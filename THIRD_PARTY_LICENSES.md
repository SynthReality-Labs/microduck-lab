# Third-party licenses

MicroDuck Lab's own source is Apache-2.0 (see [`LICENSE`](LICENSE)). This file
records everything else it redistributes or depends on, as Apache-2.0 §4(b)
requires for redistributed work.

---

## Redistributed assets

### Pollen Robotics — `microduck`

- **Source:** https://github.com/pollen-robotics/microduck
- **License:** Apache-2.0
- **Redistributed here:** the nine trained ONNX policies, unmodified, in
  `public/assets/policies/` — `alpha_walking`, `alpha_stand`, `alpha_sitstand`,
  `alpha_ground_pick`, `ball_kick_left`, `ball_kick_right`, `roller`,
  `roller_crouch`, `roulade`.
- **Also derived from:** the observation layout in `duck-control/src/obs.rs` and
  the joint model and home pose in `duck-control/src/model.rs`, ported to
  TypeScript in `src/sim/policyContract.ts`. That file cites its source.

### Pollen Robotics — `microduck_rl`

- **Source:** https://github.com/pollen-robotics/microduck_rl
- **License:** Apache-2.0
- **Redistributed here:**
  - 16 MJCF model files in `public/assets/microduck/`, unmodified
  - 47 STL meshes in `public/assets/microduck/assets/`, unmodified
  - `AGENTS.md`, unmodified, as `public/assets/knowledge/microduck-rl-playbook.md`,
    served to agents through the `get_rl_playbook` tool

**On the hardware licence.** Press coverage of Microduck notes that its
*hardware design files* are licensed non-commercially. Those files are not used
here. `microduck_rl` carries a single `LICENSE` — Apache-2.0 — with no `NOTICE`
and no per-asset licence, and the simulation assets above are covered by it.

---

## Runtime dependencies

| Package | License | Author |
|---|---|---|
| `@mujoco/mujoco` | Apache-2.0 | Google DeepMind |
| `onnxruntime-web` | MIT | Microsoft |
| `three` | MIT | three.js authors |
| `react`, `react-dom` | MIT | Meta |
| `zustand` | MIT | Poimandres |
| `vite` | MIT | Evan You and contributors |

---

## Trademarks and affiliation

"Microduck" is a product name of Pollen Robotics. MicroDuck Lab is an
independent open-source project and is **not affiliated with, sponsored by, or
endorsed by Pollen Robotics or Hugging Face**. No Pollen Robotics branding,
logos or trade dress are used.
