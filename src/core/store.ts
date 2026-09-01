import { create } from 'zustand'

export type SimStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ToolCallLogEntry {
  at: number
  tool: string
  args: unknown
  result: unknown
  ok: boolean
}

interface StudioState {
  status: SimStatus
  error: string | null
  loadProgress: { done: number; total: number }
  paused: boolean
  simTime: number
  loadedPolicy: string | null
  commandVersion: number
  /** What the human currently has selected. This is agent-readable state. */
  selection: { jointId: number; jointName: string; bodyName: string } | null
  highlight: string[]
  rolloutIds: string[]
  /** Rollout review: which episode is open, where the playhead is, what is selected. */
  review: {
    episodeId: string
    frame: number
    playing: boolean
    range: { startFrame: number; endFrame: number } | null
  } | null
  recording: { active: boolean; label: string } | null
  objectiveVersion: number
  webmcp: { available: boolean; surface: 'document' | 'navigator' | 'none'; registered: string[] }
  toolLog: ToolCallLogEntry[]

  set: (patch: Partial<StudioState>) => void
  logToolCall: (entry: ToolCallLogEntry) => void
}

/**
 * The single canonical store. Both the UI and the WebMCP adapter read and write
 * studio state through the command layer that sits over this — never directly,
 * and never through a second path. See D8.
 */
export const useStudio = create<StudioState>((set) => ({
  status: 'idle',
  error: null,
  loadProgress: { done: 0, total: 0 },
  paused: false,
  simTime: 0,
  loadedPolicy: null,
  commandVersion: 0,
  selection: null,
  highlight: [],
  rolloutIds: [],
  review: null,
  recording: null,
  objectiveVersion: 0,
  webmcp: { available: false, surface: 'none', registered: [] },
  toolLog: [],

  set: (patch) => set(patch),
  logToolCall: (entry) =>
    set((s) => ({ toolLog: [entry, ...s.toolLog].slice(0, 200) })),
}))
