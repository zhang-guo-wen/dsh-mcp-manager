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

import type { Context, Fiber } from '@deepseek-ai/cordis'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'
import { McpManager } from './mcp-remote.ts'
import { parseMcpLoadingMode, registerMcpTools } from './lazy-mcp.ts'
import { createMcpPreloadGate, MCP_ROW_EVENTS, resolvePresetMounts, type GateMount } from './mcp-gate.ts'
import { MCP_CLIENT_MODULE } from './mcp-authoring.ts'
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
export type { McpLoadingMode } from './lazy-mcp.ts'
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
  const mountReader = await resolvePresetMounts(
    ctx,
    within => livePresetMounts(within as Fiber | undefined) as readonly GateMount[],
  )
  const gate = createMcpPreloadGate(ctx, () => mcpLoading, mountReader, (message) => { ctx.logger.warn(message) })
  // The tool registration holds these closures rather than snapshots, so a
  // committed rule or description change applies to the next `mcp_load` and to
  // the next inventory refresh without re-registering anything. Loaded servers
  // keep the tools they were admitted with.
  let readToolFilter: (key: string) => McpToolFilter = () => NO_TOOL_FILTER
  const readers = {
    filterFor: (key: string): McpToolFilter => readToolFilter(key),
    descriptionFor: (key: string): string | undefined => readSettings().descriptions[key],
  }
  let mcpTools = registerMcpTools(ctx, mcpLoading, gate, readers)
  ctx.effect(() => () => { mcpTools.dispose(); gate.dispose() }, 'mcp-manager: mcp tools')
  // The gate's answer is what the inventory lists, so every reconcile is
  // followed by a refresh: the prompt section is served from a snapshot and
  // cannot await anything while the request is assembled.
  const resync = (): void => { void gate.reconcile().then(() => mcpTools.refresh()) }
  // A preset mounts its rows when a session first selects it and re-mounts them
  // whenever the composition file changes; both come back through these events,
  // which is what keeps the gate's answer true across a session's lifetime.
  // `agent-preset/selected` is emitted on the context without a declaration in
  // the Cordis event map, so the listener surface is stated here.
  const events = ctx as unknown as {
    on(name: string, listener: (...args: readonly unknown[]) => void): () => void
  }
  for (const event of MCP_ROW_EVENTS) {
    ctx.effect(() => events.on(event, (...args) => {
      if (event === 'loader/entry-init') {
        const entry = args[0] as { options?: { name?: string } } | undefined
        if (entry?.options?.name !== MCP_CLIENT_MODULE) return
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
  // A committed live field is the only way the mode or a filter changes at
  // runtime; the Loader commits every volatile reference before it fires.
  const commit = (): void => {
    const next = readSettings()
    const mode = parseMcpLoadingMode(next.loading)
    if (mode !== mcpLoading) {
      mcpLoading = mode
      mcpTools.dispose()
      mcpTools = registerMcpTools(ctx, mode, gate, readers)
      resync()
    }
    warnFiltersWithoutEffect(next)
  }
  ctx.effect(() => ctx.on('loader/volatile-update', () => { commit() }), 'mcp-manager: settings commits')
  readToolFilter = key => parseMcpToolFilter(readSettings().tools[key])
  warnFiltersWithoutEffect(readSettings())

  // MCP authoring Remote: register the `mcpManager` Typert service so the
  // browser half can mount it with `ctx.remote.$mount`. The service resolves
  // the Loader lazily inside its methods, so it must be created unconditionally
  // (a Loader-presence guard here would skip registration when the service is
  // not yet ready and the client would 404 on every MCP mutation).
  new McpManager(ctx, gate, mountReader)
}
