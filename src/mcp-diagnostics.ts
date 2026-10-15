/**
 * Connection-configuration diagnostics for one MCP row.
 *
 * A row can be authorized by the user and still be unable to start: its
 * `command`/`url` may be blank, a `${env:NAME}` placeholder may reference a
 * variable this process does not carry, or a credential-shaped field may be
 * blank. Those are configuration gaps, not loading modes, so they are reported
 * separately from the preload gate's live/unmounted state.
 *
 * The module is pure 鈥?the environment arrives as an argument 鈥?so the settings
 * page, the roster read, the preload gate, and `mcp_load` all decide from the
 * same rules and vitest can drive it directly.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-diagnostics
 */

import type { McpConfigIssue } from './types.ts'
import { assertServerName, mcpEntryConfig } from './mcp-config.ts'
import { specFromObject } from './mcp-spec.ts'
import {
  blankCredentialKeys,
  collectMissingReferences,
  isFilled as filled,
  specStrings,
} from './mcp-variable-refs.ts'

export type { McpConfigIssue, McpConfigIssueKind } from './types.ts'
export { MCP_ENV_REFERENCE } from './mcp-variable-refs.ts'

/**
 * Whether a gap can be closed from the settings page alone.
 *
 * An unresolved `${env:NAME}` depends on this process's environment, and an
 * empty credential can be filled in later, so a save that already cleaned up
 * everything the author controls is accepted and the row stays flagged. A blank
 * `command`/`url` is structural: a save carrying one is refused outright.
 * @param issue - one diagnostic entry.
 * @returns whether the row must be refused rather than accepted and flagged.
 */
export function isBlockingConfigIssue(issue: McpConfigIssue): boolean {
  return issue.kind === 'missing-command' || issue.kind === 'missing-url'
}

/**
 * Diagnose one MCP row's connection configuration.
 *
 * Ordering is deliberate: a structural problem (blank transport field) is
 * reported on its own, because a missing `url` makes every other observation
 * about that row moot. Variable and credential gaps accumulate, so the page can
 * name them all at once.
 * @param config - the row's `mcp-client` config, or whatever the composition carried.
 * @param env - environment used to resolve `${env:NAME}` (defaults to `process.env`).
 * @returns every gap found, at most one structural one, in report order.
 */
export function diagnoseMcpConfig(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): readonly McpConfigIssue[] {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return [{ kind: 'unsupported-config', reason: 'the row config is not an object' }]
  }
  const record = config as Record<string, unknown>
  const transport = record.transport
  // An absent transport is read the way `mcp-spec` reads it: a command means a
  // local process, a url means a request-based server.
  const kind: 'stdio' | 'streamable-http' | undefined = transport === 'stdio' || (transport === undefined && filled(record.command))
    ? 'stdio'
    : transport === 'streamable-http' || transport === 'http' || transport === 'sse'
      || (transport === undefined && filled(record.url))
      ? 'streamable-http'
      : undefined
  if (kind === undefined) {
    return [{
      kind: 'unsupported-config',
      reason: transport === undefined
        ? 'the row config declares neither a command nor a url'
        : `unsupported MCP transport "${String(transport)}"`,
    }]
  }

  if (kind === 'stdio') {
    if (!filled(record.command)) {
      return [{ kind: 'missing-command', reason: 'the stdio row has no command' }]
    }
    const missing = new Set<string>()
    for (const value of specStrings(record)) collectMissingReferences(value, env, missing)
    return issues(missing, blankCredentialKeys(record))
  }

  if (!filled(record.url)) {
    return [{ kind: 'missing-url', reason: 'the HTTP row has no url' }]
  }
  const missing = new Set<string>()
  for (const value of specStrings(record)) collectMissingReferences(value, env, missing)
  return issues(missing, blankCredentialKeys(record))
}

/** Render the accumulated variable and credential gaps in report order. */
function issues(missing: ReadonlySet<string>, credentials: readonly string[]): readonly McpConfigIssue[] {
  const issues: McpConfigIssue[] = []
  const names = [...missing].sort()
  if (names.length > 0) {
    issues.push({
      kind: 'unreachable-variable',
      reason: `referenced environment variable(s) are not set: ${names.join(', ')}`,
      names,
    })
  }
  for (const key of [...new Set(credentials)].sort()) {
    issues.push({
      kind: 'empty-credential',
      reason: `"${key}" is empty`,
      names: [key],
    })
  }
  return issues
}

/**
 * Whether a row with these diagnostics can start right now.
 * @param issues - the result of {@link diagnoseMcpConfig}.
 * @returns true when nothing stands between the row and a connection attempt.
 */
/**
 * Diagnose whatever a composition row carries as its config.
 *
 * A preset declaration carries the Claude-shaped spec (`type`/`command`/`url`),
 * while a global row and every managed row carry the normalized `mcp-client`
 * config; the settings editor holds the spec too. Normalizing first means all
 * three are judged by one set of rules, and a row that cannot even be converted
 * is reported as the configuration problem it is rather than starting and
 * failing later.
 * @param config - the row's raw `config` value, in either shape.
 * @param env - environment used to resolve `${env:NAME}` (defaults to `process.env`).
 * @returns every gap found, empty when the row can start as written.
 */
export function diagnoseRowConfig(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): readonly McpConfigIssue[] {
  // Nothing configured at all is not diagnosable: a row being assembled, or a
  // test double, is left alone rather than reported as broken.
  if (config === undefined || config === null) return []
  if (typeof config !== 'object' || Array.isArray(config)) {
    return [{ kind: 'unsupported-config', reason: 'the row config is not an object' }]
  }
  const record = config as Record<string, unknown>
  // Already normalized: the transport decides, and `diagnoseMcpConfig` is the
  // only reader that has to understand it.
  if (record.transport !== undefined) return diagnoseMcpConfig(record, env)
  const serverName = typeof record.serverName === 'string' ? record.serverName : ''
  try {
    // The declaration is Claude-shaped and often omits `type`, so the inference
    // rule lives in one place (`mcp-spec`) rather than being repeated here.
    const spec = specFromObject(record, 'the row config is not a usable MCP spec')
    return diagnoseMcpConfig(mcpEntryConfig(spec, assertServerName(serverName || 'row')), env)
  } catch (error) {
    return [{ kind: 'unsupported-config', reason: error instanceof Error ? error.message : String(error) }]
  }
}

/**
 * One-line explanation of why a row cannot start.
 * @param issues - the result of {@link diagnoseMcpConfig}.
 * @returns the reasons joined for a tooltip or a failure message.
 */
export function describeMcpConfigIssues(issues: readonly McpConfigIssue[]): string {
  return issues.map(issue => issue.reason).join('; ')
}

/**
 * Diagnose an authoring SPEC (the Claude-shaped form the editor edits).
 *
 * The editor holds the spec, not the `mcp-client` config, at the moment it
 * decides whether a save may proceed 鈥?and the config builder refuses a blank
 * `command`/`url` on its own. This narrows the check to what only the spec can
 * show: `${env:NAME}` references, and credential-shaped env/header fields left
 * empty. The caller supplies the environment, because the browser half has none
 * and must not assume one.
 * @param spec - the parsed spec the dialog is about to submit.
 * @param env - environment used to resolve references; the browser passes `{}`.
 * @returns the variable and credential gaps, in report order.
 */
export function diagnoseMcpSpec(
  spec: unknown,
  env: Readonly<Record<string, string | undefined>>,
): readonly McpConfigIssue[] {
  const missing = new Set<string>()
  for (const value of specStrings(spec)) collectMissingReferences(value, env, missing)
  return issues(missing, blankCredentialKeys(spec))
}
