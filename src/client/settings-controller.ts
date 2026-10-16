/**
 * Controller bridging the Host `mcp-manager` settings namespace onto the MCP
 * management section snapshot. Reads the loading mode, the row descriptions,
 * and the per-row tool filters, writes one field per action through the
 * settings scope, and supplies the MCP server roster the section renders.
 *
 * The roster comes from the Host's own `listMcps` read (`src/mcp-roster.ts`),
 * which answers from declarations and live fibers and therefore never waits for
 * an MCP child process to connect. Every mcp-client occurrence is surfaced
 * without deduplication, tagged with where it is configured (`global` or a
 * preset id). Descriptions and tool rules are plugin-owned: stored in the
 * `mcp-manager` namespace and merged onto the rows here.
 * @module @guowenzhang/dsh-mcp-manager/client/settings-controller
 */

import type {
  AddMcpRequest,
  ClearMcpCatalogRequest,
  ClearMcpCatalogResult,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  ListMcpsResult,
  McpCatalogStateRequest,
  McpCatalogStateResult,
  McpConfigIssue,
  McpFiberPhase,
  McpMutationResult,
  McpRowReadOnly,
} from '../types.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Settings namespace registered Host-side by @guowenzhang/dsh-mcp-manager: its Loader row id. */
export const MCP_SETTINGS_NS = 'mcp-manager'

/** Lifecycle phase of one MCP row, as its owning fiber reports it. */
export type McpPhase = McpFiberPhase

/**
 * Which composition plane the settings page addresses. A global row is mounted
 * by the composition itself; an agent row lives in an agent preset and takes
 * part in on-demand loading. The page tabs by this value, and a new row is
 * written into the plane its tab shows.
 */
export type McpPlane = 'global' | 'agent'

/** Stable key for one MCP row (`<scope>:<name>` or `preset:<id>:<name>`), matching the Host's `mcpRowKey`. */
export function mcpRowKey(server: McpServer): string {
  return server.scope === 'preset' ? `preset:${server.presetId ?? ''}:${server.serverName}` : `${server.scope}:${server.serverName}`
}

/**
 * The local Loader row id from a loader-qualified id. A global mcp-client row
 * is addressed as `<includePath>:<id>`, and the host writes `serverName` into
 * the row's config; in the default add flow the local id equals that name.
 * @param qualified - loader-qualified entry id.
 * @returns the id segment after the last `:` separator.
 */
function localEntryId(qualified: string): string {
  const separator = qualified.lastIndexOf(':')
  return separator < 0 ? qualified : qualified.slice(separator + 1)
}

/** One loaded MCP server, as the management section presents it. */
export interface McpServer {
  /** Loader entry id, or null when a preset row declares no id. */
  entryId: string | null
  /** MCP namespace shown in tool names. */
  serverName: string
  /** Authoring description; plugin-owned, resolved by the section from `descriptions`. */
  description?: string
  /** Where this occurrence is configured. */
  scope: 'global' | 'preset'
  /** Preset id when `scope` is `preset`. */
  presetId: string | undefined
  /** Effective enablement; `'conditional'` marks a `!!js` gate only a mount can resolve. */
  enabled: boolean | 'conditional'
  /**
   * Whether the settings page may write this row.
   *
   * False closes the row's switch and editor: a global row is written by
   * patching the user's own Include file, so a row that file does not declare
   * has nowhere to be written. {@link readOnly} names the reason to show.
   */
  writable: boolean
  /** Why the row cannot be written, present exactly when {@link writable} is false. */
  readOnly?: McpRowReadOnly
  /** Root-fiber phase when live, otherwise null. */
  fiberPhase: McpPhase
  /**
   * Key names of the `env`/`headers` the row's configuration carries, so the
   * list can open the credential editor on a row that has credentials and lead
   * everywhere else with the plain editor. Key names only: values stay on the
   * Host.
   */
  secretKeys: readonly string[]
  /**
   * Why this row cannot start as configured, when it cannot: a blank
   * `command`/`url`, an unresolved `${env:NAME}`, or an empty credential field.
   *
   * Independent of {@link fiberPhase}: a row can be enabled, wanted, and still
   * unable to start. The section marks such a row "not configured" and refuses
   * to switch it on.
   */
  configIssue?: readonly McpConfigIssue[]
}

