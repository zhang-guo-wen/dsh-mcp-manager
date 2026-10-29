// Compile the actual MCP presentation, host controls and settings CSS for a keyless browser fixture.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { rolldown } from 'rolldown'
import { transform } from 'lightningcss'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(repo, '..')
const harness = resolve(process.env.DSH_HARNESS_ROOT ?? join(workspace, 'deepseekharness'))
const out = resolve(workspace, '.scratch/test-system/mcp-roster-scroll-fixture')
const primitives = join(harness, 'packages/client/ui-primitives/src')
const hostCss = join(harness, 'packages/client/ui-settings-general/src/client/SettingsRoot.module.css')
const hostPresetLocales = join(harness, 'packages/client/ui-agent-preset/src/client/locales.ts')
const hostPresetDisplay = join(harness, 'packages/preset/agent-preset-registry/src/display.ts')
const theme = join(harness, 'packages/client/ui-theme/src/styles')
const require = createRequire(join(repo, 'package.json'))
const clsx = [
  join(repo, 'node_modules/clsx/dist/clsx.mjs'),
  join(harness, 'node_modules/.pnpm/clsx@2.1.1/node_modules/clsx/dist/clsx.mjs'),
  join(workspace, 'dsh-resource-manager/node_modules/clsx/dist/clsx.mjs'),
].find(existsSync)
if (!clsx) throw new Error('A real installed clsx package is required; no dependency is downloaded')
for (const file of [hostCss, hostPresetLocales, hostPresetDisplay, join(primitives, 'Button.tsx')]) if (!existsSync(file)) throw new Error(`Missing Harness source: ${file}`)
await mkdir(out, { recursive: true })
const inputs = new Set([fileURLToPath(import.meta.url)])
const virtualControls = '\0mcp-fixture-host-controls'
const controls = ['Button', 'Input', 'Modal', 'Menu', 'SegmentedTabs', 'SegmentedControl', 'StateDot', 'Switch', 'Toast']
const bundle = await rolldown({
  input: join(repo, 'tests/roster-scroll-fixture.tsx'),
  platform: 'browser',
  transform: { define: { 'process.env.NODE_ENV': JSON.stringify('production') } },
  resolve: { alias: {
    react: join(repo, 'node_modules/react'),
    'react-dom': join(repo, 'node_modules/react-dom'),
    clsx,
  } },
  plugins: [{
    name: 'fixture-host-controls-and-css',
    resolveId(source, importer) {
      if (source === '@deepseek-ai/dsh-client-ui-primitives') return virtualControls
      if (source === 'fixture:settings-shell-css') return `\0fixture-css:${hostCss}.mjs`
      // Test-only UI dictionary import; product code uses the injected Host translator.
      if (source === 'fixture:agent-preset-locales') return hostPresetLocales
      if (source === '@deepseek-ai/dsh-agent-preset-registry/display') return hostPresetDisplay
      if (source.endsWith('.css')) return `\0fixture-css:${importer ? resolve(dirname(importer), source) : source}.mjs`
      if (source === '@deepseek-ai/dsh-client-store') return join(harness, 'packages/client/store/src/index.ts')
      if (source === 'react/jsx-runtime') return require.resolve('react/jsx-runtime')
      if (source === 'react-dom/client') return require.resolve('react-dom/client')
      return null
    },
    async load(id) {
      if (id === virtualControls) return controls.map(name => `export { ${name} } from ${JSON.stringify(join(primitives, `${name}.tsx`))}`).join('\n')
        + `\nexport { IconChevronDownOutlineRegular } from ${JSON.stringify(join(primitives, 'icons/index.tsx'))}`
      if (!id.startsWith('\0fixture-css:')) return null
      const filename = id.slice('\0fixture-css:'.length, -4)
      inputs.add(filename)
      const module = filename.endsWith('.module.css')
      const result = transform({ filename, code: await readFile(filename), cssModules: module ? { pattern: '[hash]_[local]' } : undefined, minify: false })
      const classes = Object.fromEntries(Object.keys(result.exports ?? {}).sort().map(key => [key, result.exports[key].name]))
      return `const s=document.createElement('style');s.dataset.fixtureCss=${JSON.stringify(relative(workspace, filename))};s.textContent=${JSON.stringify(result.code.toString())};document.head.append(s);export default ${JSON.stringify(classes)};`
    },
    transform(code, id) {
      if (!id.startsWith('\0') && /\.[cm]?[jt]sx?$/.test(id)) inputs.add(id)
      return null
    },
  }],
})
await bundle.write({ file: join(out, 'fixture.js'), format: 'iife', sourcemap: false })
await bundle.close()
const themeFiles = ['base.css', 'corner-shape.css', 'design-platform.css', 'focus.css', 'onboarding.css', 'scrollbar.css', 'gradient-shadow-text.css', 'shiki.css']
const sheets = []
for (const name of themeFiles) {
  const filename = join(theme, name)
  inputs.add(filename)
  sheets.push(`/* ${name} */\n${await readFile(filename, 'utf8')}`)
}
await writeFile(join(out, 'theme.css'), sheets.join('\n'))
const entry = await readFile(join(out, 'fixture.js'))
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP roster scroll fixture</title><link rel="stylesheet" href="/theme.css"><style>html,body,#root{height:100%;margin:0}body{font-family:var(--dsw-font-family);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}#fixture-ancestor{height:100%;overflow:auto}#fixture-stage{height:100%;position:relative}#fixture-ancestor-tail{height:120px}#fixture-panel[data-narrow="true"]{width:420px}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`
await writeFile(join(out, 'index.html'), html)
const details = []
for (const filename of [...inputs].sort()) {
  const data = await readFile(filename)
  details.push({ path: relative(workspace, filename).replaceAll('\\', '/'), sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length })
}
const pluginPackage = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))
const hostPackage = JSON.parse(await readFile(join(harness, 'packages/client/ui-settings-general/package.json'), 'utf8'))
await writeFile(join(out, 'manifest.json'), JSON.stringify({ builtAt: new Date().toISOString(), harness, pluginVersion: pluginPackage.version, hostSettingsVersion: hostPackage.version, fixture: 'McpSection source + real host ui-primitives + real SettingsRoot CSS + complete installed theme sheets', artifact: { sha256: createHash('sha256').update(entry).digest('hex'), bytes: entry.length }, inputs: details }, null, 2))
console.log(`Browser fixture built: ${out}`)
