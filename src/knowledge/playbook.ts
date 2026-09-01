/**
 * Microduck RL knowledge, served to the agent through WebMCP.
 *
 * This is what replaces a Custom GPT: the site supplies domain expertise and
 * live state, ChatGPT supplies reasoning. An agent that has never heard of
 * Microduck can call these and answer correctly.
 *
 * Source: pollen-robotics/microduck_rl AGENTS.md (Apache-2.0) — Pollen's own
 * distilled playbook, described upstream as "the reward-design lessons that
 * made it work". CLAUDE.md in that repo is an 11-byte `@AGENTS.md` include.
 */

const PLAYBOOK_URL = `${import.meta.env.BASE_URL}assets/knowledge/microduck-rl-playbook.md`

let cache: string | null = null

async function loadPlaybook(): Promise<string> {
  if (cache) return cache
  const res = await fetch(PLAYBOOK_URL)
  if (!res.ok) throw new Error(`playbook unavailable: ${res.status}`)
  cache = await res.text()
  return cache
}

/** Section headings in the upstream playbook, as agent-facing topics. */
export const PLAYBOOK_TOPICS = {
  'reward-design': 'Reward design — rules that were each learned the hard way',
  'commands-observations': 'Commands, observations, dead weights',
  curricula: 'Curricula',
  'training-ops': 'Training ops & reading a run',
  sim2real: 'Sim2real footguns (cost real debugging weeks)',
  invariants: 'Invariants — do not break these',
  'building-an-env': 'Building a new env — the workflow',
} as const

export type PlaybookTopic = keyof typeof PLAYBOOK_TOPICS

/** Return one section of the playbook, verbatim. */
export async function getPlaybookSection(topic: PlaybookTopic): Promise<string> {
  const text = await loadPlaybook()
  const heading = PLAYBOOK_TOPICS[topic]
  const start = text.indexOf(`## ${heading}`)
  if (start < 0) throw new Error(`section "${heading}" not found in playbook`)
  const next = text.indexOf('\n## ', start + 1)
  return text.slice(start, next < 0 ? undefined : next).trim()
}

/**
 * Reward terms that actually appear in Microduck's training envs, with the
 * failure mode each one exists to prevent.
 *
 * Curated from the playbook rather than generic RL description, so an
 * explanation lands on this robot instead of on textbook theory.
 */
export const REWARD_TERMS: Record<string, { what: string; watchFor: string }> = {
  track_lin_vel: {
    what: 'Pays for matching the commanded forward/lateral velocity, as a Gaussian on the error.',
    watchFor:
      'Set the Gaussian std to the error you still care about, not the max error — too loose and there is no gradient at small errors.',
  },
  track_ang_vel: {
    what: 'Pays for matching the commanded yaw rate.',
    watchFor:
      'Turn-in-place is rare under uniform command sampling (~2% of experience) and never trains unless it gets its own bucket.',
  },
  upright: {
    what: 'Keeps the trunk vertical, usually via projected gravity or a tilt cosine.',
    watchFor:
      'Never gate a positive reward on being in a bad state — a policy parks in the cheapest qualifying pose and farms it. Prefer potential-based shaping: pay the change, not the level.',
  },
  action_rate_l2: {
    what: 'Smoothness: penalises how fast actions change between control steps.',
    watchFor:
      'Introduce it AFTER skill discovery. Any attempt-tax active while a hard skill is still being explored makes "do nothing" win.',
  },
  body_ang_vel: {
    what: 'A motion-blocker: penalises trunk angular velocity.',
    watchFor:
      'This penalises what a dynamic motion physically requires. Keep it LOW for dynamic tasks or the policy simply stops moving.',
  },
  energy: {
    what: 'Penalises actuator effort.',
    watchFor:
      'Compare reward MASS, not weights, when copying between envs — the same weight is 4x weaker against a 4x larger positive stack.',
  },
  foot_slip: {
    what: 'Penalises feet sliding while in contact.',
    watchFor: 'Sign convention: it must read <= 0 in the logs.',
  },
  foot_clearance: {
    what: 'Rewards lifting the swing foot to a target height.',
    watchFor: 'A "reach X" reward that then pays per step is a jackpot — rate-limit or slew it.',
  },
  air_time: {
    what: 'Rewards keeping each foot airborne for a target duration, producing stepping rather than shuffling.',
    watchFor: 'Under-specified gait rewards get farmed — encode what counts as a step with contact gates, not nudges.',
  },
  dof_pos_limits: {
    what: 'Penalises joints approaching their travel limits.',
    watchFor:
      'The stock term only fires in the last ~7.5% of range. Joints parking on limits need a dedicated qpos-side proximity penalty.',
  },
  self_collisions: {
    what: 'Penalises the robot intersecting itself.',
    watchFor: 'Sign convention: must read <= 0.',
  },
}

/**
 * The single most load-bearing rule in the playbook, surfaced on its own
 * because it is the one that silently produces a broken policy.
 */
export const SIGN_CONVENTION_RULE =
  'mjlab-base cost functions return >= 0 and take a NEGATIVE weight. Microduck self-negating ' +
  'functions (*_penalty, *_l1, returning <= 0) take a POSITIVE weight. A negative weight on a ' +
  'self-negating penalty double-negates into a reward for the violation, and the policy will farm ' +
  'it — this is where butt-hopping and crash-sits come from. The infallible check: every ' +
  'Episode_Reward/<penalty> must be <= 0 on every run.'
