import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMcpPreloadGate, type GateEntry, type GateMount } from '../src/mcp-gate.ts'

const MCP = '@deepseek-ai/dsh-mcp-client'
// The gate asks the host context for the Loader to walk the global plane; a
// fixture without one composes no global rows.
const ctx = { root: { fiber: {} }, get: () => undefined } as unknown as Context
const target = { scope: 'preset', agentPreset: 'standard' } as const

function fixture(allowed = true) {
  const options = { id: 'row', name: MCP, disabled: !allowed, config: { transport: 'stdio', command: 'node' } }
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

  it('holds a row whose configuration cannot start, even though the user enabled it', async () => {
    const { entry, mount } = fixture(true)
    const [row] = mount.declaration as { config: unknown }[]
    row!.config = { transport: 'stdio', serverName: 'row', command: 'node', args: [], env: { TOKEN: '${env:DSH_GATE_SPEC_ABSENT}' }, cwd: '' }
    const gate = createMcpPreloadGate(ctx, () => 'eager', () => [mount], vi.fn())
    await gate.reconcile()
    // `eager` would mount it, but the unresolved variable keeps it out: the
    // marker the settings page shows and the unmount come from one decision.
    expect(gate.stateFor(target, 'row')).toEqual({ allowed: false, suppressed: false })
    expect(entry.fiber?.state).toBe(4)
    expect(gate.presetRows!()[0]?.rows[0]?.allowed).toBe(false)
  })

  it('holds a row whose command is blank', async () => {
    const { entry, mount } = fixture(true)
    const [row] = mount.declaration as { config: unknown }[]
    row!.config = { transport: 'stdio', serverName: 'row', command: '', args: [], env: {}, cwd: '' }
    const gate = createMcpPreloadGate(ctx, () => 'eager', () => [mount], vi.fn())
    await gate.reconcile()
    expect(gate.stateFor(target, 'row')?.allowed).toBe(false)
    expect(entry.fiber?.state).toBe(4)
  })
})

