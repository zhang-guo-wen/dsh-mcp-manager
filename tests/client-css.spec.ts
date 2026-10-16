/**
 * Mechanical guards on the settings section's browser styles and class names.
 *
 * Two classes of regression are cheap to introduce and silent at runtime: a
 * class name the TSX reads but the CSS module does not define (the value is
 * `undefined`, so the element loses its styling without any error), and a
 * styling value outside the plugin UI standard. This spec asserts both from the
 * source text; it is not a substitute for measuring the rendered box in a
 * browser.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** One stylesheet and the components that style themselves from it. */
interface StyleSheet {
  readonly name: string
  readonly cssPath: string
  readonly components: readonly string[]
  /**
   * Whether the sheet styles a raw form control of its own.
   *
   * Only such a sheet has to carry the focus ring itself: everything else
   * renders `@deepseek-ai/dsh-client-ui-primitives`, which owns its own.
   */
  readonly stylesRawControls: boolean
}

const SHEETS: readonly StyleSheet[] = [
  {
    name: 'McpSection.module.css',
    cssPath: '../src/client/McpSection.module.css',
    components: [
      '../src/client/McpSection.tsx',
      '../src/client/McpEditor.tsx',
      '../src/client/ClaudeImportDialog.tsx',
    ],
    stylesRawControls: true,
  },
  {
    name: 'McpOptimizeSection.module.css',
    cssPath: '../src/client/McpOptimizeSection.module.css',
    components: ['../src/client/McpOptimizeSection.tsx'],
    stylesRawControls: false,
  },
]

/** Read one file next to this spec. */
function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

/** Source with comments blanked, so commented-out declarations never match. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Every class defined by the module, comments removed. */
function definedClasses(source: string): ReadonlySet<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return names
}

/** Every `css.<name>` lookup one component performs. */
function referencedClasses(source: string): readonly string[] {
  return [...source.matchAll(/css\.([A-Za-z][A-Za-z0-9_]*)/g)]
    .map(match => match[1])
    .filter((name): name is string => name !== undefined)
}

/** Split a stylesheet into declaration bodies so per-rule rules can be checked. */
function ruleBodies(source: string): readonly string[] {
  return [...source.matchAll(/\{([^{}]*)\}/g)].map(match => match[1] ?? '')
}

describe.each(SHEETS)('$name class names', (sheet) => {
  const css = withoutComments(read(sheet.cssPath))
  const defined = definedClasses(css)

  it('defines every class the components look up', () => {
    for (const path of sheet.components) {
      const missing = referencedClasses(read(path)).filter(name => !defined.has(name))
      expect(missing, `${path} references classes the module does not define`).toEqual([])
    }
  })

  it('has no class the components never look up', () => {
    const referenced = new Set(sheet.components.flatMap(path => referencedClasses(read(path))))
    expect([...defined].filter(name => !referenced.has(name)).sort()).toEqual([])
  })
})

describe.each(SHEETS)('$name standard', (sheet) => {
  const css = withoutComments(read(sheet.cssPath))

  it('uses semantic alias tokens, never literal colours', () => {
    expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(css.match(/\brgba?\(|\bhsla?\(/g) ?? []).toEqual([])
  })

  it('never falls back to a literal colour inside var()', () => {
    expect(css.match(/var\(\s*--[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/g) ?? []).toEqual([])
  })

  it('always resolves the focus-ring colour with a fallback', () => {
    const rings = css.match(/var\(--dsw-focus-ring-color[^)]*\)/g) ?? []
    if (sheet.stylesRawControls) expect(rings.length).toBeGreaterThan(0)
    for (const ring of rings) expect(ring).toContain('--dsw-alias-state-business-primary')
  })

  it('pairs every font size with a line height', () => {
    for (const body of ruleBodies(css)) {
      if (!/font-size\s*:/.test(body)) continue
      expect(/line-height\s*:/.test(body) || /(^|[;{\s])font\s*:/.test(body), body).toBe(true)
    }
  })

  it('uses the role radius scale or a token, never a local value', () => {
    const allowed = new Set(['0', '0px', '50%', '100%', '999px', 'inherit', 'initial', 'unset', 'auto'])
    for (const body of ruleBodies(css)) {
      for (const declaration of body.matchAll(/border-radius\s*:\s*([^;]+)/g)) {
        for (const part of (declaration[1] ?? '').split(/[\s/]+/)) {
          const value = part.trim()
          if (value === '') continue
          if (allowed.has(value)) continue
          expect(value, `off-scale radius in ${body}`).toMatch(/var\(--dsw-radius-|calc\(|%$/)
        }
      }
    }
  })

  it('lists transitions per property and disables them under reduced motion', () => {
    expect(css.match(/transition:\s*[^;]*\ball\b/g) ?? []).toEqual([])
    if (/transition\s*:/.test(css)) expect(css).toMatch(/prefers-reduced-motion/)
  })

  it('never paints a thicker neutral hairline than the shared 0.5px', () => {
    const neutral = [...css.matchAll(/border(?:-(?:top|right|bottom|left))?\s*:\s*([0-9.]+)px\s+solid\s+var\(--dsw-alias-border-[a-z0-9-]+\)/g)]
    for (const declaration of neutral) expect(declaration[1]).toBe('0.5')
  })
})
