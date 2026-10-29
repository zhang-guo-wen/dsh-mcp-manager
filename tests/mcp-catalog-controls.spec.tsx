// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpOptimizeSection, type McpOptimizeSectionProps } from '../src/client/McpOptimizeSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { McpCatalogStateResult, RefreshMcpCatalogResult } from '../src/types.ts'

// Keep Host overlay machinery out of this component's action/feedback tests.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Switch: ({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) => <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} />,
  Toast: ({ text }: { text: string; children?: ReactNode }) => <div role="status" data-toast>{text}</div>,
}))

const localEntry = { key: 'local:fixture', tools: 3, ageMs: 600_000, truncated: false, transport: 'stdio' as const, expired: false }
const remoteEntry = { key: 'server:cloud', tools: 4, ageMs: 120_000, truncated: false, transport: 'streamable-http' as const, expired: false }
const initial: McpCatalogStateResult = { entries: [localEntry, remoteEntry], total: 2 }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: Root | undefined
let container: HTMLDivElement
const dictionary = zh as Record<string, string>
function props(overrides: Partial<McpOptimizeSectionProps> = {}): McpOptimizeSectionProps {
  return {
    t: key => zh[key],
    useMcpSettings: selector => selector({ available: true, writable: true, loading: 'dynamic', descriptions: {}, tools: {}, optimize: {} }),
    setOptimize: vi.fn(async () => {}),
    catalogState: vi.fn(async () => initial),
    refreshCatalog: vi.fn(async () => ({ refreshed: 1, failed: [] })),
    clearCatalog: vi.fn(async () => ({ cleared: 2 })),
    ...overrides,
  } as McpOptimizeSectionProps
}
async function mount(face = props()) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<McpOptimizeSection {...face} />) })
  return face
}
function button(label: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  if (!target) throw new Error(`Missing button: ${label}`)
  return target
}
async function click(label: string) { await act(async () => { button(label).click() }) }
const refreshLabel = () => zh['opt.catalog.refresh']
const clearLabel = () => zh['opt.catalog.clear']
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { await act(async () => { root?.unmount() }); root = undefined; container?.remove(); vi.unstubAllGlobals() })

