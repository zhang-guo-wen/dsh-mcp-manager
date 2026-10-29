import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogDatabasePath, databaseCatalogStorage } from '../src/mcp-catalog-store.ts'

// All test files are unique workspace artifacts; no daily DSH_HOME or OS temp is used.
const root = resolve(import.meta.dirname, '../../.scratch/mcp-catalog-store-tests', randomUUID())
const path = (name: string) => join(root, name, 'catalog.sqlite')
const identity = (name: string) => createHash('sha256').update(name).digest('hex')
const snapshot = (...entries: ReturnType<typeof record>[]) => ({ version: 1, entries })
function record(name: string, transport: 'stdio' | 'streamable-http' = 'stdio', description = 'Public tool description') {
  return {
    identity: identity(name), label: name, transport,
    entry: { transport, fetchedAt: 1_000, truncated: false, tools: [{ name: 'find_tool', description, inputSchema: { type: 'object' } }] },
  }
}
function loaded(value: unknown) { return value as ReturnType<typeof snapshot> }
async function inspect(filename: string, operation: (db: import('node:sqlite').DatabaseSync) => void): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(filename)
  try { operation(db) } finally { db.close() }
}

describe('SQLite MCP catalogue storage', () => {
  it('does not create a database during a cache miss or merely constructing the storage', async () => {
    const filename = path('missing')
    const storage = databaseCatalogStorage(filename)
    await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await storage.load()).toBeUndefined()
    await expect(stat(filename)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('stores both transports as real SQLite and restores tools and server TTL after reopening', async () => {
    const filename = path('restart')
    const storage = databaseCatalogStorage(filename)
    const local = record('local')
    const remote = { ...record('remote', 'streamable-http'), entry: { ...record('remote', 'streamable-http').entry, serverTtlMs: 500 } }
    await storage.save(snapshot(local, remote))
    expect((await readFile(filename)).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000')
    const reopened = databaseCatalogStorage(filename)
    expect(await reopened.load()).toEqual(snapshot(local, remote))
    await inspect(filename, db => {
      expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'clear_generation'").get()?.value).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_entries').get()?.count).toBe(2)
    })
    if (process.platform !== 'win32') {
      expect((await stat(filename)).mode & 0o777).toBe(0o600)
      expect((await stat(dirname(filename))).mode & 0o777).toBe(0o700)
    }
  })

  it('accepts the snapshot transport field without requiring a redundant nested transport', async () => {
    const filename = path('outer-transport')
    const item = record('remote', 'streamable-http')
    const { transport: _transport, ...entry } = item.entry
    await databaseCatalogStorage(filename).save({ version: 1, entries: [{ ...item, entry }] })
    expect(await databaseCatalogStorage(filename).load()).toEqual(snapshot(item))
  })

  it('projects only public definitions and does not save config or private tool fields', async () => {
    const filename = path('projection')
    const item = record('public')
    await databaseCatalogStorage(filename).save({ version: 1, entries: [{ ...item,
      config: { command: 'private-command', env: { TOKEN: 'private-secret' }, headers: { Authorization: 'private-header' } },
      entry: { ...item.entry, privateEntry: 'private-entry', tools: [{ ...item.entry.tools[0], privateDebug: 'private-tool' }] },
    }] })
    expect(await databaseCatalogStorage(filename).load()).toEqual(snapshot(item))
    const bytes = (await readFile(filename)).toString('utf8')
    for (const secret of ['private-command', 'private-secret', 'private-header', 'private-entry', 'private-tool']) expect(bytes).not.toContain(secret)
  })

  it('merges independent writers and applies deletions without erasing unrelated discoveries', async () => {
    const filename = path('merge')
    const first = databaseCatalogStorage(filename)
    const second = databaseCatalogStorage(filename)
    await Promise.all([first.load(), second.load()])
    const a = record('a')
    const b = record('b', 'streamable-http')
    await Promise.all([first.save(snapshot(a)), second.save(snapshot(b))])
    expect(loaded(await databaseCatalogStorage(filename).load()).entries.sort((a, b) => a.label.localeCompare(b.label))).toEqual([a, b])
    await first.save(snapshot())
    expect(loaded(await databaseCatalogStorage(filename).load()).entries).toEqual([b])
    await second.save(snapshot(b, record('c')))
    expect(loaded(await databaseCatalogStorage(filename).load()).entries.map(item => item.label)).toEqual(['b', 'c'])
  })

  it('does not reinsert unchanged baseline records deleted by another writer', async () => {
    const filename = path('unchanged')
    const original = databaseCatalogStorage(filename)
    const a = record('a')
    await original.save(snapshot(a))
    const other = databaseCatalogStorage(filename)
    await other.load()
    await original.save(snapshot())
    await other.save(snapshot(a, record('b')))
    expect(loaded(await databaseCatalogStorage(filename).load()).entries.map(item => item.label)).toEqual(['b'])
  })

  it('advances shared clear generation and rejects an older writer without resurrecting entries', async () => {
    const filename = path('generation')
    const active = databaseCatalogStorage(filename)
    const stale = databaseCatalogStorage(filename)
    await Promise.all([active.load(), stale.load()])
    await active.save(snapshot(record('before')))
    await active.save(snapshot(), true)
    await expect(stale.save(snapshot(record('late')))).rejects.toThrow('cleared by another host')
    expect(await databaseCatalogStorage(filename).load()).toEqual(snapshot())
    await inspect(filename, db => {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'clear_generation'").get()?.value).toBe(1)
    })
    await stale.load()
    await stale.save(snapshot(record('fresh', 'streamable-http')))
    expect(loaded(await databaseCatalogStorage(filename).load()).entries[0]?.label).toBe('fresh')
  })

  it('rejects a first save without load when another writer already cleared the database', async () => {
    const filename = path('no-load-generation')
    await databaseCatalogStorage(filename).save(snapshot(), true)
    await expect(databaseCatalogStorage(filename).save(snapshot(record('late')))).rejects.toThrow('cleared by another host')
    expect(await databaseCatalogStorage(filename).load()).toEqual(snapshot())
  })

  it('serializes writes on one storage and closes every connection after use', async () => {
    const filename = path('queue')
    const storage = databaseCatalogStorage(filename)
    const a = record('a')
    const b = record('b')
    await Promise.all([storage.save(snapshot(a)), storage.save(snapshot(a, b)), storage.save(snapshot(b))])
    expect(await storage.load()).toEqual(snapshot(b))
    await inspect(filename, db => { db.exec('BEGIN EXCLUSIVE; COMMIT;') })
  })

  it('rolls back failed transactional writes and keeps the prior complete record', async () => {
    const filename = path('rollback')
    const storage = databaseCatalogStorage(filename)
    const original = record('original')
    await storage.save(snapshot(original))
    await inspect(filename, db => { db.exec("UPDATE metadata SET value = 9007199254740991 WHERE key = 'clear_generation'") })
    await expect(storage.save(snapshot(record('replacement')), true)).rejects.toThrow('generation exhausted')
    expect(loaded(await databaseCatalogStorage(filename).load()).entries).toEqual([original])
  })

  it('rejects malformed or oversized saves before touching the old database', async () => {
    const filename = path('bad-input')
    const storage = databaseCatalogStorage(filename)
    const original = record('original')
    await storage.save(snapshot(original))
    const before = await readFile(filename)
    await expect(storage.save({ version: 2, entries: [] })).rejects.toThrow('invalid catalogue snapshot')
    await expect(storage.save({ version: 1, entries: [{ ...original, entry: { ...original.entry, tools: [{ name: 'x', annotations: null }] } }] })).rejects.toThrow('invalid catalogue record')
    await expect(storage.save(snapshot(record('huge', 'stdio', '字'.repeat(12 * 1024 * 1024))))).rejects.toThrow('size limit')
    expect(await readFile(filename)).toEqual(before)
    expect(await databaseCatalogStorage(filename).load()).toEqual(snapshot(original))
  })

  it.each(['unknown-table', 'future-version', 'wrong-columns'])('rejects %s databases without overwriting their data', async (mode) => {
    const filename = path(mode)
    await mkdir(dirname(filename), { recursive: true })
    await inspect(filename, db => {
      if (mode === 'unknown-table') db.exec("CREATE TABLE owner_data (secret TEXT); INSERT INTO owner_data VALUES ('keep-me')")
      else if (mode === 'future-version') db.exec("PRAGMA user_version = 99; CREATE TABLE future (value TEXT); INSERT INTO future VALUES ('keep-me')")
      else db.exec("PRAGMA user_version = 1; CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL); INSERT INTO metadata VALUES ('clear_generation', 0); CREATE TABLE catalog_entries (identity TEXT PRIMARY KEY NOT NULL, wrong_json TEXT NOT NULL)")
    })
    const before = await readFile(filename)
    const storage = databaseCatalogStorage(filename)
    await expect(storage.load()).rejects.toThrow(/schema/)
    await expect(storage.save(snapshot(record('new')))).rejects.toThrow(/schema/)
    expect(await readFile(filename)).toEqual(before)
  })

  it('does not erase malformed durable records even during an explicit clear', async () => {
    const filename = path('bad-record')
    await databaseCatalogStorage(filename).save(snapshot(record('original')))
    await inspect(filename, db => { db.prepare('UPDATE catalog_entries SET record_json = ?').run('{bad-json') })
    const before = await readFile(filename)
    const storage = databaseCatalogStorage(filename)
    await expect(storage.load()).rejects.toThrow()
    await expect(storage.save(snapshot(), true)).rejects.toThrow()
    expect(await readFile(filename)).toEqual(before)
  })

  it('rejects a corrupted database file without changing its bytes', async () => {
    const filename = path('corrupt')
    await mkdir(dirname(filename), { recursive: true })
    const corrupt = Buffer.from('this is not a database; preserve-owner-bytes')
    await writeFile(filename, corrupt)
    await expect(databaseCatalogStorage(filename).load()).rejects.toThrow()
    await expect(databaseCatalogStorage(filename).save(snapshot(record('new')))).rejects.toThrow()
    expect(await readFile(filename)).toEqual(corrupt)
  })

  it('evicts the oldest database write, not the oldest fetchedAt, at the 500-record limit', async () => {
    const filename = path('capacity')
    const storage = databaseCatalogStorage(filename)
    const first = Array.from({ length: 500 }, (_, index) => ({ ...record(`server-${index}`), entry: { ...record(`server-${index}`).entry, fetchedAt: index + 1 } }))
    await storage.save(snapshot(...first))
    const rewritten = { ...first[0]!, entry: { ...first[0]!.entry, tools: [{ name: 'updated', description: 'updated', inputSchema: { type: 'object' } }] } }
    await storage.save(snapshot(rewritten, ...first.slice(1)))
    const independent = databaseCatalogStorage(filename)
    await independent.load()
    await independent.save(snapshot(...loaded(await independent.load()).entries, record('newest', 'streamable-http')))
    const entries = loaded(await databaseCatalogStorage(filename).load()).entries
    expect(entries).toHaveLength(500)
    expect(entries.some(item => item.label === 'server-0')).toBe(true)
    expect(entries.some(item => item.label === 'server-1')).toBe(false)
    expect(entries.at(-1)?.label).toBe('newest')
  })

  it('bounds combined UTF-8 snapshot bytes and evicts older rows instead of deleting an independent new row', async () => {
    const filename = path('bytes')
    const first = databaseCatalogStorage(filename)
    const second = databaseCatalogStorage(filename)
    await Promise.all([first.load(), second.load()])
    const payload = '字'.repeat(6 * 1024 * 1024)
    await first.save(snapshot(record('older', 'stdio', payload)))
    await second.save(snapshot(record('newer', 'streamable-http', payload)))
    const value = loaded(await databaseCatalogStorage(filename).load())
    expect(value.entries.map(item => item.label)).toEqual(['newer'])
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(32 * 1024 * 1024)
  })

  it('isolates profiles below the Host-owned cache directory', () => {
    const first = catalogDatabasePath({ home: root, dir: join(root, 'profile-a') })
    const second = catalogDatabasePath({ home: root, dir: join(root, 'profile-b') })
    expect(first).not.toBe(second)
    expect(first.startsWith(join(root, 'cache', 'dsh-mcp-manager'))).toBe(true)
    expect(first.endsWith('catalog.sqlite')).toBe(true)
  })
})
