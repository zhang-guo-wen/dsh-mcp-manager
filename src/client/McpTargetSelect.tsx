/**
 * The one picker that names where a write lands: the global plane, or one agent
 * preset.
 *
 * A row and an import each go to exactly one of the two, so asking the plane and
 * the preset as two fields asked one question twice — and left the second field
 * meaningless while the first answered "global". Both dialogs render this control
 * so the two cannot drift apart.
 *
 * The empty value stands for the global plane: every preset id is non-empty,
 * which is the same sentinel convention the roster filter uses.
 * @module @guowenzhang/dsh-mcp-manager/client/McpTargetSelect
 */

import type { ReactNode } from 'react'
import type { McpSectionKey } from './locales.ts'
import type { McpPlane, McpPresetOption } from './settings-controller.ts'
import css from './McpSection.module.css'

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = (key: McpSectionKey) => string

/**
 * The home a dialog's picker opens on, from the plane its caller named.
 *
 * The caller always hands over a plane; only the agent plane can also name the
 * preset it was narrowed to. An agent plane without a preset to name falls back
 * to the global plane, and the list arriving behind it is what offers the first
 * preset instead.
 * @param plane - the plane the caller opened the dialog on.
 * @param preset - the preset the caller was narrowed to, when it was.
 * @returns the picker's initial value.
 */
export function initialTarget(plane: McpPlane, preset: string | undefined): string {
  return plane === 'global' ? '' : preset ?? ''
}

/**
 * Render the labeled target picker of one write.
 * @param props.label - localized field name, and the control's accessible name.
 * @param props.value - chosen home: `''` for the global plane, else a preset id.
 * @param props.presets - every preset a write can address, in roster order.
 * @param props.globalWritable - whether the global plane has a file to write.
 * @param props.disabled - whether the surrounding form refuses input.
 * @param props.onChange - called with the chosen value.
 * @param props.t - the section's translator.
 * @returns the field, as the `<label>`'s own contents.
 */
export function McpTargetSelect({ label, value, presets, globalWritable, disabled, onChange, t }: {
  readonly label: string
  readonly value: string
  readonly presets: readonly McpPresetOption[]
  readonly globalWritable: boolean
  readonly disabled: boolean
  readonly onChange: (next: string) => void
  readonly t: Translate
}): ReactNode {
  // A preset the roster no longer lists still needs its own option, or the
  // control would hold a value it cannot display.
  const unlisted = value !== '' && !presets.some(option => option.id === value)
  return (
    <>
      <span className={css.formLabel}>{label}</span>
      <select
        className={css.formSelect}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => { onChange(event.currentTarget.value) }}
      >
        <option value="" disabled={!globalWritable}>{t('mcp.scopeGlobal')}</option>
        {presets.map(option => (
          <option key={option.id} value={option.id}>{`${t('mcp.scopePreset')} · ${option.name}`}</option>
        ))}
        {unlisted ? <option value={value}>{`${t('mcp.scopePreset')} · ${value}`}</option> : null}
      </select>
    </>
  )
}
