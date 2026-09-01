import type { MicroDuckSim } from './MicroDuckSim'
import { HOME_POSE, POLICY_JOINT_NAMES } from './policyContract'

export interface JointInfo {
  id: number
  name: string
  bodyId: number
  bodyName: string
  /** Index into the 14-D policy action vector, or -1 if not policy-controlled. */
  policySlot: number
  axis: [number, number, number]
  range: [number, number] | null
  position: number
  velocity: number
  /** Position relative to the home pose — what the policy actually observes. */
  fromHome: number | null
}

/**
 * Read-only introspection over the compiled MuJoCo model.
 *
 * Kept separate from MicroDuckSim so the "what is this thing" queries the agent
 * asks stay isolated from the "make it move" surface.
 */
export class Introspector {
  constructor(private readonly sim: MicroDuckSim) {}

  bodyName(bodyId: number): string {
    const { mj, model } = this.sim
    return mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, bodyId) ?? `body_${bodyId}`
  }

  jointName(jointId: number): string {
    const { mj, model } = this.sim
    return mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, jointId) ?? `joint_${jointId}`
  }

  /**
   * The joint that moves a given geom.
   *
   * Walks up the kinematic tree from the geom's body until it finds a body that
   * owns a hinge joint. Clicking a shell panel should select the joint that
   * actually articulates it, not report "no joint here".
   */
  jointForGeom(geomId: number): number {
    const { model } = this.sim
    let bodyId: number = model.geom_bodyid[geomId]
    for (let hops = 0; hops < 12 && bodyId > 0; hops++) {
      const n = model.body_jntnum[bodyId]
      const adr = model.body_jntadr[bodyId]
      for (let j = 0; j < n; j++) {
        const jid = adr + j
        // Skip the free joint: selecting it means "the whole robot", not a joint.
        if (model.jnt_type[jid] !== this.sim.mj.mjtJoint.mjJNT_FREE.value) return jid
      }
      bodyId = model.body_parentid[bodyId]
    }
    return -1
  }

  jointInfo(jointId: number): JointInfo | null {
    const { model, data } = this.sim
    if (jointId < 0 || jointId >= model.njnt) return null
    const name = this.jointName(jointId)
    const bodyId: number = model.jnt_bodyid[jointId]
    const qadr: number = model.jnt_qposadr[jointId]
    const vadr: number = model.jnt_dofadr[jointId]
    const slot = POLICY_JOINT_NAMES.indexOf(name as (typeof POLICY_JOINT_NAMES)[number])
    const limited = model.jnt_range[jointId * 2] !== 0 || model.jnt_range[jointId * 2 + 1] !== 0

    return {
      id: jointId,
      name,
      bodyId,
      bodyName: this.bodyName(bodyId),
      policySlot: slot,
      axis: [model.jnt_axis[jointId * 3], model.jnt_axis[jointId * 3 + 1], model.jnt_axis[jointId * 3 + 2]],
      range: limited ? [model.jnt_range[jointId * 2], model.jnt_range[jointId * 2 + 1]] : null,
      position: data.qpos[qadr],
      velocity: data.qvel[vadr],
      fromHome: slot >= 0 ? data.qpos[qadr] - HOME_POSE[slot] : null,
    }
  }

  /** Every geom belonging to a body — used to highlight a whole limb segment. */
  geomsOfBody(bodyId: number): number[] {
    const { model } = this.sim
    const out: number[] = []
    for (let g = 0; g < model.ngeom; g++) if (model.geom_bodyid[g] === bodyId) out.push(g)
    return out
  }

  /**
   * Bodies moved by a joint: the joint's own body plus everything below it.
   * Highlighting a knee should light the shin and foot, not just one shell.
   */
  subtreeBodies(bodyId: number): number[] {
    const { model } = this.sim
    const out = [bodyId]
    for (let b = bodyId + 1; b < model.nbody; b++) {
      if (out.includes(model.body_parentid[b])) out.push(b)
    }
    return out
  }

  jointByName(name: string): number {
    const { mj, model } = this.sim
    return mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name)
  }

  /** Every hinge joint, in model order. */
  allJoints(): JointInfo[] {
    const out: JointInfo[] = []
    for (let j = 0; j < this.sim.model.njnt; j++) {
      if (this.sim.model.jnt_type[j] === this.sim.mj.mjtJoint.mjJNT_FREE.value) continue
      const info = this.jointInfo(j)
      if (info) out.push(info)
    }
    return out
  }
}
