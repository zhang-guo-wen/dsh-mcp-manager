import { describe, expect, it } from 'vitest'
import { rowAllowed } from '../src/client/mcp-row-state.ts'

describe('rowAllowed', () => {
  it('never lets the suppression flag turn an explicit user disable back on', () => {
    // The runtime-disable path: the row is user-disabled, and the gate's
    // suppression set is stale for one pass. The switch must read as off.
    expect(rowAllowed(false, true)).toBe(false)
    expect(rowAllowed(false, false)).toBe(false)
  })

  it('renders the Host\'s other answers directly', () => {
    expect(rowAllowed(true, false)).toBe(true)
    expect(rowAllowed(true, true)).toBe(true)
    // A `!!js` gate only a mount can resolve stays enabled: the section does not
    // guess at it.
    expect(rowAllowed('conditional', false)).toBe(true)
    expect(rowAllowed('conditional', true)).toBe(true)
  })

  it('keeps the suppression flag as the fallback for a Host that answers nothing', () => {
    // A page running an older bundle against a Host that reports no declared
    // enablement: the flag is then the only signal that the mode holds the row.
    expect(rowAllowed(undefined, true)).toBe(true)
    expect(rowAllowed(undefined, false)).toBe(false)
  })
})
