import { useEffect, useMemo, useRef, useState } from 'react'
import { MicroDuckSim } from './sim/MicroDuckSim'
import { mountModelAssets } from './sim/mujocoRuntime'
import { PolicyRunner } from './sim/PolicyRunner'
import { listAllPolicies } from './sim/policyRegistry'
import { DuckRenderer } from './render/DuckRenderer'
import { useStudio } from './core/store'
import {
  attachIntrospector, attachPolicyRunner, attachRenderer, attachSim, clearSelection,
  applyDisturbance, clearHighlight, clearProps, explainObservationSlice, getCommand, loadPolicy,
  bubbleRemaining, dismissBubble, holdBubble, onPush, pinBubble, react, releaseBubble,
  renderReviewFrame, resetSim, runBubbleAction, selectJoint, setAutoWake, setCommand, setPaused,
  spawnProp, tickChatter, unloadPolicy, updateFallState, OBS_SLICES,
} from './core/commands'
import { PROPS } from './sim/props'
import { Introspector } from './sim/introspect'
import { LearnPanel } from './ui/LearnPanel'
import { Timeline } from './ui/Timeline'
import { EvalPanel } from './ui/EvalPanel'
import { EscalatePanel } from './ui/EscalatePanel'
import { LessonsPanel } from './ui/LessonsPanel'
import { probeAgentSurfaces, registerWebMcpTools, tryRegisterWebMcpTools } from './webmcp/registerTools'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [robot, setRobot] = useState<{ nu: number; nq: number } | null>(null)
  const status = useStudio((s) => s.status)
  const error = useStudio((s) => s.error)
  const progress = useStudio((s) => s.loadProgress)
  const webmcp = useStudio((s) => s.webmcp)
  const toolLog = useStudio((s) => s.toolLog)
  const paused = useStudio((s) => s.paused)
  const [simTime, setSimTime] = useState(0)
  const loadedPolicy = useStudio((s) => s.loadedPolicy)
  // Subscribing to importedPolicies is what makes the dropdown reactive: the
  // catalogue itself is a plain function, so without this an import would not
  // re-render the list it is supposed to appear in.
  const importedPolicies = useStudio((s) => s.importedPolicies)
  const allPolicies = useMemo(() => listAllPolicies(), [importedPolicies])
  const selection = useStudio((s) => s.selection)
  const commandVersion = useStudio((s) => s.commandVersion)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [charge, setCharge] = useState(0)
  const [mouth, setMouth] = useState<{ x: number; y: number } | null>(null)
  const bubble = useStudio((s) => s.bubble)
  const autoWake = useStudio((s) => s.autoWake)
  const [copied, setCopied] = useState(false)
  const [lifeLeft, setLifeLeft] = useState<number | null>(null)
  const [obsSlice, setObsSlice] = useState<string | null>(null)
  const [obsInfo, setObsInfo] = useState<{ what: string; liveValues: number[] } | null>(null)

  // Slider values are DERIVED from the command the policy is actually reading,
  // not from local state — so a change made by the agent moves the slider, and
  // the human and the agent are demonstrably looking at one value (D8).
  const cmd = useMemo(() => {
    void commandVersion
    const r = getCommand()
    const twist = r.ok ? (r.command as { twist: [number, number, number] }).twist : [0, 0, 0]
    return { vx: twist[0], vy: twist[1], vyaw: twist[2] }
  }, [commandVersion])

  const applyCommand = (patch: Partial<typeof cmd>) => setCommand({ ...cmd, ...patch })

  const onPickPolicy = async (id: string) => {
    setPolicyError(null)
    if (!id) {
      unloadPolicy()
      return
    }
    const r = await loadPolicy(id)
    if (!r.ok) setPolicyError(r.reason)
  }

  useEffect(() => {
    const store = useStudio.getState()
    let renderer: DuckRenderer | null = null
    let sim: MicroDuckSim | null = null
    let cancelled = false
    let unsubscribePush: (() => void) | null = null

    // StrictMode mounts twice in dev. Every await below is a point where the
    // effect may already have been torn down, so each one re-checks before
    // taking ownership of anything — otherwise the discarded run leaks a
    // second sim and renderer, and the two fight over the display.
    const boot = async () => {
      try {
        store.set({ status: 'loading', error: null })
        await mountModelAssets((done, total) =>
          useStudio.getState().set({ loadProgress: { done, total } }),
        )
        if (cancelled) return

        const created = await MicroDuckSim.create('scene_lab.xml')
        if (cancelled) {
          created.dispose()
          return
        }
        sim = created

        const canvas = canvasRef.current
        if (!canvas) {
          sim.dispose()
          sim = null
          return
        }

        attachSim(sim)
        const runner = PolicyRunner.create(sim)
        runner.holdHomePose()
        attachPolicyRunner(runner)
        setRobot({ nu: sim.model.nu, nq: sim.model.nq })
        store.set({ status: 'ready' })

        if (import.meta.env.DEV) {
          // Dev-only handle: lets Playwright and the terminal assert on real
          // simulation state instead of scraping the DOM.
          ;(globalThis as Record<string, unknown>).__duck = { sim, runner }
        }

        attachIntrospector(new Introspector(sim))

        renderer = new DuckRenderer(canvas, sim)
        attachRenderer(renderer)
        // Clicking the duck goes through the same command the agent calls, so
        // "what the human selected" and "what the agent selected" are one thing.
        renderer.setPickHandler((geomId) => {
          if (geomId < 0) clearSelection()
          else selectJoint({ geomId })
        })
        renderer.setPushHandlers(
          (strength) => setCharge(strength),
          (dir, magnitude) => applyDisturbance({ vector: dir, magnitude, source: 'mouse' }),
        )
        // One cue for every push, whoever caused it — mouse or agent.
        unsubscribePush = onPush(({ x, y, magnitude }) => {
          renderer?.showPushCue([x, y], magnitude)
          react('push')
        })
        renderer.start({
          // tick() is async; its own busy guard drops overlapping ticks rather
          // than queueing them, so the duck never acts on a stale observation.
          beforePhysics: (dt) => {
            // Reviewing a recording and driving the live robot are mutually
            // exclusive: in review the playhead writes qpos directly, so the
            // policy must not also be issuing commands into the same state.
            const st = useStudio.getState()
            // The eval suite drives the sim itself, on the same MjData. Letting
            // the review playhead write qpos underneath it silently corrupts
            // every episode, so an open rollout yields for the duration.
            if (st.evaluating) return
            if (st.review) renderReviewFrame()
            else if (!st.paused) void runner.tick(dt)
          },
          onFrame: () => {
            setSimTime(sim!.data.time)
            // Falling is the measurement during an eval, not a problem to fix:
            // auto-wake would reset the duck mid-episode and inflate survival.
            if (!useStudio.getState().evaluating) updateFallState()
            tickChatter()
            // Only project while a bubble is up: doing it every frame otherwise
            // would be a pointless per-frame React update.
            if (useStudio.getState().bubble) {
              setMouth(renderer?.mouthScreenPosition() ?? null)
              // Quantised so the countdown redraws ~20 times over its life
              // rather than 60 times a second.
              const r = bubbleRemaining()
              setLifeLeft(r === null ? null : Math.round(r * 20) / 20)
            }
          },
        })

        // Land on a standing duck, not a collapsed one. A biped cannot balance
        // passively, so with no policy loaded the robot faceplants within
        // seconds — which is every first visitor's first impression. alpha_walking
        // is a velstand policy, so at zero command it simply stands, and
        // "Walk forward" then works with nothing else to set up.
        await loadPolicy('alpha_walking')
        sim.reset('STAND')

        await registerWebMcpTools()
      } catch (e) {
        if (!cancelled) {
          store.set({
            status: 'error',
            error: e instanceof Error ? (e.stack ?? e.message) : String(e),
          })
        }
      }
    }

    void boot()

    const onResize = () => renderer?.resize()
    addEventListener('resize', onResize)
    return () => {
      cancelled = true
      removeEventListener('resize', onResize)
      unsubscribePush?.()
      renderer?.dispose()
      renderer = null
      attachRenderer(null)
      attachIntrospector(null)
      attachPolicyRunner(null)
      attachSim(null)
      sim?.dispose()
      sim = null
    }
  }, [])

  return (
    <div className="app">
      <div className="stage">
        <canvas ref={canvasRef} />
        <div className="brand">
          <h1>MicroDuck Lab</h1>
          <p>Learn reinforcement learning by teaching robots</p>
        </div>
        {bubble && mouth && (
          <div
            className={`bubble ${bubble.kind}`}
            style={{ left: mouth.x, top: mouth.y }}
            key={bubble.id}
            // Hovering pauses the countdown; clicking pins it outright. A timer
            // you cannot stop while reading is the thing that made the old one
            // feel hostile.
            onMouseEnter={() => holdBubble()}
            onMouseLeave={() => releaseBubble()}
            onClick={() => pinBubble()}
          >
            <button className="bubble-x" onClick={() => dismissBubble()} title="Dismiss">×</button>
            <p>{bubble.text}</p>

            {bubble.ask && (
              <button
                className="bubble-ask"
                title="Copy this and paste it to your agent"
                onClick={() => {
                  void navigator.clipboard?.writeText(bubble.ask!)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1400)
                }}
              >
                {copied ? '✓ copied — paste it to your agent' : `Ask your agent: “${bubble.ask}”`}
              </button>
            )}

            {bubble.action && (
              <button className="bubble-do" onClick={() => void runBubbleAction(bubble.action!.id)}>
                {bubble.action.label}
              </button>
            )}

            {lifeLeft !== null && !bubble.persistent && (
              <div className="bubble-life" aria-hidden>
                <i style={{ width: `${lifeLeft * 100}%` }} />
              </div>
            )}

            {bubble.kind === 'fall' && (
              <label className="auto-wake">
                <input type="checkbox" checked={autoWake} onChange={(e) => setAutoWake(e.target.checked)} />
                auto
              </label>
            )}
          </div>
        )}
        {charge > 0 && (
          <div className="charge">
            <div className="charge-bar"><i style={{ width: `${charge * 100}%` }} /></div>
            <small>hold to charge · release to shove</small>
          </div>
        )}
        {status !== 'ready' && (
          <div className="overlay">
            {status === 'error' ? (
              <>
                <strong>Simulation failed to load</strong>
                <div className="err">{error}</div>
              </>
            ) : (
              <>
                <strong>Loading Microduck</strong>
                <div className="bar">
                  <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                </div>
                <small>
                  {progress.done}/{progress.total} model assets
                </small>
              </>
            )}
          </div>
        )}
        <Timeline />
        <LearnPanel />
      </div>

      <aside className="panel">
        <section>
          <h2>Simulation</h2>
          <div className="row"><span>Status</span><span>{status}</span></div>
          <div className="row"><span>Sim time</span><span>{simTime.toFixed(2)} s</span></div>
          <div className="row"><span>Actuators (action dim)</span><span>{robot?.nu ?? '—'}</span></div>
          <div className="row"><span>qpos</span><span>{robot?.nq ?? '—'}</span></div>
          <div className="controls" style={{ marginTop: 10 }}>
            <button onClick={() => resetSim('STAND')}>Stand</button>
            <button onClick={() => resetSim('INIT')}>Init</button>
            <button onClick={() => resetSim('SIT')}>Sit</button>
            <button onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
          </div>
        </section>

        <section>
          <h2>Policy</h2>
          <select
            value={loadedPolicy ?? ''}
            onChange={(e) => void onPickPolicy(e.target.value)}
            disabled={status !== 'ready'}
          >
            <option value="">— none (hold home pose) —</option>
            {allPolicies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.source === 'imported' ? `${p.label} (yours)` : p.label}
              </option>
            ))}
          </select>
          {policyError && <p className="inline-err">{policyError}</p>}
          <p className="hint">
            Nine Apache-2.0 policies from Pollen Robotics, plus anything you
            import. Every one is <code>obs[1,61] → actions[1,14]</code>, run
            here at 50&nbsp;Hz.
          </p>
        </section>

        <section>
          <h2>Command</h2>
          {/* Ranges match what the policies were trained on — mjlab's
              lin_vel_x (-0.4,0.4), lin_vel_y (-0.3,0.3), ang_vel_z (-1,1).
              Commanding outside these is out of distribution. */}
          {([
            ['vx', 'Forward', -0.4, 0.4],
            ['vy', 'Lateral', -0.3, 0.3],
            ['vyaw', 'Yaw rate', -1.0, 1.0],
          ] as const).map(([key, label, min, max]) => (
            <label className="slider" key={key}>
              <span>{label}</span>
              <input
                type="range" min={min} max={max} step={0.005}
                value={cmd[key]}
                onChange={(e) => applyCommand({ [key]: Number(e.target.value) } as Partial<typeof cmd>)}
              />
              <em>{cmd[key].toFixed(3)}</em>
            </label>
          ))}
          <div className="controls">
            <button onClick={() => applyCommand({ vx: 0.3, vy: 0, vyaw: 0 })}>Walk forward</button>
            <button onClick={() => applyCommand({ vx: 0, vy: 0, vyaw: 0 })}>Zero</button>
          </div>
          <p className="hint">
            alpha_walking is a <em>velstand</em> policy: below roughly 0.15&nbsp;m/s it stands
            in place rather than stepping.
          </p>
        </section>

        <LessonsPanel />

        <section>
          <h2>Obstacles</h2>
          <div className="obs-slices">
            {PROPS.map((p) => (
              <button key={p.id} title={p.about} onClick={() => spawnProp({ id: p.id })}>
                {p.label}
              </button>
            ))}
            <button onClick={() => clearProps()}>Clear</button>
          </div>
          <p className="hint">Dropped 45 cm in front of the duck. Small box and ball are light enough to shove.</p>
        </section>

        <EvalPanel />

        <EscalatePanel />

        <section>
          <h2>Observation · 61 values</h2>
          <div className="obs-slices">
            {Object.entries(OBS_SLICES).map(([key, s]) => (
              <button
                key={key}
                className={obsSlice === key ? 'on' : ''}
                onClick={() => {
                  if (obsSlice === key) { setObsSlice(null); clearHighlight(); return }
                  setObsSlice(key)
                  const r = explainObservationSlice(key)
                  setObsInfo(r.ok ? r : null)
                }}
              >
                {s.label} <em>{s.to - s.from}</em>
              </button>
            ))}
          </div>
          {obsInfo && (
            <>
              <p className="hint">{obsInfo.what}</p>
              <p className="obs-vals">
                [{obsInfo.liveValues.slice(0, 8).map((v) => v.toFixed(2)).join(', ')}
                {obsInfo.liveValues.length > 8 ? ', …' : ''}]
              </p>
            </>
          )}
        </section>

        <section>
          <h2>Selection</h2>
          {selection ? (
            <>
              <div className="row"><span>Joint</span><span>{selection.jointName}</span></div>
              <div className="row"><span>Body</span><span>{selection.bodyName}</span></div>
              <button onClick={() => clearSelection()}>Clear</button>
            </>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              Click a part of the duck. Your selection becomes agent-readable state — ask
              “what am I looking at?” and the agent resolves it without you describing anything.
            </p>
          )}
        </section>

        <section>
          <h2>
            WebMCP{' '}
            <span className={`pill ${webmcp.available ? 'ok' : 'bad'}`}>
              {webmcp.available ? `${webmcp.registered.length} tools` : 'not detected'}
            </span>
          </h2>
          {webmcp.available ? (
            <ul className="tools">
              {webmcp.registered.map((t) => <li key={t}>{t}</li>)}
            </ul>
          ) : (
            <>
              <p style={{ fontSize: 12, color: 'var(--dim)', margin: 0 }}>
                No <code>document.modelContext</code> yet. MicroDuck Lab works fully without an
                agent; site tools appear automatically once the surface exists.
              </p>
              <ul className="tools probe">
                {Object.entries(probeAgentSurfaces()).map(([k, v]) => (
                  <li key={k} className={v ? 'yes' : 'no'}>{v ? '✓' : '✗'} {k}</li>
                ))}
              </ul>
              <button onClick={() => void tryRegisterWebMcpTools()}>Retry detection</button>
            </>
          )}
        </section>

        <div className="log">
          <h2>Tool calls</h2>
          {toolLog.length === 0 ? (
            <p className="empty">No agent calls yet.</p>
          ) : (
            <ol>
              {toolLog.map((e, i) => (
                <li key={i}>
                  <b>{e.tool}</b>
                  {e.ok ? '' : ' ✗'}
                  <br />
                  {new Date(e.at).toLocaleTimeString()}
                </li>
              ))}
            </ol>
          )}
        </div>
      </aside>
    </div>
  )
}
