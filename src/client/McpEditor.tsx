import { useEffect, useId, useState, type ReactNode } from 'react'
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
import { flattenSpec, parseSpecText } from '../mcp-spec.ts'
import type { McpSectionKey } from './locales.ts'
import type { McpPlane, McpPresetOption, McpServer } from './settings-controller.ts'
import css from './McpSection.module.css'

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = (key: McpSectionKey) => string

/** Whether the editor is creating a row or replacing one. */
export type McpEditorMode = 'add' | 'edit'

/** The editor's two panes: the connection row's own fields, and its tools. */
type McpEditorTab = 'config' | 'tools'

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
   * The plane the section currently shows. A new row is written there, so the
   * dialog offers no scope choice: the tab already made it.
   */
  readonly plane: McpPlane
  readonly descriptionInitial: string
  readonly onUpdateDescription: (key: string, value: string) => void
  /** Tool rules this row currently carries, as stored entries. */
  readonly toolRulesInitial: readonly string[]
  /** Persist the row's tool rules; an empty list clears them. */
  readonly onUpdateTools: (key: string, patterns: readonly string[]) => void
  readonly t: Translate
  readonly onClose: () => void
  readonly onSubmit: (request: McpEditorRequest) => void
}

/** Settings key for one row (`global:<name>` or `preset:<id>:<name>`), shared with the Host's `mcpRowKey`. */
function rowKey(scope: 'global' | 'preset', agentPreset: string, serverName: string): string {
  return scope === 'preset' ? `preset:${agentPreset}:${serverName}` : `global:${serverName}`
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

/** Modal editor split into a pane for the row's fields and a pane for its tools. */
export function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, plane, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }: McpEditorProps): ReactNode {
  const [tab, setTab] = useState<McpEditorTab>('config')
  const tabId = useId()
  /** Chosen agent preset for a new row; a placeholder while the list loads. */
  const [presetId, setPresetId] = useState(server?.scope === 'preset' ? server.presetId ?? '' : '')
  const [presetOptions, setPresetOptions] = useState<readonly McpPresetOption[]>([])
  const [title, setTitle] = useState(server?.serverName ?? '')
  const [description, setDescription] = useState(descriptionInitial)
  const [json, setJson] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [tools, setTools] = useState<readonly McpToolRow[] | null>(null)
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [toolsBusy, setToolsBusy] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const editKey = `${server?.scope ?? ''}:${server?.presetId ?? ''}:${server?.entryId ?? ''}`

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
    setTab('config')
    setPresetId(server?.scope === 'preset' ? server.presetId ?? '' : '')
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
        // A new agent row needs a preset to address; the first one is the only
        // sensible default, and the field lets the user change it.
        setPresetId((previous) => previous !== '' ? previous : (mode === 'add' ? list[0]?.id ?? '' : ''))
      },
      () => { if (current) setPresetOptions([]) },
    )
    if (mode === 'edit' && server?.entryId) {
      setLoading(true)
      const target = server.scope === 'global'
        ? { scope: 'global' as const }
        : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
      void describeMcp({ target, entryId: server.entryId }).then(
        (described) => {
          if (!current) return
          setJson(specJson(described))
          setLoading(false)
        },
        () => { if (current) { setJson(specJson(undefined)); setLoading(false) } },
      )
    } else {
      setJson(specJson(undefined))
    }
    return () => { current = false }
  }, [editKey, mode, open, server, descriptionInitial, presets, t])

  const submit = (): void => {
    try {
      const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
      const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
      if (serverName === '') throw new Error(t('mcp.form.required'))
      const spec = parsed.spec
      const target = editorTarget(mode, server, plane, presetId)
      if (target === undefined) throw new Error(t('mcp.form.noPreset'))
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
      if (description.trim() !== '') onUpdateDescription(key, description.trim())
      // Only a listing the user actually saw may rewrite the rules; a server
      // that never answered leaves the stored rules exactly as they were. A
      // global row never lists one, because its rules cannot take effect.
      if (tools !== null && !toolsReadOnly) {
        onUpdateTools(key, tools.filter(tool => hiddenTools.has(tool.name)).map(tool => `!${tool.name}`))
      }
    } catch (cause) {
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

  const formDisabled = disabled || busy
  const enabledCount = tools === null ? 0 : tools.length - tools.filter(tool => hiddenTools.has(tool.name)).length
  const titleText = mode === 'add' ? t('mcp.form.addTitle') : t('mcp.form.editTitle')
  // Rules are enforced by this plugin's own carriers, which only run for rows it
  // loads. A global row is mounted by the composition, so its tools are in every
  // request already and a rule could not hide them.
  const toolsReadOnly = mode === 'edit' ? server?.scope === 'global' : plane === 'global'
  // A new agent row needs a preset to address; with none mounted the save is
  // refused here rather than at the Host, which would report it per request.
  const noPreset = mode === 'add' && plane === 'agent' && presetId === ''
  const showsCurrentPreset = presetId !== '' && !presetOptions.some(option => option.id === presetId)
  /** The plane this row is written to, as the dialog states it. */
  const scopeLabel = mode === 'edit'
    ? (server?.scope === 'global' ? t('mcp.scopeGlobal') : `${t('mcp.scopePreset')} · ${server?.presetId ?? ''}`)
    : (plane === 'global' ? t('mcp.scopeGlobal') : undefined)
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
          <Button variant="primary" size="sm" onClick={submit} disabled={formDisabled || noPreset}>
            {busy ? t('mcp.form.saving') : t('mcp.form.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.mcpForm}>
        <SegmentedTabs<McpEditorTab>
          className={css.editorTabs}
          label={t('mcp.form.tabs')}
          value={tab}
          onChange={pickTab}
          items={[
            { value: 'config', label: t('mcp.form.tabConfig'), id: `${tabId}-config-tab`, panelId: `${tabId}-config-panel` },
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
          {scopeLabel !== undefined ? (
            <label className={css.formField}>
              <span className={css.formLabel}>{t('mcp.form.scope')}</span>
              <span className={css.fieldHint}>{scopeLabel}</span>
            </label>
          ) : (
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
              {noPreset ? <span className={css.fieldHint}>{t('mcp.form.noPreset')}</span> : null}
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
              onChange={(event) => { setJson(event.currentTarget.value); setLocalError(null) }}
            />
          </label>
          {loading ? <p className={css.mcpStatus}>{t('mcp.loading')}</p> : null}
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
              <button
                type="button"
                className={css.mcpAction}
                disabled={formDisabled || toolsBusy || toolsReadOnly}
                onClick={() => { loadToolsFromForm(tools === null) }}
              >
                {toolsBusy ? t('mcp.form.toolsLoading') : t('mcp.form.toolsReload')}
              </button>
              {tools !== null && tools.length > 0 ? (
                <>
                  <button type="button" className={css.mcpAction} disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set<string>()) }}>
                    {t('mcp.form.toolsAll')}
                  </button>
                  <button type="button" className={css.mcpAction} disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set(tools.map(tool => tool.name))) }}>
                    {t('mcp.form.toolsNone')}
                  </button>
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
        {error !== null ? <p className={css.formError} role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
