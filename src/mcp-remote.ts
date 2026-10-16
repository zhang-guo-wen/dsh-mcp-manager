/** Typert Remote owner for global and agent-preset MCP row authoring. */

import { access, constants } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  entryIds,
  findEntryRows,
  isIncludeRow,
  isRootAnchorInclude,
  MCP_CLIENT_MODULE,
  presetLeafId,
  writeEntryListFile,
  writableGlobalIncludes,
} from './mcp-authoring.ts'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { findPresetDeclaration, writePresetRows, type PresetDeclaration } from './preset-source.ts'
import { assertServerName, mcpEntryConfig, specFromEntryConfig, type McpEntryConfig } from './mcp-config.ts'
import { describeMcpConfigIssues, diagnoseRowConfig } from './mcp-diagnostics.ts'
import { scanClaudeMcp } from './claude-import.ts'
import { connectLazy } from './lazy-mcp.ts'
import { readMcpRoster } from './mcp-roster.ts'
import type {
  AddMcpRequest,
  AddMcpsRequest,
  AddMcpsResult,
  ClearMcpCatalogRequest,
  ClearMcpCatalogResult,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  ListMcpsRequest,
  ListMcpsResult,
  McpCatalogStateRequest,
  McpCatalogStateResult,
  McpGateStateRequest,
  McpGateStateResult,
  McpMutationResult,
  McpSpec,
  McpTarget,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
} from './types.ts'
import { McpCatalog } from './mcp-catalog.ts'
import type { LazyTool } from './mcp-carrier.ts'
import type { GateMount, McpPreloadGate } from './mcp-gate.ts'
import type { ExternalMcpDefinition, ExternalMcpRegistry } from './external-mcp.ts'

/** How long one editor tool listing may take before the dialog reports failure. */
const TOOL_LIST_TIMEOUT_MS = 30_000

/**
 * Resolve `work`, or reject once it outlives `ms`.
 * @param work - the operation to bound.
 * @param ms - budget in milliseconds.
 * @returns the operation's value when it settles inside the budget.
 * @throws when the budget expires before the operation settles.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`no answer within ${ms} ms`)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Minimal optional surface read from the agent-preset registry. */
interface AgentPresetResolver {
  resolve(id: string): Promise<{ readonly broken?: string }>
}

/** The file-backed Include fields needed to guard global persistence. */
interface IncludeTree extends EntryTree {
  readonly filename?: string
  readonly config?: { readonly patches?: readonly unknown[] }
  /**
   * Re-read the file and re-apply the composed patch layers, which is how a
   * global write becomes live without Loader write-back.
   */
  refresh(): Promise<void>
}

/** One batch row that passed validation, with the request position it answers. */
interface PlannedRow {
  readonly index: number
  readonly serverName: string
  readonly entryId: string
  readonly config: McpEntryConfig
}

type WritableIncludeTree = IncludeTree & { readonly filename: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `mcpManager` Remote namespace. */
    mcpManager: McpManager
  }
}

/**
 * Host service behind the `mcpManager` Remote namespace. Preset mutations
 * update the resolved user's composition file; global mutations use the one
 * unpatched root Include so Loader lifecycle and file state remain aligned.
 */
export class McpManager extends TypertRemoteService {
  static inject = ['loader']

  private mutationQueue: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - host context.
   * @param gate - the preload gate the mutations must leave in line with the
   *   current loading mode.
   * @param mountReader - reader of the live agent-preset mounts, used by the
   *   roster read to report each preset row's current fiber phase.
   * @param external - the registry of resource-plugin rows.
   * @param loadingMode - live reader of the committed loading mode.
   * @param catalog - the discovery catalogue the settings page can inspect and clear.
   */
  constructor(
    ctx: Context,
    private readonly gate: McpPreloadGate,
    private readonly mountReader: (within?: unknown) => readonly GateMount[],
    private readonly external: ExternalMcpRegistry,
    private readonly loadingMode: () => 'eager' | 'dynamic' | 'lazy',
    private readonly catalog: McpCatalog<LazyTool> = new McpCatalog<LazyTool>(),
  ) {
    super(ctx, 'mcpManager')
  }

  /** Register MCP definitions supplied by a resource plugin without writing user configuration. */
  async replaceExternalMcps(owner: string, ownerCtx: Context, rows: readonly ExternalMcpDefinition[]): Promise<void> {
    await this.external.replace(owner, ownerCtx, rows)
  }

  async removeExternalMcps(owner: string): Promise<void> {
    await this.external.remove(owner)
  }

  managedMcpMode(): 'eager' | 'dynamic' | 'lazy' {
    return this.loadingMode()
  }

