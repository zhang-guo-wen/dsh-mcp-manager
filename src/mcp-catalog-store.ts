/** Profile-isolated SQLite storage for local and remote MCP tool catalogues. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { validCatalogRecord, type McpCatalogStorage } from './mcp-catalog.ts'

const SCHEMA_VERSION = 1
const MAX_RECORDS = 500
const MAX_BYTES = 32 * 1024 * 1024
const EMPTY_SNAPSHOT_BYTES = Buffer.byteLength(JSON.stringify({ version: 1, entries: [] }))
const PUBLIC_TOOL_FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'execution'] as const

type Transport = 'stdio' | 'streamable-http'
interface RecordValue {
  readonly identity: string
  readonly label: string
  readonly transport: Transport
  readonly entry: {
    readonly tools: readonly Record<string, unknown>[]
    readonly fetchedAt: number
    readonly truncated: boolean
    readonly transport: Transport
    readonly serverTtlMs?: number
  }
}
interface EncodedRecord {
  readonly record: RecordValue
  readonly json: string
  readonly bytes: number
}
type RecordIndex = Map<string, EncodedRecord>

/** Use the Host's startup profile facts, never an implicit user-home fallback. */
export function catalogDatabasePath(profile: { readonly home: string; readonly dir: string }): string {
  const namespace = createHash('sha256').update(profile.dir).digest('hex')
  return join(profile.home, 'cache', 'dsh-mcp-manager', namespace, 'catalog.sqlite')
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Project allowed fields before encoding; raw config and private tool properties never persist. */
function encodeRecord(value: unknown): EncodedRecord {
  // The snapshot API places transport on the outer record. Keep the nested
  // copy used by the catalogue validator, but never accept a conflicting one.
  if (!object(value) || !object(value.entry)) throw new Error('invalid catalogue record')
  const nested = value.entry.transport
  if (nested !== undefined && nested !== value.transport) throw new Error('invalid catalogue transport')
  const candidate = { ...value, entry: { ...value.entry, transport: value.transport } }
  if (!validCatalogRecord(candidate)) throw new Error('invalid catalogue record')
  const record: RecordValue = {
    identity: candidate.identity,
    label: candidate.label,
    transport: candidate.transport,
    entry: {
      tools: candidate.entry.tools.map(tool => Object.fromEntries(PUBLIC_TOOL_FIELDS
        .filter(field => field in tool)
        .map(field => [field, Reflect.get(tool, field)]))),
      fetchedAt: candidate.entry.fetchedAt,
      truncated: candidate.entry.truncated,
      transport: candidate.transport,
      ...candidate.entry.serverTtlMs === undefined ? {} : { serverTtlMs: candidate.entry.serverTtlMs },
    },
  }
  const json = JSON.stringify(record)
  const bytes = Buffer.byteLength(json)
  if (bytes + EMPTY_SNAPSHOT_BYTES > MAX_BYTES) throw new Error('catalogue record exceeds size limit')
  return { record, json, bytes }
}

function snapshotIndex(value: unknown): RecordIndex {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    throw new Error('invalid catalogue snapshot')
  }
  const index: RecordIndex = new Map()
  for (const item of value.entries) {
    const encoded = encodeRecord(item)
    if (index.has(encoded.record.identity)) throw new Error('duplicate catalogue identity')
    index.set(encoded.record.identity, encoded)
  }
  return index
}

function generationOf(db: DatabaseSync): number {
  const rows = db.prepare('SELECT key, value FROM metadata').all()
  const generation = rows[0]?.value
  if (rows.length !== 1 || rows[0]?.key !== 'clear_generation'
    || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('invalid catalogue metadata')
  }
  return generation
}

function assertColumns(db: DatabaseSync, table: 'metadata' | 'catalog_entries', expected: readonly string[]): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.length !== expected.length || columns.some((column, index) => {
    const [name, type, primary] = expected[index]!.split(':')
    return column.name !== name || column.type !== type || column.notnull !== 1 || column.pk !== Number(primary)
  })) throw new Error('unrecognized catalogue schema')
}

