import { describe, expect, it } from 'vitest'
import { MAX_DESCRIPTION_CHARS, MAX_INVENTORY_CHARS, renderMcpInventory } from '../src/mcp-inventory.ts'
import type { McpInventoryRow } from '../src/mcp-inventory.ts'

const rows = (...names: string[]): McpInventoryRow[] => names.map(name => ({ name }))

describe('renderMcpInventory', () => {
  it('contributes nothing when no server may be loaded', () => {
    expect(renderMcpInventory([], 'dynamic')).toBe('')
  })

  it('lists every allowed server', () => {
    expect(renderMcpInventory(rows('github', 'yunxiao'), 'dynamic')).toBe(
      'MCP servers available on demand: call `mcp_load` with one of these names to add that server\'s tools to '
      + 'this session, and `mcp_unload` with the same name to release it again.\n'
      + '- github\n- yunxiao',
    )
  })

  it('names the tools the mode actually registers', () => {
    const dynamic = renderMcpInventory(rows('a'), 'dynamic')
    const lazy = renderMcpInventory(rows('a'), 'lazy')
    expect(dynamic).toContain('`mcp_load`')
    expect(dynamic).not.toContain('`mcp_call`')
    expect(lazy).toContain('`mcp_load`')
    expect(lazy).toContain('`mcp_call`')
    expect(lazy).toContain('`mcp_unload`')
  })

  it('appends the row description after an em dash', () => {
    expect(renderMcpInventory([{ name: 'yunxiao', description: '云效：任务与流水线' }], 'dynamic'))
      .toContain('- yunxiao — 云效：任务与流水线')
  })

  it('leaves out an empty description instead of a dangling dash', () => {
    expect(renderMcpInventory([{ name: 'bare', description: '   ' }], 'dynamic')).toContain('\n- bare')
    expect(renderMcpInventory([{ name: 'bare', description: '   ' }], 'dynamic')).not.toContain('—')
  })

  it('collapses a multi-line description to one line', () => {
    expect(renderMcpInventory([{ name: 'x', description: 'two\n  lines\ttabbed' }], 'dynamic'))
      .toContain('- x — two lines tabbed')
  })

  it('truncates a long description to the per-row cap', () => {
    const text = renderMcpInventory([{ name: 'x', description: 'a'.repeat(200) }], 'dynamic')
    expect(text).toContain(`- x — ${'a'.repeat(MAX_DESCRIPTION_CHARS - 1)}…`)
  })

  it('spends the budget on descriptions and never drops a name', () => {
    const many: McpInventoryRow[] = Array.from({ length: 40 }, (_, index) => ({
      name: `server-${index}`,
      description: 'd'.repeat(MAX_DESCRIPTION_CHARS),
    }))
    const text = renderMcpInventory(many, 'dynamic')
    for (const row of many) expect(text).toContain(`\n- ${row.name}`)
    // Descriptions stop once the budget is spent, so the section stays bounded
    // by the budget plus the names it must keep.
    expect(text).not.toContain(`- server-39 — `)
    expect(text.length).toBeLessThan(MAX_INVENTORY_CHARS + many.length * 12)
  })

  it('lists one line per name, because mcp_load resolves a name to one server', () => {
    const text = renderMcpInventory([{ name: 'dup' }, { name: 'dup' }], 'dynamic')
    expect(text.match(/- dup$/gm)).toHaveLength(1)
  })

  it('renders the deployment this plugin runs in', () => {
    expect(renderMcpInventory([
      { name: 'alibaba-devops-mcp', description: '云效MCP，任务管理工具，可以操作' },
      { name: 'kingdee', description: 'kingdee' },
      { name: 'playwright', description: 'playwright' },
      { name: 'context7', description: 'context7' },
    ], 'lazy')).toBe(
      'MCP servers available on demand: call `mcp_load` with one of these names to list that server\'s tools, '
      + '`mcp_call` to invoke one, and `mcp_unload` with the same name to release it again.\n'
      + '- alibaba-devops-mcp — 云效MCP，任务管理工具，可以操作\n'
      + '- kingdee — kingdee\n'
      + '- playwright — playwright\n'
      + '- context7 — context7',
    )
  })
})