  /**
   * Report every MCP row the running composition declares, with the planes a
   * mutation can target.
   *
   * The read answers from declarations and live fibers only, so the settings
   * page renders immediately while an MCP server is still starting; nothing here
   * waits for a row's activation.
   * @param request - empty placeholder; the roster is host-wide.
   * @returns the global rows, every declared preset with its rows, and whether
   *   the global plane accepts writes.
   */
  @Remote('listMcps')
  async listMcps(request: ListMcpsRequest): Promise<ListMcpsResult> {
    void request
    return readMcpRoster(this.ctx, this.mountReader, this.gate.suppressedEntryIds(), this.gate.globalRows?.() ?? [])
  }

  /**
   * Add one MCP client row to a global or user preset composition.
   * @param request - target, row identity, server namespace, and transport spec.
   * @returns the redacted row identity after the file-backed mutation commits.
   * @throws a typed MCP error when the target is unavailable, read-only,
   * malformed, duplicated, or not an MCP composition row.
   */
  @Remote('addMcp')
  async addMcp(request: AddMcpRequest): Promise<McpMutationResult> {
    const result = await this.enqueue(() => this.add(request))
    this.catalog.clear()
    await this.gate.reconcile()
    return result
  }

  /**
   * Add several MCP client rows to one composition in a single write.
   *
   * Every appended row is validated on its own, so one rejected row does not
   * cost the rest of the batch, but the accepted rows commit together: an agent
   * preset re-mounts once per write and starting its MCP servers again is what
   * makes a row-per-call import slow.
   * @param request - target composition and the rows to append.
   * @returns one outcome per requested row, in request order.
   */
  @Remote('addMcps')
  async addMcps(request: AddMcpsRequest): Promise<AddMcpsResult> {
    const result = await this.enqueue(() => this.addMany(request))
    this.catalog.clear()
    await this.gate.reconcile()
    return result
  }

  /**
   * Replace one MCP client row's connection configuration.
   * @param request - target row, new server namespace, and transport spec.
   * @returns the redacted row identity after the mutation commits.
   * @throws a typed MCP error when the target is unavailable, read-only,
   * malformed, duplicated, or not an MCP composition row.
   */
  @Remote('editMcp')
  async editMcp(request: EditMcpRequest): Promise<McpMutationResult> {
    const result = await this.enqueue(() => this.edit(request))
    this.catalog.clear()
    await this.gate.reconcile()
    return result
  }

  /**
   * Enable or disable one MCP client row.
   * @param request - target row and the requested disabled state.
   * @returns the redacted row identity after the mutation commits.
   * @throws a typed MCP error when the target is unavailable, read-only,
   * malformed, or not an MCP composition row.
   */
  @Remote('disableMcp')
  async disableMcp(request: DisableMcpRequest): Promise<McpMutationResult> {
    const result = await this.enqueue(() => this.disable(request))
    this.catalog.clear()
    await this.gate.reconcile()
    return result
  }

  /**
   * Report which allowed rows the preload gate currently holds unmounted.
   * @param request - empty placeholder; the gate state is host-wide. The
   *   parameter must keep this name: the gateway derives its descriptor from the
   *   method signature and rejects a payload whose field does not match.
   * @returns the suppressed row keys in the settings page's own key format.
   */
  @Remote('gateState')
  async gateState(request: McpGateStateRequest): Promise<McpGateStateResult> {
    void request
    await this.gate.reconcile()
    return { suppressed: [...this.gate.suppressedKeys()] }
  }

  /**
   * Report what the discovery catalogue remembers.
   *
   * The catalogue is what lets `mcp_search` answer without starting a server, so
   * the settings page shows exactly how much is in it and how old it is; the
   * read touches no MCP row, so it is safe to call on every section render.
   * @param request - empty placeholder; the catalogue is host-wide.
   * @returns one row per remembered server, oldest first.
   */
  @Remote('catalogState')
  async catalogState(request: McpCatalogStateRequest): Promise<McpCatalogStateResult> {
    void request
    return { entries: this.catalog.stats(), total: this.catalog.size }
  }

  /**
   * Forget every recorded discovery result.
   *
   * A running session keeps the tools it loaded — the catalogue only feeds
   * search and the settings page — so clearing is safe at any time and costs at
   * most one re-listing per server on the next search.
   * @param request - empty placeholder; the catalogue is host-wide.
   * @returns how many server records were dropped.
   */
  @Remote('clearCatalog')
  async clearCatalog(request: ClearMcpCatalogRequest): Promise<ClearMcpCatalogResult> {
    void request
    return { cleared: this.catalog.clear() }
  }

