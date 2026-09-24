import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { carrierFor, nativeDefinitions, swapNativeTools, visibleToolName } from '../src/mcp-carrier.ts'
import type { LazyClient, LazyTool } from '../src/mcp-carrier.ts'
import { NO_TOOL_FILTER, parseMcpToolFilter } from '../src/mcp-tool-filter.ts'

/** The definitions resolve services through this; the fake adapter reads nothing. */
const ctx = { logger: { warn: (): void => {} } } as unknown as Context

/** The harness adapter's contract reduced to what the carrier passes through. */
const adapter = (_ctx: Context, options: unknown): unknown => options

/** A connection double: the carrier only forwards calls into it. */
const client: LazyClient = {
  listTools: async () => ({ tools: [] }),
  callTool: async () => ({ content: [] }),
  close: async () => {},
}

/** A registry double that records live names and can reject one of them. */
function fakeRegistry(reject?: string): {
  registry: { register(definition: unknown): () => void; schemas(): readonly never[] }
  live: Set<string>
  disposed: string[]
} {
  const live = new Set<string>()
  const disposed: string[] = []
  return {
    registry: {
      register(definition: unknown): () => void {
        const name = (definition as { name: string }).name
        if (name === reject) throw new Error(`cannot register "${name}"`)
        live.add(name)
        return () => {
          live.delete(name)
          disposed.push(name)
        }
      },
      schemas: () => [],
    },
    live,
    disposed,
  }
}

const tool = (name: string, extra: Partial<LazyTool> = {}): LazyTool => ({ name, ...extra })

describe('carrierFor', () => {
  const rules = parseMcpToolFilter(['!delete_*'])

  it('uses no on-demand carrier under eager', () => {
    expect(carrierFor('eager', NO_TOOL_FILTER)).toBeUndefined()
    expect(carrierFor('eager', rules)).toBeUndefined()
  })

  it('keeps lazy on the proxy whatever the rules say', () => {
    expect(carrierFor('lazy', NO_TOOL_FILTER)).toBe('proxy')
    expect(carrierFor('lazy', rules)).toBe('proxy')
  })

  it('mounts an unfiltered dynamic row', () => {
    expect(carrierFor('dynamic', NO_TOOL_FILTER)).toBe('mount')
    expect(carrierFor('dynamic', parseMcpToolFilter([]))).toBe('mount')
    // A malformed stored value hides nothing, so it must not change the carrier.
    expect(carrierFor('dynamic', parseMcpToolFilter({ nope: true }))).toBe('mount')
  })

  it('registers a filtered dynamic row natively instead of proxying it', () => {
    expect(carrierFor('dynamic', rules)).toBe('native')
    expect(carrierFor('dynamic', parseMcpToolFilter(['get_workitem']))).toBe('native')
  })
})

describe('visibleToolName', () => {
  it('reports the upstream name for the proxy carrier', () => {
    expect(visibleToolName('proxy', 'srv', 'admin.reset')).toBe('admin.reset')
  })

  it('reports the registered public name for every native carrier', () => {
    expect(visibleToolName('mount', 'srv', 'get_item')).toBe('mcp__srv__get_item')
    expect(visibleToolName('native', 'srv', 'get_item')).toBe('mcp__srv__get_item')
    expect(visibleToolName('native', 'srv', 'admin.reset')).toMatch(/^mcp__srv__admin_reset_[0-9a-f]{12}$/)
  })
})

