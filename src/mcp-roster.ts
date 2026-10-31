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
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { MCP_CLIENT_MODULE, findEntryRows, presetLeafId, readEntryListRowsSync, writableGlobalIncludes } from './mcp-authoring.ts'
import type { GateMount, McpGlobalRow } from './mcp-gate.ts'
import { declaredMcpRows } from './mcp-allowance.ts'
import { storedCredentialKeys } from './mcp-config.ts'
import { diagnoseRowConfig } from './mcp-diagnostics.ts'
import { listPresetDeclarations } from './preset-source.ts'
import type { ListMcpsResult, McpFiberPhase, McpRosterPreset, McpRosterRow, McpRowReadOnly } from './types.ts'

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
  /** The preload gate holds this row back before its plugin ever runs. */
  readonly held?: boolean
}

/**
 * Translate one fiber state into the roster's phase vocabulary.
 *
 * A row the gate held at publication has a disposed fiber, which is otherwise
 * indistinguishable from a row that started and stopped. It is reported as
 * `held` so the settings surface keeps showing the resting state D15 defines,
 * instead of switching a working server's row to "stopped".
 * @param state - the live fiber's state, absent when the entry has no fiber.
 * @param held - whether the preload gate is holding this row back.
 * @returns the phase the section renders.
 */
function phaseOf(state: number | undefined, held = false): McpFiberPhase {
  if (held) return 'held'
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
  const configIssue = diagnoseRowConfig(source.options.config)
  return {
    entryId: source.entryId,
    moduleName: source.options.name,
    enabled: source.enabled,
    // Preset rows are always writable: the profile patch that declares the
    // preset is the file a preset write edits, and it owns every nested row.
    writable: true,
    fiberPhase: source.live ? phaseOf(source.state, source.held) : null,
    // Key names only: the settings page uses them to decide whether a row has
    // credentials to edit, and credential values never leave the Host.
    secretKeys: storedCredentialKeys(source.options.config),
    ...configIssue.length === 0 ? {} : { configIssue },
  }
}

