/**
 * Preload gate: which allowed MCP rows may hold tool slots before anything asks
 * for them.
 *
 * A composition row's `disabled` flag carries the user's answer to "may this
 * server be used at all". The loading mode answers a different question —
 * "should an allowed server take part in every request?" — and this gate is the
 * bridge. With `eager` an allowed row stays mounted; with `dynamic` or `lazy`
 * the gate unmounts it, so its tool schemas stay out of the request until
 * `mcp_load` pulls the server into one session.
 *
 * The gate reads enablement from the preset revision's captured DECLARATION,
 * never its current live flags: the live tree is what the gate itself disables.
 * Older Agents retain their own generation; the latest profile declaration
 * must not replace that revision's allowance.
 *
 * The unmount is runtime state only. A preset is composed through the
 * registry's in-memory tree, whose `write()` is a deliberate no-op, so toggling
 * a row here cannot rewrite the user's declaration. Global rows are left alone
 * on purpose — their tree is a file-backed `Include` whose `write()` would
 * persist whatever this gate did to them.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { MCP_CLIENT_MODULE, presetLeafId } from './mcp-authoring.ts'
import { declaredMcpRows } from './mcp-allowance.ts'
import { findPresetDeclaration } from './preset-source.ts'
import type { McpLoadingMode } from './lazy-mcp.ts'
import type { McpTarget } from './types.ts'

/** One row's runtime answer: may it be used, and is it held out of the request. */
export interface McpRowGateState {
  /** The user's composition file enables the row. */
  readonly allowed: boolean
  /** The gate holds the row unmounted because the mode does not preload. */
  readonly suppressed: boolean
}

/** Runtime preload gate over every live preset mount. */
export interface McpPreloadGate {
  /** Bring every live preset row in line with the current mode. */
  reconcile(): Promise<void>
  /** The gate's answer for one row, undefined when the row is not mounted. */
  stateFor(target: McpTarget, entryId: string): McpRowGateState | undefined
  /** Nonblocking revision-local allowance for on-demand inventory reads. */
  presetRows?(): readonly McpPresetRows[]
  /** Keys of the rows the gate currently suppresses, for the settings UI. */
  suppressedKeys(): readonly string[]
  /** Release the gate's own bookkeeping (it holds no services). */
  dispose(): void
}

/** Stable key for one row, matching the settings UI's description key. */
export function mcpRowKey(target: McpTarget, serverName: string): string {
  return target.scope === 'preset' ? `preset:${target.agentPreset}:${serverName}` : `global:${serverName}`
}

/** The loader entry surface this gate drives. */
export interface GateEntry {
  readonly options: EntryOptions
  /** Effective enablement the Loader reports, with a `!!js` node evaluated. */
  readonly disabled: boolean
  /** Root fiber; disposed fibers do not count as mounted. */
  readonly fiber?: { readonly state: number; readonly uid?: number | null; readonly inertia?: Promise<void> } | undefined
  /** Evaluate a declaration's !!js node in this row's Loader context. */
  evaluate?(expression: string): unknown
  update(options: Partial<EntryOptions>, create?: boolean, force?: boolean): Promise<void>
}

/** The preset mount tree surface this gate drives. */
export interface GateTree {
  entries(): Iterable<GateEntry>
}

/** One live preset mount, reduced to what the gate reads. */
export interface GateMount {
  readonly presetId: string
  readonly tree: GateTree
  /** Standing generation scope on the newer registry. */
  readonly scope?: object
  /** Revision-local declaration captured before runtime suppression. */
  readonly declaration?: readonly EntryOptions[]
}

/** Synchronous row snapshot shared by the roster and on-demand inventory. */
export interface McpPresetRows {
  readonly presetId: string
  readonly scope?: object
  readonly rows: readonly {
    readonly entryId: string
    readonly allowed: boolean
    /** Existing runtime config, never logged or persisted by the gate. */
    readonly config?: unknown
  }[]
}

/** Warning sink for reconciling problems that must not break the plugin. */
export type GateWarn = (message: string) => void

/** Row creation, teardown, and late dependency activation all invalidate snapshots. */
export const MCP_ROW_EVENTS: readonly string[] = [
  'tools/change', 'loader/entry-init', 'loader/partial-dispose', 'internal/status', 'agent-preset/selected',
]

