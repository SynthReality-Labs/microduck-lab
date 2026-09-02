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
import type { Episode } from '../sim/Episode'
import { LIBRARY, recordEpisode } from '../sim/recorder'
import { evaluatePolicy, type EvalReport } from '../sim/evaluate'
import { SCENARIOS, applyScenario, type Scenario, type ScenarioHandle } from '../sim/scenarios'
import { PARK_X, PARK_Z, PROPS } from '../sim/props'
import { LESSONS, type Lesson, type LessonStep } from '../knowledge/lessons'
import { dismissBubble, maybeIdle, noteInteraction, react, reactToFall } from './bubbles'
import type { ActionId } from '../knowledge/chatter'
import {
  DEFAULT_RECIPE, TASKS, bundleFiles, composeJob, type Recipe, type Target,
} from '../sim/recipe'
import {
  DEFAULT_OBJECTIVE, DEFAULT_TARGET, REWARD_TERMS as OBJ_TERMS, TERMS_BY_KEY,
  scoreEpisode, type Objective,
} from '../sim/objective'
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

export function resetCamera(): Result<{ reset: true }> {
  renderer?.resetCamera()
  return { ok: true, reset: true }
}

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
  // Resetting the robot resets the view too: after orbiting around a fallen
  // duck, "Stand" should give back the default framing rather than leave you
  // looking at empty floor.
  renderer?.resetCamera()
  return { ok: true, pose }
}

export function setPaused(paused: boolean): Result<{ paused: boolean }> {
  useStudio.getState().set({ paused })
  return { ok: true, paused }
}

// ── Policies ─────────────────────────────────────────────────────────────────

export function listPolicies(): Result<{
  policies: { id: string; label: string; role: string; source: string }[]
  loaded: string | null
}> {
  return {
    ok: true,
    policies: [
      ...POLICIES.map((p) => ({ id: p.id, label: p.label, role: p.role, source: 'pollen' })),
      ...listImportedPolicies().map((p) => ({ id: p.id, label: p.label, role: 'imported by the user', source: 'imported' })),
    ],
    loaded: policy?.currentPolicy ?? null,
  }
}