  /**
   * Read one MCP client row's current connection spec.
   * @param request - target row identity.
   * @returns the row's identity and connection spec for the editor to prefill.
   * @throws a typed MCP error when the target is unavailable, read-only,
   * malformed, or not an MCP composition row.
   */
  @Remote('describeMcp')
  async describeMcp(request: DescribeMcpRequest): Promise<DescribeMcpResult> {
    const target = validateTarget(request.target)
    validateEntryId(request.entryId, target, false)
    if (target.scope === 'global') {
      // Reading a global row is a lookup, not an edit: it must not require the
      // single file-backed Include that authoring does. A composition can mount
      // a user-owned Include beside the host's own root, and a patch layer can
      // insert a global row with no composition file at all.
      const entry = this.liveGlobalEntry(request.entryId, target)
      const serverName = serverNameOf(entry.options)
      if (serverName === undefined) {
        throw invalid(target, 'the MCP row has no valid serverName')
      }
      return {
        target,
        entryId: presetLeafId(entry.options.id),
        serverName,
        spec: specFromEntryConfig(entry.options.config as McpEntryConfig),
        disabled: entry.options.disabled === true,
      }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    const rows = preset.rows
    const row = this.presetMcpRow(rows, entryId, target)
    const serverName = serverNameOf(row) ?? entryId
    if (row.config === undefined || typeof row.config !== 'object' || row.config === null) {
      throw invalid(target, `preset row "${entryId}" has no connection config`)
    }
    return {
      target,
      entryId,
      serverName,
      spec: specFromEntryConfig(row.config as McpEntryConfig),
      disabled: row.disabled === true,
    }
  }

  /**
   * Connect once with a connection spec and report the tools it publishes, so
   * the editor can offer an enable/disable list. The connection is closed before
   * this resolves; nothing is registered and no row is touched.
   * @param request - transport spec (the editor's current form value) and the
   *   namespace used in diagnostics.
   * @returns the server's own tool names and descriptions, in its own order.
   * @throws a typed MCP error when the spec is malformed or the server does not
   *   answer a listing inside the budget.
   */
  @Remote('listMcpTools')
  async listMcpTools(request: ListMcpToolsRequest): Promise<ListMcpToolsResult> {
    let config: McpEntryConfig
    try {
      config = mcpEntryConfig(request.spec, assertServerName(request.serverName))
    } catch (cause) {
      const reason = String(cause)
      throw new RemoteError('mcp/invalid', reason, { reason }, { cause })
    }
    let connection: Awaited<ReturnType<typeof connectLazy>>
    try {
      connection = await withTimeout(connectLazy(config), TOOL_LIST_TIMEOUT_MS)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new RemoteError(
        'mcp/unavailable',
        `MCP server "${request.serverName}" did not answer a tool listing`,
        { reason },
        { cause },
      )
    }
    try {
      return {
        tools: connection.tools.map(tool => ({ name: tool.name, description: tool.description ?? '' })),
      }
    } finally {
      // The listing owns this connection for its whole lifetime; a close
      // failure must not replace the tools it already read.
      await connection.client.close().catch(() => {})
    }
  }

  /**
   * Report the MCP servers the Claude Code configuration files declare, so the
   * settings page can offer them for import. Reads only: nothing is mounted and
   * no composition is touched, so a scan is safe to run on every dialog open.
   * @param request - working directory whose project scope should be read.
   * @returns every readable source and the servers it declares, including the
   *   ones that cannot be imported and why.
   */
  @Remote('scanClaudeMcp')
  async scanClaudeMcp(request: ScanClaudeMcpRequest): Promise<ScanClaudeMcpResult> {
    // The scan is a plain read of user-owned files, so it answers even when the
    // gate or the Loader is mid-reconcile; only the import behind it mutates.
    return await scanClaudeMcp(request.cwd ?? process.cwd())
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation, operation)
    this.mutationQueue = run.then(() => undefined, () => undefined)
    return run
  }

