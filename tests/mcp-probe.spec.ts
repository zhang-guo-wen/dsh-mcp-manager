import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpCatalog } from '../src/mcp-catalog.ts'
import { databaseCatalogStorage } from '../src/mcp-catalog-store.ts'
import { mcpEntryConfig } from '../src/mcp-config.ts'
import type { LazyTool } from '../src/mcp-carrier.ts'
import { McpManager } from '../lib/index.mjs'

const sdk = vi.hoisted(() => ({ clients: [] as { closed: number }[], fail: false }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {
  closed = 0
  constructor() { sdk.clients.push(this) }
  async connect() { if (sdk.fail) throw new Error('fixture refused') }
  async listTools() { return { tools: [{ name: 'probe_tool', description: 'A tool', inputSchema: { type: 'object' } }] } }
  async close() { this.closed += 1 }
} }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))
const contexts: Context[] = []
const root = resolve(import.meta.dirname, '../../.scratch/mcp-probe-tests', randomUUID())
function manager(catalog: McpCatalog<LazyTool>) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('loader', {} as never)
  return new McpManager(ctx, { reconcile: async () => {} } as never, () => [], {} as never, () => 'dynamic', catalog as never)
}
beforeEach(() => { sdk.clients.length = 0; sdk.fail = false })
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

describe('connection probe database persistence', () => {
  it.each(['stdio', 'http', 'sse', 'streamable-http'] as const)('persists %s tools before returning and restores after restart', async type => {
    const filename = join(root, `${type}.sqlite`)
    const catalog = new McpCatalog<LazyTool>(databaseCatalogStorage(filename))
    const service = manager(catalog)
    const spec = type === 'stdio' ? { type, command: 'node', args: ['fixture'] } : { type, url: 'http://localhost:1234/mcp' }
    const request = { serverName: 'fixture', spec }
    const result = await service.listMcpTools(request)
    expect(result.tools[0]?.name).toBe('probe_tool')
    expect(result.tools[0]?.tokens).toBeGreaterThan(0)
    expect(sdk.clients[0]?.closed).toBe(1)
    expect((await readFile(filename)).subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
    const restarted = new McpCatalog<LazyTool>(databaseCatalogStorage(filename))
    await restarted.restore()
    expect(restarted.getFor('global:fixture', mcpEntryConfig(spec, 'fixture'))?.tools[0]?.inputSchema).toEqual({ type: 'object' })
    await service.clearCatalog({})
    const empty = new McpCatalog<LazyTool>(databaseCatalogStorage(filename))
    await empty.restore()
    expect(empty.size).toBe(0)
  })

  it('does not cache a failed probe and closes the failed connection', async () => {
    const catalog = new McpCatalog<LazyTool>(databaseCatalogStorage(join(root, 'failed.sqlite')))
    sdk.fail = true
    await expect(manager(catalog).listMcpTools({ serverName: 'bad', spec: { type: 'stdio', command: 'bad' } })).rejects.toThrow('did not answer')
    expect(catalog.size).toBe(0)
    expect(sdk.clients[0]?.closed).toBe(1)
  })

  it('does not claim persistence on database failure for either transport', async () => {
    for (const spec of [{ type: 'stdio' as const, command: 'node' }, { type: 'http' as const, url: 'https://example.test' }]) {
      const catalog = new McpCatalog<LazyTool>({ load: async () => undefined, save: async () => { throw new Error('private disk failure') } })
      await expect(manager(catalog).listMcpTools({ serverName: 'fixture', spec })).rejects.toThrow('could not be persisted')
    }
    expect(sdk.clients.every(client => client.closed === 1)).toBe(true)
  })
})

describe('explicit server catalogue refresh', () => {
  it('refreshes only current HTTP declarations and leaves local database records untouched', async () => {
    const catalog = new McpCatalog<LazyTool>(databaseCatalogStorage(join(root, 'refresh.sqlite')))
    const local = mcpEntryConfig({ type: 'stdio', command: 'do-not-run' }, 'local')
    const cloud = mcpEntryConfig({ type: 'http', url: 'https://example.test' }, 'cloud')
    catalog.remember(local, { tools: [{ name: 'local_saved' }], truncated: false })
    await catalog.flush()
    const ctx = new Context(); contexts.push(ctx)
    ctx.provide('loader', { entries: () => [], } as never)
    const external = { rows: () => [{ owner: 'fixture', serverName: 'local', config: local }, { owner: 'fixture', serverName: 'cloud', config: cloud }] }
    const service = new McpManager(ctx, { reconcile: async () => {}, suppressedEntryIds: () => [] } as never, () => [], external as never, () => 'dynamic', catalog as never)
    const result = await service.refreshCatalog({})
    expect(result).toEqual({ refreshed: 1, failed: [] })
    expect(sdk.clients).toHaveLength(1)
    expect(catalog.getFor('local', local)?.tools[0]?.name).toBe('local_saved')
    expect(catalog.getFor('remote', cloud)?.tools[0]?.name).toBe('probe_tool')
    sdk.fail = true
    const failed = await service.refreshCatalog({})
    expect(failed.refreshed).toBe(0)
    expect(failed.failed[0]?.serverName).toBe('cloud')
    expect(catalog.getFor('remote', cloud)?.tools[0]?.name).toBe('probe_tool')
  })
})
