/**
 * The Microduck policy contract.
 *
 * Ported deliberately literally from `pollen-robotics/microduck`
 * (`duck-control/src/obs.rs` and `model.rs`) rather than inferred. Upstream's
 * own words: "This is the highest-risk code in the crate... A wrong offset does
 * not fail loudly — it produces a plausible-looking robot that falls over, and
 * the symptom looks like a tuning or timing problem rather than an indexing one."
 *
 * Every alpha policy is obs[1,61] -> actions[1,14].
 *
 *   index   width  contents
 *   0..3        3  gyro, trunk frame, rad/s
 *   3..6        3  projected gravity, trunk frame, unit vector
 *   6..20      14  joint position MINUS HOME POSE, mouth excluded
 *   20..34     14  joint velocity, mouth excluded
 *   34..48     14  previous action, mouth excluded
 *   48..61     13  command
 *
 * Command block (the part with no second source of truth):
 *
 *   48..51      3  vx, vy, vyaw
 *   51..55      4  neck_pitch, head_pitch, head_yaw, head_roll
 *   55..57      2  body x, y   — always zero, unbound in training
 *   57          1  body z
 *   58          1  body roll
 *   59          1  body pitch
 *   60          1  body yaw    — always zero, unbound in training
 *
 * Note the body order is z, roll, pitch — not z, pitch, roll.
 */

export const OBS_LEN = 61
export const ACTION_LEN = 14
export const COMMAND_LEN = 13

/** Control runs at 50 Hz: mjlab uses timestep 0.005 with decimation 4. */
export const CONTROL_DT = 0.02
export const PHYSICS_DT = 0.005
export const DECIMATION = 4

/** All 15 robot joints, upstream order. The mouth is index 9. */
export const JOINT_NAMES = [
  'left_hip_yaw', 'left_hip_roll', 'left_hip_pitch', 'left_knee', 'left_ankle',
  'neck_pitch', 'head_pitch', 'head_yaw', 'head_roll',
  'mouth',
  'right_hip_yaw', 'right_hip_roll', 'right_hip_pitch', 'right_knee', 'right_ankle',
] as const

export const MOUTH_INDEX = 9

/**
 * The 14 joints a policy sees, mouth skipped.
 *
 * This is also exactly the actuator order in Pollen's `robot_allcollisions.xml`
 * — the MJCF has no mouth actuator, so the sim's ctrl vector lines up 1:1 with
 * the action vector and needs no remapping. Asserted at load in PolicyRunner.
 */
export const POLICY_JOINT_NAMES = JOINT_NAMES.filter((_, i) => i !== MOUTH_INDEX)

/**
 * Home pose, radians — upstream `DEFAULT_POSITION` with the mouth removed.
 *
 * Policies observe joint positions *relative* to these angles and their actions
 * are offsets from them, so an error here is a constant bias on 28 slots.
 * These are the same numbers as scene.xml's STAND keyframe: home pose is STAND.
 */
export const HOME_POSE: number[] = [
  0.0,      // left_hip_yaw
  -0.0873,  // left_hip_roll
  -0.4579,  // left_hip_pitch
  -0.0049,  // left_knee
  0.4530,   // left_ankle
  0.3491,   // neck_pitch
  0.3491,   // head_pitch
  0.0,      // head_yaw
  0.0,      // head_roll
  0.0,      // right_hip_yaw
  0.0873,   // right_hip_roll
  0.4579,   // right_hip_pitch
  0.0049,   // right_knee
  -0.4530,  // right_ankle
]

/** Block offsets into the observation. */
export const OBS = {
  gyro: 0,
  gravity: 3,
  jointPos: 6,
  jointVel: 20,
  lastAction: 34,
  command: 48,
} as const

/**
 * Action -> joint target.
 *
 * mjlab's JointPositionActionCfg has `use_default_offset = True` and the walking
 * env sets `scale = 1.0`, so the target is the home pose plus the raw action.
 */
export const ACTION_SCALE = 1.0

/** What the robot is being asked to do, in physical units. */
export interface Command {
  /** Forward, left, yaw-rate. */
  twist: [number, number, number]
  /** neck_pitch, head_pitch, head_yaw, head_roll. */
  head: [number, number, number, number]
  /** Standing body pose offsets; zero is the nominal stance. */
  body: { z: number; roll: number; pitch: number }
}

export const NEUTRAL_COMMAND: Command = {
  twist: [0, 0, 0],
  head: [0, 0, 0, 0],
  body: { z: 0, roll: 0, pitch: 0 },
}

/** Flatten a command into its 13 observation slots, in layout order. */
export function encodeCommand(c: Command, out: Float32Array, offset = 0): void {
  out[offset + 0] = c.twist[0]
  out[offset + 1] = c.twist[1]
  out[offset + 2] = c.twist[2]
  out[offset + 3] = c.head[0]
  out[offset + 4] = c.head[1]
  out[offset + 5] = c.head[2]
  out[offset + 6] = c.head[3]
  out[offset + 7] = 0 // body x — unbound in training
  out[offset + 8] = 0 // body y — unbound
  out[offset + 9] = c.body.z
  out[offset + 10] = c.body.roll
  out[offset + 11] = c.body.pitch
  out[offset + 12] = 0 // body yaw — unbound
}

/** The nine policies Pollen publishes, all Apache-2.0, all 61 -> 14. */
export const POLICIES = [
  { id: 'alpha_walking', label: 'Walking', file: 'alpha_walking.onnx', role: 'walking / velstand' },
  { id: 'alpha_stand', label: 'Stand', file: 'alpha_stand.onnx', role: 'standing + body pose' },
  { id: 'alpha_sitstand', label: 'Sit ↔ Stand', file: 'alpha_sitstand.onnx', role: 'posture flag' },
  { id: 'alpha_ground_pick', label: 'Ground pick', file: 'alpha_ground_pick.onnx', role: 'phase command' },
  { id: 'ball_kick_left', label: 'Kick (left)', file: 'ball_kick_left.onnx', role: 'left-leg kick' },
  { id: 'ball_kick_right', label: 'Kick (right)', file: 'ball_kick_right.onnx', role: 'right-leg kick' },
  { id: 'roller', label: 'Roller', file: 'roller.onnx', role: 'roller-mode locomotion' },
  { id: 'roller_crouch', label: 'Roller crouch', file: 'roller_crouch.onnx', role: 'roller crouch' },
  { id: 'roulade', label: 'Roulade', file: 'roulade.onnx', role: 'forward roll' },
] as const

export type PolicyId = (typeof POLICIES)[number]['id']
