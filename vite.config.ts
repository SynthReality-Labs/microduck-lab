import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Both packages ship prebuilt wasm next to their JS glue and locate it
  // relative to the module URL. Vite's dep optimiser rewrites them into
  // .vite/deps/ without copying the .wasm, so the glue fetches a path that the
  // SPA fallback answers with index.html — surfacing as a WebAssembly
  // "expected magic word ... found 3c 21 64 6f" (that is `<!do`). Excluding
  // them keeps the real module URLs, and the sibling .wasm resolves.
  optimizeDeps: { exclude: ['@mujoco/mujoco', 'onnxruntime-web'] },
  build: { target: 'es2022' },
  server: { port: 5180, strictPort: true, host: true },
})
