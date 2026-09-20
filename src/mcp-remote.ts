/** Typert Remote owner for global and agent-preset MCP row authoring. */

import { access, constants } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  entryIds,
  findEntryRows,
  MCP_CLIENT_MODULE,
  presetLeafId,
  readEntryRows,
  type PresetFile,
  writeEntryListFile,
  writePresetComposition,
} from './mcp-authoring.ts'
import { assertServerName, mcpEntryConfig, specFromEntryConfig, type McpEntryConfig } from './mcp-config.ts'
import { scanClaudeMcp } from './claude-import.ts'
import { connectLazy } from './lazy-mcp.ts'
import type {
  AddMcpRequest,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  McpGateStateRequest,
  McpGateStateResult,
  McpMutationResult,
  McpSpec,
  McpTarget,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
} from './types.ts'
import type { McpPreloadGate } from './mcp-gate.ts'

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

/** Minimal optional surface read from the agent-preset service. */
interface AgentPresetResolver {
  resolve(id: string): Promise<PresetFile>
}

/** The file-backed Include fields needed to guard global persistence. */
interface IncludeTree extends EntryTree {
  readonly filename?: string
  readonly config?: { readonly patches?: readonly unknown[] }
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
   */
  constructor(ctx: Context, private readonly gate: McpPreloadGate) {
    super(ctx, 'mcpManager')
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
      const include = await this.globalInclude(target)
      const entry = this.globalMcpEntry(request.entryId, target, include.tree)
      const serverName = serverNameOf(entry.options)
      if (serverName === undefined) {
        throw invalid(target, 'the MCP row has no valid serverName')
      }
      return {
        target,
        entryId: entry.id,
        serverName,
        spec: specFromEntryConfig(entry.options.config as McpEntryConfig),
        disabled: entry.disabled ?? false,
      }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    const rows = await readEntryRows(preset.path)
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
      await writeEntryListFile(include.tree.filename, target, {
        insert: [{ id: entryId, name: MCP_CLIENT_MODULE, config }],
      }, (rows) => {
        if (entryIds(rows).has(entryId)) {
          throw conflict(target, entryId, undefined, 'the row id is already in use')
        }
        if (rows.some(row => row.name === MCP_CLIENT_MODULE && serverNameOf(row) === request.serverName)) {
          throw conflict(target, entryId, request.serverName, 'the serverName is already in use')
        }
      }, this.warnPatch)
      const createdId = await this.loader().create({
        id: entryId,
        name: MCP_CLIENT_MODULE,
        config,
      } as Omit<EntryOptions, 'id'>, include.entry.id)
      return { target, entryId: createdId, serverName: request.serverName, disabled: false }
    }

