/** File-backed MCP row mutations for the global composition. */

import { readFileSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { McpTarget } from './types.ts'

export { MCP_CLIENT_MODULE } from './mcp-modules.ts'

/**
 * Loader id the host pins its own root anchor Include to.
 *
 * `mountRootInclude` creates it as a direct Loader entry with this id, so a
 * nested Include — and every other row — carries a qualified id instead.
 */
export const ROOT_ANCHOR_INCLUDE_ID = 'include'

/** Whether one row names the Include plugin, by builtin name or package name. */
export function isIncludeRow(options: { readonly name?: unknown }): boolean {
  return options.name === 'cordis:include' || options.name === '@deepseek-ai/cordis-plugin-include'
}

/**
 * Whether one mounted Include is the host's own root anchor.
 *
 * The anchor points at `$DSH_HOME/profiles/<profile>/cordis.yml`, which
 * `prepareProfile` rewrites from the composed layers on every start, so a write
 * there is discarded at the next boot: it is never a settings-page target. The
 * pinned id identifies it structurally, without depending on the host's profile
 * layout. Only a root-level entry carries an unqualified Loader id, so a nested
 * Include named `include` still reads as the user's.
 * @param entry - one mounted Loader row.
 * @returns whether that row is the host's root anchor Include.
 */
export function isRootAnchorInclude(entry: { readonly id: string; readonly options: { readonly name?: unknown } }): boolean {
  return entry.id === ROOT_ANCHOR_INCLUDE_ID && isIncludeRow(entry.options)
}

/** One row the composition mounts, as far as the writable-Include scan reads it. */
export interface ComposedIncludeRow {
  readonly id: string
  readonly options: { readonly name?: unknown }
  readonly subtree?: object | undefined
}

/** A file-backed Include a global write may target, with the file it owns. */
export interface WritableInclude<T> {
  readonly entry: T
  readonly filename: string
}

/** The file one mounted Include tree owns, when it exposes a usable path. */
function includeFilename(tree: object): string | undefined {
  const filename = (tree as { readonly filename?: unknown }).filename
  return typeof filename === 'string' && filename !== '' ? filename : undefined
}

/**
 * Collect the file-backed Includes a settings-page global write may target.
 *
 * The host's root anchor is excluded: its file is regenerated on every start.
 * Every other file-backed Include is the user's own, wherever the composition
 * put it — a nested one is how a profile declares its own composition file.
 * @param entries - the Loader's entries, in composition order.
 * @returns each addressable Include with its filename, in composition order.
 */
export function writableGlobalIncludes<T extends ComposedIncludeRow>(entries: Iterable<T>): WritableInclude<T>[] {
  const found: WritableInclude<T>[] = []
  for (const entry of entries) {
    if (!isIncludeRow(entry.options) || entry.subtree === undefined) continue
    if (isRootAnchorInclude(entry)) continue
    const filename = includeFilename(entry.subtree)
    if (filename === undefined) continue
    found.push({ entry, filename })
  }
  return found
}

/**
 * Read one entry-list file's own rows for a read-only decision.
 *
 * This reads the file, not the mounted tree: a row a patch layer or a nested
 * composition contributes is live but absent here, and only the rows this file
 * declares can be patched back into it.
 * @param filename - YAML or JSON entry-list path.
 * @returns the file's rows, or undefined when it cannot be read or parsed.
 */
export function readEntryListRowsSync(filename: string): EntryOptions[] | undefined {
  let parsed: unknown
  try {
    parsed = load(readFileSync(filename, 'utf8'), { schema: entryListSchema })
  } catch {
    // A missing or unreadable file declares no rows; the caller reports that
    // absence as "not writable from here" rather than throwing out of a read.
    return undefined
  }
  if (entryListProblem(parsed) !== undefined) return undefined
  return parsed as EntryOptions[]
}

/** Callback used for diagnostics emitted by the Loader patch dialect. */
export type PatchWarning = (message: string, ...args: unknown[]) => void

/**
 * Validate one parsed Loader entry list before applying a mutation.
 * @param value - parsed YAML or JSON content.
 * @returns the first validation problem, or undefined for a valid entry list.
 */
export function entryListProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'composition must be a top-level entry list'
  return entryListRowsProblem(value, 'composition')
}

