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
      rows: [{ entryId: 'slow-server', moduleName: MCP_CLIENT, enabled: true, fiberPhase: 'loading' }],
    }])
    expect(activating.wasAwaited()).toBe(false)
  })

  it('reports every global MCP row with its phase and skips other rows', () => {
    const ctx = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: '/tmp/cordis.yml', config: {} } }),
      loaderEntry({ id: 'include:context7', name: MCP_CLIENT }, { disabled: false, fiber: { state: 2 } }),
      loaderEntry({ id: 'include:kingdee', name: MCP_CLIENT }, { disabled: true }),
      loaderEntry({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, { disabled: false, fiber: { state: 2 } }),
    ])

    expect(readMcpRoster(ctx, () => []).entries).toEqual([
      { entryId: 'include:context7', moduleName: MCP_CLIENT, enabled: true, fiberPhase: 'active' },
      { entryId: 'include:kingdee', moduleName: MCP_CLIENT, enabled: false, fiberPhase: null },
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
        { entryId: 'grouped', moduleName: MCP_CLIENT, enabled: true, fiberPhase: null },
        { entryId: 'gated', moduleName: MCP_CLIENT, enabled: 'conditional', fiberPhase: null },
        { entryId: 'plain', moduleName: MCP_CLIENT, enabled: true, fiberPhase: null },
      ],
    }])
  })

  it('reports the global plane writable wherever one file-backed Include is mounted', () => {
    // A patched Include is writable: the value is written to that file and the
    // Include is reloaded, so its patch layers stay where they are.
    const patched = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, {
        subtree: { filename: '/tmp/cordis.yml', config: { patches: [{ id: 'ui-theme' }] } },
      }),
    ])
    expect(readMcpRoster(patched, () => [])).toMatchObject({ globalWritable: true })

    const plain = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, {
        subtree: { filename: '/tmp/cordis.yml', config: { patches: [] } },
      }),
    ])
    expect(readMcpRoster(plain, () => [])).toMatchObject({ globalWritable: true })

    // No file-backed Include at all: nothing to write into.
    expect(readMcpRoster(contextWith([]), () => [])).toMatchObject({ globalWritable: false })

    // Two Includes name no single file to address.
    const both = contextWith([
      loaderEntry({ id: 'include', name: 'cordis:include' }, { subtree: { filename: '/tmp/a.yml' } }),
      loaderEntry({ id: 'include2', name: 'cordis:include' }, { subtree: { filename: '/tmp/b.yml' } }),
    ])
    expect(readMcpRoster(both, () => [])).toMatchObject({ globalWritable: false })
  })

  it('reports presets without a mounted profile editor as none', () => {
    const ctx = { get: () => undefined, root: { fiber: {} } } as unknown as Context
    expect(readMcpRoster(ctx, () => [])).toMatchObject({ entries: [], presets: [], globalWritable: false })
  })
})
