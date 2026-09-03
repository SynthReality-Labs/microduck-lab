/**
 * One source of truth for "what policies exist".
 *
 * There used to be two: the frozen `POLICIES` catalogue of the nine Pollen
 * releases, and a Map of user imports living inside the command layer. Loading
 * consulted both; the dropdown, the eval suite and the post-eval restore
 * consulted only the first. So a policy you trained yourself imported fine,
 * drove the robot, and was then invisible to the very feature it exists for —
 * A/B against the baseline.
 *
 * This module owns both halves. It imports only `policyContract`, so both the
 * command layer and `evaluate.ts` can depend on it without a cycle.
 */
import { POLICIES, type PolicyId } from './policyContract'
import type { PolicyRunner } from './PolicyRunner'

export interface ImportedPolicy {
  id: string
  label: string
  url: string
  source: 'url' | 'file'
}

/** A policy the studio can load, whether we shipped it or the user brought it. */
export interface ResolvedPolicy {
  id: string
  label: string
  /** Bundled under assets/policies — set for the nine published policies. */
  file?: string
  /** Fetchable URL or object URL — set for imports. */
  url?: string
  source: 'pollen' | 'imported'
  role: string
}

const imported = new Map<string, ImportedPolicy>()

export function listImportedPolicies(): ImportedPolicy[] {
  return [...imported.values()]
}

export function registerImported(rec: ImportedPolicy): void {
  imported.set(rec.id, rec)
}

export function isImported(id: string): boolean {
  return imported.has(id)
}

/** Every policy, published then imported, in the order a list should show them. */
export function listAllPolicies(): ResolvedPolicy[] {
  return [
    ...POLICIES.map((p) => ({
      id: p.id as string,
      label: p.label,
      file: p.file,
      source: 'pollen' as const,
      role: p.role,
    })),
    ...[...imported.values()].map((p) => ({
      id: p.id,
      label: p.label,
      url: p.url,
      source: 'imported' as const,
      role: 'imported by the user',
    })),
  ]
}

/** Resolve an id against both catalogues. Undefined means genuinely unknown. */
export function resolvePolicy(id: string): ResolvedPolicy | undefined {
  return listAllPolicies().find((p) => p.id === id)
}

export function allPolicyIds(): string[] {
  return listAllPolicies().map((p) => p.id)
}

/**
 * Load a policy by id, picking the right door.
 *
 * Published policies live at a known path under assets; imports carry their own
 * URL. Every caller that used to hand-roll `POLICIES.find(...)` then
 * `runner.load(...)` should call this instead — that hand-rolling is precisely
 * what made imports unreachable from the eval suite.
 */
export async function loadPolicyById(runner: PolicyRunner, id: string): Promise<ResolvedPolicy> {
  const entry = resolvePolicy(id)
  if (!entry) throw new Error(`unknown policy ${id}`)
  if (entry.file) await runner.load(entry.id as PolicyId, entry.file)
  else await runner.loadFrom(entry.id, entry.url!)
  return entry
}
