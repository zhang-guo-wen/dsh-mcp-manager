/**
 * Module specifiers this plugin recognizes inside a composition.
 *
 * Both constants are stated once because three separate readers match on them:
 * row authoring (which writes `mcp-client` rows), the preset reader (which
 * captures agent-preset declarations), and the preload gate (which decides
 * which composed rows belong to a preset). Deriving one module's constant from
 * another would make those readers depend on each other's import graph instead
 * of on the name itself.
 *
 * @module @guowenzhang/dsh-mcp-manager/mcp-modules
 */

/** Module specifier of the plugin that declares one agent preset. */
export const AGENT_PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'

/** Module specifier of the MCP client bridge this plugin governs. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'
