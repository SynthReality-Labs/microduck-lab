/**
 * What the duck says, and when.
 *
 * Three rules kept this from becoming an irritating mascot:
 *
 * 1. Never say something false. The flavour lines are things that are actually
 *    true about this robot — it really does not know where it is, it really does
 *    decide every 20 ms. A joke that teaches beats a joke that does not.
 * 2. Most bubbles point at the agent. The studio's whole argument is that a
 *    human and an agent are better together, and a user who never opens ChatGPT
 *    never sees that. So the duck keeps handing them a question worth asking.
 * 3. Silence is the default. Timing lives in bubbles.ts; the content here is
 *    written assuming it appears rarely.
 */

export type BubbleKind = 'idle' | 'suggest' | 'react' | 'fall'

export interface BubbleContent {
  text: string
  /** A question to put to the agent. Shown as a tap-to-copy prompt. */
  ask?: string
  /** A named action the UI knows how to run. */
  action?: { label: string; id: ActionId }
}

export type ActionId =
  | 'walk'
  | 'stop'
  | 'lesson1'
  | 'spawn-box'
  | 'spawn-stairs'
  | 'run-eval'
  | 'record-library'
  | 'wake'
  | 'ice'
  | 'flat'

/** Pure flavour. Every one is true about this robot. */
export const IDLE_THOUGHTS: BubbleContent[] = [
  { text: 'I have no idea where I am. I only know which way is down.' },
  { text: 'Sixty-one numbers in, fourteen numbers out. That is my whole personality.' },
  { text: 'Every twenty milliseconds I decide what to do with my legs. Forever.' },
  { text: 'Standing still is not resting. Standing still is work.' },
  { text: 'I was trained in a simulation. This is also a simulation. I have questions.' },
  { text: 'My mouth is not in the action vector. I am told this is fine.' },
  { text: 'Somewhere there is a version of me that learned to roll instead.' },
  { text: 'I cannot see you. I have a camera on the real robot, but not in here.' },
]

/** Things to do next. Most of these route the user to the agent. */
export const SUGGESTIONS: BubbleContent[] = [
  {
    text: 'New here? Start with what I actually see.',
    action: { label: 'Lesson 1', id: 'lesson1' },
  },
  {
    text: 'Try asking your agent to make me walk. It has the controls too.',
    ask: 'Make the duck walk forward at 0.3 m/s',
  },
  { text: 'Want to see me move?', action: { label: 'Walk', id: 'walk' } },
  {
    text: 'Put something in my way and see what happens.',
    action: { label: 'Drop a box', id: 'spawn-box' },
  },
  {
    text: 'Your agent can read my joints better than you can. Give it a go.',
    ask: 'Which of the duck\'s joints is furthest from its home pose right now?',
  },
  {
    text: 'Ask your agent where I fall over. I would rather not find out myself.',
    ask: 'Run the eval suite on alpha_walking and tell me where it is fragile',
  },
  {
    text: 'There is a reward function deciding what counts as good. Want to break it?',
    action: { label: 'Show me', id: 'record-library' },
  },
  {
    text: 'Your agent knows the reward-design playbook from the people who trained me.',
    ask: 'What does the Microduck playbook say about reward sign conventions?',
  },
  { text: 'Make the floor slippery. I dare you.', action: { label: 'Ice', id: 'ice' } },
  {
    text: 'Stairs are genuinely hard for me. Want to watch?',
    action: { label: 'Stairs', id: 'spawn-stairs' },
  },
]

export const ON_WALK: BubbleContent[] = [
  { text: 'Look at me go.' },
  { text: 'Left. Right. Left. Try not to think about it too hard.' },
  { text: 'I am tracking about 43% of the velocity you asked for. Sorry.' },
  { text: 'This gait cost somebody two GPU-hours.' },
]

export const ON_PUSH: BubbleContent[] = [
  { text: 'Rude.' },
  { text: 'I felt that.' },
  {
    text: 'Your agent can push me too, you know.',
    ask: 'Push the duck hard from the front and tell me why it fell',
  },
  { text: 'Domain randomization exists so that hurt less than it could have.' },
]

export const ON_OBSTACLE: BubbleContent[] = [
  { text: 'Oh good. An obstacle.' },
  { text: 'I am going to walk into that, aren\'t I.' },
  {
    text: 'Nothing in my observation mentions that thing. I will find it with my face.',
    ask: 'Does the duck\'s observation include anything about obstacles?',
  },
]

export const ON_SELECT = (joint: string): BubbleContent[] => [
  {
    text: `That is my ${joint.replace(/_/g, ' ')}. Ask the agent what it does — it can see the live values.`,
    ask: `What is the ${joint} doing right now, and what is it for?`,
  },
  {
    text: `You clicked my ${joint.replace(/_/g, ' ')}. Your agent already knows which one that is.`,
    ask: 'What am I looking at?',
  },
]

export const FALL_QUIPS: BubbleContent[] = [
  { text: 'Well. That happened.', action: { label: 'Help it up', id: 'wake' } },
  { text: 'I meant to do that.', action: { label: 'Help it up', id: 'wake' } },
  { text: 'Ground: 1. Me: 0.', action: { label: 'Help it up', id: 'wake' } },
  {
    text: 'I have fallen and I cannot get up — there is genuinely no get-up policy.',
    action: { label: 'Help it up', id: 'wake' },
    ask: 'Why can none of the published policies stand back up?',
  },
  { text: 'This is fine. This is a valid pose.', action: { label: 'Help it up', id: 'wake' } },
  { text: 'Gravity remains undefeated.', action: { label: 'Help it up', id: 'wake' } },
]

export function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]
}
