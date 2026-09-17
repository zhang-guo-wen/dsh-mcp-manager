import z from "@deepseek-ai/schemastery";
import { livePresetMounts } from "@deepseek-ai/dsh-agent-presets";
import { access, constants, lstat, readFile } from "node:fs/promises";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { applyEntryPatches, entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { scopeOf } from "@deepseek-ai/dsh-scope";
//#region src/mcp-authoring.ts
/** File-backed MCP row mutations for Claude-compatible preset compositions. */
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
* Apply one Loader patch to a user preset and replace the YAML file atomically.
* `entryListSchema` preserves `!!js` disabled expressions, while the lock
* serializes the complete read-validate-patch-write cycle across processes.
* @param preset - the roster record resolved for the requested preset.
* @param target - the Remote target used in actionable failure details.
* @param patch - one Loader patch to apply.
* @param validate - target and duplicate checks run against locked disk state.
* @param warn - sink for skipped-patch diagnostics.
* @returns a promise resolving after the atomic replacement is committed.
* @throws an MCP Remote error when the preset cannot be authored or parsed.
*/
async function writePresetComposition(preset, target, patch, validate, warn) {
	if (preset.trust !== "user") throw new RemoteError("mcp/read-only", `MCP preset "${preset.id}" is not user-writable`, {
		target,
		reason: "the preset ships with the deployment"
	});
	if (!isAbsolute(preset.path)) throw new RemoteError("mcp/invalid", `MCP preset "${preset.id}" has a non-absolute composition path`, {
		target,
		reason: "the resolved composition path is not absolute"
	});
	if (preset.broken !== void 0) throw new RemoteError("mcp/invalid", `MCP preset "${preset.id}" is broken: ${preset.broken}`, {
		target,
		reason: preset.broken
	});
	await writeEntryListFile(preset.path, target, patch, validate, warn);
}
/**
* Read and validate one entry-list composition file, returning its rows.
* Used by the read-only describe path; the write helpers (entry-list and preset
* composition) keep their own locked/full validation.
* @param filename - YAML or JSON entry-list path.
* @returns the parsed entry rows.
* @throws when the file cannot be read or is not a valid entry list.
*/
async function readEntryRows(filename) {
	let parsed;
	try {
		parsed = load(await readFile(filename, "utf8"), { schema: entryListSchema });
	} catch (cause) {
		throw new RemoteError("mcp/invalid", "MCP entry-list file could not be read", { reason: String(cause) }, { cause });
	}
	const problem = entryListProblem(parsed);
	if (problem !== void 0) throw new RemoteError("mcp/invalid", "MCP entry-list file is not valid", { reason: problem });
	return parsed;
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
//#region src/mcp-config.ts
/**
* MCP config authoring helpers: convert the settings form's JSON spec
* (Claude Code-style `type`/`command`/`args`) into the `mcp-client` Config
* shape, and back, so the roster and the edit form share one form. The spec is
* validated strictly — a malformed or unknown-transport spec is refused before
* it reaches a composition file.
* @module @zhang-guo-wen/dsh-mcp-manager/mcp-config
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
* Resolve the `livePresetMounts` reader from the `agent-presets` instance the
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
		const mod = await loader.internal.import("@deepseek-ai/dsh-agent-presets", base, {});
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
		const presets = ctx.get("agentPresets");
		if (presets === void 0) return;
		const mounts = mountReader(ctx.root.fiber);
		const seen = /* @__PURE__ */ new Set();
		for (const mount of mounts) {
			let rows;
			try {
				rows = await readEntryRows((await presets.resolve(mount.presetId)).path);
			} catch (error) {
				warn(`mcp-manager: cannot read preset "${mount.presetId}" composition: ${String(error)}`);
				continue;
			}
			for (const entry of mount.tree.entries()) {
				if (entry.options.group === true || entry.options.name !== "@deepseek-ai/dsh-mcp-client") continue;
				const leaf = presetLeafId(entry.options.id);
				const serverName = entry.options.id;
				const fileRow = findEntryRows(rows, leaf)[0];
				if (fileRow === void 0) continue;
				const allowed = fileRow.disabled !== true;
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
* @module @zhang-guo-wen/dsh-mcp-manager/mcp-tool-filter
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
		name: "@zhang-guo-wen/dsh-mcp-manager",
		version: "0.1"
	});
	await client.connect(transport);
	return {
		client,
		tools: (await client.listTools()).tools ?? []
	};
}
const SERVER_ROW_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		name: {
			type: "string",
			required: true,
			description: "MCP serverName namespace."
		},
		scope: {
			type: "string",
			required: true,
			description: "Composition that owns the row, e.g. \"global\" or \"preset standard\"."
		},
		loaded: {
			type: "boolean",
			required: true,
			description: "Whether the server is running for this session."
		}
	}
};
/**
* Register the on-demand MCP tools in one composition scope.
* @param ctx - scope the tools belong to (a preset row's context).
* @param mode - how a loaded server reaches the model.
* @param gate - the preload gate; it decides which composed rows this session
*   is allowed to load, and holds the rest out of every request.
* @param filterFor - reads one row's tool filter by its settings key. Called at
*   every load, so a committed rule change applies to the next `mcp_load`.
* @returns a disposer that unregisters every tool and stops every server this
*   registration started. `eager` registers nothing, so its disposer is a no-op.
*/
function registerMcpTools(ctx, mode, gate, filterFor = () => NO_TOOL_FILTER) {
	const tools = ctx.get("tools");
	if (tools === void 0 || mode === "eager") return () => {};
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
	/** Whether a row's tools are in every request already, without an `mcp_load`. */
	const preloaded = (row) => {
		const state = gate.stateFor(row.target, row.entryId);
		return state === void 0 ? row.enabled : state.allowed && !state.suppressed;
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
	* The native carrier mounts the mcp-client on the agent's own context, so
	* Cordis disposes its connection with that context. The proxy carrier owns a
	* bare SDK client instead, and without this it would outlive the session that
	* loaded it: every session that ends without an `mcp_unload` would leave its
	* server running until the plugin unloads.
	* @param agentId - the session that ended.
	*/
	const releaseAgent = (agentId) => {
		scopedAgents.delete(agentId);
		const perAgent = mounted.get(agentId);
		if (perAgent === void 0) return;
		mounted.delete(agentId);
		for (const server of perAgent.values()) if (server.client !== void 0) server.dispose();
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
		name: "mcp_list",
		description: "List the MCP servers this session may use, their scope, and whether each is running. Disabled servers are not listed. Servers that are allowed but not running can be started on demand with `mcp_load`; load only what you need, because a running server costs prompt tokens.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: SERVER_ROW_SCHEMA
			},
			render: (_args, rows) => [{
				type: "text",
				text: rows.length === 0 ? "(no MCP servers configured)" : rows.map((row) => `${row.name} [${row.scope}] ${row.loaded ? "running" : "not loaded"}`).join("\n")
			}]
		},
		async execute(_args, exec) {
			const running = exec.agent === void 0 ? void 0 : mounted.get(exec.agent.id);
			return (await allowedRows()).map((row) => ({
				name: row.serverName,
				scope: row.scopeLabel,
				loaded: preloaded(row) || running?.has(row.serverName) === true
			}));
		}
	}));
	register(defineTool({
		name: "mcp_load",
		description: mode === "lazy" ? "Start one configured but not-running MCP server for THIS session and return its tools. Call the tools you need afterwards with `mcp_call`, passing the server name and tool name from this result. Only the tools this result lists are callable." : "Start one configured but not-running MCP server for THIS session and add its tools to the request. Use `mcp_list` first to see the available names.",
		parameters: { server: {
			type: "string",
			required: true,
			description: "The MCP serverName to start, as reported by mcp_list."
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
				tools: existing.client === void 0 ? toolNamesFor(tools, agent.ctx, serverName).map((name) => ({
					name,
					description: "",
					schema: ""
				})) : describeTools(existing),
				hidden: existing.hidden ?? 0
			};
			const row = (await allowedRows()).find((candidate) => candidate.serverName === serverName);
			if (row === void 0) throw new Error(`unknown or disabled MCP server "${serverName}" — call mcp_list for the servers this session may load`);
			const config = mcpEntryConfig(await describeRow(ctx, row), serverName);
			const filter = filterFor(row.key);
			if (mode === "lazy" || filterHidesAnything(filter)) {
				const { client, tools: listed } = await connectLazy(config);
				const selection = filterMcpTools(listed, filter);
				loadedFor(agent.id).set(serverName, {
					dispose: async () => {
						await client.close();
					},
					client,
					tools: selection.visible,
					hidden: selection.hidden
				});
				bindAgentScope(agent);
				return {
					server: serverName,
					tools: selection.visible.map(lazyTool),
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
			loadedFor(agent.id).set(serverName, { dispose: async () => {
				await handle.dispose();
			} });
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
	register(defineTool({
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
			if (mount.client === void 0) throw new Error(`MCP server "${request.server}" was loaded with its tools registered natively — call them by name instead`);
			if (mount.tools !== void 0 && !mount.tools.some((candidate) => candidate.name === request.tool)) throw new Error(`MCP server "${request.server}" exposes no tool "${request.tool}" in this session — call mcp_load to list the tools this session may call`);
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
	return () => {
		for (const dispose of [...registrations].reverse()) dispose();
		registrations.length = 0;
		stopAll();
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
/** The already-loaded server's exposed tool list, re-reported without reconnecting. */
function describeTools(mount) {
	if (mount.tools === void 0) return [];
	return mount.tools.map(lazyTool);
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
	let _addMcp_decorators;
	let _editMcp_decorators;
	let _disableMcp_decorators;
	let _gateState_decorators;
	let _describeMcp_decorators;
	let _listMcpTools_decorators;
	return class McpManager extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_addMcp_decorators = [Remote("addMcp")];
			_editMcp_decorators = [Remote("editMcp")];
			_disableMcp_decorators = [Remote("disableMcp")];
			_gateState_decorators = [Remote("gateState")];
			_describeMcp_decorators = [Remote("describeMcp")];
			_listMcpTools_decorators = [Remote("listMcpTools")];
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
		static inject = ["loader"];
		mutationQueue = Promise.resolve();
		/**
		* @param ctx - host context.
		* @param gate - the preload gate the mutations must leave in line with the
		*   current loading mode.
		*/
		constructor(ctx, gate) {
			super(ctx, "mcpManager");
			this.gate = gate;
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
			const rows = await readEntryRows(preset.path);
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
				await writeEntryListFile(include.tree.filename, target, { insert: [{
					id: entryId,
					name: MCP_CLIENT_MODULE,
					config
				}] }, (rows) => {
					if (entryIds(rows).has(entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
					if (rows.some((row) => row.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(row) === request.serverName)) throw conflict(target, entryId, request.serverName, "the serverName is already in use");
				}, this.warnPatch);
				return {
					target,
					entryId: await this.loader().create({
						id: entryId,
						name: MCP_CLIENT_MODULE,
						config
					}, include.entry.id),
					serverName: request.serverName,
					disabled: false
				};
			}
			const preset = await this.resolvePreset(target);
			await writePresetComposition(preset, target, { insert: [{
				id: entryId,
				name: MCP_CLIENT_MODULE,
				config
			}] }, (rows) => {
				if (entryIds(rows).has(entryId)) throw conflict(target, entryId, void 0, "the row id is already in use");
				if (rows.some((row) => row.name === "@deepseek-ai/dsh-mcp-client" && serverNameOf(row) === request.serverName)) throw conflict(target, entryId, request.serverName, "the serverName is already in use");
			}, this.warnPatch);
			await this.refreshPreset(preset.id);
			return {
				target,
				entryId,
				serverName: request.serverName,
				disabled: false
			};
		}
		async edit(request) {
			const target = validateTarget(request.target);
			const config = configFromSpec(request.spec, request.serverName, target);
			validateEntryId(request.entryId, target, false);
			if (target.scope === "global") {
				const include = await this.globalInclude(target);
				const entry = this.globalMcpEntry(request.entryId, target, include.tree);
				const disabled = entry.disabled;
				this.assertServerNameAvailable([...include.tree.entries()], request.entryId, request.serverName, target);
				await this.loader().update(request.entryId, { config });
				const rowId = entry.options.id;
				await writeEntryListFile(include.tree.filename, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					config
				}, (rows) => {
					this.presetMcpRow(rows, rowId, target);
					this.assertServerNameAvailable(rows, rowId, request.serverName, target);
				}, this.warnPatch);
				return {
					target,
					entryId: entry.id,
					serverName: request.serverName,
					disabled
				};
			}
			const preset = await this.resolvePreset(target);
			const entryId = presetLeafId(request.entryId);
			let disabled = false;
			await writePresetComposition(preset, target, {
				id: entryId,
				name: MCP_CLIENT_MODULE,
				config
			}, (rows) => {
				disabled = this.presetMcpRow(rows, entryId, target).disabled === true;
				this.assertServerNameAvailable(rows, entryId, request.serverName, target);
			}, this.warnPatch);
			await this.refreshPreset(preset.id);
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
				await this.loader().update(request.entryId, { disabled: request.disabled });
				const rowId = entry.options.id;
				await writeEntryListFile(include.tree.filename, target, {
					id: rowId,
					name: MCP_CLIENT_MODULE,
					disabled: request.disabled
				}, (rows) => {
					this.presetMcpRow(rows, rowId, target);
				}, this.warnPatch);
				return {
					target,
					entryId: entry.id,
					serverName,
					disabled: request.disabled
				};
			}
			const preset = await this.resolvePreset(target);
			const entryId = presetLeafId(request.entryId);
			let serverName = entryId;
			await writePresetComposition(preset, target, {
				id: entryId,
				name: MCP_CLIENT_MODULE,
				disabled: request.disabled
			}, (rows) => {
				serverName = serverNameOf(this.presetMcpRow(rows, entryId, target)) ?? entryId;
			}, this.warnPatch);
			await this.refreshPreset(preset.id);
			return {
				target,
				entryId,
				serverName,
				disabled: request.disabled
			};
		}
		async resolvePreset(target) {
			const presets = this.ctx.get("agentPresets");
			if (presets === void 0) throw new RemoteError("mcp/unavailable", "agent preset MCP authoring is unavailable", { reason: "agentPresets is not mounted in this composition" });
			try {
				return await presets.resolve(target.agentPreset);
			} catch (cause) {
				if (cause instanceof RemoteError) throw cause;
				throw new RemoteError("mcp/not-found", `MCP preset "${target.agentPreset}" was not found`, { target }, { cause });
			}
		}
		/**
		* Apply a just-written preset composition to its live standing mount.
		*
		* Re-reads the file through the mount's own `Include` tree (`refresh()`),
		* which diffs child entries and mounts/unmounts only what changed. A full
		* `standingKeyFor` recompose would start a new generation and remount every
		* row — restarting every MCP child process in the preset — so the targeted
		* refresh is the difference between a sub-second toggle and several seconds.
		* A preset that is not mounted has nothing live to update; a failure is
		* logged rather than thrown so a committed file write still reports success.
		* @param agentPreset - preset id whose composition was just written.
		*/
		async refreshPreset(agentPreset) {
			try {
				const mountsFor = await this.mountRegistry();
				if (mountsFor !== void 0) {
					const mount = mountsFor().filter((candidate) => candidate.presetId === agentPreset).at(-1);
					const refresh = mount?.tree?.refresh;
					if (refresh !== void 0 && mount !== void 0) {
						await refresh.call(mount.tree);
						return;
					}
				}
				const presets = this.ctx.get("agentPresets");
				if (presets?.standingKeyFor !== void 0) await presets.standingKeyFor(agentPreset);
			} catch (error) {
				this.warnPatch(`mcp-manager: preset "${agentPreset}" refresh failed after edit: ${String(error)}`);
			}
		}
		/**
		* Resolve the `livePresetMounts` reader from the agent-presets instance the
		* Loader actually uses. A plain import can land on a second copy of the
		* package (the harness resolves the roster from its own graph), so this goes
		* through the Loader's internal resolver with the harness base first, then
		* falls back to the statically imported reader.
		* @returns the mount reader, or undefined when neither path is available.
		*/
		async mountRegistry() {
			const loader = this.ctx.get("loader");
			const base = this.ctx.baseUrl;
			if (loader?.internal !== void 0 && base !== void 0) try {
				const mod = await loader.internal.import("@deepseek-ai/dsh-agent-presets", base, {});
				if (mod.livePresetMounts !== void 0) return mod.livePresetMounts;
			} catch {}
			return () => livePresetMounts();
		}
		async globalInclude(target) {
			const includes = [...this.loader().entries()].filter((entry) => entry.options.name === "cordis:include" && entry.subtree);
			if (includes.length !== 1) throw new RemoteError("mcp/unavailable", "global MCP authoring requires exactly one file-backed Include", { reason: includes.length === 0 ? "no root Include is mounted" : `${includes.length} Includes are mounted` });
			const entry = includes[0];
			const tree = entry.subtree;
			const filename = tree.filename;
			if (filename === void 0) throw new RemoteError("mcp/unavailable", "global MCP authoring has no persistent Include file", { reason: "the mounted global tree does not expose a writable filename" });
			if ((tree.config?.patches?.length ?? 0) > 0) throw new RemoteError("mcp/read-only", "global MCP authoring cannot persist a patched Include", {
				target,
				reason: "Loader write-back would flatten bundle and user patch layers"
			});
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
		globalMcpEntry(entryId, target, tree) {
			let entry;
			try {
				entry = this.loader().resolve(entryId);
			} catch (cause) {
				throw new RemoteError("mcp/not-found", `MCP loader row "${entryId}" was not found`, {
					target,
					entryId
				}, { cause });
			}
			if (!Array.from(tree.entries()).includes(entry)) throw new RemoteError("mcp/not-found", `MCP loader row "${entryId}" is outside the global Include`, {
				target,
				entryId
			});
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
/** Settings namespace owned by this plugin. */
const MCP_SETTINGS_NAMESPACE = "mcp-manager";
/** Schema served to settings clients for this namespace. */
const MCP_SETTINGS_SCHEMA = z.object({
	loading: z.string().default("dynamic"),
	descriptions: z.dict(String).default({}),
	tools: z.dict(z.any()).default({})
});
/**
* Register the `mcp-manager` namespace and return a live reader.
*
* When the settings service is mounted, the namespace is registered and the
* reader follows committed changes. Without a settings service the reader stays
* pinned to the composition `base`. A namespace already owned by another plugin
* keeps that owner's reader — we never throw.
*
* @param ctx - plugin context (uses `ctx.get('settings')` when present).
* @param config - composition defaults for the loading mode.
* @param onCommitted - observer invoked after each committed change.
* @returns a thunk returning the current flags.
*/
function registerMcpSettings(ctx, config = {}, onCommitted) {
	const base = {
		loading: config.loading ?? "dynamic",
		descriptions: {},
		tools: {}
	};
	let source = () => ({ ...base });
	ctx.inject(["settings"], (settingsCtx) => {
		const provider = settingsCtx.settings;
		try {
			const scope = provider.register(MCP_SETTINGS_NAMESPACE, MCP_SETTINGS_SCHEMA, {
				base,
				applies: "live"
			});
			source = () => ({ ...scope.get() });
			scope.watch((next) => {
				source = () => ({ ...next });
				onCommitted?.({ ...next });
			});
		} catch {}
	});
	return () => ({ ...source() });
}
//#endregion
//#region src/index.ts
/** Cordis plugin name used by loader diagnostics. */
const name = "mcp-manager";
/** Services required by this plugin. Every other service is probed lazily. */
const inject = ["loader"];
const Config = z.object({ mcpLoading: z.union([
	"eager",
	"dynamic",
	"lazy"
]).default("dynamic") });
/**
* Register the on-demand MCP tools, the preload gate that follows the loading
* mode, the `mcp-manager` settings namespace, and the `mcpManager` Remote.
*/
async function apply(ctx, config = {}) {
	let mcpLoading = parseMcpLoadingMode(config.mcpLoading);
	const gate = createMcpPreloadGate(ctx, () => mcpLoading, await resolvePresetMounts(ctx, (within) => livePresetMounts(within)), (message) => {
		ctx.logger.warn(message);
	});
	let readToolFilter = () => NO_TOOL_FILTER;
	let disposeMcpTools = registerMcpTools(ctx, mcpLoading, gate, (key) => readToolFilter(key));
	ctx.effect(() => () => {
		disposeMcpTools();
		gate.dispose();
	}, "mcp-manager: mcp tools");
	const resync = () => {
		gate.reconcile();
	};
	const events = ctx;
	for (const event of MCP_ROW_EVENTS) ctx.effect(() => events.on(event, (...args) => {
		if (event === "loader/entry-init") {
			if (args[0]?.options?.name !== "@deepseek-ai/dsh-mcp-client") return;
		}
		resync();
	}), `mcp-manager: gate follows ${event}`);
	await gate.reconcile();
	/**
	* Warn once per commit when rules cannot take effect. `eager` mounts every
	* allowed row through mcp-client, whose registration publishes all discovered
	* tools, so a filter configured for that mode is silently useless otherwise.
	*/
	const warnFiltersWithoutEffect = (next) => {
		if (mcpLoading !== "eager") return;
		const configured = Object.entries(next.tools).filter(([, value]) => filterHidesAnything(parseMcpToolFilter(value))).map(([key]) => key);
		if (configured.length === 0) return;
		ctx.logger.warn(`mcp-manager: MCP loading is "eager", so the tool filters for ${configured.join(", ")} have no effect. eager mounts every enabled row through mcp-client, which registers all discovered tools; select the "dynamic" or "lazy" loading mode to apply these filters.`);
	};
	const flags = registerMcpSettings(ctx, config.mcpLoading === void 0 ? {} : { loading: config.mcpLoading }, (next) => {
		const mode = parseMcpLoadingMode(next.loading);
		if (mode !== mcpLoading) {
			mcpLoading = mode;
			disposeMcpTools();
			disposeMcpTools = registerMcpTools(ctx, mode, gate, (key) => readToolFilter(key));
			resync();
		}
		warnFiltersWithoutEffect(next);
	});
	readToolFilter = (key) => parseMcpToolFilter(flags().tools[key]);
	warnFiltersWithoutEffect(flags());
	new McpManager(ctx, gate);
}
//#endregion
export { Config, MCP_LOADING_MODES, MCP_SETTINGS_NAMESPACE, McpManager, admits, apply, assertServerName, filterHidesAnything, filterMcpTools, inject, mcpEntryConfig, mcpRowKey, name, parseMcpLoadingMode, parseMcpToolFilter, registerMcpSettings, registerMcpTools, specFromEntryConfig, toolRuleEntries };
