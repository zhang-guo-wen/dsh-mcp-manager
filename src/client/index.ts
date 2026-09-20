/**
 * MCP management settings section, browser half. Registers the
 * `settings.mcpManager` dictionaries and the one `settings.section` entry that
 * presents the MCP server roster, its loading mode, and the per-row tool
 * filters.
 *
 * The section reads and writes the `mcp-manager` namespace the Host
 * `@zhang-guo-wen/dsh-mcp-manager` plugin owns, so the surface and the loading
 * behavior share one setting.
 * @module @zhang-guo-wen/dsh-mcp-manager/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings namespace scope merge (ctx.settingsScope) and slot types.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Remote namespaces this plugin reads (ctx.remote.pluginInventory).
// The namespace map entry itself is declared by the Host package's generated
// remote-client augmentation, which only applies once that module is in the
// program; `dsh-api-remotes/client` alone leaves `ctx.remote.pluginInventory` as
// `any`.
import type {} from '@deepseek-ai/dsh-host-plugin-inventory/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { McpSection } from './McpSection.tsx'
import { en, NS, zh, type McpSectionKey } from './locales.ts'
import {
  MCP_SETTINGS_NS,
  McpSettingsController,
  mapMcpServers,
  type McpAuthoringActions,
  type McpPresetOption,
  type McpServer,
  type McpSettingsFlags,
} from './settings-controller.ts'
import { TYPERT_REMOTE, REMOTE_NAMESPACE } from '../remote.ts'
import type {
  AddMcpRequest,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  McpGateStateRequest,
  McpGateStateResult,
  McpMutationResult,
  ScanClaudeMcpRequest,
  ScanClaudeMcpResult,
} from '../types.ts'

export type { McpSectionProps } from './McpSection.tsx'
export type { McpSectionFace, McpSectionState, McpServer } from './settings-controller.ts'
export { NS } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's MCP management settings copy. */
    'settings.mcpManager': McpSectionKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.pluginInventory']

/** The namespace service this plugin mounts itself — fetched via `ctx.get`, never injected. */
interface McpManagerNamespace {
  addMcp(request: AddMcpRequest): Promise<RemoteResult<McpMutationResult>>
  editMcp(request: EditMcpRequest): Promise<RemoteResult<McpMutationResult>>
  disableMcp(request: DisableMcpRequest): Promise<RemoteResult<McpMutationResult>>
  describeMcp(request: DescribeMcpRequest): Promise<RemoteResult<DescribeMcpResult>>
  listMcpTools(request: ListMcpToolsRequest): Promise<RemoteResult<ListMcpToolsResult>>
  gateState(request: McpGateStateRequest): Promise<RemoteResult<McpGateStateResult>>
  scanClaudeMcp(request: ScanClaudeMcpRequest): Promise<RemoteResult<ScanClaudeMcpResult>>
}

/** Unwrap a Typert `RemoteResult` or surface the Host failure. */
async function unwrapRemote<T>(call: () => Promise<RemoteResult<T>>): Promise<T> {
  const result = await call()
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/**
 * Register the dictionaries and the MCP management settings section.
 * @param ctx - client root context.
 */
export async function apply(ctx: Context): Promise<void> {
  const disposeMount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => () => disposeMount(), 'mcp-manager: remote mount')

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-mcp-manager: dictionaries')
  const t = ctx.locale.bind(NS)
  const mcps = async (): Promise<readonly McpServer[]> => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return mapMcpServers(result.value)
  }
  const mcpMgr = (): McpManagerNamespace => {
    const namespace = ctx.get(`remote.${REMOTE_NAMESPACE}`) as McpManagerNamespace | undefined
    if (namespace === undefined) {
      throw new Error(`${REMOTE_NAMESPACE} namespace service is not mounted`)
    }
    return namespace
  }
  const authoring: McpAuthoringActions = {
    addMcp: request => unwrapRemote(() => mcpMgr().addMcp(request)),
    editMcp: request => unwrapRemote(() => mcpMgr().editMcp(request)),
    disableMcp: request => unwrapRemote(() => mcpMgr().disableMcp(request)),
    describeMcp: request => unwrapRemote(() => mcpMgr().describeMcp(request)),
    listMcpTools: request => unwrapRemote(() => mcpMgr().listMcpTools(request)),
    scanClaudeMcp: request => unwrapRemote(() => mcpMgr().scanClaudeMcp(request)),
  }
  const presets = async (): Promise<readonly McpPresetOption[]> => {
    const result = await ctx.remote.pluginInventory.list()
    if (!result.ok) {
      throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
    }
    return (result.value.agentPresets ?? []).map(group => ({ id: group.id, name: group.name ?? group.id }))
  }
  const suppressedMcps = async (): Promise<readonly string[]> =>
    unwrapRemote(() => mcpMgr().gateState({}))
      .then(state => state.suppressed)
  const controller = new McpSettingsController(
    ctx.settingsScope.bind<McpSettingsFlags>({ namespace: MCP_SETTINGS_NS }),
    mcps,
    authoring,
    presets,
    suppressedMcps,
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-mcp-manager: scope')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-manager',
    order: 14,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, McpSection))
}
