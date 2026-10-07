/** Declaration enablement, independent of the gate's runtime disabled flags. */
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

export interface DeclaredMcpRow {
  readonly options: EntryOptions
  readonly enabled: boolean | 'conditional'
}

/** Match Loader's !!js representation without importing a second host copy. */
function expression(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const expr = (value as { __jsExpr?: unknown }).__jsExpr
  return typeof expr === 'string' ? expr : undefined
}

function enablement(values: readonly unknown[], evaluate?: (expr: string) => unknown): boolean | 'conditional' {
  let conditional = false
  for (const value of values) {
    const expr = expression(value)
    if (expr === undefined) {
      if (Boolean(value)) return false
    } else {
      try {
        if (evaluate === undefined) conditional = true
        else if (Boolean(evaluate(expr))) return false
      } catch { conditional = true }
    }
  }
  return conditional ? 'conditional' : true
}

/** Walk group ancestry; an unevaluable expression never authorizes a load. */
export function declaredMcpRows(
  rows: readonly EntryOptions[],
  moduleName: string,
  evaluate?: (expr: string) => unknown,
  inherited: readonly unknown[] = [],
): DeclaredMcpRow[] {
  const found: DeclaredMcpRow[] = []
  for (const row of rows) {
    const contributions = [...inherited, row.disabled]
    if (row.group === true) {
      if (Array.isArray(row.config)) found.push(...declaredMcpRows(row.config as EntryOptions[], moduleName, evaluate, contributions))
    } else if (row.name === moduleName) found.push({ options: row, enabled: enablement(contributions, evaluate) })
  }
  return found
}
