import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { LazyTool } from '../src/mcp-carrier.ts'
import { McpCatalog } from '../src/mcp-catalog.ts'
import { MCP_CLIENT_MODULE } from '../src/mcp-authoring.ts'
import { NO_TOOL_FILTER, parseMcpToolFilter } from '../src/mcp-tool-filter.ts'
import { parseMcpOptimizeFlags } from '../src/mcp-optimize.ts'

/**
 * The MCP SDK's client double.
 *
 * `registerMcpTools` reaches the SDK through a dynamic import, which Vitest
 * mocks, so the whole load path — discovery, paging, filtering, registration —
 * runs against a scripted server instead of a child process.
 */
const sdk = vi.hoisted(() => ({
  pages: new Map<string, { tools: unknown[]; nextCursor?: string; ttlMs?: number }>(),
  clients: [] as {
    closed: number
    fallbackNotificationHandler?: (notification: { method?: string }) => Promise<void>
    calls: { name: string; arguments: Record<string, unknown> }[]
  }[],
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    closed = 0
    calls: { name: string; arguments: Record<string, unknown> }[] = []
    fallbackNotificationHandler?: (notification: { method?: string }) => Promise<void>

    constructor() { sdk.clients.push(this as never) }

    async connect(): Promise<void> {}

    async listTools(params?: { cursor?: string }) {
      return sdk.pages.get(params?.cursor ?? '') ?? { tools: [] }
    }

    async callTool(request: { name: string; arguments: Record<string, unknown> }) {
      this.calls.push(request)
      return { content: [{ type: 'text', text: `called ${request.name}` }] }
    }

    async close(): Promise<void> { this.closed += 1 }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))

const { registerMcpTools } = await import('../src/lazy-mcp.ts')

/** One composition row the fake Loader publishes. */
interface RowSpec {
  readonly serverName: string
}

/** The tool every test's server starts from, unless it says otherwise. */
function tools(...names: string[]): LazyTool[] {
  return names.map(name => ({ name, description: `${name} does things` }))
}

/**
 * Script the server's `tools/list` pages.
 * @param chunks - one tool array per page, in order.
 * @param ttlMs - the server's own freshness hint, when it publishes one.
 */
function setToolPages(chunks: LazyTool[][], ttlMs?: number): void {
  sdk.pages.clear()
  chunks.forEach((page, index) => {
    const key = index === 0 ? '' : `c${index}`
    const next = index + 1 < chunks.length ? `c${index + 1}` : undefined
    sdk.pages.set(key, { tools: page, ...next === undefined ? {} : { nextCursor: next }, ...ttlMs === undefined ? {} : { ttlMs } })
  })
}

/**
 * Register the on-demand tools against a fake Harness.
 * @param options.rows - the composition rows the fake Loader declares.
 * @param options.mode - the loading mode under test.
 * @param options.policy - the stored optimization policy.
 */
function harness(options: {
  rows?: readonly RowSpec[]
  mode?: 'dynamic' | 'lazy'
  policy?: Record<string, unknown>
  filters?: Record<string, unknown>
}) {
  const rows = options.rows ?? [{ serverName: 'alpha' }]
  const definitions = new Map<string, { name: string; execute(args: unknown, exec: unknown): Promise<never> }>()
  const registry = {
    register(definition: { name: string }) {
      definitions.set(definition.name, definition as never)
      return () => { definitions.delete(definition.name) }
    },
    schemas: () => [] as { name: string }[],
  }
  const entryList = rows.map(row => ({
    id: row.serverName,
    disabled: false,
    options: { id: row.serverName, name: MCP_CLIENT_MODULE, config: {} },
  }))
  const mcpClientStub = {
    name: 'mcp-client',
    inject: [] as string[],
    apply: () => {},
    createMcpToolDefinition: (_ctx: unknown, adapter: unknown) => adapter,
  }
  const services = new Map<string, unknown>([
    ['tools', registry],
    [
      'loader',
      {
        entries: () => entryList,
        internal: { import: async (spec: string) => spec === MCP_CLIENT_MODULE ? mcpClientStub : {} },
      },
    ],
    [
      'mcpManager',
      { describeMcp: async (request: { entryId: string }) => ({ spec: { type: 'stdio', command: `run-${request.entryId}` } }) },
    ],
  ])
  const rootCtx = {
    baseUrl: 'file:///fake/index.mjs',
    get: (name: string) => services.get(name),
    logger: { warn: () => {} },
  } as unknown as Context
  const agentCtx = {
    get: (name: string) => services.get(name),
    effect: () => () => {},
    plugin: async () => ({ dispose: async () => {} }),
    logger: { warn: () => {} },
  }
  const catalog = new McpCatalog<LazyTool>()
  const gate = {
    reconcile: async () => {},
    stateFor: () => undefined,
    suppressedKeys: () => [] as string[],
    dispose: () => {},
  }
  registerMcpTools(
    rootCtx,
    options.mode ?? 'lazy',
    gate as never,
    {
      filterFor: key => {
        const value = options.filters?.[key]
        return value === undefined ? NO_TOOL_FILTER : parseMcpToolFilter(value)
      },
      descriptionFor: () => undefined,
      optimize: () => parseMcpOptimizeFlags(options.policy ?? {}),
    },
    undefined,
    catalog,
  )
  const exec = { agent: { id: 'agent-1', ctx: agentCtx } }
  const run = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
    return await definition.execute(args, exec)
  }
  return { run, registered: () => [...definitions.keys()], catalog }
}

