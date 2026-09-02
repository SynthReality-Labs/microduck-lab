import { useState } from 'react'
import { useStudio } from '../core/store'
import { startLesson } from '../core/commands'
import { LESSONS } from '../knowledge/lessons'

/**
 * A guided path, not a course.
 *
 * Each lesson performs a real action and then hands the user a question for the
 * agent. The explaining is done by something that can read the live state.
 */
export function LessonsPanel() {
  const completed = useStudio((s) => s.completedLessons)
  const active = useStudio((s) => s.activeLesson)
  const status = useStudio((s) => s.status)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ id: string; expect: string; ask: string } | null>(null)

  const run = async (id: string) => {
    setBusy(id)
    setResult(null)
    const r = await startLesson(id)
    setBusy(null)
    if (r.ok) {
      const l = r.lesson as { nowLookAt: string; suggestedQuestion: string }
      setResult({ id, expect: l.nowLookAt, ask: l.suggestedQuestion })
    }
  }

  return (
    <section className="lessons">
      <h2>
        <button className="disclose" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'}</button>
        Learn RL{' '}
        <span className="pill">{completed.length}/{LESSONS.length}</span>
      </h2>

      {open && (
        <ol className="lesson-list">
          {LESSONS.map((l, i) => {
            const done = completed.includes(l.id)
            const showing = result?.id === l.id
            return (
              <li key={l.id} className={active === l.id ? 'active' : ''}>
                <div className="lesson-head">
                  <span className={`num ${done ? 'done' : ''}`}>{done ? '✓' : i + 1}</span>
                  <strong>{l.title}</strong>
                  <button onClick={() => void run(l.id)} disabled={status !== 'ready' || busy !== null}>
                    {busy === l.id ? '…' : done ? 'Again' : 'Show me'}
                  </button>
                </div>
                <p className="why">{l.why}</p>
                {showing && (
                  <div className="lesson-result">
                    <p className="expect">{result.expect}</p>
                    <p className="ask-label">Now ask the agent:</p>
                    <p className="ask">“{result.ask}”</p>
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
