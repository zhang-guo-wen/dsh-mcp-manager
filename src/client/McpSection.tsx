/**
 * MCP management settings section: the server roster with its loading mode.
 *
 * One list carries both planes, and no control chooses between them. Global rows
 * come first and in full, whatever agent preset the list is narrowed to: a
 * session carries its global rows regardless of the preset it runs, so hiding
 * them behind a selector would misstate what the composition mounts. The preset
 * picker narrows the agent rows — and names the target of a new agent row, which
 * is why every declared preset is offered and not only the ones owning rows.
 *
 * A row's editor always opens on that row's own plane, so editing cannot write
 * to the wrong side; the plane only decides where a *new* row goes, which is why
 * it follows the last deliberate choice.
 * @module @guowenzhang/dsh-mcp-manager/client/McpSection
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AddMcpRequest, EditMcpRequest } from '../types.ts'
import { describeMcpConfigIssues } from '../mcp-diagnostics.ts'
import { toolRuleEntries } from '../mcp-tool-filter.ts'
import { McpEditor, type McpEditorMode, type McpEditorRequest } from './McpEditor.tsx'
import { ClaudeImportDialog } from './ClaudeImportDialog.tsx'
import {
  MCP_LOADING_OPTIONS,
  mcpRowKey,
  type McpLoadingOption,
  type McpPhase,
  type McpPlane,
  type McpPresetOption,
  type McpRosterView,
  type McpSectionFace,
  type McpServer,
} from './settings-controller.ts'
import { MCP_ALL_PRESETS, mcpAgentFilterOptions, narrowMcpRows } from './agent-filter.ts'
import { rowAllowed } from './mcp-row-state.ts'
import { MCP_READ_ONLY_REASON, type McpSectionKey } from './locales.ts'
import css from './McpSection.module.css'

/**
 * Whether one row's actions are closed, and why.
 *
 * A row the Host's roster marks read-only has nowhere to write: a global row
 * only exists in the user's Include file when that file declares it. The
 * plane-level answer stays the fallback for a Host that reports no per-row flag
 * or that mounts no addressable file at all.
 * @param server - the rendered row.
 * @param busy - whether another authoring action is in flight.
 * @param planeUnavailable - whether the global plane has no addressable file.
 * @param planeReason - the plane-level reason, already localized.
 * @param t - the section's translator.
 * @returns the row's disabled flag and its tooltip reason.
 */
function rowActionState(
  server: McpServer,
  busy: boolean,
  planeUnavailable: boolean,
  planeReason: string,
  t: Translate,
): { actionsDisabled: boolean; actionsReason?: string } {
  if (!server.writable) {
    return {
      actionsDisabled: true,
      actionsReason: server.readOnly === undefined ? planeReason : t(MCP_READ_ONLY_REASON[server.readOnly]),
    }
  }
  return planeUnavailable && server.scope === 'global'
    ? { actionsDisabled: true, actionsReason: planeReason }
    : { actionsDisabled: busy }
}

/** Full component props. */
export type McpSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcpManager'>
  & InjectFace<McpSectionFace>

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = McpSectionProps['t']

/** MCP load view state. */
type McpView =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly servers: readonly McpServer[]
    /** Presets the same read declared, for the agent plane's filter labels. */
    readonly presets: readonly McpPresetOption[]
    /** Row keys the gate holds unmounted, so an enabled row reads as deferred. */
    readonly suppressed: ReadonlySet<string>
    /** Whether the global plane has a file-backed Include to write. */
    readonly globalWritable: boolean
    /** A refresh is in flight over an already rendered roster. */
    readonly refreshing: boolean
  }

/** Non-empty fiber-phase → localized status key. */
const PHASE_LABEL = {
  loading: 'mcp.status.loading',
  active: 'mcp.status.active',
  failed: 'mcp.status.failed',
  unloading: 'mcp.status.unloading',
} as const satisfies Record<Exclude<NonNullable<McpPhase>, 'pending' | 'held'>, McpSectionKey>

/** Non-empty fiber-phase → state-dot semantic. */
const PHASE_DOT = {
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'ongoing',
} as const satisfies Record<Exclude<NonNullable<McpPhase>, 'pending' | 'held'>, StateDotState>

/** MCP loading mode → localized option name. */
const MODE_LABEL = {
  eager: 'mcp.mode.eager',
  dynamic: 'mcp.mode.dynamic',
  lazy: 'mcp.mode.lazy',
} as const satisfies Record<McpLoadingOption, McpSectionKey>

