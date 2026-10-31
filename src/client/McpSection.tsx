/**
 * MCP management settings section: one settings page carrying both faces of the
 * plugin, the server roster and the context-budget policy.
 *
 * One list carries both planes, and no control chooses between them. The agent
 * picker narrows the list to one preset's rows plus every global row, and the
 * global rows keep their own "Global" tag: a session carries its global rows
 * whatever preset it runs, so a view that named a preset and then dropped them
 * would misstate what that session mounts. Which plane a *new* row goes to is
 * the creating dialog's own choice — the section cannot infer it: deriving the
 * target from the row the user last edited left the global plane unreachable in
 * a composition with no global row yet.
 *
 * A row is edited by clicking the card itself, which opens the pane the row
 * needs: credentials for a row that carries them, its configuration otherwise.
 *
 * The two faces are in-page tabs rather than two `settings.section`
 * registrations: the shell's nav is a flat, order-sorted list, so a second
 * registration reads as a second plugin.
 * @module @guowenzhang/dsh-mcp-manager/client/McpSection
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Menu, SegmentedControl, SegmentedTabs, StateDot, Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AddMcpRequest, DescribeMcpRequest, DescribeMcpResult, EditMcpRequest, McpRowReadOnly } from '../types.ts'
import { MAX_DESCRIPTION_CHARS } from '../mcp-inventory.ts'
import { toolRuleEntries } from '../mcp-tool-filter.ts'
import { formatMcpConfigIssues } from './config-issues.ts'
import { McpEditor, type McpEditorMode, type McpEditorRequest, type McpEditorTab } from './McpEditor.tsx'
import { McpOptimizeSection, saveFailureMessage } from './McpOptimizeSection.tsx'
import {
  MCP_LOADING_OPTIONS,
  mcpRowKey,
  type McpGlobalEnableOutcome,
  type McpLoadingOption,
  type McpPhase,
  type McpPlane,
  type McpPresetOption,
  type McpSectionFace,
  type McpServer,
} from './settings-controller.ts'
import { MCP_ALL_PRESETS, mcpAgentFilterOptions, narrowMcpRows } from './agent-filter.ts'
import { rowAllowed } from './mcp-row-state.ts'
import { MCP_READ_ONLY_REASON, type McpSectionKey } from './locales.ts'
import css from './McpSection.module.css'

/** The page's own sections: the roster, and the settings that govern it. */
type McpTab = 'servers' | 'settings'

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
    /** Why the global plane is closed, when it is. */
    readonly globalReason?: McpRowReadOnly
    /** A refresh is in flight over an already rendered roster. */
    readonly refreshing: boolean
  }

/** One row's in-flight or failed enablement change. */
type RowAction =
  | { readonly phase: 'enabling' | 'disabling' }
  | { readonly phase: 'failed'; readonly message: string; readonly target: boolean }

/** The loading-mode write, as the picker reports it. */
type ModeSave =
  | { readonly phase: 'idle' | 'saving' }
  | { readonly phase: 'failed'; readonly mode: McpLoadingOption }

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

/** One thrown value as the line a reader can act on. */
function failureText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * The stored loading mode, narrowed to a value the picker offers. The Host
 * narrows unknown stored values itself; this keeps the control's own value
 * inside its option set.
 * @param value - the mode the settings snapshot carries.
 * @returns an offered mode, defaulting the way the Host does.
 */
function loadingMode(value: string): McpLoadingOption {
  return value === 'eager' || value === 'lazy' ? value : 'dynamic'
}

/**
 * Resolve one MCP row's displayed status label and dot, or undefined when the
 * row has nothing to report.
 *
 * An allowed row that the loading mode keeps unmounted is NOT a state: under
 * `dynamic`/`lazy` that is simply what every allowed row looks like, so
 * reporting it would put a badge on the whole list and mean nothing. What the
 * list still has to show is the one condition that stops a row from starting —
 * an incomplete connection config — and the life-cycle phases a user can act on.
 *
 * A row that renders a switch states its own on/off position, so a row the user
 * turned off needs no second label saying so; one the Host reports as off with
 * no switch to show it (a read-only row, or a row whose entry has no Loader id)
 * still does.
 * @param server - the rendered row.
 * @param hasSwitch - whether this row renders its own switch.
 * @param t - the section's translator.
 * @returns the label and dot to show, or undefined for a resting row.
 */
