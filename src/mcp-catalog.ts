/** Durable MCP tool discovery, shared by local processes and HTTP servers. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { McpEntryConfig } from './mcp-config.ts'

/** Injectable database boundary; discoveries never contain connection credentials. */
export interface McpCatalogStorage {
  load(): Promise<unknown>
  save(value: unknown, clear?: boolean): Promise<void>
}

/** Configuration digest; transport, credentials and effective local cwd/env participate. */
export function catalogIdentity(config: McpEntryConfig): string {
  const source = config.transport === 'stdio'
    ? ['stdio', config.serverName, config.command, config.args, resolve(config.cwd || process.cwd()),
      Object.entries({ ...process.env, ...config.env }).sort(([a], [b]) => a.localeCompare(b))]
    : ['streamable-http', config.serverName, config.url, Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b))]
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

export interface CatalogTool { readonly name: string }
export interface McpCatalogEntry<T extends CatalogTool> {
  readonly tools: readonly T[]
  readonly fetchedAt: number
  readonly truncated: boolean
  readonly transport: McpEntryConfig['transport']
  readonly serverTtlMs?: number
}
export interface McpCatalogRecord<T extends CatalogTool> {
  readonly tools: readonly T[]
  readonly truncated: boolean
  readonly ttlMs?: number
}
export interface McpCatalogStat {
  readonly key: string
  readonly tools: number
  readonly ageMs: number
  readonly truncated: boolean
  readonly transport: McpEntryConfig['transport']
  readonly ttlMs?: number
  readonly expired: boolean
}
interface StoredRecord<T extends CatalogTool> {
  readonly identity: string
  readonly label: string
  readonly transport: McpEntryConfig['transport']
  readonly entry: McpCatalogEntry<T>
}

function validTool(value: unknown): value is CatalogTool {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const tool = value as Record<string, unknown>
  if (typeof tool.name !== 'string') return false
  for (const field of ['title', 'description']) if (tool[field] !== undefined && typeof tool[field] !== 'string') return false
  if (tool.annotations !== undefined) {
    if (tool.annotations === null || typeof tool.annotations !== 'object' || Array.isArray(tool.annotations)) return false
    const hints = tool.annotations as Record<string, unknown>
    for (const field of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (hints[field] !== undefined && typeof hints[field] !== 'boolean') return false
    }
  }
  return true
}

/** Validate database JSON before it can feed search or a write transaction. */
export function validCatalogRecord(value: unknown): value is StoredRecord<CatalogTool> {
  if (value === null || typeof value !== 'object') return false
  const item = value as Partial<StoredRecord<CatalogTool>>
  const entry = item.entry
  return (item.transport === 'stdio' || item.transport === 'streamable-http')
    && typeof item.label === 'string' && item.label.length <= 128
    && typeof item.identity === 'string' && /^[a-f0-9]{64}$/.test(item.identity)
    && entry !== null && entry !== undefined
    && entry.transport === item.transport
    && Number.isFinite(entry.fetchedAt) && entry.fetchedAt >= 0 && entry.fetchedAt <= Date.now()
    && typeof entry.truncated === 'boolean' && Array.isArray(entry.tools) && entry.tools.length <= 2_000
    && entry.tools.every(validTool)
    && (entry.serverTtlMs === undefined || (Number.isFinite(entry.serverTtlMs) && entry.serverTtlMs >= 0))
}

const MAX_CATALOG_SERVERS = 500

/** Local catalogues are durable until invalidated; only server-advertised HTTP TTLs expire. */
export class McpCatalog<T extends CatalogTool = CatalogTool> {
  private readonly records = new Map<string, StoredRecord<T>>()
  private readonly bindings = new Map<string, string>()
  private pending: Promise<void> = Promise.resolve()
  private generation = 0
  private closed = false
  private writing = false
  private dirty = false
  private clearing = false

  constructor(private readonly storage?: McpCatalogStorage, private readonly warn: () => void = () => {}) {}
  get epoch(): number { return this.generation }
  get persistent(): boolean { return this.storage !== undefined }
  get size(): number { return this.records.size }

  async restore(): Promise<void> {
    if (this.storage === undefined) return
    try {
      const value = await this.storage.load() as { version?: unknown; entries?: unknown } | undefined
      if (value === undefined) return
      if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error('invalid catalogue')
      for (const item of value.entries.slice(-MAX_CATALOG_SERVERS)) {
        if (!validCatalogRecord(item)) { this.warn(); continue }
        this.records.set(item.identity, item as StoredRecord<T>)
      }
    } catch { this.warn() }
  }