/**
 * Create the preload gate for one host plugin instance.
 * @param ctx - host context owning the loader and the agent-presets service.
 * @param readMode - reads the committed loading mode on every reconcile.
 * @param mountReader - synchronous reader of live preset revisions.
 * @param warn - diagnostics sink for rows the gate cannot drive.
 * @returns the gate the tool registration consults.
 */
export function createMcpPreloadGate(
  ctx: Context,
  readMode: () => McpLoadingMode,
  mountReader: (within?: unknown) => readonly GateMount[],
  warn: GateWarn,
): McpPreloadGate {
  /** Runtime answers, keyed as {@link mcpRowKey}. */
  const states = new Map<string, McpRowGateState>()
  let presetRows: McpPresetRows[] = []
  /** Serializes reconciles so an entry event cannot interleave with its own run. */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const run = async (): Promise<void> => {
    if (disposed) return
    const mode = readMode()
    const mounts = mountReader(ctx.root.fiber)
    const seen = new Set<string>()
    const published = new Set<string>()
    const nextRows: McpPresetRows[] = []
    for (const mount of mounts) {
      let rows: readonly EntryOptions[]
      try {
        rows = mount.declaration ?? findPresetDeclaration(ctx, mount.presetId).rows
      } catch (error) {
        warn(`mcp-manager: cannot read preset "${mount.presetId}" composition: ${String(error)}`)
        continue
      }
      const revisionRows: { entryId: string; allowed: boolean; config?: unknown }[] = []
      for (const entry of mount.tree.entries()) {
        if (entry.options.group === true || entry.options.name !== MCP_CLIENT_MODULE) continue
        const leaf = presetLeafId(entry.options.id)
        const serverName = leaf
        const declaredRow = declaredMcpRows(rows, MCP_CLIENT_MODULE, entry.evaluate?.bind(entry))
          .find(row => presetLeafId(row.options.id) === leaf)
        // A row the declaration does not carry (a patch insert, or a preset
        // whose declaration moved under us) keeps its composed state and is
        // never driven.
        if (declaredRow === undefined) continue
        const allowed = declaredRow.enabled === true
        revisionRows.push({ entryId: leaf, allowed, config: entry.options.config })
        const wantMounted = allowed && mode === 'eager'
        // Loader's disabled update starts disposal but does not join it. Never
        // mount a replacement while the old stdio/client is still closing.
        const previous = entry.fiber
        if (wantMounted && previous !== undefined && (previous.state === 5 || previous.uid === null)) {
          while (previous.inertia !== undefined) await previous.inertia
        }
        const key = mcpRowKey({ scope: 'preset', agentPreset: mount.presetId }, serverName)
        seen.add(key)
        const mounted = entry.fiber !== undefined && entry.fiber.uid !== null && entry.fiber.state !== 4 && entry.fiber.state !== 5
        // A stopped row may keep a disposed fiber or a suppressed options flag.
        // Restore its declaration even when no live fiber exists.
        if (mounted !== wantMounted || Boolean(entry.options.disabled) !== !wantMounted) {
          try {
            await entry.update({ disabled: !wantMounted }, false, true)
          } catch (error) {
            warn(`mcp-manager: cannot ${wantMounted ? 'mount' : 'hold'} MCP row "${key}": ${String(error)}`)
            continue
          }
        }
        // Newest revision wins the settings projection, but every generation
        // above is driven using its own declaration.
        if (!published.has(key)) {
          states.set(key, { allowed, suppressed: allowed && !wantMounted })
          published.add(key)
        }
      }
      nextRows.push({ presetId: mount.presetId, ...(mount.scope === undefined ? {} : { scope: mount.scope }), rows: revisionRows })
    }
    presetRows = nextRows
    // Drop bookkeeping for rows that no longer exist, so a removed preset does
    // not keep reporting a suppression it no longer owns.
    for (const key of [...states.keys()]) if (!seen.has(key)) states.delete(key)
  }

  const reconcile = (): Promise<void> => {
    queue = queue.then(run, run)
    return queue
  }

  return {
    reconcile,
    stateFor: (target, entryId) => states.get(mcpRowKey(target, presetLeafId(entryId))),
    presetRows: () => presetRows,
    suppressedKeys: () => [...states.entries()].filter(([, state]) => state.suppressed).map(([key]) => key),
    dispose: () => {
      disposed = true
      states.clear()
      presetRows = []
    },
  }
}
