import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExternalMcpRegistry, type ScopeLookup } from '../src/external-mcp.ts'
import type { McpEntryConfig } from '../src/mcp-config.ts'

const scopes: ScopeLookup = {
  scopeOf: ctx => (ctx as Context & { scope?: object }).scope,
  scopeChainOf: scope => scope ? [scope, ...('parent' in scope && scope.parent ? [scope.parent as object] : [])] : [],
}

const config = { serverName: 'knowledge', transport: 'streamable-http' as const, url: 'https://example.invalid/mcp', headers: {} }

describe('external MCP ownership', () => {
  it('mounts eager resources once, then releases them when the mode becomes dynamic', async () => {
    let mode: 'eager' | 'dynamic' = 'eager'
    const disposed = vi.fn(async () => {})
    const mount = vi.fn(async () => ({ dispose: disposed }))
    const changed = vi.fn(async () => {})
    const registry = new ExternalMcpRegistry(() => mode, mount, changed, scopes)
    const ctx = {} as Context
    const rows = [{ serverName: 'knowledge', scope: 'global' as const, config }]
    await registry.replace('repository', ctx, rows)
    await registry.replace('repository', ctx, rows)
    expect(mount).toHaveBeenCalledTimes(1)
    expect(mount.mock.calls[0]?.[1]).toMatchObject({ headers: {} })
    mode = 'dynamic'
    await registry.reconcile()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(registry.rows()).toHaveLength(1)
    await registry.remove('repository')
    expect(registry.rows()).toHaveLength(0)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('keeps an agent resource inside its scope and rejects an unscoped agent owner', async () => {
    const registry = new ExternalMcpRegistry(() => 'dynamic', async () => ({ dispose: async () => {} }), async () => {}, scopes)
    const ownerScope = {}
    const owner = { scope: ownerScope } as unknown as Context
    const row = { serverName: 'knowledge', scope: 'agent' as const, config }
    await registry.replace('agent', owner, [row])
    const managed = registry.rows()[0]!
    expect(registry.visible(managed, { parent: ownerScope })).toBe(true)
    expect(registry.visible(managed, {})).toBe(false)
    await expect(registry.replace('other', {} as Context, [row])).rejects.toThrow('has no agent scope')
  })

  it('fills omitted stdio defaults before handing a repository config to the loader', async () => {
    const mount = vi.fn(async (_ctx: Context, _config: McpEntryConfig) => ({ dispose: async () => {} }))
    const registry = new ExternalMcpRegistry(() => 'eager', mount, async () => {}, scopes)
    await registry.replace('repository', {} as Context, [{
      serverName: 'local', scope: 'global',
      config: { serverName: 'local', transport: 'stdio', command: 'server' } as McpEntryConfig,
    }])
    expect(mount.mock.calls[0]?.[1]).toMatchObject({ args: [], env: {}, cwd: '' })
  })

  it('serializes concurrent resource owners so tool registrations cannot overlap', async () => {
    let changing = false
    const changed = vi.fn(async () => {
      expect(changing).toBe(false)
      changing = true
      await Promise.resolve()
      changing = false
    })
    const registry = new ExternalMcpRegistry(() => 'dynamic', async () => ({ dispose: async () => {} }), changed, scopes)
    await Promise.all([
      registry.replace('first', {} as Context, [{ serverName: 'one', scope: 'global', config: { ...config, serverName: 'one' } }]),
      registry.replace('second', {} as Context, [{ serverName: 'two', scope: 'global', config: { ...config, serverName: 'two' } }]),
    ])
    expect(registry.rows().map(row => row.serverName)).toEqual(['one', 'two'])
    expect(changed).toHaveBeenCalledTimes(2)
  })
})
