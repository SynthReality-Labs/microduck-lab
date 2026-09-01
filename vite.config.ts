import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // @mujoco/mujoco ships prebuilt wasm + glue; keep it out of dep optimisation
  // so the .wasm resolves against the real module URL.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022' },
  server: { port: 5180, strictPort: true, host: true },
})
