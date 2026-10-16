import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { Include } from '@deepseek-ai/cordis-plugin-include'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.mjs'
import { createMcpClientFixture } from './fixtures/mcp-client-fixture.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const MANAGER = '@guowenzhang/dsh-mcp-manager'
const ROW = 'gfixture-a'
const PATCHED = 'gfixture-patched'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Let published microtasks, the Include reload and the gate settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

/** One MCP row declaration, as the user's own file spells it. */
const row = (id: string) => [
  `- id: ${id}`,
  `  name: '${MCP}'`,
  '  config:',
  '    transport: stdio',
  `    serverName: ${id}`,
  '    command: fixture-server',
  '    args: []',
  '    env: {}',
  "    cwd: ''",
  '',
].join('\n')

const rowOptions = (id: string) => ({
  id,
  name: MCP,
  config: { transport: 'stdio', serverName: id, command: 'fixture-server', args: [], env: {}, cwd: '' },
})

/** The manager instance the running plugin published. */
type Manager = {
  listMcps(request: object): Promise<{
    entries: {
      entryId: string | null
      enabled: boolean | 'conditional'
      writable: boolean
      readOnly?: string
      fiberPhase: string | null
    }[]
    globalWritable: boolean
  }>
  gateState(request: object): Promise<{ suppressed: string[] }>
  disableMcp(request: object): Promise<{ entryId: string; disabled: boolean }>
  addMcp(request: object): Promise<{ entryId: string; serverName: string }>
}

/**
 * Compose the shape A profile: the host's root anchor Include holds the manager
 * row and the user's own Include, whose file declares the global MCP rows.
 * @param dir - the temp directory holding both files.
 * @param patches - extra rows the anchor's patch layer inserts.
 */
async function shapeA(dir: string, patches: readonly unknown[] = []): Promise<void> {
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  await writeFile(join(dir, 'mcps.yml'), row(ROW))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(join(dir, 'cordis.yml')).href
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
    id: 'include', name: 'cordis:include',
    config: {
      path: './cordis.yml',
      patches: [{ insert: [
        { id: 'mcp-manager', name: MANAGER },
        { id: 'mcps', name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'mcps.yml')).href } },
        ...patches,
      ] }],
    },
  } as never)
  await ctx.loader.await()
  await settle()
}

const managerOf = (ctx: Context): Manager => ctx.get('mcpManager') as Manager