describe('nativeDefinitions', () => {
  it('names every visible tool with the mcp-client public contract', () => {
    const definitions = nativeDefinitions(ctx, adapter, 'srv', [
      tool('get_item'),
      tool('admin.reset'),
    ], client)
    expect([...definitions.keys()]).toEqual([
      'mcp__srv__get_item',
      expect.stringMatching(/^mcp__srv__admin_reset_[0-9a-f]{12}$/),
    ])
  })

  it('keeps the upstream schema so arguments bind natively', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    const definitions = nativeDefinitions(ctx, adapter, 'srv', [tool('get_item', { inputSchema: schema })], client)
    expect(definitions.get('mcp__srv__get_item')).toMatchObject({
      name: 'mcp__srv__get_item',
      rawName: 'get_item',
      inputSchema: schema,
    })
  })

  it('falls back to an unconstrained schema when the server declared none', () => {
    const definitions = nativeDefinitions(ctx, adapter, 'srv', [tool('bare')], client)
    expect(definitions.get('mcp__srv__bare')).toMatchObject({ inputSchema: {} })
  })

  it('forwards the upstream output schema and a required task support', () => {
    const definitions = nativeDefinitions(ctx, adapter, 'srv', [
      tool('structured', { outputSchema: { type: 'object' }, execution: { taskSupport: 'required' } }),
    ], client)
    expect(definitions.get('mcp__srv__structured')).toMatchObject({
      outputSchema: { type: 'object' },
      taskRequired: true,
    })
  })

  it('forwards one call to the connected client with its cancellation signal', async () => {
    const calls: unknown[][] = []
    const spy: LazyClient = {
      ...client,
      callTool: async (...args: unknown[]) => {
        calls.push(args)
        return { content: [] }
      },
    }
    const definitions = nativeDefinitions(ctx, adapter, 'srv', [tool('get_item')], spy)
    const definition = definitions.get('mcp__srv__get_item') as {
      call(args: Record<string, unknown>, execution: { signal: AbortSignal }): Promise<unknown>
    }
    const controller = new AbortController()
    await definition.call({ id: 'x' }, { signal: controller.signal })
    expect(calls).toEqual([[{ name: 'get_item', arguments: { id: 'x' } }, undefined, { signal: controller.signal }]])
  })

  it('rejects a server that lists one raw name twice', () => {
    expect(() => nativeDefinitions(ctx, adapter, 'srv', [tool('dup'), tool('dup')], client))
      .toThrow(/listed tool "dup" more than once/)
  })
})

describe('swapNativeTools', () => {
  it('registers the whole first generation', () => {
    const { registry, live } = fakeRegistry()
    const registrations = swapNativeTools(registry, new Map(), new Map([
      ['mcp__srv__a', { name: 'mcp__srv__a' }],
      ['mcp__srv__b', { name: 'mcp__srv__b' }],
    ]))
    expect([...registrations.keys()]).toEqual(['mcp__srv__a', 'mcp__srv__b'])
    expect([...live].sort()).toEqual(['mcp__srv__a', 'mcp__srv__b'])
  })

  it('keeps a surviving name registered and drops what the server removed', () => {
    const { registry, live, disposed } = fakeRegistry()
    const first = swapNativeTools(registry, new Map(), new Map([
      ['mcp__srv__a', { name: 'mcp__srv__a' }],
      ['mcp__srv__b', { name: 'mcp__srv__b' }],
    ]))
    const second = swapNativeTools(registry, first, new Map([
      ['mcp__srv__a', { name: 'mcp__srv__a' }],
      ['mcp__srv__c', { name: 'mcp__srv__c' }],
    ]))
    // The unchanged name keeps its exact registration: no churn in the model's tool list.
    expect(second.get('mcp__srv__a')).toBe(first.get('mcp__srv__a'))
    expect(disposed).toEqual(['mcp__srv__b'])
    expect([...live].sort()).toEqual(['mcp__srv__a', 'mcp__srv__c'])
  })

  it('unwinds a failed generation and leaves the previous one registered', () => {
    const { registry, live } = fakeRegistry('mcp__srv__bad')
    const first = swapNativeTools(registry, new Map(), new Map([['mcp__srv__a', { name: 'mcp__srv__a' }]]))
    expect(() => swapNativeTools(registry, first, new Map([
      ['mcp__srv__a', { name: 'mcp__srv__a' }],
      ['mcp__srv__bad', { name: 'mcp__srv__bad' }],
    ]))).toThrow(/cannot register/)
    expect([...live]).toEqual(['mcp__srv__a'])
    expect(first.has('mcp__srv__a')).toBe(true)
  })

  it('leaves nothing registered when the first generation fails', () => {
    const { registry, live } = fakeRegistry('mcp__srv__bad')
    expect(() => swapNativeTools(registry, new Map(), new Map([
      ['mcp__srv__ok', { name: 'mcp__srv__ok' }],
      ['mcp__srv__bad', { name: 'mcp__srv__bad' }],
    ]))).toThrow(/cannot register/)
    expect([...live]).toEqual([])
  })
})
