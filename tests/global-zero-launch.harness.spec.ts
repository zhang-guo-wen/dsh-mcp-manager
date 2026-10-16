/**
 * Global-plane zero-launch against a real file-backed Include.
 *
 * The user's own `cordis.yml` supplies the global rows. Like a preset row, one
 * must not start its process under `dynamic`, must stay loadable on demand, and
 * must come back under `eager`. The file itself is a hard constraint: the Loader
 * writes a file-backed tree on self-dispose (`vendor/loader/src/index.ts:164`),
 * so a global row must never be released through `fiber.dispose()`.
 *
 * The Include is mounted the way a profile does it: `builtins.include` resolved
 * from the `cordis:include` builtin name, with `path` relative to `ctx.baseUrl`.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Entry, Group } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.mjs'
import { createMcpPreloadGate, MCP_ROW_EVENTS, type McpPreloadGate } from '../src/mcp-gate.ts'
import { createPresetMountReader, type PresetMountReader } from '../src/preset-mounts.ts'
import { createMcpConnectionPool } from '../src/mcp-pool.ts'
import { McpCatalog } from '../src/mcp-catalog.ts'
import { listMcpRows, registerMcpTools, type McpLoadingMode, type McpToolRegistration } from '../src/lazy-mcp.ts'
import { createMcpClientFixture, type McpClientFixture } from './fixtures/mcp-client-fixture.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
const ROW = 'global-server'
const ROW_KEY = `global:${ROW}`
const PUBLIC_TOOL = `mcp__${ROW}__echo`
const TOOLS = [{ name: 'echo', description: 'Echo one argument', inputSchema: { type: 'object' } }]

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The composition file one rig mounts, kept verbatim for the byte comparison. */
const composition = [
  '- id: global-server',
  `  name: '${MCP}'`,
  '  config:',
  '    transport: stdio',
  `    serverName: ${ROW}`,
  '    command: fixture-server',
  '    args: []',
  '    env: {}',
  "    cwd: ''",
  '',
].join('\n')

/** Let published microtasks and the pool's release queue settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

/** Write the temp composition file and point a context's baseUrl at it. */
async function compositionFile(): Promise<{ ctx: Context; dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-global-'))
  dirs.push(dir)
  const file = join(dir, 'cordis.yml')
  await writeFile(file, composition)
  const ctx = new Context()
  contexts.push(ctx)
  // `Include` resolves `path` against baseUrl, so a file URL in the same
  // directory is what makes './cordis.yml' land on the temp file.
  ctx.baseUrl = pathToFileURL(file).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.include = Include
  return { ctx, dir, file }
}

/** Mount the temp composition the way a profile does. */
async function mountInclude(ctx: Context): Promise<void> {
  await ctx.loader.create({ id: 'global-include', name: 'cordis:include', config: { path: './cordis.yml' } } as never)
  await ctx.loader.await()
  await settle()
}

const fixtureOf = (fixture: McpClientFixture) => (ctx: Context) => {
  ctx.loader.internal = {
    import: async (specifier: string) => {
      if (specifier === '@deepseek-ai/dsh-scope') return scopes
      if (specifier === MCP) return fixture.module
      throw new Error(`unexpected fixture module ${specifier}`)
    },
  } as never
}

