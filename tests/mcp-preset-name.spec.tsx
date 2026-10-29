// @vitest-environment jsdom
import { act, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpSection, type McpSectionProps } from '../src/client/McpSection.tsx'
import { McpTargetSelect } from '../src/client/McpTargetSelect.tsx'
import { en, zh, type McpSectionKey } from '../src/client/locales.ts'
import { mcpPresetName } from '../src/client/preset-name.ts'
import type { BuiltInPresetCopyKey } from '@deepseek-ai/dsh-agent-preset-registry/display'

vi.mock('@deepseek-ai/dsh-client-store', () => ({ createSnapshotStore: () => ({}) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ variant: _v, size: _s, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props} />,
  IconChevronDownOutlineRegular: () => null,
  StateDot: () => null,
  Switch: () => <input type="checkbox" />,
  Toast: () => null,
  SegmentedControl: () => null,
  SegmentedTabs: ({ items, onChange }: { items: { value: string; label: string }[]; onChange: (id: string) => void }) => <div role="tablist">{items.map(item => <button key={item.value} role="tab" onClick={() => onChange(item.value)}>{item.label}</button>)}</div>,
  Menu: ({ anchor, items, open, onSelect }: { anchor: ReactNode; open: boolean; items: { id: string; label: string }[]; onSelect: (id: string) => void }) => <>{anchor}{open ? <div role="menu">{items.map(item => <button role="menuitem" key={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>)}</div> : null}</>,
}))
vi.mock('../src/client/McpOptimizeSection.tsx', () => ({ McpOptimizeSection: () => null, saveFailureMessage: String }))
vi.mock('../src/client/McpEditor.tsx', () => ({ McpEditor: () => null }))

let language: 'zh' | 'en' = 'zh'
const copy = { zh: { presetStandardName: '标准模式', presetPtcName: '编程模式', presetMinimalName: '极简模式', presetCordisName: '创造模式' }, en: { presetStandardName: 'Standard', presetPtcName: 'PTC', presetMinimalName: 'Minimal', presetCordisName: 'Creator' } }
const presetName = (preset: { id: string; name?: string }) => mcpPresetName(preset, (key: BuiltInPresetCopyKey) => (copy[language] as Record<string, string>)[key] ?? 'Description')
const raw = [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }, { id: 'custom', name: 'Research Agent' }]
const translate = () => (key: McpSectionKey) => language === 'zh' ? zh[key] : en[key]
const containers: { root: ReturnType<typeof createRoot>; element: HTMLDivElement }[] = []
function mount() { const element = document.createElement('div'); document.body.append(element); const root = createRoot(element); containers.push({ root, element }); return { root, element } }
afterEach(async () => { for (const item of containers.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; vi.unstubAllGlobals() })

function props(): McpSectionProps {
  return {
    useMcpSettings: select => select({ available: true, writable: true, loading: 'dynamic', descriptions: {}, tools: {}, optimize: {} }),
    t: translate(), presetName,
    mcps: vi.fn(async () => ({ presets: raw, globalWritable: true, servers: raw.map(preset => ({ entryId: preset.id, serverName: `server-${preset.id}`, scope: 'preset' as const, presetId: preset.id, enabled: true, writable: true, fiberPhase: null, secretKeys: [] })) })),
    presets: vi.fn(async () => raw), suppressedMcps: vi.fn(async () => []),
  } as McpSectionProps
}

describe('localized Agent names in MCP surfaces', () => {
  it('renders the filter and row scope using Host names, switches languages without re-reading the roster', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    language = 'zh'
    const { root, element } = mount()
    const face = props()
    await act(async () => root.render(<McpSection {...face} />))
    expect(element.textContent).toContain('标准模式')
    expect(element.querySelector('[data-mcp-name="server-standard"]')?.textContent).toContain('标准模式')
    const picker = () => element.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement
    await act(async () => picker().click())
    expect([...element.querySelectorAll('[role="menuitem"]')].map(el => el.textContent)).toEqual(['标准模式', '编程模式', '极简模式', '创造模式', 'Research Agent'])
    const calls = vi.mocked(face.mcps).mock.calls.length
    language = 'en'
    await act(async () => root.render(<McpSection {...face} t={translate()} />))
    expect([...element.querySelectorAll('[role="menuitem"]')].map(el => el.textContent)).toEqual(['Standard', 'PTC', 'Minimal', 'Creator', 'Research Agent'])
    expect(vi.mocked(face.mcps).mock.calls.length).toBe(calls)
    const ptc = [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(el => el.textContent === 'PTC')!
    await act(async () => ptc.click())
    expect(element.querySelector('[data-mcp-name="server-ptc"]')).not.toBeNull()
    expect(element.querySelector('[data-mcp-name="server-standard"]')).toBeNull()
    expect(picker().textContent).toBe('PTC')
  })

  it('renders add targets in the active language while preserving select values and custom names', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    language = 'zh'
    const { root, element } = mount()
    const onChange = vi.fn()
    const render = async () => { await act(async () => root.render(<McpTargetSelect label="Target" value="standard" presets={raw} presetName={presetName} globalSelectable disabled={false} onChange={onChange} t={translate()} />)) }
    await render()
    expect([...element.querySelectorAll('option')].map(option => option.textContent)).toEqual(['全局', '预设 · 标准模式', '预设 · 编程模式', '预设 · 极简模式', '预设 · 创造模式', '预设 · Research Agent'])
    expect([...element.querySelectorAll('option')].map(option => option.value)).toEqual(['', 'standard', 'ptc', 'minimal', 'cordis', 'custom'])
    language = 'en'
    await render()
    expect(element.querySelector('option[value="standard"]')?.textContent).toContain('Standard')
    expect(element.querySelector('select')?.value).toBe('standard')
    expect(onChange).not.toHaveBeenCalled()
  })
})
