import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as registryModule from '@deepseek-ai/dsh-agent-preset-registry'
import { createPresetMountReader } from '../src/preset-mounts.ts'
import { createMcpPreloadGate } from '../src/mcp-gate.ts'
import { listMcpRows, registerMcpTools } from '../src/lazy-mcp.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
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
  // Exercise real Loader trees/fibers but never launch a user's MCP server.
  ctx.loader.internal = { import: async (specifier: string) => {
    if (specifier === MCP) return { name: 'test-mcp', apply() {} }
    if (specifier === 'pending') return { name: 'pending', inject: ['neverAvailable'], apply() {} }
    throw new Error(`unexpected fixture module ${specifier}`)
  } } as never
  return ctx
}

async function declare(ctx: Context, plugins: unknown[], id = 'standard') {
  return await ctx.plugin({
    name: 'test-declaration', inject: ['agentPresets'],
    async* apply(child: Context) { yield await child.get('agentPresets').register({ id, plugins } as never) },
  })
}

const mcp = (id: string, disabled?: unknown) => ({ id, name: MCP,
  config: { serverName: id, transport: 'stdio', command: 'fixture', args: [], env: {}, cwd: '' },
  ...(disabled === undefined ? {} : { disabled }),
})

describe('latest Harness preset compatibility', () => {
  it('discovers detached generations without livePresetMounts and restores eager after suppression', async () => {
    const ctx = await setup()
    expect('livePresetMounts' in registryModule).toBe(false)
    const declaration = [mcp('server'), mcp('disabled', true)]
    await declare(ctx, declaration)
    const reader = createPresetMountReader(ctx, scopes)
    expect(reader()).toHaveLength(1)
    let mode: 'eager' | 'dynamic' | 'lazy' = 'dynamic'
    const warn = vi.fn()
    const gate = createMcpPreloadGate(ctx, () => mode, reader, warn)
    await gate.reconcile()
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'server')).toEqual({ allowed: true, suppressed: true })
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'disabled')).toEqual({ allowed: false, suppressed: false })
    expect(declaration[0]).not.toHaveProperty('disabled')
    mode = 'lazy'
    await gate.reconcile()
    mode = 'eager'
    await gate.reconcile()
    await ctx.loader.await()
    expect([...reader()[0]!.tree.entries()].find(row => row.options.id === 'server')?.disabled).toBe(false)
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'server')).toEqual({ allowed: true, suppressed: false })
    expect(warn).not.toHaveBeenCalled()
    gate.dispose()
    reader.dispose()
  })

  it('does not advertise unmounted or disabled preset declarations as global servers', async () => {
    const ctx = {
      get(name: string) {
        if (name === 'loader') return { entries: () => [] }
        if (name === 'configEditor') return { entries: () => [{ options: {
          name: '@deepseek-ai/dsh-agent-preset', disabled: true,
          config: { id: 'disabled', plugins: [mcp('private')] },
        } }] }
      }, root: { fiber: {} },
    } as unknown as Context
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', () => [], vi.fn())
    await gate.reconcile()
    expect(listMcpRows(ctx, gate)).toEqual([])
  })

  it('keeps immutable allowance when only the manager reader is reloaded', async () => {
    const ctx = await setup()
    await declare(ctx, [mcp('server')])
    const first = createPresetMountReader(ctx, scopes)
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', first, vi.fn())
    await gate.reconcile()
    const key = first()[0]!.scope
    expect([...first()[0]!.tree.entries()][0]?.options.disabled).toBe(true)
    gate.dispose()
    first.dispose()
    const second = createPresetMountReader(ctx, scopes)
    const reloaded = createMcpPreloadGate(ctx, () => 'eager', second, vi.fn())
    await reloaded.reconcile()
    expect(second()[0]?.scope).toBe(key)
    expect(reloaded.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'server')).toEqual({ allowed: true, suppressed: false })
    second.dispose()
  })

  it('inherits group and evaluated !!js disablement without authorizing disabled loads', async () => {
    const ctx = await setup()
    await declare(ctx, [
      mcp('true', { __jsExpr: 'true' }), mcp('false', { __jsExpr: 'false' }),
      { id: 'group', name: 'cordis:group', group: true, disabled: true, config: [mcp('grouped')] },
      { id: 'conditional-group', name: 'cordis:group', group: true, disabled: { __jsExpr: 'true' }, config: [mcp('conditional')] },
    ])
    const reader = createPresetMountReader(ctx, scopes)
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', reader, vi.fn())
    await gate.reconcile()
    expect(listMcpRows(ctx, gate).filter(row => row.enabled).map(row => row.serverName)).toEqual(['false'])
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'true')?.allowed).toBe(false)
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'grouped')?.allowed).toBe(false)
    expect(gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, 'conditional')?.allowed).toBe(false)
    reader.dispose()
  })

  it('retains revision-local allowance and config for old Agents and their children', async () => {
    const ctx = await setup()
    const old = await declare(ctx, [mcp('old')])
    const agent = scopes.createScope(ctx, {})
    await ctx.get('agentPresets').mount(agent.ctx)
    const reader = createPresetMountReader(ctx, scopes)
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', reader, vi.fn())
    await gate.reconcile()
    const oldKey = reader()[0]!.scope
    await old.dispose()
    await declare(ctx, [mcp('new'), mcp('old', true)])
    await gate.reconcile()
    const mounts = reader()
    expect(mounts).toHaveLength(2)
    expect(mounts[0]!.scope).not.toBe(oldKey)
    const snapshots = gate.presetRows!()
    expect(snapshots.find(row => row.scope === oldKey)?.rows.map(row => [row.entryId, row.allowed])).toEqual([['old', true]])
    expect(snapshots.find(row => row.scope !== oldKey)?.rows.map(row => [row.entryId, row.allowed])).toEqual([['new', true], ['old', false]])
    const child = scopes.createScope(ctx, {})
    expect(ctx.get('agentPresets').composeFrom(child.ctx, agent.ctx)).toBe('standard')
    expect(scopes.scopeChainOf(scopes.scopeOf(child.ctx))).toContain(oldKey)
    await agent.dispose()
    expect(reader()).toHaveLength(2)
    await child.dispose()
    expect(reader()).toHaveLength(1)
    reader.dispose()
  })

  it('refreshes inventory with pending Host injection and never calls compositionInventory', async () => {
    const ctx = await setup()
    await declare(ctx, [mcp('ready'), { id: 'pending', name: 'pending' }])
    const audit = vi.spyOn(ctx.get('agentPresets'), 'compositionInventory').mockImplementation(() => {
      throw new Error('activation audit must not be read')
    })
    const reader = createPresetMountReader(ctx, scopes)
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', reader, vi.fn())
    await gate.reconcile()
    const definitions: any[] = []
    const sections: any[] = []
    const fakeCtx = {
      root: ctx.root,
      get(name: string) {
        if (name === 'tools') return { register: (value: unknown) => { definitions.push(value); return () => {} } }
        if (name === 'systemPrompt') return { getSectionOrder: () => 0, section: (value: unknown) => { sections.push(value); return () => {} } }
        return ctx.get(name as never)
      },
    } as unknown as Context
    const registration = registerMcpTools(fakeCtx, 'dynamic', gate)
    await registration.refresh()
    expect(audit).not.toHaveBeenCalled()
    const agent = scopes.createScope(ctx, {}, { parent: reader()[0]!.scope! })
    const key = scopes.scopeOf(agent.ctx)
    expect(sections[0].text({ scope: key })).toContain('- ready')
    expect(sections[0].text({ scope: {} })).not.toContain('- ready')
    await expect(definitions.find(row => row.name === 'mcp_load').execute({ server: 'ready' }, {
      agent: { id: 'other', ctx: scopes.createScope(ctx, {}).ctx },
    })).rejects.toThrow('unknown or disabled')
    await registration.dispose()
    reader.dispose()
  })
})
