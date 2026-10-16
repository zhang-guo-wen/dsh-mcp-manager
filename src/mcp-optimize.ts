/**
 * The context-budget policy for on-demand MCP loading.
 *
 * The three loading modes decide *whether* a server's tools enter a request;
 * this module decides *how much* of them enters once one is loaded, and how
 * long a discovery result may be reused instead of reconnecting. It is the
 * client-side half of what the MCP specification and the major clients do about
 * tool bloat:
 *
 * - **A query narrows what a session admits.** `tools/list` has no query
 *   parameter in any spec revision, and the deferred-loading clients all add
 *   one of their own (Claude's `tool_search_tool_*`, the community MCP brokers'
 *   search tools). {@link matchTools} is that search: lexical, offline, no
 *   embedding.
 * - **A listing is paginated.** `tools/list` is cursor-paginated
 *   (`cursor`/`nextCursor`), and every client that shows tools pages them.
 *   {@link paginateTools} pages what a result puts in the conversation.
 * - **A tool can be loaded by name alone.** {@link McpOptimizeFlags.namesOnly}
 *   keeps argument schemas out of the result until one is asked for by name.
 * - **Annotations are policy input.** The spec's `readOnlyHint` /
 *   `destructiveHint` / `idempotentHint` / `openWorldHint` let a deployment
 *   keep destructive tools out of the admitted set without hand-writing a rule.
 *
 * Everything here is pure: the settings document is user-editable, so a
 * malformed value has to converge at the read site rather than fail the commit
 * that carried it.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-optimize
 */

/** The MCP tool annotations the spec defines (2025-06-18). */
export interface McpToolAnnotations {
  /** The tool does not modify its environment. */
  readonly readOnlyHint?: boolean
  /** The tool may perform destructive updates; defaults to true when omitted. */
  readonly destructiveHint?: boolean
  /** Calling the tool repeatedly with the same arguments has no extra effect. */
  readonly idempotentHint?: boolean
  /** The tool interacts with an open world of external entities. */
  readonly openWorldHint?: boolean
}

/** One tool as this module's policy reads it; a discovered tool satisfies it. */
export interface PolicyTool {
  /** The server's own tool name. */
  readonly name: string
  /** Optional human-readable display name the spec added. */
  readonly title?: string
  /** Optional description the server published. */
  readonly description?: string
  /** Optional behaviour hints the server published. */
  readonly annotations?: McpToolAnnotations
}

/**
 * The optimization policy one deployment runs under.
 *
 * Every field is a setting the browser section writes; the Host converges each
 * one at read time, so an unknown or malformed stored value falls back to its
 * default instead of rejecting the whole namespace.
 */
export interface McpOptimizeFlags {
  /**
   * Register `mcp_search`, which matches a query against the tool names and
   * descriptions of every server this session may load.
   */
  readonly search: boolean
  /**
   * Whether a search may connect to a server whose catalogue is not cached.
   *
   * Off by default: searching must stay a cheap read, and a deployment with
   * twenty servers would otherwise spawn twenty child processes because the
   * model asked a question. Off, a search answers from what previous loads
   * catalogued and names the servers it could not see.
   */
  readonly searchIndex: boolean
  /** Tools per page in every model-facing listing (`mcp_load`, `mcp_search`). */
  readonly pageSize: number
  /**
   * Omit `inputSchema` from a listing unless one tool is asked for by name.
   *
   * This is the two-phase discovery the deferred-loading clients use: a listing
   * carries identities, and the arguments schema is fetched for the one tool the
   * model is about to call (`mcp_load` with `tool`).
   */
  readonly namesOnly: boolean
  /** How long a discovered catalogue may answer a search without reconnecting. */
  readonly catalogTtlMs: number
  /** Hard cap on the tools one `tools/list` walk may collect from one server. */
  readonly maxTools: number
  /** Whether a listing reports the spec's annotations (`read-only`, `destructive`, …). */
  readonly annotations: boolean
  /**
   * Whether a tool the server declares destructive is kept out of the session.
   *
   * Only an explicit `destructiveHint: true` counts: the spec's default for an
   * absent hint is "destructive", so treating absence as destructive would hide
   * every tool of every server that publishes no annotations.
   */
  readonly hideDestructive: boolean
}

/** The policy a deployment runs when its settings document says nothing. */
export const MCP_OPTIMIZE_DEFAULTS: McpOptimizeFlags = Object.freeze({
  search: true,
  searchIndex: false,
  pageSize: 10,
  namesOnly: true,
  catalogTtlMs: 300_000,
  maxTools: 200,
  annotations: true,
  hideDestructive: false,
})

/** Accepted range of {@link McpOptimizeFlags.pageSize}. */
export const MCP_PAGE_SIZE_RANGE = Object.freeze({ min: 1, max: 50 })

