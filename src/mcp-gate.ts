/**
 * Preload gate: which allowed MCP rows may hold tool slots before anything asks
 * for them.
 *
 * A composition row's `disabled` flag carries the user's answer to "may this
 * server be used at all". The loading mode answers a different question —
 * "should an allowed server take part in every request?" — and this gate is the
 * bridge. With `eager` an allowed row stays mounted; with `dynamic` or `lazy`
 * the gate holds it out of the request until `mcp_load` pulls the server into
 * one session.
 *
 * The hold happens at the row's fiber publication, before the plugin callback
 * runs. `mcp-client` starts its child process inside `apply`, so a correction
 * that arrives after the mount is always too late: the row would spawn and be
 * killed again on every host start and every declaration rebuild. Cordis
 * publishes a fiber through `internal/plugin` before it resolves the fiber's
 * dependencies, and disposing that fiber there skips activation entirely — the
 * process never starts. The Loader-driven `entry.update({ disabled })` stays as
 * the idempotent second path, because a row can also be reached by events this
 * observer never sees.
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
import { diagnoseRowConfig } from './mcp-diagnostics.ts'
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
  /**
   * Consider one published fiber for an immediate hold.
   *
   * The caller installs its subscription synchronously, before any `await` in
   * its own `apply`, because a composed row can publish while that `apply` is
   * still yielding. A publication that arrives before this gate exists cannot
   * be held — the fiber is already running — so the caller reports it instead
   * of dropping it silently.
   * @param published - the fiber, its owning entry, and that entry's tree.
   */
  onPublish(published: PublishedFiber): void
  /**
   * Consider one Loader entry before it has options or a fiber.
   *
   * The publication observer cannot cover a row whose fiber is created before
   * this plugin's `apply` has run: the composition builds its entries first and
   * imports each plugin only when it reaches it. This hook runs from the
   * `loader/entry-init` event, which the Loader emits while the entry is still
   * being constructed — early enough to make the row look disabled and keep the
   * whole mount from happening.
   * @param entry - the entry under construction.
   */
  onEntryInit(entry: GateEntry): void
  /** The gate's answer for one row, undefined when the row is not mounted. */
  stateFor(target: McpTarget, entryId: string): McpRowGateState | undefined
  /** Nonblocking revision-local allowance for on-demand inventory reads. */
  presetRows?(): readonly McpPresetRows[]
  /**
   * The composed global rows, read from the file-backed Include without waiting
   * for any activation. Enablement is the entry's own effective flag, which is
   * the declaration's answer: the gate never writes `disabled` into a global
   * row's options, so the flag cannot be the gate's own product the way it is
   * on a preset row.
   * @returns one row per global MCP entry the Include currently mounts.
   */
  globalRows?(): readonly McpGlobalRow[]
  /**
   * Hand one global row back to its own declaration so it can mount again.
   *
   * Only the in-memory hold is released — the entry's options are never
   * rewritten — so the file-backed Include keeps the user's own row intact.
   * @param entryId - the global entry to release, as the Loader names it.
   * @returns whether a hold was actually released.
   */
  releaseGlobalHold?(entryId: string): boolean
  /** Keys of the rows the gate currently suppresses, for the settings UI. */
  suppressedKeys(): readonly string[]
  /**
   * Entry ids the publication observer held back since the last successful
   * activation, whether or not a mount tree has been captured for them yet.
   * This is what keeps the roster from reporting a held row as stopped.
   */
  suppressedEntryIds(): readonly string[]
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
  /** The group holding this entry, when the entry is a composed row. */
  readonly parent?: { readonly tree?: unknown } | undefined
  /** Root fiber; disposed fibers do not count as mounted. */
  readonly fiber?: {
    readonly state: number
    readonly uid?: number | null
    readonly inertia?: Promise<void>
    dispose?(): unknown
  } | undefined
  /** Evaluate a declaration's !!js node in this row's Loader context. */
  evaluate?(expression: string): unknown
  update(options: Partial<EntryOptions>, create?: boolean, force?: boolean): Promise<void>
}

/**
 * One published fiber, reduced to the facts the publication observer needs: the
 * Loader entry that owns it and the tree that entry belongs to. Resolving the
 * tree belongs to the reader that knows the Loader's Entry structure, so the
 * gate never reaches into the entry itself.
 */
