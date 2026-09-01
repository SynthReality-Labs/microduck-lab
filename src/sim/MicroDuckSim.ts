import type { MainModule, MjModel, MjData } from '@mujoco/mujoco'
import { getMujoco, mountModelAssets, WORK_DIR } from './mujocoRuntime'
import { CONTROL_DT, PHYSICS_DT } from './policyContract'

/** Keyframes defined in scene.xml, in declaration order. */
export const KEYFRAME = { INIT: 0, STAND: 1, SIT: 2, FOLD: 3 } as const
export type KeyframeName = keyof typeof KEYFRAME

export interface GeomVisual {
  /** Index into model.geom_* and data.geom_x*. */
  geomId: number
  positions: Float32Array
  normals: Float32Array
  rgba: [number, number, number, number]
}

/**
 * Owns the MuJoCo model and data for one Microduck.
 *
 * Array properties on MjModel/MjData are live views into WASM memory, so we
 * hold the handles and re-read rather than copying each frame.
 */
export class MicroDuckSim {
  readonly mj: MainModule
  readonly model: MjModel
  readonly data: MjData

  private constructor(mj: MainModule, model: MjModel, data: MjData) {
    this.mj = mj
    this.model = model
    this.data = data
  }

  static async create(scene = 'scene.xml'): Promise<MicroDuckSim> {
    await mountModelAssets()
    const mj = await getMujoco()
    const model = mj.MjModel.from_xml_path(`${WORK_DIR}/${scene}`)

    // The MJCF sets no timestep, so MuJoCo defaults to 0.002 — but these
    // policies were trained by mjlab at 0.005 with decimation 4, i.e. 50 Hz
    // control. Matching the training timestep matters twice over: the learned
    // dynamics assume it, and a mismatched timestep silently changes the
    // control rate, which looks like a badly tracking policy rather than a
    // configuration error.
    model.opt.timestep = PHYSICS_DT

    const data = new mj.MjData(model)
    const sim = new MicroDuckSim(mj, model, data)
    sim.reset('STAND')
    return sim
  }

  get timestep(): number {
    return this.model.opt.timestep
  }

  /**
   * Physics steps per control step, derived rather than hardcoded, so the 50 Hz
   * contract survives any future change to the model timestep.
   */
  get controlDecimation(): number {
    return Math.max(1, Math.round(CONTROL_DT / this.timestep))
  }

  /** Actuator names, in ctrl order — this is the 14-D action space. */
  actuatorNames(): string[] {
    const { mj, model } = this
    return Array.from({ length: model.nu }, (_, i) =>
      mj.mj_id2name(model, mj.mjtObj.mjOBJ_ACTUATOR.value, i),
    )
  }

  jointNames(): string[] {
    const { mj, model } = this
    return Array.from({ length: model.njnt }, (_, i) =>
      mj.mj_id2name(model, mj.mjtObj.mjOBJ_JOINT.value, i),
    )
  }

  reset(key: KeyframeName = 'STAND'): void {
    this.mj.mj_resetDataKeyframe(this.model, this.data, KEYFRAME[key])
    this.mj.mj_forward(this.model, this.data)
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) this.mj.mj_step(this.model, this.data)
  }

  private carry = 0

  /**
   * Advance by wall-clock seconds, capped so a stalled tab cannot spiral.
   *
   * Keeps the sub-step remainder so simulated time tracks real time instead of
   * losing a slice every frame — at 60 fps and a 5 ms timestep, truncating
   * would run the clock ~10% slow and quietly bias every velocity we report.
   */
  advance(seconds: number, maxSteps = 40): number {
    this.carry += seconds
    const steps = Math.min(Math.floor(this.carry / this.timestep), maxSteps)
    this.carry -= steps * this.timestep
    this.step(steps)
    return steps
  }

  setCtrl(values: ArrayLike<number>): void {
    const ctrl = this.data.ctrl
    const n = Math.min(ctrl.length, values.length)
    for (let i = 0; i < n; i++) ctrl[i] = values[i]
  }

  /**
   * Visual geometry, built from MuJoCo's *compiled* mesh arrays rather than by
   * re-parsing the STLs. Guarantees what we draw is exactly what we simulate,
   * and means the renderer needs no mesh loader at all.
   *
   * Group 2 is the `visual` default class in robot_allcollisions.xml;
   * group 3 is `collision` and is never drawn.
   */
  visualGeoms(group = 2): GeomVisual[] {
    const { model } = this
    const { geom_type, geom_group, geom_dataid, geom_rgba } = model
    const { mesh_vertadr, mesh_vertnum, mesh_faceadr, mesh_facenum, mesh_vert, mesh_face,
            mesh_normal, mesh_normaladr } = model
    const MESH = this.mj.mjtGeom.mjGEOM_MESH.value

    const out: GeomVisual[] = []
    for (let g = 0; g < model.ngeom; g++) {
      if (geom_group[g] !== group || geom_type[g] !== MESH) continue
      const meshId = geom_dataid[g]
      if (meshId < 0) continue

      const vAdr = mesh_vertadr[meshId]
      const fAdr = mesh_faceadr[meshId]
      const nFace = mesh_facenum[meshId]
      const nAdr = mesh_normaladr[meshId]

      // Expand indexed faces to flat triangles: simpler, and lets each face
      // keep MuJoCo's own normal instead of us re-deriving them.
      const positions = new Float32Array(nFace * 9)
      const normals = new Float32Array(nFace * 9)
      for (let f = 0; f < nFace; f++) {
        for (let k = 0; k < 3; k++) {
          const vi = mesh_face[(fAdr + f) * 3 + k]
          const ni = model.mesh_facenormal[(fAdr + f) * 3 + k]
          const o = f * 9 + k * 3
          positions[o] = mesh_vert[(vAdr + vi) * 3]
          positions[o + 1] = mesh_vert[(vAdr + vi) * 3 + 1]
          positions[o + 2] = mesh_vert[(vAdr + vi) * 3 + 2]
          normals[o] = mesh_normal[(nAdr + ni) * 3]
          normals[o + 1] = mesh_normal[(nAdr + ni) * 3 + 1]
          normals[o + 2] = mesh_normal[(nAdr + ni) * 3 + 2]
        }
      }
      void mesh_vertnum
      out.push({
        geomId: g,
        positions,
        normals,
        rgba: [geom_rgba[g * 4], geom_rgba[g * 4 + 1], geom_rgba[g * 4 + 2], geom_rgba[g * 4 + 3]],
      })
    }
    return out
  }

  dispose(): void {
    this.data.delete()
    this.model.delete()
  }
}
