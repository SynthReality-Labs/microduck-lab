/**
 * WebMCP site tools.
 *
 * The getter moved from `navigator` to `document` in the 2026-05-27 spec draft
 * and is deprecated in Chromium 150 — `document.modelContext` is the surface the
 * challenge rules require. Not yet in lib.dom, so declared here.
 */
export interface WebMcpToolDefinition<Args = Record<string, unknown>> {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Named `execute` in the challenge rules. */
  execute: (args: Args) => Promise<unknown> | unknown
  /** Named `handler` in Chrome's own examples. We register both. */
  handler?: (args: Args) => Promise<unknown> | unknown
}

export interface ModelContext {
  registerTool(tool: WebMcpToolDefinition<never>): void | Promise<void>
  unregisterTool?(name: string): void | Promise<void>
  provideContext?(tools: { tools: WebMcpToolDefinition<never>[] }): void | Promise<void>
  clearContext?(): void | Promise<void>
}

declare global {
  interface Document {
    modelContext?: ModelContext
  }
  interface Navigator {
    /** Legacy location, deprecated in Chromium 150. Probed only for diagnostics. */
    modelContext?: ModelContext
  }
}
