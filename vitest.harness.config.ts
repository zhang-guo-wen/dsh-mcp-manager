/** Opt-in compatibility tests against a real Harness source checkout. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const harness = resolve(process.env.DSH_HARNESS_ROOT ?? resolve(import.meta.dirname, '../../deepseek-harness'))
const config = ts.readConfigFile(resolve(harness, 'tsconfig.base.json'), ts.sys.readFile)
if (config.error) throw new Error('Set DSH_HARNESS_ROOT to a Harness source checkout')
const paths = config.config.compilerOptions.paths as Record<string, string[]>
const alias = Object.entries(paths).filter(([name]) => !name.includes('*')).map(([find, targets]) => {
  const path = resolve(harness, targets[0]!)
  return { find, replacement: existsSync(`${path}/index.ts`) ? `${path}/index.ts` : path }
})

export default defineConfig({
  plugins: [{
    name: 'lower-standard-decorators', enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?tsx?$/.test(id) || !/^\s*@[A-Za-z_$]/m.test(code)) return
      return ts.transpileModule(code, { fileName: id, compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
      } }).outputText
    },
  }],
  resolve: { alias },
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.harness.spec.ts'],
    environment: 'node',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
})