/** The fields this plugin persists for the MCP management surface. */
export interface McpSettingsFlags {
  /** `eager`, `dynamic` or `lazy`; see {@link McpLoadingOption}. */
  loading: string
  /** Plugin-owned MCP row descriptions keyed by {@link mcpRowKey}. */
  descriptions: Record<string, string>
  /** Plugin-owned MCP tool rules keyed the same way. */
  tools: Record<string, unknown>
  /**
   * Plugin-owned context-budget policy, as one open map. The Host converges
   * every field at read time, so the surface never has to validate it and a
   * malformed entry cannot roll the namespace back.
   */
  optimize: Record<string, unknown>
}

/**
 * One MCP loading mode the section offers. The Host narrows an unknown stored
 * value back to `dynamic`, so the editor only ever shows these three.
 */
export type McpLoadingOption = 'eager' | 'dynamic' | 'lazy'

/** The MCP loading modes in display order. */
export const MCP_LOADING_OPTIONS: readonly McpLoadingOption[] = ['eager', 'dynamic', 'lazy']

/** One agent preset the MCP editor can target. */
export interface McpPresetOption {
  /** Preset id used in the composition target. */
  readonly id: string
  /** Display name the preset published, or the id. */
  readonly name: string
}

/** Host-authoring callbacks projected into the MCP management section. */
export interface McpAuthoringActions {
  /** Add one MCP row and resolve after the Host commits it. */
  addMcp: (request: AddMcpRequest) => Promise<McpMutationResult>
  /** Replace one MCP row and resolve after the Host commits it. */
  editMcp: (request: EditMcpRequest) => Promise<McpMutationResult>
  /** Set one MCP row's disabled flag and resolve after the Host commits it. */
  disableMcp: (request: DisableMcpRequest) => Promise<McpMutationResult>
  /** Read one MCP row's current connection spec for the editor to prefill. */
  describeMcp: (request: DescribeMcpRequest) => Promise<DescribeMcpResult>
  /** Connect once with a spec and report the tools it publishes. */
  listMcpTools: (request: ListMcpToolsRequest) => Promise<ListMcpToolsResult>
  /** Read what the discovery catalogue remembers, for the optimization page. */
  catalogState: (request: McpCatalogStateRequest) => Promise<McpCatalogStateResult>
  /** Forget every recorded discovery result. */
  clearCatalog: (request: ClearMcpCatalogRequest) => Promise<ClearMcpCatalogResult>
}

/** The roster read's answer, as the section consumes it. */
export interface McpRosterView {
  /** Every MCP row, global plane plus each preset composition, undeduplicated. */
  readonly servers: readonly McpServer[]
  /**
   * Every preset the same read declared, so the agent plane's filter can label
   * its options without a second roster read.
   */
  readonly presets: readonly McpPresetOption[]
  /**
   * Whether the global plane accepts writes, which needs one file-backed root
   * Include. Its patch layers are not a bar: a global write edits that file and
   * reloads the Include, leaving the layers in place.
   */
  readonly globalWritable: boolean
}

/** Snapshot the section renders. */
export interface McpSectionState {
  /** Whether the namespace is exposed to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** How MCP servers reach the model; one of {@link MCP_LOADING_OPTIONS}. */
  loading: string
  /** Plugin-owned MCP row descriptions keyed by {@link mcpRowKey}. */
  descriptions: Record<string, string>
  /** Plugin-owned MCP tool rules keyed the same way. */
  tools: Record<string, unknown>
  /** Plugin-owned context-budget policy, as stored; the Host converges it at read time. */
  optimize: Record<string, unknown>
}

