/**
 * What each allowed MCP server publishes, kept between loads.
 *
 * Two of the optimizations need a tool list without a live connection: search
 * has to answer for servers the session never loaded, and a listing should not
 * spawn a child process just to be paged. The catalogue is that memory: every
 * `tools/list` this plugin performs — a load, an editor listing, an indexing
 * search — records what the server published, and a later search reads it back
 * while it is younger than the configured TTL.
 *
 * It is deliberately process-local and small. Nothing here is authoritative:
 * a connection is still opened to call anything, and `notifications/tools/
 * list_changed` or a TTL expiry drops the entry so the next search re-reads it.
 * Persisting it to disk would let a cold host answer a search, which is a
 * deliberate non-goal for now: it would need a data directory this plugin does
 * not own, and a stale on-disk catalogue is harder to explain than an empty one.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-catalog
 */

/** The one field the catalogue indexes tools by. */
export interface CatalogTool {
  /** The server's own tool name. */
  readonly name: string
}

/** One server's recorded tool list. */
export interface McpCatalogEntry<T extends CatalogTool> {
  /** The tools the server published, in its own order. */
  readonly tools: readonly T[]
  /** When the list was read, on the same clock the TTL is measured against. */
  readonly fetchedAt: number
  /** Whether the collection cap cut the server's own listing short. */
  readonly truncated: boolean
  /**
   * The freshness window the server itself published (`ttlMs`, the spec's
   * `CacheableResult` mixin). Absent when the server sent none, which is every
   * revision before 2026-07-28 and every server that omits the field.
   */
  readonly serverTtlMs?: number
}

/** What one discovery walk records for a server. */
export interface McpCatalogRecord<T extends CatalogTool> {
  /** The tools the server published, in its own order. */
  readonly tools: readonly T[]
  /** Whether the collection cap cut the server's own listing short. */
  readonly truncated: boolean
  /** The server's own freshness hint, when it published one. */
  readonly ttlMs?: number
}

/** One catalogue entry as the settings page reports it. */
export interface McpCatalogStat {
  /** The row key the entry belongs to. */
  readonly key: string
  /** How many tools were recorded. */
  readonly tools: number
  /** How long ago the entry was recorded. */
  readonly ageMs: number
  /** Whether the recorded list was cut short by the collection cap. */
  readonly truncated: boolean
}

/** Upper bound on remembered servers, so a long-lived host cannot grow without limit. */
const MAX_CATALOG_SERVERS = 500

/**
 * A bounded, TTL-read tool catalogue.
 *
 * Reads and writes carry an explicit clock so the TTL rules are testable
 * without waiting.
 */
export class McpCatalog<T extends CatalogTool = CatalogTool> {
  private readonly entries = new Map<string, McpCatalogEntry<T>>()

  /**
   * Read one server's recorded tools while they are fresh enough to reuse.
   *
   * The effective window is the shorter of the configured TTL and the server's
   * own `ttlMs` hint: a server that says its listing is good for a minute is not
   * cached for five just because the deployment asked for five.
   * @param key - the row key the tools were recorded under.
   * @param ttlMs - how long a hint-less entry stays usable; zero disables reuse.
   * @param now - current time on the caller's clock.
   * @returns the entry, or undefined when it is absent or expired.
   */
  get(key: string, ttlMs: number, now: number = Date.now()): McpCatalogEntry<T> | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    const window = entry.serverTtlMs === undefined ? ttlMs : Math.min(ttlMs, entry.serverTtlMs)
    if (window <= 0) return undefined
    return now - entry.fetchedAt <= window ? entry : undefined
  }

  /**
   * Record what one server published, replacing anything recorded before.
   * @param key - the row key to record under.
   * @param record - the tools, whether the cap cut them short, and the server's
   *   own freshness hint when it sent one.
   * @param now - current time on the caller's clock.
   */
  set(key: string, record: McpCatalogRecord<T>, now: number = Date.now()): void {
    // Re-inserting moves the key to the end of the insertion order, so the
    // eviction below always drops the least recently written server.
    this.entries.delete(key)
    this.entries.set(key, {
      tools: record.tools,
      fetchedAt: now,
      truncated: record.truncated,
      ...record.ttlMs === undefined ? {} : { serverTtlMs: record.ttlMs },
    })
    while (this.entries.size > MAX_CATALOG_SERVERS) {
      const oldest = this.entries.keys().next()
      if (oldest.done === true) break
      this.entries.delete(oldest.value)
    }
  }

  /**
   * Forget one server, so the next read re-lists it.
   * @param key - the row key to drop.
   * @returns whether an entry was there to drop.
   */
  invalidate(key: string): boolean {
    return this.entries.delete(key)
  }

  /**
   * Forget every server.
   * @returns how many entries were dropped.
   */
  clear(): number {
    const dropped = this.entries.size
    this.entries.clear()
    return dropped
  }

  /** How many servers are remembered. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Report every remembered server, oldest first.
   * @param now - current time on the caller's clock.
   * @returns one row per entry, with its age relative to `now`.
   */
  stats(now: number = Date.now()): readonly McpCatalogStat[] {
    return [...this.entries].map(([key, entry]) => ({
      key,
      tools: entry.tools.length,
      ageMs: Math.max(0, now - entry.fetchedAt),
      truncated: entry.truncated,
    }))
  }
}
