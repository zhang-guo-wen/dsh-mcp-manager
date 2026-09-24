import { describe, expect, it } from 'vitest'
import { mcpToolPublicName } from '../src/mcp-tool-name.ts'

// These fixtures pin the naming contract the harness `mcp-client` publishes
// (`publicToolName` in @deepseek-ai/dsh-mcp-client). A tool must carry the same
// name no matter which carrier registered it.
describe('mcpToolPublicName', () => {
  it('joins clean names verbatim', () => {
    expect(mcpToolPublicName('github', 'create_issue')).toBe('mcp__github__create_issue')
    expect(mcpToolPublicName('everything', 'get-sum')).toBe('mcp__everything__get-sum')
  })

  it('replaces invalid characters and appends an identity hash', () => {
    const name = mcpToolPublicName('srv', 'admin.reset')
    expect(name).toMatch(/^mcp__srv__admin_reset_[0-9a-f]{12}$/)
    expect(name.length).toBeLessThanOrEqual(64)
  })

  it('truncates over-long names and appends an identity hash', () => {
    const name = mcpToolPublicName('srv', 'a'.repeat(80))
    expect(name).toHaveLength(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
    expect(name.startsWith('mcp__srv__aaa')).toBe(true)
  })

  it('is deterministic and keeps distinct identities apart', () => {
    expect(mcpToolPublicName('srv', 'admin.reset')).toBe(mcpToolPublicName('srv', 'admin.reset'))
    expect(mcpToolPublicName('srv', 'admin.reset')).not.toBe(mcpToolPublicName('srv', 'admin_reset'))
  })
})