function statusOf(server: McpServer, hasSwitch: boolean, t: Translate): { label: string; dot: StateDotState } | undefined {
  // A configuration gap outranks enablement: a row the user enabled but that
  // cannot start is exactly the case this marker exists for.
  const configIssue = server.configIssue ?? []
  if (configIssue.length > 0) {
    return { label: t('mcp.status.unconfigured'), dot: 'warning' }
  }
  if (server.enabled === false) {
    return hasSwitch ? undefined : { label: t('mcp.status.disabled'), dot: 'idle' }
  }
  if (server.enabled === 'conditional') return { label: t('mcp.status.conditional'), dot: 'warning' }
  const phase = server.fiberPhase
  // No fiber, a pending fiber, and a fiber the preload gate held back all mean
  // "not running right now", which is an ordinary resting state rather than
  // something to annotate (D15: only a configuration gap earns a marker).
  if (phase === null || phase === 'pending' || phase === 'held') return undefined
  return { label: t(PHASE_LABEL[phase]), dot: PHASE_DOT[phase] }
}

/**
 * The MCP loading mode picker: the shared segmented control for the three-way
 * choice, with the selected mode's one-line explanation underneath, so the
 * trade-off (prompt cost and cache-prefix churn against tool-binding quality) is
 * readable without leaving the page. The write reports its own saving and failed
 * states next to the control.
 */
