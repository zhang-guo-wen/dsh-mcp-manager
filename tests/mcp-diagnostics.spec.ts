import { describe, expect, it } from 'vitest'
import {
  describeMcpConfigIssues,
  diagnoseMcpConfig,
  diagnoseMcpSpec,
  diagnoseRowConfig,
  isBlockingConfigIssue,
} from '../src/mcp-diagnostics.ts'

/** A stdio config with everything filled in. */
const runnable = { transport: 'stdio', serverName: 'demo', command: 'node', args: [], env: {}, cwd: '' } as const

describe('diagnoseMcpConfig', () => {
  it('reports nothing for a runnable row', () => {
    expect(diagnoseMcpConfig(runnable)).toEqual([])
    expect(diagnoseMcpConfig({ transport: 'streamable-http', serverName: 'web', url: 'https://example.test/mcp', headers: {} })).toEqual([])
  })

  it('reports a blank command and a blank url as structural gaps', () => {
    const [stdio] = diagnoseMcpConfig({ ...runnable, command: '   ' })
    expect(stdio?.kind).toBe('missing-command')
    expect(isBlockingConfigIssue(stdio!)).toBe(true)

    const [http] = diagnoseMcpConfig({ transport: 'streamable-http', serverName: 'web', url: '' })
    expect(http?.kind).toBe('missing-url')
    expect(isBlockingConfigIssue(http!)).toBe(true)
  })

  it('names every `${env:NAME}` this process cannot resolve, wherever it appears', () => {
    const issues = diagnoseMcpConfig({
      transport: 'stdio',
      serverName: 'demo',
      command: 'node',
      args: ['--token', '${env:MISSING_TOKEN}'],
      env: { KNOWN: 'set', ALSO: '${env:MISSING_TOKEN}' },
      cwd: '',
    }, { KNOWN: 'set' })
    expect(issues.map(issue => issue.kind)).toEqual(['unreachable-variable'])
    expect(issues[0]?.names).toEqual(['MISSING_TOKEN'])
    // The unresolved reference does not block a save: the variable can be set
    // before the next start.
    expect(isBlockingConfigIssue(issues[0]!)).toBe(false)
  })

  it('treats a resolved reference as configured', () => {
    expect(diagnoseMcpConfig({ ...runnable, env: { TOKEN: '${env:TOKEN}' } }, { TOKEN: 'secret' })).toEqual([])
    // A blank environment value counts as unset, exactly like the resource manager.
    expect(diagnoseMcpConfig({ ...runnable, env: { TOKEN: '${env:TOKEN}' } }, { TOKEN: '  ' })).toHaveLength(1)
  })

  it('flags credential-shaped fields left empty, headers included', () => {
    expect(diagnoseMcpConfig({ ...runnable, env: { GITHUB_TOKEN: '' } })).toEqual([
      { kind: 'empty-credential', reason: '"GITHUB_TOKEN" is empty', names: ['GITHUB_TOKEN'] },
    ])
    // A blank value on a field that is not credential-shaped is a deliberate
    // "this server needs no credential", not an incomplete configuration.
    expect(diagnoseMcpConfig({ ...runnable, env: { LOG_LEVEL: '' } })).toEqual([])
    expect(diagnoseMcpConfig({
      transport: 'streamable-http', serverName: 'web', url: 'https://example.test/mcp', headers: { Authorization: '' },
    })).toEqual([{ kind: 'empty-credential', reason: '"Authorization" is empty', names: ['Authorization'] }])
  })

  it('reports a shape it cannot drive rather than guessing', () => {
    expect(diagnoseMcpConfig({ transport: 'grpc', serverName: 'x' }).map(issue => issue.kind)).toEqual(['unsupported-config'])
    expect(diagnoseMcpConfig('nope').map(issue => issue.kind)).toEqual(['unsupported-config'])
    expect(diagnoseMcpConfig({ serverName: 'x' }).map(issue => issue.kind)).toEqual(['unsupported-config'])
  })

  it('joins the reasons for display', () => {
    const issues = diagnoseMcpConfig({ ...runnable, env: { TOKEN: '' } }, {})
    expect(describeMcpConfigIssues([...issues, { kind: 'unreachable-variable', reason: 'extra' }]))
      .toBe('"TOKEN" is empty; extra')
  })
})

describe('diagnoseRowConfig', () => {
  it('accepts the normalized config a global row carries', () => {
    expect(diagnoseRowConfig(runnable)).toEqual([])
  })

  it('accepts the Claude-shaped spec a preset declaration carries', () => {
    expect(diagnoseRowConfig({ serverName: 'demo', command: 'node', args: [] })).toEqual([])
    expect(diagnoseRowConfig({ type: 'stdio', serverName: 'demo', command: 'node' })).toEqual([])
    expect(diagnoseRowConfig({ type: 'streamable-http', serverName: 'web', url: 'https://example.test/mcp' })).toEqual([])
  })

  it('reports a declaration that cannot be converted at all', () => {
    // The declaration surface has no dialog to explain itself, so the reason
    // stays the inference rule's own message.
    expect(diagnoseRowConfig({ serverName: 'demo', command: '' })).toEqual([
      { kind: 'unsupported-config', reason: 'the row config is not a usable MCP spec' },
    ])
  })

  it('leaves an absent config alone', () => {
    expect(diagnoseRowConfig(undefined)).toEqual([])
    expect(diagnoseRowConfig(null)).toEqual([])
  })
})

describe('diagnoseMcpSpec', () => {
  it('reports references in the editor form, which holds the spec not the config', () => {
    const issues = diagnoseMcpSpec({ type: 'stdio', command: 'node', env: { TOKEN: '${env:ABSENT}' } }, {})
    expect(issues.map(issue => issue.kind)).toEqual(['unreachable-variable'])
    expect(issues[0]?.names).toEqual(['ABSENT'])
  })

  it('reports header references and blank credential headers', () => {
    const issues = diagnoseMcpSpec({
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: '${env:ABSENT}', 'X-Api-Key': '' },
    }, {})
    expect(issues.map(issue => issue.kind)).toEqual(['unreachable-variable', 'empty-credential'])
  })

  it('reports nothing for a complete spec', () => {
    expect(diagnoseMcpSpec({ type: 'stdio', command: 'node', args: ['serve'], env: { LOG_LEVEL: 'info' } })).toEqual([])
  })
})