export async function loadPolicy(id: string): Promise<Result<{ loaded: string }>> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  const entry = POLICIES.find((e) => e.id === id)
  const importedEntry = entry ? null : imported.get(id)
  if (!entry && !importedEntry) {
    return {
      ok: false,
      reason: `Unknown policy "${id}".`,
      suggestion: `Valid ids: ${[...POLICIES.map((e) => e.id), ...imported.keys()].join(', ')}`,
    }
  }
  try {
    if (entry) await p.load(entry.id as PolicyId, entry.file)
    else await p.loadFrom(importedEntry!.id, importedEntry!.url)
    const loadedId = entry ? entry.id : importedEntry!.id
    useStudio.getState().set({ loadedPolicy: loadedId })
    return { ok: true, loaded: loadedId }
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
  const wasBelow = Math.hypot(c.twist[0], c.twist[1]) <= 0.15
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
  noteInteraction()
  // Crossing the velstand threshold is the moment it starts actually stepping.
  if (wasBelow && Math.hypot(c.twist[0], c.twist[1]) > 0.15) react('walk')
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
  react('select', info.name)
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
/**
 * Listeners for pushes, so every shove gets the same visual cue.
 *
 * Deliberately at the command layer rather than in the pointer handler: an
 * agent-initiated push must look identical to a mouse-initiated one, otherwise
 * the most interesting thing the agent does is invisible on camera.
 */
type PushListener = (p: { x: number; y: number; magnitude: number; source: 'agent' | 'mouse' }) => void
const pushListeners = new Set<PushListener>()

export function onPush(fn: PushListener): () => void {
  pushListeners.add(fn)
  return () => pushListeners.delete(fn)
}

export function applyDisturbance(args: {
  magnitude?: number
  direction?: 'front' | 'back' | 'left' | 'right'
  /**世界-frame direction, used by the mouse push. Overrides `direction`. */
  vector?: [number, number]
  source?: 'agent' | 'mouse'
}): Result<{ magnitude: number; direction: string }> {
  const s = requireSim()
  if (isErr(s)) return s
  const magnitude = Math.min(Math.max(args.magnitude ?? 0.4, 0), 3)
  const direction = args.direction ?? 'front'
  const vec: Record<string, [number, number]> = {
    front: [-1, 0], back: [1, 0], left: [0, -1], right: [0, 1],
  }
  let d = args.vector ?? vec[direction]
  if (!d) {
    return { ok: false, reason: `Unknown direction "${direction}".`, suggestion: 'Valid: front, back, left, right' }
  }
  const len = Math.hypot(d[0], d[1]) || 1
  d = [d[0] / len, d[1] / len]

  // qvel[0..3] on a free joint is linear velocity in the world frame.
  s.data.qvel[0] += d[0] * magnitude
  s.data.qvel[1] += d[1] * magnitude

  for (const fn of pushListeners) {
    fn({ x: d[0], y: d[1], magnitude, source: args.source ?? 'agent' })
  }
  return { ok: true, magnitude, direction: args.vector ? 'custom' : direction }
}

// ── Rollouts and objectives: Learn mode ──────────────────────────────────────

const rollouts = new Map<string, Episode>()
let objective: Objective = { ...DEFAULT_OBJECTIVE }
/** Every rollout is scored against this same task. See ScoringTarget. */
const scoringTarget = { ...DEFAULT_TARGET }

export function getRollout(id: string): Episode | undefined {
  return rollouts.get(id)
}

/**
 * Record the canonical rollout library.
 *
 * Recorded live rather than shipped as fixtures, so what gets scored is
 * something this machine actually simulated with real Pollen policies.
 */
export async function recordLibrary(): Promise<Result<{ recorded: string[] }>> {
  const s = requireSim()
  if (isErr(s)) return s
  const p = requirePolicyRunner()
  if (isErr(p)) return p

  const store = useStudio.getState()
  const wasPaused = store.paused
  // Recording swaps policies and resets the robot. Capture what the studio was
  // showing so the user gets their session back rather than silently inheriting
  // whichever policy happened to be recorded last.
  const previousPolicy = p.currentPolicy
  const previousCommand = structuredClone(p.command)
  store.set({ paused: true })
  const recorded: string[] = []
  try {
    for (const spec of LIBRARY) {
      useStudio.getState().set({ recording: { active: true, label: spec.label } })
      const ep = await recordEpisode(s, p, spec)
      rollouts.set(ep.id, ep)
      recorded.push(ep.id)
    }
    useStudio.getState().set({ rolloutIds: [...rollouts.keys()] })
    return { ok: true, recorded }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    if (previousPolicy) {
      const entry = POLICIES.find((e) => e.id === previousPolicy)
      if (entry) await p.load(entry.id as PolicyId, entry.file)
    } else {
      p.unload()
      p.holdHomePose()
    }
    p.command = previousCommand
    s.reset('STAND')
    useStudio.getState().set({
      recording: null,
      paused: wasPaused,
      loadedPolicy: previousPolicy ?? null,
    })
  }
}

export function listRollouts(): Result<{ rollouts: unknown[] }> {
  return {
    ok: true,
    rollouts: [...rollouts.values()].map((e) => ({
      id: e.id, label: e.label, policy: e.policy, note: e.note,
      seconds: +(e.length * e.dt).toFixed(2),
      distanceX: +(e.posX[e.length - 1] - e.posX[0]).toFixed(3),
      finalHeight: +e.posZ[e.length - 1].toFixed(3),
      terminated: e.terminated, terminationReason: e.terminationReason,
    })),
  }
}

export function getObjective(): Result<{ objective: Objective; task: unknown; terms: unknown[] }> {
  return {
    ok: true,
    objective: { ...objective },
    task: { ...scoringTarget, description: 'Every rollout is scored against this same task: walk forward at this velocity.' },
    terms: OBJ_TERMS.map((t) => ({ key: t.key, label: t.label, kind: t.kind, description: t.description })),
  }
}

export function setRewardWeight(term: string, weight: number): Result<{ objective: Objective }> {
  if (!TERMS_BY_KEY.has(term)) {
    return {
      ok: false,
      reason: `Unknown reward term "${term}".`,
      suggestion: `Valid terms: ${OBJ_TERMS.map((t) => t.key).join(', ')}`,
    }
  }
  if (!Number.isFinite(weight)) return { ok: false, reason: 'weight must be a finite number.' }
  objective = { ...objective, [term]: weight }
  useStudio.getState().set({ objectiveVersion: useStudio.getState().objectiveVersion + 1 })
  return { ok: true, objective: { ...objective } }
}

export function resetObjective(): Result<{ objective: Objective }> {
  objective = { ...DEFAULT_OBJECTIVE }
  useStudio.getState().set({ objectiveVersion: useStudio.getState().objectiveVersion + 1 })
  return { ok: true, objective: { ...objective } }
}

export interface RankedRow {
  rank: number
  id: string
  label: string
  total: number
  perTerm: { key: string; label: string; weight: number; mean: number; contribution: number }[]
}

/** Score every rollout under the current objective and rank them. Pure. */
export function scoreRollouts(): Result<{ objective: Objective; ranking: RankedRow[] }> {
  if (rollouts.size === 0) {
    return {
      ok: false,
      reason: 'No rollouts recorded yet.',
      suggestion: 'Call record_rollout_library first.',
    }
  }
  const rows = [...rollouts.values()]
    .map((ep) => {
      const score = scoreEpisode(ep, objective, scoringTarget)
      return { id: ep.id, label: ep.label, total: score.total, perTerm: score.perTerm }
    })
    .sort((a, b) => b.total - a.total)
    .map((r, i) => ({ rank: i + 1, ...r }))
  return { ok: true, objective: { ...objective }, ranking: rows }
}

export function getRewardBreakdown(id: string): Result<{ rollout: string; total: number; perTerm: unknown[] }> {
  const ep = rollouts.get(id)
  if (!ep) {
    return {
      ok: false,
      reason: `No rollout "${id}".`,
      suggestion: `Recorded rollouts: ${[...rollouts.keys()].join(', ') || '(none yet)'}`,
    }
  }
  const score = scoreEpisode(ep, objective, scoringTarget)
  return { ok: true, rollout: id, total: score.total, perTerm: score.perTerm }
}

/**
 * Pollen's "infallible check", as a tool.
 *
 * Their playbook states it plainly: every `Episode_Reward/<penalty>` must be
 * <= 0 on every run. A negative weight on a self-negating penalty
 * double-negates into a reward for the violation, and the policy farms it —
 * which is where butt-hopping and crash-sits come from.
 *
 * Here the same check runs over recorded rollouts instead of a training log, so
 * it catches the error before any GPU time is spent.
 */
export function checkRewardSigns(): Result<{
  passed: boolean
  findings: { term: string; label: string; weight: number; worstContribution: number; verdict: string }[]
  rule: string
}> {
  if (rollouts.size === 0) {
    return { ok: false, reason: 'No rollouts recorded yet.', suggestion: 'Call record_rollout_library first.' }
  }
  const findings: { term: string; label: string; weight: number; worstContribution: number; verdict: string }[] = []

  for (const term of OBJ_TERMS) {
    const weight = objective[term.key]
    if (weight === undefined || weight === 0) continue
    let worst = 0
    for (const ep of rollouts.values()) {
      const score = scoreEpisode(ep, { [term.key]: weight }, scoringTarget)
      const c = score.perTerm[0]?.contribution ?? 0
      if (c > worst) worst = c
    }
    if (term.kind === 'penalty' && worst > 0) {
      findings.push({
        term: term.key,
        label: term.label,
        weight,
        worstContribution: +worst.toFixed(4),
        verdict:
          `FAIL — this is a penalty but it is PAYING OUT (+${worst.toFixed(3)}). A negative weight ` +
          'on a self-negating penalty double-negates into a reward for the violation. Use a positive weight.',
      })
    }
  }

  return {
    ok: true,
    passed: findings.length === 0,
    findings,
    rule: SIGN_CONVENTION_RULE,
  }
}

// ── Rollout review: the timeline, and the range the human dragged ────────────

function currentReview() {
  return useStudio.getState().review
}

/** Open a recorded rollout for review. Pauses physics — you are inspecting a
 *  recording, not steering the live robot. */
export function openRollout(id: string): Result<{ rollout: string; frames: number; seconds: number }> {
  const ep = rollouts.get(id)
  if (!ep) {
    return {
      ok: false,
      reason: `No rollout "${id}".`,
      suggestion: `Recorded rollouts: ${[...rollouts.keys()].join(', ') || '(none — call record_rollout_library)'}`,
    }
  }
  useStudio.getState().set({
    review: { episodeId: id, frame: 0, playing: true, range: null },
    paused: true,
  })
  return { ok: true, rollout: id, frames: ep.length, seconds: +(ep.length * ep.dt).toFixed(2) }
}

export function closeRollout(): Result<{ closed: true }> {
  useStudio.getState().set({ review: null, paused: false })
  const s = requireSim()
  if (!isErr(s)) s.reset('STAND')
  return { ok: true, closed: true }
}

export function seekRollout(seconds: number): Result<{ time: number; frame: number }> {
  const r = currentReview()
  if (!r) return { ok: false, reason: 'No rollout is open.', suggestion: 'Call open_rollout first.' }
  const ep = rollouts.get(r.episodeId)!
  const frame = Math.max(0, Math.min(ep.length - 1, Math.round(seconds / ep.dt)))
  useStudio.getState().set({ review: { ...r, frame, playing: false } })
  return { ok: true, time: +(frame * ep.dt).toFixed(3), frame }
}

export function setReviewPlaying(playing: boolean): Result<{ playing: boolean }> {
  const r = currentReview()
  if (!r) return { ok: false, reason: 'No rollout is open.' }
  useStudio.getState().set({ review: { ...r, playing } })
  return { ok: true, playing }
}

export function setTimelineRange(startSec: number, endSec: number): Result<{ start: number; end: number }> {
  const r = currentReview()
  if (!r) return { ok: false, reason: 'No rollout is open.', suggestion: 'Call open_rollout first.' }
  const ep = rollouts.get(r.episodeId)!
  const a = Math.max(0, Math.min(ep.length - 1, Math.round(Math.min(startSec, endSec) / ep.dt)))
  const b = Math.max(0, Math.min(ep.length - 1, Math.round(Math.max(startSec, endSec) / ep.dt)))
  useStudio.getState().set({ review: { ...r, range: { startFrame: a, endFrame: b } } })
  return { ok: true, start: +(a * ep.dt).toFixed(3), end: +(b * ep.dt).toFixed(3) }
}

export function clearTimelineRange(): Result<{ cleared: true }> {
  const r = currentReview()
  if (r) useStudio.getState().set({ review: { ...r, range: null } })
  return { ok: true, cleared: true }
}

/**
 * The time range the human dragged on the timeline.
 *
 * The companion to get_selected_joint: together they let "what went wrong
 * here?" resolve without the user describing when or where "here" is.
 */
export function getSelectedTimelineRange(): Result<{ selection: unknown }> {
  const r = currentReview()
  if (!r) {
    return {
      ok: true,
      selection: null,
      ...({ note: 'No rollout is open. Call open_rollout, then the user can drag a range on the timeline.' } as object),
    }
  }
  const ep = rollouts.get(r.episodeId)!
  if (!r.range) {
    return {
      ok: true,
      selection: null,
      ...({
        note: `Rollout "${ep.id}" is open at t=${(r.frame * ep.dt).toFixed(2)}s but no range is selected. The user can drag one on the timeline.`,
      } as object),
    }
  }
  return {
    ok: true,
    selection: {
      rollout: ep.id,
      label: ep.label,
      start: +(r.range.startFrame * ep.dt).toFixed(3),
      end: +(r.range.endFrame * ep.dt).toFixed(3),
      frames: r.range.endFrame - r.range.startFrame + 1,
    },
  }
}

/**
 * Analyse a window of a rollout.
 *
 * Defaults to whatever the human currently has selected, so an agent answering
 * "what went wrong here?" needs no arguments at all.
 */
export function inspectRollout(args: { start?: number; end?: number; id?: string }): Result<{ window: unknown; findings: unknown }> {
  const r = currentReview()
  const ep = rollouts.get(args.id ?? r?.episodeId ?? '')
  if (!ep) {
    return {
      ok: false,
      reason: 'No rollout to inspect.',
      suggestion: 'Call open_rollout first, or pass an id.',
    }
  }
  let a = 0
  let b = ep.length - 1
  if (args.start !== undefined || args.end !== undefined) {
    a = Math.max(0, Math.round((args.start ?? 0) / ep.dt))
    b = Math.min(ep.length - 1, Math.round((args.end ?? ep.length * ep.dt) / ep.dt))
  } else if (r?.range) {
    a = r.range.startFrame
    b = r.range.endFrame
  }
  if (b < a) [a, b] = [b, a]

  let minUpright = 1
  let maxAngVel = 0
  let minHeight = Infinity
  let maxHeight = -Infinity
  let sumSpeed = 0
  let peakActionDelta = 0
  let peakFrame = a
  for (let i = a; i <= b; i++) {
    minUpright = Math.min(minUpright, -ep.gravZ[i])
    if (ep.angVelMag[i] > maxAngVel) maxAngVel = ep.angVelMag[i]
    minHeight = Math.min(minHeight, ep.posZ[i])
    maxHeight = Math.max(maxHeight, ep.posZ[i])
    sumSpeed += ep.velX[i]
    if (ep.actionDelta[i] > peakActionDelta) {
      peakActionDelta = ep.actionDelta[i]
      peakFrame = i
    }
  }
  const n = b - a + 1

  const findings: string[] = []
  if (minUpright < 0.4) findings.push('Lost upright orientation in this window — the trunk went past horizontal.')
  if (minHeight < 0.08) findings.push(`Trunk dropped to ${minHeight.toFixed(3)} m, well below the nominal 0.12 m stance.`)
  if (maxAngVel > 3) findings.push(`Large angular velocity peak (${maxAngVel.toFixed(2)} rad/s) — the trunk is being thrown, not steered.`)
  if (peakActionDelta > 0.5) findings.push(`Action-rate spike at t=${(peakFrame * ep.dt).toFixed(2)}s — the policy is correcting hard.`)
  if (findings.length === 0) findings.push('Nothing anomalous in this window: upright, stable height, smooth actions.')

  return {
    ok: true,
    window: {
      rollout: ep.id,
      start: +(a * ep.dt).toFixed(3),
      end: +(b * ep.dt).toFixed(3),
      frames: n,
    },
    findings: {
      summary: findings,
      minUpright: +minUpright.toFixed(3),
      minHeight: +minHeight.toFixed(3),
      maxHeight: +maxHeight.toFixed(3),
      meanForwardSpeed: +(sumSpeed / n).toFixed(3),
      maxAngularVelocity: +maxAngVel.toFixed(3),
      peakActionRateAt: +(peakFrame * ep.dt).toFixed(3),
      terminationReason: ep.terminationReason,
    },
  }
}

/** Write the frame the playhead is on into the live sim, for rendering. */
export function renderReviewFrame(): void {
  const r = currentReview()
  if (!r) return
  const ep = rollouts.get(r.episodeId)
  const s = sim
  if (!ep || !s) return
  s.applyQpos(ep.qpos, r.frame * ep.nq)
  if (r.playing) {
    const next = r.frame + 1
    if (next >= ep.length) useStudio.getState().set({ review: { ...r, frame: 0 } })
    else useStudio.getState().set({ review: { ...r, frame: next } })
  }
}

// ── Observation anatomy: the 61-D vector, shown on the robot ─────────────────

export const OBS_SLICES = {
  gyro: { from: OBS.gyro, to: OBS.gravity, label: 'Gyroscope', joints: [] as string[],
    what: 'Trunk angular velocity in the trunk frame, rad/s. How fast the body is rotating.' },
  gravity: { from: OBS.gravity, to: OBS.jointPos, label: 'Projected gravity', joints: [] as string[],
    what: 'The gravity direction expressed in the trunk frame, as a unit vector. This is how the policy knows which way is up: (0,0,-1) is perfectly upright.' },
  joint_positions: { from: OBS.jointPos, to: OBS.jointVel, label: 'Joint positions', joints: [...POLICY_JOINT_NAMES],
    what: 'Where each of the 14 actuated joints currently is — RELATIVE TO THE HOME POSE, not absolute. A joint at its home angle reads zero.' },
  joint_velocities: { from: OBS.jointVel, to: OBS.lastAction, label: 'Joint velocities', joints: [...POLICY_JOINT_NAMES],
    what: 'How fast each of those 14 joints is moving, rad/s.' },
  last_action: { from: OBS.lastAction, to: OBS.command, label: 'Previous action', joints: [...POLICY_JOINT_NAMES],
    what: "The policy's own output from the previous control step, fed back in. This is what lets it produce smooth motion rather than reacting from scratch each tick." },
  command: { from: OBS.command, to: OBS_LEN, label: 'Command', joints: [] as string[],
    what: 'What the robot is being asked to do: velocity (3), head pose (4), body pose (6). Body x, y and yaw are always zero — they were unbound during training.' },
} as const

export type ObsSliceKey = keyof typeof OBS_SLICES

/**
 * Explain one block of the observation vector, and light up the joints it
 * covers.
 *
 * The point of Learn mode: the 61-D vector is not described, it is shown on the
 * robot the user is already looking at.
 */
export function explainObservationSlice(key: string): Result<{
  slice: string
  label: string
  indices: [number, number]
  width: number
  what: string
  liveValues: number[]
  joints: string[]
}> {
  const slice = OBS_SLICES[key as ObsSliceKey]
  if (!slice) {
    return {
      ok: false,
      reason: `Unknown observation slice "${key}".`,
      suggestion: `Valid slices: ${Object.keys(OBS_SLICES).join(', ')}`,
    }
  }
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  const i = requireIntrospector()
  if (isErr(i)) return i

  // Rebuild so the numbers are this frame's, not the last inference's.
  const obs = p.buildObservation()
  const live = Array.from(obs.slice(slice.from, slice.to)).map((v) => +v.toFixed(4))

  const geoms = slice.joints.flatMap((n) => {
    const jid = i.jointByName(n)
    if (jid < 0) return []
    const info = i.jointInfo(jid)
    return info ? i.geomsOfBody(info.bodyId) : []
  })
  renderer?.setHighlight(geoms)
  useStudio.getState().set({ highlight: [...slice.joints] })

  return {
    ok: true,
    slice: key,
    label: slice.label,
    indices: [slice.from, slice.to],
    width: slice.to - slice.from,
    what: slice.what,
    liveValues: live,
    joints: [...slice.joints],
  }
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const evalReports = new Map<string, EvalReport>()
const DEFAULT_SEEDS = [1, 2, 3]

export function listScenarios(): Result<{ scenarios: unknown[] }> {
  return {
    ok: true,
    scenarios: SCENARIOS.map((s) => ({
      id: s.id, label: s.label,
      slopeDeg: s.slopeDeg ?? 0,
      friction: s.friction ?? 1.0,
      push: s.push ?? null,
    })),
  }
}

export async function runEvalSuite(args: {
  policy?: string
  scenarios?: string[]
  seeds?: number[]
  seconds?: number
  vx?: number
}): Promise<Result<{ report: EvalReport }>> {
  const s = requireSim()
  if (isErr(s)) return s
  const p = requirePolicyRunner()
  if (isErr(p)) return p

  const policyId = args.policy ?? p.currentPolicy ?? 'alpha_walking'
  if (!POLICIES.some((e) => e.id === policyId)) {
    return {
      ok: false,
      reason: `Unknown policy "${policyId}".`,
      suggestion: `Valid: ${POLICIES.map((e) => e.id).join(', ')}`,
    }
  }

  let scenarios: Scenario[] = SCENARIOS
  if (args.scenarios?.length) {
    const unknown = args.scenarios.filter((id) => !SCENARIOS.some((sc) => sc.id === id))
    if (unknown.length) {
      return {
        ok: false,
        reason: `Unknown scenario(s): ${unknown.join(', ')}.`,
        suggestion: `Valid: ${SCENARIOS.map((sc) => sc.id).join(', ')}`,
      }
    }
    scenarios = SCENARIOS.filter((sc) => args.scenarios!.includes(sc.id))
  }

  const previousPolicy = p.currentPolicy
  const previousCommand = structuredClone(p.command)
  const wasPaused = useStudio.getState().paused
  useStudio.getState().set({ paused: true, evaluating: { done: 0, total: 0, label: 'starting' } })
  // Scenarios mutate the same gravity and friction fields the live world uses,
  // so clear the live settings first and put them back afterwards. Otherwise a
  // user standing on ice would silently bias every scenario in the suite.
  clearLiveEnvironment()

  try {
    const report = await evaluatePolicy(s, p, {
      policy: policyId as PolicyId,
      scenarios,
      seeds: args.seeds?.length ? args.seeds : DEFAULT_SEEDS,
      seconds: args.seconds ?? 5,
      command: { vx: args.vx ?? 0.3, vy: 0, vyaw: 0 },
      onProgress: (done, total, label) =>
        useStudio.getState().set({ evaluating: { done, total, label } }),
    })
    evalReports.set(policyId, report)
    useStudio.getState().set({ evalPolicies: [...evalReports.keys()] })
    return { ok: true, report }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  } finally {
    if (previousPolicy) {
      const entry = POLICIES.find((e) => e.id === previousPolicy)
      if (entry) await p.load(entry.id as PolicyId, entry.file)
    }
    p.command = previousCommand
    reapplyEnvironment()
    s.reset('STAND')
    useStudio.getState().set({
      evaluating: null, paused: wasPaused, loadedPolicy: previousPolicy ?? null,
    })
  }
}

export function getEvalReport(policy: string): Result<{ report: EvalReport }> {
  const report = evalReports.get(policy)
  if (!report) {
    return {
      ok: false,
      reason: `No evaluation for "${policy}".`,
      suggestion: `Run run_eval_suite first. Evaluated so far: ${[...evalReports.keys()].join(', ') || '(none)'}`,
    }
  }
  return { ok: true, report }
}

export function getEvalReports(): Map<string, EvalReport> {
  return evalReports
}

/**
 * A/B two policies over the same scenarios, seeds and command.
 *
 * Same seeds on both sides is what makes the comparison mean anything: the
 * starting jitter is identical, so a difference in outcome is a difference in
 * policy rather than in luck.
 */
export async function comparePolicies(args: {
  a: string
  b: string
  seeds?: number[]
  seconds?: number
  vx?: number
}): Promise<Result<{ comparison: unknown }>> {
  if (!args?.a || !args?.b) {
    return { ok: false, reason: 'Two policy ids are required.', suggestion: 'e.g. {"a":"alpha_walking","b":"alpha_stand"}' }
  }
  const seeds = args.seeds?.length ? args.seeds : DEFAULT_SEEDS
  for (const id of [args.a, args.b]) {
    const r = await runEvalSuite({ policy: id, seeds, seconds: args.seconds, vx: args.vx })
    if (!r.ok) return r
  }
  const ra = evalReports.get(args.a)!
  const rb = evalReports.get(args.b)!

  const rows = ra.scenarios.map((sa) => {
    const sb = rb.scenarios.find((x) => x.scenario === sa.scenario)!
    return {
      scenario: sa.scenario,
      label: sa.label,
      a: { successRate: sa.successRate, meanDistance: sa.meanDistance, worstUpright: sa.worstUpright },
      b: { successRate: sb.successRate, meanDistance: sb.meanDistance, worstUpright: sb.worstUpright },
      successDelta: +(sb.successRate - sa.successRate).toFixed(3),
      distanceDelta: +(sb.meanDistance - sa.meanDistance).toFixed(3),
    }
  })

  const wins = rows.filter((r) => r.successDelta > 0).map((r) => r.label)
  const losses = rows.filter((r) => r.successDelta < 0).map((r) => r.label)
  const summary =
    wins.length === 0 && losses.length === 0
      ? `${args.b} and ${args.a} survive identically across every scenario; compare distance instead.`
      : [
          wins.length ? `${args.b} is more robust on: ${wins.join(', ')}.` : '',
          losses.length ? `${args.a} is more robust on: ${losses.join(', ')}.` : '',
        ].filter(Boolean).join(' ')

  return {
    ok: true,
    comparison: {
      a: args.a, b: args.b, seeds, seconds: ra.seconds, command: ra.command,
      overall: { a: ra.overallSuccessRate, b: rb.overallSuccessRate },
      summary,
      scenarios: rows,
    },
  }
}

// ── Recipes and the escalation loop ─────────────────────────────────────────

let recipe: Recipe = { ...DEFAULT_RECIPE, rewardWeights: {} }

export function getRecipe(): Result<{ recipe: Recipe; tasks: unknown[] }> {
  return {
    ok: true,
    recipe: structuredClone(recipe),
    tasks: TASKS.map((t) => ({ id: t.id, label: t.label, about: t.about })),
  }
}

export function setRecipe(patch: Partial<Recipe>): Result<{ recipe: Recipe }> {
  if (patch.task && !TASKS.some((t) => t.id === patch.task)) {
    return {
      ok: false,
      reason: `Unknown task "${patch.task}".`,
      suggestion: `Valid tasks: ${TASKS.map((t) => t.id).join(', ')}`,
    }
  }
  const targets: Target[] = ['local-gpu', 'local-cpu', 'hf-jobs']
  if (patch.target && !targets.includes(patch.target)) {
    return { ok: false, reason: `Unknown target "${patch.target}".`, suggestion: `Valid: ${targets.join(', ')}` }
  }
  recipe = {
    ...recipe,
    ...patch,
    rewardWeights: { ...recipe.rewardWeights, ...(patch.rewardWeights ?? {}) },
  }
  useStudio.getState().set({ recipeVersion: useStudio.getState().recipeVersion + 1 })
  return { ok: true, recipe: structuredClone(recipe) }
}

export function composeTrainingJob(): Result<{ recipe: Recipe; job: unknown }> {
  return { ok: true, recipe: structuredClone(recipe), job: composeJob(recipe) }
}

/**
 * Download the job as a bundle.
 *
 * Three files rather than a bare command: the runnable script, the recipe as
 * data so it can be re-imported, and a README covering the smoke test and how
 * to bring the resulting weights back. Downloaded as separate files because a
 * zip would need a dependency for no real gain.
 */
export function exportTrainingJob(): Result<{ files: string[] }> {
  const job = composeJob(recipe)
  const files = bundleFiles(recipe, job)
  for (const f of files) {
    const blob = new Blob([f.content], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${recipe.behaviour}-${f.name}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
  return { ok: true, files: files.map((f) => f.name) }
}

// ── Imported policies: the loop closes here ─────────────────────────────────

export interface ImportedPolicy {
  id: string
  label: string
  url: string
  source: 'url' | 'file'
}

const imported = new Map<string, ImportedPolicy>()

export function listImportedPolicies(): ImportedPolicy[] {
  return [...imported.values()]
}

/**
 * Import a policy trained elsewhere and make it immediately evaluable.
 *
 * This is what makes the escalation story real without any bridge or account:
 * export a job, train it on your own GPU, drop the .onnx back in, and A/B it
 * against the baseline over the same scenarios and seeds.
 */
export async function importPolicy(args: { url?: string; name?: string }): Promise<Result<{ imported: unknown }>> {
  const p = requirePolicyRunner()
  if (isErr(p)) return p
  if (!args?.url) {
    return {
      ok: false,
      reason: 'A url is required.',
      suggestion: 'Pass a URL to an .onnx file, or drag the file onto the studio window.',
    }
  }
  const id = args.name?.trim() || `imported-${imported.size + 1}`
  if (POLICIES.some((e) => e.id === id)) {
    return { ok: false, reason: `"${id}" collides with a published policy.`, suggestion: 'Choose another name.' }
  }

  const previous = p.currentPolicy
  try {
    // Loading IS the validation: the 61 -> 14 contract is checked here, so a
    // wrong-shaped file fails now rather than becoming a flailing duck later.
    await p.loadFrom(id, args.url)
  } catch (e) {
    if (previous) {
      const entry = POLICIES.find((x) => x.id === previous)
      if (entry) await p.load(entry.id as PolicyId, entry.file)
    }
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
      suggestion: 'Every Microduck policy must be obs[1,61] -> actions[1,14].',
    }
  }

  const rec: ImportedPolicy = { id, label: args.name ?? id, url: args.url, source: 'url' }
  imported.set(id, rec)
  useStudio.getState().set({
    loadedPolicy: id,
    importedPolicies: [...imported.keys()],
  })
  return {
    ok: true,
    imported: { id, label: rec.label, contract: 'obs[1,61] -> actions[1,14] — validated', loaded: true },
  }
}

/** Import from a File the user dropped or picked. */
export async function importPolicyFile(file: File): Promise<Result<{ imported: unknown }>> {
  const url = URL.createObjectURL(file)
  const name = file.name.replace(/\.onnx$/i, '')
  const r = await importPolicy({ url, name })
  if (!r.ok) URL.revokeObjectURL(url)
  return r
}

// ── Live world settings ──────────────────────────────────────────────────────

let worldHandle: ScenarioHandle | null = null
let world = { slopeDeg: 0, friction: 1.0 }

/** Presets deliberately share values with the eval scenarios, so "make it
 *  slippery" and the Ice row of the eval table mean the same thing. */
export const ENVIRONMENT_PRESETS = {
  flat: { slopeDeg: 0, friction: 1.0, about: 'Default ground.' },
  'gentle-slope': { slopeDeg: 8, friction: 1.0, about: 'An 8 degree incline. The duck stays upright but loses ground.' },
  'steep-slope': { slopeDeg: 15, friction: 1.0, about: '15 degrees. The walking policy falls within about a second.' },
  slippery: { slopeDeg: 0, friction: 0.15, about: 'Measurably harder — travel drops from 0.63 m to about 0.37 m.' },
  ice: { slopeDeg: 0, friction: 0.05, about: 'The walking policy goes down within roughly two seconds.' },
} as const

export function getEnvironment(): Result<{ environment: unknown; presets: unknown }> {
  return {
    ok: true,
    environment: { ...world },
    presets: Object.entries(ENVIRONMENT_PRESETS).map(([id, p]) => ({ id, ...p })),
  }
}

/**
 * Change the world the live robot is standing in.
 *
 * Reuses the same applyScenario used by the evaluation suite, so what the user
 * plays with and what gets measured are the same conditions rather than two
 * implementations that can drift.
 */
export function setEnvironment(args: { preset?: string; slopeDeg?: number; friction?: number }): Result<{
  environment: unknown
}> {
  const s = requireSim()
  if (isErr(s)) return s

  let next = { ...world }
  if (args.preset) {
    const p = ENVIRONMENT_PRESETS[args.preset as keyof typeof ENVIRONMENT_PRESETS]
    if (!p) {
      return {
        ok: false,
        reason: `Unknown preset "${args.preset}".`,
        suggestion: `Valid presets: ${Object.keys(ENVIRONMENT_PRESETS).join(', ')}`,
      }
    }
    next = { slopeDeg: p.slopeDeg, friction: p.friction }
  }
  if (args.slopeDeg !== undefined) next.slopeDeg = Math.max(-30, Math.min(30, args.slopeDeg))
  if (args.friction !== undefined) next.friction = Math.max(0.01, Math.min(2, args.friction))

  worldHandle?.restore()
  worldHandle = null
  world = next

  if (next.slopeDeg !== 0 || next.friction !== 1.0) {
    worldHandle = applyScenario(s, {
      id: 'live', label: 'live',
      slopeDeg: next.slopeDeg || undefined,
      friction: next.friction !== 1.0 ? next.friction : undefined,
    })
  }
  useStudio.getState().set({ environment: { ...world } })
  return {
    ok: true,
    environment: {
      ...world,
      note:
        next.friction >= 0.35 && next.friction < 1
          ? 'Note: friction above about 0.2 barely affects an 800 g duck. Use 0.15 to slow it, 0.05 to put it down.'
          : undefined,
    },
  }
}

/** Drop live world settings so an evaluation measures the scenario alone. */
export function clearLiveEnvironment(): void {
  worldHandle?.restore()
  worldHandle = null
}

/** The eval suite mutates the same fields, so it must restore live settings after. */
export function reapplyEnvironment(): void {
  const s = sim
  if (!s) return
  worldHandle?.restore()
  worldHandle = null
  if (world.slopeDeg !== 0 || world.friction !== 1.0) {
    worldHandle = applyScenario(s, {
      id: 'live', label: 'live',
      slopeDeg: world.slopeDeg || undefined,
      friction: world.friction !== 1.0 ? world.friction : undefined,
    })
  }
}

// ── Props: things to put in the duck's way ──────────────────────────────────

function propJointAddress(s: MicroDuckSim, id: string): number {
  const jid = s.mj.mj_name2id(s.model, s.mj.mjtObj.mjOBJ_JOINT.value, `prop_${id}_free`)
  return jid < 0 ? -1 : s.model.jnt_qposadr[jid]
}

export function listProps(): Result<{ props: unknown[]; spawned: string[] }> {
  return {
    ok: true,
    props: PROPS.map((p) => ({ id: p.id, label: p.label, about: p.about, mass: p.mass })),
    spawned: useStudio.getState().spawnedProps,
  }
}

/**
 * Put a prop in front of the duck.
 *
 * Placed relative to the robot's current position by default, because "in its
 * path" is what anyone actually means — an absolute coordinate would need the
 * user to know where the duck currently is.
 */
export function spawnProp(args: { id: string; ahead?: number; lateral?: number; pitchDeg?: number }): Result<{
  spawned: string
  at: [number, number, number]
}> {
  const s = requireSim()
  if (isErr(s)) return s
  const spec = PROPS.find((p) => p.id === args?.id)
  if (!spec) {
    return {
      ok: false,
      reason: `Unknown prop "${args?.id}".`,
      suggestion: `Valid props: ${PROPS.map((p) => p.id).join(', ')}`,
    }
  }
  const adr = propJointAddress(s, spec.id)
  if (adr < 0) return { ok: false, reason: `Prop "${spec.id}" is not in the loaded scene.` }

  const ahead = args.ahead ?? 0.45
  const lateral = args.lateral ?? 0
  const qpos = s.data.qpos

  // Place along the duck's HEADING, not world +x. Once it has turned — and the
  // walking policy drifts in yaw constantly — "in front of the duck" and
  // "further along x" stop being the same place, and obstacles land beside it.
  const [qw, qx, qy, qz] = [qpos[3], qpos[4], qpos[5], qpos[6]]
  let fx = 1 - 2 * (qy * qy + qz * qz)
  let fy = 2 * (qx * qy + qw * qz)
  const flen = Math.hypot(fx, fy) || 1
  fx /= flen
  fy /= flen
  // Right-hand side of the heading, for the lateral offset.
  const rx = fy
  const ry = -fx

  const x = qpos[0] + fx * ahead + rx * lateral
  const y = qpos[1] + fy * ahead + ry * lateral
  const z = spec.z

  // Face the prop along the duck's heading too, so a ramp or a step is crossed
  // squarely rather than at whatever angle the world axes happen to give.
  const yaw = Math.atan2(fy, fx)
  const pitch = ((args.pitchDeg ?? 0) * Math.PI) / 360
  const halfYaw = yaw / 2
  // Yaw about z composed with an optional pitch about the local y.
  const cy = Math.cos(halfYaw)
  const sy = Math.sin(halfYaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  qpos[adr] = x
  qpos[adr + 1] = y
  qpos[adr + 2] = z
  qpos[adr + 3] = cy * cp
  qpos[adr + 4] = -sy * sp
  qpos[adr + 5] = cy * sp
  qpos[adr + 6] = sy * cp

  // Zero its velocity too, or a re-spawned prop keeps whatever it was doing.
  const vadr = s.model.jnt_dofadr[s.mj.mj_name2id(s.model, s.mj.mjtObj.mjOBJ_JOINT.value, `prop_${spec.id}_free`)]
  for (let i = 0; i < 6; i++) s.data.qvel[vadr + i] = 0
  s.mj.mj_forward(s.model, s.data)

  const spawned = [...new Set([...useStudio.getState().spawnedProps, spec.id])]
  useStudio.getState().set({ spawnedProps: spawned })
  react('obstacle')
  return { ok: true, spawned: spec.id, at: [+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)] }
}

export function clearProps(id?: string): Result<{ cleared: string[] }> {
  const s = requireSim()
  if (isErr(s)) return s
  const targets = id ? PROPS.filter((p) => p.id === id) : PROPS
  if (id && targets.length === 0) {
    return { ok: false, reason: `Unknown prop "${id}".`, suggestion: `Valid: ${PROPS.map((p) => p.id).join(', ')}` }
  }
  for (const spec of targets) {
    const adr = propJointAddress(s, spec.id)
    if (adr < 0) continue
    s.data.qpos[adr] = PARK_X
    s.data.qpos[adr + 1] = 0
    s.data.qpos[adr + 2] = PARK_Z
    s.data.qpos[adr + 3] = 1
    s.data.qpos[adr + 4] = 0
    s.data.qpos[adr + 5] = 0
    s.data.qpos[adr + 6] = 0
    const vadr = s.model.jnt_dofadr[s.mj.mj_name2id(s.model, s.mj.mjtObj.mjOBJ_JOINT.value, `prop_${spec.id}_free`)]
    for (let i = 0; i < 6; i++) s.data.qvel[vadr + i] = 0
  }
  s.mj.mj_forward(s.model, s.data)
  const remaining = id
    ? useStudio.getState().spawnedProps.filter((p) => p !== id)
    : []
  useStudio.getState().set({ spawnedProps: remaining })
  return { ok: true, cleared: targets.map((t) => t.id) }
}

// ── Lessons ─────────────────────────────────────────────────────────────────

export function getLessons(): Result<{ lessons: unknown[]; completed: string[] }> {
  return {
    ok: true,
    lessons: LESSONS.map((l, i) => ({
      number: i + 1, id: l.id, title: l.title, why: l.why, expect: l.expect, ask: l.ask,
    })),
    completed: useStudio.getState().completedLessons,
  }
}

async function runStep(step: LessonStep): Promise<void> {
  switch (step.kind) {
    case 'loadPolicy': await loadPolicy(step.id); break
    case 'setCommand': setCommand(step); break
    case 'reset': resetSim(step.pose ?? 'STAND'); break
    case 'observationSlice': explainObservationSlice(step.slice); break
    case 'recordLibrary': if (rollouts.size === 0) await recordLibrary(); break
    case 'resetObjective': resetObjective(); break
    case 'setRewardWeight': setRewardWeight(step.term, step.weight); break
    case 'runEval': await runEvalSuite({}); break
    case 'setEnvironment': setEnvironment({ preset: step.preset }); break
    case 'spawnProp': spawnProp({ id: step.id, ahead: step.ahead }); break
    case 'clearProps': clearProps(); break
    case 'wait': await new Promise((r) => setTimeout(r, step.ms)); break
  }
}

/**
 * Run a lesson: perform its actions, then hand back what to look at and what to
 * ask the agent.
 *
 * The steps are the same core commands everything else uses, so a lesson cannot
 * demonstrate behaviour the app does not really have.
 */
export async function startLesson(id: string): Promise<Result<{ lesson: unknown }>> {
  const lesson: Lesson | undefined = LESSONS.find((l) => l.id === id)
  if (!lesson) {
    return {
      ok: false,
      reason: `Unknown lesson "${id}".`,
      suggestion: `Valid lessons: ${LESSONS.map((l) => l.id).join(', ')}`,
    }
  }
  useStudio.getState().set({ activeLesson: id })
  try {
    for (const step of lesson.steps) await runStep(step)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  const completed = [...new Set([...useStudio.getState().completedLessons, id])]
  useStudio.getState().set({ completedLessons: completed })
  return {
    ok: true,
    lesson: {
      id: lesson.id, title: lesson.title, why: lesson.why,
      nowLookAt: lesson.expect,
      suggestedQuestion: lesson.ask,
    },
  }
}

// ── Falling over, and getting helped up ─────────────────────────────────────

let fallenSince = 0

/**
 * Watch for the robot going down.
 *
 * Called every frame, but only writes to the store on a transition — a biped
 * wobbles, and a per-frame write would rerender the whole panel sixty times a
 * second for no reason.
 *
 * A fall has to persist for half a second before it counts. Uprightness dips
 * below the threshold briefly during a hard recovery, and a bubble that flashes
 * up mid-stumble reads as a bug rather than a joke.
 */
export function updateFallState(): void {
  const s = sim
  if (!s) return
  const st = useStudio.getState()
  if (st.review) return // reviewing a recording, not driving the robot

  const trunk = s.mj.mj_name2id(s.model, s.mj.mjtObj.mjOBJ_BODY.value, 'trunk_base')
  if (trunk < 0) return
  const upright = s.data.xmat[trunk * 9 + 8]
  const height = s.data.qpos[2]
  const down = upright < 0.4 || height < 0.06

  // Publish uprightness, but only on meaningful change — this runs every frame
  // and a per-frame store write would rerender the panel sixty times a second.
  if (Math.abs(upright - st.upright) > 0.05) useStudio.getState().set({ upright })

  const now = performance.now()
  if (down) {
    if (fallenSince === 0) fallenSince = now
    if (!st.fallen && now - fallenSince > 500) {
      useStudio.getState().set({ fallen: true })
      if (st.autoWake) void wakeDuck()
      else reactToFall()
    }
  } else {
    fallenSince = 0
    if (st.fallen && upright > 0.7) {
      useStudio.getState().set({ fallen: false })
      if (useStudio.getState().bubble?.kind === 'fall') dismissBubble()
    }
  }
}

/**
 * Help the duck back onto its feet.
 *
 * Resets to the STAND keyframe rather than running a recovery policy, because
 * none of the nine published policies can get up off the floor — the studio is
 * honest about lifting it rather than pretending it recovered on its own.
 */
export async function wakeDuck(): Promise<Result<{ woken: true; note: string }>> {
  const s = requireSim()
  if (isErr(s)) return s
  s.reset('STAND')
  fallenSince = 0
  useStudio.getState().set({ fallen: false })
  dismissBubble()
  return {
    ok: true,
    woken: true,
    note:
      'Lifted back to the home pose. None of the published policies can stand up from the floor, ' +
      'so this is a hand up rather than a recovery — training a get-up behaviour is its own task ' +
      '(Mjlab-StandUp-Flat-MicroDuck).',
  }
}

export function setAutoWake(on: boolean): Result<{ autoWake: boolean }> {
  useStudio.getState().set({ autoWake: on })
  return { ok: true, autoWake: on }
}

/** Actions a bubble can offer. Named so content stays data, not callbacks. */
export async function runBubbleAction(id: ActionId): Promise<void> {
  noteInteraction()
  switch (id) {
    case 'walk': setCommand({ vx: 0.3, vy: 0, vyaw: 0 }); break
    case 'stop': setCommand({ vx: 0, vy: 0, vyaw: 0 }); break
    case 'lesson1': await startLesson('observations'); break
    case 'spawn-box': spawnProp({ id: 'small-box' }); break
    case 'spawn-stairs': spawnProp({ id: 'stairs', ahead: 0.55 }); break
    case 'run-eval': await runEvalSuite({}); break
    case 'record-library': await recordLibrary(); break
    case 'wake': await wakeDuck(); break
    case 'ice': setEnvironment({ preset: 'ice' }); break
    case 'flat': setEnvironment({ preset: 'flat' }); break
  }
  dismissBubble()
}

/** Called from the render loop; internally rate-limited. */
export function tickChatter(): void {
  maybeIdle()
}

export { dismissBubble, noteInteraction, react } from './bubbles'
