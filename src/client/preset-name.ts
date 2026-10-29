/** Agent names use the same render-time resolver and dictionary as the Host session picker. */
import { presetDisplayText, type BuiltInPresetCopyKey, type PresetDisplaySource } from '@deepseek-ai/dsh-agent-preset-registry/display'

/**
 * Resolve shipped copy for the current language without translating authored names.
 * Missing Host dictionaries fall back to the raw id, never a locale key.
 * @param preset - original declaration metadata, with an absent name kept absent.
 * @param translate - live lookup bound to settings.agentPreset.
 * @returns the current display name.
 */
export function mcpPresetName(preset: PresetDisplaySource, translate: (key: BuiltInPresetCopyKey) => string): string {
  let missing = false
  const display = presetDisplayText(preset, key => {
    const value = translate(key)
    if (value === key && key.endsWith('Name')) missing = true
    return value
  })
  return missing ? preset.name ?? preset.id : display.name
}
