import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AddMcpRequest,
  DescribeMcpRequest,
  DescribeMcpResult,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  McpSpec,
  McpToolRow,
} from '../types.ts'
import { admits, parseMcpToolFilter } from '../mcp-tool-filter.ts'
import { flattenSpec, parseSpecText } from '../mcp-spec.ts'
import type { McpSectionKey } from './locales.ts'
import type { McpPresetOption, McpServer } from './settings-controller.ts'
import css from './McpSection.module.css'

/** Localized `t` bound to this section's dictionary namespace. */
type Translate = (key: McpSectionKey) => string

/** Whether the editor is creating a row or replacing one. */
export type McpEditorMode = 'add' | 'edit'

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
   * Localized reason the global plane refuses writes. Present when the Host
   * cannot persist a global row, which makes the global option unusable rather
   * than failing the save after the user filled the form in.
   */
  readonly globalProblemReason?: string
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

/** The connection-spec JSON prefilled in the box (no scope/title — those are fields). */
function specJson(describe: DescribeMcpResult | undefined): string {
  const spec = describe?.spec ?? { type: 'stdio', command: '', args: [], env: {} }
  return JSON.stringify(flattenSpec(spec), null, 2)
}

/** Modal editor: one scope dropdown, title/description fields, a JSON spec box, and the tool list. */
export function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, globalProblemReason, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }: McpEditorProps): ReactNode {
  const [scopeValue, setScopeValue] = useState(server?.scope === 'preset' ? server.presetId ?? '' : '')
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

  useEffect(() => {
    if (!open) return
    let current = true
    setLocalError(null)
    setScopeValue(server?.scope === 'preset' ? server.presetId ?? '' : '')
    setTitle(server?.serverName ?? '')
    setDescription(descriptionInitial)
    setTools(null)
    setHiddenTools(new Set<string>())
    setToolsError(null)
    setToolsBusy(false)
    void presets().then(
      (list) => { if (current) setPresetOptions(list) },
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
          loadTools(described.spec, described.serverName, true)
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
      if (globalUnavailable && scopeValue === '') throw new Error(globalProblemReason ?? t('unavailable'))
      const target = scopeValue === ''
        ? { scope: 'global' as const }
        : { scope: 'preset' as const, agentPreset: scopeValue }
      const entryId = mode === 'edit' ? server?.entryId ?? '' : undefined
      if (mode === 'edit' && entryId === '') throw new Error(t('mcp.form.required'))
      const request: McpEditorRequest = {
        target,
        serverName,
        spec,
        ...(entryId === undefined ? {} : { entryId }),
      } as McpEditorRequest
      onSubmit(request)
      const key = rowKey(scopeValue === '' ? 'global' : 'preset', scopeValue, serverName)
      if (description.trim() !== '') onUpdateDescription(key, description.trim())
      // Only a listing the user actually saw may rewrite the rules; a server
      // that never answered leaves the stored rules exactly as they were.
      if (tools !== null) {
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
  const showsCurrentPreset = scopeValue !== '' && !presetOptions.some(option => option.id === scopeValue)
  // A read-only global plane is offered but not selectable in add mode: the
  // reason is shown under the field so the user picks a preset instead of
  // discovering the refusal when the save fails.
  const globalUnavailable = mode === 'add' && globalProblemReason !== undefined
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={titleText}
      closeLabel={t('mcp.form.close')}
      description={t('mcp.form.hint')}
      contentClassName={css.mcpEditorContent ?? ''}
      footer={(
        <div className={css.formActions}>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>{t('mcp.form.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={formDisabled}>
            {busy ? t('mcp.form.saving') : t('mcp.form.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.mcpForm}>
        <label className={css.formField}>
          <span className={css.formLabel}>{t('mcp.form.scope')}</span>
          <select
            className={css.formSelect}
            value={scopeValue}
            disabled={formDisabled || mode === 'edit'}
            aria-label={t('mcp.form.scope')}
            onChange={(event) => { setScopeValue(event.currentTarget.value); setLocalError(null) }}
          >
            <option value="" disabled={globalUnavailable}>{globalUnavailable ? t('mcp.scopeGlobalReadOnly') : t('mcp.scopeGlobal')}</option>
            {presetOptions.map(option => (
              <option key={option.id} value={option.id}>{option.name}</option>
            ))}
            {showsCurrentPreset ? <option value={scopeValue}>{scopeValue}</option> : null}
          </select>
          {globalUnavailable ? <span className={css.fieldHint}>{globalProblemReason}</span> : null}
        </label>
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
        <div className={css.formField}>
          <span className={css.toolsHead}>
            <span className={css.formLabel}>{t('mcp.form.tools')}</span>
            {tools !== null ? <span className={css.toolsCount}>{`${enabledCount}/${tools.length}`}</span> : null}
            <span className={css.toolsActions}>
              <button
                type="button"
                className={css.mcpAction}
                disabled={formDisabled || toolsBusy}
                onClick={() => {
                  try {
                    const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
                    const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
                    loadTools(parsed.spec, serverName, tools === null)
                  } catch (cause) {
                    setToolsError(cause instanceof Error ? cause.message : t('mcp.form.jsonInvalid'))
                  }
                }}
              >
                {toolsBusy ? t('mcp.form.toolsLoading') : t('mcp.form.toolsReload')}
              </button>
              {tools !== null && tools.length > 0 ? (
                <>
                  <button type="button" className={css.mcpAction} disabled={formDisabled} onClick={() => { setHiddenTools(new Set<string>()) }}>
                    {t('mcp.form.toolsAll')}
                  </button>
                  <button type="button" className={css.mcpAction} disabled={formDisabled} onClick={() => { setHiddenTools(new Set(tools.map(tool => tool.name))) }}>
                    {t('mcp.form.toolsNone')}
                  </button>
                </>
              ) : null}
            </span>
          </span>
          <span className={css.fieldHint}>{t('mcp.form.toolsHint')}</span>
          {toolsError !== null ? <p className={css.formError} role="alert">{toolsError}</p> : null}
          {tools !== null && tools.length === 0 ? <p className={css.mcpStatus}>{t('mcp.form.toolsEmpty')}</p> : null}
          {tools !== null && tools.length > 0 ? (
            <div className={css.toolsList}>
              {tools.map(tool => (
                <label key={tool.name} className={css.toolRow} title={tool.description}>
                  <input
                    type="checkbox"
                    checked={!hiddenTools.has(tool.name)}
                    disabled={formDisabled}
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
        {loading ? <p className={css.mcpStatus}>{t('mcp.loading')}</p> : null}
        {localError !== null ? <p className={css.formError} role="alert">{localError}</p> : null}
        {error !== null ? <p className={css.formError} role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
