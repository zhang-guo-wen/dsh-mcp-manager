/**
 * On-demand MCP loading, in two modes.
 *
 * A deployment keeps MCP servers out of every request's tool list by leaving
 * their composition rows unmounted, then pulls one in when it is actually
 * needed. `mcp_load` starts one server, `mcp_unload` lets the calling session
 * release it, and the servers a session may pick from are published in the
 * system prompt rather than in a listing tool (see `mcp-inventory.ts`), so the
 * tool set stays `mcp_load` + `mcp_unload` under `dynamic` and adds `mcp_call`
 * under `lazy`.
 *
 * The mode decides how a loaded server reaches the model:
 *
 * - `dynamic` registers the server's visible tools natively in the CALLING
 *   AGENT's scope — best tool binding, but the tool list changes once per load.
 * - `lazy` talks to the MCP server over the SDK WITHOUT registering anything:
 *   `mcp_load` returns the tool schemas as its result and the model calls them
 *   through the fixed `mcp_call` proxy. The tool list never changes, so the
 *   request-cache prefix is never invalidated.
 *
 * A filter narrows what a load exposes: `dynamic` registers the row's VISIBLE
 * tools itself through the harness's own `createMcpToolDefinition` adapter, so
 * those tools keep their upstream schemas — the model argues from the real
 * schema in every request — while the hidden ones are never registered at all.
 * A row's `context-injection.mcpTools` rules narrow what a load exposes in
 * every carrier: a hidden tool is neither listed nor callable.
 *
 * The connection itself belongs to neither mode and to no session: it lives in
 * the host-level pool (`mcp-pool.ts`) until the last session that loaded it
 * releases its claim. A second session loading the same server reuses that
 * connection instead of paying for another process, which is also why this
 * module never mounts the harness's `mcp-client` plugin: that plugin connects
 * once per scope, so a per-session mount would mean a per-session process.
 * Tool definitions still come from the harness's own
 * `createMcpToolDefinition`, so a row's tools bind arguments, validate results,
 * and project images exactly as a mounted row's do. The cost of not mounting is
 * the server's own instructions and the `mcp-resources` tools, which the
 * harness registers per mount.
 *
 * ## The context-budget layer
 *
 * The three modes answer *whether* a server's tools enter a request. What enters
 * once one is loaded is the optimization policy's answer (`mcp-optimize.ts`),
 * and this module is where it is enforced:
 *
 * - **`tools/list` is walked cursor by cursor.** The SDK's `listTools` returns
 *   one page, the spec makes the page size the server's choice, and defines
 *   end-of-list as a missing `nextCursor` — an empty string is a valid cursor.
 *   {@link listAllTools} follows that contract up to a cap.
 * - **A query narrows a load.** `mcp_load` with `query` (or `tool`) admits only
 *   the matching tools, which is the client-side half of the progressive
 *   discovery the MCP client best-practices guide prescribes.
 * - **A listing is paged.** `cursor`/`limit` control what a result puts in the
 *   conversation without changing what the session may call.
 * - **A tool can be listed by name alone.** Under `namesOnly` a result carries
 *   names and descriptions; the arguments schema comes back for the one tool the
 *   model asks for by name.
 * - **Discovery is remembered.** {@link McpCatalog} keeps what each server
 *   published, so `mcp_search` can answer without starting a process and a
 *   `tools/list_changed` invalidates exactly the server that changed.
 *
 * @module @guowenzhang/dsh-mcp-manager/lazy-mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-mcp-client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import { MCP_CLIENT_MODULE } from './mcp-authoring.ts'
import { McpCatalog } from './mcp-catalog.ts'
import {
  annotationSummary,
  applyAnnotationPolicy,
  matchTools,
  MCP_OPTIMIZE_DEFAULTS,
  MCP_PAGE_SIZE_RANGE,
  paginateTools,
  toolMatchesQuery,
  type McpOptimizeFlags,
} from './mcp-optimize.ts'
import {
  carrierFor,
  nativeDefinitions,
  swapNativeTools,
  visibleToolName,
  type LazyClient,
  type LazyTool,
  type McpCarrier,
  type McpToolAdapter,
  type ToolRegistry,
} from './mcp-carrier.ts'
import { mcpEntryConfig, specFromEntryConfig, type McpEntryConfig } from './mcp-config.ts'
import { describeMcpConfigIssues, diagnoseRowConfig } from './mcp-diagnostics.ts'
import type { McpPreloadGate } from './mcp-gate.ts'
import { mcpRowKey } from './mcp-gate.ts'
import { renderMcpInventory } from './mcp-inventory.ts'
import type { PooledConnection, PoolKey } from './mcp-pool.ts'
import { connectionFingerprint, type McpConnectionPool } from './mcp-pool.ts'
import type { ExternalMcpRegistry } from './external-mcp.ts'
import {
  filterMcpTools,
  NO_TOOL_FILTER,
  type McpToolFilter,
} from './mcp-tool-filter.ts'
import type { McpSpec, McpTarget } from './types.ts'

/** How a configured-but-stopped MCP server reaches the model once loaded. */
export type McpLoadingMode = 'eager' | 'dynamic' | 'lazy'

/** Every {@link McpLoadingMode}, used to validate the persisted setting. */
export const MCP_LOADING_MODES: readonly McpLoadingMode[] = ['eager', 'dynamic', 'lazy']

/**
 * Narrow one stored `mcpLoading` value. The settings document is a durable,
 * user-editable file, so an unknown value falls back to `dynamic` instead of
 * failing the commit that carried it.
 * @param value - raw value read from the settings namespace or the plugin config.
 * @returns the matching mode, or `dynamic` when nothing matches.
 */
export function parseMcpLoadingMode(value: unknown): McpLoadingMode {
  return MCP_LOADING_MODES.includes(value as McpLoadingMode) ? value as McpLoadingMode : 'dynamic'
}

/** One configured mcp-client row and where its composition lives. */
interface McpRow {
  readonly target: McpTarget
  readonly entryId: string
  readonly serverName: string
  /** Settings key for this row, shared with the description map and the UI. */
  readonly key: string
  readonly scopeLabel: string
  readonly enabled: boolean
  readonly presetScope?: object
  readonly presetConfig?: unknown
  readonly externalConfig?: McpEntryConfig
  readonly externalScope?: object
  readonly externalKind?: 'global' | 'agent'
  readonly externalDescription?: string
  /** The preload gate holds this row back before its plugin ever runs. */
  readonly held?: boolean
}

/** The mcp-client host plugin object, resolved from the harness module graph. */
interface McpClientModule {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: Context, config: unknown): void | Promise<void>
  /**
   * The harness's upstream-tool adapter. Every dynamic-mode load builds its
   * definitions with it, so a row's tools keep the same argument binding,
   * canonical result, error, and image projection as a mounted one. Absent only
   * on a harness build older than the adapter: the load fails loud there rather
   * than registering weaker definitions.
   */
  createMcpToolDefinition?(ctx: Context, options: McpToolDefinitionOptions): unknown
}

