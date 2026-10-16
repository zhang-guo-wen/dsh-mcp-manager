/**
 * Startup zero-launch: the preload gate must keep a preset's `mcp-client` row
 * from ever reaching its plugin callback.
 *
 * `mcp-client` starts the child process inside `apply`, so "the fixture's apply
 * counter stayed at zero" is the direct evidence that no process was started.
 * The plugin here is the built artifact, mounted through a Loader `Entry`, which
 * is how the host loads it.
 *
 * The eager control in the same file shows the counter does observe a mount, so
 * a zero is not an artifact of a fixture that never runs at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Entry, Group } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.mjs'
import { createMcpClientFixture, type McpClientFixture } from './fixtures/mcp-client-fixture.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const ROW = 'test-server'
const ROW_KEY = `preset:standard:${ROW}`

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

async function setup(config: Record<string, unknown>) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.plugin({
    apply(child: Context) {
      child.provide('tools', {
        register: () => () => {},
        schemas: () => [],
      } as never)
      child.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} } as never)
    },
  })
  const fixture = createMcpClientFixture()
  ctx.loader.internal = {
    import: async (specifier: string) => {
      if (specifier === '@deepseek-ai/dsh-scope') return scopes
      if (specifier === MCP) return fixture.module
      throw new Error(`unexpected fixture module ${specifier}`)
    },
  } as never
  const entry = new Entry(ctx.get('loader'))
  entry.parent = ctx.get('loader').root
  entry.options = { id: 'mcp-manager', name: '@guowenzhang/dsh-mcp-manager' }
  await ctx.extend({ [Entry.key]: entry }).plugin(plugin, config)
  return { ctx, fixture }
}

/** Declare the preset the way a profile patch does, after the plugin is up. */
async function declare(ctx: Context) {
  return await ctx.plugin({
    name: 'fixture-declaration', inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.get('agentPresets').register({ id: 'standard', plugins: [{
        id: ROW, name: MCP,
        config: { transport: 'stdio', serverName: ROW, command: 'fixture-server', args: [], env: {}, cwd: '' },
      }] } as never)
    },
  })
}

const gateState = async (ctx: Context) => await (ctx.get('mcpManager') as {
  gateState(request: object): Promise<{ suppressed: string[] }>
}).gateState({})

describe('startup zero-launch in a real Loader composition', () => {
  it('never runs the mcp-client callback for a preset row held under dynamic', async () => {
    const { ctx, fixture } = await setup({})
    await declare(ctx)
    await vi.waitFor(async () => {
      expect((await gateState(ctx)).suppressed).toContain(ROW_KEY)
    })
    // The row exists and the gate reports it held, and its plugin callback —
    // the only place the real mcp-client starts a child process — never ran.
    expect(fixture.applyCalls).toBe(0)
  })

  it('re-mounts a rebuilt declaration without activating the held row', async () => {
    const { ctx, fixture } = await setup({})
    const first = await declare(ctx)
    await vi.waitFor(async () => {
      expect((await gateState(ctx)).suppressed).toContain(ROW_KEY)
    })
    expect(fixture.applyCalls).toBe(0)
    // A settings write rebuilds the whole declaration row. The rebuilt row is
    // published while the gate is listening, so it must not spawn either.
    await first.dispose()
    await declare(ctx)
    await vi.waitFor(async () => {
      expect((await gateState(ctx)).suppressed).toContain(ROW_KEY)
    })
    expect(fixture.applyCalls).toBe(0)
  })

  it('mounts the same declaration exactly once under eager', async () => {
    const { ctx, fixture } = await setup({ loading: 'eager' })
    await declare(ctx)
    await vi.waitFor(() => { expect(fixture.applyCalls).toBeGreaterThan(0) })
    expect(fixture.applyCalls).toBe(1)
    expect((await gateState(ctx)).suppressed).not.toContain(ROW_KEY)
  })

  it('holds a row that was declared before the plugin activated, after one activation', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.plugin({
      apply(child: Context) {
        child.provide('tools', { register: () => () => {}, schemas: () => [] } as never)
        child.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} } as never)
      },
    })
    const fixture: McpClientFixture = createMcpClientFixture()
    ctx.loader.internal = {
      import: async (specifier: string) => {
        if (specifier === '@deepseek-ai/dsh-scope') return scopes
        if (specifier === MCP) return fixture.module
        throw new Error(`unexpected fixture module ${specifier}`)
      },
    } as never
    // The preset exists before the plugin row is applied: publication happened
    // while no gate was subscribed, which is the one window the plugin reports
    // rather than prevents.
    await declare(ctx)
    await ctx.loader.await()
    expect(fixture.applyCalls).toBe(1)
    const entry = new Entry(ctx.get('loader'))
    entry.parent = ctx.get('loader').root
    entry.options = { id: 'mcp-manager', name: '@guowenzhang/dsh-mcp-manager' }
    await ctx.extend({ [Entry.key]: entry }).plugin(plugin, {})
    await vi.waitFor(async () => {
      expect((await gateState(ctx)).suppressed).toContain(ROW_KEY)
    })
    // Held from here on: the reconcile fallback stopped it and keeps it stopped.
    expect(fixture.applyCalls).toBe(1)
  })
})
