/** MCP definitions supplied by another plugin without writing composition files. */
import type { Context } from '@deepseek-ai/cordis'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { McpEntryConfig } from './mcp-config.ts'
import { assertServerName } from './mcp-config.ts'
import type { McpLoadingMode } from './lazy-mcp.ts'

export interface ExternalMcpDefinition {
  readonly serverName: string
  readonly scope: 'global' | 'agent'
  readonly description?: string
  readonly config: McpEntryConfig
}

export interface ExternalMcpRow extends ExternalMcpDefinition {
  readonly owner: string
  readonly scopeKey: ScopeKey | undefined
}

interface Owner {
  readonly ctx: Context
  readonly rows: readonly ExternalMcpDefinition[]
  readonly mounts: Map<string, { dispose(): Promise<void> }>
}

export interface ScopeLookup {
  scopeOf(ctx: Context): ScopeKey | undefined
  scopeChainOf(scope: ScopeKey | undefined): ScopeKey[]
}

/** The manager owns both the eager fibers and the definitions used by mcp_load. */
export class ExternalMcpRegistry {
  private readonly owners = new Map<string, Owner>()
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly mode: () => McpLoadingMode,
    private readonly mount: (ctx: Context, config: McpEntryConfig) => Promise<{ dispose(): Promise<void> }>,
    private readonly changed: () => Promise<void>,
    private readonly scopes: ScopeLookup,
  ) {}

  scopeOf(ctx: Context): ScopeKey | undefined {
    return this.scopes.scopeOf(ctx)
  }

  scopeDistance(owner: ScopeKey | undefined, caller: ScopeKey | undefined): number {
    if (owner === undefined) return Number.MAX_SAFE_INTEGER
    const distance = this.scopes.scopeChainOf(caller).indexOf(owner)
    return distance < 0 ? Number.MAX_SAFE_INTEGER : distance
  }

  rows(): ExternalMcpRow[] {
    return [...this.owners].flatMap(([owner, value]) => value.rows.map(row => ({
      ...row, owner, scopeKey: this.scopes.scopeOf(value.ctx),
    })))
  }

  visible(row: ExternalMcpRow, scope: ScopeKey | undefined): boolean {
    return row.scope === 'global' || row.scopeKey !== undefined && this.scopes.scopeChainOf(scope).includes(row.scopeKey)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => {})
    return next
  }

  replace(owner: string, ctx: Context, rows: readonly ExternalMcpDefinition[]): Promise<void> {
    return this.enqueue(() => this.replaceNow(owner, ctx, rows))
  }

  private async replaceNow(owner: string, ctx: Context, rows: readonly ExternalMcpDefinition[]): Promise<void> {
    if (this.closed) throw new Error('MCP manager is stopping')
    if (!owner) throw new Error('MCP owner is required')
    const names = new Set<string>()
    const normalized = rows.map(row => ({ ...row, config: row.config.transport === 'stdio'
      ? { ...row.config, args: row.config.args ?? [], env: row.config.env ?? {}, cwd: row.config.cwd ?? '' }
      : { ...row.config, headers: row.config.headers ?? {} },
    })) as ExternalMcpDefinition[]
    for (const row of normalized) {
      assertServerName(row.serverName)
      if (names.has(row.serverName)) throw new Error(`Duplicate managed MCP server: ${row.serverName}`)
      names.add(row.serverName)
      if (row.config.serverName !== row.serverName) throw new Error(`MCP server name mismatch: ${row.serverName}`)
      if (row.scope === 'agent' && this.scopes.scopeOf(ctx) === undefined) throw new Error(`Agent MCP ${row.serverName} has no agent scope`)
    }
    const previous = this.owners.get(owner)
    if (previous?.ctx === ctx && JSON.stringify(previous.rows) === JSON.stringify(normalized)) return
    if (previous) await this.removeNow(owner)
    const next: Owner = { ctx, rows: normalized, mounts: new Map() }
    this.owners.set(owner, next)
    try {
      await this.reconcileOwner(next)
    } catch (error) {
      await this.removeNow(owner)
      throw error
    }
    await this.changed()
  }

  remove(owner: string): Promise<void> {
    return this.enqueue(() => this.removeNow(owner))
  }

  private async removeNow(owner: string): Promise<void> {
    const previous = this.owners.get(owner)
    if (!previous) return
    await Promise.all([...previous.mounts.values()].map(mount => mount.dispose()))
    this.owners.delete(owner)
    await this.changed()
  }

  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow())
  }

  private async reconcileNow(): Promise<void> {
    if (this.closed) return
    await Promise.all([...this.owners.values()].map(owner => this.reconcileOwner(owner)))
  }

  transition(before: () => Promise<void>, after: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      await before()
      await this.reconcileNow()
      await after()
    })
  }

  private async reconcileOwner(owner: Owner): Promise<void> {
    if (this.mode() !== 'eager') {
      await Promise.all([...owner.mounts.values()].map(mount => mount.dispose()))
      owner.mounts.clear()
      return
    }
    for (const row of owner.rows) {
      if (owner.mounts.has(row.serverName)) continue
      owner.mounts.set(row.serverName, await this.mount(owner.ctx, row.config))
    }
  }

  dispose(before?: () => Promise<void>): Promise<void> {
    return this.enqueue(async () => {
      this.closed = true
      await before?.()
      const previous = [...this.owners.values()]
      this.owners.clear()
      await Promise.allSettled(previous.flatMap(owner => [...owner.mounts.values()].map(mount => mount.dispose())))
    })
  }
}
