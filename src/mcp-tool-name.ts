/**
 * Model-facing naming for one MCP tool under any carrier.
 *
 * The plugin registers a filtered row's visible tools itself, so it must
 * reproduce the `mcp-client` public-name contract exactly: the same tool has to
 * carry the same name whichever carrier loaded its row, or the model would see
 * two identities for one tool and the `mcp__<serverName>__` prefix that
 * presentation code matches on would stop being a reliable namespace.
 *
 * Mirrors `publicToolName` in `@deepseek-ai/dsh-mcp-client`, which that package
 * does not re-export from its public entry. Keep the two implementations in
 * step; `tests/mcp-tool-name.spec.ts` pins the fixtures both must satisfy.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-tool-name
 */

import { createHash } from 'node:crypto'

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/**
 * Derive the model-facing name of one MCP tool.
 * @param serverName - the row's `serverName` namespace.
 * @param rawName - the MCP server's own tool name.
 * @returns `mcp__<serverName>__<rawName>` verbatim when that already satisfies
 *   the function-name contract; otherwise the sanitized and truncated form plus
 *   a 12-hex-char SHA-256 identity hash, so distinct identities never collapse
 *   onto one name.
 */
export function mcpToolPublicName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}