/** One session's use of a pooled connection: what it registered, and its filter. */
interface LoadedView {
  readonly rowKey: string
  readonly carrier: 'native' | 'proxy'
  readonly connection: PooledConnection
  /** Rules this view was admitted with; a re-sync recomputes the same set. */
  readonly filter: McpToolFilter
  /** The tools this session may call, in the server's own order. */
  tools: readonly LazyTool[]
  hidden: number
  /** Live registrations by public name; empty under `proxy`. */
  definitions: Map<string, () => void>
  /** Whether the server's own listing was cut short by the collection cap. */
  truncated: boolean
  /** The subset this view was loaded with, or undefined when it took everything. */
  admits?: ToolNarrowing
  /** The in-flight `tools/list_changed` re-sync for this view, if any. */
  resyncing?: Promise<void>
}

/**
 * Whether one discovered tool belongs to the subset a load asked for.
 *
 * A load narrows either by `query` (lexical match) or by `tool` (one name); a
 * view that was never narrowed carries no predicate and admits every tool the
 * row's rules left visible.
 */
type ToolNarrowing = (tool: LazyTool) => boolean

/** The last `:`-separated segment of a loader-qualified row id. */
function leafId(id: string): string {
  const separator = id.lastIndexOf(':')
  return separator < 0 ? id : id.slice(separator + 1)
}

/** Resolve the mcp-client plugin from the Loader's module graph (same instance the composition mounts). */
export async function resolveMcpClient(ctx: Context): Promise<McpClientModule> {
  const loader = ctx.get('loader') as
    | { internal?: { import(spec: string, base: string, options: object): Promise<unknown> } }
    | undefined
  const base = (ctx as unknown as { baseUrl?: string }).baseUrl
  if (loader?.internal !== undefined && base !== undefined) {
    try {
      const mod = await loader.internal.import(MCP_CLIENT_MODULE, base, {}) as McpClientModule
      if (typeof mod.apply === 'function') return mod
    } catch {
      // Swallows only the internal-resolver miss; the plain import below is the
      // fallback and reports its own failure if the package is absent.
    }
  }
  return await import('@deepseek-ai/dsh-mcp-client') as McpClientModule
}

/** Nonblocking declaration/status read: never calls the registry activation audit. */
export function listMcpRows(ctx: Context, gate: McpPreloadGate, external?: ExternalMcpRegistry): McpRow[] {
  const rows: McpRow[] = []
  // Global rows live in whichever tree the composition put them in — a
  // file-backed include's subtree, a nested group there, or the root tree when a
  // patch layer inserted them — so the gate walks all of those. The root list is
  // read as well for a row the gate's walk cannot reach, and the two scans are
  // joined on the leaf id the gate reports.
  const globals = new Set<string>()
  for (const row of gate.globalRows?.() ?? []) {
    globals.add(row.entryId)
    rows.push({
      target: { scope: 'global' },
      entryId: row.entryId,
      serverName: row.entryId,
      key: mcpRowKey({ scope: 'global' }, row.entryId),
      scopeLabel: 'global',
      enabled: row.enabled,
      ...(row.held ? { held: true } : {}),
    })
  }
  const loader = ctx.get('loader') as
    | { entries(): Iterable<{ id: string; disabled?: boolean; options: { name?: string; group?: boolean } }> }
    | undefined
  for (const entry of loader?.entries() ?? []) {
    if (entry.options.group === true || entry.options.name !== MCP_CLIENT_MODULE) continue
    const serverName = leafId(entry.id)
    // The same row answers to its qualified id and its leaf id; comparing the
    // raw ids would report it twice.
    if (globals.has(serverName)) continue
    rows.push({
      target: { scope: 'global' },
      entryId: entry.id,
      serverName,
      key: mcpRowKey({ scope: 'global' }, serverName),
      scopeLabel: 'global',
      enabled: entry.disabled !== true,
    })
  }
  const revisions = gate.presetRows?.() ?? []
  for (const preset of revisions) {
    for (const row of preset.rows) {
      const serverName = leafId(row.entryId)
      const target: McpTarget = { scope: 'preset', agentPreset: preset.presetId }
      rows.push({
        target, entryId: row.entryId, serverName, key: mcpRowKey(target, serverName),
        scopeLabel: `preset ${preset.presetId}`, enabled: row.allowed,
        ...(preset.scope === undefined ? {} : { presetScope: preset.scope }), presetConfig: row.config,
      })
    }
  }
  // Unpublished/disabled presets remain visible in the settings roster, but
  // cannot authorize a session load without a retained generation scope.
  for (const row of external?.rows() ?? []) rows.push({
    target: { scope: 'global' },
    entryId: row.owner,
    serverName: row.serverName,
    key: `external:${row.owner}:${row.serverName}`,
    scopeLabel: row.owner,
    enabled: true,
    externalConfig: row.config,
    externalKind: row.scope,
    ...(row.description === undefined ? {} : { externalDescription: row.description }),
    ...(row.scopeKey === undefined ? {} : { externalScope: row.scopeKey }),
  })
  return rows
}

/** Read one row's connection spec through the authoring owner. */
async function describeRow(ctx: Context, row: McpRow): Promise<McpSpec> {
  const owner = ctx.get('mcpManager') as
    | { describeMcp(request: { target: McpTarget; entryId: string }): Promise<{ spec: McpSpec }> }
    | undefined
  if (owner === undefined) throw new Error('mcp_load requires the mcpManager service')
  if (row.presetConfig !== undefined) return specFromEntryConfig(row.presetConfig as McpEntryConfig)
  return (await owner.describeMcp({ target: row.target, entryId: row.entryId })).spec
}

/** The tool names one server published into an agent's scope (dynamic mode). */
function toolNamesFor(tools: ToolRegistry, agentCtx: Context, serverName: string, external?: ExternalMcpRegistry): string[] {
  const prefix = `mcp__${serverName}__`
  return tools.schemas(external ? external.scopeOf(agentCtx) : scopeOf(agentCtx)).map(schema => schema.name).filter(name => name.startsWith(prefix))
}

/** How many `tools/list` pages one discovery walk follows before it gives up. */
const MAX_TOOL_PAGES = 64

/** How many servers one search may connect at once while indexing them. */
const SEARCH_INDEX_CONCURRENCY = 3

/** How long one indexing connection may take before its server is left unindexed. */
const SEARCH_INDEX_TIMEOUT_MS = 8_000

/** One discovery walk's result: the tools, and what the walk could not see. */
export interface McpDiscovery {
  /** The tools that were collected, in the server's own order. */
  readonly tools: readonly LazyTool[]
  /** Whether the walk stopped at a cap or page budget instead of end-of-list. */
  readonly truncated: boolean
  /** The server's own freshness hint for the listing, when it published one. */
  readonly ttlMs?: number
}

/**
 * Walk every page of one server's `tools/list`.
 *
 * The spec makes the page size the server's business and defines end-of-list as
 * a missing `nextCursor`; an empty string is a valid cursor and must be passed
 * back rather than read as the end. The walk stops at `maxTools` or at
 * {@link MAX_TOOL_PAGES}, and reports that it did, so a listing can say it saw
 * only part of what the server publishes.
 * @param client - the connected SDK client.
 * @param maxTools - how many tools the walk may collect.
 * @returns the collected tools, whether the walk was cut short, and the
 *   server's `ttlMs` hint when it sent one.
 */
