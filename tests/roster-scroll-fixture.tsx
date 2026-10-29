// Browser-only driven data: real McpSection and controls, no Host RPC or credentials.
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { McpSection, type McpSectionProps } from '../src/client/McpSection.tsx'
import { en, zh, type McpSectionKey } from '../src/client/locales.ts'
import { mcpPresetName } from '../src/client/preset-name.ts'
import type { McpPresetOption, McpSectionState, McpServer } from '../src/client/settings-controller.ts'
import type { BuiltInPresetCopyKey } from '@deepseek-ai/dsh-agent-preset-registry/display'
import { en as hostPresetEn, zh as hostPresetZh } from 'fixture:agent-preset-locales'
import shell from 'fixture:settings-shell-css'

type Language = 'en' | 'zh'
type FixtureConfig = { count: number; narrow: boolean; nav: boolean; names: boolean; refreshDelay: number }
const params = new URLSearchParams(location.search)
const names = params.get('names') === '1'
const config: FixtureConfig = { count: Number(params.get('count') ?? (names ? 2 : 80)), narrow: params.get('narrow') === '1', nav: params.get('nav') === '1', names, refreshDelay: 20 }
const presets: McpPresetOption[] = names
  ? [{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }, { id: 'cordis' }, { id: 'research', name: 'Research Agent' }]
  : [{ id: 'standard', name: 'standard' }, { id: 'other', name: 'other' }]
const hostNames = (language: Language) => {
  const dictionary = language === 'zh' ? hostPresetZh : hostPresetEn
  return { standard: dictionary.presetStandardName, ptc: dictionary.presetPtcName, minimal: dictionary.presetMinimalName, cordis: dictionary.presetCordisName, research: 'Research Agent' }
}
let activeLanguage: Language = names ? 'zh' : 'en'
let renderLanguage: (language: Language) => void = () => {}
const presetTranslate = (key: BuiltInPresetCopyKey): string => (activeLanguage === 'zh' ? hostPresetZh : hostPresetEn)[key]
const presetName = (preset: McpPresetOption): string => mcpPresetName(preset, presetTranslate)
let reads = 0
let catalogReads = 0
let refreshCalls = 0
let catalogEntries = [
  { key: 'local:fixture', tools: 4, ageMs: 1000, truncated: false, transport: 'stdio' as const, expired: false },
  { key: 'server:fixture', tools: 3, ageMs: 2000, truncated: false, transport: 'streamable-http' as const, expired: false },
]
const makeRows = (count: number): McpServer[] => presets.flatMap(preset => Array.from({ length: count }, (_, i) => ({
  entryId: `${preset.id}-${String(i).padStart(3, '0')}`,
  serverName: `${preset.id}_${String(i).padStart(3, '0')}`,
  description: 'Editable local MCP fixture',
  scope: 'preset' as const, presetId: preset.id, enabled: true, writable: true, fiberPhase: null, secretKeys: [],
})))
let rows = makeRows(config.count)
let readRoster = async () => { reads += 1; await new Promise(resolve => setTimeout(resolve, config.refreshDelay)); return { servers: rows, presets, globalWritable: true } }
const snapshot: McpSectionState = { available: true, writable: true, loading: 'dynamic', descriptions: {}, tools: {}, optimize: {} }
let refresh: () => void = () => {}
const control = {
  async refresh(count = config.count) {
    config.count = count
    rows = makeRows(count)
    const before = reads
    refresh()
    while (reads === before) await new Promise(resolve => setTimeout(resolve, 5))
  },
  get reads() { return reads },
  get count() { return config.count },
  get catalogReads() { return catalogReads },
  get refreshCalls() { return refreshCalls },
  get language() { return activeLanguage },
  hostNames,
  setLanguage(language: Language) { activeLanguage = language; renderLanguage(language) },
  setDelay(ms: number) { config.refreshDelay = ms },
}
Object.assign(window, { __mcpFixture: control })
// Stable callbacks ensure a language rerender does not trigger the roster read effect.
const t = (key: McpSectionKey) => (activeLanguage === 'zh' ? zh : en)[key]
const mutation = async (request: { target: { scope: 'global' } | { scope: 'preset'; agentPreset: string }; serverName?: string; entryId?: string; disabled?: boolean }) => ({
  target: request.target, entryId: request.entryId ?? request.serverName ?? 'fixture', serverName: request.serverName ?? 'fixture', disabled: request.disabled ?? false,
})
const common = {
  t,
  presetName,
  useMcpSettings: <T,>(selector: (state: McpSectionState) => T): T => selector(snapshot),
  setMcpLoading: async () => {}, setOptimize: async () => {}, updateMcpDescription: async () => {}, updateMcpTools: async () => {},
  addMcp: mutation, editMcp: mutation, disableMcp: mutation,
  describeMcp: async (request: { target: { scope: 'global' } | { scope: 'preset'; agentPreset: string }; entryId: string }) => ({
    target: request.target, entryId: request.entryId,
    serverName: rows.find(row => row.entryId === request.entryId)?.serverName ?? 'fixture',
    spec: { type: 'stdio' as const, command: 'fixture' }, disabled: false,
  }),
  listMcpTools: async () => ({ tools: [] }),
  catalogState: async () => { catalogReads += 1; return { entries: catalogEntries, total: catalogEntries.length } },
  clearCatalog: async () => { const cleared = catalogEntries.length; catalogEntries = []; return { cleared } },
  refreshCatalog: async () => { refreshCalls += 1; await new Promise(resolve => setTimeout(resolve, 50)); return { refreshed: 1, failed: [] } },
  enableGlobalPlane: async () => ({ includePath: 'fixture-only', created: false, patchChanged: false, mounted: true }),
  suppressedMcps: async () => [], presets: async () => presets,
}
function Fixture() {
  const [reader, setReader] = useState(() => readRoster)
  const [language, setLanguage] = useState<Language>(activeLanguage)
  useEffect(() => {
    renderLanguage = language => { setLanguage(language) }
    refresh = () => {
      readRoster = async () => { reads += 1; await new Promise(resolve => setTimeout(resolve, config.refreshDelay)); return { servers: rows, presets, globalWritable: true } }
      setReader(() => readRoster)
    }
    return () => { refresh = () => {}; renderLanguage = () => {} }
  }, [])
  const props = { ...common, mcps: reader } as McpSectionProps
  return <div id="fixture-ancestor" lang={language} data-language={language}>
    <div id="fixture-stage">
      <div className={shell.overlay}>
        <div id="fixture-panel" className={shell.panel} data-narrow={config.narrow ? 'true' : undefined}>
          {config.nav ? <nav id="host-nav" className={shell.nav}><div className={shell.navTitle}>Settings</div><div className={shell.navList}><button className={`${shell.navCell} ${shell.active}`}>MCP</button></div></nav> : null}
          <div id="host-content" className={shell.content}>
            <header id="host-header" className={shell.header}><div className={shell.actions}><button className={shell.close} aria-label="Close fixture">×</button></div></header>
            <div id="host-options" className={shell.options}><McpSection {...props} /></div>
          </div>
        </div>
      </div>
    </div>
    <div id="fixture-ancestor-tail" aria-hidden="true" />
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