beforeEach(() => {
  sdk.pages.clear()
  sdk.clients.length = 0
})

describe('mcp_load discovery', () => {
  it('walks every tools/list page the server offers', async () => {
    setToolPages([tools('a', 'b'), tools('c')])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools.map(tool => tool.name)).toEqual(['a', 'b', 'c'])
    expect(result.total).toBe(3)
    expect(result.loaded).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('cuts the walk at the configured cap and says so', async () => {
    setToolPages([tools('a', 'b', 'c')])
    const h = harness({ policy: { maxTools: 2 } })
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(result.truncated).toBe(true)
  })

  it('remembers what it discovered, so a search needs no second connection', async () => {
    setToolPages([tools('a', 'b')])
    const h = harness({})
    await h.run('mcp_load', { server: 'alpha' })
    expect(h.catalog.size).toBe(1)
    expect(h.catalog.get('global:alpha', 60_000)?.tools).toHaveLength(2)
  })
})

describe('mcp_load listing shape', () => {
  it('lists names and descriptions without argument schemas by default', async () => {
    setToolPages([[{ name: 'a', description: 'Alpha', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools[0].description).toBe('Alpha')
    expect(result.tools[0].schema).toBeUndefined()
  })

  it('adds the schema at the full detail level', async () => {
    setToolPages([[{ name: 'a', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }]])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha', detail: 'full' })
    expect(result.tools[0].schema).toBe('{"type":"object","properties":{"q":{"type":"string"}}}')
  })

  it('honours a namesOnly=false deployment, which always carries schemas', async () => {
    setToolPages([[{ name: 'a', inputSchema: { type: 'object' } }]])
    const h = harness({ policy: { namesOnly: false } })
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools[0].schema).toBe('{"type":"object"}')
  })

  it('pages the listing without taking tools out of the session', async () => {
    setToolPages([tools('a', 'b', 'c', 'd', 'e')])
    const h = harness({ policy: { pageSize: 2 } })
    const first = await h.run('mcp_load', { server: 'alpha' })
    expect(first.tools.map(tool => tool.name)).toEqual(['a', 'b'])
    expect(first.shown).toBe(2)
    expect(first.total).toBe(5)
    // Paging is a context budget, not a capability change: every tool is loaded.
    expect(first.loaded).toBe(5)
    const second = await h.run('mcp_load', { server: 'alpha', cursor: first.nextCursor })
    expect(second.tools.map(tool => tool.name)).toEqual(['c', 'd'])
    const third = await h.run('mcp_load', { server: 'alpha', cursor: second.nextCursor })
    expect(third.tools.map(tool => tool.name)).toEqual(['e'])
    expect(third.nextCursor).toBeUndefined()
  })

  it('rejects a cursor it did not issue', async () => {
    setToolPages([tools('a')])
    const h = harness({})
    await expect(h.run('mcp_load', { server: 'alpha', cursor: 'nope' })).rejects.toThrow(/invalid cursor/)
  })
})

describe('mcp_load narrowing', () => {
  it('loads only the tools a query matches', async () => {
    setToolPages([
      [
        { name: 'create_issue', description: 'open a work item' },
        { name: 'list_projects', description: 'all projects' },
        { name: 'delete_issue', description: 'remove a work item' },
      ],
    ])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha', query: 'issue' })
    expect(result.tools.map(tool => tool.name)).toEqual(['create_issue', 'delete_issue'])
    expect(result.loaded).toBe(2)
    expect(result.hidden).toBe(1)
  })

  it('loads one named tool and reports its schema', async () => {
    setToolPages([[{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b' }]])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha', tool: 'a' })
    expect(result.tools.map(tool => tool.name)).toEqual(['a'])
    expect(result.tools[0].schema).toBe('{"type":"object"}')
    expect(result.loaded).toBe(1)
    expect(result.hidden).toBe(1)
  })

  it('refuses a name the server does not publish', async () => {
    setToolPages([tools('a')])
    const h = harness({})
    await expect(h.run('mcp_load', { server: 'alpha', tool: 'nope' })).rejects.toThrow(/publishes no tool "nope"/)
  })

  it('leaves no empty mount behind when a query matches nothing', async () => {
    setToolPages([tools('a', 'b')])
    const h = harness({})
    const empty = await h.run('mcp_load', { server: 'alpha', query: 'nothing-here' })
    expect(empty.total).toBe(0)
    expect(empty.loaded).toBe(0)
    // The next load must still find the server, which an empty mount would hide.
    const full = await h.run('mcp_load', { server: 'alpha' })
    expect(full.tools.map(tool => tool.name)).toEqual(['a', 'b'])
  })

  it('widens an already-loaded server to a later query', async () => {
    setToolPages([tools('create_issue', 'list_projects')])
    const h = harness({})
    const first = await h.run('mcp_load', { server: 'alpha', query: 'create' })
    expect(first.loaded).toBe(1)
    const second = await h.run('mcp_load', { server: 'alpha', query: 'list' })
    expect(second.loaded).toBe(2)
    expect(second.tools.map(tool => tool.name)).toEqual(['list_projects'])
  })
})

describe('mcp_load with the row rules and the annotation policy', () => {
  it('applies the row filter before anything reaches the model', async () => {
    setToolPages([tools('get_issue', 'delete_issue')])
    const h = harness({ filters: { 'global:alpha': ['!delete_*'] } })
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools.map(tool => tool.name)).toEqual(['get_issue'])
    expect(result.hidden).toBe(1)
  })

  it('hides explicitly destructive tools when the policy asks', async () => {
    setToolPages([
      [
        { name: 'read', annotations: { readOnlyHint: true } },
        { name: 'drop', annotations: { destructiveHint: true } },
        { name: 'silent' },
      ],
    ])
    const h = harness({ policy: { hideDestructive: true } })
    const result = await h.run('mcp_load', { server: 'alpha', detail: 'full' })
    expect(result.tools.map(tool => tool.name)).toEqual(['read', 'silent'])
    expect(result.hidden).toBe(1)
  })

  it('reports the annotations the server published, and nothing when it published none', async () => {
    setToolPages([[{ name: 'read', annotations: { readOnlyHint: true, idempotentHint: true } }, { name: 'plain' }]])
    const h = harness({})
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools[0].annotations).toEqual(['read-only', 'idempotent'])
    expect(result.tools[1].annotations).toBeUndefined()
  })

  it('drops annotations from a listing when the setting is off', async () => {
    setToolPages([[{ name: 'read', annotations: { readOnlyHint: true } }]])
    const h = harness({ policy: { annotations: false } })
    const result = await h.run('mcp_load', { server: 'alpha' })
    expect(result.tools[0].annotations).toBeUndefined()
  })
})

describe('mcp_call under the proxy carrier', () => {
  it('forwards to the raw upstream name', async () => {
    setToolPages([tools('a')])
    const h = harness({ mode: 'lazy' })
    await h.run('mcp_load', { server: 'alpha' })
    const result = await h.run('mcp_call', { server: 'alpha', tool: 'a', arguments: { q: 1 } })
    expect(result.text).toBe('called a')
    expect(sdk.clients[0]?.calls).toEqual([{ name: 'a', arguments: { q: 1 } }])
  })

  it('refuses a tool the load did not admit', async () => {
    setToolPages([tools('a', 'b')])
    const h = harness({ mode: 'lazy' })
    await h.run('mcp_load', { server: 'alpha', query: 'a' })
    await expect(h.run('mcp_call', { server: 'alpha', tool: 'b', arguments: {} }))
      .rejects.toThrow(/exposes no tool "b"/)
  })
})

describe('mcp_search', () => {
  it('is registered when the policy asks for it, and not when it does not', () => {
    setToolPages([tools('a')])
    expect(harness({}).registered()).toContain('mcp_search')
    expect(harness({ policy: { search: false } }).registered()).not.toContain('mcp_search')
  })

  it('answers from what a load catalogued and names the servers it could not see', async () => {
    setToolPages([[
      { name: 'create_issue', description: 'open a work item' },
      { name: 'list_projects', description: 'all projects' },
    ]])
    const h = harness({ rows: [{ serverName: 'alpha' }, { serverName: 'beta' }] })
    await h.run('mcp_load', { server: 'alpha' })
    const result = await h.run('mcp_search', { query: 'issue' })
    expect(result.hits).toEqual([{ server: 'alpha', tool: 'create_issue', description: 'open a work item' }])
    expect(result.total).toBe(1)
    expect(result.indexed).toBe(1)
    expect(result.pending).toEqual(['beta'])
  })

  it('pages its matches', async () => {
    setToolPages([tools('issue_one', 'issue_two', 'issue_three')])
    const h = harness({ policy: { pageSize: 2 } })
    await h.run('mcp_load', { server: 'alpha' })
    const first = await h.run('mcp_search', { query: 'issue' })
    expect(first.hits).toHaveLength(2)
    expect(first.total).toBe(3)
    const second = await h.run('mcp_search', { query: 'issue', cursor: first.nextCursor })
    expect(second.hits.map(hit => hit.tool)).toEqual(['issue_three'])
  })

  it('can be narrowed to one server', async () => {
    setToolPages([tools('issue_one')])
    const h = harness({ rows: [{ serverName: 'alpha' }, { serverName: 'beta' }] })
    await h.run('mcp_load', { server: 'alpha' })
    const result = await h.run('mcp_search', { query: 'issue', server: 'beta' })
    expect(result.hits).toEqual([])
    expect(result.pending).toEqual(['beta'])
  })

  it('indexes an uncached server only when the policy allows connecting', async () => {
    setToolPages([tools('issue_one')])
    const offline = harness({ rows: [{ serverName: 'alpha' }, { serverName: 'beta' }] })
    await offline.run('mcp_load', { server: 'alpha' })
    expect((await offline.run('mcp_search', { query: 'issue' })).indexed).toBe(1)

    sdk.pages.clear()
    sdk.clients.length = 0
    setToolPages([tools('issue_one')])
    const online = harness({ rows: [{ serverName: 'alpha' }, { serverName: 'beta' }], policy: { searchIndex: true } })
    await online.run('mcp_load', { server: 'alpha' })
    const result = await online.run('mcp_search', { query: 'issue' })
    expect(result.indexed).toBe(2)
    expect(result.pending).toEqual([])
    // The indexing connection is closed again; the session loaded nothing extra.
    expect(online.catalog.size).toBe(2)
  })

  it('never surfaces a tool the row rules hide', async () => {
    setToolPages([tools('get_issue', 'delete_issue')])
    const h = harness({ filters: { 'global:alpha': ['!delete_*'] } })
    await h.run('mcp_load', { server: 'alpha' })
    const result = await h.run('mcp_search', { query: 'issue' })
    expect(result.hits.map(hit => hit.tool)).toEqual(['get_issue'])
  })
})

describe('tools/list_changed', () => {
  it('invalidates the catalogue entry for the server that changed', async () => {
    setToolPages([tools('a')])
    const h = harness({})
    await h.run('mcp_load', { server: 'alpha' })
    expect(h.catalog.size).toBe(1)
    await sdk.clients[0]?.fallbackNotificationHandler?.({ method: 'notifications/tools/list_changed' })
    expect(h.catalog.size).toBe(0)
  })

  it('ignores a notification it does not own', async () => {
    setToolPages([tools('a')])
    const h = harness({})
    await h.run('mcp_load', { server: 'alpha' })
    await sdk.clients[0]?.fallbackNotificationHandler?.({ method: 'notifications/resources/list_changed' })
    expect(h.catalog.size).toBe(1)
  })
})
