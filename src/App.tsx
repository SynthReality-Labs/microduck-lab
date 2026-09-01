import { useEffect, useRef, useState } from 'react'
import { MicroDuckSim } from './sim/MicroDuckSim'
import { mountModelAssets } from './sim/mujocoRuntime'
import { PolicyRunner } from './sim/PolicyRunner'
import { POLICIES } from './sim/policyContract'
import { DuckRenderer } from './render/DuckRenderer'
import { useStudio } from './core/store'
import {
  attachIntrospector, attachPolicyRunner, attachRenderer, attachSim, clearSelection,
  loadPolicy, resetSim, selectJoint, setCommand, setPaused, unloadPolicy,
} from './core/commands'
import { Introspector } from './sim/introspect'
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
  const selection = useStudio((s) => s.selection)
  const [cmd, setCmd] = useState({ vx: 0, vy: 0, vyaw: 0 })
  const [policyError, setPolicyError] = useState<string | null>(null)

  const applyCommand = (patch: Partial<typeof cmd>) => {
    const next = { ...cmd, ...patch }
    setCmd(next)
    setCommand(next)
  }

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

        const created = await MicroDuckSim.create('scene.xml')
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
        renderer.start({
          // tick() is async; its own busy guard drops overlapping ticks rather
          // than queueing them, so the duck never acts on a stale observation.
          beforePhysics: (dt) => void runner.tick(dt),
          onFrame: () => setSimTime(sim!.data.time),
        })

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
            {POLICIES.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {policyError && <p className="inline-err">{policyError}</p>}
          <p className="hint">
            Nine Apache-2.0 policies from Pollen Robotics. Every one is
            <code> obs[1,61] → actions[1,14]</code>, run here at 50&nbsp;Hz.
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
