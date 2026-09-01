/**
 * Obstacles the duck can be made to deal with.
 *
 * MuJoCo compiles the model at load, so bodies cannot be added at runtime
 * without recompiling — which would invalidate every live view into MjModel and
 * MjData that the renderer, policy runner and introspector hold. Instead the
 * full prop set is baked into the scene XML when we mount it, each prop on a
 * freejoint and parked well below the floor. "Spawning" writes its qpos;
 * "clearing" parks it again. No recompilation, no dangling references.
 */

export interface PropSpec {
  id: string
  label: string
  /** MJCF geom body, minus the freejoint and position, which are added below. */
  geom: string
  /** Mass in kg. The duck is 0.8 kg, so anything above ~0.4 is immovable to it. */
  mass: number
  /** Default drop height when spawned. */
  z: number
  about: string
}

export const PROPS: PropSpec[] = [
  {
    id: 'small-box', label: 'Small box', mass: 0.05, z: 0.02,
    geom: '<geom type="box" size="0.02 0.02 0.02" rgba="0.85 0.62 0.30 1" group="2"/>',
    about: 'A 4 cm cube, light enough to shove aside.',
  },
  {
    id: 'big-box', label: 'Big box', mass: 0.6, z: 0.045,
    geom: '<geom type="box" size="0.045 0.06 0.045" rgba="0.72 0.45 0.25 1" group="2"/>',
    about: '9 cm and heavy — a wall, not an obstacle to push.',
  },
  {
    id: 'step', label: 'Step', mass: 5.0, z: 0.015,
    geom: '<geom type="box" size="0.06 0.16 0.015" rgba="0.45 0.5 0.56 1" group="2"/>',
    about: 'A 3 cm kerb spanning the path. Anchored — the duck must climb it.',
  },
  {
    id: 'ramp', label: 'Ramp', mass: 5.0, z: 0.03,
    geom: '<geom type="box" size="0.12 0.16 0.008" rgba="0.42 0.55 0.48 1" group="2"/>',
    about: 'A shallow incline to walk up. Anchored.',
  },
  {
    id: 'ball', label: 'Ball', mass: 0.02, z: 0.035,
    geom: '<geom type="sphere" size="0.035" rgba="0.9 0.85 0.35 1" group="2"/>',
    about: 'The 70 mm ball the kick policies were trained against.',
  },
]

/**
 * Where an unused prop lives.
 *
 * NOT below the floor. A MuJoCo plane is a half-space, so a prop parked at
 * z = -5 sits five metres INSIDE the ground, and the solver resolves that
 * penetration by ejecting it at enormous speed — through the robot. The duck
 * was being launched 16 m from a standing start by obstacles meant to be inert.
 *
 * Props are always collidable; parking is purely positional. Toggling
 * contype/conaffinity at runtime was tried and did not restore collision — the
 * props fell straight through the floor to z = -4877 — so the simple thing wins:
 * park them a kilometre away, where they rest on the floor and touch nothing.
 */
export const PARK_X = 1000
export const PARK_Z = 0.5

/**
 * Build the scene MJCF with the prop set appended.
 *
 * Takes the vendored scene as text so the upstream file stays untouched — we
 * redistribute it unmodified, and the props are ours.
 */
export function sceneWithProps(sceneXml: string): string {
  const bodies = PROPS.map(
    (p) => `
    <body name="prop_${p.id}" pos="${PARK_X} 0 ${PARK_Z}">
      <freejoint name="prop_${p.id}_free"/>
      <inertial pos="0 0 0" mass="${p.mass}" diaginertia="1e-4 1e-4 1e-4"/>
      ${p.geom}
    </body>`,
  ).join('')

  const marker = '</worldbody>'
  const at = sceneXml.lastIndexOf(marker)
  if (at < 0) throw new Error('scene.xml has no </worldbody> to extend')
  const withBodies = sceneXml.slice(0, at) + bodies + '\n  ' + sceneXml.slice(at)

  return extendKeyframes(withBodies)
}

/**
 * Extend every keyframe's qpos to cover the props.
 *
 * A keyframe must describe the WHOLE model. Adding five freejoints took nq from
 * 21 to 56, and MuJoCo zero-pads a short keyframe — which gives each prop the
 * quaternion (0,0,0,0). That is not a rotation, so the props materialised at
 * the origin on every reset and shoved the robot around: the duck was drifting
 * a metre sideways from a standing start, pushed by obstacles nobody could see.
 *
 * Appending an explicit parked pose per prop fixes it at the source.
 */
function extendKeyframes(xml: string): string {
  const parked = PROPS.map(() => `${PARK_X} 0 ${PARK_Z} 1 0 0 0`).join('  ')
  return xml.replace(/qpos="([^"]*)"/g, (_match, value: string) => {
    const trimmed = String(value).trim().replace(/\s+/g, ' ')
    return `qpos="${trimmed} ${parked}"`
  })
}
