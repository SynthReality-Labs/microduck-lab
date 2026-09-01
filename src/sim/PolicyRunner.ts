// The wasm-only entry: the default bundle also probes the jsep/WebGPU build,
// which we neither ship nor want (D9 keeps us off SharedArrayBuffer).
import * as ort from 'onnxruntime-web/wasm'
import type { MicroDuckSim } from './MicroDuckSim'
import {
  ACTION_LEN, ACTION_SCALE, CONTROL_DT, HOME_POSE, NEUTRAL_COMMAND,
  OBS, OBS_LEN, POLICY_JOINT_NAMES, encodeCommand,
  type Command, type PolicyId,
} from './policyContract'

const POLICY_BASE = `${import.meta.env.BASE_URL}assets/policies`

// `onnxruntime-web/wasm` resolves to the bundle build, which embeds its own
// runtime — so we must NOT set wasmPaths. Doing so forces an external fetch of
// the Emscripten glue, which Vite then tries to transform and returns 500 for.
// Threads stay at 1: SharedArrayBuffer needs cross-origin isolation, which we
// cannot rely on inside ChatGPT's in-app browser (D9).
ort.env.wasm.numThreads = 1

/** Where each policy joint lives in MuJoCo's qpos / qvel / ctrl vectors. */
interface JointIndex {
  qpos: number[]
  qvel: number[]
  ctrl: number[]
}

/**
 * Runs a Pollen ONNX policy against the MuJoCo sim at 50 Hz.
 *
 * Owns the one piece of state the policy depends on but MuJoCo does not hold:
 * the previous action, which occupies obs[34..48].
 */
export class PolicyRunner {
  readonly obs = new Float32Array(OBS_LEN)
  private lastAction = new Float32Array(ACTION_LEN)
  private session: ort.InferenceSession | null = null
  private policyId: PolicyId | null = null
  private accumulator = 0
  private inputName = 'obs'
  private busy = false

  command: Command = structuredClone(NEUTRAL_COMMAND)

  private constructor(
    private readonly sim: MicroDuckSim,
    private readonly idx: JointIndex,
    private readonly trunkBodyId: number,
  ) {}