describe('global plane zero-launch with a real file-backed Include', () => {
  it('never runs the mcp-client callback for a held global row under dynamic', async () => {
    const { ctx, file } = await compositionFile()
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.plugin({
      apply(child: Context) {
        child.provide('tools', { register: () => () => {}, schemas: () => [] } as never)
        child.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} } as never)
      },
    })
    const fixture = createMcpClientFixture()
    fixtureOf(fixture)(ctx)
    // The built artifact, mounted the way the host loads it.
    const entry = new Entry(ctx.get('loader'))
    entry.parent = ctx.get('loader').root
    entry.options = { id: 'mcp-manager', name: '@guowenzhang/dsh-mcp-manager' }
    await ctx.extend({ [Entry.key]: entry }).plugin(plugin, {})
    // The composition file mounts after the plugin is active, which is the
    // order a profile uses: the bundle layer declares the manager first.
    await mountInclude(ctx)
    await vi.waitFor(async () => {
      const state = await (ctx.get('mcpManager') as {
        gateState(request: object): Promise<{ suppressed: string[] }>
      }).gateState({})
      expect(state.suppressed).toContain(ROW_KEY)
    })
    // The row exists and is held, and its plugin callback — the only place the
    // real mcp-client starts a child process — never ran.
    expect(fixture.applyCalls).toBe(0)
    // Holding it did not touch the user's file.
    expect(await readFile(file, 'utf8')).toBe(composition)
  })

  it('mounts the same global row after switching to eager and keeps the file intact', async () => {
    const rig = await manualRig()
    await mountInclude(rig.ctx)
    await rig.gate.reconcile()

    expect(rig.fixture.applyCalls).toBe(0)
    expect(rig.gate.globalRows?.()).toMatchObject([{ entryId: ROW, enabled: true, held: true, mounted: false }])
    expect(await readFile(rig.file, 'utf8')).toBe(composition)

    rig.mode.value = 'eager'
    await rig.gate.reconcile()
    await rig.ctx.loader.await()
    await vi.waitFor(() => { expect(rig.fixture.applyCalls).toBe(1) })
    expect(rig.gate.globalRows?.()).toMatchObject([{ entryId: ROW, enabled: true, held: false, mounted: true }])
    expect(rig.gate.suppressedKeys()).not.toContain(ROW_KEY)

    // Both directions of the hold left the user's composition byte-identical.
    expect(await readFile(rig.file, 'utf8')).toBe(composition)
    await rig.dispose()
  })

  it('keeps the held global row loadable on demand through the host pool', async () => {
    const rig = await manualRig()
    await mountInclude(rig.ctx)
    await rig.gate.reconcile()

    // Held, but still allowed: the mode decides when, not whether.
    expect(rig.gate.globalRows?.()).toMatchObject([{ entryId: ROW, enabled: true, held: true }])
    expect(listMcpRows(rig.ctx, rig.gate).map(row => `${row.serverName}:${row.enabled}`)).toEqual([`${ROW}:true`])

    const session = rig.session('session-a')
    const loaded = await rig.call('mcp_load', { server: ROW }, session)
    expect(loaded).toMatchObject({ server: ROW, hidden: 0 })
    expect((loaded.tools as { name: string }[]).map(tool => tool.name)).toEqual([PUBLIC_TOOL])
    // The connection came from the host pool, not from a mounted row.
    expect(rig.counters.opened).toBe(1)
    expect(rig.fixture.applyCalls).toBe(0)
    expect(await readFile(rig.file, 'utf8')).toBe(composition)
    await rig.dispose()
  })

  it('holds a global row the composition mounted before this plugin was imported', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-global-b-'))
    dirs.push(dir)
    const file = join(dir, 'cordis.yml')
    // Shape B: the anchor holds the manager row, and the profile patch layer
    // inserts the MCP row at its top level. That row is part of the composition,
    // so the Loader builds and imports it before this plugin exists.
    const anchor = [
      '- id: mcp-manager',
      "  name: '@guowenzhang/dsh-mcp-manager'",
      '',
    ].join('\n')
    await writeFile(file, anchor)
    ctx.baseUrl = pathToFileURL(file).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    ctx.loader.builtins.include = Include
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentPresets, { default: 'standard' })
    await ctx.plugin({
      apply(child: Context) {
        child.provide('tools', { register: () => () => {}, schemas: () => [] } as never)
        child.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} } as never)
      },
    })
    const fixture = createMcpClientFixture()
    ctx.loader.internal = {
      import: async (specifier: string) => {
        if (specifier === '@deepseek-ai/dsh-scope') return scopes
        if (specifier === MCP) return fixture.module
        if (specifier === MANAGER) return plugin
        throw new Error(`unexpected fixture module ${specifier}`)
      },
    } as never
    await ctx.loader.create({
      id: 'anchor', name: 'cordis:include',
      config: { path: './cordis.yml', patches: [{ insert: [{
        id: ROW, name: MCP,
        config: { transport: 'stdio', serverName: ROW, command: 'fixture-server', args: [], env: {}, cwd: '' },
      }] }] },
    } as never)
    await ctx.loader.await()
    await settle()
    // The composition started it once before the manager row was applied.
    expect(fixture.applyCalls).toBe(1)
    await vi.waitFor(async () => {
      expect((await gateState(ctx)).suppressed).toContain(ROW_KEY)
    })
    // Held from here on: the process is stopped without touching the file.
    const entry = globalRowEntry(ctx)
    expect(entry?.fiber?.uid ?? null).toBeNull()
    expect((entry?.options as { disabled?: unknown } | undefined)?.disabled ?? null).toBeNull()
    const roster = await mcpRoster(ctx)
    const rows = roster.entries as { entryId?: string; serverName?: string; enabled: boolean; fiberPhase: string | null }[]
    expect(rows.find(row => (row.entryId ?? row.serverName) === ROW))
      .toMatchObject({ enabled: true, fiberPhase: 'held' })
    expect(await readFile(file, 'utf8')).toBe(anchor)
  })

  it('releases that late-held row under eager and keeps the file intact', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-global-b-'))
    dirs.push(dir)
    const file = join(dir, 'cordis.yml')
    await writeFile(file, '[]\n')
    ctx.baseUrl = pathToFileURL(file).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    ctx.loader.builtins.include = Include
    const fixture = createMcpClientFixture()
    fixtureOf(fixture)(ctx)
    // The row is already a mounted composition row before any gate exists.
    await ctx.loader.create({
      id: 'anchor', name: 'cordis:include',
      config: { path: './cordis.yml', patches: [{ insert: [{
        id: ROW, name: MCP,
        config: { transport: 'stdio', serverName: ROW, command: 'fixture-server', args: [], env: {}, cwd: '' },
      }] }] },
    } as never)
    await ctx.loader.await()
    await settle()
    expect(fixture.applyCalls).toBe(1)

    const rig = await attachRig(ctx, file, fixture)
    await rig.gate.reconcile()
    expect(rig.gate.globalRows?.()).toMatchObject([{ entryId: ROW, enabled: true, held: true, mounted: false }])
    expect(listMcpRows(ctx, rig.gate).map(row => `${row.serverName}:${row.enabled}`)).toEqual([`${ROW}:true`])
    expect(await readFile(file, 'utf8')).toBe('[]\n')

    const loaded = await rig.call('mcp_load', { server: ROW }, rig.session('session-a'))
    expect(loaded).toMatchObject({ server: ROW, hidden: 0 })
    expect(rig.counters.opened).toBe(1)
    expect(await readFile(file, 'utf8')).toBe('[]\n')

    rig.mode.value = 'eager'
    await rig.gate.reconcile()
    await ctx.loader.await()
    await vi.waitFor(() => { expect(fixture.applyCalls).toBe(2) })
    expect(rig.gate.globalRows?.()).toMatchObject([{ entryId: ROW, enabled: true, held: false, mounted: true }])
    expect(await readFile(file, 'utf8')).toBe('[]\n')
    await rig.dispose()
  })
})

