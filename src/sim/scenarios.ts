import type { MicroDuckSim } from './MicroDuckSim'

/**
 * An evaluation condition.
 *
 * SLOPE tilts gravity, with the floor left horizontal. That is not an
 * approximation: a horizontal plane under tilted gravity is the same system as
 * an inclined plane under vertical gravity, viewed in the rotated frame — the
 * angle between the contact normal and gravity is what matters, and it is
 * identical. Only the visual differs.
 *
 * Rotating the floor geom was tried instead and does NOT work: geom_quat on a
 * world-body plane never reaches the solver (the plane normal stayed [0,0,1]
 * and the robot never climbed).
 *
 * The sign matters and was wrong first time round. Gravity's along-surface
 * component points DOWNHILL, so for a slope rising toward +x it must be
 * negative in x. Getting it backwards had the duck strolling 4 m "uphill" in
 * five seconds, versus 0.6 m on the flat — a result too good to be true, which
 * is the only reason the error surfaced.
 *
 * FRICTION needs geom_priority. MuJoCo combines the friction of two contacting
 * geoms by taking the elementwise MAXIMUM, so lowering the floor alone does
 * nothing against feet at 1.0. Raising the floor's priority makes its friction
 * govern the contact outright.
 */
export interface Scenario {
  id: string
  label: string
  /** Degrees of incline the robot walks up. */
  slopeDeg?: number
  /**
   * Floor sliding friction; the plane's default is 1.0.
   *
   * Values chosen from a measured sweep rather than guessed. An 800 g duck has
   * so little to slip that 0.35 changes nothing (0.66 m travelled, versus
   * 0.63 m at full grip). 0.15 measurably slows it to 0.44 m, and 0.05 puts it
   * on the floor.
   */
  friction?: number
  /** A shove part-way through the episode. */
  push?: { at: number; magnitude: number; direction: 'front' | 'back' | 'left' | 'right' }
}

export const SCENARIOS: Scenario[] = [
  { id: 'flat', label: 'Flat ground' },
  { id: 'slope-8', label: '8° slope', slopeDeg: 8 },
  { id: 'slope-15', label: '15° slope', slopeDeg: 15 },
  { id: 'low-friction', label: 'Low friction', friction: 0.15 },
  { id: 'ice', label: 'Ice', friction: 0.05 },
  { id: 'push-light', label: 'Push 0.8 m/s', push: { at: 2.0, magnitude: 0.8, direction: 'front' } },
  { id: 'push-hard', label: 'Push 1.6 m/s', push: { at: 2.0, magnitude: 1.6, direction: 'front' } },
]

/** Deterministic per-seed jitter, so a seed means the same thing every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ScenarioHandle {
  restore: () => void
}

/**
 * Apply a scenario to the model, returning an undo.
 *
 * Mutates the compiled model rather than recompiling: recompiling would mean
 * re-mounting assets and re-deriving indices, and every consumer holding a
 * live view into MjModel/MjData would be pointing at freed memory.
 */
export function applyScenario(sim: MicroDuckSim, sc: Scenario): ScenarioHandle {
  const { model, mj } = sim
  const floor = mj.mj_name2id(model, mj.mjtObj.mjOBJ_GEOM.value, 'floor')

  const g = model.opt.gravity
  const g0 = [g[0], g[1], g[2]]
  const mag = Math.hypot(g0[0], g0[1], g0[2])

  const friction0 = floor >= 0 ? model.geom_friction[floor * 3] : 0
  const priority0 = floor >= 0 ? model.geom_priority[floor] : 0

  if (sc.slopeDeg) {
    const r = (sc.slopeDeg * Math.PI) / 180
    g[0] = -mag * Math.sin(r) // downhill is -x for a slope rising toward +x
    g[2] = -mag * Math.cos(r)
  }
  if (sc.friction !== undefined && floor >= 0) {
    model.geom_friction[floor * 3] = sc.friction
    model.geom_priority[floor] = 1 // otherwise the feet's friction wins the max
  }

  return {
    restore() {
      g[0] = g0[0]
      g[1] = g0[1]
      g[2] = g0[2]
      if (floor >= 0) {
        model.geom_friction[floor * 3] = friction0
        model.geom_priority[floor] = priority0
      }
    },
  }
}

/** Seeded jitter on the starting joint angles, so seeds are not cosmetic. */
export function jitterStart(sim: MicroDuckSim, seed: number, amplitude = 0.02): void {
  const rand = mulberry32(seed)
  const qpos = sim.data.qpos
  for (let i = 7; i < sim.model.nq; i++) qpos[i] += (rand() - 0.5) * 2 * amplitude
  sim.mj.mj_forward(sim.model, sim.data)
}
