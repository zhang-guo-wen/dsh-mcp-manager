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
import { connectLazyWithin } from './lazy-mcp.ts'
import type { McpOptimizeFlags } from './mcp-optimize.ts'
import { readMcpRoster } from './mcp-roster.ts'
import { ensureGlobalInclude } from './mcp-global-include.ts'
import { estimateToolTokens } from './mcp-tokens.ts'
import type {
  AddMcpRequest,
  ClearMcpCatalogRequest,
  ClearMcpCatalogResult,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  RefreshMcpCatalogRequest,
  RefreshMcpCatalogResult,
  EnableGlobalPlaneRequest,
  EnableGlobalPlaneResult,
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
} from './types.ts'
import { McpCatalog, catalogIdentity } from './mcp-catalog.ts'
import type { LazyTool } from './mcp-carrier.ts'
import type { GateMount, McpPreloadGate } from './mcp-gate.ts'
import type { ExternalMcpDefinition, ExternalMcpRegistry } from './external-mcp.ts'

/** How long one editor tool listing may take before the dialog reports failure. */
const TOOL_LIST_TIMEOUT_MS = 30_000

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

type WritableIncludeTree = IncludeTree & { readonly filename: string }

/** Profile facts that decide where a global Include file and its patch row live. */
interface ProfileFacts {
  readonly dir: string
  readonly patchPath: string
}

/** The boot package surface used to rebuild the composition after a patch write. */
interface AppBootRuntime {
  readProfilePatches(binName: string, context: ProfileFacts): PatchOptions[]
  reconcileProfilePatches(ctx: Context, patches: PatchOptions[], binName: string): Promise<readonly string[]>
}

