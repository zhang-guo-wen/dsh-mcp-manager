/**
 * The credential view of the editor's JSON box.
 *
 * The dialog keeps ONE document — the JSON the user types — and the credentials
 * pane is a view of its `env`/`headers` map, not a second copy of it. These
 * rules read and write that view, so the pane never has to reconcile a draft
 * with the box: what the pane shows is what the box holds, and a save writes
 * the box.
 *
 * They live here rather than in the editor component because they are pure and
 * carry the fiddly part — a partial, hand-typed document may be a flat spec, a
 * single named entry, or a Claude `mcpServers` wrapper, and none of those is
 * required to be valid yet.
 * @module @guowenzhang/dsh-mcp-manager/client/credential-fields
 */

import { transportKindOf, type AnyRecord } from '../mcp-spec.ts'

/** Which credential map one pane edits; both are `KEY → value` pairs. */
export type CredentialKind = 'env' | 'headers'

/** One credential map read out of the JSON box. */
export interface CredentialValues {
  /** `KEY → value` in declaration order; empty when the box declares none. */
  readonly entries: readonly (readonly [string, string])[]
  /**
   * Whether the box carries a `KEY → value` shape this pane can write back to:
   * an array, a string, or a number where the map belongs cannot be edited here
   * without silently dropping what the user typed.
   */
  readonly editable: boolean
}

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The object one credential map lives on, unwrapping the two containers the
 * parser also accepts. Undefined when the text is not an object at all.
 * @param decoded - the decoded JSON box.
 * @returns the object carrying the transport fields.
 */
function entryOf(decoded: unknown): AnyRecord | undefined {
  if (!isRecord(decoded)) return undefined
  const root = isRecord(decoded.mcpServers) ? decoded.mcpServers : decoded
  // A named entry (`{ "<name>": { command } }`) is what the parser accepts when
  // the object declares no transport of its own, so the pane unwraps the same
  // way rather than reporting a document with no credentials.
  const keys = Object.keys(root)
  if (transportKindOf(root) === undefined && keys.length === 1) {
    const only = root[keys[0] as string]
    if (isRecord(only)) return only
  }
  return root
}

/**
 * Read one credential map out of the JSON box.
 *
 * Every value is a string once saved, but the box is free text until then, so a
 * non-string value is rendered as its JSON text and written back as the string
 * it shows: the pane edits exactly what the user can see.
 * @param json - the JSON box's current text.
 * @param kind - the map to read (`env` for stdio, `headers` for HTTP).
 * @returns the pairs in declaration order and whether the shape is writable, or
 *   undefined when the text is not a document this pane can show.
 */
export function credentialValues(json: string, kind: CredentialKind): CredentialValues | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch {
    return undefined
  }
  const entry = entryOf(decoded)
  if (entry === undefined) return undefined
  const source = entry[kind]
  if (source === undefined) return { entries: [], editable: true }
  if (!isRecord(source)) return { entries: [], editable: false }
  return {
    entries: Object.entries(source).map(([key, value]) =>
      [key, typeof value === 'string' ? value : JSON.stringify(value)] as const),
    editable: true,
  }
}

/**
 * Write one credential value back into the JSON box, leaving every other field
 * of the document as it was typed.
 * @param json - the JSON box's current text.
 * @param kind - the map to write (`env` or `headers`).
 * @param key - the entry's key.
 * @param value - the entry's new value.
 * @returns the box's new text, or undefined when the text is not a document
 *   this pane can write to.
 */
export function credentialText(json: string, kind: CredentialKind, key: string, value: string): string | undefined {
  let decoded: unknown
  try {
    decoded = JSON.parse(json)
  } catch {
    return undefined
  }
  const entry = entryOf(decoded)
  if (entry === undefined) return undefined
  const source = entry[kind]
  if (source !== undefined && !isRecord(source)) return undefined
  entry[kind] = { ...(source ?? {}), [key]: value }
  return JSON.stringify(decoded, null, 2)
}

/**
 * Fold the credential fields the user changed into the document about to be
 * saved.
 *
 * Only the changed ones: the pane edits a box the user also edits by hand, and
 * a value it never showed must not be replaced by the version the pane read
 * when it opened.
 * @param current - the JSON box's current text.
 * @param opened - the text the credentials pane opened with.
 * @returns the text to save, or `current` unchanged when nothing was edited.
 */
export function mergeCredentialEdits(current: string, opened: string): string {
  if (opened === '' || opened === current) return current
  let next = current
  for (const kind of ['env', 'headers'] as const) {
    const before = credentialValues(opened, kind)
    const now = credentialValues(next, kind)
    if (before === undefined || now === undefined || !before.editable || !now.editable) continue
    const shown = new Map(now.entries)
    for (const [key, value] of before.entries) {
      const edited = shown.get(key)
      if (edited === undefined || edited === value) continue
      next = credentialText(next, kind, key, edited) ?? next
    }
  }
  return next
}
