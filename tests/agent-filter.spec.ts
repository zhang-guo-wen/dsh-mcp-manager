import { describe, expect, it } from 'vitest'
import {
  MCP_ALL_PRESETS,
  mcpAgentFilterOptions,
  narrowMcpRows,
  type McpAgentFilterPreset,
  type McpAgentFilterRow,
} from '../src/client/agent-filter.ts'

/** A roster row plus the name the expectations read back. */
interface Row extends McpAgentFilterRow {
  readonly serverName: string
}

/** One roster row; only the fields the agent filter reads matter here. */
function server(serverName: string, scope: 'global' | 'preset', presetId?: string): Row {
  return { serverName, scope, presetId }
}

/** One declared preset. */
function preset(id: string, name?: string): McpAgentFilterPreset {
  return { id, name: name ?? id }
}

describe('mcpAgentFilterOptions', () => {
  it('offers one option per preset that owns rows, with its row count', () => {
    const servers = [
      server('global-one', 'global'),
      server('a', 'preset', 'standard'),
      server('b', 'preset', 'standard'),
      server('c', 'preset', 'research'),
    ]
    expect(mcpAgentFilterOptions(servers, [preset('standard'), preset('research'), preset('empty')]))
      .toEqual([
        { id: 'standard', name: 'standard', count: 2 },
        { id: 'research', name: 'research', count: 1 },
      ])
  })

  it('labels options with the declared display name and falls back to the id', () => {
    const servers = [server('a', 'preset', 'standard-yunxiao'), server('b', 'preset', 'untitled')]
    const options = mcpAgentFilterOptions(servers, [preset('standard-yunxiao', '云效')])
    expect(options).toEqual([
      { id: 'standard-yunxiao', name: '云效', count: 1 },
      { id: 'untitled', name: 'untitled', count: 1 },
    ])
  })

  it('never spends the every-preset value on a row without a preset id', () => {
    expect(MCP_ALL_PRESETS).toBe('')
    expect(mcpAgentFilterOptions([server('a', 'preset', undefined), server('b', 'preset')], [])).toEqual([])
  })

  it('is empty when the roster holds no agent row', () => {
    expect(mcpAgentFilterOptions([server('g', 'global')], [preset('standard')])).toEqual([])
  })
})

describe('narrowMcpRows', () => {
  const servers = [
    server('global-one', 'global'),
    server('a', 'preset', 'standard'),
    server('b', 'preset', 'research'),
  ]

  it('keeps every preset for the every-preset value, and only agent rows', () => {
    expect(narrowMcpRows(servers, MCP_ALL_PRESETS).map(row => row.serverName)).toEqual(['a', 'b'])
  })

  it('keeps one preset’s rows, so the list is what the select shows', () => {
    expect(narrowMcpRows(servers, 'research').map(row => row.serverName)).toEqual(['b'])
  })

  it('selects nothing for a value the roster no longer offers', () => {
    expect(narrowMcpRows(servers, 'removed')).toEqual([])
  })
})
