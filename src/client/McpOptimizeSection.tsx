/**
 * MCP optimization settings page: how much of a tool list enters the context.
 *
 * A separate `settings.section` from the roster on purpose. The roster answers
 * "which servers exist and when may a session load one"; this page answers the
 * orthogonal question the MCP client best-practices guide calls progressive
 * discovery — whether the model can search before loading, whether a listing is
 * paged, whether argument schemas are deferred to the moment they are needed,
 * and how long a discovery result may be reused instead of reconnecting.
 *
 * Every control writes one field of the `mcp-manager` namespace's `optimize`
 * map through the shared controller, so the same document the Host reads is the
 * one this page edits, and each row shows its own save state.
 * @module @guowenzhang/dsh-mcp-manager/client/McpOptimizeSection
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  MCP_CATALOG_TTL_RANGE,
  MCP_MAX_TOOLS_RANGE,
  MCP_PAGE_SIZE_RANGE,
  parseMcpOptimizeFlags,
  type McpOptimizeFlags,
} from '../mcp-optimize.ts'
import type { McpCatalogEntryView } from '../types.ts'
import type { McpSectionFace } from './settings-controller.ts'
import type { McpSectionKey } from './locales.ts'
import css from './McpOptimizeSection.module.css'

/** Full component props. */
export type McpOptimizeSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcpManager'>
  & InjectFace<McpSectionFace>

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = McpOptimizeSectionProps['t']

/** The catalogue panel's view state. */
type CatalogView =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly entries: readonly McpCatalogEntryView[]
    readonly total: number
    readonly refreshing: boolean
  }

/** One row's save state, shown beside its control. */
type RowState = 'idle' | 'saving' | 'saved'

/** Settings that must be a whole number of milliseconds per minute in the UI. */
const MS_PER_MINUTE = 60_000

/**
 * Render one boolean setting row.
 * @param props.field - the policy field the switch writes.
 * @param props.label - the localized row label, also the switch's accessible name.
 * @param props.desc - the localized one-line explanation under the label.
 * @param props.value - the committed value.
 * @param props.disabled - whether the document is writable.
 * @param props.state - this row's save state.
 * @param props.onWrite - called with the value the user asked for.
 * @param props.t - the section's translator.
 * @returns the row.
 */
function SwitchRow({ field, label, desc, value, disabled, state, onWrite, t }: {
  readonly field: string
  readonly label: string
  readonly desc: string
  readonly value: boolean
  readonly disabled: boolean
  readonly state: RowState
  readonly onWrite: (field: string, value: unknown) => void
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.row} data-optimize-field={field}>
      <div className={css.rowText}>
        <span className={css.rowLabel}>{label}</span>
        <span className={css.rowDesc}>{desc}</span>
      </div>
      <div className={css.rowControl}>
        <span className={css.rowState} data-state={state} role="status">
          {state === 'saving' ? t('opt.state.saving') : state === 'saved' ? t('opt.state.saved') : ''}
        </span>
        <Switch
          checked={value}
          onChange={(next) => { onWrite(field, next) }}
          label={label}
          disabled={disabled}
          title={disabled ? t('unavailable') : undefined}
        />
      </div>
    </div>
  )
}

/**
 * Render one whole-number setting row.
 *
 * The field keeps a local draft so a half-typed value never reaches the Host;
 * the draft commits on blur or Enter and reverts when it is not a number.
 * @param props.field - the policy field the input writes.
 * @param props.label - the localized row label.
 * @param props.desc - the localized one-line explanation under the label.
 * @param props.value - the committed value, in the field's own unit.
 * @param props.min - smallest accepted value.
 * @param props.max - largest accepted value.
 * @param props.disabled - whether the document is writable.
 * @param props.state - this row's save state.
 * @param props.onWrite - called with the value the user asked for.
 * @param props.t - the section's translator.
 * @returns the row.
 */