export async function listAllTools(client: LazyClient, maxTools: number): Promise<McpDiscovery> {
  const tools: LazyTool[] = []
  let cursor: string | undefined
  let ttlMs: number | undefined
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const listed = await client.listTools(cursor === undefined ? undefined : { cursor })
    if (ttlMs === undefined && listed.ttlMs !== undefined) ttlMs = listed.ttlMs
    let full = false
    for (const tool of listed.tools ?? []) {
      if (tools.length >= maxTools) {
        full = true
        break
      }
      tools.push(tool)
    }
    const next = listed.nextCursor
    if (full || next === undefined) {
      return { tools, truncated: full, ...ttlMs === undefined ? {} : { ttlMs } }
    }
    cursor = next
  }
  return { tools, truncated: true, ...ttlMs === undefined ? {} : { ttlMs } }
}

/**
 * Connect one configured server through the MCP SDK without registering anything.
 * @param config - the row's resolved transport and namespace.
 * @param options - the discovery budget; `maxTools` defaults to the policy's cap.
 * @returns the connected client and the tools the server published. The caller
 *   owns the client and must close it.
 */
export async function connectLazy(
  config: McpEntryConfig,
  options: { readonly maxTools?: number } = {},
): Promise<{ client: LazyClient; tools: readonly LazyTool[]; truncated: boolean; ttlMs?: number }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js') as {
    Client: new (info: { name: string; version: string }) => LazyClient & { connect(transport: unknown): Promise<void> }
  }
  let transport: unknown
  if (config.transport === 'stdio') {
    // The SDK's own transport options do not overlap this structural cast, so
    // it goes through `unknown`.
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js') as unknown as {
      StdioClientTransport: new (options: Record<string, unknown>) => unknown
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...process.env, ...config.env },
      ...(config.cwd === '' ? {} : { cwd: config.cwd }),
      stderr: 'ignore',
    })
  } else {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
      StreamableHTTPClientTransport: new (url: URL, options?: Record<string, unknown>) => unknown
    }
    transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      Object.keys(config.headers).length === 0 ? {} : { requestInit: { headers: config.headers } },
    )
  }
  const client = new Client({ name: '@guowenzhang/dsh-mcp-manager', version: '0.1' })
  await client.connect(transport)
  return { client, ...(await listAllTools(client, options.maxTools ?? MCP_OPTIMIZE_DEFAULTS.maxTools)) }
}

/**
 * Every tool one row admits: its rules, the load's narrowing, and the policy.
 *
 * `visible` is what the row's rules and the annotation policy let through at
 * all, and `admitted` is the subset the load itself asked for. A view keeps
 * both: `visible` because a later load may widen into it, and `admitted` because
 * that is what the session may actually call. `hidden` counts everything the
 * session cannot call right now — both the rules' exclusions and the ones this
 * load did not ask for — because that is the number the result reports.
 * @param tools - the server's discovered tools.
 * @param filter - the row's parsed rules.
 * @param narrowing - the load's own subset, or undefined when it took everything.
 * @param policy - the resolved optimization policy.
 * @returns the visible set, the admitted subset, and how many tools are out.
 */
function admittedTools(
  tools: readonly LazyTool[],
  filter: McpToolFilter,
  narrowing: ToolNarrowing | undefined,
  policy: McpOptimizeFlags,
): { readonly visible: readonly LazyTool[]; readonly admitted: readonly LazyTool[]; readonly hidden: number } {
  const byRules = filterMcpTools(tools, filter)
  const visible = applyAnnotationPolicy(byRules.visible, policy).visible
  const admitted = narrowing === undefined ? visible : visible.filter(narrowing)
  return { visible, admitted, hidden: tools.length - admitted.length }
}

/**
 * The subset of the system-prompt registry this module uses.
 *
 * Every profile mounts it, but the plugin treats it as optional like every
 * other probed service: without it the on-demand tools still work and only the
 * inventory section is missing.
 */
interface SystemPromptRegistry {
  section(section: {
    readonly name: string
    readonly order: number
    readonly interpolate?: boolean
    readonly text: string | ((context: { readonly scope?: unknown }) => string)
  }): () => void
  getSectionOrder(name: string): number
}

/** What one on-demand registration exposes to its owner. */
export interface McpToolRegistration {
  /** Unregister every tool and drop every session's claims on pooled connections. */
  dispose(): Promise<void>
  /**
   * Re-read the allowed rows and re-render the inventory section. The caller
   * runs it once before the first request and again whenever a composition row
   * or the loading mode changes.
   */
  refresh(): Promise<void>
  /**
   * Apply a pooled server's new tool list to every session that claimed it.
   * The pool calls this after re-listing a connection.
   * @param connection - the connection whose tools changed.
   */
  toolsChanged(connection: PooledConnection): void
}

/** Live per-row readers the caller owns, so a committed change needs no re-registration. */
export interface McpRowReaders {
  /**
   * One row's tool filter by its settings key. Read at every load, so a
   * committed rule change applies to the next `mcp_load`.
   */
  filterFor(key: string): McpToolFilter
  /**
   * One row's authoring description by its settings key. Read on every
   * inventory refresh, and published to the model in that section.
   */
  descriptionFor(key: string): string | undefined
  /**
   * The committed optimization policy. Read at every load, every search, and
   * every re-sync, so a committed change applies from the next call on; the one
   * decision it cannot change live is whether `mcp_search` exists at all, which
   * the caller re-registers for (see `mcpRegistrationKey`).
   */
  optimize?(): McpOptimizeFlags
}

/**
 * Register the on-demand MCP tools and the inventory section that names them.
 * @param ctx - scope the tools belong to (the plugin's host context).
 * @param mode - how a loaded server reaches the model.
 * @param gate - the preload gate; it decides which composed rows this session
 *   is allowed to load, and holds the rest out of every request.
 * @param readers - live per-row rule, description, and policy readers.
 * @param pool - the host-level connection pool every session shares.
 * @param external - the registry of resource-plugin rows, when one is mounted.
 * @param catalog - where discovery results are remembered between calls. Every
 *   caller passes one; `index.ts` passes the shared instance so searches and
 *   the settings page's catalogue read the same memory, across registrations.
 * @returns the registration handle. `eager` registers no tool at all, and its
 *   handle is an inert pair of no-ops.
 */