function McpLoadingPicker({ value, disabled, status, onPick, onRetry, t }: {
  readonly value: string
  readonly disabled: boolean
  readonly status: ModeSave
  readonly onPick: (mode: McpLoadingOption) => void
  readonly onRetry: (mode: McpLoadingOption) => void
  readonly t: Translate
}): ReactNode {
  const pickerId = useId()
  const current = loadingMode(value)
  const options = MCP_LOADING_OPTIONS.map(mode => ({
    value: mode,
    label: t(MODE_LABEL[mode]),
    ...(disabled ? { disabled: true, title: t('unavailable') } : {}),
  }))
  return (
    <div className={css.modeBlock}>
      <SegmentedControl<McpLoadingOption>
        id={pickerId}
        value={current}
        options={options}
        onChange={onPick}
        label={t('mcp.mode.title')}
        disabled={disabled}
      />
      {/* One panel per mode, all mounted and hidden when unselected: the
          control names each with `aria-controls`, so every referenced panel has
          to exist in the document. */}
      {MCP_LOADING_OPTIONS.map(mode => (
        <div
          key={mode}
          id={`${pickerId}-${mode}-panel`}
          role="tabpanel"
          aria-labelledby={`${pickerId}-${mode}`}
          hidden={mode !== current}
        >
          <p className={css.modeDesc}>{t(MODE_DESC[mode])}</p>
        </div>
      ))}
      {status.phase === 'saving' ? (
        <p className={css.modeStatus} role="status">{t('mcp.mode.saving')}</p>
      ) : null}
      {status.phase === 'failed' ? (
        <div className={css.mcpFailure}>
          <p role="alert">{t('mcp.mode.saveFailed')}</p>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => { onRetry(status.mode) }}>
            {t('mcp.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One row's authoring description.
 *
 * The description is the only user-written text that reaches the model (it is
 * the roster line in the system prompt), so it reads as content rather than as
 * an empty field: a borderless text at rest, a real input only while it is being
 * edited. Only an over-budget description warns, because the model sees the
 * first {@link MAX_DESCRIPTION_CHARS} characters of it and nothing says so
 * anywhere else.
 * @param props.value - the committed description.
 * @param props.disabled - whether the row's actions are closed.
 * @param props.onCommit - persist the edited text; rejects with the save reason.
 * @param props.t - the section's translator.
 * @returns the description control.
 */
function McpDescription({ value, disabled, onCommit, t }: {
  readonly value: string
  readonly disabled: boolean
  readonly onCommit: (next: string) => Promise<void>
  readonly t: Translate
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  // One async save runs per commit, and the row says where it stands: saving,
  // saved, or failed with the reason. A failed write keeps the draft in the
  // box — the user retries by committing again — instead of reverting to the
  // last committed text as if the edit never happened.
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const composing = useRef(false)
  const savedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
  }, [])
  const commit = async (next: string): Promise<void> => {
    if (next === value) {
      setDraft(null)
      return
    }
    setSave('saving')
    setFailure(null)
    try {
      await onCommit(next)
      setDraft(null)
      setSave('saved')
      if (savedTimer.current !== undefined) clearTimeout(savedTimer.current)
      savedTimer.current = window.setTimeout(() => {
        savedTimer.current = undefined
        setSave(previous => (previous === 'saved' ? 'idle' : previous))
      }, 2_500)
    } catch (cause) {
      setSave('failed')
      setFailure(saveFailureMessage(cause, t))
    }
  }
  if (draft === null) {
    return (
      <>
        <button
          type="button"
          className={css.descText}
          data-empty={value === ''}
          disabled={disabled}
          title={value === '' ? t('mcp.descriptionPlaceholder') : value}
          // The description is edited in place, so its click must not also reach
          // the row and open the row editor behind it.
          onClick={(event) => {
            event.stopPropagation()
            setDraft(value)
            setSave('idle')
            setFailure(null)
          }}
        >
          {value === '' ? t('mcp.description.add') : value}
        </button>
        {save === 'saved' ? (
          <span className={css.descState} role="status">{t('opt.state.saved')}</span>
        ) : null}
      </>
    )
  }
  return (
    <>
      <input
        className={css.mcpDesc}
        value={draft}
        autoFocus
        placeholder={t('mcp.descriptionPlaceholder')}
        aria-label={t('mcp.descriptionLabel')}
        aria-invalid={draft.length > MAX_DESCRIPTION_CHARS}
        onChange={(event) => { setDraft(event.currentTarget.value) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onBlur={() => {
          // A blur that arrives mid-composition (an IME candidate window
          // closing) must not commit half-conformed text.
          if (composing.current) return
          void commit(draft)
        }}
        onKeyDown={(event) => {
          // Enter confirms an IME candidate as often as it submits; only a
          // real Enter may leave the field (keyCode 229 is composition too).
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.currentTarget.blur()
          }
          if (event.key === 'Escape') {
            // Only the draft is cancelled here. Left to bubble, the settings
            // shell treats the same Escape as "close this dialog" and takes the
            // whole page away from the user mid-edit.
            event.stopPropagation()
            setDraft(null)
            setSave('idle')
            setFailure(null)
          }
        }}
      />
      {draft.length > MAX_DESCRIPTION_CHARS ? (
        <span className={css.descOver} role="status">
          {t('mcp.description.budget').replace('{n}', String(MAX_DESCRIPTION_CHARS))}
        </span>
      ) : null}
      {save === 'saving' ? (
        <span className={css.descState} role="status">{t('opt.state.saving')}</span>
      ) : null}
      {save === 'failed' ? (
        <span className={css.descState} data-state="failed" role="alert">
          {failure ?? t('opt.state.failed')}
        </span>
      ) : null}
    </>
  )
}

/** One rendered MCP server row: name, plugin-owned description, scope, status, and row actions. */
function McpRow({ server, presetLabel, description, suppressed, action, onEditDescription, onEdit, onToggleDisabled, onRetry, actionsDisabled, actionsReason, t }: {
  readonly server: McpServer
  readonly presetLabel: string
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
  /** This row's in-flight enablement change, or the failure it ended in. */
  readonly action: RowAction | null
  readonly onEditDescription: (value: string) => Promise<void>
  /** Open this row's editor on one of its panes. */
  readonly onEdit: (tab: McpEditorTab) => void
  readonly onToggleDisabled: (enabled: boolean) => void
  /** Retry the enablement change this row last failed at. */
  readonly onRetry: (enabled: boolean) => void
  readonly actionsDisabled: boolean
  /**
   * Why row actions are closed, when that reason is not the shared busy flag.
   * A global row's actions depend on the composition having one addressable
   * file to write, which the section states in the control's tooltip.
   */
  readonly actionsReason?: string
  readonly t: Translate
}): ReactNode {
  // A pending toggle shows the intended target and a transient label, so the
  // row reacts the instant it is clicked instead of waiting on the child MCP
  // process to start (or stop).
  const configIssue = server.configIssue ?? []
  const unconfigured = configIssue.length > 0
  const pending = action !== null && action.phase !== 'failed' ? action.phase : null
  const failure = action !== null && action.phase === 'failed' ? action : null
  const hasSwitch = server.entryId !== null
  const status = pending === 'enabling'
    ? { label: t('mcp.status.starting'), dot: 'warning' as StateDotState }
    : pending === 'disabling'
      ? { label: t('mcp.status.stopping'), dot: 'warning' as StateDotState }
      : statusOf(server, hasSwitch, t)
  // The Host's own enablement answer wins over the gate's bookkeeping; the
  // suppression set only decides when the answer is not explicit at all.
  const allowed = rowAllowed(server.enabled, suppressed)
  const checked = pending === 'enabling' ? true : pending === 'disabling' ? false : allowed
  const disabledNow = !allowed
  // Switching a row on is what starts it, so an incomplete config closes that
  // direction; switching one off stays available, since a row already on must
  // remain removable.
  const cannotEnable = unconfigured && !checked && pending === null
  // A row with credentials opens on the pane that edits them; everything else
  // opens on the configuration it has, which is where a row without credentials
  // has anything to change at all.
  const editorTab: McpEditorTab = server.secretKeys.length > 0 ? 'credentials' : 'config'
  /** The plane marker's text: the global plane's own name, or the preset's id. */
  const planeLabel = server.scope === 'global' ? t('mcp.scopeGlobal') : presetLabel
  const openEditor = (): void => { onEdit(editorTab) }
  // The card itself is the edit affordance. A closed row has nothing to open,
  // so it is not given the pointer, and the controls inside keep working on
  // their own without the row opening behind them.
  const clickable = !actionsDisabled
  // A click or key press that started on one of the row's own controls belongs
  // to that control; the card must not open the editor behind it as well.
  const fromRowControl = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && target.closest('button, input, select, textarea, a, label') !== null
  const clickProps = clickable
    ? {
      onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
        if (fromRowControl(event.target)) return
        openEditor()
      },
      // The card is a Tab stop of its own, so the keyboard reaches the row the
      // way the pointer does; Enter and Space open it. Space is claimed only
      // here, so the page still scrolls while focus is anywhere else.
      tabIndex: 0,
      onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (fromRowControl(event.target)) return
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        openEditor()
      },
      title: actionsReason === undefined ? t('mcp.row.editHint') : undefined,
    }
    : {}
  // The tooltip states what the control would do next, like its label does: a
  // row that is on is offered the switch back off. A closed row states why
  // instead, so the switch and the card's own hint explain the same refusal. An
  // unconfigured row names its issues through this section's own dictionary —
  // the Host's English sentence is the fallback, not the user-facing text.
  const switchTitle = actionsReason !== undefined
    ? actionsReason
    : cannotEnable
      ? `${t('mcp.status.unconfigured')}: ${formatMcpConfigIssues(configIssue, t)}`
      : checked ? t('mcp.disable') : t('mcp.enable')
  return (
    <div
      className={css.mcpRow}
      data-mcp-scope={server.scope}
      data-mcp-name={server.serverName}
      data-clickable={clickable ? 'true' : undefined}
      {...clickProps}
    >
      <div className={css.mcpMain}>
        <span className={css.mcpName}>{server.serverName}</span>
        <McpDescription value={description} disabled={actionsDisabled} onCommit={onEditDescription} t={t} />
        {/* The failed action stays in its row with a retry, so the roster and
            the last good state remain on screen while the user decides. */}
        {failure === null ? null : (
          <div className={css.rowFailure}>
            <p role="alert">{`${t('mcp.row.toggleFailed')} ${failure.message}`}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={actionsDisabled}
              onClick={() => { onRetry(failure.target) }}
            >
              {t('mcp.retry')}
            </Button>
          </div>
        )}
      </div>
      <div className={css.mcpRight}>
        {/* The status is the one element that comes and goes, so it goes first:
            behind it the plane marker and the switch keep the same column in
            every row that renders them. */}
        {status === undefined ? null : <span className={css.status}>
          <StateDot state={status.dot} />
          {status.label}
        </span>}
        {/* Which plane the row lives in, as the chip both planes share: a global
            row is named because the list also carries the rows of the preset the
            filter selected, and a preset row is named because the list is already
            narrowed to it. */}
        {planeLabel === '' ? null : <span className={css.rowScope}>{planeLabel}</span>}
        {hasSwitch ? (
          <Switch
            checked={checked}
            onChange={onToggleDisabled}
            label={disabledNow ? t('mcp.enable') : t('mcp.disable')}
            disabled={actionsDisabled || pending !== null || cannotEnable}
            title={switchTitle}
          />
        ) : null}
      </div>
    </div>
  )
}

/**
 * First-paint placeholder shaped like the roster cards it replaces, so the
 * section does not reflow when the read answers.
 */
function McpRosterSkeleton({ label }: { readonly label: string }): ReactNode {
  return (
    <>
      <p className={css.visuallyHidden} role="status">{label}</p>
      <div className={css.skeletonList} aria-hidden="true">
        {[0, 1, 2].map(index => (
          <div key={index} className={css.skeletonRow}>
            <span className={css.skeletonBar} />
            <span className={css.skeletonBar} />
          </div>
        ))}
      </div>
    </>
  )
}

/** MCP management with fixed page chrome and an independently scrolling roster. */
export function McpSection(props: McpSectionProps): ReactNode {
  const {
    useMcpSettings, t, setMcpLoading, addMcp, editMcp, disableMcp, describeMcp, listMcpTools,
    suppressedMcps, mcps, presets, presetName, updateMcpDescription, updateMcpTools, enableGlobalPlane,
  } = props
  const state = useMcpSettings(snapshot => snapshot)
  const [tab, setTab] = useState<McpTab>('servers')
  const tabsId = useId()
  const [mcpView, setMcpView] = useState<McpView>({ status: 'loading' })
  const [mcpRequest, setMcpRequest] = useState(0)
  const [editor, setEditor] = useState<{ mode: McpEditorMode; server: McpServer | undefined; open: boolean }>({
    mode: 'add', server: undefined, open: false,
  })
  /**
   * The pane the editor opens on. Held beside {@link editor} so opening the same
   * row's credentials twice re-states the request instead of leaving the dialog
   * on whatever pane the user left it.
   */
  const [openedTab, setOpenedTab] = useState<McpEditorTab>('config')
  /** The plane a dialog opened from the section starts on; the dialog owns it from there. */
  const [openedPlane, setOpenedPlane] = useState<McpPlane>('agent')
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  /**
   * The settled outcome of the last row edit, toggle or mode change, reported in
   * the host's floating banner: the roster can be long, so a line under it
   * scrolls out of view exactly when the reader wants the answer. `seq` restarts
   * the hold when the same outcome is reported again. A failure keeps its own
   * longer hold and names what the Host refused.
   */
  const [notice, setNotice] = useState<{ text: string; seq: number } | null>(null)
  const noticeSeq = useRef(0)
  const reportNotice = (text: string): void => {
    noticeSeq.current += 1
    setNotice({ text, seq: noticeSeq.current })
    setMcpActionError(null)
  }
  const reportRefusal = (text: string): void => {
    noticeSeq.current += 1
    setNotice(null)
    setMcpActionError({ text, seq: noticeSeq.current })
  }
  const [rowAction, setRowAction] = useState<Record<string, RowAction>>({})
  const [modeSave, setModeSave] = useState<ModeSave>({ phase: 'idle' })
  /** A global-plane enablement in flight: the plane has no file until it lands. */
  const [enablingGlobal, setEnablingGlobal] = useState(false)
  const [search, setSearch] = useState('')
  /**
   * A failure no single row can carry.
   *
   * A row whose entry has no Loader id renders no switch at all, so the click
   * that reaches the toggle came from a roster that moved underneath it; there
   * is no row left to hold the reason, and the page states it instead.
   */
  const [mcpActionError, setMcpActionError] = useState<{ text: string; seq: number } | null>(null)
  // Which agent preset's rows the list carries. The global rows are listed
  // whatever this value is, because a session carries them whatever preset it
  // runs; the picker exists to shorten a long roster, not to hide a plane.
  const [agentFilter, setAgentFilter] = useState<string>(MCP_ALL_PRESETS)
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const disabled = !state.available || !state.writable
  const servers = mcpView.status === 'ready' ? mcpView.servers : []
  const presetNames = mcpView.status === 'ready' ? mcpView.presets : []
  const globalServers = servers.filter(server => server.scope === 'global')
  // Every declared preset is offered, not only the ones owning rows: one that
  // owns none still needs to be selectable, because a new row is written into
  // it. The picker's options and its controlled value must come from this one
  // set, or a value the options offer would be rejected on the next render.
  const presetChoices = (() => {
    const merged = new Map<string, { id: string; name: string; count: number }>()
    for (const preset of presetNames) merged.set(preset.id, { id: preset.id, name: presetName(preset), count: 0 })
    for (const option of mcpAgentFilterOptions(servers, presetNames.map(preset => ({ id: preset.id, name: presetName(preset) })))) {
      const source = presetNames.find(preset => preset.id === option.id) ?? { id: option.id }
      merged.set(option.id, { id: option.id, name: presetName(source), count: option.count })
    }
    return [...merged.values()]
  })()
  // The picker names a preset rather than an "everything" view: with the group
  // headings gone, one value naming the preset the list is showing is what the
  // count has to report. A value whose presets disappeared — or a first render,
  // where the roster has not answered yet — falls back to the first declared
  // one, and to the unfiltered view only when the composition declares none.
  const activePreset = presetChoices.some(option => option.id === agentFilter)
    ? agentFilter
    : presetChoices[0]?.id ?? MCP_ALL_PRESETS
  const activePresetName = presetChoices.find(option => option.id === activePreset)?.name ?? ''
  // The global plane is always listed, and first: selecting an agent preset
  // narrows the preset rows only.
  const presetServers = narrowMcpRows(servers, activePreset)
  const listedServers = [...globalServers, ...presetServers]
  const descriptionOf = (server: McpServer): string => server.description ?? state.descriptions[mcpRowKey(server)] ?? ''
  // The name filter is a view over the same roster: it never changes which rows
  // the composition declares, so the reported totals stay the composition's.
  const needle = search.trim().toLowerCase()
  const matches = (server: McpServer): boolean => needle === ''
    || server.serverName.toLowerCase().includes(needle)
    || descriptionOf(server).toLowerCase().includes(needle)
  const visibleGlobal = globalServers.filter(matches)
  const visiblePreset = presetServers.filter(matches)
  const visibleCount = visibleGlobal.length + visiblePreset.length
  const enabledCount = listedServers.filter(server => server.enabled !== false).length
  // A global write edits the Include's own file, so a patched profile writes
  // fine; only a composition that mounts no single file-backed Include cannot
  // address one, and then the global row actions are closed.
  const globalUnavailable = mcpView.status === 'ready' && !mcpView.globalWritable
  /**
   * Whether the Host can create the missing global file.
   *
   * Only `no-writable-include` leaves a file to create: several mounted
   * Includes or an unreadable one cannot be resolved by writing a new file, so
   * those stay closed and the notice only explains why.
   */
  const globalCreatable = mcpView.status === 'ready' && mcpView.globalReason === 'no-writable-include'
  const unavailableReason = t('mcp.global.unavailable')

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
            ...roster.globalReason === undefined ? {} : { globalReason: roster.globalReason },
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
   * every composed row reached its new state. The picker reports the write's own
   * saving and failed states; a failing gate read after a committed write is not
   * a failed save, so the roster is refreshed from whatever the read can answer.
   */
  const pickMode = (mode: McpLoadingOption): void => {
    setModeSave({ phase: 'saving' })
    setNotice(null)
    void (async () => {
      try {
        await setMcpLoading(mode)
      } catch {
        setModeSave({ phase: 'failed', mode })
        return
      }
      setModeSave({ phase: 'idle' })
      reportNotice(t('mcp.notice.modeSaved'))
      await suppressedMcps().catch((): readonly string[] => [])
      refreshMcps()
    })()
  }

  const openAdd = (plane: McpPlane = 'agent'): void => {
    setOpenedPlane(plane)
    setOpenedTab('config')
    setEditor({ mode: 'add', server: undefined, open: true })
    setEditorError(null)
    setNotice(null)
    setMcpActionError(null)
  }

  const openEdit = (server: McpServer, tab: McpEditorTab = 'config'): void => {
    // The pane is moved before the dialog opens: the dialog keeps whatever pane
    // it is showing while it is closed, so setting it afterwards would leave the
    // first frame on the previous pane.
    setOpenedTab(tab)
    setEditor({ mode: 'edit', server, open: true })
    setEditorError(null)
    setNotice(null)
    setMcpActionError(null)
  }

  const closeEditor = (): void => {
    if (editorBusy) return
    setEditor(previous => ({ ...previous, open: false }))
    setEditorError(null)
  }

  const refreshMcps = (): void => {
    setMcpRequest(value => value + 1)
  }

  /**
   * Let the Host create the user's own global Include, then re-read the roster.
   *
   * The plane has no writable file in a fresh profile, so this is the one action
   * that opens it; the roster read behind it is what turns every control from
   * "closed" to usable. A host that wrote the file but could not mount it still
   * gets an answer, and the notice says a restart is what applies it.
   * @returns `ready` when the plane is writable now, `pending` when the file was
   *   written but is not mounted, and `failed` when nothing usable was written.
   */
  const enableGlobal = async (): Promise<McpGlobalEnableOutcome> => {
    if (enablingGlobal) return 'failed'
    setEnablingGlobal(true)
    setMcpActionError(null)
    try {
      const result = await enableGlobalPlane()
      refreshMcps()
      reportNotice(result.mounted ? t('mcp.global.created') : t('mcp.global.createdPending'))
      return result.mounted ? 'ready' : 'pending'
    } catch (cause) {
      reportRefusal(`${t('mcp.global.enableFailed')}${failureText(cause)}`)
      return 'failed'
    } finally {
      setEnablingGlobal(false)
    }
  }

  const submitEditor = async (request: McpEditorRequest): Promise<void> => {
    setEditorBusy(true)
    setEditorError(null)
    try {
      if (editor.mode === 'add') await addMcp(request as AddMcpRequest)
      else await editMcp(request as EditMcpRequest)
      setEditor({ mode: editor.mode, server: undefined, open: false })
      reportNotice(editor.mode === 'add' ? t('mcp.notice.added') : t('mcp.notice.saved'))
      refreshMcps()
    } catch (cause) {
      setEditorError(failureText(cause))
    } finally {
      setEditorBusy(false)
    }
  }

  /**
   * Flip one row's enablement without blocking the list. The row immediately
   * shows its target state and a transient starting/stopping label; the Host
   * call (which starts or stops the child MCP process) runs in the background
   * and the list refreshes with the real state when it settles. A failed call
   * leaves the roster as it was and keeps the reason and a retry in that row.
   */
  const toggleDisabled = (server: McpServer, enabled: boolean): void => {
    const entryId = server.entryId
    setMcpActionError(null)
    if (entryId === null) {
      // A row with no Loader id renders no switch at all, so reaching this means
      // the roster moved under the click. Say so instead of returning silently.
      reportRefusal(t('mcp.error.unaddressable'))
      return
    }
    const key = mcpRowKey(server)
    const target = server.scope === 'global'
      ? { scope: 'global' as const }
      : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
    setNotice(null)
    setRowAction(previous => ({ ...previous, [key]: { phase: enabled ? 'enabling' : 'disabling' } }))
    void (async () => {
      try {
        await disableMcp({ target, entryId, disabled: !enabled })
        reportNotice(enabled ? t('mcp.notice.enabled') : t('mcp.notice.disabled'))
        setRowAction(previous => {
          const next = { ...previous }
          delete next[key]
          return next
        })
      } catch (cause) {
        setRowAction(previous => ({ ...previous, [key]: { phase: 'failed', message: failureText(cause), target: enabled } }))
      } finally {
        refreshMcps()
      }
    })()
  }

  const rowFor = (server: McpServer): ReactNode => {
    const key = mcpRowKey(server)
    return (
      <McpRow
        key={key}
        server={server}
        presetLabel={server.presetId === undefined ? '' : presetName(presetNames.find(preset => preset.id === server.presetId) ?? { id: server.presetId })}
        description={descriptionOf(server)}
        suppressed={mcpView.status === 'ready' && mcpView.suppressed.has(key)}
        action={rowAction[key] ?? null}
        onEditDescription={(value) => updateMcpDescription(key, value)}
        onEdit={(tab) => { openEdit(server, tab) }}
        onToggleDisabled={(enabled) => { toggleDisabled(server, enabled) }}
        onRetry={(enabled) => { toggleDisabled(server, enabled) }}
        {...rowActionState(server, editorBusy, globalUnavailable, unavailableReason, t)}
        t={t}
      />
    )
  }

  /**
   * What the list says when the current view renders no row.
   *
   * Two different nothings: a search that matched nothing (the roster itself is
   * not what is wrong), and a view whose preset and global planes are both
   * empty. Neither offers a way out any more: creating a row belongs to the
   * list's own 新增 MCP button, and the preset branch used to repeat that as a
   * second, plane-specific button under a sentence explaining which rows the
   * filter shows. The count and the preset picker above already say that, so the
   * empty block is only the statement that this view holds nothing.
   * @returns the empty-state block, or null when the list has rows.
   */
  const emptyList = (): ReactNode => {
    if (mcpView.status !== 'ready' || visibleGlobal.length + visiblePreset.length > 0) return null
    const searching = needle !== ''
    return (
      <div className={css.emptyBlock}>
        <p className={css.empty}>
          {searching ? t('mcp.noMatch') : t('mcp.empty.row')}
        </p>
        {searching ? <p className={css.emptyHint}>{t('mcp.noMatch.hint')}</p> : null}
      </div>
    )
  }

  /**
   * The loading mode lives on the settings tab: it is one of the two inputs that
   * govern the roster (the row switch is the other), but it is a page-level
   * preference, not a property of the list it sits beside.
   */
  const loadingSection = (
    <section className={css.block}>
      <div className={css.blockHead}>
        <h3 className={css.blockTitle}>{t('mcp.mode.title')}</h3>
      </div>
      {!state.available ? <p className={css.unavailable}>{t('unavailable')}</p> : null}
      <McpLoadingPicker
        value={state.loading}
        disabled={disabled}
        status={modeSave}
        onPick={pickMode}
        onRetry={pickMode}
        t={t}
      />
    </section>
  )

  const rosterPanel = (
    <>
      <section className={css.rosterBlock}>
        <div className={css.listHead}>
          <div className={css.listHeadText}>
            <h3 className={css.blockTitle}>{t('mcp.list.title')}</h3>
            {mcpView.status === 'ready' ? (
              <span className={css.count}>
                {needle === ''
                  ? t('mcp.count.rows')
                    .replace('{n}', String(listedServers.length))
                    .replace('{m}', String(enabledCount))
                  : t('mcp.count.filtered')
                    .replace('{n}', String(visibleCount))
                    .replace('{m}', String(listedServers.length))}
              </span>
            ) : null}
          </div>
          <span className={css.listActions}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => { openAdd() }}
              disabled={disabled || editorBusy}
              title={disabled ? t('unavailable') : undefined}
            >
              {t('mcp.add')}
            </Button>
          </span>
        </div>
        {/* A fresh profile has no writable Include, so the plane is closed until
            the Host creates one. Saying that here — where the list would show the
            global rows — is what makes the closed scope picker explainable, and
            the button is the only thing that can change the answer. */}
        {globalUnavailable ? (
          <div className={css.globalCallout}>
            <div className={css.globalCalloutText}>
              <p>{unavailableReason}</p>
              {globalCreatable ? <p className={css.globalCalloutHint}>{t('mcp.global.autoHint')}</p> : null}
            </div>
            {globalCreatable ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void enableGlobal() }}
                disabled={disabled || enablingGlobal}
              >
                {enablingGlobal ? t('mcp.global.enabling') : t('mcp.global.enable')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* The picker names the preset whose rows the list carries. There is no
            "every preset" entry: the global rows are listed under every value,
            so an option that meant "all of them" would be a second, unnamed
            view of the same list. */}
        <div className={css.listFilters}>
          <input
            type="search"
            className={css.rosterSearch}
            value={search}
            placeholder={t('mcp.search.placeholder')}
            aria-label={t('mcp.search.label')}
            onChange={(event) => { setSearch(event.currentTarget.value) }}
          />
          {presetChoices.length > 0 ? (
            <Menu open={presetMenuOpen} portal className={css.mcpFilterMenu}
              selectedId={activePreset}
              items={presetChoices.map(option => ({
                id: option.id, label: t('mcp.filter.option').replace('{name}', option.name),
              }))}
              onClose={() => setPresetMenuOpen(false)}
              onSelect={id => { setAgentFilter(id); setPresetMenuOpen(false) }}
              anchor={<Button variant="outline" className={css.mcpFilterSelect}
                aria-label={t('mcp.filter.label')} aria-haspopup="menu" aria-expanded={presetMenuOpen}
                onClick={() => setPresetMenuOpen(value => !value)}>
                <span className={css.mcpFilterName}>{t('mcp.filter.option').replace('{name}', activePresetName)}</span>
                <IconChevronDownOutlineRegular size={16} />
              </Button>} />
          ) : null}
        </div>
        <div className={css.rosterBody} role="region" aria-label={t('mcp.list.title')} tabIndex={0}>
          {mcpView.status === 'loading' ? <McpRosterSkeleton label={t('mcp.loading')} /> : null}
          {mcpView.status === 'error' ? (
            <div className={css.mcpFailure}>
              <p role="alert">{t('mcp.error')}</p>
              <Button variant="outline" size="sm" onClick={refreshMcps}>{t('mcp.retry')}</Button>
            </div>
          ) : null}
          {mcpView.status === 'ready' ? (
            <div className={css.mcpList}>
              {/* One flat list, global rows first: the global plane is never
                  filtered away (a session carries its rows whatever agent preset
                  it runs), and its rows are the only ones tagged, so which plane
                  a row belongs to stays readable without a heading per group. */}
              {visibleGlobal.map(server => rowFor(server))}
              {visiblePreset.map(server => rowFor(server))}
              {emptyList()}
            </div>
          ) : null}
          {/* A refresh stays below the mounted rows to preserve their positions;
              settled outcomes use the floating Toast outside the scroll box. */}
          {mcpView.status === 'ready' && mcpView.refreshing ? (
            <p className={css.mcpStatus} role="status">{t('mcp.refreshing')}</p>
          ) : null}
        </div>
        {mcpActionError !== null ? <Toast key={`refusal-${String(mcpActionError.seq)}`}
          text={mcpActionError.text}
          holdMs={6000}
          onDone={() => { setMcpActionError(current => current?.seq === mcpActionError.seq ? null : current) }} /> : null}
        {notice !== null ? <Toast key={`notice-${String(notice.seq)}`} text={notice.text} tone="success"
          onDone={() => { setNotice(current => current?.seq === notice.seq ? null : current) }} /> : null}
      </section>
    </>
  )

  return (
    <div className={css.section}>
      <header className={css.pageHead}>
        <h2 className={css.pageTitle}>{t('mcp.page.title')}</h2>
        <p className={css.pageIntro}>{t('mcp.page.intro')}</p>
      </header>
      <SegmentedTabs<McpTab>
        className={css.tabs}
        label={t('mcp.tabs.label')}
        value={tab}
        onChange={setTab}
        items={[
          { value: 'servers', label: t('mcp.tab.servers'), id: `${tabsId}-servers-tab`, panelId: `${tabsId}-servers-panel` },
          { value: 'settings', label: t('mcp.tab.settings'), id: `${tabsId}-settings-tab`, panelId: `${tabsId}-settings-panel` },
        ]}
      />
      <div
        id={`${tabsId}-servers-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-servers-tab`}
        className={css.tabPanel}
        hidden={tab !== 'servers'}
      >
        {rosterPanel}
      </div>
      <div
        id={`${tabsId}-settings-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-settings-tab`}
        className={css.tabPanel}
        data-scroll="settings"
        hidden={tab !== 'settings'}
      >
        {loadingSection}
        <McpOptimizeSection {...props} />
      </div>
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
        presetName={presetName}
        plane={openedPlane}
        tab={openedTab}
        globalWritable={mcpView.status === 'ready' && mcpView.globalWritable}
        globalCreatable={globalCreatable}
        onEnableGlobal={enableGlobal}
        {...activePreset === MCP_ALL_PRESETS ? {} : { preset: activePreset }}
        descriptionInitial={editor.server === undefined
          ? ''
          : descriptionOf(editor.server)}
        onUpdateDescription={updateMcpDescription}
        toolRulesInitial={editor.server === undefined ? [] : toolRuleEntries(state.tools[mcpRowKey(editor.server)])}
        onUpdateTools={updateMcpTools}
        t={t}
        onClose={closeEditor}
        onSubmit={(request) => { void submitEditor(request) }}
      />
    </div>
  )
}