/** MCP loading mode → localized one-line explanation. */
const MODE_DESC = {
  eager: 'mcp.mode.eager.desc',
  dynamic: 'mcp.mode.dynamic.desc',
  lazy: 'mcp.mode.lazy.desc',
} as const satisfies Record<McpLoadingOption, McpSectionKey>

/**
 * Resolve one MCP row's displayed status label and dot, or undefined when the
 * row has nothing to report.
 *
 * An allowed row that the loading mode keeps unmounted is NOT a state: under
 * `dynamic`/`lazy` that is simply what every allowed row looks like, so
 * reporting it would put a badge on the whole list and mean nothing. What the
 * list still has to show is the one condition that stops a row from starting —
 * an incomplete connection config — and the life-cycle phases a user can act on.
 */
function statusOf(server: McpServer, t: Translate): { label: string; dot: StateDotState } | undefined {
  // A configuration gap outranks enablement: a row the user enabled but that
  // cannot start is exactly the case this marker exists for.
  const configIssue = server.configIssue ?? []
  if (configIssue.length > 0) {
    return { label: t('mcp.status.unconfigured'), dot: 'warning' }
  }
  if (server.enabled === false) return { label: t('mcp.status.disabled'), dot: 'idle' }
  if (server.enabled === 'conditional') return { label: t('mcp.status.conditional'), dot: 'warning' }
  const phase = server.fiberPhase
  // No fiber, a pending fiber, and a fiber the preload gate held back all mean
  // "not running right now", which is an ordinary resting state rather than
  // something to annotate (D15: only a configuration gap earns a marker).
  if (phase === null || phase === 'pending' || phase === 'held') return undefined
  return { label: t(PHASE_LABEL[phase]), dot: PHASE_DOT[phase] }
}

/**
 * The MCP loading mode picker: one radio per mode, each carrying its own
 * one-line explanation so the trade-off (prompt cost and cache-prefix churn
 * against tool-binding quality) is readable without leaving the page.
 */
