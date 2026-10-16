/**
 * ESM bridge to the real `semver` package for the harness compatibility run.
 *
 * Why this file exists: the Harness checkout resolved through `DSH_HARNESS_ROOT`
 * is a pure source tree with no `node_modules` of its own, so a bare `semver`
 * import inside it cannot be resolved by Vite from the importer's location.
 * Vite then hands `vite-node` an unresolvable `/semver` id, which becomes
 * `<vitest root>/semver` — a path that has no extension and no directory to
 * resolve relative requires from, so the CJS entry dies with
 * `Cannot find module './internal/re'` while the require stack misleadingly
 * points at `dsh-mcp-manager\semver`.
 *
 * Aliasing the bare specifier here (`vitest.harness.config.ts`) resolves it to a
 * real file in this package instead. The real package is then loaded through
 * Node's own CJS loader, so `require('./internal/re')` resolves against the
 * genuine package directory and the module keeps its native semantics.
 *
 * Only the surface the Harness actually imports is re-exported
 * (`plugin-compatibility.ts` uses `default`, `valid`, `satisfies`;
 * `profile-compatibility.ts` uses `parse`).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** The genuine CommonJS `semver` singleton, resolved from this package. */
const semver = require('semver') as typeof import('semver')

export default semver
export const valid = semver.valid
export const satisfies = semver.satisfies
export const parse = semver.parse
