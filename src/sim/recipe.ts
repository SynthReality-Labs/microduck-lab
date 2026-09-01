/**
 * A training recipe, and the real mjlab command it compiles to.
 *
 * Every flag emitted here was verified against `train --help` in the real
 * repository and then executed. Flags that exist in the docs but that tyro does
 * not actually expose are deliberately absent — an "illustrative" command that
 * fails on paste is worse than a shorter one that runs.
 *
 * Notably: only `upright` and `pose` are reachable as `--env.rewards.*.weight`.
 * The other microduck reward terms are added dynamically in the env config's
 * post-init, so tyro never surfaces them, and emitting them would produce
 * "Unrecognized options".
 */

/** mjlab tasks registered by microduck_rl that are worth offering. */
export const TASKS = [
  { id: 'Mjlab-Velocity-Flat-MicroDuck', label: 'Walk — flat', about: 'Velocity tracking on flat ground. The default locomotion task.' },
  { id: 'Mjlab-Velocity-Rough-MicroDuck', label: 'Walk — rough', about: 'Velocity tracking over rough terrain. Harder; needs more iterations.' },
  { id: 'Mjlab-VelStand-Flat-MicroDuck', label: 'Walk + stand — flat', about: 'Adds explicit zero-command standing, which is the deployment idle state.' },
  { id: 'Mjlab-StandUp-Flat-MicroDuck', label: 'Stand up', about: 'Getting up from the ground.' },
  { id: 'Mjlab-Spin-Flat-MicroDuck', label: 'Spin', about: 'Turn in place — a command region that needs its own bucket to train at all.' },
  { id: 'Mjlab-Kick-Flat-MicroDuck', label: 'Ball kick', about: 'Kicking a 70 mm ball.' },
] as const

export type TaskId = (typeof TASKS)[number]['id']
export type Target = 'local-gpu' | 'local-cpu' | 'hf-jobs'

export interface Recipe {
  behaviour: string
  task: TaskId
  numEnvs: number
  iterations: number
  seed: number
  /** Only the two terms mjlab actually exposes as CLI flags. */
  rewardWeights: { upright?: number; pose?: number }
  /** A .pt checkpoint to continue PPO from. */
  resumeFrom?: string
  target: Target
}

export const DEFAULT_RECIPE: Recipe = {
  behaviour: 'my-walk',
  task: 'Mjlab-Velocity-Flat-MicroDuck',
  numEnvs: 4096,
  iterations: 4000,
  seed: 1,
  rewardWeights: {},
  target: 'local-gpu',
}

/** Pollen's own pre-flight: 64 envs x 5 iterations catches ~95% of config errors. */
export const SMOKE_TEST: Pick<Recipe, 'numEnvs' | 'iterations'> = { numEnvs: 64, iterations: 5 }

export interface ComposedJob {
  command: string
  target: Target
  estimate: string
  notes: string[]
  warnings: string[]
  smokeTestFirst: string
}

function flags(r: Recipe): string[] {
  const out = [
    `--env.scene.num-envs ${r.numEnvs}`,
    `--agent.max-iterations ${r.iterations}`,
    `--agent.seed ${r.seed}`,
    `--agent.run-name ${r.behaviour}`,
  ]
  if (r.rewardWeights.upright !== undefined) out.push(`--env.rewards.upright.weight ${r.rewardWeights.upright}`)
  if (r.rewardWeights.pose !== undefined) out.push(`--env.rewards.pose.weight ${r.rewardWeights.pose}`)
  if (r.resumeFrom) out.push(`--agent.load-checkpoint ${r.resumeFrom}`, '--agent.resume True')
  if (r.target === 'hf-jobs') out.push('--hf-jobs')
  return out
}

