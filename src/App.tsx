import { useEffect, useRef, useState } from 'react'
import { MicroDuckSim } from './sim/MicroDuckSim'
import { mountModelAssets } from './sim/mujocoRuntime'
import { DuckRenderer } from './render/DuckRenderer'
import { useStudio } from './core/store'
import { attachSim, resetSim, setPaused } from './core/commands'
import { registerWebMcpTools } from './webmcp/registerTools'

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
        setRobot({ nu: sim.model.nu, nq: sim.model.nq })
        store.set({ status: 'ready' })

        renderer = new DuckRenderer(canvas, sim)
        renderer.start(() => setSimTime(sim!.data.time))

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
            <p style={{ fontSize: 12, color: 'var(--dim)', margin: 0 }}>
              No <code>document.modelContext</code> on this page. MicroDuck Lab works fully
              without an agent — open it in ChatGPT's in-app browser to enable site tools.
            </p>
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