  remember(config: McpEntryConfig, record: McpCatalogRecord<T>, key?: string, now = Date.now(), epoch = this.epoch): void {
    if (this.closed || epoch !== this.epoch) return
    const identity = catalogIdentity(config)
    const entry: McpCatalogEntry<T> = {
      tools: record.tools, fetchedAt: now, truncated: record.truncated, transport: config.transport,
      ...config.transport === 'stdio' || record.ttlMs === undefined ? {} : { serverTtlMs: record.ttlMs },
    }
    this.records.delete(identity)
    this.records.set(identity, { identity, label: config.serverName, transport: config.transport, entry })
    if (key !== undefined) this.bindings.set(key, identity)
    this.trim()
    this.persist()
  }

  /** Config-aware lookup prevents changed URL/command/credentials from reusing old tools. */
  getFor(key: string, config: McpEntryConfig, now = Date.now()): McpCatalogEntry<T> | undefined {
    const identity = catalogIdentity(config)
    this.bindings.set(key, identity)
    this.trim()
    const entry = this.records.get(identity)?.entry
    return entry === undefined || this.expired(entry, now) ? undefined : entry
  }

  get(key: string, now = Date.now()): McpCatalogEntry<T> | undefined {
    const identity = this.bindings.get(key)
    const entry = identity === undefined ? undefined : this.records.get(identity)?.entry
    return entry === undefined || this.expired(entry, now) ? undefined : entry
  }

  /** Whether a previously discovered server should be refreshed on the next search. */
  expiredFor(config: McpEntryConfig, now = Date.now()): boolean {
    const entry = this.records.get(catalogIdentity(config))?.entry
    return entry !== undefined && this.expired(entry, now)
  }

  private expired(entry: McpCatalogEntry<T>, now: number): boolean {
    return entry.transport === 'streamable-http' && entry.serverTtlMs !== undefined
      && (entry.serverTtlMs <= 0 || now - entry.fetchedAt > entry.serverTtlMs)
  }

  invalidate(key: string): boolean {
    const identity = this.bindings.get(key)
    if (identity === undefined) return false
    const removed = this.records.delete(identity)
    for (const [alias, target] of this.bindings) if (target === identity) this.bindings.delete(alias)
    if (removed) this.persist()
    return removed
  }

  clear(): number {
    this.generation += 1
    const count = this.records.size
    this.records.clear()
    this.bindings.clear()
    this.persist(true)
    return count
  }

  stats(now = Date.now()): readonly McpCatalogStat[] {
    return [...this.records.values()].map(({ identity, label, transport, entry }) => ({
      key: [...this.bindings].find(([, value]) => value === identity)?.[0] ?? `${transport === 'stdio' ? 'local' : 'server'}:${label}`,
      transport, tools: entry.tools.length, ageMs: Math.max(0, now - entry.fetchedAt), truncated: entry.truncated,
      ...entry.serverTtlMs === undefined ? {} : { ttlMs: entry.serverTtlMs }, expired: this.expired(entry, now),
    }))
  }

  async flush(): Promise<void> { await this.pending }
  async close(): Promise<void> { this.closed = true; this.generation += 1; await this.flush() }

  private trim(): void {
    while (this.records.size > MAX_CATALOG_SERVERS) {
      const identity = this.records.keys().next().value!
      this.records.delete(identity)
      for (const [key, value] of this.bindings) if (value === identity) this.bindings.delete(key)
    }
    while (this.bindings.size > MAX_CATALOG_SERVERS) this.bindings.delete(this.bindings.keys().next().value!)
  }

  private persist(clear = false): void {
    if (this.storage === undefined) return
    this.dirty = true
    this.clearing ||= clear
    if (this.writing) return
    this.writing = true
    this.pending = (async () => {
      while (this.dirty) {
        this.dirty = false
        const clearing = this.clearing
        this.clearing = false
        const entries = [...this.records.values()].map(item => ({ ...item, entry: {
          ...item.entry, tools: item.entry.tools.map(tool => Object.fromEntries(
            ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'execution']
              .filter(field => field in tool).map(field => [field, (tool as unknown as Record<string, unknown>)[field]]),
          )),
        } }))
        try {
          await this.storage!.save({ version: 1, entries }, clearing)
        } catch (error) {
          if (clearing) this.clearing = true
          throw error
        }
      }
    })().finally(() => { this.writing = false })
    void this.pending.catch(() => { this.warn() })
  }
}
