/**
 * Import dialog: the MCP servers the Claude Code configuration files declare,
 * offered as a checklist.
 *
 * The scan is a read; the import is one `addMcps` call carrying every selected
 * entry. That reuse is deliberate: a row imported here goes through the same
 * validation, conflict detection, atomic write, and live reconciliation as one
 * typed into the editor, so the two paths cannot drift. One call, not one per
 * entry, because an agent preset re-mounts once per write and every MCP server
 * that preset declares starts again on each mount. Entries are still validated
 * individually, so a failure is reported per entry rather than discarding the
 * batch, because one colliding name must not cost the rest.
 *
 * The plane is the settings tab's, not a field of its own: a user who opened the
 * import from the global tab is importing into the global plane, and one who
 * opened it from the agent tab picks the preset there.
 *
 * @module @guowenzhang/dsh-mcp-manager/client/ClaudeImportDialog
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AddMcpsRequest,
  AddMcpsResult,
  ClaudeMcpEntry,
  ClaudeMcpSource,
  McpTarget,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
} from '../types.ts'
import type { McpSectionKey } from './locales.ts'
import type { McpPlane, McpPresetOption, McpServer } from './settings-controller.ts'
import css from './McpSection.module.css'

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = (key: McpSectionKey) => string

/** What the dialog is currently showing. */
type ImportView =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly sources: readonly ClaudeMcpSource[] }

/** Outcome of one import batch. */
interface ImportOutcome {
  readonly imported: number
  readonly failures: readonly { readonly serverName: string; readonly reason: string }[]
}

interface ClaudeImportDialogProps {
  readonly open: boolean
  readonly busy: boolean
  readonly error: string | null
  /** Read the servers the Claude Code configuration files declare. */
  readonly scanClaudeMcp: (request: ScanClaudeMcpRequest) => Promise<ScanClaudeMcpResult>
  /** Append every selected entry to the addressed composition in one write. */
  readonly addMcps: (request: AddMcpsRequest) => Promise<AddMcpsResult>
  /** The roster already configured, used to pre-clear names that would collide. */
  readonly servers: readonly McpServer[]
  /** Presets an import can target, in roster order. */
  readonly presets: () => Promise<readonly McpPresetOption[]>
  /** The plane the settings tab shows, which the batch writes into. */
  readonly plane: McpPlane
  readonly t: Translate
  readonly onClose: () => void
  /** Called after a batch settles so the section can refresh its roster. */
  readonly onImported: () => void
}

/** Where one import writes. */
type ImportScope = { readonly kind: 'global' } | { readonly kind: 'preset'; readonly presetId: string }

/** The composition target one import scope addresses. */
function targetOf(scope: ImportScope): McpTarget {
  return scope.kind === 'global' ? { scope: 'global' } : { scope: 'preset', agentPreset: scope.presetId }
}

/**
 * The names one composition already carries, which an import into it would
 * collide with. A row's `serverName` is its local entry id unless the file said
 * otherwise, so both spellings are treated as taken.
 */
function configuredNames(servers: readonly McpServer[], scope: ImportScope): ReadonlySet<string> {
  const names = new Set<string>()
  for (const server of servers) {
    const same = scope.kind === 'global'
      ? server.scope === 'global'
      : server.scope === 'preset' && server.presetId === scope.presetId
    if (!same) continue
    names.add(server.serverName)
    if (server.entryId !== null) names.add(server.entryId)
  }
  return names
}

/**
 * One checkbox line: the server's name, transport, origin, and secret key names.
 *
 * Memoized, and every prop is stable between renders except `checked`: with a
 * real Claude configuration the list runs to dozens of rows, and re-rendering
 * all of them under the modal's blurred backdrop is what makes the dialog feel
 * slow while the user ticks boxes.
 */
const EntryRow = memo(function EntryRow({ entryKey, entry, checked, disabled, onToggle, t }: {
  readonly entryKey: string
  readonly entry: ClaudeMcpEntry
  readonly checked: boolean
  readonly disabled: boolean
  readonly onToggle: (key: string, next: boolean) => void
  readonly t: Translate
}): ReactNode {
  const transport = entry.spec.type === 'stdio'
    ? `stdio · ${entry.spec.command}`
    : `${entry.spec.type} · ${entry.spec.url}`
  return (
    <label className={css.importRow}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={entry.serverName}
        onChange={(event) => { onToggle(entryKey, event.currentTarget.checked) }}
      />
      <span className={css.importMain}>
        <span className={css.importName}>
          {entry.serverName}
          {entry.duplicate ? <span className={css.importTag}>{t('mcp.import.duplicate')}</span> : null}
          {entry.problem !== undefined
            ? <span className={css.importTagWarn}>{t(`mcp.import.problem.${entry.problem}`)}</span>
            : null}
          {disabled && entry.problem === undefined ? <span className={css.importTag}>{t('mcp.import.existing')}</span> : null}
        </span>
        <span className={css.importMeta}>{transport}</span>
        {entry.envKeys.length > 0 ? (
          <span className={css.importMeta}>
            {`${t(entry.spec.type === 'stdio' ? 'mcp.import.secrets' : 'mcp.import.headers')}: ${entry.envKeys.join(', ')}`}
          </span>
        ) : null}
      </span>
    </label>
  )
})