export function registerMcpTools(
  ctx: Context,
  mode: McpLoadingMode,
  gate: McpPreloadGate,
  readers: McpRowReaders = { filterFor: () => NO_TOOL_FILTER, descriptionFor: () => undefined },
  pool: McpConnectionPool,
  external: ExternalMcpRegistry | undefined,
  catalog: McpCatalog<LazyTool>,
): McpToolRegistration {
  const tools = ctx.get('tools') as ToolRegistry | undefined
  if (tools === undefined || mode === 'eager') {
    return { dispose: async () => {}, refresh: async () => {}, toolsChanged: () => {} }
  }
  /** The mode whose tools exist; narrowed once so closures need no re-check. */
  const onDemandMode: 'dynamic' | 'lazy' = mode
  /** The policy as it stands at call time; the caller re-registers when the tool set must change. */
  const policyNow = (): McpOptimizeFlags => readers.optimize?.() ?? MCP_OPTIMIZE_DEFAULTS
  /**
   * Whether this registration includes `mcp_search`. Captured once at
   * registration time and used by the inventory text too, so the model is never
   * told about a tool this registration does not carry; the caller re-registers
   * the whole tool set when the setting flips (`mcpRegistrationKey`).
   */
  const searchEnabled = policyNow().search
  /**
   * The rows this session may load: composed rows the user has not disabled.
   * The gate is re-read first because a preset composition is also rebuilt when
   * its file changes, and a row that just came back would otherwise be treated
   * as still absent.
   */
  const allowedRows = async (scope?: object): Promise<McpRow[]> => {
    await gate.reconcile()
    return listMcpRows(ctx, gate, external).filter(row =>
      row.externalConfig === undefined
        ? row.enabled && (row.presetScope === undefined || scope !== undefined
          && (external ? external.scopeDistance(row.presetScope, scope) < Number.MAX_SAFE_INTEGER
            : scopeChainOf(scope).includes(row.presetScope)))
        : external?.visible({
          owner: row.entryId, serverName: row.serverName, config: row.externalConfig,
          scope: row.externalKind ?? 'global',
          scopeKey: row.externalScope,
        }, scope) === true,
    ).sort((a, b) => {
      const priority = (row: McpRow): number => row.externalKind === 'agent'
        ? external?.scopeDistance(row.externalScope, scope) ?? Number.MAX_SAFE_INTEGER
        : row.externalConfig === undefined ? 1_000_000 : 2_000_000
      return priority(a) - priority(b)
    })
  }
  /** Session claims, keyed by agent id then serverName. */
  const views = new Map<string, Map<string, LoadedView>>()
  /** Sessions whose claims are already bound to their own context disposal. */
  const scopedAgents = new Set<string>()
  /** The agent behind one id, for a re-sync that has no execution context. */
  const agents = new Map<string, { readonly id: string; readonly ctx: Context }>()
  /** Live tool registrations, undone by the returned disposer. */
  const registrations: (() => void)[] = []
  /** Set by the returned disposer, so a late pool notification does nothing. */
  let disposed = false
  const register = (definition: unknown): void => { registrations.push(tools.register(definition)) }

  const viewsFor = (agentId: string): Map<string, LoadedView> => {
    const existing = views.get(agentId)
    if (existing !== undefined) return existing
    const created = new Map<string, LoadedView>()
    views.set(agentId, created)
    return created
  }

  /** The harness adapter, resolved once per activation; dynamic loads fail loud without it. */
  let adapter: McpToolAdapter | undefined
  const resolveAdapter = async (): Promise<McpToolAdapter> => {
    if (adapter !== undefined) return adapter
    const mod = await resolveMcpClient(ctx)
    const found = mod.createMcpToolDefinition
    if (found === undefined) {
      throw new Error(
        'this harness build does not export createMcpToolDefinition from @deepseek-ai/dsh-mcp-client, so the '
        + 'tools of a server cannot be registered individually; select the "lazy" loading mode, or a harness build '
        + 'that provides the adapter',
      )
    }
    adapter = found
    return found
  }

  /**
   * Release one session's claim on one server: its own registrations first, then
   * the pool, which closes the connection only when no session holds it.
   */
  const releaseView = async (agentId: string, serverName: string): Promise<boolean> => {
    const perAgent = views.get(agentId)
    const view = perAgent?.get(serverName)
    if (perAgent === undefined || view === undefined) return false
    perAgent.delete(serverName)
    if (perAgent.size === 0) views.delete(agentId)
    for (const dispose of [...view.definitions.values()].reverse()) dispose()
    view.definitions.clear()
    await pool.release(view.connection, agentId)
    return true
  }

  /**
   * Everything one ended session held. The connection outlives the session —
   * another session (or the next turn of this one) reuses it — so a session end
   * only drops that session's tool registrations and its claims.
   * @param agentId - the session that ended.
   */
  const releaseAgent = (agentId: string): void => {
    scopedAgents.delete(agentId)
    const perAgent = views.get(agentId)
    if (perAgent === undefined) return
    for (const serverName of [...perAgent.keys()]) void releaseView(agentId, serverName)
  }

  /**
   * Bind one session's claims to its context, so ending the session releases
   * them. Registered once per session: the first load also covers every later
   * load in that session.
   * @param agent - the session that is loading a server.
   */
  const bindAgentScope = (agent: { readonly id: string; readonly ctx: Context }): void => {
    if (scopedAgents.has(agent.id)) return
    scopedAgents.add(agent.id)
    agent.ctx.effect(() => () => { releaseAgent(agent.id) }, `mcp-manager: mcp claims of ${agent.id}`)
  }

  /** Re-list one pooled connection's tools and rebuild every session's view of it. */
  const onToolsChanged = (connection: PooledConnection): void => {
    if (disposed) return
    // The spec makes a `list_changed` invalidate a still-fresh cached listing
    // immediately, so a search never answers from the set the server just
    // replaced. The re-list below writes the new one back through `remember`.
    for (const rowKey of rowKeysByConnection(connection)) catalog.invalidate(rowKey)
    for (const [agentId, perAgent] of views) {
      for (const [serverName, view] of perAgent) {
        if (view.connection !== connection) continue
        void resyncView(agentId, serverName, view).catch((error: unknown) => {
          ctx.logger.warn(`mcp-manager: could not follow the tool list change of "${serverName}": ${String(error)}`)
        })
      }
    }
  }

  /**
   * Apply a connection's new tool list to one session's view, using the rules
   * and the narrowing that session loaded with. A failed registration leaves the
   * session with the tools it already had.
   */
  const resyncView = async (agentId: string, serverName: string, view: LoadedView): Promise<void> => {
    const selection = admittedTools(view.connection.tools, view.filter, view.admits, policyNow())
    view.tools = selection.visible
    view.hidden = selection.hidden
    view.truncated = view.connection.truncated
    if (view.carrier === 'proxy') return
    const agent = agents.get(agentId)
    const registry = agent?.ctx.get('tools') as ToolRegistry | undefined
    if (agent === undefined || registry === undefined) return
    const adapter = await resolveAdapter()
    view.definitions = swapNativeTools(
      registry,
      view.definitions,
      nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, view.connection.client),
    )
  }

  /** The row keys every live view of one connection was loaded under. */
  const rowKeysByConnection = (connection: PooledConnection): ReadonlySet<string> => {
    const keys = new Set<string>()
    for (const perAgent of views.values()) {
      for (const view of perAgent.values()) {
        if (view.connection === connection) keys.add(view.rowKey)
      }
    }
    return keys
  }

  /**
   * The model's only source for loadable server names: no server's tools are in
   * the request until a session loads one, so the names have to be published.
   * The text is a snapshot, refreshed through {@link McpToolRegistration.refresh}.
   */
  let inventoryRows: McpRow[] = []
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptRegistry | undefined
  const inventorySection = systemPrompt?.section({
    name: 'mcp-manager:on-demand',
    order: systemPrompt.getSectionOrder('MCP_SERVERS'),
    // Row descriptions are user text, not templates: `{{...}}` stays literal.
    interpolate: false,
    text: context => renderMcpInventory(inventoryRows.filter(row =>
      row.presetScope !== undefined
        ? context.scope !== undefined && (external
          ? external.scopeDistance(row.presetScope, context.scope as object) < Number.MAX_SAFE_INTEGER
          : scopeChainOf(context.scope as object).includes(row.presetScope))
        : row.externalConfig === undefined || row.externalKind === 'global'
        || (context.scope !== undefined && external?.visible({
          owner: row.entryId, serverName: row.serverName, config: row.externalConfig!,
          scope: row.externalKind ?? 'global',
          scopeKey: row.externalScope,
        }, context.scope as object) === true),
    ).sort((a, b) => {
      const priority = (row: McpRow): number => row.externalKind === 'agent'
        ? external?.scopeDistance(row.externalScope, context.scope as object | undefined) ?? Number.MAX_SAFE_INTEGER
        : row.externalConfig === undefined ? 1_000_000 : 2_000_000
      return priority(a) - priority(b)
    }).map(row => {
      const description = row.externalDescription ?? readers.descriptionFor(row.key)
      return { name: row.serverName, ...(description === undefined ? {} : { description }) }
    }), onDemandMode, searchEnabled),
  })
  const refresh = async (): Promise<void> => {
    await gate.reconcile()
    inventoryRows = listMcpRows(ctx, gate, external).filter(row =>
      row.externalConfig !== undefined || row.enabled,
    )
  }

  const stopAll = async (): Promise<void> => {
    const pending: Promise<void>[] = []
    for (const agentId of [...views.keys()]) {
      pending.push(...[...(views.get(agentId)?.keys() ?? [])].map(serverName =>
        releaseView(agentId, serverName).then(() => undefined)))
    }
    views.clear()
    scopedAgents.clear()
    agents.clear()
    await Promise.allSettled(pending)
  }
  /**
   * Widen one view to a later load's subset.
   *
   * A session that loaded a server with a query may ask for more of it later.
   * The admitted set only ever grows, so a second query never takes away a tool
   * the session already has; a view that took everything has nothing to widen.
   * @param view - the session's live view of one pooled connection.
   * @param next - the subset the new load asks for.
   * @returns whether the admitted set grew, which is what needs a re-register.
   */
  const widen = (view: LoadedView, next: ToolNarrowing): boolean => {
    const previous = view.admits
    if (previous === undefined) return false
    if (!view.tools.some(tool => !previous(tool) && next(tool))) return false
    view.admits = tool => previous(tool) || next(tool)
    return true
  }

  /**
   * Widen one view back to the whole server.
   *
   * A load with neither `query` nor `tool` asks for everything the server
   * exposes, which is wider than any subset a previous load asked for — so a
   * narrowed view takes its filter-visible tools back. Like `widen`, this only
   * ever grows the admitted set: a tool the session already has stays callable.
   * @param view - the session's live view of one pooled connection.
   * @returns whether the admitted set grew, which is what needs a re-register.
   */
  const widenToWhole = (view: LoadedView): boolean => {
    const previous = view.admits
    if (previous === undefined) return false
    // Dropping the predicate is not a widening by itself: a narrowing that
    // happened to admit every visible tool leaves the same callable set.
    if (!view.tools.some(tool => !previous(tool))) return false
    delete view.admits
    return true
  }

  /** Rebuild one native view's registrations from its current admitted set. */
  const reregister = async (agentId: string, serverName: string, view: LoadedView): Promise<void> => {
    const agent = agents.get(agentId)
    const registry = agent?.ctx.get('tools') as ToolRegistry | undefined
    if (agent === undefined || registry === undefined) return
    const selection = admittedTools(view.connection.tools, view.filter, view.admits, policyNow())
    const adapter = await resolveAdapter()
    view.definitions = swapNativeTools(
      registry,
      view.definitions,
      nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, view.connection.client),
    )
    view.tools = selection.visible
    view.hidden = selection.hidden
  }

  /** Remember one server's discovery result, honouring its own freshness hint. */
  const remember = (key: string, discovery: McpDiscovery): void => {
    catalog.set(key, {
      tools: discovery.tools,
      truncated: discovery.truncated,
      ...discovery.ttlMs === undefined ? {} : { ttlMs: discovery.ttlMs },
    })
  }


  register(defineTool({
    name: 'mcp_load',
    description: onDemandMode === 'lazy'
      ? 'Start one of the MCP servers listed in your system prompt for THIS session and add its tools to this '
        + 'session. The server then stays running and other sessions reuse the same process. Call the tools you need '
        + 'afterwards with `mcp_call`, passing the server name and tool name from this result. Pass `query` to add only '
        + 'the tools that match, `tool` to add exactly one tool and get its argument schema, and `cursor`/`limit` to '
        + 'page through a long listing. Only the tools this result reports are callable.'
      : 'Start one of the MCP servers listed in your system prompt for THIS session and add its tools to the '
        + 'request. The server then stays running and other sessions reuse the same process. Pass `query` to add only '
        + 'the tools that match, `tool` to add exactly one tool and get its argument schema, and `cursor`/`limit` to '
        + 'page through a long listing. Only the tools this result reports are callable.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP server name to start, as listed in your system prompt.' },
      query: {
        type: 'string',
        description: 'Only add tools whose name, title, or description contains every word of this text. '
          + 'Leave it out to add every tool the server is allowed to expose.',
      },
      tool: {
        type: 'string',
        description: 'Add exactly this one tool (its upstream name) and report its full argument schema. '
          + 'Use it when you already know which tool you are going to call.',
      },
      detail: {
        type: 'string',
        description: "How much to report per tool: \"names\", \"summary\" (name and description), or \"full\" "
          + '(adds the argument schema). Defaults to the session\'s configured level.',
      },
      cursor: {
        type: 'string',
        description: 'The `nextCursor` of a previous result, to read the next page of the same listing.',
      },
      limit: {
        type: 'number',
        description: 'How many tools this result may list. Defaults to the session\'s configured page size.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          total: {
            type: 'number',
            required: true,
            description: 'Tools this call selected, before paging.',
          },
          shown: { type: 'number', required: true, description: 'Tools this result lists.' },
          loaded: {
            type: 'number',
            required: true,
            description: 'Tools this session may now call on this server.',
          },
          hidden: {
            type: 'number',
            required: true,
            description: 'Discovered tools this row\'s rules or the annotation policy keep out of the session.',
          },
          truncated: {
            type: 'boolean',
            required: true,
            description: 'The server\'s own tool list was cut short by the configured collection cap.',
          },
          nextCursor: {
            type: 'string',
            description: 'Pass this as `cursor` to read the next page of the same listing.',
          },
          widened: {
            type: 'boolean',
            description: 'This call widened the session\'s view: a load without `query`/`tool` after a narrowed one, '
              + 'so every tool the row allows is callable now.',
          },
          tools: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                title: { type: 'string', description: 'The display name the server published, when it did.' },
                description: { type: 'string', required: true },
                annotations: {
                  type: 'array',
                  description: 'Behaviour hints the server published (read-only, destructive, idempotent, open-world).',
                  items: { type: 'string' },
                },
                schema: {
                  type: 'string',
                  description: 'JSON schema of the tool arguments; present at the "full" detail level.',
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Started MCP server "${value.server}"; ${value.loaded} tool(s) are callable in this session`
            + `${value.hidden === 0 ? '' : `, ${value.hidden} hidden`}.`
            + `${value.total === 0 ? '' : ` Showing ${value.shown} of ${value.total} selected.`}`,
          ...value.tools.map(tool => `- ${tool.name}`
            + `${tool.annotations === undefined || tool.annotations.length === 0 ? '' : ` (${tool.annotations.join(', ')})`}`
            + `${tool.title === undefined ? '' : ` — ${tool.title}`}`
            + `${tool.description === '' ? '' : `: ${tool.description}`}`
            + `${tool.schema === undefined ? '' : `\n  args: ${tool.schema}`}`),
          value.total === 0
            ? 'No tool on this server matched. Try different words, or call mcp_load without `query` to see everything.'
            : '',
          value.nextCursor === undefined
            ? ''
            : `More tools are available: call mcp_load again with cursor "${value.nextCursor}".`,
          value.widened === true
            ? `This call widened the session's view of "${value.server}": ${value.loaded} tool(s) are callable now.`
            : '',
          value.truncated
            ? 'The server publishes more tools than this session collects; ask again with a `query` to find the rest.'
            : '',
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_load requires an owning agent session')
      const request = args as {
        server: string
        query?: string
        tool?: string
        detail?: string
        cursor?: string
        limit?: number
      }
      const serverName = String(request.server)
      const policy = policyNow()
      const limit = clampPageSize(request.limit, policy.pageSize)
      const query = typeof request.query === 'string' ? request.query : ''
      const wanted = typeof request.tool === 'string' && request.tool.trim() !== '' ? request.tool.trim() : undefined
      const detail = parseDetailLevel(request.detail, policy, wanted !== undefined)
      const page = { cursor: request.cursor, limit }

      const existing = viewsFor(agent.id).get(serverName)
      if (existing !== undefined) {
        // A second load only ever widens what the session already has, so a
        // later query can add tools without taking any away. A load with no
        // `query`/`tool` asks for the whole server, so it widens a narrowed view
        // back to every tool the row's rules leave visible.
        const narrowing = narrowingFor(query, wanted)
        const widened = narrowing === undefined ? widenToWhole(existing) : widen(existing, narrowing)
        if (widened) await reregister(agent.id, serverName, existing)
        return reportLoad(
          existing,
          serverName,
          { query, wanted, detail, page, widened },
          policy,
          () => toolNamesFor(tools, agent.ctx, serverName, external),
        )
      }

      const row = (await allowedRows(external ? external.scopeOf(agent.ctx) : scopeOf(agent.ctx)))
        .find(candidate => candidate.serverName === serverName)
      if (row === undefined) {
        throw new Error(
          `unknown or disabled MCP server "${serverName}" — load one of the MCP servers listed in your system prompt`,
        )
      }
      const config = row.externalConfig ?? mcpEntryConfig(await describeRow(ctx, row), serverName)
      // A row with an incomplete connection config cannot start, so the load
      // fails here with the actual reason instead of letting the client report
      // "connection failed". The settings page marks the same row as not
      // configured, and the gate holds it unmounted.
      const configIssue = diagnoseRowConfig(config)
      if (configIssue.length > 0) {
        throw new Error(
          `MCP server "${serverName}" is not configured and cannot start: ${describeMcpConfigIssues(configIssue)}`,
        )
      }
      const filter = readers.filterFor(row.key)
      const narrowing = narrowingFor(query, wanted)
      const carrier = carrierFor(onDemandMode, filter, narrowing !== undefined)
      if (carrier === undefined) throw new Error('mcp_load is not registered under the "eager" loading mode')
      const key: PoolKey = { rowKey: row.key, serverName, fingerprint: connectionFingerprint(config) }
      // The pooled connection is opened once and shared; only the registering
      // and the claim below are per session. `connectLazy` walks every page of
      // the server's listing, so what this connection already discovered is what
      // the catalogue remembers for it.
      const connection = await pool.acquire(key, config)
      remember(row.key, {
        tools: connection.tools,
        truncated: connection.truncated,
        ...connection.ttlMs === undefined ? {} : { ttlMs: connection.ttlMs },
      })
      const selection = admittedTools(connection.tools, filter, narrowing, policy)
      // A narrowing that admits nothing must not leave a view behind: an empty
      // view would answer every later call for that server with an empty tool
      // list, so the session would be locked out until it unloaded a server it
      // never really got. The claim is released instead and the answer handed
      // back: an error when one tool was asked for by name (the model has the
      // wrong name), and an ordinary empty listing when a query simply matched
      // nothing (the model should try other words).
      if (narrowing !== undefined && selection.admitted.length === 0) {
        await pool.release(connection, agent.id)
        if (wanted === undefined) {
          return {
            server: serverName,
            total: 0,
            shown: 0,
            loaded: 0,
            hidden: selection.hidden,
            truncated: connection.truncated,
            tools: [],
          }
        }
        const publishes = connection.tools.some(tool => tool.name === wanted)
        throw new Error(
          publishes
            ? `MCP server "${serverName}" publishes the tool "${wanted}", but this row's rules or the annotation `
              + 'policy keep it out of this session'
            : `MCP server "${serverName}" publishes no tool "${wanted}" — use mcp_search to find the right name, `
              + 'or call mcp_load without `tool` to list what it does publish',
        )
      }
      const registry = agent.ctx.get('tools') as ToolRegistry | undefined
      if (registry === undefined) throw new Error('mcp_load requires the tools service')
      let definitions = new Map<string, () => void>()
      if (carrier === 'native') {
        const adapter = await resolveAdapter()
        try {
          definitions = swapNativeTools(
            registry,
            new Map(),
            nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, connection.client),
          )
        } catch (error) {
          await pool.release(connection, agent.id)
          throw error
        }
      }
      agents.set(agent.id, agent)
      const view: LoadedView = {
        rowKey: row.key,
        carrier,
        connection,
        filter,
        tools: selection.visible,
        hidden: selection.hidden,
        truncated: connection.truncated,
        definitions,
        ...narrowing === undefined ? {} : { admits: narrowing },
      }
      viewsFor(agent.id).set(serverName, view)
      pool.claim(key, connection, agent.id)
      bindAgentScope(agent)
      return reportLoad(view, serverName, { query, wanted, detail, page }, policy, () => toolNamesFor(tools, agent.ctx, serverName, external))
    },
  }))

  // The catalogue is only useful if the model can search it, and the whole point
  // of the search is that a session does NOT have to load a server to find out
  // what it publishes. Registered only when the policy asks for it: the caller
  // re-registers the tool set when that setting flips.
  if (searchEnabled) register(defineTool({
    name: 'mcp_search',
    description:
      'Find MCP tools by what they do, across every server this session may load, without adding them to the '
      + 'session. Returns matching server/tool names with a one-line description; load the ones you need with '
      + '`mcp_load`, which reports their argument schemas. Answers from tools already discovered; servers the '
      + 'Host has not catalogued are reported as not indexed.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What the tool does, or part of its name. Every word must occur in the name, title, or description.',
      },
      server: {
        type: 'string',
        description: 'Restrict the search to one server name. Omit it to search every server this session may load.',
      },
      cursor: {
        type: 'string',
        description: 'The `nextCursor` of a previous result, to read the next page of matches.',
      },
      limit: {
        type: 'number',
        description: 'How many matches this result may list. Defaults to the session\'s configured page size.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          total: { type: 'number', required: true, description: 'Matches found, before paging.' },
          shown: { type: 'number', required: true, description: 'Matches this result lists.' },
          nextCursor: {
            type: 'string',
            description: 'Pass this as `cursor` to read the next page of matches.',
          },
          indexed: {
            type: 'number',
            required: true,
            description: 'Servers holding a tool list this search could read.',
          },
          pending: {
            type: 'array',
            required: true,
            description: 'Servers with no tool list yet, which this search could not look inside.',
            items: { type: 'string' },
          },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                server: { type: 'string', required: true },
                tool: { type: 'string', required: true, description: 'The server\'s own tool name.' },
                title: { type: 'string', description: 'The display name the server published, when it did.' },
                description: { type: 'string', required: true },
                annotations: {
                  type: 'array',
                  description: 'Behaviour hints the server published (read-only, destructive, idempotent, open-world).',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Tools matching "${value.query}": ${value.total} found, showing ${value.shown}.`,
          ...value.hits.map(hit => `- ${hit.server} · ${hit.tool}`
            + `${hit.annotations === undefined || hit.annotations.length === 0 ? '' : ` (${hit.annotations.join(', ')})`}`
            + `${hit.title === undefined ? '' : ` — ${hit.title}`}`
            + `${hit.description === '' ? '' : `: ${hit.description}`}`),
          value.total === 0 ? 'No match. Try other words, or load a server to see what it publishes.' : '',
          value.pending.length === 0
            ? ''
            : `Not indexed yet: ${value.pending.join(', ')}. Load one with \`mcp_load\` to make its tools searchable.`,
          value.nextCursor === undefined
            ? ''
            : `More matches: call mcp_search again with cursor "${value.nextCursor}".`,
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_search requires an owning agent session')
      const request = args as { query: string; server?: string; cursor?: string; limit?: number }
      const policy = policyNow()
      const limit = clampPageSize(request.limit, policy.pageSize)
      const query = String(request.query)
      const only = typeof request.server === 'string' && request.server.trim() !== ''
        ? request.server.trim()
        : undefined
      const rows = (await allowedRows(external ? external.scopeOf(agent.ctx) : scopeOf(agent.ctx)))
        .filter(row => only === undefined || row.serverName === only)

      // A row with no fresh catalogue still has to be indexable: with
      // `searchIndex` the search connects it once (bounded, and bounded in
      // concurrency) instead of leaving a hole in the answer that the model
      // cannot see.
      const stale = rows.filter(row => catalog.get(row.key, policy.catalogTtlMs) === undefined)
      if (policy.searchIndex && stale.length > 0) {
        await mapLimited(stale, SEARCH_INDEX_CONCURRENCY, async (row) => {
          try {
            const config = row.externalConfig ?? mcpEntryConfig(await describeRow(ctx, row), row.serverName)
            if (describeRow === undefined || diagnoseRowConfig(config).length > 0) return
            const { client, tools: listed, truncated, ttlMs } = await withBudget(
              connectLazy(config, { maxTools: policy.maxTools }),
              SEARCH_INDEX_TIMEOUT_MS,
            )
            try {
              remember(row.key, { tools: listed, truncated, ...ttlMs === undefined ? {} : { ttlMs } })
            } finally {
              await client.close().catch(() => {})
            }
          } catch {
            // A server that will not answer is reported as still not indexed
            // rather than failing the whole search.
          }
        })
      }

      const hits: SearchHit[] = []
      const pending: string[] = []
      let indexed = 0
      for (const row of rows) {
        const entry = catalog.get(row.key, policy.catalogTtlMs)
        if (entry === undefined) {
          pending.push(row.serverName)
          continue
        }
        indexed += 1
        const byRules = filterMcpTools(entry.tools, readers.filterFor(row.key)).visible
        const admitted = applyAnnotationPolicy(byRules, policy).visible
        for (const tool of matchTools(admitted, query)) {
          if (hits.length >= policy.maxTools) break
          hits.push({
            server: row.serverName,
            tool: tool.name,
            ...tool.title === undefined ? {} : { title: tool.title },
            description: tool.description ?? '',
            ...annotationTokens(tool, policy),
          })
        }
      }
      const paged = paginateTools(hits, request.cursor, limit)
      return {
        query,
        total: hits.length,
        shown: paged.page.length,
        indexed,
        pending,
        hits: paged.page,
        ...paged.nextCursor === undefined ? {} : { nextCursor: paged.nextCursor },
      }
    },
  }))

  // Registered under `lazy` alone: that mode keeps every tool out of the
  // request, so this proxy is the only way to invoke one. `dynamic` registers
  // its tools natively and the model calls them by name.
  if (onDemandMode === 'lazy') register(defineTool({
    name: 'mcp_call',
    description:
      'Call one tool of an MCP server that `mcp_load` started. Use the server and tool names from the mcp_load '
      + 'result; pass the tool arguments exactly as that result described them.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP serverName, as reported by mcp_load.' },
      tool: { type: 'string', required: true, description: 'The tool name reported by mcp_load.' },
      arguments: { type: 'json', required: true, description: 'Arguments object for that tool, matching its reported schema.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          tool: { type: 'string', required: true },
          text: { type: 'string', required: true, description: 'The tool result rendered as text.' },
          isError: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_call requires an owning agent session')
      const request = args as { server: string; tool: string; arguments: unknown }
      const view = viewsFor(agent.id).get(request.server)
      if (view === undefined) {
        throw new Error(`MCP server "${request.server}" is not loaded for this session — call mcp_load first`)
      }
      if (view.carrier !== 'proxy') {
        throw new Error(
          `MCP server "${request.server}" was loaded with its tools registered natively — call them by name instead`,
        )
      }
      if (!admittedOf(view).some(candidate => candidate.name === request.tool)) {
        throw new Error(
          `MCP server "${request.server}" exposes no tool "${request.tool}" in this session — `
          + 'call mcp_load to list the tools this session may call, or mcp_load that one tool by name',
        )
      }
      const result = await view.connection.client.callTool({
        name: request.tool,
        arguments: asRecord(request.arguments),
      })
      return {
        server: request.server,
        tool: request.tool,
        text: renderCallResult(result),
        isError: (result as { isError?: boolean } | null)?.isError === true,
      }
    },
  }))

  register(defineTool({
    name: 'mcp_unload',
    description:
      'Release an MCP server that `mcp_load` started for THIS session. The server keeps running while another '
      + 'session still uses it, and stops when this was the last session holding it.',
    parameters: {
      server: { type: 'string', required: true, description: 'The MCP serverName to release.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          server: { type: 'string', required: true },
          released: { type: 'boolean', required: true },
          stopped: { type: 'boolean', required: true, description: 'No session holds this server any more, so its process stopped.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: !value.released
          ? `MCP server "${value.server}" was not loaded for this session.`
          : value.stopped
            ? `Released MCP server "${value.server}"; no session is using it any more, so it stopped.`
            : `Released MCP server "${value.server}" for this session; it stays running for the sessions still using it.`,
      }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('mcp_unload requires an owning agent session')
      const serverName = String((args as { server: string }).server)
      const view = views.get(agent.id)?.get(serverName)
      if (view === undefined) return { server: serverName, released: false, stopped: false }
      const connection = view.connection
      await releaseView(agent.id, serverName)
      return { server: serverName, released: true, stopped: connection.claims.size === 0 }
    },
  }))

  return {
    dispose: async () => {
      disposed = true
      for (const dispose of [...registrations].reverse()) dispose()
      registrations.length = 0
      inventorySection?.()
      inventoryRows = []
      await stopAll()
    },
    refresh,
    toolsChanged: connection => { onToolsChanged(connection) },
  }
}

