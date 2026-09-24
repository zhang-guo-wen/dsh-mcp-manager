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

/** Root-fiber lifecycle phase of one MCP row, or null when it owns no fiber. */
export type McpFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** Why the global plane refuses MCP row writes. */
export type McpGlobalProblem =
  /** The root Include carries the profile's patch list, so write-back would flatten it. */
  | 'patched-include'
  /** The composition mounts no single file-backed Include to address. */
  | 'no-include'
  /** The mounted global configuration file is not writable. */
  | 'not-writable'

/** One MCP client row a composition declares, read without waiting for its activation. */
export interface McpRosterRow {
  /** Loader-qualified row id for a global row, the local row id for a preset row. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement; `conditional` marks a `!!js` gate only a mount can resolve. */
  readonly enabled: boolean | 'conditional'
  /** Root-fiber phase, null when the row currently owns no fiber. */
  readonly fiberPhase: McpFiberPhase
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
   * Whether the global plane accepts writes. False when the mounted root
   * Include carries a patch list, which is the normal profile composition and
   * makes Loader write-back flatten the bundle and user layers.
   */
  readonly globalWritable: boolean
  /** Why the global plane is read-only, for the settings page to show. */
  readonly globalProblem?: McpGlobalProblem
}

/** Request the MCP servers the Claude Code configuration files declare. */
export interface ScanClaudeMcpRequest {
  /**
   * Working directory whose project scope should be read from the user file's
   * `projects` map and from `<cwd>/.mcp.json`. Omitted means the Host's own
   * working directory.
   */
  readonly cwd?: string
}

/** Which configuration file an imported entry was read from. */
export type ClaudeMcpSourceLabel = 'user' | 'projectScope' | 'settings' | 'projectFile'

/** Why a scanned source or entry could not be offered for import. */
export type ClaudeMcpProblem =
  | 'missing'
  | 'unreadable'
  | 'malformed'
  | 'too-large'
  | 'unsupported'
  | 'unsupported-name'

/** One MCP server found in a Claude Code configuration file. */
export interface ClaudeMcpEntry {
  /** The server's name as its configuration file declares it. */
  readonly serverName: string
  /** Id of the source this entry came from. */
  readonly sourceId: string
  /** Which kind of file it was read from. */
  readonly sourceLabel: ClaudeMcpSourceLabel
  /** Absolute path of the file it was read from. */
  readonly sourcePath: string
  /** The `projects` key this entry came from, for a per-directory scope. */
  readonly sourceDetail?: string
  /** The parsed transport, ready to hand to `addMcp`. */
  readonly spec: McpSpec
  /**
   * Names of the `env`/`headers` keys the entry declares, so the dialog can say
   * which secrets an import would carry without printing their values. The
   * values themselves live in `spec`, which the import writes verbatim.
   */
  readonly envKeys: readonly string[]
  /** Another entry earlier in the scan already used this server name. */
  readonly duplicate: boolean
  /** Set when the entry cannot be imported; `spec` is then a placeholder. */
  readonly problem?: ClaudeMcpProblem
}

/** One configuration file that was read, or skipped. */
export interface ClaudeMcpSource {
  /** Stable id addressing this source within one scan result. */
  readonly id: string
  /** Which kind of file this is. */
  readonly label: ClaudeMcpSourceLabel
  /** Absolute path that was inspected. */
  readonly path: string
  /** The `projects` key, for a per-directory scope. */
  readonly sourceDetail?: string
  /** Servers this source declares, in the file's own order. */
  readonly entries: readonly ClaudeMcpEntry[]
  /** Set when the file could not be read at all. */
  readonly problem?: ClaudeMcpProblem
}

/** Every MCP server the Claude Code configuration files declare. */
export interface ScanClaudeMcpResult {
  /** Sources that exist and were readable, in scan order. */
  readonly sources: readonly ClaudeMcpSource[]
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
