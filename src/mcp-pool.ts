/**
 * Host-level pool of on-demand MCP connections.
 *
 * A session's `mcp_load` starts a server; the connection then belongs to the
 * host, not to that session. Every later load of the same row — from the same
 * session, from another session, or from a sub-agent — reuses the live
 * connection, so a `npx -y` server is paid for once per host lifetime instead
 * of once per session. A session keeps a claim on the views it registered, and
 * the connection closes when its last claim is released, either by
 * `mcp_unload` or by the session ending.
 *
 * The pool is deliberately independent of the tool registration that owns it:
 * the registration can be rebuilt (a committed loading-mode change) without the
 * pool losing the connections it holds. That rebuild does release the sessions'
 * claims, because the tools registered under the previous mode cannot stay, so
 * a server with no other holder stops and the next `mcp_load` starts it again.
 * Only plugin unload closes whatever is left.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-pool
 */

import { createHash } from 'node:crypto'
import type { McpEntryConfig } from './mcp-config.ts'
import type { LazyClient, LazyTool } from './mcp-carrier.ts'

/** One live connection shared by every session that loaded its row. */
export interface PooledConnection {
  readonly serverName: string
  /** Identity of the connection config this client was opened with. */
  readonly fingerprint: string
  readonly client: LazyClient
  /** The tools the server published, unfiltered: each session filters its own. */
  tools: readonly LazyTool[]
  /** Whether the opening walk stopped at a cap instead of the server's end-of-list. */
  truncated: boolean
  /** The server's own freshness hint for its listing, when it published one. */
  ttlMs?: number | undefined
  /** Claim tokens currently holding this connection open. */
  readonly claims: Set<string>
  /** Whether `dispose` already ran: a closed connection must never be reused. */
  readonly closed: boolean
  dispose(): Promise<void>
}

/**
 * Connection identity for pooling.
 *
 * Two rows that resolve to the same transport and the same server namespace
 * share one process; a changed command, URL, or credential opens a new
 * connection. The digest is what reaches keys and logs — the config itself
 * carries env values and headers, so it is never logged and never embedded in
 * an error message.
 * @param config - one row's resolved connection config.
 * @returns a stable hex digest over the connection-relevant fields.
 */
export function connectionFingerprint(config: McpEntryConfig): string {
  const identity = config.transport === 'stdio'
    ? ['stdio', config.serverName, config.command, ...config.args, config.cwd,
      ...Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b)).flat()]
    : ['streamable-http', config.serverName, config.url,
      ...Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b)).flat()]
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16)
}

/** The row identity a pool entry belongs to, plus its config identity. */
export interface PoolKey {
  /** Stable key of the row that authorized this connection. */
  readonly rowKey: string
  readonly serverName: string
  readonly fingerprint: string
}

/** What opening one connection costs and requires. */
export interface ConnectionOpener {
  /**
   * Connect one server and report its tools.
   * @param config - the row's resolved connection config.
   * @returns the live client and the tools the server published.
   */
  open(config: McpEntryConfig): Promise<{
    client: LazyClient
    tools: readonly LazyTool[]
    truncated: boolean
    ttlMs?: number
  }>
  /**
   * Re-walk one server's tool list after a `tools/list_changed`. Omitted means
   * a single `listTools()` call; the host passes its paginated walk, so a paged
   * server is not silently cut to its first page.
   * @param client - the live client whose listing changed.
   * @returns the full listing, whether it was cut short, and the freshness hint.
   */
  relist?(client: LazyClient): Promise<{
    tools: readonly LazyTool[]
    truncated?: boolean
    ttlMs?: number
  }>
  /**
   * One connection's tool list changed and its live tools were re-listed.
   * @param connection - the connection whose tools changed.
   * @param error - the re-list failure, when the re-list itself failed.
   */
  onToolsChanged(connection: PooledConnection, error?: unknown): void
  /** Connection lifecycle diagnostics. Messages never contain credentials. */
  warn(message: string): void
}

/** The host-level pool surface the tool registration drives. */
export interface McpConnectionPool {
  /**
   * The live connection for one row and config, opened on first use.
   * A row whose config changed since its connection was opened gets a fresh
   * connection; the previous one keeps serving the sessions still holding it.
   * @param key - the row identity and its current config identity.
   * @param config - the row's resolved connection config.
   * @returns the connection every session of this row shares.
   */
  acquire(key: PoolKey, config: McpEntryConfig): Promise<PooledConnection>
  /**
   * Record one holder's claim on one connection.
   * @param key - the row identity and its current config identity.
   * @param connection - the connection that holder just loaded.
   * @param claimId - the claim token, unique per holder and load; `release`
   *   must be given the same token back.
   * @throws when the connection is already closed — a dead connection must not
   *   be registered back into the pool.
   */
  claim(key: PoolKey, connection: PooledConnection, claimId: string): void
  /**
   * Release one claim and close the connection when it was the last. A token
   * this connection never claimed releases nothing: an error path that never
   * claimed must not close a connection another holder is still loading.
   * @param connection - the connection the holder is giving up.
   * @param claimId - the claim token given to `claim`.
   */
  release(connection: PooledConnection, claimId: string): Promise<void>
  /**
   * Close one connection regardless of its claims, used when its row is gone.
   * @param key - the row identity whose connection should stop.
   */
  retire(key: PoolKey): Promise<void>
  /** Close every connection the pool holds. */
  dispose(): Promise<void>
}