/** The manager package name a profile row uses. */
const MANAGER = '@guowenzhang/dsh-mcp-manager'

/** The one composed mcp-client entry, wherever the include holds it. */
const globalRowEntry = (ctx: Context) => [...(ctx.loader.entries() as Iterable<{
  readonly id: string
  readonly options: { readonly name?: string; readonly disabled?: unknown }
  readonly fiber?: { readonly uid: number | null } | undefined
}> )].find(entry => entry.options.name === MCP)

const gateState = async (ctx: Context) => await (ctx.get('mcpManager') as {
  gateState(request: object): Promise<{ suppressed: string[] }>
}).gateState({})

const mcpRoster = async (ctx: Context) => await (ctx.get('mcpManager') as {
  listMcps(request: object): Promise<Record<string, unknown>>
}).listMcps({})

/** One session over a scope the global plane admits. */
interface Session {
  readonly id: string
  readonly agent: { readonly id: string; readonly ctx: Context }
}

/** The gate, pool and registration driven by hand, with the production wiring. */
interface ManualRig {
  readonly ctx: Context
  readonly fixture: McpClientFixture
  readonly gate: McpPreloadGate
  readonly reader: PresetMountReader
  readonly registration: McpToolRegistration
  readonly counters: { opened: number; closed: number; calls: number }
  readonly mode: { value: McpLoadingMode }
  readonly file: string
  session(id: string): Session
  call(name: string, args: unknown, session: Session): Promise<Record<string, unknown>>
  dispose(): Promise<void>
}

