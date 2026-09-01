import { useState } from 'react'
import { useStudio } from '../core/store'
import { getEvalReport, runEvalSuite } from '../core/commands'
import type { EvalReport } from '../sim/evaluate'

/** Where a policy holds up, and where it does not. */
export function EvalPanel() {
  const status = useStudio((s) => s.status)
  const evaluating = useStudio((s) => s.evaluating)
  const loadedPolicy = useStudio((s) => s.loadedPolicy)
  const evalPolicies = useStudio((s) => s.evalPolicies)
  const [report, setReport] = useState<EvalReport | null>(null)

  const shown =
    report ??
    (loadedPolicy && evalPolicies.includes(loadedPolicy)
      ? (getEvalReport(loadedPolicy) as { ok: true; report: EvalReport }).report
      : null)

  const run = async () => {
    const r = await runEvalSuite({})
    if (r.ok) setReport(r.report)
  }

  return (
    <section>
      <h2>
        Evaluation{' '}
        {shown && (
          <span className={`pill ${shown.overallSuccessRate >= 0.7 ? 'ok' : 'bad'}`}>
            {(shown.overallSuccessRate * 100).toFixed(0)}% survived
          </span>
        )}
      </h2>

      {evaluating ? (
        <>
          <div className="bar">
            <i style={{ width: `${evaluating.total ? (evaluating.done / evaluating.total) * 100 : 0}%` }} />
          </div>
          <p className="hint" style={{ marginTop: 6 }}>{evaluating.label}</p>
        </>
      ) : (
        <button onClick={() => void run()} disabled={status !== 'ready'}>
          {shown ? 'Re-run' : 'Run eval suite'}
        </button>
      )}

      {shown && !evaluating && (
        <table className="eval">
          <tbody>
            {shown.scenarios.map((s) => (
              <tr key={s.scenario} className={s.successRate === 1 ? 'pass' : s.successRate === 0 ? 'fail' : 'partial'}>
                <td>{s.label}</td>
                <td className="n">{(s.successRate * 100).toFixed(0)}%</td>
                <td className="n dim" title="mean distance travelled">{s.meanDistance.toFixed(2)}m</td>
                <td className="dim" title={s.failures.map((f) => `seed ${f.seed}: ${f.reason} at ${f.at}s`).join('\n')}>
                  {s.failures.length ? `${s.failures[0].reason} @${s.failures[0].at}s` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
