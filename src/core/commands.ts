import type { MicroDuckSim, KeyframeName } from '../sim/MicroDuckSim'
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

export function attachSim(s: MicroDuckSim | null): void {
  sim = s
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

export function resetSim(pose: KeyframeName = 'STAND'): Result<{ pose: string }> {
  const s = requireSim()
  if (isErr(s)) return s
  s.reset(pose)
  return { ok: true, pose }
}

export function setPaused(paused: boolean): Result<{ paused: boolean }> {
  useStudio.getState().set({ paused })
  return { ok: true, paused }
}
