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
 * @module @zhang-guo-wen/dsh-mcp-manager
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import { McpManager } from './mcp-remote.ts'
import { parseMcpLoadingMode, registerMcpTools, type McpLoadingMode } from './lazy-mcp.ts'
import { createMcpPreloadGate, MCP_ROW_EVENTS, resolvePresetMounts, type GateMount } from './mcp-gate.ts'
import { MCP_CLIENT_MODULE } from './mcp-authoring.ts'
import {
  filterHidesAnything,
  NO_TOOL_FILTER,
  parseMcpToolFilter,
  type McpToolFilter,
} from './mcp-tool-filter.ts'
import {
  registerMcpSettings,
  type McpSettingsConfig,
  type McpSettingsFlags,
} from './settings.ts'

export { McpManager } from './mcp-remote.ts'
export { assertServerName, mcpEntryConfig, specFromEntryConfig } from './mcp-config.ts'
export { MCP_LOADING_MODES, parseMcpLoadingMode, registerMcpTools } from './lazy-mcp.ts'
export type { McpLoadingMode } from './lazy-mcp.ts'
export { admits, filterHidesAnything, filterMcpTools, parseMcpToolFilter, toolRuleEntries } from './mcp-tool-filter.ts'
export type { McpToolFilter, McpToolSelection } from './mcp-tool-filter.ts'
export { mcpRowKey } from './mcp-gate.ts'
export type { McpPreloadGate, McpRowGateState } from './mcp-gate.ts'
export { MCP_SETTINGS_NAMESPACE, registerMcpSettings } from './settings.ts'
export type { McpSettingsConfig, McpSettingsFlags, McpSettingsSource } from './settings.ts'
export type { McpSpec, McpTarget } from './types.ts'
export type { McpEntryConfig, McpTransportConfig } from './mcp-config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Services required by this plugin. Every other service is probed lazily. */
export const inject = ['loader']

/** Config forwarded to the settings namespace and the preload gate. */
export interface Config extends McpSettingsConfig {
  /**
   * How MCP servers load: `eager` (every enabled row mounts at preset mount),
   * `dynamic` (on-demand tools mount a server into the calling session; the
   * tool list changes once per load) or `lazy` (on-demand tools talk to the
   * server without registering, so the tool list never changes).
   */
  mcpLoading?: McpLoadingMode
}

export const Config: Schema<Config> = z.object({
  mcpLoading: z.union(['eager', 'dynamic', 'lazy']).default('dynamic'),
})

/**
 * Register the on-demand MCP tools, the preload gate that follows the loading
 * mode, the `mcp-manager` settings namespace, and the `mcpManager` Remote.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // MCP loading has two inputs. The user's composition says which servers may
  // be used at all; the mode says whether an allowed server also takes part in
  // every request. The gate holds the composed rows to that second answer, and
  // the tool set is re-registered with the new mode on every commit.
  let mcpLoading = parseMcpLoadingMode(config.mcpLoading)
  const mountReader = await resolvePresetMounts(
    ctx,
    within => livePresetMounts(within as Fiber | undefined) as readonly GateMount[],
  )
  const gate = createMcpPreloadGate(ctx, () => mcpLoading, mountReader, (message) => { ctx.logger.warn(message) })
  // The tool registration holds this closure rather than a snapshot, so a
  // committed rule change applies to the next `mcp_load` without re-registering
  // anything. Loaded servers keep the tools they were admitted with.
  let readToolFilter: (key: string) => McpToolFilter = () => NO_TOOL_FILTER
  let disposeMcpTools = registerMcpTools(ctx, mcpLoading, gate, key => readToolFilter(key))
  ctx.effect(() => () => { disposeMcpTools(); gate.dispose() }, 'mcp-manager: mcp tools')
  const resync = (): void => { void gate.reconcile() }
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
  /**
   * Warn once per commit when rules cannot take effect. `eager` mounts every
   * allowed row through mcp-client, whose registration publishes all discovered
   * tools, so a filter configured for that mode is silently useless otherwise.
   */
  const warnFiltersWithoutEffect = (next: McpSettingsFlags): void => {
    if (mcpLoading !== 'eager') return
    const configured = Object.entries(next.tools)
      .filter(([, value]) => filterHidesAnything(parseMcpToolFilter(value)))
      .map(([key]) => key)
    if (configured.length === 0) return
    ctx.logger.warn(
      `mcp-manager: MCP loading is "eager", so the tool filters for ${configured.join(', ')} have no effect. `
      + 'eager mounts every enabled row through mcp-client, which registers all discovered tools; '
      + 'select the "dynamic" or "lazy" loading mode to apply these filters.',
    )
  }
  // Only forward the field the namespace reads: under `exactOptionalPropertyTypes`
  // an optional property does not accept an explicitly `undefined` value.
  const flags = registerMcpSettings(ctx, config.mcpLoading === undefined ? {} : { loading: config.mcpLoading }, (next) => {
    const mode = parseMcpLoadingMode(next.loading)
    if (mode !== mcpLoading) {
      mcpLoading = mode
      disposeMcpTools()
      disposeMcpTools = registerMcpTools(ctx, mode, gate, key => readToolFilter(key))
      resync()
    }
    warnFiltersWithoutEffect(next)
  })
  readToolFilter = key => parseMcpToolFilter(flags().tools[key])
  warnFiltersWithoutEffect(flags())

  // MCP authoring Remote: register the `mcpManager` Typert service so the
  // browser half can mount it with `ctx.remote.$mount`. The service resolves
  // the Loader lazily inside its methods, so it must be created unconditionally
  // (a Loader-presence guard here would skip registration when the service is
  // not yet ready and the client would 404 on every MCP mutation).
  new McpManager(ctx, gate)
}
