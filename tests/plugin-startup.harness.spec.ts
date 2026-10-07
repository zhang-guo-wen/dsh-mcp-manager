import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Entry, Group } from '@deepseek-ai/cordis-plugin-loader'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.mjs'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  const definitions = new Map<string, any>()
  const sections: any[] = []
  await ctx.plugin({ apply(child: Context) {
    child.provide('tools', { register(def: any) { definitions.set(def.name, def); return () => { definitions.delete(def.name) } } } as never)
    child.provide('systemPrompt', { getSectionOrder: () => 0, section(def: any) { sections.push(def); return () => {} } } as never)
  } })
  ctx.loader.internal = { import: async (name: string) => {
    if (name === '@deepseek-ai/dsh-scope') return scopes
    if (name === '@deepseek-ai/dsh-mcp-client') return { name: 'fixture-mcp', apply() {} }
    if (name === 'pending-manager') return { name: 'pending-manager', inject: ['mcpManager'], apply() {} }
    throw new Error(`unexpected fixture module ${name}`)
  } } as never
  return { ctx, definitions, sections }
}

async function mountPreset(ctx: Context) {
  return await ctx.plugin({
    name: 'fixture-declaration', inject: ['agentPresets'],
    async* apply(child: Context) { yield await child.get('agentPresets').register({ id: 'standard', plugins: [
      { id: 'test-server', name: '@deepseek-ai/dsh-mcp-client', config: {
        transport: 'stdio', serverName: 'test-server', command: 'fixture', args: [], env: {}, cwd: '',
      } },
      { id: 'wait-for-manager', name: 'pending-manager' },
    ] }) },
  })
}

async function start(ctx: Context) {
  const entry = new Entry(ctx.get('loader'))
  entry.parent = ctx.get('loader').root
  entry.options = { id: 'mcp-manager', name: '@guowenzhang/dsh-mcp-manager' }
  return await ctx.extend({ [Entry.key]: entry }).plugin(plugin, {})
}

const mcpRows = async (ctx: Context) => await (ctx.get('mcpManager') as any).listMcps({})

describe('built plugin import and activation on latest Harness', () => {
  it('imports the distributed artifact and completes activation beside pending manager injection', async () => {
    const { ctx, definitions } = await setup()
    await mountPreset(ctx)
    const audit = vi.spyOn(ctx.get('agentPresets'), 'compositionInventory').mockImplementation(() => {
      throw new Error('must not wait for registry diagnostics')
    })
    await start(ctx)
    expect(ctx.get('mcpManager')).toBeDefined()
    expect(definitions.has('mcp_load')).toBe(true)
    expect(definitions.has('mcp_unload')).toBe(true)
    expect(definitions.has('mcp_call')).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })

  it('supports manager-only reload after suppression on a surviving generation', async () => {
    const { ctx } = await setup()
    await mountPreset(ctx)
    const first = await start(ctx)
    const agent = scopes.createScope(ctx, {})
    await ctx.get('agentPresets').mount(agent.ctx)
    await (ctx.get('mcpManager') as any).gateState({})
    await first.dispose()
    await start(ctx)
    expect((await (ctx.get('mcpManager') as any).gateState({})).suppressed).toContain('preset:standard:test-server')
    const rows = await ctx.get('agentPresets').compositionInventory()
    expect(rows[0]?.rows.find(row => row.moduleName === '@deepseek-ai/dsh-mcp-client')?.enabled).toBe(false)
  })

  it('follows declarations mounted after apply and exposes scoped on-demand inventory', async () => {
    const { ctx, sections } = await setup()
    await start(ctx)
    await mountPreset(ctx)
    const scope = scopes.createScope(ctx, {})
    await ctx.get('agentPresets').mount(scope.ctx)
    await vi.waitFor(async () => {
      expect((await (ctx.get('mcpManager') as any).gateState({})).suppressed).toContain('preset:standard:test-server')
    })
    await vi.waitFor(() => {
      expect(sections[0].text({ scope: scopes.scopeOf(scope.ctx) })).toContain('- test-server')
    })
    expect(await mcpRows(ctx)).toMatchObject({ entries: [] })
    expect(sections[0].text({ scope: {} })).not.toContain('- test-server')
  })
})
