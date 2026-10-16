import { describe, expect, it } from 'vitest'
import { credentialText, credentialValues, mergeCredentialEdits } from '../src/client/credential-fields.ts'

describe('credentialValues', () => {
  it('reads a flat stdio spec\'s env in declaration order', () => {
    const json = JSON.stringify({ type: 'stdio', command: 'node', env: { TOKEN: 'a', REGION: 'cn' } })
    expect(credentialValues(json, 'env')).toEqual({
      entries: [['TOKEN', 'a'], ['REGION', 'cn']],
      editable: true,
    })
  })

  it('reads an HTTP row\'s headers', () => {
    const json = JSON.stringify({ type: 'streamable-http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer a' } })
    expect(credentialValues(json, 'headers')).toEqual({
      entries: [['Authorization', 'Bearer a']],
      editable: true,
    })
  })

  it('reports an absent map as empty and editable, so the pane can say so', () => {
    // The pane's job is to explain the row, not to refuse it: a stdio row
    // without `env` is a legal row with no credentials.
    expect(credentialValues(JSON.stringify({ type: 'stdio', command: 'node' }), 'env'))
      .toEqual({ entries: [], editable: true })
  })

  it('unwraps a single named entry and a Claude mcpServers wrapper', () => {
    const named = JSON.stringify({ 'my-server': { command: 'node', env: { A: '1' } } })
    expect(credentialValues(named, 'env')?.entries).toEqual([['A', '1']])
    const wrapped = JSON.stringify({ mcpServers: { 'my-server': { command: 'node', env: { A: '2' } } } })
    expect(credentialValues(wrapped, 'env')?.entries).toEqual([['A', '2']])
  })

  it('renders a non-string value as the text it would be written back as', () => {
    const json = JSON.stringify({ type: 'stdio', command: 'node', env: { PORT: 8080 } })
    expect(credentialValues(json, 'env')?.entries).toEqual([['PORT', '8080']])
  })

  it('refuses a map the pane cannot write: malformed JSON, a non-object, a wrong shape', () => {
    expect(credentialValues('{ not json', 'env')).toBeUndefined()
    expect(credentialValues('"a string"', 'env')).toBeUndefined()
    expect(credentialValues(JSON.stringify({ type: 'stdio', command: 'node', env: ['A=1'] }), 'env'))
      .toEqual({ entries: [], editable: false })
  })
})

describe('credentialText', () => {
  it('writes one value and leaves every other field as it was typed', () => {
    const json = JSON.stringify({
      type: 'stdio',
      command: 'node',
      args: ['--x'],
      cwd: 'C:\\work',
      env: { TOKEN: 'old', REGION: 'cn' },
    }, null, 2)
    const next = credentialText(json, 'env', 'TOKEN', 'new')
    expect(next).toBeDefined()
    expect(JSON.parse(next as string)).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['--x'],
      cwd: 'C:\\work',
      env: { TOKEN: 'new', REGION: 'cn' },
    })
  })

  it('adds the map when the row declares none yet', () => {
    const next = credentialText(JSON.stringify({ type: 'stdio', command: 'node' }), 'env', 'TOKEN', 'v')
    expect(JSON.parse(next as string).env).toEqual({ TOKEN: 'v' })
  })

  it('writes headers on an HTTP row and keeps the named-entry wrapper', () => {
    const named = JSON.stringify({ 'my-server': { url: 'https://x.test/mcp' } })
    const next = credentialText(named, 'headers', 'Authorization', 'Bearer v')
    expect(JSON.parse(next as string)).toEqual({
      'my-server': { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer v' } },
    })
  })

  it('refuses text it cannot write rather than replacing what the user typed', () => {
    expect(credentialText('{ not json', 'env', 'A', '1')).toBeUndefined()
    expect(credentialText(JSON.stringify({ type: 'stdio', command: 'node', env: 'A=1' }), 'env', 'A', '1')).toBeUndefined()
  })
})

describe('mergeCredentialEdits', () => {
  const opened = JSON.stringify({
    type: 'stdio',
    command: 'node',
    args: ['--x'],
    env: { TOKEN: 'old', REGION: 'cn' },
  }, null, 2)

  it('leaves the document alone when nothing was edited', () => {
    expect(mergeCredentialEdits(opened, opened)).toBe(opened)
  })

  it('folds in a changed credential and nothing else', () => {
    const edited = credentialText(opened, 'env', 'TOKEN', 'new') as string
    const merged = mergeCredentialEdits(edited, opened)
    expect(JSON.parse(merged).env).toEqual({ TOKEN: 'new', REGION: 'cn' })
    expect(JSON.parse(merged).args).toEqual(['--x'])
  })

  it('never writes back a field the pane did not show', () => {
    // The user edited the box by hand while the pane was open: a value the pane
    // never displayed must survive, which is why only changed keys are folded.
    const handEdited = JSON.stringify({
      type: 'stdio',
      command: 'node',
      args: ['--hand'],
      env: { TOKEN: 'old', ADDED: 'keep-me' },
    }, null, 2)
    const merged = mergeCredentialEdits(handEdited, opened)
    expect(JSON.parse(merged).env).toEqual({ TOKEN: 'old', ADDED: 'keep-me' })
    expect(JSON.parse(merged).args).toEqual(['--hand'])
  })

  it('keeps a changed Keycloak-style header on an HTTP row', () => {
    const httpOpened = JSON.stringify({ type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer old' } }, null, 2)
    const edited = credentialText(httpOpened, 'headers', 'Authorization', 'Bearer new') as string
    expect(JSON.parse(mergeCredentialEdits(edited, httpOpened)).headers).toEqual({ Authorization: 'Bearer new' })
  })
})
