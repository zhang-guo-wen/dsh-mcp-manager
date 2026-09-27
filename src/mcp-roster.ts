/**
 * The MCP roster the settings section renders, read without waiting for any MCP
 * server to finish starting.
 *
 * The plugin-inventory projection this section used before ran the agent-preset
 * registry's activation audit, which awaits every live row's fiber
 * (`auditRows`). A row whose plugin is an MCP client stays loading for the whole
 * child-process startup — seconds with `npx -y` / `uvx` launchers — so the
 * roster read, and with it the settings page and every refresh after a mutation,
 * blocked for that long. The same facts are available without awaiting: the
 * declaration list and the live fibers. This module reads those.
 *
 * Global rows come from the Loader. Preset rows come from the live standing
 * mount when the preset is mounted — the normal case, since a preset mounts when
 * it registers — and from the declaration otherwise. Enablement is the Loader's
 * own answer (`!entry.disabled`) for a live row, so a `!!js` gate is evaluated
 * exactly as a mount would evaluate it; a declaration read outside a mount
 * cannot evaluate one, so such a row reports `conditional` rather than a guess.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-roster
 */

import type { Context } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { MCP_CLIENT_MODULE, presetLeafId } from './mcp-authoring.ts'
import type { GateMount } from './mcp-gate.ts'
import { listPresetDeclarations } from './preset-source.ts'
import type { ListMcpsResult, McpFiberPhase, McpRosterPreset, McpRosterRow } from './types.ts'

/**
 * Runtime mirror of Cordis's cross-package `FiberState` enum; the values are the
 * Loader's own.
 */
const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** One root-Loader entry, reduced to what the roster reads. */
interface RosterLoaderEntry {
  readonly id: string
  readonly options: EntryOptions
  readonly disabled: boolean
  readonly fiber?: { readonly state: number } | undefined
  readonly subtree?: { readonly filename?: string; readonly config?: { readonly patches?: readonly unknown[] } } | undefined
}

/** One MCP row found in a composition, before it is projected for the section. */
interface RosterRowSource {
  readonly entryId: string | null
  readonly options: EntryOptions
  readonly live: boolean
  readonly enabled: boolean | 'conditional'
  readonly state: number | undefined
}

/** Translate one fiber state into the roster's phase vocabulary. */
function phaseOf(state: number | undefined): McpFiberPhase {
  switch (state) {
    case FIBER_STATE.PENDING: return 'pending'
    case FIBER_STATE.LOADING: return 'loading'
    case FIBER_STATE.ACTIVE: return 'active'
    case FIBER_STATE.FAILED: return 'failed'
    case FIBER_STATE.UNLOADING: return 'unloading'
    // No fiber at all and a disposed fiber both mean "not running right now".
    default: return null
  }
}

/** Project one source row onto the row the settings section renders. */
function rosterRow(source: RosterRowSource): McpRosterRow {
  return {
    entryId: source.entryId,
    moduleName: source.options.name,
    enabled: source.enabled,
    fiberPhase: source.live ? phaseOf(source.state) : null,
  }
}

/** Whether a row names the MCP client bridge and is not a structural group. */
function isMcpRow(options: EntryOptions): boolean {
  return options.group !== true && options.name === MCP_CLIENT_MODULE
}

/**
 * Enablement of one declared row, following the Loader's own reading: any
 * literal `true` disables, anything else enables, and a `!!js` expression stays
 * `conditional` because only a mount can evaluate it.
 * @param contributions - the row's own `disabled` node and its groups', outermost first.
 * @returns true (enabled), false (disabled), or `conditional`.
 */
function declaredEnablement(...contributions: readonly unknown[]): boolean | 'conditional' {
  let conditional = false
  for (const value of contributions) {
    if (isJsExpr(value)) conditional = true
    else if (Boolean(value)) return false
  }
  return conditional ? 'conditional' : true
}

/**
 * Collect the MCP rows of one declared composition, descending into groups the
 * way the Loader does: a group's `disabled` is inherited by its children.
 * @param rows - declared child rows at the current level.
 * @param inherited - `disabled` nodes contributed by owning groups.
 * @param found - accumulator receiving one source per MCP row.
 */
function declaredMcpRows(
  rows: readonly EntryOptions[],
  inherited: readonly unknown[],
  found: RosterRowSource[],
): void {
  for (const row of rows) {
    if (row.group === true) {
      const children = Array.isArray(row.config) ? row.config as EntryOptions[] : []
      declaredMcpRows(children, [...inherited, row.disabled], found)
      continue
    }
    if (!isMcpRow(row)) continue
    found.push({
      entryId: typeof row.id === 'string' && row.id !== '' ? row.id : null,
      options: row,
      live: false,
      enabled: declaredEnablement(...inherited, row.disabled),
      state: undefined,
    })
  }
}

/**
 * Read every MCP row the running composition declares, plus the planes a
 * mutation can target.
 *
 * Nothing here awaits, so a row that is connecting reports its `loading` phase
 * instead of holding the read open.
 * @param ctx - host context carrying the Loader and the profile editor.
 * @param mountReader - reader of the live agent-preset mounts, resolved through
 *   the Loader so it observes the same registry instance as the composition.
 * @returns the global rows, every declared preset with its rows, and whether the
 *   global plane accepts writes.
 */
export function readMcpRoster(
  ctx: Context,
  mountReader: (within?: unknown) => readonly GateMount[],
): ListMcpsResult {
  const loader = ctx.get('loader') as { entries(): Iterable<RosterLoaderEntry> } | undefined
  const entries: McpRosterRow[] = []
  /** Mounted root Includes, which is where a global write lands. */
  let includes = 0
  if (loader !== undefined) {
    for (const entry of loader.entries()) {
      if (entry.options.name === 'cordis:include' && entry.subtree !== undefined) {
        includes += 1
      }
      if (!isMcpRow(entry.options)) continue
      entries.push(rosterRow({
        entryId: entry.id,
        options: entry.options,
        live: true,
        enabled: !entry.disabled,
        state: entry.fiber?.state,
      }))
    }
  }

  const mounts = mountReader(ctx.root.fiber)
  const presets: McpRosterPreset[] = listPresetDeclarations(ctx).map((declaration) => {
    const mount = mounts.find(candidate => candidate.presetId === declaration.id)
    const sources: RosterRowSource[] = []
    if (mount === undefined) {
      declaredMcpRows(declaration.rows, [], sources)
    } else {
      for (const row of mount.tree.entries()) {
        if (!isMcpRow(row.options)) continue
        sources.push({
          entryId: presetLeafId(row.options.id),
          options: row.options,
          live: true,
          enabled: !row.disabled,
          state: row.fiber?.state,
        })
      }
    }
    return {
      id: declaration.id,
      ...declaration.name === undefined ? {} : { name: declaration.name },
      rows: sources.map(rosterRow),
    }
  })

  // A global write edits the Include's own file and reloads it, so the profile's
  // patch layers stay where they are; only a composition with no single
  // file-backed Include has nothing to address.
  return {
    entries,
    presets,
    globalWritable: includes === 1,
  }
}
