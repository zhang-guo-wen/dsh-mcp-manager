// @vitest-environment jsdom

import { act, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { McpEditor } from '../src/client/McpEditor.tsx'
import { en, zh, type McpSectionKey } from '../src/client/locales.ts'
import type { McpServer } from '../src/client/settings-controller.ts'
import type { DescribeMcpResult, ListMcpToolsResult, McpSpec } from '../src/types.ts'

// Keep host overlay/focus machinery outside this editor interaction suite.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Modal: ({ open, children, footer, onClose, closeLabel }: { open: boolean; children: ReactNode; footer: ReactNode; onClose: () => void; closeLabel: string }) => open ? (
    <div role="dialog"><button onClick={onClose}>{closeLabel}</button>{children}{footer}</div>
  ) : null,
  SegmentedTabs: ({ value, items, onChange, label }: { value: string; items: readonly { value: string; label: string }[]; onChange: (value: string) => void; label: string }) => (
    <div role="tablist" aria-label={label}>{items.map(item => <button key={item.value} role="tab" aria-selected={item.value === value} onClick={() => { onChange(item.value) }}>{item.label}</button>)}</div>
  ),
}))

type EditorProps = ComponentProps<typeof McpEditor>
const t = (key: McpSectionKey): string => en[key]
const localSpec: McpSpec = { type: 'stdio', command: 'node', args: ['fixture.mjs'] }
const result = (count: number): ListMcpToolsResult => ({ tools: Array.from({ length: count }, (_, index) => ({ name: `tool_${index}`, description: '', tokens: 1 })) })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function props(): EditorProps {
  return {
    open: true, mode: 'add', server: undefined, disabled: false, busy: false, error: null,
    describeMcp: vi.fn(async () => ({ target: { scope: 'global' as const }, entryId: 'fixture', spec: localSpec, serverName: 'fixture', disabled: false })),
    listMcpTools: vi.fn(async () => result(2)),
    presetName: preset => preset.name ?? preset.id,
    presets: [], plane: 'global', tab: 'config',
    globalWritable: true, globalCreatable: false, onEnableGlobal: vi.fn(async () => 'ready' as const),
    descriptionInitial: '', onUpdateDescription: vi.fn(async () => {}),
    toolRulesInitial: [], onUpdateTools: vi.fn(async () => {}), t,
    onClose: vi.fn(), onSubmit: vi.fn(),
  }
}


/** One roster row the editor can open. */
function server(overrides: Partial<McpServer> = {}): McpServer {
  return {
    entryId: 'fixture', serverName: 'fixture', scope: 'global', presetId: undefined,
    enabled: true, writable: true, fiberPhase: null, secretKeys: [], ...overrides,
  }
}

/** One describe answer for the row named by the request. */
function describedFor(request: { entryId: string }, overrides: Partial<DescribeMcpResult> = {}): DescribeMcpResult {
  return {
    target: { scope: 'global' }, entryId: request.entryId, serverName: 'fixture',
    spec: localSpec, disabled: false, ...overrides,
  }
}

let container: HTMLDivElement
let root: Root | undefined
let current: EditorProps

async function render(overrides: Partial<EditorProps> = {}): Promise<void> {
  current = { ...current, ...overrides }
  await act(async () => { root?.render(<McpEditor {...current} />) })
}

async function mount(overrides: Partial<EditorProps> = {}): Promise<void> {
  current = props()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await render(overrides)
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (found === undefined) throw new Error(`Button not found: ${label}`)
  return found
}

async function click(label: string): Promise<void> {
  await act(async () => { button(label).click() })
}

async function enter(label: string, value: string): Promise<void> {
  const field = [...container.querySelectorAll('input,textarea')].find(item => item.getAttribute('aria-label') === label)
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) throw new Error(`Field not found: ${label}`)
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter === undefined) throw new Error('Native field value setter is missing')
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function configure(spec: McpSpec = localSpec, name = 'fixture'): Promise<void> {
  await enter(t('mcp.form.json'), JSON.stringify(spec))
  await enter(t('mcp.form.serverName'), name)
}

beforeAll(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterAll(() => { vi.unstubAllGlobals() })
afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
})