    const preset = await this.resolvePreset(target)
    const patch = { insert: [{ id: entryId, name: MCP_CLIENT_MODULE, config }] }
    await writePresetComposition(preset, target, patch, (rows) => {
      if (entryIds(rows).has(entryId)) {
        throw conflict(target, entryId, undefined, 'the row id is already in use')
      }
      if (rows.some(row => row.name === MCP_CLIENT_MODULE && serverNameOf(row) === request.serverName)) {
        throw conflict(target, entryId, request.serverName, 'the serverName is already in use')
      }
    }, this.warnPatch)
    await this.refreshPreset(preset.id)
    return { target, entryId, serverName: request.serverName, disabled: false }
  }

  private async edit(request: EditMcpRequest): Promise<McpMutationResult> {
    const target = validateTarget(request.target)
    const config = configFromSpec(request.spec, request.serverName, target)
    validateEntryId(request.entryId, target, false)
    if (target.scope === 'global') {
      const include = await this.globalInclude(target)
      const entry = this.globalMcpEntry(request.entryId, target, include.tree)
      const disabled = entry.disabled
      this.assertServerNameAvailable(
        [...include.tree.entries()], request.entryId, request.serverName, target,
      )
      await this.loader().update(request.entryId, { config })
      const rowId = entry.options.id
      await writeEntryListFile(include.tree.filename, target, { id: rowId, name: MCP_CLIENT_MODULE, config }, (rows) => {
        this.presetMcpRow(rows, rowId, target)
        this.assertServerNameAvailable(rows, rowId, request.serverName, target)
      }, this.warnPatch)
      return { target, entryId: entry.id, serverName: request.serverName, disabled }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    let disabled = false
    const patch = { id: entryId, name: MCP_CLIENT_MODULE, config }
    await writePresetComposition(preset, target, patch, (rows) => {
      const row = this.presetMcpRow(rows, entryId, target)
      disabled = row.disabled === true
      this.assertServerNameAvailable(rows, entryId, request.serverName, target)
    }, this.warnPatch)
    await this.refreshPreset(preset.id)
    return { target, entryId, serverName: request.serverName, disabled }
  }

  private async disable(request: DisableMcpRequest): Promise<McpMutationResult> {
    const target = validateTarget(request.target)
    validateEntryId(request.entryId, target, false)
    if (target.scope === 'global') {
      const include = await this.globalInclude(target)
      const entry = this.globalMcpEntry(request.entryId, target, include.tree)
      const serverName = serverNameOf(entry.options)
      if (serverName === undefined) {
        throw invalid(target, 'the MCP row has no valid serverName')
      }
      await this.loader().update(request.entryId, { disabled: request.disabled })
      const rowId = entry.options.id
      await writeEntryListFile(include.tree.filename, target, {
        id: rowId, name: MCP_CLIENT_MODULE, disabled: request.disabled,
      }, (rows) => {
        this.presetMcpRow(rows, rowId, target)
      }, this.warnPatch)
      return { target, entryId: entry.id, serverName, disabled: request.disabled }
    }

    const preset = await this.resolvePreset(target)
    const entryId = presetLeafId(request.entryId)
    let serverName = entryId
    await writePresetComposition(preset, target, { id: entryId, name: MCP_CLIENT_MODULE, disabled: request.disabled }, (rows) => {
      const row = this.presetMcpRow(rows, entryId, target)
      serverName = serverNameOf(row) ?? entryId
    }, this.warnPatch)
    await this.refreshPreset(preset.id)
    return { target, entryId, serverName, disabled: request.disabled }
  }

  private async resolvePreset(target: Extract<McpTarget, { scope: 'preset' }>): Promise<PresetFile> {
    const presets = this.ctx.get('agentPresets') as AgentPresetResolver | undefined
    if (presets === undefined) {
      throw new RemoteError('mcp/unavailable', 'agent preset MCP authoring is unavailable', {
        reason: 'agentPresets is not mounted in this composition',
      })
    }
    try {
      return await presets.resolve(target.agentPreset)
    } catch (cause) {
      if (cause instanceof RemoteError) throw cause
      throw new RemoteError('mcp/not-found', `MCP preset "${target.agentPreset}" was not found`, {
        target,
      }, { cause })
    }
  }

  /**
   * Apply a just-written preset composition to its live standing mount.
   *
   * Re-reads the file through the mount's own `Include` tree (`refresh()`),
   * which diffs child entries and mounts/unmounts only what changed. A full
   * `standingKeyFor` recompose would start a new generation and remount every
   * row — restarting every MCP child process in the preset — so the targeted
   * refresh is the difference between a sub-second toggle and several seconds.
   * A preset that is not mounted has nothing live to update; a failure is
   * logged rather than thrown so a committed file write still reports success.
   * @param agentPreset - preset id whose composition was just written.
   */
  private async refreshPreset(agentPreset: string): Promise<void> {
    try {
      const mountsFor = await this.mountRegistry()
      if (mountsFor !== undefined) {
        const mount = mountsFor().filter(candidate => candidate.presetId === agentPreset).at(-1)
        const refresh = (mount?.tree as { refresh?: () => Promise<void> } | undefined)?.refresh
        if (refresh !== undefined && mount !== undefined) {
          await refresh.call(mount.tree)
          return
        }
      }
      // Fallback: no reachable standing tree, so recompose through the service
      // so the change still goes live (correct, but restarts the whole preset).
      const presets = this.ctx.get('agentPresets') as { standingKeyFor?(id?: string): Promise<unknown> } | undefined
      if (presets?.standingKeyFor !== undefined) {
        await presets.standingKeyFor(agentPreset)
      }
    } catch (error) {
      this.warnPatch(`mcp-manager: preset "${agentPreset}" refresh failed after edit: ${String(error)}`)
    }
  }

  /**
   * Resolve the `livePresetMounts` reader from the agent-presets instance the
   * Loader actually uses. A plain import can land on a second copy of the
   * package (the harness resolves the roster from its own graph), so this goes
   * through the Loader's internal resolver with the harness base first, then
   * falls back to the statically imported reader.
   * @returns the mount reader, or undefined when neither path is available.
   */
  private async mountRegistry(): Promise<(() => readonly { presetId: string; tree: unknown }[]) | undefined> {
    const loader = this.ctx.get('loader') as { internal?: { import(spec: string, base: string, options: object): Promise<unknown> } } | undefined
    const base = (this.ctx as unknown as { baseUrl?: string }).baseUrl
    if (loader?.internal !== undefined && base !== undefined) {
      try {
        const mod = await loader.internal.import('@deepseek-ai/dsh-agent-presets', base, {}) as { livePresetMounts?: () => readonly { presetId: string; tree: unknown }[] }
        if (mod.livePresetMounts !== undefined) return mod.livePresetMounts
      } catch {
        // Swallows only the internal-resolver failure; the static reader below
        // is the fallback, and the outer call treats an empty registry as
        // "nothing to refresh" rather than an error.
      }
    }
    return () => livePresetMounts()
  }

  private async globalInclude(target: Extract<McpTarget, { scope: 'global' }>): Promise<{ entry: Entry; tree: WritableIncludeTree }> {
    const includes = [...this.loader().entries()].filter(entry => entry.options.name === 'cordis:include' && entry.subtree)
    if (includes.length !== 1) {
      throw new RemoteError('mcp/unavailable', 'global MCP authoring requires exactly one file-backed Include', {
        reason: includes.length === 0 ? 'no root Include is mounted' : `${includes.length} Includes are mounted`,
      })
    }
    const entry = includes[0] as Entry
    const tree = entry.subtree as IncludeTree
    const filename = tree.filename
    if (filename === undefined) {
      throw new RemoteError('mcp/unavailable', 'global MCP authoring has no persistent Include file', {
        reason: 'the mounted global tree does not expose a writable filename',
      })
    }
    if ((tree.config?.patches?.length ?? 0) > 0) {
      throw new RemoteError('mcp/read-only', 'global MCP authoring cannot persist a patched Include', {
        target,
        reason: 'Loader write-back would flatten bundle and user patch layers',
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

  private globalMcpEntry(entryId: string, target: McpTarget, tree: IncludeTree): Entry {
    let entry: Entry
    try {
      entry = this.loader().resolve(entryId)
    } catch (cause) {
      throw new RemoteError('mcp/not-found', `MCP loader row "${entryId}" was not found`, { target, entryId }, { cause })
    }
    if (!Array.from(tree.entries()).includes(entry)) {
      throw new RemoteError('mcp/not-found', `MCP loader row "${entryId}" is outside the global Include`, { target, entryId })
    }
    if (entry.options.name !== MCP_CLIENT_MODULE || entry.options.group) {
      throw invalid(target, `loader row "${entryId}" is not an MCP client row`)
    }
    return entry
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
      create(options: Omit<EntryOptions, 'id'>, parent: string): Promise<string>
      update(id: string, patch: Record<string, unknown>): Promise<void>
      resolve(id: string): Entry
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
