/** Live preset trees without depending on a removed registry root export. */
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { GateEntry, GateMount, GateTree } from './mcp-gate.ts'

interface RuntimeFiber {
  readonly uid: number | null
  readonly state: number
  readonly parent: { readonly fiber: RuntimeFiber }
  readonly entry?: RuntimeEntry
}

interface RuntimeEntry extends GateEntry {
  readonly parent?: { readonly tree: RuntimeTree }
}

interface RuntimeTree extends GateTree {
  readonly ctx: Context & { readonly fiber: RuntimeFiber }
  readonly root: { readonly data: readonly EntryOptions[] }
}

/** Scope helpers must come from the host's own module graph. */
export interface PresetScopeLookup {
  scopeOf(ctx: Context): object | undefined
  createScope(ctx: Context, key: object, options: { parent: object }): {
    readonly ctx: Context
    dispose(): void | Promise<void>
  }
}

/** Plugin-owned, root-local weak state survives manager-only HMR/re-enablement. */
const PRESET_STATE = Symbol.for('@guowenzhang/dsh-mcp-manager:preset-state')
interface PresetState {
  readonly trees: Set<WeakRef<RuntimeTree>>
  readonly observed: WeakSet<RuntimeTree>
  readonly mounts: WeakMap<RuntimeTree, GateMount>
}

function presetState(ctx: Context): PresetState {
  const root = ctx.root as Context & { [PRESET_STATE]?: PresetState }
  if (root[PRESET_STATE] === undefined) Object.defineProperty(root, PRESET_STATE, { value: {
    trees: new Set<WeakRef<RuntimeTree>>(), observed: new WeakSet<RuntimeTree>(), mounts: new WeakMap<RuntimeTree, GateMount>(),
  } })
  return root[PRESET_STATE]!
}

/** A synchronous reader with explicit lifecycle ownership. */
export interface PresetMountReader {
  (within?: unknown): readonly GateMount[]
  observe(entry: unknown): void
  dispose(): void
}

/** Compare fiber identities, never registry-local numeric ids. */
function withinFiber(fiber: RuntimeFiber, root: unknown): boolean {
  const seen = new Set<RuntimeFiber>()
  while (!seen.has(fiber)) {
    if (fiber === root) return true
    seen.add(fiber)
    fiber = fiber.parent.fiber
  }
  return false
}

/** Keep only declaration/enablement metadata, not connection credentials. */
function declaredRows(rows: readonly EntryOptions[]): EntryOptions[] {
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    ...(row.disabled === undefined ? {} : { disabled: structuredClone(row.disabled) }),
    ...(row.group === true ? {
      group: true,
      config: declaredRows(Array.isArray(row.config) ? row.config as EntryOptions[] : []),
    } : {}),
  }))
}

/**
 * Discover detached trees through public Loader entries. A registry no longer
 * publishes mutable mounts, but every live entry still names its owning tree.
 * A short-lived, empty scope parented to that tree lets `composedPreset` answer
 * its identity through the public scope API, without reading registry internals
 * or retaining/recomposing an Agent. No tool or service is registered there.
 *
 * The reader captures each revision's own declaration before the gate touches
 * it. Old Agents therefore retain their old allowance, not the latest file's.
 */
export function createPresetMountReader(ctx: Context, scopes: PresetScopeLookup): PresetMountReader {
  const state = presetState(ctx)
  const snapshots = state.mounts
  let disposed = false
  const observe = (value: unknown): void => {
    if (disposed) return
    const tree = (value as RuntimeEntry | undefined)?.parent?.tree
    if (tree !== undefined && scopes.scopeOf(tree.ctx) !== undefined && !state.observed.has(tree)) {
      state.observed.add(tree)
      state.trees.add(new WeakRef(tree))
    }
  }
  const read = (within: unknown = ctx.root.fiber): readonly GateMount[] => {
    if (disposed) return []
    const registry = ctx.get('agentPresets') as { composedPreset?(context: Context): string | undefined } | undefined
    if (registry === undefined) return []
    if (typeof registry.composedPreset !== 'function') throw new Error('mcp-manager: preset scope inspection is unavailable')
    const runtimes = ctx.registry.values() as Iterable<{ readonly fibers: Iterable<RuntimeFiber> }>
    for (const runtime of runtimes) for (const fiber of runtime.fibers) observe(fiber.entry)
    const trees: RuntimeTree[] = []
    for (const reference of state.trees) {
      const tree = reference.deref()
      if (tree === undefined || tree.ctx.fiber.uid === null || tree.ctx.fiber.state === 4 || tree.ctx.fiber.state === 5) {
        state.trees.delete(reference)
      } else if (withinFiber(tree.ctx.fiber, within)) trees.push(tree)
    }
    // Nested Includes share the standing scope, but are not another preset.
    const roots = trees.filter(tree => !trees.some(other => other !== tree
      && scopes.scopeOf(other.ctx) === scopes.scopeOf(tree.ctx)
      && withinFiber(tree.ctx.fiber, other.ctx.fiber)))
    const mounts: GateMount[] = []
    for (const tree of roots) {
      let mount = snapshots.get(tree)
      if (mount === undefined) {
        const key = scopes.scopeOf(tree.ctx)!
        const probe = scopes.createScope(ctx, {}, { parent: key })
        let presetId: string | undefined
        try { presetId = registry.composedPreset(probe.ctx) }
        finally {
          void Promise.resolve(probe.dispose()).catch(() => ctx.logger.warn('mcp-manager: preset inspection scope cleanup failed'))
        }
        // A tree still activating is not published yet. A later status event
        // retries it; reading must never await its activation/audit.
        if (presetId === undefined) continue
        mount = { presetId, tree, scope: key, declaration: declaredRows(tree.root.data) }
        snapshots.set(tree, mount)
      }
      mounts.push(mount)
    }
    // The settings roster reads the newest live revision; the gate drives all
    // retained revisions, each with its own captured declaration.
    return mounts.sort((left, right) =>
      ((right.tree as RuntimeTree).ctx.fiber.uid ?? 0) - ((left.tree as RuntimeTree).ctx.fiber.uid ?? 0))
  }
  return Object.assign(read, {
    observe,
    dispose: () => { disposed = true },
  })
}
