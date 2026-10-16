import { describe, expect, it } from 'vitest'
import { McpCatalog } from '../src/mcp-catalog.ts'

const tools = (...names: string[]): { name: string }[] => names.map(name => ({ name }))

describe('McpCatalog', () => {
  it('answers while the record is inside the window', () => {
    const catalog = new McpCatalog()
    catalog.set('preset:p:github', { tools: tools('a', 'b'), truncated: false }, 1_000)
    expect(catalog.get('preset:p:github', 5_000, 3_000)?.tools).toHaveLength(2)
  })

  it('stops answering once the window has passed', () => {
    const catalog = new McpCatalog()
    catalog.set('k', { tools: tools('a'), truncated: false }, 1_000)
    expect(catalog.get('k', 1_000, 2_000)).toBeDefined()
    expect(catalog.get('k', 1_000, 2_001)).toBeUndefined()
  })

  it('treats a zero setting as "never reuse"', () => {
    const catalog = new McpCatalog()
    catalog.set('k', { tools: tools('a'), truncated: false }, 1_000)
    expect(catalog.get('k', 0, 1_000)).toBeUndefined()
    // The record is still kept: the settings page reports what was discovered.
    expect(catalog.size).toBe(1)
  })

  it('honours a shorter freshness hint from the server', () => {
    const catalog = new McpCatalog()
    catalog.set('k', { tools: tools('a'), truncated: false, ttlMs: 500 }, 1_000)
    expect(catalog.get('k', 600_000, 1_400)).toBeDefined()
    expect(catalog.get('k', 600_000, 1_600)).toBeUndefined()
  })

  it('lets a server that refuses caching win over the configured window', () => {
    const catalog = new McpCatalog()
    catalog.set('k', { tools: tools('a'), truncated: false, ttlMs: 0 }, 1_000)
    expect(catalog.get('k', 600_000, 1_000)).toBeUndefined()
  })

  it('replaces a record rather than accumulating one per listing', () => {
    const catalog = new McpCatalog()
    catalog.set('k', { tools: tools('a'), truncated: false }, 1_000)
    catalog.set('k', { tools: tools('a', 'b'), truncated: true }, 2_000)
    expect(catalog.size).toBe(1)
    expect(catalog.stats(2_000)).toEqual([{ key: 'k', tools: 2, ageMs: 0, truncated: true }])
  })

  it('drops one server, or every server', () => {
    const catalog = new McpCatalog()
    catalog.set('a', { tools: tools('x'), truncated: false }, 1_000)
    catalog.set('b', { tools: tools('y'), truncated: false }, 1_000)
    expect(catalog.invalidate('a')).toBe(true)
    expect(catalog.invalidate('a')).toBe(false)
    expect(catalog.size).toBe(1)
    expect(catalog.clear()).toBe(1)
    expect(catalog.size).toBe(0)
    expect(catalog.clear()).toBe(0)
  })

  it('reports ages and keeps the oldest first', () => {
    const catalog = new McpCatalog()
    catalog.set('first', { tools: tools('x'), truncated: false }, 1_000)
    catalog.set('second', { tools: tools('y', 'z'), truncated: false }, 4_000)
    expect(catalog.stats(5_000)).toEqual([
      { key: 'first', tools: 1, ageMs: 4_000, truncated: false },
      { key: 'second', tools: 2, ageMs: 1_000, truncated: false },
    ])
  })

  it('bounds itself, so a long-lived host cannot grow without limit', () => {
    const catalog = new McpCatalog()
    for (let index = 0; index < 520; index += 1) {
      catalog.set(`server-${index}`, { tools: tools('t'), truncated: false }, index)
    }
    expect(catalog.size).toBeLessThanOrEqual(500)
    // The most recently written server survives; the oldest were evicted.
    expect(catalog.get('server-519', 600_000, 519)).toBeDefined()
    expect(catalog.get('server-0', 600_000, 519)).toBeUndefined()
  })
})
