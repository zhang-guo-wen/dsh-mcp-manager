/**
 * The agent plane's preset filter: which presets the roster offers as filter
 * values, and which rows one value shows.
 *
 * Both rules live here rather than in the settings controller because they are
 * pure: the controller pulls in the harness client store, while this module
 * only needs the two fields of a roster row it reads, so the rules stay unit
 * testable without a browser or a mounted settings page.
 * @module @guowenzhang/dsh-mcp-manager/client/agent-filter
 */

/**
 * Filter value that keeps every preset's rows. A preset id is never empty, so
 * the empty string cannot collide with one.
 */
export const MCP_ALL_PRESETS = ''

/** The row fields the agent filter reads; `McpServer` satisfies this shape. */
export interface McpAgentFilterRow {
  /** Plane the row lives in. Only `preset` rows take part in the filter. */
  readonly scope: 'global' | 'preset'
  /** Preset id when `scope` is `preset`; a row without one cannot be filtered to. */
  readonly presetId: string | undefined
}

/** One preset the roster declared; `McpPresetOption` satisfies this shape. */
export interface McpAgentFilterPreset {
  /** Preset id, as the row's `presetId` spells it. */
  readonly id: string
  /** Display name the preset published, or its id. */
  readonly name: string
}

/** One option of the agent plane's preset filter. */
export interface McpAgentFilterOption extends McpAgentFilterPreset {
  /** How many MCP rows this preset owns in the current roster. */
  readonly count: number
}

/**
 * Build the agent plane's filter from one roster read. Only presets that own
 * rows become options: the filter exists to shorten a long list, and an option
 * with nothing behind it would only add another empty view. Heaviest presets
 * come first, because they are what makes the list long.
 * @param rows - every roster row, both planes.
 * @param presets - the presets that same read declared, for display names.
 * @returns one option per preset that owns at least one MCP row.
 */
export function mcpAgentFilterOptions(
  rows: readonly McpAgentFilterRow[],
  presets: readonly McpAgentFilterPreset[],
): readonly McpAgentFilterOption[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const id = row.scope === 'preset' ? row.presetId ?? MCP_ALL_PRESETS : MCP_ALL_PRESETS
    if (id === MCP_ALL_PRESETS) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const names = new Map(presets.map(preset => [preset.id, preset.name]))
  return [...counts.entries()]
    .map(([id, count]) => ({ id, name: names.get(id) ?? id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id))
}

/**
 * The agent rows one filter value shows. Callers pass a value the roster still
 * offers (see {@link mcpAgentFilterOptions}), so an unknown id shows nothing —
 * the section keeps the select and the list on one value instead of guessing.
 * @param rows - every roster row, both planes.
 * @param presetId - the chosen preset, or {@link MCP_ALL_PRESETS} for all of them.
 * @returns the agent-plane rows that value shows.
 */
export function narrowMcpRows<T extends McpAgentFilterRow>(
  rows: readonly T[],
  presetId: string,
): readonly T[] {
  const agentRows = rows.filter(row => row.scope === 'preset')
  return presetId === MCP_ALL_PRESETS ? agentRows : agentRows.filter(row => row.presetId === presetId)
}
