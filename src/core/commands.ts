import type { MicroDuckSim, KeyframeName } from '../sim/MicroDuckSim'
import type { PolicyRunner } from '../sim/PolicyRunner'
import type { DuckRenderer } from '../render/DuckRenderer'
import { Introspector } from '../sim/introspect'
import {
  ACTION_LEN, CONTROL_DT, HOME_POSE, OBS, OBS_LEN, POLICIES, POLICY_JOINT_NAMES,
  type PolicyId,
} from '../sim/policyContract'
import {
  PLAYBOOK_TOPICS, REWARD_TERMS, SIGN_CONVENTION_RULE, getPlaybookSection,
  type PlaybookTopic,
} from '../knowledge/playbook'
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

let renderer: DuckRenderer | null = null
let introspect: Introspector | null = null

export function attachRenderer(r: DuckRenderer | null): void {
  renderer = r
}

export function attachIntrospector(i: Introspector | null): void {
  introspect = i
}

function requireIntrospector(): Introspector | Err {
  if (!introspect) {
    return { ok: false, reason: 'The simulation is not loaded yet.', suggestion: 'Wait for status "ready".' }
  }
  return introspect
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

// ── Selection: the human's pointing gesture, as agent-readable state ─────────

/**
 * Select a joint by name, by id, or from a clicked geom.
 *
 * This is the same entry point the 3D view uses on click and the agent uses via
 * WebMCP, so "what the human selected" and "what the agent selected" cannot
 * become two different things.
 */
export function selectJoint(ref: { name?: string; jointId?: number; geomId?: number }): Result<{
  selected: unknown
}> {
  const i = requireIntrospector()
  if (isErr(i)) return i

  let jointId = -1
  if (ref.geomId !== undefined && ref.geomId >= 0) jointId = i.jointForGeom(ref.geomId)
  else if (ref.jointId !== undefined) jointId = ref.jointId
  else if (ref.name) {
    jointId = i.jointByName(ref.name)
    if (jointId < 0) {
      return {
        ok: false,
        reason: `No joint named "${ref.name}".`,
        suggestion: `Valid joints: ${i.allJoints().map((j) => j.name).join(', ')}`,
      }
    }
  }

  if (jointId < 0) {
    useStudio.getState().set({ selection: null })
    renderer?.setHighlight([])
    return { ok: true, selected: null }
  }

  const info = i.jointInfo(jointId)
  if (!info) return { ok: false, reason: `Joint id ${jointId} is out of range.` }

  useStudio.getState().set({
    selection: { jointId, jointName: info.name, bodyName: info.bodyName },
  })
  // Selecting also highlights, so the human and the agent are looking at the
  // same thing without a second command.
  highlightJoint(info.name)
  return { ok: true, selected: info }
}

export function clearSelection(): Result<{ selected: null }> {
  useStudio.getState().set({ selection: null, highlight: [] })
  renderer?.setHighlight([])
  return { ok: true, selected: null }
}

/** What the human currently has selected — the tool behind "what went wrong here?" */
export function getSelectedJoint(): Result<{ selected: unknown }> {
  const i = requireIntrospector()
  if (isErr(i)) return i
  const sel = useStudio.getState().selection
  if (!sel) {
    return {
      ok: true,
      selected: null,
      // Explaining the absence is more useful to an agent than a bare null.
      ...({ note: 'Nothing is selected. The user can click a part of the robot in the 3D view.' } as object),
    }
  }
  return { ok: true, selected: i.jointInfo(sel.jointId) }
}

export function getSelectedRobot(): Result<{ robot: unknown }> {
  const s = requireSim()
  if (isErr(s)) return s
  // One duck today; Arena would make this meaningful. Reported honestly rather
  // than omitted, so the agent knows the concept exists.
  return {
    ok: true,
    robot: { id: 'duck_0', label: 'Microduck', isOnlyRobot: true },
  }
}

// ── Attention: the agent's pointing finger ───────────────────────────────────

export function highlightJoint(name: string): Result<{ highlighted: string; geoms: number }> {
  const i = requireIntrospector()
  if (isErr(i)) return i
  const jointId = i.jointByName(name)
  if (jointId < 0) {
    return {
      ok: false,
      reason: `No joint named "${name}".`,
      suggestion: `Valid joints: ${i.allJoints().map((j) => j.name).join(', ')}`,
    }
  }
  const info = i.jointInfo(jointId)!
  const geoms = i.subtreeBodies(info.bodyId).flatMap((b) => i.geomsOfBody(b))
  renderer?.setHighlight(geoms)
  useStudio.getState().set({ highlight: [name] })
  return { ok: true, highlighted: name, geoms: geoms.length }
}

export function clearHighlight(): Result<{ cleared: true }> {
  renderer?.setHighlight([])
  useStudio.getState().set({ highlight: [] })
  return { ok: true, cleared: true }
}

// ── Robot description ────────────────────────────────────────────────────────

export function listJoints(): Result<{ joints: unknown[] }> {
  const i = requireIntrospector()
  if (isErr(i)) return i
  return { ok: true, joints: i.allJoints() }
}

// ── Knowledge: what makes any agent a Microduck expert ───────────────────────

export function getMicroduckSpec(): Result<{ spec: unknown }> {
  return {
    ok: true,
    spec: {
      robot: 'Microduck',
      maker: 'Pollen Robotics with Hugging Face',
      announced: '2026-08-27',
      price_usd: 399,
      height_cm: 25,
      mass_g: 800,
      motors: 15,
      sensors: ['camera', 'depth sensor', '2x IMU'],
      actuatedInSim: ACTION_LEN,
      note:
        'The real robot has 15 joints including a mouth. Every published policy is 14 actions ' +
        'with the mouth excluded, and the simulation model has no mouth actuator, so sim ctrl ' +
        'and policy actions line up 1:1.',
      licensing:
        'Code and simulation assets are Apache-2.0. Hardware CAD is licensed non-commercially ' +
        'and is not used here.',
      simulationModel: 'robot_allcollisions.xml from pollen-robotics/microduck_rl',
      trainingStack: 'mjlab (MuJoCo Warp) with PPO, policies exported to ONNX',
    },
  }
}

export function getPolicyContract(): Result<{ contract: unknown }> {
  return {
    ok: true,
    contract: {
      shape: 'obs[1,61] -> actions[1,14]',
      controlRateHz: Math.round(1 / CONTROL_DT),
      observationLayout: [
        { slice: [OBS.gyro, OBS.gravity], width: 3, contents: 'gyro, trunk frame, rad/s' },
        { slice: [OBS.gravity, OBS.jointPos], width: 3, contents: 'projected gravity, trunk frame, unit vector' },
        { slice: [OBS.jointPos, OBS.jointVel], width: 14, contents: 'joint position MINUS home pose, mouth excluded' },
        { slice: [OBS.jointVel, OBS.lastAction], width: 14, contents: 'joint velocity, mouth excluded' },
        { slice: [OBS.lastAction, OBS.command], width: 14, contents: 'previous action, mouth excluded' },
        { slice: [OBS.command, OBS_LEN], width: 13, contents: 'command block' },
      ],
      commandBlock: {
        '48..51': 'vx, vy, vyaw',
        '51..55': 'neck_pitch, head_pitch, head_yaw, head_roll',
        '55..57': 'body x, y — always zero, unbound in training',
        '57': 'body z',
        '58': 'body roll',
        '59': 'body pitch',
        '60': 'body yaw — always zero, unbound in training',
      },
      jointOrder: POLICY_JOINT_NAMES,
      homePose: HOME_POSE,
      actionToTarget: 'joint target = home pose + 1.0 * action (mjlab use_default_offset)',
      trainedCommandRanges: { lin_vel_x: [-0.4, 0.4], lin_vel_y: [-0.3, 0.3], ang_vel_z: [-1.0, 1.0] },
      caveats: [
        'A 51-D legacy observation family exists and is rejected at load.',
        'Joint positions are relative to the home pose, not absolute.',
        'The body block order is z, roll, pitch — not z, pitch, roll.',
      ],
    },
  }
}

export async function getRlPlaybook(topic: string): Promise<Result<{ topic: string; content: string }>> {
  const topics = Object.keys(PLAYBOOK_TOPICS) as PlaybookTopic[]
  if (!topics.includes(topic as PlaybookTopic)) {
    return {
      ok: false,
      reason: `Unknown playbook topic "${topic}".`,
      suggestion: `Valid topics: ${topics.join(', ')}`,
    }
  }
  try {
    return { ok: true, topic, content: await getPlaybookSection(topic as PlaybookTopic) }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function explainRewardTerm(term: string): Result<{ term: string; what: string; watchFor: string; signConvention: string }> {
  const entry = REWARD_TERMS[term]
  if (!entry) {
    return {
      ok: false,
      reason: `No curated explanation for reward term "${term}".`,
      suggestion: `Known terms: ${Object.keys(REWARD_TERMS).join(', ')}`,
    }
  }
  return { ok: true, term, what: entry.what, watchFor: entry.watchFor, signConvention: SIGN_CONVENTION_RULE }
}

// ── Disturbances ─────────────────────────────────────────────────────────────

/**
 * Shove the trunk. Applied as an instantaneous velocity change rather than a
 * force, so "5 N for one step" cannot mean something different at a different
 * timestep — an agent asking twice gets the same push.
 */
export function applyDisturbance(args: { magnitude?: number; direction?: 'front' | 'back' | 'left' | 'right' }): Result<{
  magnitude: number
  direction: string
}> {
  const s = requireSim()
  if (isErr(s)) return s
  const magnitude = Math.min(Math.max(args.magnitude ?? 0.4, 0), 3)
  const direction = args.direction ?? 'front'
  const vec: Record<string, [number, number]> = {
    front: [-1, 0], back: [1, 0], left: [0, -1], right: [0, 1],
  }
  const d = vec[direction]
  if (!d) {
    return { ok: false, reason: `Unknown direction "${direction}".`, suggestion: 'Valid: front, back, left, right' }
  }
  // qvel[0..3] on a free joint is linear velocity in the world frame.
  s.data.qvel[0] += d[0] * magnitude
  s.data.qvel[1] += d[1] * magnitude
  return { ok: true, magnitude, direction }
}
