/**
 * The name a parsed spec implies when its document declared none.
 *
 * The editor fills a new row's server name from this, so the cases that matter
 * are the ones a user actually pastes: an `npx` stdio row, a bare URL row, and
 * the documents that name nothing at all (a bare launcher, an address).
 */

import { describe, expect, it } from 'vitest'
import { parseSpecText, serverNameFromSpec } from '../src/mcp-spec.ts'

/** Parse one JSON document and derive the name it implies. */
function derived(text: string): string {
  return serverNameFromSpec(parseSpecText(text, 'invalid').spec)
}

describe('serverNameFromSpec', () => {
  it('names a stdio row after the package it launches, not its launcher', () => {
    expect(derived('{"command":"npx","args":["-y","@upstash/context7-mcp"]}')).toBe('context7')
    expect(derived('{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}'))
      .toBe('server-filesystem')
  })

  it('falls back to the command when the row launches one binary', () => {
    expect(derived('{"command":"/usr/local/bin/mcp-server-weather"}')).toBe('mcp-server-weather')
    expect(derived('{"command":"alibabacloud-devops-mcp-server"}')).toBe('alibabacloud-devops')
    expect(derived('{"command":"node","args":["/srv/tools/mcp-server-weather.js"]}')).toBe('mcp-server-weather')
  })

  it('names an HTTP row after the host label that is not a role', () => {
    expect(derived('{"url":"https://mcp.yunxiao.com/mcp"}')).toBe('yunxiao')
    expect(derived('{"url":"https://api.example.com"}')).toBe('example')
    expect(derived('{"url":"https://example.com/mcp"}')).toBe('example')
  })

  it('leaves the name empty when the spec has nothing to name', () => {
    // A launcher with no package yet is an unfinished row, not a server.
    expect(derived('{"command":"npx","args":["-y"]}')).toBe('')
    expect(derived('{"command":"npx"}')).toBe('')
    expect(derived('{"command":"node"}')).toBe('')
    expect(derived('{"url":"http://127.0.0.1:1/mcp"}')).toBe('')
    expect(derived('{"url":"not a url"}')).toBe('')
    // A blank command never parses into a spec, so it is asked of the derivation
    // itself rather than through a document.
    expect(serverNameFromSpec({ type: 'stdio', command: '' })).toBe('')
  })

  it('keeps the document\'s own name out of this path', () => {
    // An explicitly named document reports its name through `parseSpecText`, and
    // the editor prefers that value; the derivation still answers about the spec.
    const named = parseSpecText('{"mcpServers":{"yunxiao":{"url":"https://mcp.yunxiao.com/mcp"}}}', 'invalid')
    expect(named.serverName).toBe('yunxiao')
    expect(serverNameFromSpec(named.spec)).toBe('yunxiao')
  })
})
