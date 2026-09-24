/**
 * Import dialog: the MCP servers the Claude Code configuration files declare,
 * offered as a checklist.
 *
 * The scan is a read; the import is a sequence of ordinary `addMcp` calls, one
 * per selected entry. That reuse is deliberate: a row imported here goes
 * through the same validation, conflict detection, atomic write, and live
 * reconciliation as one typed into the editor, so the two paths cannot drift.
 * Entries are imported independently and a failure is reported per entry rather
 * than aborting the batch, because one colliding name must not discard the rest.
 *
 * The target is chosen here: the global plane while it accepts writes, otherwise
 * an agent preset. A profile mounts its root Include together with the bundle and
 * user patch layers, so the global plane refuses writes there and an import that
 * insisted on it could never land a row.
 *
 * @module @guowenzhang/dsh-mcp-manager/client/ClaudeImportDialog
 */

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AddMcpRequest, ClaudeMcpEntry, ClaudeMcpSource, McpTarget, ScanClaudeMcpRequest, ScanClaudeMcpResult } from '../types.ts'
import type { McpSectionKey } from './locales.ts'
import type { McpPresetOption, McpServer } from './settings-controller.ts'
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
  /** Import one entry as a row of the selected composition. */
  readonly addMcp: (request: AddMcpRequest) => Promise<unknown>
  /** The roster already configured, used to pre-clear names that would collide. */
  readonly servers: readonly McpServer[]
  /** Presets an import can target, in roster order. */
  readonly presets: () => Promise<readonly McpPresetOption[]>
  /** Whether the global plane accepts writes; when false it is not offered. */
  readonly globalWritable: boolean
  /**
   * Localized reason the global plane refuses writes, shown while it does. The
   * import then writes into a preset, because the global plane cannot persist a
   * row in a profile whose root Include carries the bundle and user patch layers.
   */
  readonly globalProblem?: string
  readonly t: Translate
  readonly onClose: () => void
  /** Called after a batch settles so the section can refresh its roster. */
  readonly onImported: () => void
}

