/**
 * Claude-compatible MCP spec parsing, shared by every entry point that accepts
 * an externally authored server object.
 *
 * The shapes below are what Claude Code itself writes, so they arrive without
 * an owner: a `type` field is often absent and has to be inferred from the
 * presence of `command` or `url`; a single named entry may be wrapped in
 * `mcpServers` or given bare. The same rules must hold whether the object came
 * from the editor's JSON box or from a scanned `~/.claude.json`, because both
 * end up in the same composition row — two implementations would drift into
 * "the dialog accepted it but the import refused it".
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-spec
 */

import type { McpSpec } from './types.ts'

/** One decoded JSON object, before this module narrows its fields. */
export type AnyRecord = Record<string, unknown>

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read one server object (Claude-shaped, `spec` fields at the top level) into
 * the normalized spec. A missing `type` is inferred: `command` means stdio and
 * `url` means streamable HTTP, matching what Claude Code writes.
 * @param candidate - one decoded server entry.
 * @param invalid - message used for a malformed or unknown-transport entry.
 * @returns the normalized transport spec.
 * @throws when the entry declares an unsupported transport or lacks its
 * required field.
 */
export function specFromObject(candidate: AnyRecord, invalid: string): McpSpec {
  const declared = candidate.type
  const type = declared === undefined
    ? typeof candidate.command === 'string' ? 'stdio' : typeof candidate.url === 'string' ? 'streamable-http' : undefined
    : declared
  if (type === 'stdio') {
    const command = candidate.command
    if (typeof command !== 'string' || command.trim() === '') throw new Error(invalid)
    const args = Array.isArray(candidate.args) ? candidate.args.map(String) : undefined
    const env = isRecord(candidate.env)
      ? Object.fromEntries(Object.entries(candidate.env).map(([k, v]) => [k, String(v)]))
      : undefined
    const cwd = typeof candidate.cwd === 'string' ? candidate.cwd : undefined
    return {
      type: 'stdio',
      command,
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
      ...(cwd === undefined ? {} : { cwd }),
    }
  }
  if (type === 'streamable-http' || type === 'http' || type === 'sse') {
    const url = candidate.url
    if (typeof url !== 'string' || url.trim() === '') throw new Error(invalid)
    const headers = isRecord(candidate.headers)
      ? Object.fromEntries(Object.entries(candidate.headers).map(([k, v]) => [k, String(v)]))
      : undefined
    return { type, url, ...(headers === undefined ? {} : { headers }) }
  }
  throw new Error(invalid)
}

/**
 * Which transport one decoded server object declares, without asserting that it
 * is complete: a missing `type` is inferred from `command`/`url`, exactly as
 * {@link specFromObject} does. Callers use it to decide which field a partial
 * object is about — the credentials editor edits the object the user typed into
 * the JSON box, which may be neither valid nor finished yet.
 * @param candidate - one decoded server entry.
 * @returns the transport kind, or undefined when the entry names none.
 */
export function transportKindOf(candidate: AnyRecord): 'stdio' | 'http' | undefined {
  const declared = candidate.type
  if (declared === 'stdio') return 'stdio'
  if (declared === 'streamable-http' || declared === 'http' || declared === 'sse') return 'http'
  if (declared !== undefined) return undefined
  if (typeof candidate.command === 'string') return 'stdio'
  return typeof candidate.url === 'string' ? 'http' : undefined
}

/**
 * Parse an MCP connection document. Accepts a flat spec, a single-entry named
 * map (`{ "<name>": { command|url } }`), or a Claude `mcpServers` wrapper; a
 * name carried in the JSON is returned so a caller can fill an empty title.
 * @param text - raw JSON text.
 * @param invalid - message used for malformed JSON or an unrecognized shape.
 * @returns the normalized spec and the entry's own name when it declared one.
 * @throws when the text is not JSON or does not describe exactly one server.
 */
export function parseSpecText(text: string, invalid: string): { spec: McpSpec; serverName?: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(invalid)
  }
  return parseSpecValue(value, invalid)
}

/**
 * Parse one decoded MCP connection document; the JSON-text entry point above
 * and the file scanner share this so both accept the same shapes.
 * @param value - decoded JSON value.
 * @param invalid - message used for an unrecognized shape.
 * @returns the normalized spec and the entry's own name when it declared one.
 * @throws when the value does not describe exactly one server.
 */
