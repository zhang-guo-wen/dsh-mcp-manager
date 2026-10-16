import { describe, expect, it } from 'vitest'
import type { McpConfigIssue } from '../src/types.ts'
import { formatMcpConfigIssues } from '../src/client/config-issues.ts'
import { zh, type McpSectionKey } from '../src/client/locales.ts'

/** The shipped Chinese copy, so the expectations read what a user reads. */
const t = (key: McpSectionKey): string => zh[key]

describe('formatMcpConfigIssues', () => {
  it('renders a structural gap from its kind, not the Host sentence', () => {
    const issues: readonly McpConfigIssue[] = [
      { kind: 'missing-command', reason: 'the stdio row has no command' },
    ]
    expect(formatMcpConfigIssues(issues, t)).toBe('缺少 command：stdio 行没有启动命令')
  })

  it('names every unresolved variable', () => {
    const issues: readonly McpConfigIssue[] = [
      { kind: 'unreachable-variable', reason: 'not set', names: ['YUNXIAO_TOKEN', 'ORG_ID'] },
    ]
    expect(formatMcpConfigIssues(issues, t)).toBe('引用的环境变量未设置：YUNXIAO_TOKEN, ORG_ID')
  })

  it('names the empty credential field', () => {
    const issues: readonly McpConfigIssue[] = [{ kind: 'empty-credential', reason: 'empty', names: ['Authorization'] }]
    expect(formatMcpConfigIssues(issues, t)).toBe('“Authorization” 的值为空')
  })

  it('joins several gaps into the one line a tooltip or an error shows', () => {
    const issues: readonly McpConfigIssue[] = [
      { kind: 'unreachable-variable', reason: 'not set', names: ['TOKEN'] },
      { kind: 'empty-credential', reason: 'empty', names: ['KEY'] },
    ]
    expect(formatMcpConfigIssues(issues, t)).toBe('引用的环境变量未设置：TOKEN; “KEY” 的值为空')
  })

  it('falls back to the Host reason for a kind this bundle does not know', () => {
    // The roster and the save check arrive over the wire, so a newer Host can
    // report a kind this bundle predates; it must still render. Parsing the
    // payload is how that unknown kind reaches this typed function.
    const issues: readonly McpConfigIssue[] = JSON.parse('[{"kind":"future-kind","reason":"something new"}]')
    expect(formatMcpConfigIssues(issues, t)).toBe('something new')
  })

  it('renders nothing for a row with no gap', () => {
    expect(formatMcpConfigIssues([], t)).toBe('')
  })
})
