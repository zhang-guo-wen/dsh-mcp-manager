import { livePresetMounts } from "@deepseek-ai/dsh-agent-preset-registry";
import { access, constants, lstat, readFile } from "node:fs/promises";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { dirname, extname, join, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { homedir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { createHash } from "node:crypto";
import { isJsExpr } from "@deepseek-ai/cordis-plugin-loader";
import z from "@deepseek-ai/schemastery";
//#region src/mcp-authoring.ts
/** File-backed MCP row mutations for the global composition. */
/** Module specifier of the MCP client bridge these helpers author. */
const MCP_CLIENT_MODULE = "@deepseek-ai/dsh-mcp-client";
/**
* Validate one parsed Loader entry list before applying a mutation.
* @param value - parsed YAML or JSON content.
* @returns the first validation problem, or undefined for a valid entry list.
*/
function entryListProblem(value) {
	if (!Array.isArray(value)) return "composition must be a top-level entry list";
	return entryListRowsProblem(value, "composition");
}
function entryListRowsProblem(rows, path) {
	for (const [index, value] of rows.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path}[${index}] must be an entry object`;
		const row = value;
		if (typeof row.id !== "string" || row.id.length === 0) return `${path}[${index}].id must be a non-empty string`;
		if (typeof row.name !== "string" || row.name.length === 0) return `${path}[${index}].name must be a non-empty string`;
		if (row.group === true) {
			if (!Array.isArray(row.config)) return `${path}[${index}].config must be an entry list for a group`;
			const problem = entryListRowsProblem(row.config, `${path}[${index}].config`);
			if (problem !== void 0) return problem;
		}
	}
}
/**
* Find rows recursively, preserving the local Loader ids used by patches.
* @param rows - entry rows at the current composition level.
* @param id - row id to locate.
* @returns every matching row, including nested group children.
*/
function findEntryRows(rows, id) {
	const found = [];
	for (const row of rows) {
		if (row.id === id) found.push(row);
		if (row.group === true && Array.isArray(row.config)) found.push(...findEntryRows(row.config, id));
	}
	return found;
}
/**
* Collect every row id in a composition, including nested group children.
* @param rows - entry rows at the current composition level.
* @returns all row ids in the composition.
*/
function entryIds(rows) {
	const ids = /* @__PURE__ */ new Set();
	for (const row of rows) {
		ids.add(row.id);
		if (row.group === true && Array.isArray(row.config)) for (const id of entryIds(row.config)) ids.add(id);
	}
	return ids;
}
/** Reject a preset path that traverses a symbolic link. */
async function assertNoSymlink(path) {
	let current = resolve(path);
	for (;;) {
		try {
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`preset composition path contains a symbolic link: ${current}`);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}
/**
* Apply one Loader patch to an entry-list file and replace it atomically.
* @param filename - YAML or JSON entry-list path.
* @param target - the Remote target used in actionable failure details.
* @param patch - one Loader patch to apply.
* @param validate - target and duplicate checks run against locked disk state.
* @param warn - sink for skipped-patch diagnostics.
* @returns a promise resolving after the atomic replacement is committed.
* @throws an MCP Remote error when the file cannot be read or parsed.
*/
async function writeEntryListFile(filename, target, patch, validate, warn) {
	await assertNoSymlink(filename);
	await withFileLock(filename, async () => {
		await assertNoSymlink(filename);
		let parsed;
		try {
			parsed = load(await readFile(filename, "utf8"), { schema: entryListSchema });
		} catch (cause) {
			throw new RemoteError("mcp/invalid", "MCP entry-list file could not be read", {
				target,
				reason: String(cause)
			}, { cause });
		}
		const problem = entryListProblem(parsed);
		if (problem !== void 0) throw new RemoteError("mcp/invalid", "MCP entry-list file is not valid", {
			target,
			reason: problem
		});
		const rows = parsed;
		validate(rows);
		const next = applyEntryPatches(rows, [patch], warn);
		const content = extname(filename).toLowerCase() === ".json" ? JSON.stringify(next, null, 2) + "\n" : dump(next, { schema: entryListSchema });
		await writeFileAtomic(filename, content, {
			mode: 384,
			dirMode: 448
		});
	});
}
/**
* Return a stable leaf id for a mounted preset row address.
* @param entryId - local or loader-qualified row id.
* @returns the row id used in the preset composition file.
*/
function presetLeafId(entryId) {
	const separator = entryId.lastIndexOf(":");
	return separator < 0 ? entryId : entryId.slice(separator + 1);
}
/** The profile editor, or undefined when this composition mounts none. */
function profileEditor(ctx) {
	return ctx.get("configEditor");
}
/**
* Locate every declaration the profile editor owns.
*
* The read is tolerant on purpose: a declaration whose child list is malformed,
* or one that is still missing its preset id, is skipped so a roster read can
* still describe the presets that are usable. {@link findPresetDeclaration}
* keeps reporting those as errors when a mutation names one.
* @param ctx - host context carrying `configEditor`.
* @returns declarations in editor order.
*/
function listPresetDeclarations(ctx) {
	const editor = profileEditor(ctx);
	if (editor === void 0) return [];
	const declared = [];
	for (const entry of editor.entries()) {
		if (entry.options.name !== "@deepseek-ai/dsh-agent-preset") continue;
		const config = entry.options.config;
		if (typeof config?.id !== "string" || config.id === "") continue;
		declared.push({
			id: config.id,
			...typeof config.name === "string" && config.name !== "" ? { name: config.name } : {},
			entry,
			rows: Array.isArray(config.plugins) ? config.plugins : []
		});
	}
	return declared;
}
/**
* Validate one declaration's child rows.
* @param config - the declaration's composed configuration.
* @param id - preset identity used in the diagnostic.
* @returns the child rows.
* @throws an MCP Remote error when the row list is malformed.
*/
function declaredRows(config, id) {
	const plugins = config?.plugins;
	const problem = entryListProblem(plugins);
	if (problem !== void 0) throw new RemoteError("mcp/invalid", `Agent preset "${id}" is not a valid composition`, { reason: problem });
	return plugins;
}
/**
* Whether one Loader entry declares the given preset.
* @param entry - candidate declaration row.
* @param id - preset identity.
* @returns whether this row declares that preset.
*/
function declares(entry, id) {
	return entry.options.name === "@deepseek-ai/dsh-agent-preset" && entry.options.config?.id === id;
}
/**
* Locate the declaration of one preset.
* @param ctx - host context carrying `configEditor`.
* @param id - preset identity.
* @returns the declaration with its declared child rows.
* @throws an MCP Remote error when no editor is mounted or the preset is undeclared.
*/
function findPresetDeclaration(ctx, id) {
	const editor = profileEditor(ctx);
	if (editor === void 0) throw new RemoteError("mcp/unavailable", "agent preset MCP authoring is unavailable", { reason: "configEditor is not mounted in this composition" });
	const entry = editor.entries().find((candidate) => declares(candidate, id));
	if (entry === void 0) {
		const target = {
			scope: "preset",
			agentPreset: id
		};
		throw new RemoteError("mcp/not-found", `MCP preset "${id}" was not found`, { target });
	}
	const name = entry.options.config?.name;
	return {
		id,
		...typeof name === "string" && name !== "" ? { name } : {},
		entry,
		rows: declaredRows(entry.options.config, id)
	};
}
/**
* Apply one Loader patch to a preset's declared child rows.
*
* The editor owns the profile lock, so the read-validate-patch-write cycle runs
* against the state another editor would see, and its Loader reconcile mounts or
* unmounts exactly the rows the declaration changed — a separate refresh step
* would only repeat that work.
* @param ctx - host context carrying `configEditor`.
* @param declaration - the preset to edit.
* @param patch - one Loader patch applied to the declared child rows.
* @param validate - target and duplicate checks run against the rows being replaced.
* @param warn - sink for skipped-patch diagnostics.
* @returns a promise resolving after the profile patch and its reconcile commit.
* @throws an MCP Remote error when no editor is mounted.
*/
async function writePresetRows(ctx, declaration, patch, validate, warn) {
	const editor = profileEditor(ctx);
	if (editor === void 0) throw new RemoteError("mcp/unavailable", "agent preset MCP authoring is unavailable", { reason: "configEditor is not mounted in this composition" });
	await editor.edit(declaration.entry, (current) => {
		const rows = declaredRows(current, declaration.id);
		validate(rows);
		return {
			...current,
			plugins: applyEntryPatches(rows, [patch], warn)
		};
	});
}
//#endregion
//#region src/mcp-config.ts
/**
* MCP config authoring helpers: convert the settings form's JSON spec
* (Claude Code-style `type`/`command`/`args`) into the `mcp-client` Config
* shape, and back, so the roster and the edit form share one form. The spec is
* validated strictly — a malformed or unknown-transport spec is refused before
* it reaches a composition file.
* @module @guowenzhang/dsh-mcp-manager/mcp-config
*/
/** mcp-client `serverName` namespace pattern (`mcp__<serverName>__<rawName>`). */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/**
* Validate a server-name string.
* @param serverName - candidate server namespace.
* @returns the value when valid.
* @throws when it does not match the mcp-client namespace pattern.
*/
function assertServerName(serverName) {
	if (!MCP_SERVER_NAME_PATTERN.test(serverName)) throw new Error(`MCP serverName must match ${String(MCP_SERVER_NAME_PATTERN)}`);
	return serverName;
}
/**
* Convert a form spec + identity into the mcp-client entry config.
* @param spec - the user-supplied JSON spec.
* @param serverName - the server namespace (unique per entry).
* @returns the mcp-client connection config shape. Display descriptions stay in
* the `context-injection` settings namespace and are not written to MCP rows.
* @throws when the spec is malformed or the transport fragment is incomplete.
*/
function mcpEntryConfig(spec, serverName) {
	assertServerName(serverName);
	switch (spec.type) {
		case "stdio": {
			const command = spec.command;
			if (typeof command !== "string" || command.length === 0) throw new Error("MCP stdio spec requires a command string");
			return {
				transport: "stdio",
				serverName,
				command,
				args: [...spec.args ?? []],
				env: { ...spec.env },
				cwd: spec.cwd ?? ""
			};
		}
		case "http":
		case "sse":
		case "streamable-http": {
			const url = spec.url;
			if (typeof url !== "string" || url.length === 0) throw new Error("MCP http spec requires a url");
			return {
				transport: "streamable-http",
				serverName,
				url,
				headers: { ...spec.headers }
			};
		}
		default: throw new Error(`Unknown MCP transport type: ${String(spec.type)}`);
	}
}
/**
* Reverse a stored entry config into the form spec (for editing).
* @param config - the mcp-client connection config read from an entry.
* @returns the Claude Code-style spec the edit form edits.
*/
function specFromEntryConfig(config) {
	if (config.transport === "stdio") return {
		type: "stdio",
		command: config.command,
		args: config.args,
		env: config.env,
		cwd: config.cwd
	};
	return {
		type: "streamable-http",
		url: config.url,
		headers: config.headers
	};
}
//#endregion
//#region src/mcp-spec.ts
/** True for a decoded JSON object (not null, not an array). */
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/**
* Read one server object (Claude-shaped, `spec` fields at the top level) into
* the normalized spec. A missing `type` is inferred: `command` means stdio and
* `url` means streamable HTTP, matching what Claude Code writes.
* @param candidate - one decoded server entry.
* @param invalid - message used for a malformed or unknown-transport entry.
* @returns the normalized transport spec.
* @throws when the entry declares an unsupported transport or lacks its
* required field.
*/
function specFromObject(candidate, invalid) {
	const declared = candidate.type;
	const type = declared === void 0 ? typeof candidate.command === "string" ? "stdio" : typeof candidate.url === "string" ? "streamable-http" : void 0 : declared;
	if (type === "stdio") {
		const command = candidate.command;
		if (typeof command !== "string" || command.trim() === "") throw new Error(invalid);
		const args = Array.isArray(candidate.args) ? candidate.args.map(String) : void 0;
		const env = isRecord$1(candidate.env) ? Object.fromEntries(Object.entries(candidate.env).map(([k, v]) => [k, String(v)])) : void 0;
		const cwd = typeof candidate.cwd === "string" ? candidate.cwd : void 0;
		return {
			type: "stdio",
			command,
			...args === void 0 ? {} : { args },
			...env === void 0 ? {} : { env },
			...cwd === void 0 ? {} : { cwd }
		};
	}
	if (type === "streamable-http" || type === "http" || type === "sse") {
		const url = candidate.url;
		if (typeof url !== "string" || url.trim() === "") throw new Error(invalid);
		const headers = isRecord$1(candidate.headers) ? Object.fromEntries(Object.entries(candidate.headers).map(([k, v]) => [k, String(v)])) : void 0;
		return {
			type,
			url,
			...headers === void 0 ? {} : { headers }
		};
	}
	throw new Error(invalid);
}
/**
* Parse an MCP connection document. Accepts a flat spec, a single-entry named
* map (`{ "<name>": { command|url } }`), or a Claude `mcpServers` wrapper; a
* name carried in the JSON is returned so a caller can fill an empty title.
* @param text - raw JSON text.
* @param invalid - message used for malformed JSON or an unrecognized shape.
* @returns the normalized spec and the entry's own name when it declared one.
* @throws when the text is not JSON or does not describe exactly one server.
*/
function parseSpecText(text, invalid) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(invalid);
	}
	return parseSpecValue(value, invalid);
}
/**
* Parse one decoded MCP connection document; the JSON-text entry point above
* and the file scanner share this so both accept the same shapes.
* @param value - decoded JSON value.
* @param invalid - message used for an unrecognized shape.
* @returns the normalized spec and the entry's own name when it declared one.
* @throws when the value does not describe exactly one server.
*/
function parseSpecValue(value, invalid) {
	if (!isRecord$1(value)) throw new Error(invalid);
	let root = value;
	if (isRecord$1(root.mcpServers)) root = root.mcpServers;
	let serverName;
	if (root.type === void 0 && root.command === void 0 && root.url === void 0) {
		const pairs = Object.entries(root);
		if (pairs.length !== 1) throw new Error(invalid);
		const [name, entry] = pairs[0];
		if (!isRecord$1(entry)) throw new Error(invalid);
		serverName = name;
		root = entry;
	}
	return {
		spec: specFromObject(root, invalid),
		...serverName === void 0 ? {} : { serverName }
	};
}
/**
* Flatten a spec into a Claude-shaped object (`spec` fields at the top level),
* the inverse of {@link specFromObject} for display and round-tripping.
* @param spec - normalized transport spec.
* @returns the Claude-shaped object.
*/
function flattenSpec(spec) {
	if (spec.type === "stdio") return {
		type: "stdio",
		command: spec.command,
		...spec.args === void 0 ? {} : { args: spec.args },
		...spec.env === void 0 ? {} : { env: spec.env },
		...spec.cwd === void 0 ? {} : { cwd: spec.cwd }
	};
	return {
		type: spec.type,
		url: spec.url,
		...spec.headers === void 0 ? {} : { headers: spec.headers }
	};
}
/**
* The names of the secrets one spec carries. Only the keys are read: a scan
* result is shown to the user and written to logs, so values must never travel
* with it.
* @param spec - normalized transport spec.
* @returns the `env` keys for stdio, or the `headers` keys for HTTP.
*/
function secretKeys(spec) {
	const values = spec.type === "stdio" ? spec.env : spec.headers;
	return Object.keys(values ?? {});
}
/**
* Derive a server namespace from a launch command, used when an imported entry
* declares no name of its own. Strips the scope, the `-mcp`/`-server` suffixes,
* and any version, so `@upstash/context7-mcp` reads as `context7` and
* `alibabacloud-devops-mcp-server` reads as `alibabacloud-devops`.
* @param command - the stdio command or first package argument.
* @returns a namespace candidate, or an empty string when nothing survives.
*/
function serverNameFromCommand(command) {
	return (command.split(/[\\/]/).at(-1) ?? command).replace(/\.(cmd|exe|ps1|js|mjs|cjs|py)$/i, "").replace(/^@[^/]+\//, "").replace(/-mcp(-server)?$/, "").replace(/-server$/, "").replace(/@[^@]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
//#endregion
//#region src/claude-import.ts
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
/** Where the user scope lives, relative to the home directory. */
const CLAUDE_JSON = ".claude.json";
/** Claude's own settings directory, relative to the home directory. */
const CLAUDE_DIR = ".claude";
/** Settings file names inside the Claude directory that may carry `mcpServers`. */
const CLAUDE_SETTINGS_FILES = ["settings.json", "settings.local.json"];
/** The project scope file, relative to the project root. */
const PROJECT_MCP_FILE = ".mcp.json";
/** Largest configuration file this module will read. */
const MAX_SOURCE_BYTES = 16777216;
/** True for a decoded JSON object (not null, not an array). */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Read and decode one JSON file, or report why it could not be used. */
async function readJson(path) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (cause) {
		return { error: cause.code === "ENOENT" ? "missing" : "unreadable" };
	}
	if (text.length > MAX_SOURCE_BYTES) return { error: "too-large" };
	try {
		return { value: JSON.parse(text) };
	} catch {
		return { error: "malformed" };
	}
}
/**
* Collect the entries one `mcpServers` map declares.
* @param map - the decoded `mcpServers` value, when it is an object.
* @param source - the source the entries came from.
* @param names - set collecting every discovered server name, for duplicate marking.
* @returns one entry per usable server, skipping those that cannot be normalized.
*/
function entriesFromMap(map, source, names) {
	if (!isRecord(map)) return [];
	const found = [];
	/** One entry that cannot be imported, carrying the reason instead of a spec. */
	const skipped = (name, problem) => ({
		serverName: name,
		sourceId: source.id,
		sourceLabel: source.label,
		sourcePath: source.path,
		...source.detail === void 0 ? {} : { sourceDetail: source.detail },
		spec: {
			type: "stdio",
			command: ""
		},
		envKeys: [],
		duplicate: false,
		problem
	});
	for (const [name, value] of Object.entries(map)) {
		if (!isRecord(value)) continue;
		if (name.length === 0 || name.length > 64) continue;
		if (!MCP_SERVER_NAME_PATTERN.test(name)) {
			found.push(skipped(name, "unsupported-name"));
			continue;
		}
		let spec;
		try {
			spec = specFromObject(value, "unsupported transport");
		} catch {
			found.push(skipped(name, "unsupported"));
			continue;
		}
		names.add(name);
		found.push({
			serverName: name,
			sourceId: source.id,
			sourceLabel: source.label,
			sourcePath: source.path,
			...source.detail === void 0 ? {} : { sourceDetail: source.detail },
			spec,
			envKeys: [...secretKeys(spec)],
			duplicate: false
		});
	}
	return found;
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
async function scanClaudeMcp(cwd, home = homedir()) {
	const root = resolve(cwd);
	const sources = [];
	const names = /* @__PURE__ */ new Set();
	const userJson = join(home, CLAUDE_JSON);
	const user = await readJson(userJson);
	if ("error" in user) {
		if (user.error !== "missing") sources.push({
			id: "user",
			label: "user",
			path: userJson,
			entries: [],
			problem: user.error
		});
	} else if (isRecord(user.value)) {
		const entries = entriesFromMap(user.value.mcpServers, {
			id: "user",
			label: "user",
			path: userJson
		}, names);
		if (entries.length > 0) sources.push({
			id: "user",
			label: "user",
			path: userJson,
			entries
		});
		const projects = user.value.projects;
		if (isRecord(projects)) {
			const wanted = [
				root,
				root.replaceAll("\\", "/"),
				root.replaceAll("/", "\\")
			];
			for (const key of wanted) {
				const project = projects[key];
				if (!isRecord(project) || !isRecord(project.mcpServers)) continue;
				const projectEntries = entriesFromMap(project.mcpServers, {
					id: `project:${key}`,
					label: "projectScope",
					path: userJson,
					detail: key
				}, names);
				if (projectEntries.length > 0) sources.push({
					id: `project:${key}`,
					label: "projectScope",
					path: userJson,
					sourceDetail: key,
					entries: projectEntries
				});
				break;
			}
		}
	} else sources.push({
		id: "user",
		label: "user",
		path: userJson,
		entries: [],
		problem: "malformed"
	});
	for (const file of CLAUDE_SETTINGS_FILES) {
		const path = join(home, CLAUDE_DIR, file);
		const read = await readJson(path);
		if ("error" in read) {
			if (read.error !== "missing") sources.push({
				id: `settings:${file}`,
				label: "settings",
				path,
				entries: [],
				problem: read.error
			});
			continue;
		}
		if (!isRecord(read.value)) {
			sources.push({
				id: `settings:${file}`,
				label: "settings",
				path,
				entries: [],
				problem: "malformed"
			});
			continue;
		}
		const entries = entriesFromMap(read.value.mcpServers, {
			id: `settings:${file}`,
			label: "settings",
			path
		}, names);
		if (entries.length > 0) sources.push({
			id: `settings:${file}`,
			label: "settings",
			path,
			entries
		});
	}
	const projectPath = join(root, PROJECT_MCP_FILE);
	const project = await readJson(projectPath);
	if ("error" in project) {
		if (project.error !== "missing") sources.push({
			id: "project",
			label: "projectFile",
			path: projectPath,
			entries: [],
			problem: project.error
		});
	} else {
		const entries = entriesFromProjectFile(project.value, {
			id: "project",
			label: "projectFile",
			path: projectPath
		}, names);
		if (entries.length > 0) sources.push({
			id: "project",
			label: "projectFile",
			path: projectPath,
			entries
		});
	}
	const seen = /* @__PURE__ */ new Set();
	return { sources: sources.map((source) => ({
		...source,
		entries: source.entries.map((entry) => {
			const duplicate = seen.has(entry.serverName);
			if (entry.problem === void 0) seen.add(entry.serverName);
			return {
				...entry,
				duplicate
			};
		})
	})) };
}
/**
* Read one `.mcp.json`. The file is `{ "mcpServers": { … } }`, but a bare
* single-entry map is also accepted because users hand-write it that way.
*/
function entriesFromProjectFile(value, source, names) {
	if (!isRecord(value)) return [];
	const inner = value.mcpServers;
	if (isRecord(inner)) return entriesFromMap(inner, source, names);
	const values = Object.values(value);
	if (values.length === 0 || !values.every(isRecord)) return [];
	return entriesFromMap(value, source, names);
}
//#endregion
//#region src/mcp-tool-filter.ts
/**
* Tool-level filters for on-demand MCP servers.
*
* A server that publishes fifty tools but is used for three of them pays for
* all fifty input schemas every time the session loads it. One row's rules live
* in the `context-injection` settings namespace under `mcpTools`, keyed as
* `mcpRowKey`, and decide which of a server's discovered tools reach the model
* at load time:
*
* - a plain entry keeps matching tools, so a row with at least one plain entry
*   is an allow list and everything else is hidden;
* - a `!`-prefixed entry drops matching tools, so a row with only `!` entries
*   is a deny list and everything else survives;
* - `*` matches any run of characters and `?` matches exactly one.
*
* Filtering happens where the tools are discovered and again where they are
* called, so a hidden tool is neither advertised nor callable. The settings
* document is a user-editable file: an absent, empty, or unparsable rule set
* filters nothing, because a typo must not silently hide a server.
*
* @module @guowenzhang/dsh-mcp-manager/mcp-tool-filter
*/
/** Marker that turns one rule entry into an exclusion. */
const EXCLUSION_PREFIX = "!";
/** A filter that hides nothing, used when a row has no rules. */
const NO_TOOL_FILTER = {
	keep: [],
	drop: []
};
/**
* Read one row's stored rules as trimmed entries.
*
* The value arrives from a durable settings document, so every malformed entry
* is skipped rather than raised: a rule set that parses to nothing filters
* nothing. A bare string is accepted as a one-entry list because the document is
* hand-edited.
*
* @param value - the stored rule value for one row, of any shape.
* @returns the non-blank entries in their stored order, with their markers.
*/
function toolRuleEntries(value) {
	const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	const text = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed !== "") text.push(trimmed);
	}
	return text;
}
/**
* Compile one row's stored rules into patterns.
* @param value - the stored rule value for one row, of any shape.
* @returns the patterns to keep and the patterns to drop.
*/
function parseMcpToolFilter(value) {
	const keep = [];
	const drop = [];
	for (const entry of toolRuleEntries(value)) {
		if (entry.startsWith(EXCLUSION_PREFIX)) {
			const pattern = entry.slice(1).trim();
			if (pattern !== "") drop.push(compilePattern(pattern));
			continue;
		}
		keep.push(compilePattern(entry));
	}
	return {
		keep,
		drop
	};
}
/**
* Whether a rule set hides anything.
* @param filter - a parsed rule set.
* @returns true when at least one pattern was parsed.
*/
function filterHidesAnything(filter) {
	return filter.keep.length > 0 || filter.drop.length > 0;
}
/**
* Select the tools one server may expose under a filter.
* @param tools - the server's discovered tools, in the server's own order.
* @param filter - the row's parsed rules.
* @returns the visible tools in their original order, plus how many were hidden.
*/
function filterMcpTools(tools, filter) {
	if (!filterHidesAnything(filter)) return {
		visible: tools,
		hidden: 0
	};
	const visible = tools.filter((tool) => admits(filter, tool.name));
	return {
		visible,
		hidden: tools.length - visible.length
	};
}
/**
* Whether one tool name survives a filter.
* @param filter - the row's parsed rules.
* @param name - the server's own tool name.
* @returns true when an exclusion does not match and either no allow pattern
* exists or one matches.
*/
function admits(filter, name) {
	if (filter.drop.some((pattern) => pattern.test(name))) return false;
	return filter.keep.length === 0 || filter.keep.some((pattern) => pattern.test(name));
}
/**
* Compile one entry into an anchored pattern.
*
* Every regular-expression metacharacter except the two wildcards is escaped,
* so a rule matches tool names literally apart from `*` and `?`.
*
* @param pattern - one trimmed rule entry without its exclusion marker.
* @returns an anchored, case-sensitive pattern.
*/
function compilePattern(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
}
//#endregion
//#region src/mcp-tool-name.ts
/**
* Model-facing naming for one MCP tool under any carrier.
*
* The plugin registers a filtered row's visible tools itself, so it must
* reproduce the `mcp-client` public-name contract exactly: the same tool has to
* carry the same name whichever carrier loaded its row, or the model would see
* two identities for one tool and the `mcp__<serverName>__` prefix that
* presentation code matches on would stop being a reliable namespace.
*
* Mirrors `publicToolName` in `@deepseek-ai/dsh-mcp-client`, which that package
* does not re-export from its public entry. Keep the two implementations in
* step; `tests/mcp-tool-name.spec.ts` pins the fixtures both must satisfy.
*
* @module @guowenzhang/dsh-mcp-manager/mcp-tool-name
*/
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/**
* Derive the model-facing name of one MCP tool.
* @param serverName - the row's `serverName` namespace.
* @param rawName - the MCP server's own tool name.
* @returns `mcp__<serverName>__<rawName>` verbatim when that already satisfies
*   the function-name contract; otherwise the sanitized and truncated form plus
*   a 12-hex-char SHA-256 identity hash, so distinct identities never collapse
*   onto one name.
*/
function mcpToolPublicName(serverName, rawName) {
	const joined = `mcp__${serverName}__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, 51)}_${hash}`;
}
//#endregion
//#region src/mcp-carrier.ts
/**
* Choose one on-demand mode's carrier.
*
* The mode owns this decision: it is what decides whether the model argues from
* real tool schemas — and pays a prefix invalidation per load — or calls
* through the proxy and pays arguments copied out of a result. A row's filter
* only narrows the visible set inside that decision.
* @param mode - the loading mode a session committed to.
* @param filter - the row's resolved rules.
* @returns `proxy` under `lazy`; under `dynamic`, `native` when the rules hide
*   anything and `mount` when they hide nothing; `undefined` under `eager`,
*   which mounts every allowed row and registers no on-demand tool at all.
*/
function carrierFor(mode, filter) {
	if (mode === "eager") return void 0;
	if (mode === "lazy") return "proxy";
	return filterHidesAnything(filter) ? "native" : "mount";
}
/**
* The name the model calls one visible tool by.
*
* A `proxy` row is called by its upstream name through `mcp_call`; every
* carrier that registers tools natively is called by the model-facing public
* name, so `mcp_load` must report that same name or the model would be handed a
* name no tool answers to.
* @param carrier - the carrier that exposed the tool.
* @param serverName - the row's namespace.
* @param rawName - the tool's upstream name.
* @returns the reported and callable name for this (carrier, serverName, tool).
*/
function visibleToolName(carrier, serverName, rawName) {
	return carrier === "proxy" ? rawName : mcpToolPublicName(serverName, rawName);
}
/**
* The upstream input schema as the definition adapter accepts it.
* @param schema - the schema the server advertised for one tool.
* @returns that schema, or an annotation-only one when the server declared none.
*/
function toolInputSchema(schema) {
	return schema !== null && typeof schema === "object" && !Array.isArray(schema) ? schema : {};
}
/**
* Build one generation of native tool definitions for a server's visible tools.
*
* Every definition comes from the harness's own adapter, so a filtered row's
* tools bind arguments, validate results, and project images exactly as a
* mounted row's do — the difference is only that the hidden tools are never
* built. Building is pure: nothing is registered, so a failure here leaves the
* session's current generation untouched.
* @param ctx - the session context the definitions resolve services through.
* @param adapter - the harness `createMcpToolDefinition` export.
* @param serverName - the row's namespace.
* @param visible - the tools the row's rules admit, in the server's own order.
* @param client - the connected SDK client every definition forwards to.
* @returns definitions keyed by model-facing public name.
* @throws when the server lists one raw name twice, which would collapse two
*   distinct tools onto a single public name.
*/
function nativeDefinitions(ctx, adapter, serverName, visible, client) {
	const definitions = /* @__PURE__ */ new Map();
	for (const tool of visible) {
		const name = mcpToolPublicName(serverName, tool.name);
		if (definitions.has(name)) throw new Error(`MCP server "${serverName}" listed tool "${tool.name}" more than once — invalid tool list`);
		definitions.set(name, adapter(ctx, {
			name,
			rawName: tool.name,
			description: tool.description ?? "",
			inputSchema: toolInputSchema(tool.inputSchema),
			...tool.outputSchema === void 0 ? {} : { outputSchema: tool.outputSchema },
			...tool.execution?.taskSupport === "required" ? { taskRequired: true } : {},
			call: (args, execution) => client.callTool({
				name: tool.name,
				arguments: args
			}, void 0, { signal: execution.signal })
		}));
	}
	return definitions;
}
/**
* Swap one generation of native registrations.
*
* New names register before anything is disposed, and a name that survives the
* swap keeps its registration — so the model's tool list, and the request
* prefix carrying it, changes only where the server did. A rejected
* registration unwinds the names this swap added and rethrows, leaving the
* previous generation registered: the same all-or-nothing contract `mcp-client`
* follows for its own generations.
* @param registry - the session-scoped tool registry.
* @param current - the registrations this mount owns right now.
* @param definitions - the next generation, keyed by public name.
* @returns the registrations the mount owns after a successful swap.
*/
function swapNativeTools(registry, current, definitions) {
	const next = /* @__PURE__ */ new Map();
	const added = [];
	try {
		for (const [name, definition] of definitions) {
			const existing = current.get(name);
			if (existing !== void 0) {
				next.set(name, existing);
				continue;
			}
			next.set(name, registry.register(definition));
			added.push(name);
		}
	} catch (error) {
		for (const name of added) next.get(name)?.();
		throw error;
	}
	for (const [name, dispose] of current) if (!next.has(name)) dispose();
	return next;
}
//#endregion
//#region src/mcp-gate.ts
/** Stable key for one row, matching the settings UI's description key. */
function mcpRowKey(target, serverName) {
	return target.scope === "preset" ? `preset:${target.agentPreset}:${serverName}` : `global:${serverName}`;
}
/**
* Host events that mean "the composed rows may have changed". `tools/change` is
* the load-bearing one: a preset composes its rows after this plugin applies,
* and those rows announce themselves by registering tools. `loader/entry-init`
* and `agent-preset/selected` narrow the same moment and are kept because they
* arrive even for a row that publishes no tool.
*/
const MCP_ROW_EVENTS = [
	"tools/change",
	"loader/entry-init",
	"agent-preset/selected"
];
/**
* Resolve the `livePresetMounts` reader from the preset registry instance the
* Loader actually uses. A plain import can land on a second copy of the package
* (the harness resolves its roster from its own graph), so the Loader's
* internal resolver is asked first and the static import is the fallback.
* @param ctx - plugin context holding `ctx.loader`.
* @param fallback - the statically imported reader.
* @returns a reader of the live preset mounts for this runtime.
*/
async function resolvePresetMounts(ctx, fallback) {
	const loader = ctx.get("loader");
	const base = ctx.baseUrl;
	if (loader?.internal !== void 0 && base !== void 0) try {
		const mod = await loader.internal.import("@deepseek-ai/dsh-agent-preset-registry", base, {});
		if (mod.livePresetMounts !== void 0) return mod.livePresetMounts;
	} catch {}
	return fallback;
}
/**
* Create the preload gate for one host plugin instance.
* @param ctx - host context owning the loader and the agent-presets service.
* @param readMode - reads the committed loading mode on every reconcile.
* @param mountReader - reader of live preset mounts, from {@link resolvePresetMounts}.
* @param warn - diagnostics sink for rows the gate cannot drive.
* @returns the gate the tool registration consults.
*/
function createMcpPreloadGate(ctx, readMode, mountReader, warn) {
	/** Runtime answers, keyed as {@link mcpRowKey}. */
	const states = /* @__PURE__ */ new Map();
	/** Serializes reconciles so an entry event cannot interleave with its own run. */
	let queue = Promise.resolve();
	let disposed = false;
	const run = async () => {
		if (disposed) return;
		const mode = readMode();
		const mounts = mountReader(ctx.root.fiber);
		const seen = /* @__PURE__ */ new Set();
		for (const mount of mounts) {
			let rows;
			try {
				rows = findPresetDeclaration(ctx, mount.presetId).rows;
			} catch (error) {
				warn(`mcp-manager: cannot read preset "${mount.presetId}" composition: ${String(error)}`);
				continue;
			}
			for (const entry of mount.tree.entries()) {
				if (entry.options.group === true || entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
				const leaf = presetLeafId(entry.options.id);
				const serverName = entry.options.id;
				const declaredRow = findEntryRows(rows, leaf)[0];
				if (declaredRow === void 0) continue;
				const allowed = declaredRow.disabled !== true;
				const wantMounted = allowed && mode === "eager";
				const key = mcpRowKey({
					scope: "preset",
					agentPreset: mount.presetId
				}, serverName);
				seen.add(key);
				if (entry.fiber !== void 0 !== wantMounted) try {
					await entry.update({ disabled: !wantMounted }, false, true);
				} catch (error) {
					warn(`mcp-manager: cannot ${wantMounted ? "mount" : "hold"} MCP row "${key}": ${String(error)}`);
					continue;
				}
				states.set(key, {
					allowed,
					suppressed: allowed && !wantMounted
				});
			}
		}
		for (const key of [...states.keys()]) if (!seen.has(key)) states.delete(key);
	};
	const reconcile = () => {
		queue = queue.then(run, run);
		return queue;
	};
	return {
		reconcile,
		stateFor: (target, entryId) => states.get(mcpRowKey(target, presetLeafId(entryId))),
		suppressedKeys: () => [...states.entries()].filter(([, state]) => state.suppressed).map(([key]) => key),
		dispose: () => {
			disposed = true;
			states.clear();
		}
	};
}
/**
* The usage line for one on-demand mode.
* @param mode - the on-demand loading mode the instruction must match.
* @returns one line naming the tools that actually exist in that mode.
*/
function instruction(mode) {
	return mode === "lazy" ? "MCP servers available on demand: call `mcp_load` with one of these names to list that server's tools, `mcp_call` to invoke one, and `mcp_unload` with the same name to release it again." : "MCP servers available on demand: call `mcp_load` with one of these names to add that server's tools to this session, and `mcp_unload` with the same name to release it again.";
}
/**
* Collapse one row description to a single trimmed line.
* @param text - the description as the user stored it.
* @returns the collapsed text, truncated to {@link MAX_DESCRIPTION_CHARS}.
*/
function clipDescription(text) {
	const collapsed = text.trim().replace(/\s+/g, " ");
	return collapsed.length <= 80 ? collapsed : `${collapsed.slice(0, 79)}…`;
}
/**
* Render the on-demand MCP inventory for the system prompt.
*
* Rows are listed in listing order and deduplicated by name, because
* `mcp_load` resolves a name to one server and two identically named lines
* would offer the model a choice it cannot make.
* @param rows - every server this deployment allows a session to load.
* @param mode - the on-demand mode whose tools the instruction names.
* @returns the section text, or an empty string when nothing may be loaded,
*   which contributes no section at all.
*/
function renderMcpInventory(rows, mode) {
	if (rows.length === 0) return "";
	const head = instruction(mode);
	const lines = [head];
	const seen = /* @__PURE__ */ new Set();
	let used = head.length;
	for (const row of rows) {
		if (seen.has(row.name)) continue;
		seen.add(row.name);
		const bullet = `- ${row.name}`;
		const description = clipDescription(row.description ?? "");
		const withDescription = description === "" ? bullet : `${bullet} — ${description}`;
		const line = used + withDescription.length + 1 <= 900 ? withDescription : bullet;
		lines.push(line);
		used += line.length + 1;
	}
	return lines.join("\n");
}
//#endregion
//#region src/lazy-mcp.ts
/** Every {@link McpLoadingMode}, used to validate the persisted setting. */
const MCP_LOADING_MODES = [
	"eager",
	"dynamic",
	"lazy"
];
/**
* Narrow one stored `mcpLoading` value. The settings document is a durable,
* user-editable file, so an unknown value falls back to `dynamic` instead of
* failing the commit that carried it.
* @param value - raw value read from the settings namespace or the plugin config.
* @returns the matching mode, or `dynamic` when nothing matches.
*/
function parseMcpLoadingMode(value) {
	return MCP_LOADING_MODES.includes(value) ? value : "dynamic";
}
/** The last `:`-separated segment of a loader-qualified row id. */
function leafId(id) {
	const separator = id.lastIndexOf(":");
	return separator < 0 ? id : id.slice(separator + 1);
}
/** Resolve the mcp-client plugin from the Loader's module graph (same instance the composition mounts). */
async function resolveMcpClient(ctx) {
	const loader = ctx.get("loader");
	const base = ctx.baseUrl;
	if (loader?.internal !== void 0 && base !== void 0) try {
		const mod = await loader.internal.import(MCP_CLIENT_MODULE, base, {});
		if (typeof mod.apply === "function") return mod;
	} catch {}
	return await import("@deepseek-ai/dsh-mcp-client");
}
/** Every configured mcp-client row: Loader entries (global) plus each agent preset's composition rows. */
async function listRows(ctx) {
	const rows = [];
	const loader = ctx.get("loader");
	for (const entry of loader?.entries() ?? []) {
		if (entry.options.group === true || entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
		const serverName = leafId(entry.id);
		rows.push({
			target: { scope: "global" },
			entryId: entry.id,
			serverName,
			key: mcpRowKey({ scope: "global" }, serverName),
			scopeLabel: "global",
			enabled: entry.disabled !== true
		});
	}
	const presets = ctx.get("agentPresets");
	if (presets !== void 0) for (const preset of await presets.compositionInventory()) for (const row of preset.rows) {
		if (row.moduleName !== "@deepseek-ai/dsh-mcp-client") continue;
		const entryId = row.entryId ?? "";
		const serverName = leafId(entryId);
		const target = {
			scope: "preset",
			agentPreset: preset.id
		};
		rows.push({
			target,
			entryId,
			serverName,
			key: mcpRowKey(target, serverName),
			scopeLabel: `preset ${preset.id}`,
			enabled: row.enabled === true
		});
	}
	return rows;
}
/** Read one row's connection spec through the authoring owner. */
async function describeRow(ctx, row) {
	const owner = ctx.get("mcpManager");
	if (owner === void 0) throw new Error("mcp_load requires the mcpManager service");
	return (await owner.describeMcp({
		target: row.target,
		entryId: row.entryId
	})).spec;
}
/** The tool names one server published into an agent's scope (dynamic mode). */
function toolNamesFor(tools, agentCtx, serverName) {
	const prefix = `mcp__${serverName}__`;
	return tools.schemas(scopeOf(agentCtx)).map((schema) => schema.name).filter((name) => name.startsWith(prefix));
}
/**
* Connect one configured server through the MCP SDK without registering anything.
* @param config - the row's resolved transport and namespace.
* @returns the connected client and the tools the server published. The caller
*   owns the client and must close it.
*/
async function connectLazy(config) {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	let transport;
	if (config.transport === "stdio") {
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		transport = new StdioClientTransport({
			command: config.command,
			args: [...config.args],
			env: {
				...process.env,
				...config.env
			},
			...config.cwd === "" ? {} : { cwd: config.cwd },
			stderr: "ignore"
		});
	} else {
		const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
		transport = new StreamableHTTPClientTransport(new URL(config.url), Object.keys(config.headers).length === 0 ? {} : { requestInit: { headers: config.headers } });
	}
	const client = new Client({
		name: "@guowenzhang/dsh-mcp-manager",
		version: "0.1"
	});
	await client.connect(transport);
	return {
		client,
		tools: (await client.listTools()).tools ?? []
	};
}
/** Wrap one release step so the session context and `mcp_unload` cannot run it twice. */
function once(release) {
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		await release();
	};
}
/**
* Re-list one native mount and swap its registration generation.
*
* The mount's own load-time rules decide the new visible set, so a
* `tools/list_changed` never applies a rule the session did not load with. A
* failed re-list leaves the session with the tools it already had.
* @param mount - the session's native mount for one server.
* @param row - the composition row the mount came from.
* @param deps - the session-scoped registry and the harness adapter.
*/
async function resyncNativeTools(mount, row, deps) {
	const selection = filterMcpTools((await mount.client.listTools()).tools ?? [], mount.filter);
	const definitions = nativeDefinitions(deps.ctx, deps.adapter, row.serverName, selection.visible, mount.client);
	mount.registrations = swapNativeTools(deps.registry, mount.registrations, definitions);
	mount.tools = selection.visible;
	mount.hidden = selection.hidden;
}
/**
* Follow `notifications/tools/list_changed` for one native mount.
*
* The SDK installs no dedicated handler for that notification, so it arrives at
* the client's fallback listener. Re-syncs are serialized per mount, because a
* server may announce another change while the previous swap is still running.
* @param mount - the session's native mount.
* @param row - the composition row the mount came from.
* @param deps - the session-scoped registry and the harness adapter.
*/
function watchToolListChanges(mount, row, deps) {
	mount.client.fallbackNotificationHandler = async (notification) => {
		if (notification.method !== "notifications/tools/list_changed") return;
		const next = (mount.resyncing ?? Promise.resolve()).then(() => resyncNativeTools(mount, row, deps)).catch((error) => {
			deps.ctx.logger.warn(`mcp-manager: could not follow the tool list change of "${row.serverName}": ${String(error)}`);
		});
		mount.resyncing = next;
		await next;
	};
}
/**
* Register the on-demand MCP tools and the inventory section that names them.
* @param ctx - scope the tools belong to (a preset row's context).
* @param mode - how a loaded server reaches the model.
* @param gate - the preload gate; it decides which composed rows this session
*   is allowed to load, and holds the rest out of every request.
* @param readers - live per-row rule and description readers.
* @returns the registration handle. `eager` registers no tool at all, and its
*   handle is an inert pair of no-ops.
*/
function registerMcpTools(ctx, mode, gate, readers = {
	filterFor: () => NO_TOOL_FILTER,
	descriptionFor: () => void 0
}) {
	const tools = ctx.get("tools");
	if (tools === void 0 || mode === "eager") return {
		dispose: () => {},
		refresh: async () => {}
	};
	/** The mode whose tools exist; narrowed once so closures need no re-check. */
	const onDemandMode = mode;
	/**
	* The rows this session may load: composed rows the user has not disabled.
	* The gate is re-read first because a preset composition is also rebuilt when
	* its file changes, and a row that just came back would otherwise be treated
	* as still absent.
	*/
	const allowedRows = async () => {
		await gate.reconcile();
		return (await listRows(ctx)).filter((row) => gate.stateFor(row.target, row.entryId)?.allowed ?? row.enabled);
	};
	/** Loaded servers keyed by agent id, then serverName. */
	const mounted = /* @__PURE__ */ new Map();
	/** Sessions whose mounts are already bound to their own context disposal. */
	const scopedAgents = /* @__PURE__ */ new Set();
	/** Live tool registrations, undone by the returned disposer. */
	const registrations = [];
	const register = (definition) => {
		registrations.push(tools.register(definition));
	};
	/**
	* The model's only source for loadable server names: no server's tools are in
	* the request until a session loads one, so the names have to be published.
	* The text is a snapshot, refreshed through {@link McpToolRegistration.refresh}.
	*/
	let inventory = "";
	const systemPrompt = ctx.get("systemPrompt");
	const inventorySection = systemPrompt?.section({
		name: "mcp-manager:on-demand",
		order: systemPrompt.getSectionOrder("MCP_SERVERS"),
		interpolate: false,
		text: () => inventory
	});
	const refresh = async () => {
		inventory = renderMcpInventory((await allowedRows()).map((row) => {
			const description = readers.descriptionFor(row.key);
			return {
				name: row.serverName,
				...description === void 0 ? {} : { description }
			};
		}), onDemandMode);
	};
	const loadedFor = (agentId) => {
		const existing = mounted.get(agentId);
		if (existing !== void 0) return existing;
		const created = /* @__PURE__ */ new Map();
		mounted.set(agentId, created);
		return created;
	};
	/**
	* Close everything one ended session started.
	*
	* The `mount` carrier puts the mcp-client on the agent's own context, so
	* Cordis disposes its connection with that context and nothing is left here.
	* The `proxy` and `native` carriers own a bare SDK client instead — and the
	* native one also owns tool registrations made through that context — so
	* without this they would outlive the session that loaded them: every session
	* that ends without an `mcp_unload` would leave its server running until the
	* plugin unloads.
	* @param agentId - the session that ended.
	*/
	const releaseAgent = (agentId) => {
		scopedAgents.delete(agentId);
		const perAgent = mounted.get(agentId);
		if (perAgent === void 0) return;
		mounted.delete(agentId);
		for (const server of perAgent.values()) if (server.carrier !== "mount") server.dispose();
	};
	/**
	* Bind one session's mounts to its context, so they close when the session
	* ends. Registered once per session: the first load also covers every later
	* load in that session.
	* @param agent - the session that is loading a server.
	*/
	const bindAgentScope = (agent) => {
		if (scopedAgents.has(agent.id)) return;
		scopedAgents.add(agent.id);
		agent.ctx.effect(() => () => {
			releaseAgent(agent.id);
		}, `mcp-manager: mcp mounts of ${agent.id}`);
	};
	const stopAll = async () => {
		const pending = [];
		for (const perAgent of mounted.values()) for (const server of perAgent.values()) pending.push(server.dispose());
		mounted.clear();
		scopedAgents.clear();
		await Promise.allSettled(pending);
	};
	register(defineTool({
		name: "mcp_load",
		description: onDemandMode === "lazy" ? "Start one of the MCP servers listed in your system prompt for THIS session and return its tools. Call the tools you need afterwards with `mcp_call`, passing the server name and tool name from this result. Only the tools this result lists are callable." : "Start one of the MCP servers listed in your system prompt for THIS session and add its tools to the request. Only the tools this result lists are callable.",
		parameters: { server: {
			type: "string",
			required: true,
			description: "The MCP server name to start, as listed in your system prompt."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					server: {
						type: "string",
						required: true
					},
					hidden: {
						type: "number",
						required: true,
						description: "Discovered tools this session's filter keeps out of the result; they cannot be called."
					},
					tools: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: {
									type: "string",
									required: true
								},
								description: {
									type: "string",
									required: true
								},
								schema: {
									type: "string",
									required: true,
									description: "JSON schema of the tool arguments, empty when the server declared none."
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: (value.tools.length === 0 ? `Started MCP server "${value.server}"; it exposed no tools.` : `Started MCP server "${value.server}".\n` + value.tools.map((tool) => `- ${tool.name}: ${tool.description}${tool.schema === "" ? "" : `\n  args: ${tool.schema}`}`).join("\n")) + (value.hidden === 0 ? "" : `\n(${value.hidden} further tool(s) on this server are hidden by this row's filter and cannot be called.)`)
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_load requires an owning agent session");
			const serverName = String(args.server);
			const existing = loadedFor(agent.id).get(serverName);
			if (existing !== void 0) return {
				server: serverName,
				tools: existing.carrier === "mount" ? toolNamesFor(tools, agent.ctx, serverName).map((name) => ({
					name,
					description: "",
					schema: ""
				})) : describeTools(existing, serverName),
				hidden: existing.carrier === "mount" ? 0 : existing.hidden
			};
			const row = (await allowedRows()).find((candidate) => candidate.serverName === serverName);
			if (row === void 0) throw new Error(`unknown or disabled MCP server "${serverName}" — load one of the MCP servers listed in your system prompt`);
			const config = mcpEntryConfig(await describeRow(ctx, row), serverName);
			const filter = readers.filterFor(row.key);
			const carrier = carrierFor(onDemandMode, filter);
			if (carrier === void 0) throw new Error("mcp_load is not registered under the \"eager\" loading mode");
			if (carrier === "proxy") {
				const { client, tools: listed } = await connectLazy(config);
				const selection = filterMcpTools(listed, filter);
				loadedFor(agent.id).set(serverName, {
					carrier: "proxy",
					client,
					tools: selection.visible,
					hidden: selection.hidden,
					dispose: once(async () => {
						await client.close();
					})
				});
				bindAgentScope(agent);
				return {
					server: serverName,
					tools: selection.visible.map(lazyTool),
					hidden: selection.hidden
				};
			}
			if (carrier === "native") {
				const adapter = (await resolveMcpClient(ctx)).createMcpToolDefinition;
				if (adapter === void 0) throw new Error(`this harness build does not export createMcpToolDefinition from @deepseek-ai/dsh-mcp-client, so the tools of "${serverName}" cannot be registered individually; select the "lazy" loading mode, or a harness build that provides the adapter`);
				const registry = agent.ctx.get("tools");
				if (registry === void 0) throw new Error("mcp_load requires the tools service");
				const { client, tools: listed } = await connectLazy(config);
				const selection = filterMcpTools(listed, filter);
				let registrations;
				try {
					registrations = swapNativeTools(registry, /* @__PURE__ */ new Map(), nativeDefinitions(agent.ctx, adapter, serverName, selection.visible, client));
				} catch (error) {
					await client.close();
					throw error;
				}
				const mount = {
					carrier: "native",
					client,
					filter,
					tools: selection.visible,
					hidden: selection.hidden,
					registrations,
					dispose: once(async () => {
						for (const dispose of [...mount.registrations.values()].reverse()) dispose();
						await client.close();
					})
				};
				loadedFor(agent.id).set(serverName, mount);
				watchToolListChanges(mount, row, {
					registry,
					ctx: agent.ctx,
					adapter
				});
				bindAgentScope(agent);
				return {
					server: serverName,
					tools: selection.visible.map((tool) => exposedTool("native", serverName, tool)),
					hidden: selection.hidden
				};
			}
			const mod = await resolveMcpClient(ctx);
			const plugin = {
				name: mod.name,
				inject: mod.inject,
				apply: mod.apply
			};
			const handle = await agent.ctx.plugin(plugin, config);
			loadedFor(agent.id).set(serverName, {
				carrier: "mount",
				dispose: once(async () => {
					await handle.dispose();
				})
			});
			bindAgentScope(agent);
			return {
				server: serverName,
				tools: toolNamesFor(tools, agent.ctx, serverName).map((name) => ({
					name,
					description: "",
					schema: ""
				})),
				hidden: 0
			};
		}
	}));
	if (onDemandMode === "lazy") register(defineTool({
		name: "mcp_call",
		description: "Call one tool of an MCP server that `mcp_load` started for THIS session. Use the server and tool names from the mcp_load result; pass the tool arguments exactly as that result described them.",
		parameters: {
			server: {
				type: "string",
				required: true,
				description: "The MCP serverName, as reported by mcp_load."
			},
			tool: {
				type: "string",
				required: true,
				description: "The tool name reported by mcp_load."
			},
			arguments: {
				type: "json",
				required: true,
				description: "Arguments object for that tool, matching its reported schema."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					server: {
						type: "string",
						required: true
					},
					tool: {
						type: "string",
						required: true
					},
					text: {
						type: "string",
						required: true,
						description: "The tool result rendered as text."
					},
					isError: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_call requires an owning agent session");
			const request = args;
			const mount = loadedFor(agent.id).get(request.server);
			if (mount === void 0) throw new Error(`MCP server "${request.server}" is not loaded for this session — call mcp_load first`);
			if (mount.carrier !== "proxy") throw new Error(`MCP server "${request.server}" was loaded with its tools registered natively — call them by name instead`);
			if (!mount.tools.some((candidate) => candidate.name === request.tool)) throw new Error(`MCP server "${request.server}" exposes no tool "${request.tool}" in this session — call mcp_load to list the tools this session may call`);
			const result = await mount.client.callTool({
				name: request.tool,
				arguments: asRecord(request.arguments)
			});
			return {
				server: request.server,
				tool: request.tool,
				text: renderCallResult(result),
				isError: result?.isError === true
			};
		}
	}));
	register(defineTool({
		name: "mcp_unload",
		description: "Stop an MCP server that `mcp_load` started for THIS session and release it again. Use it when you are done with a server, to keep the prompt small.",
		parameters: { server: {
			type: "string",
			required: true,
			description: "The MCP serverName to stop."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					server: {
						type: "string",
						required: true
					},
					stopped: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.stopped ? `Stopped MCP server "${value.server}".` : `MCP server "${value.server}" was not loaded for this session.`
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_unload requires an owning agent session");
			const serverName = String(args.server);
			const mount = loadedFor(agent.id).get(serverName);
			if (mount === void 0) return {
				server: serverName,
				stopped: false
			};
			loadedFor(agent.id).delete(serverName);
			await mount.dispose();
			return {
				server: serverName,
				stopped: true
			};
		}
	}));
	return {
		dispose: () => {
			for (const dispose of [...registrations].reverse()) dispose();
			registrations.length = 0;
			inventorySection?.();
			inventory = "";
			stopAll();
		},
		refresh
	};
}
/** One MCP tool projected onto the model-facing shape. */
function lazyTool(tool) {
	return {
		name: tool.name,
		description: tool.description ?? "",
		schema: tool.inputSchema === void 0 ? "" : JSON.stringify(tool.inputSchema)
	};
}
/** One visible tool as `mcp_load` reports it: named the way this session must call it. */
function exposedTool(carrier, serverName, tool) {
	return {
		...lazyTool(tool),
		name: visibleToolName(carrier, serverName, tool.name)
	};
}
/** The already-loaded server's exposed tool list, re-reported without reconnecting. */
function describeTools(mount, serverName) {
	return mount.tools.map((tool) => exposedTool(mount.carrier, serverName, tool));
}
/** Coerce model-supplied arguments to the object the SDK expects. */
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Render one MCP call result as text for the model. */
function renderCallResult(result) {
	const content = result?.content;
	if (Array.isArray(content)) {
		const text = content.map((block) => block.type === "text" ? block.text ?? "" : JSON.stringify(block)).filter((part) => part !== "").join("\n");
		if (text !== "") return text;
	}
	return JSON.stringify(result);
}
//#endregion
//#region src/mcp-roster.ts
/**
* Runtime mirror of Cordis's cross-package `FiberState` enum; the values are the
* Loader's own.
*/
const FIBER_STATE = {
	PENDING: 0,
	LOADING: 1,
	ACTIVE: 2,
	FAILED: 3,
	DISPOSED: 4,
	UNLOADING: 5
};
/** Translate one fiber state into the roster's phase vocabulary. */
function phaseOf(state) {
	switch (state) {
		case FIBER_STATE.PENDING: return "pending";
		case FIBER_STATE.LOADING: return "loading";
		case FIBER_STATE.ACTIVE: return "active";
		case FIBER_STATE.FAILED: return "failed";
		case FIBER_STATE.UNLOADING: return "unloading";
		default: return null;
	}
}
/** Project one source row onto the row the settings section renders. */
function rosterRow(source) {
	return {
		entryId: source.entryId,
		moduleName: source.options.name,
		enabled: source.enabled,
		fiberPhase: source.live ? phaseOf(source.state) : null
	};
}
/** Whether a row names the MCP client bridge and is not a structural group. */
function isMcpRow(options) {
	return options.group !== true && options.name === "@deepseek-ai/dsh-mcp-client";
}
/**
* Enablement of one declared row, following the Loader's own reading: any
* literal `true` disables, anything else enables, and a `!!js` expression stays
* `conditional` because only a mount can evaluate it.
* @param contributions - the row's own `disabled` node and its groups', outermost first.
* @returns true (enabled), false (disabled), or `conditional`.
*/
function declaredEnablement(...contributions) {
	let conditional = false;
	for (const value of contributions) if (isJsExpr(value)) conditional = true;
	else if (Boolean(value)) return false;
	return conditional ? "conditional" : true;
}
/**
* Collect the MCP rows of one declared composition, descending into groups the
* way the Loader does: a group's `disabled` is inherited by its children.
* @param rows - declared child rows at the current level.
* @param inherited - `disabled` nodes contributed by owning groups.
* @param found - accumulator receiving one source per MCP row.
*/
function declaredMcpRows(rows, inherited, found) {
	for (const row of rows) {
		if (row.group === true) {
			declaredMcpRows(Array.isArray(row.config) ? row.config : [], [...inherited, row.disabled], found);
			continue;
		}
		if (!isMcpRow(row)) continue;
		found.push({
			entryId: typeof row.id === "string" && row.id !== "" ? row.id : null,
			options: row,
			live: false,
			enabled: declaredEnablement(...inherited, row.disabled),
			state: void 0
		});
	}
}
/**
* Read every MCP row the running composition declares, plus the planes a
* mutation can target.
*
* Nothing here awaits, so a row that is connecting reports its `loading` phase
* instead of holding the read open.
* @param ctx - host context carrying the Loader and the profile editor.
* @param mountReader - reader of the live agent-preset mounts, resolved through
*   the Loader so it observes the same registry instance as the composition.
* @returns the global rows, every declared preset with its rows, and whether the
*   global plane accepts writes.
*/
function readMcpRoster(ctx, mountReader) {
	const loader = ctx.get("loader");
	const entries = [];
	/** Mounted root Includes, which is where a global write lands. */
	let includes = 0;
	if (loader !== void 0) for (const entry of loader.entries()) {
		if (entry.options.name === "cordis:include" && entry.subtree !== void 0) includes += 1;
		if (!isMcpRow(entry.options)) continue;
		entries.push(rosterRow({
			entryId: entry.id,
			options: entry.options,
			live: true,
			enabled: !entry.disabled,
			state: entry.fiber?.state
		}));
	}
	const mounts = mountReader(ctx.root.fiber);
	return {
		entries,
		presets: listPresetDeclarations(ctx).map((declaration) => {
			const mount = mounts.find((candidate) => candidate.presetId === declaration.id);
			const sources = [];
			if (mount === void 0) declaredMcpRows(declaration.rows, [], sources);
			else for (const row of mount.tree.entries()) {
				if (!isMcpRow(row.options)) continue;
				sources.push({
					entryId: presetLeafId(row.options.id),
					options: row.options,
					live: true,
					enabled: !row.disabled,
					state: row.fiber?.state
				});
			}
			return {
				id: declaration.id,
				...declaration.name === void 0 ? {} : { name: declaration.name },
				rows: sources.map(rosterRow)
			};
		}),
		globalWritable: includes === 1
	};
}
//#endregion
//#region src/mcp-remote.ts
/** Typert Remote owner for global and agent-preset MCP row authoring. */
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) {
			if (kind === "field") initializers.unshift(_);
			else descriptor[key] = _;
		}
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** How long one editor tool listing may take before the dialog reports failure. */
const TOOL_LIST_TIMEOUT_MS = 3e4;
/**
* Resolve `work`, or reject once it outlives `ms`.
* @param work - the operation to bound.
* @param ms - budget in milliseconds.
* @returns the operation's value when it settles inside the budget.
* @throws when the budget expires before the operation settles.
*/
async function withTimeout(work, ms) {
	let timer;
	try {
		return await Promise.race([work, new Promise((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(/* @__PURE__ */ new Error(`no answer within ${ms} ms`));
			}, ms);
		})]);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
