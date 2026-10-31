import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import {
  GLOBAL_INCLUDE_FILE,
  GLOBAL_INCLUDE_ID,
  ensureGlobalInclude,
  planGlobalInclude,
} from '../src/mcp-global-include.ts'

/** One temporary profile directory, removed by the caller. */
function profileDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-global-include-'))
}

/** Parse a written patch layer, asserting it stays a valid entry list. */
function patchesOf(text: string): unknown[] {
  const parsed = load(text, { schema: entryListSchema })
  expect(Array.isArray(parsed)).toBe(true)
  return parsed as unknown[]
}

/** The Include row the plan inserts, when it inserts one. */
function insertedRow(text: string): { id?: unknown; name?: unknown; config?: { path?: unknown } } | undefined {
  for (const patch of patchesOf(text) as { insert?: { id?: string; name?: string; config?: { path?: string } }[] }[]) {
    for (const row of patch.insert ?? []) {
      if (row.id === GLOBAL_INCLUDE_ID) return row
    }
  }
  return undefined
}

describe('planGlobalInclude', () => {
  it('plans the Include file and the patch row a fresh profile needs', () => {
    const dir = profileDir()
    try {
      const plan = planGlobalInclude('', dir)
      expect(plan.filename).toBe(join(dir, GLOBAL_INCLUDE_FILE))
      expect(plan.patchChanged).toBe(true)
      const row = insertedRow(plan.patchText)
      expect(row?.name).toBe('cordis:include')
      expect(row?.config?.path).toBe(`./${GLOBAL_INCLUDE_FILE}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('turns the template\'s flow-style empty list into a block sequence and keeps comments', () => {
    const dir = profileDir()
    try {
      const plan = planGlobalInclude('# my patch layer\n[]\n', dir)
      expect(plan.patchText).toContain('# my patch layer')
      expect(insertedRow(plan.patchText)?.id).toBe(GLOBAL_INCLUDE_ID)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends after the entries a profile already carries, without rewriting them', () => {
    const dir = profileDir()
    const existing = [
      '- id: ui-theme',
      '  config:',
      '    preference: dark',
      '- id: mcp-manager',
      '  config:',
      '    loading: dynamic',
      '',
    ].join('\n')
    try {
      const plan = planGlobalInclude(existing, dir)
      expect(plan.patchText.startsWith(existing)).toBe(true)
      expect(plan.patchText).toContain('id: ui-theme')
      expect(plan.patchText).toContain('loading: dynamic')
      expect(insertedRow(plan.patchText)?.id).toBe(GLOBAL_INCLUDE_ID)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is idempotent: the row it wrote is left alone on the next plan', () => {
    const dir = profileDir()
    try {
      const first = planGlobalInclude('', dir)
      const second = planGlobalInclude(first.patchText, dir)
      expect(second.patchChanged).toBe(false)
      expect(second.patchText).toBe(first.patchText)
      expect(second.filename).toBe(join(dir, GLOBAL_INCLUDE_FILE))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('follows the path an existing Include row already names', () => {
    const dir = profileDir()
    const moved = join(dir, 'elsewhere.yml')
    const patch = [
      '- insert:',
      `    - id: ${GLOBAL_INCLUDE_ID}`,
      "      name: 'cordis:include'",
      '      config:',
      `        path: ${JSON.stringify(pathToFileURL(moved).href)}`,
      '',
    ].join('\n')
    try {
      const plan = planGlobalInclude(patch, dir)
      expect(plan.patchChanged).toBe(false)
      expect(plan.filename).toBe(moved)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a loader id another plugin already owns', () => {
    const dir = profileDir()
    try {
      const patch = [
        '- insert:',
        `    - id: ${GLOBAL_INCLUDE_ID}`,
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '',
      ].join('\n')
      expect(() => planGlobalInclude(patch, dir)).toThrow(/already uses the loader id/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a patch layer that is not an entry list', () => {
    const dir = profileDir()
    try {
      expect(() => planGlobalInclude('just a string\n', dir)).toThrow(/top-level YAML sequence/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ensureGlobalInclude', () => {
  it('writes the entry-list file and the patch row, then reloads once', async () => {
    const dir = profileDir()
    const patchPath = join(dir, 'cordis.patch.yml')
    const reconcile = vi.fn(async () => {})
    try {
      writeFileSync(patchPath, '- id: ui-theme\n  config:\n    preference: dark\n')
      const result = await ensureGlobalInclude({ profileDir: dir, patchPath, reconcile })
      expect(result).toEqual({ filename: join(dir, GLOBAL_INCLUDE_FILE), created: true, patchChanged: true })
      expect(readFileSync(join(dir, GLOBAL_INCLUDE_FILE), 'utf8')).toBe('[]\n')
      const patch = readFileSync(patchPath, 'utf8')
      expect(patch).toContain('id: ui-theme')
      expect(insertedRow(patch)?.id).toBe(GLOBAL_INCLUDE_ID)
      expect(reconcile).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does nothing on a second pass: the file and the row are both there', async () => {
    const dir = profileDir()
    const patchPath = join(dir, 'cordis.patch.yml')
    try {
      const first = vi.fn(async () => {})
      await ensureGlobalInclude({ profileDir: dir, patchPath, reconcile: first })
      const before = readFileSync(patchPath, 'utf8')
      const second = vi.fn(async () => {})
      const result = await ensureGlobalInclude({ profileDir: dir, patchPath, reconcile: second })
      expect(result).toEqual({ filename: join(dir, GLOBAL_INCLUDE_FILE), created: false, patchChanged: false })
      expect(readFileSync(patchPath, 'utf8')).toBe(before)
      expect(second).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves a global file the user already wrote untouched', async () => {
    const dir = profileDir()
    const patchPath = join(dir, 'cordis.patch.yml')
    try {
      const file = join(dir, GLOBAL_INCLUDE_FILE)
      writeFileSync(file, '- id: kept\n  name: kept\n')
      const result = await ensureGlobalInclude({ profileDir: dir, patchPath, reconcile: async () => {} })
      expect(result.created).toBe(false)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('- id: kept\n  name: kept\n')
      expect(insertedRow(readFileSync(patchPath, 'utf8'))?.id).toBe(GLOBAL_INCLUDE_ID)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
