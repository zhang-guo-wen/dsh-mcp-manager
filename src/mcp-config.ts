/**
 * MCP config authoring helpers: convert the settings form's JSON spec
 * (Claude Code-style `type`/`command`/`args`) into the `mcp-client` Config
 * shape, and back, so the roster and the edit form share one form. The spec is
 * validated strictly — a malformed or unknown-transport spec is refused before
 * it reaches a composition file.
 * @module @guowenzhang/dsh-mcp-manager/mcp-config
 */

/** mcp-client `serverName` namespace pattern (`mcp__<serverName>__<rawName>`). */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

import type { McpSpec } from './types.ts'

export type { McpSpec } from './types.ts'

/** The normalized transport fragment the mcp-client Config consumes. */
export type McpTransportConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string }
  | { transport: 'streamable-http'; url: string; headers: Record<string, string> }

/** The connection config written into an mcp-client entry. */
export type McpEntryConfig = McpTransportConfig & {
  serverName: string
}

/**
 * Validate a server-name string.
 * @param serverName - candidate server namespace.
 * @returns the value when valid.
 * @throws when it does not match the mcp-client namespace pattern.
 */
export function assertServerName(serverName: string): string {
  if (!MCP_SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`MCP serverName must match ${String(MCP_SERVER_NAME_PATTERN)}`)
  }
  return serverName
}

/**
 * Convert a form spec + identity into the mcp-client entry config.
 * @param spec - the user-supplied JSON spec.
 * @param serverName - the server namespace (unique per entry).
 * @returns the mcp-client connection config shape. Display descriptions stay in
 * the `context-injection` settings namespace and are not written to MCP rows.
 * @throws when the spec is malformed or the transport fragment is incomplete.
 */
export function mcpEntryConfig(spec: McpSpec, serverName: string): McpEntryConfig {
  assertServerName(serverName)
  switch (spec.type) {
    case 'stdio': {
      const command = (spec as { readonly command?: unknown }).command
      if (typeof command !== 'string' || command.length === 0) {
        throw new Error('MCP stdio spec requires a command string')
      }
      return {
        transport: 'stdio',
        serverName,
        command,
        args: [...spec.args ?? []],
        env: { ...spec.env },
        cwd: spec.cwd ?? '',
      }
    }
    case 'http':
    case 'sse':
    case 'streamable-http': {
      const url = (spec as { readonly url?: unknown }).url
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('MCP http spec requires a url')
      }
      return {
        transport: 'streamable-http',
        serverName,
        url,
        headers: { ...spec.headers },
      }
    }
    default:
      throw new Error(`Unknown MCP transport type: ${String((spec as { type: unknown }).type)}`)
  }
}

/**
 * Reverse a stored entry config into the form spec (for editing).
 * @param config - the mcp-client connection config read from an entry.
 * @returns the Claude Code-style spec the edit form edits.
 */
export function specFromEntryConfig(config: McpEntryConfig): McpSpec {
  if (config.transport === 'stdio') {
    return { type: 'stdio', command: config.command, args: config.args, env: config.env, cwd: config.cwd }
  }
  return { type: 'streamable-http', url: config.url, headers: config.headers }
}
