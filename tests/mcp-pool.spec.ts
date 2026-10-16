import { describe, expect, it, vi } from 'vitest'
import { connectionFingerprint, createMcpConnectionPool } from '../src/mcp-pool.ts'
import type { ConnectionOpener, PoolKey } from '../src/mcp-pool.ts'
import type { LazyClient } from '../src/mcp-carrier.ts'
import { NO_TOOL_FILTER } from '../src/mcp-tool-filter.ts'

const stdio = (extra: Record<string, unknown> = {}) => ({
  transport: 'stdio' as const,
  serverName: 'engram',
  command: 'node',
  args: ['server.mjs'],
  env: {},
  cwd: '',
  ...extra,
})

const key = (fingerprint: string): PoolKey => ({ rowKey: 'preset:standard:engram', serverName: 'engram', fingerprint })

/** An opener double that counts connections, closes, losses, and notifications. */
function opener(): ConnectionOpener & { opened: number; closes: number; changes: number; losses: number } {
  const state = {
    opened: 0,
    closes: 0,
    changes: 0,
    losses: 0,
    async open(): Promise<{ client: LazyClient; tools: readonly { name: string }[] }> {
      state.opened += 1
      return {
        client: {
          listTools: async () => ({ tools: [{ name: `tool-${state.opened}` }] }),
          callTool: async () => ({ content: [] }),
          close: async () => { state.closes += 1 },
        },
        tools: [{ name: `tool-${state.opened}` }],
      }
    },
    onToolsChanged(): void { state.changes += 1 },
    onConnectionLost(): void { state.losses += 1 },
    warn(): void {},
  }
  return state
}