async function manualRig(): Promise<ManualRig> {
  const { ctx, file } = await compositionFile()
  const fixture = createMcpClientFixture()
  fixtureOf(fixture)(ctx)
  return await attachRig(ctx, file, fixture)
}

/**
 * Wire the gate, the pool and the tool registration onto a context that already
 * has its composition, mirroring the subscriptions `index.ts` installs.
 */
async function attachRig(ctx: Context, file: string, fixture: McpClientFixture): Promise<ManualRig> {
  const fibers = ctx as unknown as { on(name: string, listener: (...args: readonly never[]) => void): () => void }
  const reader = createPresetMountReader(ctx, scopes)
  const mode: { value: McpLoadingMode } = { value: 'dynamic' }
  const gate = createMcpPreloadGate(ctx, () => mode.value, reader, vi.fn())
  fibers.on('internal/plugin', fiber => { gate.onPublish({ fiber }) })
  fibers.on('loader/entry-init', entry => { gate.onEntryInit(entry as never) })
  /** Every definition the sessions registered, newest last. */
  const registrations: { readonly name: string; readonly definition: unknown; active: boolean }[] = []
  await ctx.plugin({
    apply(child: Context) {
      child.provide('tools', {
        register(definition: { name: string }) {
          const registration = { name: definition.name, definition, active: true }
          registrations.push(registration)
          return () => { registration.active = false }
        },
        schemas: () => [],
      } as never)
      // A global row has no captured declaration, so `mcp_load` reads its spec
      // through the manager. The stub answers with what the file declares.
      child.provide('mcpManager', {
        describeMcp: async () => ({ spec: {
          type: 'stdio', serverName: ROW, command: 'fixture-server', args: [], env: {},
        } }),
      } as never)
    },
  })
  const counters = { opened: 0, closed: 0, calls: 0 }
  const pool = createMcpConnectionPool({
    open: async () => {
      counters.opened += 1
      return {
        client: {
          listTools: async () => ({ tools: TOOLS }),
          callTool: async () => { counters.calls += 1; return { content: [{ type: 'text', text: 'echo' }] } },
          close: async () => { counters.closed += 1 },
        },
        tools: TOOLS,
      }
    },
    onToolsChanged: () => {},
    warn: vi.fn(),
  })
  const registration = registerMcpTools(ctx, mode.value, gate, undefined, pool, undefined, new McpCatalog())
  let syncing = false
  let dirty = false
  const resync = (): void => {
    dirty = true
    if (syncing) return
    syncing = true
    void (async () => {
      try {
        while (dirty) { dirty = false; await gate.reconcile(); await registration.refresh() }
      } finally { syncing = false }
    })()
  }
  for (const event of MCP_ROW_EVENTS) {
    fibers.on(event, (...args) => {
      if (event === 'loader/entry-init') {
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
  return {
    ctx, fixture, gate, reader, registration, counters, mode, file,
    session: (id) => {
      const scope = scopes.createScope(ctx, {})
      return { id, agent: { id, ctx: scope.ctx } }
    },
    call: (name, args, session) => {
      const found = registrations.find(entry => entry.active && entry.name === name)
      if (found === undefined) throw new Error(`tool "${name}" is not registered`)
      return (found.definition as { execute(args: unknown, exec: unknown): Promise<Record<string, unknown>> })
        .execute(args, { agent: session.agent })
    },
    dispose: async () => { await registration.dispose(); reader.dispose(); gate.dispose() },
  }
}
