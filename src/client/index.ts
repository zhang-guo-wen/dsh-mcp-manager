/**
 * MCP management settings section, browser half. Registers the
 * `settings.mcpManager` dictionaries and the one `settings.section` entry that
 * presents the MCP server roster, its loading mode, and the per-row tool
 * filters.
 *
 * The section reads and writes the `mcp-manager` namespace the Host
 * `@guowenzhang/dsh-mcp-manager` plugin owns, so the surface and the loading
 * behavior share one setting. The roster it renders comes from that plugin's
 * own `listMcps` Remote, which never waits for an MCP row's activation.
 * @module @guowenzhang/dsh-mcp-manager/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the configuration-form service merge (ctx.configForms) and slot types.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the slot registry Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the Remote namespace map (ctx.remote), declared by the generated
// remote-client augmentation of `dsh-api-remotes/client`.
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
  type McpRosterView,
  type McpSettingsFlags,
} from './settings-controller.ts'
import { TYPERT_REMOTE, REMOTE_NAMESPACE } from '../remote.ts'
import type {
  AddMcpRequest,
  AddMcpsRequest,
  AddMcpsResult,
  DescribeMcpRequest,
  DescribeMcpResult,
  DisableMcpRequest,
  EditMcpRequest,
  ListMcpToolsRequest,
  ListMcpToolsResult,
  ListMcpsRequest,
  ListMcpsResult,
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
export const inject = ['slots', 'locale', 'configForms', 'remote']

/** The namespace service this plugin mounts itself — fetched via `ctx.get`, never injected. */
interface McpManagerNamespace {
  addMcp(request: AddMcpRequest): Promise<RemoteResult<McpMutationResult>>
  addMcps(request: AddMcpsRequest): Promise<RemoteResult<AddMcpsResult>>
  editMcp(request: EditMcpRequest): Promise<RemoteResult<McpMutationResult>>
  disableMcp(request: DisableMcpRequest): Promise<RemoteResult<McpMutationResult>>
  describeMcp(request: DescribeMcpRequest): Promise<RemoteResult<DescribeMcpResult>>
  listMcps(request: ListMcpsRequest): Promise<RemoteResult<ListMcpsResult>>
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
  const mcpMgr = (): McpManagerNamespace => {
    const namespace = ctx.get(`remote.${REMOTE_NAMESPACE}`) as McpManagerNamespace | undefined
    if (namespace === undefined) {
      throw new Error(`${REMOTE_NAMESPACE} namespace service is not mounted`)
    }
    return namespace
  }
  // The roster read answers from declarations and live fibers, so it never waits
  // for an MCP child process: a server that is still starting shows its own
  // phase instead of holding the settings page open.
  const readRoster = (): Promise<ListMcpsResult> => unwrapRemote(() => mcpMgr().listMcps({}))
  const mcps = async (): Promise<McpRosterView> => {
    const roster = await readRoster()
    return { servers: mapMcpServers(roster), globalWritable: roster.globalWritable }
  }
  const authoring: McpAuthoringActions = {
    addMcp: request => unwrapRemote(() => mcpMgr().addMcp(request)),
    addMcps: request => unwrapRemote(() => mcpMgr().addMcps(request)),
    editMcp: request => unwrapRemote(() => mcpMgr().editMcp(request)),
    disableMcp: request => unwrapRemote(() => mcpMgr().disableMcp(request)),
    describeMcp: request => unwrapRemote(() => mcpMgr().describeMcp(request)),
    listMcpTools: request => unwrapRemote(() => mcpMgr().listMcpTools(request)),
    scanClaudeMcp: request => unwrapRemote(() => mcpMgr().scanClaudeMcp(request)),
  }
  const presets = async (): Promise<readonly McpPresetOption[]> => {
    const roster = await readRoster()
    return roster.presets.map(preset => ({ id: preset.id, name: preset.name ?? preset.id }))
  }
  const suppressedMcps = async (): Promise<readonly string[]> =>
    unwrapRemote(() => mcpMgr().gateState({}))
      .then(state => state.suppressed)
  const controller = new McpSettingsController(
    ctx.configForms.get<McpSettingsFlags>(MCP_SETTINGS_NS),
    mcps,
    authoring,
    presets,
    suppressedMcps,
  )
  ctx.effect(() => () => { controller.dispose() }, 'ui-mcp-manager: settings form')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-manager',
    order: 14,
    label: () => t('nav'),
    locale: NS,
    inject: () => controller.inject(),
  }, McpSection))
}