/** How much one `mcp_load` result reports per tool. */
type ToolDetail = 'names' | 'summary' | 'full'

/** One tool line in a load result. */
interface LoadedToolView {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly annotations?: string[]
  readonly schema?: string
}

/** One tool line in a search result. */
interface SearchHit {
  readonly server: string
  readonly tool: string
  readonly title?: string
  readonly description: string
  readonly annotations?: string[]
}

/** What one `mcp_load` call asked the result to show. */
interface LoadView {
  readonly query: string
  readonly wanted: string | undefined
  readonly detail: ToolDetail
  readonly page: { readonly cursor: string | undefined; readonly limit: number }
  /** Set when this call widened what an earlier load had narrowed. */
  readonly widened?: boolean
}

/** The canonical `mcp_load` value; the declared output schema describes exactly this. */
interface LoadResult {
  readonly server: string
  readonly total: number
  readonly shown: number
  readonly loaded: number
  readonly hidden: number
  readonly truncated: boolean
  readonly tools: LoadedToolView[]
  readonly nextCursor?: string
  readonly widened?: boolean
}

/**
 * Read one stored `detail` value, converging anything else to the policy's level.
 *
 * Asking for one tool by name is asking for its arguments, so that request
 * defaults to the full schema even under `namesOnly`; only an explicit `detail`
 * can downgrade it.
 * @param value - the model's request value.
 * @param policy - the resolved policy, whose `namesOnly` picks the default.
 * @param wanted - whether the request named one tool.
 * @returns the level this result reports at.
 */