describe('MCP database catalogue controls', () => {
  it('places directory state inside the cache group with no manual TTL input', async () => {
    const face = await mount()
    const heading = [...container.querySelectorAll('h3')].find(node => node.textContent === zh['opt.group.catalog'])!
    const group = heading.closest('section')!
    expect(group.textContent).toContain(zh['opt.catalog.title'])
    expect(group.textContent).toContain('local:fixture')
    expect(group.textContent).toContain('server:cloud')
    expect(group.querySelectorAll('input')).toHaveLength(0)
    expect(container.querySelector('[data-optimize-field="catalogTtlMs"]')).toBeNull()
    expect(container.textContent).not.toContain('缓存有效期（分钟）')
    expect(container.textContent).toContain('数据库')
    expect(container.textContent).toContain('本地')
    expect(face.catalogState).toHaveBeenCalledTimes(1)
    expect(face.refreshCatalog).not.toHaveBeenCalled()
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('refreshes remote catalogues through the new RPC and shows a pending/success outcome', async () => {
    const pending = deferred<RefreshMcpCatalogResult>()
    const catalogState = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ entries: [localEntry, { ...remoteEntry, tools: 8, ageMs: 0 }], total: 2 })
    const face = await mount(props({ catalogState, refreshCatalog: vi.fn(() => pending.promise) }))
    await act(async () => { button(refreshLabel()).click(); button(refreshLabel()).click() })
    expect(face.refreshCatalog).toHaveBeenCalledTimes(1)
    expect(catalogState).toHaveBeenCalledTimes(1)
    expect(button(refreshLabel()).disabled).toBe(true)
    expect(button(clearLabel()).disabled).toBe(true)
    expect(container.textContent).toContain('local:fixture')
    expect(container.querySelector('[aria-label="工具目录缓存"] [role="status"]')?.textContent).toContain(zh['opt.catalog.refreshing'])
    await act(async () => { pending.resolve({ refreshed: 1, failed: [] }) })
    expect(catalogState).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('local:fixture')
    expect(container.textContent).toContain('server:cloud')
    expect(container.textContent).toMatch(/已刷新.*1/)
    expect(button(refreshLabel()).disabled).toBe(false)
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('keeps cached rows and names partial refresh failures without reporting full success', async () => {
    const face = await mount(props({ refreshCatalog: vi.fn(async () => ({ refreshed: 1, failed: [{ serverName: 'unreachable', reason: 'Connection refused' }] })) }))
    await click(refreshLabel())
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('unreachable')
    expect(alert?.textContent).toContain('Connection refused')
    expect(container.textContent).toContain('local:fixture')
    expect(container.textContent).toContain('server:cloud')
    expect(container.textContent).toMatch(/1.*失败|失败.*1/)
    expect(container.querySelector('[data-toast]')).toBeNull()
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('retains the last catalogue when refresh fails and allows retry', async () => {
    const refreshCatalog = vi.fn().mockRejectedValueOnce(new Error('Database unavailable')).mockResolvedValueOnce({ refreshed: 0, failed: [] })
    const face = await mount(props({ refreshCatalog }))
    await click(refreshLabel())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Database unavailable')
    expect(container.textContent).toContain('local:fixture')
    expect(container.textContent).toContain('server:cloud')
    expect(container.querySelector('[data-toast]')).toBeNull()
    expect(face.catalogState).toHaveBeenCalledTimes(1)
    expect(button(refreshLabel()).disabled).toBe(false)
    await click(refreshLabel())
    expect(refreshCatalog).toHaveBeenCalledTimes(2)
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('clears all stored entries through the existing clear RPC, not refresh or settings writes', async () => {
    const catalogState = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce({ entries: [], total: 0 })
    const face = await mount(props({ catalogState }))
    await click(clearLabel())
    expect(face.clearCatalog).toHaveBeenCalledTimes(1)
    expect(face.refreshCatalog).not.toHaveBeenCalled()
    expect(catalogState).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('local:fixture')
    expect(container.textContent).not.toContain('server:cloud')
    expect(container.textContent).toContain(zh['opt.catalog.cleared'].replace('{n}', '2'))
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('keeps the cached state and never reports success when clearing fails', async () => {
    const face = await mount(props({ clearCatalog: vi.fn(async () => { throw new Error('Write denied') }) }))
    await click(clearLabel())
    expect(face.clearCatalog).toHaveBeenCalledTimes(1)
    expect(face.catalogState).toHaveBeenCalledTimes(1)
    expect(face.refreshCatalog).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Write denied')
    expect(container.textContent).toContain('local:fixture')
    expect(container.textContent).toContain('server:cloud')
    expect(container.querySelector('[data-toast]')).toBeNull()
    expect(button(clearLabel()).disabled).toBe(false)
    expect(face.setOptimize).not.toHaveBeenCalled()
  })

  it('ignores an obsolete initial state read after an explicit refresh has completed', async () => {
    const old = deferred<McpCatalogStateResult>()
    const catalogState = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ entries: [{ ...remoteEntry, key: 'server:new' }], total: 1 })
    await mount(props({ catalogState }))
    await click(refreshLabel())
    expect(container.textContent).toContain('server:new')
    await act(async () => { old.resolve(initial) })
    expect(container.textContent).toContain('server:new')
    expect(container.textContent).not.toContain('local:fixture')
  })

  it('shows retained-local, manual-server and expired-server metadata from the Host', async () => {
    await mount(props({ catalogState: vi.fn(async () => ({ entries: [localEntry, remoteEntry, { ...remoteEntry, key: 'server:expired', ttlMs: 60_000, expired: true }], total: 3 })) }))
    expect(container.textContent).toContain(zh['opt.catalog.retention.local'])
    expect(container.textContent).toContain(zh['opt.catalog.retention.manual'])
    expect(container.textContent).toContain('已过期')
    expect(dictionary['opt.catalogTtl']).toBeUndefined()
    expect(dictionary['opt.catalogTtl.desc']).toBeUndefined()
  })
})