/** Registration-side face for the section. */
export interface McpSectionFace {
  hooks: {
    /** Section snapshot bound by the renderer as useMcpSettings. */
    mcpSettings: SnapshotStore<McpSectionState>
  }
  /** Persist the MCP loading mode the user picked. */
  setMcpLoading: (mode: McpLoadingOption) => Promise<void>
  /** Persist one MCP row's description; resolves once the Host accepted the write. */
  updateMcpDescription: (key: string, description: string) => Promise<void>
  /**
   * Persist one MCP row's tool rules. An empty list removes the row's rules, so
   * every tool it publishes becomes visible again. Resolves once the Host
   * accepted the write and rejects with the reason it did not.
   */
  updateMcpTools: (key: string, patterns: readonly string[]) => Promise<void>
  /**
   * Persist one optimization field, merging it into the stored policy map.
   * Resolves once the Host accepted the write and rejects with the reason it did
   * not, so the page can show a per-row save state instead of a silent no-op.
   */
  setOptimize: (field: string, value: unknown) => Promise<void>
  /** Add one MCP row through the Claude-compatible Host Remote. */
  addMcp: (request: AddMcpRequest) => Promise<McpMutationResult>
  /** Edit one MCP row through the Claude-compatible Host Remote. */
  editMcp: (request: EditMcpRequest) => Promise<McpMutationResult>
  /** Enable or disable one MCP row through the Claude-compatible Host Remote. */
  disableMcp: (request: DisableMcpRequest) => Promise<McpMutationResult>
  /** Read one MCP row's connection spec through the Claude-compatible Host Remote. */
  describeMcp: (request: DescribeMcpRequest) => Promise<DescribeMcpResult>
  /** List the tools a connection spec publishes through the Host Remote. */
  listMcpTools: (request: ListMcpToolsRequest) => Promise<ListMcpToolsResult>
  /** Read what the discovery catalogue remembers. */
  catalogState: () => Promise<McpCatalogStateResult>
  /** Forget every recorded discovery result. */
  clearCatalog: () => Promise<ClearMcpCatalogResult>
  /**
   * Keys of the allowed rows the Host holds unmounted because the loading mode
   * does not preload. The list uses them to tell "disabled by the user" apart
   * from "enabled, but deliberately not in this request".
   */
  suppressedMcps: () => Promise<readonly string[]>
  /** Resolve the current MCP roster without waiting for any row's activation. */
  mcps: () => Promise<McpRosterView>
  /** Resolve the agent presets the editor can target. */
  presets: () => Promise<readonly McpPresetOption[]>
}

/**
 * Project the Host roster read onto the rows the section renders, keeping every
 * mcp-client occurrence (global plane plus each preset composition) without
 * deduplicating cross-scope repeats. Descriptions are not read here — they are
 * plugin-owned and merged by the section from the `descriptions` map.
 * @param roster - the roster read from the Host.
 * @returns one row per mcp-client occurrence, tagged with its config scope.
 */
export function mapMcpServers(roster: ListMcpsResult): readonly McpServer[] {
  const rows: McpServer[] = []
  for (const entry of roster.entries) {
    rows.push({
      entryId: entry.entryId,
      serverName: localEntryId(entry.entryId ?? ''),
      scope: 'global',
      presetId: undefined,
      enabled: entry.enabled,
      // A page can outlive the Host it talks to: an older Host reports no
      // per-row flag, and then the plane-level answer still governs.
      writable: entry.writable !== false,
      ...entry.readOnly === undefined ? {} : { readOnly: entry.readOnly },
      fiberPhase: entry.fiberPhase,
      secretKeys: entry.secretKeys ?? [],
      ...entry.configIssue === undefined ? {} : { configIssue: entry.configIssue },
    })
  }
  for (const preset of roster.presets) {
    for (const row of preset.rows) {
      rows.push({
        entryId: row.entryId,
        serverName: localEntryId(row.entryId ?? row.moduleName),
        scope: 'preset',
        presetId: preset.id,
        enabled: row.enabled,
        writable: row.writable !== false,
        ...row.readOnly === undefined ? {} : { readOnly: row.readOnly },
        fiberPhase: row.fiberPhase,
        secretKeys: row.secretKeys ?? [],
        ...row.configIssue === undefined ? {} : { configIssue: row.configIssue },
      })
    }
  }
  return rows
}

/**
 * A save failure carrying a stable code, so the page can show a localized
 * headline instead of raw Host text.
 */
export class McpSaveError extends Error {
  constructor(readonly code: 'not-writable', message: string) {
    super(message)
    this.name = 'McpSaveError'
  }
}

/** Owner handle over the `mcp-manager` namespace. */
export class McpSettingsController {
  private readonly store: SnapshotStore<McpSectionState>
  private readonly unsubscribe: () => void
  /** One namespace write at a time: each queued write reads after the last landed. */
  private writeQueue: Promise<void> = Promise.resolve()
  /** Optimization fields this controller wrote, ahead of a possibly stale snapshot. */
  private optimizeWritten: Record<string, unknown> = {}

