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
import { flattenSpec, parseSpecText, serverNameFromSpec } from '../mcp-spec.ts'
import {
  credentialText,
  credentialValues,
  mergeCredentialEdits,
  type CredentialKind,
} from './credential-fields.ts'
import { formatMcpConfigIssues } from './config-issues.ts'
import { McpTargetSelect, initialTarget } from './McpTargetSelect.tsx'
import { MCP_READ_ONLY_REASON, type McpSectionKey } from './locales.ts'
import type { McpGlobalEnableOutcome, McpPlane, McpPresetOption, McpServer } from './settings-controller.ts'
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
  /** Presets the roster read already returned; the dialog never fetches again. */
  readonly presets: readonly McpPresetOption[]
  readonly presetName: (preset: McpPresetOption) => string
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
   * Whether the Host can create that file, which it does when the profile mounts
   * no writable Include of its own. Choosing the global target then asks the Host
   * to create it instead of leaving the plane unreachable.
   */
  readonly globalCreatable: boolean
  /** Ask the Host to create the global Include; resolves how it ended. */
  readonly onEnableGlobal: () => Promise<McpGlobalEnableOutcome>
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
 * The composition a save addresses: an edited row keeps its own plane, and a new
 * row goes to the home its picker names. Undefined when the edited row has no
 * addressable entry.
 * @param mode - whether the dialog creates a row or replaces one.
 * @param server - the row being edited, when there is one.
 * @param choice - a new row's home: `''` for the global plane, else a preset id.
 * @returns the target to write, or undefined when there is none.
 */