/** Whether a row names the MCP client bridge and is not a structural group. */
function isMcpRow(options: EntryOptions): boolean {
  return options.group !== true && options.name === MCP_CLIENT_MODULE
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
 * @param heldEntryIds - row ids the preload gate is holding back right now.
 * @param globalRows - the composed global rows the gate read from the include.
 *   A global row lives inside the include's tree, not at the Loader root, so
 *   this is the only read that finds it; the root entry list is the fallback for
 *   a composition that mounts an mcp-client row directly.
 * @returns the global rows, every declared preset with its rows, and whether the
 *   global plane accepts writes.
 */
export function readMcpRoster(
  ctx: Context,
  mountReader: (within?: unknown) => readonly GateMount[],
  heldEntryIds: readonly string[] = [],
  globalRows: readonly McpGlobalRow[] = [],
): ListMcpsResult {
  const held = new Set(heldEntryIds)
  const loader = ctx.get('loader') as { entries(): Iterable<RosterLoaderEntry> } | undefined
  const entries: McpRosterRow[] = []
  /**
   * The user's own file-backed Includes, which is where a global write lands.
   *
   * The host's root anchor is not one of them: `prepareProfile` rewrites its
   * file on every start. Counting it made a profile that declares its own
   * Include look like a two-Include composition, which closed the whole plane.
   */
  const includes = writableGlobalIncludes(loader?.entries() ?? [])
  const fileRows = includes.length === 1 ? readEntryListRowsSync(includes[0]!.filename) : undefined
  /** Why a global row cannot be written here, shared by every global row. */
  const globalReadOnly: McpRowReadOnly | undefined = includes.length === 0
    ? 'no-writable-include'
    : includes.length > 1
      ? 'several-writable-includes'
      : fileRows === undefined
        ? 'unreadable-include'
        : undefined
  /**
   * Whether one global row is declared by the one writable Include's own file.
   *
   * A row a patch layer or the composition itself contributes exists only in
   * the live tree, so the file a global write patches has no row to update.
   */
  const globalWritableRow = (entryId: string): boolean =>
    globalReadOnly === undefined && findEntryRows(fileRows ?? [], presetLeafId(entryId)).length === 1
  const globalRow = (row: McpRosterRow): McpRosterRow => globalWritableRow(row.entryId ?? '')
    ? row
    : { ...row, writable: false, ...globalReadOnly === undefined ? { readOnly: 'composed-row' as const } : { readOnly: globalReadOnly } }
  const composedGlobals = new Set<string>()
  for (const row of globalRows) {
    composedGlobals.add(row.entryId)
    entries.push(globalRow(rosterRow({
      entryId: row.entryId,
      // The composed projection carries the row's own config, which is what the
      // settings page reads for its credential fields and its "not configured"
      // marker; building an options object without it made every global row
      // report an empty configuration.
      options: { id: row.entryId, name: MCP_CLIENT_MODULE, ...row.config === undefined ? {} : { config: row.config } } as EntryOptions,
      live: true,
      enabled: row.enabled,
      state: row.mounted ? FIBER_STATE.ACTIVE : undefined,
      held: row.held,
    })))
  }
  if (loader !== undefined) {
    for (const entry of loader.entries()) {
      // A row enumerates under its qualified id here and under its leaf id in
      // the composed projection, so join on the leaf. Reading the instance's
      // `disabled` would also report this gate's own hold as a user disabling,
      // which is what the composed projection exists to prevent.
      if (!isMcpRow(entry.options) || composedGlobals.has(presetLeafId(entry.id))) continue
      entries.push(globalRow(rosterRow({
        entryId: presetLeafId(entry.id),
        options: entry.options,
        live: true,
        enabled: entry.options.disabled !== true,
        state: entry.fiber?.state,
      })))
    }
  }

  const mounts = mountReader(ctx.root.fiber)
  // The profile editor owns the declared child rows, so it is the primary
  // source. A composition that mounts preset trees without one — a test
  // harness, or a host that reads but never edits — still has live mounts, and
  // their captured declarations answer the same question.
  const declared = listPresetDeclarations(ctx)
  const presetIds = declared.length > 0
    ? declared.map(declaration => declaration.id)
    : [...new Set(mounts.map(mount => mount.presetId))]
  const presets: McpRosterPreset[] = presetIds.map((presetId) => {
    const declaration = declared.find(candidate => candidate.id === presetId)
    const mount = mounts.find(candidate => candidate.presetId === presetId)
    const sources: RosterRowSource[] = []
    const declaredRowsForMount = declaration?.rows ?? mount?.declaration ?? []
    if (mount === undefined) {
      for (const row of declaredMcpRows(declaredRowsForMount, MCP_CLIENT_MODULE)) sources.push({
        entryId: typeof row.options.id === 'string' && row.options.id !== '' ? row.options.id : null,
        options: row.options, live: false, enabled: row.enabled, state: undefined,
      })
    } else {
      // Enablement comes from the DECLARATION here too, not from the live tree.
      // The live tree's flag is the gate's own artifact under `dynamic`/`lazy`:
      // the gate really does set `disabled` on every allowed row it holds
      // unmounted. Reporting that as the row's state makes the whole preset
      // plane read as "disabled" whenever the loading mode is not `eager`.
      for (const row of mount.tree.entries()) {
        if (!isMcpRow(row.options)) continue
        const leaf = presetLeafId(row.options.id)
        const declaredRow = declaredMcpRows(
          declaredRowsForMount,
          MCP_CLIENT_MODULE,
          row.evaluate?.bind(row),
        ).find(candidate => presetLeafId(candidate.options.id) === leaf)
        sources.push({
          entryId: leaf,
          options: row.options,
          live: true,
          enabled: declaredRow?.enabled ?? !row.disabled,
          state: row.fiber?.state,
          held: held.has(leaf),
        })
      }
    }
    return {
      id: presetId,
      ...declaration?.name === undefined ? {} : { name: declaration.name },
      rows: sources.map(rosterRow),
    }
  })

  // A global write edits the user's own Include file and reloads it, so the
  // profile's patch layers stay where they are. The host's root anchor is not a
  // target: only a composition with no single writable Include of its own, or
  // with several, has nothing to address.
  return {
    entries,
    presets,
    globalWritable: includes.length === 1,
    ...globalReadOnly === undefined ? {} : { globalReason: globalReadOnly },
  }
}
