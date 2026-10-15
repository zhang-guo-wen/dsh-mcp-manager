/**
 * The placeholders an MCP config may reference, and how to spot them.
 *
 * Kept apart from the diagnostics module on purpose: this file never touches
 * `process.env`, so it can be bundled into the browser half. The editor needs
 * the same rules — to warn about a `${env:NAME}` while the Host is the only side
 * that can say whether it resolves — and the browser has no environment at all.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-variable-refs
 */

/**
 * Placeholder syntax this plugin understands: `${env:NAME}`.
 *
 * The same spelling `dsh-resource-manager` resolves before it hands rows over.
 * It is reused here rather than invented a second time, so a row authored for
 * either surface means the same thing.
 */
export const MCP_ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Credential-shaped keys whose blank value means "not configured yet". */
export const CREDENTIAL_KEY = /token|secret|password|passwd|api[_-]?key|apikey|auth|credential|cookie/i

/** True for a non-empty string. */
export function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Collect the unset variables a value references.
 * @param value - one string from a config or spec.
 * @param env - environment to resolve against.
 * @param missing - sink collecting unresolved names.
 */
export function collectMissingReferences(
  value: string,
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  missing: Set<string>,
): void {
  for (const match of value.matchAll(MCP_ENV_REFERENCE)) {
    const name = match[1]
    if (name !== undefined && !(env[name] ?? '').trim()) missing.add(name)
  }
}

/**
 * Every string an MCP spec or row config may carry a reference in.
 *
 * Env and header VALUES are included, not just the transport fields: the
 * documented way to keep a credential out of the config is
 * `"env": { "TOKEN": "${env:TOKEN}" }`, so the reference lives there.
 * @param spec - a parsed spec, or a normalized `mcp-client` config.
 * @returns the strings to scan, in no particular order.
 */
export function specStrings(spec: unknown): readonly string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return []
  const record = spec as Record<string, unknown>
  const strings: string[] = []
  for (const key of ['command', 'url', 'cwd']) {
    if (typeof record[key] === 'string') strings.push(record[key] as string)
  }
  if (Array.isArray(record.args)) {
    for (const arg of record.args) if (typeof arg === 'string') strings.push(arg)
  }
  for (const field of ['env', 'headers']) {
    const map = record[field]
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (typeof value === 'string') strings.push(value)
    }
  }
  return strings
}

/**
 * The env/header keys of a spec that are present but blank.
 * @param spec - a parsed spec (or a raw declaration config).
 * @returns the credential-shaped key names, deduplicated.
 */
export function blankCredentialKeys(spec: unknown): readonly string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return []
  const record = spec as Record<string, unknown>
  const blank = new Set<string>()
  for (const field of ['env', 'headers']) {
    const map = record[field]
    if (map === null || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (CREDENTIAL_KEY.test(key) && !isFilled(value)) blank.add(key)
    }
  }
  return [...blank].sort()
}
