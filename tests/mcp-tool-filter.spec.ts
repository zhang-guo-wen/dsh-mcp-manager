import { describe, expect, it } from 'vitest'
import { filterMcpTools, parseMcpToolFilter } from '../src/mcp-tool-filter.ts'

const tools = [
  { name: 'create_workitem' },
  { name: 'get_workitem' },
  { name: 'delete_workitem' },
  { name: 'list_pipelines' },
]

const visible = (rules: unknown): string[] =>
  filterMcpTools(tools, parseMcpToolFilter(rules)).visible.map(tool => tool.name)

describe('mcp-tool-filter', () => {
  it('hides nothing without rules', () => {
    expect(visible(undefined)).toHaveLength(4)
    expect(visible([])).toHaveLength(4)
  })

  it('treats plain entries as an allow list', () => {
    expect(visible(['create_workitem', 'get_workitem'])).toEqual(['create_workitem', 'get_workitem'])
  })

  it('treats bang entries as a deny list', () => {
    expect(visible(['!delete_*'])).toEqual(['create_workitem', 'get_workitem', 'list_pipelines'])
  })

  it('applies exclusions after allows', () => {
    expect(visible(['*item*', '!delete_*'])).toEqual(['create_workitem', 'get_workitem'])
  })

  it('counts what it hid', () => {
    expect(filterMcpTools(tools, parseMcpToolFilter(['get_workitem'])).hidden).toBe(3)
    expect(filterMcpTools(tools, parseMcpToolFilter(['!*'])).visible).toEqual([])
  })

  it('escapes regular-expression metacharacters', () => {
    expect(visible(['a.b'])).toEqual([])
    expect(visible(['create_workitem'])).toEqual(['create_workitem'])
  })

  it('matches case-sensitively', () => {
    expect(visible(['Get_Workitem'])).toEqual([])
  })

  it('ignores malformed stored values', () => {
    expect(visible({ nope: true })).toHaveLength(4)
    expect(visible([1, null, '   ', true])).toHaveLength(4)
    expect(visible('create_workitem')).toEqual(['create_workitem'])
  })
})
