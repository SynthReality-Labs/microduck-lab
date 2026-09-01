import './webmcp.d'
import type { WebMcpToolDefinition, ModelContext } from './webmcp.d'
import { useStudio } from '../core/store'
import * as core from '../core/commands'

/**
 * WebMCP adapter.
 *
 * Each entry is a schema + a call into the core command layer. If any real
 * logic appears in this file it belongs in ../core/commands.ts instead.
 */

type Tool = WebMcpToolDefinition<Record<string, never>>

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})
const NO_ARGS = obj()

const tools: Tool[] = [
  // ── Knowledge ──────────────────────────────────────────────────────────────
  {
    name: 'get_microduck_spec',
    title: 'Microduck specification',
    description:
      'Facts about the Microduck robot itself: size, mass, motors, sensors, who made it, and how ' +
      'the simulation model relates to the physical robot. Call this before answering any question ' +
      'about what the robot is or what it can do.',
    inputSchema: NO_ARGS,
    execute: () => core.getMicroduckSpec(),
  },
  {
    name: 'get_policy_contract',
    title: 'Policy input/output contract',
    description:
      'The exact interface every Microduck policy implements: the 61-dimensional observation layout ' +
      'slice by slice, the 13-value command block, the 14 joints in action order, the home pose, how ' +
      'an action becomes a joint target, and the velocity ranges the policies were trained on. ' +
      'Essential before reasoning about observations, actions or commands.',
    inputSchema: NO_ARGS,
    execute: () => core.getPolicyContract(),
  },
  {
    name: 'get_rl_playbook',
    title: 'Microduck RL playbook',
    description:
      "Pollen Robotics' own hard-won reinforcement-learning lessons for this robot — the reward-design " +
      'rules, curriculum pacing, sim2real footguns and training diagnostics they learned by actually ' +
      'training it. Prefer this over generic RL knowledge when advising on this robot.',
    inputSchema: obj(
      {
        topic: {
          type: 'string',
          enum: ['reward-design', 'commands-observations', 'curricula', 'training-ops', 'sim2real', 'invariants', 'building-an-env'],
          description: 'Which section of the playbook to return.',
        },
      },
      ['topic'],
    ),
    execute: (a: { topic: string }) => core.getRlPlaybook(a?.topic),
  },
  {
    name: 'explain_reward_term',
    title: 'Explain a reward term',
    description:
      'What a specific reward term does on this robot and the failure mode it exists to prevent, plus ' +
      "the sign convention whose violation causes butt-hopping and crash-sits. Use when the user asks " +
      'what a reward term means or why a policy is behaving badly.',
    inputSchema: obj({ term: { type: 'string', description: 'Reward term name, e.g. action_rate_l2.' } }, ['term']),
    execute: (a: { term: string }) => core.explainRewardTerm(a?.term),
  },

  // ── State ──────────────────────────────────────────────────────────────────
  {
    name: 'get_studio_state',
    title: 'Studio state',
    description:
      'What MicroDuck Lab is currently doing: load status, whether physics is paused, simulation time, ' +
      'and how many WebMCP tools are registered. Call this first when you need orientation before acting.',
    inputSchema: NO_ARGS,
    execute: () => core.getStudioState(),
  },
  {
    name: 'describe_robot',
    title: 'Describe the robot',
    description:
      'The loaded simulation model: the 14 actuator names in action order, all joint names, state ' +
      'dimensions and the physics timestep.',
    inputSchema: NO_ARGS,
    execute: () => core.describeRobot(),
  },
  {
    name: 'list_joints',
    title: 'List joints with live state',
    description:
      'Every hinge joint with its current angle, velocity, travel limits, axis, owning body, and how far ' +
      'it currently sits from the home pose. Use to find which joint is doing something unusual.',
    inputSchema: NO_ARGS,
    execute: () => core.listJoints(),
  },
  {
    name: 'list_policies',
    title: 'List available policies',
    description:
      'The nine Apache-2.0 policies published by Pollen Robotics, and which one is currently loaded.',
    inputSchema: NO_ARGS,
    execute: () => core.listPolicies(),
  },
  {
    name: 'get_command',
    title: 'Get the current command',
    description: 'The velocity, head and body command currently being fed to the policy.',
    inputSchema: NO_ARGS,
    execute: () => core.getCommand(),
  },

  // ── Selection: the human's pointing gesture, readable ───────────────────────
  {
    name: 'get_selected_joint',
    title: 'What the user has selected',
    description:
      'The joint the user has clicked in the 3D view, with its live angle, velocity, limits and offset ' +
      'from the home pose. Call this whenever the user says "this joint", "here", "that part" or "what ' +
      'am I looking at" — it resolves what they are pointing at without asking them to describe it.',
    inputSchema: NO_ARGS,
    execute: () => core.getSelectedJoint(),
  },
  {
    name: 'get_selected_robot',
    title: 'Which robot is selected',
    description: 'Which robot the user currently has selected. Useful once more than one duck is in the scene.',
    inputSchema: NO_ARGS,
    execute: () => core.getSelectedRobot(),
  },
  {
    name: 'select_joint',
    title: 'Select a joint',
    description:
      'Select a joint by name, which also highlights it. Use to direct the user to the joint you are ' +
      'talking about, so your explanation lands on the robot rather than in the chat.',
    inputSchema: obj({ name: { type: 'string', description: 'Joint name, e.g. left_hip_roll.' } }, ['name']),
    execute: (a: { name: string }) => core.selectJoint({ name: a?.name }),
  },

  // ── Attention: the agent's pointing finger ─────────────────────────────────
  {
    name: 'highlight_joint',
    title: 'Highlight a joint',
    description:
      'Light up a joint and everything below it in the kinematic chain, in the 3D view the user is ' +
      'already looking at. Use when naming a joint in an explanation.',
    inputSchema: obj({ name: { type: 'string', description: 'Joint name to highlight.' } }, ['name']),
    execute: (a: { name: string }) => core.highlightJoint(a?.name),
  },
  {
    name: 'clear_highlight',
    title: 'Clear highlighting',
    description: 'Remove any highlight from the 3D view.',
    inputSchema: NO_ARGS,
    execute: () => core.clearHighlight(),
  },

  // ── Mutation ───────────────────────────────────────────────────────────────
  {
    name: 'load_policy',
    title: 'Load a policy',
    description:
      'Load one of the published policies and start driving the robot with it. alpha_walking is the ' +
      'locomotion policy; below roughly 0.15 m/s of commanded velocity it stands in place by design.',
    inputSchema: obj(
      {
        id: {
          type: 'string',
          enum: ['alpha_walking', 'alpha_stand', 'alpha_sitstand', 'alpha_ground_pick', 'ball_kick_left', 'ball_kick_right', 'roller', 'roller_crouch', 'roulade'],
          description: 'Policy id to load.',
        },
      },
      ['id'],
    ),
    execute: (a: { id: string }) => core.loadPolicy(a?.id),
  },
  {
    name: 'unload_policy',
    title: 'Unload the policy',
    description: 'Stop running any policy and hold the home pose. The robot will fall — it cannot balance passively.',
    inputSchema: NO_ARGS,
    execute: () => core.unloadPolicy(),
  },
  {
    name: 'set_command',
    title: 'Set the velocity command',
    description:
      'Set what the robot is being asked to do. Trained ranges are forward -0.4..0.4 m/s, lateral ' +
      '-0.3..0.3 m/s, yaw -1..1 rad/s; commanding outside those is out of distribution and the policy ' +
      'may behave unpredictably.',
    inputSchema: obj({
      vx: { type: 'number', minimum: -0.4, maximum: 0.4, description: 'Forward velocity, m/s.' },
      vy: { type: 'number', minimum: -0.3, maximum: 0.3, description: 'Lateral velocity, m/s.' },
      vyaw: { type: 'number', minimum: -1, maximum: 1, description: 'Yaw rate, rad/s.' },
    }),
    execute: (a: { vx?: number; vy?: number; vyaw?: number }) => core.setCommand(a ?? {}),
  },
  {
    name: 'reset_sim',
    title: 'Reset the robot pose',
    description:
      'Reset the robot to one of the scene keyframes. STAND is the home pose every policy was trained ' +
      'against; INIT drops it from spawn height.',
    inputSchema: obj({
      pose: { type: 'string', enum: ['INIT', 'STAND', 'SIT', 'FOLD'], description: 'Keyframe to reset to. Defaults to STAND.' },
    }),
    execute: (a: { pose?: 'INIT' | 'STAND' | 'SIT' | 'FOLD' }) => core.resetSim(a?.pose ?? 'STAND'),
  },
  {
    name: 'apply_disturbance',
    title: 'Push the robot',
    description:
      'Shove the robot to test whether the current policy can recover. Applied as an instantaneous ' +
      'velocity change so the same request always means the same push.',
    inputSchema: obj({
      magnitude: { type: 'number', minimum: 0, maximum: 3, description: 'Push strength in m/s of instantaneous velocity. 0.4 is gentle, 1.5 is hard.' },
      direction: { type: 'string', enum: ['front', 'back', 'left', 'right'], description: 'Which way to push. Defaults to front.' },
    }),
    execute: (a: { magnitude?: number; direction?: 'front' | 'back' | 'left' | 'right' }) => core.applyDisturbance(a ?? {}),
  },
  // ── Learn mode: rollouts and reward design ─────────────────────────────────
  {
    name: 'record_rollout_library',
    title: 'Record the rollout library',
    description:
      'Simulate and record the canonical set of rollouts — a clean walk, a slow walk, a forward ' +
      'roll and a stand — using the real published policies. Takes a few seconds. Required before ' +
      'any reward scoring, and worth re-running only if the library was cleared.',
    inputSchema: NO_ARGS,
    execute: () => core.recordLibrary(),
  },
  {
    name: 'list_rollouts',
    title: 'List recorded rollouts',
    description:
      'The recorded rollouts with distance travelled, final trunk height and whether the robot fell. ' +
      'Use to see what is available to score.',
    inputSchema: NO_ARGS,
    execute: () => core.listRollouts(),
  },
  {
    name: 'get_objective',
    title: 'Get the reward function',
    description:
      'The current reward terms and their weights, plus every available term with what it measures. ' +
      'Call before changing weights so you know what you are editing.',
    inputSchema: NO_ARGS,
    execute: () => core.getObjective(),
  },
  {
    name: 'set_reward_weight',
    title: 'Set a reward weight',
    description:
      'Change the weight of one reward term. This does NOT retrain anything — it changes how stored ' +
      'rollouts are scored, which is exactly how you demonstrate what a reward function actually ' +
      'prefers. Follow with score_rollouts to see the effect.',
    inputSchema: obj(
      {
        term: {
          type: 'string',
          enum: ['track_lin_vel', 'forward_progress', 'upright', 'height', 'action_rate_l2', 'energy', 'body_ang_vel'],
          description: 'Which reward term to reweight.',
        },
        weight: { type: 'number', description: 'New weight. Penalty terms are already negative internally, so use positive weights.' },
      },
      ['term', 'weight'],
    ),
    execute: (a: { term: string; weight: number }) => core.setRewardWeight(a?.term, a?.weight),
  },
  {
    name: 'reset_objective',
    title: 'Reset the reward function',
    description: 'Restore the balanced default reward weights.',
    inputSchema: NO_ARGS,
    execute: () => core.resetObjective(),
  },
  {
    name: 'score_rollouts',
    title: 'Score and rank all rollouts',
    description:
      'Score every recorded rollout under the current reward function and rank them best to worst, ' +
      'with a per-term breakdown. This is how you show reward hacking: inflate a poorly specified ' +
      'term and watch a pathological rollout out-rank the clean walk.',
    inputSchema: NO_ARGS,
    execute: () => core.scoreRollouts(),
  },
  {
    name: 'explain_observation_slice',
    title: 'Explain part of the observation',
    description:
      'Explain one block of the 61-dimensional observation vector, return its LIVE values from this ' +
      'frame, and highlight the joints it covers on the robot. Use when the user asks what the ' +
      'policy sees, or what a part of the observation means — it lands the explanation on the robot ' +
      'rather than in the chat.',
    inputSchema: obj(
      {
        slice: {
          type: 'string',
          enum: ['gyro', 'gravity', 'joint_positions', 'joint_velocities', 'last_action', 'command'],
          description: 'Which block of the observation to explain.',
        },
      },
      ['slice'],
    ),
    execute: (a: { slice: string }) => core.explainObservationSlice(a?.slice),
  },

  // ── Rollout review: the timeline the human drags on ────────────────────────
  {
    name: 'open_rollout',
    title: 'Open a rollout for review',
    description:
      'Load a recorded rollout into the viewer and start replaying it. Pauses the live robot — you ' +
      'are inspecting a recording. Do this before seeking, selecting a range, or inspecting a window.',
    inputSchema: obj({ id: { type: 'string', description: 'Rollout id, e.g. clean-walk or roulade.' } }, ['id']),
    execute: (a: { id: string }) => core.openRollout(a?.id),
  },
  {
    name: 'close_rollout',
    title: 'Close rollout review',
    description: 'Leave review and return to the live robot.',
    inputSchema: NO_ARGS,
    execute: () => core.closeRollout(),
  },
  {
    name: 'seek_rollout',
    title: 'Seek the playhead',
    description:
      'Move the replay playhead to a moment in the open rollout, and pause there. Use to put the ' +
      'user on the exact frame you are describing.',
    inputSchema: obj({ seconds: { type: 'number', minimum: 0, description: 'Time within the rollout.' } }, ['seconds']),
    execute: (a: { seconds: number }) => core.seekRollout(a?.seconds),
  },
  {
    name: 'set_timeline_range',
    title: 'Select a time range',
    description:
      'Highlight a window on the timeline, so the user can see which part of the rollout you are ' +
      'talking about.',
    inputSchema: obj(
      { start: { type: 'number', minimum: 0, description: 'Start time, seconds.' },
        end: { type: 'number', minimum: 0, description: 'End time, seconds.' } },
      ['start', 'end'],
    ),
    execute: (a: { start: number; end: number }) => core.setTimelineRange(a?.start, a?.end),
  },
  {
    name: 'get_selected_timeline_range',
    title: 'What time range the user selected',
    description:
      'The window the user dragged on the rollout timeline. Call this whenever they say "here", ' +
      '"this bit", "that fall" or "what went wrong" — it resolves WHEN they mean without asking. ' +
      'Pairs with get_selected_joint, which resolves WHERE.',
    inputSchema: NO_ARGS,
    execute: () => core.getSelectedTimelineRange(),
  },
  {
    name: 'inspect_rollout',
    title: 'Analyse a window of a rollout',
    description:
      'Diagnose a slice of a rollout: uprightness, trunk height, angular-velocity peaks, action-rate ' +
      'spikes and the termination cause, with a plain-language summary. Called with no arguments it ' +
      'analyses whatever the user currently has selected, which is the usual way to answer ' +
      '"what went wrong here?".',
    inputSchema: obj({
      start: { type: 'number', minimum: 0, description: 'Optional start time; defaults to the user selection.' },
      end: { type: 'number', minimum: 0, description: 'Optional end time.' },
      id: { type: 'string', description: 'Optional rollout id; defaults to the open one.' },
    }),
    execute: (a: { start?: number; end?: number; id?: string }) => core.inspectRollout(a ?? {}),
  },
  // ── Escalation: design here, train elsewhere, bring the weights back ───────
  {
    name: 'get_training_recipe',
    title: 'Get the training recipe',
    description:
      'The current training recipe — task, environment count, iterations, seed, reward weight ' +
      'overrides and where it would run — plus every mjlab task available for the Microduck.',
    inputSchema: NO_ARGS,
    execute: () => core.getRecipe(),
  },
  {
    name: 'set_training_recipe',
    title: 'Edit the training recipe',
    description:
      'Change part of the training recipe. Only upright and pose are settable as reward weights — ' +
      'the other Microduck reward terms are added dynamically in the env config and mjlab does not ' +
      'expose them as CLI flags, so emitting them would produce a command that fails on paste.',
    inputSchema: obj({
      behaviour: { type: 'string', description: 'Run name, used for the checkpoint directory.' },
      task: { type: 'string', enum: ['Mjlab-Velocity-Flat-MicroDuck', 'Mjlab-Velocity-Rough-MicroDuck', 'Mjlab-VelStand-Flat-MicroDuck', 'Mjlab-StandUp-Flat-MicroDuck', 'Mjlab-Spin-Flat-MicroDuck', 'Mjlab-Kick-Flat-MicroDuck'], description: 'Which mjlab task to train.' },
      numEnvs: { type: 'number', minimum: 8, maximum: 8192, description: 'Parallel environments. 4096 is the usual full-training value; 64 is the smoke test.' },
      iterations: { type: 'number', minimum: 1, maximum: 20000, description: 'PPO iterations. ~4000 for a usable gait; 5 for a smoke test.' },
      seed: { type: 'number', description: 'Random seed.' },
      rewardWeights: { type: 'object', properties: { upright: { type: 'number' }, pose: { type: 'number' } }, additionalProperties: false, description: 'Reward weight overrides.' },
      resumeFrom: { type: 'string', description: 'A .pt checkpoint to continue PPO from. Note Pollen publish ONNX only, so this needs your own checkpoint.' },
      target: { type: 'string', enum: ['local-gpu', 'local-cpu', 'hf-jobs'], description: 'Where the job would run.' },
    }),
    execute: (a: Record<string, never>) => core.setRecipe(a ?? {}),
  },
  {
    name: 'compose_training_job',
    title: 'Compose the training command',
    description:
      'Turn the recipe into a REAL, runnable mjlab command, with a time estimate, a pre-flight smoke ' +
      'test and any warnings. Every flag emitted has been verified against the real CLI and executed. ' +
      'Use when the user is ready to move from the browser to actual training.',
    inputSchema: NO_ARGS,
    execute: () => core.composeTrainingJob(),
  },
  {
    name: 'export_training_job',
    title: 'Download the training bundle',
    description:
      'Download the job as three files: a runnable train.sh, recipe.json, and a README covering the ' +
      'smoke test and how to bring the resulting weights back. Triggers browser downloads, so ask ' +
      'the user before calling it.',
    inputSchema: NO_ARGS,
    execute: () => core.exportTrainingJob(),
  },
  {
    name: 'import_policy',
    title: 'Import a trained policy',
    description:
      'Load a policy trained elsewhere from a URL and make it immediately evaluable against the same ' +
      'scenarios as the published ones. The 61 -> 14 contract is validated on load, so a wrong-shaped ' +
      'file fails immediately rather than becoming a robot that flails. This is how the loop closes: ' +
      'export a job, train it on your own GPU, bring the .onnx back, A/B it against the baseline.',
    inputSchema: obj(
      {
        url: { type: 'string', description: 'URL of an .onnx policy file.' },
        name: { type: 'string', description: 'Name to give it in the policy list.' },
      },
      ['url'],
    ),
    execute: (a: { url: string; name?: string }) => core.importPolicy(a ?? ({} as never)),
  },

  // ── Props: obstacles in the duck's path ────────────────────────────────────
  {
    name: 'list_props',
    title: 'List obstacles',
    description: 'The obstacles available to put in the robot\'s path, and which are currently placed.',
    inputSchema: NO_ARGS,
    execute: () => core.listProps(),
  },
  {
    name: 'spawn_prop',
    title: 'Put an obstacle in the path',
    description:
      "Place an obstacle in front of the robot. Positioned relative to where the duck currently is, " +
      'so "in its path" needs no coordinates. The small box and ball are light enough to shove; the ' +
      'big box, step and ramp are effectively anchored, so the robot has to climb or go around.',
    inputSchema: obj(
      {
        id: { type: 'string', enum: ['small-box', 'big-box', 'step', 'ramp', 'ball'], description: 'Which obstacle.' },
        ahead: { type: 'number', minimum: 0.1, maximum: 3, description: 'Metres in front of the robot. Defaults to 0.45.' },
        lateral: { type: 'number', minimum: -1, maximum: 1, description: 'Metres to the side. Defaults to 0.' },
        pitchDeg: { type: 'number', minimum: -45, maximum: 45, description: 'Tilt, for making a ramp steeper or shallower.' },
      },
      ['id'],
    ),
    execute: (a: { id: string }) => core.spawnProp(a ?? ({} as never)),
  },
  {
    name: 'clear_props',
    title: 'Remove obstacles',
    description: 'Remove one obstacle, or all of them if no id is given.',
    inputSchema: obj({ id: { type: 'string', enum: ['small-box', 'big-box', 'step', 'ramp', 'ball'], description: 'Optional; omit to clear everything.' } }),
    execute: (a: { id?: string }) => core.clearProps(a?.id),
  },

  // ── The world the robot is standing in ─────────────────────────────────────
  {
    name: 'get_environment',
    title: 'Get the world settings',
    description: 'The live ground conditions — slope and friction — and the presets available.',
    inputSchema: NO_ARGS,
    execute: () => core.getEnvironment(),
  },
  {
    name: 'set_environment',
    title: 'Change the ground',
    description:
      'Change the ground the robot is walking on, live. Use a preset, or set slope and friction ' +
      'directly. Friction above about 0.2 barely affects an 800 g duck: 0.15 measurably slows it and ' +
      '0.05 puts it down, so reach for those rather than 0.5. Presets share their values with the ' +
      'evaluation scenarios, so "make it slippery" and the Ice row of an eval report mean the same thing.',
    inputSchema: obj({
      preset: { type: 'string', enum: ['flat', 'gentle-slope', 'steep-slope', 'slippery', 'ice'], description: 'A named ground condition.' },
      slopeDeg: { type: 'number', minimum: -30, maximum: 30, description: 'Incline in degrees; positive is uphill in +x.' },
      friction: { type: 'number', minimum: 0.01, maximum: 2, description: 'Ground sliding friction; default is 1.0.' },
    }),
    execute: (a: Record<string, never>) => core.setEnvironment(a ?? {}),
  },

  // ── Evaluation ─────────────────────────────────────────────────────────────
  {
    name: 'list_scenarios',
    title: 'List evaluation scenarios',
    description:
      'The conditions a policy can be evaluated against: flat ground, slopes, low friction and ' +
      'pushes, with the exact parameters of each.',
    inputSchema: NO_ARGS,
    execute: () => core.listScenarios(),
  },
  {
    name: 'run_eval_suite',
    title: 'Evaluate a policy',
    description:
      'Run a policy across scenarios and seeds and report where it holds up and where it falls, with ' +
      'success rate, distance, worst uprightness and the seed and time of every failure. Takes ' +
      'roughly a second per episode, so this is EXPENSIVE — confirm with the user before running the ' +
      'full suite. Defaults to all seven scenarios x three seeds.',
    inputSchema: obj({
      policy: { type: 'string', enum: ['alpha_walking', 'alpha_stand', 'alpha_sitstand', 'alpha_ground_pick', 'ball_kick_left', 'ball_kick_right', 'roller', 'roller_crouch', 'roulade'], description: 'Policy to evaluate. Defaults to the loaded one.' },
      scenarios: { type: 'array', items: { type: 'string', enum: ['flat', 'slope-8', 'slope-15', 'low-friction', 'ice', 'push-light', 'push-hard'] }, description: 'Subset of scenarios. Defaults to all.' },
      seeds: { type: 'array', items: { type: 'number' }, description: 'Seeds. Defaults to [1,2,3].' },
      seconds: { type: 'number', minimum: 1, maximum: 15, description: 'Episode length. Defaults to 5.' },
      vx: { type: 'number', minimum: -0.4, maximum: 0.4, description: 'Forward command during evaluation. Defaults to 0.3.' },
    }),
    execute: (a: Record<string, never>) => core.runEvalSuite(a ?? {}),
  },
  {
    name: 'get_eval_report',
    title: 'Get a stored evaluation',
    description: 'Retrieve a previously computed evaluation without re-running it.',
    inputSchema: obj({ policy: { type: 'string', description: 'Policy id.' } }, ['policy']),
    execute: (a: { policy: string }) => core.getEvalReport(a?.policy),
  },
  {
    name: 'compare_policies',
    title: 'A/B two policies',
    description:
      'Evaluate two policies over the SAME scenarios, seeds and command, and report per-scenario ' +
      'deltas in success rate and distance. Identical seeds mean the starting jitter matches, so a ' +
      'difference in outcome is a difference in policy rather than luck. EXPENSIVE — it runs two ' +
      'full suites, so confirm with the user first.',
    inputSchema: obj(
      {
        a: { type: 'string', description: 'Baseline policy id.' },
        b: { type: 'string', description: 'Policy to compare against the baseline.' },
        seeds: { type: 'array', items: { type: 'number' }, description: 'Seeds. Defaults to [1,2,3].' },
        seconds: { type: 'number', minimum: 1, maximum: 15, description: 'Episode length. Defaults to 5.' },
        vx: { type: 'number', minimum: -0.4, maximum: 0.4, description: 'Forward command. Defaults to 0.3.' },
      },
      ['a', 'b'],
    ),
    execute: (a: { a: string; b: string }) => core.comparePolicies(a ?? ({} as never)),
  },
  {
    name: 'check_reward_signs',
    title: 'Audit reward signs',
    description:
      "Run Pollen's own sign-convention check over the current reward function: every penalty term " +
      'must contribute <= 0. A penalty that pays out has been double-negated into a reward for the ' +
      'violation, which is where butt-hopping and crash-sits come from. Run this before spending any ' +
      'GPU time, and whenever a rollout scores surprisingly well.',
    inputSchema: NO_ARGS,
    execute: () => core.checkRewardSigns(),
  },
  {
    name: 'get_reward_breakdown',
    title: 'Reward breakdown for one rollout',
    description:
      'Per-term reward contributions for a single rollout, sorted by how much each term moved the ' +
      'total. Use to answer "why did this score so well?".',
    inputSchema: obj({ id: { type: 'string', description: 'Rollout id, e.g. clean-walk or roulade.' } }, ['id']),
    execute: (a: { id: string }) => core.getRewardBreakdown(a?.id),
  },
  {
    name: 'set_paused',
    title: 'Pause or resume physics',
    description:
      'Pause or resume the simulation. Pause before inspecting a specific moment so the state stops ' +
      'changing underneath you.',
    inputSchema: obj({ paused: { type: 'boolean', description: 'true to pause, false to resume.' } }, ['paused']),
    execute: (a: { paused: boolean }) => core.setPaused(Boolean(a?.paused)),
  },
] as unknown as Tool[]