/** The Claude configuration import dialog. */
export function ClaudeImportDialog({
  open, busy, error, scanClaudeMcp, addMcps, servers, presets, plane, t, onClose, onImported,
}: ClaudeImportDialogProps): ReactNode {
  const [view, setView] = useState<ImportView>({ status: 'loading' })
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [importing, setImporting] = useState(false)
  const [presetOptions, setPresetOptions] = useState<readonly McpPresetOption[]>([])
  const [presetId, setPresetId] = useState('')
  /** Whether the previous render had the dialog open, so a re-scan is told apart from a fresh open. */
  const wasOpen = useRef(false)

  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!open) return
    let current = true
    setView({ status: 'loading' })
    setOutcome(null)
    setImporting(false)
    // Only a fresh open starts from "everything importable selected". A re-scan
    // inside the same open dialog (a batch settled, or the retry button) keeps
    // the user's own selection: clearing it there silently re-checked every row.
    if (opening) {
      setExcluded(new Set<string>())
      // An empty preset id stands for "the first preset once they are known".
      setPresetId('')
    }
    void presets().then(
      (list) => {
        if (!current) return
        setPresetOptions(list)
        setPresetId(previous => previous !== '' ? previous : list[0]?.id ?? '')
      },
      () => { if (current) setPresetOptions([]) },
    )
    void scanClaudeMcp({}).then(
      (result) => { if (current) setView({ status: 'ready', sources: result.sources }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [open, attempt, scanClaudeMcp, presets])

  /** The composition the batch writes into: the tab's plane, or its preset. */
  const scope: ImportScope = plane === 'global' ? { kind: 'global' } : { kind: 'preset', presetId }
  const existing = configuredNames(servers, scope)
  /** A key is source-scoped, because the same name may appear in two files. */
  const keyOf = (source: ClaudeMcpSource, entry: ClaudeMcpEntry): string => `${source.id}\u0000${entry.serverName}`
  const selectable = (entry: ClaudeMcpEntry): boolean => entry.problem === undefined && !existing.has(entry.serverName)

  const allEntries = view.status === 'ready'
    ? view.sources.flatMap(source => source.entries.map(entry => ({ source, entry })))
    : []
  const chosen = allEntries.filter(({ source, entry }) => selectable(entry) && !excluded.has(keyOf(source, entry)))

  const toggle = useCallback((key: string, next: boolean): void => {
    setExcluded((previous) => {
      const set = new Set(previous)
      if (next) set.delete(key)
      else set.add(key)
      return set
    })
  }, [])

  const setAll = (next: boolean): void => {
    setExcluded(next
      ? new Set<string>()
      : new Set(allEntries.filter(({ entry }) => selectable(entry)).map(({ source, entry }) => keyOf(source, entry))))
  }

  /**
   * Import every selected entry in one `addMcps` call. The Host validates each
   * row on its own and reports what became of it, so a collision still costs only
   * its own row, while the accepted rows commit together — one write, which means
   * one preset re-mount instead of one per row.
   */
  const runImport = async (): Promise<void> => {
    setOutcome(null)
    setImporting(true)
    try {
      const result = await addMcps({
        target: targetOf(scope),
        rows: chosen.map(({ entry }) => ({ serverName: entry.serverName, spec: entry.spec })),
      })
      const refused = result.outcomes.filter(outcome => outcome.entryId === null)
      const imported = result.outcomes.length - refused.length
      setOutcome({
        imported,
        failures: refused.map(row => ({ serverName: row.serverName, reason: row.reason ?? t('unavailable') })),
      })
      if (imported > 0) onImported()
      // Nothing was refused, so there is nothing left to read: the dialog closes
      // and the roster behind it shows what landed.
      if (refused.length === 0) {
        onClose()
        return
      }
      // Surviving rows are now in the roster, so the source list is re-read to
      // mark them as existing and keep a second click from colliding.
      setAttempt(value => value + 1)
    } catch (cause) {
      setOutcome({ imported: 0, failures: [{ serverName: '', reason: cause instanceof Error ? cause.message : String(cause) }] })
    } finally {
      setImporting(false)
    }
  }

  const total = allEntries.length
  const importable = allEntries.filter(({ entry }) => selectable(entry)).length
  // An agent-plane import needs a preset to address; with none declared there is
  // nowhere for it to land.
  const noTarget = plane === 'agent' && presetId === ''
  const footer = (
    <div className={css.formActions}>
      <Button variant="outline" size="sm" onClick={onClose} disabled={busy || importing}>{t('mcp.import.close')}</Button>
      <Button
        variant="primary"
        size="sm"
        disabled={busy || importing || chosen.length === 0 || noTarget}
        onClick={() => { void runImport() }}
      >
        {importing ? t('mcp.import.submitting') : t('mcp.import.submit')}
      </Button>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('mcp.import.title')}
      closeLabel={t('mcp.import.close')}
      description={t('mcp.import.hint')}
      className={css.mcpEditorDialog ?? ''}
      contentClassName={css.mcpEditorContent ?? ''}
      footer={footer}
    >
      <div className={css.mcpForm}>
        {/* One control row: where the batch writes on the left, what is selected
            on the right, on one baseline. The plane follows the settings tab, so
            only the agent plane asks which preset. */}
        <div className={css.importToolbar}>
          {plane === 'agent' ? (
            <label className={css.importScope}>
              <span className={css.formLabel}>{t('mcp.form.presetScope')}</span>
              <select
                className={css.formSelect}
                value={presetId}
                disabled={busy || importing || presetOptions.length === 0}
                aria-label={t('mcp.form.presetScope')}
                onChange={(event) => {
                  setPresetId(event.currentTarget.value)
                  // The chosen preset changes which names already exist there, so
                  // the dialog returns to "everything importable is selected".
                  setExcluded(new Set<string>())
                }}
              >
                {presetOptions.map(option => (
                  <option key={option.id} value={option.id}>{`${t('mcp.scopePreset')} · ${option.name}`}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className={css.importScope}>
              <span className={css.formLabel}>{t('mcp.form.scope')}</span>
              <span className={css.fieldHint}>{t('mcp.scopeGlobal')}</span>
            </span>
          )}
          {view.status === 'ready' && total > 0 ? (
            <span className={css.importChecks}>
              <span className={css.toolsCount} role="status">
                {t('mcp.import.selected').replace('{n}', String(chosen.length)).replace('{m}', String(importable))}
              </span>
              <button type="button" className={css.mcpAction} disabled={busy || importing} onClick={() => { setAll(true) }}>
                {t('mcp.import.selectAll')}
              </button>
              <button type="button" className={css.mcpAction} disabled={busy || importing} onClick={() => { setAll(false) }}>
                {t('mcp.import.selectNone')}
              </button>
            </span>
          ) : null}
        </div>
        {noTarget ? <p className={css.fieldHint}>{t('mcp.form.noPreset')}</p> : null}
        {view.status === 'loading' ? <p className={css.mcpStatus}>{t('mcp.import.loading')}</p> : null}
        {view.status === 'error' ? (
          <div className={css.mcpFailure}>
            <p role="alert">{t('mcp.error')}</p>
            <button type="button" className={css.mcpRetry} onClick={() => { setAttempt(value => value + 1) }}>
              {t('mcp.import.retry')}
            </button>
          </div>
        ) : null}
        {view.status === 'ready' && total === 0 ? (
          <>
            <p className={css.empty}>{t('mcp.import.empty')}</p>
            <p className={css.empty}>{t('mcp.import.emptyHint')}</p>
          </>
        ) : null}
        {view.status === 'ready' && total > 0 ? (
          <>
            <div className={css.importList}>
              {view.sources.map((source) => (
                <div key={source.id} className={css.importSource}>
                  <div className={css.importSourceHead}>
                    <span className={css.importSourceLabel}>{t(`mcp.import.source.${source.label}`)}</span>
                    <span className={css.importSourcePath} title={source.path}>{source.path}</span>
                  </div>
                  {source.problem !== undefined ? (
                    <p className={css.importProblem}>{t(`mcp.import.problem.${source.problem}`)}</p>
                  ) : null}
                  {source.entries.map((entry) => {
                    const disabled = !selectable(entry)
                    const entryKey = keyOf(source, entry)
                    return (
                      <EntryRow
                        key={entryKey}
                        entryKey={entryKey}
                        entry={entry}
                        checked={!disabled && !excluded.has(entryKey)}
                        disabled={disabled}
                        onToggle={toggle}
                        t={t}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
            {importable === 0 ? <p className={css.mcpStatus}>{t('mcp.import.noneSelected')}</p> : null}
          </>
        ) : null}
        {outcome !== null ? (
          <p className={outcome.failures.length > 0 ? css.mcpActionError : css.mcpNotice} role="status">
            {outcome.failures.length === 0
              ? t('mcp.import.done').replace('{n}', String(outcome.imported))
              : t('mcp.import.partial')
                .replace('{n}', String(outcome.imported))
                .replace('{m}', String(outcome.failures.length))}
          </p>
        ) : null}
        {outcome?.failures.map((failure, index) => (
          <p key={`${failure.serverName}:${index}`} className={css.mcpActionError} role="alert">
            {`${failure.serverName}: ${failure.reason}`}
          </p>
        ))}
        {error !== null ? <p className={css.formError} role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
