/**
 * A recorded rollout, stored column-wise.
 *
 * Struct-of-arrays rather than an array of frame objects: scoring walks every
 * step of every episode on each objective edit, and typed arrays keep that
 * under a frame even with the whole library loaded.
 */
export interface Episode {
  id: string
  label: string
  policy: string
  note: string
  length: number
  dt: number

  /** Trunk position and orientation. */
  posX: Float32Array
  posY: Float32Array
  posZ: Float32Array
  /** Projected gravity z: -1 upright, +1 inverted. */
  gravZ: Float32Array
  /** World-frame trunk velocity. */
  velX: Float32Array
  velY: Float32Array
  angVelMag: Float32Array

  /** What was being asked for at each step. */
  cmdVx: Float32Array
  cmdVy: Float32Array

  /** Action statistics, precomputed so scoring stays a cheap fold. */
  actionDelta: Float32Array
  actionEnergy: Float32Array

  terminated: boolean
  terminationReason: string | null
}

export function makeEpisode(id: string, label: string, policy: string, note: string, capacity: number, dt: number): Episode & { push: (f: Frame) => void; finish: (t: string | null) => Episode } {
  const f32 = () => new Float32Array(capacity)
  const ep = {
    id, label, policy, note, length: 0, dt,
    posX: f32(), posY: f32(), posZ: f32(), gravZ: f32(),
    velX: f32(), velY: f32(), angVelMag: f32(),
    cmdVx: f32(), cmdVy: f32(),
    actionDelta: f32(), actionEnergy: f32(),
    terminated: false, terminationReason: null as string | null,
  }
  return {
    ...ep,
    push(fr: Frame) {
      const i = this.length
      if (i >= capacity) return
      this.posX[i] = fr.posX; this.posY[i] = fr.posY; this.posZ[i] = fr.posZ
      this.gravZ[i] = fr.gravZ
      this.velX[i] = fr.velX; this.velY[i] = fr.velY; this.angVelMag[i] = fr.angVelMag
      this.cmdVx[i] = fr.cmdVx; this.cmdVy[i] = fr.cmdVy
      this.actionDelta[i] = fr.actionDelta; this.actionEnergy[i] = fr.actionEnergy
      this.length = i + 1
    },
    finish(reason: string | null) {
      this.terminated = reason !== null
      this.terminationReason = reason
      return this as unknown as Episode
    },
  }
}

export interface Frame {
  posX: number; posY: number; posZ: number
  gravZ: number
  velX: number; velY: number; angVelMag: number
  cmdVx: number; cmdVy: number
  actionDelta: number; actionEnergy: number
}
