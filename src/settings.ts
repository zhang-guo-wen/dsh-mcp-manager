/**
 * MCP manager user settings: the loading policy, the row descriptions, and the
 * per-row tool filters the management surface persists.
 *
 * One namespace (`mcp-manager`) owns every field this plugin exposes to the
 * settings UI. Values resolve through `ctx.settings` (the settings seam) so they
 * are user-editable in a local document and persist across restarts, falling
 * back to a composition `base` (from the plugin `config`) when the user has not
 * overridden them. The settings service is optional: without one mounted, the
 * reader stays pinned to the composition `base`.
 *
 * This file deliberately accesses `ctx.settings` through a small local interface
 * rather than a hard dependency on the settings package, so this package stays
 * composable in trees that do not mount the settings provider.
 *
 * @module @zhang-guo-wen/dsh-mcp-manager/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
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

/** Schema served to settings clients for this namespace. */
export const MCP_SETTINGS_SCHEMA: Schema<McpSettingsFlags> = z.object({
  loading: z.string().default('dynamic'),
  descriptions: z.dict(String).default({}),
  // Values stay unvalidated by the schema on purpose: the settings document is
  // hand-editable, and a malformed entry must fail that one row's filter at
  // read time instead of rejecting the whole namespace's stored section.
  tools: z.dict(z.any()).default({}),
})

/** Composition-layer defaults for this namespace. */
export interface McpSettingsConfig {
  /** Initial loading mode inherited when the user document does not override it. */
  loading?: string
}

/** A live {@link McpSettingsFlags} reader (detached snapshots). */
export type McpSettingsSource = () => McpSettingsFlags

/**
 * Minimal local shape of the `settings.register` owner scope we consume. The
 * value types are the same as `@deepseek-ai/dsh-settings` exposes; declaring
 * them here keeps this package free of a hard reference to that service so it
 * can be composed even where the provider is absent.
 */
interface SettingsScopeLike<T> {
  get(): T
  watch(callback: (next: T, prev: T) => void): () => void
}

interface SettingsRegisterOptionsLike<T> {
  base?: Partial<T>
  applies?: 'live' | 'restart'
}

interface SettingsProviderLike {
  register<T>(
    namespace: string,
    schema: unknown,
    options?: SettingsRegisterOptionsLike<T>,
  ): SettingsScopeLike<T>
}

/**
 * Register the `mcp-manager` namespace and return a live reader.
 *
 * When the settings service is mounted, the namespace is registered and the
 * reader follows committed changes. Without a settings service the reader stays
 * pinned to the composition `base`. A namespace already owned by another plugin
 * keeps that owner's reader — we never throw.
 *
 * @param ctx - plugin context (uses `ctx.get('settings')` when present).
 * @param config - composition defaults for the loading mode.
 * @param onCommitted - observer invoked after each committed change.
 * @returns a thunk returning the current flags.
 */
export function registerMcpSettings(
  ctx: Context,
  config: McpSettingsConfig = {},
  onCommitted?: (flags: McpSettingsFlags) => void,
): McpSettingsSource {
  const base: McpSettingsFlags = {
    loading: config.loading ?? 'dynamic',
    descriptions: {},
    tools: {},
  }
  let source: McpSettingsSource = () => ({ ...base })
  ctx.inject(['settings'], (settingsCtx) => {
    const provider = (settingsCtx as unknown as { settings: SettingsProviderLike }).settings
    try {
      const scope = provider.register<McpSettingsFlags>(
        MCP_SETTINGS_NAMESPACE,
        MCP_SETTINGS_SCHEMA,
        { base, applies: 'live' },
      )
      source = () => ({ ...scope.get() })
      scope.watch((next) => {
        source = () => ({ ...next })
        onCommitted?.({ ...next })
      })
    } catch {
      // Another owner already registered this namespace; keep our base.
    }
  })
  return () => ({ ...source() })
}
