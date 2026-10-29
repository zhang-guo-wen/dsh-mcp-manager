import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

// Prevent accidental reintroduction of the superseded JSON-file storage path.
describe('catalogue storage selection', () => {
  it('uses SQLite as the only persisted catalogue implementation', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('databaseCatalogStorage')
    expect(source).not.toContain('mcp-catalog-file')
  })
})