/** Entries by row and config identity, plus their in-flight opening. */
interface Pending {
  readonly connection?: PooledConnection
  readonly opening?: Promise<PooledConnection>
}

/**
 * Create one host-level pool.
 * @param opener - connection and change-notification behavior.
 * @returns the pool the tool registration shares across sessions.
 */
export function createMcpConnectionPool(opener: ConnectionOpener): McpConnectionPool {
  const entries = new Map<string, Pending>()
  let serial: Promise<unknown> = Promise.resolve()

  const keyOf = (key: PoolKey): string => `${key.rowKey}\u0000${key.fingerprint}`

  /** One task at a time, so two sessions cannot open the same server twice. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = serial.then(task, task)
    serial = run.then(() => undefined, () => undefined)
    return run
  }

  /** Follow tool-list changes for one connection, for every claimed session. */
  const watch = (connection: PooledConnection): void => {
    connection.client.fallbackNotificationHandler = async (notification) => {
      if (notification.method !== 'notifications/tools/list_changed') return
      try {
        if (opener.relist !== undefined) {
          const relisted = await opener.relist(connection.client)
          connection.tools = relisted.tools ?? []
          connection.truncated = relisted.truncated ?? false
          connection.ttlMs = relisted.ttlMs
        } else {
          const listed = await connection.client.listTools()
          connection.tools = listed.tools ?? []
        }
        opener.onToolsChanged(connection)
      } catch (error) {
        opener.warn(`mcp-manager: could not follow the tool list change of "${connection.serverName}": ${String(error)}`)
        opener.onToolsChanged(connection, error)
      }
    }
  }

  /** Close one connection and forget it, whoever else still refers to it. */
  const close = async (connection: PooledConnection): Promise<void> => {
    for (const [id, entry] of entries) {
      if (entry.connection === connection) entries.delete(id)
    }
    try {
      await connection.dispose()
    } catch (error) {
      opener.warn(`mcp-manager: could not stop "${connection.serverName}": ${String(error)}`)
    }
  }

  return {
    acquire: (key, config) => enqueue(async () => {
      const id = keyOf(key)
      const existing = entries.get(id)?.connection
      if (existing !== undefined) return existing
      const pending = entries.get(id)?.opening
      if (pending !== undefined) return await pending
      const opening = (async (): Promise<PooledConnection> => {
        const { client, tools, truncated, ttlMs } = await opener.open(config)
        let closed = false
        const connection: PooledConnection = {
          serverName: key.serverName,
          fingerprint: key.fingerprint,
          client,
          tools,
          truncated,
          ...ttlMs === undefined ? {} : { ttlMs },
          claims: new Set<string>(),
          get closed() { return closed },
          dispose: async () => {
            if (closed) return
            closed = true
            await client.close()
          },
        }
        watch(connection)
        entries.set(id, { connection })
        return connection
      })()
      entries.set(id, { opening })
      try {
        return await opening
      } catch (error) {
        entries.delete(id)
        throw error
      }
    }),

    claim: (key, connection, claimId) => {
      if (connection.closed) {
        throw new Error(`the connection to "${connection.serverName}" is already closed`)
      }
      // A connection displaced by a config change keeps serving its own
      // holders, so it is registered under the identity it was opened with.
      const id = keyOf({ ...key, fingerprint: connection.fingerprint })
      if (entries.get(id)?.connection === undefined) entries.set(id, { connection })
      connection.claims.add(claimId)
    },

    release: (connection, claimId) => enqueue(async () => {
      const held = connection.claims.delete(claimId)
      if (!held || connection.claims.size > 0) return
      await close(connection)
    }),

    retire: key => enqueue(async () => {
      const id = keyOf(key)
      const entry = entries.get(id)
      if (entry === undefined) return
      entries.delete(id)
      if (entry.connection !== undefined) await close(entry.connection)
      else await entry.opening?.then(close, () => undefined)
    }),

    dispose: () => enqueue(async () => {
      const connections = [...new Set([...entries.values()].map(entry => entry.connection).filter(Boolean))]
      entries.clear()
      await Promise.allSettled(connections.map(connection => connection!.dispose()))
    }),
  }
}
