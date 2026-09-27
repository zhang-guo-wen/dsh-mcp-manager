/**
 * Declared agent-preset compositions, read and written where the harness keeps
 * them: the active profile's patch.
 *
 * A preset is an ordinary Cordis declaration — `@deepseek-ai/dsh-agent-preset`
 * carrying a `config.plugins` child list — so its persistence belongs to
 * `configEditor`, the profile-patch owner. This module therefore touches no
 * file: reads come from the declaring Loader entry, and a write goes through
 * `configEditor.edit`, whose Loader reconcile is what puts the change live.
 *
 * @module @guowenzhang/dsh-mcp-manager/preset-source
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the config editor's Context merge (ctx.configEditor).
import type {} from '@deepseek-ai/dsh-config-editor'
import { entryListProblem, type PatchWarning } from './mcp-authoring.ts'
import type { McpTarget } from './types.ts'

/** Module specifier of the plugin every preset declaration names. */
export const AGENT_PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** One declared preset beside the Loader entry that carries it. */
export interface PresetDeclaration {
  /** Preset identity sessions record. */
  readonly id: string
  /** Display name the declaration carries, when it carries one. */
  readonly name?: string
  /** The declaration row, addressed by `configEditor.edit`. */
  readonly entry: Entry
  /** Declared child rows, in composition order. */
  readonly rows: EntryOptions[]
}

/** The profile editor, or undefined when this composition mounts none. */
function profileEditor(ctx: Context): Context['configEditor'] | undefined {
  return ctx.get('configEditor')
}

/**
 * Locate every declaration the profile editor owns.
 *
 * The read is tolerant on purpose: a declaration whose child list is malformed,
 * or one that is still missing its preset id, is skipped so a roster read can
 * still describe the presets that are usable. {@link findPresetDeclaration}
 * keeps reporting those as errors when a mutation names one.
 * @param ctx - host context carrying `configEditor`.
 * @returns declarations in editor order.
 */
export function listPresetDeclarations(ctx: Context): PresetDeclaration[] {
  const editor = profileEditor(ctx)
  if (editor === undefined) return []
  const declared: PresetDeclaration[] = []
  for (const entry of editor.entries()) {
    if (entry.options.name !== AGENT_PRESET_MODULE) continue
    const config = entry.options.config as { id?: unknown; name?: unknown; plugins?: unknown } | undefined
    if (typeof config?.id !== 'string' || config.id === '') continue
    declared.push({
      id: config.id,
      ...typeof config.name === 'string' && config.name !== '' ? { name: config.name } : {},
      entry,
      rows: Array.isArray(config.plugins) ? config.plugins as EntryOptions[] : [],
    })
  }
  return declared
}

/**
 * Validate one declaration's child rows.
 * @param config - the declaration's composed configuration.
 * @param id - preset identity used in the diagnostic.
 * @returns the child rows.
 * @throws an MCP Remote error when the row list is malformed.
 */
function declaredRows(config: unknown, id: string): EntryOptions[] {
  const plugins = (config as { plugins?: unknown } | undefined)?.plugins
  const problem = entryListProblem(plugins)
  if (problem !== undefined) {
    throw new RemoteError('mcp/invalid', `Agent preset "${id}" is not a valid composition`, {
      reason: problem,
    })
  }
  return plugins as EntryOptions[]
}

/**
 * Whether one Loader entry declares the given preset.
 * @param entry - candidate declaration row.
 * @param id - preset identity.
 * @returns whether this row declares that preset.
 */
function declares(entry: Entry, id: string): boolean {
  return entry.options.name === AGENT_PRESET_MODULE
    && (entry.options.config as { id?: unknown } | undefined)?.id === id
}

/**
 * Locate the declaration of one preset.
 * @param ctx - host context carrying `configEditor`.
 * @param id - preset identity.
 * @returns the declaration with its declared child rows.
 * @throws an MCP Remote error when no editor is mounted or the preset is undeclared.
 */
export function findPresetDeclaration(ctx: Context, id: string): PresetDeclaration {
  const editor = profileEditor(ctx)
  if (editor === undefined) {
    throw new RemoteError('mcp/unavailable', 'agent preset MCP authoring is unavailable', {
      reason: 'configEditor is not mounted in this composition',
    })
  }
  const rows = editor.entries()
  const entry = rows.find(candidate => declares(candidate, id))
  if (entry === undefined) {
    const target: McpTarget = { scope: 'preset', agentPreset: id }
    throw new RemoteError('mcp/not-found', `MCP preset "${id}" was not found`, { target })
  }
  const name = (entry.options.config as { name?: unknown } | undefined)?.name
  return {
    id,
    ...typeof name === 'string' && name !== '' ? { name } : {},
    entry,
    rows: declaredRows(entry.options.config, id),
  }
}

/**
 * Apply one Loader patch to a preset's declared child rows.
 *
 * The editor owns the profile lock, so the read-validate-patch-write cycle runs
 * against the state another editor would see, and its Loader reconcile mounts or
 * unmounts exactly the rows the declaration changed — a separate refresh step
 * would only repeat that work.
 * @param ctx - host context carrying `configEditor`.
 * @param declaration - the preset to edit.
 * @param patch - one Loader patch applied to the declared child rows.
 * @param validate - target and duplicate checks run against the rows being replaced.
 * @param warn - sink for skipped-patch diagnostics.
 * @returns a promise resolving after the profile patch and its reconcile commit.
 * @throws an MCP Remote error when no editor is mounted.
 */
export async function writePresetRows(
  ctx: Context,
  declaration: PresetDeclaration,
  patch: PatchOptions,
  validate: (rows: EntryOptions[]) => void,
  warn: PatchWarning,
): Promise<void> {
  const editor = profileEditor(ctx)
  if (editor === undefined) {
    throw new RemoteError('mcp/unavailable', 'agent preset MCP authoring is unavailable', {
      reason: 'configEditor is not mounted in this composition',
    })
  }
  await editor.edit(declaration.entry, (current) => {
    const rows = declaredRows(current, declaration.id)
    validate(rows)
    return { ...current, plugins: applyEntryPatches(rows, [patch], warn) }
  })
}