/** Accepted range of {@link McpOptimizeFlags.maxTools}. */
export const MCP_MAX_TOOLS_RANGE = Object.freeze({ min: 1, max: 2_000 })

/** Accepted range of {@link McpOptimizeFlags.catalogTtlMs}; zero means "never reuse". */
export const MCP_CATALOG_TTL_RANGE = Object.freeze({ min: 0, max: 24 * 60 * 60 * 1_000 })

/** One page of a model-facing listing. */
export interface McpToolPage<T> {
  /** The tools this page carries. */
  readonly page: T[]
  /** Index of the first tool on this page. */
  readonly offset: number
  /** How many tools the whole listing holds. */
  readonly total: number
  /** Opaque cursor for the next page; absent on the last page. */
  readonly nextCursor?: string
}

/** The tools one annotation policy admits. */
export interface McpPolicySelection<T> {
  /** Tools the policy keeps. */
  readonly visible: readonly T[]
  /** How many tools the policy hid. */
  readonly hidden: number
}

/**
 * Read one stored boolean, converging anything else to its default.
 * @param value - the stored value of any shape.
 * @param fallback - the default to use when the value is not a boolean.
 * @returns the stored boolean or the default.
 */
function readFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read one stored number, clamping it into `range`.
 *
 * A settings document is hand-edited, so a value that is not a finite number in
 * range converges to the default rather than failing the namespace commit.
 * @param value - the stored value of any shape.
 * @param fallback - the default to use when the value is unusable.
 * @param range - inclusive bounds.
 * @returns the stored number, clamped, or the default.
 */
function readNumber(value: unknown, fallback: number, range: { readonly min: number; readonly max: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(value)))
}

/**
 * Converge one stored `optimize` value into the policy the Host runs under.
 * @param value - the stored value, of any shape; a non-object reads as "no settings".
 * @returns every field, taking the default for anything absent or malformed.
 */
export function parseMcpOptimizeFlags(value: unknown): McpOptimizeFlags {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    search: readFlag(record.search, MCP_OPTIMIZE_DEFAULTS.search),
    searchIndex: readFlag(record.searchIndex, MCP_OPTIMIZE_DEFAULTS.searchIndex),
    pageSize: readNumber(record.pageSize, MCP_OPTIMIZE_DEFAULTS.pageSize, MCP_PAGE_SIZE_RANGE),
    namesOnly: readFlag(record.namesOnly, MCP_OPTIMIZE_DEFAULTS.namesOnly),
    catalogTtlMs: readNumber(record.catalogTtlMs, MCP_OPTIMIZE_DEFAULTS.catalogTtlMs, MCP_CATALOG_TTL_RANGE),
    maxTools: readNumber(record.maxTools, MCP_OPTIMIZE_DEFAULTS.maxTools, MCP_MAX_TOOLS_RANGE),
    annotations: readFlag(record.annotations, MCP_OPTIMIZE_DEFAULTS.annotations),
    hideDestructive: readFlag(record.hideDestructive, MCP_OPTIMIZE_DEFAULTS.hideDestructive),
  }
}

/**
 * The part of the policy that decides which tools exist at all.
 *
 * Nearly everything here is read live: a switch flipped in the settings page
 * changes the next load, search, or re-sync without rebuilding anything. The one
 * exception is whether `mcp_search` is registered — a registered tool set is
 * what the request prefix carries — so the registration is rebuilt when this
 * changes and not for anything else.
 * @param flags - the resolved policy.
 * @returns a stable key that changes exactly when the registered tool set must.
 */
export function mcpRegistrationKey(flags: McpOptimizeFlags): string {
  return flags.search ? 'search' : 'plain'
}

/**
 * Collapse a query into the terms every match must contain.
 * @param query - the model's query text.
 * @returns normalized, non-empty terms with wildcard characters dropped, so
 *   `get_*` reads as the prefix `get_` instead of a literal asterisk.
 */
function queryTerms(query: string): readonly string[] {
  return normalizeText(query)
    .split(/\s+/)
    .map(term => term.replace(/[*?]/g, ''))
    .filter(term => term !== '')
}

/**
 * Normalize one text fragment for matching: compatibility-normalized, folded to
 * lower case. NFKC makes full-width and half-width spellings comparable, which
 * matters for the CJK descriptions deployments write by hand.
 * @param text - the raw text.
 * @returns the comparable form.
 */
function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/**
 * Score one tool against the query terms.
 * @param tool - the candidate tool.
 * @param terms - the normalized query terms; every one must occur.
 * @returns a relevance score, or `-1` when a term is missing anywhere.
 */
