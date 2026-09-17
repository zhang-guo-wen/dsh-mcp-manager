/**
 * Tool-level filters for on-demand MCP servers.
 *
 * A server that publishes fifty tools but is used for three of them pays for
 * all fifty input schemas every time the session loads it. One row's rules live
 * in the `context-injection` settings namespace under `mcpTools`, keyed as
 * `mcpRowKey`, and decide which of a server's discovered tools reach the model
 * at load time:
 *
 * - a plain entry keeps matching tools, so a row with at least one plain entry
 *   is an allow list and everything else is hidden;
 * - a `!`-prefixed entry drops matching tools, so a row with only `!` entries
 *   is a deny list and everything else survives;
 * - `*` matches any run of characters and `?` matches exactly one.
 *
 * Filtering happens where the tools are discovered and again where they are
 * called, so a hidden tool is neither advertised nor callable. The settings
 * document is a user-editable file: an absent, empty, or unparsable rule set
 * filters nothing, because a typo must not silently hide a server.
 *
 * @module @zhang-guo-wen/dsh-mcp-manager/mcp-tool-filter
 */

/** Marker that turns one rule entry into an exclusion. */
const EXCLUSION_PREFIX = '!'

/** One row's compiled filters. Empty on both sides means "keep everything". */
export interface McpToolFilter {
  /** Patterns whose matches stay visible; empty keeps every tool not dropped. */
  readonly keep: readonly RegExp[]
  /** Patterns whose matches are hidden from the model. */
  readonly drop: readonly RegExp[]
}

/** The tools one filter admits out of a server's discovered set. */
export interface McpToolSelection<T> {
  /** Tools the model may see and call. */
  readonly visible: readonly T[]
  /** How many discovered tools the filter hid. */
  readonly hidden: number
}

/** A filter that hides nothing, used when a row has no rules. */
export const NO_TOOL_FILTER: McpToolFilter = { keep: [], drop: [] }

/**
 * Read one row's stored rules as trimmed entries.
 *
 * The value arrives from a durable settings document, so every malformed entry
 * is skipped rather than raised: a rule set that parses to nothing filters
 * nothing. A bare string is accepted as a one-entry list because the document is
 * hand-edited.
 *
 * @param value - the stored rule value for one row, of any shape.
 * @returns the non-blank entries in their stored order, with their markers.
 */
export function toolRuleEntries(value: unknown): readonly string[] {
  const entries: readonly unknown[] = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : []
  const text: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed !== '') text.push(trimmed)
  }
  return text
}

/**
 * Compile one row's stored rules into patterns.
 * @param value - the stored rule value for one row, of any shape.
 * @returns the patterns to keep and the patterns to drop.
 */
export function parseMcpToolFilter(value: unknown): McpToolFilter {
  const keep: RegExp[] = []
  const drop: RegExp[] = []
  for (const entry of toolRuleEntries(value)) {
    if (entry.startsWith(EXCLUSION_PREFIX)) {
      const pattern = entry.slice(EXCLUSION_PREFIX.length).trim()
      if (pattern !== '') drop.push(compilePattern(pattern))
      continue
    }
    keep.push(compilePattern(entry))
  }
  return { keep, drop }
}

/**
 * Whether a rule set hides anything.
 * @param filter - a parsed rule set.
 * @returns true when at least one pattern was parsed.
 */
export function filterHidesAnything(filter: McpToolFilter): boolean {
  return filter.keep.length > 0 || filter.drop.length > 0
}

/**
 * Select the tools one server may expose under a filter.
 * @param tools - the server's discovered tools, in the server's own order.
 * @param filter - the row's parsed rules.
 * @returns the visible tools in their original order, plus how many were hidden.
 */
export function filterMcpTools<T extends { readonly name: string }>(
  tools: readonly T[],
  filter: McpToolFilter,
): McpToolSelection<T> {
  if (!filterHidesAnything(filter)) return { visible: tools, hidden: 0 }
  const visible = tools.filter(tool => admits(filter, tool.name))
  return { visible, hidden: tools.length - visible.length }
}

/**
 * Whether one tool name survives a filter.
 * @param filter - the row's parsed rules.
 * @param name - the server's own tool name.
 * @returns true when an exclusion does not match and either no allow pattern
 * exists or one matches.
 */
export function admits(filter: McpToolFilter, name: string): boolean {
  if (filter.drop.some(pattern => pattern.test(name))) return false
  return filter.keep.length === 0 || filter.keep.some(pattern => pattern.test(name))
}

/**
 * Compile one entry into an anchored pattern.
 *
 * Every regular-expression metacharacter except the two wildcards is escaped,
 * so a rule matches tool names literally apart from `*` and `?`.
 *
 * @param pattern - one trimmed rule entry without its exclusion marker.
 * @returns an anchored, case-sensitive pattern.
 */
function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`)
}