  /**
   * @param scope - the `mcp-manager` configuration form.
   * @param mcps - Host-backed MCP roster read.
   * @param authoring - Host-backed MCP mutation callbacks.
   * @param presets - Host-backed agent-preset options loader.
   * @param suppressed - Host-backed reader of the rows the gate holds unmounted.
   */
  constructor(
    private readonly scope: ConfigForm<McpSettingsFlags>,
    private readonly mcps: () => Promise<McpRosterView>,
    private readonly authoring: McpAuthoringActions,
    private readonly presets: () => Promise<readonly McpPresetOption[]>,
    private readonly suppressed: () => Promise<readonly string[]>,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => this.publish())
  }

  /** Stop observing settings. */
  dispose(): void {
    this.unsubscribe()
  }

  /** Build the renderer face for this section. */
  inject(): McpSectionFace {
    return {
      hooks: { mcpSettings: this.store },
      setMcpLoading: (mode) => this.setMcpLoading(mode),
      updateMcpDescription: (key, description) => this.updateMcpDescription(key, description),
      updateMcpTools: (key, patterns) => this.updateMcpTools(key, patterns),
      setOptimize: (field, value) => this.setOptimize(field, value),
      addMcp: this.authoring.addMcp,
      editMcp: this.authoring.editMcp,
      disableMcp: this.authoring.disableMcp,
      describeMcp: this.authoring.describeMcp,
      listMcpTools: this.authoring.listMcpTools,
      catalogState: () => this.authoring.catalogState({}),
      clearCatalog: () => this.authoring.clearCatalog({}),
      suppressedMcps: this.suppressed,
      mcps: this.mcps,
      presets: this.presets,
    }
  }

  /** Run one write after every write queued before it, failures not poisoning the chain. */
  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task)
    this.writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * The current value of one settings map, for a read-modify-write.
   * @param field - the namespace field holding the map.
   * @returns the map as the snapshot currently reports it.
   * @throws {@link McpSaveError} when the document cannot be written.
   */
  private async readWritable(field: 'optimize' | 'descriptions' | 'tools'): Promise<Record<string, unknown>> {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) {
      throw new McpSaveError('not-writable', 'the MCP settings document is not writable')
    }
    return (snapshot.value?.[field] ?? {}) as Record<string, unknown>
  }

  /**
   * Write one optimization field.
   *
   * The stored policy is one open map, so a field write is a read-modify-write
   * of that map rather than a separate namespace field. The Host converges every
   * field at read time, which is why nothing here validates the value: a bad one
   * falls back to its default instead of failing the namespace commit. Writes
   * are serialized and fold in every field this controller already wrote, so
   * two rows saving at once cannot drop each other's value through a stale
   * snapshot.
   * @param field - the policy field name.
   * @param value - the value to store.
   * @throws {@link McpSaveError} when the document is not writable, or when the
   *   Host rejects the write.
   */
  private setOptimize(field: string, value: unknown): Promise<void> {
    return this.enqueueWrite(async () => {
      const next = { ...await this.readWritable('optimize'), ...this.optimizeWritten, [field]: value }
      await this.scope.set('optimize', next)
      this.optimizeWritten = { ...this.optimizeWritten, [field]: value }
    })
  }

  private async updateMcpDescription(key: string, description: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const map = (await this.readWritable('descriptions')) as Record<string, string>
      const next = { ...map }
      if (description === '') Reflect.deleteProperty(next, key)
      else next[key] = description
      await this.scope.set('descriptions', next)
    })
  }

  private async updateMcpTools(key: string, patterns: readonly string[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const map = (await this.readWritable('tools')) as Record<string, unknown>
      const next = { ...map }
      if (patterns.length === 0) Reflect.deleteProperty(next, key)
      else next[key] = [...patterns]
      await this.scope.set('tools', next)
    })
  }

  private async setMcpLoading(mode: McpLoadingOption): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) return
    if (snapshot.value?.loading === mode) return
    // The form answers whether the Host accepted the write; the section shows
    // the committed value through the mirror either way.
    await this.scope.set('loading', mode)
  }

  private projection(): McpSectionState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      loading: snapshot.value?.loading ?? 'dynamic',
      descriptions: snapshot.value?.descriptions ?? {},
      tools: snapshot.value?.tools ?? {},
      optimize: snapshot.value?.optimize ?? {},
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
