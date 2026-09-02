import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { MicroDuckSim } from '../sim/MicroDuckSim'
import { useStudio } from '../core/store'

/**
 * Renders the duck from MuJoCo's compiled geometry.
 *
 * MuJoCo is Z-up; rather than rotating the world we tell Three.js that Z is up,
 * so every coordinate we handle stays in MuJoCo's frame. That keeps the numbers
 * the agent reports and the numbers we draw identical.
 */
export class DuckRenderer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly meshes: { geomId: number; mesh: THREE.Mesh }[] = []
  private readonly mat = new THREE.Matrix4()
  private raf = 0

  readonly controls: OrbitControls
  /** When true the orbit target tracks the duck; the user's angle and zoom are kept. */
  follow = true
  /**
   * Manual camera moves suspend following, then it resumes on its own.
   *
   * Snapping straight back would fight the user mid-gesture; never resuming
   * means one nudge and the duck walks out of frame forever. Resuming after a
   * few idle seconds — keeping the angle and zoom they chose — does what people
   * actually expect.
   */
  private followResumeAt = 0
  private static readonly FOLLOW_RESUME_MS = 2500
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private downAt: { x: number; y: number } | null = null

  /** Hold-to-charge push state. */
  private charge: { since: number; dir: THREE.Vector3 } | null = null
  private onCharge: ((strength: number) => void) | null = null
  private onShove: ((dir: [number, number], magnitude: number) => void) | null = null
  private readonly cue = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.12, 0xffcc4d, 0.035, 0.022,
  )
  private cueUntil = 0
  private highlighted = new Set<number>()
  private onPick: ((geomId: number) => void) | null = null

  /** Smoothed point the camera orbits, so a walking duck stays in frame. */
  private readonly focus = new THREE.Vector3(0, 0, 0.1)
  private trunkGeomId = -1

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sim: MicroDuckSim,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 50)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(0.55, -0.55, 0.32)

    // Orbit/pan/zoom. The controls own the camera's position; "follow" moves
    // their TARGET, so tracking the duck and the user's chosen angle compose
    // instead of fighting.
    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.12
    this.controls.minDistance = 0.15
    this.controls.maxDistance = 6
    this.controls.maxPolarAngle = Math.PI * 0.495 // stop just above the floor
    this.controls.target.set(0, 0, 0.1)
    this.controls.addEventListener('start', () => {
      this.followResumeAt = Infinity // held while the gesture is in progress
    })
    this.controls.addEventListener('end', () => {
      this.followResumeAt = performance.now() + DuckRenderer.FOLLOW_RESUME_MS
    })

    this.scene.background = new THREE.Color(0x0f1418)
    this.scene.fog = new THREE.Fog(0x0f1418, 1.5, 6)
    this.scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x202428, 2.0))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(1.2, -1.6, 2.4)
    this.scene.add(key)

    const grid = new THREE.GridHelper(20, 200, 0x2a3440, 0x1a2028)
    grid.rotation.x = Math.PI / 2 // GridHelper is XZ by default; MuJoCo's floor is XY
    this.scene.add(grid)
    this.cue.visible = false
    this.scene.add(this.cue)

    this.buildDuck()
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointerup', this.handlePointerUp)
    // Follow the trunk rather than the world origin. Uses a geom on the trunk
    // body so we can read the position straight out of the same live view the
    // meshes already use.
    const first = this.meshes[0]
    this.trunkGeomId = first ? first.geomId : -1
    this.resize()
  }

  private buildDuck(): void {
    for (const g of this.sim.visualGeoms()) {
      // MuJoCo sizes are half-extents; Three.js primitives take full extents.
      const [sx, sy, sz] = g.size ?? [0, 0, 0]
      let geom: THREE.BufferGeometry
      if (g.kind === 'box') {
        geom = new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2)
      } else if (g.kind === 'sphere') {
        geom = new THREE.SphereGeometry(sx, 24, 16)
      } else if (g.kind === 'capsule') {
        geom = new THREE.CapsuleGeometry(sx, sy * 2, 6, 16)
      } else if (g.kind === 'cylinder') {
        geom = new THREE.CylinderGeometry(sx, sx, sy * 2, 20)
      } else {
        geom = new THREE.BufferGeometry()
        geom.setAttribute('position', new THREE.BufferAttribute(g.positions!, 3))
        geom.setAttribute('normal', new THREE.BufferAttribute(g.normals!, 3))
      }
      const mesh = new THREE.Mesh(
        geom,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]),
          transparent: g.rgba[3] < 1,
          opacity: g.rgba[3],
          roughness: 0.65,
          metalness: 0.05,
        }),
      )
      mesh.matrixAutoUpdate = false
      this.scene.add(mesh)
      this.meshes.push({ geomId: g.geomId, mesh })
    }
  }

  /** Register a callback for clicks on the duck. */
  setPickHandler(fn: ((geomId: number) => void) | null): void {
    this.onPick = fn
  }

  /** Charge grows with hold time and saturates, so a long press is a hard shove
   *  but never an absurd one. 1.2 s reaches full strength. */
  private static chargeOf(heldMs: number): number {
    return Math.min(heldMs / 1200, 1) * 2.2
  }

  setPushHandlers(
    onCharge: ((strength: number) => void) | null,
    onShove: ((dir: [number, number], magnitude: number) => void) | null,
  ): void {
    this.onCharge = onCharge
    this.onShove = onShove
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.downAt = { x: e.clientX, y: e.clientY }

    // Pressing ON the duck charges a push; pressing anywhere else orbits. That
    // keeps one pointer doing both without a mode switch to explain.
    if (!this.onShove || !this.hitsDuck(e)) return
    const away = new THREE.Vector3()
      .subVectors(this.controls.target, this.camera.position)
      .setZ(0)
      .normalize()
    this.charge = { since: performance.now(), dir: away }
    this.controls.enabled = false
  }

  /**
   * Picking happens on pointer UP, and only if the pointer barely moved.
   * OrbitControls owns drags, so a click must be distinguished from an orbit —
   * otherwise every camera nudge would also reselect a joint.
   */
  private hitsDuck(e: PointerEvent): boolean {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    return this.raycaster.intersectObjects(this.meshes.map((m) => m.mesh), false).length > 0
  }

  private handlePointerUp = (e: PointerEvent): void => {
    const down = this.downAt
    this.downAt = null

    if (this.charge) {
      const held = performance.now() - this.charge.since
      const magnitude = DuckRenderer.chargeOf(held)
      const dir = this.charge.dir
      this.charge = null
      this.controls.enabled = true
      this.onCharge?.(0)
      // A tap is a selection, not a shove.
      if (held > 120) {
        this.onShove?.([dir.x, dir.y], magnitude)
        return
      }
    }

    if (!this.onPick || !down) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return

    const rect = this.canvas.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)

    // Meshes carry a static identity matrix and are positioned via .matrix, so
    // Three.js needs their world matrices refreshed before intersection.
    const hits = this.raycaster.intersectObjects(this.meshes.map((m) => m.mesh), false)
    if (!hits.length) {
      this.onPick(-1)
      return
    }
    const hit = this.meshes.find((m) => m.mesh === hits[0].object)
    this.onPick(hit ? hit.geomId : -1)
  }

  /** Emissive-highlight a set of geoms; pass an empty set to clear. */
  setHighlight(geomIds: Iterable<number>): void {
    const next = new Set(geomIds)
    for (const { geomId, mesh } of this.meshes) {
      const on = next.has(geomId)
      if (on === this.highlighted.has(geomId)) continue
      const mat = mesh.material as THREE.MeshStandardMaterial
      mat.emissive.setHex(on ? 0xffcc4d : 0x000000)
      mat.emissiveIntensity = on ? 0.55 : 0
    }
    this.highlighted = next
  }

  /** Pull the live geom transforms out of MjData and push them onto the meshes. */
  syncTransforms(): void {
    const xpos = this.sim.data.geom_xpos
    const xmat = this.sim.data.geom_xmat // row-major 3x3
    for (const { geomId, mesh } of this.meshes) {
      const p = geomId * 3
      const m = geomId * 9
      this.mat.set(
        xmat[m], xmat[m + 1], xmat[m + 2], xpos[p],
        xmat[m + 3], xmat[m + 4], xmat[m + 5], xpos[p + 1],
        xmat[m + 6], xmat[m + 7], xmat[m + 8], xpos[p + 2],
        0, 0, 0, 1,
      )
      mesh.matrix.copy(this.mat)
      mesh.matrixWorld.copy(this.mat)
    }
  }

  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /** Ease the camera toward the duck. Critically damped enough to look calm
   *  while never losing a duck walking at the top of its command range. */
  private followDuck(): void {
    if (this.trunkGeomId < 0 || !this.follow) return
    if (performance.now() < this.followResumeAt) return

    const xpos = this.sim.data.geom_xpos
    const p = this.trunkGeomId * 3
    this.focus.set(xpos[p], xpos[p + 1], Math.max(xpos[p + 2], 0.05))
    // Move the orbit target, not the camera: the user's angle and zoom survive.
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target)
    this.controls.target.lerp(this.focus, 0.08)
    this.camera.position.copy(this.controls.target).add(offset)
  }

  /** Put the camera back where it started and resume following immediately. */
  resetCamera(): void {
    const xpos = this.sim.data.geom_xpos
    const p = Math.max(this.trunkGeomId, 0) * 3
    const at = new THREE.Vector3(xpos[p] || 0, xpos[p + 1] || 0, Math.max(xpos[p + 2] || 0.1, 0.05))
    this.controls.target.copy(at)
    this.camera.position.copy(at).add(new THREE.Vector3(0.55, -0.55, 0.22))
    this.focus.copy(at)
    this.followResumeAt = 0
    this.follow = true
    this.controls.update()
  }

  /** Show an impulse arrow at the duck, whoever caused it. */
  showPushCue(dir: [number, number], magnitude: number): void {
    if (this.trunkGeomId < 0) return
    const xpos = this.sim.data.geom_xpos
    const p = this.trunkGeomId * 3
    const from = new THREE.Vector3(dir[0], dir[1], 0).normalize()
    // Sized against the duck (0.25 m tall): long enough to read as an impulse,
    // small enough not to hide the robot it is describing.
    const len = 0.08 + Math.min(magnitude, 3) * 0.04
    this.cue.position.set(
      xpos[p] - from.x * (len + 0.04),
      xpos[p + 1] - from.y * (len + 0.04),
      xpos[p + 2],
    )
    this.cue.setDirection(from)
    this.cue.setLength(len, len * 0.32, len * 0.2)
    this.cue.visible = true
    this.cueUntil = performance.now() + 700
  }

  render(): void {
    this.followDuck()
    if (this.charge) {
      this.onCharge?.(DuckRenderer.chargeOf(performance.now() - this.charge.since) / 2.2)
    }
    if (this.cue.visible) {
      const left = this.cueUntil - performance.now()
      if (left <= 0) this.cue.visible = false
      else {
        // Fade out so the cue reads as an impulse rather than a fixture.
        const a = Math.min(left / 400, 1)
        for (const child of this.cue.children) {
          const m = (child as THREE.Mesh).material as THREE.Material
          m.transparent = true
          m.opacity = a
        }
      }
    }
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Fixed-step physics driven by the display clock, with transforms synced once
   * per frame. Paused freezes physics but keeps rendering, so the camera stays
   * live while the agent inspects a held state.
   */
  start(opts: { beforePhysics?: (dt: number) => void; onFrame?: () => void } = {}): void {
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      // beforePhysics runs even when paused: replaying a recorded rollout writes
      // qpos every frame while physics is deliberately stopped, so gating it on
      // !paused would freeze the replay instead of the simulation.
      opts.beforePhysics?.(dt)
      if (!useStudio.getState().paused) this.sim.advance(dt)
      this.syncTransforms()
      this.render()
      opts.onFrame?.()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  dispose(): void {
    this.stop()
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.controls.dispose()
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.renderer.dispose()
  }
}
