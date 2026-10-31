/**
 * Create the user's own file-backed Include that makes the global plane writable.
 *
 * A fresh profile mounts only the host's root anchor Include
 * (`$DSH_HOME/profiles/<profile>/cordis.yml`), whose file `prepareProfile`
 * regenerates on every start. The settings page therefore has no file it may
 * patch, and the global plane is closed. The supported shape is a second,
 * user-owned Include declared by the profile patch layer; this module writes
 * exactly that row and the empty entry-list file it points at.
 *
 * The patch file is edited as text: the patch layer is hand-written YAML and may
 * carry comments, so appending one block preserves everything already there.
 * @module @guowenzhang/dsh-mcp-manager/mcp-global-include
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dump, load } from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Loader id of the Include row this module inserts into the profile patch layer. */
export const GLOBAL_INCLUDE_ID = 'mcp-manager-global'

/** File name of the entry-list file the inserted Include owns. */
export const GLOBAL_INCLUDE_FILE = 'mcp.cordis.yml'

/** The Include module specifier a patch layer names for a file-backed tree. */
const INCLUDE_MODULE = 'cordis:include'

/** Content of a newly created entry-list file: valid YAML with no rows. */
const EMPTY_ENTRY_LIST = '[]\n'

/** Settings the profile supplies, as far as writing into its patch layer needs them. */
export interface GlobalIncludeProfile {
  /** Directory holding the profile's composition files. */
  readonly dir: string
  /** The user patch layer this module appends to (`cordis.patch.yml`). */
  readonly patchPath: string
}

/** The file a global write would target, and the patch text that declares it. */
export interface GlobalIncludePlan {
  /** Absolute path of the Include's entry-list file. */
  readonly filename: string
  /** The profile patch layer after this plan, unchanged when it already declares one. */
  readonly patchText: string
  /** Whether {@link patchText} differs from the text this plan was made from. */
  readonly patchChanged: boolean
}

/** What one ensure pass created. */
export interface GlobalIncludeResult {
  /** Absolute path of the Include's entry-list file. */
  readonly filename: string
  /** Whether this pass created that file. */
  readonly created: boolean
  /** Whether this pass appended the Include row to the profile patch layer. */
  readonly patchChanged: boolean
}

/**
 * Parse one profile patch layer, requiring a top-level entry list.
 * @param text - the patch file's content; empty content declares no patches.
 * @returns the parsed patch entries.
 * @throws when the file holds anything other than a YAML sequence.
 */
function parsePatchText(text: string): PatchOptions[] {
  const parsed: unknown = load(text, { schema: entryListSchema })
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed)) throw new Error('the profile patch layer must hold a top-level YAML sequence')
  return parsed as PatchOptions[]
}

/** The Include row a patch layer inserts, when this module wrote one already. */
function insertedInclude(patches: readonly PatchOptions[]): EntryOptions | undefined {
  for (const patch of patches) {
    for (const row of patch.insert ?? []) {
      if (row.id !== GLOBAL_INCLUDE_ID) continue
      if (row.name !== INCLUDE_MODULE) {
        throw new Error(`the profile patch layer already uses the loader id "${GLOBAL_INCLUDE_ID}" for a different plugin`)
      }
      return row
    }
  }
  return undefined
}

/** The file path one Include row names, resolved beside the profile. */
function includeFilename(options: EntryOptions, profileDir: string): string | undefined {
  const config = options.config
  if (config === null || typeof config !== 'object') return undefined
  const path = (config as { readonly path?: unknown }).path
  if (typeof path !== 'string' || path === '') return undefined
  if (path.startsWith('file:')) return fileURLToPath(path)
  return isAbsolute(path) ? path : resolve(profileDir, path)
}

/** The patch block that declares the user's global Include. */
function renderIncludeBlock(): string {
  const rows: EntryOptions[] = [{
    id: GLOBAL_INCLUDE_ID,
    name: INCLUDE_MODULE,
    config: { path: `./${GLOBAL_INCLUDE_FILE}`, initial: [] },
  }]
  return dump([{ insert: rows }] as PatchOptions[], { schema: entryListSchema, lineWidth: -1, noRefs: true })
}

/**
 * Append one top-level patch entry to the patch layer's text.
 *
 * A patch file the template left as a flow-style empty list (`[]`) cannot take
 * a block entry after it, so the empty list is replaced instead of appended to;
 * comment lines before it survive.
 * @param text - current patch file content, possibly empty.
 * @param block - the YAML block to add.
 * @returns the next file content.
 */
function appendBlock(text: string, block: string): string {
  const trimmed = text.trimEnd()
  if (trimmed === '') return block
  // A flow-style empty list ends the document; a block entry cannot follow it.
  const emptyFlow = /(?:^|\n)[ \t]*\[\][ \t]*$/u.exec(trimmed)
  if (emptyFlow !== null) {
    const cut = emptyFlow.index + (emptyFlow[0].startsWith('\n') ? 1 : 0)
    return `${text.slice(0, cut)}${block}`
  }
  return text.endsWith('\n') ? `${text}${block}` : `${text}\n${block}`
}

/**
 * Decide what enabling the global plane would write, without touching the disk.
 *
 * Idempotent: a patch layer that already inserts the Include row is left alone,
 * and the row's own path decides the target file, so a user who moved the file
 * keeps it where it is.
 * @param patchText - current profile patch layer content.
 * @param profileDir - the profile directory new relative paths resolve against.
 * @returns the target file and the patch text to commit.
 * @throws when the patch layer is not a YAML sequence, or the id is taken by
 *   another plugin.
 */
export function planGlobalInclude(patchText: string, profileDir: string): GlobalIncludePlan {
  const patches = parsePatchText(patchText)
  const existing = insertedInclude(patches)
  if (existing !== undefined) {
    return {
      filename: includeFilename(existing, profileDir) ?? join(profileDir, GLOBAL_INCLUDE_FILE),
      patchText,
      patchChanged: false,
    }
  }
  const filename = join(profileDir, GLOBAL_INCLUDE_FILE)
  const next = appendBlock(patchText, renderIncludeBlock())
  // Validate what would be written before any caller commits it: a patch layer
  // that cannot be parsed fails the whole profile at boot.
  parsePatchText(next)
  return { filename, patchText: next, patchChanged: true }
}

/** Whether a path exists, without opening it. */
async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** One file's content, with a missing file read as empty. */
async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Create the user's global Include when the profile has none, then reload.
 *
 * Writing the Include row into the patch layer is not enough on its own: the
 * running composition is rebuilt from the patch layer by {@link options.reconcile},
 * which is why a changed patch is followed by that call. An unchanged patch is
 * not reloaded here — the caller decides whether the row is mounted.
 * @param options - profile locations and the reload callback.
 * @returns what this pass wrote.
 * @throws when the patch layer cannot be parsed or the files cannot be written.
 */
export async function ensureGlobalInclude(options: {
  readonly profileDir: string
  readonly patchPath: string
  readonly reconcile: () => Promise<void>
}): Promise<GlobalIncludeResult> {
  const plan = planGlobalInclude(await readTextOrEmpty(options.patchPath), options.profileDir)
  const created = !(await exists(plan.filename))
  if (created) await writeFileAtomic(plan.filename, EMPTY_ENTRY_LIST, { mode: 0o600, dirMode: 0o700 })
  if (plan.patchChanged) await writeFileAtomic(options.patchPath, plan.patchText, { mode: 0o600 })
  if (plan.patchChanged) await options.reconcile()
  return { filename: plan.filename, created, patchChanged: plan.patchChanged }
}