  private async add(request: AddMcpRequest): Promise<McpMutationResult> {
    const target = validateTarget(request.target)
    const config = configFromSpec(request.spec, request.serverName, target)
    const entryId = request.entryId ?? request.serverName
    validateEntryId(entryId, target, true)
    if (target.scope === 'global') {
      const include = await this.globalInclude(target)
      const rows = [...include.tree.entries()]
      if (rows.some(entry => entry.options.id === entryId)) {
        throw conflict(target, entryId, undefined, 'the row id is already in use')
      }
      if (rows.some(entry => entry.options.name === MCP_CLIENT_MODULE
        && serverNameOf(entry.options) === request.serverName)) {
        throw conflict(target, entryId, request.serverName, 'the serverName is already in use')
      }
      const created = await this.writeGlobalOne(include, target, {
        insert: [{ id: entryId, name: MCP_CLIENT_MODULE, config }],
      }, (fileRows) => {
        if (entryIds(fileRows).has(entryId)) {
          throw conflict(target, entryId, undefined, 'the row id is already in use')
        }
        if (fileRows.some(row => row.name === MCP_CLIENT_MODULE && serverNameOf(row) === request.serverName)) {
          throw conflict(target, entryId, request.serverName, 'the serverName is already in use')
        }
      }, entryId)
      return { target, entryId: created.id, serverName: request.serverName, disabled: this.declaredDisabled(created) }
    }

    const preset = await this.resolvePreset(target)
    const patch = { insert: [{ id: entryId, name: MCP_CLIENT_MODULE, config }] }
    await writePresetRows(this.ctx, preset, patch, (rows) => {
      if (entryIds(rows).has(entryId)) {
        throw conflict(target, entryId, undefined, 'the row id is already in use')
      }
      if (rows.some(row => row.name === MCP_CLIENT_MODULE && serverNameOf(row) === request.serverName)) {
        throw conflict(target, entryId, request.serverName, 'the serverName is already in use')
      }
    }, this.warnPatch)
    return { target, entryId, serverName: request.serverName, disabled: false }
  }

  /**
   * Plan and commit a batch add. Each row is validated on its own so one bad row
   * does not cost the rest; the accepted rows then commit in one write, which
   * matters most for a preset: it re-mounts once per write, and every MCP server
   * it declares starts again on each mount.
   * @param request - target composition and the requested rows.
   * @returns one outcome per requested row, in request order.
   */
  private async addMany(request: AddMcpsRequest): Promise<AddMcpsResult> {
    const target = validateTarget(request.target)
    const reasons = new Map<number, string>()
    const planned: PlannedRow[] = []
    const takenIds = new Set<string>()
    const takenNames = new Set<string>()
    request.rows.forEach((row, index) => {
      try {
        const entryId = row.entryId ?? row.serverName
        validateEntryId(entryId, target, true)
        const config = configFromSpec(row.spec, row.serverName, target)
        // Two rows of one batch may not claim the same identity either.
        if (takenIds.has(entryId)) throw conflict(target, entryId, undefined, 'the row id is already in use')
        if (takenNames.has(row.serverName)) {
          throw conflict(target, entryId, row.serverName, 'the serverName is already in use')
        }
        takenIds.add(entryId)
        takenNames.add(row.serverName)
        planned.push({ index, serverName: row.serverName, entryId, config })
      } catch (cause) {
        reasons.set(index, cause instanceof Error ? cause.message : String(cause))
      }
    })
    if (planned.length > 0) {
      const refused = target.scope === 'global'
        ? await this.writeGlobalBatch(target, planned)
        : await this.writePresetBatch(target, planned)
      for (const [index, reason] of refused) reasons.set(index, reason)
    }
    const entryOf = new Map(planned.map(row => [row.index, row.entryId]))
    return {
      target,
      outcomes: request.rows.map((row, index) => {
        const reason = reasons.get(index)
        return reason === undefined
          ? { serverName: row.serverName, entryId: entryOf.get(index) ?? null }
          : { serverName: row.serverName, entryId: null, reason }
      }),
    }
  }

  /**
   * Commit a global batch: one file patch, one Include reload, then a liveness
   * check per accepted row.
   * @param target - the global plane.
   * @param planned - validated rows, in request order.
   * @returns per-row refusal reasons keyed by request position.
   */
  private async writeGlobalBatch(
    target: Extract<McpTarget, { scope: 'global' }>,
    planned: readonly PlannedRow[],
  ): Promise<Map<number, string>> {
    const refused = new Map<number, string>()
    const include = await this.globalInclude(target)
    const live = [...include.tree.entries()]
    for (const row of planned) {
      if (live.some(entry => entry.options.id === row.entryId)) {
        refused.set(row.index, conflict(target, row.entryId, undefined, 'the row id is already in use').message)
      } else if (live.some(entry => entry.options.name === MCP_CLIENT_MODULE
        && serverNameOf(entry.options) === row.serverName)) {
        refused.set(row.index, conflict(target, row.entryId, row.serverName, 'the serverName is already in use').message)
      }
    }
    const accepted = planned.filter(row => !refused.has(row.index))
    if (accepted.length === 0) return refused
    try {
      await this.writeGlobalRow(include, target, {
        insert: accepted.map(row => ({ id: row.entryId, name: MCP_CLIENT_MODULE, config: row.config })),
      }, (fileRows) => {
        const ids = entryIds(fileRows)
        for (const row of accepted) {
          if (ids.has(row.entryId)) {
            throw conflict(target, row.entryId, undefined, 'the row id is already in use')
          }
          if (fileRows.some(file => file.name === MCP_CLIENT_MODULE && serverNameOf(file) === row.serverName)) {
            throw conflict(target, row.entryId, row.serverName, 'the serverName is already in use')
          }
        }
      }, accepted.map(row => row.entryId))
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      for (const row of accepted) refused.set(row.index, reason)
    }
    return refused
  }

