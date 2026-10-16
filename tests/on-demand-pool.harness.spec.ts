/**
 * Real Loader/registry regression for the host-level on-demand MCP pool.
 *
 * These specs drive the real `registerMcpTools` / `mcp-pool` / `mcp-gate` /
 * `preset-mounts` code against a real Cordis Loader and agent-preset registry,
 * with the same event wiring `index.ts` installs: the fiber-publication
 * observer, the `loader/entry-init` hook that keeps a composed row from mounting
 * at all, and the row events that re-run `reconcile`.
 *
 * Only two things are stubbed:
 *
 * - `loader.internal.import` resolves the composition's MCP rows to
 *   `tests/fixtures/mcp-client-fixture.ts`, so a mounted row is countable and
 *   never starts a process.
 * - the pool's `open` is a counting stand-in for the SDK connection, which is
 *   where the real carrier spawns or connects. `opened` is therefore the
 *   process/connection count this suite asserts on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as scopes from '@deepseek-ai/dsh-scope'
import { createMcpPreloadGate, MCP_ROW_EVENTS, type McpPreloadGate } from '../src/mcp-gate.ts'
import { createPresetMountReader, type PresetMountReader } from '../src/preset-mounts.ts'
import { createMcpConnectionPool } from '../src/mcp-pool.ts'
import { registerMcpTools, type McpLoadingMode, type McpToolRegistration } from '../src/lazy-mcp.ts'
import { createMcpClientFixture, type McpClientFixture } from './fixtures/mcp-client-fixture.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const SERVER = 'test-server'
const PUBLIC_TOOL = `mcp__${SERVER}__echo`
/** One upstream tool the stand-in server publishes. */
const TOOLS = [{ name: 'echo', description: 'Echo one argument', inputSchema: { type: 'object' } }]

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

/** Let the Loader's published microtasks and the pool's release queue settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

/** One registration the specs' tool registry accepted. */
interface Registration { readonly name: string; readonly definition: unknown; active: boolean }
/** The `tools` service stand-in: records registrations, like the harness registry. */
interface ToolRecorder {
  readonly service: { register(definition: { name: string }): () => void }
  readonly registrations: Registration[]
  active(name: string): Registration[]
}

