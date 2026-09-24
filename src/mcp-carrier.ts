/**
 * How one loaded MCP row's tools reach the model: the carrier decision and the
 * native registration primitives.
 *
 * The loading mode owns the carrier. `dynamic` gives the model real tool
 * schemas — and pays a prefix invalidation per load — while `lazy` keeps every
 * tool out of the request and serves it through the proxy. A row's filter only
 * narrows the visible set inside that decision, which is why a filtered
 * `dynamic` row registers its VISIBLE tools natively here instead of falling
 * back to the proxy: the harness mount cannot hold individual tools back, but
 * the plugin can hold them back by never building them.
 *
 * This module is pure policy plus registration primitives; the connect,
 * lifetime, and re-sync machinery lives in `lazy-mcp.ts`, which imports from
 * here. The `McpLoadingMode` import below is type-only, so the runtime
 * dependency runs one way.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-carrier
 */

import type { Context } from '@deepseek-ai/cordis'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-mcp-client'
import type { McpLoadingMode } from './lazy-mcp.ts'
import { filterHidesAnything, type McpToolFilter } from './mcp-tool-filter.ts'
import { mcpToolPublicName } from './mcp-tool-name.ts'

/** How one loaded row's tools reach the model once a session loads it. */
export type McpCarrier = 'mount' | 'native' | 'proxy'

/** One MCP tool as the SDK client reports it. */
export interface LazyTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
  /** Advertised structured-output schema, forwarded to the definition adapter. */
  readonly outputSchema?: unknown
  /** Upstream execution metadata; a `required` task support is unsupported here. */
  readonly execution?: { readonly taskSupport?: string }
}

/** The subset of the MCP SDK client the carriers use. */
export interface LazyClient {
  listTools(): Promise<{ tools?: readonly LazyTool[] }>
  /**
   * Call one upstream tool.
   * @param request - upstream tool name and arguments.
   * @param resultSchema - SDK result-schema override; omitted to use the default.
   * @param options - per-call request options; the native carrier forwards the
   *   caller's cancellation signal here.
   * @returns the raw MCP result.
   */
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  close(): Promise<void>
  /**
   * Listener for notifications this client has no dedicated handler for. The
   * native carrier assigns it to follow `notifications/tools/list_changed`.
   */
  fallbackNotificationHandler?: (notification: { readonly method?: string }) => Promise<void>
}

/** The tool registry surface the native carrier uses. */
export interface ToolRegistry {
  register(definition: unknown): () => void
  schemas(scope?: unknown): readonly { readonly name: string }[]
}

/** Builds one harness tool definition from one upstream tool. */
export type McpToolAdapter = (ctx: Context, options: McpToolDefinitionOptions) => unknown

/**
 * Choose one on-demand mode's carrier.
 *
 * The mode owns this decision: it is what decides whether the model argues from
 * real tool schemas — and pays a prefix invalidation per load — or calls
 * through the proxy and pays arguments copied out of a result. A row's filter
 * only narrows the visible set inside that decision.
 * @param mode - the loading mode a session committed to.
 * @param filter - the row's resolved rules.
 * @returns `proxy` under `lazy`; under `dynamic`, `native` when the rules hide
 *   anything and `mount` when they hide nothing; `undefined` under `eager`,
 *   which mounts every allowed row and registers no on-demand tool at all.
 */
export function carrierFor(mode: McpLoadingMode, filter: McpToolFilter): McpCarrier | undefined {
  if (mode === 'eager') return undefined
  if (mode === 'lazy') return 'proxy'
  return filterHidesAnything(filter) ? 'native' : 'mount'
}

/**
 * The name the model calls one visible tool by.
 *
 * A `proxy` row is called by its upstream name through `mcp_call`; every
 * carrier that registers tools natively is called by the model-facing public
 * name, so `mcp_load` must report that same name or the model would be handed a
 * name no tool answers to.
 * @param carrier - the carrier that exposed the tool.
 * @param serverName - the row's namespace.
 * @param rawName - the tool's upstream name.
 * @returns the reported and callable name for this (carrier, serverName, tool).
 */
export function visibleToolName(carrier: McpCarrier, serverName: string, rawName: string): string {
  return carrier === 'proxy' ? rawName : mcpToolPublicName(serverName, rawName)
}

/**
 * The upstream input schema as the definition adapter accepts it.
 * @param schema - the schema the server advertised for one tool.
 * @returns that schema, or an annotation-only one when the server declared none.
 */
function toolInputSchema(schema: unknown): Record<string, unknown> {
  return schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {}
}

/**
 * Build one generation of native tool definitions for a server's visible tools.
 *
 * Every definition comes from the harness's own adapter, so a filtered row's
 * tools bind arguments, validate results, and project images exactly as a
 * mounted row's do — the difference is only that the hidden tools are never
 * built. Building is pure: nothing is registered, so a failure here leaves the
 * session's current generation untouched.
 * @param ctx - the session context the definitions resolve services through.
 * @param adapter - the harness `createMcpToolDefinition` export.
 * @param serverName - the row's namespace.
 * @param visible - the tools the row's rules admit, in the server's own order.
 * @param client - the connected SDK client every definition forwards to.
 * @returns definitions keyed by model-facing public name.
 * @throws when the server lists one raw name twice, which would collapse two
 *   distinct tools onto a single public name.
 */
export function nativeDefinitions(
  ctx: Context,
  adapter: McpToolAdapter,
  serverName: string,
  visible: readonly LazyTool[],
  client: LazyClient,
): Map<string, unknown> {
  const definitions = new Map<string, unknown>()
  for (const tool of visible) {
    const name = mcpToolPublicName(serverName, tool.name)
    if (definitions.has(name)) {
      throw new Error(`MCP server "${serverName}" listed tool "${tool.name}" more than once — invalid tool list`)
    }
    definitions.set(name, adapter(ctx, {
      name,
      rawName: tool.name,
      description: tool.description ?? '',
      inputSchema: toolInputSchema(tool.inputSchema),
      ...tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema },
      ...tool.execution?.taskSupport === 'required' ? { taskRequired: true } : {},
      call: (args, execution) => client.callTool(
        { name: tool.name, arguments: args },
        undefined,
        { signal: execution.signal },
      ),
    }))
  }
  return definitions
}

/**
 * Swap one generation of native registrations.
 *
 * New names register before anything is disposed, and a name that survives the
 * swap keeps its registration — so the model's tool list, and the request
 * prefix carrying it, changes only where the server did. A rejected
 * registration unwinds the names this swap added and rethrows, leaving the
 * previous generation registered: the same all-or-nothing contract `mcp-client`
 * follows for its own generations.
 * @param registry - the session-scoped tool registry.
 * @param current - the registrations this mount owns right now.
 * @param definitions - the next generation, keyed by public name.
 * @returns the registrations the mount owns after a successful swap.
 */
export function swapNativeTools(
  registry: ToolRegistry,
  current: ReadonlyMap<string, () => void>,
  definitions: ReadonlyMap<string, unknown>,
): Map<string, () => void> {
  const next = new Map<string, () => void>()
  const added: string[] = []
  try {
    for (const [name, definition] of definitions) {
      const existing = current.get(name)
      if (existing !== undefined) {
        next.set(name, existing)
        continue
      }
      next.set(name, registry.register(definition))
      added.push(name)
    }
  } catch (error) {
    for (const name of added) next.get(name)?.()
    throw error
  }
  for (const [name, dispose] of current) {
    if (!next.has(name)) dispose()
  }
  return next
}
