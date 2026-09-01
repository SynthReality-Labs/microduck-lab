import { useMemo, useState } from 'react'
import { useStudio } from '../core/store'
import {
  composeTrainingJob, exportTrainingJob, getRecipe, importPolicyFile, setRecipe,
} from '../core/commands'
import type { Recipe } from '../sim/recipe'

/**
 * Design here, train elsewhere, bring the weights back.
 *
 * The browser is where a hypothesis is formed and cheaply falsified; the GPU is
 * where you pay for the ones that survive. This panel is the seam between them.
 */
export function EscalatePanel() {
  const recipeVersion = useStudio((s) => s.recipeVersion)
  const imported = useStudio((s) => s.importedPolicies)
  const [importError, setImportError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  const { recipe, tasks } = useMemo(() => {
    void recipeVersion
    const r = getRecipe()
    return r.ok ? r : { recipe: null as Recipe | null, tasks: [] as unknown[] }
  }, [recipeVersion])

  const job = useMemo(() => {
    void recipeVersion
    const r = composeTrainingJob()
    return r.ok ? (r.job as { command: string; estimate: string; warnings: string[] }) : null
  }, [recipeVersion])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDropping(false)
    setImportError(null)
    const file = e.dataTransfer.files[0]
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.onnx')) {
      setImportError('Expected a .onnx file.')
      return
    }
    const r = await importPolicyFile(file)
    if (!r.ok) setImportError(r.reason)
  }

  if (!recipe) return null

  return (
    <section>
      <h2>Train elsewhere</h2>

      <label className="field">
        <span>Task</span>
        <select value={recipe.task} onChange={(e) => setRecipe({ task: e.target.value as Recipe['task'] })}>
          {(tasks as { id: string; label: string }[]).map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Run on</span>
        <select value={recipe.target} onChange={(e) => setRecipe({ target: e.target.value as Recipe['target'] })}>
          <option value="local-gpu">Local CUDA GPU</option>
          <option value="local-cpu">Local CPU (smoke test only)</option>
          <option value="hf-jobs">Hugging Face Jobs</option>
        </select>
      </label>
      <div className="row"><span>Envs × iterations</span><span>{recipe.numEnvs} × {recipe.iterations}</span></div>
      <div className="row"><span>Estimate</span><span>{job?.estimate}</span></div>

      {job && <pre className="cmd">{job.command}</pre>}
      {job?.warnings.map((w) => <p className="inline-err" key={w}>{w}</p>)}

      <div className="controls" style={{ marginTop: 8 }}>
        <button onClick={() => exportTrainingJob()}>Download bundle</button>
      </div>

      <div
        className={`dropzone ${dropping ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDropping(true) }}
        onDragLeave={() => setDropping(false)}
        onDrop={(e) => void onDrop(e)}
      >
        Drop a trained <code>.onnx</code> here to evaluate it
        <em>validated against obs[1,61] → actions[1,14]</em>
      </div>
      {importError && <p className="inline-err">{importError}</p>}
      {imported.length > 0 && (
        <p className="hint">Imported: {imported.join(', ')} — now selectable in the policy list and in the eval suite.</p>
      )}
    </section>
  )
}