function parseDetailLevel(value: unknown, policy: McpOptimizeFlags, wanted: boolean): ToolDetail {
  if (value === 'names' || value === 'summary' || value === 'full') return value
  if (wanted) return 'full'
  return policy.namesOnly ? 'summary' : 'full'
}

/**
 * Clamp one requested page size into the policy's range.
 * @param value - the model's `limit`.
 * @param fallback - the configured page size.
 * @returns a whole number of tools this result may list.
 */
function clampPageSize(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(MCP_PAGE_SIZE_RANGE.max, Math.max(MCP_PAGE_SIZE_RANGE.min, parsed))
}

/**
 * Turn one load request into the subset it asks for.
 * @param query - the model's query text; blank selects nothing by itself.
 * @param wanted - the one tool the model asked for by name, when it did.
 * @returns the predicate that admits the subset, or undefined for "everything".
 */
function narrowingFor(query: string, wanted: string | undefined): ToolNarrowing | undefined {
  if (wanted !== undefined) return tool => tool.name === wanted
  if (query.trim() === '') return undefined
  return tool => toolMatchesQuery(tool, query)
}

/**
 * Project one discovered tool onto the load result's per-tool shape.
 *
 * The model-facing name is the one this session must call: the public
 * `mcp__<server>__<tool>` name under a native carrier, the raw name through
 * `mcp_call` under the proxy. A mounted server's names come from the harness
 * registry instead, which is why they are not built here.
 * @param carrier - the carrier that exposed the tool.
 * @param serverName - the row's namespace.
 * @param tool - the discovered tool.
 * @param detail - how much of the tool to report.
 * @param policy - the resolved policy; decides whether annotations appear.
 * @returns one result line.
 */
