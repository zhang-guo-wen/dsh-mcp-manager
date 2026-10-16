/** Client-safe MCP authoring requests and mutation results. */

/** MCP transport fields accepted by the Claude-compatible authoring form. */
export type McpSpec =
  | {
    /** Launch an MCP server as a child process. */
    readonly type: 'stdio'
    /** Child-process executable. */
    readonly command: string
    /** Arguments passed directly to the executable. */
    readonly args?: readonly string[]
    /** Additional child-process environment variables. */
    readonly env?: Readonly<Record<string, string>>
    /** Child-process working directory. */
    readonly cwd?: string
  }
  | {
    /** Connect to a streamable HTTP MCP endpoint. */
    readonly type: 'streamable-http' | 'http' | 'sse'
    /** MCP endpoint URL. */
    readonly url: string
    /** Additional HTTP headers. */
    readonly headers?: Readonly<Record<string, string>>
  }

/** The configuration surface that identifies a global or preset composition. */
export type McpTarget =
  | { readonly scope: 'global' }
  | { readonly scope: 'preset'; readonly agentPreset: string }

/**
 * Why one row's connection configuration cannot start as written.
 *
 * Declared here rather than in the diagnostics module so the browser half can
 * carry it without importing host-side code.
 */
export type McpConfigIssueKind =
  /** The transport is closed but no `command` was supplied. */
  | 'missing-command'
  /** The transport is open but no `url` was supplied. */
  | 'missing-url'
  /** A `${env:NAME}` placeholder names a variable that is unset or blank. */
  | 'unreachable-variable'
  /** A credential-shaped field is present but empty. */
  | 'empty-credential'
  /** The row config is not an object this plugin can drive. */
  | 'unsupported-config'

/** One configuration gap, in the terms the settings page and the model see. */
export interface McpConfigIssue {
  /** Stable kind, for callers that branch rather than print. */
  readonly kind: McpConfigIssueKind
  /** Human-readable reason, already formatted for display. */
  readonly reason: string
  /** Variable or field names involved, when the kind carries them. */
  readonly names?: readonly string[]
}

/** Request to append one MCP client row. */
export interface AddMcpRequest {
  /** Composition that receives the row. */
  readonly target: McpTarget
  /** Row id; defaults to `serverName` when omitted. */
  readonly entryId?: string
  /** MCP namespace used in tool names. */
  readonly serverName: string
  /** Claude-compatible transport specification. */
  readonly spec: McpSpec
}

/** Request to replace one MCP client row's connection configuration. */
export interface EditMcpRequest {
  /** Composition containing the row. */
  readonly target: McpTarget
  /** Loader row id, or the preset row id. */
  readonly entryId: string
  /** MCP namespace used in tool names after the edit. */
  readonly serverName: string
  /** Claude-compatible transport specification. */
  readonly spec: McpSpec
}

/** Request to enable or disable one MCP client row. */
export interface DisableMcpRequest {
  /** Composition containing the row. */
  readonly target: McpTarget
  /** Loader row id, or the preset row id. */
  readonly entryId: string
  /** Whether the row is disabled in its source composition. */
  readonly disabled: boolean
}

/** Request to read one MCP client row's current connection spec. */
export interface DescribeMcpRequest {
  /** Composition containing the row. */
  readonly target: McpTarget
  /** Loader row id, or the preset row id. */
  readonly entryId: string
}

/** Current connection spec and identity of one MCP client row. */
export interface DescribeMcpResult {
  /** Composition that owns the row. */
  readonly target: McpTarget
  /** Address of the row in the source composition. */
  readonly entryId: string
  /** MCP namespace shown in tool names. */
  readonly serverName: string
  /** Claude-compatible transport specification. */
  readonly spec: McpSpec
  /** Whether the row is disabled in its source composition. */
  readonly disabled: boolean
}

/** Redacted result returned after an MCP row mutation. */
export interface McpMutationResult {
  /** Composition that was changed. */
  readonly target: McpTarget
  /** Address of the changed row in the source composition. */
  readonly entryId: string
  /** MCP namespace after the mutation. */
  readonly serverName: string
  /** Effective disabled flag written by the mutation. */
  readonly disabled: boolean
}

/** One tool a connection publishes, as the editor's enable/disable list shows it. */
export interface McpToolRow {
  /** The server's own tool name; filter rules match exactly this name. */
  readonly name: string
  /** The server's description, empty when it declared none. */
  readonly description: string
  /**
   * Estimated tokens this definition adds to a request, so the list can show
   * which tools cost the most and what unchecking them saves. An estimate: see
   * `src/mcp-tokens.ts` for what it counts.
   */
  readonly tokens: number
}

/**
 * Request the tools one connection spec publishes. The editor sends its current
 * form value rather than a stored row, so a listing reflects unsaved edits and
 * works for a row that does not exist yet.
 */
export interface ListMcpToolsRequest {
  /** Transport specification to connect with. */
  readonly spec: McpSpec
  /** Namespace used in the connection's diagnostics. */
  readonly serverName: string
}

/** The tools one connection spec publishes, read from a live connection. */
export interface ListMcpToolsResult {
  /** Published tools in the server's own order. */
  readonly tools: readonly McpToolRow[]
}

/** Request for the runtime preload gate's current view. */
export interface McpGateStateRequest {
  /** Placeholder field: the gate state is host-wide, so the request carries none. */
  readonly unused?: boolean
}

/** The preload gate's runtime view, as the settings page presents it. */
export interface McpGateStateResult {
  /**
   * Keys of the allowed rows the gate keeps unmounted because the loading mode
   * does not preload. Keyed as the settings page's row key
   * (`preset:<id>:<serverName>` or `global:<serverName>`).
   */
  readonly suppressed: readonly string[]
}

