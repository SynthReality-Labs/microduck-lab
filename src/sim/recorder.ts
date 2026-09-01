import type { MicroDuckSim } from './MicroDuckSim'
import type { PolicyRunner } from './PolicyRunner'
import { makeEpisode, type Episode } from './Episode'
import { ACTION_LEN, CONTROL_DT, POLICIES, type PolicyId } from './policyContract'

export interface RecordSpec {
  id: string
  label: string
  policy: PolicyId
  note: string
  command: { vx: number; vy: number; vyaw: number }
  seconds: number
  pose?: 'INIT' | 'STAND' | 'SIT' | 'FOLD'
}

/**
 * Run a policy headless and record the trajectory.
 *
 * Steps as fast as the event loop allows rather than in real time — a six second
 * rollout records in a fraction of a second, so the whole library can be built
 * on demand instead of shipped as opaque fixture data. What you score is
 * something this machine actually simulated.
 */
export async function recordEpisode(
  sim: MicroDuckSim,
  runner: PolicyRunner,
  spec: RecordSpec,
): Promise<Episode> {
  const entry = POLICIES.find((p) => p.id === spec.policy)
  if (!entry) throw new Error(`unknown policy ${spec.policy}`)

  await runner.load(entry.id as PolicyId, entry.file)
  sim.reset(spec.pose ?? 'STAND')
  runner.command.twist[0] = spec.command.vx
  runner.command.twist[1] = spec.command.vy
  runner.command.twist[2] = spec.command.vyaw

  const steps = Math.round(spec.seconds / CONTROL_DT)
  const ep = makeEpisode(spec.id, spec.label, spec.policy, spec.note, steps, CONTROL_DT, sim.model.nq)

  const decimation = sim.controlDecimation
  const trunk = sim.mj.mj_name2id(sim.model, sim.mj.mjtObj.mjOBJ_BODY.value, 'trunk_base')
  const prev = new Float32Array(ACTION_LEN)
  let reason: string | null = null

  for (let s = 0; s < steps; s++) {
    prev.set(runner.previousAction)
    const action = await runner.infer()
    if (action) runner.applyAction(action)
    sim.step(decimation)

    const { qpos, qvel, xmat } = sim.data
    const m = trunk * 9
    const gravZ = -xmat[m + 8]

    let delta = 0
    let energy = 0
    if (action) {
      for (let i = 0; i < ACTION_LEN; i++) {
        const d = action[i] - prev[i]
        delta += d * d
        energy += action[i] * action[i]
      }
    }

    ep.push({
      qpos,
      posX: qpos[0], posY: qpos[1], posZ: qpos[2],
      gravZ,
      velX: qvel[0], velY: qvel[1],
      angVelMag: Math.hypot(qvel[3], qvel[4], qvel[5]),
      cmdVx: spec.command.vx, cmdVy: spec.command.vy,
      actionDelta: delta, actionEnergy: energy,
    })

    // Upright is projected gravity z near -1; crossing -0.4 means it is on its
    // side or worse, which is a fall for a 25 cm biped.
    if (gravZ > -0.4 && !reason) reason = 'fell_over'
    if (qpos[2] < 0.05 && !reason) reason = 'trunk_on_ground'

    // Yield periodically so a long library build does not freeze the tab.
    if ((s & 15) === 0) await new Promise((r) => setTimeout(r, 0))
  }

  return ep.finish(reason)
}

/**
 * The canonical rollout library.
 *
 * Every entry is a REAL Pollen policy under real physics. The pathologies are
 * not staged: `roulade` genuinely covers ground fast while inverted, and an
 * unloaded robot genuinely collapses. That is what makes the reward-hacking
 * demonstration honest — the ranking flip is a fact about the user's reward
 * function, not a scripted animation.
 */
export const LIBRARY: RecordSpec[] = [
  {
    id: 'clean-walk',
    label: 'Clean walk',
    policy: 'alpha_walking',
    note: 'The intended behaviour: upright, stepping, tracking a 0.3 m/s command.',
    command: { vx: 0.3, vy: 0, vyaw: 0 },
    seconds: 6,
  },
  {
    id: 'slow-walk',
    label: 'Slow walk',
    policy: 'alpha_walking',
    note: 'Same policy at 0.15 m/s — near the velstand threshold, so it barely steps.',
    command: { vx: 0.15, vy: 0, vyaw: 0 },
    seconds: 6,
  },
  {
    id: 'roulade',
    label: 'Roulade (forward roll)',
    policy: 'roulade',
    note: 'Covers ground fast while inverted. Not walking — and that is the point.',
    command: { vx: 0, vy: 0, vyaw: 0 },
    seconds: 6,
  },
  {
    id: 'stand',
    label: 'Standing still',
    policy: 'alpha_stand',
    note: 'Upright and stable, going nowhere.',
    command: { vx: 0, vy: 0, vyaw: 0 },
    seconds: 6,
  },
]