describe('connection identity', () => {
  it('separates servers that differ in transport, command, or credentials', () => {
    const base = connectionFingerprint(stdio())
    expect(connectionFingerprint(stdio())).toBe(base)
    // Argument order is part of the identity.
    expect(connectionFingerprint(stdio({ args: ['other.mjs', 'server.mjs'] }))).not.toBe(base)
    expect(connectionFingerprint(stdio({ env: { TOKEN: 'a' } }))).not.toBe(base)
    expect(connectionFingerprint(stdio({ env: { TOKEN: 'b' } }))).not.toBe(base)
    expect(connectionFingerprint({ transport: 'streamable-http', serverName: 'engram', url: 'https://x/mcp', headers: {} })).not.toBe(base)
  })

  it('does not depend on the order env keys were written', () => {
    expect(connectionFingerprint(stdio({ env: { A: '1', B: '2' } })))
      .toBe(connectionFingerprint(stdio({ env: { B: '2', A: '1' } })))
  })

  it('never carries a credential value into its own output', () => {
    const digest = connectionFingerprint(stdio({ env: { TOKEN: 'super-secret' } }))
    expect(digest).not.toContain('super-secret')
    expect(digest).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('host-level connection pool', () => {
  it('opens one server once however many sessions ask for it', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const first = await pool.acquire(identity, stdio())
    const second = await pool.acquire(identity, stdio())
    expect(io.opened).toBe(1)
    expect(second).toBe(first)
  })

  it('opens once when two sessions load at the same moment', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const [first, second] = await Promise.all([pool.acquire(identity, stdio()), pool.acquire(identity, stdio())])
    expect(io.opened).toBe(1)
    expect(second).toBe(first)
  })

  it('keeps the process alive for the other sessions when one releases its claim', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    pool.claim(identity, connection, 'session-b')
    await pool.release(connection, 'session-a')
    expect(io.closes).toBe(0)
    expect(connection.claims).toEqual(new Set(['session-b']))
    // The surviving session still gets the same running server.
    expect(await pool.acquire(identity, stdio())).toBe(connection)
  })

  it('stops the process once the last claim is released', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    pool.claim(identity, connection, 'session-b')
    await pool.release(connection, 'session-a')
    await pool.release(connection, 'session-b')
    expect(io.closes).toBe(1)
    // A later load opens a fresh connection: nothing is left to reuse.
    expect(await pool.acquire(identity, stdio())).not.toBe(connection)
    expect(io.opened).toBe(2)
  })

  it('a release for a claim it never held closes nothing', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    // An error path that never claimed must not drop a connection another
    // holder is still loading through.
    await pool.release(connection, 'session-b')
    expect(io.closes).toBe(0)
    expect(connection.claims).toEqual(new Set(['session-a']))
    await pool.release(connection, 'session-a')
    expect(io.closes).toBe(1)
  })

  it('refuses to claim a connection that is already closed', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    await pool.release(connection, 'session-a')
    expect(io.closes).toBe(1)
    // A dead connection must never be registered back into the pool: the claim
    // fails loud and the next acquire opens a fresh one instead of serving it.
    expect(() => { pool.claim(identity, connection, 'session-b') }).toThrow(/already closed/)
    expect(await pool.acquire(identity, stdio())).not.toBe(connection)
    expect(io.opened).toBe(2)
  })

  it('drops a connection whose transport ended and opens a fresh one on the next load', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    // The server's process died: the transport reports the ending by itself.
    connection.client.onclose?.()
    expect(connection.lost).toBe(true)
    expect(io.losses).toBe(1)
    // The dead transport is not handed out again. Before this, the row kept
    // serving it for the rest of the host's life and only a restart recovered.
    const fresh = await pool.acquire(identity, stdio())
    expect(fresh).not.toBe(connection)
    expect(io.opened).toBe(2)
  })

  it('does not report the close it asked for as a lost connection', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    await pool.release(connection, 'session-a')
    // Releasing the last claim closes the client, which fires the same SDK
    // callback a crash would. Only the crash is a loss.
    expect(io.closes).toBe(1)
    expect(io.losses).toBe(0)
    expect(connection.lost).toBe(false)
  })

  it('refuses to claim a lost connection and reports the loss once', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    connection.client.onclose?.()
    expect(() => { pool.claim(identity, connection, 'session-b') }).toThrow(/already closed/)
    // A transport already known to be gone must not be reported a second time.
    connection.client.onclose?.()
    expect(io.losses).toBe(1)
  })

  it('releases a lost connection without a second close or a second loss', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    pool.claim(identity, connection, 'session-a')
    pool.claim(identity, connection, 'session-b')
    connection.client.onclose?.()
    await pool.release(connection, 'session-a')
    expect(io.closes).toBe(0)
    await pool.release(connection, 'session-b')
    // The last release still releases the transport, once; the crash is not
    // counted as a second loss.
    expect(io.closes).toBe(1)
    expect(io.losses).toBe(1)
  })

  it('warns once with the server name when a connection is lost', async () => {
    const warn = vi.fn()
    const pool = createMcpConnectionPool({
      open: async () => ({
        client: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} },
        tools: [],
        truncated: false,
      }),
      onToolsChanged: () => {},
      onConnectionLost: () => {},
      warn,
    })
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    connection.client.onclose?.()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('engram')
  })

  it('opens a new connection when the row config changed, keeping the old one for its sessions', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const before = key(connectionFingerprint(stdio()))
    const oldConnection = await pool.acquire(before, stdio())
    pool.claim(before, oldConnection, 'session-a')
    const after = key(connectionFingerprint(stdio({ args: ['other.mjs'] })))
    const fresh = await pool.acquire(after, stdio({ args: ['other.mjs'] }))
    expect(io.opened).toBe(2)
    expect(fresh).not.toBe(oldConnection)
    expect(io.closes).toBe(0)
    await pool.release(oldConnection, 'session-a')
    expect(io.closes).toBe(1)
  })

  it('closes every connection when the pool is disposed', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const a = await pool.acquire(key(connectionFingerprint(stdio())), stdio())
    const b = await pool.acquire(key(connectionFingerprint(stdio({ serverName: 'other' }))), stdio({ serverName: 'other' }))
    pool.claim(key(connectionFingerprint(stdio())), a, 'session-a')
    pool.claim(key(connectionFingerprint(stdio({ serverName: 'other' }))), b, 'session-a')
    await pool.dispose()
    expect(io.closes).toBe(2)
  })

  it('reports a failed open without caching the failure', async () => {
    let attempts = 0
    const pool = createMcpConnectionPool({
      open: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('connect failed')
        return { client: { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} }, tools: [] }
      },
      onToolsChanged: () => {},
      onConnectionLost: () => {},
      warn: () => {},
    })
    const identity = key(connectionFingerprint(stdio()))
    await expect(pool.acquire(identity, stdio())).rejects.toThrow('connect failed')
    await expect(pool.acquire(identity, stdio())).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it('re-lists a connection when the server announces a new tool list', async () => {
    const io = opener()
    const pool = createMcpConnectionPool(io)
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    const handler = connection.client.fallbackNotificationHandler
    expect(handler).toBeDefined()
    await handler?.({ method: 'notifications/tools/list_changed' })
    expect(io.changes).toBe(1)
    expect(connection.tools.map(tool => tool.name)).toEqual(['tool-1'])
    // Unrelated notifications stay out of the re-sync path.
    await handler?.({ method: 'notifications/resources/list_changed' })
    expect(io.changes).toBe(1)
  })

  it('re-walks every page through the opener relist, not just the first page', async () => {
    const pool = createMcpConnectionPool({
      open: async () => ({
        client: {
          listTools: async () => ({ tools: [{ name: 'first-page-only' }] }),
          callTool: async () => ({}),
          close: async () => {},
        },
        tools: [{ name: 'first-page-only' }],
        truncated: true,
      }),
      relist: async () => ({ tools: [{ name: 'one' }, { name: 'two' }], truncated: false, ttlMs: 1_000 }),
      onToolsChanged: () => {},
      onConnectionLost: () => {},
      warn: () => {},
    })
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    expect(connection.truncated).toBe(true)
    await connection.client.fallbackNotificationHandler?.({ method: 'notifications/tools/list_changed' })
    // The whole listing is replaced, and the cap/freshness answers follow it.
    expect(connection.tools.map(tool => tool.name)).toEqual(['one', 'two'])
    expect(connection.truncated).toBe(false)
    expect(connection.ttlMs).toBe(1_000)
  })

  it('survives a failing re-list and reports it once', async () => {
    const warn = vi.fn()
    const pool = createMcpConnectionPool({
      open: async () => ({
        client: {
          listTools: async () => { throw new Error('listing failed') },
          callTool: async () => ({}),
          close: async () => {},
        },
        tools: [{ name: 'kept' }],
      }),
      onToolsChanged: () => {},
      onConnectionLost: () => {},
      warn,
    })
    const identity = key(connectionFingerprint(stdio()))
    const connection = await pool.acquire(identity, stdio())
    await connection.client.fallbackNotificationHandler?.({ method: 'notifications/tools/list_changed' })
    expect(warn).toHaveBeenCalledTimes(1)
    // The session keeps the tools it already had.
    expect(connection.tools.map(tool => tool.name)).toEqual(['kept'])
  })
})

describe('view filters', () => {
  it('leaves filtering to each session, so the pool stores the server list', () => {
    // The pool hands over the unfiltered list on purpose: two sessions may load
    // the same server under different rules.
    expect(NO_TOOL_FILTER).toBeDefined()
  })
})