function NumberRow({ field, label, desc, value, min, max, disabled, state, onWrite, t }: {
  readonly field: string
  readonly label: string
  readonly desc: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly disabled: boolean
  readonly state: RowState
  readonly onWrite: (field: string, value: unknown) => void
  readonly t: Translate
}): ReactNode {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = (): void => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
    setDraft(String(clamped))
    if (clamped !== value) onWrite(field, clamped)
  }
  return (
    <div className={css.row} data-optimize-field={field}>
      <div className={css.rowText}>
        <span className={css.rowLabel}>{label}</span>
        <span className={css.rowDesc}>{desc}</span>
      </div>
      <div className={css.rowControl}>
        <span className={css.rowState} data-state={state} role="status">
          {state === 'saving' ? t('opt.state.saving') : state === 'saved' ? t('opt.state.saved') : ''}
        </span>
        <Input
          className={css.numberInput ?? ''}
          type="number"
          inputMode="numeric"
          value={draft}
          min={min}
          max={max}
          aria-label={label}
          disabled={disabled}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
      </div>
    </div>
  )
}

/**
 * Localize how long ago one catalogue record was made.
 * @param ageMs - age in milliseconds.
 * @param t - the section's translator.
 * @returns the localized age.
 */
function ageText(ageMs: number, t: Translate): string {
  const seconds = Math.round(ageMs / 1_000)
  if (seconds < 60) return t('opt.catalog.age.seconds').replace('{n}', String(seconds))
  return t('opt.catalog.age.minutes').replace('{n}', String(Math.round(seconds / 60)))
}

