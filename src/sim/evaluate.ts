import type { MicroDuckSim } from './MicroDuckSim'
import type { PolicyRunner } from './PolicyRunner'
import { ACTION_LEN, CONTROL_DT, POLICIES, type PolicyId } from './policyContract'
import { applyScenario, jitterStart, type Scenario } from './scenarios'

export interface EpisodeResult {
  scenario: string
  seed: number
  survived: boolean
  failureReason: string | null
  failedAt: number | null
  distance: number
  meanSpeed: number
  minUpright: number
  meanEnergy: number
}

export interface ScenarioSummary {
  scenario: string
  label: string
  episodes: number
  survived: number
  successRate: number
  meanDistance: number
  meanSpeed: number
  worstUpright: number
  failures: { seed: number; reason: string; at: number }[]
}

export interface EvalReport {
  policy: string
  command: { vx: number; vy: number; vyaw: number }
  seconds: number
  seeds: number[]
  overallSuccessRate: number
  scenarios: ScenarioSummary[]
}

/**
 * Run one policy across scenarios x seeds and report where it holds up.
 *
 * Runs on the main thread with periodic yields rather than in a worker pool: a
 * worker would need its own MuJoCo instance and ONNX session, and at roughly a
 * second per episode the suite finishes faster than that plumbing would take to
 * write. Revisit if the suite ever grows past a few dozen episodes.
 */
export async function evaluatePolicy(
  sim: MicroDuckSim,
  runner: PolicyRunner,
  opts: {
    policy: PolicyId
    scenarios: Scenario[]
    seeds: number[]
    seconds?: number
    command?: { vx: number; vy: number; vyaw: number }
    onProgress?: (done: number, total: number, label: string) => void
  },
): Promise<EvalReport> {
  const entry = POLICIES.find((p) => p.id === opts.policy)
  if (!entry) throw new Error(`unknown policy ${opts.policy}`)
  await runner.load(entry.id as PolicyId, entry.file)

  const seconds = opts.seconds ?? 5
  const command = opts.command ?? { vx: 0.3, vy: 0, vyaw: 0 }
  const steps = Math.round(seconds / CONTROL_DT)
  const decimation = sim.controlDecimation
  const trunk = sim.mj.mj_name2id(sim.model, sim.mj.mjtObj.mjOBJ_BODY.value, 'trunk_base')

  const total = opts.scenarios.length * opts.seeds.length
  let done = 0
  const summaries: ScenarioSummary[] = []

  for (const sc of opts.scenarios) {
    const results: EpisodeResult[] = []
    const handle = applyScenario(sim, sc)
    try {
      for (const seed of opts.seeds) {
        opts.onProgress?.(done, total, `${sc.label} · seed ${seed}`)

        sim.reset('STAND')
        jitterStart(sim, seed)
        runner.command.twist[0] = command.vx
        runner.command.twist[1] = command.vy
        runner.command.twist[2] = command.vyaw

        const startX = sim.data.qpos[0]
        let minUpright = 1
        let energy = 0
        let failureReason: string | null = null
        let failedAt: number | null = null
        let pushed = false

        for (let s = 0; s < steps; s++) {
          const t = s * CONTROL_DT
          if (sc.push && !pushed && t >= sc.push.at) {
            const dir: Record<string, [number, number]> = {
              front: [-1, 0], back: [1, 0], left: [0, -1], right: [0, 1],
            }
            const d = dir[sc.push.direction]
            sim.data.qvel[0] += d[0] * sc.push.magnitude
            sim.data.qvel[1] += d[1] * sc.push.magnitude
            pushed = true
          }

          const action = await runner.infer()
          if (action) {
            runner.applyAction(action)
            for (let i = 0; i < ACTION_LEN; i++) energy += action[i] * action[i]
          }
          sim.step(decimation)

          const upright = sim.data.xmat[trunk * 9 + 8]
          if (upright < minUpright) minUpright = upright
          if (!failureReason) {
            if (upright < 0.4) { failureReason = 'fell_over'; failedAt = t }
            else if (sim.data.qpos[2] < 0.05) { failureReason = 'trunk_on_ground'; failedAt = t }
            else if (!Number.isFinite(sim.data.qpos[0])) { failureReason = 'nan_state'; failedAt = t }
          }
          if ((s & 15) === 0) await new Promise((r) => setTimeout(r, 0))
        }

        const distance = sim.data.qpos[0] - startX
        results.push({
          scenario: sc.id,
          seed,
          survived: failureReason === null,
          failureReason,
          failedAt: failedAt === null ? null : +failedAt.toFixed(2),
          distance: +distance.toFixed(3),
          meanSpeed: +(distance / seconds).toFixed(3),
          minUpright: +minUpright.toFixed(3),
          meanEnergy: +(energy / steps).toFixed(3),
        })
        done++
      }
    } finally {
      handle.restore()
    }

    const survived = results.filter((r) => r.survived).length
    summaries.push({
      scenario: sc.id,
      label: sc.label,
      episodes: results.length,
      survived,
      successRate: +(survived / results.length).toFixed(3),
      meanDistance: +(results.reduce((a, r) => a + r.distance, 0) / results.length).toFixed(3),
      meanSpeed: +(results.reduce((a, r) => a + r.meanSpeed, 0) / results.length).toFixed(3),
      worstUpright: +Math.min(...results.map((r) => r.minUpright)).toFixed(3),
      failures: results
        .filter((r) => !r.survived)
        .map((r) => ({ seed: r.seed, reason: r.failureReason!, at: r.failedAt! })),
    })
  }

  opts.onProgress?.(total, total, 'done')
  const allEpisodes = summaries.reduce((a, s) => a + s.episodes, 0)
  const allSurvived = summaries.reduce((a, s) => a + s.survived, 0)

  return {
    policy: opts.policy,
    command,
    seconds,
    seeds: opts.seeds,
    overallSuccessRate: +(allSurvived / allEpisodes).toFixed(3),
    scenarios: summaries,
  }
}