/**
* Host service behind the `mcpManager` Remote namespace. Preset mutations
* update the resolved user's composition file; global mutations use the one
* unpatched root Include so Loader lifecycle and file state remain aligned.
*/
let McpManager = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listMcps_decorators;
	let _addMcp_decorators;
	let _addMcps_decorators;
	let _editMcp_decorators;
	let _disableMcp_decorators;
	let _gateState_decorators;
	let _describeMcp_decorators;
	let _listMcpTools_decorators;
	let _scanClaudeMcp_decorators;
	return class McpManager extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listMcps_decorators = [Remote("listMcps")];
			_addMcp_decorators = [Remote("addMcp")];
			_addMcps_decorators = [Remote("addMcps")];
			_editMcp_decorators = [Remote("editMcp")];
			_disableMcp_decorators = [Remote("disableMcp")];
			_gateState_decorators = [Remote("gateState")];
			_describeMcp_decorators = [Remote("describeMcp")];
			_listMcpTools_decorators = [Remote("listMcpTools")];
			_scanClaudeMcp_decorators = [Remote("scanClaudeMcp")];
			__esDecorate(this, null, _listMcps_decorators, {
				kind: "method",
				name: "listMcps",
				static: false,
				private: false,
				access: {
					has: (obj) => "listMcps" in obj,
					get: (obj) => obj.listMcps
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _addMcp_decorators, {
				kind: "method",
				name: "addMcp",
				static: false,
				private: false,
				access: {
					has: (obj) => "addMcp" in obj,
					get: (obj) => obj.addMcp
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _addMcps_decorators, {
				kind: "method",
				name: "addMcps",
				static: false,
				private: false,
				access: {
					has: (obj) => "addMcps" in obj,
					get: (obj) => obj.addMcps
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _editMcp_decorators, {
				kind: "method",
				name: "editMcp",
				static: false,
				private: false,
				access: {
					has: (obj) => "editMcp" in obj,
					get: (obj) => obj.editMcp
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _disableMcp_decorators, {
				kind: "method",
				name: "disableMcp",
				static: false,
				private: false,
				access: {
					has: (obj) => "disableMcp" in obj,
					get: (obj) => obj.disableMcp
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _gateState_decorators, {
				kind: "method",
				name: "gateState",
				static: false,
				private: false,
				access: {
					has: (obj) => "gateState" in obj,
					get: (obj) => obj.gateState
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _describeMcp_decorators, {
				kind: "method",
				name: "describeMcp",
				static: false,
				private: false,
				access: {
					has: (obj) => "describeMcp" in obj,
					get: (obj) => obj.describeMcp
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listMcpTools_decorators, {
				kind: "method",
				name: "listMcpTools",
				static: false,
				private: false,
				access: {
					has: (obj) => "listMcpTools" in obj,
					get: (obj) => obj.listMcpTools
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _scanClaudeMcp_decorators, {
				kind: "method",
				name: "scanClaudeMcp",
				static: false,
				private: false,
				access: {
					has: (obj) => "scanClaudeMcp" in obj,
					get: (obj) => obj.scanClaudeMcp
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		gate = __runInitializers(this, _instanceExtraInitializers);
		mountReader;
		static inject = ["loader"];
		mutationQueue = Promise.resolve();
		/**
		* @param ctx - host context.
		* @param gate - the preload gate the mutations must leave in line with the
		*   current loading mode.
		* @param mountReader - reader of the live agent-preset mounts, used by the
		*   roster read to report each preset row's current fiber phase.
		*/
		constructor(ctx, gate, mountReader) {
			super(ctx, "mcpManager");
			this.gate = gate;
			this.mountReader = mountReader;
		}
		/**
		* Report every MCP row the running composition declares, with the planes a
		* mutation can target.
		*
		* The read answers from declarations and live fibers only, so the settings
		* page renders immediately while an MCP server is still starting; nothing here
		* waits for a row's activation.
		* @param request - empty placeholder; the roster is host-wide.
		* @returns the global rows, every declared preset with its rows, and whether
		*   the global plane accepts writes.
		*/
		async listMcps(request) {
			return readMcpRoster(this.ctx, this.mountReader);
		}
		/**
		* Add one MCP client row to a global or user preset composition.
		* @param request - target, row identity, server namespace, and transport spec.
		* @returns the redacted row identity after the file-backed mutation commits.
		* @throws a typed MCP error when the target is unavailable, read-only,
		* malformed, duplicated, or not an MCP composition row.
		*/
		async addMcp(request) {
			const result = await this.enqueue(() => this.add(request));
			await this.gate.reconcile();
			return result;
		}
		/**
		* Add several MCP client rows to one composition in a single write.
		*
		* Every appended row is validated on its own, so one rejected row does not
		* cost the rest of the batch, but the accepted rows commit together: an agent
		* preset re-mounts once per write and starting its MCP servers again is what
		* makes a row-per-call import slow.
		* @param request - target composition and the rows to append.
		* @returns one outcome per requested row, in request order.
		*/
		async addMcps(request) {
			const result = await this.enqueue(() => this.addMany(request));
			await this.gate.reconcile();
			return result;
		}
		/**
		* Replace one MCP client row's connection configuration.
		* @param request - target row, new server namespace, and transport spec.
		* @returns the redacted row identity after the mutation commits.
		* @throws a typed MCP error when the target is unavailable, read-only,
		* malformed, duplicated, or not an MCP composition row.
		*/
		async editMcp(request) {
			const result = await this.enqueue(() => this.edit(request));
			await this.gate.reconcile();
			return result;
		}
		/**
		* Enable or disable one MCP client row.
		* @param request - target row and the requested disabled state.
		* @returns the redacted row identity after the mutation commits.
		* @throws a typed MCP error when the target is unavailable, read-only,
		* malformed, or not an MCP composition row.
		*/
		async disableMcp(request) {
			const result = await this.enqueue(() => this.disable(request));
			await this.gate.reconcile();
			return result;
		}
		/**
		* Report which allowed rows the preload gate currently holds unmounted.
		* @param request - empty placeholder; the gate state is host-wide. The
		*   parameter must keep this name: the gateway derives its descriptor from the
		*   method signature and rejects a payload whose field does not match.
		* @returns the suppressed row keys in the settings page's own key format.
		*/
		async gateState(request) {
			await this.gate.reconcile();
			return { suppressed: [...this.gate.suppressedKeys()] };
		}
		/**
		* Read one MCP client row's current connection spec.
		* @param request - target row identity.
		* @returns the row's identity and connection spec for the editor to prefill.
		* @throws a typed MCP error when the target is unavailable, read-only,
		* malformed, or not an MCP composition row.
		*/
		async describeMcp(request) {
			const target = validateTarget(request.target);
			validateEntryId(request.entryId, target, false);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const entry = this.globalMcpEntry(request.entryId, target, include.tree);
				const serverName = serverNameOf(entry.options);
				if (serverName === void 0) throw invalid(target, "the MCP row has no valid serverName");
				return {
					target,
					entryId: entry.id,
					serverName,
					spec: specFromEntryConfig(entry.options.config),
					disabled: entry.disabled ?? false
				};
			}
			const preset = await this.resolvePreset(target);
			const entryId = presetLeafId(request.entryId);
			const rows = preset.rows;
			const row = this.presetMcpRow(rows, entryId, target);
			const serverName = serverNameOf(row) ?? entryId;
			if (row.config === void 0 || typeof row.config !== "object" || row.config === null) throw invalid(target, `preset row "${entryId}" has no connection config`);
			return {
				target,
				entryId,
				serverName,
				spec: specFromEntryConfig(row.config),
				disabled: row.disabled === true
			};
		}
		/**
		* Connect once with a connection spec and report the tools it publishes, so
		* the editor can offer an enable/disable list. The connection is closed before
		* this resolves; nothing is registered and no row is touched.
		* @param request - transport spec (the editor's current form value) and the
		*   namespace used in diagnostics.
		* @returns the server's own tool names and descriptions, in its own order.
		* @throws a typed MCP error when the spec is malformed or the server does not
		*   answer a listing inside the budget.
		*/
		async listMcpTools(request) {
			let config;
			try {
				config = mcpEntryConfig(request.spec, assertServerName(request.serverName));
			} catch (cause) {
				const reason = String(cause);
				throw new RemoteError("mcp/invalid", reason, { reason }, { cause });
			}
			let connection;
			try {
				connection = await withTimeout(connectLazy(config), TOOL_LIST_TIMEOUT_MS);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				throw new RemoteError("mcp/unavailable", `MCP server "${request.serverName}" did not answer a tool listing`, { reason }, { cause });
			}
			try {
				return { tools: connection.tools.map((tool) => ({
					name: tool.name,
					description: tool.description ?? ""
				})) };
			} finally {
				await connection.client.close().catch(() => {});
			}
		}
		/**
		* Report the MCP servers the Claude Code configuration files declare, so the
		* settings page can offer them for import. Reads only: nothing is mounted and
		* no composition is touched, so a scan is safe to run on every dialog open.
		* @param request - working directory whose project scope should be read.
		* @returns every readable source and the servers it declares, including the
		*   ones that cannot be imported and why.
		*/
		async scanClaudeMcp(request) {
			return await scanClaudeMcp(request.cwd ?? process.cwd());
		}
		enqueue(operation) {
			const run = this.mutationQueue.then(operation, operation);
			this.mutationQueue = run.then(() => void 0, () => void 0);
			return run;
		}
		async add(request) {
			const target = validateTarget(request.target);
			const config = configFromSpec(request.spec, request.serverName, target);
			const entryId = request.entryId ?? request.serverName;
			validateEntryId(entryId, target, true);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const rows = [...include.tree.entries()];
				if (rows.some((entry) => entry.options.id === entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
				if (rows.some((entry) => entry.options.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(entry.options) === request.serverName)) throw conflict(target, entryId, request.serverName, "the serverName is already in use");
				const created = await this.writeGlobalOne(include, target, { insert: [{
					id: entryId,
					name: MCP_CLIENT_MODULE,
					config
				}] }, (fileRows) => {
					if (entryIds(fileRows).has(entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
					if (fileRows.some((row) => row.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(row) === request.serverName)) throw conflict(target, entryId, request.serverName, "the serverName is already in use");
				}, entryId);
				return {
					target,
					entryId: created.id,
					serverName: request.serverName,
					disabled: created.disabled
				};
			}
			const preset = await this.resolvePreset(target);
			const patch = { insert: [{
				id: entryId,
				name: MCP_CLIENT_MODULE,
				config
			}] };
			await writePresetRows(this.ctx, preset, patch, (rows) => {
				if (entryIds(rows).has(entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
				if (rows.some((row) => row.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(row) === request.serverName)) throw conflict(target, entryId, request.serverName, "the serverName is already in use");
			}, this.warnPatch);
			return {
				target,
				entryId,
				serverName: request.serverName,
				disabled: false
			};
		}
		/**
		* Plan and commit a batch add. Each row is validated on its own so one bad row
		* does not cost the rest; the accepted rows then commit in one write, which
		* matters most for a preset: it re-mounts once per write, and every MCP server
		* it declares starts again on each mount.
		* @param request - target composition and the requested rows.
		* @returns one outcome per requested row, in request order.
		*/
		async addMany(request) {
			const target = validateTarget(request.target);
			const reasons = /* @__PURE__ */ new Map();
			const planned = [];
			const takenIds = /* @__PURE__ */ new Set();
			const takenNames = /* @__PURE__ */ new Set();
			request.rows.forEach((row, index) => {
				try {
					const entryId = row.entryId ?? row.serverName;
					validateEntryId(entryId, target, true);
					const config = configFromSpec(row.spec, row.serverName, target);
					if (takenIds.has(entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
					if (takenNames.has(row.serverName)) throw conflict(target, entryId, row.serverName, "the serverName is already in use");
					takenIds.add(entryId);
					takenNames.add(row.serverName);
					planned.push({
						index,
						serverName: row.serverName,
						entryId,
						config
					});
				} catch (cause) {
					reasons.set(index, cause instanceof Error ? cause.message : String(cause));
				}
			});
			if (planned.length > 0) {
				const refused = target.scope === "global" ? await this.writeGlobalBatch(target, planned) : await this.writePresetBatch(target, planned);
				for (const [index, reason] of refused) reasons.set(index, reason);
			}
			const entryOf = new Map(planned.map((row) => [row.index, row.entryId]));
			return {
				target,
				outcomes: request.rows.map((row, index) => {
					const reason = reasons.get(index);
					return reason === void 0 ? {
						serverName: row.serverName,
						entryId: entryOf.get(index) ?? null
					} : {
						serverName: row.serverName,
						entryId: null,
						reason
					};
				})
			};
		}
		/**
		* Commit a global batch: one file patch, one Include reload, then a liveness
		* check per accepted row.
		* @param target - the global plane.
		* @param planned - validated rows, in request order.
		* @returns per-row refusal reasons keyed by request position.
		*/
		async writeGlobalBatch(target, planned) {
			const refused = /* @__PURE__ */ new Map();
			const include = await this.globalInclude(target);
			const live = [...include.tree.entries()];
			for (const row of planned) if (live.some((entry) => entry.options.id === row.entryId)) refused.set(row.index, conflict(target, row.entryId, void 0, "the row id is already in use").message);
			else if (live.some((entry) => entry.options.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(entry.options) === row.serverName)) refused.set(row.index, conflict(target, row.entryId, row.serverName, "the serverName is already in use").message);
			const accepted = planned.filter((row) => !refused.has(row.index));
			if (accepted.length === 0) return refused;
			try {
				await this.writeGlobalRow(include, target, { insert: accepted.map((row) => ({
					id: row.entryId,
					name: MCP_CLIENT_MODULE,
					config: row.config
				})) }, (fileRows) => {
					const ids = entryIds(fileRows);
					for (const row of accepted) {
						if (ids.has(row.entryId)) throw conflict(target, row.entryId, void 0, "the row id is already in use");
						if (fileRows.some((file) => file.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(file) === row.serverName)) throw conflict(target, row.entryId, row.serverName, "the serverName is already in use");
					}
				}, accepted.map((row) => row.entryId));
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				for (const row of accepted) refused.set(row.index, reason);
			}
			return refused;
		}
		/**
		* Commit a preset batch as one patch, so the preset reconciles once.
		* @param target - the addressed preset.
		* @param planned - validated rows, in request order.
		* @returns per-row refusal reasons keyed by request position.
		*/
		async writePresetBatch(target, planned) {
			const refused = /* @__PURE__ */ new Map();
			const preset = await this.resolvePreset(target);
			const declared = entryIds(preset.rows);
			for (const row of planned) if (declared.has(row.entryId)) refused.set(row.index, conflict(target, row.entryId, void 0, "the row id is already in use").message);
			else if (preset.rows.some((entry) => entry.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(entry) === row.serverName)) refused.set(row.index, conflict(target, row.entryId, row.serverName, "the serverName is already in use").message);
			const accepted = planned.filter((row) => !refused.has(row.index));
			if (accepted.length === 0) return refused;
			try {
				await writePresetRows(this.ctx, preset, { insert: accepted.map((row) => ({
					id: row.entryId,
					name: MCP_CLIENT_MODULE,
					config: row.config
				})) }, (rows) => {
					const ids = entryIds(rows);
					for (const row of accepted) {
						if (ids.has(row.entryId)) throw conflict(target, row.entryId, void 0, "the row id is already in use");
						if (rows.some((entry) => entry.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(entry) === row.serverName)) throw conflict(target, row.entryId, row.serverName, "the serverName is already in use");
					}
				}, this.warnPatch);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				for (const row of accepted) refused.set(row.index, reason);
			}
			return refused;
		}
		async edit(request) {
			const target = validateTarget(request.target);
			const config = configFromSpec(request.spec, request.serverName, target);
			validateEntryId(request.entryId, target, false);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const entry = this.globalMcpEntry(request.entryId, target, include.tree);
				this.assertServerNameAvailable([...include.tree.entries()], request.entryId, request.serverName, target);
				const rowId = entry.options.id;
				const written = await this.writeGlobalOne(include, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					config
				}, (fileRows) => {
					this.presetMcpRow(fileRows, rowId, target);
					this.assertServerNameAvailable(fileRows, rowId, request.serverName, target);
				}, rowId);
				return {
					target,
					entryId: written.id,
					serverName: request.serverName,
					disabled: written.disabled
				};
			}
			const preset = await this.resolvePreset(target);
			const entryId = presetLeafId(request.entryId);
			let disabled = false;
			const patch = {
				id: entryId,
				name: MCP_CLIENT_MODULE,
				config
			};
			await writePresetRows(this.ctx, preset, patch, (rows) => {
				disabled = this.presetMcpRow(rows, entryId, target).disabled === true;
				this.assertServerNameAvailable(rows, entryId, request.serverName, target);
			}, this.warnPatch);
			return {
				target,
				entryId,
				serverName: request.serverName,
				disabled
			};
		}
		async disable(request) {
			const target = validateTarget(request.target);
			validateEntryId(request.entryId, target, false);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const entry = this.globalMcpEntry(request.entryId, target, include.tree);
				const serverName = serverNameOf(entry.options);
				if (serverName === void 0) throw invalid(target, "the MCP row has no valid serverName");
				const rowId = entry.options.id;
				const written = await this.writeGlobalOne(include, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					disabled: request.disabled
				}, (fileRows) => {
					this.presetMcpRow(fileRows, rowId, target);
				}, rowId);
				return {
					target,
					entryId: written.id,
					serverName,
					disabled: written.disabled
				};
			}
			const preset = await this.resolvePreset(target);
			const entryId = presetLeafId(request.entryId);
			let serverName = entryId;
			await writePresetRows(this.ctx, preset, {
				id: entryId,
				name: MCP_CLIENT_MODULE,
				disabled: request.disabled
			}, (rows) => {
				serverName = serverNameOf(this.presetMcpRow(rows, entryId, target)) ?? entryId;
			}, this.warnPatch);
			return {
				target,
				entryId,
				serverName,
				disabled: request.disabled
			};
		}
		/**
		* Resolve one preset's declaration, refusing an activation failure before any
		* edit is attempted.
		*
		* The registry answers whether the declaration currently activates; the
		* declaration row itself comes from the profile patch, which is also where a
		* write goes. A composition without the registry still authors fine; only the
		* activation diagnostic is unavailable then.
		* @param target - the preset-scoped MCP target being authored.
		* @returns the declaration row and its current child rows.
		* @throws an MCP Remote error when the preset is unknown or broken.
		*/
		async resolvePreset(target) {
			const presets = this.ctx.get("agentPresets");
			if (presets !== void 0) {
				let broken;
				try {
					broken = (await presets.resolve(target.agentPreset)).broken;
				} catch (cause) {
					if (cause instanceof RemoteError) throw cause;
					throw new RemoteError("mcp/not-found", `MCP preset "${target.agentPreset}" was not found`, { target }, { cause });
				}
				if (broken !== void 0) throw new RemoteError("mcp/invalid", `MCP preset "${target.agentPreset}" is broken: ${broken}`, {
					target,
					reason: broken
				});
			}
			return findPresetDeclaration(this.ctx, target.agentPreset);
		}
		async globalInclude(target) {
			const includes = [...this.loader().entries()].filter((entry) => entry.options.name === "cordis:include" && entry.subtree);
			if (includes.length !== 1) throw new RemoteError("mcp/unavailable", "global MCP authoring requires exactly one file-backed Include", { reason: includes.length === 0 ? "no root Include is mounted" : `${includes.length} Includes are mounted` });
			const entry = includes[0];
			const tree = entry.subtree;
			const filename = tree.filename;
			if (filename === void 0) throw new RemoteError("mcp/unavailable", "global MCP authoring has no persistent Include file", { reason: "the mounted global tree does not expose a writable filename" });
			try {
				await access(filename, constants.W_OK);
			} catch (cause) {
				const reason = String(cause);
				throw new RemoteError("mcp/read-only", `global MCP config is not writable: ${filename}`, {
					target,
					reason
				}, { cause });
			}
			return {
				entry,
				tree
			};
		}
		/**
		* Persist one global-plane patch and reload the Include.
		*
		* The patch is applied to the Include's own file, whose list holds the user's
		* rows only, and `Include.refresh()` then re-reads it and re-applies the
		* composed patch layers. Writing through `loader.create`/`loader.update`
		* instead would make the Include serialize its patched tree back into that
		* file, flattening the bundle and user patch layers into it.
		* @param include - the addressed root Include and its file-backed tree.
		* @param target - the Remote target used in actionable failure details.
		* @param patch - the entry-list patch to commit.
		* @param validate - duplicate checks run against locked disk state.
		* @param rowIds - the rows this patch is expected to leave live.
		* @returns the live entries the reload produced, in the order asked for.
		* @throws an MCP Remote error when the reload does not mount every row.
		*/
		async writeGlobalRow(include, target, patch, validate, rowIds) {
			await writeEntryListFile(include.tree.filename, target, patch, validate, this.warnPatch);
			await include.tree.refresh();
			const live = [...include.tree.entries()];
			return rowIds.map((rowId) => {
				const mounted = live.find((row) => row.options.id === rowId);
				if (mounted === void 0) throw new RemoteError("mcp/invalid", `global MCP row "${rowId}" was written but is not mounted`, {
					target,
					reason: `${include.tree.filename} was updated; the composition did not pick the row up`
				});
				return mounted;
			});
		}
		/**
		* Persist one global-plane patch and return the row it mounts.
		* @param include - the addressed root Include and its file-backed tree.
		* @param target - the global plane.
		* @param patch - the entry-list patch to commit.
		* @param validate - duplicate checks run against locked disk state.
		* @param rowId - the row this patch is expected to leave live.
		* @returns the live entry the reload produced.
		*/
		async writeGlobalOne(include, target, patch, validate, rowId) {
			const [written] = await this.writeGlobalRow(include, target, patch, validate, [rowId]);
			if (written === void 0) throw new RemoteError("mcp/invalid", `global MCP row "${rowId}" was not mounted`, {
				target,
				reason: rowId
			});
			return written;
		}
		/**
		* Find one MCP row inside the addressed Include.
		*
		* The row lives in the Include's own subtree, so `loader.resolve` cannot see
		* it: that walks the root store, where only the Include itself is registered.
		* Both spellings of an id are accepted because the settings page keeps the leaf
		* id it renders while the Loader reports the qualified one.
		* @param entryId - qualified or leaf row id.
		* @param target - the Remote target used in actionable failure details.
		* @param tree - the addressed Include's tree.
		* @returns the row's live entry.
		* @throws an MCP Remote error when the row is absent, ambiguous, or not an MCP row.
		*/
		globalMcpEntry(entryId, target, tree) {
			const leafId = presetLeafId(entryId);
			const found = [...tree.entries()].filter((entry) => entry.options.id === leafId || entry.id === entryId);
			if (found.length === 0) throw new RemoteError("mcp/not-found", `MCP loader row "${entryId}" was not found`, {
				target,
				entryId
			});
			if (found.length > 1) throw conflict(target, entryId, void 0, "the row id occurs more than once");
			const entry = found[0];
			if (entry.options.name !== "@deepseek-ai/dsh-mcp-client" || entry.options.group) throw invalid(target, `loader row "${entryId}" is not an MCP client row`);
			return entry;
		}
		presetMcpRow(rows, entryId, target) {
			const found = findEntryRows(rows, entryId);
			if (found.length === 0) throw new RemoteError("mcp/not-found", `MCP preset row "${entryId}" was not found`, {
				target,
				entryId
			});
			if (found.length > 1) throw conflict(target, entryId, void 0, "the row id occurs more than once");
			const row = found[0];
			if (row.name !== "@deepseek-ai/dsh-mcp-client" || row.group) throw invalid(target, `preset row "${entryId}" is not an MCP client row`);
			return row;
		}
		assertServerNameAvailable(entries, entryId, serverName, target) {
			for (const value of entries) {
				const options = "options" in value ? value.options : value;
				const fullId = "options" in value ? value.id : void 0;
				if (options.id === entryId || fullId === entryId || options.name !== "@deepseek-ai/dsh-mcp-client" || options.group) continue;
				if (serverNameOf(options) === serverName) throw conflict(target, entryId, serverName, "the serverName is already in use");
			}
		}
		/** Resolve the Loader through `ctx.get`, never property access: an un-injected
		* service property throws under Cordis's inject guard, and the authoring
		* operations need the Loader lazily (it may not be ready at construction). */
		loader() {
			return this.ctx.get("loader");
		}
		warnPatch = (message, ...args) => {
			this.ctx.get("logger")?.warn(message, ...args);
		};
	};
})();
function validateTarget(value) {
	if (value.scope === "global") return { scope: "global" };
	if (value.agentPreset.length > 0) return {
		scope: "preset",
		agentPreset: value.agentPreset
	};
	throw badRequest("target must select global or a non-empty preset id");
}
function validateEntryId(entryId, target, adding) {
	if (entryId.length === 0) throw badRequest("entryId must be a non-empty string");
	if (adding && target.scope === "global" && entryId.includes(":")) throw badRequest("a new global entryId must be local to the Include root");
}
function configFromSpec(spec, serverName, target) {
	try {
		return mcpEntryConfig(spec, assertServerName(serverName));
	} catch (cause) {
		throw invalid(target, String(cause));
	}
}
function serverNameOf(options) {
	const config = options.config;
	if (config === null || typeof config !== "object" || Array.isArray(config)) return void 0;
	const record = config;
	return typeof record.serverName === "string" ? record.serverName : void 0;
}
function badRequest(message) {
	return new RemoteError("gateway/bad-request", message, {});
}
function invalid(target, reason) {
	return new RemoteError("mcp/invalid", reason, {
		target,
		reason
	});
}
function conflict(target, entryId, serverName, reason) {
	return new RemoteError("mcp/conflict", reason, {
		target,
		entryId,
		...serverName === void 0 ? {} : { serverName },
		reason
	});
}
//#endregion
//#region src/settings.ts
/** Settings namespace owned by this plugin: its Loader row id. */
const MCP_SETTINGS_NAMESPACE = "mcp-manager";
/** Schema served to settings clients for this namespace.
* The inferred type is the source of truth: `.volatile()` produces the `Volatile` accessors above. */
const Config = z.object({
	loading: z.string().default("dynamic").volatile(),
	descriptions: z.dict(String).default({}).volatile(),
	tools: z.dict(z.any()).default({}).volatile()
});
/**
* Read the namespace's fields as plain values.
*
* The gate and the tool filter call the returned thunk at their own commit
* points, so a committed change needs no listener here.
* @param config - the plugin's resolved configuration.
* @returns a thunk returning the flags as they stand at call time.
*/
function readMcpSettings(config) {
	return () => ({
		loading: config.loading.get(),
		descriptions: { ...config.descriptions.get() },
		tools: { ...config.tools.get() }
	});
}
//#endregion
//#region src/index.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "mcp-manager";
/** Services required by this plugin. Every other service is probed lazily. */
const inject = ["loader"];
/**
* Register the on-demand MCP tools, the preload gate that follows the loading
* mode, the live settings fields, and the `mcpManager` Remote.
* @param ctx - plugin context.
* @param config - the row's resolved configuration.
*/
async function apply(ctx, config) {
	const readSettings = readMcpSettings(config);
	let mcpLoading = parseMcpLoadingMode(readSettings().loading);
	const mountReader = await resolvePresetMounts(ctx, (within) => livePresetMounts(within));
	const gate = createMcpPreloadGate(ctx, () => mcpLoading, mountReader, (message) => {
		ctx.logger.warn(message);
	});
	let readToolFilter = () => NO_TOOL_FILTER;
	const readers = {
		filterFor: (key) => readToolFilter(key),
		descriptionFor: (key) => readSettings().descriptions[key]
	};
	let mcpTools = registerMcpTools(ctx, mcpLoading, gate, readers);
	ctx.effect(() => () => {
		mcpTools.dispose();
		gate.dispose();
	}, "mcp-manager: mcp tools");
	const resync = () => {
		gate.reconcile().then(() => mcpTools.refresh());
	};
	const events = ctx;
	for (const event of MCP_ROW_EVENTS) ctx.effect(() => events.on(event, (...args) => {
		if (event === "loader/entry-init") {
			if (args[0]?.options?.name !== "@deepseek-ai/dsh-mcp-client") return;
		}
		resync();
	}), `mcp-manager: gate follows ${event}`);
	await gate.reconcile();
	await mcpTools.refresh();
	/**
	* Warn once per commit when rules cannot take effect, in either of the two
	* ways a row can bypass this plugin's carriers: `eager` mounts every allowed
	* row through mcp-client, and a global row is mounted that way whatever the
	* mode. Both publish all discovered tools, so a rule there is silently useless
	* otherwise.
	*/
	const warnFiltersWithoutEffect = (next) => {
		const configured = Object.entries(next.tools).filter(([, value]) => filterHidesAnything(parseMcpToolFilter(value))).map(([key]) => key);
		if (configured.length === 0) return;
		if (mcpLoading === "eager") {
			ctx.logger.warn(`mcp-manager: MCP loading is "eager", so the tool filters for ${configured.join(", ")} have no effect. eager mounts every enabled row through mcp-client, which registers all discovered tools; select the "dynamic" or "lazy" loading mode to apply these filters.`);
			return;
		}
		const globalRules = configured.filter((key) => key.startsWith("global:"));
		if (globalRules.length === 0) return;
		ctx.logger.warn(`mcp-manager: the tool filters for ${globalRules.join(", ")} have no effect. A global row is mounted by the composition, which registers all of its discovered tools; author the row inside an agent preset to filter it.`);
	};
	const commit = () => {
		const next = readSettings();
		const mode = parseMcpLoadingMode(next.loading);
		if (mode !== mcpLoading) {
			mcpLoading = mode;
			mcpTools.dispose();
			mcpTools = registerMcpTools(ctx, mode, gate, readers);
			resync();
		}
		warnFiltersWithoutEffect(next);
	};
	ctx.effect(() => ctx.on("loader/volatile-update", () => {
		commit();
	}), "mcp-manager: settings commits");
	readToolFilter = (key) => parseMcpToolFilter(readSettings().tools[key]);
	warnFiltersWithoutEffect(readSettings());
	new McpManager(ctx, gate, mountReader);
}
//#endregion
export { Config, MCP_LOADING_MODES, MCP_SETTINGS_NAMESPACE, McpManager, admits, apply, assertServerName, carrierFor, filterHidesAnything, filterMcpTools, flattenSpec, inject, mcpEntryConfig, mcpRowKey, name, parseMcpLoadingMode, parseMcpToolFilter, parseSpecText, parseSpecValue, readMcpSettings, registerMcpTools, scanClaudeMcp, secretKeys, serverNameFromCommand, specFromEntryConfig, specFromObject, toolRuleEntries };
