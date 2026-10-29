import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mcpPresetName } from '../src/client/preset-name.ts'
import type { BuiltInPresetCopyKey } from '@deepseek-ai/dsh-agent-preset-registry/display'

const copy: Record<'zh' | 'en', Record<BuiltInPresetCopyKey, string>> = {
  zh: { presetStandardName: '标准模式', presetStandardDescription: '标准说明', presetPtcName: '编程模式', presetPtcDescription: '编程说明', presetMinimalName: '极简模式', presetMinimalDescription: '极简说明', presetCordisName: '创造模式', presetCordisDescription: '创造说明' },
  en: { presetStandardName: 'Standard', presetStandardDescription: 'Standard description', presetPtcName: 'PTC', presetPtcDescription: 'PTC description', presetMinimalName: 'Minimal', presetMinimalDescription: 'Minimal description', presetCordisName: 'Creator', presetCordisDescription: 'Creator description' },
}

describe('MCP preset display names', () => {
  it('uses the Host resolver for all shipped ids, without changing identities', () => {
    const presets = ['standard', 'ptc', 'minimal', 'cordis'].map(id => ({ id }))
    expect(presets.map(preset => mcpPresetName(preset, key => copy.zh[key])))
      .toEqual(['标准模式', '编程模式', '极简模式', '创造模式'])
    expect(presets.map(preset => preset.id)).toEqual(['standard', 'ptc', 'minimal', 'cordis'])
  })

  it('resolves the current language on every call over the same raw data', () => {
    let locale: 'zh' | 'en' = 'zh'
    const translate = (key: BuiltInPresetCopyKey) => copy[locale][key]
    const preset = { id: 'standard' }
    expect(mcpPresetName(preset, translate)).toBe('标准模式')
    locale = 'en'
    expect(mcpPresetName(preset, translate)).toBe('Standard')
    locale = 'zh'
    expect(mcpPresetName(preset, translate)).toBe('标准模式')
  })

  it('keeps authored overrides, including empty names, and unknown ids verbatim', () => {
    const translate = (key: BuiltInPresetCopyKey) => copy.zh[key]
    expect(mcpPresetName({ id: 'standard', name: 'My Agent' }, translate)).toBe('My Agent')
    expect(mcpPresetName({ id: 'standard', name: '' }, translate)).toBe('')
    expect(mcpPresetName({ id: 'custom', name: '研究员' }, translate)).toBe('研究员')
    expect(mcpPresetName({ id: 'unknown' }, translate)).toBe('unknown')
  })

  it('never shows translation keys when the Host dictionary is unavailable', () => {
    expect(mcpPresetName({ id: 'standard' }, key => key)).toBe('standard')
    expect(mcpPresetName({ id: 'custom', name: 'User name' }, key => key)).toBe('User name')
    expect(mcpPresetName({ id: 'standard' }, key => key === 'presetStandardName' ? '标准模式' : key)).toBe('标准模式')
  })

  it('inlines the import-free Host display helper instead of requesting a dynamic Client module', () => {
    const artifact = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(artifact).toContain('presetStandardName')
    expect(artifact).not.toMatch(/require\(["']@deepseek-ai\/dsh-agent-preset-registry\/display["']\)/)
  })
})
