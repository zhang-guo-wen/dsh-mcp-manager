/**
 * The enablement one roster row renders.
 *
 * The rule lives in its own module because the section it feeds cannot load
 * under plain Node (it imports the UI primitives and a CSS module), while this
 * decision is the most visible one the surface makes — an explicit user disable
 * must never render as "on" — so it is unit-tested directly.
 *
 * @module @guowenzhang/dsh-mcp-manager/client/mcp-row-state
 */

/**
 * Whether one row's switch reads as on.
 *
 * The Host's answer wins whenever it is explicit: `enabled: false` is the user
 * disabling the row, and no gate bookkeeping may turn it back on. `suppressed`
 * is only a fallback for a page talking to a Host that reports no declared
 * enablement at all (an older bundle, where a held row also reported `false`);
 * it must never override an explicit `false`.
 * @param enabled - the Host's declared enablement for the row.
 * @param suppressed - whether the preload gate holds the row back.
 * @returns whether the row is allowed, which is what its switch shows.
 */
export function rowAllowed(enabled: boolean | 'conditional' | undefined, suppressed: boolean): boolean {
  if (enabled === false) return false
  return enabled === true || enabled === 'conditional' || suppressed
}
