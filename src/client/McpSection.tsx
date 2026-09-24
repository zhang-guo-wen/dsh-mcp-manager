/**
 * MCP management settings section: the server roster with its loading mode.
 *
 * The roster is split by the plane a row lives in — the global plane or an agent
 * preset — because the two differ in kind: preset rows take part in on-demand
 * loading, while global rows are always mounted and ignore the loading mode and
 * the tool filters. Each plane gets its own tab, with that difference stated.
 * Both planes are surfaced without deduplication.
 * @module @guowenzhang/dsh-mcp-manager/client/McpSection
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs, StateDot, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AddMcpRequest, EditMcpRequest } from '../types.ts'
import { toolRuleEntries } from '../mcp-tool-filter.ts'
import { McpEditor, type McpEditorMode, type McpEditorRequest } from './McpEditor.tsx'
import { ClaudeImportDialog } from './ClaudeImportDialog.tsx'
import {
  MCP_LOADING_OPTIONS,
  mcpRowKey,
  type McpLoadingOption,
  type McpPhase,
  type McpRosterView,
  type McpSectionFace,
  type McpServer,
} from './settings-controller.ts'
import type { McpSectionKey } from './locales.ts'
import css from './McpSection.module.css'

/** Full component props. */
export type McpSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcpManager'>
  & InjectFace<McpSectionFace>

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = McpSectionProps['t']

/** Which composition plane the roster tab shows. */
type McpPlaneTab = 'global' | 'agent'

/** MCP load view state. */
type McpView =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
    readonly status: 'ready'
    readonly servers: readonly McpServer[]
    /** Row keys the gate holds unmounted, so an enabled row reads as deferred. */
    readonly suppressed: ReadonlySet<string>
    /** Why the global plane refuses writes, when it does. */
    readonly globalProblem?: McpRosterView['globalProblem']
    /** A refresh is in flight over an already rendered roster. */
    readonly refreshing: boolean
  }

/** Non-empty fiber-phase → localized status key. */
const PHASE_LABEL = {
  pending: 'mcp.status.pending',
  loading: 'mcp.status.loading',
  active: 'mcp.status.active',
  failed: 'mcp.status.failed',
  unloading: 'mcp.status.unloading',
} as const satisfies Record<NonNullable<McpPhase>, McpSectionKey>

/** Non-empty fiber-phase → state-dot semantic. */
const PHASE_DOT = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'ongoing',
} as const satisfies Record<NonNullable<McpPhase>, StateDotState>

/** MCP loading mode → localized option name. */
const MODE_LABEL = {
  eager: 'mcp.mode.eager',
  dynamic: 'mcp.mode.dynamic',
  lazy: 'mcp.mode.lazy',
} as const satisfies Record<McpLoadingOption, McpSectionKey>

/** Why the global plane refuses writes → localized explanation. */
const GLOBAL_PROBLEM_KEY = {
  'patched-include': 'mcp.global.readOnly.patched-include',
  'no-include': 'mcp.global.readOnly.no-include',
  'not-writable': 'mcp.global.readOnly.not-writable',
} as const satisfies Record<NonNullable<McpRosterView['globalProblem']>, McpSectionKey>

/** MCP loading mode → localized one-line explanation. */
const MODE_DESC = {
  eager: 'mcp.mode.eager.desc',
  dynamic: 'mcp.mode.dynamic.desc',
  lazy: 'mcp.mode.lazy.desc',
} as const satisfies Record<McpLoadingOption, McpSectionKey>

