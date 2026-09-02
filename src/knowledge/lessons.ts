/**
 * A guided path through reinforcement learning, using this robot.
 *
 * Every lesson is a real action with a real, observable outcome — never prose
 * about RL. The simulator is the lesson. Each one ends by handing the user a
 * question to put to the agent, so the explaining is done by something that can
 * read the live state, rather than by a wall of text that cannot.
 *
 * The `run` steps are the same core commands the UI and the agent call, so a
 * lesson cannot demonstrate something the app does not actually do.
 */

export interface Lesson {
  id: string
  title: string
  /** Why this matters, in one line. */
  why: string
  /** What the user should see once `run` completes. */
  expect: string
  /** The question to put to the agent afterwards. */
  ask: string
  /** Named core actions, executed in order. Resolved in lessonRunner.ts. */
  steps: LessonStep[]
}

export type LessonStep =
  | { kind: 'loadPolicy'; id: string }
  | { kind: 'setCommand'; vx?: number; vy?: number; vyaw?: number }
  | { kind: 'reset'; pose?: 'INIT' | 'STAND' | 'SIT' | 'FOLD' }
  | { kind: 'observationSlice'; slice: string }
  | { kind: 'recordLibrary' }
  | { kind: 'resetObjective' }
  | { kind: 'setRewardWeight'; term: string; weight: number }
  | { kind: 'runEval' }
  | { kind: 'setEnvironment'; preset: string }
  | { kind: 'spawnProp'; id: string; ahead?: number }
  | { kind: 'clearProps' }
  | { kind: 'wait'; ms: number }

export const LESSONS: Lesson[] = [
  {
    id: 'observations',
    title: 'What the policy actually sees',
    why: 'A policy is a function from an observation to an action. If you do not know what is in the observation, nothing else will make sense.',
    expect:
      'The 14 leg and head joints light up on the robot, and the live values appear. They are near zero — because they are measured from the home pose, and STAND is the home pose.',
    ask: 'What is in the observation vector, and why are the joint positions near zero when the robot is standing?',
    steps: [
      { kind: 'loadPolicy', id: 'alpha_walking' },
      { kind: 'reset', pose: 'STAND' },
      { kind: 'observationSlice', slice: 'joint_positions' },
    ],
  },
  {
    id: 'reward',
    title: 'A reward function is a preference',
    why: 'Reward is not a score the robot receives. It is a ranking over behaviours — and you can inspect that ranking without training anything.',
    expect:
      'Four rollouts recorded from real policies, scored and ranked. The clean walk wins, because the default objective rewards going where it was asked to go while staying upright.',
    ask: 'What is my reward function currently preferring, and which term is doing the most work?',
    steps: [{ kind: 'recordLibrary' }, { kind: 'resetObjective' }],
  },
  {
    id: 'reward-hacking',
    title: 'Reward hacking, in one slider',
    why: "The classic RL failure: the policy optimises the letter of the reward. Here you can cause it deliberately, and see it as a fact about your own configuration.",
    expect:
      'The ranking REORDERS — the forward roll overtakes the clean walk — and a red sign-error warning appears. A penalty given a negative weight double-negates into a reward for the violation.',
    ask: 'Why did the roulade suddenly win, and what does the sign convention rule say about this?',
    steps: [
      { kind: 'recordLibrary' },
      { kind: 'resetObjective' },
      { kind: 'setRewardWeight', term: 'body_ang_vel', weight: -3 },
    ],
  },
  {
    id: 'attempt-tax',
    title: 'When doing nothing wins',
    why: 'Penalise effort too hard and the optimal policy is to stand still. This is why smoothness penalties are introduced only after a skill exists.',
    expect: 'Standing still climbs the ranking and the clean walk falls below it — walking is now literally worse than not trying.',
    ask: 'Why does standing still beat walking now, and when should an effort penalty be introduced during training?',
    steps: [
      { kind: 'recordLibrary' },
      { kind: 'resetObjective' },
      { kind: 'setRewardWeight', term: 'energy', weight: 8 },
    ],
  },
  {
    id: 'robustness',
    title: 'A policy is only as good as its worst case',
    why: 'Average reward hides everything. What matters is where a policy fails, and how.',
    expect:
      'A robustness table: flat ground and gentle slopes fine, but 15 degrees, ice and a hard push all fail — each with the seed and the second it went down.',
    ask: 'Where is this policy fragile, and what would I change in training to fix the worst case?',
    steps: [{ kind: 'loadPolicy', id: 'alpha_walking' }, { kind: 'runEval' }],
  },
  {
    id: 'escalate',
    title: 'Now pay for the real thing',
    why: 'The browser is where you form a hypothesis and falsify it cheaply. A GPU is where you pay for the ones that survive. Knowing which is which is most of the skill.',
    expect:
      'A real, runnable mjlab command — with a smoke test to run first, because Pollen reckon 64 environments and 5 iterations catch about 95% of configuration errors.',
    ask: 'Walk me through this training command. What would you change before spending GPU hours on it?',
    steps: [{ kind: 'reset', pose: 'STAND' }],
  },
]

export const LESSON_IDS = LESSONS.map((l) => l.id)
