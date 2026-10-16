/**
 * MCP management plugin (host) with a browser settings section (client).
 *
 * Host: owns every `@deepseek-ai/dsh-mcp-client` composition row — global ones
 * and each agent preset's — through the `mcpManager` Remote namespace, holds the
 * allowed rows out of every request until a session loads one, and applies the
 * per-row tool filters the settings surface stores. Client: `src/client` bundles
 * the MCP management section into a `window.__ModuleLoader__` handoff artifact
 * served at `/plugins/<id>/client.js`.
 *
 * @module @guowenzhang/dsh-mcp-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import { McpManager } from './mcp-remote.ts'
import { parseMcpLoadingMode, registerMcpTools, resolveMcpClient, connectLazy, listAllTools } from './lazy-mcp.ts'
import type { LazyTool } from './mcp-carrier.ts'
import type { McpLoadingMode, McpToolRegistration } from './lazy-mcp.ts'
import { createMcpConnectionPool } from './mcp-pool.ts'
import type { PooledConnection } from './mcp-pool.ts'
import { McpCatalog } from './mcp-catalog.ts'
import {
  mcpRegistrationKey,
  parseMcpOptimizeFlags,
  type McpOptimizeFlags,
} from './mcp-optimize.ts'
import { ExternalMcpRegistry, type ScopeLookup } from './external-mcp.ts'
import { createMcpPreloadGate, MCP_ROW_EVENTS } from './mcp-gate.ts'
import type { GateEntry } from './mcp-gate.ts'
import { createPresetMountReader, type PresetScopeLookup } from './preset-mounts.ts'
import { MCP_CLIENT_MODULE } from './mcp-modules.ts'
import { AGENT_PRESET_MODULE } from './preset-source.ts'
import {
  filterHidesAnything,
  NO_TOOL_FILTER,
  parseMcpToolFilter,
  type McpToolFilter,
} from './mcp-tool-filter.ts'
import {
  Config,
  MCP_SETTINGS_NAMESPACE,
  readMcpSettings,
  type McpSettingsFlags,
} from './settings.ts'

export { McpManager } from './mcp-remote.ts'
export { assertServerName, mcpEntryConfig, specFromEntryConfig } from './mcp-config.ts'
export { flattenSpec, parseSpecText, parseSpecValue, secretKeys, serverNameFromCommand, specFromObject } from './mcp-spec.ts'
export { carrierFor } from './mcp-carrier.ts'
export type { McpCarrier } from './mcp-carrier.ts'
export { MCP_LOADING_MODES, parseMcpLoadingMode, registerMcpTools } from './lazy-mcp.ts'
export type { McpLoadingMode, McpRowReaders, McpToolRegistration } from './lazy-mcp.ts'
export { connectLazy, listAllTools } from './lazy-mcp.ts'
export type { McpDiscovery } from './lazy-mcp.ts'
export { McpCatalog } from './mcp-catalog.ts'
export type { McpCatalogEntry, McpCatalogRecord, McpCatalogStat, CatalogTool } from './mcp-catalog.ts'
export {
  annotationSummary,
  applyAnnotationPolicy,
  decodeToolCursor,
  encodeToolCursor,
  matchTools,
  mcpRegistrationKey,
  MCP_CATALOG_TTL_RANGE,
  MCP_MAX_TOOLS_RANGE,
  MCP_OPTIMIZE_DEFAULTS,
  MCP_PAGE_SIZE_RANGE,
  paginateTools,
  parseMcpOptimizeFlags,
  toolMatchesQuery,
} from './mcp-optimize.ts'
export type {
  McpOptimizeFlags,
  McpPolicySelection,
  McpToolAnnotations,
  McpToolPage,
  PolicyTool,
} from './mcp-optimize.ts'
export type { ExternalMcpDefinition } from './external-mcp.ts'
export { admits, filterHidesAnything, filterMcpTools, parseMcpToolFilter, toolRuleEntries } from './mcp-tool-filter.ts'
export type { McpToolFilter, McpToolSelection } from './mcp-tool-filter.ts'
export { mcpRowKey } from './mcp-gate.ts'
export type { McpPreloadGate, McpRowGateState } from './mcp-gate.ts'
export { Config, MCP_SETTINGS_NAMESPACE, readMcpSettings }
export type { McpSettingsConfig, McpSettingsFlags, McpSettingsSource } from './settings.ts'
export type { McpSpec, McpTarget } from './types.ts'
export type { AnyRecord as McpSpecRecord } from './mcp-spec.ts'
export type { McpEntryConfig, McpTransportConfig } from './mcp-config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Services required by this plugin. Every other service is probed lazily. */
export const inject = ['loader']