function prepareSchema(db: DatabaseSync, mayCreate: boolean): void {
  const version = db.prepare('PRAGMA user_version').get()?.user_version
  const objects = db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
  if (version === 0 && objects.length === 0 && mayCreate) {
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
      CREATE TABLE catalog_entries (identity TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('clear_generation', 0);
      PRAGMA user_version = ${SCHEMA_VERSION};`)
  } else if (version !== SCHEMA_VERSION || objects.length !== 2
    || objects[0]?.type !== 'table' || objects[0]?.name !== 'catalog_entries'
    || objects[1]?.type !== 'table' || objects[1]?.name !== 'metadata') {
    throw new Error('unsupported catalogue database schema')
  }
  assertColumns(db, 'metadata', ['key:TEXT:1', 'value:INTEGER:0'])
  assertColumns(db, 'catalog_entries', ['identity:TEXT:1', 'record_json:TEXT:0'])
  const check = db.prepare('PRAGMA quick_check(1)').get()
  if (check?.quick_check !== 'ok') throw new Error('invalid catalogue database')
  generationOf(db)
}

function readRecords(db: DatabaseSync): RecordIndex {
  const bounds = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes FROM catalog_entries').get()
  if (typeof bounds?.count !== 'number' || typeof bounds.bytes !== 'number'
    || bounds.count > MAX_RECORDS || bounds.bytes > MAX_BYTES) throw new Error('catalogue database exceeds size limit')
  const index: RecordIndex = new Map()
  for (const row of db.prepare('SELECT identity, record_json FROM catalog_entries ORDER BY rowid').all()) {
    if (typeof row.identity !== 'string' || typeof row.record_json !== 'string') throw new Error('invalid catalogue database record')
    const encoded = encodeRecord(JSON.parse(row.record_json) as unknown)
    if (row.identity !== encoded.record.identity) throw new Error('invalid catalogue database identity')
    index.set(row.identity, encoded)
  }
  return index
}

function totalBytes(index: RecordIndex): number {
  let bytes = EMPTY_SNAPSHOT_BYTES + Math.max(0, index.size - 1)
  for (const value of index.values()) bytes += value.bytes
  return bytes
}

/** Open only during an operation; a mere import never loads node:sqlite. */
export function databaseCatalogStorage(filename: string): McpCatalogStorage {
  let previous: RecordIndex = new Map()
  let baseline = 0
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation)
    queue = run.then(() => undefined, () => undefined)
    return run
  }
  const withDatabase = async <T>(create: boolean, operation: (db: DatabaseSync) => T): Promise<T | undefined> => {
    if (create) {
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
      try {
        const file = await open(filename, 'wx', 0o600)
        await file.close()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    try {
      if (!(await lstat(filename)).isFile()) throw new Error('catalogue database is not a regular file')
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const { DatabaseSync: Database } = await import('node:sqlite')
    const db = new Database(filename)
    let transaction = false
    try {
      db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;')
      transaction = true
      prepareSchema(db, create)
      const result = operation(db)
      db.exec('COMMIT')
      transaction = false
      return result
    } catch (error) {
      if (transaction) {
        try { db.exec('ROLLBACK') } catch { /* Preserve the original operation failure. */ }
      }
      throw error
    } finally { db.close() }
  }
  return {
    load: () => enqueue(async () => {
      const loaded = await withDatabase(false, db => {
        const generation = generationOf(db)
        const entries = readRecords(db)
        if (entries.size > MAX_RECORDS || totalBytes(entries) > MAX_BYTES) throw new Error('catalogue database exceeds size limit')
        return { generation, entries }
      })
      baseline = loaded?.generation ?? 0
      previous = loaded?.entries ?? new Map()
      return loaded === undefined ? undefined : { version: 1, entries: [...loaded.entries.values()].map(item => item.record) }
    }),
    async save(value, clear = false) {
      // Capture caller data before the first await; later mutation cannot alter a queued write.
      const next = snapshotIndex(value)
      await enqueue(async () => {
        const saved = await withDatabase(true, db => {
          const currentGeneration = generationOf(db)
          if (!clear && currentGeneration !== baseline) throw new Error('catalogue cleared by another host; reload before writing')
          if (clear && currentGeneration === Number.MAX_SAFE_INTEGER) throw new Error('catalogue generation exhausted')
          const generation = clear ? currentGeneration + 1 : currentGeneration
          const current = readRecords(db)
          const merged = clear ? new Map<string, EncodedRecord>() : current
          const remove = db.prepare('DELETE FROM catalog_entries WHERE identity = ?')
          const insert = db.prepare('INSERT INTO catalog_entries (identity, record_json) VALUES (?, ?)')
          if (clear) db.exec('DELETE FROM catalog_entries')
          else for (const [identity, prior] of previous) if (!next.has(identity) && merged.get(identity)?.json === prior.json) {
            remove.run(identity)
            merged.delete(identity)
          }
          for (const [identity, item] of next) {
            if (!clear && previous.get(identity)?.json === item.json) continue
            // Reinsert, rather than UPDATE, so rowid is the database's write order.
            remove.run(identity)
            insert.run(identity, item.json)
            merged.delete(identity)
            merged.set(identity, item)
          }
          let bytes = totalBytes(merged)
          while (merged.size > MAX_RECORDS || bytes > MAX_BYTES) {
            const oldest = merged.keys().next().value!
            const item = merged.get(oldest)!
            bytes -= item.bytes + (merged.size > 1 ? 1 : 0)
            merged.delete(oldest)
            remove.run(oldest)
          }
          db.prepare("UPDATE metadata SET value = ? WHERE key = 'clear_generation'").run(generation)
          return generation
        })
        baseline = saved!
        previous = next
      })
    },
  }
}
