import { describe, expect, it } from 'vitest'
import { Config, readMcpSettings } from '../src/settings.ts'

describe('MCP settings namespace convergence', () => {
  it('drops a non-string description instead of rejecting the whole namespace', () => {
    // The settings document is hand-editable. A number here used to fail the
    // schema and silently roll the loading mode and tool rules back with it.
    const resolved = Config({
      loading: 'lazy',
      descriptions: { good: 'kept', bad: 2024 },
      tools: { 'global:x': ['!secret'] },
      optimize: { pageSize: 7 },
    })
    const flags = readMcpSettings(resolved)()
    expect(flags.loading).toBe('lazy')
    expect(flags.descriptions).toEqual({ good: 'kept' })
    expect(flags.tools['global:x']).toEqual(['!secret'])
    expect(flags.optimize.pageSize).toBe(7)
  })
})