/**
 * Wrap the callback so every agent call lands in the dev panel's log.
 *
 * The field name is not settled across sources: the challenge rules document
 * `execute`, while Chrome's own examples use `handler`. They cost one property
 * each, so we supply both rather than bet the gate on which one this build
 * reads.
 */
function instrument(tool: Tool): Tool {
  const inner = tool.execute
  const wrapped = async (args: Record<string, never>) => {
    let result: unknown
    let ok = true
    try {
      result = await inner(args)
      ok = (result as { ok?: boolean })?.ok !== false
    } catch (e) {
      ok = false
      result = { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
      useStudio.getState().logToolCall({ at: Date.now(), tool: tool.name, args, result, ok })
      return result
  }
  return { ...tool, execute: wrapped, handler: wrapped } as Tool
}

function findModelContext(): { ctx: ModelContext | null; surface: 'document' | 'navigator' | 'none' } {
  if (typeof document !== 'undefined' && document.modelContext) {
    return { ctx: document.modelContext, surface: 'document' }
  }
  // Legacy location; deprecated in Chromium 150. Probed so the dev panel can say
  // "old surface detected" rather than the unhelpful "unavailable".
  if (typeof navigator !== 'undefined' && navigator.modelContext) {
    return { ctx: navigator.modelContext, surface: 'navigator' }
  }
  return { ctx: null, surface: 'none' }
}

async function registerInto(ctx: ModelContext, surface: 'document' | 'navigator'): Promise<void> {
  const registered: string[] = []
  for (const tool of tools) {
    try {
      await ctx.registerTool(instrument(tool) as never)
      registered.push(tool.name)
    } catch (e) {
      console.error(`[webmcp] failed to register ${tool.name}`, e)
    }
  }
  useStudio.getState().set({
    webmcp: { available: registered.length > 0, surface, registered },
  })
  console.info(`[webmcp] registered ${registered.length} tools on ${surface}.modelContext`)
}

/** Try once, right now. Returns true if tools got registered. */
export async function tryRegisterWebMcpTools(): Promise<boolean> {
  const { ctx, surface } = findModelContext()
  if (!ctx || surface === 'none') return false
  await registerInto(ctx, surface)
  return true
}

let watching = false

/**
 * Register site tools, and keep looking if the surface is not there yet.
 *
 * `document.modelContext` is not guaranteed to exist at page-load time — an
 * agent-capable browser may inject it late, or only once an agent attaches to
 * the tab. A one-shot probe at boot would then report "not detected" forever on
 * a browser that does in fact support WebMCP, which is exactly the failure that
 * is indistinguishable from the feature being absent.
 *
 * So: probe immediately, then poll, then keep a slow heartbeat going. Cheap
 * (a property read), and it means the badge becomes correct on its own.
 */
export async function registerWebMcpTools(): Promise<void> {
  useStudio.getState().set({ webmcp: { available: false, surface: 'none', registered: [] } })

  if (await tryRegisterWebMcpTools()) return
  if (watching) return
  watching = true

  let delay = 250
  const attempt = async () => {
    if (await tryRegisterWebMcpTools()) {
      watching = false
      return
    }
    delay = Math.min(delay * 1.6, 5000)
    setTimeout(() => void attempt(), delay)
  }
  setTimeout(() => void attempt(), delay)

  // Attaching an agent often coincides with the tab being focused.
  addEventListener('focus', () => void tryRegisterWebMcpTools())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void tryRegisterWebMcpTools()
  })
}

export const TOOL_NAMES = tools.map((t) => t.name)

/**
 * What agent-related surfaces this browser actually exposes.
 *
 * Reported in the dev panel so "not detected" can be distinguished from "not
 * injected yet" — and so a failing gate produces evidence rather than a shrug.
 */
export function probeAgentSurfaces(): Record<string, boolean> {
  const d = document as unknown as Record<string, unknown>
  const n = navigator as unknown as Record<string, unknown>
  const w = globalThis as unknown as Record<string, unknown>
  return {
    'document.modelContext': typeof d.modelContext === 'object' && d.modelContext !== null,
    'navigator.modelContext': typeof n.modelContext === 'object' && n.modelContext !== null,
    'navigator.agent': typeof n.agent === 'object' && n.agent !== null,
    'window.agent': typeof w.agent === 'object' && w.agent !== null,
    'window.ai': typeof w.ai === 'object' && w.ai !== null,
    isSecureContext: Boolean(w.isSecureContext),
  }
}
