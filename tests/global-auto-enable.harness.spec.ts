import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { Group, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { Include, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load } from 'js-yaml'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as scopes from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.mjs'
import { createMcpClientFixture } from './fixtures/mcp-client-fixture.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const MANAGER = '@guowenzhang/dsh-mcp-manager'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Let published microtasks, the reload and the gate settle. */
const settle = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

/** The manager instance the running plugin published. */
type Manager = {
  listMcps(request: object): Promise<{ entries: unknown[]; globalWritable: boolean; globalReason?: string }>
}

/**
 * A launched-profile composition with nothing but the host root anchor.
 *
 * The boot package is replaced by a small stand-in: it reads the profile patch
 * layer and applies it to the mounted root Include, which is the one effect the
 * production `reconcileProfilePatches` has on this composition. Compatibility
 * preflight is not exercised here — the isolated browser run covers the real
 * boot path.
 * @param dir - temp directory holding the profile files.
 * @param patches - base patch rows the root anchor starts with.
 */
async function bareProfile(dir: string): Promise<void> {
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n')
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(join(dir, 'cordis.yml')).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.group = Group
  ctx.loader.builtins.include = Include
  ctx.provide('profileContext', {
    name: 'test',
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: dir,
    cwd: dir,
    home: dir,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.plugin({
    apply(child: Context) {
      child.provide('tools', { register: () => () => {}, schemas: () => [] } as never)
      child.provide('systemPrompt', { getSectionOrder: () => 0, section: () => () => {} } as never)
    },
  })
  const fixture = createMcpClientFixture()
  const basePatches = [{ insert: [{ id: 'mcp-manager', name: MANAGER }] }]
  let includeEntry: Entry | undefined
  ctx.loader.internal = {
    import: async (specifier: string) => {
      if (specifier === '@deepseek-ai/dsh-scope') return scopes
      if (specifier === MCP) return fixture.module
      if (specifier === MANAGER) return plugin
      if (specifier === '@deepseek-ai/dsh-app-boot') {
        return {
          readProfilePatches(_bin: string, facts: { patchPath: string }) {
            let rows: unknown = []
            try { rows = load(readFileSync(facts.patchPath, 'utf8'), { schema: entryListSchema }) }
            catch { /* a missing patch layer contributes no rows */ }
            return [...basePatches, ...(Array.isArray(rows) ? rows : [])]
          },
          async reconcileProfilePatches(root: Context, patches: unknown[]) {
            if (includeEntry === undefined) throw new Error('root Include is not mounted')
            await includeEntry.update({ config: { path: './cordis.yml', patches } } as never)
            await (root.get('loader') as { await(): Promise<void> }).await()
          },
        }
      }
      throw new Error(`unexpected fixture module ${specifier}`)
    },
  } as never
  const includeId = await ctx.loader.create({
    id: 'include',
    name: 'cordis:include',
    config: { path: './cordis.yml', patches: basePatches },
  } as never)
  includeEntry = ctx.loader.resolve(includeId)
  await ctx.loader.await()
  await settle()
}

const managerOf = (ctx: Context): Manager => ctx.get('mcpManager') as Manager

describe('automatic global Include creation', () => {
  it('creates the profile Include on the first roster read, once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-global-auto-'))
    dirs.push(dir)
    await bareProfile(dir)
    const ctx = contexts[contexts.length - 1] as Context
    const anchorBefore = await readFile(join(dir, 'cordis.yml'), 'utf8')
    const includePath = join(dir, 'mcp.cordis.yml')
    expect(existsSync(includePath)).toBe(false)

    // Opening the management page issues this read; the page itself never had to
    // ask for the creation, so the plane is writable in the very answer it renders.
    const roster = await managerOf(ctx).listMcps({})
    await settle()
    expect(roster.globalWritable).toBe(true)
    expect(roster.globalReason).toBeUndefined()
    expect(existsSync(includePath)).toBe(true)
    expect(readFileSync(includePath, 'utf8').trim()).toBe('[]')
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('mcp-manager-global')
    expect(patch).toContain('cordis:include')
    // Never the host anchor: its file is regenerated on every start.
    expect(await readFile(join(dir, 'cordis.yml'), 'utf8')).toBe(anchorBefore)

    // A second read is a pure roster read: one attempt per process, one row.
    expect((await managerOf(ctx).listMcps({})).globalWritable).toBe(true)
    await settle()
    expect((readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').match(/mcp-manager-global/g) ?? []).length).toBe(1)
  })

  it('keeps the roster answer when the creation cannot run', async () => {
    // Without a profile there is no patch layer to name, so the automatic
    // attempt reports nothing usable and the read still answers the closed plane.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-global-auto-'))
    dirs.push(dir)
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
    await ctx.loader.create({
      id: 'include', name: 'cordis:include',
      config: { path: './cordis.yml', patches: [{ insert: [{ id: 'mcp-manager', name: MANAGER }] }] },
    } as never)
    await ctx.loader.await()
    await settle()
    const roster = await managerOf(ctx).listMcps({})
    expect(roster.globalWritable).toBe(false)
    expect(roster.globalReason).toBe('no-writable-include')
    expect(existsSync(join(dir, 'mcp.cordis.yml'))).toBe(false)
  })
})