  /**
   * Commit a preset batch as one patch, so the preset reconciles once.
   * @param target - the addressed preset.
   * @param planned - validated rows, in request order.
   * @returns per-row refusal reasons keyed by request position.
   */
  private async writePresetBatch(
    target: Extract<McpTarget, { scope: 'preset' }>,
    planned: readonly PlannedRow[],
  ): Promise<Map<number, string>> {
    const refused = new Map<number, string>()
    const preset = await this.resolvePreset(target)
    const declared = entryIds(preset.rows)
    for (const row of planned) {
      if (declared.has(row.entryId)) {
        refused.set(row.index, conflict(target, row.entryId, undefined, 'the row id is already in use').message)
      } else if (preset.rows.some(entry => entry.name === MCP_CLIENT_MODULE
        && serverNameOf(entry) === row.serverName)) {
        refused.set(row.index, conflict(target, row.entryId, row.serverName, 'the serverName is already in use').message)
      }
    }
    const accepted = planned.filter(row => !refused.has(row.index))
    if (accepted.length === 0) return refused
    try {
      await writePresetRows(this.ctx, preset, {
        insert: accepted.map(row => ({ id: row.entryId, name: MCP_CLIENT_MODULE, config: row.config })),
      }, (rows) => {
        const ids = entryIds(rows)
        for (const row of accepted) {
          if (ids.has(row.entryId)) {
            throw conflict(target, row.entryId, undefined, 'the row id is already in use')
          }
          if (rows.some(entry => entry.name === MCP_CLIENT_MODULE && serverNameOf(entry) === row.serverName)) {
            throw conflict(target, row.entryId, row.serverName, 'the serverName is already in use')
          }
        }
      }, this.warnPatch)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      for (const row of accepted) refused.set(row.index, reason)
    }
    return refused
  }

  /**
   * Whether one global row's declaration disables it.
   *
   * The live instance property is the preload gate's own shadow, so it answers
   * "is the gate holding this row" rather than "did the user disable it". Every
   * answer this service reports about a global row comes from the declaration.
   * @param entry - the live global row.
   * @returns whether the row's own declaration disables it.
   */
  private declaredDisabled(entry: Entry): boolean {
    return entry.options.disabled === true
  }

