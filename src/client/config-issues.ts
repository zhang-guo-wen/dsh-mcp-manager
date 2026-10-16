/**
 * Localized rendering of one MCP row's configuration gaps.
 *
 * `src/mcp-diagnostics.ts` carries a `reason` for every gap, but that text is
 * the Host's own English report: it reaches the settings page through the
 * roster read and the editor's save check, where it is user-visible copy and
 * therefore belongs in this plugin's dictionary. The kind is the stable field,
 * so the browser renders from `kind` plus the names it carries and keeps
 * `reason` only as the fallback for a kind this bundle predates.
 *
 * Pure, and free of harness imports, so vitest drives it directly.
 * @module @guowenzhang/dsh-mcp-manager/client/config-issues
 */

import type { McpConfigIssue } from '../types.ts'
import type { McpSectionKey } from './locales.ts'

/** This plugin's dictionary lookup, bound to the section namespace. */
export type ConfigIssueTranslate = (key: McpSectionKey) => string

/**
 * Fill one `{name}`-style placeholder.
 * @param template - localized text carrying the placeholder.
 * @param values - placeholder name to replacement text.
 * @returns the filled text, or the template when it carries no placeholder.
 */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  let text = template
  for (const [key, value] of Object.entries(values)) text = text.replace(`{${key}}`, value)
  return text
}

/**
 * One gap, in the reader's language.
 * @param issue - the gap, as the Host reported it.
 * @param t - this section's dictionary lookup.
 * @returns the localized sentence for that kind.
 */
function describeIssue(issue: McpConfigIssue, t: ConfigIssueTranslate): string {
  const names = issue.names ?? []
  // Widened on purpose: the roster and the save check arrive over the wire, so
  // an unknown kind must still render instead of falling off the end.
  const kind: string = issue.kind
  switch (kind) {
    case 'missing-command':
      return t('mcp.issue.missingCommand')
    case 'missing-url':
      return t('mcp.issue.missingUrl')
    case 'unsupported-config':
      return t('mcp.issue.unsupportedConfig')
    case 'unreachable-variable':
      return fill(t('mcp.issue.unreachableVariable'), { names: names.join(', ') })
    case 'empty-credential':
      return fill(t('mcp.issue.emptyCredential'), { name: names[0] ?? '' })
    default:
      // The wire carries a kind this bundle does not know; the Host's own
      // sentence is still better than dropping the reason.
      return issue.reason
  }
}

/**
 * Render every gap of one row as one line, for a tooltip or a save error.
 * @param issues - the gaps `diagnoseRowConfig` / `diagnoseMcpSpec` reported.
 * @param t - this section's dictionary lookup.
 * @returns the localized reasons joined for display.
 */
export function formatMcpConfigIssues(issues: readonly McpConfigIssue[], t: ConfigIssueTranslate): string {
  return issues.map(issue => describeIssue(issue, t)).join('; ')
}
