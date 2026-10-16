import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { readMcpRoster } from '../src/mcp-roster.ts'
import type { GateMount } from '../src/mcp-gate.ts'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const AGENT_PRESET = '@deepseek-ai/dsh-agent-preset'

/**
 * A root-Loader entry double. `await` and `inertia` are trapped so a read that
 * waits for activation fails loudly instead of hanging the spec.
 */
function loaderEntry(options: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: options.id as string,
    options,
    disabled: false,
    ...extra,
    get await(): never { throw new Error(`the roster read awaited ${String(options.id)}`) },
    get inertia(): never { throw new Error(`the roster read read inertia of ${String(options.id)}`) },
  }
}

/**
 * A live preset row double whose plugin is still activating. Nothing may await
 * it: the roster read must report its phase and return.
 */
function activatingRow(id: string) {
  let awaited = false
  return {
    row: {
      options: { id, name: MCP_CLIENT },
      disabled: false,
      fiber: { state: 1 },
      get inertia(): never { throw new Error(`the roster read read inertia of ${id}`) },
      get settle(): never { throw new Error(`the roster read awaited ${id}`) },
    },
    wasAwaited: () => awaited,
  }
}

function contextWith(
  loaderEntries: readonly unknown[],
  presetOptions: readonly Record<string, unknown>[] = [],
): Context {
  return {
    get: (name: string) => {
      if (name === 'loader') return { entries: () => loaderEntries[Symbol.iterator]() }
      if (name === 'configEditor') {
        return { entries: () => presetOptions.map(options => ({ options })) }
      }
      return undefined
    },
    root: { fiber: {} },
  } as unknown as Context
}

const mountOf = (...rows: readonly unknown[]): GateMount => ({
  presetId: 'standard',
  tree: { entries: () => rows[Symbol.iterator]() },
} as unknown as GateMount)

