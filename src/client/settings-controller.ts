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
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  ListMcpsResult,
  McpFiberPhase,
  McpGlobalProblem,
  McpMutationResult,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
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
  /** Root-fiber phase when live, otherwise null. */
  fiberPhase: McpPhase
}

/** The fields this plugin persists for the MCP management surface. */
export interface McpSettingsFlags {
  /** `eager`, `dynamic` or `lazy`; see {@link McpLoadingOption}. */
  loading: string
  /** Plugin-owned MCP row descriptions keyed by {@link mcpRowKey}. */
  descriptions: Record<string, string>
  /** Plugin-owned MCP tool rules keyed the same way. */
  tools: Record<string, unknown>
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
  /** Read the MCP servers the Claude Code configuration files declare. */
  scanClaudeMcp: (request: ScanClaudeMcpRequest) => Promise<ScanClaudeMcpResult>
}

/** The roster read's answer, as the section consumes it. */
export interface McpRosterView {
  /** Every MCP row, global plane plus each preset composition, undeduplicated. */
  readonly servers: readonly McpServer[]
  /**
   * Why the global plane refuses writes, when it does. A profile mounts its
   * root Include together with the bundle and user patch layers, and Loader
   * write-back would flatten those layers, so global authoring is unavailable
   * there and the surface must say so instead of failing row by row.
   */
  readonly globalProblem?: McpGlobalProblem
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
}

/** Registration-side face for the section. */
export interface McpSectionFace {
  hooks: {
    /** Section snapshot bound by the renderer as useMcpSettings. */
    mcpSettings: SnapshotStore<McpSectionState>
  }
  /** Persist the MCP loading mode the user picked. */
  setMcpLoading: (mode: McpLoadingOption) => Promise<void>
  /** Persist one MCP row's description. */
  updateMcpDescription: (key: string, description: string) => void
  /**
   * Persist one MCP row's tool rules. An empty list removes the row's rules, so
   * every tool it publishes becomes visible again.
   */
  updateMcpTools: (key: string, patterns: readonly string[]) => void
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
  /** Read the MCP servers the Claude Code configuration files declare. */
  scanClaudeMcp: (request: ScanClaudeMcpRequest) => Promise<ScanClaudeMcpResult>
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
      fiberPhase: entry.fiberPhase,
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
        fiberPhase: row.fiberPhase,
      })
    }
  }
  return rows
}

/** Owner handle over the `mcp-manager` namespace. */
export class McpSettingsController {
  private readonly store: SnapshotStore<McpSectionState>
  private readonly unsubscribe: () => void

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
      updateMcpDescription: (key, description) => { this.updateMcpDescription(key, description) },
      updateMcpTools: (key, patterns) => { this.updateMcpTools(key, patterns) },
      addMcp: this.authoring.addMcp,
      editMcp: this.authoring.editMcp,
      disableMcp: this.authoring.disableMcp,
      describeMcp: this.authoring.describeMcp,
      listMcpTools: this.authoring.listMcpTools,
      scanClaudeMcp: this.authoring.scanClaudeMcp,
      suppressedMcps: this.suppressed,
      mcps: this.mcps,
      presets: this.presets,
    }
  }

  private updateMcpDescription(key: string, description: string): void {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) return
    const map = snapshot.value?.descriptions ?? {}
    const next = { ...map }
    if (description === '') Reflect.deleteProperty(next, key)
    else next[key] = description
    void this.scope.set('descriptions', next)
  }

  private updateMcpTools(key: string, patterns: readonly string[]): void {
    const snapshot = this.scope.getSnapshot()
    if (snapshot.status !== 'ready' || !snapshot.writable) return
    const next = { ...snapshot.value?.tools }
    if (patterns.length === 0) Reflect.deleteProperty(next, key)
    else next[key] = [...patterns]
    void this.scope.set('tools', next)
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
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
