import { useStudio } from './store'
import {
  FALL_QUIPS, IDLE_THOUGHTS, ON_OBSTACLE, ON_PUSH, ON_SELECT, ON_WALK, SUGGESTIONS,
  pick, type ActionId, type BubbleContent, type BubbleKind,
} from '../knowledge/chatter'

export interface ActiveBubble {
  id: number
  kind: BubbleKind
  text: string
  ask?: string
  action?: { label: string; id: ActionId }
  /** Persistent bubbles wait for the user; the rest fade on their own. */
  persistent: boolean
}

/**
 * When the duck is allowed to speak.
 *
 * The failure mode for a talking mascot is talking too much, so silence is the
 * default and every path here is rate-limited. A bubble that appears twice in
 * ten seconds stops being charming immediately.
 */
const MIN_GAP_MS = 14_000
const IDLE_AFTER_MS = 22_000
const REACT_COOLDOWN_MS = 30_000

/**
 * How long a transient bubble lives.
 *
 * Was 7 s, which is enough to notice a bubble and not enough to read it, decide,
 * and click — so the affordance kept expiring mid-decision. Long enough to act
 * on, and the countdown makes the remaining time legible instead of a surprise.
 */
const TRANSIENT_MS = 14_000

let nextId = 1
let lastShownAt = 0
let lastInteractionAt = Date.now()
const lastByKind = new Map<string, number>()

/**
 * Expiry is a deadline checked each frame rather than a setTimeout, so it can
 * be paused. A timer the user cannot stop is the reason the old one felt hostile.
 */
let expiresAt = 0
let holds = 0
let pausedRemaining = 0

/** Freeze the countdown — hovering, or pinning by clicking. */
export function holdBubble(): void {
  if (!expiresAt) return
  if (holds === 0) pausedRemaining = Math.max(0, expiresAt - Date.now())
  holds++
}

export function releaseBubble(): void {
  if (holds === 0) return
  holds--
  if (holds === 0 && pausedRemaining > 0) expiresAt = Date.now() + pausedRemaining
}

/** Pin until explicitly dismissed. */
export function pinBubble(): void {
  expiresAt = 0
  holds = 0
  pausedRemaining = 0
  const b = useStudio.getState().bubble
  if (b) useStudio.getState().set({ bubble: { ...b, persistent: true } })
}

/** Fraction of life remaining, 1 to 0. Returns null when nothing is counting down. */
export function bubbleRemaining(): number | null {
  if (!expiresAt) return null
  const left = holds > 0 ? pausedRemaining : expiresAt - Date.now()
  return Math.max(0, Math.min(1, left / TRANSIENT_MS))
}

/** Called every frame; retires the bubble when its deadline passes. */
export function tickBubble(): void {
  if (!expiresAt || holds > 0) return
  if (Date.now() >= expiresAt) dismissBubble()
}

/** Any deliberate user or agent action postpones idle chatter. */
export function noteInteraction(): void {
  lastInteractionAt = Date.now()
}

function show(content: BubbleContent, kind: BubbleKind, persistent: boolean): void {
  const bubble: ActiveBubble = {
    id: nextId++,
    kind,
    text: content.text,
    ask: content.ask,
    action: content.action,
    persistent,
  }
  lastShownAt = Date.now()
  holds = 0
  pausedRemaining = 0
  expiresAt = persistent ? 0 : Date.now() + TRANSIENT_MS
  useStudio.getState().set({ bubble })
}

export function dismissBubble(): void {
  expiresAt = 0
  holds = 0
  pausedRemaining = 0
  useStudio.getState().set({ bubble: null })
}

/**
 * A reaction to something that just happened.
 *
 * Skipped if the duck spoke recently, or if this same kind of event spoke within
 * the cooldown — poking the robot ten times should not produce ten quips.
 */
export function react(event: 'walk' | 'push' | 'obstacle' | 'select', arg?: string): void {
  noteInteraction()
  const current = useStudio.getState().bubble
  if (current?.persistent) return // a fall outranks banter
  const now = Date.now()
  if (now - lastShownAt < MIN_GAP_MS) return
  if (now - (lastByKind.get(event) ?? 0) < REACT_COOLDOWN_MS) return
  lastByKind.set(event, now)

  const pool =
    event === 'walk' ? ON_WALK
    : event === 'push' ? ON_PUSH
    : event === 'obstacle' ? ON_OBSTACLE
    : ON_SELECT(arg ?? 'joint')
  show(pick(pool), 'react', false)
}

/** The duck has gone down. Persistent, because it needs a decision. */
export function reactToFall(): void {
  show(pick(FALL_QUIPS), 'fall', true)
}

/**
 * Idle chatter: a thought, or something to try.
 *
 * Weighted towards suggestions, because a suggestion can hand the user a
 * question for the agent and a musing cannot.
 */
export function maybeIdle(): void {
  const st = useStudio.getState()
  if (st.bubble || st.fallen || st.review) return
  // Not just "has not latched as fallen": during a violent tumble uprightness
  // swings through the recovery threshold, unlatching for a frame, and idle
  // chatter would appear while the duck is mid-air. Require it to be genuinely
  // upright before musing about anything.
  if (st.upright < 0.8) return
  const now = Date.now()
  if (now - lastShownAt < MIN_GAP_MS) return
  if (now - lastInteractionAt < IDLE_AFTER_MS) return

  lastInteractionAt = now // stagger the next one
  const suggest = Math.random() < 0.65
  show(pick(suggest ? SUGGESTIONS : IDLE_THOUGHTS), suggest ? 'suggest' : 'idle', false)
}