export function parseSpecValue(value: unknown, invalid: string): { spec: McpSpec; serverName?: string } {
  if (!isRecord(value)) throw new Error(invalid)
  let root = value
  if (isRecord(root.mcpServers)) root = root.mcpServers
  let serverName: string | undefined
  if (root.type === undefined && root.command === undefined && root.url === undefined) {
    const pairs = Object.entries(root)
    if (pairs.length !== 1) throw new Error(invalid)
    const [name, entry] = pairs[0] as [string, unknown]
    if (!isRecord(entry)) throw new Error(invalid)
    serverName = name
    root = entry
  }
  return { spec: specFromObject(root, invalid), ...(serverName === undefined ? {} : { serverName }) }
}

/**
 * Flatten a spec into a Claude-shaped object (`spec` fields at the top level),
 * the inverse of {@link specFromObject} for display and round-tripping.
 * @param spec - normalized transport spec.
 * @returns the Claude-shaped object.
 */
export function flattenSpec(spec: McpSpec): AnyRecord {
  if (spec.type === 'stdio') {
    return {
      type: 'stdio',
      command: spec.command,
      ...(spec.args === undefined ? {} : { args: spec.args }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
    }
  }
  return {
    type: spec.type,
    url: spec.url,
    ...(spec.headers === undefined ? {} : { headers: spec.headers }),
  }
}

/**
 * The names of the secrets one spec carries. Only the keys are read: a scan
 * result is shown to the user and written to logs, so values must never travel
 * with it.
 * @param spec - normalized transport spec.
 * @returns the `env` keys for stdio, or the `headers` keys for HTTP.
 */
export function secretKeys(spec: McpSpec): readonly string[] {
  const values = spec.type === 'stdio' ? spec.env : spec.headers
  return Object.keys(values ?? {})
}

/**
 * Derive a server namespace from a launch command, used when an imported entry
 * declares no name of its own. Strips the scope, the `-mcp`/`-server` suffixes,
 * and any version, so `@upstash/context7-mcp` reads as `context7` and
 * `alibabacloud-devops-mcp-server` reads as `alibabacloud-devops`.
 * @param command - the stdio command or first package argument.
 * @returns a namespace candidate, or an empty string when nothing survives.
 */
export function serverNameFromCommand(command: string): string {
  return programName(command)
    .replace(/^@[^/]+\//, '')
    .replace(/-mcp(-server)?$/, '')
    .replace(/-server$/, '')
    .replace(/@[^@]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** A command's own program, without its path or script extension. */
function programName(command: string): string {
  const last = command.split(/[\\/]/).at(-1) ?? command
  return last.replace(/\.(cmd|exe|ps1|js|mjs|cjs|py)$/i, '')
}

/**
 * Programs that only ever launch another program.
 *
 * A row whose command is one of them and that carries no package argument is
 * unfinished — `npx` alone is not a server called `npx`, and naming one after
 * its launcher would put a wrong name in the roster and the system prompt.
 */
const PACKAGE_RUNNERS = new Set([
  'bun', 'bunx', 'deno', 'dnx', 'node', 'npm', 'npx', 'pipx', 'pnpm', 'pnpx', 'python', 'python3', 'uv', 'uvx', 'yarn',
])

/** Host labels that name a role rather than a product, so a URL's own name skips them. */
const GENERIC_HOST_LABELS = new Set(['mcp', 'www', 'api', 'server', 'sse', 'http', 'https'])

/**
 * The name a spec implies when the document it came from declared none.
 *
 * A stdio row is named after the package it launches (`npx -y
 * @upstash/context7-mcp` → `context7`), an HTTP row after the most specific label
 * of the host it calls (`https://mcp.yunxiao.com/mcp` → `yunxiao`). Nothing is
 * derived where nothing names a server: an address is not a name, and neither is
 * a launcher waiting for its package.
 * @param spec - the parsed transport spec.
 * @returns a namespace candidate, or an empty string when nothing usable is left.
 */
export function serverNameFromSpec(spec: McpSpec): string {
  if (spec.type === 'stdio') {
    // The package argument rather than the launcher: `npx -y <pkg>` names the
    // server after `pkg`, and flags carry no identity.
    const pkg = (spec.args ?? []).find(argument => !argument.startsWith('-'))
    if (pkg !== undefined) return serverNameFromCommand(pkg)
    return PACKAGE_RUNNERS.has(programName(spec.command)) ? '' : serverNameFromCommand(spec.command)
  }
  let host: string
  try {
    host = new URL(spec.url).hostname
  } catch {
    // A url that does not parse names nothing; the field stays for the user.
    return ''
  }
  if (host === '' || /^[\d.]+$/.test(host)) return ''
  const labels = host.split('.').filter(label => label !== '')
  const label = labels.find(part => !GENERIC_HOST_LABELS.has(part)) ?? labels[0] ?? ''
  return serverNameFromCommand(label)
}