function McpLoadingPicker({ value, disabled, onPick, t }: {
  readonly value: string
  readonly disabled: boolean
  readonly onPick: (mode: McpLoadingOption) => void
  readonly t: Translate
}): ReactNode {
  return (
    <div className={css.modeBlock}>
      <span className={css.fieldLabel}>{t('mcp.mode.title')}</span>
      <div className={css.modeGroup} role="radiogroup" aria-label={t('mcp.mode.title')}>
        {MCP_LOADING_OPTIONS.map((mode) => {
          const selected = value === mode
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              data-mcp-mode={mode}
              className={selected ? `${css.modeOption} ${css.modeOptionActive}` : css.modeOption}
              disabled={disabled}
              title={disabled ? t('unavailable') : undefined}
              onClick={() => { onPick(mode) }}
            >
              <span className={css.modeName}>{t(MODE_LABEL[mode])}</span>
              <span className={css.modeDesc}>{t(MODE_DESC[mode])}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** One rendered MCP server row: name, plugin-owned description, scope, status, and row actions. */
function McpRow({ server, description, suppressed, pending, onEditDescription, onEdit, onToggleDisabled, actionsDisabled, actionsReason, t }: {
  readonly server: McpServer
  readonly description: string
  /**
   * The gate holds this row unmounted because the mode does not preload.
   *
   * A fallback only, and it never overrides the Host's own answer: a row the
   * user disabled reports `enabled: false`, which the switch must show as off
   * whatever this flag says. It stays for a page running an older bundle than
   * the Host it talks to, where a held row also reported `false` and this flag
   * was the only way to tell "the mode holds it" from "the user turned it off".
   */
  readonly suppressed: boolean
  readonly pending: 'enabling' | 'disabling' | null
  readonly onEditDescription: (value: string) => void
  readonly onEdit: () => void
  readonly onToggleDisabled: (enabled: boolean) => void
  readonly actionsDisabled: boolean
  /**
   * Why row actions are closed, when that reason is not the shared busy flag.
   * A global row's actions depend on the composition having one addressable
   * file to write, which the section states in the control's tooltip.
   */
  readonly actionsReason?: string
  readonly t: Translate
}): ReactNode {
  const scope = server.scope === 'global'
    ? t('mcp.scopeGlobal')
    : `${t('mcp.scopePreset')} · ${server.presetId ?? ''}`
  // A pending toggle shows the intended target and a transient label, so the
  // row reacts the instant it is clicked instead of waiting on the child MCP
  // process to start (or stop).
  const configIssue = server.configIssue ?? []
  const unconfigured = configIssue.length > 0
  const status = pending === 'enabling'
    ? { label: t('mcp.status.starting'), dot: 'warning' as StateDotState }
    : pending === 'disabling'
      ? { label: t('mcp.status.stopping'), dot: 'warning' as StateDotState }
      : statusOf(server, t)
  // The Host's own enablement answer wins over the gate's bookkeeping; the
  // suppression set only decides when the answer is not explicit at all.
  const allowed = rowAllowed(server.enabled, suppressed)
  const checked = pending === 'enabling' ? true : pending === 'disabling' ? false : allowed
  const disabledNow = !allowed
  // Switching a row on is what starts it, so an incomplete config closes that
  // direction; switching one off stays available, since a row already on must
  // remain removable.
  const cannotEnable = unconfigured && !checked && pending === null
  // The tooltip states what the control would do next, like its label does: a
  // row that is on is offered the switch back off. A closed row states why
  // instead, so the switch and the edit button explain the same refusal.
  const switchTitle = actionsReason !== undefined
    ? actionsReason
    : cannotEnable
      ? `${t('mcp.status.unconfigured')}: ${describeMcpConfigIssues(configIssue)}`
      : checked ? t('mcp.disable') : t('mcp.enable')
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? description
  return (
    <div className={css.mcpRow} data-mcp-scope={server.scope} data-mcp-name={server.serverName}>
      <div className={css.mcpMain}>
        <span className={css.mcpName}>{server.serverName}</span>
        <input
          className={css.mcpDesc}
          value={value}
          placeholder={t('mcp.descriptionPlaceholder')}
          aria-label={t('mcp.descriptionLabel')}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          onBlur={() => { onEditDescription(value); setDraft(null) }}
        />
      </div>
      <div className={css.mcpRight}>
        <span className={css.badge}>{scope}</span>
        {status === undefined ? null : <span className={css.status}>
          <StateDot state={status.dot} />
          {status.label}
        </span>}
        <span className={css.mcpActions}>
          <button
            type="button"
            className={css.mcpAction}
            disabled={actionsDisabled}
            title={actionsDisabled && actionsReason !== undefined ? actionsReason : undefined}
            onClick={onEdit}
          >
            {t('mcp.edit')}
          </button>
          {server.entryId !== null ? (
            <Switch
              checked={checked}
              onChange={onToggleDisabled}
              label={disabledNow ? t('mcp.enable') : t('mcp.disable')}
              disabled={actionsDisabled || pending !== null || cannotEnable}
              title={switchTitle}
            />
          ) : null}
        </span>
      </div>
    </div>
  )
}

/** The MCP management section body. */
export function McpSection(props: McpSectionProps): ReactNode {
  const {
    useMcpSettings, t, setMcpLoading, addMcp, addMcps, editMcp, disableMcp, describeMcp, listMcpTools,
    suppressedMcps, mcps, presets, updateMcpDescription, updateMcpTools, scanClaudeMcp,
  } = props
  const state = useMcpSettings(snapshot => snapshot)
  const [mcpView, setMcpView] = useState<McpView>({ status: 'loading' })
  const [mcpRequest, setMcpRequest] = useState(0)
  const [importerOpen, setImporterOpen] = useState(false)
  const [editor, setEditor] = useState<{ mode: McpEditorMode; server: McpServer | undefined; open: boolean }>({
    mode: 'add', server: undefined, open: false,
  })
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [mcpActionError, setMcpActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rowPending, setRowPending] = useState<Record<string, 'enabling' | 'disabling'>>({})
  // Which agent preset the agent rows are narrowed to; `MCP_ALL_PRESETS` shows
  // every preset, which is what a first visit needs.
  const [agentFilter, setAgentFilter] = useState<string>(MCP_ALL_PRESETS)
  /**
   * Where an authoring action writes.
   *
   * The list shows both planes at once, so the surface no longer implies a
   * target: a new row goes to the plane the user is working in. Narrowing the
   * list to one preset means the agent plane; opening a global row's editor
   * means that row's own plane.
   */
  const [writePlane, setWritePlane] = useState<McpPlane>('agent')
  const disabled = !state.available || !state.writable
  const servers = mcpView.status === 'ready' ? mcpView.servers : []
  const presetNames = mcpView.status === 'ready' ? mcpView.presets : []
  const globalServers = servers.filter(server => server.scope === 'global')
  const agentServers = narrowMcpRows(servers, MCP_ALL_PRESETS)
  // Every declared preset is offered, not only the ones owning rows: one that
  // owns none still needs to be selectable, because a new row is written into
  // it. The picker's options and its controlled value must come from this one
  // set, or a value the options offer would be rejected on the next render.
  const presetChoices = (() => {
    const merged = new Map<string, { id: string; name: string; count: number }>()
    for (const preset of presetNames) merged.set(preset.id, { id: preset.id, name: preset.name, count: 0 })
    for (const option of mcpAgentFilterOptions(servers, presetNames)) {
      merged.set(option.id, { id: option.id, name: option.name, count: option.count })
    }
    return [...merged.values()]
  })()
  // A filter value whose presets disappeared falls back to every preset rather
  // than leaving the list blank.
  const activePreset = presetChoices.some(option => option.id === agentFilter) ? agentFilter : MCP_ALL_PRESETS
  // The global plane is always listed, first and in full: selecting an agent
  // preset narrows the agent rows only.
  const presetServers = narrowMcpRows(servers, activePreset)
  // A global write edits the Include's own file, so a patched profile writes
  // fine; only a composition that mounts no single file-backed Include cannot
  // address one, and then the global row actions are closed.
  const globalUnavailable = mcpView.status === 'ready' && !mcpView.globalWritable
  const listUnavailable = writePlane === 'global' && globalUnavailable
  const unavailableReason = t('mcp.global.unavailable')
  // Writing an agent row needs one preset to address. The list may show every
  // preset at once, and then a new row has no home: the picker says so instead
  // of the dialog failing after the form is filled in.
  const needsPreset = writePlane === 'agent' && activePreset === MCP_ALL_PRESETS

  useEffect(() => {
    let current = true
    // A refresh keeps the rendered roster: the reads below answer from
    // declarations, so a mutation's follow-up refresh is quick, and replacing
    // the list with a loading line would only make the page flicker.
    setMcpView(previous => previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' })
    // The gate read is awaited FIRST: it resolves only after the Host has
    // finished applying the loading mode to the composed rows, so the roster
    // read behind it describes the settled state instead of a half-unmounted
    // composition. A gate read that fails must not hide the roster — the rows
    // then render with their composed state until the next refresh.
    void Promise.resolve()
      .then(suppressedMcps)
      .catch((error: unknown): readonly string[] => {
        console.error('[mcp-manager] MCP gate read failed', error)
        return []
      })
      .then(async (suppressed) => ({ suppressed, roster: await mcps() }))
      .then(
        ({ roster, suppressed }) => {
          if (!current) return
          setMcpView({
            status: 'ready',
            servers: roster.servers,
            presets: roster.presets,
            suppressed: new Set(suppressed),
            globalWritable: roster.globalWritable,
            refreshing: false,
          })
        },
        () => {
          // Keep a roster that is already on screen; only a first read reports
          // the failure as the page's own state.
          if (current) setMcpView(previous => previous.status === 'ready' ? { ...previous, refreshing: false } : { status: 'error' })
        },
      )
    return () => { current = false }
  }, [mcps, suppressedMcps, mcpRequest])

  /**
   * Persisting the mode changes which rows are mounted, so the roster is
   * re-read once the Host has applied it: the gate read resolves only after
   * every composed row reached its new state.
   */
  const pickMode = (mode: McpLoadingOption): void => {
    void Promise.resolve()
      .then(() => setMcpLoading(mode))
      .then(suppressedMcps)
      .catch((): readonly string[] => [])
      .then(() => { refreshMcps() })
  }

  const openAdd = (): void => {
    setEditor({ mode: 'add', server: undefined, open: true })
    setEditorError(null)
    setMcpActionError(null)
    setNotice(null)
  }

  const openEdit = (server: McpServer): void => {
    setEditor({ mode: 'edit', server, open: true })
    setEditorError(null)
    setMcpActionError(null)
    setNotice(null)
  }

  const openImport = (): void => {
    setImporterOpen(true)
    setMcpActionError(null)
    setNotice(null)
  }

  const closeEditor = (): void => {
    if (editorBusy) return
    setEditor(previous => ({ ...previous, open: false }))
    setEditorError(null)
  }

  const refreshMcps = (): void => {
    setMcpRequest(value => value + 1)
  }

  const submitEditor = async (request: McpEditorRequest): Promise<void> => {
    setEditorBusy(true)
    setEditorError(null)
    setMcpActionError(null)
    try {
      if (editor.mode === 'add') await addMcp(request as AddMcpRequest)
      else await editMcp(request as EditMcpRequest)
      setEditor({ mode: editor.mode, server: undefined, open: false })
      setNotice(editor.mode === 'add' ? t('mcp.notice.added') : t('mcp.notice.saved'))
      refreshMcps()
    } catch (cause) {
      setEditorError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setEditorBusy(false)
    }
  }

  /**
   * Flip one row's enablement without blocking the list. The row immediately
   * shows its target state and a transient starting/stopping label; the Host
   * call (which starts or stops the child MCP process) runs in the background
   * and the list refreshes with the real state when it settles.
   */
  const toggleDisabled = (server: McpServer, enabled: boolean): void => {
    const entryId = server.entryId
    if (entryId === null) {
      // A row with no Loader id renders no switch at all, so reaching this means
      // the roster moved under the click. Say so instead of returning silently.
      setRowPending(previous => ({ ...previous, [mcpRowKey(server)]: enabled ? 'enabling' : 'disabling' }))
      setMcpActionError(t('mcp.error.unaddressable'))
      return
    }
    const key = mcpRowKey(server)
    const target = server.scope === 'global'
      ? { scope: 'global' as const }
      : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
    setMcpActionError(null)
    setRowPending(previous => ({ ...previous, [key]: enabled ? 'enabling' : 'disabling' }))
    void (async () => {
      try {
        await disableMcp({ target, entryId, disabled: !enabled })
        setNotice(enabled ? t('mcp.notice.enabled') : t('mcp.notice.disabled'))
      } catch (cause) {
        setMcpActionError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setRowPending(previous => {
          const next = { ...previous }
          delete next[key]
          return next
        })
        refreshMcps()
      }
    })()
  }

  return (
    <div className={css.section}>
      <div className={css.panel}>
        {!state.available ? <p className={css.unavailable}>{t('unavailable')}</p> : null}
        <McpLoadingPicker
          value={state.loading}
          disabled={disabled}
          onPick={pickMode}
          t={t}
        />
        <div className={css.mcpToolbar}>
          <div className={css.mcpToolbarLead}>
            <p className={css.mcpSub}>{t('mcp.subtitle')}</p>
            {/* One list carries both planes, so the picker chooses which preset
                the agent rows come from — and doubles as the target of a new
                agent row, which is why every declared preset is offered. */}
            {presetChoices.length > 0 ? (
              <select
                className={css.mcpFilterSelect}
                value={activePreset}
                aria-label={t('mcp.filter.label')}
                onChange={(event) => {
                  setAgentFilter(event.currentTarget.value)
                  setWritePlane('agent')
                }}
              >
                <option value={MCP_ALL_PRESETS}>
                  {t('mcp.filter.all').replace('{n}', String(agentServers.length))}
                </option>
                {presetChoices.map(option => (
                  <option key={option.id} value={option.id}>
                    {t('mcp.filter.option').replace('{name}', option.name).replace('{n}', String(option.count))}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <span className={css.mcpActions}>
            <Button
              variant="outline"
              size="sm"
              onClick={openImport}
              disabled={disabled || editorBusy || listUnavailable || needsPreset}
              title={listUnavailable ? unavailableReason : needsPreset ? t('mcp.actionNeedsPreset') : undefined}
            >
              {t('mcp.import')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={openAdd}
              disabled={editorBusy || listUnavailable || needsPreset}
              title={listUnavailable ? unavailableReason : needsPreset ? t('mcp.actionNeedsPreset') : undefined}
            >
              {t('mcp.add')}
            </Button>
          </span>
        </div>
        {mcpView.status === 'loading' ? <p className={css.mcpStatus}>{t('mcp.loading')}</p> : null}
        {mcpView.status === 'ready' && mcpView.refreshing ? (
          <p className={css.mcpStatus} role="status">{t('mcp.loading')}</p>
        ) : null}
        {mcpView.status === 'error' ? (
          <div className={css.mcpFailure}>
            <p role="alert">{t('mcp.error')}</p>
            <button type="button" className={css.mcpRetry} onClick={() => { setMcpRequest(value => value + 1) }}>
              {t('mcp.retry')}
            </button>
          </div>
        ) : null}
        {mcpView.status === 'ready' ? (
          <div className={css.mcpList}>
            {/* The global plane is listed first and never filtered away: a
                session carries its rows whatever agent preset it runs. */}
            <p className={css.mcpGroup}>
              <span>{t('mcp.group.global').replace('{n}', String(globalServers.length))}</span>
              {/* Both planes follow the loading mode now, so the one rule that
                  still differs between them is stated where their rows split. */}
              <span className={css.mcpGroupHint}>{t('mcp.plane.global.eager')}</span>
            </p>
            {globalServers.length === 0 ? <p className={css.empty}>{t('mcp.empty.global')}</p> : null}
            {globalServers.map((server) => {
              const key = mcpRowKey(server)
              return (
                <McpRow
                  key={key}
                  server={server}
                  description={server.description ?? state.descriptions[key] ?? ''}
                  suppressed={mcpView.suppressed.has(key)}
                  pending={rowPending[key] ?? null}
                  onEditDescription={(value) => { updateMcpDescription(key, value) }}
                  onEdit={() => { setWritePlane('global'); openEdit(server) }}
                  onToggleDisabled={(enabled) => { toggleDisabled(server, enabled) }}
                  {...rowActionState(server, editorBusy, globalUnavailable, unavailableReason, t)}
                  t={t}
                />
              )
            })}
            <p className={css.mcpGroup}>
              {activePreset === MCP_ALL_PRESETS
                ? t('mcp.group.agentAll').replace('{n}', String(presetServers.length))
                : t('mcp.group.agent').replace('{name}', activePreset).replace('{n}', String(presetServers.length))}
            </p>
            {presetServers.length === 0 ? <p className={css.empty}>{t('mcp.empty.agent')}</p> : null}
            {presetServers.map((server) => {
              const key = mcpRowKey(server)
              return (
                <McpRow
                  key={key}
                  server={server}
                  description={server.description ?? state.descriptions[key] ?? ''}
                  suppressed={mcpView.suppressed.has(key)}
                  pending={rowPending[key] ?? null}
                  onEditDescription={(value) => { updateMcpDescription(key, value) }}
                  onEdit={() => { setWritePlane('agent'); openEdit(server) }}
                  onToggleDisabled={(enabled) => { toggleDisabled(server, enabled) }}
                  {...rowActionState(server, editorBusy, globalUnavailable, unavailableReason, t)}
                  t={t}
                />
              )
            })}
          </div>
        ) : null}
        {mcpActionError !== null ? <p className={css.mcpActionError} role="alert">{mcpActionError}</p> : null}
        {notice !== null ? <p className={css.mcpNotice} role="status">{notice}</p> : null}
        <McpEditor
          open={editor.open}
          mode={editor.mode}
          server={editor.server}
          disabled={false}
          busy={editorBusy}
          error={editorError}
          describeMcp={describeMcp}
          listMcpTools={listMcpTools}
          presets={presets}
          plane={writePlane}
          {...activePreset === MCP_ALL_PRESETS ? {} : { preset: activePreset }}
          descriptionInitial={editor.server === undefined
            ? ''
            : (editor.server.description ?? state.descriptions[mcpRowKey(editor.server)] ?? '')}
          onUpdateDescription={updateMcpDescription}
          toolRulesInitial={editor.server === undefined ? [] : toolRuleEntries(state.tools[mcpRowKey(editor.server)])}
          onUpdateTools={updateMcpTools}
          t={t}
          onClose={closeEditor}
          onSubmit={(request) => { void submitEditor(request) }}
        />
        <ClaudeImportDialog
          open={importerOpen}
          // The batch reports its own progress and the mask blocks this section
          // while it runs, so it must not toggle the shared busy flag per entry:
          // each toggle re-rendered this section, and the page behind the modal is
          // what the mask's backdrop filter has to re-compose.
          busy={false}
          error={editorError}
          scanClaudeMcp={scanClaudeMcp}
          addMcps={addMcps}
          servers={servers}
          presets={presets}
          plane={writePlane}
          {...activePreset === MCP_ALL_PRESETS ? {} : { preset: activePreset }}
          t={t}
          onClose={() => { setImporterOpen(false) }}
          onImported={() => {
            setNotice(t('mcp.notice.added'))
            refreshMcps()
          }}
        />
      </div>
    </div>
  )
}
