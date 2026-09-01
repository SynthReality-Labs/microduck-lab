import type { MicroDuckSim, KeyframeName } from '../sim/MicroDuckSim'
import type { PolicyRunner } from '../sim/PolicyRunner'
import { POLICIES, type PolicyId } from '../sim/policyContract'
import { useStudio } from './store'

/**
 * The command layer. Every state change in MicroDuck Lab goes through here —
 * the UI calls these functions, and each WebMCP tool is a thin schema wrapper
 * over the same function. There is deliberately no second path for the agent.
 */

export type Ok<T> = { ok: true } & T
export type Err = { ok: false; reason: string; suggestion?: string }
export type Result<T> = Ok<T> | Err

let sim: MicroDuckSim | null = null
let policy: PolicyRunner | null = null

export function attachSim(s: MicroDuckSim | null): void {
  sim = s
}

export function attachPolicyRunner(p: PolicyRunner | null): void {
  policy = p
}

function requirePolicyRunner(): PolicyRunner | Err {
  if (!policy) {
    return {
      ok: false,
      reason: 'The policy runner is not ready yet.',
      suggestion: 'Wait for status to become "ready", then retry.',
    }
  }
  return policy
}

function requireSim(): MicroDuckSim | Err {
  if (!sim) {
    return {
      ok: false,
      reason: 'The simulation is not loaded yet.',
      suggestion: 'Wait for status to become "ready", then retry.',
    }
  }
  return sim
}

function isErr(v: unknown): v is Err {
  return typeof v === 'object' && v !== null && (v as Err).ok === false
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getStudioState(): Result<{
  status: string
  paused: boolean
  simTime: number
  webmcp: { surface: string; toolCount: number }
}> {
  const s = useStudio.getState()
  return {
    ok: true,
    status: s.status,
    paused: s.paused,
    simTime: sim ? Number(sim.data.time.toFixed(4)) : 0,
    webmcp: { surface: s.webmcp.surface, toolCount: s.webmcp.registered.length },
  }
}

export function describeRobot(): Result<{
  model: string
  actuators: string[]
  joints: string[]
  nq: number
  nv: number
  nu: number
  timestep: number
}> {
  const s = requireSim()
  if (isErr(s)) return s
  return {
    ok: true,
    model: 'Microduck (Pollen Robotics) — robot_allcollisions.xml',
    actuators: s.actuatorNames(),
    joints: s.jointNames(),
    nq: s.model.nq,
    nv: s.model.nv,
    nu: s.model.nu,
    timestep: s.timestep,
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

const POSES: KeyframeName[] = ['INIT', 'STAND', 'SIT', 'FOLD']

export function resetSim(pose: KeyframeName = 'STAND'): Result<{ pose: string }> {
  const s = requireSim()
  if (isErr(s)) return s
  // Validate before touching MuJoCo. An unknown key otherwise reaches
  // mj_resetDataKeyframe as undefined and surfaces as 'Cannot convert
  // "undefined" to int', which tells an agent nothing it can act on.
  if (!POSES.includes(pose)) {
    return {
      ok: false,
      reason: `Unknown pose "${pose}".`,
      suggestion: `Valid poses: ${POSES.join(', ')}`,
    }
  }
  s.reset(pose)
  return { ok: true, pose }
}

export function setPaused(paused: boolean): Result<{ paused: boolean }> {
  useStudio.getState().set({ paused })
  return { ok: true, paused }
}

// ── Policies ─────────────────────────────────────────────────────────────────

export function listPolicies(): Result<{
  policies: { id: string; label: string; role: string }[]
  loaded: string | null
}> {
  return {
    ok: true,
    policies: POLICIES.map((p) => ({ id: p.id, label: p.label, role: p.role })),
    loaded: policy?.currentPolicy ?? null,
  }
}

export async function loadPolicy(id: string): Promise<Result<{ loaded: string }>> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  const entry = POLICIES.find((e) => e.id === id)
  if (!entry) {
    return {
      ok: false,
      reason: `Unknown policy "${id}".`,
      suggestion: `Valid ids: ${POLICIES.map((e) => e.id).join(', ')}`,
    }
  }
  try {
    await p.load(entry.id as PolicyId, entry.file)
    useStudio.getState().set({ loadedPolicy: entry.id })
    return { ok: true, loaded: entry.id }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function unloadPolicy(): Result<{ loaded: null }> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  p.unload()
  p.holdHomePose()
  useStudio.getState().set({ loadedPolicy: null })
  return { ok: true, loaded: null }
}

// ── Command ──────────────────────────────────────────────────────────────────

export interface CommandPatch {
  vx?: number
  vy?: number
  vyaw?: number
  head?: [number, number, number, number]
  body?: { z?: number; roll?: number; pitch?: number }
}

export function setCommand(patch: CommandPatch): Result<{ command: unknown }> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  const c = p.command
  if (patch.vx !== undefined) c.twist[0] = patch.vx
  if (patch.vy !== undefined) c.twist[1] = patch.vy
  if (patch.vyaw !== undefined) c.twist[2] = patch.vyaw
  if (patch.head) c.head = patch.head
  if (patch.body) {
    if (patch.body.z !== undefined) c.body.z = patch.body.z
    if (patch.body.roll !== undefined) c.body.roll = patch.body.roll
    if (patch.body.pitch !== undefined) c.body.pitch = patch.body.pitch
  }
  useStudio.getState().set({ commandVersion: useStudio.getState().commandVersion + 1 })
  return { ok: true, command: { twist: c.twist, head: c.head, body: c.body } }
}

export function getCommand(): Result<{ command: unknown }> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  return { ok: true, command: { twist: p.command.twist, head: p.command.head, body: p.command.body } }
}
