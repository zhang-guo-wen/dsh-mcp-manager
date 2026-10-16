import { describe, expect, it } from 'vitest'
import { listAllTools } from '../src/lazy-mcp.ts'
import { carrierFor, type LazyClient, type LazyTool } from '../src/mcp-carrier.ts'
import { NO_TOOL_FILTER, parseMcpToolFilter } from '../src/mcp-tool-filter.ts'

/**
 * A client double that answers `tools/list` from a page table, so the walk's
 * cursor handling can be asserted without an MCP server.
 * @param pages - `cursor ?? '(first)'` to that page's tools.
 * @param next - `cursor ?? '(first)'` to the cursor of the page after it.
 * @param ttlMs - the `ttlMs` the server publishes, when it publishes one.
 * @returns the double plus the cursors it was asked for.
 */
function pagedClient(
  pages: Record<string, string[]>,
  next: Record<string, string | undefined> = {},
  ttlMs?: number,
): { client: LazyClient; asked: (string | undefined)[] } {
  const asked: (string | undefined)[] = []
  const client: LazyClient = {
    async listTools(params) {
      const cursor = params?.cursor
      asked.push(cursor)
      const key = cursor ?? '(first)'
      const tools: LazyTool[] = (pages[key] ?? []).map(name => ({ name }))
      const following = next[key]
      return {
        tools,
        ...following === undefined ? {} : { nextCursor: following },
        ...ttlMs === undefined ? {} : { ttlMs },
      }
    },
    async callTool() { return { content: [] } },
    async close() {},
  }
  return { client, asked }
}

describe('listAllTools', () => {
  it('stops at the page with no nextCursor', async () => {
    const { client, asked } = pagedClient({ '(first)': ['a', 'b'], page2: ['c'] }, { '(first)': 'page2' })
    const discovery = await listAllTools(client, 100)
    expect(discovery.tools.map(tool => tool.name)).toEqual(['a', 'b', 'c'])
    expect(discovery.truncated).toBe(false)
    expect(asked).toEqual([undefined, 'page2'])
  })

  it('treats the empty string as a valid cursor, not as the end of the list', async () => {
    // The spec says an empty cursor is legal and a missing nextCursor is the
    // only end-of-list signal; a truthiness check would silently drop page two.
    const { client, asked } = pagedClient(
      { '(first)': ['a'], '': ['b'] },
      { '(first)': '', '': undefined },
    )
    const discovery = await listAllTools(client, 100)
    expect(discovery.tools.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(asked).toEqual([undefined, ''])
  })

  it('cuts the walk at the collection cap and says so', async () => {
    const { client } = pagedClient({ '(first)': ['a', 'b', 'c'] })
    const discovery = await listAllTools(client, 2)
    expect(discovery.tools.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(discovery.truncated).toBe(true)
  })

  it('gives up on a server that always offers another page', async () => {
    let page = 0
    const client: LazyClient = {
      async listTools() {
        page += 1
        return { tools: [{ name: `t${page}` }], nextCursor: `c${page}` }
      },
      async callTool() { return { content: [] } },
      async close() {},
    }
    const discovery = await listAllTools(client, 10_000)
    expect(discovery.truncated).toBe(true)
    expect(discovery.tools).toHaveLength(64)
  })

  it('forwards the freshness hint the server published', async () => {
    const { client } = pagedClient({ '(first)': ['a'] }, {}, 1_234)
    expect((await listAllTools(client, 10)).ttlMs).toBe(1_234)
  })
})

describe('carrierFor narrowing', () => {
  const rules = parseMcpToolFilter(['!delete_*'])

  it('keeps the mode as the first word', () => {
    expect(carrierFor('eager', NO_TOOL_FILTER, true)).toBeUndefined()
    expect(carrierFor('lazy', NO_TOOL_FILTER, true)).toBe('proxy')
    expect(carrierFor('lazy', rules, true)).toBe('proxy')
  })

  it('mounts whole servers when nothing narrows them', () => {
    expect(carrierFor('dynamic', NO_TOOL_FILTER)).toBe('mount')
    expect(carrierFor('dynamic', NO_TOOL_FILTER, false)).toBe('mount')
  })

  it('registers individual tools when a rule or the load narrows them', () => {
    // A narrowed load cannot use mcp-client's mount: it registers every
    // discovered tool and cannot hold the rest back.
    expect(carrierFor('dynamic', rules)).toBe('native')
    expect(carrierFor('dynamic', NO_TOOL_FILTER, true)).toBe('native')
  })
})
