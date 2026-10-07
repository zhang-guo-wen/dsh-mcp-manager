import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMcpPreloadGate, type GateEntry, type GateMount } from '../src/mcp-gate.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
const ctx = { root: { fiber: {} } } as unknown as Context
const target = { scope: 'preset', agentPreset: 'standard' } as const

function fixture(allowed = true) {
  const options = { id: 'row', name: MCP, disabled: !allowed }
  const declaration = [{ ...options }]
  const entry = {
    options, disabled: !allowed, fiber: allowed ? { state: 2 } : undefined,
    update: vi.fn(async (patch) => {
      Object.assign(options, patch)
      entry.disabled = Boolean(options.disabled)
      if (entry.disabled) entry.fiber = { state: 4 }
      else entry.fiber = { state: 2 }
    }),
  } as GateEntry & { fiber: { state: number } | undefined; disabled: boolean }
  const mount: GateMount = { presetId: 'standard', scope: {}, declaration, tree: { entries: () => [entry] } }
  return { entry, declaration, mount }
}

describe('runtime-only MCP gate', () => {
  it('cycles eager/dynamic/lazy without latching suppression or editing declarations', async () => {
    const { entry, declaration, mount } = fixture()
    let mode: 'eager' | 'dynamic' | 'lazy' = 'dynamic'
    const gate = createMcpPreloadGate(ctx, () => mode, () => [mount], vi.fn())
    await gate.reconcile()
    expect(gate.stateFor(target, 'row')).toEqual({ allowed: true, suppressed: true })
    expect(entry.fiber?.state).toBe(4)
    const calls = entry.update as ReturnType<typeof vi.fn>
    expect(calls).toHaveBeenCalledWith({ disabled: true }, false, true)
    mode = 'lazy'
    await gate.reconcile()
    expect(calls).toHaveBeenCalledTimes(1)
    mode = 'eager'
    await gate.reconcile()
    expect(entry.fiber?.state).toBe(2)
    expect(gate.stateFor(target, 'row')).toEqual({ allowed: true, suppressed: false })
    expect(declaration[0]?.disabled).toBe(false)
  })

  it.each([{ state: 5 }, { state: 1, uid: null }])('joins a disposing fiber %j before eager starts its replacement', async (state) => {
    const { entry, mount } = fixture()
    let finish!: () => void
    const closing = new Promise<void>(resolve => { finish = resolve })
    const fiber = { ...state, inertia: closing }
    entry.fiber = fiber
    entry.options.disabled = true
    closing.then(() => { fiber.state = 4; delete (fiber as { inertia?: Promise<void> }).inertia })
    const gate = createMcpPreloadGate(ctx, () => 'eager', () => [mount], vi.fn())
    const run = gate.reconcile()
    await Promise.resolve()
    expect(entry.update).not.toHaveBeenCalled()
    finish()
    await run
    expect(entry.update).toHaveBeenCalledWith({ disabled: false }, false, true)
  })

  it('drives retained generations using separate declarations and prunes removed mounts', async () => {
    const old = fixture(true)
    const fresh = fixture(false)
    let mounts = [fresh.mount, old.mount]
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', () => mounts, vi.fn())
    await gate.reconcile()
    expect(gate.stateFor(target, 'row')?.allowed).toBe(false)
    expect(gate.presetRows!().map(revision => revision.rows[0]?.allowed)).toEqual([false, true])
    expect(old.entry.fiber?.state).toBe(4)
    mounts = []
    await gate.reconcile()
    expect(gate.stateFor(target, 'row')).toBeUndefined()
    expect(gate.presetRows!()).toEqual([])
  })
})
