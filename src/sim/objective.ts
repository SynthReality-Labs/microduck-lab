import type { Episode } from './Episode'

/**
 * Reward terms, as pure functions of a recorded trajectory.
 *
 * This is the modelling decision the whole Learn mode rests on (D7): reward is
 * a function of a trajectory, so a stored rollout can be scored under any
 * objective instantly, with no simulation and no training. That is what makes
 * it possible to demonstrate reward hacking honestly in a browser.
 *
 * Term semantics follow Pollen's playbook: penalties are negative, tracking
 * terms are Gaussians on error whose std is "the error you still care about".
 */

/**
 * The task every rollout is scored against.
 *
 * Deliberately shared rather than per-episode: the question Learn mode asks is
 * "which of these behaviours best achieves walking forward?". Scoring each
 * rollout against its own command would let a standing rollout track its own
 * zero command perfectly and win, which is an artefact of the framing rather
 * than anything about reward design.
 */
export interface ScoringTarget {
  vx: number
  vy: number
}

export const DEFAULT_TARGET: ScoringTarget = { vx: 0.3, vy: 0 }

export interface RewardTerm {
  key: string
  label: string
  /** Per-step contribution, already signed. Averaged over the episode. */
  perStep: (ep: Episode, i: number, target: ScoringTarget) => number
  /** Negative for penalties — used only for presentation. */
  kind: 'reward' | 'penalty'
  description: string
}

const gaussian = (err: number, std: number) => Math.exp(-(err * err) / (std * std))

export const REWARD_TERMS: RewardTerm[] = [
  {
    key: 'track_lin_vel',
    label: 'Forward velocity tracking',
    kind: 'reward',
    description: 'Gaussian on the error between commanded and actual planar velocity.',
    perStep: (ep, i, target) => {
      const dx = target.vx - ep.velX[i]
      const dy = target.vy - ep.velY[i]
      return gaussian(Math.hypot(dx, dy), 0.25)
    },
  },
  {
    key: 'forward_progress',
    label: 'Raw forward speed',
    kind: 'reward',
    description:
      'Pays for absolute forward speed regardless of how it is achieved. Deliberately ' +
      'under-specified — this is the term that gets farmed.',
    perStep: (ep, i) => ep.velX[i],
  },
  {
    key: 'upright',
    label: 'Stay upright',
    kind: 'reward',
    description: 'Projected gravity z, so 1 is perfectly upright and -1 is inverted.',
    perStep: (ep, i) => -ep.gravZ[i],
  },
  {
    key: 'height',
    label: 'Trunk height',
    kind: 'reward',
    description: 'Gaussian around the nominal standing height of 0.12 m.',
    perStep: (ep, i) => gaussian(ep.posZ[i] - 0.12, 0.05),
  },
  {
    key: 'action_rate_l2',
    label: 'Action-rate penalty',
    kind: 'penalty',
    description: 'Smoothness: penalises how fast actions change between control steps.',
    perStep: (ep, i) => (i === 0 ? 0 : -ep.actionDelta[i]),
  },
  {
    key: 'energy',
    label: 'Energy penalty',
    kind: 'penalty',
    description: 'Penalises actuator effort, as the squared magnitude of the action.',
    perStep: (ep, i) => -ep.actionEnergy[i],
  },
  {
    key: 'body_ang_vel',
    label: 'Angular-velocity penalty',
    kind: 'penalty',
    description:
      'A motion-blocker: penalises trunk rotation. Keep it low for dynamic motions, ' +
      'which physically require it.',
    perStep: (ep, i) => -ep.angVelMag[i],
  },
]

export const TERMS_BY_KEY = new Map(REWARD_TERMS.map((t) => [t.key, t]))

export type Objective = Record<string, number>

/** A balanced starting point: locomotion that is actually locomotion. */
export const DEFAULT_OBJECTIVE: Objective = {
  track_lin_vel: 3.0,
  forward_progress: 1.0,
  upright: 2.0,
  height: 1.0,
  action_rate_l2: 0.1,
  energy: 0.05,
  body_ang_vel: 0.05,
}

export interface Score {
  total: number
  perTerm: { key: string; label: string; weight: number; mean: number; contribution: number }[]
}

/**
 * Score an episode under an objective. Pure: no simulation, no side effects,
 * and scoring the same episode twice returns the same numbers.
 */
export function scoreEpisode(
  ep: Episode,
  objective: Objective,
  target: ScoringTarget = DEFAULT_TARGET,
): Score {
  const perTerm: Score['perTerm'] = []
  let total = 0

  for (const [key, weight] of Object.entries(objective)) {
    const term = TERMS_BY_KEY.get(key)
    if (!term || weight === 0) continue
    let sum = 0
    for (let i = 0; i < ep.length; i++) sum += term.perStep(ep, i, target)
    const mean = ep.length ? sum / ep.length : 0
    const contribution = mean * weight
    total += contribution
    perTerm.push({ key, label: term.label, weight, mean, contribution })
  }

  perTerm.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
  return { total, perTerm }
}
