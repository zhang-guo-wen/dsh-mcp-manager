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
 * The unmount is runtime state only. A preset is composed through `PresetTree`,
 * whose `write()` is a deliberate no-op (`agent-presets` owns that contract: a
 * preset is an input, never a persistence target), so toggling a row here
 * cannot rewrite the user's composition file. Global rows are left alone on
 * purpose — their tree is a file-backed `Include` whose `write()` would persist
 * whatever this gate did to them.
 *
 * @module @zhang-guo-wen/dsh-mcp-manager/mcp-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  findEntryRows,
  MCP_CLIENT_MODULE,
  presetLeafId,
  readEntryRows,
  type PresetFile,
} from './mcp-authoring.ts'
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
  readonly fiber?: unknown
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
}

/** The `agent-presets` surface the gate consumes. */
interface AgentPresetResolver {
  resolve(id: string): Promise<PresetFile>
  list(): Promise<readonly { readonly id: string }[]>
}

/** The Loader's internal resolver, used to find the harness's own agent-presets instance. */
interface InternalResolver {
  internal?: { import(spec: string, base: string, options: object): Promise<unknown> }
}

/** Warning sink for reconciling problems that must not break the plugin. */
export type GateWarn = (message: string) => void

/**
 * Host events that mean "the composed rows may have changed". `tools/change` is
 * the load-bearing one: a preset composes its rows after this plugin applies,
 * and those rows announce themselves by registering tools. `loader/entry-init`
 * and `agent-preset/selected` narrow the same moment and are kept because they
 * arrive even for a row that publishes no tool.
 */
export const MCP_ROW_EVENTS: readonly string[] = ['tools/change', 'loader/entry-init', 'agent-preset/selected']

/**
 * Resolve the `livePresetMounts` reader from the `agent-presets` instance the
 * Loader actually uses. A plain import can land on a second copy of the package
 * (the harness resolves its roster from its own graph), so the Loader's
 * internal resolver is asked first and the static import is the fallback.
 * @param ctx - plugin context holding `ctx.loader`.
 * @param fallback - the statically imported reader.
 * @returns a reader of the live preset mounts for this runtime.
 */
export async function resolvePresetMounts(
  ctx: Context,
  fallback: (within?: unknown) => readonly GateMount[],
): Promise<(within?: unknown) => readonly GateMount[]> {
  const loader = ctx.get('loader') as InternalResolver | undefined
  const base = (ctx as unknown as { baseUrl?: string }).baseUrl
  if (loader?.internal !== undefined && base !== undefined) {
    try {
      const mod = await loader.internal.import('@deepseek-ai/dsh-agent-presets', base, {}) as {
        livePresetMounts?: (within?: unknown) => readonly GateMount[]
      }
      if (mod.livePresetMounts !== undefined) return mod.livePresetMounts
    } catch {
      // Swallows only the internal-resolver miss; the static reader below is the
      // fallback and the outer call treats an empty registry as "nothing to do".
    }
  }
  return fallback
}

/**
 * Create the preload gate for one host plugin instance.
 * @param ctx - host context owning the loader and the agent-presets service.
 * @param readMode - reads the committed loading mode on every reconcile.
 * @param mountReader - reader of live preset mounts, from {@link resolvePresetMounts}.
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
  /** Serializes reconciles so an entry event cannot interleave with its own run. */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const run = async (): Promise<void> => {
    if (disposed) return
    const mode = readMode()
    const presets = ctx.get('agentPresets') as AgentPresetResolver | undefined
    if (presets === undefined) return
    const mounts = mountReader(ctx.root.fiber)
    const seen = new Set<string>()
    for (const mount of mounts) {
      let rows: readonly EntryOptions[]
      try {
        const preset = await presets.resolve(mount.presetId)
        rows = await readEntryRows(preset.path)
      } catch (error) {
        warn(`mcp-manager: cannot read preset "${mount.presetId}" composition: ${String(error)}`)
        continue
      }
      for (const entry of mount.tree.entries()) {
        if (entry.options.group === true || entry.options.name !== MCP_CLIENT_MODULE) continue
        const leaf = presetLeafId(entry.options.id)
        const serverName = entry.options.id
        const fileRow = findEntryRows(rows, leaf)[0]
        // A row the file does not declare (a patch insert, or a preset whose
        // file moved under us) keeps its composed state and is never driven.
        if (fileRow === undefined) continue
        const allowed = fileRow.disabled !== true
        const wantMounted = allowed && mode === 'eager'
        const key = mcpRowKey({ scope: 'preset', agentPreset: mount.presetId }, serverName)
        seen.add(key)
        const mounted = entry.fiber !== undefined
        if (mounted !== wantMounted) {
          try {
            await entry.update({ disabled: !wantMounted }, false, true)
          } catch (error) {
            warn(`mcp-manager: cannot ${wantMounted ? 'mount' : 'hold'} MCP row "${key}": ${String(error)}`)
            continue
          }
        }
        states.set(key, { allowed, suppressed: allowed && !wantMounted })
      }
    }
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
    suppressedKeys: () => [...states.entries()].filter(([, state]) => state.suppressed).map(([key]) => key),
    dispose: () => {
      disposed = true
      states.clear()
    },
  }
}