/** The HMR service surface that serializes a profile-layer write with automatic reloads. */
interface HmrService {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>
}

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
   * Whether this process already tried the automatic global-Include creation.
   *
   * One attempt per host process: the creation is a composition write, and a
   * failed attempt leaves the page's explicit action as the retry — repeating it
   * on every roster read would rewrite a patch layer the user may be fixing.
   */
  private globalPlaneAutoTried = false

  /**
   * @param ctx - host context.
   * @param gate - the preload gate the mutations must leave in line with the
   *   current loading mode.
   * @param mountReader - reader of the live agent-preset mounts, used by the
   *   roster read to report each preset row's current fiber phase.
   * @param external - the registry of resource-plugin rows.
   * @param loadingMode - live reader of the committed loading mode.
   * @param optimize - live reader of the policy, so both discovery entry points
   *   here collect as many tools as `mcp_load` would for the same row.
   * @param catalog - the discovery catalogue the settings page can inspect and clear.
   */
  constructor(
    ctx: Context,
    private readonly gate: McpPreloadGate,
    private readonly mountReader: (within?: unknown) => readonly GateMount[],
    private readonly external: ExternalMcpRegistry,
    private readonly loadingMode: () => 'eager' | 'dynamic' | 'lazy',
    private readonly optimize: () => McpOptimizeFlags,
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
   * The first read of a host process also repairs the one state a fresh profile
   * cannot get out of by itself: no writable Include at all. Repairing on the
   * read that opens the settings page makes the global plane usable without any
   * extra click, while every later read is a pure roster read. The attempt is
   * made once per process; a failure keeps the roster's own read-only reason and
   * leaves the explicit action in the page for a retry.
   * @param request - empty placeholder; the roster is host-wide.
   * @returns the global rows, every declared preset with its rows, and whether
   *   the global plane accepts writes.
   */
  @Remote('listMcps')
  async listMcps(request: ListMcpsRequest): Promise<ListMcpsResult> {
    void request
    await this.autoEnableGlobalPlane()
    return readMcpRoster(this.ctx, this.mountReader, this.gate.suppressedEntryIds(), this.gate.globalRows?.() ?? [])
  }

  /**
   * Create the missing global Include on the first roster read of this process.
   *
   * The settings page cannot make the plane writable without a click otherwise,
   * and a fresh profile never has the file. This is the same creation the explicit
   * {@link enableGlobalPlane} call performs, run once; it never throws into the
   * read — a failure is logged and the roster reports the read-only reason, so the
   * page keeps its own retry action.
   * @returns a promise resolving after the one attempt, success or not.
   */
  private async autoEnableGlobalPlane(): Promise<void> {
    if (this.globalPlaneAutoTried) return
    this.globalPlaneAutoTried = true
    // Nothing to repair when a writable Include is already mounted, or when the
    // plane is closed for a reason creating a file cannot fix.
    if (this.writableIncludes().length !== 0) return
    if (this.ctx.get('profileContext') === undefined) return
    try {
      const result = await this.enqueue(() => this.ensureGlobalPlane())
      await this.gate.reconcile()
      if (!result.mounted) {
        this.warnPatch('mcp-manager: created the global Include but the composition did not mount it; restart the host to apply it')
      }
    } catch (cause) {
      this.warnPatch('mcp-manager: automatic global Include creation failed: %s', String(cause))
    }
  }

  /**
   * Make the global plane writable, creating the user's own Include when needed.
   *
   * A freshly installed profile mounts only the host's root anchor Include, whose
   * file the host regenerates on every start, so the settings page has nothing it
   * may patch and offers no global target. This call supplies that file: it
   * writes an entry-list file beside the profile and appends the patch row that
   * mounts it, then rebuilds the composition so the plane is writable in the same
   * session. A composition that already has exactly one writable Include is left
   * untouched, and one with several stays closed — no single file can be named.
   * @param request - empty placeholder; the plane is host-wide.
   * @returns what was written and whether a global write can land now.
   * @throws a typed MCP error when the profile patch layer cannot be written or
   *   the Include row does not mount.
   */
  @Remote('enableGlobalPlane')
  async enableGlobalPlane(request: EnableGlobalPlaneRequest): Promise<EnableGlobalPlaneResult> {
    void request
    const result = await this.enqueue(() => this.ensureGlobalPlane())
    await this.gate.reconcile()
    return result
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

  /** Explicitly re-discover current HTTP rows; local stdio catalogues are untouched. */
  @Remote('refreshCatalog')
  async refreshCatalog(request: RefreshMcpCatalogRequest): Promise<RefreshMcpCatalogResult> {
    void request
    return this.enqueue(async () => {
      if (!this.catalog.persistent) throw new RemoteError('mcp/unavailable', 'The catalogue database is unavailable', { reason: 'catalogue database unavailable' })
      const epoch = this.catalog.epoch
      const configs = new Map<string, { key: string; config: McpEntryConfig }>()
      let interrupted = false
      const failed: { serverName: string; reason: string }[] = []
      const roster = readMcpRoster(this.ctx, this.mountReader, this.gate.suppressedEntryIds(), this.gate.globalRows?.() ?? [])
      const rows = [
        ...roster.entries.map(row => ({ row, target: { scope: 'global' as const } })),
        ...roster.presets.flatMap(preset => preset.rows.map(row => ({ row, target: { scope: 'preset' as const, agentPreset: preset.id } }))),
      ]
      for (const { row, target } of rows) {
        if (row.entryId === null || row.enabled !== true) continue
        try {
          const described = await this.describeMcp({ target, entryId: row.entryId })
          const config = mcpEntryConfig(described.spec, described.serverName)
          if (config.transport !== 'streamable-http') continue
          configs.set(catalogIdentity(config), {
            key: target.scope === 'global' ? `global:${described.serverName}` : `preset:${target.agentPreset}:${described.serverName}`, config,
          })
        } catch { failed.push({ serverName: row.entryId, reason: 'The current connection configuration is unavailable' }) }
      }
      for (const row of this.external.rows()) {
        if (row.config.transport !== 'streamable-http') continue
        configs.set(catalogIdentity(row.config), { key: `external:${row.owner}:${row.serverName}`, config: row.config })
      }
      let refreshed = 0
      // Bound network concurrency; no local child process is ever spawned here.
      const pending = [...configs.values()]
      await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
        for (;;) {
          if (epoch !== this.catalog.epoch) { interrupted = true; return }
          const next = pending.shift()
          if (next === undefined) return
          const { key, config } = next
          try {
            const connection = await connectLazyWithin(config, { maxTools: this.optimize().maxTools }, TOOL_LIST_TIMEOUT_MS)
            try {
              if (epoch !== this.catalog.epoch) throw new Error('catalogue changed')
              this.catalog.remember(config, connection, key, Date.now(), epoch)
              await this.catalog.flush()
              refreshed += 1
            } finally { await connection.client.close().catch(() => {}) }
          } catch { failed.push({ serverName: config.serverName, reason: 'The server did not refresh its tool catalogue or the database write failed' }) }
        }
      }))
      if (interrupted || epoch !== this.catalog.epoch) {
        throw new RemoteError('mcp/unavailable', 'The catalogue changed during refresh; refresh again', { reason: 'catalogue refresh interrupted' })
      }
      return { refreshed, failed }
    })
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
    const cleared = this.catalog.clear()
    await this.catalog.flush()
    return { cleared }
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
    const epoch = this.catalog.epoch
    let connection: Awaited<ReturnType<typeof connectLazyWithin>>
    try {
      // The listing owns this connection for its whole lifetime either way:
      // `connectLazyWithin` closes the client a lost race still produces.
      connection = await connectLazyWithin(config, { maxTools: this.optimize().maxTools }, TOOL_LIST_TIMEOUT_MS)
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
      // A probe has no authored row yet. Its normalized local-config digest is
      // sufficient for the row to reuse it after Save (and after a host restart).
      if (epoch !== this.catalog.epoch) {
        throw new RemoteError('mcp/unavailable', 'The tool catalogue was cleared while probing; test the connection again', { reason: 'catalogue changed during probe' })
      }
      this.catalog.remember(config, connection, undefined, Date.now(), epoch)
      if (!this.catalog.persistent) {
        throw new RemoteError('mcp/unavailable', 'MCP connected, but the catalogue database is unavailable', { reason: 'catalogue database unavailable' })
      }
      try { await this.catalog.flush() } catch {
        throw new RemoteError('mcp/unavailable', 'MCP connected, but its tool catalogue could not be persisted', { reason: 'catalogue database write failed' })
      }
      return {
        tools: connection.tools.map(tool => ({
          name: tool.name,
          description: tool.description ?? '',
          // Measured here, where the definition is whole: the schema is what a
          // listing mostly costs and the browser never receives it.
          tokens: estimateToolTokens(tool),
        })),
      }
    } finally {
      // The listing owns this connection for its whole lifetime; a close
      // failure must not replace the tools it already read.
      await connection.client.close().catch(() => {})
    }
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

  /** The writable Includes the running composition mounts, in composition order. */
  private writableIncludes() {
    return writableGlobalIncludes(this.loader().entries())
  }

  /**
   * Create the user's global Include when the profile mounts none.
   *
   * The row goes into the profile patch layer, which is the only composition
   * layer that survives `prepareProfile`. Writing it is followed by a rebuild:
   * the patch layer is read at boot, so an in-session write is invisible until
   * the composition is reconciled through the boot package.
   * @returns what was written and whether the Include is mounted now.
   * @throws a typed MCP error when the plane is ambiguous, the host mounted no
   *   patch layer, or the patch write itself fails.
   */
  private async ensureGlobalPlane(): Promise<EnableGlobalPlaneResult> {
    const before = this.writableIncludes()
    if (before.length > 1) {
      throw new RemoteError('mcp/read-only', 'the global plane has several writable Includes', {
        target: { scope: 'global' },
        reason: `${before.length} file-backed Includes of your own are mounted, so no single file can be addressed`,
      })
    }
    if (before.length === 1) {
      return { includePath: before[0]!.filename, created: false, patchChanged: false, mounted: true }
    }
    const profile = this.ctx.get('profileContext') as ProfileFacts | undefined
    if (profile === undefined) {
      throw new RemoteError('mcp/unavailable', 'this host launched no profile, so it has no patch layer to declare a global Include in', {
        reason: 'the profileContext service is unavailable',
      })
    }
    const hmr = this.ctx.get('hmr') as HmrService | undefined
    const create = async () => ensureGlobalInclude({
      profileDir: profile.dir,
      patchPath: profile.patchPath,
      reconcile: () => this.reloadProfileComposition(profile),
    })
    let created: Awaited<ReturnType<typeof ensureGlobalInclude>>
    try {
      created = hmr === undefined ? await create() : await hmr.runExclusive(create)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      throw new RemoteError('mcp/invalid', 'the profile patch layer could not be extended with a global Include', {
        target: { scope: 'global' },
        reason,
      }, { cause })
    }
    let mounted = this.writableIncludes().length === 1
    if (!mounted) {
      // The row is on disk; the live tree may lag when the write's own rebuild
      // failed or this host hides the boot package. One more rebuild is cheap and
      // decides between "apply now" and "restart first" for the caller.
      try {
        await this.reloadProfileComposition(profile)
        mounted = this.writableIncludes().length === 1
      } catch (cause) {
        this.warnPatch('mcp-manager: global Include reload failed: %s', String(cause))
      }
    }
    return { includePath: created.filename, created: created.created, patchChanged: created.patchChanged, mounted }
  }

  /**
   * Rebuild the composition from the profile's patch layers.
   *
   * The boot package owns the root Include and the reconciliation, so it is
   * resolved through the host module loader, the same way this plugin resolves
   * the other Harness runtime packages it does not bundle.
   * @param profile - profile facts read from the host.
   * @throws when the host exposes no loader bridge or no boot package.
   */
  private async reloadProfileComposition(profile: ProfileFacts): Promise<void> {
    const internal = this.loader().internal
    if (internal === undefined) throw new Error('the Harness module loader is unavailable')
    const appBoot = await internal.import('@deepseek-ai/dsh-app-boot', this.ctx.baseUrl ?? import.meta.url, {}) as Partial<AppBootRuntime>
    if (typeof appBoot.readProfilePatches !== 'function' || typeof appBoot.reconcileProfilePatches !== 'function') {
      throw new Error('the Harness boot package does not expose profile reconciliation')
    }
    const patches = appBoot.readProfilePatches('dsh', profile)
    await appBoot.reconcileProfilePatches(this.ctx.root, patches, 'dsh')
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
      /** The Harness module bridge, present in a launched host. */
      readonly internal?: { import(specifier: string, base: string, options: object): Promise<unknown> }
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