export interface PublishedFiber {
  readonly fiber: unknown
  /** The owning Loader entry, absent for a fiber started outside any tree. */
  readonly entry?: GateEntry
  /** The owning entry's parent tree, absent with the entry. */
  readonly tree?: unknown
}

/** The preset mount tree surface this gate drives. */
export interface GateTree {
  entries(): Iterable<GateEntry>
}

/**
 * One composed global row, read from the file-backed Include.
 *
 * Global rows live in the root Include's tree rather than a preset tree, and the
 * Loader mounts them from the user's own `cordis.yml`. The gate drives them the
 * same way it drives preset rows — by keeping the plugin from ever being
 * imported — but it never rewrites their options: the Include would serialize
 * whatever it did into that file on the next write.
 */
export interface McpGlobalRow {
  /** The Loader's own entry id, which is also what `mcp_load` accepts. */
  readonly entryId: string
  /** The row's effective enablement, inherited from any owning group. */
  readonly enabled: boolean
  /** Whether the gate currently keeps this row from mounting. */
  readonly held: boolean
  /** Whether the row's plugin is running right now. */
  readonly mounted: boolean
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

/**
 * The preset reader the gate drives, including the one answer the publication
 * observer needs: whether a Loader tree carries a preset this plugin governs.
 * The reader reaches that tree from a row's own entry before any reconcile has
 * captured it, so the answer cannot come from the gate's own bookkeeping.
 */
export interface GateMountReader {
  (within?: unknown): readonly GateMount[]
  ownsTree?(tree: unknown): boolean
  /**
   * Capture one tree as a preset this plugin governs. The gate calls this from
   * the row's first `update`, which is the only moment a preset mounted after
   * the plugin applied is both attached to its tree and known to be a row.
   * @param entry - the row whose tree should be captured.
   */
  observe?(entry: unknown): void
}

/** Subscribes to fiber publication; the returned disposer unsubscribes. */
export type FiberObserver = (onPublish: (published: PublishedFiber) => void) => () => void

/** The Loader's own entry key, matching `Entry.key` in `cordis-plugin-loader`. */
const ENTRY_KEY = Symbol.for('cordis.entry')

/** Row creation, teardown, and late dependency activation all invalidate snapshots. */
export const MCP_ROW_EVENTS: readonly string[] = [
  'tools/change', 'loader/entry-init', 'loader/partial-dispose', 'internal/status', 'agent-preset/selected',
]

/** The Loader surface the global-row reader needs beyond one entry. */
interface IncludeEntry extends GateEntry {
  readonly subtree?: { entries?(): Iterable<GateEntry> } | undefined
}

/**
 * Whether a Loader tree is the file-backed include that owns the global plane.
 *
 * The composition file is what separates the planes: an in-memory composed
 * preset tree has no `filename`, while the include names the file it persists
 * to and writes back to. `ctx` cannot be the marker — `EntryTree` declares one
 * on every tree, the include's included.
 * @param tree - candidate tree, usually reached through `entry.parent.tree`.
 * @returns true when this tree is the global composition file.
 */
export function isGlobalPlaneTree(tree: unknown): boolean {
  if (tree === undefined || tree === null) return false
  const candidate = tree as { readonly filename?: unknown; readonly write?: unknown }
  return typeof candidate.filename === 'string' && typeof candidate.write === 'function'
}

/** The module names a file-backed include is mounted under. */
const INCLUDE_MODULES: readonly string[] = ['cordis:include', '@deepseek-ai/cordis-plugin-include']

/**
 * Whether a tree belongs to the global plane, judged by whichever handle the
 * caller has. The include's own tree answers with its composition file; a row's
 * tree is reached before the include finished constructing, so the owning
 * entry's own name answers instead. Both are the same plane.
 * @param tree - candidate tree, usually reached through `entry.parent.tree`.
 * @returns true when this tree is the global composition file.
 */
export function ownsGlobalTree(tree: unknown): boolean {
  if (isGlobalPlaneTree(tree)) return true
  const owner = (tree as { readonly ctx?: { readonly fiber?: { readonly entry?: IncludeEntry } } } | undefined)
    ?.ctx?.fiber?.entry
  return owner !== undefined && INCLUDE_MODULES.includes(String(owner.options?.name))
}

/** One entry's descendants, including nested groups' rows. */
function* walkEntries(tree: { entries(): Iterable<GateEntry> }): Generator<GateEntry> {
  for (const entry of tree.entries()) {
    yield entry
    const nested = (entry as IncludeEntry).subtree
    if (nested?.entries !== undefined) yield* walkEntries(nested as { entries(): Iterable<GateEntry> })
  }
}

/** Every file-backed include the root Loader currently mounts. */
function* includeEntries(ctx: Context): Generator<{ entries(): Iterable<GateEntry> }> {
  const loader = ctx.get('loader') as { entries(): Iterable<IncludeEntry> } | undefined
  // A host context without a Loader composes no global rows; reading one there
  // is an empty answer rather than a failure, so the gate can be driven by hand.
  if (loader?.entries === undefined) return
  for (const entry of loader.entries()) {
    const tree = entry.subtree
    if (isGlobalPlaneTree(tree)) yield tree as { entries(): Iterable<GateEntry> }
  }
}

/**
 * Create the preload gate for one host plugin instance.
 * @param ctx - host context owning the loader and the agent-presets service.
 * @param readMode - reads the committed loading mode on every reconcile.
 * @param mountReader - synchronous reader of live preset revisions.
 * @param warn - diagnostics sink for rows the gate cannot drive.
 * @param observeFiber - subscribes to fiber publication, so a held row never
 *   reaches its plugin callback. Omitted by callers that drive the gate by hand.
 * @param onRowTaken - reports that this gate just took over one more row. The
 *   caller uses it to refresh what it derives from the row set: taking a row
 *   over is such a change, and it carries no event of its own, because a held
 *   row never activates and the composition's own mount emits nothing.
 * @returns the gate the tool registration consults.
 */
export function createMcpPreloadGate(
  ctx: Context,
  readMode: () => McpLoadingMode,
  mountReader: GateMountReader,
  warn: GateWarn,
  observeFiber?: FiberObserver,
  onRowTaken?: () => void,
): McpPreloadGate {
  /** Runtime answers, keyed as {@link mcpRowKey}. */
  const states = new Map<string, McpRowGateState>()
  /** Row ids the publication observer held back, whether or not a mount is captured. */
  const held = new Set<string>()
  let presetRows: McpPresetRows[] = []
  /** Serializes reconciles so an entry event cannot interleave with its own run. */
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  /**
   * The row's owning Loader entry, when this fiber is a composed row. A fiber
   * started by `ctx.plugin` outside any tree (an on-demand load, a managed
   * external mount) carries no entry and is never the gate's to hold back.
   */
  const entryOf = (parent: unknown): GateEntry | undefined => {
    const entry = (parent as Record<PropertyKey, unknown> | undefined)?.[ENTRY_KEY]
    return entry === null || entry === undefined ? undefined : entry as GateEntry
  }

  /**
   * Hold one row back at the only moment that can: before its plugin callback
   * runs. Disposal is synchronous, so Cordis skips the dependency resolution
   * that would have started the server; the row's own declaration keeps the
   * `disabled` flag so any later re-init of this entry returns without work.
   */
  const holdAtPublication = (published: PublishedFiber): void => {
    if (disposed || readMode() === 'eager') return
    const entry = published.entry ?? entryOf((published.fiber as { readonly parent?: unknown } | undefined)?.parent)
    // `entry.options` is still empty while the entry is being constructed, so
    // an unnamed entry is not yet a row this gate can identify.
    if (entry === undefined || entry.options.name !== MCP_CLIENT_MODULE) return
    if (entry.options.group === true) return
    if (entry.options.id === undefined) return
    // The reader resolves the row's tree from whichever handle this caller has:
    // the published pair when the composition published one, the owning entry's
    // parent group otherwise.
    const tree = (published.tree ?? entry.parent?.tree ?? entry.parent) as
      | { filename?: unknown; write?: unknown }
      | undefined
    if (mountReader.ownsTree?.(tree) !== true) return
    const entryId = presetLeafId(entry.options.id)
    held.add(entryId)
    heldRowIds.add(entryId)
    if (typeof tree?.filename === 'string' && typeof tree.write === 'function') {
      // The row's tree persists to a file — a nested Include under a preset is
      // still a preset tree to the ownership test — so the fiber must not
      // self-dispose first: the Loader's self-dispose branch writes `disabled`
      // back into the user's own file unless the entry already reads as
      // disabled. Hold it the late-hold way instead: shadow first, dispose
      // second (pitfall 42), declaration untouched, undo registered.
      const row = entry as unknown as { disabled?: boolean | undefined }
      const previousDisabled = Object.getOwnPropertyDescriptor(row, 'disabled')
      Object.defineProperty(row, 'disabled', { configurable: true, enumerable: false, value: true })
      preHeld.set(entryId, {
        entry,
        global: true,
        undo: () => {
          if (previousDisabled === undefined) delete row.disabled
          else Object.defineProperty(row, 'disabled', previousDisabled)
        },
      })
    }
    try {
      void (published.fiber as { dispose(): Promise<void> }).dispose()
    } catch (error) {
      warn(`mcp-manager: cannot hold MCP row "${entryId}": ${String(error)}`)
    }
    // Keep the declaration in step with the runtime hold, so a later update of
    // this entry returns before importing the plugin again. A shadowed row is
    // exempt: its options must stay exactly as the user wrote them.
    if (preHeld.has(entryId)) return
    if (entry.options.disabled !== true) {
      void Promise.resolve(entry.update({ disabled: true })).catch(error => {
        warn(`mcp-manager: cannot mark MCP row "${entryId}" as held: ${String(error)}`)
      })
    }
  }
  const unsubscribe = observeFiber?.(holdAtPublication)

  /**
   * Entries held before they could mount, keyed by the row id their options
   * turned out to name, with the override this gate installed on each.
   */
  const preHeld = new Map<string, { entry: GateEntry; undo(): void; global: boolean }>()
  /** Row ids the pre-mount hook holds back right now. */
  const heldRowIds = new Set<string>()

  /** Tagged entries, so the first `update` can be identified before the row is named. */
  const tagged = new WeakSet<GateEntry>()
  /** Tagged entries whose row id the Loader has not revealed yet. */
  const pendingPreHeld = new Map<GateEntry, () => void>()

  /**
   * Keep one composed row from mounting at all.
   *
   * A row that is created before this plugin's `apply` runs has no publication
   * to observe — the composition builds every entry, then imports each plugin.
   * This hook runs from `loader/entry-init`, which the Loader emits inside the
   * `Entry` constructor: before the options are assigned, before the parent
   * group is attached, before the fiber is created, and before the plugin that
   * starts the child process is imported.
   *
   * Because neither the options nor the tree exist yet, the entry is only
   * tagged here; {@link namePreHeld} decides, once the Loader assigns the
   * options, whether it is one of our rows. The tag makes the row read as
   * disabled by shadowing `Entry.disabled` on this one instance. The
   * declaration keeps the user's own answer, so the Loader's `update` returns
   * before `init`, and switching back to `eager` restores the row.
   * @param entry - the entry under construction.
   */
  const holdBeforeMount = (entry: GateEntry): void => {
    if (disposed || readMode() === 'eager' || tagged.has(entry)) return
    const row = entry as unknown as {
      disabled?: boolean | undefined
      update?: (...args: unknown[]) => Promise<void>
    }
    const previousDisabled = Object.getOwnPropertyDescriptor(row, 'disabled')
    const previousUpdate = row.update
    if (previousUpdate === undefined) return
    tagged.add(entry)
    // The Loader assigns the options by calling `update`, which is also the last
    // moment before it would import the plugin. Intercepting that one call is
    // how this gate sees a row it was never able to observe.
    row.update = function (this: unknown, ...args: unknown[]): Promise<void> {
      namePreHeld(entry, args[0] as Partial<EntryOptions> | undefined)
      return previousUpdate.apply(this, args)
    } as (...args: unknown[]) => Promise<void>
    Object.defineProperty(row, 'disabled', { configurable: true, enumerable: false, value: true })
    pendingPreHeld.set(entry, () => {
      row.update = previousUpdate
      if (previousDisabled === undefined) delete row.disabled
      else Object.defineProperty(row, 'disabled', previousDisabled)
      tagged.delete(entry)
    })
  }

  /**
   * Hand one row's pre-held entries back to their declarations. Called both
   * when the row leaves this gate's care (an `eager` commit) and on dispose, so
   * the override can never outlive the hold it expressed.
   * @param entryId - the row whose holds should be released.
   * @returns whether anything was released.
   */
  const releasePreHeldRow = (entryId: string): boolean => {
    heldRowIds.delete(entryId)
    const held = preHeld.get(entryId)
    if (held === undefined) return false
    preHeld.delete(entryId)
    held.undo()
    return true
  }

  /**
   * Hand one global row back, then let the Loader mount it.
   *
   * Dropping the hold alone is not enough: the row's entry never finished its
   * first `update`, so nothing will try to mount it until the include reloads.
   * `Entry.update` is the call that does it, and it persists nothing — only
   * `EntryTree.create`/`update`/`remove` and a fiber's self-dispose write the
   * include file.
   * @param entryId - the global entry to release.
   * @returns whether a global hold was released.
   */
  const releaseGlobalHold = (entryId: string): boolean => {
    const held = preHeld.get(entryId)
    if (held?.global !== true) return false
    const { entry } = held
    releasePreHeldRow(entryId)
    void entry.update({ disabled: false }, false, true).catch((error: unknown) => {
      warn(`mcp-manager: cannot mount the global MCP row "${entryId}": ${String(error)}`)
    })
    return true
  }

  /** Hand every pre-held row back to its own declaration. */
  const releasePreHeld = (): void => {
    for (const entryId of [...preHeld.keys()]) releasePreHeldRow(entryId)
    for (const undo of [...pendingPreHeld.values()]) undo()
    pendingPreHeld.clear()
    heldRowIds.clear()
  }

  /**
   * Decide whether a tagged entry really is one of this gate's rows, and name
   * it. Ownership is checked here rather than at the tag because the entry has
   * no options and no parent group while it is being constructed: only once the
   * Loader assigns them can this tell a preset row from a global one.
   *
   * The options are read from the intercepted call's own argument, not from the
   * entry: the Loader assigns `entry.options` inside `update`, so at this point
   * the entry still holds the previous (empty) set, and reading it would leave
   * the hold in place for every row the composition creates after this plugin
   * activated. Loading that hold is what would keep such a row from ever
   * mounting, not just an MCP one.
   * @param entry - the entry whose options are about to be assigned.
   * @param passed - the options this `update` call carries.
   */
  const namePreHeld = (entry: GateEntry, passed?: Partial<EntryOptions>): void => {
    const undo = pendingPreHeld.get(entry)
    if (undo === undefined) return
    const options = (passed ?? entry.options) as { readonly name?: string; readonly id?: string } | undefined
    if (options?.name === undefined || options.id === undefined) return
    if (options.name !== MCP_CLIENT_MODULE) {
      // Not an MCP row: hand it straight back to its own declaration.
      pendingPreHeld.delete(entry)
      undo()
      return
    }
    const tree = entry.parent?.tree
    const global = ownsGlobalTree(tree)
    // A preset row is held only for a tree this plugin governs; a global row is
    // held for the include that owns the user's own composition file.
    if (!global && mountReader.ownsTree?.(tree) !== true) {
      pendingPreHeld.delete(entry)
      undo()
      return
    }
    pendingPreHeld.delete(entry)
    const entryId = presetLeafId(options.id)
    preHeld.set(entryId, { entry, undo, global })
    heldRowIds.add(entryId)
    onRowTaken?.()
  }

  /**
   * Keep the composed global rows out of every composition that is not `eager`.
   *
   * A global row reaches the Loader's `update` before its plugin is imported, so
   * the in-memory hold that covers a preset row covers this one too. The gate
   * never writes these rows' options: their tree is the file-backed include, and
   * rewriting a row here would let a later include write serialize the gate's
   * state into the user's own composition file.
   * @returns the global rows the include currently mounts.
   */
  const readGlobalRows = (): McpGlobalRow[] => {
    const rows: McpGlobalRow[] = []
    const seen = new Set<string>()
    /** Rows sit either inside a file-backed include or directly in the root tree. */
    const trees: { entries(): Iterable<GateEntry> }[] = []
    const loader = ctx.get('loader') as { entries(): Iterable<IncludeEntry> } | undefined
    for (const entry of loader?.entries() ?? []) {
      if (isGlobalPlaneTree(entry.subtree)) trees.push(entry.subtree as { entries(): Iterable<GateEntry> })
      // A patch layer can insert a row at the composition's own level, naming no
      // composition file; it is still a global row this gate governs.
      else if ((entry.options as { readonly group?: boolean } | undefined)?.group !== true) continue
      else if (entry.subtree !== undefined) trees.push(entry.subtree as { entries(): Iterable<GateEntry> })
    }
    for (const tree of trees) {
      for (const entry of walkEntries(tree)) {
        const options = entry.options as { readonly name?: string; readonly id?: string } | undefined
        if (options?.name !== MCP_CLIENT_MODULE || options.id === undefined) continue
        const entryId = presetLeafId(options.id)
        // The same row answers through its include-qualified id and its leaf id;
        // report it once.
        if (seen.has(entryId)) continue
        seen.add(entryId)
        rows.push({
          entryId,
          // The declaration's own answer, never the instance getter: this gate
          // shadows `disabled` on the rows it holds, so reading it back would
          // report its own hold as a user disabling the row.
          enabled: entry.options.disabled !== true,
          held: preHeld.get(entryId)?.global === true,
          mounted: (entry.fiber?.uid ?? null) !== null && entry.fiber?.state !== 4,
        })
      }
    }
    return rows
  }

  /**
   * Hold a global row that already mounted before this plugin existed.
   *
   * A row the composition builds inside its own Include — a patch-layer insert,
   * or the host's root composition — is created and imported while this plugin
   * is still being imported, so no entry-init subscription and no publication
   * can reach it. The row is therefore halted after the fact: the instance
   * shadow is installed **before** the fiber is disposed, because the Loader's
   * self-dispose branch persists `disabled` into the composition file unless the
   * entry already reads as disabled.
   * @param entry - the mounted global row to hold.
   * @returns whether the row was taken over.
   */
  const holdMountedGlobal = (entry: GateEntry): boolean => {
    const entryId = presetLeafId(String(entry.options.id))
    if (preHeld.has(entryId)) return false
    const fiber = entry.fiber
    if (fiber === undefined || fiber.uid === null || fiber.dispose === undefined) return false
    const row = entry as unknown as { disabled?: boolean | undefined }
    const previousDisabled = Object.getOwnPropertyDescriptor(row, 'disabled')
    Object.defineProperty(row, 'disabled', { configurable: true, enumerable: false, value: true })
    preHeld.set(entryId, {
      entry,
      global: true,
      undo: () => {
        if (previousDisabled === undefined) delete row.disabled
        else Object.defineProperty(row, 'disabled', previousDisabled)
      },
    })
    heldRowIds.add(entryId)
    try {
      void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
        warn(`mcp-manager: cannot hold the global MCP row "${entryId}": ${String(error)}`)
      })
    } catch (error) {
      warn(`mcp-manager: cannot hold the global MCP row "${entryId}": ${String(error)}`)
    }
    return true
  }

  /**
   * One global row's live entry, found by the id the reader reports.
   * @param entryId - the row's leaf id.
   * @returns the entry, or undefined when the composition no longer carries it.
   */
  const globalEntry = (entryId: string): GateEntry | undefined => {
    const loader = ctx.get('loader') as { entries(): Iterable<IncludeEntry> } | undefined
    for (const entry of loader?.entries() ?? []) {
      const tree = entry.subtree
      if (tree === undefined) continue
      for (const candidate of walkEntries(tree as { entries(): Iterable<GateEntry> })) {
        const options = candidate.options as { readonly name?: string; readonly id?: string } | undefined
        if (options?.name === MCP_CLIENT_MODULE && options.id !== undefined && presetLeafId(options.id) === entryId) {
          return candidate
        }
      }
    }
    return undefined
  }

  const run = async (): Promise<void> => {
    if (disposed) return
    const mode = readMode()
    const mounts = mountReader(ctx.root.fiber)
    const seen = new Set<string>()
    const published = new Set<string>()
    const globals = new Set<string>()
    /** Rows this pass brought back to their composed state. */
    const resumed = new Set<string>()
    /** Rows this pass proved still exist, whether or not they could be driven. */
    const liveRows = new Set<string>()
    const nextRows: McpPresetRows[] = []
    // The composed global rows are driven on the same rule as a preset row, but
    // through the include's own entries: their options are never rewritten, so
    // the only power the gate has over them is the in-memory hold.
    for (const row of readGlobalRows()) {
      const target: McpTarget = { scope: 'global' }
      const key = mcpRowKey(target, row.entryId)
      globals.add(key)
      seen.add(key)
      liveRows.add(row.entryId)
      // A row the user disabled is not suppressed: `suppressed` means "the
      // loading mode holds back a row the user allows". Skipping the row without
      // recording that answer left the previous pass's flag in `states`, so the
      // settings page kept reading a row the user had just turned off as
      // suppressed — and its switch, which trusts that flag as a fallback,
      // stayed on. The hold bookkeeping is a separate question: the row stays
      // held unmounted, which the roster reports as `held`.
      if (!row.enabled) {
        if (!published.has(key)) states.set(key, { allowed: false, suppressed: false })
        continue
      }
      const wantMounted = mode === 'eager'
      if (wantMounted) {
        held.delete(row.entryId)
        resumed.add(row.entryId)
        releaseGlobalHold(row.entryId)
      } else if (row.held) {
        held.add(row.entryId)
      } else if (row.mounted) {
        // A row the composition built and imported before this plugin applied:
        // no hook could have reached it, so it is halted here and stays held.
        const entry = globalEntry(row.entryId)
        if (entry !== undefined && holdMountedGlobal(entry)) held.add(row.entryId)
      }
      if (!published.has(key)) states.set(key, { allowed: true, suppressed: !wantMounted })
    }
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
        liveRows.add(leaf)
        const declaredRow = declaredMcpRows(rows, MCP_CLIENT_MODULE, entry.evaluate?.bind(entry))
          .find(row => presetLeafId(row.options.id) === leaf)
        // A row the declaration does not carry (a patch insert, or a preset
        // whose declaration moved under us) keeps its composed state and is
        // never driven.
        if (declaredRow === undefined) continue
        // A row the user enabled is still not runnable while its connection
        // configuration is incomplete (blank command/url, unresolved
        // `${env:NAME}`): starting it would only fail, so it is held exactly
        // like a row the loading mode does not preload. The settings page reads
        // the same diagnostics and marks it "not configured".
        const allowed = declaredRow.enabled === true && diagnoseRowConfig(declaredRow.options.config).length === 0
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
        // The publication observer holds a row before its plugin runs, and the
        // hold keeps the declaration's `disabled` flag in step. Reaching this
        // row's composed state is therefore what clears that memory, not the
        // fiber's own phase: a held fiber is already disposed.
        if (wantMounted) {
          held.delete(leaf)
          resumed.add(leaf)
          // A row the pre-mount hook held has to be handed back before the
          // Loader can mount it: the override is what makes it read as
          // disabled, so `update` below would return without doing anything.
          releasePreHeldRow(leaf)
        } else {
          heldRowIds.add(leaf)
        }
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
    // A held row that no longer appears in any live preset was removed from the
    // composition; it must not keep the roster reporting a hold forever.
    for (const entryId of [...held]) if (!resumed.has(entryId) && !liveRows.has(entryId)) held.delete(entryId)
  }

  const reconcile = (): Promise<void> => {
    queue = queue.then(run, run)
    return queue
  }

  return {
    reconcile,
    onPublish: holdAtPublication,
    onEntryInit: (entry) => { namePreHeld(entry); holdBeforeMount(entry) },
    globalRows: readGlobalRows,
    releaseGlobalHold,
    stateFor: (target, entryId) => states.get(mcpRowKey(target, presetLeafId(entryId))),
    presetRows: () => presetRows,
    suppressedKeys: () => [...states.entries()].filter(([, state]) => state.suppressed).map(([key]) => key),
    suppressedEntryIds: () => [...heldRowIds],
    dispose: () => {
      disposed = true
      unsubscribe?.()
      releasePreHeld()
      states.clear()
      held.clear()
      presetRows = []
    },
  }
}