/** Request for the discovery catalogue's current state; the catalogue is host-wide. */
export interface McpCatalogStateRequest {
  /** Placeholder field: the catalogue is host-wide, so the request carries none. */
  readonly unused?: boolean
}

/** One server the discovery catalogue remembers. */
export interface McpCatalogEntryView {
  /** The settings-page row key the tools were recorded under. */
  readonly key: string
  /** How many tools were recorded for it. */
  readonly tools: number
  /** How long ago the record was made. */
  readonly ageMs: number
  /** Whether the collection cap cut the server's listing short. */
  readonly truncated: boolean
}

/** What the discovery catalogue currently remembers. */
export interface McpCatalogStateResult {
  /** One row per remembered server, oldest first. */
  readonly entries: readonly McpCatalogEntryView[]
  /** How many entries the whole catalogue holds. */
  readonly total: number
}

/** Request to forget every recorded discovery result. */
export interface ClearMcpCatalogRequest {
  /** Placeholder field: the catalogue is host-wide, so the request carries none. */
  readonly unused?: boolean
}

/** What clearing the discovery catalogue dropped. */
export interface ClearMcpCatalogResult {
  /** How many server records were dropped. */
  readonly cleared: number
}

/**
 * Root-fiber lifecycle phase of one MCP row, or null when it owns no fiber.
 *
 * `held` is the state the loading mode produces: the row may be used, but the
 * preload gate kept it from ever starting, so its disposed fiber must not read
 * as "stopped".
 */
export type McpFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | 'held' | null

/**
 * Why one roster row has no writable home in the settings page.
 *
 * A global row is written by patching the entry list of the user's own
 * file-backed Include, so a row that file does not declare cannot be switched
 * from the page at all. The per-row flag exists so the surface closes those
 * controls instead of letting a click fail at the Host.
 */
export type McpRowReadOnly =
  /** The row is live but the addressable Include's own file does not declare it. */
  | 'composed-row'
  /** No file-backed Include of the user's own is mounted. */
  | 'no-writable-include'
  /** Several are mounted, so the target file is ambiguous. */
  | 'several-writable-includes'
  /** The one addressable file could not be read, so its rows are unknown. */
  | 'unreadable-include'

/** One MCP client row a composition declares, read without waiting for its activation. */
export interface McpRosterRow {
  /** Loader-qualified row id for a global row, the local row id for a preset row. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement; `conditional` marks a `!!js` gate only a mount can resolve. */
  readonly enabled: boolean | 'conditional'
  /**
   * Whether the settings page may write this row.
   *
   * False closes the row's switch and editor, and {@link readOnly} says why. A
   * preset row is always writable: the profile patch that declares its preset
   * owns every row nested in it.
   */
  readonly writable: boolean
  /** Why the row cannot be written, present exactly when `writable` is false. */
  readonly readOnly?: McpRowReadOnly
  /** Root-fiber phase, null when the row currently owns no fiber. */
  readonly fiberPhase: McpFiberPhase
  /**
   * Names of the `env`/`headers` keys this row's configuration carries, so the
   * settings page can open its credential editor where there is something to
   * edit. Key names only: values are credentials and never leave the Host.
   */
  readonly secretKeys: readonly string[]
  /**
   * Why this row's connection configuration cannot start, when it cannot.
   *
   * Omitted for a runnable row, so the common case adds nothing to the wire.
   * This is what the settings page marks as "not configured": a configuration
   * gap, unlike the preload gate's live/unmounted state, is not a loading mode.
   */
  readonly configIssue?: readonly McpConfigIssue[]
}

/** One agent preset that can own MCP rows. */
export interface McpRosterPreset {
  /** Preset id used in the composition target. */
  readonly id: string
  /** Display name the preset declares, when it declares one. */
  readonly name?: string
  /** The preset's MCP rows, in composition order. */
  readonly rows: readonly McpRosterRow[]
}

/** Request for the MCP roster read; the roster is host-wide, so it carries no fields. */
export interface ListMcpsRequest {
  /** Placeholder field: kept so the gateway derives a one-field descriptor. */
  readonly unused?: boolean
}

/**
 * The MCP rows the running composition declares, plus the planes a mutation can
 * target. Read from declarations and live fibers only: the read never waits for
 * a row's activation, so a settings page renders while an MCP server is still
 * starting.
 */
export interface ListMcpsResult {
  /** Global-plane rows, in Loader order. */
  readonly entries: readonly McpRosterRow[]
  /** Every declared preset, with its MCP rows. */
  readonly presets: readonly McpRosterPreset[]
  /**
   * Whether the global plane accepts writes, which needs exactly one
   * file-backed Include of the user's own to address. Its patch layers are not
   * a bar: a global write edits that file and reloads the Include, so the layers
   * stay in place. The host's root anchor Include is excluded — `prepareProfile`
   * rewrites its file on every start.
   */
  readonly globalWritable: boolean
}

/** Failure details owned by the MCP authoring Remote. */declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The requested composition or MCP row does not exist. */
    'mcp/not-found': { readonly target: McpTarget; readonly entryId?: string }
    /** The requested mutation is not supported by the current deployment. */
    'mcp/unavailable': { readonly reason: string }
    /** The source composition cannot be written. */
    'mcp/read-only': { readonly target: McpTarget; readonly reason: string }
    /** The request or source composition is malformed. */
    'mcp/invalid': { readonly target?: McpTarget; readonly reason: string }
    /** The mutation would create an ambiguous MCP configuration. */
    'mcp/conflict': {
      readonly target: McpTarget
      readonly entryId?: string
      readonly serverName?: string
      readonly reason: string
    }
  }
}

export {}