  private async edit(request: EditMcpRequest): Promise<McpMutationResult> {
    const target = validateTarget(request.target)
    const config = configFromSpec(request.spec, request.serverName, target)
    validateEntryId(request.entryId, target, false)
    if (target.scope === 'global') {
      const include = await this.globalInclude(target)
      // Look the row up where the composition put it, not only inside the
      // addressable file: a patch-declared row is live and listed, and the
      // preflight below is what refuses it with the plane-accurate reason.
      const entry = this.liveGlobalEntry(request.entryId, target)
      this.assertServerNameAvailable(
        [...include.tree.entries()], request.entryId, request.serverName, target,
      )
      const rowId = entry.options.id
      const written = await this.writeGlobalOne(include, target, {
        id: rowId, name: MCP_CLIENT_MODULE, config,
      }, (fileRows) => {
        this.globalFileRow(fileRows, rowId, target, include.tree.filename)
        this.assertServerNameAvailable(fileRows, rowId, request.serverName, target)
      }, rowId)
      return { target, entryId: written.id, serverName: request.serverName, disabled: this.declaredDisabled(written) }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    let disabled = false
    const patch = { id: entryId, name: MCP_CLIENT_MODULE, config }
    await writePresetRows(this.ctx, preset, patch, (rows) => {
      const row = this.presetMcpRow(rows, entryId, target)
      disabled = row.disabled === true
      this.assertServerNameAvailable(rows, entryId, request.serverName, target)
    }, this.warnPatch)
    return { target, entryId, serverName: request.serverName, disabled }
  }

  private async disable(request: DisableMcpRequest): Promise<McpMutationResult> {
    const target = validateTarget(request.target)
    validateEntryId(request.entryId, target, false)
    if (target.scope === 'global') {
      const include = await this.globalInclude(target)
      const entry = this.liveGlobalEntry(request.entryId, target)
      const serverName = serverNameOf(entry.options)
      if (serverName === undefined) {
        throw invalid(target, 'the MCP row has no valid serverName')
      }
      const rowId = entry.options.id
      if (!request.disabled) assertRunnableConfig(target, entry.options.config)
      const written = await this.writeGlobalOne(include, target, {
        id: rowId, name: MCP_CLIENT_MODULE, disabled: request.disabled,
      }, (fileRows) => {
        this.globalFileRow(fileRows, rowId, target, include.tree.filename)
      }, rowId)
      return { target, entryId: written.id, serverName, disabled: this.declaredDisabled(written) }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    let serverName = entryId
    await writePresetRows(this.ctx, preset, { id: entryId, name: MCP_CLIENT_MODULE, disabled: request.disabled }, (rows) => {
      const row = this.presetMcpRow(rows, entryId, target)
      serverName = serverNameOf(row) ?? entryId
      if (!request.disabled) assertRunnableConfig(target, row.config)
    }, this.warnPatch)
    return { target, entryId, serverName, disabled: request.disabled }
  }

  /**
   * Resolve one preset's declaration, refusing an activation failure before any
   * edit is attempted.
   *
   * The registry answers whether the declaration currently activates; the
   * declaration row itself comes from the profile patch, which is also where a
   * write goes. A composition without the registry still authors fine; only the
   * activation diagnostic is unavailable then.
   * @param target - the preset-scoped MCP target being authored.
   * @returns the declaration row and its current child rows.
   * @throws an MCP Remote error when the preset is unknown or broken.
   */
  private async resolvePreset(target: Extract<McpTarget, { scope: 'preset' }>): Promise<PresetDeclaration> {
    const presets = this.ctx.get('agentPresets') as AgentPresetResolver | undefined
    if (presets !== undefined) {
      let broken: string | undefined
      try {
        broken = (await presets.resolve(target.agentPreset)).broken
      } catch (cause) {
        if (cause instanceof RemoteError) throw cause
        throw new RemoteError('mcp/not-found', `MCP preset "${target.agentPreset}" was not found`, {
          target,
        }, { cause })
      }
      if (broken !== undefined) {
        throw new RemoteError('mcp/invalid', `MCP preset "${target.agentPreset}" is broken: ${broken}`, {
          target,
          reason: broken,
        })
      }
    }
    return findPresetDeclaration(this.ctx, target.agentPreset)
  }

  private async globalInclude(target: Extract<McpTarget, { scope: 'global' }>): Promise<{ entry: Entry; tree: WritableIncludeTree }> {
    const entries = [...this.loader().entries()]
    const mounted = entries.filter(entry => isIncludeRow(entry.options) && entry.subtree !== undefined)
    // The host's own root anchor is never a write target: `prepareProfile`
    // regenerates its file on every start. Only a user Include can be patched.
    const includes = writableGlobalIncludes(entries)
    if (includes.length !== 1) {
      const reason = includes.length === 0
        ? mounted.some(entry => isRootAnchorInclude(entry))
          ? 'the composition mounts only the host profile Include, whose file the host regenerates'
          : 'no file-backed Include of your own is mounted'
        : `${includes.length} writable Includes are mounted`
      throw new RemoteError(mounted.length === 0 ? 'mcp/unavailable' : 'mcp/read-only',
        'global MCP rows are written through a file-backed Include of your own', { target, reason })
    }
    const entry = includes[0]!.entry as Entry
    const tree = entry.subtree as IncludeTree
    const filename = tree.filename
    if (filename === undefined) {
      throw new RemoteError('mcp/unavailable', 'global MCP authoring has no persistent Include file', {
        reason: 'the mounted global tree does not expose a writable filename',
      })
    }
    try {
      await access(filename, constants.W_OK)
    } catch (cause) {
      const reason = String(cause)
      throw new RemoteError('mcp/read-only', `global MCP config is not writable: ${filename}`, {
        target,
        reason,
      }, { cause })
    }
    return { entry, tree: tree as WritableIncludeTree }
  }

  /**
   * Persist one global-plane patch and reload the Include.
   *
   * The patch is applied to the Include's own file, whose list holds the user's
   * rows only, and `Include.refresh()` then re-reads it and re-applies the
   * composed patch layers. Writing through `loader.create`/`loader.update`
   * instead would make the Include serialize its patched tree back into that
   * file, flattening the bundle and user patch layers into it.
   * @param include - the addressed root Include and its file-backed tree.
   * @param target - the Remote target used in actionable failure details.
   * @param patch - the entry-list patch to commit.
   * @param validate - duplicate checks run against locked disk state.
   * @param rowIds - the rows this patch is expected to leave live.
   * @returns the live entries the reload produced, in the order asked for.
   * @throws an MCP Remote error when the reload does not mount every row.
   */
  private async writeGlobalRow(
    include: { entry: Entry; tree: WritableIncludeTree },
    target: Extract<McpTarget, { scope: 'global' }>,
    patch: PatchOptions,
    validate: (rows: EntryOptions[]) => void,
    rowIds: readonly string[],
  ): Promise<Entry[]> {
    await writeEntryListFile(include.tree.filename, target, patch, validate, this.warnPatch)
    await include.tree.refresh()
    const live = [...include.tree.entries()]
    return rowIds.map((rowId) => {
      const mounted = live.find(row => row.options.id === rowId)
      if (mounted === undefined) {
        throw new RemoteError('mcp/invalid', `global MCP row "${rowId}" was written but is not mounted`, {
          target,
          reason: `${include.tree.filename} was updated; the composition did not pick the row up`,
        })
      }
      return mounted
    })
  }

  /**
   * Persist one global-plane patch and return the row it mounts.
   * @param include - the addressed root Include and its file-backed tree.
   * @param target - the global plane.
   * @param patch - the entry-list patch to commit.
   * @param validate - duplicate checks run against locked disk state.
   * @param rowId - the row this patch is expected to leave live.
   * @returns the live entry the reload produced.
   */
  private async writeGlobalOne(
    include: { entry: Entry; tree: WritableIncludeTree },
    target: Extract<McpTarget, { scope: 'global' }>,
    patch: PatchOptions,
    validate: (rows: EntryOptions[]) => void,
    rowId: string,
  ): Promise<Entry> {
    // The batch form rejects when a row did not mount, so exactly one comes back.
    const [written] = await this.writeGlobalRow(include, target, patch, validate, [rowId])
    if (written === undefined) {
      throw new RemoteError('mcp/invalid', `global MCP row "${rowId}" was not mounted`, { target, reason: rowId })
    }
    return written
  }

  /**
   * Find one MCP row inside the addressed Include.
   *
   * The row lives in the Include's own subtree, so `loader.resolve` cannot see
   * it: that walks the root store, where only the Include itself is registered.
   * Both spellings of an id are accepted because the settings page keeps the leaf
   * id it renders while the Loader reports the qualified one.
   * @param entryId - qualified or leaf row id.
   * @param target - the Remote target used in actionable failure details.
   * @param tree - the addressed Include's tree.
   * @returns the row's live entry.
   * @throws an MCP Remote error when the row is absent, ambiguous, or not an MCP row.
   */
  /**
   * Locate one live global row without addressing its composition file.
   *
   * The row is found wherever the composition put it: inside a file-backed
   * Include's subtree, in a nested group there, or directly in the root tree
   * when a patch layer inserted it. Reading must not depend on which of those
   * shapes the profile used.
   * @param entryId - qualified or leaf row id.
   * @param target - the Remote target used in actionable failure details.
   * @returns the row's live entry.
   * @throws an MCP Remote error when the row is absent, ambiguous, or not an MCP row.
   */
  private liveGlobalEntry(entryId: string, target: McpTarget): Entry {
    const leafId = presetLeafId(entryId)
    // One row is enumerated more than once: a file-backed include's store keys
    // it by its qualified id, and the root list names the same entry by its leaf
    // id. The row is the same either way, so collect by leaf and answer once.
    const found = new Map<string, Entry>()
    const visit = (tree: { entries(): Iterable<Entry> }): void => {
      for (const entry of tree.entries()) {
        const id = entry.options.id
        if (id !== leafId && entry.id !== entryId) {
          const nested = (entry as { readonly subtree?: { entries(): Iterable<Entry> } }).subtree
          if (nested?.entries !== undefined) visit(nested)
          continue
        }
        found.set(presetLeafId(id), entry)
      }
    }
    for (const entry of this.loader().entries()) {
      if (entry.subtree === undefined) continue
      // A preset's tree carries its own rows; only the composition's own trees
      // answer a global lookup.
      visit(entry.subtree as { entries(): Iterable<Entry> })
    }
    if (found.size === 0) {
      throw new RemoteError('mcp/not-found', `MCP loader row "${entryId}" was not found`, { target, entryId })
    }
    if (found.size > 1) throw conflict(target, entryId, undefined, 'the row id occurs more than once')
    const entry = [...found.values()][0]!
    if (entry.options.name !== MCP_CLIENT_MODULE || entry.options.group) {
      throw invalid(target, `loader row "${entryId}" is not an MCP client row`)
    }
    return entry
  }

  /**
   * The row one global patch updates inside the addressed Include's own file.
   *
   * The file holds the user's rows only. A global row can also be live because
   * the composition or a patch layer declares it, and then the file has nothing
   * to patch: the write would either duplicate the row or fail late with a
   * message about a missing row. Refusing here states which plane owns it.
   * @param rows - the Include file's own rows, read under the write lock.
   * @param rowId - the live row's local id.
   * @param target - the global plane.
   * @param filename - the file the patch would edit.
   * @returns the file row the patch updates.
   * @throws an MCP Remote error when the file does not declare exactly this row.
   */
  private globalFileRow(rows: EntryOptions[], rowId: string, target: McpTarget, filename: string): EntryOptions {
    const found = findEntryRows(rows, rowId)
    if (found.length === 0) {
      throw new RemoteError('mcp/read-only', `global MCP row "${rowId}" is not declared by ${filename}`, {
        target,
        reason: `the composition or a patch layer declares "${rowId}", so it cannot be switched from the settings `
          + `page: only the rows inside ${filename} are editable there`,
      })
    }
    if (found.length > 1) throw conflict(target, rowId, undefined, 'the row id occurs more than once')
    const row = found[0] as EntryOptions
    if (row.name !== MCP_CLIENT_MODULE || row.group) {
      throw invalid(target, `global row "${rowId}" is not an MCP client row`)
    }
    return row
  }

  private presetMcpRow(rows: EntryOptions[], entryId: string, target: McpTarget): EntryOptions {
    const found = findEntryRows(rows, entryId)
    if (found.length === 0) throw new RemoteError('mcp/not-found', `MCP preset row "${entryId}" was not found`, { target, entryId })
    if (found.length > 1) throw conflict(target, entryId, undefined, 'the row id occurs more than once')
    const row = found[0] as EntryOptions
    if (row.name !== MCP_CLIENT_MODULE || row.group) {
      throw invalid(target, `preset row "${entryId}" is not an MCP client row`)
    }
    return row
  }

  private assertServerNameAvailable(
    entries: readonly Entry[] | readonly EntryOptions[],
    entryId: string,
    serverName: string,
    target: McpTarget,
  ): void {
    for (const value of entries) {
      const options = 'options' in value ? value.options : value
      const fullId = 'options' in value ? value.id : undefined
      if (options.id === entryId || fullId === entryId || options.name !== MCP_CLIENT_MODULE || options.group) continue
      if (serverNameOf(options) === serverName) {
        throw conflict(target, entryId, serverName, 'the serverName is already in use')
      }
    }
  }

  /** Resolve the Loader through `ctx.get`, never property access: an un-injected
   * service property throws under Cordis's inject guard, and the authoring
   * operations need the Loader lazily (it may not be ready at construction). */
  private loader() {
    return this.ctx.get('loader') as {
      entries(): IterableIterator<Entry>
    }
  }

  private warnPatch = (message: string, ...args: unknown[]): void => {
    const logger = this.ctx.get('logger') as { warn(message: string, ...args: unknown[]): void } | undefined
    logger?.warn(message, ...args)
  }
}

function validateTarget(value: McpTarget): McpTarget {
  if (value.scope === 'global') return { scope: 'global' }
  if (value.agentPreset.length > 0) return { scope: 'preset', agentPreset: value.agentPreset }
  throw badRequest('target must select global or a non-empty preset id')
}

function validateEntryId(entryId: string, target: McpTarget, adding: boolean): void {
  if (entryId.length === 0) throw badRequest('entryId must be a non-empty string')
  if (adding && target.scope === 'global' && entryId.includes(':')) {
    throw badRequest('a new global entryId must be local to the Include root')
  }
}

function configFromSpec(spec: McpSpec, serverName: string, target: McpTarget) {
  try {
    return mcpEntryConfig(spec, assertServerName(serverName))
  } catch (cause) {
    const reason = String(cause)
    throw invalid(target, reason)
  }
}

/**
 * Refuse to switch a row on while its connection config cannot start.
 *
 * The settings page closes the same door in the UI, but a row can also be
 * enabled by hand-editing the profile patch, so the check runs Host-side where
 * every path passes. Disabling is always allowed: a row that cannot start still
 * has to be removable.
 * @param target - the row being enabled, for the error's scope.
 * @param config - the row's composed `mcp-client` config.
 * @throws an MCP Remote error naming every gap.
 */
function assertRunnableConfig(target: McpTarget, config: unknown): void {
  const issues = diagnoseRowConfig(config)
  if (issues.length > 0) {
    throw invalid(target, `this MCP row is not configured and cannot be enabled: ${describeMcpConfigIssues(issues)}`)
  }
}

function serverNameOf(options: EntryOptions): string | undefined {
  const config: unknown = options.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  const record = config as Record<string, unknown>
  return typeof record.serverName === 'string' ? record.serverName : undefined
}

function badRequest(message: string): RemoteError {
  return new RemoteError('gateway/bad-request', message, {})
}

function invalid(target: McpTarget, reason: string): RemoteError {
  return new RemoteError('mcp/invalid', reason, { target, reason })
}

function conflict(target: McpTarget, entryId: string, serverName: string | undefined, reason: string): RemoteError {
  return new RemoteError('mcp/conflict', reason, {
    target,
    entryId,
    ...(serverName === undefined ? {} : { serverName }),
    reason,
  })
}