/** Where one import writes, as the dialog's scope field spells it. */
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
  open, busy, error, scanClaudeMcp, addMcp, servers, presets, globalWritable, globalProblem, t, onClose, onImported,
}: ClaudeImportDialogProps): ReactNode {
  const [view, setView] = useState<ImportView>({ status: 'loading' })
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number; readonly serverName: string } | null>(null)
  const [presetOptions, setPresetOptions] = useState<readonly McpPresetOption[]>([])
  const [scope, setScope] = useState<ImportScope>({ kind: 'global' })
  /** Whether the previous render had the dialog open, so a re-scan is told apart from a fresh open. */
  const wasOpen = useRef(false)

  useEffect(() => {
    const opening = open && !wasOpen.current
    wasOpen.current = open
    if (!open) return
    let current = true
    setView({ status: 'loading' })
    setOutcome(null)
    setProgress(null)
    // Only a fresh open starts from "everything importable selected". A re-scan
    // inside the same open dialog (a batch settled, or the retry button) keeps
    // the user's own selection: clearing it there silently re-checked every row.
    if (opening) {
      setExcluded(new Set<string>())
      // An empty preset id stands for "the first preset once they are known";
      // the global plane is preferred while it accepts writes.
      setScope(globalWritable ? { kind: 'global' } : { kind: 'preset', presetId: '' })
    }
    void presets().then(
      (list) => {
        if (!current) return
        setPresetOptions(list)
        setScope((previous) => {
          if (previous.kind !== 'preset' || previous.presetId !== '') return previous
          const first = list[0]
          return first === undefined ? { kind: 'global' } : { kind: 'preset', presetId: first.id }
        })
      },
      () => { if (current) setPresetOptions([]) },
    )
    void scanClaudeMcp({}).then(
      (result) => { if (current) setView({ status: 'ready', sources: result.sources }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [open, attempt, scanClaudeMcp, presets, globalWritable])

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
   * Import every selected entry, one `addMcp` each. A rejection is recorded
   * against its own server and the batch continues, so a single conflict cannot
   * cost the user the rest of the import. One add can take as long as the MCP
   * child process takes to start, so the dialog reports which server it is on
   * rather than an indeterminate "importing" line.
   */
  const runImport = async (): Promise<void> => {
    setOutcome(null)
    const failures: { serverName: string; reason: string }[] = []
    let imported = 0
    for (const [index, { entry }] of chosen.entries()) {
      setProgress({ done: index, total: chosen.length, serverName: entry.serverName })
      try {
        await addMcp({ target: targetOf(scope), serverName: entry.serverName, spec: entry.spec })
        imported += 1
      } catch (cause) {
        failures.push({ serverName: entry.serverName, reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    setProgress(null)
    setOutcome({ imported, failures })
    if (imported > 0) onImported()
    // Surviving rows are now in the roster, so the source list is re-read to
    // mark them as existing and keep a second click from colliding.
    setAttempt(value => value + 1)
  }

  const total = allEntries.length
  const importable = allEntries.filter(({ entry }) => selectable(entry)).length
  /** The preset the select shows; empty while the global plane is the target. */
  const scopeValue = scope.kind === 'global' ? '' : scope.presetId
  // A profile whose root Include carries the bundle and user patch layers has no
  // writable global plane, so a preset is the only place an import can land.
  // With neither, the dialog explains why nothing can be imported.
  const noWritablePlane = !globalWritable && presetOptions.length === 0
  const footer = (
    <div className={css.formActions}>
      <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('mcp.import.close')}</Button>
      <Button
        variant="primary"
        size="sm"
        disabled={busy || chosen.length === 0 || noWritablePlane}
        onClick={() => { void runImport() }}
      >
        {progress === null
          ? (busy ? t('mcp.import.submitting') : t('mcp.import.submit'))
          : t('mcp.import.progress')
            .replace('{i}', String(progress.done + 1))
            .replace('{n}', String(progress.total))
            .replace('{name}', progress.serverName)}
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
        {/* One control row: where the batch writes on the left, what is
            selected on the right. The plane select and the check-all actions
            share a baseline, so the dialog does not stack three bands before
            the list. */}
        <div className={css.importToolbar}>
          <label className={css.importScope}>
            <span className={css.formLabel}>{t('mcp.import.scope')}</span>
            <select
              className={css.formSelect}
              value={scopeValue}
              disabled={busy || noWritablePlane}
              aria-label={t('mcp.import.scope')}
              onChange={(event) => {
                const next = event.currentTarget.value
                setScope(next === '' ? { kind: 'global' } : { kind: 'preset', presetId: next })
                // The chosen plane changes which names already exist there, so the
                // dialog returns to "everything importable into it is selected".
                setExcluded(new Set<string>())
              }}
            >
              {globalWritable ? <option value="">{t('mcp.scopeGlobal')}</option> : null}
              {presetOptions.map(option => (
                <option key={option.id} value={option.id}>{`${t('mcp.scopePreset')} · ${option.name}`}</option>
              ))}
            </select>
          </label>
          {view.status === 'ready' && total > 0 ? (
            <span className={css.toolsActions}>
              <span className={css.toolsCount} role="status">
                {t('mcp.import.selected').replace('{n}', String(chosen.length)).replace('{m}', String(importable))}
              </span>
              <button type="button" className={css.mcpAction} disabled={busy} onClick={() => { setAll(true) }}>
                {t('mcp.import.selectAll')}
              </button>
              <button type="button" className={css.mcpAction} disabled={busy} onClick={() => { setAll(false) }}>
                {t('mcp.import.selectNone')}
              </button>
            </span>
          ) : null}
        </div>
        {noWritablePlane ? (
          <p className={css.mcpActionError} role="alert">
            {t('mcp.import.scopeUnavailable').replace('{reason}', globalProblem ?? t('unavailable'))}
          </p>
        ) : null}
        {!noWritablePlane && globalProblem !== undefined ? (
          <p className={css.fieldHint}>{t('mcp.import.globalReadOnly')}</p>
        ) : null}
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
        {outcome?.failures.map(failure => (
          <p key={failure.serverName} className={css.mcpActionError} role="alert">
            {`${failure.serverName}: ${failure.reason}`}
          </p>
        ))}
        {error !== null ? <p className={css.formError} role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