export function composeJob(r: Recipe): ComposedJob {
  const body = [`uv run train ${r.task}`, ...flags(r)].join(' \\\n    ')
  const prefix = r.target === 'local-cpu' ? 'CUDA_VISIBLE_DEVICES="" ' : ''
  const command = prefix + body

  const smoke = [
    (r.target === 'local-cpu' ? 'CUDA_VISIBLE_DEVICES="" ' : '') + `uv run train ${r.task}`,
    `--env.scene.num-envs ${SMOKE_TEST.numEnvs}`,
    `--agent.max-iterations ${SMOKE_TEST.iterations}`,
    `--agent.run-name ${r.behaviour}-smoke`,
  ].join(' \\\n    ')

  const notes = [
    'Run from a clone of pollen-robotics/microduck_rl.',
    `Pollen recommend a ${SMOKE_TEST.numEnvs} env x ${SMOKE_TEST.iterations} iteration smoke test first — it catches roughly 95% of config errors before you spend GPU hours.`,
  ]
  const warnings: string[] = []

  if (r.target === 'local-cpu') {
    notes.push('CUDA_VISIBLE_DEVICES="" selects mjlab\'s CPU mode, which works on Apple Silicon.')
    warnings.push('CPU training is viable for a smoke test only. A full gait extrapolates to roughly 142 hours on an M4 Pro.')
  }
  if (r.target === 'hf-jobs') {
    notes.push('--hf-jobs submits to Hugging Face GPUs. Flavors: l4x1 (default), a10g-large, a100-large. Add --dry-run to inspect the job spec without submitting.')
  }
  if (r.resumeFrom) {
    warnings.push('Fine-tuning needs a .pt checkpoint. Pollen publish ONNX only — inference exports with no optimizer state — so you must train your own base checkpoint first.')
  }
  if (r.numEnvs >= 2048 && r.iterations >= 1000 && r.target !== 'hf-jobs') {
    notes.push('A usable gait is roughly 1-2 hours at 4096 envs on a modern CUDA GPU.')
  }

  const estimate =
    r.target === 'local-cpu'
      ? r.numEnvs <= 64 && r.iterations <= 10 ? '~20 seconds' : 'hours to days — CPU is smoke-test only'
      : r.numEnvs >= 2048 && r.iterations >= 1000 ? '~1-2 hours on a modern GPU' : 'minutes'

  return { command, target: r.target, estimate, notes, warnings, smokeTestFirst: smoke }
}

/** The files an export bundle contains. */
export function bundleFiles(r: Recipe, job: ComposedJob): { name: string; content: string }[] {
  return [
    { name: 'recipe.json', content: JSON.stringify(r, null, 2) },
    {
      name: 'train.sh',
      content: `#!/usr/bin/env bash\n# Generated by MicroDuck Lab.\n# Run from a clone of https://github.com/pollen-robotics/microduck_rl\nset -euo pipefail\n\n# Pre-flight (Pollen recommend this first — catches ~95% of config errors):\n# ${job.smokeTestFirst.replace(/\n/g, '\n# ')}\n\n${job.command}\n`,
    },
    {
      name: 'README.md',
      content: [
        `# ${r.behaviour}`,
        '',
        'Training job composed by MicroDuck Lab.',
        '',
        '## Run it',
        '',
        '```bash',
        'git clone https://github.com/pollen-robotics/microduck_rl',
        'cd microduck_rl',
        'uv sync',
        'bash train.sh',
        '```',
        '',
        `**Estimate:** ${job.estimate}`,
        '',
        '## Smoke test first',
        '',
        '```bash',
        job.smokeTestFirst,
        '```',
        '',
        ...(job.notes.length ? ['## Notes', '', ...job.notes.map((n) => `- ${n}`), ''] : []),
        ...(job.warnings.length ? ['## Warnings', '', ...job.warnings.map((w) => `- ${w}`), ''] : []),
        '## Bringing the result back',
        '',
        'Export the trained policy to ONNX, then drop the `.onnx` file into',
        'MicroDuck Lab to evaluate it against the same scenarios as the baseline:',
        '',
        '```bash',
        `uv run scripts/export.py ${r.task} --wandb-run-path <entity/project/run_id>`,
        '```',
        '',
        'The studio validates the 61 -> 14 contract on import and rejects anything else.',
      ].join('\n'),
    },
  ]
}
