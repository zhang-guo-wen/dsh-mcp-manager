import { defineConfig } from 'tsdown'
import ts from 'typescript'

const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Lower TC39 stage-3 class decorators before rolldown bundles the host entry.
 * Node does not parse decorator syntax, so the `@Remote` markers on the MCP
 * authoring service must be compiled to their `__runInitializers` form at build
 * time. Mirrors the harness's own decorator-lowering pass.
 */
function lowerDecorators() {
  return {
    name: 'dsh-lower-decorators',
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  platform: 'node',
  dts: false,
  // The MCP SDK is resolved from the harness at runtime, so it stays external
  // like every @deepseek-ai package rather than being bundled here.
  deps: { neverBundle: [/^@deepseek-ai\//, /^@modelcontextprotocol\//] },
  plugins: [lowerDecorators()],
  clean: true,
})
