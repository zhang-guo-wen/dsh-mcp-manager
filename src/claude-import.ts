/**
 * Read MCP server definitions out of the Claude Code configuration files.
 *
 * Claude Code keeps its servers in several places at once, so an import has to
 * look in all of them and present what each one holds rather than merging them
 * silently: the same name in two files is two different rows with two different
 * credential sets. Sources, in scan order:
 *
 * - `~/.claude.json` — the "user" scope, plus its `projects` map, which carries
 *   a per-working-directory `mcpServers` set;
 * - `~/.claude/settings.json` and `settings.local.json` — Claude's settings
 *   files accept the same key, and users do put servers there;
 * - `<project root>/.mcp.json` — the checked-in project scope.
 *
 * Nothing here writes. A scanned entry carries the complete parsed spec, because
 * importing it has to reproduce the server with its credentials; the `envKeys`
 * field exists so the dialog can show *which* secrets a row will carry without
 * printing them, and so a diagnostic can name them without quoting values.
 *
 * @module @guowenzhang/dsh-mcp-manager/claude-import
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { MCP_SERVER_NAME_PATTERN } from './mcp-config.ts'
import { secretKeys, specFromObject, type AnyRecord } from './mcp-spec.ts'
import type { ClaudeMcpEntry, ClaudeMcpProblem, ClaudeMcpSource, ScanClaudeMcpResult } from './types.ts'
/** Where the user scope lives, relative to the home directory. */
const CLAUDE_JSON = '.claude.json'

/** Claude's own settings directory, relative to the home directory. */
const CLAUDE_DIR = '.claude'

/** Settings file names inside the Claude directory that may carry `mcpServers`. */
const CLAUDE_SETTINGS_FILES = ['settings.json', 'settings.local.json'] as const

/** The project scope file, relative to the project root. */
const PROJECT_MCP_FILE = '.mcp.json'

/** Largest configuration file this module will read. */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read and decode one JSON file, or report why it could not be used. */
async function readJson(path: string): Promise<{ value: unknown } | { error: ClaudeMcpProblem }> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code
    return { error: code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  if (text.length > MAX_SOURCE_BYTES) return { error: 'too-large' }
  try {
    return { value: JSON.parse(text) }
  } catch {
    // A partially written or hand-edited config must not hide the other
    // sources, so the failure is reported for this file alone.
    return { error: 'malformed' }
  }
}

/**
 * Collect the entries one `mcpServers` map declares.
 * @param map - the decoded `mcpServers` value, when it is an object.
 * @param source - the source the entries came from.
 * @param names - set collecting every discovered server name, for duplicate marking.
 * @returns one entry per usable server, skipping those that cannot be normalized.
 */
function entriesFromMap(
  map: unknown,
  source: { id: string; label: ClaudeMcpSource['label']; path: string; detail?: string },
  names: Set<string>,
): ClaudeMcpEntry[] {
  if (!isRecord(map)) return []
  const found: ClaudeMcpEntry[] = []
  /** One entry that cannot be imported, carrying the reason instead of a spec. */
  const skipped = (name: string, problem: ClaudeMcpProblem): ClaudeMcpEntry => ({
    serverName: name,
    sourceId: source.id,
    sourceLabel: source.label,
    sourcePath: source.path,
    ...(source.detail === undefined ? {} : { sourceDetail: source.detail }),
    // A refused entry still needs a spec field; the empty stdio spec is never
    // imported, because the dialog refuses to select an entry with a problem.
    spec: { type: 'stdio', command: '' },
    envKeys: [],
    duplicate: false,
    problem,
  })
  for (const [name, value] of Object.entries(map)) {
    if (!isRecord(value)) continue
    if (name.length === 0 || name.length > 64) continue
    // A name the composition cannot address is refused here rather than during
    // the import, so the dialog can say why instead of reporting a batch error.
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      found.push(skipped(name, 'unsupported-name'))
      continue
    }
    let spec
    try {
      spec = specFromObject(value, 'unsupported transport')
    } catch {
      // An entry this build cannot express is reported as skipped rather than
      // failing the whole file: one exotic row must not block the rest.
      found.push(skipped(name, 'unsupported'))
      continue
    }
    // The key in the file is the name a user recognizes and the one the row is
    // addressed by, so it is authoritative even when the command suggests
    // something shorter.
    names.add(name)
    found.push({
      serverName: name,
      sourceId: source.id,
      sourceLabel: source.label,
      sourcePath: source.path,
      ...(source.detail === undefined ? {} : { sourceDetail: source.detail }),
      spec,
      envKeys: [...secretKeys(spec)],
      duplicate: false,
    })
  }
  return found
}