/** The MCP optimization settings page body. */
export function McpOptimizeSection(props: McpOptimizeSectionProps): ReactNode {
  const { useMcpSettings, setOptimize, catalogState, clearCatalog, t } = props
  const state = useMcpSettings(snapshot => snapshot)
  const policy: McpOptimizeFlags = parseMcpOptimizeFlags(state.optimize)
  const disabled = !state.available || !state.writable
  const [savingField, setSavingField] = useState<string | null>(null)
  const [savedField, setSavedField] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogView>({ status: 'loading' })
  const [catalogRequest, setCatalogRequest] = useState(0)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const write = useCallback((field: string, value: unknown): void => {
    setSavingField(field)
    setSavedField(null)
    setFailure(null)
    void setOptimize(field, value).then(
      () => { setSavedField(field) },
      (cause: unknown) => { setFailure(cause instanceof Error ? cause.message : String(cause)) },
    ).finally(() => {
      setSavingField(current => current === field ? null : current)
    })
  }, [setOptimize])

  useEffect(() => {
    let current = true
    // A refresh keeps the rendered catalogue: the read is a plain snapshot of an
    // in-memory map, so replacing it with a loading line would only flicker.
    setCatalog(previous => previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' })
    void catalogState().then(
      (result) => {
        if (!current) return
        setCatalog({ status: 'ready', entries: result.entries, total: result.total, refreshing: false })
      },
      () => {
        if (current) {
          setCatalog(previous => previous.status === 'ready' ? { ...previous, refreshing: false } : { status: 'error' })
        }
      },
    )
    return () => { current = false }
  }, [catalogState, catalogRequest])

  const rowState = (field: string): RowState =>
    savingField === field ? 'saving' : savedField === field ? 'saved' : 'idle'
  const rowProps = { disabled, t, onWrite: write }
  const entries = catalog.status === 'ready' ? catalog.entries : []
  const toolCount = entries.reduce((total, entry) => total + entry.tools, 0)

  const clear = (): void => {
    setCatalogBusy(true)
    setFailure(null)
    setNotice(null)
    void clearCatalog().then(
      (result) => {
        setNotice(t('opt.catalog.cleared').replace('{n}', String(result.cleared)))
        setCatalogRequest(value => value + 1)
      },
      (cause: unknown) => { setFailure(cause instanceof Error ? cause.message : String(cause)) },
    ).finally(() => { setCatalogBusy(false) })
  }

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('opt.intro')}</p>
      {!state.available ? <p className={css.unavailable}>{t('unavailable')}</p> : null}

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('opt.group.search')}</h3>
        <p className={css.groupHint}>{t('opt.group.search.hint')}</p>
        <SwitchRow field="search" label={t('opt.search')} desc={t('opt.search.desc')} value={policy.search} state={rowState('search')} {...rowProps} />
        <SwitchRow field="searchIndex" label={t('opt.searchIndex')} desc={t('opt.searchIndex.desc')} value={policy.searchIndex} state={rowState('searchIndex')} {...rowProps} />
        <NumberRow
          field="pageSize"
          label={t('opt.pageSize')}
          desc={t('opt.pageSize.desc')}
          value={policy.pageSize}
          min={MCP_PAGE_SIZE_RANGE.min}
          max={MCP_PAGE_SIZE_RANGE.max}
          state={rowState('pageSize')}
          {...rowProps}
        />
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('opt.group.load')}</h3>
        <p className={css.groupHint}>{t('opt.group.load.hint')}</p>
        <SwitchRow field="namesOnly" label={t('opt.namesOnly')} desc={t('opt.namesOnly.desc')} value={policy.namesOnly} state={rowState('namesOnly')} {...rowProps} />
        <NumberRow
          field="maxTools"
          label={t('opt.maxTools')}
          desc={t('opt.maxTools.desc')}
          value={policy.maxTools}
          min={MCP_MAX_TOOLS_RANGE.min}
          max={MCP_MAX_TOOLS_RANGE.max}
          state={rowState('maxTools')}
          {...rowProps}
        />
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('opt.group.catalog')}</h3>
        <p className={css.groupHint}>{t('opt.group.catalog.hint')}</p>
        <NumberRow
          field="catalogTtlMs"
          label={t('opt.catalogTtl')}
          desc={t('opt.catalogTtl.desc')}
          value={Math.round(policy.catalogTtlMs / MS_PER_MINUTE)}
          min={Math.round(MCP_CATALOG_TTL_RANGE.min / MS_PER_MINUTE)}
          max={Math.round(MCP_CATALOG_TTL_RANGE.max / MS_PER_MINUTE)}
          state={rowState('catalogTtlMs')}
          onWrite={(field, value) => { write(field, Number(value) * MS_PER_MINUTE) }}
          disabled={disabled}
          t={t}
        />
        <div className={css.catalog}>
          <div className={css.catalogHead}>
            <span className={css.rowLabel}>{t('opt.catalog.title')}</span>
            <span className={css.catalogSummary}>
              {catalog.status === 'ready'
                ? t('opt.catalog.summary').replace('{servers}', String(catalog.total)).replace('{tools}', String(toolCount))
                : catalog.status === 'error' ? t('mcp.error') : t('mcp.loading')}
            </span>
            <span className={css.catalogActions}>
              <button
                type="button"
                className={css.action}
                disabled={catalogBusy}
                onClick={() => { setCatalogRequest(value => value + 1) }}
              >
                {t('opt.catalog.refresh')}
              </button>
              <button
                type="button"
                className={css.action}
                disabled={catalogBusy || catalog.status !== 'ready' || catalog.total === 0}
                onClick={clear}
              >
                {t('opt.catalog.clear')}
              </button>
            </span>
          </div>
          {catalog.status === 'ready' && entries.length === 0
            ? <p className={css.catalogEmpty}>{t('opt.catalog.empty')}</p>
            : null}
          {entries.length > 0 ? (
            <ul className={css.catalogList}>
              {entries.map(entry => (
                <li key={entry.key} className={css.catalogRow}>
                  <span className={css.catalogKey}>{entry.key}</span>
                  <span className={css.catalogMeta}>
                    {t('opt.catalog.row')
                      .replace('{tools}', String(entry.tools))
                      .replace('{age}', ageText(entry.ageMs, t))}
                    {entry.truncated ? ` · ${t('opt.catalog.truncated')}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className={css.group}>
        <h3 className={css.groupTitle}>{t('opt.group.annotations')}</h3>
        <p className={css.groupHint}>{t('opt.group.annotations.hint')}</p>
        <SwitchRow field="annotations" label={t('opt.annotations')} desc={t('opt.annotations.desc')} value={policy.annotations} state={rowState('annotations')} {...rowProps} />
        <SwitchRow field="hideDestructive" label={t('opt.hideDestructive')} desc={t('opt.hideDestructive.desc')} value={policy.hideDestructive} state={rowState('hideDestructive')} {...rowProps} />
      </section>

      {failure === null ? null : <p className={css.failure} role="alert">{failure}</p>}
      {notice === null ? null : <p className={css.notice} role="status">{notice}</p>}
    </div>
  )
}