function scoreTool(tool: PolicyTool, terms: readonly string[]): number {
  const name = normalizeText(tool.name)
  const title = normalizeText(tool.title ?? '')
  const description = normalizeText(tool.description ?? '')
  let score = 0
  for (const term of terms) {
    const inName = name.includes(term)
    const inTitle = title.includes(term)
    const inDescription = description.includes(term)
    if (!inName && !inTitle && !inDescription) return -1
    if (inName) score += 4
    if (inTitle) score += 2
    if (inDescription) score += 1
    // An exact name match outranks a containment match, and a name hit outranks
    // a description hit of the same term, which is what makes the first page of
    // a broad query useful without any index.
    if (name === term) score += 8
  }
  return score
}

/**
 * Match one query against a server's tools.
 *
 * Every whitespace-separated term has to occur in the tool's name, title, or
 * description; the result is ordered by relevance with ties left in the
 * server's own order, so the same query always pages the same way.
 * @param tools - the tools the policy currently admits, in the server's order.
 * @param query - the model's query; blank keeps every tool.
 * @returns the matching tools, most relevant first.
 */
export function matchTools<T extends PolicyTool>(tools: readonly T[], query: string): readonly T[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return tools
  const scored: { readonly tool: T; readonly index: number; readonly score: number }[] = []
  tools.forEach((tool, index) => {
    const score = scoreTool(tool, terms)
    if (score >= 0) scored.push({ tool, index, score })
  })
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored.map(entry => entry.tool)
}

/**
 * Whether one tool matches a query, for callers that only need the predicate.
 * @param tool - the candidate tool.
 * @param query - the model's query; blank matches everything.
 * @returns true when the query admits the tool.
 */
export function toolMatchesQuery(tool: PolicyTool, query: string): boolean {
  const terms = queryTerms(query)
  return terms.length === 0 || scoreTool(tool, terms) >= 0
}

/**
 * Apply the annotation policy to one server's filtered tools.
 * @param tools - the tools the row's own rules already admitted.
 * @param flags - the resolved policy.
 * @returns the tools the session may admit, and how many the policy hid.
 */
export function applyAnnotationPolicy<T extends PolicyTool>(
  tools: readonly T[],
  flags: McpOptimizeFlags,
): McpPolicySelection<T> {
  if (!flags.hideDestructive) return { visible: tools, hidden: 0 }
  const visible = tools.filter(tool => tool.annotations?.destructiveHint !== true)
  return { visible, hidden: tools.length - visible.length }
}

/**
 * The annotation tokens a listing prints for one tool.
 *
 * Only the hints the server actually published are reported, and only when the
 * policy asks for annotations: the spec treats annotations as untrusted server
 * claims, so a missing hint must not be presented as a promise.
 * @param tool - the tool to describe.
 * @param flags - the resolved policy.
 * @returns the token list, empty when there is nothing to report.
 */
export function annotationSummary(tool: PolicyTool, flags: McpOptimizeFlags): readonly string[] {
  if (!flags.annotations) return []
  const annotations = tool.annotations
  if (annotations === undefined) return []
  const tokens: string[] = []
  if (annotations.readOnlyHint === true) tokens.push('read-only')
  if (annotations.destructiveHint === true) tokens.push('destructive')
  if (annotations.idempotentHint === true) tokens.push('idempotent')
  if (annotations.openWorldHint === true) tokens.push('open-world')
  return tokens
}

/**
 * Page one model-facing listing.
 *
 * The cursor is opaque to the model (it is only ever echoed back), and a cursor
 * this build did not issue is a caller error rather than a silently wrong page.
 * @param items - the whole listing, in its stable order.
 * @param cursor - the previous page's `nextCursor`, or undefined for the first page.
 * @param limit - requested page size; the caller clamps it to the policy range.
 * @returns the page, the offset it started at, the listing size, and the cursor
 *   for the page after it.
 * @throws when `cursor` is not a cursor this build issued.
 */
export function paginateTools<T>(items: readonly T[], cursor: string | undefined, limit: number): McpToolPage<T> {
  const offset = cursor === undefined ? 0 : decodeToolCursor(cursor)
  const page = items.slice(offset, offset + limit)
  const next = offset + page.length
  return {
    page,
    offset,
    total: items.length,
    ...next < items.length ? { nextCursor: encodeToolCursor(next) } : {},
  }
}

/**
 * Encode one listing offset as an opaque page cursor.
 * @param offset - index of the next page's first tool.
 * @returns the cursor to hand the model.
 */
export function encodeToolCursor(offset: number): string {
  return `o${offset.toString(36)}`
}

/**
 * Read one page cursor back.
 * @param cursor - the cursor the model echoed.
 * @returns the offset it carries.
 * @throws when the value is not a cursor this build issued.
 */
export function decodeToolCursor(cursor: string): number {
  const digits = /^o([0-9a-z]+)$/.exec(cursor.trim())?.[1] ?? ''
  const offset = digits === '' ? Number.NaN : Number.parseInt(digits, 36)
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('invalid cursor — pass `nextCursor` from the previous result, or omit it')
  }
  return offset
}