/**
 * Scan the Claude Code configuration files for MCP servers.
 *
 * Every source is read independently: a missing file is omitted entirely, and a
 * file that exists but cannot be parsed is reported with its own problem so the
 * remaining sources still import. `cwd` selects which entry of the user file's
 * `projects` map is offered as its own source.
 * @param cwd - the working directory whose project scope should be read.
 * @param home - home directory holding `~/.claude.json` and `~/.claude`; defaults
 *   to the real one, and is injectable so the scan can be exercised on fixtures.
 * @returns the discovered sources, each with its entries, in scan order.
 */
export async function scanClaudeMcp(cwd: string, home: string = homedir()): Promise<ScanClaudeMcpResult> {
  const root = resolve(cwd)
  const sources: ClaudeMcpSource[] = []
  const names = new Set<string>()

  const userJson = join(home, CLAUDE_JSON)
  const user = await readJson(userJson)
  if ('error' in user) {
    if (user.error !== 'missing') {
      sources.push({ id: 'user', label: 'user', path: userJson, entries: [], problem: user.error })
    }
  } else if (isRecord(user.value)) {
    const entries = entriesFromMap(user.value.mcpServers, { id: 'user', label: 'user', path: userJson }, names)
    if (entries.length > 0) sources.push({ id: 'user', label: 'user', path: userJson, entries })
    // `projects` is keyed by working directory as Claude Code recorded it; the
    // separators vary by platform, so both spellings are compared.
    const projects = user.value.projects
    if (isRecord(projects)) {
      const wanted = [root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')]
      for (const key of wanted) {
        const project = projects[key]
        if (!isRecord(project) || !isRecord(project.mcpServers)) continue
        const projectEntries = entriesFromMap(project.mcpServers, {
          id: `project:${key}`,
          label: 'projectScope',
          path: userJson,
          detail: key,
        }, names)
        if (projectEntries.length > 0) {
          sources.push({
            id: `project:${key}`,
            label: 'projectScope',
            path: userJson,
            sourceDetail: key,
            entries: projectEntries,
          })
        }
        break
      }
    }
  } else {
    sources.push({ id: 'user', label: 'user', path: userJson, entries: [], problem: 'malformed' })
  }

  for (const file of CLAUDE_SETTINGS_FILES) {
    const path = join(home, CLAUDE_DIR, file)
    const read = await readJson(path)
    if ('error' in read) {
      if (read.error !== 'missing') {
        sources.push({ id: `settings:${file}`, label: 'settings', path, entries: [], problem: read.error })
      }
      continue
    }
    if (!isRecord(read.value)) {
      sources.push({ id: `settings:${file}`, label: 'settings', path, entries: [], problem: 'malformed' })
      continue
    }
    const entries = entriesFromMap(read.value.mcpServers, { id: `settings:${file}`, label: 'settings', path }, names)
    if (entries.length > 0) sources.push({ id: `settings:${file}`, label: 'settings', path, entries })
  }

  const projectPath = join(root, PROJECT_MCP_FILE)
  const project = await readJson(projectPath)
  if ('error' in project) {
    if (project.error !== 'missing') {
      sources.push({ id: 'project', label: 'projectFile', path: projectPath, entries: [], problem: project.error })
    }
  } else {
    const entries = entriesFromProjectFile(project.value, { id: 'project', label: 'projectFile', path: projectPath }, names)
    if (entries.length > 0) sources.push({ id: 'project', label: 'projectFile', path: projectPath, entries })
  }

  // Mark repeats after every source is read, so the first occurrence is the one
  // offered for import and later ones are visibly accounted for. A duplicate is
  // reported rather than dropped: the user still decides, and an entry that
  // failed to parse does not reserve its name against a usable one.
  const seen = new Set<string>()
  const marked = sources.map((source) => ({
    ...source,
    entries: source.entries.map((entry) => {
      const duplicate = seen.has(entry.serverName)
      if (entry.problem === undefined) seen.add(entry.serverName)
      return { ...entry, duplicate }
    }),
  }))
  return { sources: marked }
}

/**
 * Read one `.mcp.json`. The file is `{ "mcpServers": { … } }`, but a bare
 * single-entry map is also accepted because users hand-write it that way.
 */
function entriesFromProjectFile(
  value: unknown,
  source: { id: string; label: ClaudeMcpSource['label']; path: string },
  names: Set<string>,
): ClaudeMcpEntry[] {
  if (!isRecord(value)) return []
  const inner = value.mcpServers
  if (isRecord(inner)) return entriesFromMap(inner, source, names)
  // A bare map is only a server set when every value looks like a server
  // object; otherwise this is some other document and nothing should import.
  const values = Object.values(value)
  if (values.length === 0 || !values.every(isRecord)) return []
  return entriesFromMap(value, source, names)
}
