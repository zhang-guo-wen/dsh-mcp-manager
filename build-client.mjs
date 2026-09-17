// build-client.mjs — bundle src/client into the DSH client-loader handoff format.
// window.__ModuleLoader__.load({ id, factory }). react + @deepseek-ai/* external.
// CSS modules compiled with lightningcss; `.module.css` -> hashed class map + <style> inject.
import { rolldown } from 'rolldown'
import { transform } from 'lightningcss'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const HANDOFF_ID = '@zhang-guo-wen/dsh-mcp-manager'
const VIRT = '\0dsh-css:'
const SUFFIX = '.mjs'

const banner = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(HANDOFF_ID) + ', factory: (require) => {'
const footer = 'return module.exports; } });'
const intro = 'var module = { exports: {} }; var exports = module.exports;'

const cssModulePlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.module.css')) return null
    const abs = importer ? join(dirname(importer), source) : source
    return VIRT + abs + SUFFIX
  },
  async load(id) {
    if (!id.startsWith(VIRT)) return null
    const fileId = id.slice(VIRT.length, -SUFFIX.length)
    this.addWatchFile?.(fileId)
    const css = await readFile(fileId)
    const { code, exports: cssExports } = transform({
      filename: fileId,
      code: css,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap = {}
    // lightningcss's `exports` object carries no stable key order, so an
    // unsorted walk emits the same entries in a different sequence on every
    // build: behaviourally identical, but a different byte-for-byte artifact
    // and a spurious diff in the committed lib/. Sort the local names.
    for (const local of Object.keys(cssExports ?? {}).sort()) {
      classMap[local] = cssExports[local].name
    }
    const cssText = String(code)
    const tagId = HANDOFF_ID + '/' + fileId.split(/[\\/]/).pop()
    return [
      'const css = ' + JSON.stringify(cssText) + ';',
      'const tagId = ' + JSON.stringify(tagId) + ';',
      "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
      "  const tag = document.createElement('style');",
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      'export default ' + JSON.stringify(classMap) + ';',
    ].join('\n')
  },
}

const bundle = await rolldown({
  input: join(root, 'src', 'client', 'index.ts'),
  platform: 'browser',
  external: [/^react$/, /^react\//, /^@deepseek-ai\//],
  plugins: [cssModulePlugin],
})
await bundle.write({ format: 'cjs', file: join(root, 'lib', 'client.js'), banner, footer, intro, sourcemap: false })
console.log('lib/client.js written (ModuleLoader handoff bundle)')