function editorTarget(
  mode: McpEditorMode,
  server: McpServer | undefined,
  choice: string,
): McpTarget | undefined {
  if (mode === 'edit') {
    if (server === undefined || server.entryId === null) return undefined
    return server.scope === 'global'
      ? { scope: 'global' }
      : { scope: 'preset', agentPreset: server.presetId ?? '' }
  }
  return choice === '' ? { scope: 'global' } : { scope: 'preset', agentPreset: choice }
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
  return (
    <div className={css.formField}>
      <span className={css.formLabel}>{label}</span>
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
export function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, presetName, plane, tab: openTab, globalWritable, globalCreatable, onEnableGlobal, preset, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }: McpEditorProps): ReactNode {
  const [tab, setTab] = useState<McpEditorTab>(openTab)
  const tabId = useId()
  /**
   * A new row's home, as this dialog's own field: the empty value is the global
   * plane, any other value a preset id. An edited row's home is never this field
   * — it keeps its own plane — so the value only decides an add.
   */
  const [choice, setChoice] = useState(initialTarget(plane, preset))
  /**
   * Whether this dialog's own creation call opened the global plane. The section
   * re-reads the roster afterwards, but the answer has to hold in this form even
   * before that read lands, so the dialog keeps it too.
   */
  const [globalEnabled, setGlobalEnabled] = useState(false)
  const [enablingGlobal, setEnablingGlobal] = useState(false)
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
  /**
   * Whether the user has named the row themselves.
   *
   * The name is derivable from the spec (`@scope/pkg` → `pkg`), so a new row is
   * named as soon as its JSON says what it is. Typing in the field takes the name
   * back: from then on the JSON never touches it again.
   */
  const nameTouched = useRef(false)
  const [localError, setLocalError] = useState<string | null>(null)
  /**
   * What is wrong with the JSON box, if anything, shown under the box itself.
   *
   * A document that cannot be read is the one failure the user can fix right
   * there, so its reason sits beside the field rather than on the form's shared
   * error line at the bottom of the dialog.
   */
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [configNotice, setConfigNotice] = useState<string | null>(null)
  const [probe, setProbe] = useState<
    | { readonly status: 'pending' }
    | { readonly status: 'success'; readonly count: number; readonly local: boolean }
    | { readonly status: 'failed'; readonly reason: string }
    | null
  >(null)
  /** Only the current form's request may publish feedback; also guards same-tick clicks. */
  const probeRun = useRef<object | null>(null)
  const resetProbe = (): void => {
    probeRun.current = null
    setProbe(null)
  }
  const close = (): void => {
    resetProbe()
    onClose()
  }
  const [loading, setLoading] = useState(false)
  /** Why the row's current configuration could not be read, if it could not. */
  const [describeError, setDescribeError] = useState<string | null>(null)
  /** The describe request this form is waiting on; a late answer is ignored. */
  const describeRun = useRef<object | null>(null)
  /** The tools tab was requested while the initial describe was still running. */
  const pendingTools = useRef(false)
  /** Only the newest tool listing may publish its answer into this form. */
  const loadRun = useRef<object | null>(null)
  /**
   * What the rendered listing was taken for, so opening the pane again after the
   * form changed lists again instead of showing a listing that no longer
   * describes the row.
   */
  const listedFor = useRef<string | null>(null)
  const [tools, setTools] = useState<readonly McpToolRow[] | null>(null)
  const [hiddenTools, setHiddenTools] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [toolsBusy, setToolsBusy] = useState(false)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const editKey = `${server?.scope ?? ''}:${server?.presetId ?? ''}:${server?.entryId ?? ''}`
  /** The credential map this row's transport carries; `env` until the transport is known. */
  const credentialKind: CredentialKind = (() => {
    try {
      const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
      return parsed.spec.type === 'stdio' ? 'env' : 'headers'
    } catch { return 'env' }
  })()

  /**
   * Name a new row from the spec it describes, while the user has not named it.
   *
   * The name is the one field of this form the JSON already answers — a spec's
   * `args`/`url` imply it — so asking for it before the paste is asking for
   * something the dialog can fill in. An edited row keeps its own name: renaming
   * it is a deliberate act, not a side effect of touching the JSON.
   * @param text - the JSON box's current text.
   */
  const syncName = (text: string): void => {
    if (mode !== 'add' || nameTouched.current) return
    try {
      const parsed = parseSpecText(text, t('mcp.form.jsonInvalid'))
      // A document that names itself wins; otherwise the launch command (or the
      // URL's host) is what the name is derived from.
      const suggested = parsed.serverName ?? serverNameFromSpec(parsed.spec)
      // A half-typed document names nothing yet; the field keeps what it has.
      if (suggested !== '') setTitle(suggested)
    } catch { /* unparseable text has no name to offer */ }
  }

  /**
   * Apply one credential field to the JSON box, which is the document the save
   * reads. A box this pane cannot parse or write leaves the field as it was: the
   * config pane is where a broken document gets fixed.
   */
  const pushCredential = (kind: CredentialKind, key: string, value: string): void => {
    const next = credentialText(jsonBox.current, kind, key, value)
    if (next === undefined) return
    resetProbe()
    jsonBox.current = next
    setJson(next)
    syncName(next)
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
   *   dialog's first listing); a later listing of the same row keeps the user's
   *   own choices and treats tools it has not seen before as enabled.
   */
  const loadTools = (spec: McpSpec, serverName: string, fromRules: boolean): void => {
    if (serverName.trim() === '') {
      setToolsError(t('mcp.form.toolsNeedsName'))
      return
    }
    setToolsBusy(true)
    setToolsError(null)
    const run = {}
    loadRun.current = run
    void listMcpTools({ spec, serverName }).then(
      (result) => {
        // A late answer from another row (or an older form state) must not
        // publish its tools or its rule seeds into this form.
        if (loadRun.current !== run) return
        setTools(result.tools)
        // What this listing describes, so returning to the pane can tell whether
        // the form has moved on since.
        listedFor.current = listingKey(serverName, spec)
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
        if (loadRun.current !== run) return
        setToolsError(cause instanceof Error ? cause.message : String(cause))
        setToolsBusy(false)
      },
    )
  }

  /**
   * The identity of one listing: the namespace and the spec it was taken for.
   * @param serverName - namespace the listing used.
   * @param spec - transport the listing connected with.
   * @returns the key two listings are compared by.
   */
  const listingKey = (serverName: string, spec: McpSpec): string => {
    // Credentials do not change which tools a server publishes, so editing an
    // env value must not invalidate the listing the user is looking at. The
    // launch command / URL does.
    const identity = spec.type === 'stdio'
      ? JSON.stringify([spec.type, spec.command, spec.args ?? [], spec.cwd ?? ''])
      : JSON.stringify([spec.type, spec.url])
    return `${serverName}\u0000${identity}`
  }

  /**
   * The reason the JSON box cannot be used, or null when it describes a usable
   * connection.
   *
   * The two levels the save checks, and nothing else: whether the document
   * parses, and whether the transport it describes is structurally complete. A
   * missing server name is not this box's business, and what only the Host can
   * answer (whether a `${...}` reference resolves) stays with the roster.
   * @param text - the JSON box's current text.
   * @returns the localized reason, or null when the box is usable.
   */
  const jsonProblem = (text: string): string | null => {
    try {
      const parsed = parseSpecText(text, t('mcp.form.jsonInvalid'))
      const blocking = diagnoseMcpSpec(parsed.spec, {}).filter(isBlockingConfigIssue)
      return blocking.length === 0 ? null : formatMcpConfigIssues(blocking, t)
    } catch (cause) {
      return cause instanceof Error ? cause.message : t('mcp.form.jsonInvalid')
    }
  }

  /** Probe the unsaved connection without admitting tools or saving the MCP row. */
  const probeConnection = async (): Promise<void> => {
    if (!open || mode !== 'add' || formDisabled || loading || probeRun.current !== null) return
    resetProbe()
    setLocalError(null)
    const problem = jsonProblem(jsonBox.current)
    setJsonError(problem)
    if (problem !== null) return
    const parsed = parseSpecText(jsonBox.current, t('mcp.form.jsonInvalid'))
    const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
    if (serverName === '') {
      setLocalError(t('mcp.form.required'))
      return
    }
    const run = {}
    probeRun.current = run
    setProbe({ status: 'pending' })
    try {
      const result = await listMcpTools({ spec: parsed.spec, serverName })
      if (probeRun.current !== run) return
      setProbe({ status: 'success', count: result.tools.length, local: parsed.spec.type === 'stdio' })
    } catch (cause) {
      if (probeRun.current !== run) return
      setProbe({ status: 'failed', reason: cause instanceof Error ? cause.message : String(cause) })
    } finally {
      if (probeRun.current === run) probeRun.current = null
    }
  }

  /**
   * The spec and namespace the form currently describes, or null when there is
   * nothing to list.
   *
   * A box that cannot be read is reported beside itself and the pane holding it
   * comes back into view — a connection error about a spec that was never
   * readable would name the wrong thing. A row with no name yet says so in this
   * pane, because the name is the pane's own requirement.
   * @returns what a listing would connect with, or null when it cannot start.
   */
  const listingTarget = (text = json): { spec: McpSpec; serverName: string } | null => {
    const problem = jsonProblem(text)
    if (problem !== null) {
      setJsonError(problem)
      setTab('config')
      return null
    }
    const parsed = parseSpecText(text, t('mcp.form.jsonInvalid'))
    const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
    if (serverName === '') {
      setToolsError(t('mcp.form.toolsNeedsName'))
      return null
    }
    return { spec: parsed.spec, serverName }
  }

  /**
   * List the tools of the spec the form currently shows. The JSON box is the
   * source, so an edited command or url is listed as edited.
   * @param fromRules - seed the checkboxes from the row's stored rules.
   */
  const loadToolsFromForm = (fromRules: boolean, text = json): void => {
    const target = listingTarget(text)
    if (target === null) return
    loadTools(target.spec, target.serverName, fromRules)
  }

  /**
   * Opening the tools pane triggers its own listing: connecting spawns a child
   * process for stdio rows, and a row the user only renames never needs one.
   * There is no load button in this pane, so it opens on what the form describes —
   * and lists again when the form changed since the listing it already has.
   * `tools` stays null until a listing was actually shown, which is what keeps
   * the save from rewriting the stored rules with an empty set.
   */
  const pickTab = (next: McpEditorTab): void => {
    setTab(next)
    if (next !== 'tools') return
    // A global row's rules could not take effect, so listing its tools would spawn
    // a connection for a pane the user cannot use.
    if (toolsReadOnly) return
    if (describeError !== null) return
    if (loading) {
      // The initial describe is still running: open the pane immediately and
      // list once the row's real configuration has been read. There is no load
      // button to press in the meantime.
      pendingTools.current = true
      return
    }
    if (toolsBusy) return
    if (tools === null) {
      loadToolsFromForm(true)
      return
    }
    // A listing of the same spec stays as it is: re-listing on every visit would
    // connect for a pane whose answer cannot have changed.
    const problem = jsonProblem(json)
    if (problem !== null) return
    const parsed = parseSpecText(json, t('mcp.form.jsonInvalid'))
    const serverName = (title.trim() !== '' ? title.trim() : parsed.serverName ?? '').trim()
    if (listedFor.current === listingKey(serverName, parsed.spec)) return
    loadTools(parsed.spec, serverName, false)
  }

  /**
   * Read one edited row's configuration again.
   *
   * A rejected read must not leave a blank stdio skeleton looking like the
   * row's real configuration: the failure is reported, saving is closed, and
   * the user can retry. The dialog itself is never a place to guess the row.
   */
  const describeServer = (): void => {
    if (mode !== 'edit' || server === undefined || server.entryId === null) return
    const entryId = server.entryId
    const target = server.scope === 'global'
      ? { scope: 'global' as const }
      : { scope: 'preset' as const, agentPreset: server.presetId ?? '' }
    const run = {}
    describeRun.current = run
    pendingTools.current = false
    setLoading(true)
    setDescribeError(null)
    setTools(null)
    listedFor.current = null
    setToolsError(null)
    void describeMcp({ target, entryId }).then(
      (described) => {
        if (describeRun.current !== run) return
        const text = specJson(described)
        jsonBox.current = text
        setJson(text)
        // The credentials pane records the document it opened with, so a save
        // writes back only the fields the user changed.
        setCredentialBase(text)
        // The config's own serverName is authoritative when the row id and the
        // namespace differ (a row renamed in its composition); the roster's
        // name is built from the id.
        if (!nameTouched.current) setTitle(described.serverName)
        setLoading(false)
        // The tools tab was opened during the read; there is no load button to
        // press afterwards, so the listing starts now.
        if (pendingTools.current) {
          pendingTools.current = false
          loadTools(described.spec, described.serverName, true)
        }
      },
      (cause: unknown) => {
        if (describeRun.current !== run) return
        jsonBox.current = ''
        setJson('')
        setCredentialBase('')
        setLoading(false)
        pendingTools.current = false
        setDescribeError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  useEffect(() => {
    resetProbe()
    if (!open) return
    setLocalError(null)
    setJsonError(null)
    setConfigNotice(null)
    // The pane this dialog opens on: the row's own button asks for its
    // credentials, and everything else asks for the config. The dialog stays
    // mounted while it is closed, so the pane cannot come from the state
    // initializer alone — it has to be applied on every open.
    setTab(openTab)
    // A new row opens on the home the caller started the dialog from — its own
    // plane, or the preset the list was narrowed to, which is the one the section
    // will write into. Losing that here left the picker on the first preset, so a
    // row landed somewhere the user was not looking. `preset` is deliberately not
    // a dependency: the list can refresh while this dialog is open, and re-running
    // this effect would reset the form under the user.
    setChoice(initialTarget(plane, preset))
    setGlobalEnabled(false)
    setEnablingGlobal(false)
    nameTouched.current = false
    setTitle(server?.serverName ?? '')
    setDescription(descriptionInitial)
    setTools(null)
    listedFor.current = null
    setHiddenTools(new Set<string>())
    setToolsError(null)
    setToolsBusy(false)
    setDescribeError(null)
    setLoading(false)
    describeRun.current = null
    loadRun.current = null
    pendingTools.current = false
    if (mode === 'edit' && server?.entryId) {
      describeServer()
    } else if (mode === 'edit') {
      // A row without an id cannot be read or saved; never present a blank
      // skeleton as if it were the row's configuration.
      jsonBox.current = ''
      setJson('')
      setCredentialBase('')
      setDescribeError(t('mcp.error.unaddressable'))
    } else {
      const text = specJson(undefined)
      jsonBox.current = text
      setJson(text)
      setCredentialBase(text)
    }
    return () => {
      probeRun.current = null
      describeRun.current = null
      loadRun.current = null
    }
    // `descriptionInitial` is deliberately not a dependency: a failed row save
    // can still have persisted the description, and re-running this effect then
    // would throw away the title and JSON the user is editing.
  }, [editKey, mode, open, openTab, server])

  // A new row needs one addressable home. The roster can land after the dialog
  // opens, so the choice falls back to the first declared preset when the list
  // becomes available, without re-running the form reset above.
  useEffect(() => {
    if (!open || mode !== 'add') return
    setChoice((previous) => {
      if (previous !== '' || presets.length === 0) return previous
      return plane === 'global' && globalWritable ? previous : presets[0]?.id ?? previous
    })
  }, [open, mode, plane, globalWritable, presets])

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
      const target = editorTarget(mode, server, choice)
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
      // An emptied description removes the stored entry (the Host deletes the
      // key); otherwise the old value would come straight back.
      if (description.trim() !== '' || descriptionInitial !== '') {
        await onUpdateDescription(key, description.trim())
      }
      // Only a listing the user actually saw for THIS row and spec may rewrite
      // the rules; a server that never answered leaves the stored rules exactly
      // as they were, and a late answer from a previous row cannot write here.
      if (tools !== null && !toolsReadOnly && listedFor.current === listingKey(serverName, spec)) {
        await onUpdateTools(key, tools.filter(tool => hiddenTools.has(tool.name)).map(tool => `!${tool.name}`))
      }
    } catch (cause) {
      // Everything this catch reports is about the connection spec, so the pane
      // that holds the JSON box comes back into view: the message sits next to
      // the field it names instead of behind the tools tab.
      setTab('config')
      // A document that cannot be used is reported beside the box; what is left
      // (a missing name, an unaddressable target) stays on the form's own line.
      const fromJson = jsonProblem(mergeCredentials(json))
      if (fromJson === null) setLocalError(cause instanceof Error ? cause.message : t('mcp.form.jsonInvalid'))
      else { setJsonError(fromJson); setLocalError(null) }
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
  const unaddressableRow = mode === 'edit' && server !== undefined && server.entryId === null
  const readOnlyRow = unaddressableRow || (mode === 'edit' && server !== undefined && !server.writable)
  const formDisabled = disabled || busy || readOnlyRow
  const enabledCount = tools === null ? 0 : tools.length - tools.filter(tool => hiddenTools.has(tool.name)).length
  /**
   * What the current checkboxes cost a request: the definitions that stay in it,
   * and the ones the rules would keep out. Both are the same local estimate the
   * per-tool numbers use, summed.
   */
  const loadedTokens = tools === null
    ? 0
    : tools.reduce((sum, tool) => sum + (hiddenTools.has(tool.name) ? 0 : tool.tokens), 0)
  const droppedTokens = tools === null
    ? 0
    : tools.reduce((sum, tool) => sum + (hiddenTools.has(tool.name) ? tool.tokens : 0), 0)
  const titleText = mode === 'add' ? t('mcp.form.addTitle') : t('mcp.form.editTitle')
  // Rules are enforced by this plugin's own carriers, which only run for rows it
  // loads. A global row is mounted by the composition, so its tools are in every
  // request already and a rule could not hide them.
  const toolsReadOnly = mode === 'edit' ? server?.scope === 'global' : choice === ''
  /** The global plane after this dialog's own creation call, before the roster re-read lands. */
  const globalWritableNow = globalWritable || globalEnabled
  /**
   * Whether the picker may name the global plane.
   *
   * The Host can create the missing file only when the profile mounts no
   * writable Include of its own (`globalCreatable`); a composition with several
   * Includes or an unreadable one stays closed. Choosing the global entry is what
   * triggers the creation, so the entry is offered when the Host can act on it.
   */
  const globalSelectable = globalWritableNow || globalCreatable
  // The only home a new row can fail to have is the global plane with no file to
  // write: a preset id in the picker always names an addressable preset.
  const noTarget = mode === 'add' && choice === '' && !globalWritableNow
  const noTargetReason = presets.length === 0
    ? t('mcp.form.noTarget')
    : t('mcp.global.unavailable')
  /**
   * Switch a new row's home. Choosing the still-closed global plane first asks
   * the Host to create the file it needs — that call is the fix for the closed
   * plane, so the picker does not have to send the user to a second control.
   * @param next - the chosen home; the empty value is the global plane.
   */
  const pickTarget = async (next: string): Promise<void> => {
    setLocalError(null)
    if (next !== '' || globalWritableNow) {
      setChoice(next)
      return
    }
    if (!globalCreatable || enablingGlobal) return
    setEnablingGlobal(true)
    try {
      const outcome = await onEnableGlobal()
      if (outcome === 'ready') {
        setGlobalEnabled(true)
        setChoice('')
      } else if (outcome === 'pending') {
        setLocalError(t('mcp.global.createdPending'))
      }
    } finally {
      setEnablingGlobal(false)
    }
  }
  /** The plane this row is written to, as the dialog states it for an edited row. */
  const scopeLabel = mode === 'edit'
    ? (server?.scope === 'global' ? t('mcp.scopeGlobal') : `${t('mcp.scopePreset')} · ${presetName(presets.find(preset => preset.id === server?.presetId) ?? { id: server?.presetId ?? '' })}`)
    : undefined
  return (
    <Modal
      open={open}
      onClose={close}
      title={titleText}
      closeLabel={t('mcp.form.close')}
      description={t('mcp.form.hint')}
      className={css.mcpEditorDialog ?? ''}
      contentClassName={css.mcpEditorContent ?? ''}
      footer={(
        <div className={css.formActions}>
          <Button variant="outline" size="sm" onClick={close} disabled={busy}>{t('mcp.form.cancel')}</Button>
          <Button variant="primary" size="sm" onClick={() => { void submit() }} disabled={formDisabled || noTarget || loading || describeError !== null}>
            {busy ? t('mcp.form.saving') : t('mcp.form.save')}
          </Button>
        </div>
      )}
    >
      <div className={css.mcpForm}>
        {readOnlyRow ? (
          <p className={css.fieldHint} role="status">
            {unaddressableRow ? t('mcp.error.unaddressable') : t(MCP_READ_ONLY_REASON[server.readOnly ?? 'composed-row'])}
          </p>
        ) : null}
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
              {/* A new row's home is a field of this form, not a property of the
                  page behind it: the page has no control that names a plane, so
                  deriving one from it left the global plane unreachable. The one
                  picker names the whole home, because a row lives in exactly one
                  of the two and a second field answering "which preset" while the
                  first said "global" was the same question twice. */}
              <label className={css.formField}>
                <McpTargetSelect
                  label={t('mcp.form.scope')}
                  value={choice}
                  presets={presets}
                  presetName={presetName}
                  globalSelectable={globalSelectable}
                  disabled={formDisabled || enablingGlobal}
                  onChange={(next) => { void pickTarget(next) }}
                  t={t}
                />
              </label>
              {globalWritableNow ? null : globalCreatable
                ? (
                  <span className={css.fieldHint}>
                    {enablingGlobal ? t('mcp.global.enabling') : t('mcp.global.selectCreates')}
                  </span>
                )
                : <span className={css.fieldHint}>{noTargetReason}</span>}
            </>
          ) : (
            <label className={css.formField}>
              <span className={css.formLabel}>{t('mcp.form.scope')}</span>
              <span className={css.fieldHint}>{scopeLabel}</span>
            </label>
          )}
          <label className={css.formField}>
            <span className={css.formLabel}>
              {t('mcp.form.serverName')}
              <span className={css.requiredMark} aria-hidden="true">*</span>
            </span>
            <Input
              value={title}
              disabled={formDisabled}
              aria-label={t('mcp.form.serverName')}
              aria-required="true"
              onChange={(event) => {
                // A name the user typed is theirs: the JSON no longer refills it.
                nameTouched.current = true
                resetProbe()
                setTitle(event.currentTarget.value)
                setLocalError(null)
              }}
            />
          </label>
          <label className={css.formField}>
            <span className={css.formLabel}>{t('mcp.form.description')}</span>
            <Input value={description} disabled={formDisabled} aria-label={t('mcp.form.description')} onChange={(event) => { setDescription(event.currentTarget.value); setLocalError(null) }} />
          </label>
          <label className={css.formField}>
            {/* The document's own verdict sits on the label line, beside the
                field it is about: under the box it would be the last thing the
                scrolling dialog shows, and the author would have to hunt for it. */}
            <span className={css.formLabel}>
              {t('mcp.form.json')}
              <span className={css.requiredMark} aria-hidden="true">*</span>
              {jsonError === null ? null : <span className={css.fieldError} role="alert">{jsonError}</span>}
            </span>
            <textarea
              className={css.formJson}
              value={json}
              disabled={formDisabled}
              spellCheck={false}
              aria-label={t('mcp.form.json')}
              aria-required="true"
              aria-invalid={jsonError !== null}
              onChange={(event) => {
                resetProbe()
                jsonBox.current = event.currentTarget.value
                setJson(event.currentTarget.value)
                syncName(event.currentTarget.value)
                // The box is being edited again, so the verdict from the last
                // time it was left is stale; leaving it shows the new one.
                setJsonError(null)
                setLocalError(null)
              }}
              // Checking on the way out is what lets the author finish typing a
              // half-written document without being told it is broken.
              onBlur={() => { setJsonError(jsonProblem(jsonBox.current)) }}
            />
          </label>
          {mode === 'add' ? (
            <div className={css.formField}>
              <div>
                <Button variant="outline" size="sm" disabled={formDisabled || loading || probe?.status === 'pending'} onClick={() => { void probeConnection() }}>
                  {t('mcp.form.probe')}
                </Button>
              </div>
              {probe === null ? <span className={css.fieldHint}>{t('mcp.form.probeHint')}</span>
                : probe.status === 'pending' ? <span className={css.fieldHint} role="status">{t('mcp.form.probePending')}</span>
                  : probe.status === 'success' ? (
                    <span className={css.fieldHint} role="status">
                      {t(probe.local ? 'mcp.form.probeSuccessLocal' : 'mcp.form.probeSuccessRemote').replace('{n}', probe.count.toLocaleString())}
                    </span>
                  ) : <span className={css.formError} role="alert">{t('mcp.form.probeFailed').replace('{reason}', probe.reason)}</span>}
            </div>
          ) : null}
          {loading ? <p className={css.mcpStatus}>{t('mcp.loading')}</p> : null}
          {describeError !== null ? (
            <p className={css.formError} role="alert">
              <span>{describeError}</span>{' '}
              <Button variant="outline" size="sm" onClick={describeServer} disabled={loading}>{t('mcp.retry')}</Button>
            </p>
          ) : null}
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
            : describeError !== null
              ? <p className={css.formError} role="alert">{describeError}</p>
              : (
              <McpCredentialsPane
                json={json}
                kind={credentialKind}
                baseline={credentialBase}
                disabled={formDisabled}
                onPush={pushCredential}
                t={t}
              />
            )}
        </div>
        <div
          id={`${tabId}-tools-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-tools-tab`}
          className={css.editorPanel}
          hidden={tab !== 'tools'}
        >
          {/* One row, always present: the count and the bulk toggles appear with
              a listing, and the line under it must not move when they do. */}
          <div className={css.toolsHead}>
            {tools !== null ? <span className={css.toolsCount}>{`${enabledCount}/${tools.length}`}</span> : null}
            {tools !== null && tools.length > 0 ? (
              <span className={css.toolsActions}>
                <Button variant="ghost" size="sm" disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set<string>()) }}>
                  {t('mcp.form.toolsAll')}
                </Button>
                <Button variant="ghost" size="sm" disabled={formDisabled || toolsReadOnly} onClick={() => { setHiddenTools(new Set(tools.map(tool => tool.name))) }}>
                  {t('mcp.form.toolsNone')}
                </Button>
              </span>
            ) : null}
          </div>
          {/* What the checkboxes mean, in the currency the setting is about: the
              definitions a request carries and the ones a rule keeps out of it. */}
          <span className={css.fieldHint}>
            {toolsReadOnly
              ? t('mcp.form.toolsGlobal')
              : t('mcp.form.toolsHint')
                .replace('{n}', loadedTokens.toLocaleString())
                .replace('{m}', droppedTokens.toLocaleString())}
          </span>
          {describeError !== null ? <p className={css.formError} role="alert">{describeError}</p> : null}
          {toolsError !== null ? <p className={css.formError} role="alert">{toolsError}</p> : null}
          {tools !== null && tools.length === 0 && !toolsBusy ? <p className={css.mcpStatus}>{t('mcp.form.toolsEmpty')}</p> : null}
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
                  <span className={css.toolTokens}>
                    {t('mcp.form.toolTokens').replace('{n}', tool.tokens.toLocaleString())}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {/* The listing is a connect, so it can take seconds: the wait sits in
              the middle of the panel, under the line that explains it, and the
              line stays exactly where it was instead of moving down with it. */}
          {toolsBusy ? (
            <span className={css.toolsLoading} role="status">
              <span className={css.spinner} aria-hidden="true" />
              {t('mcp.form.toolsLoading')}
            </span>
          ) : null}
        </div>
        {localError !== null ? <p className={css.formError} role="alert">{localError}</p> : null}
        {configNotice !== null ? <p className={css.mcpNotice} role="status">{configNotice}</p> : null}
        {error !== null ? <p className={css.formError} role="alert">{`${t('mcp.form.saveFailed')} ${error}`}</p> : null}
      </div>
    </Modal>
  )
}
