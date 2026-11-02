import { describe, expect, it, vi } from 'vitest'

/**
 * The stdio transport the SDK sees. The test only needs the options the plugin
 * passes; the client double answers a listing and closes.
 */
const sdk = vi.hoisted(() => ({
  transport: undefined as { options?: Record<string, unknown> } | undefined,
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools() { return { tools: [] } }
    async close(): Promise<void> {}
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    options?: Record<string, unknown>
    constructor(options: Record<string, unknown>) {
      this.options = options
      sdk.transport = this
    }
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const { connectLazy } = await import('../src/lazy-mcp.ts')

describe('MCP child environment', () => {
  it('starts from the scrubbed parent environment and layers the row\'s own env on it', async () => {
    const saved = { ...process.env }
    process.env.DEEPSEEK_API_KEY = 'host-api-key'
    process.env.DSH_SESSION_ID = 'host-session'
    process.env.MCP_INHERITED = 'kept'
    process.env.MCP_ROW_VALUE = 'parent-value'
    try {
      await connectLazy({
        transport: 'stdio',
        serverName: 'fixture',
        command: 'node',
        args: ['server.mjs'],
        env: { MCP_ROW_VALUE: 'row-value', MCP_ROW_TOKEN: 'explicit-token' },
        cwd: '',
      })
      const env = sdk.transport?.options?.env as Record<string, string>
      // Credential-shaped and harness-owned names never reach a third-party
      // server; the row's explicit values still do, even when their name is
      // credential-shaped.
      expect(env.DEEPSEEK_API_KEY).toBeUndefined()
      expect(env.DSH_SESSION_ID).toBeUndefined()
      expect(env.MCP_INHERITED).toBe('kept')
      expect(env.MCP_ROW_VALUE).toBe('row-value')
      expect(env.MCP_ROW_TOKEN).toBe('explicit-token')
      expect(env.PATH).toBe(process.env.PATH)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})
