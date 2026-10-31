import { access, constants, lstat, mkdir, open, readFile } from "node:fs/promises";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { scopeChainOf, scopeOf } from "@deepseek-ai/dsh-scope";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
/** Module specifier of the MCP client bridge this plugin governs. */
const MCP_CLIENT_MODULE = "@deepseek-ai/dsh-mcp-client";
/** Whether one row names the Include plugin, by builtin name or package name. */
function isIncludeRow(options) {
	return options.name === "cordis:include" || options.name === "@deepseek-ai/cordis-plugin-include";
}
/**
* Whether one mounted Include is the host's own root anchor.
*
* The anchor points at `$DSH_HOME/profiles/<profile>/cordis.yml`, which
* `prepareProfile` rewrites from the composed layers on every start, so a write
* there is discarded at the next boot: it is never a settings-page target. The
* pinned id identifies it structurally, without depending on the host's profile
* layout. Only a root-level entry carries an unqualified Loader id, so a nested
* Include named `include` still reads as the user's.
* @param entry - one mounted Loader row.
* @returns whether that row is the host's root anchor Include.
*/
function isRootAnchorInclude(entry) {
	return entry.id === "include" && isIncludeRow(entry.options);
}
/** The file one mounted Include tree owns, when it exposes a usable path. */
function includeFilename$1(tree) {
	const filename = tree.filename;
	return typeof filename === "string" && filename !== "" ? filename : void 0;
}
/**
* Collect the file-backed Includes a settings-page global write may target.
*
* The host's root anchor is excluded: its file is regenerated on every start.
* Every other file-backed Include is the user's own, wherever the composition
* put it — a nested one is how a profile declares its own composition file.
* @param entries - the Loader's entries, in composition order.
* @returns each addressable Include with its filename, in composition order.
*/
function writableGlobalIncludes(entries) {
	const found = [];
	for (const entry of entries) {
		if (!isIncludeRow(entry.options) || entry.subtree === void 0) continue;
		if (isRootAnchorInclude(entry)) continue;
		const filename = includeFilename$1(entry.subtree);
		if (filename === void 0) continue;
		found.push({
			entry,
			filename
		});
	}
	return found;
}
/**
* Read one entry-list file's own rows for a read-only decision.
*
* This reads the file, not the mounted tree: a row a patch layer or a nested
* composition contributes is live but absent here, and only the rows this file
* declares can be patched back into it.
* @param filename - YAML or JSON entry-list path.
* @returns the file's rows, or undefined when it cannot be read or parsed.
*/
function readEntryListRowsSync(filename) {
	let parsed;
	try {
		parsed = load(readFileSync(filename, "utf8"), { schema: entryListSchema });
	} catch {
		return;
	}
	if (entryListProblem(parsed) !== void 0) return void 0;
	return parsed;
}
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
//#endregion
//#region src/preset-source.ts
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
			...typeof config.name === "string" ? { name: config.name } : {},
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
function declaredRows$1(config, id) {
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
		...typeof name === "string" ? { name } : {},
		entry,
		rows: declaredRows$1(entry.options.config, id)
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
		const rows = declaredRows$1(current, declaration.id);
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
/** An empty credential set, shared so a read of a config-free row allocates nothing. */
const NO_CREDENTIALS = {
	env: {},
	headers: {}
};
/**
* Read the credentials a stored entry config declares, without asserting its
* transport: the settings page only needs to know whether a row carries `env`
* or `headers` at all, and where.
*
* Every value is a string on the wire, but a hand-edited composition file can
* carry anything, so a non-string value is dropped rather than coerced — the
* page shows what the row really has, and the diagnostics report the rest.
* @param config - the row config as the Loader holds it, of unknown shape.
* @returns the env and header maps, each empty when the config declares none.
*/
function readStoredCredentials(config) {
	if (config === null || typeof config !== "object") return NO_CREDENTIALS;
	const values = config;
	const pairs = (source) => {
		if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
		const entries = Object.entries(source).filter((entry) => typeof entry[1] === "string");
		return Object.fromEntries(entries);
	};
	return {
		env: pairs(values.env),
		headers: pairs(values.headers)
	};
}
/**
* The credential key names a stored entry config declares. Only the keys are
* read: values are credentials, and this answer travels to the browser.
* @param config - the row config as the Loader holds it.
* @returns the `env` and `headers` key names, in one list in declaration order.
*/
function storedCredentialKeys(config) {
	const credentials = readStoredCredentials(config);
	return [...Object.keys(credentials.env), ...Object.keys(credentials.headers)];
}
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
function isRecord(value) {
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
		const env = isRecord(candidate.env) ? Object.fromEntries(Object.entries(candidate.env).map(([k, v]) => [k, String(v)])) : void 0;
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
		const headers = isRecord(candidate.headers) ? Object.fromEntries(Object.entries(candidate.headers).map(([k, v]) => [k, String(v)])) : void 0;
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
	if (!isRecord(value)) throw new Error(invalid);
	let root = value;
	if (isRecord(root.mcpServers)) root = root.mcpServers;
	let serverName;
	if (root.type === void 0 && root.command === void 0 && root.url === void 0) {
		const pairs = Object.entries(root);
		if (pairs.length !== 1) throw new Error(invalid);
		const [name, entry] = pairs[0];
		if (!isRecord(entry)) throw new Error(invalid);
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
	return programName(command).replace(/^@[^/]+\//, "").replace(/-mcp(-server)?$/, "").replace(/-server$/, "").replace(/@[^@]*$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
/** A command's own program, without its path or script extension. */
function programName(command) {
	return (command.split(/[\\/]/).at(-1) ?? command).replace(/\.(cmd|exe|ps1|js|mjs|cjs|py)$/i, "");
}
//#endregion
//#region src/mcp-variable-refs.ts
/**
* The placeholders an MCP config may reference, and how to spot them.
*
* Kept apart from the diagnostics module on purpose: this file never touches
* `process.env`, so it can be bundled into the browser half. The editor needs
* the same rules — to warn about a `${env:NAME}` while the Host is the only side
* that can say whether it resolves — and the browser has no environment at all.
*
* @module @guowenzhang/dsh-mcp-manager/mcp-variable-refs
*/
/**
* Placeholder syntax this plugin understands: `${env:NAME}`.
*
* The same spelling `dsh-resource-manager` resolves before it hands rows over.
* It is reused here rather than invented a second time, so a row authored for
* either surface means the same thing.
*/
const MCP_ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Credential-shaped keys whose blank value means "not configured yet". */
const CREDENTIAL_KEY = /token|secret|password|passwd|api[_-]?key|apikey|auth|credential|cookie/i;
/** True for a non-empty string. */
function isFilled(value) {
	return typeof value === "string" && value.trim() !== "";
}
/**
* Collect the unset variables a value references.
* @param value - one string from a config or spec.
* @param env - environment to resolve against.
* @param missing - sink collecting unresolved names.
*/
function collectMissingReferences(value, env, missing) {
	for (const match of value.matchAll(MCP_ENV_REFERENCE)) {
		const name = match[1];
		if (name !== void 0 && !(env[name] ?? "").trim()) missing.add(name);
	}
}
/**
* Every string an MCP spec or row config may carry a reference in.
*
* Env and header VALUES are included, not just the transport fields: the
* documented way to keep a credential out of the config is
* `"env": { "TOKEN": "${env:TOKEN}" }`, so the reference lives there.
* @param spec - a parsed spec, or a normalized `mcp-client` config.
* @returns the strings to scan, in no particular order.
*/
function specStrings(spec) {
	if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return [];
	const record = spec;
	const strings = [];
	for (const key of [
		"command",
		"url",
		"cwd"
	]) if (typeof record[key] === "string") strings.push(record[key]);
	if (Array.isArray(record.args)) {
		for (const arg of record.args) if (typeof arg === "string") strings.push(arg);
	}
	for (const field of ["env", "headers"]) {
		const map = record[field];
		if (map === null || typeof map !== "object" || Array.isArray(map)) continue;
		for (const value of Object.values(map)) if (typeof value === "string") strings.push(value);
	}
	return strings;
}
/**
* The env/header keys of a spec that are present but blank.
* @param spec - a parsed spec (or a raw declaration config).
* @returns the credential-shaped key names, deduplicated.
*/
function blankCredentialKeys(spec) {
	if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return [];
	const record = spec;
	const blank = /* @__PURE__ */ new Set();
	for (const field of ["env", "headers"]) {
		const map = record[field];
		if (map === null || typeof map !== "object" || Array.isArray(map)) continue;
		for (const [key, value] of Object.entries(map)) {
			if (value === void 0 || value === null) continue;
			if (CREDENTIAL_KEY.test(key) && !isFilled(value)) blank.add(key);
		}
	}
	return [...blank].sort();
}
//#endregion
//#region src/mcp-diagnostics.ts
/**
* Diagnose one MCP row's connection configuration.
*
* Ordering is deliberate: a structural problem (blank transport field) is
* reported on its own, because a missing `url` makes every other observation
* about that row moot. Variable and credential gaps accumulate, so the page can
* name them all at once.
* @param config - the row's `mcp-client` config, or whatever the composition carried.
* @param env - environment used to resolve `${env:NAME}` (defaults to `process.env`).
* @returns every gap found, at most one structural one, in report order.
*/
function diagnoseMcpConfig(config, env = process.env) {
	if (config === null || typeof config !== "object" || Array.isArray(config)) return [{
		kind: "unsupported-config",
		reason: "the row config is not an object"
	}];
	const record = config;
	const transport = record.transport;
	const kind = transport === "stdio" || transport === void 0 && isFilled(record.command) ? "stdio" : transport === "streamable-http" || transport === "http" || transport === "sse" || transport === void 0 && isFilled(record.url) ? "streamable-http" : void 0;
	if (kind === void 0) return [{
		kind: "unsupported-config",
		reason: transport === void 0 ? "the row config declares neither a command nor a url" : `unsupported MCP transport "${String(transport)}"`
	}];
	if (kind === "stdio") {
		if (!isFilled(record.command)) return [{
			kind: "missing-command",
			reason: "the stdio row has no command"
		}];
		const missing = /* @__PURE__ */ new Set();
		for (const value of specStrings(record)) collectMissingReferences(value, env, missing);
		return issues(missing, blankCredentialKeys(record));
	}
	if (!isFilled(record.url)) return [{
		kind: "missing-url",
		reason: "the HTTP row has no url"
	}];
	const missing = /* @__PURE__ */ new Set();
	for (const value of specStrings(record)) collectMissingReferences(value, env, missing);
	return issues(missing, blankCredentialKeys(record));
}
/** Render the accumulated variable and credential gaps in report order. */
function issues(missing, credentials) {
	const issues = [];
	const names = [...missing].sort();
	if (names.length > 0) issues.push({
		kind: "unreachable-variable",
		reason: `referenced environment variable(s) are not set: ${names.join(", ")}`,
		names
	});
	for (const key of [...new Set(credentials)].sort()) issues.push({
		kind: "empty-credential",
		reason: `"${key}" is empty`,
		names: [key]
	});
	return issues;
}
/**
* Whether a row with these diagnostics can start right now.
* @param issues - the result of {@link diagnoseMcpConfig}.
* @returns true when nothing stands between the row and a connection attempt.
*/
/**
* Diagnose whatever a composition row carries as its config.
*
* A preset declaration carries the Claude-shaped spec (`type`/`command`/`url`),
* while a global row and every managed row carry the normalized `mcp-client`
* config; the settings editor holds the spec too. Normalizing first means all
* three are judged by one set of rules, and a row that cannot even be converted
* is reported as the configuration problem it is rather than starting and
* failing later.
* @param config - the row's raw `config` value, in either shape.
* @param env - environment used to resolve `${env:NAME}` (defaults to `process.env`).
* @returns every gap found, empty when the row can start as written.
*/
function diagnoseRowConfig(config, env = process.env) {
	if (config === void 0 || config === null) return [];
	if (typeof config !== "object" || Array.isArray(config)) return [{
		kind: "unsupported-config",
		reason: "the row config is not an object"
	}];
	const record = config;
	if (record.transport !== void 0) return diagnoseMcpConfig(record, env);
	const serverName = typeof record.serverName === "string" ? record.serverName : "";
	try {
		return diagnoseMcpConfig(mcpEntryConfig(specFromObject(record, "the row config is not a usable MCP spec"), assertServerName(serverName || "row")), env);
	} catch (error) {
		return [{
			kind: "unsupported-config",
			reason: error instanceof Error ? error.message : String(error)
		}];
	}
}
/**
* One-line explanation of why a row cannot start.
* @param issues - the result of {@link diagnoseMcpConfig}.
* @returns the reasons joined for a tooltip or a failure message.
*/
function describeMcpConfigIssues(issues) {
	return issues.map((issue) => issue.reason).join("; ");
}
//#endregion
//#region src/mcp-catalog.ts
/** Durable MCP tool discovery, shared by local processes and HTTP servers. */
/** Configuration digest; transport, credentials and effective local cwd/env participate. */
function catalogIdentity(config) {
	const source = config.transport === "stdio" ? [
		"stdio",
		config.serverName,
		config.command,
		config.args,
		resolve(config.cwd || process.cwd()),
		Object.entries({
			...process.env,
			...config.env
		}).sort(([a], [b]) => a.localeCompare(b))
	] : [
		"streamable-http",
		config.serverName,
		config.url,
		Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b))
	];
	return createHash("sha256").update(JSON.stringify(source)).digest("hex");
}
function validTool(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const tool = value;
	if (typeof tool.name !== "string") return false;
	for (const field of ["title", "description"]) if (tool[field] !== void 0 && typeof tool[field] !== "string") return false;
	if (tool.annotations !== void 0) {
		if (tool.annotations === null || typeof tool.annotations !== "object" || Array.isArray(tool.annotations)) return false;
		const hints = tool.annotations;
		for (const field of [
			"readOnlyHint",
			"destructiveHint",
			"idempotentHint",
			"openWorldHint"
		]) if (hints[field] !== void 0 && typeof hints[field] !== "boolean") return false;
	}
	return true;
}
/** Validate database JSON before it can feed search or a write transaction. */
function validCatalogRecord(value) {
	if (value === null || typeof value !== "object") return false;
	const item = value;
	const entry = item.entry;
	return (item.transport === "stdio" || item.transport === "streamable-http") && typeof item.label === "string" && item.label.length <= 128 && typeof item.identity === "string" && /^[a-f0-9]{64}$/.test(item.identity) && entry !== null && entry !== void 0 && entry.transport === item.transport && Number.isFinite(entry.fetchedAt) && entry.fetchedAt >= 0 && entry.fetchedAt <= Date.now() && typeof entry.truncated === "boolean" && Array.isArray(entry.tools) && entry.tools.length <= 2e3 && entry.tools.every(validTool) && (entry.serverTtlMs === void 0 || Number.isFinite(entry.serverTtlMs) && entry.serverTtlMs >= 0);
}
const MAX_CATALOG_SERVERS = 500;
/** Local catalogues are durable until invalidated; only server-advertised HTTP TTLs expire. */
var McpCatalog = class {
	storage;
	warn;
	records = /* @__PURE__ */ new Map();
	bindings = /* @__PURE__ */ new Map();
	pending = Promise.resolve();
	generation = 0;
	closed = false;
	writing = false;
	dirty = false;
	clearing = false;
	constructor(storage, warn = () => {}) {
		this.storage = storage;
		this.warn = warn;
	}
	get epoch() {
		return this.generation;
	}
	get persistent() {
		return this.storage !== void 0;
	}
	get size() {
		return this.records.size;
	}
	async restore() {
		if (this.storage === void 0) return;
		try {
			const value = await this.storage.load();
			if (value === void 0) return;
			if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("invalid catalogue");
			for (const item of value.entries.slice(-500)) {
				if (!validCatalogRecord(item)) {
					this.warn();
					continue;
				}
				this.records.set(item.identity, item);
			}
		} catch {
			this.warn();
		}
	}
	remember(config, record, key, now = Date.now(), epoch = this.epoch) {
		if (this.closed || epoch !== this.epoch) return;
		const identity = catalogIdentity(config);
		const entry = {
			tools: record.tools,
			fetchedAt: now,
			truncated: record.truncated,
			transport: config.transport,
			...config.transport === "stdio" || record.ttlMs === void 0 ? {} : { serverTtlMs: record.ttlMs }
		};
		this.records.delete(identity);
		this.records.set(identity, {
			identity,
			label: config.serverName,
			transport: config.transport,
			entry
		});
		if (key !== void 0) this.bindings.set(key, identity);
		this.trim();
		this.persist();
	}
	/** Config-aware lookup prevents changed URL/command/credentials from reusing old tools. */
	getFor(key, config, now = Date.now()) {
		const identity = catalogIdentity(config);
		this.bindings.set(key, identity);
		this.trim();
		const entry = this.records.get(identity)?.entry;
		return entry === void 0 || this.expired(entry, now) ? void 0 : entry;
	}
	get(key, now = Date.now()) {
		const identity = this.bindings.get(key);
		const entry = identity === void 0 ? void 0 : this.records.get(identity)?.entry;
		return entry === void 0 || this.expired(entry, now) ? void 0 : entry;
	}
	/** Whether a previously discovered server should be refreshed on the next search. */
	expiredFor(config, now = Date.now()) {
		const entry = this.records.get(catalogIdentity(config))?.entry;
		return entry !== void 0 && this.expired(entry, now);
	}
	expired(entry, now) {
		return entry.transport === "streamable-http" && entry.serverTtlMs !== void 0 && (entry.serverTtlMs <= 0 || now - entry.fetchedAt > entry.serverTtlMs);
	}
	invalidate(key) {
		const identity = this.bindings.get(key);
		if (identity === void 0) return false;
		const removed = this.records.delete(identity);
		for (const [alias, target] of this.bindings) if (target === identity) this.bindings.delete(alias);
		if (removed) this.persist();
		return removed;
	}
	clear() {
		this.generation += 1;
		const count = this.records.size;
		this.records.clear();
		this.bindings.clear();
		this.persist(true);
		return count;
	}
	stats(now = Date.now()) {
		return [...this.records.values()].map(({ identity, label, transport, entry }) => ({
			key: [...this.bindings].find(([, value]) => value === identity)?.[0] ?? `${transport === "stdio" ? "local" : "server"}:${label}`,
			transport,
			tools: entry.tools.length,
			ageMs: Math.max(0, now - entry.fetchedAt),
			truncated: entry.truncated,
			...entry.serverTtlMs === void 0 ? {} : { ttlMs: entry.serverTtlMs },
			expired: this.expired(entry, now)
		}));
	}
	async flush() {
		await this.pending;
	}
	async close() {
		this.closed = true;
		this.generation += 1;
		await this.flush();
	}
	trim() {
		while (this.records.size > MAX_CATALOG_SERVERS) {
			const identity = this.records.keys().next().value;
			this.records.delete(identity);
			for (const [key, value] of this.bindings) if (value === identity) this.bindings.delete(key);
		}
		while (this.bindings.size > MAX_CATALOG_SERVERS) this.bindings.delete(this.bindings.keys().next().value);
	}
	persist(clear = false) {
		if (this.storage === void 0) return;
		this.dirty = true;
		this.clearing ||= clear;
		if (this.writing) return;
		this.writing = true;
		this.pending = (async () => {
			while (this.dirty) {
				this.dirty = false;
				const clearing = this.clearing;
				this.clearing = false;
				const entries = [...this.records.values()].map((item) => ({
					...item,
					entry: {
						...item.entry,
						tools: item.entry.tools.map((tool) => Object.fromEntries([
							"name",
							"title",
							"description",
							"inputSchema",
							"outputSchema",
							"annotations",
							"execution"
						].filter((field) => field in tool).map((field) => [field, tool[field]])))
					}
				}));
				try {
					await this.storage.save({
						version: 1,
						entries
					}, clearing);
				} catch (error) {
					if (clearing) this.clearing = true;
					throw error;
				}
			}
		})().finally(() => {
			this.writing = false;
		});
		this.pending.catch(() => {
			this.warn();
		});
	}
};
//#endregion
//#region src/mcp-optimize.ts
/** The policy a deployment runs when its settings document says nothing. */
const MCP_OPTIMIZE_DEFAULTS = Object.freeze({
	search: true,
	searchIndex: false,
	pageSize: 10,
	namesOnly: true,
	maxTools: 200,
	annotations: true,
	hideDestructive: false
});
/** Accepted range of {@link McpOptimizeFlags.pageSize}. */
const MCP_PAGE_SIZE_RANGE = Object.freeze({
	min: 1,
	max: 50
});
/** Accepted range of {@link McpOptimizeFlags.maxTools}. */
const MCP_MAX_TOOLS_RANGE = Object.freeze({
	min: 1,
	max: 2e3
});
/**
* Read one stored boolean, converging anything else to its default.
* @param value - the stored value of any shape.
* @param fallback - the default to use when the value is not a boolean.
* @returns the stored boolean or the default.
*/
function readFlag(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/**
* Read one stored number, clamping it into `range`.
*
* A settings document is hand-edited, so a value that is not a finite number in
* range converges to the default rather than failing the namespace commit.
* @param value - the stored value of any shape.
* @param fallback - the default to use when the value is unusable.
* @param range - inclusive bounds.
* @returns the stored number, clamped, or the default.
*/
function readNumber(value, fallback, range) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(range.max, Math.max(range.min, Math.round(value)));
}
/**
* Converge one stored `optimize` value into the policy the Host runs under.
* @param value - the stored value, of any shape; a non-object reads as "no settings".
* @returns every field, taking the default for anything absent or malformed.
*/
function parseMcpOptimizeFlags(value) {
	const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	return {
		search: readFlag(record.search, MCP_OPTIMIZE_DEFAULTS.search),
		searchIndex: readFlag(record.searchIndex, MCP_OPTIMIZE_DEFAULTS.searchIndex),
		pageSize: readNumber(record.pageSize, MCP_OPTIMIZE_DEFAULTS.pageSize, MCP_PAGE_SIZE_RANGE),
		namesOnly: readFlag(record.namesOnly, MCP_OPTIMIZE_DEFAULTS.namesOnly),
		maxTools: readNumber(record.maxTools, MCP_OPTIMIZE_DEFAULTS.maxTools, MCP_MAX_TOOLS_RANGE),
		annotations: readFlag(record.annotations, MCP_OPTIMIZE_DEFAULTS.annotations),
		hideDestructive: readFlag(record.hideDestructive, MCP_OPTIMIZE_DEFAULTS.hideDestructive)
	};
}
/**
* The part of the policy that decides which tools exist at all.
*
* Nearly everything here is read live: a switch flipped in the settings page
* changes the next load, search, or re-sync without rebuilding anything. The one
* exception is whether `mcp_search` is registered — a registered tool set is
* what the request prefix carries — so the registration is rebuilt when this
* changes and not for anything else.
* @param flags - the resolved policy.
* @returns a stable key that changes exactly when the registered tool set must.
*/
function mcpRegistrationKey(flags) {
	return flags.search ? "search" : "plain";
}
/**
* Collapse a query into the terms every match must contain.
* @param query - the model's query text.
* @returns normalized, non-empty terms with wildcard characters dropped, so
*   `get_*` reads as the prefix `get_` instead of a literal asterisk.
*/
function queryTerms(query) {
	return normalizeText(query).split(/\s+/).map((term) => term.replace(/[*?]/g, "")).filter((term) => term !== "");
}
/**
* Normalize one text fragment for matching: compatibility-normalized, folded to
* lower case. NFKC makes full-width and half-width spellings comparable, which
* matters for the CJK descriptions deployments write by hand.
* @param text - the raw text.
* @returns the comparable form.
*/
function normalizeText(text) {
	return text.normalize("NFKC").toLowerCase();
}
/**
* Score one tool against the query terms.
* @param tool - the candidate tool.
* @param terms - the normalized query terms; every one must occur.
* @returns a relevance score, or `-1` when a term is missing anywhere.
*/
function scoreTool(tool, terms) {
	const name = normalizeText(tool.name);
	const title = normalizeText(tool.title ?? "");
	const description = normalizeText(tool.description ?? "");
	let score = 0;
	for (const term of terms) {
		const inName = name.includes(term);
		const inTitle = title.includes(term);
		const inDescription = description.includes(term);
		if (!inName && !inTitle && !inDescription) return -1;
		if (inName) score += 4;
		if (inTitle) score += 2;
		if (inDescription) score += 1;
		if (name === term) score += 8;
	}
	return score;
}
/**
* Match one query against a server's tools.
*
* Every whitespace-separated term has to occur in the tool's name, title, or
* description; the result is ordered by relevance with ties left in the
* server's own order, so the same query always pages the same way.
* @param tools - the tools the policy currently admits, in the server's order.
* @param query - the model's query; blank keeps every tool.
* @returns the matching tools, most relevant first.
*/
function matchTools(tools, query) {
	const terms = queryTerms(query);
	if (terms.length === 0) return tools;
	const scored = [];
	tools.forEach((tool, index) => {
		const score = scoreTool(tool, terms);
		if (score >= 0) scored.push({
			tool,
			index,
			score
		});
	});
	scored.sort((left, right) => right.score - left.score || left.index - right.index);
	return scored.map((entry) => entry.tool);
}
/**
* Whether one tool matches a query, for callers that only need the predicate.
* @param tool - the candidate tool.
* @param query - the model's query; blank matches everything.
* @returns true when the query admits the tool.
*/
function toolMatchesQuery(tool, query) {
	const terms = queryTerms(query);
	return terms.length === 0 || scoreTool(tool, terms) >= 0;
}
/**
* Apply the annotation policy to one server's filtered tools.
* @param tools - the tools the row's own rules already admitted.
* @param flags - the resolved policy.
* @returns the tools the session may admit, and how many the policy hid.
*/
function applyAnnotationPolicy(tools, flags) {
	if (!flags.hideDestructive) return {
		visible: tools,
		hidden: 0
	};
	const visible = tools.filter((tool) => tool.annotations?.destructiveHint !== true);
	return {
		visible,
		hidden: tools.length - visible.length
	};
}
/**
* The annotation tokens a listing prints for one tool.
*
* Only the hints the server actually published are reported, and only when the
* policy asks for annotations: the spec treats annotations as untrusted server
* claims, so a missing hint must not be presented as a promise.
* @param tool - the tool to describe.
* @param flags - the resolved policy.
* @returns the token list, empty when there is nothing to report.
*/
function annotationSummary(tool, flags) {
	if (!flags.annotations) return [];
	const annotations = tool.annotations;
	if (annotations === void 0) return [];
	const tokens = [];
	if (annotations.readOnlyHint === true) tokens.push("read-only");
	if (annotations.destructiveHint === true) tokens.push("destructive");
	if (annotations.idempotentHint === true) tokens.push("idempotent");
	if (annotations.openWorldHint === true) tokens.push("open-world");
	return tokens;
}
/**
* Page one model-facing listing.
*
* The cursor is opaque to the model (it is only ever echoed back), and a cursor
* this build did not issue is a caller error rather than a silently wrong page.
* A blank cursor is the one exception: the MCP spec hands an empty `nextCursor`
* back to the caller to mean "start here", so a caller that echoes it is asking
* for the first page, exactly like a caller that omitted the cursor.
* @param items - the whole listing, in its stable order.
* @param cursor - the previous page's `nextCursor`, or undefined for the first page.
* @param limit - requested page size; the caller clamps it to the policy range.
* @returns the page, the offset it started at, the listing size, and the cursor
*   for the page after it.
* @throws when `cursor` is a non-blank cursor this build did not issue.
*/
function paginateTools(items, cursor, limit) {
	const offset = cursor === void 0 || typeof cursor === "string" && cursor.trim() === "" ? 0 : decodeToolCursor(cursor);
	const page = items.slice(offset, offset + limit);
	const next = offset + page.length;
	return {
		page,
		offset,
		total: items.length,
		...next < items.length ? { nextCursor: encodeToolCursor(next) } : {}
	};
}
/**
* Encode one listing offset as an opaque page cursor.
* @param offset - index of the next page's first tool.
* @returns the cursor to hand the model.
*/
function encodeToolCursor(offset) {
	return `o${offset.toString(36)}`;
}
/**
* Read one page cursor back.
* @param cursor - the cursor the model echoed; a blank one never reaches here,
*   because `paginateTools` reads it as "first page".
* @returns the offset it carries.
* @throws when the value is not a cursor this build issued.
*/
function decodeToolCursor(cursor) {
	const digits = /^o([0-9a-z]+)$/.exec(cursor.trim())?.[1] ?? "";
	const offset = digits === "" ? NaN : Number.parseInt(digits, 36);
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid cursor — pass `nextCursor` from the previous result, or omit it");
	return offset;
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
* and a load-time query only narrow the visible set inside that decision: under
* `dynamic` the plugin builds exactly the visible tools natively, so a narrowed
* load needs no separate carrier.
* @param mode - the loading mode a session committed to.
* @param filter - the row's resolved rules.
* @param _narrowed - whether the load itself asks for a subset of the server's
*   tools (`query`/`tool` on `mcp_load`). Accepted for call-site compatibility;
*   it cannot change the carrier, because `dynamic` builds individual
*   definitions whether or not the load narrows anything.
* @returns `proxy` under `lazy` and `native` under `dynamic`; `undefined` under
*   `eager`, which mounts every allowed row and registers no on-demand tool at
*   all. The filter does not change the carrier: it only decides which of a
*   `native` row's tools are built.
*/
function carrierFor(mode, _filter, _narrowed = false) {
	if (mode === "eager") return void 0;
	return mode === "lazy" ? "proxy" : "native";
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
//#region src/mcp-allowance.ts
/** Match Loader's !!js representation without importing a second host copy. */
function expression(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const expr = value.__jsExpr;
	return typeof expr === "string" ? expr : void 0;
}
function enablement(values, evaluate) {
	let conditional = false;
	for (const value of values) {
		const expr = expression(value);
		if (expr === void 0) {
			if (Boolean(value)) return false;
		} else try {
			if (evaluate === void 0) conditional = true;
			else if (Boolean(evaluate(expr))) return false;
		} catch {
			conditional = true;
		}
	}
	return conditional ? "conditional" : true;
}
/** Walk group ancestry; an unevaluable expression never authorizes a load. */
function declaredMcpRows(rows, moduleName, evaluate, inherited = []) {
	const found = [];
	for (const row of rows) {
		const contributions = [...inherited, row.disabled];
		if (row.group === true) {
			if (Array.isArray(row.config)) found.push(...declaredMcpRows(row.config, moduleName, evaluate, contributions));
		} else if (row.name === moduleName) found.push({
			options: row,
			enabled: enablement(contributions, evaluate)
		});
	}
	return found;
}
//#endregion
//#region src/mcp-gate.ts
/** Stable key for one row, matching the settings UI's description key. */
function mcpRowKey(target, serverName) {
	return target.scope === "preset" ? `preset:${target.agentPreset}:${serverName}` : `global:${serverName}`;
}
/** The Loader's own entry key, matching `Entry.key` in `cordis-plugin-loader`. */
const ENTRY_KEY = Symbol.for("cordis.entry");
/** Row creation, teardown, and late dependency activation all invalidate snapshots. */
const MCP_ROW_EVENTS = [
	"tools/change",
	"loader/entry-init",
	"loader/partial-dispose",
	"internal/status",
	"agent-preset/selected"
];
/**
* Whether a Loader tree is the file-backed include that owns the global plane.
*
* The composition file is what separates the planes: an in-memory composed
* preset tree has no `filename`, while the include names the file it persists
* to and writes back to. `ctx` cannot be the marker — `EntryTree` declares one
* on every tree, the include's included.
* @param tree - candidate tree, usually reached through `entry.parent.tree`.
* @returns true when this tree is the global composition file.
*/
function isGlobalPlaneTree(tree) {
	if (tree === void 0 || tree === null) return false;
	const candidate = tree;
	return typeof candidate.filename === "string" && typeof candidate.write === "function";
}
/** The module names a file-backed include is mounted under. */
const INCLUDE_MODULES = ["cordis:include", "@deepseek-ai/cordis-plugin-include"];
/**
* Whether a tree belongs to the global plane, judged by whichever handle the
* caller has. The include's own tree answers with its composition file; a row's
* tree is reached before the include finished constructing, so the owning
* entry's own name answers instead. Both are the same plane.
* @param tree - candidate tree, usually reached through `entry.parent.tree`.
* @returns true when this tree is the global composition file.
*/
function ownsGlobalTree(tree) {
	if (isGlobalPlaneTree(tree)) return true;
	const owner = tree?.ctx?.fiber?.entry;
	return owner !== void 0 && INCLUDE_MODULES.includes(String(owner.options?.name));
}
/** One entry's descendants, including nested groups' rows. */
function* walkEntries(tree) {
	for (const entry of tree.entries()) {
		yield entry;
		const nested = entry.subtree;
		if (nested?.entries !== void 0) yield* walkEntries(nested);
	}
}
/**
* Create the preload gate for one host plugin instance.
* @param ctx - host context owning the loader and the agent-presets service.
* @param readMode - reads the committed loading mode on every reconcile.
* @param mountReader - synchronous reader of live preset revisions.
* @param warn - diagnostics sink for rows the gate cannot drive.
* @param observeFiber - subscribes to fiber publication, so a held row never
*   reaches its plugin callback. Omitted by callers that drive the gate by hand.
* @param onRowTaken - reports that this gate just took over one more row. The
*   caller uses it to refresh what it derives from the row set: taking a row
*   over is such a change, and it carries no event of its own, because a held
*   row never activates and the composition's own mount emits nothing.
* @returns the gate the tool registration consults.
*/
function createMcpPreloadGate(ctx, readMode, mountReader, warn, observeFiber, onRowTaken) {
	/** Runtime answers, keyed as {@link mcpRowKey}. */
	const states = /* @__PURE__ */ new Map();
	/** Row ids the publication observer held back, whether or not a mount is captured. */
	const held = /* @__PURE__ */ new Set();
	let presetRows = [];
	/** Serializes reconciles so an entry event cannot interleave with its own run. */
	let queue = Promise.resolve();
	let disposed = false;
	/**
	* The row's owning Loader entry, when this fiber is a composed row. A fiber
	* started by `ctx.plugin` outside any tree (an on-demand load, a managed
	* external mount) carries no entry and is never the gate's to hold back.
	*/
	const entryOf = (parent) => {
		const entry = parent?.[ENTRY_KEY];
		return entry === null || entry === void 0 ? void 0 : entry;
	};
	/**
	* Hold one row back at the only moment that can: before its plugin callback
	* runs. Disposal is synchronous, so Cordis skips the dependency resolution
	* that would have started the server; the row's own declaration keeps the
	* `disabled` flag so any later re-init of this entry returns without work.
	*/
	const holdAtPublication = (published) => {
		if (disposed || readMode() === "eager") return;
		const entry = published.entry ?? entryOf(published.fiber?.parent);
		if (entry === void 0 || entry.options.name !== "@deepseek-ai/dsh-mcp-client") return;
		if (entry.options.group === true) return;
		if (entry.options.id === void 0) return;
		const tree = published.tree ?? entry.parent?.tree ?? entry.parent;
		if (mountReader.ownsTree?.(tree) !== true) return;
		const entryId = presetLeafId(entry.options.id);
		held.add(entryId);
		heldRowIds.add(entryId);
		if (typeof tree?.filename === "string" && typeof tree.write === "function") {
			const row = entry;
			const previousDisabled = Object.getOwnPropertyDescriptor(row, "disabled");
			Object.defineProperty(row, "disabled", {
				configurable: true,
				enumerable: false,
				value: true
			});
			preHeld.set(entryId, {
				entry,
				global: true,
				undo: () => {
					if (previousDisabled === void 0) delete row.disabled;
					else Object.defineProperty(row, "disabled", previousDisabled);
				}
			});
		}
		try {
			published.fiber.dispose();
		} catch (error) {
			warn(`mcp-manager: cannot hold MCP row "${entryId}": ${String(error)}`);
		}
		if (preHeld.has(entryId)) return;
		if (entry.options.disabled !== true) Promise.resolve(entry.update({ disabled: true })).catch((error) => {
			warn(`mcp-manager: cannot mark MCP row "${entryId}" as held: ${String(error)}`);
		});
	};
	const unsubscribe = observeFiber?.(holdAtPublication);
	/**
	* Entries held before they could mount, keyed by the row id their options
	* turned out to name, with the override this gate installed on each.
	*/
	const preHeld = /* @__PURE__ */ new Map();
	/** Row ids the pre-mount hook holds back right now. */
	const heldRowIds = /* @__PURE__ */ new Set();
	/** Tagged entries, so the first `update` can be identified before the row is named. */
	const tagged = /* @__PURE__ */ new WeakSet();
	/** Tagged entries whose row id the Loader has not revealed yet. */
	const pendingPreHeld = /* @__PURE__ */ new Map();
	/**
	* Keep one composed row from mounting at all.
	*
	* A row that is created before this plugin's `apply` runs has no publication
	* to observe — the composition builds every entry, then imports each plugin.
	* This hook runs from `loader/entry-init`, which the Loader emits inside the
	* `Entry` constructor: before the options are assigned, before the parent
	* group is attached, before the fiber is created, and before the plugin that
	* starts the child process is imported.
	*
	* Because neither the options nor the tree exist yet, the entry is only
	* tagged here; {@link namePreHeld} decides, once the Loader assigns the
	* options, whether it is one of our rows. The tag makes the row read as
	* disabled by shadowing `Entry.disabled` on this one instance. The
	* declaration keeps the user's own answer, so the Loader's `update` returns
	* before `init`, and switching back to `eager` restores the row.
	* @param entry - the entry under construction.
	*/
	const holdBeforeMount = (entry) => {
		if (disposed || readMode() === "eager" || tagged.has(entry)) return;
		const row = entry;
		const previousDisabled = Object.getOwnPropertyDescriptor(row, "disabled");
		const previousUpdate = row.update;
		if (previousUpdate === void 0) return;
		tagged.add(entry);
		row.update = function(...args) {
			namePreHeld(entry, args[0]);
			return previousUpdate.apply(this, args);
		};
		Object.defineProperty(row, "disabled", {
			configurable: true,
			enumerable: false,
			value: true
		});
		pendingPreHeld.set(entry, () => {
			row.update = previousUpdate;
			if (previousDisabled === void 0) delete row.disabled;
			else Object.defineProperty(row, "disabled", previousDisabled);
			tagged.delete(entry);
		});
	};
	/**
	* Hand one row's pre-held entries back to their declarations. Called both
	* when the row leaves this gate's care (an `eager` commit) and on dispose, so
	* the override can never outlive the hold it expressed.
	* @param entryId - the row whose holds should be released.
	* @returns whether anything was released.
	*/
	const releasePreHeldRow = (entryId) => {
		heldRowIds.delete(entryId);
		const held = preHeld.get(entryId);
		if (held === void 0) return false;
		preHeld.delete(entryId);
		held.undo();
		return true;
	};
	/**
	* Hand one global row back, then let the Loader mount it.
	*
	* Dropping the hold alone is not enough: the row's entry never finished its
	* first `update`, so nothing will try to mount it until the include reloads.
	* `Entry.update` is the call that does it, and it persists nothing — only
	* `EntryTree.create`/`update`/`remove` and a fiber's self-dispose write the
	* include file.
	* @param entryId - the global entry to release.
	* @returns whether a global hold was released.
	*/
	const releaseGlobalHold = (entryId) => {
		const held = preHeld.get(entryId);
		if (held?.global !== true) return false;
		const { entry } = held;
		releasePreHeldRow(entryId);
		entry.update({ disabled: false }, false, true).catch((error) => {
			warn(`mcp-manager: cannot mount the global MCP row "${entryId}": ${String(error)}`);
		});
		return true;
	};
	/** Hand every pre-held row back to its own declaration. */
	const releasePreHeld = () => {
		for (const entryId of [...preHeld.keys()]) releasePreHeldRow(entryId);
		for (const undo of [...pendingPreHeld.values()]) undo();
		pendingPreHeld.clear();
		heldRowIds.clear();
	};
	/**
	* Decide whether a tagged entry really is one of this gate's rows, and name
	* it. Ownership is checked here rather than at the tag because the entry has
	* no options and no parent group while it is being constructed: only once the
	* Loader assigns them can this tell a preset row from a global one.
	*
	* The options are read from the intercepted call's own argument, not from the
	* entry: the Loader assigns `entry.options` inside `update`, so at this point
	* the entry still holds the previous (empty) set, and reading it would leave
	* the hold in place for every row the composition creates after this plugin
	* activated. Loading that hold is what would keep such a row from ever
	* mounting, not just an MCP one.
	* @param entry - the entry whose options are about to be assigned.
	* @param passed - the options this `update` call carries.
	*/
	const namePreHeld = (entry, passed) => {
		const undo = pendingPreHeld.get(entry);
		if (undo === void 0) return;
		const options = passed ?? entry.options;
		if (options?.name === void 0 || options.id === void 0) return;
		if (options.name !== "@deepseek-ai/dsh-mcp-client") {
			pendingPreHeld.delete(entry);
			undo();
			return;
		}
		const tree = entry.parent?.tree;
		const global = ownsGlobalTree(tree);
		if (!global && mountReader.ownsTree?.(tree) !== true) {
			pendingPreHeld.delete(entry);
			undo();
			return;
		}
		pendingPreHeld.delete(entry);
		const entryId = presetLeafId(options.id);
		preHeld.set(entryId, {
			entry,
			undo,
			global
		});
		heldRowIds.add(entryId);
		onRowTaken?.();
	};
	/**
	* Keep the composed global rows out of every composition that is not `eager`.
	*
	* A global row reaches the Loader's `update` before its plugin is imported, so
	* the in-memory hold that covers a preset row covers this one too. The gate
	* never writes these rows' options: their tree is the file-backed include, and
	* rewriting a row here would let a later include write serialize the gate's
	* state into the user's own composition file.
	* @returns the global rows the include currently mounts.
	*/
	const readGlobalRows = () => {
		const rows = [];
		const seen = /* @__PURE__ */ new Set();
		/** Rows sit either inside a file-backed include or directly in the root tree. */
		const trees = [];
		const loader = ctx.get("loader");
		for (const entry of loader?.entries() ?? []) if (isGlobalPlaneTree(entry.subtree)) trees.push(entry.subtree);
		else if (entry.options?.group !== true) continue;
		else if (entry.subtree !== void 0) trees.push(entry.subtree);
		for (const tree of trees) for (const entry of walkEntries(tree)) {
			const options = entry.options;
			if (options?.name !== "@deepseek-ai/dsh-mcp-client" || options.id === void 0) continue;
			const entryId = presetLeafId(options.id);
			if (seen.has(entryId)) continue;
			seen.add(entryId);
			rows.push({
				entryId,
				enabled: entry.options.disabled !== true,
				held: preHeld.get(entryId)?.global === true,
				mounted: (entry.fiber?.uid ?? null) !== null && entry.fiber?.state !== 4,
				config: entry.options.config
			});
		}
		return rows;
	};
	/**
	* Hold a global row that already mounted before this plugin existed.
	*
	* A row the composition builds inside its own Include — a patch-layer insert,
	* or the host's root composition — is created and imported while this plugin
	* is still being imported, so no entry-init subscription and no publication
	* can reach it. The row is therefore halted after the fact: the instance
	* shadow is installed **before** the fiber is disposed, because the Loader's
	* self-dispose branch persists `disabled` into the composition file unless the
	* entry already reads as disabled.
	* @param entry - the mounted global row to hold.
	* @returns whether the row was taken over.
	*/
	const holdMountedGlobal = (entry) => {
		const entryId = presetLeafId(String(entry.options.id));
		if (preHeld.has(entryId)) return false;
		const fiber = entry.fiber;
		if (fiber === void 0 || fiber.uid === null || fiber.dispose === void 0) return false;
		const row = entry;
		const previousDisabled = Object.getOwnPropertyDescriptor(row, "disabled");
		Object.defineProperty(row, "disabled", {
			configurable: true,
			enumerable: false,
			value: true
		});
		preHeld.set(entryId, {
			entry,
			global: true,
			undo: () => {
				if (previousDisabled === void 0) delete row.disabled;
				else Object.defineProperty(row, "disabled", previousDisabled);
			}
		});
		heldRowIds.add(entryId);
		try {
			Promise.resolve(fiber.dispose()).catch((error) => {
				warn(`mcp-manager: cannot hold the global MCP row "${entryId}": ${String(error)}`);
			});
		} catch (error) {
			warn(`mcp-manager: cannot hold the global MCP row "${entryId}": ${String(error)}`);
		}
		return true;
	};
	/**
	* One global row's live entry, found by the id the reader reports.
	* @param entryId - the row's leaf id.
	* @returns the entry, or undefined when the composition no longer carries it.
	*/
	const globalEntry = (entryId) => {
		const loader = ctx.get("loader");
		for (const entry of loader?.entries() ?? []) {
			const tree = entry.subtree;
			if (tree === void 0) continue;
			for (const candidate of walkEntries(tree)) {
				const options = candidate.options;
				if (options?.name === "@deepseek-ai/dsh-mcp-client" && options.id !== void 0 && presetLeafId(options.id) === entryId) return candidate;
			}
		}
	};
	const run = async () => {
		if (disposed) return;
		const mode = readMode();
		const mounts = mountReader(ctx.root.fiber);
		const seen = /* @__PURE__ */ new Set();
		const published = /* @__PURE__ */ new Set();
		const globals = /* @__PURE__ */ new Set();
		/** Rows this pass brought back to their composed state. */
		const resumed = /* @__PURE__ */ new Set();
		/** Rows this pass proved still exist, whether or not they could be driven. */
		const liveRows = /* @__PURE__ */ new Set();
		const nextRows = [];
		for (const row of readGlobalRows()) {
			const key = mcpRowKey({ scope: "global" }, row.entryId);
			globals.add(key);
			seen.add(key);
			liveRows.add(row.entryId);
			if (!row.enabled) {
				if (!published.has(key)) states.set(key, {
					allowed: false,
					suppressed: false
				});
				continue;
			}
			const wantMounted = mode === "eager";
			if (wantMounted) {
				held.delete(row.entryId);
				resumed.add(row.entryId);
				releaseGlobalHold(row.entryId);
			} else if (row.held) held.add(row.entryId);
			else if (row.mounted) {
				const entry = globalEntry(row.entryId);
				if (entry !== void 0 && holdMountedGlobal(entry)) held.add(row.entryId);
			}
			if (!published.has(key)) states.set(key, {
				allowed: true,
				suppressed: !wantMounted
			});
		}
		for (const mount of mounts) {
			let rows;
			try {
				rows = mount.declaration ?? findPresetDeclaration(ctx, mount.presetId).rows;
			} catch (error) {
				warn(`mcp-manager: cannot read preset "${mount.presetId}" composition: ${String(error)}`);
				continue;
			}
			const revisionRows = [];
			for (const entry of mount.tree.entries()) {
				if (entry.options.group === true || entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
				const leaf = presetLeafId(entry.options.id);
				const serverName = leaf;
				liveRows.add(leaf);
				const declaredRow = declaredMcpRows(rows, MCP_CLIENT_MODULE, entry.evaluate?.bind(entry)).find((row) => presetLeafId(row.options.id) === leaf);
				if (declaredRow === void 0) continue;
				const allowed = declaredRow.enabled === true && diagnoseRowConfig(declaredRow.options.config).length === 0;
				revisionRows.push({
					entryId: leaf,
					allowed,
					config: entry.options.config
				});
				const wantMounted = allowed && mode === "eager";
				const previous = entry.fiber;
				if (wantMounted && previous !== void 0 && (previous.state === 5 || previous.uid === null)) while (previous.inertia !== void 0) await previous.inertia;
				const key = mcpRowKey({
					scope: "preset",
					agentPreset: mount.presetId
				}, serverName);
				seen.add(key);
				if (wantMounted) {
					held.delete(leaf);
					resumed.add(leaf);
					releasePreHeldRow(leaf);
				} else heldRowIds.add(leaf);
				if ((entry.fiber !== void 0 && entry.fiber.uid !== null && entry.fiber.state !== 4 && entry.fiber.state !== 5) !== wantMounted || Boolean(entry.options.disabled) !== !wantMounted) try {
					await entry.update({ disabled: !wantMounted }, false, true);
				} catch (error) {
					warn(`mcp-manager: cannot ${wantMounted ? "mount" : "hold"} MCP row "${key}": ${String(error)}`);
					continue;
				}
				if (!published.has(key)) {
					states.set(key, {
						allowed,
						suppressed: allowed && !wantMounted
					});
					published.add(key);
				}
			}
			nextRows.push({
				presetId: mount.presetId,
				...mount.scope === void 0 ? {} : { scope: mount.scope },
				rows: revisionRows
			});
		}
		presetRows = nextRows;
		for (const key of [...states.keys()]) if (!seen.has(key)) states.delete(key);
		for (const entryId of [...held]) if (!resumed.has(entryId) && !liveRows.has(entryId)) held.delete(entryId);
	};
	const reconcile = () => {
		queue = queue.then(run, run);
		return queue;
	};
	return {
		reconcile,
		onPublish: holdAtPublication,
		onEntryInit: (entry) => {
			namePreHeld(entry);
			holdBeforeMount(entry);
		},
		globalRows: readGlobalRows,
		releaseGlobalHold,
		stateFor: (target, entryId) => states.get(mcpRowKey(target, presetLeafId(entryId))),
		presetRows: () => presetRows,
		suppressedKeys: () => [...states.entries()].filter(([, state]) => state.suppressed).map(([key]) => key),
		suppressedEntryIds: () => [...heldRowIds],
		dispose: () => {
			disposed = true;
			unsubscribe?.();
			releasePreHeld();
			states.clear();
			held.clear();
			presetRows = [];
		}
	};
}
/**
* The usage line for one on-demand mode.
*
* It has to name the tools that actually exist in that mode: `mcp_search` is
* only registered while the search setting is on, and `mcp_call` only exists
* under `lazy`, so the model is never sent after a tool it cannot call.
* @param mode - the on-demand loading mode the instruction must match.
* @param search - whether this deployment also registers `mcp_search`.
* @returns one line naming the tools that actually exist in that mode.
*/
function instruction(mode, search) {
	const find = search ? "Use `mcp_search` to find tools by what they do without loading a server, and " : "";
	return mode === "lazy" ? `MCP servers available on demand: ${find}call \`mcp_load\` with one of these names to list that server's tools — pass \`query\` to load only what matches, or \`tool\` for one tool and its argument schema — then \`mcp_call\` to invoke one, and \`mcp_unload\` with the same name to release it again.` : `MCP servers available on demand: ${find}call \`mcp_load\` with one of these names to add that server's tools to this session — pass \`query\` to add only what matches, or \`tool\` for one tool and its argument schema — and \`mcp_unload\` with the same name to release it again.`;
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
* @param search - whether the deployment also registers `mcp_search`.
* @returns the section text, or an empty string when nothing may be loaded,
*   which contributes no section at all.
*/
function renderMcpInventory(rows, mode, search = false) {
	if (rows.length === 0) return "";
	const head = instruction(mode, search);
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
//#region src/mcp-pool.ts
/**
* Host-level pool of on-demand MCP connections.
*
* A session's `mcp_load` starts a server; the connection then belongs to the
* host, not to that session. Every later load of the same row — from the same
* session, from another session, or from a sub-agent — reuses the live
* connection, so a `npx -y` server is paid for once per host lifetime instead
* of once per session. A session keeps a claim on the views it registered, and
* the connection closes when its last claim is released, either by
* `mcp_unload` or by the session ending.
*
* The pool is deliberately independent of the tool registration that owns it:
* the registration can be rebuilt (a committed loading-mode change) without the
* pool losing the connections it holds. That rebuild does release the sessions'
* claims, because the tools registered under the previous mode cannot stay, so
* a server with no other holder stops and the next `mcp_load` starts it again.
* Only plugin unload closes whatever is left.
*
* A connection can also end without this pool asking: a stdio child crashes, or
* an HTTP stream drops. The client's transport callback reports that ending, the
* connection leaves the pool, and the next load opens a fresh process instead of
* reusing a transport that is gone.
*
* @module @guowenzhang/dsh-mcp-manager/mcp-pool
*/
/**
* Connection identity for pooling.
*
* Two rows that resolve to the same transport and the same server namespace
* share one process; a changed command, URL, or credential opens a new
* connection. The digest is what reaches keys and logs — the config itself
* carries env values and headers, so it is never logged and never embedded in
* an error message.
* @param config - one row's resolved connection config.
* @returns a stable hex digest over the connection-relevant fields.
*/
function connectionFingerprint(config) {
	const identity = config.transport === "stdio" ? [
		"stdio",
		config.serverName,
		config.command,
		...config.args,
		config.cwd,
		...Object.entries(config.env).sort(([a], [b]) => a.localeCompare(b)).flat()
	] : [
		"streamable-http",
		config.serverName,
		config.url,
		...Object.entries(config.headers).sort(([a], [b]) => a.localeCompare(b)).flat()
	];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
}
/**
* Create one host-level pool.
* @param opener - connection and change-notification behavior.
* @returns the pool the tool registration shares across sessions.
*/
function createMcpConnectionPool(opener) {
	const entries = /* @__PURE__ */ new Map();
	let serial = Promise.resolve();
	const keyOf = (key) => `${key.rowKey}\u0000${key.fingerprint}`;
	/** One task at a time, so two sessions cannot open the same server twice. */
	const enqueue = (task) => {
		const run = serial.then(task, task);
		serial = run.then(() => void 0, () => void 0);
		return run;
	};
	/**
	* Follow one connection's transport and its tool-list changes.
	*
	* `end` is the connection's own ending gate. The transport callback reports
	* every ending, including the `close()` this pool asked for, so the decision
	* of whether the loss is real belongs to that gate rather than here.
	* @param connection - the connection being watched.
	* @param end - marks the connection unusable, reporting whether it was lost.
	*/
	const watch = (connection, end) => {
		connection.client.onclose = () => {
			end(true);
		};
		connection.client.fallbackNotificationHandler = async (notification) => {
			if (notification.method !== "notifications/tools/list_changed") return;
			try {
				if (opener.relist !== void 0) {
					const relisted = await opener.relist(connection.client);
					connection.tools = relisted.tools ?? [];
					connection.truncated = relisted.truncated ?? false;
					connection.ttlMs = relisted.ttlMs;
				} else connection.tools = (await connection.client.listTools()).tools ?? [];
				opener.onToolsChanged(connection);
			} catch (error) {
				opener.warn(`mcp-manager: could not follow the tool list change of "${connection.serverName}": ${String(error)}`);
				opener.onToolsChanged(connection, error);
			}
		};
	};
	/** Close one connection and forget it, whoever else still refers to it. */
	const close = async (connection) => {
		for (const [id, entry] of entries) if (entry.connection === connection) entries.delete(id);
		try {
			await connection.dispose();
		} catch (error) {
			opener.warn(`mcp-manager: could not stop "${connection.serverName}": ${String(error)}`);
		}
	};
	return {
		acquire: (key, config) => enqueue(async () => {
			const id = keyOf(key);
			const existing = entries.get(id)?.connection;
			if (existing !== void 0) {
				if (!existing.closed) return existing;
				entries.delete(id);
			}
			const pending = entries.get(id)?.opening;
			if (pending !== void 0) return await pending;
			const opening = (async () => {
				const { client, tools, truncated, ttlMs } = await opener.open(config);
				let closed = false;
				let lost = false;
				let disposed = false;
				/**
				* The one place a connection stops being usable. `dispose` runs it for
				* our own teardown; the transport callback runs it when the server died.
				* A lost connection leaves the pool at once, so the load that follows
				* opens a fresh process instead of being handed a transport that is
				* already gone, and its holders hear about it through the opener.
				*/
				const end = (byLoss) => {
					if (closed) return;
					closed = true;
					lost = byLoss;
					if (!byLoss) return;
					for (const [entryId, entry] of entries) if (entry.connection === connection) entries.delete(entryId);
					opener.warn(`mcp-manager: the connection to "${connection.serverName}" ended; the next load starts it again`);
					opener.onConnectionLost(connection);
				};
				const connection = {
					serverName: key.serverName,
					fingerprint: key.fingerprint,
					client,
					tools,
					truncated,
					...ttlMs === void 0 ? {} : { ttlMs },
					claims: /* @__PURE__ */ new Set(),
					get closed() {
						return closed;
					},
					get lost() {
						return lost;
					},
					dispose: async () => {
						if (disposed) return;
						disposed = true;
						end(false);
						await client.close();
					}
				};
				watch(connection, end);
				entries.set(id, { connection });
				return connection;
			})();
			entries.set(id, { opening });
			try {
				return await opening;
			} catch (error) {
				entries.delete(id);
				throw error;
			}
		}),
		claim: (key, connection, claimId) => {
			if (connection.closed) throw new Error(`the connection to "${connection.serverName}" is already closed`);
			const id = keyOf({
				...key,
				fingerprint: connection.fingerprint
			});
			if (entries.get(id)?.connection === void 0) entries.set(id, { connection });
			connection.claims.add(claimId);
		},
		release: (connection, claimId) => enqueue(async () => {
			if (!connection.claims.delete(claimId) || connection.claims.size > 0) return;
			await close(connection);
		}),
		retire: (key) => enqueue(async () => {
			const id = keyOf(key);
			const entry = entries.get(id);
			if (entry === void 0) return;
			entries.delete(id);
			if (entry.connection !== void 0) await close(entry.connection);
			else await entry.opening?.then(close, () => void 0);
		}),
		dispose: () => enqueue(async () => {
			const connections = [...new Set([...entries.values()].map((entry) => entry.connection).filter(Boolean))];
			entries.clear();
			await Promise.allSettled(connections.map((connection) => connection.dispose()));
		})
	};
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
/** Nonblocking declaration/status read: never calls the registry activation audit. */
function listMcpRows(ctx, gate, external) {
	const rows = [];
	const globals = /* @__PURE__ */ new Set();
	for (const row of gate.globalRows?.() ?? []) {
		globals.add(row.entryId);
		rows.push({
			target: { scope: "global" },
			entryId: row.entryId,
			serverName: row.entryId,
			key: mcpRowKey({ scope: "global" }, row.entryId),
			scopeLabel: "global",
			enabled: row.enabled,
			...row.held ? { held: true } : {}
		});
	}
	const loader = ctx.get("loader");
	for (const entry of loader?.entries() ?? []) {
		if (entry.options.group === true || entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
		const serverName = leafId(entry.id);
		if (globals.has(serverName)) continue;
		rows.push({
			target: { scope: "global" },
			entryId: entry.id,
			serverName,
			key: mcpRowKey({ scope: "global" }, serverName),
			scopeLabel: "global",
			enabled: entry.disabled !== true
		});
	}
	const revisions = gate.presetRows?.() ?? [];
	for (const preset of revisions) for (const row of preset.rows) {
		const serverName = leafId(row.entryId);
		const target = {
			scope: "preset",
			agentPreset: preset.presetId
		};
		rows.push({
			target,
			entryId: row.entryId,
			serverName,
			key: mcpRowKey(target, serverName),
			scopeLabel: `preset ${preset.presetId}`,
			enabled: row.allowed,
			...preset.scope === void 0 ? {} : { presetScope: preset.scope },
			presetConfig: row.config
		});
	}
	for (const row of external?.rows() ?? []) rows.push({
		target: { scope: "global" },
		entryId: row.owner,
		serverName: row.serverName,
		key: `external:${row.owner}:${row.serverName}`,
		scopeLabel: row.owner,
		enabled: true,
		externalConfig: row.config,
		externalKind: row.scope,
		...row.description === void 0 ? {} : { externalDescription: row.description },
		...row.scopeKey === void 0 ? {} : { externalScope: row.scopeKey }
	});
	return rows;
}
/** Read one row's connection spec through the authoring owner. */
async function describeRow(ctx, row) {
	const owner = ctx.get("mcpManager");
	if (owner === void 0) throw new Error("mcp_load requires the mcpManager service");
	if (row.presetConfig !== void 0) return specFromEntryConfig(row.presetConfig);
	return (await owner.describeMcp({
		target: row.target,
		entryId: row.entryId
	})).spec;
}
/** The tool names one server published into an agent's scope (dynamic mode). */
function toolNamesFor(tools, agentCtx, serverName, external) {
	const prefix = `mcp__${serverName}__`;
	return tools.schemas(external ? external.scopeOf(agentCtx) : scopeOf(agentCtx)).map((schema) => schema.name).filter((name) => name.startsWith(prefix));
}
/** How many `tools/list` pages one discovery walk follows before it gives up. */
const MAX_TOOL_PAGES = 64;
/** How many servers one search may connect at once while indexing them. */
const SEARCH_INDEX_CONCURRENCY = 3;
/** How long one indexing connection may take before its server is left unindexed. */
const SEARCH_INDEX_TIMEOUT_MS = 8e3;
/**
* Walk every page of one server's `tools/list`.
*
* The spec makes the page size the server's business and defines end-of-list as
* a missing `nextCursor`; an empty string is a valid cursor and must be passed
* back rather than read as the end. The walk stops at `maxTools` or at
* {@link MAX_TOOL_PAGES}, and reports that it did, so a listing can say it saw
* only part of what the server publishes.
* @param client - the connected SDK client.
* @param maxTools - how many tools the walk may collect.
* @returns the collected tools, whether the walk was cut short, and the
*   server's `ttlMs` hint when it sent one.
*/
async function listAllTools(client, maxTools) {
	const tools = [];
	let cursor;
	let ttlMs;
	for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
		const listed = await client.listTools(cursor === void 0 ? void 0 : { cursor });
		if (listed.ttlMs !== void 0 && Number.isFinite(listed.ttlMs) && listed.ttlMs >= 0) ttlMs = ttlMs === void 0 ? listed.ttlMs : Math.min(ttlMs, listed.ttlMs);
		let full = false;
		for (const tool of listed.tools ?? []) {
			if (tools.length >= maxTools) {
				full = true;
				break;
			}
			tools.push(tool);
		}
		const next = listed.nextCursor;
		if (full || next === void 0) return {
			tools,
			truncated: full,
			...ttlMs === void 0 ? {} : { ttlMs }
		};
		cursor = next;
	}
	return {
		tools,
		truncated: true,
		...ttlMs === void 0 ? {} : { ttlMs }
	};
}
/**
* Connect one configured server through the MCP SDK without registering anything.
* @param config - the row's resolved transport and namespace.
* @param options - the discovery budget; `maxTools` defaults to the policy's cap.
* @returns the connected client and the tools the server published. The caller
*   owns the client and must close it.
*/
async function connectLazy(config, options = {}) {
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
	try {
		await client.connect(transport);
		return {
			client,
			...await listAllTools(client, options.maxTools ?? MCP_OPTIMIZE_DEFAULTS.maxTools)
		};
	} catch (error) {
		await client.close().catch(() => {});
		throw error;
	}
}
/**
* Connect one configured server under a time budget, owning the client's
* lifetime on either outcome.
*
* `connectLazy` makes its caller the owner of the client it eventually
* produces, but a call that gives up on a slow server cannot close what it
* never received — and without this wrapper the connection finishes in the
* background anyway, its child process outliving the call forever. A connect
* that loses the race is closed as soon as it settles.
* @param config - the row's resolved transport and namespace.
* @param options - the discovery budget; `maxTools` defaults to the policy's cap.
* @param budgetMs - how long to wait for the server to answer.
* @returns the connected client and the tools the server published. The caller
*   owns the client and must close it.
*/
async function connectLazyWithin(config, options, budgetMs) {
	const pending = connectLazy(config, options);
	try {
		return await withBudget(pending, budgetMs);
	} catch (error) {
		pending.then(({ client }) => {
			client.close().catch(() => {});
		}, () => {});
		throw error;
	}
}
/**
* Every tool one row admits: its rules, the load's narrowing, and the policy.
*
* `visible` is what the row's rules and the annotation policy let through at
* all, and `admitted` is the subset the load itself asked for. A view keeps
* both: `visible` because a later load may widen into it, and `admitted` because
* that is what the session may actually call. `hidden` counts everything the
* session cannot call right now — both the rules' exclusions and the ones this
* load did not ask for — because that is the number the result reports.
* @param tools - the server's discovered tools.
* @param filter - the row's parsed rules.
* @param narrowing - the load's own subset, or undefined when it took everything.
* @param policy - the resolved optimization policy.
* @returns the visible set, the admitted subset, and how many tools are out.
*/
function admittedTools(tools, filter, narrowing, policy) {
	const visible = applyAnnotationPolicy(filterMcpTools(tools, filter).visible, policy).visible;
	const admitted = narrowing === void 0 ? visible : visible.filter(narrowing);
	return {
		visible,
		admitted,
		hidden: tools.length - admitted.length
	};
}
/**
* Register the on-demand MCP tools and the inventory section that names them.
* @param ctx - scope the tools belong to (the plugin's host context).
* @param mode - how a loaded server reaches the model.
* @param gate - the preload gate; it decides which composed rows this session
*   is allowed to load, and holds the rest out of every request.
* @param readers - live per-row rule, description, and policy readers.
* @param pool - the host-level connection pool every session shares.
* @param external - the registry of resource-plugin rows, when one is mounted.
* @param catalog - where discovery results are remembered between calls. Every
*   caller passes one; `index.ts` passes the shared instance so searches and
*   the settings page's catalogue read the same memory, across registrations.
* @returns the registration handle. `eager` registers no tool at all, and its
*   handle is an inert pair of no-ops.
*/
function registerMcpTools(ctx, mode, gate, readers = {
	filterFor: () => NO_TOOL_FILTER,
	descriptionFor: () => void 0
}, pool, external, catalog) {
	const tools = ctx.get("tools");
	if (tools === void 0 || mode === "eager") return {
		dispose: async () => {},
		refresh: async () => {},
		toolsChanged: () => {},
		connectionLost: () => {}
	};
	/** The mode whose tools exist; narrowed once so closures need no re-check. */
	const onDemandMode = mode;
	/** The policy as it stands at call time; the caller re-registers when the tool set must change. */
	const policyNow = () => readers.optimize?.() ?? MCP_OPTIMIZE_DEFAULTS;
	/**
	* Whether this registration includes `mcp_search`. Captured once at
	* registration time and used by the inventory text too, so the model is never
	* told about a tool this registration does not carry; the caller re-registers
	* the whole tool set when the setting flips (`mcpRegistrationKey`).
	*/
	const searchEnabled = policyNow().search;
	/**
	* The rows this session may load: composed rows the user has not disabled.
	* The gate is re-read first because a preset composition is also rebuilt when
	* its file changes, and a row that just came back would otherwise be treated
	* as still absent.
	*/
	const allowedRows = async (scope) => {
		await gate.reconcile();
		return listMcpRows(ctx, gate, external).filter((row) => row.externalConfig === void 0 ? row.enabled && (row.presetScope === void 0 || scope !== void 0 && (external ? external.scopeDistance(row.presetScope, scope) < Number.MAX_SAFE_INTEGER : scopeChainOf(scope).includes(row.presetScope))) : external?.visible({
			owner: row.entryId,
			serverName: row.serverName,
			config: row.externalConfig,
			scope: row.externalKind ?? "global",
			scopeKey: row.externalScope
		}, scope) === true).sort((a, b) => {
			const priority = (row) => row.externalKind === "agent" ? external?.scopeDistance(row.externalScope, scope) ?? Number.MAX_SAFE_INTEGER : row.externalConfig === void 0 ? 1e6 : 2e6;
			return priority(a) - priority(b);
		});
	};
	/** Session claims, keyed by agent id then serverName. */
	const views = /* @__PURE__ */ new Map();
	/** Sessions whose claims are already bound to their own context disposal. */
	const scopedAgents = /* @__PURE__ */ new Set();
	/** The agent behind one id, for a re-sync that has no execution context. */
	const agents = /* @__PURE__ */ new Map();
	/** Serial behind unique claim tokens: every load claims under its own. */
	let claimSerial = 0;
	/** In-flight search indexing by row key, so parallel searches share one connect. */
	const indexing = /* @__PURE__ */ new Map();
	/** Live tool registrations, undone by the returned disposer. */
	const registrations = [];
	/** Set by the returned disposer, so a late pool notification does nothing. */
	let disposed = false;
	const register = (definition) => {
		registrations.push(tools.register(definition));
	};
	const viewsFor = (agentId) => {
		const existing = views.get(agentId);
		if (existing !== void 0) return existing;
		const created = /* @__PURE__ */ new Map();
		views.set(agentId, created);
		return created;
	};
	/** The harness adapter, resolved once per activation; dynamic loads fail loud without it. */
	let adapter;
	const resolveAdapter = async () => {
		if (adapter !== void 0) return adapter;
		const found = (await resolveMcpClient(ctx)).createMcpToolDefinition;
		if (found === void 0) throw new Error("this harness build does not export createMcpToolDefinition from @deepseek-ai/dsh-mcp-client, so the tools of a server cannot be registered individually; select the \"lazy\" loading mode, or a harness build that provides the adapter");
		adapter = found;
		return found;
	};
	/**
	* Release one session's claim on one server: its own registrations first, then
	* the pool, which closes the connection only when no session holds it.
	*/
	const releaseView = async (agentId, serverName) => {
		const perAgent = views.get(agentId);
		const view = perAgent?.get(serverName);
		if (perAgent === void 0 || view === void 0) return false;
		perAgent.delete(serverName);
		if (perAgent.size === 0) views.delete(agentId);
		for (const dispose of [...view.definitions.values()].reverse()) dispose();
		view.definitions.clear();
		await pool.release(view.connection, view.claimId);
		return true;
	};
	/**
	* Everything one ended session held. The connection outlives the session —
	* another session (or the next turn of this one) reuses it — so a session end
	* only drops that session's tool registrations and its claims.
	* @param agentId - the session that ended.
	*/
	const releaseAgent = (agentId) => {
		scopedAgents.delete(agentId);
		const perAgent = views.get(agentId);
		if (perAgent === void 0) return;
		for (const serverName of [...perAgent.keys()]) releaseView(agentId, serverName);
	};
	/**
	* Bind one session's claims to its context, so ending the session releases
	* them. Registered once per session: the first load also covers every later
	* load in that session.
	* @param agent - the session that is loading a server.
	*/
	const bindAgentScope = (agent) => {
		if (scopedAgents.has(agent.id)) return;
		scopedAgents.add(agent.id);
		agent.ctx.effect(() => () => {
			releaseAgent(agent.id);
		}, `mcp-manager: mcp claims of ${agent.id}`);
	};
	/** Re-list one pooled connection's tools and rebuild every session's view of it. */
	const onToolsChanged = (connection) => {
		if (disposed) return;
		for (const rowKey of rowKeysByConnection(connection)) catalog.invalidate(rowKey);
		for (const [agentId, perAgent] of views) for (const [serverName, view] of perAgent) {
			if (view.connection !== connection) continue;
			resyncView(agentId, serverName, view).catch((error) => {
				ctx.logger.warn(`mcp-manager: could not follow the tool list change of "${serverName}": ${String(error)}`);
			});
		}
	};
	/**
	* Withdraw every session's view of a connection whose transport ended on its
	* own. The views go first and the claims after them: `releaseView` disposes
	* the registrations, and the pooled connection is already unusable, so the
	* release closes nothing that is not closed. The row stays in the on-demand
	* inventory, which is what lets the next `mcp_load` start the server again.
	*/
	const onConnectionLost = (connection) => {
		if (disposed) return;
		for (const rowKey of rowKeysByConnection(connection)) catalog.invalidate(rowKey);
		const holders = [];
		for (const [agentId, perAgent] of views) for (const [serverName, view] of perAgent) if (view.connection === connection) holders.push({
			agentId,
			serverName
		});
		for (const holder of holders) releaseView(holder.agentId, holder.serverName).catch((error) => {
			ctx.logger.warn(`mcp-manager: could not withdraw "${holder.serverName}": ${String(error)}`);
		});
	};
	/**
	* Apply a connection's new tool list to one session's view, using the rules
	* and the narrowing that session loaded with. A failed registration leaves the
	* session with the tools it already had.
	*/
	const resyncView = async (agentId, serverName, view) => {
		const selection = admittedTools(view.connection.tools, view.filter, view.admits, policyNow());
		view.tools = selection.visible;
		view.hidden = selection.hidden;
		view.truncated = view.connection.truncated;
		if (view.carrier === "proxy") return;
		const agent = agents.get(agentId);
		const registry = agent?.ctx.get("tools");
		if (agent === void 0 || registry === void 0) return;
		const adapter = await resolveAdapter();
		view.definitions = swapNativeTools(registry, view.definitions, nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, view.connection.client));
	};
	/** The row keys every live view of one connection was loaded under. */
	const rowKeysByConnection = (connection) => {
		const keys = /* @__PURE__ */ new Set();
		for (const perAgent of views.values()) for (const view of perAgent.values()) if (view.connection === connection) keys.add(view.rowKey);
		return keys;
	};
	/**
	* The model's only source for loadable server names: no server's tools are in
	* the request until a session loads one, so the names have to be published.
	* The text is a snapshot, refreshed through {@link McpToolRegistration.refresh}.
	*/
	let inventoryRows = [];
	const systemPrompt = ctx.get("systemPrompt");
	const inventorySection = systemPrompt?.section({
		name: "mcp-manager:on-demand",
		order: systemPrompt.getSectionOrder("MCP_SERVERS"),
		interpolate: false,
		text: (context) => renderMcpInventory(inventoryRows.filter((row) => row.presetScope !== void 0 ? context.scope !== void 0 && (external ? external.scopeDistance(row.presetScope, context.scope) < Number.MAX_SAFE_INTEGER : scopeChainOf(context.scope).includes(row.presetScope)) : row.externalConfig === void 0 || row.externalKind === "global" || context.scope !== void 0 && external?.visible({
			owner: row.entryId,
			serverName: row.serverName,
			config: row.externalConfig,
			scope: row.externalKind ?? "global",
			scopeKey: row.externalScope
		}, context.scope) === true).sort((a, b) => {
			const priority = (row) => row.externalKind === "agent" ? external?.scopeDistance(row.externalScope, context.scope) ?? Number.MAX_SAFE_INTEGER : row.externalConfig === void 0 ? 1e6 : 2e6;
			return priority(a) - priority(b);
		}).map((row) => {
			const description = row.externalDescription ?? readers.descriptionFor(row.key);
			return {
				name: row.serverName,
				...description === void 0 ? {} : { description }
			};
		}), onDemandMode, searchEnabled)
	});
	const refresh = async () => {
		await gate.reconcile();
		inventoryRows = listMcpRows(ctx, gate, external).filter((row) => row.externalConfig !== void 0 || row.enabled);
	};
	const stopAll = async () => {
		const pending = [];
		for (const agentId of [...views.keys()]) pending.push(...[...views.get(agentId)?.keys() ?? []].map((serverName) => releaseView(agentId, serverName).then(() => void 0)));
		views.clear();
		scopedAgents.clear();
		agents.clear();
		await Promise.allSettled(pending);
	};
	/**
	* Widen one view to a later load's subset.
	*
	* A session that loaded a server with a query may ask for more of it later.
	* The admitted set only ever grows, so a second query never takes away a tool
	* the session already has; a view that took everything has nothing to widen.
	* @param view - the session's live view of one pooled connection.
	* @param next - the subset the new load asks for.
	* @returns whether the admitted set grew, which is what needs a re-register.
	*/
	const widen = (view, next) => {
		const previous = view.admits;
		if (previous === void 0) return false;
		if (!view.tools.some((tool) => !previous(tool) && next(tool))) return false;
		view.admits = (tool) => previous(tool) || next(tool);
		return true;
	};
	/**
	* Widen one view back to the whole server.
	*
	* A load with neither `query` nor `tool` asks for everything the server
	* exposes, which is wider than any subset a previous load asked for — so a
	* narrowed view takes its filter-visible tools back. Like `widen`, this only
	* ever grows the admitted set: a tool the session already has stays callable.
	* @param view - the session's live view of one pooled connection.
	* @returns whether the admitted set grew, which is what needs a re-register.
	*/
	const widenToWhole = (view) => {
		const previous = view.admits;
		if (previous === void 0) return false;
		if (!view.tools.some((tool) => !previous(tool))) return false;
		delete view.admits;
		return true;
	};
	/** Rebuild one native view's registrations from its current admitted set. */
	const reregister = async (agentId, serverName, view) => {
		const agent = agents.get(agentId);
		const registry = agent?.ctx.get("tools");
		if (agent === void 0 || registry === void 0) return;
		const selection = admittedTools(view.connection.tools, view.filter, view.admits, policyNow());
		const adapter = await resolveAdapter();
		view.definitions = swapNativeTools(registry, view.definitions, nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, view.connection.client));
		view.tools = selection.visible;
		view.hidden = selection.hidden;
	};
	/** Remember one server's discovery result, honouring its own freshness hint. */
	const remember = (key, discovery, config, epoch) => {
		catalog.remember(config, discovery, key, Date.now(), epoch);
	};
	register(defineTool({
		name: "mcp_load",
		description: onDemandMode === "lazy" ? "Start one of the MCP servers listed in your system prompt for THIS session and add its tools to this session. The server then stays running and other sessions reuse the same process. Call the tools you need afterwards with `mcp_call`, passing the server name and tool name from this result. Pass `query` to add only the tools that match, `tool` to add exactly one tool and get its argument schema, and `cursor`/`limit` to page through a long listing. Only the tools this result reports are callable." : "Start one of the MCP servers listed in your system prompt for THIS session and add its tools to the request. The server then stays running and other sessions reuse the same process. Pass `query` to add only the tools that match, `tool` to add exactly one tool and get its argument schema, and `cursor`/`limit` to page through a long listing. Only the tools this result reports are callable.",
		parameters: {
			server: {
				type: "string",
				required: true,
				description: "The MCP server name to start, as listed in your system prompt."
			},
			query: {
				type: "string",
				description: "Only add tools whose name, title, or description contains every word of this text. Leave it out to add every tool the server is allowed to expose."
			},
			tool: {
				type: "string",
				description: "Add exactly this one tool (its upstream name) and report its full argument schema. Use it when you already know which tool you are going to call."
			},
			detail: {
				type: "string",
				description: "How much to report per tool: \"names\", \"summary\" (name and description), or \"full\" (adds the argument schema). Defaults to the session's configured level."
			},
			cursor: {
				type: "string",
				description: "The `nextCursor` of a previous result, to read the next page of the same listing."
			},
			limit: {
				type: "number",
				description: "How many tools this result may list. Defaults to the session's configured page size."
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
					total: {
						type: "number",
						required: true,
						description: "Tools this call selected, before paging."
					},
					shown: {
						type: "number",
						required: true,
						description: "Tools this result lists."
					},
					loaded: {
						type: "number",
						required: true,
						description: "Tools this session may now call on this server."
					},
					hidden: {
						type: "number",
						required: true,
						description: "Discovered tools this row's rules or the annotation policy keep out of the session."
					},
					truncated: {
						type: "boolean",
						required: true,
						description: "The server's own tool list was cut short by the configured collection cap."
					},
					nextCursor: {
						type: "string",
						description: "Pass this as `cursor` to read the next page of the same listing."
					},
					widened: {
						type: "boolean",
						description: "This call widened the session's view: a load without `query`/`tool` after a narrowed one, so every tool the row allows is callable now."
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
								title: {
									type: "string",
									description: "The display name the server published, when it did."
								},
								description: {
									type: "string",
									required: true
								},
								annotations: {
									type: "array",
									description: "Behaviour hints the server published (read-only, destructive, idempotent, open-world).",
									items: { type: "string" }
								},
								schema: {
									type: "string",
									description: "JSON schema of the tool arguments; present at the \"full\" detail level."
								}
							}
						}
					}
				}
			},
			render: (args, value) => [{
				type: "text",
				text: [
					`Started MCP server "${value.server}"; ${value.loaded} tool(s) are callable in this session${value.hidden === 0 ? "" : `, ${value.hidden} hidden`}.${value.total === 0 ? "" : ` Showing ${value.shown} of ${value.total} selected.`}`,
					...value.tools.map((tool) => `- ${tool.name}${tool.annotations === void 0 || tool.annotations.length === 0 ? "" : ` (${tool.annotations.join(", ")})`}${tool.title === void 0 ? "" : ` — ${tool.title}`}${tool.description === "" ? "" : `: ${tool.description}`}${tool.schema === void 0 ? "" : `\n  args: ${tool.schema}`}`),
					value.total === 0 ? args.query !== void 0 || args.tool !== void 0 ? "No tool on this server matched. Try different words, or call mcp_load without `query` to see everything." : "This server publishes no tool this row admits, so nothing was loaded." : "",
					value.nextCursor === void 0 ? "" : `More tools are available: call mcp_load again with cursor "${value.nextCursor}".`,
					value.widened === true ? `This call widened the session's view of "${value.server}": ${value.loaded} tool(s) are callable now.` : "",
					value.truncated ? "The server publishes more tools than this session collects; the tools beyond that cap are not collected anywhere and a `query` cannot reach them — raise the collection cap to see more." : ""
				].filter((line) => line !== "").join("\n")
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_load requires an owning agent session");
			const request = args;
			const serverName = String(request.server);
			const policy = policyNow();
			const limit = clampPageSize(request.limit, policy.pageSize);
			const query = typeof request.query === "string" ? request.query : "";
			const wanted = typeof request.tool === "string" && request.tool.trim() !== "" ? request.tool.trim() : void 0;
			const detail = parseDetailLevel(request.detail, policy, wanted !== void 0);
			const page = {
				cursor: request.cursor,
				limit
			};
			const existing = viewsFor(agent.id).get(serverName);
			if (existing !== void 0) {
				const narrowing = narrowingFor(query, wanted);
				const widened = narrowing === void 0 ? widenToWhole(existing) : widen(existing, narrowing);
				if (widened) await reregister(agent.id, serverName, existing);
				return reportLoad(existing, serverName, {
					query,
					wanted,
					detail,
					page,
					widened
				}, policy, () => toolNamesFor(tools, agent.ctx, serverName, external));
			}
			const row = (await allowedRows(external ? external.scopeOf(agent.ctx) : scopeOf(agent.ctx))).find((candidate) => candidate.serverName === serverName);
			if (row === void 0) throw new Error(`unknown or disabled MCP server "${serverName}" — load one of the MCP servers listed in your system prompt`);
			const config = row.externalConfig ?? mcpEntryConfig(await describeRow(ctx, row), serverName);
			const configIssue = diagnoseRowConfig(config);
			if (configIssue.length > 0) throw new Error(`MCP server "${serverName}" is not configured and cannot start: ${describeMcpConfigIssues(configIssue)}`);
			const filter = readers.filterFor(row.key);
			const narrowing = narrowingFor(query, wanted);
			const carrier = carrierFor(onDemandMode, filter, narrowing !== void 0);
			if (carrier === void 0) throw new Error("mcp_load is not registered under the \"eager\" loading mode");
			const key = {
				rowKey: row.key,
				serverName,
				fingerprint: connectionFingerprint(config)
			};
			const epoch = catalog.epoch;
			const connection = await pool.acquire(key, config);
			const claimId = `${agent.id}\u0000${claimSerial += 1}`;
			pool.claim(key, connection, claimId);
			remember(row.key, {
				tools: connection.tools,
				truncated: connection.truncated,
				...connection.ttlMs === void 0 ? {} : { ttlMs: connection.ttlMs }
			}, config, epoch);
			const selection = admittedTools(connection.tools, filter, narrowing, policy);
			if (narrowing !== void 0 && selection.admitted.length === 0) {
				await pool.release(connection, claimId);
				if (wanted === void 0) return {
					server: serverName,
					total: 0,
					shown: 0,
					loaded: 0,
					hidden: selection.hidden,
					truncated: connection.truncated,
					tools: []
				};
				const publishes = connection.tools.some((tool) => tool.name === wanted);
				throw new Error(publishes ? `MCP server "${serverName}" publishes the tool "${wanted}", but this row's rules or the annotation policy keep it out of this session` : `MCP server "${serverName}" publishes no tool "${wanted}" — use mcp_search to find the right name, or call mcp_load without \`tool\` to list what it does publish`);
			}
			const registry = agent.ctx.get("tools");
			if (registry === void 0) {
				await pool.release(connection, claimId);
				throw new Error("mcp_load requires the tools service");
			}
			let definitions = /* @__PURE__ */ new Map();
			if (carrier === "native") try {
				const adapter = await resolveAdapter();
				definitions = swapNativeTools(registry, /* @__PURE__ */ new Map(), nativeDefinitions(agent.ctx, adapter, serverName, selection.admitted, connection.client));
			} catch (error) {
				await pool.release(connection, claimId);
				throw error;
			}
			agents.set(agent.id, agent);
			const won = viewsFor(agent.id).get(serverName);
			if (won !== void 0) {
				for (const dispose of [...definitions.values()].reverse()) dispose();
				definitions.clear();
				await pool.release(connection, claimId);
				const widening = narrowing === void 0 ? widenToWhole(won) : widen(won, narrowing);
				if (widening) await reregister(agent.id, serverName, won);
				return reportLoad(won, serverName, {
					query,
					wanted,
					detail,
					page,
					widened: widening
				}, policy, () => toolNamesFor(tools, agent.ctx, serverName, external));
			}
			const view = {
				rowKey: row.key,
				carrier,
				claimId,
				connection,
				filter,
				tools: selection.visible,
				hidden: selection.hidden,
				truncated: connection.truncated,
				definitions,
				...narrowing === void 0 ? {} : { admits: narrowing }
			};
			viewsFor(agent.id).set(serverName, view);
			bindAgentScope(agent);
			return reportLoad(view, serverName, {
				query,
				wanted,
				detail,
				page
			}, policy, () => toolNamesFor(tools, agent.ctx, serverName, external));
		}
	}));
	if (searchEnabled) register(defineTool({
		name: "mcp_search",
		description: "Find MCP tools by what they do, across every server this session may load, without adding them to the session. Returns matching server/tool names with a one-line description; load the ones you need with `mcp_load`, which reports their argument schemas. Answers from tools already discovered; servers the Host has not catalogued are reported as not indexed.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "What the tool does, or part of its name. Every word must occur in the name, title, or description."
			},
			server: {
				type: "string",
				description: "Restrict the search to one server name. Omit it to search every server this session may load."
			},
			cursor: {
				type: "string",
				description: "The `nextCursor` of a previous result, to read the next page of matches."
			},
			limit: {
				type: "number",
				description: "How many matches this result may list. Defaults to the session's configured page size."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: {
						type: "string",
						required: true
					},
					total: {
						type: "number",
						required: true,
						description: "Matches found, before paging."
					},
					shown: {
						type: "number",
						required: true,
						description: "Matches this result lists."
					},
					nextCursor: {
						type: "string",
						description: "Pass this as `cursor` to read the next page of matches."
					},
					indexed: {
						type: "number",
						required: true,
						description: "Servers holding a tool list this search could read."
					},
					pending: {
						type: "array",
						required: true,
						description: "Servers with no tool list yet, which this search could not look inside.",
						items: { type: "string" }
					},
					hits: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								server: {
									type: "string",
									required: true
								},
								tool: {
									type: "string",
									required: true,
									description: "The server's own tool name."
								},
								title: {
									type: "string",
									description: "The display name the server published, when it did."
								},
								description: {
									type: "string",
									required: true
								},
								annotations: {
									type: "array",
									description: "Behaviour hints the server published (read-only, destructive, idempotent, open-world).",
									items: { type: "string" }
								}
							}
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: [
					`Tools matching "${value.query}": ${value.total} found, showing ${value.shown}.`,
					...value.hits.map((hit) => `- ${hit.server} · ${hit.tool}${hit.annotations === void 0 || hit.annotations.length === 0 ? "" : ` (${hit.annotations.join(", ")})`}${hit.title === void 0 ? "" : ` — ${hit.title}`}${hit.description === "" ? "" : `: ${hit.description}`}`),
					value.total === 0 ? "No match. Try other words, or load a server to see what it publishes." : "",
					value.pending.length === 0 ? "" : `Not indexed yet: ${value.pending.join(", ")}. Load one with \`mcp_load\` to make its tools searchable.`,
					value.nextCursor === void 0 ? "" : `More matches: call mcp_search again with cursor "${value.nextCursor}".`
				].filter((line) => line !== "").join("\n")
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_search requires an owning agent session");
			const request = args;
			const requestEpoch = catalog.epoch;
			const policy = policyNow();
			const limit = clampPageSize(request.limit, policy.pageSize);
			const query = String(request.query);
			const only = typeof request.server === "string" && request.server.trim() !== "" ? request.server.trim() : void 0;
			const rows = (await allowedRows(external ? external.scopeOf(agent.ctx) : scopeOf(agent.ctx))).filter((row) => only === void 0 || row.serverName === only);
			const configs = /* @__PURE__ */ new Map();
			for (const row of rows) try {
				const config = row.externalConfig ?? mcpEntryConfig(await describeRow(ctx, row), row.serverName);
				if (diagnoseRowConfig(config).length === 0) configs.set(row.key, config);
			} catch {}
			const discoveredNow = /* @__PURE__ */ new Map();
			const cached = (row) => {
				if (requestEpoch !== catalog.epoch) return void 0;
				const fresh = discoveredNow.get(row.key);
				if (fresh !== void 0) return fresh;
				const config = configs.get(row.key);
				return config === void 0 ? void 0 : catalog.getFor(row.key, config);
			};
			const stale = rows.filter((row) => {
				const config = configs.get(row.key);
				return cached(row) === void 0 && (policy.searchIndex || config !== void 0 && catalog.expiredFor(config));
			});
			if (stale.length > 0) await mapLimited(stale, SEARCH_INDEX_CONCURRENCY, async (row) => {
				if (disposed || requestEpoch !== catalog.epoch) return;
				const prior = indexing.get(row.key);
				if (prior !== void 0) {
					await prior.catch(() => {});
					return;
				}
				let finish;
				const turn = new Promise((resolve) => {
					finish = resolve;
				});
				indexing.set(row.key, turn);
				try {
					const config = configs.get(row.key);
					if (config === void 0) return;
					const epoch = requestEpoch;
					const { client, tools: listed, truncated, ttlMs } = await connectLazyWithin(config, { maxTools: policy.maxTools }, SEARCH_INDEX_TIMEOUT_MS);
					try {
						const discovery = {
							tools: listed,
							truncated,
							...ttlMs === void 0 ? {} : { ttlMs }
						};
						remember(row.key, discovery, config, epoch);
						if (epoch === catalog.epoch) discoveredNow.set(row.key, discovery);
					} finally {
						await client.close().catch(() => {});
					}
				} catch {} finally {
					finish();
					indexing.delete(row.key);
				}
			});
			const hits = [];
			const pending = [];
			let indexed = 0;
			for (const row of rows) {
				const entry = cached(row);
				if (entry === void 0) {
					pending.push(row.serverName);
					continue;
				}
				indexed += 1;
				const byRules = filterMcpTools(entry.tools, readers.filterFor(row.key)).visible;
				const admitted = applyAnnotationPolicy(byRules, policy).visible;
				for (const tool of matchTools(admitted, query)) {
					if (hits.length >= policy.maxTools) break;
					hits.push({
						server: row.serverName,
						tool: tool.name,
						...tool.title === void 0 ? {} : { title: tool.title },
						description: tool.description ?? "",
						...annotationTokens(tool, policy)
					});
				}
			}
			const paged = paginateTools(hits, request.cursor, limit);
			return {
				query,
				total: hits.length,
				shown: paged.page.length,
				indexed,
				pending,
				hits: paged.page,
				...paged.nextCursor === void 0 ? {} : { nextCursor: paged.nextCursor }
			};
		}
	}));
	if (onDemandMode === "lazy") register(defineTool({
		name: "mcp_call",
		description: "Call one tool of an MCP server that `mcp_load` started. Use the server and tool names from the mcp_load result; pass the tool arguments exactly as that result described them.",
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
			const view = viewsFor(agent.id).get(request.server);
			if (view === void 0) throw new Error(`MCP server "${request.server}" is not loaded for this session — call mcp_load first`);
			if (view.carrier !== "proxy") throw new Error(`MCP server "${request.server}" was loaded with its tools registered natively — call them by name instead`);
			if (!admittedOf(view).some((candidate) => candidate.name === request.tool)) throw new Error(`MCP server "${request.server}" exposes no tool "${request.tool}" in this session — call mcp_load to list the tools this session may call, or mcp_load that one tool by name`);
			const result = await view.connection.client.callTool({
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
		description: "Release an MCP server that `mcp_load` started for THIS session. The server keeps running while another session still uses it, and stops when this was the last session holding it.",
		parameters: { server: {
			type: "string",
			required: true,
			description: "The MCP serverName to release."
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
					released: {
						type: "boolean",
						required: true
					},
					stopped: {
						type: "boolean",
						required: true,
						description: "No session holds this server any more, so its process stopped."
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: !value.released ? `MCP server "${value.server}" was not loaded for this session.` : value.stopped ? `Released MCP server "${value.server}"; no session is using it any more, so it stopped.` : `Released MCP server "${value.server}" for this session; it stays running for the sessions still using it.`
			}]
		},
		async execute(args, exec) {
			const agent = exec.agent;
			if (agent === void 0) throw new Error("mcp_unload requires an owning agent session");
			const serverName = String(args.server);
			const view = views.get(agent.id)?.get(serverName);
			if (view === void 0) return {
				server: serverName,
				released: false,
				stopped: false
			};
			const connection = view.connection;
			await releaseView(agent.id, serverName);
			return {
				server: serverName,
				released: true,
				stopped: connection.claims.size === 0
			};
		}
	}));
	return {
		dispose: async () => {
			disposed = true;
			for (const dispose of [...registrations].reverse()) dispose();
			registrations.length = 0;
			inventorySection?.();
			inventoryRows = [];
			await stopAll();
		},
		refresh,
		toolsChanged: (connection) => {
			onToolsChanged(connection);
		},
		connectionLost: (connection) => {
			onConnectionLost(connection);
		}
	};
}
/**
* Read one stored `detail` value, converging anything else to the policy's level.
*
* Asking for one tool by name is asking for its arguments, so that request
* defaults to the full schema even under `namesOnly`; only an explicit `detail`
* can downgrade it.
* @param value - the model's request value.
* @param policy - the resolved policy, whose `namesOnly` picks the default.
* @param wanted - whether the request named one tool.
* @returns the level this result reports at.
*/
function parseDetailLevel(value, policy, wanted) {
	if (value === "names" || value === "summary" || value === "full") return value;
	if (wanted) return "full";
	return policy.namesOnly ? "summary" : "full";
}
/**
* Clamp one requested page size into the policy's range.
* @param value - the model's `limit`.
* @param fallback - the configured page size.
* @returns a whole number of tools this result may list.
*/
function clampPageSize(value, fallback) {
	const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(MCP_PAGE_SIZE_RANGE.max, Math.max(MCP_PAGE_SIZE_RANGE.min, parsed));
}
/**
* Turn one load request into the subset it asks for.
* @param query - the model's query text; blank selects nothing by itself.
* @param wanted - the one tool the model asked for by name, when it did.
* @returns the predicate that admits the subset, or undefined for "everything".
*/
function narrowingFor(query, wanted) {
	if (wanted !== void 0) return (tool) => tool.name === wanted;
	if (query.trim() === "") return void 0;
	return (tool) => toolMatchesQuery(tool, query);
}
/**
* Project one discovered tool onto the load result's per-tool shape.
*
* The model-facing name is the one this session must call: the public
* `mcp__<server>__<tool>` name under a native carrier, the raw name through
* `mcp_call` under the proxy. A mounted server's names come from the harness
* registry instead, which is why they are not built here.
* @param carrier - the carrier that exposed the tool.
* @param serverName - the row's namespace.
* @param tool - the discovered tool.
* @param detail - how much of the tool to report.
* @param policy - the resolved policy; decides whether annotations appear.
* @returns one result line.
*/
function toolView(carrier, serverName, tool, detail, policy) {
	const annotations = annotationSummary(tool, policy);
	const base = {
		name: visibleToolName(carrier, serverName, tool.name),
		...tool.title === void 0 ? {} : { title: tool.title },
		description: detail === "names" ? "" : tool.description ?? "",
		...annotations.length === 0 ? {} : { annotations: [...annotations] }
	};
	return detail === "full" ? {
		...base,
		schema: tool.inputSchema === void 0 ? "" : JSON.stringify(tool.inputSchema)
	} : base;
}
/**
* Build one `mcp_load` value from a live mount.
*
* `total` is what this call's selection covers, `loaded` is what the session may
* now call on the server, and `shown` is how much of the selection this page
* carries — the three numbers differ whenever the session narrowed a load or the
* listing is paged.
* @param mount - the live mount.
* @param serverName - the row's namespace.
* @param view - the query, the one tool asked for, the detail level, and the page.
* @param policy - the resolved policy.
* @param agent - the calling session, whose registry answers for a mounted server.
* @returns the canonical result value.
*/
function reportLoad(view, serverName, load, policy, registeredNames) {
	const admitted = admittedOf(view);
	const selected = load.wanted !== void 0 ? admitted.filter((tool) => tool.name === load.wanted) : load.query.trim() === "" ? admitted : matchTools(admitted, load.query);
	const paged = paginateTools(selected, load.page.cursor, load.page.limit);
	return {
		server: serverName,
		total: selected.length,
		shown: paged.page.length,
		loaded: admitted.length,
		hidden: view.hidden,
		truncated: view.truncated,
		tools: paged.page.map((tool) => toolView(view.carrier, serverName, tool, load.detail, policy)),
		...paged.nextCursor === void 0 ? {} : { nextCursor: paged.nextCursor },
		...load.widened === true ? { widened: true } : {}
	};
}
/** The admitted tools of one view: what the row's rules and this load left callable. */
function admittedOf(view) {
	return view.admits === void 0 ? view.tools : view.tools.filter(view.admits);
}
/** The annotation tokens a listing prints, as an optional result field. */
function annotationTokens(tool, policy) {
	const tokens = [...annotationSummary(tool, policy)];
	return tokens.length === 0 ? {} : { annotations: tokens };
}
/**
* Run `work` for every item, at most `limit` at a time.
* @param items - the items to process.
* @param limit - how many may be in flight at once.
* @param work - one item's work; a rejection is the caller's to handle.
*/
async function mapLimited(items, limit, work) {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			const item = items[index];
			if (item === void 0) return;
			await work(item);
		}
	});
	await Promise.all(workers);
}
/**
* Resolve `work`, or reject once it outlives `ms`.
* @param work - the operation to bound.
* @param ms - budget in milliseconds.
* @returns the operation's value when it settles inside the budget.
* @throws when the budget expires before the operation settles.
*/
async function withBudget(work, ms) {
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
/**
* Translate one fiber state into the roster's phase vocabulary.
*
* A row the gate held at publication has a disposed fiber, which is otherwise
* indistinguishable from a row that started and stopped. It is reported as
* `held` so the settings surface keeps showing the resting state D15 defines,
* instead of switching a working server's row to "stopped".
* @param state - the live fiber's state, absent when the entry has no fiber.
* @param held - whether the preload gate is holding this row back.
* @returns the phase the section renders.
*/
function phaseOf(state, held = false) {
	if (held) return "held";
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
	const configIssue = diagnoseRowConfig(source.options.config);
	return {
		entryId: source.entryId,
		moduleName: source.options.name,
		enabled: source.enabled,
		writable: true,
		fiberPhase: source.live ? phaseOf(source.state, source.held) : null,
		secretKeys: storedCredentialKeys(source.options.config),
		...configIssue.length === 0 ? {} : { configIssue }
	};
}
/** Whether a row names the MCP client bridge and is not a structural group. */
function isMcpRow(options) {
	return options.group !== true && options.name === "@deepseek-ai/dsh-mcp-client";
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
* @param heldEntryIds - row ids the preload gate is holding back right now.
* @param globalRows - the composed global rows the gate read from the include.
*   A global row lives inside the include's tree, not at the Loader root, so
*   this is the only read that finds it; the root entry list is the fallback for
*   a composition that mounts an mcp-client row directly.
* @returns the global rows, every declared preset with its rows, and whether the
*   global plane accepts writes.
*/
function readMcpRoster(ctx, mountReader, heldEntryIds = [], globalRows = []) {
	const held = new Set(heldEntryIds);
	const loader = ctx.get("loader");
	const entries = [];
	/**
	* The user's own file-backed Includes, which is where a global write lands.
	*
	* The host's root anchor is not one of them: `prepareProfile` rewrites its
	* file on every start. Counting it made a profile that declares its own
	* Include look like a two-Include composition, which closed the whole plane.
	*/
	const includes = writableGlobalIncludes(loader?.entries() ?? []);
	const fileRows = includes.length === 1 ? readEntryListRowsSync(includes[0].filename) : void 0;
	/** Why a global row cannot be written here, shared by every global row. */
	const globalReadOnly = includes.length === 0 ? "no-writable-include" : includes.length > 1 ? "several-writable-includes" : fileRows === void 0 ? "unreadable-include" : void 0;
	/**
	* Whether one global row is declared by the one writable Include's own file.
	*
	* A row a patch layer or the composition itself contributes exists only in
	* the live tree, so the file a global write patches has no row to update.
	*/
	const globalWritableRow = (entryId) => globalReadOnly === void 0 && findEntryRows(fileRows ?? [], presetLeafId(entryId)).length === 1;
	const globalRow = (row) => globalWritableRow(row.entryId ?? "") ? row : {
		...row,
		writable: false,
		...globalReadOnly === void 0 ? { readOnly: "composed-row" } : { readOnly: globalReadOnly }
	};
	const composedGlobals = /* @__PURE__ */ new Set();
	for (const row of globalRows) {
		composedGlobals.add(row.entryId);
		entries.push(globalRow(rosterRow({
			entryId: row.entryId,
			options: {
				id: row.entryId,
				name: MCP_CLIENT_MODULE,
				...row.config === void 0 ? {} : { config: row.config }
			},
			live: true,
			enabled: row.enabled,
			state: row.mounted ? FIBER_STATE.ACTIVE : void 0,
			held: row.held
		})));
	}
	if (loader !== void 0) for (const entry of loader.entries()) {
		if (!isMcpRow(entry.options) || composedGlobals.has(presetLeafId(entry.id))) continue;
		entries.push(globalRow(rosterRow({
			entryId: presetLeafId(entry.id),
			options: entry.options,
			live: true,
			enabled: entry.options.disabled !== true,
			state: entry.fiber?.state
		})));
	}
	const mounts = mountReader(ctx.root.fiber);
	const declared = listPresetDeclarations(ctx);
	return {
		entries,
		presets: (declared.length > 0 ? declared.map((declaration) => declaration.id) : [...new Set(mounts.map((mount) => mount.presetId))]).map((presetId) => {
			const declaration = declared.find((candidate) => candidate.id === presetId);
			const mount = mounts.find((candidate) => candidate.presetId === presetId);
			const sources = [];
			const declaredRowsForMount = declaration?.rows ?? mount?.declaration ?? [];
			if (mount === void 0) for (const row of declaredMcpRows(declaredRowsForMount, MCP_CLIENT_MODULE)) sources.push({
				entryId: typeof row.options.id === "string" && row.options.id !== "" ? row.options.id : null,
				options: row.options,
				live: false,
				enabled: row.enabled,
				state: void 0
			});
			else for (const row of mount.tree.entries()) {
				if (!isMcpRow(row.options)) continue;
				const leaf = presetLeafId(row.options.id);
				const declaredRow = declaredMcpRows(declaredRowsForMount, MCP_CLIENT_MODULE, row.evaluate?.bind(row)).find((candidate) => presetLeafId(candidate.options.id) === leaf);
				sources.push({
					entryId: leaf,
					options: row.options,
					live: true,
					enabled: declaredRow?.enabled ?? !row.disabled,
					state: row.fiber?.state,
					held: held.has(leaf)
				});
			}
			return {
				id: presetId,
				...declaration?.name === void 0 ? {} : { name: declaration.name },
				rows: sources.map(rosterRow)
			};
		}),
		globalWritable: includes.length === 1,
		...globalReadOnly === void 0 ? {} : { globalReason: globalReadOnly }
	};
}
//#endregion
//#region src/mcp-global-include.ts
/**
* Create the user's own file-backed Include that makes the global plane writable.
*
* A fresh profile mounts only the host's root anchor Include
* (`$DSH_HOME/profiles/<profile>/cordis.yml`), whose file `prepareProfile`
* regenerates on every start. The settings page therefore has no file it may
* patch, and the global plane is closed. The supported shape is a second,
* user-owned Include declared by the profile patch layer; this module writes
* exactly that row and the empty entry-list file it points at.
*
* The patch file is edited as text: the patch layer is hand-written YAML and may
* carry comments, so appending one block preserves everything already there.
* @module @guowenzhang/dsh-mcp-manager/mcp-global-include
*/
/** Loader id of the Include row this module inserts into the profile patch layer. */
const GLOBAL_INCLUDE_ID = "mcp-manager-global";
/** File name of the entry-list file the inserted Include owns. */
const GLOBAL_INCLUDE_FILE = "mcp.cordis.yml";
/** The Include module specifier a patch layer names for a file-backed tree. */
const INCLUDE_MODULE = "cordis:include";
/** Content of a newly created entry-list file: valid YAML with no rows. */
const EMPTY_ENTRY_LIST = "[]\n";
/**
* Parse one profile patch layer, requiring a top-level entry list.
* @param text - the patch file's content; empty content declares no patches.
* @returns the parsed patch entries.
* @throws when the file holds anything other than a YAML sequence.
*/
function parsePatchText(text) {
	const parsed = load(text, { schema: entryListSchema });
	if (parsed === void 0 || parsed === null) return [];
	if (!Array.isArray(parsed)) throw new Error("the profile patch layer must hold a top-level YAML sequence");
	return parsed;
}
/** The Include row a patch layer inserts, when this module wrote one already. */
function insertedInclude(patches) {
	for (const patch of patches) for (const row of patch.insert ?? []) {
		if (row.id !== "mcp-manager-global") continue;
		if (row.name !== INCLUDE_MODULE) throw new Error(`the profile patch layer already uses the loader id "${GLOBAL_INCLUDE_ID}" for a different plugin`);
		return row;
	}
}
/** The file path one Include row names, resolved beside the profile. */
function includeFilename(options, profileDir) {
	const config = options.config;
	if (config === null || typeof config !== "object") return void 0;
	const path = config.path;
	if (typeof path !== "string" || path === "") return void 0;
	if (path.startsWith("file:")) return fileURLToPath(path);
	return isAbsolute(path) ? path : resolve(profileDir, path);
}
/** The patch block that declares the user's global Include. */
function renderIncludeBlock() {
	return dump([{ insert: [{
		id: GLOBAL_INCLUDE_ID,
		name: INCLUDE_MODULE,
		config: {
			path: `./${GLOBAL_INCLUDE_FILE}`,
			initial: []
		}
	}] }], {
		schema: entryListSchema,
		lineWidth: -1,
		noRefs: true
	});
}
/**
* Append one top-level patch entry to the patch layer's text.
*
* A patch file the template left as a flow-style empty list (`[]`) cannot take
* a block entry after it, so the empty list is replaced instead of appended to;
* comment lines before it survive.
* @param text - current patch file content, possibly empty.
* @param block - the YAML block to add.
* @returns the next file content.
*/
function appendBlock(text, block) {
	const trimmed = text.trimEnd();
	if (trimmed === "") return block;
	const emptyFlow = /(?:^|\n)[ \t]*\[\][ \t]*$/u.exec(trimmed);
	if (emptyFlow !== null) {
		const cut = emptyFlow.index + (emptyFlow[0].startsWith("\n") ? 1 : 0);
		return `${text.slice(0, cut)}${block}`;
	}
	return text.endsWith("\n") ? `${text}${block}` : `${text}\n${block}`;
}
/**
* Decide what enabling the global plane would write, without touching the disk.
*
* Idempotent: a patch layer that already inserts the Include row is left alone,
* and the row's own path decides the target file, so a user who moved the file
* keeps it where it is.
* @param patchText - current profile patch layer content.
* @param profileDir - the profile directory new relative paths resolve against.
* @returns the target file and the patch text to commit.
* @throws when the patch layer is not a YAML sequence, or the id is taken by
*   another plugin.
*/
function planGlobalInclude(patchText, profileDir) {
	const existing = insertedInclude(parsePatchText(patchText));
	if (existing !== void 0) return {
		filename: includeFilename(existing, profileDir) ?? join(profileDir, "mcp.cordis.yml"),
		patchText,
		patchChanged: false
	};
	const filename = join(profileDir, GLOBAL_INCLUDE_FILE);
	const next = appendBlock(patchText, renderIncludeBlock());
	parsePatchText(next);
	return {
		filename,
		patchText: next,
		patchChanged: true
	};
}
/** Whether a path exists, without opening it. */
async function exists(path) {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}
/** One file's content, with a missing file read as empty. */
async function readTextOrEmpty(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}
/**
* Create the user's global Include when the profile has none, then reload.
*
* Writing the Include row into the patch layer is not enough on its own: the
* running composition is rebuilt from the patch layer by {@link options.reconcile},
* which is why a changed patch is followed by that call. An unchanged patch is
* not reloaded here — the caller decides whether the row is mounted.
* @param options - profile locations and the reload callback.
* @returns what this pass wrote.
* @throws when the patch layer cannot be parsed or the files cannot be written.
*/
async function ensureGlobalInclude(options) {
	const plan = planGlobalInclude(await readTextOrEmpty(options.patchPath), options.profileDir);
	const created = !await exists(plan.filename);
	if (created) await writeFileAtomic(plan.filename, EMPTY_ENTRY_LIST, {
		mode: 384,
		dirMode: 448
	});
	if (plan.patchChanged) await writeFileAtomic(options.patchPath, plan.patchText, { mode: 384 });
	if (plan.patchChanged) await options.reconcile();
	return {
		filename: plan.filename,
		created,
		patchChanged: plan.patchChanged
	};
}
//#endregion
//#region src/mcp-tokens.ts
/** Characters most tokenizers pack about four to a token. */
const CHARS_PER_TOKEN = 4;
/** CJK characters carry more each; about two of them are one token. */
const CJK_CHARS_PER_TOKEN = 2;
/** Han, kana, Hangul, and fullwidth forms: the ranges counted as CJK. */
const CJK = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;
/**
* Estimate the tokens one text costs.
* @param text - the text a request would carry.
* @returns the estimated token count, at least 1 for non-empty text.
*/
function estimateTokens(text) {
	const cjk = text.match(CJK)?.length ?? 0;
	return Math.max(1, Math.ceil((text.length - cjk) / CHARS_PER_TOKEN + cjk / CJK_CHARS_PER_TOKEN));
}
/**
* Estimate the tokens one tool definition adds to a request.
*
* The definition's own text is what is measured — the `name`, `title`,
* `description`, and `inputSchema` the model receives. The adapter's own
* wrapper is not modelled, so the number is comparable across tools rather than
* absolute.
* @param tool - the definition as the server published it.
* @returns the estimated token count.
*/
function estimateToolTokens(tool) {
	return estimateTokens(JSON.stringify({
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema
	}));
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
* Host service behind the `mcpManager` Remote namespace. Preset mutations
* update the resolved user's composition file; global mutations use the one
* unpatched root Include so Loader lifecycle and file state remain aligned.
*/
let McpManager = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listMcps_decorators;
	let _enableGlobalPlane_decorators;
	let _addMcp_decorators;
	let _editMcp_decorators;
	let _disableMcp_decorators;
	let _gateState_decorators;
	let _catalogState_decorators;
	let _refreshCatalog_decorators;
	let _clearCatalog_decorators;
	let _describeMcp_decorators;
	let _listMcpTools_decorators;
	return class McpManager extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listMcps_decorators = [Remote("listMcps")];
			_enableGlobalPlane_decorators = [Remote("enableGlobalPlane")];
			_addMcp_decorators = [Remote("addMcp")];
			_editMcp_decorators = [Remote("editMcp")];
			_disableMcp_decorators = [Remote("disableMcp")];
			_gateState_decorators = [Remote("gateState")];
			_catalogState_decorators = [Remote("catalogState")];
			_refreshCatalog_decorators = [Remote("refreshCatalog")];
			_clearCatalog_decorators = [Remote("clearCatalog")];
			_describeMcp_decorators = [Remote("describeMcp")];
			_listMcpTools_decorators = [Remote("listMcpTools")];
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
			__esDecorate(this, null, _enableGlobalPlane_decorators, {
				kind: "method",
				name: "enableGlobalPlane",
				static: false,
				private: false,
				access: {
					has: (obj) => "enableGlobalPlane" in obj,
					get: (obj) => obj.enableGlobalPlane
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
			__esDecorate(this, null, _catalogState_decorators, {
				kind: "method",
				name: "catalogState",
				static: false,
				private: false,
				access: {
					has: (obj) => "catalogState" in obj,
					get: (obj) => obj.catalogState
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _refreshCatalog_decorators, {
				kind: "method",
				name: "refreshCatalog",
				static: false,
				private: false,
				access: {
					has: (obj) => "refreshCatalog" in obj,
					get: (obj) => obj.refreshCatalog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clearCatalog_decorators, {
				kind: "method",
				name: "clearCatalog",
				static: false,
				private: false,
				access: {
					has: (obj) => "clearCatalog" in obj,
					get: (obj) => obj.clearCatalog
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
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		gate = __runInitializers(this, _instanceExtraInitializers);
		mountReader;
		external;
		loadingMode;
		optimize;
		catalog;
		static inject = ["loader"];
		mutationQueue = Promise.resolve();
		/**
		* Whether this process already tried the automatic global-Include creation.
		*
		* One attempt per host process: the creation is a composition write, and a
		* failed attempt leaves the page's explicit action as the retry — repeating it
		* on every roster read would rewrite a patch layer the user may be fixing.
		*/
		globalPlaneAutoTried = false;
		/**
		* @param ctx - host context.
		* @param gate - the preload gate the mutations must leave in line with the
		*   current loading mode.
		* @param mountReader - reader of the live agent-preset mounts, used by the
		*   roster read to report each preset row's current fiber phase.
		* @param external - the registry of resource-plugin rows.
		* @param loadingMode - live reader of the committed loading mode.
		* @param optimize - live reader of the policy, so both discovery entry points
		*   here collect as many tools as `mcp_load` would for the same row.
		* @param catalog - the discovery catalogue the settings page can inspect and clear.
		*/
		constructor(ctx, gate, mountReader, external, loadingMode, optimize, catalog = new McpCatalog()) {
			super(ctx, "mcpManager");
			this.gate = gate;
			this.mountReader = mountReader;
			this.external = external;
			this.loadingMode = loadingMode;
			this.optimize = optimize;
			this.catalog = catalog;
		}
		/** Register MCP definitions supplied by a resource plugin without writing user configuration. */
		async replaceExternalMcps(owner, ownerCtx, rows) {
			await this.external.replace(owner, ownerCtx, rows);
		}
		async removeExternalMcps(owner) {
			await this.external.remove(owner);
		}
		managedMcpMode() {
			return this.loadingMode();
		}
		/**
		* Report every MCP row the running composition declares, with the planes a
		* mutation can target.
		*
		* The first read of a host process also repairs the one state a fresh profile
		* cannot get out of by itself: no writable Include at all. Repairing on the
		* read that opens the settings page makes the global plane usable without any
		* extra click, while every later read is a pure roster read. The attempt is
		* made once per process; a failure keeps the roster's own read-only reason and
		* leaves the explicit action in the page for a retry.
		* @param request - empty placeholder; the roster is host-wide.
		* @returns the global rows, every declared preset with its rows, and whether
		*   the global plane accepts writes.
		*/
		async listMcps(request) {
			await this.autoEnableGlobalPlane();
			return readMcpRoster(this.ctx, this.mountReader, this.gate.suppressedEntryIds(), this.gate.globalRows?.() ?? []);
		}
		/**
		* Create the missing global Include on the first roster read of this process.
		*
		* The settings page cannot make the plane writable without a click otherwise,
		* and a fresh profile never has the file. This is the same creation the explicit
		* {@link enableGlobalPlane} call performs, run once; it never throws into the
		* read — a failure is logged and the roster reports the read-only reason, so the
		* page keeps its own retry action.
		* @returns a promise resolving after the one attempt, success or not.
		*/
		async autoEnableGlobalPlane() {
			if (this.globalPlaneAutoTried) return;
			this.globalPlaneAutoTried = true;
			if (this.writableIncludes().length !== 0) return;
			if (this.ctx.get("profileContext") === void 0) return;
			try {
				const result = await this.enqueue(() => this.ensureGlobalPlane());
				await this.gate.reconcile();
				if (!result.mounted) this.warnPatch("mcp-manager: created the global Include but the composition did not mount it; restart the host to apply it");
			} catch (cause) {
				this.warnPatch("mcp-manager: automatic global Include creation failed: %s", String(cause));
			}
		}
		/**
		* Make the global plane writable, creating the user's own Include when needed.
		*
		* A freshly installed profile mounts only the host's root anchor Include, whose
		* file the host regenerates on every start, so the settings page has nothing it
		* may patch and offers no global target. This call supplies that file: it
		* writes an entry-list file beside the profile and appends the patch row that
		* mounts it, then rebuilds the composition so the plane is writable in the same
		* session. A composition that already has exactly one writable Include is left
		* untouched, and one with several stays closed — no single file can be named.
		* @param request - empty placeholder; the plane is host-wide.
		* @returns what was written and whether a global write can land now.
		* @throws a typed MCP error when the profile patch layer cannot be written or
		*   the Include row does not mount.
		*/
		async enableGlobalPlane(request) {
			const result = await this.enqueue(() => this.ensureGlobalPlane());
			await this.gate.reconcile();
			return result;
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
		* Report what the discovery catalogue remembers.
		*
		* The catalogue is what lets `mcp_search` answer without starting a server, so
		* the settings page shows exactly how much is in it and how old it is; the
		* read touches no MCP row, so it is safe to call on every section render.
		* @param request - empty placeholder; the catalogue is host-wide.
		* @returns one row per remembered server, oldest first.
		*/
		async catalogState(request) {
			return {
				entries: this.catalog.stats(),
				total: this.catalog.size
			};
		}
		/** Explicitly re-discover current HTTP rows; local stdio catalogues are untouched. */
		async refreshCatalog(request) {
			return this.enqueue(async () => {
				if (!this.catalog.persistent) throw new RemoteError("mcp/unavailable", "The catalogue database is unavailable", { reason: "catalogue database unavailable" });
				const epoch = this.catalog.epoch;
				const configs = /* @__PURE__ */ new Map();
				let interrupted = false;
				const failed = [];
				const roster = readMcpRoster(this.ctx, this.mountReader, this.gate.suppressedEntryIds(), this.gate.globalRows?.() ?? []);
				const rows = [...roster.entries.map((row) => ({
					row,
					target: { scope: "global" }
				})), ...roster.presets.flatMap((preset) => preset.rows.map((row) => ({
					row,
					target: {
						scope: "preset",
						agentPreset: preset.id
					}
				})))];
				for (const { row, target } of rows) {
					if (row.entryId === null || row.enabled !== true) continue;
					try {
						const described = await this.describeMcp({
							target,
							entryId: row.entryId
						});
						const config = mcpEntryConfig(described.spec, described.serverName);
						if (config.transport !== "streamable-http") continue;
						configs.set(catalogIdentity(config), {
							key: target.scope === "global" ? `global:${described.serverName}` : `preset:${target.agentPreset}:${described.serverName}`,
							config
						});
					} catch {
						failed.push({
							serverName: row.entryId,
							reason: "The current connection configuration is unavailable"
						});
					}
				}
				for (const row of this.external.rows()) {
					if (row.config.transport !== "streamable-http") continue;
					configs.set(catalogIdentity(row.config), {
						key: `external:${row.owner}:${row.serverName}`,
						config: row.config
					});
				}
				let refreshed = 0;
				const pending = [...configs.values()];
				await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
					for (;;) {
						if (epoch !== this.catalog.epoch) {
							interrupted = true;
							return;
						}
						const next = pending.shift();
						if (next === void 0) return;
						const { key, config } = next;
						try {
							const connection = await connectLazyWithin(config, { maxTools: this.optimize().maxTools }, TOOL_LIST_TIMEOUT_MS);
							try {
								if (epoch !== this.catalog.epoch) throw new Error("catalogue changed");
								this.catalog.remember(config, connection, key, Date.now(), epoch);
								await this.catalog.flush();
								refreshed += 1;
							} finally {
								await connection.client.close().catch(() => {});
							}
						} catch {
							failed.push({
								serverName: config.serverName,
								reason: "The server did not refresh its tool catalogue or the database write failed"
							});
						}
					}
				}));
				if (interrupted || epoch !== this.catalog.epoch) throw new RemoteError("mcp/unavailable", "The catalogue changed during refresh; refresh again", { reason: "catalogue refresh interrupted" });
				return {
					refreshed,
					failed
				};
			});
		}
		/**
		* Forget every recorded discovery result.
		*
		* A running session keeps the tools it loaded — the catalogue only feeds
		* search and the settings page — so clearing is safe at any time and costs at
		* most one re-listing per server on the next search.
		* @param request - empty placeholder; the catalogue is host-wide.
		* @returns how many server records were dropped.
		*/
		async clearCatalog(request) {
			const cleared = this.catalog.clear();
			await this.catalog.flush();
			return { cleared };
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
				const entry = this.liveGlobalEntry(request.entryId, target);
				const serverName = serverNameOf(entry.options);
				if (serverName === void 0) throw invalid(target, "the MCP row has no valid serverName");
				return {
					target,
					entryId: presetLeafId(entry.options.id),
					serverName,
					spec: specFromEntryConfig(entry.options.config),
					disabled: entry.options.disabled === true
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
			const epoch = this.catalog.epoch;
			let connection;
			try {
				connection = await connectLazyWithin(config, { maxTools: this.optimize().maxTools }, TOOL_LIST_TIMEOUT_MS);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				throw new RemoteError("mcp/unavailable", `MCP server "${request.serverName}" did not answer a tool listing`, { reason }, { cause });
			}
			try {
				if (epoch !== this.catalog.epoch) throw new RemoteError("mcp/unavailable", "The tool catalogue was cleared while probing; test the connection again", { reason: "catalogue changed during probe" });
				this.catalog.remember(config, connection, void 0, Date.now(), epoch);
				if (!this.catalog.persistent) throw new RemoteError("mcp/unavailable", "MCP connected, but the catalogue database is unavailable", { reason: "catalogue database unavailable" });
				try {
					await this.catalog.flush();
				} catch {
					throw new RemoteError("mcp/unavailable", "MCP connected, but its tool catalogue could not be persisted", { reason: "catalogue database write failed" });
				}
				return { tools: connection.tools.map((tool) => ({
					name: tool.name,
					description: tool.description ?? "",
					tokens: estimateToolTokens(tool)
				})) };
			} finally {
				await connection.client.close().catch(() => {});
			}
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
					disabled: this.declaredDisabled(created)
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
		* Whether one global row's declaration disables it.
		*
		* The live instance property is the preload gate's own shadow, so it answers
		* "is the gate holding this row" rather than "did the user disable it". Every
		* answer this service reports about a global row comes from the declaration.
		* @param entry - the live global row.
		* @returns whether the row's own declaration disables it.
		*/
		declaredDisabled(entry) {
			return entry.options.disabled === true;
		}
		async edit(request) {
			const target = validateTarget(request.target);
			const config = configFromSpec(request.spec, request.serverName, target);
			validateEntryId(request.entryId, target, false);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const entry = this.liveGlobalEntry(request.entryId, target);
				this.assertServerNameAvailable([...include.tree.entries()], request.entryId, request.serverName, target);
				const rowId = entry.options.id;
				const written = await this.writeGlobalOne(include, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					config
				}, (fileRows) => {
					this.globalFileRow(fileRows, rowId, target, include.tree.filename);
					this.assertServerNameAvailable(fileRows, rowId, request.serverName, target);
				}, rowId);
				return {
					target,
					entryId: written.id,
					serverName: request.serverName,
					disabled: this.declaredDisabled(written)
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
				const entry = this.liveGlobalEntry(request.entryId, target);
				const serverName = serverNameOf(entry.options);
				if (serverName === void 0) throw invalid(target, "the MCP row has no valid serverName");
				const rowId = entry.options.id;
				if (!request.disabled) assertRunnableConfig(target, entry.options.config);
				const written = await this.writeGlobalOne(include, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					disabled: request.disabled
				}, (fileRows) => {
					this.globalFileRow(fileRows, rowId, target, include.tree.filename);
				}, rowId);
				return {
					target,
					entryId: written.id,
					serverName,
					disabled: this.declaredDisabled(written)
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
				const row = this.presetMcpRow(rows, entryId, target);
				serverName = serverNameOf(row) ?? entryId;
				if (!request.disabled) assertRunnableConfig(target, row.config);
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
		/** The writable Includes the running composition mounts, in composition order. */
		writableIncludes() {
			return writableGlobalIncludes(this.loader().entries());
		}
		/**
		* Create the user's global Include when the profile mounts none.
		*
		* The row goes into the profile patch layer, which is the only composition
		* layer that survives `prepareProfile`. Writing it is followed by a rebuild:
		* the patch layer is read at boot, so an in-session write is invisible until
		* the composition is reconciled through the boot package.
		* @returns what was written and whether the Include is mounted now.
		* @throws a typed MCP error when the plane is ambiguous, the host mounted no
		*   patch layer, or the patch write itself fails.
		*/
		async ensureGlobalPlane() {
			const before = this.writableIncludes();
			if (before.length > 1) throw new RemoteError("mcp/read-only", "the global plane has several writable Includes", {
				target: { scope: "global" },
				reason: `${before.length} file-backed Includes of your own are mounted, so no single file can be addressed`
			});
			if (before.length === 1) return {
				includePath: before[0].filename,
				created: false,
				patchChanged: false,
				mounted: true
			};
			const profile = this.ctx.get("profileContext");
			if (profile === void 0) throw new RemoteError("mcp/unavailable", "this host launched no profile, so it has no patch layer to declare a global Include in", { reason: "the profileContext service is unavailable" });
			const hmr = this.ctx.get("hmr");
			const create = async () => ensureGlobalInclude({
				profileDir: profile.dir,
				patchPath: profile.patchPath,
				reconcile: () => this.reloadProfileComposition(profile)
			});
			let created;
			try {
				created = hmr === void 0 ? await create() : await hmr.runExclusive(create);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				throw new RemoteError("mcp/invalid", "the profile patch layer could not be extended with a global Include", {
					target: { scope: "global" },
					reason
				}, { cause });
			}
			let mounted = this.writableIncludes().length === 1;
			if (!mounted) try {
				await this.reloadProfileComposition(profile);
				mounted = this.writableIncludes().length === 1;
			} catch (cause) {
				this.warnPatch("mcp-manager: global Include reload failed: %s", String(cause));
			}
			return {
				includePath: created.filename,
				created: created.created,
				patchChanged: created.patchChanged,
				mounted
			};
		}
		/**
		* Rebuild the composition from the profile's patch layers.
		*
		* The boot package owns the root Include and the reconciliation, so it is
		* resolved through the host module loader, the same way this plugin resolves
		* the other Harness runtime packages it does not bundle.
		* @param profile - profile facts read from the host.
		* @throws when the host exposes no loader bridge or no boot package.
		*/
		async reloadProfileComposition(profile) {
			const internal = this.loader().internal;
			if (internal === void 0) throw new Error("the Harness module loader is unavailable");
			const appBoot = await internal.import("@deepseek-ai/dsh-app-boot", this.ctx.baseUrl ?? import.meta.url, {});
			if (typeof appBoot.readProfilePatches !== "function" || typeof appBoot.reconcileProfilePatches !== "function") throw new Error("the Harness boot package does not expose profile reconciliation");
			const patches = appBoot.readProfilePatches("dsh", profile);
			await appBoot.reconcileProfilePatches(this.ctx.root, patches, "dsh");
		}
		async globalInclude(target) {
			const entries = [...this.loader().entries()];
			const mounted = entries.filter((entry) => isIncludeRow(entry.options) && entry.subtree !== void 0);
			const includes = writableGlobalIncludes(entries);
			if (includes.length !== 1) {
				const reason = includes.length === 0 ? mounted.some((entry) => isRootAnchorInclude(entry)) ? "the composition mounts only the host profile Include, whose file the host regenerates" : "no file-backed Include of your own is mounted" : `${includes.length} writable Includes are mounted`;
				throw new RemoteError(mounted.length === 0 ? "mcp/unavailable" : "mcp/read-only", "global MCP rows are written through a file-backed Include of your own", {
					target,
					reason
				});
			}
			const entry = includes[0].entry;
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
		/**
		* Locate one live global row without addressing its composition file.
		*
		* The row is found wherever the composition put it: inside a file-backed
		* Include's subtree, in a nested group there, or directly in the root tree
		* when a patch layer inserted it. Reading must not depend on which of those
		* shapes the profile used.
		* @param entryId - qualified or leaf row id.
		* @param target - the Remote target used in actionable failure details.
		* @returns the row's live entry.
		* @throws an MCP Remote error when the row is absent, ambiguous, or not an MCP row.
		*/
		liveGlobalEntry(entryId, target) {
			const leafId = presetLeafId(entryId);
			const found = /* @__PURE__ */ new Map();
			const visit = (tree) => {
				for (const entry of tree.entries()) {
					const id = entry.options.id;
					if (id !== leafId && entry.id !== entryId) {
						const nested = entry.subtree;
						if (nested?.entries !== void 0) visit(nested);
						continue;
					}
					found.set(presetLeafId(id), entry);
				}
			};
			for (const entry of this.loader().entries()) {
				if (entry.subtree === void 0) continue;
				visit(entry.subtree);
			}
			if (found.size === 0) throw new RemoteError("mcp/not-found", `MCP loader row "${entryId}" was not found`, {
				target,
				entryId
			});
			if (found.size > 1) throw conflict(target, entryId, void 0, "the row id occurs more than once");
			const entry = [...found.values()][0];
			if (entry.options.name !== "@deepseek-ai/dsh-mcp-client" || entry.options.group) throw invalid(target, `loader row "${entryId}" is not an MCP client row`);
			return entry;
		}
		/**
		* The row one global patch updates inside the addressed Include's own file.
		*
		* The file holds the user's rows only. A global row can also be live because
		* the composition or a patch layer declares it, and then the file has nothing
		* to patch: the write would either duplicate the row or fail late with a
		* message about a missing row. Refusing here states which plane owns it.
		* @param rows - the Include file's own rows, read under the write lock.
		* @param rowId - the live row's local id.
		* @param target - the global plane.
		* @param filename - the file the patch would edit.
		* @returns the file row the patch updates.
		* @throws an MCP Remote error when the file does not declare exactly this row.
		*/
		globalFileRow(rows, rowId, target, filename) {
			const found = findEntryRows(rows, rowId);
			if (found.length === 0) throw new RemoteError("mcp/read-only", `global MCP row "${rowId}" is not declared by ${filename}`, {
				target,
				reason: `the composition or a patch layer declares "${rowId}", so it cannot be switched from the settings page: only the rows inside ${filename} are editable there`
			});
			if (found.length > 1) throw conflict(target, rowId, void 0, "the row id occurs more than once");
			const row = found[0];
			if (row.name !== "@deepseek-ai/dsh-mcp-client" || row.group) throw invalid(target, `global row "${rowId}" is not an MCP client row`);
			return row;
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
/**
* Refuse to switch a row on while its connection config cannot start.
*
* The settings page closes the same door in the UI, but a row can also be
* enabled by hand-editing the profile patch, so the check runs Host-side where
* every path passes. Disabling is always allowed: a row that cannot start still
* has to be removable.
* @param target - the row being enabled, for the error's scope.
* @param config - the row's composed `mcp-client` config.
* @throws an MCP Remote error naming every gap.
*/
function assertRunnableConfig(target, config) {
	const issues = diagnoseRowConfig(config);
	if (issues.length > 0) throw invalid(target, `this MCP row is not configured and cannot be enabled: ${describeMcpConfigIssues(issues)}`);
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
//#region src/mcp-catalog-store.ts
/** Profile-isolated SQLite storage for local and remote MCP tool catalogues. */
const SCHEMA_VERSION = 1;
const MAX_RECORDS = 500;
const MAX_BYTES = 33554432;
const EMPTY_SNAPSHOT_BYTES = Buffer.byteLength(JSON.stringify({
	version: 1,
	entries: []
}));
const PUBLIC_TOOL_FIELDS = [
	"name",
	"title",
	"description",
	"inputSchema",
	"outputSchema",
	"annotations",
	"execution"
];
/** Use the Host's startup profile facts, never an implicit user-home fallback. */
function catalogDatabasePath(profile) {
	const namespace = createHash("sha256").update(profile.dir).digest("hex");
	return join(profile.home, "cache", "dsh-mcp-manager", namespace, "catalog.sqlite");
}
function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Project allowed fields before encoding; raw config and private tool properties never persist. */
function encodeRecord(value) {
	if (!object(value) || !object(value.entry)) throw new Error("invalid catalogue record");
	const nested = value.entry.transport;
	if (nested !== void 0 && nested !== value.transport) throw new Error("invalid catalogue transport");
	const candidate = {
		...value,
		entry: {
			...value.entry,
			transport: value.transport
		}
	};
	if (!validCatalogRecord(candidate)) throw new Error("invalid catalogue record");
	const record = {
		identity: candidate.identity,
		label: candidate.label,
		transport: candidate.transport,
		entry: {
			tools: candidate.entry.tools.map((tool) => Object.fromEntries(PUBLIC_TOOL_FIELDS.filter((field) => field in tool).map((field) => [field, Reflect.get(tool, field)]))),
			fetchedAt: candidate.entry.fetchedAt,
			truncated: candidate.entry.truncated,
			transport: candidate.transport,
			...candidate.entry.serverTtlMs === void 0 ? {} : { serverTtlMs: candidate.entry.serverTtlMs }
		}
	};
	const json = JSON.stringify(record);
	const bytes = Buffer.byteLength(json);
	if (bytes + EMPTY_SNAPSHOT_BYTES > MAX_BYTES) throw new Error("catalogue record exceeds size limit");
	return {
		record,
		json,
		bytes
	};
}
function snapshotIndex(value) {
	if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("invalid catalogue snapshot");
	const index = /* @__PURE__ */ new Map();
	for (const item of value.entries) {
		const encoded = encodeRecord(item);
		if (index.has(encoded.record.identity)) throw new Error("duplicate catalogue identity");
		index.set(encoded.record.identity, encoded);
	}
	return index;
}
function generationOf(db) {
	const rows = db.prepare("SELECT key, value FROM metadata").all();
	const generation = rows[0]?.value;
	if (rows.length !== 1 || rows[0]?.key !== "clear_generation" || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid catalogue metadata");
	return generation;
}
function assertColumns(db, table, expected) {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all();
	if (columns.length !== expected.length || columns.some((column, index) => {
		const [name, type, primary] = expected[index].split(":");
		return column.name !== name || column.type !== type || column.notnull !== 1 || column.pk !== Number(primary);
	})) throw new Error("unrecognized catalogue schema");
}
function prepareSchema(db, mayCreate) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	const objects = db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
	if (version === 0 && objects.length === 0 && mayCreate) db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
      CREATE TABLE catalog_entries (identity TEXT PRIMARY KEY NOT NULL, record_json TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('clear_generation', 0);
      PRAGMA user_version = ${SCHEMA_VERSION};`);
	else if (version !== SCHEMA_VERSION || objects.length !== 2 || objects[0]?.type !== "table" || objects[0]?.name !== "catalog_entries" || objects[1]?.type !== "table" || objects[1]?.name !== "metadata") throw new Error("unsupported catalogue database schema");
	assertColumns(db, "metadata", ["key:TEXT:1", "value:INTEGER:0"]);
	assertColumns(db, "catalog_entries", ["identity:TEXT:1", "record_json:TEXT:0"]);
	if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") throw new Error("invalid catalogue database");
	generationOf(db);
}
function readRecords(db) {
	const bounds = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record_json AS BLOB))), 0) AS bytes FROM catalog_entries").get();
	if (typeof bounds?.count !== "number" || typeof bounds.bytes !== "number" || bounds.count > MAX_RECORDS || bounds.bytes > MAX_BYTES) throw new Error("catalogue database exceeds size limit");
	const index = /* @__PURE__ */ new Map();
	for (const row of db.prepare("SELECT identity, record_json FROM catalog_entries ORDER BY rowid").all()) {
		if (typeof row.identity !== "string" || typeof row.record_json !== "string") throw new Error("invalid catalogue database record");
		const encoded = encodeRecord(JSON.parse(row.record_json));
		if (row.identity !== encoded.record.identity) throw new Error("invalid catalogue database identity");
		index.set(row.identity, encoded);
	}
	return index;
}
function totalBytes(index) {
	let bytes = EMPTY_SNAPSHOT_BYTES + Math.max(0, index.size - 1);
	for (const value of index.values()) bytes += value.bytes;
	return bytes;
}
/** Open only during an operation; a mere import never loads node:sqlite. */
function databaseCatalogStorage(filename) {
	let previous = /* @__PURE__ */ new Map();
	let baseline = 0;
	let queue = Promise.resolve();
	const enqueue = (operation) => {
		const run = queue.then(operation, operation);
		queue = run.then(() => void 0, () => void 0);
		return run;
	};
	const withDatabase = async (create, operation) => {
		if (create) {
			await mkdir(dirname(filename), {
				recursive: true,
				mode: 448
			});
			try {
				await (await open(filename, "wx", 384)).close();
			} catch (error) {
				if (error.code !== "EEXIST") throw error;
			}
		}
		try {
			if (!(await lstat(filename)).isFile()) throw new Error("catalogue database is not a regular file");
		} catch (error) {
			if (!create && error.code === "ENOENT") return void 0;
			throw error;
		}
		const { DatabaseSync: Database } = await import("node:sqlite");
		const db = new Database(filename);
		let transaction = false;
		try {
			db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
			transaction = true;
			prepareSchema(db, create);
			const result = operation(db);
			db.exec("COMMIT");
			transaction = false;
			return result;
		} catch (error) {
			if (transaction) try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			db.close();
		}
	};
	return {
		load: () => enqueue(async () => {
			const loaded = await withDatabase(false, (db) => {
				const generation = generationOf(db);
				const entries = readRecords(db);
				if (entries.size > MAX_RECORDS || totalBytes(entries) > MAX_BYTES) throw new Error("catalogue database exceeds size limit");
				return {
					generation,
					entries
				};
			});
			baseline = loaded?.generation ?? 0;
			previous = loaded?.entries ?? /* @__PURE__ */ new Map();
			return loaded === void 0 ? void 0 : {
				version: 1,
				entries: [...loaded.entries.values()].map((item) => item.record)
			};
		}),
		async save(value, clear = false) {
			const next = snapshotIndex(value);
			await enqueue(async () => {
				baseline = await withDatabase(true, (db) => {
					const currentGeneration = generationOf(db);
					if (!clear && currentGeneration !== baseline) throw new Error("catalogue cleared by another host; reload before writing");
					if (clear && currentGeneration === Number.MAX_SAFE_INTEGER) throw new Error("catalogue generation exhausted");
					const generation = clear ? currentGeneration + 1 : currentGeneration;
					const current = readRecords(db);
					const merged = clear ? /* @__PURE__ */ new Map() : current;
					const remove = db.prepare("DELETE FROM catalog_entries WHERE identity = ?");
					const insert = db.prepare("INSERT INTO catalog_entries (identity, record_json) VALUES (?, ?)");
					if (clear) db.exec("DELETE FROM catalog_entries");
					else for (const [identity, prior] of previous) if (!next.has(identity) && merged.get(identity)?.json === prior.json) {
						remove.run(identity);
						merged.delete(identity);
					}
					for (const [identity, item] of next) {
						if (!clear && previous.get(identity)?.json === item.json) continue;
						remove.run(identity);
						insert.run(identity, item.json);
						merged.delete(identity);
						merged.set(identity, item);
					}
					let bytes = totalBytes(merged);
					while (merged.size > MAX_RECORDS || bytes > MAX_BYTES) {
						const oldest = merged.keys().next().value;
						const item = merged.get(oldest);
						bytes -= item.bytes + (merged.size > 1 ? 1 : 0);
						merged.delete(oldest);
						remove.run(oldest);
					}
					db.prepare("UPDATE metadata SET value = ? WHERE key = 'clear_generation'").run(generation);
					return generation;
				});
				previous = next;
			});
		}
	};
}
//#endregion
//#region src/external-mcp.ts
/** The manager owns both the eager fibers and the definitions used by mcp_load. */
var ExternalMcpRegistry = class {
	mode;
	mount;
	changed;
	scopes;
	owners = /* @__PURE__ */ new Map();
	queue = Promise.resolve();
	closed = false;
	constructor(mode, mount, changed, scopes) {
		this.mode = mode;
		this.mount = mount;
		this.changed = changed;
		this.scopes = scopes;
	}
	scopeOf(ctx) {
		return this.scopes.scopeOf(ctx);
	}
	scopeDistance(owner, caller) {
		if (owner === void 0) return Number.MAX_SAFE_INTEGER;
		const distance = this.scopes.scopeChainOf(caller).indexOf(owner);
		return distance < 0 ? Number.MAX_SAFE_INTEGER : distance;
	}
	rows() {
		return [...this.owners].flatMap(([owner, value]) => value.rows.map((row) => ({
			...row,
			owner,
			scopeKey: this.scopes.scopeOf(value.ctx)
		})));
	}
	visible(row, scope) {
		return row.scope === "global" || row.scopeKey !== void 0 && this.scopes.scopeChainOf(scope).includes(row.scopeKey);
	}
	enqueue(operation) {
		const next = this.queue.then(operation, operation);
		this.queue = next.catch(() => {});
		return next;
	}
	replace(owner, ctx, rows) {
		return this.enqueue(() => this.replaceNow(owner, ctx, rows));
	}
	async replaceNow(owner, ctx, rows) {
		if (this.closed) throw new Error("MCP manager is stopping");
		if (!owner) throw new Error("MCP owner is required");
		const names = /* @__PURE__ */ new Set();
		const normalized = rows.map((row) => ({
			...row,
			config: row.config.transport === "stdio" ? {
				...row.config,
				args: row.config.args ?? [],
				env: row.config.env ?? {},
				cwd: row.config.cwd ?? ""
			} : {
				...row.config,
				headers: row.config.headers ?? {}
			}
		}));
		for (const row of normalized) {
			assertServerName(row.serverName);
			if (names.has(row.serverName)) throw new Error(`Duplicate managed MCP server: ${row.serverName}`);
			names.add(row.serverName);
			if (row.config.serverName !== row.serverName) throw new Error(`MCP server name mismatch: ${row.serverName}`);
			if (row.scope === "agent" && this.scopes.scopeOf(ctx) === void 0) throw new Error(`Agent MCP ${row.serverName} has no agent scope`);
		}
		const previous = this.owners.get(owner);
		if (previous?.ctx === ctx && JSON.stringify(previous.rows) === JSON.stringify(normalized)) return;
		if (previous) await this.removeNow(owner);
		const next = {
			ctx,
			rows: normalized,
			mounts: /* @__PURE__ */ new Map()
		};
		this.owners.set(owner, next);
		try {
			await this.reconcileOwner(next);
		} catch (error) {
			await this.removeNow(owner);
			throw error;
		}
		await this.changed();
	}
	remove(owner) {
		return this.enqueue(() => this.removeNow(owner));
	}
	async removeNow(owner) {
		const previous = this.owners.get(owner);
		if (!previous) return;
		await Promise.all([...previous.mounts.values()].map((mount) => mount.dispose()));
		this.owners.delete(owner);
		await this.changed();
	}
	reconcile() {
		return this.enqueue(() => this.reconcileNow());
	}
	async reconcileNow() {
		if (this.closed) return;
		await Promise.all([...this.owners.values()].map((owner) => this.reconcileOwner(owner)));
	}
	transition(before, after) {
		return this.enqueue(async () => {
			await before();
			await this.reconcileNow();
			await after();
		});
	}
	async reconcileOwner(owner) {
		if (this.mode() !== "eager") {
			await Promise.all([...owner.mounts.values()].map((mount) => mount.dispose()));
			owner.mounts.clear();
			return;
		}
		for (const row of owner.rows) {
			if (owner.mounts.has(row.serverName)) continue;
			owner.mounts.set(row.serverName, await this.mount(owner.ctx, row.config));
		}
	}
	dispose(before) {
		return this.enqueue(async () => {
			this.closed = true;
			await before?.();
			const previous = [...this.owners.values()];
			this.owners.clear();
			await Promise.allSettled(previous.flatMap((owner) => [...owner.mounts.values()].map((mount) => mount.dispose())));
		});
	}
};
//#endregion
//#region src/preset-mounts.ts
/** Plugin-owned, root-local weak state survives manager-only HMR/re-enablement. */
const PRESET_STATE = Symbol.for("@guowenzhang/dsh-mcp-manager:preset-state");
function presetState(ctx) {
	const root = ctx.root;
	if (root[PRESET_STATE] === void 0) Object.defineProperty(root, PRESET_STATE, { value: {
		trees: /* @__PURE__ */ new Set(),
		observed: /* @__PURE__ */ new WeakSet(),
		mounts: /* @__PURE__ */ new WeakMap()
	} });
	return root[PRESET_STATE];
}
/** Compare fiber identities, never registry-local numeric ids. */
function withinFiber(fiber, root) {
	const seen = /* @__PURE__ */ new Set();
	while (!seen.has(fiber)) {
		if (fiber === root) return true;
		seen.add(fiber);
		fiber = fiber.parent.fiber;
	}
	return false;
}
/** Keep only declaration/enablement metadata, not connection credentials. */
function declaredRows(rows) {
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		...row.disabled === void 0 ? {} : { disabled: structuredClone(row.disabled) },
		...row.group === true ? {
			group: true,
			config: declaredRows(Array.isArray(row.config) ? row.config : [])
		} : {}
	}));
}
/**
* Whether one loader tree is a preset mount rather than the host composition.
*
* Three answers, strongest first, because the callers ask at moments when the
* reader may know nothing yet:
*
* 1. A tree this reader already captured is that preset, by identity.
* 2. A tree whose owning entry chain reaches an agent-preset declaration is a
*    preset mount: rows are created before their declaration is captured, and
*    the row's own entry points at that declaration.
* 3. A tree whose context belongs to a standing scope is a preset mount. A
*    preset tree's context is not created by a Loader entry — its context fiber
*    carries no `entry` — so the scope on that context is the only structural
*    signal left, and it is the same predicate {@link createPresetMountReader}
*    uses to decide which trees to capture.
*
* The host composition's tree and every detached subtree owned by another
* plugin answer false at all three steps and keep their composed state.
* @param tree - candidate loader tree, usually reached through `entry.parent.tree`.
* @param known - the reader's captured trees, when it has any.
* @param scoped - whether a tree's context belongs to a standing preset scope.
* @returns true when this tree carries one agent preset's rows.
*/
function presetOwnedTree(tree, known, scoped) {
	if (tree === void 0 || tree === null) return false;
	if (known?.(tree) === true) return true;
	const entry = tree.ctx?.fiber?.entry;
	if (entry !== void 0) {
		const seen = /* @__PURE__ */ new Set();
		for (let row = entry; row !== void 0;) {
			if (seen.has(row)) break;
			seen.add(row);
			if (row.options?.name === "@deepseek-ai/dsh-agent-preset") return true;
			row = row.parent?.ctx?.fiber?.entry;
		}
	}
	return scoped?.(tree) === true;
}
/**
* Discover detached trees through public Loader entries. A registry no longer
* publishes mutable mounts, but every live entry still names its owning tree.
* A short-lived, empty scope parented to that tree lets `composedPreset` answer
* its identity through the public scope API, without reading registry internals
* or retaining/recomposing an Agent. No tool or service is registered there.
*
* The reader captures each revision's own declaration before the gate touches
* it. Old Agents therefore retain their old allowance, not the latest file's.
*/
function createPresetMountReader(ctx, scopes, onCaptured) {
	const state = presetState(ctx);
	const snapshots = state.mounts;
	let disposed = false;
	const observe = (value) => {
		if (disposed) return;
		const tree = value?.parent?.tree;
		if (tree !== void 0 && scopes.scopeOf(tree.ctx) !== void 0 && !state.observed.has(tree)) {
			state.observed.add(tree);
			state.trees.add(new WeakRef(tree));
		}
	};
	const read = (within = ctx.root.fiber) => {
		if (disposed) return [];
		const registry = ctx.get("agentPresets");
		if (registry === void 0) return [];
		if (typeof registry.composedPreset !== "function") throw new Error("mcp-manager: preset scope inspection is unavailable");
		const runtimes = ctx.registry.values();
		for (const runtime of runtimes) for (const fiber of runtime.fibers) observe(fiber.entry);
		const trees = [];
		for (const reference of state.trees) {
			const tree = reference.deref();
			if (tree === void 0 || tree.ctx.fiber.uid === null || tree.ctx.fiber.state === 4 || tree.ctx.fiber.state === 5) state.trees.delete(reference);
			else if (withinFiber(tree.ctx.fiber, within)) trees.push(tree);
		}
		const roots = trees.filter((tree) => !trees.some((other) => other !== tree && scopes.scopeOf(other.ctx) === scopes.scopeOf(tree.ctx) && withinFiber(tree.ctx.fiber, other.ctx.fiber)));
		const mounts = [];
		for (const tree of roots) {
			let mount = snapshots.get(tree);
			if (mount === void 0) {
				const key = scopes.scopeOf(tree.ctx);
				const probe = scopes.createScope(ctx, {}, { parent: key });
				let presetId;
				try {
					presetId = registry.composedPreset(probe.ctx);
				} finally {
					Promise.resolve(probe.dispose()).catch(() => ctx.logger.warn("mcp-manager: preset inspection scope cleanup failed"));
				}
				if (presetId === void 0) continue;
				mount = {
					presetId,
					tree,
					scope: key,
					declaration: declaredRows(tree.root.data)
				};
				snapshots.set(tree, mount);
				onCaptured?.(mount);
			}
			mounts.push(mount);
		}
		return mounts.sort((left, right) => (right.tree.ctx.fiber.uid ?? 0) - (left.tree.ctx.fiber.uid ?? 0));
	};
	return Object.assign(read, {
		observe,
		ownsTree: (tree) => presetOwnedTree(tree, (candidate) => snapshots.has(candidate), (candidate) => candidate?.ctx !== void 0 && scopes.scopeOf(candidate.ctx) !== void 0),
		dispose: () => {
			disposed = true;
		}
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
	tools: z.dict(z.any()).default({}).volatile(),
	optimize: z.dict(z.any()).default({}).volatile()
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
		tools: { ...config.tools.get() },
		optimize: { ...config.optimize.get() }
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
	/**
	* Fiber publication, subscribed before this `apply` yields.
	*
	* A composed row's fiber is published and activated as soon as the row is
	* created, so a listener installed after any `await` below can miss a row
	* that the composition activated while this plugin was still starting. Until
	* the gate exists the publications are counted, not held: a fiber that is
	* already running cannot be kept from spawning, so the honest answer is a
	* report and the Loader-driven reconcile fallback.
	*/
	const fibers = ctx;
	let publish = () => {
		missedPublications += 1;
	};
	let missedPublications = 0;
	const earlySubscription = fibers.on("internal/plugin", (fiber) => {
		publish(fiber);
	});
	ctx.effect(() => () => {
		earlySubscription();
	}, "mcp-manager: fiber publication subscription");
	/**
	* Row creation, observed from the same first statement.
	*
	* A composed row is built before this plugin is imported, so its fiber is
	* never published while the gate is listening. `loader/entry-init` fires
	* inside the entry's constructor — earlier than the fiber, earlier than the
	* plugin import — which is where a row can still be kept from mounting.
	* Entries seen before the gate exists are replayed when it does.
	*/
	const pendingEntries = [];
	let entryInit;
	const earlyEntrySubscription = fibers.on("loader/entry-init", (entry) => {
		if (entryInit === void 0) pendingEntries.push({ entry });
		else entryInit(entry);
	});
	ctx.effect(() => () => {
		earlyEntrySubscription();
	}, "mcp-manager: entry creation subscription");
	const profile = ctx.get("profileContext");
	const catalog = new McpCatalog(profile?.home && profile.dir ? databaseCatalogStorage(catalogDatabasePath({
		home: profile.home,
		dir: profile.dir
	})) : {
		async load() {
			throw new Error("catalogue database profile is unavailable");
		},
		async save() {
			throw new Error("catalogue database profile is unavailable");
		}
	}, () => {
		ctx.logger.warn("mcp-manager: tool catalogue database is unavailable or invalid");
	});
	await catalog.restore();
	ctx.effect(() => async () => {
		await catalog.close().catch(() => {});
	}, "mcp-manager: catalogue writes");
	const loader = ctx.get("loader");
	if (!loader.internal) throw new Error("mcp-manager: Harness module loader is unavailable");
	const scopes = await loader.internal.import("@deepseek-ai/dsh-scope", ctx.baseUrl ?? import.meta.url, {});
	if (typeof scopes.scopeOf !== "function" || typeof scopes.scopeChainOf !== "function" || typeof scopes.createScope !== "function") throw new Error("mcp-manager: Harness scope helpers are unavailable");
	const rowTaken = {};
	const mountReader = createPresetMountReader(ctx, scopes, () => {
		queueMicrotask(() => {
			rowTaken.current?.();
		});
	});
	ctx.effect(() => () => {
		mountReader.dispose();
	}, "mcp-manager: preset mount reader");
	/**
	* Resolve a published fiber to its owning row without the gate.
	*
	* This runs only while the gate is still being built, and only to keep a
	* composed MCP row's publication from going unreported: a row that got this
	* far is already running, so the Loader-driven reconcile has to stop it.
	*/
	const mcpRowOf = (fiber) => {
		const entry = fiber?.parent?.[Symbol.for("cordis.entry")];
		if (entry?.options?.name !== "@deepseek-ai/dsh-mcp-client") return void 0;
		return entry.options.id;
	};
	const gate = createMcpPreloadGate(ctx, () => mcpLoading, mountReader, (message) => {
		ctx.logger.warn(message);
	}, void 0, () => {
		queueMicrotask(() => {
			rowTaken.current?.();
		});
	});
	if (missedPublications > 0) ctx.logger.warn(`mcp-manager: ${missedPublications} fiber(s) appeared while this plugin was still starting, before the preload gate existed; any composed MCP row among them started and is stopped again by the row synchronization`);
	publish = (fiber) => {
		const missed = mcpRowOf(fiber);
		if (missed !== void 0) ctx.logger.warn(`mcp-manager: MCP row "${missed}" was published before the preload gate existed, so it may have started once; the row synchronization stops it and it stays held from here on`);
		gate.onPublish({ fiber });
	};
	entryInit = (entry) => {
		gate.onEntryInit(entry);
	};
	for (const pending of pendingEntries.splice(0)) entryInit(pending.entry);
	ctx.effect(() => () => {
		gate.dispose();
	}, "mcp-manager: preload gate");
	let readToolFilter = () => NO_TOOL_FILTER;
	const readers = {
		filterFor: (key) => readToolFilter(key),
		descriptionFor: (key) => readSettings().descriptions[key],
		optimize: () => parseMcpOptimizeFlags(readSettings().optimize)
	};
	/** What a live connection does when the server announces a new tool list. */
	let changed = () => {};
	/** What a live connection does when its transport ends without us closing it. */
	let lost = () => {};
	const pool = createMcpConnectionPool({
		open: (config) => connectLazy(config, { maxTools: readers.optimize().maxTools }),
		relist: (client) => listAllTools(client, readers.optimize().maxTools),
		onToolsChanged: (connection) => {
			changed(connection);
		},
		onConnectionLost: (connection) => {
			lost(connection);
		},
		warn: (message) => {
			ctx.logger.warn(message);
		}
	});
	ctx.effect(() => async () => {
		await pool.dispose();
	}, "mcp-manager: on-demand connections");
	const active = {};
	const activate = (next) => {
		const registration = registerMcpTools(ctx, next, gate, readers, pool, external, catalog);
		active.current = registration;
		changed = (connection) => {
			registration.toolsChanged(connection);
		};
		lost = (connection) => {
			registration.connectionLost(connection);
		};
		return registration;
	};
	const external = new ExternalMcpRegistry(() => mcpLoading, async (ownerCtx, entryConfig) => {
		const module = await resolveMcpClient(ctx);
		return await ownerCtx.plugin({
			name: module.name,
			inject: module.inject,
			apply: module.apply
		}, {
			...entryConfig,
			failOnStartupError: true
		});
	}, async () => {
		await active.current?.dispose();
		await activate(mcpLoading).refresh();
	}, scopes);
	new McpManager(ctx, gate, mountReader, external, () => mcpLoading, () => readers.optimize(), catalog);
	activate(mcpLoading);
	/**
	* The registered tool set's identity: what a re-registration is keyed on.
	*
	* The loading mode decides which on-demand tools exist, and the policy
	* decides whether `mcp_search` exists at all — a registered tool set is what
	* the request prefix carries, so those two answers rebuild it. Every other
	* policy field is read live at the call site.
	*/
	let registrationKey = `${mcpLoading}|${mcpRegistrationKey(readers.optimize())}`;
	ctx.effect(() => async () => {
		await external.dispose(async () => {
			await active.current?.dispose();
			gate.dispose();
		});
	}, "mcp-manager: mcp tools");
	let syncing = false;
	let dirty = false;
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
	}, "mcp-manager: row synchronization");
	const resync = () => {
		if (stopped) return;
		dirty = true;
		if (syncing) return;
		syncing = true;
		(async () => {
			try {
				while (dirty && !stopped) {
					dirty = false;
					await gate.reconcile();
					await active.current?.refresh();
				}
			} catch (error) {
				ctx.logger.warn(`mcp-manager: row synchronization failed: ${String(error)}`);
			} finally {
				syncing = false;
			}
		})();
	};
	rowTaken.current = resync;
	const events = ctx;
	for (const event of MCP_ROW_EVENTS) ctx.effect(() => events.on(event, (...args) => {
		if (event === "loader/entry-init") {
			queueMicrotask(() => {
				mountReader.observe(args[0]);
				resync();
			});
			return;
		}
		if (event === "internal/status") {
			const moduleName = args[0]?.entry?.options?.name;
			if (moduleName !== "@deepseek-ai/dsh-mcp-client" && moduleName !== "@deepseek-ai/dsh-agent-preset") return;
		}
		resync();
	}), `mcp-manager: gate follows ${event}`);
	await gate.reconcile();
	await active.current?.refresh();
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
	const commit = async () => {
		const next = readSettings();
		const mode = parseMcpLoadingMode(next.loading);
		const nextKey = `${mode}|${mcpRegistrationKey(parseMcpOptimizeFlags(next.optimize))}`;
		if (nextKey !== registrationKey) {
			await external.transition(async () => {
				await active.current?.dispose();
				mcpLoading = mode;
			}, async () => {
				const registration = activate(mode);
				await registration.refresh();
				await gate.reconcile();
				await registration.refresh();
			});
			registrationKey = nextKey;
		}
		warnFiltersWithoutEffect(next);
	};
	let commits = Promise.resolve();
	ctx.effect(() => ctx.on("loader/volatile-update", () => {
		commits = commits.then(commit, commit).catch((error) => {
			ctx.logger.warn(`mcp-manager: settings reload failed: ${String(error)}`);
		});
	}), "mcp-manager: settings commits");
	readToolFilter = (key) => parseMcpToolFilter(readSettings().tools[key]);
	warnFiltersWithoutEffect(readSettings());
}
//#endregion
export { Config, MCP_LOADING_MODES, MCP_MAX_TOOLS_RANGE, MCP_OPTIMIZE_DEFAULTS, MCP_PAGE_SIZE_RANGE, MCP_SETTINGS_NAMESPACE, McpCatalog, McpManager, admits, annotationSummary, apply, applyAnnotationPolicy, assertServerName, carrierFor, connectLazy, decodeToolCursor, encodeToolCursor, filterHidesAnything, filterMcpTools, flattenSpec, inject, listAllTools, matchTools, mcpEntryConfig, mcpRegistrationKey, mcpRowKey, name, paginateTools, parseMcpLoadingMode, parseMcpOptimizeFlags, parseMcpToolFilter, parseSpecText, parseSpecValue, readMcpSettings, registerMcpTools, secretKeys, serverNameFromCommand, specFromEntryConfig, specFromObject, toolMatchesQuery, toolRuleEntries };
