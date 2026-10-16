/**
 * Controllable stand-in for the harness `@deepseek-ai/dsh-mcp-client` plugin.
 *
 * The harness specs stub `loader.internal.import`, so the composition's MCP rows
 * resolve to this object instead of the real plugin. Two counters make the two
 * behaviors under test observable:
 *
 * - `applyCalls` counts mounted rows. The real plugin starts the child process
 *   inside `apply`, so this is the direct evidence for "the row never launched"
 *   when the preload gate holds it at fiber publication.
 * - `adapterContexts` records the context every native tool definition was built
 *   with, which is how a spec shows where a `dynamic` load registered its tools.
 *
 * @module tests/fixtures/mcp-client-fixture
 */

/** One built tool definition, as the fixture adapter reports it. */
export interface FixtureToolDefinition {
  readonly name: string
  readonly rawName: string
  call(args: unknown, execution: { readonly signal?: AbortSignal }): unknown
}

/** The fixture plugin object the Loader mounts for one MCP row. */
export interface FixtureMcpClientModule {
  readonly name: string
  readonly inject: string[]
  apply(ctx: unknown, config: unknown): void
  createMcpToolDefinition(
    ctx: unknown,
    options: { readonly name: string; readonly rawName: string; readonly call: FixtureToolDefinition['call'] },
  ): FixtureToolDefinition
}

/** The counters and the module object for one spec. */
export interface McpClientFixture {
  /** Times the plugin's `apply` ran: one per mounted row. */
  applyCalls: number
  /** Contexts passed to the tool-definition adapter, in build order. */
  adapterContexts: unknown[]
  /** Configs the fixture plugin was mounted with. */
  applied: unknown[]
  readonly module: FixtureMcpClientModule
}

/**
 * Build one fixture with its own counters.
 * @returns the counters and the module object to hand back from the import stub.
 */
export function createMcpClientFixture(): McpClientFixture {
  const fixture = {
    applyCalls: 0,
    adapterContexts: [] as unknown[],
    applied: [] as unknown[],
  } as Omit<McpClientFixture, 'module'> & { module: FixtureMcpClientModule }
  fixture.module = {
    name: 'fixture-mcp-client',
    inject: [],
    apply(_ctx, config) {
      fixture.applyCalls += 1
      fixture.applied.push(config)
    },
    createMcpToolDefinition(ctx, options) {
      fixture.adapterContexts.push(ctx)
      return { name: options.name, rawName: options.rawName, call: options.call }
    },
  }
  return fixture as McpClientFixture
}
