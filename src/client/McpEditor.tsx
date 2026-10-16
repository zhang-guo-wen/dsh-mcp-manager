import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AddMcpRequest,
  DescribeMcpRequest,
  DescribeMcpResult,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  McpSpec,
  McpTarget,
  McpToolRow,
} from '../types.ts'
import { admits, parseMcpToolFilter } from '../mcp-tool-filter.ts'
import { mcpEntryConfig } from '../mcp-config.ts'
import { isBlockingConfigIssue, diagnoseMcpSpec } from '../mcp-diagnostics.ts'
import { flattenSpec, parseSpecText } from '../mcp-spec.ts'
import {
  credentialText,
  credentialValues,
  mergeCredentialEdits,
  type CredentialKind,
} from './credential-fields.ts'
import { formatMcpConfigIssues } from './config-issues.ts'
import { MCP_READ_ONLY_REASON, type McpSectionKey } from './locales.ts'
import type { McpPlane, McpPresetOption, McpServer } from './settings-controller.ts'
import css from './McpSection.module.css'

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = (key: McpSectionKey) => string

/** Whether the editor is creating a row or replacing one. */
export type McpEditorMode = 'add' | 'edit'

/**
 * The editor's panes: the row's own fields, the credentials it carries, and its
 * tools. `credentials` edits the `env`/`headers` of the same JSON the config
 * pane holds — one datum, two views — so a row with credentials can be opened
 * straight on them.
 */
export type McpEditorTab = 'config' | 'credentials' | 'tools'

/** Request emitted by the MCP editor after JSON parsing and validation. */
export type McpEditorRequest = AddMcpRequest | EditMcpRequest

interface McpEditorProps {
  readonly open: boolean
  readonly mode: McpEditorMode
  readonly server: McpServer | undefined
  readonly disabled: boolean
  readonly busy: boolean
  readonly error: string | null
  readonly describeMcp: (request: DescribeMcpRequest) => Promise<DescribeMcpResult>
  /** Connect once with a spec and report the tools it publishes. */
  readonly listMcpTools: (request: ListMcpToolsRequest) => Promise<ListMcpToolsResult>
  readonly presets: () => Promise<readonly McpPresetOption[]>
  /**
   * The plane a new row starts in.
   *
   * The dialog owns the choice from here on: the section cannot infer which
   * plane the user means (an empty global plane left its write path unreachable
   * when the target was derived from the row last edited), and choosing an agent
   * row needs a preset that only this form asks for.
   */
  readonly plane: McpPlane
  /**
   * The pane this dialog opens on. The section asks for `credentials` when the
   * row's own button was clicked, and for `config` everywhere else.
   */
  readonly tab: McpEditorTab
  /** Whether the global plane has a file-backed Include to write. */
  readonly globalWritable: boolean
  /**
   * The agent preset the section is narrowed to, when it is narrowed to one.
   * A new row is written into it, so the dialog's own preset picker opens on it.
   */
  readonly preset?: string
  readonly descriptionInitial: string
  readonly onUpdateDescription: (key: string, value: string) => Promise<void>
  /** Tool rules this row currently carries, as stored entries. */
  readonly toolRulesInitial: readonly string[]
  /** Persist the row's tool rules; an empty list clears them. */
  readonly onUpdateTools: (key: string, patterns: readonly string[]) => Promise<void>
  readonly t: Translate
  readonly onClose: () => void
  readonly onSubmit: (request: McpEditorRequest) => void
}

/** Settings key for one row (`global:<name>` or `preset:<id>:<name>`), shared with the Host's `mcpRowKey`. */
function rowKey(scope: 'global' | 'preset', agentPreset: string, serverName: string): string {
  return scope === 'preset' ? `preset:${agentPreset}:${serverName}` : `global:${serverName}`
}

