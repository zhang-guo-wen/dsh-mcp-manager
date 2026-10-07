import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { declaredMcpRows } from '../src/mcp-allowance.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const row = (id: string, disabled?: unknown) => ({ id, name: MCP, disabled }) as EntryOptions
const group = (disabled: unknown, children: EntryOptions[]) => ({
  id: 'group', name: 'cordis:group', group: true, disabled, config: children,
}) as EntryOptions

describe('declared MCP allowance', () => {
  it('inherits literal and nested group disablement', () => {
    expect(declaredMcpRows([group(true, [row('child')])], MCP).map(row => row.enabled)).toEqual([false])
    expect(declaredMcpRows([group(false, [group(true, [row('nested')])])], MCP).map(row => row.enabled)).toEqual([false])
    expect(declaredMcpRows([row('enabled', false), row('truthy', 'disabled')], MCP).map(row => row.enabled)).toEqual([true, false])
  })

  it('evaluates expression nodes with the Loader evaluator', () => {
    const rows = [row('yes', { __jsExpr: 'false' }), group({ __jsExpr: 'true' }, [row('no')])]
    expect(declaredMcpRows(rows, MCP, expr => expr === 'true').map(row => row.enabled)).toEqual([true, false])
  })

  it('never guesses that a missing or throwing evaluator permits a row', () => {
    const rows = [group({ __jsExpr: 'unknown' }, [row('conditional')]), row('disabled', true)]
    expect(declaredMcpRows(rows, MCP).map(row => row.enabled)).toEqual(['conditional', false])
    expect(declaredMcpRows(rows, MCP, () => { throw new Error('refused') }).map(row => row.enabled)).toEqual(['conditional', false])
    expect(declaredMcpRows([group(true, [row('blocked', { __jsExpr: 'unknown' })])], MCP).map(row => row.enabled)).toEqual([false])
  })
})
