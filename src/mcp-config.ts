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

/** The credentials one stored entry config carries, as key/value pairs. */
export interface McpStoredCredentials {
  /** The child-process environment of a stdio row; empty for HTTP. */
  readonly env: Readonly<Record<string, string>>
  /** The request headers of an HTTP row; empty for stdio. */
  readonly headers: Readonly<Record<string, string>>
}

/** An empty credential set, shared so a read of a config-free row allocates nothing. */
const NO_CREDENTIALS: McpStoredCredentials = { env: {}, headers: {} }

/**
 * Read the credentials a stored entry config declares, without asserting its
 * transport: the settings page only needs to know whether a row carries `env`
 * or `headers` at all, and where.
 *
 * Every value is a string on the wire, but a hand-edited composition file can
 * carry anything, so a non-string value is dropped rather than coerced — the
 * page shows what the row really has, and the diagnostics report the rest.
 * @param config - the row config as the Loader holds it, of unknown shape.
 * @returns the env and header maps, each empty when the config declares none.
 */
export function readStoredCredentials(config: unknown): McpStoredCredentials {
  if (config === null || typeof config !== 'object') return NO_CREDENTIALS
  const values = config as { readonly env?: unknown; readonly headers?: unknown }
  const pairs = (source: unknown): Record<string, string> => {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) return {}
    const entries = Object.entries(source as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    return Object.fromEntries(entries)
  }
  return { env: pairs(values.env), headers: pairs(values.headers) }
}

/**
 * The credential key names a stored entry config declares. Only the keys are
 * read: values are credentials, and this answer travels to the browser.
 * @param config - the row config as the Loader holds it.
 * @returns the `env` and `headers` key names, in one list in declaration order.
 */
export function storedCredentialKeys(config: unknown): readonly string[] {
  const credentials = readStoredCredentials(config)
  return [...Object.keys(credentials.env), ...Object.keys(credentials.headers)]
}

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
