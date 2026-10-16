import { describe, expect, it } from 'vitest'
import {
  annotationSummary,
  applyAnnotationPolicy,
  decodeToolCursor,
  encodeToolCursor,
  matchTools,
  mcpRegistrationKey,
  MCP_OPTIMIZE_DEFAULTS,
  paginateTools,
  parseMcpOptimizeFlags,
  toolMatchesQuery,
  type PolicyTool,
} from '../src/mcp-optimize.ts'

const tool = (name: string, extra: Partial<PolicyTool> = {}): PolicyTool => ({ name, ...extra })

describe('parseMcpOptimizeFlags', () => {
  it('falls back to the defaults for anything that is not a settings object', () => {
    expect(parseMcpOptimizeFlags(undefined)).toEqual(MCP_OPTIMIZE_DEFAULTS)
    expect(parseMcpOptimizeFlags('nonsense')).toEqual(MCP_OPTIMIZE_DEFAULTS)
    expect(parseMcpOptimizeFlags([1, 2])).toEqual(MCP_OPTIMIZE_DEFAULTS)
    expect(parseMcpOptimizeFlags({})).toEqual(MCP_OPTIMIZE_DEFAULTS)
  })

  it('converges a mistyped field to its default and keeps the rest', () => {
    // A settings document is hand-edited: one typo must not take the other
    // fields down with it.
    const flags = parseMcpOptimizeFlags({ search: 'yes', namesOnly: false })
    expect(flags.search).toBe(MCP_OPTIMIZE_DEFAULTS.search)
    expect(flags.namesOnly).toBe(false)
  })

  it('clamps a page size instead of rejecting it', () => {
    expect(parseMcpOptimizeFlags({ pageSize: 0 }).pageSize).toBe(1)
    expect(parseMcpOptimizeFlags({ pageSize: 10_000 }).pageSize).toBe(50)
    expect(parseMcpOptimizeFlags({ pageSize: 12.6 }).pageSize).toBe(13)
    expect(parseMcpOptimizeFlags({ pageSize: Number.NaN }).pageSize).toBe(MCP_OPTIMIZE_DEFAULTS.pageSize)
  })

  it('accepts a zero cache lifetime, which means "never reuse"', () => {
    expect(parseMcpOptimizeFlags({ catalogTtlMs: 0 }).catalogTtlMs).toBe(0)
    expect(parseMcpOptimizeFlags({ catalogTtlMs: -5 }).catalogTtlMs).toBe(0)
    expect(parseMcpOptimizeFlags({ catalogTtlMs: 1e12 }).catalogTtlMs).toBe(24 * 60 * 60 * 1_000)
  })
})

describe('mcpRegistrationKey', () => {
  it('changes exactly when the registered tool set must be rebuilt', () => {
    const base = MCP_OPTIMIZE_DEFAULTS
    expect(mcpRegistrationKey(base)).toBe(mcpRegistrationKey({ ...base, pageSize: 25 }))
    expect(mcpRegistrationKey(base)).toBe(mcpRegistrationKey({ ...base, namesOnly: false }))
    expect(mcpRegistrationKey(base)).not.toBe(mcpRegistrationKey({ ...base, search: false }))
  })
})

describe('matchTools', () => {
  it('returns everything for a blank query', () => {
    const tools = [tool('a'), tool('b')]
    expect(matchTools(tools, '   ')).toEqual(tools)
  })

  it('requires every term, matching any of name, title, or description', () => {
    const tools = [
      tool('create_issue', { description: 'Open a work item' }),
      tool('delete_issue', { description: 'Remove a work item' }),
      tool('list_projects', { description: 'List projects' }),
    ]
    expect(matchTools(tools, 'issue').map(entry => entry.name)).toEqual(['create_issue', 'delete_issue'])
    expect(matchTools(tools, 'work item').map(entry => entry.name)).toEqual(['create_issue', 'delete_issue'])
    expect(matchTools(tools, 'issue project')).toEqual([])
  })

  it('ranks an exact name match first, then a name hit over a description hit', () => {
    const tools = [
      tool('search_issues', { description: 'Search' }),
      tool('issues', { description: 'All issues' }),
      tool('create', { description: 'Create an issues entry' }),
    ]
    expect(matchTools(tools, 'issues').map(entry => entry.name)).toEqual(['issues', 'search_issues', 'create'])
  })

  it('is case-insensitive and compatibility-normalized', () => {
    const tools = [tool('Create_Issue', { description: 'ＦＵＬＬ width' })]
    expect(matchTools(tools, 'create_issue')).toHaveLength(1)
    expect(matchTools(tools, 'full width')).toHaveLength(1)
  })

  it('reads a wildcard character as "nothing", so get_* finds the prefix', () => {
    const tools = [tool('get_issue'), tool('put_issue')]
    expect(matchTools(tools, 'get_*').map(entry => entry.name)).toEqual(['get_issue'])
  })

  it('keeps the server order for equally relevant tools', () => {
    const tools = [tool('alpha_one'), tool('alpha_two')]
    expect(matchTools(tools, 'alpha').map(entry => entry.name)).toEqual(['alpha_one', 'alpha_two'])
  })

  it('exposes the same predicate through toolMatchesQuery', () => {
    expect(toolMatchesQuery(tool('get_issue', { description: 'Fetch one' }), 'fetch')).toBe(true)
    expect(toolMatchesQuery(tool('get_issue'), 'fetch')).toBe(false)
    expect(toolMatchesQuery(tool('get_issue'), '')).toBe(true)
  })
})

