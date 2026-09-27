import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanClaudeMcp } from '../src/claude-import.ts'

/**
 * A workspace holding a fake home directory and a fake project root. The file
 * layouts mirror what Claude Code actually writes: the entries below were
 * copied from a real `~/.claude.json`, including the two servers that omit
 * `type` entirely.
 */
let home: string
let project: string

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8')
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'claude-import-'))
  home = join(base, 'home')
  project = join(base, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('scanClaudeMcp', () => {
  it('reads the user scope and infers a transport when type is omitted', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: {
        context7: { type: 'stdio', command: 'cmd', args: ['/c', 'npx', '-y', '@upstash/context7-mcp'] },
        kingdee: { command: 'uvx', args: ['kingdee-mcp'] },
      },
    })
    const { sources } = await scanClaudeMcp(project, home)
    expect(sources).toHaveLength(1)
    const [user] = sources
    expect(user?.label).toBe('user')
    expect(user?.entries.map(entry => entry.serverName)).toEqual(['context7', 'kingdee'])
    expect(user?.entries[1]?.spec).toEqual({ type: 'stdio', command: 'uvx', args: ['kingdee-mcp'] })
  })

  it('infers streamable-http from a url when type is omitted', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: { remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } } },
    })
    const { sources } = await scanClaudeMcp(project, home)
    expect(sources[0]?.entries[0]?.spec).toEqual({
      type: 'streamable-http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer x' },
    })
  })

  it('names the secret keys an entry carries', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: {
        kingdee: { command: 'uvx', args: ['kingdee-mcp'], env: { KINGDEE_PASSWORD: 'hunter2', KINGDEE_ACCT_ID: '6465' } },
      },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const entry = sources[0]?.entries[0]
    // The dialog shows which secrets a row will carry so the user can judge an
    // import; the values themselves are only ever in `spec`, never in a label.
    expect(entry?.envKeys).toEqual(['KINGDEE_PASSWORD', 'KINGDEE_ACCT_ID'])
    // The spec must still reproduce the server, credentials included.
    expect(entry?.spec).toMatchObject({ env: { KINGDEE_PASSWORD: 'hunter2' } })
  })

  it('reads the project scope matching the working directory', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
      projects: {
        '/elsewhere': { mcpServers: { ignored: { command: 'npx', args: ['x'] } } },
        [project.replaceAll('\\', '/')]: { mcpServers: { playwright: { command: 'npx', args: ['--yes', '@playwright/mcp'] } } },
      },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const labels = sources.map(source => source.id)
    expect(labels).toContain('user')
    const scoped = sources.find(source => source.label === 'projectScope')
    expect(scoped?.entries.map(entry => entry.serverName)).toEqual(['playwright'])
    // A project scope that does not match the cwd must not be offered.
    expect(sources.flatMap(source => source.entries).map(entry => entry.serverName)).not.toContain('ignored')
  })

  it('reads the project .mcp.json file', async () => {
    await writeJson(join(project, '.mcp.json'), {
      mcpServers: { docs: { type: 'sse', url: 'https://example.test/sse' } },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const file = sources.find(source => source.label === 'projectFile')
    expect(file?.entries[0]?.spec).toEqual({ type: 'sse', url: 'https://example.test/sse' })
  })

  it('reads mcpServers from the Claude settings files', async () => {
    await writeJson(join(home, '.claude', 'settings.json'), {
      mcpServers: { fromSettings: { command: 'uvx', args: ['x'] } },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const settings = sources.find(source => source.label === 'settings')
    expect(settings?.entries.map(entry => entry.serverName)).toEqual(['fromSettings'])
  })

  it('skips absent files without reporting them', async () => {
    const { sources } = await scanClaudeMcp(project, home)
    expect(sources).toEqual([])
  })

  it('reports a malformed file without hiding the other sources', async () => {
    await writeFile(join(home, '.claude.json'), '{ this is not json', 'utf8')
    await writeJson(join(project, '.mcp.json'), { mcpServers: { docs: { command: 'npx', args: ['x'] } } })
    const { sources } = await scanClaudeMcp(project, home)
    const broken = sources.find(source => source.id === 'user')
    expect(broken?.problem).toBe('malformed')
    expect(broken?.entries).toEqual([])
    expect(sources.find(source => source.label === 'projectFile')?.entries.map(entry => entry.serverName))
      .toEqual(['docs'])
  })

  it('marks a repeated server name without dropping it', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: { docs: { command: 'npx', args: ['a'] } },
    })
    await writeJson(join(project, '.mcp.json'), {
      mcpServers: { docs: { command: 'npx', args: ['b'] } },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const entries = sources.flatMap(source => source.entries)
    expect(entries.map(entry => entry.duplicate)).toEqual([false, true])
  })

  it('refuses a name the composition cannot address', async () => {
    const longName = 'a'.repeat(40)
    await writeJson(join(home, '.claude.json'), {
      mcpServers: {
        'my server': { command: 'npx', args: ['a'] },
        [longName]: { command: 'npx', args: ['b'] },
        MiniMax: { command: 'uvx', args: ['minimax-coding-plan-mcp'] },
      },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const entries = sources[0]?.entries ?? []
    // A space and an over-long name cannot become an `mcp__<name>__` namespace,
    // so they are reported rather than failing later during the import.
    expect(entries.map(entry => entry.problem)).toEqual(['unsupported-name', 'unsupported-name', undefined])
    expect(entries[2]?.serverName).toBe('MiniMax')
  })

  it('keeps an unparsable entry beside the usable ones', async () => {
    await writeJson(join(home, '.claude.json'), {
      mcpServers: {
        good: { command: 'npx', args: ['a'] },
        weird: { type: 'carrier-pigeon', endpoint: 'x' },
        notAnObject: 'nope',
      },
    })
    const { sources } = await scanClaudeMcp(project, home)
    const entries = sources[0]?.entries ?? []
    expect(entries.map(entry => entry.serverName)).toEqual(['good', 'weird'])
    expect(entries[1]?.problem).toBe('unsupported')
    expect(entries[1]?.duplicate).toBe(false)
  })
})