function entryListRowsProblem(rows: readonly unknown[], path: string): string | undefined {
  for (const [index, value] of rows.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${path}[${index}] must be an entry object`
    }
    const row = value as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) return `${path}[${index}].id must be a non-empty string`
    if (typeof row.name !== 'string' || row.name.length === 0) return `${path}[${index}].name must be a non-empty string`
    if (row.group === true) {
      if (!Array.isArray(row.config)) return `${path}[${index}].config must be an entry list for a group`
      const problem = entryListRowsProblem(row.config, `${path}[${index}].config`)
      if (problem !== undefined) return problem
    }
  }
  return undefined
}

/**
 * Find rows recursively, preserving the local Loader ids used by patches.
 * @param rows - entry rows at the current composition level.
 * @param id - row id to locate.
 * @returns every matching row, including nested group children.
 */
export function findEntryRows(rows: readonly EntryOptions[], id: string): EntryOptions[] {
  const found: EntryOptions[] = []
  for (const row of rows) {
    if (row.id === id) found.push(row)
    if (row.group === true && Array.isArray(row.config)) {
      found.push(...findEntryRows(row.config as EntryOptions[], id))
    }
  }
  return found
}

/**
 * Collect every row id in a composition, including nested group children.
 * @param rows - entry rows at the current composition level.
 * @returns all row ids in the composition.
 */
export function entryIds(rows: readonly EntryOptions[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    ids.add(row.id)
    if (row.group === true && Array.isArray(row.config)) {
      for (const id of entryIds(row.config as EntryOptions[])) ids.add(id)
    }
  }
  return ids
}

/** Reject a preset path that traverses a symbolic link. */
async function assertNoSymlink(path: string): Promise<void> {
  let current = resolve(path)
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`preset composition path contains a symbolic link: ${current}`)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/**
 * Apply one Loader patch to an entry-list file and replace it atomically.
 * @param filename - YAML or JSON entry-list path.
 * @param target - the Remote target used in actionable failure details.
 * @param patch - one Loader patch to apply.
 * @param validate - target and duplicate checks run against locked disk state.
 * @param warn - sink for skipped-patch diagnostics.
 * @returns a promise resolving after the atomic replacement is committed.
 * @throws an MCP Remote error when the file cannot be read or parsed.
 */
export async function writeEntryListFile(
  filename: string,
  target: McpTarget,
  patch: PatchOptions,
  validate: (rows: EntryOptions[]) => void,
  warn: PatchWarning,
): Promise<void> {
  await assertNoSymlink(filename)
  await withFileLock(filename, async () => {
    await assertNoSymlink(filename)
    let parsed: unknown
    try {
      parsed = load(await readFile(filename, 'utf8'), { schema: entryListSchema })
    } catch (cause) {
      const reason = String(cause)
      throw new RemoteError('mcp/invalid', 'MCP entry-list file could not be read', { target, reason }, { cause })
    }
    const problem = entryListProblem(parsed)
    if (problem !== undefined) {
      throw new RemoteError('mcp/invalid', 'MCP entry-list file is not valid', { target, reason: problem })
    }
    const rows = parsed as EntryOptions[]
    validate(rows)
    const next = applyEntryPatches(rows, [patch], warn)
    const content = extname(filename).toLowerCase() === '.json'
      ? JSON.stringify(next, null, 2) + '\n'
      : dump(next, { schema: entryListSchema })
    await writeFileAtomic(filename, content, { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Return a stable leaf id for a mounted preset row address.
 * @param entryId - local or loader-qualified row id.
 * @returns the row id used in the preset composition file.
 */
export function presetLeafId(entryId: string): string {
  const separator = entryId.lastIndexOf(':')
  return separator < 0 ? entryId : entryId.slice(separator + 1)
}
