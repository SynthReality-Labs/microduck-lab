import { useMemo, useState } from 'react'
import { useStudio } from '../core/store'
import {
  checkRewardSigns, getObjective, listRollouts, openRollout, recordLibrary, resetObjective,
  scoreRollouts, setRewardWeight,
} from '../core/commands'

/**
 * Learn mode: score recorded rollouts under a reward function you edit.
 *
 * Nothing here retrains anything. Reward is a function of a trajectory, so
 * re-scoring stored rollouts shows what a reward function actually prefers —
 * instantly, and without a GPU. The ranking reordering IS the lesson.
 */
export function LearnPanel() {
  const rolloutIds = useStudio((s) => s.rolloutIds)
  const recording = useStudio((s) => s.recording)
  const objectiveVersion = useStudio((s) => s.objectiveVersion)
  const status = useStudio((s) => s.status)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(true)

  const objective = useMemo(() => {
    void objectiveVersion
    const r = getObjective()
    return r.ok ? r : null
  }, [objectiveVersion])

  const ranking = useMemo(() => {
    void objectiveVersion
    void rolloutIds
    const r = scoreRollouts()
    return r.ok ? r.ranking : []
  }, [objectiveVersion, rolloutIds])

  const audit = useMemo(() => {
    void objectiveVersion
    void rolloutIds
    const r = checkRewardSigns()
    return r.ok ? r : null
  }, [objectiveVersion, rolloutIds])

  const notes = useMemo(() => {
    const r = listRollouts()
    return r.ok
      ? new Map((r.rollouts as { id: string; note: string }[]).map((x) => [x.id, x.note]))
      : new Map<string, string>()
  }, [rolloutIds])

  const record = async () => {
    setBusy(true)
    await recordLibrary()
    setBusy(false)
  }

  const best = ranking[0]?.total ?? 1
  const worst = ranking[ranking.length - 1]?.total ?? 0
  const span = Math.max(best - worst, 0.001)

  return (
    <div className={`learn ${open ? 'open' : 'shut'}`}>
      <div className="learn-head">
        {/* A dock, not a strip: with no rollouts recorded this panel is two
            lines tall and reads as page furniture, so give it a handle that
            says it is a panel and remembers being closed. */}
        <button
          className="learn-disclose"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse reward design' : 'Expand reward design'}
        >
          <span className="chev" aria-hidden>{open ? '▾' : '▸'}</span>
          <h2>Reward design</h2>
        </button>
        {recording ? (
          <span className="pill">recording {recording.label}…</span>
        ) : rolloutIds.length === 0 ? (
          <button onClick={() => void record()} disabled={busy || status !== 'ready'}>
            {busy ? 'Recording…' : 'Record rollout library'}
          </button>
        ) : (
          <>
            {audit && !audit.passed && (
              <span className="pill bad" title={audit.findings[0]?.verdict}>
                sign error: {audit.findings[0]?.term}
              </span>
            )}
            {audit?.passed && <span className="pill ok">signs ok</span>}
            <button onClick={() => resetObjective()}>Reset weights</button>
          </>
        )}
      </div>

      {!open ? null : rolloutIds.length === 0 ? (
        <p className="hint">
          Record four rollouts using the real published policies, then score them under a reward
          function you control. Changing a weight retrains nothing — it reveals what your reward
          function <em>already</em> prefers.
        </p>
      ) : (
        <div className="learn-body">
          <ol className="ranking">
            {ranking.map((r) => (
              <li
                key={r.id}
                title={`${notes.get(r.id) ?? ''}\n\nClick to replay this rollout.`}
                onClick={() => openRollout(r.id)}
                className="clickable"
              >
                <span className="rk">#{r.rank}</span>
                <span className="nm">{r.label}</span>
                <span className="br">
                  <i style={{ width: `${((r.total - worst) / span) * 100}%` }} />
                </span>
                <span className="sc">{r.total.toFixed(2)}</span>
              </li>
            ))}
          </ol>

          <div className="weights">
            {objective &&
              (objective.terms as { key: string; label: string; kind: string }[]).map((t) => {
                const w = (objective.objective as Record<string, number>)[t.key] ?? 0
                return (
                  <label className="slider" key={t.key}>
                    <span>{t.label}</span>
                    <input
                      type="range"
                      min={t.kind === 'penalty' ? -4 : 0}
                      max={10}
                      step={0.05}
                      value={w}
                      onChange={(e) => setRewardWeight(t.key, Number(e.target.value))}
                    />
                    <em className={t.kind === 'penalty' && w < 0 ? 'warn' : ''}>{w.toFixed(2)}</em>
                  </label>
                )
              })}
          </div>
        </div>
      )}
    </div>
  )
}
