import './webmcp.d'
import type { WebMcpToolDefinition, ModelContext } from './webmcp.d'
import { useStudio } from '../core/store'
import * as core from '../core/commands'

/**
 * WebMCP adapter.
 *
 * Each entry is a schema + a call into the core command layer. If any real
 * logic appears in this file it belongs in ../core/commands.ts instead.
 */

type Tool = WebMcpToolDefinition<Record<string, never>>

const tools: Tool[] = [
  {
    name: 'get_studio_state',
    description:
      'Get what MicroDuck Lab is currently doing: load status, whether the simulation is paused, ' +
      'the current simulation time, and how many WebMCP tools are registered. ' +
      'Call this first when you need orientation before acting.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => core.getStudioState(),
  },
  {
    name: 'describe_robot',
    description:
      "Get the Microduck's kinematic and actuation layout: the 14 actuator names in action order, " +
      'all joint names, state dimensions (nq/nv/nu) and the physics timestep. ' +
      'Use this to ground any question about joints, actuators or the action space.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => core.describeRobot(),
  },
  {
    name: 'reset_sim',
    description:
      'Reset the robot to one of the poses defined in the scene. Use STAND before running a ' +
      'locomotion policy; INIT drops the robot from its spawn height.',
    inputSchema: {
      type: 'object',
      properties: {
        pose: {
          type: 'string',
          enum: ['INIT', 'STAND', 'SIT', 'FOLD'],
          description: 'Which keyframe pose to reset to. Defaults to STAND.',
        },
      },
      additionalProperties: false,
    },
    execute: (args: { pose?: 'INIT' | 'STAND' | 'SIT' | 'FOLD' }) =>
      core.resetSim(args?.pose ?? 'STAND'),
  },
  {
    name: 'set_paused',
    description:
      'Pause or resume the physics simulation. Pause before inspecting a specific moment so the ' +
      'state stops changing underneath you.',
    inputSchema: {
      type: 'object',
      properties: { paused: { type: 'boolean', description: 'true to pause, false to resume.' } },
      required: ['paused'],
      additionalProperties: false,
    },
    execute: (args: { paused: boolean }) => core.setPaused(Boolean(args?.paused)),
  },
] as unknown as Tool[]

/**
 * Wrap the callback so every agent call lands in the dev panel's log.
 *
 * The field name is not settled across sources: the challenge rules document
 * `execute`, while Chrome's own examples use `handler`. They cost one property
 * each, so we supply both rather than bet the gate on which one this build
 * reads.
 */
function instrument(tool: Tool): Tool {
  const inner = tool.execute
  const wrapped = async (args: Record<string, never>) => {
    let result: unknown
    let ok = true
    try {
      result = await inner(args)
      ok = (result as { ok?: boolean })?.ok !== false
    } catch (e) {
      ok = false
      result = { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
      useStudio.getState().logToolCall({ at: Date.now(), tool: tool.name, args, result, ok })
      return result
  }
  return { ...tool, execute: wrapped, handler: wrapped } as Tool
}

function findModelContext(): { ctx: ModelContext | null; surface: 'document' | 'navigator' | 'none' } {
  if (typeof document !== 'undefined' && document.modelContext) {
    return { ctx: document.modelContext, surface: 'document' }
  }
  // Legacy location; deprecated in Chromium 150. Probed so the dev panel can say
  // "old surface detected" rather than the unhelpful "unavailable".
  if (typeof navigator !== 'undefined' && navigator.modelContext) {
    return { ctx: navigator.modelContext, surface: 'navigator' }
  }
  return { ctx: null, surface: 'none' }
}

async function registerInto(ctx: ModelContext, surface: 'document' | 'navigator'): Promise<void> {
  const registered: string[] = []
  for (const tool of tools) {
    try {
      await ctx.registerTool(instrument(tool) as never)
      registered.push(tool.name)
    } catch (e) {
      console.error(`[webmcp] failed to register ${tool.name}`, e)
    }
  }
  useStudio.getState().set({
    webmcp: { available: registered.length > 0, surface, registered },
  })
  console.info(`[webmcp] registered ${registered.length} tools on ${surface}.modelContext`)
}

/** Try once, right now. Returns true if tools got registered. */
export async function tryRegisterWebMcpTools(): Promise<boolean> {
  const { ctx, surface } = findModelContext()
  if (!ctx || surface === 'none') return false
  await registerInto(ctx, surface)
  return true
}

let watching = false

/**
 * Register site tools, and keep looking if the surface is not there yet.
 *
 * `document.modelContext` is not guaranteed to exist at page-load time — an
 * agent-capable browser may inject it late, or only once an agent attaches to
 * the tab. A one-shot probe at boot would then report "not detected" forever on
 * a browser that does in fact support WebMCP, which is exactly the failure that
 * is indistinguishable from the feature being absent.
 *
 * So: probe immediately, then poll, then keep a slow heartbeat going. Cheap
 * (a property read), and it means the badge becomes correct on its own.
 */
export async function registerWebMcpTools(): Promise<void> {
  useStudio.getState().set({ webmcp: { available: false, surface: 'none', registered: [] } })

  if (await tryRegisterWebMcpTools()) return
  if (watching) return
  watching = true

  let delay = 250
  const attempt = async () => {
    if (await tryRegisterWebMcpTools()) {
      watching = false
      return
    }
    delay = Math.min(delay * 1.6, 5000)
    setTimeout(() => void attempt(), delay)
  }
  setTimeout(() => void attempt(), delay)

  // Attaching an agent often coincides with the tab being focused.
  addEventListener('focus', () => void tryRegisterWebMcpTools())
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void tryRegisterWebMcpTools()
  })
}

export const TOOL_NAMES = tools.map((t) => t.name)

/**
 * What agent-related surfaces this browser actually exposes.
 *
 * Reported in the dev panel so "not detected" can be distinguished from "not
 * injected yet" — and so a failing gate produces evidence rather than a shrug.
 */
export function probeAgentSurfaces(): Record<string, boolean> {
  const d = document as unknown as Record<string, unknown>
  const n = navigator as unknown as Record<string, unknown>
  const w = globalThis as unknown as Record<string, unknown>
  return {
    'document.modelContext': typeof d.modelContext === 'object' && d.modelContext !== null,
    'navigator.modelContext': typeof n.modelContext === 'object' && n.modelContext !== null,
    'navigator.agent': typeof n.agent === 'object' && n.agent !== null,
    'window.agent': typeof w.agent === 'object' && w.agent !== null,
    'window.ai': typeof w.ai === 'object' && w.ai !== null,
    isSecureContext: Boolean(w.isSecureContext),
  }
}