describe('publication-point hold', () => {
  /** A published fiber for one composed MCP row, with the Loader entry key attached. */
  function publication(options: Record<string, unknown>) {
    const dispose = vi.fn(async () => {})
    const update = vi.fn(async () => {})
    const rowOptions = { id: 'row', name: MCP, config: {}, ...options }
    const tree = { entries: () => [] }
    const entry = { options: rowOptions, disabled: false, tree, update } as unknown as GateEntry
    const fiber = { dispose, parent: { [Symbol.for('cordis.entry')]: entry } }
    return { fiber, entry, dispose, update, tree }
  }

  it('disposes the fiber before the plugin callback and marks the row held', () => {
    let publish!: (published: { fiber: unknown; entry?: GateEntry; tree?: unknown }) => void
    const gate = createMcpPreloadGate(
      ctx,
      () => 'dynamic',
      Object.assign(() => [], { ownsTree: (tree: unknown) => tree !== undefined }),
      vi.fn(),
      onPublish => { publish = onPublish; return () => {} },
    )
    const { fiber, entry, dispose, update, tree } = publication({})
    publish({ fiber, entry, tree })
    // Disposal happens in the publication observer itself: Cordis resolves the
    // fiber's dependencies only after this event, so the mcp-client callback
    // that would spawn the server never runs.
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({ disabled: true })
    expect(gate.suppressedEntryIds()).toEqual(['row'])
    gate.dispose()
  })

  it('shadows a file-backed row before disposal, so the hold cannot write to the user file', () => {
    let publish!: (published: { fiber: unknown; entry?: GateEntry; tree?: unknown }) => void
    const gate = createMcpPreloadGate(
      ctx,
      () => 'dynamic',
      Object.assign(() => [], { ownsTree: (tree: unknown) => tree !== undefined }),
      vi.fn(),
      onPublish => { publish = onPublish; return () => {} },
    )
    const { fiber, entry, dispose, update, tree } = publication({})
    // A file-backed Include: the Loader's self-dispose branch persists
    // `disabled` into this very file unless the entry reads as disabled
    // already, so the shadow must be in place before the fiber is disposed.
    const fileTree = Object.assign(tree, { filename: 'mcps.yml', write: vi.fn() })
    let disabledAtDispose: boolean | undefined
    dispose.mockImplementation(async () => {
      disabledAtDispose = (entry as unknown as { disabled: boolean }).disabled
    })
    publish({ fiber, entry, tree: fileTree })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(disabledAtDispose).toBe(true)
    // The declaration itself is never touched, so there is nothing to write.
    expect(update).not.toHaveBeenCalled()
    expect(fileTree.write).not.toHaveBeenCalled()
    expect(gate.suppressedEntryIds()).toEqual(['row'])
    gate.dispose()
  })

  it('leaves an entry the Loader has not identified yet alone', () => {
    let publish!: (published: { fiber: unknown; entry?: GateEntry; tree?: unknown }) => void
    const gate = createMcpPreloadGate(
      ctx,
      () => 'dynamic',
      Object.assign(() => [], { ownsTree: (tree: unknown) => tree !== undefined }),
      vi.fn(),
      onPublish => { publish = onPublish; return () => {} },
    )
    const { fiber, entry, dispose, tree } = publication({ id: undefined })
    publish({ fiber, entry, tree })
    expect(dispose).not.toHaveBeenCalled()
    expect(gate.suppressedEntryIds()).toEqual([])
    gate.dispose()
  })

  it('leaves eager mode, other plugins, and foreign trees alone', () => {
    for (const [mode, name, ownsTree] of [
      ['eager', MCP, true],
      ['dynamic', '@deepseek-ai/dsh-tool-pwsh', true],
      ['dynamic', MCP, false],
    ] as const) {
      let publish!: (published: { fiber: unknown; entry?: GateEntry; tree?: unknown }) => void
      const gate = createMcpPreloadGate(
        ctx,
        () => mode,
        Object.assign(() => [], { ownsTree: () => ownsTree }),
        vi.fn(),
        onPublish => { publish = onPublish; return () => {} },
      )
      const { fiber, entry, dispose, tree } = publication({ name })
      publish({ fiber, entry, tree })
      expect(dispose).not.toHaveBeenCalled()
      expect(gate.suppressedEntryIds()).toEqual([])
      gate.dispose()
    }
  })

  it('forgets a held row once the mode mounts it again', async () => {
    const { entry, mount } = fixture()
    let publish!: (published: { fiber: unknown }) => void
    let mode: 'eager' | 'dynamic' = 'dynamic'
    const gate = createMcpPreloadGate(
      ctx,
      () => mode,
      Object.assign(() => [mount], { ownsTree: () => true }),
      vi.fn(),
      onPublish => { publish = onPublish; return () => {} },
    )
    // The gate answers for the mount first, then a row is published while the
    // mode still holds it — the order a composition row really arrives in.
    await gate.reconcile()
    const fiber = { dispose: vi.fn(async () => {}) }
    publish({ fiber })
    expect(gate.suppressedEntryIds()).toEqual(['row'])
    mode = 'eager'
    await gate.reconcile()
    expect(gate.suppressedEntryIds()).toEqual([])
    expect(entry.fiber?.state).toBe(2)
    gate.dispose()
  })

  it('drops the subscription on dispose', () => {
    const unsubscribe = vi.fn()
    const gate = createMcpPreloadGate(ctx, () => 'dynamic', () => [], vi.fn(), () => unsubscribe)
    gate.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

/**
 * One entry as the Loader builds it: the constructor emits `loader/entry-init`
 * with no options and no parent group, then the group assigns both and calls
 * `update` — which is where a released row would import its plugin.
 */
function entryUnderConstruction() {
  let disabled = false
  // `disabled` lives on the prototype, as it does on a real `Entry`, so an own
  // property shadowing it can be installed and later removed.
  const prototype = {
    get disabled() { return disabled },
    set disabled(value: boolean) { disabled = value },
  }
  const entry = Object.create(prototype) as unknown as GateEntry & {
    options: { id?: string; name?: string; disabled?: boolean } | undefined
    parent: { tree?: unknown } | undefined
    fiber: { state: number; uid?: number } | undefined
    update: ReturnType<typeof vi.fn>
    init: ReturnType<typeof vi.fn>
  }
  entry.options = undefined
  entry.parent = undefined
  entry.fiber = undefined
  // Mirrors `Entry.update`: the options arrive as this call's argument and are
  // assigned first, a disabled row returns before `init`, and `init` is the step
  // that imports the plugin and creates its fiber.
  entry.init = vi.fn(async () => { entry.fiber = { state: 2, uid: 12 } })
  entry.update = vi.fn(async (patch?: { id?: string; name?: string; disabled?: boolean }) => {
    if (patch !== undefined) entry.options = patch
    if (entry.disabled) return
    await entry.init()
  })
  return { entry }
}

/**
 * The options the Loader passes to a row's first `update`. They arrive as that
 * call's argument — the entry still holds the previous, empty set — so the tests
 * supply them the way the Loader does.
 */
const rowOptions = (id = 'standard:row', name = MCP) => ({ id, name, config: {} })

describe('pre-mount hold (rows built before the plugin applied)', () => {
  const tree = { ctx: {} }

  function gateFor(mode: () => 'eager' | 'dynamic' | 'lazy', owns = true, onPublish?: () => void) {
    return createMcpPreloadGate(
      ctx,
      mode,
      Object.assign(() => [], { ownsTree: () => owns }),
      vi.fn(),
      onPublish === undefined ? undefined : () => onPublish,
    )
  }

  it.each(['dynamic', 'lazy'] as const)('keeps a composed MCP row from mounting under %s', async (mode) => {
    const gate = gateFor(() => mode)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')?.value).toBe(true)
    // Nothing is registered as held until the Loader reveals what the row is.
    expect(gate.suppressedEntryIds()).toEqual([])
    entry.parent = { tree }
    const update = entry.update
    await update(rowOptions() as never)
    // The plugin was never imported: the Loader's own update returned early.
    expect(entry.init).not.toHaveBeenCalled()
    expect(entry.fiber).toBeUndefined()
    expect(gate.suppressedEntryIds()).toEqual(['row'])
    gate.dispose()
  })

  it('hands a row back untouched when its options name something else', async () => {
    const gate = gateFor(() => 'dynamic')
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    entry.parent = { tree }
    await entry.update(rowOptions('other:row', '@deepseek-ai/dsh-something-else') as never)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    expect(entry.fiber).toEqual({ state: 2, uid: 12 })
    expect(gate.suppressedEntryIds()).toEqual([])
    gate.dispose()
  })

  it('hands a row back untouched when the tree is not this gate\'s preset', async () => {
    const gate = gateFor(() => 'dynamic', false)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    entry.parent = { tree }
    await entry.update(rowOptions('other:row', '@deepseek-ai/dsh-something-else') as never)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    expect(entry.fiber).toEqual({ state: 2, uid: 12 })
    gate.dispose()
  })

  it('never holds a row while the mode is eager', async () => {
    const gate = gateFor(() => 'eager')
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    entry.parent = { tree }
    await entry.update(rowOptions() as never)
    expect(entry.fiber).toEqual({ state: 2, uid: 12 })
    gate.dispose()
  })

  it('hands the row back before an eager commit mounts it again', async () => {
    let mode: 'eager' | 'dynamic' = 'dynamic'
    const { entry, mount } = fixture()
    const gate = createMcpPreloadGate(
      ctx,
      () => mode,
      Object.assign(() => [mount], { ownsTree: () => true }),
      vi.fn(),
    )
    const built = entryUnderConstruction()
    gate.onEntryInit(built.entry)
    built.entry.parent = { tree }
    await built.entry.update(rowOptions() as never)
    expect(Object.getOwnPropertyDescriptor(built.entry, 'disabled')?.value).toBe(true)
    expect(gate.suppressedEntryIds()).toEqual(['row'])
    mode = 'eager'
    await gate.reconcile()
    // The override is gone, so the Loader can really update the row again.
    expect(Object.getOwnPropertyDescriptor(built.entry, 'disabled')).toBeUndefined()
    expect(gate.suppressedEntryIds()).toEqual([])
    built.entry.disabled = false
    await built.entry.update(rowOptions() as never)
    expect(built.entry.fiber).toEqual({ state: 2, uid: 12 })
    gate.dispose()
  })
})

/**
 * A file-backed include as the Loader mounts it: the root entry carries the
 * subtree that owns the global composition file, and its rows are built the
 * same way a preset's are.
 */
function includeFixture(rows: readonly { id: string; name: string; disabled?: boolean }[]) {
  const entries = rows.map(row => {
    const options: { id: string; name: string; disabled?: boolean } = { id: row.id, name: row.name }
    if (row.disabled !== undefined) options.disabled = row.disabled
    return { options, disabled: row.disabled === true, fiber: { state: 2, uid: 7 } } as unknown as GateEntry
  })
  // A real `EntryTree` declares `ctx` on every tree, so `filename` is what marks
  // the file-backed include rather than an in-memory composed tree.
  const tree = { entries: () => entries, filename: '/tmp/cordis.yml', write: () => {} }
  const include = { id: 'global-include', options: { name: 'cordis:include' }, disabled: false, subtree: tree }
  return { include, tree, entries }
}

describe('global plane', () => {
  function gateWithGlobals(
    mode: () => 'eager' | 'dynamic' | 'lazy',
    include: unknown,
  ) {
    const ctxWithLoader = {
      root: { fiber: {} },
      get: (name: string) => (name === 'loader' ? { entries: () => [include] } : undefined),
    } as unknown as Context
    return createMcpPreloadGate(ctxWithLoader, mode, Object.assign(() => [], { ownsTree: () => false }), vi.fn())
  }

  it('holds a composed global row so its plugin never runs', async () => {
    const { include } = includeFixture([{ id: 'global-server', name: MCP }])
    const gate = gateWithGlobals(() => 'dynamic', include)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    // The include's tree carries a `filename` and no composed preset, which is
    // what marks the global plane.
    entry.parent = { tree: (include as { subtree: unknown }).subtree }
    const update = entry.update
    await update(rowOptions('global-server') as never)
    expect(entry.init).not.toHaveBeenCalled()
    expect(gate.suppressedEntryIds()).toEqual(['global-server'])
    const rows = gate.globalRows!()
    expect(rows).toEqual([{ entryId: 'global-server', enabled: true, held: true, mounted: true }])
    gate.dispose()
  })

  it('never holds a global row under eager and releases it on the switch', async () => {
    const { include } = includeFixture([{ id: 'global-server', name: MCP }])
    let mode: 'eager' | 'dynamic' = 'dynamic'
    const gate = gateWithGlobals(() => mode, include)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    entry.parent = { tree: (include as { subtree: unknown }).subtree }
    await entry.update(rowOptions('global-server') as never)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')?.value).toBe(true)
    mode = 'eager'
    await gate.reconcile()
    // The hold is gone and the Loader was asked to mount the row again.
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    expect(entry.init).toHaveBeenCalled()
    expect(gate.suppressedEntryIds()).toEqual([])
    expect(gate.globalRows!()[0]).toEqual({ entryId: 'global-server', enabled: true, held: false, mounted: true })
    gate.dispose()
  })

  it('reports a user-disabled global row as not enabled and leaves it alone', async () => {
    const { include } = includeFixture([{ id: 'off', name: MCP, disabled: true }])
    const gate = gateWithGlobals(() => 'dynamic', include)
    await gate.reconcile()
    expect(gate.globalRows!()).toEqual([{ entryId: 'off', enabled: false, held: false, mounted: true }])
    expect(gate.suppressedKeys()).toEqual([])
    gate.dispose()
  })

  it('drops the mode hold once the user disables a global row at runtime', async () => {
    const { include, entries } = includeFixture([{ id: 'global-server', name: MCP }])
    // Holding a mounted row disposes its fiber; this fixture is not a real one,
    // so it gains only the method the hold calls (keeping uid and state).
    const fiber = entries[0]!.fiber as { dispose?: () => Promise<void> }
    fiber.dispose = async () => { entries[0]!.fiber = undefined }
    const gate = gateWithGlobals(() => 'dynamic', include)
    await gate.reconcile()
    // The mode holds a row the user allows: the settings surface's fallback flag
    // is on, and the row itself reads as enabled.
    expect(gate.suppressedKeys()).toEqual(['global:global-server'])
    expect(gate.stateFor({ scope: 'global' }, 'global-server')).toEqual({ allowed: true, suppressed: true })

    // The user disables it from the settings page: the Include file is written
    // and reloaded, so the row's own declaration now carries `disabled: true`.
    entries[0]!.options.disabled = true
    await gate.reconcile()

    // No longer suppressed. A stale flag is what left the switch reading "on"
    // for a row the user had just turned off.
    expect(gate.suppressedKeys()).toEqual([])
    expect(gate.stateFor({ scope: 'global' }, 'global-server')).toEqual({ allowed: false, suppressed: false })
    // The hold is a different question: the row is still held unmounted, which
    // is what the roster reports as `held` — a resting state D15 marks with
    // nothing at all.
    expect(gate.suppressedEntryIds()).toEqual(['global-server'])
    gate.dispose()
  })

  it('ignores a tree that is neither a preset nor the global include', async () => {
    const gate = gateWithGlobals(() => 'dynamic', includeFixture([{ id: 'row', name: MCP }]).include)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    entry.options = { id: 'row', name: MCP, config: {} }
    // An in-memory composed tree: it carries `ctx`, as every EntryTree does, and
    // no composition file.
    entry.parent = { tree: { entries: () => [], ctx: {} } }
    await entry.update(rowOptions() as never)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    expect(entry.init).toHaveBeenCalled()
    gate.dispose()
  })

  it('does not mistake a file-backed tree without a write path for the global plane', async () => {
    const gate = gateWithGlobals(() => 'dynamic', includeFixture([{ id: 'row', name: MCP }]).include)
    const { entry } = entryUnderConstruction()
    gate.onEntryInit(entry)
    entry.parent = { tree: { entries: () => [], filename: '/tmp/other.yml' } }
    await entry.update(rowOptions() as never)
    expect(Object.getOwnPropertyDescriptor(entry, 'disabled')).toBeUndefined()
    expect(entry.init).toHaveBeenCalled()
    gate.dispose()
  })
})

