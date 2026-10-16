import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findEntryRows, isRootAnchorInclude, readEntryListRowsSync, writableGlobalIncludes } from '../src/mcp-authoring.ts'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** One mounted row double, as the Loader exposes it to a read. */
const mounted = (id: string, name: string, filename?: string) => ({
  id,
  options: { id: id.split(':').pop(), name },
  ...filename === undefined ? {} : { subtree: { filename } },
})

describe('isRootAnchorInclude', () => {
  it('recognizes the host anchor by its pinned id, and nothing else', () => {
    expect(isRootAnchorInclude(mounted('include', 'cordis:include'))).toBe(true)
    // The package spelling is the same plugin.
    expect(isRootAnchorInclude(mounted('include', '@deepseek-ai/cordis-plugin-include'))).toBe(true)
    // A nested Include carries a qualified id, even when it is named `include`.
    expect(isRootAnchorInclude(mounted('include:include', 'cordis:include'))).toBe(false)
    // A root-level Include of the user's own has its own id.
    expect(isRootAnchorInclude(mounted('mcps', 'cordis:include'))).toBe(false)
    expect(isRootAnchorInclude(mounted('include', MCP_CLIENT))).toBe(false)
  })
})

describe('writableGlobalIncludes', () => {
  it('excludes the host anchor and keeps every Include of the user\'s own', () => {
    const entries = [
      mounted('include', 'cordis:include', '/home/u/.dsh/profiles/web/cordis.yml'),
      mounted('include:mcps', 'cordis:include', '/home/u/mcps.yml'),
      mounted('include:context7', MCP_CLIENT),
      // A tree with no file is not a write target at all.
      mounted('include:memory', 'cordis:include'),
    ]
    expect(writableGlobalIncludes(entries)).toEqual([
      { entry: entries[1], filename: '/home/u/mcps.yml' },
    ])
  })

  it('reports every user Include, so the caller can refuse an ambiguous target', () => {
    const entries = [
      mounted('include', 'cordis:include', '/home/u/.dsh/profiles/web/cordis.yml'),
      mounted('mcps-a', 'cordis:include', '/home/u/a.yml'),
      mounted('mcps-b', 'cordis:include', '/home/u/b.yml'),
    ]
    expect(writableGlobalIncludes(entries).map(include => include.filename))
      .toEqual(['/home/u/a.yml', '/home/u/b.yml'])
  })

  it('keeps a user Include whose file is not readable yet', () => {
    // Existence is not this scan's question: the caller reports an unreadable
    // file as its own read-only reason rather than as "no Include".
    const entries = [mounted('mcps', 'cordis:include', '/nonexistent/mcps.yml')]
    expect(writableGlobalIncludes(entries).map(include => include.filename)).toEqual(['/nonexistent/mcps.yml'])
  })
})

describe('readEntryListRowsSync', () => {
  it('reads the file\'s own rows, nested group children included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-authoring-'))
    try {
      const file = join(dir, 'mcps.yml')
      writeFileSync(file, [
        '- id: plain',
        `  name: '${MCP_CLIENT}'`,
        '- id: wrapper',
        '  name: cordis:group',
        '  group: true',
        '  config:',
        '    - id: nested',
        `      name: '${MCP_CLIENT}'`,
        '',
      ].join('\n'))
      const rows = readEntryListRowsSync(file)
      expect(rows?.map(row => row.id)).toEqual(['plain', 'wrapper'])
      expect(findEntryRows(rows ?? [], 'nested')).toHaveLength(1)
      expect(findEntryRows(rows ?? [], 'absent')).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('answers undefined for a missing or malformed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-authoring-'))
    try {
      expect(readEntryListRowsSync(join(dir, 'absent.yml'))).toBeUndefined()
      const malformed = join(dir, 'malformed.yml')
      writeFileSync(malformed, 'just a string\n')
      expect(readEntryListRowsSync(malformed)).toBeUndefined()
      const broken = join(dir, 'broken.yml')
      writeFileSync(broken, '- id: noName\n')
      expect(readEntryListRowsSync(broken)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
