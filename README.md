# MicroDuck Lab

**Learn reinforcement learning by teaching robots.**

A WebMCP-powered RL studio for [Microduck](https://pollen-robotics.com/microduck/)
— the $399 open-source bipedal robot from Pollen Robotics and Hugging Face.
The real robot model, real MuJoCo physics and the real published policies, in a
browser tab, with an AI agent working the same controls you are.

*by SynthReality Labs*

---

## What it does

Microduck's whole premise is *train in simulation → deploy → refine → retrain*.
That loop has no interactive front door. This is one.

**A human and an agent are good at opposite halves of RL diagnosis.** You look
at a rollout and instantly know *that gait is ugly* — a judgement that is
pre-verbal and nearly impossible to write as a metric. The agent can read thirty
metrics, a reward decomposition and a documented failure catalogue at once, which
is tedious and error-prone for you. Neither does the other's half well.

So the studio is a shared workspace. Both of you act on the same live state.

### The interaction it exists for

Drag a range on the rollout timeline, click the duck, and type five words:

> *"What went wrong here?"*

The agent doesn't ask what "here" means. It reads your selection — which rollout,
which window, which joint — pulls the telemetry for exactly that slice, and
answers:

> Lost upright orientation in this window — the trunk went past horizontal.
> Trunk dropped to 0.049 m, well below the nominal 0.12 m stance.
> Large angular velocity peak (10.01 rad/s) — the trunk is being thrown, not steered.
> Action-rate spike at t=2.38 s — the policy is correcting hard.

No transcription, no screenshots, no "at about two seconds in". **The pointing
gesture is the query.**

### What else it does

- **Runs the nine published policies** on the real `robot_allcollisions.xml`
  model at the trained 50 Hz control rate.
- **Shows what a reward function actually prefers.** Reward is a function of a
  trajectory, so stored rollouts can be re-scored under any objective instantly
  — no retraining, no GPU. Give a penalty a negative weight and watch a
  pathological rollout climb to the top of the ranking, which is Pollen's own
  documented sign-convention bug, reproduced.
- **Audits your reward signs** using Pollen's "infallible check": every penalty
  must contribute ≤ 0.
- **Evaluates robustness** across slopes, friction and pushes, and A/Bs two
  policies over identical seeds.
- **Composes real training commands.** The generated `mjlab` command is verified
  against the real CLI and runs on paste. Train it on your own GPU, drop the
  resulting `.onnx` back in, and compare it against the baseline.
- **Makes any agent a Microduck expert** by serving Pollen's own hard-won RL
  playbook through tools, rather than expecting the model to already know it.

## Why WebMCP

Because without it the agent is guessing at a screenshot and you are
transcribing numbers into a chat box.

Every state change goes through one command layer. The UI calls it; each WebMCP
tool is a thin schema wrapper over the same function. There is deliberately no
second path for the agent — so when the agent sets a velocity command, *the
slider moves*. Human state and agent state cannot drift apart, because they are
the same state.

## Running it

```bash
npm install
npm run dev      # http://localhost:5180
```

`npm run build` produces a static bundle; no backend, no account, no key.

### Enabling the agent

The app is fully usable with no agent at all — WebMCP absence is stated, not
fatal. To enable site tools, either:

**ChatGPT desktop** — open the URL in its built-in browser. Requires a current
build (site-tools support landed 2026-08-26; older builds expose nothing) on a
plan with the built-in browser.

**Google Chrome** — enable `chrome://flags/#enable-webmcp-testing` and relaunch.
Chrome 146+. The
[Model Context Tool Inspector](https://chromewebstore.google.com/detail/webmcp-model-context-tool/gbpdfapgefenggkahomfgkhfehlcenpd)
extension lists and invokes the tools manually, which is a good way to see the
surface without an agent.

The right-hand panel shows how many tools are registered, and logs every call.
If it says *not detected*, it lists each surface it probed.

## Architecture

Client-only. No backend, no telemetry, nothing to authenticate.

| Concern | Choice |
|---|---|
| Physics | [`@mujoco/mujoco`](https://github.com/google-deepmind/mujoco/tree/main/wasm), single-threaded WASM |
| Policies | `onnxruntime-web` |
| Rendering | Three.js, from MuJoCo's compiled mesh arrays |
| Agent surface | `document.modelContext.registerTool` |

Single-threaded MuJoCo is deliberate: the multi-threaded build needs
`SharedArrayBuffer` and therefore cross-origin isolation, which is not
guaranteed inside an embedded browser.

## Honest limits

- **Training a policy in the browser is impossible**, and that is the product's
  architecture rather than a limitation being hidden. A 61→14 locomotion policy
  needs CUDA and hours. The browser is where a hypothesis is formed and cheaply
  falsified; the GPU is where you pay for the ones that survive.
- **Changing a reward weight does not change the robot's behaviour.** That needs
  retraining. Re-scoring shows what the reward function prefers, which is a
  different and sharper lesson.
- **Pollen publish ONNX only** — inference exports with no optimizer state — so
  fine-tuning from the published policies is not possible without training your
  own base checkpoint first.
- **The simulation lacks mjlab's BAM actuator model**, so the duck is somewhat
  weaker here than on the training rig and tracks roughly 43% of commanded
  velocity. The robustness figures are a property of this simulation, not of the
  real robot.

## License

MicroDuck Lab is [Apache-2.0](LICENSE). Redistributed Pollen Robotics assets keep
their own licence with attribution preserved — see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

> **MicroDuck Lab is an independent open-source project and is not affiliated
> with or endorsed by Pollen Robotics.**

© 2026 Gespona Tech, S.L.U.