  static create(sim: MicroDuckSim): PolicyRunner {
    const { mj, model } = sim
    const JOINT = mj.mjtObj.mjOBJ_JOINT.value
    const ACT = mj.mjtObj.mjOBJ_ACTUATOR.value

    const actuatorNames = sim.actuatorNames()
    const idx: JointIndex = { qpos: [], qvel: [], ctrl: [] }

    for (const name of POLICY_JOINT_NAMES) {
      const jid = mj.mj_name2id(model, JOINT, name)
      if (jid < 0) throw new Error(`Model is missing policy joint "${name}"`)
      idx.qpos.push(model.jnt_qposadr[jid])
      idx.qvel.push(model.jnt_dofadr[jid])

      const aid = actuatorNames.indexOf(name)
      if (aid < 0) throw new Error(`Model is missing actuator "${name}"`)
      idx.ctrl.push(aid)
    }

    // Upstream warns a shifted joint mapping is "catastrophic and completely
    // silent", so state the expectation loudly instead of trusting declaration order.
    if (model.nu !== ACTION_LEN) {
      throw new Error(`Expected ${ACTION_LEN} actuators, model has ${model.nu}`)
    }

    const trunk = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'trunk_base')
    if (trunk < 0) throw new Error('Model is missing body "trunk_base"')
    void ACT
    return new PolicyRunner(sim, idx, trunk)
  }

  /** The previous action — obs[34..48], and what action-rate is measured against. */
  get previousAction(): Float32Array {
    return this.lastAction
  }

  get currentPolicy(): PolicyId | null {
    return this.policyId
  }

  async load(id: PolicyId, file: string): Promise<void> {
    return this.loadFrom(id, `${POLICY_BASE}/${file}`)
  }

  /**
   * Load a policy from any URL or object URL.
   *
   * The contract check is the same one upstream's robotd performs at load
   * rather than "mid-stride" — an imported file with the wrong observation
   * width must fail here, naming both widths, not produce a flailing duck.
   */
  async loadFrom(id: string, url: string): Promise<void> {
    const session = await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
    })

    // Upstream's robotd checks this at load rather than "discovering it
    // mid-stride"; a 51-D legacy policy must fail here, naming both widths.
    const meta = session.inputMetadata[0] as { name: string; shape?: readonly (number | string)[] }
    const width = Number(meta?.shape?.[meta.shape.length - 1])
    if (Number.isFinite(width) && width !== OBS_LEN) {
      throw new Error(`policy unavailable: observation width is ${width}, expected ${OBS_LEN}`)
    }
    const outMeta = session.outputMetadata[0] as { shape?: readonly (number | string)[] }
    const outWidth = Number(outMeta?.shape?.[outMeta.shape.length - 1])
    if (Number.isFinite(outWidth) && outWidth !== ACTION_LEN) {
      throw new Error(`policy unavailable: action width is ${outWidth}, expected ${ACTION_LEN}`)
    }

    this.session?.release?.()
    this.session = session
    this.inputName = meta?.name ?? 'obs'
    this.policyId = id as PolicyId
    this.lastAction.fill(0)
  }

  unload(): void {
    this.session?.release?.()
    this.session = null
    this.policyId = null
    this.lastAction.fill(0)
  }

  /** Assemble obs[61] from live simulation state. See policyContract.ts for the layout. */
  buildObservation(): Float32Array {
    const { data } = this.sim
    const { obs, idx } = this
    const qpos = data.qpos
    const qvel = data.qvel
    const xmat = data.xmat

    // Free joint: qvel[3..6] is angular velocity already in the body frame.
    obs[OBS.gyro] = qvel[3]
    obs[OBS.gyro + 1] = qvel[4]
    obs[OBS.gyro + 2] = qvel[5]

    // Projected gravity = R^T * (0,0,-1), which is the negated third row of the
    // trunk's row-major body->world rotation.
    const m = this.trunkBodyId * 9
    obs[OBS.gravity] = -xmat[m + 6]
    obs[OBS.gravity + 1] = -xmat[m + 7]
    obs[OBS.gravity + 2] = -xmat[m + 8]

    for (let i = 0; i < ACTION_LEN; i++) {
      obs[OBS.jointPos + i] = qpos[idx.qpos[i]] - HOME_POSE[i]
      obs[OBS.jointVel + i] = qvel[idx.qvel[i]]
      obs[OBS.lastAction + i] = this.lastAction[i]
    }

    encodeCommand(this.command, obs, OBS.command)
    return obs
  }

  /** target = home + scale * action, matching mjlab's use_default_offset. */
  applyAction(action: Float32Array): void {
    const ctrl = this.sim.data.ctrl
    for (let i = 0; i < ACTION_LEN; i++) {
      ctrl[this.idx.ctrl[i]] = HOME_POSE[i] + ACTION_SCALE * action[i]
    }
    this.lastAction.set(action)
  }

  /** One inference. Returns the raw 14-D action. */
  async infer(): Promise<Float32Array | null> {
    if (!this.session) return null
    const input = new ort.Tensor('float32', this.buildObservation(), [1, OBS_LEN])
    const out = await this.session.run({ [this.inputName]: input })
    const first = out[Object.keys(out)[0]]
    return first.data as Float32Array
  }

  /**
   * Advance the control clock by `dt` and run the policy if a 50 Hz tick is due.
   *
   * Inference is async while physics is not, so a tick that is still in flight
   * is skipped rather than queued — the alternative is an unbounded backlog on a
   * slow frame, which would make the duck act on stale observations.
   */
  async tick(dt: number): Promise<boolean> {
    if (!this.session) return false
    this.accumulator += dt
    if (this.accumulator < CONTROL_DT) return false
    this.accumulator %= CONTROL_DT
    if (this.busy) return false

    this.busy = true
    try {
      const action = await this.infer()
      if (action) this.applyAction(action)
      return true
    } finally {
      this.busy = false
    }
  }

  /** Hold the home pose — what the sim should do with no policy loaded. */
  holdHomePose(): void {
    const ctrl = this.sim.data.ctrl
    for (let i = 0; i < ACTION_LEN; i++) ctrl[this.idx.ctrl[i]] = HOME_POSE[i]
  }
}