describe('readMcpRoster', () => {
  it('answers while a preset row is still activating', () => {
    const activating = activatingRow('standard:slow-server')
    const ctx = contextWith(
      [loaderEntry({ id: 'include', name: 'cordis:include' }, {
        subtree: { filename: '/tmp/cordis.yml', config: {} },
      })],
      [{
        id: 'preset-standard',
        name: AGENT_PRESET,
        config: { id: 'standard', name: 'Standard', plugins: [{ id: 'slow-server', name: MCP_CLIENT }] },
      }],
    )

    const roster = readMcpRoster(ctx, () => [mountOf(activating.row)])

    expect(roster.presets).toEqual([{
      id: 'standard',
      name: 'Standard',
      rows: [{ entryId: 'slow-server', moduleName: MCP_CLIENT, enabled: true, writable: true, fiberPhase: 'loading', secretKeys: [] }],
    }])
    expect(activating.wasAwaited()).toBe(false)
  })

  it('reports every global MCP row with its phase and skips other rows', () => {
    const ctx = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: '/tmp/cordis.yml', config: {} } }),
      loaderEntry({ id: 'include:context7', name: MCP_CLIENT }, { disabled: false, fiber: { state: 2 } }),
      // A global row's enablement is the declaration's, which the Loader keeps
      // in the entry's own options; the gate shadows the instance property.
      loaderEntry({ id: 'include:kingdee', name: MCP_CLIENT, disabled: true }, { fiber: { state: 4 } }),
      loaderEntry({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, { disabled: false, fiber: { state: 2 } }),
    ])

    // The leaf id is the row's public name: it is what `mcp_load` accepts and
    // what the composed global projection reports, so a row the loader lists
    // under its qualified id is the same row and must not be listed twice.
    // These rows live in the host's own root Include, which is never a write
    // target, so the global plane reports them read-only.
    expect(readMcpRoster(ctx, () => []).entries).toEqual([
      { entryId: 'context7', moduleName: MCP_CLIENT, enabled: true, writable: false, readOnly: 'no-writable-include', fiberPhase: 'active', secretKeys: [] },
      { entryId: 'kingdee', moduleName: MCP_CLIENT, enabled: false, writable: false, readOnly: 'no-writable-include', fiberPhase: null, secretKeys: [] },
    ])
  })

  it('falls back to the declaration for a preset that owns no live mount', () => {
    const ctx = contextWith([], [{
      id: 'preset-standard',
      name: AGENT_PRESET,
      config: {
        id: 'standard',
        plugins: [
          { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'grouped', name: MCP_CLIENT }] },
          { id: 'gated', name: MCP_CLIENT, disabled: { __jsExpr: 'process.platform === "win32"' } },
          { id: 'plain', name: MCP_CLIENT },
        ],
      },
    }])

    expect(readMcpRoster(ctx, () => []).presets).toEqual([{
      id: 'standard',
      rows: [
        // A group's enablement is inherited, and a `!!js` node stays conditional
        // because only a mount can evaluate it.
        { entryId: 'grouped', moduleName: MCP_CLIENT, enabled: true, writable: true, fiberPhase: null, secretKeys: [] },
        { entryId: 'gated', moduleName: MCP_CLIENT, enabled: 'conditional', writable: true, fiberPhase: null, secretKeys: [] },
        { entryId: 'plain', moduleName: MCP_CLIENT, enabled: true, writable: true, fiberPhase: null, secretKeys: [] },
      ],
    }])
  })

  it('reports a mounted row by its declaration, not by the gate\'s own disabled flag', () => {
    // Under `dynamic`/`lazy` the gate really does set `disabled` on every
    // allowed row it holds unmounted, so the live flag cannot answer "does the
    // user allow this?". Reading it here made the whole preset plane render as
    // "disabled"; the declaration is the answer.
    const ctx = contextWith([], [{
      id: 'preset-standard',
      name: AGENT_PRESET,
      config: { id: 'standard', plugins: [{ id: 'held', name: MCP_CLIENT }] },
    }])
    const held = {
      options: { id: 'held', name: MCP_CLIENT, config: { transport: 'stdio', serverName: 'held', command: 'node' } },
      disabled: true,
      fiber: { state: 4 },
    }

    expect(readMcpRoster(ctx, () => [mountOf(held)]).presets).toEqual([{
      id: 'standard',
      rows: [{ entryId: 'held', moduleName: MCP_CLIENT, enabled: true, writable: true, fiberPhase: null, secretKeys: [] }],
    }])
  })

  it('reports a row the preload gate held at publication as held, not stopped', () => {
    // A held row's fiber is disposed before its plugin ever runs, which is
    // otherwise the same reading as a row that started and stopped. The gate's
    // held set is what tells them apart.
    const ctx = contextWith([], [{
      id: 'preset-standard',
      name: AGENT_PRESET,
      config: { id: 'standard', plugins: [{ id: 'held', name: MCP_CLIENT }] },
    }])
    const held = {
      options: { id: 'held', name: MCP_CLIENT, config: { transport: 'stdio', serverName: 'held', command: 'node' } },
      disabled: true,
      fiber: { state: 4 },
    }
    const mount = () => [mountOf(held)]

    expect(readMcpRoster(ctx, mount, ['held']).presets[0]?.rows).toEqual([
      { entryId: 'held', moduleName: MCP_CLIENT, enabled: true, writable: true, fiberPhase: 'held', secretKeys: [] },
    ])
    // A row that is not held keeps reporting its real fiber state.
    expect(readMcpRoster(ctx, mount, []).presets[0]?.rows[0]?.fiberPhase).toBeNull()
  })

  it('still reports a row the declaration disables', () => {
    const ctx = contextWith([], [{
      id: 'preset-standard',
      name: AGENT_PRESET,
      config: { id: 'standard', plugins: [{ id: 'off', name: MCP_CLIENT, disabled: true }] },
    }])
    const off = {
      options: { id: 'off', name: MCP_CLIENT, config: { transport: 'stdio', serverName: 'off', command: 'node' } },
      disabled: true,
    }

    expect(readMcpRoster(ctx, () => [mountOf(off)]).presets[0]?.rows).toEqual([
      { entryId: 'off', moduleName: MCP_CLIENT, enabled: false, writable: true, fiberPhase: null, secretKeys: [] },
    ])
  })

  it('reports the global plane writable only for the user\'s own Include file', () => {
    // The value is written into that file and the Include is reloaded, so its
    // patch layers stay where they are — a patched Include stays writable.
    const patched = contextWith([
      loaderEntry({ id: 'mcps', name: 'cordis:include' }, {
        subtree: { filename: '/tmp/mcps.yml', config: { patches: [{ id: 'ui-theme' }] } },
      }),
    ])
    expect(readMcpRoster(patched, () => [])).toMatchObject({ globalWritable: true })

    const plain = contextWith([
      loaderEntry({ id: 'mcps', name: 'cordis:include' }, {
        subtree: { filename: '/tmp/mcps.yml', config: { patches: [] } },
      }),
    ])
    expect(readMcpRoster(plain, () => [])).toMatchObject({ globalWritable: true })

    // The host's own root anchor is not a write target: `prepareProfile`
    // rewrites its file on every start. Counting it made a profile that
    // declares its own Include look like a two-Include composition and closed
    // the whole plane.
    const anchorOnly = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: '/tmp/cordis.yml' } }),
    ])
    expect(readMcpRoster(anchorOnly, () => [])).toMatchObject({ globalWritable: false })

    // Shape A: the host anchor plus the Include the user declared inside it.
    // Exactly one file is addressable, so the plane is writable.
    const shapeA = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: '/tmp/cordis.yml' } }),
      loaderEntry({ id: 'include:mcps', name: 'cordis:include' }, { subtree: { filename: '/tmp/mcps.yml' } }),
    ])
    expect(readMcpRoster(shapeA, () => [])).toMatchObject({ globalWritable: true })

    // No file-backed Include at all: nothing to write into.
    expect(readMcpRoster(contextWith([]), () => [])).toMatchObject({ globalWritable: false })

    // Two user Includes name no single file to address.
    const both = contextWith([
      loaderEntry({ id: 'mcps-a', name: 'cordis:include' }, { subtree: { filename: '/tmp/a.yml' } }),
      loaderEntry({ id: 'mcps-b', name: 'cordis:include' }, { subtree: { filename: '/tmp/b.yml' } }),
    ])
    expect(readMcpRoster(both, () => [])).toMatchObject({ globalWritable: false })
  })

  it('marks a global row writable exactly when the user Include file declares it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roster-'))
    try {
      const file = join(dir, 'mcps.yml')
      writeFileSync(file, [
        '- id: declared',
        `  name: '${MCP_CLIENT}'`,
        '  config:',
        '    transport: stdio',
        '    serverName: declared',
        '    command: node',
        '',
      ].join('\n'))
      const ctx = contextWith(
        [loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: join(dir, 'cordis.yml') } }),
          loaderEntry({ id: 'include:mcps', name: 'cordis:include' }, { subtree: { filename: file } }),
          loaderEntry({ id: 'include:mcps:declared', name: MCP_CLIENT }, { disabled: false, fiber: { state: 4 } }),
          // A patch layer inserted this row into the composition, so the user's
          // file has nothing to patch for it.
          loaderEntry({ id: 'include:patched', name: MCP_CLIENT }, { disabled: false, fiber: { state: 4 } }),
        ],
      )
      const roster = readMcpRoster(ctx, () => [])
      expect(roster.globalWritable).toBe(true)
      expect(roster.entries).toMatchObject([
        { entryId: 'declared', writable: true },
        { entryId: 'patched', writable: false, readOnly: 'composed-row' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a composed global row\'s credential field names from the gate read', () => {
    // A global row lives inside the include's tree, so the roster's only read of
    // it is the gate's own; the config has to travel with that row or the
    // settings page cannot offer its credential editor.
    const ctx = contextWith([])
    const roster = readMcpRoster(ctx, () => [], [], [
      {
        entryId: 'gv-headers',
        enabled: true,
        held: false,
        mounted: true,
        config: { serverName: 'gv-headers', transport: 'streamable-http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer secret' } },
      },
      {
        entryId: 'gv-plain',
        enabled: true,
        held: false,
        mounted: true,
        config: { serverName: 'gv-plain', transport: 'streamable-http', url: 'https://x.test/mcp', headers: {} },
      },
    ])

    expect(roster.entries).toMatchObject([
      { entryId: 'gv-headers', secretKeys: ['Authorization'] },
      { entryId: 'gv-plain', secretKeys: [] },
    ])
    expect(JSON.stringify(roster)).not.toContain('Bearer secret')
  })

  it('reports presets without a mounted profile editor as none', () => {
    const ctx = { get: () => undefined, root: { fiber: {} } } as unknown as Context
    expect(readMcpRoster(ctx, () => [])).toMatchObject({ entries: [], presets: [], globalWritable: false })
  })

  it('reports a row\'s credential key names, and never their values', () => {
    // The settings page uses this to open a row on its credential editor, so
    // the answer has to name the fields without carrying the secrets: the value
    // of an `env` entry is exactly what must not reach the browser as data the
    // page could log or echo.
    const secret = 'sk-do-not-ship'
    const ctx = contextWith([], [{
      id: 'preset-standard',
      name: AGENT_PRESET,
      config: {
        id: 'standard',
        plugins: [
          { id: 'stdio-row', name: MCP_CLIENT },
          { id: 'http-row', name: MCP_CLIENT },
          { id: 'plain-row', name: MCP_CLIENT },
        ],
      },
    }])
    const rows = [
      { options: { id: 'stdio-row', name: MCP_CLIENT, config: { transport: 'stdio', serverName: 'stdio-row', command: 'node', env: { TOKEN: secret, REGION: 'cn' } } } },
      { options: { id: 'http-row', name: MCP_CLIENT, config: { transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: `Bearer ${secret}` } } } },
      { options: { id: 'plain-row', name: MCP_CLIENT, config: { transport: 'stdio', serverName: 'plain-row', command: 'node' } } },
    ]

    const roster = readMcpRoster(ctx, () => [mountOf(...rows)])

    expect(roster.presets[0]?.rows.map(row => row.secretKeys)).toEqual([
      ['TOKEN', 'REGION'],
      ['Authorization'],
      [],
    ])
    expect(JSON.stringify(roster)).not.toContain(secret)
  })
})