describe('global row authoring through the settings page', () => {
  it('toggles a row the user Include declares, and leaves the anchor and its patch layer alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-global-authoring-'))
    dirs.push(dir)
    await shapeA(dir)
    const ctx = contexts[contexts.length - 1] as Context
    const anchor = await readFile(join(dir, 'cordis.yml'), 'utf8')
    const user = await readFile(join(dir, 'mcps.yml'), 'utf8')

    // Shape A: the host anchor plus one Include of the user's own is exactly one
    // addressable file, so the plane is writable and the row has a home.
    const before = await managerOf(ctx).listMcps({})
    expect(before.globalWritable).toBe(true)
    // A row the mode holds unmounted reports `held`, which the surface shows as
    // an ordinary resting state (no marker), and the gate reports it suppressed.
    expect(before.entries).toMatchObject([{ entryId: ROW, enabled: true, writable: true, fiberPhase: 'held' }])
    expect((await managerOf(ctx).gateState({})).suppressed).toContain(`global:${ROW}`)

    const disabled = await managerOf(ctx).disableMcp({
      target: { scope: 'global' }, entryId: ROW, disabled: true,
    })
    await settle()
    // The result names the live entry by its qualified Loader id; the roster
    // reports the leaf id the settings page renders.
    expect(disabled).toMatchObject({ entryId: expect.stringContaining(ROW), disabled: true })

    // The write landed in the user's file, and the Include reloaded it.
    const afterDisable = await readFile(join(dir, 'mcps.yml'), 'utf8')
    expect(afterDisable).not.toBe(user)
    expect(afterDisable).toContain('disabled: true')
    expect(afterDisable).toContain(`id: ${ROW}`)
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchor)

    const roster = await managerOf(ctx).listMcps({})
    expect(roster.globalWritable).toBe(true)
    expect(roster.entries).toMatchObject([{ entryId: ROW, enabled: false, writable: true }])
    // The suppression answer follows the declaration: the user disabled this
    // row, so the Host stops reporting it suppressed. A stale flag here is what
    // left the switch reading "on" for a row the user had just turned off (the
    // page treats suppression as a fallback for an unstated enablement).
    expect((await managerOf(ctx).gateState({})).suppressed).not.toContain(`global:${ROW}`)
    // The live row carries the declaration the reload produced, not a shadow.
    const live = [...ctx.loader.entries()].find(entry =>
      entry.options.name === MCP && entry.options.id === ROW)
    expect(live?.options).toMatchObject({ id: ROW, disabled: true })

    const enabled = await managerOf(ctx).disableMcp({
      target: { scope: 'global' }, entryId: ROW, disabled: false,
    })
    await settle()
    // The answer comes from the declaration: the gate's own shadow reads
    // `disabled` on the live row whenever it holds one.
    expect(enabled).toMatchObject({ entryId: expect.stringContaining(ROW), disabled: false })
    const afterEnable = await readFile(join(dir, 'mcps.yml'), 'utf8')
    expect(afterEnable).not.toContain('disabled: true')
    expect(afterEnable).toContain(`id: ${ROW}`)
    // Never the anchor: its file is regenerated on every start.
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchor)
    expect((await managerOf(ctx).listMcps({})).entries)
      .toMatchObject([{ entryId: ROW, enabled: true, writable: true, fiberPhase: 'held' }])
    // Enabled again, so the mode holds it once more and the Host says so.
    expect((await managerOf(ctx).gateState({})).suppressed).toContain(`global:${ROW}`)

    // The plane is usable in both directions: a new global row also lands in
    // the user's file, never in the anchor.
    const added = await managerOf(ctx).addMcp({
      target: { scope: 'global' }, serverName: 'gfixture-b',
      spec: { type: 'stdio', command: 'fixture-server', args: [] },
    })
    await settle()
    expect(added).toMatchObject({ entryId: expect.stringContaining('gfixture-b'), serverName: 'gfixture-b' })
    const afterAdd = await readFile(join(dir, 'mcps.yml'), 'utf8')
    expect(afterAdd).toContain('id: gfixture-b')
    expect(afterAdd).toContain(`id: ${ROW}`)
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchor)
    expect((await managerOf(ctx).listMcps({})).entries)
      .toMatchObject([
        { entryId: ROW, enabled: true, writable: true },
        { entryId: 'gfixture-b', enabled: true, writable: true },
      ])
  })

  it('refuses a row only the composition declares, without touching either file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-global-authoring-'))
    dirs.push(dir)
    await shapeA(dir, [rowOptions(PATCHED)])
    const ctx = contexts[contexts.length - 1] as Context
    const anchor = await readFile(join(dir, 'cordis.yml'), 'utf8')
    const user = await readFile(join(dir, 'mcps.yml'), 'utf8')

    // Both rows are live and listed; only the one the user's file declares can
    // be written from here.
    const roster = await managerOf(ctx).listMcps({})
    expect(roster.globalWritable).toBe(true)
    expect(roster.entries).toMatchObject([
      { entryId: ROW, enabled: true, writable: true },
      { entryId: PATCHED, enabled: true, writable: false, readOnly: 'composed-row' },
    ])

    await expect(managerOf(ctx).disableMcp({
      target: { scope: 'global' }, entryId: PATCHED, disabled: true,
    })).rejects.toMatchObject({
      code: 'mcp/read-only',
      message: expect.stringMatching(/is not declared by .*mcps\.yml/),
    })
    await settle()
    expect(await readFile(join(dir, 'mcps.yml'), 'utf8')).toBe(user)
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchor)
  })

  it('closes the whole plane when the composition mounts only the host anchor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-global-authoring-'))
    dirs.push(dir)
    // Shape B: the global row arrives through the patch layer, so there is no
    // user Include file to patch at all.
    await writeFile(join(dir, 'cordis.yml'), '[]\n')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(join(dir, 'cordis.yml')).href
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
    const anchor = '[]\n'
    await ctx.loader.create({
      id: 'include', name: 'cordis:include',
      config: { path: './cordis.yml', patches: [{ insert: [
        { id: 'mcp-manager', name: MANAGER },
        rowOptions(ROW),
      ] }] },
    } as never)
    await ctx.loader.await()
    await settle()

    const roster = await managerOf(ctx).listMcps({})
    expect(roster.globalWritable).toBe(false)
    expect(roster.entries).toMatchObject([
      { entryId: ROW, enabled: true, writable: false, readOnly: 'no-writable-include' },
    ])

    await expect(managerOf(ctx).disableMcp({
      target: { scope: 'global' }, entryId: ROW, disabled: true,
    })).rejects.toMatchObject({
      code: 'mcp/read-only',
      message: expect.stringMatching(/Include of your own/),
    })
    await settle()
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchor)
  })
})
