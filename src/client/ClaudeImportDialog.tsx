/**
 * Import dialog: the MCP servers the Claude Code configuration files declare,
 * offered as a checklist.
 *
 * The scan is a read; the import is a sequence of ordinary `addMcp` calls, one
 * per selected entry. That reuse is deliberate: a row imported here goes
 * through the same validation, conflict detection, atomic write, and live
 * `tree.refresh()` as one typed into the editor, so the two paths cannot drift.
 * Entries are imported independently and a failure is reported per entry rather
 * than aborting the batch, because one colliding name must not discard the rest.
 *
 * @module @zhang-guo-wen/dsh-mcp-manager/client/ClaudeImportDialog
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AddMcpRequest, ClaudeMcpEntry, ClaudeMcpSource, ScanClaudeMcpRequest, ScanClaudeMcpResult } from '../types.ts'
import type { McpSectionKey } from './locales.ts'
import type { McpServer } from './settings-controller.ts'
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
  /** Import one entry as a global MCP row. */
  readonly addMcp: (request: AddMcpRequest) => Promise<unknown>
  /** The roster already configured, used to pre-clear names that would collide. */
  readonly servers: readonly McpServer[]
  readonly t: Translate
  readonly onClose: () => void
  /** Called after a batch settles so the section can refresh its roster. */
  readonly onImported: () => void
}

/** The names already present as global rows, which an import would collide with. */
function globalServerNames(servers: readonly McpServer[]): ReadonlySet<string> {
  const names = new Set<string>()
  for (const server of servers) {
    if (server.scope !== 'global') continue
    // A global row's `serverName` is its local entry id unless the file said
    // otherwise, so both spellings are treated as taken.
    names.add(server.serverName)
    if (server.entryId !== null) names.add(server.entryId)
  }
  return names
}

/** One checkbox line: the server's name, transport, origin, and secret key names. */
function EntryRow({ entry, checked, disabled, onToggle, t }: {
  readonly entry: ClaudeMcpEntry
  readonly checked: boolean
  readonly disabled: boolean
  readonly onToggle: (next: boolean) => void
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
        onChange={(event) => { onToggle(event.currentTarget.checked) }}
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
}

/** The Claude configuration import dialog. */
export function ClaudeImportDialog({
  open, busy, error, scanClaudeMcp, addMcp, servers, t, onClose, onImported,
}: ClaudeImportDialogProps): ReactNode {
  const [view, setView] = useState<ImportView>({ status: 'loading' })
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [attempt, setAttempt] = useState(0)
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null)

  useEffect(() => {
    if (!open) return
    let current = true
    setView({ status: 'loading' })
    setOutcome(null)
    setExcluded(new Set<string>())
    void scanClaudeMcp({}).then(
      (result) => { if (current) setView({ status: 'ready', sources: result.sources }) },
      () => { if (current) setView({ status: 'error' }) },
    )
    return () => { current = false }
  }, [open, attempt, scanClaudeMcp])

  const existing = globalServerNames(servers)
  /** A key is source-scoped, because the same name may appear in two files. */
  const keyOf = (source: ClaudeMcpSource, entry: ClaudeMcpEntry): string => `${source.id}\u0000${entry.serverName}`
  const selectable = (entry: ClaudeMcpEntry): boolean => entry.problem === undefined && !existing.has(entry.serverName)

  const allEntries = view.status === 'ready'
    ? view.sources.flatMap(source => source.entries.map(entry => ({ source, entry })))
    : []
  const chosen = allEntries.filter(({ source, entry }) => selectable(entry) && !excluded.has(keyOf(source, entry)))

  const toggle = (key: string, next: boolean): void => {
    setExcluded((previous) => {
      const set = new Set(previous)
      if (next) set.delete(key)
      else set.add(key)
      return set
    })
  }

  const setAll = (next: boolean): void => {
    setExcluded(next
      ? new Set<string>()
      : new Set(allEntries.filter(({ entry }) => selectable(entry)).map(({ source, entry }) => keyOf(source, entry))))
  }

  /**
   * Import every selected entry, one `addMcp` each. A rejection is recorded
   * against its own server and the batch continues, so a single conflict cannot
   * cost the user the rest of the import.
   */
  const runImport = async (): Promise<void> => {
    setOutcome(null)
    const failures: { serverName: string; reason: string }[] = []
    let imported = 0
    for (const { entry } of chosen) {
      try {
        await addMcp({ target: { scope: 'global' }, serverName: entry.serverName, spec: entry.spec })
        imported += 1
      } catch (cause) {
        failures.push({ serverName: entry.serverName, reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    setOutcome({ imported, failures })
    if (imported > 0) onImported()
    // Surviving rows are now in the roster, so the source list is re-read to
    // mark them as existing and keep a second click from colliding.
    setAttempt(value => value + 1)
  }

  const total = allEntries.length
  const importable = allEntries.filter(({ entry }) => selectable(entry)).length
  const footer = (
    <div className={css.formActions}>
      <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('mcp.import.close')}</Button>
      <Button
        variant="primary"
        size="sm"
        disabled={busy || chosen.length === 0}
        onClick={() => { void runImport() }}
      >
        {busy ? t('mcp.import.submitting') : t('mcp.import.submit')}
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
      contentClassName={css.mcpEditorContent ?? ''}
      footer={footer}
    >
      <div className={css.mcpForm}>
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
            <div className={css.importToolbar}>
              <span className={css.fieldHint}>{t('mcp.import.scopeNote')}</span>
              <span className={css.toolsActions}>
                <button type="button" className={css.mcpAction} disabled={busy} onClick={() => { setAll(true) }}>
                  {t('mcp.import.selectAll')}
                </button>
                <button type="button" className={css.mcpAction} disabled={busy} onClick={() => { setAll(false) }}>
                  {t('mcp.import.selectNone')}
                </button>
              </span>
            </div>
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
                    return (
                      <EntryRow
                        key={entry.serverName}
                        entry={entry}
                        checked={!disabled && !excluded.has(keyOf(source, entry))}
                        disabled={disabled}
                        onToggle={(next) => { toggle(keyOf(source, entry), next) }}
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
