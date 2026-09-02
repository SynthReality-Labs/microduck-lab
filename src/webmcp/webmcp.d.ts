/**
 * WebMCP site tools.
 *
 * The getter moved from `navigator` to `document` in the 2026-05-27 spec draft
 * and is deprecated in Chromium 150 — `document.modelContext` is the surface the
 * challenge rules require. Not yet in lib.dom, so declared here.
 */
export interface WebMcpToolDefinition<Args = Record<string, unknown>> {
  name: string
  /** Chrome's RegisteredTool exposes a `title`; supply a human-readable one. */
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  /** Named `execute` in the challenge rules. */
  execute: (args: Args) => Promise<unknown> | unknown
  /** Named `handler` in Chrome's own examples. We register both. */
  handler?: (args: Args) => Promise<unknown> | unknown

  /**
   * Annotation hints from Chrome's WebMCP tool-security guidance.
   *
   * `readOnlyHint` tells an agent the call cannot change state, so it is safe to
   * retry or issue speculatively. `untrustedContentHint` marks a result carrying
   * third-party or user-supplied text, which an agent should treat as data
   * rather than instructions — the standard defence against indirect prompt
   * injection.
   *
   * They MUST be nested under `annotations`. Passed as flat top-level fields
   * (which the guidance's prose reads as) Chrome silently discards them: the
   * RegisteredTool comes back from getTools() with no trace. Nested, it
   * round-trips intact. Verified against Chrome 152.
   */
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
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
