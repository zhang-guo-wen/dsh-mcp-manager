import { describe, expect, it } from 'vitest'
import { McpCatalog, catalogIdentity, type McpCatalogStorage } from '../src/mcp-catalog.ts'
import { mcpEntryConfig } from '../src/mcp-config.ts'

const local = mcpEntryConfig({ type: 'stdio', command: 'fixture' }, 'local')
const remote = mcpEntryConfig({ type: 'http', url: 'https://example.test/mcp', headers: { Authorization: 'secret' } }, 'cloud')
const record = { tools: [{ name: 'one', description: 'A tool', inputSchema: { type: 'object' } }], truncated: false }
function storage() {
  let disk: unknown
  const value: McpCatalogStorage = { load: async () => disk, save: async next => { disk = structuredClone(next) } }
  return value
}

describe('durable MCP catalogue', () => {
  it('keeps local records without an age limit, ignoring local TTL hints', () => {
    const catalog = new McpCatalog()
    catalog.remember(local, { ...record, ttlMs: 0 }, 'row', 1000)
    expect(catalog.getFor('row', local, 1_000_000_000)).toBeDefined()
    expect(catalog.stats(1_000_000_000)[0]).toMatchObject({ transport: 'stdio', expired: false })
    expect(catalog.stats()[0]).not.toHaveProperty('ttlMs')
  })

  it('uses only the HTTP server TTL, with no configurable fallback lifetime', () => {
    const catalog = new McpCatalog()
    catalog.remember(remote, { ...record, ttlMs: 500 }, 'row', 1000)
    expect(catalog.getFor('row', remote, 1500)).toBeDefined()
    expect(catalog.getFor('row', remote, 1501)).toBeUndefined()
    expect(catalog.expiredFor(remote, 1501)).toBe(true)
    expect(catalog.stats(1501)[0]).toMatchObject({ transport: 'streamable-http', ttlMs: 500, expired: true })
  })

  it('retains an HTTP record with no TTL until a real refresh or invalidation', () => {
    const catalog = new McpCatalog()
    catalog.remember(remote, record, 'row', 1000)
    expect(catalog.getFor('row', remote, 1e12)).toBeDefined()
    expect(catalog.expiredFor(remote, 1e12)).toBe(false)
  })

  it('treats server TTL zero as immediately stale, while retaining the discovered record', () => {
    const catalog = new McpCatalog()
    catalog.remember(remote, { ...record, ttlMs: 0 }, 'row', 1000)
    expect(catalog.getFor('row', remote, 1000)).toBeUndefined()
    expect(catalog.size).toBe(1)
    expect(catalog.stats(1000)[0]?.expired).toBe(true)
  })

  it('restores both local and HTTP directories with original timestamps and schemas', async () => {
    const db = storage()
    const first = new McpCatalog(db)
    first.remember(local, record, undefined, 1000)
    first.remember(remote, { ...record, ttlMs: 5000 }, undefined, 2000)
    await first.flush()
    const after = new McpCatalog(db)
    await after.restore()
    expect(after.size).toBe(2)
    expect(after.getFor('l', local, 10_000)?.tools).toEqual(record.tools)
    expect(after.getFor('r', remote, 3000)?.fetchedAt).toBe(2000)
    expect(after.getFor('r', remote, 7001)).toBeUndefined()
  })

  it('changes identity for local configuration and remote URL/headers without storing raw configuration', async () => {
    expect(catalogIdentity({ ...local, command: 'other' } as typeof local)).not.toBe(catalogIdentity(local))
    expect(catalogIdentity({ ...remote, headers: { Authorization: 'other' } } as typeof remote)).not.toBe(catalogIdentity(remote))
    const db = storage()
    const catalog = new McpCatalog(db)
    catalog.remember(remote, record, 'row')
    expect(catalog.getFor('row', { ...remote, url: 'https://other.test' } as typeof remote)).toBeUndefined()
    await catalog.flush()
    const text = JSON.stringify(await db.load())
    expect(text).not.toContain('Authorization')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('example.test')
  })

  it('retains live invalidation bindings across declaration mutations and removes all aliases', async () => {
    const db = storage()
    const catalog = new McpCatalog(db)
    catalog.remember(local, record, 'a')
    catalog.getFor('b', local)
    expect(catalog.invalidate('a')).toBe(true)
    expect(catalog.get('b')).toBeUndefined()
    await catalog.flush()
    const after = new McpCatalog(db)
    await after.restore()
    expect(after.size).toBe(0)
  })

  it('clear/close block discoveries started before their epoch', async () => {
    const catalog = new McpCatalog()
    const old = catalog.epoch
    catalog.remember(local, record)
    expect(catalog.clear()).toBe(1)
    catalog.remember(remote, record, undefined, Date.now(), old)
    expect(catalog.size).toBe(0)
    await catalog.close()
    catalog.remember(local, record)
    expect(catalog.size).toBe(0)
  })

  it('bounds both records and slow-database snapshots', async () => {
    let release!: () => void
    let writes = 0
    const blocked = new Promise<void>(resolve => { release = resolve })
    const catalog = new McpCatalog({ load: async () => undefined, save: async () => { writes += 1; await blocked } })
    for (let i = 0; i < 520; i += 1) catalog.remember({ ...local, args: [String(i)] } as typeof local, record)
    expect(catalog.size).toBe(500)
    expect(writes).toBe(1)
    release()
    await catalog.flush()
    expect(writes).toBeLessThanOrEqual(2)
  })
})
