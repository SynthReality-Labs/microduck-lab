import { useRef } from 'react'
import { useStudio } from '../core/store'
import {
  clearTimelineRange, closeRollout, getRollout, seekRollout, setReviewPlaying, setTimelineRange,
} from '../core/commands'

/**
 * Rollout timeline with drag-to-select.
 *
 * The range the user drags here is readable by the agent through
 * get_selected_timeline_range, which is what lets "what went wrong here?"
 * resolve without them saying when "here" is.
 */
export function Timeline() {
  const review = useStudio((s) => s.review)
  const barRef = useRef<HTMLDivElement>(null)
  const dragStart = useRef<number | null>(null)

  if (!review) return null
  const ep = getRollout(review.episodeId)
  if (!ep) return null

  const duration = ep.length * ep.dt
  const toSeconds = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration))
  }

  const onDown = (e: React.PointerEvent) => {
    barRef.current?.setPointerCapture(e.pointerId)
    dragStart.current = toSeconds(e.clientX)
    clearTimelineRange()
    seekRollout(dragStart.current)
  }
  const onMove = (e: React.PointerEvent) => {
    if (dragStart.current === null) return
    const now = toSeconds(e.clientX)
    // A click is a seek; a drag is a range. Threshold keeps a slightly shaky
    // click from producing a one-frame "selection".
    if (Math.abs(now - dragStart.current) > duration * 0.01) setTimelineRange(dragStart.current, now)
  }
  const onUp = () => {
    dragStart.current = null
  }

  const pct = (t: number) => `${(t / duration) * 100}%`
  const range = review.range

  return (
    <div className="timeline">
      <div className="tl-head">
        <strong>{ep.label}</strong>
        <button onClick={() => setReviewPlaying(!review.playing)}>{review.playing ? 'Pause' : 'Play'}</button>
        <span className="tl-t">
          {(review.frame * ep.dt).toFixed(2)}s / {duration.toFixed(2)}s
        </span>
        {range && (
          <span className="pill">
            {(range.startFrame * ep.dt).toFixed(2)}s – {(range.endFrame * ep.dt).toFixed(2)}s selected
          </span>
        )}
        {range && <button onClick={() => clearTimelineRange()}>Clear range</button>}
        <button onClick={() => closeRollout()}>Close</button>
      </div>

      <div
        className="tl-bar"
        ref={barRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        title="Click to seek, drag to select a range"
      >
        {/* upright trace: dips show the robot going over */}
        <svg className="tl-trace" viewBox={`0 0 ${ep.length} 100`} preserveAspectRatio="none">
          <polyline
            points={Array.from({ length: ep.length }, (_, i) => `${i},${50 - -ep.gravZ[i] * 45}`).join(' ')}
          />
        </svg>
        {range && (
          <div
            className="tl-range"
            style={{
              left: pct(range.startFrame * ep.dt),
              width: pct((range.endFrame - range.startFrame) * ep.dt),
            }}
          />
        )}
        <div className="tl-head-marker" style={{ left: pct(review.frame * ep.dt) }} />
      </div>
    </div>
  )
}
