/**
 * The on-demand MCP inventory the plugin contributes to the system prompt.
 *
 * Under `dynamic`/`lazy` no server's tools are in the request until a session
 * loads one, so a model that was never told the names cannot load anything.
 * This section is that name list: one line per allowed row, registered at the
 * position the harness reserves for MCP server context (`MCP_SERVERS`, shared
 * with the instructions a mounted server contributes).
 *
 * Two rules keep it affordable. It never reports load state — that would
 * rewrite the system prompt on every `mcp_load` and invalidate the whole
 * request prefix, which costs far more than the lines it would add. And the
 * character budget trims descriptions, never servers: a name the model cannot
 * see is a server it cannot load, while a missing description only costs it a
 * guess.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-inventory
 */

/** One allowed MCP row as the inventory renders it. */
export interface McpInventoryRow {
  /** The `serverName` the model passes to `mcp_load`. */
  readonly name: string
  /** The user-authored row description, shown when it is useful and the budget allows. */
  readonly description?: string
}

/** Whole-section character budget: every name fits, descriptions fill the rest. */
export const MAX_INVENTORY_CHARS = 900

/** Per-row description cap, applied before the section budget. */
export const MAX_DESCRIPTION_CHARS = 80

/**
 * The usage line for one on-demand mode.
 *
 * It has to name the tools that actually exist in that mode: `mcp_search` is
 * only registered while the search setting is on, and `mcp_call` only exists
 * under `lazy`, so the model is never sent after a tool it cannot call.
 * @param mode - the on-demand loading mode the instruction must match.
 * @param search - whether this deployment also registers `mcp_search`.
 * @returns one line naming the tools that actually exist in that mode.
 */
function instruction(mode: 'dynamic' | 'lazy', search: boolean): string {
  const find = search
    ? 'Use `mcp_search` to find tools by what they do without loading a server, and '
    : ''
  return mode === 'lazy'
    ? `MCP servers available on demand: ${find}call \`mcp_load\` with one of these names to list that server's `
      + 'tools — pass `query` to load only what matches, or `tool` for one tool and its argument schema — then '
      + '`mcp_call` to invoke one, and `mcp_unload` with the same name to release it again.'
    : `MCP servers available on demand: ${find}call \`mcp_load\` with one of these names to add that server's `
      + 'tools to this session — pass `query` to add only what matches, or `tool` for one tool and its argument '
      + 'schema — and `mcp_unload` with the same name to release it again.'
}

/**
 * Collapse one row description to a single trimmed line.
 * @param text - the description as the user stored it.
 * @returns the collapsed text, truncated to {@link MAX_DESCRIPTION_CHARS}.
 */
function clipDescription(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  return collapsed.length <= MAX_DESCRIPTION_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
}

/**
 * Render the on-demand MCP inventory for the system prompt.
 *
 * Rows are listed in listing order and deduplicated by name, because
 * `mcp_load` resolves a name to one server and two identically named lines
 * would offer the model a choice it cannot make.
 * @param rows - every server this deployment allows a session to load.
 * @param mode - the on-demand mode whose tools the instruction names.
 * @param search - whether the deployment also registers `mcp_search`.
 * @returns the section text, or an empty string when nothing may be loaded,
 *   which contributes no section at all.
 */
export function renderMcpInventory(
  rows: readonly McpInventoryRow[],
  mode: 'dynamic' | 'lazy',
  search = false,
): string {
  if (rows.length === 0) return ''
  const head = instruction(mode, search)
  const lines: string[] = [head]
  const seen = new Set<string>()
  let used = head.length
  for (const row of rows) {
    if (seen.has(row.name)) continue
    seen.add(row.name)
    const bullet = `- ${row.name}`
    const description = clipDescription(row.description ?? '')
    const withDescription = description === '' ? bullet : `${bullet} — ${description}`
    const line = used + withDescription.length + 1 <= MAX_INVENTORY_CHARS ? withDescription : bullet
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}
