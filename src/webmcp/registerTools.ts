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

/** Wrap execute so every agent call lands in the dev panel's log. */
function instrument(tool: Tool): Tool {
  const inner = tool.execute
  return {
    ...tool,
    execute: async (args: Record<string, never>) => {
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
    },
  }
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

export async function registerWebMcpTools(): Promise<void> {
  const { ctx, surface } = findModelContext()
  const store = useStudio.getState()

  if (!ctx) {
    store.set({ webmcp: { available: false, surface: 'none', registered: [] } })
    return
  }

  const registered: string[] = []
  for (const tool of tools) {
    try {
      await ctx.registerTool(instrument(tool) as never)
      registered.push(tool.name)
    } catch (e) {
      console.error(`[webmcp] failed to register ${tool.name}`, e)
    }
  }

  store.set({ webmcp: { available: registered.length > 0, surface, registered } })
}

export const TOOL_NAMES = tools.map((t) => t.name)