/**
 * Register the on-demand MCP tools, the preload gate that follows the loading
 * mode, the live settings fields, and the `mcpManager` Remote.
 * @param ctx - plugin context.
 * @param config - the row's resolved configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const readSettings = readMcpSettings(config)
  // MCP loading has two inputs. The user's composition says which servers may
  // be used at all; the mode says whether an allowed server also takes part in
  // every request. The gate holds the composed rows to that second answer, and
  // the tool set is re-registered with the new mode on every commit.
  let mcpLoading = parseMcpLoadingMode(readSettings().loading)
  /**
   * Fiber publication, subscribed before this `apply` yields.
   *
   * A composed row's fiber is published and activated as soon as the row is
   * created, so a listener installed after any `await` below can miss a row
   * that the composition activated while this plugin was still starting. Until
   * the gate exists the publications are counted, not held: a fiber that is
   * already running cannot be kept from spawning, so the honest answer is a
   * report and the Loader-driven reconcile fallback.
   */
  const fibers = ctx as unknown as {
    on(name: string, listener: (...args: readonly never[]) => void): () => void
  }
  let publish: (fiber: unknown) => void = () => { missedPublications += 1 }
  let missedPublications = 0
  const earlySubscription = fibers.on('internal/plugin', fiber => { publish(fiber) })
  ctx.effect(() => () => { earlySubscription() }, 'mcp-manager: fiber publication subscription')
  /**
   * Row creation, observed from the same first statement.
   *
   * A composed row is built before this plugin is imported, so its fiber is
   * never published while the gate is listening. `loader/entry-init` fires
   * inside the entry's constructor — earlier than the fiber, earlier than the
   * plugin import — which is where a row can still be kept from mounting.
   * Entries seen before the gate exists are replayed when it does.
   */
  const pendingEntries: { entry: unknown }[] = []
  let entryInit: ((entry: unknown) => void) | undefined
  const earlyEntrySubscription = fibers.on('loader/entry-init', (entry) => {
    if (entryInit === undefined) pendingEntries.push({ entry })
    else entryInit(entry)
  })
  ctx.effect(() => () => { earlyEntrySubscription() }, 'mcp-manager: entry creation subscription')

  // What each server published last time it was listed. It is what lets a
  // search answer without starting a process, and what a `tools/list_changed`
  // invalidates; one catalogue serves every registration generation, so a mode
  // change does not throw away what was already discovered.
  const catalog = new McpCatalog<LazyTool>()
  const loader = ctx.get('loader') as { internal?: { import(spec: string, base: string, options: object): Promise<unknown> } }
  if (!loader.internal) throw new Error('mcp-manager: Harness module loader is unavailable')
  const scopes = await loader.internal.import('@deepseek-ai/dsh-scope', ctx.baseUrl ?? import.meta.url, {}) as ScopeLookup & PresetScopeLookup
  if (typeof scopes.scopeOf !== 'function' || typeof scopes.scopeChainOf !== 'function' || typeof scopes.createScope !== 'function') {
    throw new Error('mcp-manager: Harness scope helpers are unavailable')
  }
  // Taking over a row, or a preset generation becoming readable, is a change to
  // the rows this session may load, and neither carries an event of its own: a
  // held row never activates, so it never publishes the `internal/status` event
  // that used to refresh the derived inventory as a side effect, and the
  // composition's own mount emits nothing. Both report here; the row
  // synchronization that acts on them is installed below.
  const rowTaken: { current?: () => void } = {}
  const mountReader = createPresetMountReader(ctx, scopes, () => { queueMicrotask(() => { rowTaken.current?.() }) })
  ctx.effect(() => () => { mountReader.dispose() }, 'mcp-manager: preset mount reader')
  /**
   * Resolve a published fiber to its owning row without the gate.
   *
   * This runs only while the gate is still being built, and only to keep a
   * composed MCP row's publication from going unreported: a row that got this
   * far is already running, so the Loader-driven reconcile has to stop it.
   */
  const mcpRowOf = (fiber: unknown): string | undefined => {
    const entry = (fiber as { readonly parent?: Record<PropertyKey, unknown> } | undefined)
      ?.parent?.[Symbol.for('cordis.entry')] as { readonly options?: { readonly name?: string; readonly id?: string } } | undefined
    if (entry?.options?.name !== MCP_CLIENT_MODULE) return undefined
    return entry.options.id
  }
  // The gate decides a preset row's fate at the row's fiber publication, which
  // is the only moment early enough to keep an MCP server from starting: the
  // mcp-client plugin spawns inside its own callback, and Cordis emits
  // `internal/plugin` before it resolves that callback's dependencies.
  const gate = createMcpPreloadGate(
    ctx,
    () => mcpLoading,
    mountReader,
    (message) => { ctx.logger.warn(message) },
    undefined,
    () => { queueMicrotask(() => { rowTaken.current?.() }) },
  )
  if (missedPublications > 0) {
    ctx.logger.warn(
      `mcp-manager: ${missedPublications} fiber(s) appeared while this plugin was still starting, before the preload `
      + 'gate existed; any composed MCP row among them started and is stopped again by the row synchronization',
    )
  }
  publish = fiber => {
    const missed = mcpRowOf(fiber)
    if (missed !== undefined) {
      ctx.logger.warn(
        `mcp-manager: MCP row "${missed}" was published before the preload gate existed, so it may have started once; `
        + 'the row synchronization stops it and it stays held from here on',
      )
    }
    gate.onPublish({ fiber })
  }
  entryInit = (entry: unknown) => { gate.onEntryInit(entry as GateEntry) }
  for (const pending of pendingEntries.splice(0)) entryInit(pending.entry)
  ctx.effect(() => () => { gate.dispose() }, 'mcp-manager: preload gate')
  // The tool registration holds these closures rather than snapshots, so a
  // committed rule or description change applies to the next `mcp_load` and to
  // the next inventory refresh without re-registering anything. Loaded servers
  // keep the tools they were admitted with.
  let readToolFilter: (key: string) => McpToolFilter = () => NO_TOOL_FILTER
  const readers = {
    filterFor: (key: string): McpToolFilter => readToolFilter(key),
    descriptionFor: (key: string): string | undefined => readSettings().descriptions[key],
    // Read at every load, every search, and every `tools/list_changed` re-sync,
    // so a committed switch applies from the next call on.
    optimize: (): McpOptimizeFlags => parseMcpOptimizeFlags(readSettings().optimize),
  }
  // On-demand connections belong to the host, not to a session: a server that
  // one session loaded keeps running until the last session using it releases
  // its claim, and the next session loads it without paying for a second
  // process. Committing a different loading mode does rebuild the tool surface
  // and therefore releases those claims — the mode's contract changed, so the
  // tools registered under the old one cannot stay — but nothing else in the
  // settings does, and the pool itself is closed only when this plugin unloads.
  /** What a live connection does when the server announces a new tool list. */
  let changed: (connection: PooledConnection) => void = () => {}
  /** What a live connection does when its transport ends without us closing it. */
  let lost: (connection: PooledConnection) => void = () => {}
  const pool = createMcpConnectionPool({
    // The collection cap is the policy's, read when the connection is opened:
    // a connection already serving sessions keeps the listing it walked.
    open: config => connectLazy(config, { maxTools: readers.optimize().maxTools }),
    // A `tools/list_changed` re-walks every page through the same discovery
    // path, so a paged server is not silently cut to its first page; the cap
    // is read live, like every other policy field.
    relist: client => listAllTools(client, readers.optimize().maxTools),
    // The registration that owns the current mode answers these; it exists before
    // any session can load a server, because a connection is only opened by
    // `mcp_load`.
    onToolsChanged: connection => { changed(connection) },
    // A crashed server has to stop being offered: the pool has already dropped
    // the connection, and the registration withdraws the tools pointing at it.
    onConnectionLost: connection => { lost(connection) },
    warn: message => { ctx.logger.warn(message) },
  })
  ctx.effect(() => async () => { await pool.dispose() }, 'mcp-manager: on-demand connections')
  // The registration is the mode's tool set. It is re-created on every mode
  // commit, always through `activate`, so the pool's change notifications follow
  // the live one. The holder is what makes that safe during this `apply`: the
  // external registry can publish a change before the first activation below
  // has finished, and `activate` must not depend on a binding that is still
  // being initialized.
  const active: { current?: McpToolRegistration } = {}
  const activate = (next: McpLoadingMode): McpToolRegistration => {
    // The shared catalogue is the seventh argument: `mcp_load`/`mcp_search`
    // must remember discoveries where `McpManager.catalogState` reads them and
    // where every later registration generation still finds them.
    const registration = registerMcpTools(ctx, next, gate, readers, pool, external, catalog)
    active.current = registration
    changed = connection => { registration.toolsChanged(connection) }
    lost = connection => { registration.connectionLost(connection) }
    return registration
  }
  const external = new ExternalMcpRegistry(
    () => mcpLoading,
    async (ownerCtx, entryConfig) => {
      const module = await resolveMcpClient(ctx)
      const handle = await ownerCtx.plugin(
        { name: module.name, inject: module.inject, apply: module.apply } as never,
        { ...entryConfig, failOnStartupError: true } as never,
      ) as unknown as { dispose(): Promise<void> }
      return handle
    },
    async () => {
      await active.current?.dispose()
      await activate(mcpLoading).refresh()
    },
    scopes,
  )
  // Register the Remote service before any inventory refresh. Preset rows may
  // depend on it, and activation-sensitive registry diagnostics are never read.
  new McpManager(ctx, gate, mountReader, external, () => mcpLoading, catalog)
  activate(mcpLoading)
  /**
   * The registered tool set's identity: what a re-registration is keyed on.
   *
   * The loading mode decides which on-demand tools exist, and the policy
   * decides whether `mcp_search` exists at all — a registered tool set is what
   * the request prefix carries, so those two answers rebuild it. Every other
   * policy field is read live at the call site.
   */
  let registrationKey = `${mcpLoading}|${mcpRegistrationKey(readers.optimize())}`
  ctx.effect(() => async () => {
    await external.dispose(async () => { await active.current?.dispose(); gate.dispose() })
  }, 'mcp-manager: mcp tools')
  // The gate's answer is what the inventory lists, so every reconcile is
  // followed by a refresh: the prompt section is served from a snapshot and
  // cannot await anything while the request is assembled.
  let syncing = false
  let dirty = false
  let stopped = false
  ctx.effect(() => () => { stopped = true }, 'mcp-manager: row synchronization')
  const resync = (): void => {
    if (stopped) return
    dirty = true
    if (syncing) return
    syncing = true
    void (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false
          await gate.reconcile()
          await active.current?.refresh()
        }
      } catch (error) {
        ctx.logger.warn(`mcp-manager: row synchronization failed: ${String(error)}`)
      } finally { syncing = false }
    })()
  }
  rowTaken.current = resync
  // Presets activate when declared and publish another generation whenever
  // their composition changes; both come back through these events,
  // which is what keeps the gate's answer true across a session's lifetime.
  // `agent-preset/selected` is emitted on the context without a declaration in
  // the Cordis event map, so the listener surface is stated here.
  const events = ctx as unknown as {
    on(name: string, listener: (...args: readonly unknown[]) => void): () => void
  }
  for (const event of MCP_ROW_EVENTS) {
    ctx.effect(() => events.on(event, (...args) => {
      if (event === 'loader/entry-init') {
        // Loader emits this before assigning parent/options. Observe on the
        // next microtask, not synchronously against an empty entry.
        queueMicrotask(() => { mountReader.observe(args[0]); resync() })
        return
      }
      if (event === 'internal/status') {
        const fiber = args[0] as { entry?: { options?: { name?: string } } } | undefined
        const moduleName = fiber?.entry?.options?.name
        if (moduleName !== MCP_CLIENT_MODULE && moduleName !== AGENT_PRESET_MODULE) return
      }
      resync()
    }), `mcp-manager: gate follows ${event}`)
  }
  await gate.reconcile()
  await active.current?.refresh()
  /**
   * Warn once per commit when rules cannot take effect, in either of the two
   * ways a row can bypass this plugin's carriers: `eager` mounts every allowed
   * row through mcp-client, and a global row is mounted that way whatever the
   * mode. Both publish all discovered tools, so a rule there is silently useless
   * otherwise.
   */
  const warnFiltersWithoutEffect = (next: McpSettingsFlags): void => {
    const configured = Object.entries(next.tools)
      .filter(([, value]) => filterHidesAnything(parseMcpToolFilter(value)))
      .map(([key]) => key)
    if (configured.length === 0) return
    if (mcpLoading === 'eager') {
      ctx.logger.warn(
        `mcp-manager: MCP loading is "eager", so the tool filters for ${configured.join(', ')} have no effect. `
        + 'eager mounts every enabled row through mcp-client, which registers all discovered tools; '
        + 'select the "dynamic" or "lazy" loading mode to apply these filters.',
      )
      return
    }
    const globalRules = configured.filter(key => key.startsWith('global:'))
    if (globalRules.length === 0) return
    ctx.logger.warn(
      `mcp-manager: the tool filters for ${globalRules.join(', ')} have no effect. `
      + 'A global row is mounted by the composition, which registers all of its discovered tools; '
      + 'author the row inside an agent preset to filter it.',
    )
  }
  // A committed live field is the only way the mode, a filter, or an
  // optimization switch changes at runtime; the Loader commits every volatile
  // reference before it fires.
  const commit = async (): Promise<void> => {
    const next = readSettings()
    const mode = parseMcpLoadingMode(next.loading)
    const policy = parseMcpOptimizeFlags(next.optimize)
    // Most of the policy is read live by the running registration. The one part
    // that cannot be is whether `mcp_search` exists at all — a registered tool
    // set is what the request prefix carries — so the whole registration is
    // rebuilt when that answer changes, exactly as it is for the loading mode.
    const nextKey = `${mode}|${mcpRegistrationKey(policy)}`
    if (nextKey !== registrationKey) {
      await external.transition(
        async () => { await active.current?.dispose(); mcpLoading = mode },
        async () => {
          const registration = activate(mode)
          await registration.refresh()
          await gate.reconcile()
          await registration.refresh()
        },
      )
      registrationKey = nextKey
    }
    warnFiltersWithoutEffect(next)
  }
  let commits: Promise<void> = Promise.resolve()
  ctx.effect(() => ctx.on('loader/volatile-update', () => {
    commits = commits.then(commit, commit).catch(error => { ctx.logger.warn(`mcp-manager: settings reload failed: ${String(error)}`) })
  }), 'mcp-manager: settings commits')
  readToolFilter = key => parseMcpToolFilter(readSettings().tools[key])
  warnFiltersWithoutEffect(readSettings())
}
