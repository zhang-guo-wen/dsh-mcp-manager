/**
 * MCP manager user settings: the loading policy, the row descriptions, and the
 * per-row tool filters the management surface persists.
 *
 * The namespace is this plugin's Loader row Config, so the profile entry id
 * (`mcp-manager`) is what the settings page addresses and the schema below is
 * the live form it renders. Every field is volatile: a committed change reaches
 * the running plugin without a remount, and the reader below always observes
 * the value as it stands at call time.
 *
 * @module @zhang-guo-wen/dsh-mcp-manager/settings
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin: its Loader row id. */
export const MCP_SETTINGS_NAMESPACE = 'mcp-manager'

/** Every field the MCP management surface persists. */
export interface McpSettingsFlags {
  /**
   * How MCP servers load: `eager` (every enabled row mounts at preset mount),
   * `dynamic` (on-demand tools mount a server into the calling session) or
   * `lazy` (on-demand tools talk to the server without registering anything).
   */
  loading: string
  /**
   * Authoring descriptions for MCP rows, keyed by `<scope>:<serverName>`
   * (`global:engram` or `preset:standard:mcp-github`). Plugin-owned display
   * metadata; never reaches the model or the config file.
   */
  descriptions: Record<string, string>
  /**
   * Per-row tool filters, keyed the same way. Each entry keeps matching tools
   * and `!`-prefixed entries hide them; `*` and `?` are wildcards. Applied when
   * a session loads the server, so a hidden tool is neither advertised nor
   * callable.
   */
  tools: Record<string, unknown>
}

/** The same fields as live configuration. */
export interface Config {
  /** Loading mode, read fresh on every commit. */
  loading: Volatile<string>
  /** Authoring descriptions, keyed by row. */
  descriptions: Volatile<Record<string, string>>
  /** Per-row tool filters, keyed by row. */
  tools: Volatile<Record<string, unknown>>
}

/** Schema served to settings clients for this namespace.
 * The inferred type is the source of truth: `.volatile()` produces the `Volatile` accessors above. */
export const Config = z.object({
  // Deliberately a plain string rather than an enum: the settings document is
  // hand-editable, and a rejected value rolls the whole namespace back to its
  // last good section. `parseMcpLoadingMode` converges an unrecognized mode at
  // the read site instead.
  loading: z.string().default('dynamic').volatile(),
  descriptions: z.dict(String).default({}).volatile(),
  // Values stay unvalidated by the schema on purpose, for the same reason: a
  // malformed entry must fail that one row's filter at read time rather than
  // rejecting the whole namespace.
  tools: z.dict(z.any()).default({}).volatile(),
})

/** Composition-layer defaults accepted under the row's `config:`. */
export interface McpSettingsConfig {
  /** Initial loading mode inherited when the user document does not override it. */
  loading?: string
}

/** A live {@link McpSettingsFlags} reader (detached snapshots). */
export type McpSettingsSource = () => McpSettingsFlags

/**
 * Read the namespace's fields as plain values.
 *
 * The gate and the tool filter call the returned thunk at their own commit
 * points, so a committed change needs no listener here.
 * @param config - the plugin's resolved configuration.
 * @returns a thunk returning the flags as they stand at call time.
 */
export function readMcpSettings(config: Config): McpSettingsSource {
  return () => ({
    loading: config.loading.get(),
    descriptions: { ...config.descriptions.get() },
    tools: { ...config.tools.get() },
  })
}