describe('new MCP connection probe', () => {
  it('shows local catalogue persistence, guards duplicate clicks and does not save the declaration or tool rules', async () => {
    const pending = deferred<ListMcpToolsResult>()
    const listMcpTools = vi.fn(() => pending.promise)
    await mount({ listMcpTools })
    await configure()
    await act(async () => { button(t('mcp.form.probe')).click(); button(t('mcp.form.probe')).click() })
    expect(listMcpTools).toHaveBeenCalledTimes(1)
    expect(listMcpTools).toHaveBeenCalledWith({ spec: localSpec, serverName: 'fixture' })
    expect(button(t('mcp.form.probe')).disabled).toBe(true)
    expect(container.textContent).toContain(t('mcp.form.probePending'))
    expect(button(t('mcp.form.save')).disabled).toBe(false)
    await act(async () => { pending.resolve(result(2)) })
    expect(container.textContent).toContain(t('mcp.form.probeSuccessLocal').replace('{n}', '2'))
    expect(current.onSubmit).not.toHaveBeenCalled()
    expect(current.onUpdateDescription).not.toHaveBeenCalled()
    expect(current.onUpdateTools).not.toHaveBeenCalled()
    await click(t('mcp.form.save'))
    expect(current.onSubmit).toHaveBeenCalledWith({ target: { scope: 'global' }, serverName: 'fixture', spec: localSpec })
    expect(current.onUpdateTools).not.toHaveBeenCalled()
  })

  it('reports a failed probe, permits retry and still permits direct saving', async () => {
    const listMcpTools = vi.fn().mockRejectedValueOnce(new Error('Connection refused')).mockResolvedValueOnce(result(0))
    await mount({ listMcpTools })
    await configure()
    await click(t('mcp.form.probe'))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(t('mcp.form.probeFailed').replace('{reason}', 'Connection refused'))
    expect(button(t('mcp.form.probe')).disabled).toBe(false)
    await click(t('mcp.form.save'))
    expect(current.onSubmit).toHaveBeenCalledTimes(1)
    await click(t('mcp.form.probe'))
    expect(listMcpTools).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain(t('mcp.form.probeSuccessLocal').replace('{n}', '0'))
  })

  it.each(['streamable-http', 'http', 'sse'] as const)('reports memory-only caching for %s connections', async (type) => {
    await mount()
    const spec: McpSpec = { type, url: 'https://mcp.example.test/api' }
    await configure(spec, 'cloud')
    await click(t('mcp.form.probe'))
    expect(current.listMcpTools).toHaveBeenCalledWith({ spec, serverName: 'cloud' })
    expect(container.textContent).toContain(t('mcp.form.probeSuccessRemote').replace('{n}', '2'))
    expect(container.textContent).not.toContain('cached locally')
    expect(current.onSubmit).not.toHaveBeenCalled()
  })

  it('isolates a late spec response from a newer probe, including its busy state', async () => {
    const old = deferred<ListMcpToolsResult>()
    const next = deferred<ListMcpToolsResult>()
    const listMcpTools = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    await mount({ listMcpTools })
    await configure()
    await click(t('mcp.form.probe'))
    await enter(t('mcp.form.json'), JSON.stringify({ ...localSpec, args: ['new.mjs'] }))
    expect(container.textContent).not.toContain(t('mcp.form.probePending'))
    expect(button(t('mcp.form.probe')).disabled).toBe(false)
    await click(t('mcp.form.probe'))
    await act(async () => { old.resolve(result(9)) })
    expect(container.textContent).toContain(t('mcp.form.probePending'))
    expect(button(t('mcp.form.probe')).disabled).toBe(true)
    expect(container.textContent).not.toContain('9 tool(s)')
    await act(async () => { next.resolve(result(1)) })
    expect(container.textContent).toContain(t('mcp.form.probeSuccessLocal').replace('{n}', '1'))
  })

  it('clears feedback on rename and ignores an obsolete rejection', async () => {
    const old = deferred<ListMcpToolsResult>()
    const listMcpTools = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(result(3))
    await mount({ listMcpTools })
    await configure()
    await click(t('mcp.form.probe'))
    await enter(t('mcp.form.serverName'), 'renamed')
    await click(t('mcp.form.probe'))
    await act(async () => { old.reject(new Error('obsolete failure')) })
    expect(container.textContent).toContain(t('mcp.form.probeSuccessLocal').replace('{n}', '3'))
    expect(container.textContent).not.toContain('obsolete failure')
    await enter(t('mcp.form.serverName'), 'renamed-again')
    expect(container.textContent).not.toContain('Connected:')
  })

  it('discards results across close and reopen, even when the new form probes the same spec', async () => {
    const old = deferred<ListMcpToolsResult>()
    const next = deferred<ListMcpToolsResult>()
    const listMcpTools = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    await mount({ listMcpTools })
    await configure()
    await click(t('mcp.form.probe'))
    await click(t('mcp.form.cancel'))
    expect(current.onClose).toHaveBeenCalledTimes(1)
    await render({ open: false })
    await render({ open: true })
    expect(container.textContent).not.toContain(t('mcp.form.probePending'))
    await configure()
    await click(t('mcp.form.probe'))
    await act(async () => { next.resolve(result(4)); old.resolve(result(8)) })
    expect(container.textContent).toContain(t('mcp.form.probeSuccessLocal').replace('{n}', '4'))
    expect(container.textContent).not.toContain('8 tool(s)')
  })

  it('invalidates a pending probe when a credential field changes', async () => {
    const pending = deferred<ListMcpToolsResult>()
    await mount({ listMcpTools: vi.fn(() => pending.promise) })
    await configure({ ...localSpec, env: { DEMO_TOKEN: 'first' } })
    await click(t('mcp.form.probe'))
    await click(t('mcp.credential.tab'))
    await enter('DEMO_TOKEN', 'second')
    await act(async () => { pending.resolve(result(7)) })
    await click(t('mcp.form.tabConfig'))
    expect(container.textContent).not.toContain('Connected:')
    expect(container.textContent).not.toContain(t('mcp.form.probePending'))
    expect(button(t('mcp.form.probe')).disabled).toBe(false)
  })

  it('keeps the add target and edited JSON when the locale translator changes', async () => {
    const presets = [{ id: 'standard' }, { id: 'ptc' }]
    await mount({ plane: 'agent', preset: 'ptc', presets })
    await configure({ ...localSpec, args: ['edited.mjs'] }, 'edited-server')
    const target = container.querySelector('select')!
    await act(async () => { target.value = 'standard'; target.dispatchEvent(new Event('change', { bubbles: true })) })
    await render({ t: key => zh[key], presetName: preset => preset.id === 'standard' ? '标准模式' : 'PTC 模式' })
    expect(container.querySelector('select')?.value).toBe('standard')
    expect(container.querySelector('textarea')?.value).toContain('edited.mjs')
    // The roster already carried the presets; the dialog must not fetch again
    // and reset the form when its translator changes.
    expect(container.textContent).toContain('标准模式')
  })

  it('does not require a probe before saving and never offers the probe in edit mode', async () => {
    await mount()
    await configure()
    await click(t('mcp.form.save'))
    expect(current.onSubmit).toHaveBeenCalledTimes(1)
    expect(current.listMcpTools).not.toHaveBeenCalled()
    await render({ mode: 'edit' })
    expect([...container.querySelectorAll('button')].some(item => item.textContent === t('mcp.form.probe'))).toBe(false)
  })

  it('does not use the probe result as the tools pane listing or rewrite its filters', async () => {
    const listMcpTools = vi.fn().mockResolvedValueOnce(result(2)).mockResolvedValueOnce(result(1))
    await mount({ listMcpTools, plane: 'agent', preset: 'assistant', presets: [{ id: 'assistant', name: 'Assistant' }] })
    await configure()
    await click(t('mcp.form.probe'))
    await click(t('mcp.form.tabTools'))
    expect(listMcpTools).toHaveBeenCalledTimes(2)
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    await click(t('mcp.form.save'))
    expect(current.onUpdateTools).toHaveBeenCalledWith('preset:assistant:fixture', [])
  })

  it('keeps malformed JSON beside its field instead of making a connection', async () => {
    await mount()
    await enter(t('mcp.form.json'), '{')
    await click(t('mcp.form.probe'))
    expect(current.listMcpTools).not.toHaveBeenCalled()
    expect(container.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('uses Chinese feedback from the same typed dictionary', async () => {
    const translate = (key: McpSectionKey): string => zh[key]
    await mount({ t: translate })
    await enter(translate('mcp.form.json'), JSON.stringify(localSpec))
    await enter(translate('mcp.form.serverName'), 'fixture')
    await click(translate('mcp.form.probe'))
    expect(container.textContent).toContain(translate('mcp.form.probeSuccessLocal').replace('{n}', '2'))
  })
})

describe('editing an existing MCP row', () => {
  it('reports an initial read failure instead of presenting a blank configuration, and can retry', async () => {
    const describeMcp = vi.fn()
      .mockRejectedValueOnce(new Error('row disappeared'))
      .mockResolvedValueOnce(describedFor({ entryId: 'fixture' }))
    await mount({ mode: 'edit', server: server(), describeMcp })
    expect(container.textContent).toContain('row disappeared')
    expect(container.querySelector('textarea')?.value).toBe('')
    expect(button(t('mcp.form.save')).disabled).toBe(true)
    await click(t('mcp.retry'))
    expect(describeMcp).toHaveBeenCalledTimes(2)
    expect(container.querySelector('textarea')?.value).toContain('"command": "node"')
    expect(container.textContent).not.toContain('row disappeared')
    expect(button(t('mcp.form.save')).disabled).toBe(false)
  })

  it('lists the tools when the tools pane is opened while the row is still being read', async () => {
    const pending = deferred<DescribeMcpResult>()
    const listMcpTools = vi.fn(async () => result(2))
    await mount({
      mode: 'edit', server: server({ scope: 'preset', presetId: 'standard' }),
      describeMcp: vi.fn(() => pending.promise), listMcpTools,
    })
    await click(t('mcp.form.tabTools'))
    expect(listMcpTools).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(describedFor({ entryId: 'fixture' })) })
    expect(listMcpTools).toHaveBeenCalledWith({ spec: localSpec, serverName: 'fixture' })
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('ignores a tools listing that arrives after another row was opened', async () => {
    const late = deferred<ListMcpToolsResult>()
    const listMcpTools = vi.fn()
      .mockReturnValueOnce(late.promise)
      .mockRejectedValueOnce(new Error('second row failed'))
    const describeMcp = vi.fn(async (request: { entryId: string }) => describedFor(request, {
      serverName: request.entryId,
      spec: { type: 'stdio', command: `run-${request.entryId}` },
    }))
    await mount({
      mode: 'edit', server: server({ entryId: 'a', serverName: 'a', scope: 'preset', presetId: 'standard' }),
      describeMcp, listMcpTools,
    })
    await click(t('mcp.form.tabTools'))
    expect(listMcpTools).toHaveBeenCalledTimes(1)
    // Open row b while row a's listing is still in flight.
    await render({ server: server({ entryId: 'b', serverName: 'b', scope: 'preset', presetId: 'standard' }) })
    await click(t('mcp.form.tabTools'))
    expect(container.textContent).toContain('second row failed')
    await act(async () => { late.resolve(result(3)) })
    // Row a's tools must not appear under row b, and saving must not write a's
    // rules into b's setting key.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(container.textContent).not.toContain('tool_0')
    await click(t('mcp.form.save'))
    expect(current.onUpdateTools).not.toHaveBeenCalled()
  })

  it('clears a stored description when the field is emptied', async () => {
    await mount({
      mode: 'edit', server: server(), descriptionInitial: 'Old description',
      describeMcp: vi.fn(async () => describedFor({ entryId: 'fixture' })),
    })
    await enter(t('mcp.form.description'), '')
    await click(t('mcp.form.save'))
    expect(current.onSubmit).toHaveBeenCalledTimes(1)
    expect(current.onUpdateDescription).toHaveBeenCalledWith('global:fixture', '')
  })

  it('uses the configuration owner as the authoritative server name', async () => {
    await mount({
      mode: 'edit',
      server: server({ entryId: 'legacy-entry', serverName: 'legacy-entry' }),
      describeMcp: vi.fn(async () => describedFor({ entryId: 'legacy-entry' }, { serverName: 'renamed' })),
    })
    const name = [...container.querySelectorAll('input')].find(item => item.getAttribute('aria-label') === t('mcp.form.serverName'))
    expect(name?.value).toBe('renamed')
  })

  it('refuses to edit a row with no addressable id instead of offering a blank form', async () => {
    const describeMcp = vi.fn()
    await mount({ mode: 'edit', server: server({ entryId: null }), describeMcp })
    expect(container.textContent).toContain(t('mcp.error.unaddressable'))
    expect(button(t('mcp.form.save')).disabled).toBe(true)
    expect(describeMcp).not.toHaveBeenCalled()
  })
})