/**
 * The plane one row lives in, in this dialog's own vocabulary. A row's scope is
 * `global` or `preset`; a plane a new row can be written to is `global` or
 * `agent` (an agent row addressed through one preset).
 * @param server - the row being edited, when there is one.
 * @returns the plane that row belongs to.
 */
function planeOf(server: McpServer | undefined): McpPlane {
  return server?.scope === 'global' ? 'global' : 'agent'
}

/**
 * The composition a save addresses: an edited row keeps its own plane, and a new
 * row goes to the plane the section shows. Undefined when that plane cannot be
 * named — an agent row with no preset to address.
 */
function editorTarget(
  mode: McpEditorMode,
  server: McpServer | undefined,
  plane: McpPlane,
  presetId: string,
): McpTarget | undefined {
  if (mode === 'edit') {
    if (server === undefined || server.entryId === null) return undefined
    return server.scope === 'global'
      ? { scope: 'global' }
      : { scope: 'preset', agentPreset: server.presetId ?? '' }
  }
  if (plane === 'global') return { scope: 'global' }
  return presetId === '' ? undefined : { scope: 'preset', agentPreset: presetId }
}

/** The connection-spec JSON prefilled in the box (no scope/title — those are fields). */
function specJson(describe: DescribeMcpResult | undefined): string {
  const spec = describe?.spec ?? { type: 'stdio', command: '', args: [], env: {} }
  return JSON.stringify(flattenSpec(spec), null, 2)
}

/**
 * The credentials pane: the row's `env` (stdio) or `headers` (HTTP) as fields,
 * read from and written back to the JSON on the config pane.
 *
 * One datum with two views, rather than a second copy of it: a pasted spec, a
 * fixed command and a credential all end in the same save, so the JSON box has
 * to stay the thing that is written.
 * @param props.json - the JSON box's current text.
 * @param props.kind - the map this transport carries.
 * @param props.baseline - the values the pane opened with, for the changed-only merge.
 * @param props.disabled - whether the row's actions are closed.
 * @param props.onPush - apply one field's edit to the JSON box.
 * @param props.t - the section's translator.
 * @returns the credential fields, or why they cannot be shown.
 */
function McpCredentialsPane({ json, kind, baseline, disabled, onPush, t }: {
  readonly json: string
  readonly kind: CredentialKind
  readonly baseline: string
  readonly disabled: boolean
  readonly onPush: (kind: CredentialKind, key: string, value: string) => void
  readonly t: Translate
}): ReactNode {
  const values = credentialValues(json, kind)
  if (values === undefined) return <p className={css.fieldHint} role="status">{t('mcp.credential.unreadable')}</p>
  const label = kind === 'env' ? t('mcp.credential.env') : t('mcp.credential.header')
  const hint = kind === 'env' ? t('mcp.credential.envHint') : t('mcp.credential.headerHint')
  return (
    <div className={css.formField}>
      <span className={css.formLabel}>{label}</span>
      <span className={css.fieldHint}>{hint}</span>
      {values.entries.length === 0
        ? <span className={css.fieldHint}>{t('mcp.credential.empty')}</span>
        : (
          <div className={css.credentialFields}>
            {values.entries.map(([key, value]) => (
              <div key={key} className={css.credentialField}>
                <span className={css.credentialKey}>{key}</span>
                <Input
                  value={value}
                  disabled={disabled || !values.editable}
                  aria-label={key}
                  spellCheck={false}
                  onChange={(event) => { onPush(kind, key, event.currentTarget.value) }}
                />
              </div>
            ))}
          </div>
        )}
      {values.editable ? null : <span className={css.descOver}>{t('mcp.credential.unreadable')}</span>}
    </div>
  )
}