function toolRecorder(): ToolRecorder {
  const registrations: Registration[] = []
  return {
    service: {
      register(definition: { name: string }) {
        const registration: Registration = { name: definition.name, definition, active: true }
        registrations.push(registration)
        return () => { registration.active = false }
      },
    },
    registrations,
    active: name => registrations.filter(entry => entry.active && entry.name === name),
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = import.meta.url
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  const registry = toolRecorder()
  await ctx.plugin({
    apply(child: Context) {
      child.provide('tools', registry.service as never)
      // `mcp_load` resolves the row through the manager. The fixture's preset
      // rows carry their own config, so the call itself must not be needed.
      child.provide('mcpManager', {
        describeMcp: async () => { throw new Error('the fixture rows carry their own config') },
      } as never)
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
  return { ctx, fixture, registry }
}

/** One session: its own scope key, chained under the preset that owns the row. */
interface Session {
  readonly id: string
  readonly agent: { readonly id: string; readonly ctx: Context }
  dispose(): Promise<void>
}

/** The assembled harness one spec drives. */
interface Harness {
  readonly ctx: Context
  readonly fixture: McpClientFixture
  readonly registry: ToolRecorder
  readonly reader: PresetMountReader
  readonly gate: McpPreloadGate
  readonly registration: McpToolRegistration
  readonly counters: { opened: number; closed: number; calls: number }
  readonly mode: { value: McpLoadingMode }
  readonly warn: ReturnType<typeof vi.fn>
  session(id: string): Session
  call(name: string, args: unknown, session: Session): Promise<Record<string, unknown>>
  rowEntry(): { readonly options: Record<string, unknown>; readonly disabled: boolean } | undefined
  dispose(): Promise<void>
}

const definition = (registry: ToolRecorder, name: string): { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> } => {
  const found = registry.registrations.find(entry => entry.active && entry.name === name)
  if (found === undefined) throw new Error(`tool "${name}" is not registered`)
  return (found as unknown as { definition: { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> } }).definition
}

async function harness(mode: McpLoadingMode = 'dynamic'): Promise<Harness> {
  const { ctx, fixture, registry } = await setup()
  const state = { value: mode }
  const warn = vi.fn()
  const fibers = ctx as unknown as {
    on(name: string, listener: (...args: readonly never[]) => void): () => void
  }
  const reader = createPresetMountReader(ctx, scopes)
  const gate = createMcpPreloadGate(ctx, () => state.value, reader, warn)
  // The same subscriptions `index.ts` installs before its first `await`.
  fibers.on('internal/plugin', fiber => { gate.onPublish({ fiber }) })
  fibers.on('loader/entry-init', entry => { gate.onEntryInit(entry as never) })
  const counters = { opened: 0, closed: 0, calls: 0 }
  const pool = createMcpConnectionPool({
    open: async () => {
      counters.opened += 1
      return {
        client: {
          listTools: async () => ({ tools: TOOLS }),
          callTool: async (request: { name: string }) => {
            counters.calls += 1
            return { content: [{ type: 'text', text: `echo:${request.name}` }] }
          },
          close: async () => { counters.closed += 1 },
        },
        tools: TOOLS,
      }
    },
    onToolsChanged: () => {},
    warn,
  })
  const registration = registerMcpTools(ctx, state.value, gate, undefined, pool)
  let syncing = false
  let dirty = false
  const resync = (): void => {
    dirty = true
    if (syncing) return
    syncing = true
    void (async () => {
      try {
        while (dirty) {
          dirty = false
          await gate.reconcile()
          await registration.refresh()
        }
      } finally { syncing = false }
    })()
  }
  for (const event of MCP_ROW_EVENTS) {
    fibers.on(event, (...args) => {
      if (event === 'loader/entry-init') {
        // The Loader emits this before parent and options are assigned.
        queueMicrotask(() => { reader.observe(args[0]); resync() })
        return
      }
      if (event === 'internal/status') {
        const name = (args[0] as { entry?: { options?: { name?: string } } } | undefined)?.entry?.options?.name
        if (name !== MCP && name !== PRESET_MODULE) return
      }
      resync()
    })
  }
  await ctx.plugin({
    name: 'fixture-declaration', inject: ['agentPresets'],
    async* apply(child: Context) {
      yield await child.get('agentPresets').register({ id: 'standard', plugins: [{
        id: SERVER, name: MCP,
        config: { transport: 'stdio', serverName: SERVER, command: 'fixture-server', args: [], env: {}, cwd: '' },
      }] } as never)
    },
  })
  await settle()
  const mount = reader()[0]
  if (mount?.scope === undefined) throw new Error('the declared preset was not captured by the mount reader')
  const presetScope = mount.scope
  return {
    ctx, fixture, registry, reader, gate, registration, counters, mode: state, warn,
    session: (id) => {
      const scope = scopes.createScope(ctx, {}, { parent: presetScope })
      return { id, agent: { id, ctx: scope.ctx }, dispose: () => scope.dispose() }
    },
    call: (name, args, session) => definition(registry, name).execute(args, { agent: session.agent }),
    rowEntry: () => [...reader()[0]!.tree.entries()].find(entry => entry.options.id === SERVER) as
      | { readonly options: Record<string, unknown>; readonly disabled: boolean }
      | undefined,
    dispose: async () => { await registration.dispose(); reader.dispose(); gate.dispose() },
  }
}

describe('on-demand pool against a real Loader and preset registry', () => {
  it('opens one connection for the first session and reuses it for a second', async () => {
    const h = await harness('dynamic')
    const first = h.session('session-a')
    const second = h.session('session-b')

    const loaded = await h.call('mcp_load', { server: SERVER }, first)
    expect(loaded).toMatchObject({ server: SERVER, hidden: 0 })
    expect((loaded.tools as { name: string }[]).map(tool => tool.name)).toEqual([PUBLIC_TOOL])
    expect(h.counters.opened).toBe(1)
    // `dynamic` registers the tools itself; the mounting plugin never applies.
    expect(h.fixture.applyCalls).toBe(0)

    const reused = await h.call('mcp_load', { server: SERVER }, second)
    expect(reused).toMatchObject({ server: SERVER, hidden: 0 })
    expect((reused.tools as { name: string }[]).map(tool => tool.name)).toEqual([PUBLIC_TOOL])
    // The direct evidence for the resident pool: a second session paid nothing.
    expect(h.counters.opened).toBe(1)

    // Each session got its own generation, built through its own context.
    expect(h.registry.active(PUBLIC_TOOL)).toHaveLength(2)
    expect(h.fixture.adapterContexts).toEqual([first.agent.ctx, second.agent.ctx])
    expect(h.fixture.adapterContexts.map(context => scopes.scopeOf(context as Context)))
      .toEqual([scopes.scopeOf(first.agent.ctx), scopes.scopeOf(second.agent.ctx)])
    await h.dispose()
  })

  it('keeps the connection after the loading session ends and closes it on the last release', async () => {
    const h = await harness('dynamic')
    const first = h.session('session-a')
    const second = h.session('session-b')
    await h.call('mcp_load', { server: SERVER }, first)
    await h.call('mcp_load', { server: SERVER }, second)

    await first.dispose()
    await settle()
    // The ended session released its claim; the server is still up for the other.
    expect(h.counters.closed).toBe(0)
    expect(h.counters.opened).toBe(1)
    expect(h.registry.active(PUBLIC_TOOL)).toHaveLength(1)

    const stopped = await h.call('mcp_unload', { server: SERVER }, second)
    expect(stopped).toEqual({ server: SERVER, released: true, stopped: true })
    await vi.waitFor(() => { expect(h.counters.closed).toBe(1) })
    await h.dispose()
  })

  it('releases only the calling session\'s claim and reports the server as still in use', async () => {
    const h = await harness('dynamic')
    const first = h.session('session-a')
    const second = h.session('session-b')
    await h.call('mcp_load', { server: SERVER }, first)
    await h.call('mcp_load', { server: SERVER }, second)

    const released = await h.call('mcp_unload', { server: SERVER }, first)
    expect(released).toEqual({ server: SERVER, released: true, stopped: false })
    await settle()
    expect(h.counters.closed).toBe(0)
    expect(h.registry.active(PUBLIC_TOOL)).toHaveLength(1)

    // The remaining session still calls the tool through the shared connection.
    const registered = h.registry.active(PUBLIC_TOOL)[0]!
    const live = registered as unknown as { definition: { call(args: unknown, execution: { signal?: AbortSignal }): unknown } }
    expect(await live.definition.call({ text: 'hi' }, {})).toMatchObject({ content: [{ text: 'echo:echo' }] })
    expect(h.counters.calls).toBe(1)
    await h.dispose()
  })

  it('mounts the row under eager and mounts it again after suppression', async () => {
    const h = await harness('dynamic')
    await h.gate.reconcile()
    await h.ctx.loader.await()

    expect(h.rowEntry()?.disabled).toBe(true)
    expect(h.fixture.applyCalls).toBe(0)
    expect(h.gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, SERVER))
      .toEqual({ allowed: true, suppressed: true })

    h.mode.value = 'eager'
    await h.gate.reconcile()
    await h.ctx.loader.await()

    expect(h.rowEntry()?.disabled).toBe(false)
    expect(h.fixture.applyCalls).toBe(1)
    expect(h.gate.stateFor({ scope: 'preset', agentPreset: 'standard' }, SERVER))
      .toEqual({ allowed: true, suppressed: false })
    await h.dispose()
  })
})
