import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * The preload gate holds a preset row back from its `internal/plugin`
 * publication. That is only early enough if Cordis skips the callback when the
 * fiber is disposed inside the event, so this spec pins the framework behavior
 * the gate depends on: the disposed fiber never resolves its dependencies and
 * never runs its plugin callback.
 */
describe('fiber publication ordering', () => {
  it('skips the plugin callback of a fiber disposed in the publication observer', async () => {
    const ran: string[] = []
    const ctx = new Context()
    ctx.on('internal/plugin', fiber => { void fiber.dispose() })
    await ctx.plugin({ name: 'held', apply() { ran.push('held') } })
    await Promise.resolve()
    expect(ran).toEqual([])
  })

  it('runs the callback of a fiber nobody disposes', async () => {
    const ran: string[] = []
    const ctx = new Context()
    ctx.on('internal/plugin', () => {})
    const fiber = await ctx.plugin({ name: 'mounted', apply() { ran.push('mounted') } })
    await fiber.await()
    expect(ran).toEqual(['mounted'])
  })

  it('lets a held row start later with an explicit context plugin call', async () => {
    // The hold is a runtime state, not a latch: once the gate stops holding a
    // row (a switch back to `eager`), the same plugin must be able to run.
    const ran: string[] = []
    const ctx = new Context()
    let hold = true
    ctx.on('internal/plugin', fiber => { if (hold) void fiber.dispose() })
    const plugin = { name: 'row', apply() { ran.push('row') } }
    await ctx.plugin(plugin)
    await Promise.resolve()
    expect(ran).toEqual([])
    hold = false
    const mounted = await ctx.plugin(plugin)
    await mounted.await()
    expect(ran).toEqual(['row'])
  })
})