/** Modal editor split into a pane for the row's fields and a pane for its tools. */
export function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, plane, tab: openTab, globalWritable, preset, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }: McpEditorProps): ReactNode {
  const [tab, setTab] = useState<McpEditorTab>(openTab)
  const tabId = useId()
  /** Chosen agent preset for a new row; a placeholder while the list loads. */
  const [presetId, setPresetId] = useState(server?.scope === 'preset' ? server.presetId ?? '' : preset ?? '')
  const [presetOptions, setPresetOptions] = useState<readonly McpPresetOption[]>([])
  /** Whether the preset read answered, so an empty list can be told from a pending one. */
  const [presetLoaded, setPresetLoaded] = useState(false)
  /** Chosen plane for a new row, as this dialog's own field. */
  const [planeChoice, setPlaneChoice] = useState<McpPlane>(plane)
  const [title, setTitle] = useState(server?.serverName ?? '')
  const [description, setDescription] = useState(descriptionInitial)
  const [json, setJson] = useState('')
  /**
   * The JSON box as it stood when the credentials pane opened, so a save only
   * writes back the values the user actually changed: a later spec load, or a
   * value left as the box spelled it, must survive untouched.
   */
  const [credentialBase, setCredentialBase] = useState('')
  /**
   * The box's current text, for a merge that runs from a click rather than from
   * a render. A `setJson` is not visible to a handler that started in the same
   * tick, and the pane's own writes all land here too.
   */
  const jsonBox = useRef('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [configNotice, setConfigNotice] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tools, setTools] = useState<readonly McpToolRow[] | null>(null)
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [toolsBusy, setToolsBusy] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const editKey = `${server?.scope ?? ''}:${server?.presetId ?? ''}:${server?.entryId ?? ''}`
  /**
   * The plane this save addresses: an edited row keeps its own, a new one uses
   * the field below. Editing never follows the field, so a row cannot be written
   * to the wrong side by opening its editor after a scope change.
   */
  const targetPlane: McpPlane = mode === 'edit' ? planeOf(server) : planeChoice
  /** The credential map this row's transport carries; `env` until the transport is known. */
  const credentialKind: CredentialKind = (() => {
    try {
      const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
      return parsed.spec.type === 'stdio' ? 'env' : 'headers'
    } catch { return 'env' }
  })()

  /**
   * Apply one credential field to the JSON box, which is the document the save
   * reads. A box this pane cannot parse or write leaves the field as it was: the
   * config pane is where a broken document gets fixed.
   */
  const pushCredential = (kind: CredentialKind, key: string, value: string): void => {
    const next = credentialText(jsonBox.current, kind, key, value)
    if (next === undefined) return
    jsonBox.current = next
    setJson(next)
  }

  /**
   * Fold the credential fields the user changed into the form's JSON.
   *
   * Only the changed ones: the pane edits the box the user also edits by hand,
   * and a value it never showed must not be replaced by the version it read
   * when it opened.
   * @param text - the JSON box's current text.
   * @returns the text to save, or the input unchanged when nothing was edited.
   */
  const mergeCredentials = (text: string): string => mergeCredentialEdits(text, credentialBase)

  /**
   * Connect once and list what the server publishes.
   * @param spec - transport to connect with.
   * @param serverName - namespace for diagnostics; required by the Host.
   * @param fromRules - seed the checkboxes from the row's stored rules (the
   *   dialog's first listing); a manual reload keeps the user's own choices and
   *   treats tools it has not seen before as enabled.
   */
  const loadTools = (spec: McpSpec, serverName: string, fromRules: boolean): void => {
    if (serverName.trim() === '') {
      setToolsError(t('mcp.form.toolsNeedsName'))
      return
    }
    setToolsBusy(true)
    setToolsError(null)
    void listMcpTools({ spec, serverName }).then(
      (result) => {
        setTools(result.tools)
        setHiddenTools((previous) => {
          const filter = parseMcpToolFilter(toolRulesInitial)
          const next = new Set<string>()
          for (const tool of result.tools) {
            if (fromRules ? !admits(filter, tool.name) : previous.has(tool.name)) next.add(tool.name)
          }
          return next
        })
        setToolsBusy(false)
      },
      (cause: unknown) => {
        setToolsError(cause instanceof Error ? cause.message : String(cause))
        setToolsBusy(false)
      },
    )
  }

  /**
   * List the tools of the spec the form currently shows. The JSON box is the
   * source, so an edited command or url is listed as edited.
   * @param fromRules - seed the checkboxes from the row's stored rules.
   */
  const loadToolsFromForm = (fromRules: boolean): void => {
    try {
      const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
      const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
      loadTools(parsed.spec, serverName, fromRules)
    } catch (cause) {
      setToolsError(cause instanceof Error ? cause.message : t('mcp.form.jsonInvalid'))
    }
  }

  /**
   * Opening the tools pane is what asks the server for its listing: connecting
   * spawns a child process for stdio rows, and a row the user only renames never
   * needs one. `tools` stays null until a listing was actually shown, which is
   * what keeps the save from rewriting the stored rules with an empty set.
   */
  const pickTab = (next: McpEditorTab): void => {
    setTab(next)
    if (next !== 'tools' || mode !== 'edit' || loading) return
    // A global row's rules could not take effect, so listing its tools would spawn
    // a connection for a pane the user cannot use.
    if (toolsReadOnly) return
    if (tools !== null || toolsBusy) return
    loadToolsFromForm(true)
  }

  useEffect(() => {
    if (!open) return
    let current = true
    setLocalError(null)
    setConfigNotice(null)
    // The pane this dialog opens on: the row's own button asks for its
    // credentials, and everything else asks for the config. The dialog stays
    // mounted while it is closed, so the pane cannot come from the state
    // initializer alone — it has to be applied on every open.
    setTab(openTab)
    // An edited row keeps its own preset; a new row opens on the preset the list
    // is narrowed to, which is the one the section will write into. Losing that
    // here left the picker on the first preset, so a row landed somewhere the
    // user was not looking. `preset` is deliberately not a dependency: the list
    // can refresh while this dialog is open, and re-running this effect would
    // reset the form under the user.
    setPresetId(server?.scope === 'preset' ? server.presetId ?? '' : preset ?? '')
    // An edited row keeps its own plane; a new one opens on the plane the caller
    // started the dialog from, and the field below lets the user change it.
    setPlaneChoice(mode === 'edit' ? planeOf(server) : plane)
    setPresetLoaded(false)
    setTitle(server?.serverName ?? '')
    setDescription(descriptionInitial)
    setTools(null)
    setHiddenTools(new Set<string>())
    setToolsError(null)
    setToolsBusy(false)
    setLoading(false)
    void presets().then(
      (list) => {
        if (!current) return
        setPresetOptions(list)
        setPresetLoaded(true)
        // A new agent row needs a preset to address; the first one is the only
        // sensible default, and the field lets the user change it.
        setPresetId((previous) => previous !== '' ? previous : (mode === 'add' ? list[0]?.id ?? '' : ''))
      },
      () => { if (current) { setPresetOptions([]); setPresetLoaded(true) } },
    )
    if (mode === 'edit' && server?.entryId) {
      setLoading(true)
      const target = server.scope === 'global'
        ? { scope: 'global' as const }
        : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
      void describeMcp({ target, entryId: server.entryId }).then(
        (described) => {
          if (!current) return
          const text = specJson(described)
          jsonBox.current = text
          setJson(text)
          // The credentials pane records the document it opened with, so a save
          // writes back only the fields the user changed.
          setCredentialBase(text)
          setLoading(false)
        },
        () => {
          if (!current) return
          const text = specJson(undefined)
          jsonBox.current = text
          setJson(text)
          setCredentialBase(text)
          setLoading(false)
        },
      )
    } else {
      const text = specJson(undefined)
      jsonBox.current = text
      setJson(text)
      setCredentialBase(text)
    }
    return () => { current = false }
  }, [editKey, mode, open, openTab, server, descriptionInitial, presets, t])

  const submit = async (): Promise<void> => {
    try {
      // The credentials pane edits the box through the same merge the config
      // pane's own typing goes through, so one save writes one document.
      const parsed = parseSpecText(mergeCredentials(json), t('mcp.form.jsonInvalid'))
      const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
      if (serverName === '') throw new Error(t('mcp.form.required'))
      const spec = parsed.spec
      // Two levels of check, because the dialog runs in a browser that has no
      // environment of its own. A structural gap — a blank `command`/`url`, a
      // spec that cannot be read at all — can never work, so the save is
      // refused here (the builder's own error is the message). What only the
      // Host can answer — whether `${env:NAME}` resolves — is left to the
      // roster read, which marks the row "not configured" and keeps it from
      // starting; blocking the save would make such a row impossible to author
      // from a browser even when the variable is set on the Host.
      mcpEntryConfig(spec, serverName)
      const configIssue = diagnoseMcpSpec(spec, {})
      const blocking = configIssue.filter(isBlockingConfigIssue)
      if (blocking.length > 0) throw new Error(formatMcpConfigIssues(blocking, t))
      // Accepted, but the row will read as "not configured" and refuse to start
      // until the Host can resolve it: say so on the spot instead of leaving the
      // author to wonder why the row's switch will not turn on.
      setConfigNotice(configIssue.length === 0 ? null : t('mcp.form.pendingConfig'))
      const target = editorTarget(mode, server, targetPlane, presetId)
      if (target === undefined) throw new Error(noTargetReason)
      const entryId = mode === 'edit' ? server?.entryId ?? '' : undefined
      if (mode === 'edit' && entryId === '') throw new Error(t('mcp.form.required'))
      const request: McpEditorRequest = {
        target,
        serverName,
        spec,
        ...(entryId === undefined ? {} : { entryId }),
      } as McpEditorRequest
      onSubmit(request)
      const key = rowKey(
        target.scope === 'global' ? 'global' : 'preset',
        target.scope === 'global' ? '' : target.agentPreset,
        serverName,
      )
      if (description.trim() !== '') await onUpdateDescription(key, description.trim())
      // Only a listing the user actually saw may rewrite the rules; a server
      // that never answered leaves the stored rules exactly as they were. A
      // global row never lists one, because its rules cannot take effect.
      if (tools !== null && !toolsReadOnly) {
        await onUpdateTools(key, tools.filter(tool => hiddenTools.has(tool.name)).map(tool => `!${tool.name}`))
      }
    } catch (cause) {
      // Everything this catch reports is about the connection spec, so the pane
      // that holds the JSON box comes back into view: the message sits next to
      // the field it names instead of behind the tools tab.
      setTab('config')
      setLocalError(cause instanceof Error ? cause.message : t('mcp.form.jsonInvalid'))
    }
  }

  const toggleTool = (name: string): void => {
    setHiddenTools((previous) => {
      const next = new Set(previous)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // A row the Host's roster marks read-only has no writable home: opening its
  // editor must show the row, not offer a save that the Host will refuse.
  const readOnlyRow = mode === 'edit' && server !== undefined && !server.writable
  const formDisabled = disabled || busy || readOnlyRow
  const enabledCount = tools === null ? 0 : tools.length - tools.filter(tool => hiddenTools.has(tool.name)).length
  const titleText = mode === 'add' ? t('mcp.form.addTitle') : t('mcp.form.editTitle')
  // Rules are enforced by this plugin's own carriers, which only run for rows it
  // loads. A global row is mounted by the composition, so its tools are in every
  // request already and a rule could not hide them.
  const toolsReadOnly = mode === 'edit' ? server?.scope === 'global' : targetPlane === 'global'
  // A new row needs an addressable target, and which one is missing decides what
  // the form says: no preset in this composition, a preset that was not chosen
  // yet, or the global plane having no file to write.
  const agentTargetMissing = mode === 'add' && targetPlane === 'agent' && presetId === ''
  const globalTargetMissing = mode === 'add' && targetPlane === 'global' && !globalWritable
  const noTarget = agentTargetMissing || globalTargetMissing
  const noTargetReason = presetLoaded && presetOptions.length === 0 && !globalWritable
    ? t('mcp.form.noTarget')
    : globalTargetMissing ? t('mcp.global.unavailable') : t('mcp.form.noPreset')
  const showsCurrentPreset = presetId !== '' && !presetOptions.some(option => option.id === presetId)
  /** The plane this row is written to, as the dialog states it for an edited row. */
  const scopeLabel = mode === 'edit'
    ? (server?.scope === 'global' ? t('mcp.scopeGlobal') : `${t('mcp.scopePreset')} · ${server?.presetId ?? ''}`)
    : undefined
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titleText}
      closeLabel={t('mcp.form.close')}
      description={t('mcp.form.hint')}
      className={css.mcpEditorDialog ?? ''}
      contentClassName={css.mcpEditorContent ?? ''}
      footer={(
        <div className={css.formActions}>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('mcp.form.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => { void submit() }} disabled={formDisabled || noTarget}>
            {busy ? t('mcp.form.saving') : t('mcp.form.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.mcpForm}>
        {readOnlyRow ? <p className={css.fieldHint} role="status">{t(MCP_READ_ONLY_REASON[server.readOnly ?? 'composed-row'])}</p> : null}
        <SegmentedTabs<McpEditorTab>
          className={css.editorTabs}
          label={t('mcp.form.tabs')}
          value={tab}
          onChange={pickTab}
          items={[
            { value: 'config', label: t('mcp.form.tabConfig'), id: `${tabId}-config-tab`, panelId: `${tabId}-config-panel` },
            { value: 'credentials', label: t('mcp.credential.tab'), id: `${tabId}-credentials-tab`, panelId: `${tabId}-credentials-panel` },
            { value: 'tools', label: t('mcp.form.tabTools'), id: `${tabId}-tools-tab`, panelId: `${tabId}-tools-panel` },
          ]}
        />
        <div
          id={`${tabId}-config-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-config-tab`}
          className={css.editorPanel}
          hidden={tab !== 'config'}
        >
          {mode === 'add' ? (
            <>
              {/* A new row's target is a field of this form, not a property of the
                  page behind it: the page has no control that names a plane, so
                  deriving one from it left the global plane unreachable. */}
              <label className={css.formField}>
                <span className={css.formLabel}>{t('mcp.form.scope')}</span>
                <select
                  className={css.formSelect}
                  value={targetPlane}
                  disabled={formDisabled}
                  aria-label={t('mcp.form.scope')}
                  onChange={(event) => { setPlaneChoice(event.currentTarget.value as McpPlane); setLocalError(null) }}
                >
                  <option value="global" disabled={!globalWritable}>{t('mcp.scopeGlobal')}</option>
                  <option value="agent" disabled={presetOptions.length === 0}>{t('mcp.form.presetScope')}</option>
                </select>
                {globalWritable ? null : <span className={css.fieldHint}>{t('mcp.global.unavailable')}</span>}
              </label>
              {targetPlane === 'agent' ? (
                <label className={css.formField}>
                  <span className={css.formLabel}>{t('mcp.form.presetScope')}</span>
                  <select
                    className={css.formSelect}
                    value={presetId}
                    disabled={formDisabled}
                    aria-label={t('mcp.form.presetScope')}
                    onChange={(event) => { setPresetId(event.currentTarget.value); setLocalError(null) }}
                  >
                    {presetOptions.map(option => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                    {showsCurrentPreset ? <option value={presetId}>{presetId}</option> : null}
                  </select>
                </label>
              ) : null}
              {presetLoaded && noTarget ? <span className={css.fieldHint}>{noTargetReason}</span> : null}
            </>
          ) : (
            <label className={css.formField}>
              <span className={css.formLabel}>{t('mcp.form.scope')}</span>
              <span className={css.fieldHint}>{scopeLabel}</span>
            </label>
          )}
          <label className={css.formField}>
            <span className={css.formLabel}>{t('mcp.form.serverName')}</span>
            <Input value={title} disabled={formDisabled} aria-label={t('mcp.form.serverName')} onChange={(event) => { setTitle(event.currentTarget.value); setLocalError(null) }} />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>{t('mcp.form.description')}</span>
            <Input value={description} disabled={formDisabled} aria-label={t('mcp.form.description')} onChange={(event) => { setDescription(event.currentTarget.value); setLocalError(null) }} />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>{t('mcp.form.json')}</span>
            <textarea
              className={css.formJson}
              value={json}
              disabled={formDisabled}
              spellCheck={false}
              aria-label={t('mcp.form.json')}
              onChange={(event) => {
                jsonBox.current = event.currentTarget.value
                setJson(event.currentTarget.value)
                setLocalError(null)
              }}
            />
          </label>
          {loading ? <p className={css.mcpStatus}>{t('mcp.loading')}</p> : null}
        </div>
        <div
          id={`${tabId}-credentials-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-credentials-tab`}
          className={css.editorPanel}
          hidden={tab !== 'credentials'}
        >
          {loading
            ? <p className={css.mcpStatus}>{t('mcp.credential.busy')}</p>
            : (
              <>
                <McpCredentialsPane
                  json={json}
                  kind={credentialKind}
                  baseline={credentialBase}
                  disabled={formDisabled}
                  onPush={pushCredential}
                  t={t}
                />
                <span className={css.fieldHint}>{t('mcp.credential.hint')}</span>
              </>
            )}
        </div>
        <div
          id={`${tabId}-tools-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-tools-tab`}
          className={css.editorPanel}
          hidden={tab !== 'tools'}
        >
          <div className={css.toolsHead}>
            {tools !== null ? <span className={css.toolsCount}>{`${enabledCount}/${tools.length}`}</span> : null}
            <span className={css.toolsActions}>
              <Button
                variant="outline"
                size="sm"
                disabled={formDisabled || toolsBusy || toolsReadOnly}
                onClick={() => { loadToolsFromForm(tools === null) }}
              >
                {toolsBusy ? t('mcp.form.toolsLoading') : t('mcp.form.toolsReload')}
              </Button>
              {tools !== null && tools.length > 0 ? (
                <>
                  <Button variant="ghost" size="sm" disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set<string>()) }}>
                    {t('mcp.form.toolsAll')}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set(tools.map(tool => tool.name))) }}>
                    {t('mcp.form.toolsNone')}
                  </Button>
                </>
              ) : null}
            </span>
          </div>
          <span className={css.fieldHint}>{toolsReadOnly ? t('mcp.form.toolsGlobal') : t('mcp.form.toolsHint')}</span>
          {toolsError !== null ? <p className={css.formError} role="alert">{toolsError}</p> : null}
          {tools !== null && tools.length === 0 ? <p className={css.mcpStatus}>{t('mcp.form.toolsEmpty')}</p> : null}
          {tools !== null && tools.length > 0 ? (
            <div className={css.toolsList}>
              {tools.map(tool => (
                <label key={tool.name} className={css.toolRow} title={tool.description}>
                  <input
                    type="checkbox"
                    checked={!hiddenTools.has(tool.name)}
                    disabled={formDisabled || toolsReadOnly}
                    aria-label={tool.name}
                    onChange={() => { toggleTool(tool.name) }}
                  />
                  <span className={css.toolName}>{tool.name}</span>
                  {tool.description === '' ? null : <span className={css.toolDesc}>{tool.description}</span>}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        {localError !== null ? <p className={css.formError} role="alert">{localError}</p> : null}
        {configNotice !== null ? <p className={css.mcpNotice} role="status">{configNotice}</p> : null}
        {error !== null ? <p className={css.formError} role="alert">{`${t('mcp.form.saveFailed')} ${error}`}</p> : null}
      </div>
    </Modal>
  )
}
