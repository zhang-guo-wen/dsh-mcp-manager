/**
 * The local token estimate a tool listing shows.
 *
 * These assertions pin the two things the number has to be good at: ordering
 * definitions by size the way a reader expects (a big argument schema costs more
 * than a bare name), and never claiming a definition is free.
 */

import { describe, expect, it } from 'vitest'
import { estimateTokens, estimateToolTokens } from '../src/mcp-tokens.ts'

describe('estimateToolTokens', () => {
  it('measures the schema, which is what a definition mostly is', () => {
    const bare = estimateToolTokens({ name: 'ping', description: 'Ping.' })
    const schema = estimateToolTokens({
      name: 'ping',
      description: 'Ping.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Host to ping.' },
          count: { type: 'number', description: 'How many packets.' },
        },
        required: ['host'],
      },
    })
    expect(schema).toBeGreaterThan(bare)
    expect(bare).toBeGreaterThan(0)
  })

  it('counts a CJK description higher than the same length of ASCII', () => {
    const ascii = estimateTokens('a'.repeat(40))
    const cjk = estimateTokens('测'.repeat(40))
    expect(cjk).toBeGreaterThan(ascii)
    expect(ascii).toBe(10)
    expect(cjk).toBe(20)
  })

  it('never reports a definition as free, and shows its title', () => {
    expect(estimateToolTokens({ name: 'x' })).toBeGreaterThan(0)
    expect(estimateToolTokens({ name: 'x', title: 'A longer display name for the tool' }))
      .toBeGreaterThan(estimateToolTokens({ name: 'x' }))
  })
})

describe('estimateTokens', () => {
  it('floors an empty string at one token', () => {
    expect(estimateTokens('')).toBe(1)
  })

  it('rounds up rather than down', () => {
    expect(estimateTokens('abcde')).toBe(2)
  })
})