function toolView(
  carrier: McpCarrier,
  serverName: string,
  tool: LazyTool,
  detail: ToolDetail,
  policy: McpOptimizeFlags,
): LoadedToolView {
  const annotations = annotationSummary(tool, policy)
  const base: LoadedToolView = {
    name: visibleToolName(carrier, serverName, tool.name),
    ...tool.title === undefined ? {} : { title: tool.title },
    description: detail === 'names' ? '' : tool.description ?? '',
    ...annotations.length === 0 ? {} : { annotations: [...annotations] },
  }
  return detail === 'full'
    ? { ...base, schema: tool.inputSchema === undefined ? '' : JSON.stringify(tool.inputSchema) }
    : base
}

/**
 * Build one `mcp_load` value from a live mount.
 *
 * `total` is what this call's selection covers, `loaded` is what the session may
 * now call on the server, and `shown` is how much of the selection this page
 * carries — the three numbers differ whenever the session narrowed a load or the
 * listing is paged.
 * @param mount - the live mount.
 * @param serverName - the row's namespace.
 * @param view - the query, the one tool asked for, the detail level, and the page.
 * @param policy - the resolved policy.
 * @param agent - the calling session, whose registry answers for a mounted server.
 * @returns the canonical result value.
 */
function reportLoad(
  view: LoadedView,
  serverName: string,
  load: LoadView,
  policy: McpOptimizeFlags,
  registeredNames: () => readonly string[],
): LoadResult {
  const admitted = admittedOf(view)
  const selected = load.wanted !== undefined
    ? admitted.filter(tool => tool.name === load.wanted)
    : load.query.trim() === ''
      ? admitted
      : matchTools(admitted, load.query)
  const paged = paginateTools(selected, load.page.cursor, load.page.limit)
  return {
    server: serverName,
    total: selected.length,
    shown: paged.page.length,
    loaded: admitted.length,
    hidden: view.hidden,
    truncated: view.truncated,
    tools: paged.page.map(tool => toolView(view.carrier, serverName, tool, load.detail, policy)),
    ...paged.nextCursor === undefined ? {} : { nextCursor: paged.nextCursor },
    ...load.widened === true ? { widened: true } : {},
  }
}

