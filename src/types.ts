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

/** Failure details owned by the MCP authoring Remote. */
declare module '@deepseek-ai/dsh-typert-protocol' {
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
