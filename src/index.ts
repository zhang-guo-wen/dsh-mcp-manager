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
import { parseMcpLoadingMode, registerMcpTools, resolveMcpClient } from './lazy-mcp.ts'
import type { LazyTool } from './mcp-carrier.ts'
import { McpCatalog } from './mcp-catalog.ts'
import {
  mcpRegistrationKey,
  parseMcpOptimizeFlags,
  type McpOptimizeFlags,
} from './mcp-optimize.ts'
import { ExternalMcpRegistry, type ScopeLookup } from './external-mcp.ts'
import { createMcpPreloadGate, MCP_ROW_EVENTS } from './mcp-gate.ts'
import { createPresetMountReader, type PresetScopeLookup } from './preset-mounts.ts'
import { MCP_CLIENT_MODULE } from './mcp-authoring.ts'
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
export { scanClaudeMcp } from './claude-import.ts'
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
export type {
  ClaudeMcpEntry,
  ClaudeMcpProblem,
  ClaudeMcpSource,
  ClaudeMcpSourceLabel,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
} from './types.ts'
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
  const mountReader = createPresetMountReader(ctx, scopes)
  ctx.effect(() => () => { mountReader.dispose() }, 'mcp-manager: preset mount reader')
  const gate = createMcpPreloadGate(ctx, () => mcpLoading, mountReader, (message) => { ctx.logger.warn(message) })
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
      await mcpTools.dispose()
      mcpTools = registerMcpTools(ctx, mcpLoading, gate, readers, external, catalog)
      await mcpTools.refresh()
    },
    scopes,
  )
  // Register the Remote service before any inventory refresh. Preset rows may
  // depend on it, and activation-sensitive registry diagnostics are never read.
  new McpManager(ctx, gate, mountReader, external, () => mcpLoading, catalog)
  let mcpTools = registerMcpTools(ctx, mcpLoading, gate, readers, external, catalog)
  /** The registered tool set's identity: what a re-registration is keyed on. */
  let registrationKey = `${mcpLoading}|${mcpRegistrationKey(readers.optimize())}`
  ctx.effect(() => async () => { await external.dispose(async () => { await mcpTools.dispose(); gate.dispose() }) }, 'mcp-manager: mcp tools')
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
          await mcpTools.refresh()
        }
      } catch (error) {
        ctx.logger.warn(`mcp-manager: row synchronization failed: ${String(error)}`)
      } finally { syncing = false }
    })()
  }
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
  await mcpTools.refresh()
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
        async () => { await mcpTools.dispose(); mcpLoading = mode },
        async () => {
          mcpTools = registerMcpTools(ctx, mode, gate, readers, external, catalog)
          await gate.reconcile()
          await mcpTools.refresh()
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