/** The admitted tools of one view: what the row's rules and this load left callable. */
function admittedOf(view: LoadedView): readonly LazyTool[] {
  return view.admits === undefined ? view.tools : view.tools.filter(view.admits)
}

/** The annotation tokens a listing prints, as an optional result field. */
function annotationTokens(tool: LazyTool, policy: McpOptimizeFlags): { readonly annotations?: string[] } {
  const tokens = [...annotationSummary(tool, policy)]
  return tokens.length === 0 ? {} : { annotations: tokens }
}

/**
 * Run `work` for every item, at most `limit` at a time.
 * @param items - the items to process.
 * @param limit - how many may be in flight at once.
 * @param work - one item's work; a rejection is the caller's to handle.
 */
async function mapLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      await work(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Resolve `work`, or reject once it outlives `ms`.
 * @param work - the operation to bound.
 * @param ms - budget in milliseconds.
 * @returns the operation's value when it settles inside the budget.
 * @throws when the budget expires before the operation settles.
 */
async function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
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

/** Coerce model-supplied arguments to the object the SDK expects. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Render one MCP call result as text for the model. */
function renderCallResult(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const text = content
      .map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : JSON.stringify(block))
      .filter(part => part !== '')
      .join('\n')
    if (text !== '') return text
  }
  return JSON.stringify(result)
}