describe('applyAnnotationPolicy', () => {
  const destructive = tool('drop_table', { annotations: { destructiveHint: true } })
  const plain = tool('read_file', { annotations: { readOnlyHint: true } })
  const silent = tool('unknown')

  it('keeps everything while the policy is off', () => {
    const selection = applyAnnotationPolicy([destructive, plain, silent], MCP_OPTIMIZE_DEFAULTS)
    expect(selection.visible).toHaveLength(3)
    expect(selection.hidden).toBe(0)
  })

  it('hides only an explicit destructive declaration', () => {
    // The spec defaults an absent destructiveHint to true, so treating absence
    // as destructive would hide every tool of every unannotated server.
    const policy = { ...MCP_OPTIMIZE_DEFAULTS, hideDestructive: true }
    const selection = applyAnnotationPolicy([destructive, plain, silent], policy)
    expect(selection.visible.map(entry => entry.name)).toEqual(['read_file', 'unknown'])
    expect(selection.hidden).toBe(1)
  })
})

describe('annotationSummary', () => {
  it('reports only the hints the server actually published', () => {
    const policy = MCP_OPTIMIZE_DEFAULTS
    expect(annotationSummary(tool('a', { annotations: { readOnlyHint: true, idempotentHint: true } }), policy))
      .toEqual(['read-only', 'idempotent'])
    expect(annotationSummary(tool('b', { annotations: { destructiveHint: true, openWorldHint: true } }), policy))
      .toEqual(['destructive', 'open-world'])
  })

  it('reports nothing without annotations, or when the setting is off', () => {
    expect(annotationSummary(tool('a'), MCP_OPTIMIZE_DEFAULTS)).toEqual([])
    const off = { ...MCP_OPTIMIZE_DEFAULTS, annotations: false }
    expect(annotationSummary(tool('a', { annotations: { readOnlyHint: true } }), off)).toEqual([])
  })
})

describe('paginateTools', () => {
  const items = ['a', 'b', 'c', 'd', 'e']

  it('returns the first page with a cursor for the next one', () => {
    const page = paginateTools(items, undefined, 2)
    expect(page.page).toEqual(['a', 'b'])
    expect(page.offset).toBe(0)
    expect(page.total).toBe(5)
    expect(page.nextCursor).toBeDefined()
  })

  it('walks to the end and then stops offering a cursor', () => {
    const first = paginateTools(items, undefined, 2)
    const second = paginateTools(items, first.nextCursor, 2)
    const third = paginateTools(items, second.nextCursor, 2)
    expect(second.page).toEqual(['c', 'd'])
    expect(third.page).toEqual(['e'])
    expect(third.nextCursor).toBeUndefined()
  })

  it('answers an offset past the end with an empty page rather than a crash', () => {
    const page = paginateTools(items, encodeToolCursor(99), 2)
    expect(page.page).toEqual([])
    expect(page.nextCursor).toBeUndefined()
  })

  it('rejects a cursor this build did not issue', () => {
    expect(() => paginateTools(items, 'not-a-cursor', 2)).toThrow(/invalid cursor/)
    expect(() => decodeToolCursor('')).toThrow(/invalid cursor/)
    expect(() => decodeToolCursor('o-1')).toThrow(/invalid cursor/)
  })

  it('round-trips an offset through the opaque cursor', () => {
    expect(decodeToolCursor(encodeToolCursor(41))).toBe(41)
  })
})
