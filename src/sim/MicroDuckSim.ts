import type { MainModule, MjModel, MjData } from '@mujoco/mujoco'
import { getMujoco, mountModelAssets, WORK_DIR } from './mujocoRuntime'
import { CONTROL_DT, PHYSICS_DT } from './policyContract'

/** Keyframes defined in scene.xml, in declaration order. */
export const KEYFRAME = { INIT: 0, STAND: 1, SIT: 2, FOLD: 3 } as const
export type KeyframeName = keyof typeof KEYFRAME

export interface GeomVisual {
  /** Index into model.geom_* and data.geom_x*. */
  geomId: number
  rgba: [number, number, number, number]
  /** Mesh geoms carry baked triangles; primitives carry their MuJoCo size. */
  kind: 'mesh' | 'box' | 'sphere' | 'capsule' | 'cylinder'
  positions?: Float32Array
  normals?: Float32Array
  size?: [number, number, number]
}

/**
 * Owns the MuJoCo model and data for one Microduck.
 *
 * Array properties on MjModel/MjData are live views into WASM memory, so we
 * hold the handles and re-read rather than copying each frame.
 */
/**
 * The real Microduck's paint, over the CAD model's defaults.
 *
 * The MJCF carries per-material colours, but they are SolidWorks defaults: the
 * beak and feet come through as a flat yellow and the soles as mint green. The
 * shipped robot is cream with an orange beak, orange feet and an amber eye, and
 * the whole point of the viewport is that you recognise the thing on your desk.
 * Keyed on material name so it degrades to the CAD colour if a name changes.
 */
const LIVERY: Record<string, [number, number, number]> = {
  // Beak — the most recognisable part of the robot.
  jaw_material: [0.949, 0.42, 0.122],
  jaw_soft_material: [0.949, 0.42, 0.122],
  soft_mouth_top_material: [0.949, 0.42, 0.122],
  bottom_head_shell_material: [0.949, 0.42, 0.122],
  // Feet and ankles.
  foot_left_material: [0.949, 0.42, 0.122],
  foot_right_material: [0.949, 0.42, 0.122],
  ankle_left_material: [0.949, 0.42, 0.122],
  ankle_right_material: [0.949, 0.42, 0.122],
  sole_left_material: [0.839, 0.353, 0.09],
  sole_right_material: [0.839, 0.353, 0.09],
  // Shells — warm cream, not the CAD's cold greys and pale blue.
  top_head_shell_material: [0.929, 0.91, 0.878],
  left_shell_material: [0.929, 0.91, 0.878],
  right_shell_material: [0.929, 0.91, 0.878],
  leg_material: [0.929, 0.91, 0.878],
  upper_leg_left_material: [0.929, 0.91, 0.878],
  upper_leg_right_material: [0.929, 0.91, 0.878],
  upper_leg_rigidity_plate_material: [0.929, 0.91, 0.878],
  // The eye.
  noenoeil_material: [0.941, 0.706, 0.0],
}

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

  /**
   * Show a recorded configuration without simulating it.
   *
   * mj_forward recomputes every derived quantity — body transforms, contacts,
   * sensors — from qpos alone, so a replayed frame is rendered from the same
   * pipeline as a live one rather than a separate playback path.
   */
  applyQpos(source: Float32Array, offset: number): void {
    const qpos = this.data.qpos
    for (let i = 0; i < this.model.nq; i++) qpos[i] = source[offset + i]
    this.mj.mj_forward(this.model, this.data)
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
    const geom_matid = (model as { geom_matid?: ArrayLike<number> }).geom_matid
    const mat_rgba = (model as { mat_rgba?: ArrayLike<number> }).mat_rgba
    const { mesh_vertadr, mesh_vertnum, mesh_faceadr, mesh_facenum, mesh_vert, mesh_face,
            mesh_normal, mesh_normaladr } = model
    const T = this.mj.mjtGeom
    const MESH = T.mjGEOM_MESH.value
    const PRIMITIVES: Record<number, GeomVisual['kind']> = {
      [T.mjGEOM_BOX.value]: 'box',
      [T.mjGEOM_SPHERE.value]: 'sphere',
      [T.mjGEOM_CAPSULE.value]: 'capsule',
      [T.mjGEOM_CYLINDER.value]: 'cylinder',
    }
    const { geom_size } = model

    const out: GeomVisual[] = []
    for (let g = 0; g < model.ngeom; g++) {
      if (geom_group[g] !== group) continue
      // When a geom carries a material, MuJoCo leaves geom_rgba at the default
      // grey and the real colour lives on the material — which is why the duck
      // rendered uniformly grey while the MJCF has an orange beak and feet.
      const matid = geom_matid ? geom_matid[g] : -1
      const src = matid >= 0 && mat_rgba ? mat_rgba : geom_rgba
      const base = matid >= 0 && mat_rgba ? matid * 4 : g * 4
      const rgba: [number, number, number, number] = [
        src[base], src[base + 1], src[base + 2], src[base + 3],
      ]
      if (matid >= 0) {
        const matName = this.mj.mj_id2name(model, this.mj.mjtObj.mjOBJ_MATERIAL.value, matid)
        const paint = matName ? LIVERY[matName] : undefined
        if (paint) { rgba[0] = paint[0]; rgba[1] = paint[1]; rgba[2] = paint[2] }
      }

      // Primitives (the props we inject) have no mesh to expand — Three.js can
      // build them from MuJoCo's half-extents directly.
      const primitive = PRIMITIVES[geom_type[g]]
      if (primitive) {
        out.push({
          geomId: g, kind: primitive, rgba,
          size: [geom_size[g * 3], geom_size[g * 3 + 1], geom_size[g * 3 + 2]],
        })
        continue
      }

      if (geom_type[g] !== MESH) continue
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
      out.push({ geomId: g, kind: 'mesh', positions, normals, rgba })
    }
    return out
  }

  dispose(): void {
    this.data.delete()
    this.model.delete()
  }
}
