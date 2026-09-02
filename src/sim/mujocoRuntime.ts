import loadMujoco from '@mujoco/mujoco'
import type { MainModule } from '@mujoco/mujoco'
// Let the bundler own the binary and hand us its hashed URL. Keeping a copy in
// public/ as well shipped the same 9.7 MB twice: once as the file locateFile
// pointed at, and once emitted from mujoco.js's own internal reference.
import mujocoWasmUrl from '@mujoco/mujoco/mujoco.wasm?url'
import { MODEL_XMLS, MODEL_MESHES } from './assetManifest'
import { sceneWithProps } from './props'

/**
 * Single-threaded MuJoCo. Deliberate: the multi-threaded build needs
 * SharedArrayBuffer, hence COOP/COEP, and cross-origin isolation inside
 * ChatGPT's in-app browser — our primary surface — is unverified. See D9.
 */

const ASSET_BASE = `${import.meta.env.BASE_URL}assets/microduck`
export const WORK_DIR = '/work'

let modulePromise: Promise<MainModule> | null = null

/**
 * Loads the WASM module once.
 *
 * `locateFile` points at the bundler's own emitted asset, so there is exactly
 * one copy of the binary and it gets a content hash for caching.
 */
export function getMujoco(): Promise<MainModule> {
  modulePromise ??= loadMujoco({
    locateFile: (path: string) => (path.endsWith('.wasm') ? mujocoWasmUrl : path),
  } as unknown as undefined)
  return modulePromise
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

let mounted = false

/**
 * Mounts the Microduck model into MuJoCo's Emscripten filesystem.
 *
 * We use the real FS rather than MjVFS because the model relies on both
 * `<include>` (scene.xml -> robot_allcollisions.xml) and `meshdir="assets"`.
 * A real directory tree resolves each of those the way the compiler expects,
 * with no path rewriting on our side.
 */
export async function mountModelAssets(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (mounted) return
  const mj = await getMujoco()
  const { FS } = mj

  try {
    FS.mkdirTree(`${WORK_DIR}/assets`, 0o777)
  } catch {
    // already present across a hot reload
  }

  const total = MODEL_XMLS.length + MODEL_MESHES.length
  let done = 0
  const tick = () => onProgress?.(++done, total)

  await Promise.all([
    ...MODEL_XMLS.map(async (name) => {
      const bytes = await fetchBytes(`${ASSET_BASE}/${name}`)
      if (name === 'scene.xml') {
        // Write the upstream file untouched, plus a lab variant carrying our
        // props. Keeping them separate means what we redistribute stays
        // byte-identical to Pollen's.
        FS.writeFile(`${WORK_DIR}/${name}`, bytes)
        const text = new TextDecoder().decode(bytes)
        FS.writeFile(`${WORK_DIR}/scene_lab.xml`, new TextEncoder().encode(sceneWithProps(text)))
      } else {
        FS.writeFile(`${WORK_DIR}/${name}`, bytes)
      }
      tick()
    }),
    ...MODEL_MESHES.map(async (name) => {
      FS.writeFile(`${WORK_DIR}/assets/${name}`, await fetchBytes(`${ASSET_BASE}/assets/${name}`))
      tick()
    }),
  ])

  mounted = true
}
