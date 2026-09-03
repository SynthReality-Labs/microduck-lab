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
/** `bare` drops the section chrome — the caller supplies its own fold. */
export function EscalatePanel({ bare = false }: { bare?: boolean } = {}) {
  const recipeVersion = useStudio((s) => s.recipeVersion)
  const imported = useStudio((s) => s.importedPolicies)
  const [importError, setImportError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [copiedPrompt, setCopiedPrompt] = useState(false)

  const { recipe, tasks } = useMemo(() => {
    void recipeVersion
    const r = getRecipe()
    return r.ok ? r : { recipe: null as Recipe | null, tasks: [] as unknown[] }
  }, [recipeVersion])

  const job = useMemo(() => {
    void recipeVersion
    const r = composeTrainingJob()
    return r.ok
      ? (r.job as {
          command: string; estimate: string; warnings: string[]
          agentPrompt: string; notes: string[]; smokeTestFirst: string
        })
      : null
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

  const body = (
    <>
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

      {/* The three targets differ by one token each — a leading
          CUDA_VISIBLE_DEVICES, or a trailing --hf-jobs — which is easy to miss
          in six lines of flags. Say what changed before showing it. */}
      <p className="target-note">{TARGET_NOTE[recipe.target]}</p>

      {job && <pre className="cmd">{job.command}</pre>}
      {job?.notes.map((n) => <p className="hint" key={n}>{n}</p>)}
      {job?.warnings.map((w) => <p className="inline-err" key={w}>{w}</p>)}

      {/* The handoff is agent-to-agent: paste this into the assistant on the
          machine with the GPU and training continues the same conversation. */}
      <button
        className="handoff"
        title={`Copy a prompt for the agent ${HANDOFF_WHERE[recipe.target]}`}
        onClick={() => {
          if (!job) return
          void navigator.clipboard?.writeText(job.agentPrompt)
          setCopiedPrompt(true)
          setTimeout(() => setCopiedPrompt(false), 1800)
        }}
      >
        {copiedPrompt ? `✓ copied — paste it to the agent ${HANDOFF_WHERE[recipe.target]}` : `⇥ Copy prompt to train ${HANDOFF_WHERE[recipe.target]}`}
      </button>

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
    </>
  )

  if (bare) return body
  return (
    <section>
      <h2>Train elsewhere</h2>
      {body}
    </section>
  )
}

/** What each target actually changes about the command above. */
const TARGET_NOTE: Record<Recipe['target'], string> = {
  'local-gpu': 'Runs as-is on a machine with a CUDA GPU. Roughly 1–2 h for a usable gait.',
  'local-cpu': 'Prefixed with CUDA_VISIBLE_DEVICES="" to force mjlab\'s CPU path — works on Apple Silicon, and is how you check the config is sane before paying for GPU time.',
  'hf-jobs': 'Adds --hf-jobs, which submits to Hugging Face GPUs instead of running here. No local CUDA needed; add --dry-run first to inspect the job spec.',
}

/** Where the pasted prompt is meant to be pasted. */
const HANDOFF_WHERE: Record<Recipe['target'], string> = {
  'local-gpu': 'on your GPU machine',
  'local-cpu': 'on this machine',
  'hf-jobs': 'on a machine that can reach Hugging Face',
}