/** Resolve one MCP row's displayed status label and dot. */
function statusOf(server: McpServer, suppressed: boolean, t: Translate): { label: string; dot: StateDotState } {
  // A row the gate holds unmounted is still one the user enabled: the loading
  // mode, not the user, keeps it out of the request.
  if (server.enabled === false) {
    return suppressed
      ? { label: t('mcp.status.deferred'), dot: 'idle' }
      : { label: t('mcp.status.disabled'), dot: 'idle' }
  }
  if (server.enabled === 'conditional') return { label: t('mcp.status.conditional'), dot: 'warning' }
  if (server.fiberPhase === null) return { label: t('mcp.status.configured'), dot: 'idle' }
  return { label: t(PHASE_LABEL[server.fiberPhase]), dot: PHASE_DOT[server.fiberPhase] }
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
function McpRow({ server, description, suppressed, pending, onEditDescription, onEdit, onToggleDisabled, actionsDisabled, t }: {
  readonly server: McpServer
  readonly description: string
  /** The gate holds this allowed row unmounted because the mode does not preload. */
  readonly suppressed: boolean
  readonly pending: 'enabling' | 'disabling' | null
  readonly onEditDescription: (value: string) => void
  readonly onEdit: () => void
  readonly onToggleDisabled: (enabled: boolean) => void
  readonly actionsDisabled: boolean
  readonly t: Translate
}): ReactNode {
  const scope = server.scope === 'global'
    ? t('mcp.scopeGlobal')
    : `${t('mcp.scopePreset')} · ${server.presetId ?? ''}`
  // A pending toggle shows the intended target and a transient label, so the
  // row reacts the instant it is clicked instead of waiting on the child MCP
  // process to start (or stop).
  const status = pending === 'enabling'
    ? { label: t('mcp.status.starting'), dot: 'warning' as StateDotState }
    : pending === 'disabling'
      ? { label: t('mcp.status.stopping'), dot: 'warning' as StateDotState }
      : statusOf(server, suppressed, t)
  const checked = pending === 'enabling'
    ? true
    : pending === 'disabling' ? false : server.enabled !== false || suppressed
  const disabledNow = server.enabled === false && !suppressed
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
        <span className={css.status}>
          <StateDot state={status.dot} />
          {status.label}
        </span>
        <span className={css.mcpActions}>
          <button
            type="button"
            className={css.mcpAction}
            disabled={actionsDisabled}
            onClick={onEdit}
          >
            {t('mcp.edit')}
          </button>
          {server.entryId !== null ? (
            <Switch
              checked={checked}
              onChange={onToggleDisabled}
              label={disabledNow ? t('mcp.enable') : t('mcp.disable')}
              disabled={actionsDisabled || pending !== null}
              title={t('mcp.status.disabled')}
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
    useMcpSettings, t, setMcpLoading, addMcp, editMcp, disableMcp, describeMcp, listMcpTools,
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
  // The agent plane is where a row can be authored and lazy-loaded, so it opens
  // first; a deployment that configured only global rows sees their count on the
  // other tab.
  const [plane, setPlane] = useState<McpPlaneTab>('agent')
  const planeTabId = useId()
  const disabled = !state.available || !state.writable
  /** Localized reason the global plane refuses writes, while it does. */
  const globalProblemReason = mcpView.status === 'ready' && mcpView.globalProblem !== undefined
    ? t(GLOBAL_PROBLEM_KEY[mcpView.globalProblem])
    : undefined
  const servers = mcpView.status === 'ready' ? mcpView.servers : []
  const globalServers = servers.filter(server => server.scope === 'global')
  const agentServers = servers.filter(server => server.scope === 'preset')
  const planeServers = plane === 'global' ? globalServers : agentServers

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
            suppressed: new Set(suppressed),
            ...roster.globalProblem === undefined ? {} : { globalProblem: roster.globalProblem },
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
    if (server.entryId === null) return
    const key = mcpRowKey(server)
    const target = server.scope === 'global'
      ? { scope: 'global' as const }
      : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
    setMcpActionError(null)
    setRowPending(previous => ({ ...previous, [key]: enabled ? 'enabling' : 'disabling' }))
    void (async () => {
      try {
        await disableMcp({ target, entryId: server.entryId as string, disabled: !enabled })
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
        <SegmentedTabs<McpPlaneTab>
          label={t('mcp.plane.label')}
          value={plane}
          onChange={setPlane}
          items={[
            {
              value: 'global',
              label: t('mcp.plane.tab').replace('{label}', t('mcp.plane.global')).replace('{n}', String(globalServers.length)),
              id: `${planeTabId}-global-tab`,
              panelId: `${planeTabId}-global-panel`,
            },
            {
              value: 'agent',
              label: t('mcp.plane.tab').replace('{label}', t('mcp.plane.agent')).replace('{n}', String(agentServers.length)),
              id: `${planeTabId}-agent-tab`,
              panelId: `${planeTabId}-agent-panel`,
            },
          ]}
        />
        <div
          id={`${planeTabId}-global-panel`}
          role="tabpanel"
          aria-labelledby={`${planeTabId}-global-tab`}
          className={css.planePanel}
          hidden={plane !== 'global'}
        >
          {/* A global row is mounted by the composition itself, so nothing here
              decides when it enters context. */}
          <p className={css.fieldHint}>{t('mcp.plane.global.eager')}</p>
          {globalProblemReason !== undefined ? <p className={css.fieldHint}>{globalProblemReason}</p> : null}
        </div>
        <div
          id={`${planeTabId}-agent-panel`}
          role="tabpanel"
          aria-labelledby={`${planeTabId}-agent-tab`}
          className={css.planePanel}
          hidden={plane !== 'agent'}
        >
          <McpLoadingPicker
            value={state.loading}
            disabled={disabled}
            onPick={pickMode}
            t={t}
          />
        </div>
        <div className={css.mcpToolbar}>
          <p className={css.mcpSub}>{t('mcp.subtitle')}</p>
          <span className={css.mcpActions}>
            <Button variant="outline" size="sm" onClick={openImport} disabled={disabled || editorBusy}>
              {t('mcp.import')}
            </Button>
            <Button variant="outline" size="sm" onClick={openAdd} disabled={editorBusy}>
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
        {mcpView.status === 'ready' && planeServers.length === 0 ? (
          <p className={css.empty}>{plane === 'global' ? t('mcp.empty.global') : t('mcp.empty.agent')}</p>
        ) : null}
        {mcpView.status === 'ready' && planeServers.length > 0 ? (
          <div className={css.mcpList}>
            {planeServers.map((server) => {
              const key = mcpRowKey(server)
              return (
                <McpRow
                  key={key}
                  server={server}
                  description={server.description ?? state.descriptions[key] ?? ''}
                  suppressed={mcpView.suppressed.has(key)}
                  pending={rowPending[key] ?? null}
                  onEditDescription={(value) => { updateMcpDescription(key, value) }}
                  onEdit={() => { openEdit(server) }}
                  onToggleDisabled={(enabled) => { toggleDisabled(server, enabled) }}
                  actionsDisabled={editorBusy}
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
          {...globalProblemReason === undefined ? {} : { globalProblemReason }}
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
          busy={editorBusy}
          error={editorError}
          scanClaudeMcp={scanClaudeMcp}
          addMcp={async (request) => {
            setEditorBusy(true)
            try {
              return await addMcp(request)
            } finally {
              setEditorBusy(false)
            }
          }}
          servers={servers}
          presets={presets}
          globalWritable={mcpView.status === 'ready' && mcpView.globalProblem === undefined}
          {...globalProblemReason === undefined ? {} : { globalProblem: globalProblemReason }}
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
