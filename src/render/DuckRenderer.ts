import * as THREE from 'three'
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
    this.camera.lookAt(0, 0, 0.1)

    this.scene.background = new THREE.Color(0x0f1418)
    this.scene.fog = new THREE.Fog(0x0f1418, 2, 9)
    this.scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x202428, 2.0))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(1.2, -1.6, 2.4)
    this.scene.add(key)

    const grid = new THREE.GridHelper(4, 40, 0x2a3440, 0x1a2028)
    grid.rotation.x = Math.PI / 2 // GridHelper is XZ by default; MuJoCo's floor is XY
    this.scene.add(grid)

    this.buildDuck()
    this.resize()
  }

  private buildDuck(): void {
    for (const g of this.sim.visualGeoms()) {
      const geom = new THREE.BufferGeometry()
      geom.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
      geom.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3))
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
    }
  }

  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  /**
   * Fixed-step physics driven by the display clock, with transforms synced once
   * per frame. Paused freezes physics but keeps rendering, so the camera stays
   * live while the agent inspects a held state.
   */
  start(onFrame?: () => void): void {
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now
      if (!useStudio.getState().paused) this.sim.advance(dt)
      this.syncTransforms()
      this.render()
      onFrame?.()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  dispose(): void {
    this.stop()
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    this.renderer.dispose()
  }
}
