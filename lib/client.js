window.__ModuleLoader__.load({
	id: "@guowenzhang/dsh-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
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
		//#region src/client/config-issues.ts
		/**
		* Fill one `{name}`-style placeholder.
		* @param template - localized text carrying the placeholder.
		* @param values - placeholder name to replacement text.
		* @returns the filled text, or the template when it carries no placeholder.
		*/
		function fill(template, values) {
			let text = template;
			for (const [key, value] of Object.entries(values)) text = text.replace(`{${key}}`, value);
			return text;
		}
		/**
		* One gap, in the reader's language.
		* @param issue - the gap, as the Host reported it.
		* @param t - this section's dictionary lookup.
		* @returns the localized sentence for that kind.
		*/
		function describeIssue(issue, t) {
			const names = issue.names ?? [];
			switch (issue.kind) {
				case "missing-command": return t("mcp.issue.missingCommand");
				case "missing-url": return t("mcp.issue.missingUrl");
				case "unsupported-config": return t("mcp.issue.unsupportedConfig");
				case "unreachable-variable": return fill(t("mcp.issue.unreachableVariable"), { names: names.join(", ") });
				case "empty-credential": return fill(t("mcp.issue.emptyCredential"), { name: names[0] ?? "" });
				default: return issue.reason;
			}
		}
		/**
		* Render every gap of one row as one line, for a tooltip or a save error.
		* @param issues - the gaps `diagnoseRowConfig` / `diagnoseMcpSpec` reported.
		* @param t - this section's dictionary lookup.
		* @returns the localized reasons joined for display.
		*/
		function formatMcpConfigIssues(issues, t) {
			return issues.map((issue) => describeIssue(issue, t)).join("; ");
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
		* Which transport one decoded server object declares, without asserting that it
		* is complete: a missing `type` is inferred from `command`/`url`, exactly as
		* {@link specFromObject} does. Callers use it to decide which field a partial
		* object is about — the credentials editor edits the object the user typed into
		* the JSON box, which may be neither valid nor finished yet.
		* @param candidate - one decoded server entry.
		* @returns the transport kind, or undefined when the entry names none.
		*/
		function transportKindOf(candidate) {
			const declared = candidate.type;
			if (declared === "stdio") return "stdio";
			if (declared === "streamable-http" || declared === "http" || declared === "sse") return "http";
			if (declared !== void 0) return void 0;
			if (typeof candidate.command === "string") return "stdio";
			return typeof candidate.url === "string" ? "http" : void 0;
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
		/**
		* Programs that only ever launch another program.
		*
		* A row whose command is one of them and that carries no package argument is
		* unfinished — `npx` alone is not a server called `npx`, and naming one after
		* its launcher would put a wrong name in the roster and the system prompt.
		*/
		const PACKAGE_RUNNERS = /* @__PURE__ */ new Set([
			"bun",
			"bunx",
			"deno",
			"dnx",
			"node",
			"npm",
			"npx",
			"pipx",
			"pnpm",
			"pnpx",
			"python",
			"python3",
			"uv",
			"uvx",
			"yarn"
		]);
		/** Host labels that name a role rather than a product, so a URL's own name skips them. */
		const GENERIC_HOST_LABELS = /* @__PURE__ */ new Set([
			"mcp",
			"www",
			"api",
			"server",
			"sse",
			"http",
			"https"
		]);
		/**
		* The name a spec implies when the document it came from declared none.
		*
		* A stdio row is named after the package it launches (`npx -y
		* @upstash/context7-mcp` → `context7`), an HTTP row after the most specific label
		* of the host it calls (`https://mcp.yunxiao.com/mcp` → `yunxiao`). Nothing is
		* derived where nothing names a server: an address is not a name, and neither is
		* a launcher waiting for its package.
		* @param spec - the parsed transport spec.
		* @returns a namespace candidate, or an empty string when nothing usable is left.
		*/
		function serverNameFromSpec(spec) {
			if (spec.type === "stdio") {
				const pkg = (spec.args ?? []).find((argument) => !argument.startsWith("-"));
				if (pkg !== void 0) return serverNameFromCommand(pkg);
				return PACKAGE_RUNNERS.has(programName(spec.command)) ? "" : serverNameFromCommand(spec.command);
			}
			let host;
			try {
				host = new URL(spec.url).hostname;
			} catch {
				return "";
			}
			if (host === "" || /^[\d.]+$/.test(host)) return "";
			const labels = host.split(".").filter((label) => label !== "");
			return serverNameFromCommand(labels.find((part) => !GENERIC_HOST_LABELS.has(part)) ?? labels[0] ?? "");
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
		* Whether a gap can be closed from the settings page alone.
		*
		* An unresolved `${env:NAME}` depends on this process's environment, and an
		* empty credential can be filled in later, so a save that already cleaned up
		* everything the author controls is accepted and the row stays flagged. A blank
		* `command`/`url` is structural: a save carrying one is refused outright.
		* @param issue - one diagnostic entry.
		* @returns whether the row must be refused rather than accepted and flagged.
		*/
		function isBlockingConfigIssue(issue) {
			return issue.kind === "missing-command" || issue.kind === "missing-url";
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
		* Diagnose an authoring SPEC (the Claude-shaped form the editor edits).
		*
		* The editor holds the spec, not the `mcp-client` config, at the moment it
		* decides whether a save may proceed 鈥?and the config builder refuses a blank
		* `command`/`url` on its own. This narrows the check to what only the spec can
		* show: `${env:NAME}` references, and credential-shaped env/header fields left
		* empty. The caller supplies the environment, because the browser half has none
		* and must not assume one.
		* @param spec - the parsed spec the dialog is about to submit.
		* @param env - environment used to resolve references; the browser passes `{}`.
		* @returns the variable and credential gaps, in report order.
		*/
		function diagnoseMcpSpec(spec, env) {
			const missing = /* @__PURE__ */ new Set();
			for (const value of specStrings(spec)) collectMissingReferences(value, env, missing);
			return issues(missing, blankCredentialKeys(spec));
		}
		//#endregion
		//#region src/client/credential-fields.ts
		/**
		* The credential view of the editor's JSON box.
		*
		* The dialog keeps ONE document — the JSON the user types — and the credentials
		* pane is a view of its `env`/`headers` map, not a second copy of it. These
		* rules read and write that view, so the pane never has to reconcile a draft
		* with the box: what the pane shows is what the box holds, and a save writes
		* the box.
		*
		* They live here rather than in the editor component because they are pure and
		* carry the fiddly part — a partial, hand-typed document may be a flat spec, a
		* single named entry, or a Claude `mcpServers` wrapper, and none of those is
		* required to be valid yet.
		* @module @guowenzhang/dsh-mcp-manager/client/credential-fields
		*/
		/** True for a decoded JSON object (not null, not an array). */
		function isRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}
		/**
		* The object one credential map lives on, unwrapping the two containers the
		* parser also accepts. Undefined when the text is not an object at all.
		* @param decoded - the decoded JSON box.
		* @returns the object carrying the transport fields.
		*/
		function entryOf(decoded) {
			if (!isRecord(decoded)) return void 0;
			const root = isRecord(decoded.mcpServers) ? decoded.mcpServers : decoded;
			const keys = Object.keys(root);
			if (transportKindOf(root) === void 0 && keys.length === 1) {
				const only = root[keys[0]];
				if (isRecord(only)) return only;
			}
			return root;
		}
		/**
		* Read one credential map out of the JSON box.
		*
		* Every value is a string once saved, but the box is free text until then, so a
		* non-string value is rendered as its JSON text and written back as the string
		* it shows: the pane edits exactly what the user can see.
		* @param json - the JSON box's current text.
		* @param kind - the map to read (`env` for stdio, `headers` for HTTP).
		* @returns the pairs in declaration order and whether the shape is writable, or
		*   undefined when the text is not a document this pane can show.
		*/
		function credentialValues(json, kind) {
			let decoded;
			try {
				decoded = JSON.parse(json);
			} catch {
				return;
			}
			const entry = entryOf(decoded);
			if (entry === void 0) return void 0;
			const source = entry[kind];
			if (source === void 0) return {
				entries: [],
				editable: true
			};
			if (!isRecord(source)) return {
				entries: [],
				editable: false
			};
			return {
				entries: Object.entries(source).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
				editable: true
			};
		}
		/**
		* Write one credential value back into the JSON box, leaving every other field
		* of the document as it was typed.
		* @param json - the JSON box's current text.
		* @param kind - the map to write (`env` or `headers`).
		* @param key - the entry's key.
		* @param value - the entry's new value.
		* @returns the box's new text, or undefined when the text is not a document
		*   this pane can write to.
		*/
		function credentialText(json, kind, key, value) {
			let decoded;
			try {
				decoded = JSON.parse(json);
			} catch {
				return;
			}
			const entry = entryOf(decoded);
			if (entry === void 0) return void 0;
			const source = entry[kind];
			if (source !== void 0 && !isRecord(source)) return void 0;
			entry[kind] = {
				...source ?? {},
				[key]: value
			};
			return JSON.stringify(decoded, null, 2);
		}
		/**
		* Fold the credential fields the user changed into the document about to be
		* saved.
		*
		* Only the changed ones: the pane edits a box the user also edits by hand, and
		* a value it never showed must not be replaced by the version the pane read
		* when it opened.
		* @param current - the JSON box's current text.
		* @param opened - the text the credentials pane opened with.
		* @returns the text to save, or `current` unchanged when nothing was edited.
		*/
		function mergeCredentialEdits(current, opened) {
			if (opened === "" || opened === current) return current;
			let next = current;
			for (const kind of ["env", "headers"]) {
				const before = credentialValues(opened, kind);
				const now = credentialValues(next, kind);
				if (before === void 0 || now === void 0 || !before.editable || !now.editable) continue;
				const shown = new Map(now.entries);
				for (const [key, value] of before.entries) {
					const edited = shown.get(key);
					if (edited === void 0 || edited === value) continue;
					next = credentialText(next, kind, key, edited) ?? next;
				}
			}
			return next;
		}
		//#endregion
		//#region \0dsh-css:C:\02-codespace\DeepSeek\dsh-mcp-manager\src\client\McpSection.module.css.mjs
		const css$1 = ".y1VbRq_section{box-sizing:border-box;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex;container:y1VbRq_mcp-manager/inline-size}.y1VbRq_pageHead{flex-direction:column;gap:4px;display:flex}.y1VbRq_pageTitle{font:var(--dsw-font-base-strong-16);margin:0}.y1VbRq_pageIntro{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_tabs{box-sizing:border-box;flex:none;width:100%}.y1VbRq_tabPanel{flex-direction:column;gap:16px;display:flex}.y1VbRq_tabPanel[hidden]{display:none}.y1VbRq_block{flex-direction:column;gap:12px;display:flex}.y1VbRq_blockHead{flex-wrap:wrap;align-items:baseline;gap:4px 12px;display:flex}.y1VbRq_blockTitle{font:var(--dsw-font-s-14);margin:0;font-weight:600}.y1VbRq_modeBlock{flex-direction:column;align-items:stretch;gap:8px;display:flex}.y1VbRq_modeDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);margin:0}.y1VbRq_modeStatus{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_listHead{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;display:flex}.y1VbRq_listHeadText{align-items:baseline;gap:8px;min-width:0;display:flex}.y1VbRq_count{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.y1VbRq_listActions{flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;display:inline-flex}.y1VbRq_listFilters{flex-wrap:wrap;gap:8px;display:flex}.y1VbRq_rosterSearch{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);min-width:0;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);flex:220px;padding:0 10px}.y1VbRq_rosterSearch::placeholder{color:var(--dsw-alias-label-caption)}.y1VbRq_mcpFilterSelect{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);max-width:240px;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);padding:0 10px}.y1VbRq_mcpList{flex-direction:column;gap:10px;display:flex}.y1VbRq_emptyBlock{flex-direction:column;align-items:flex-start;gap:6px;padding:2px 0 4px;display:flex}.y1VbRq_empty{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_emptyHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_mcpRow{box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);transition:background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);justify-content:space-between;align-items:flex-start;gap:14px;padding:12px 14px;display:flex}.y1VbRq_mcpRow[data-clickable=true]{cursor:pointer}.y1VbRq_mcpRow[data-clickable=true]:hover{background:var(--dsw-alias-interactive-bg-hover)}.y1VbRq_mcpRow[data-clickable=true]:active{background:var(--dsw-alias-interactive-bg-active)}.y1VbRq_mcpRow[data-clickable=true]:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.y1VbRq_rowScope{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);height:24px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:nowrap;align-items:center;padding:0 10px;display:inline-flex}@media (prefers-reduced-motion:reduce){.y1VbRq_mcpRow{transition:none}}.y1VbRq_mcpMain{flex-direction:column;flex:auto;gap:4px;min-width:0;display:flex}.y1VbRq_mcpName{font:var(--dsw-font-s-14);font-weight:600;font-family:var(--ds-font-family-code);overflow-wrap:anywhere}.y1VbRq_descText{appearance:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:left;overflow-wrap:anywhere;cursor:pointer;background:0 0;border:0;margin:0;padding:0}.y1VbRq_descText:hover{color:var(--dsw-alias-label-secondary)}.y1VbRq_descText[data-empty=true]{color:var(--dsw-alias-label-dimmed)}.y1VbRq_descText:disabled{opacity:.5;cursor:default}.y1VbRq_mcpDesc{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);width:100%;height:28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere;margin:0;padding:0 8px}.y1VbRq_mcpDesc::placeholder{color:var(--dsw-alias-label-dimmed)}.y1VbRq_mcpFilterSelect:disabled,.y1VbRq_formSelect:disabled,.y1VbRq_formJson:disabled,.y1VbRq_toolRow input:disabled{opacity:.5;cursor:default}.y1VbRq_descOver{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-warn-label)}.y1VbRq_descState{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_descState[data-state=failed]{color:var(--dsw-alias-state-error-primary)}.y1VbRq_mcpRight{flex-wrap:wrap;flex:none;justify-content:flex-end;align-self:center;align-items:center;gap:8px;max-width:100%;display:inline-flex}.y1VbRq_status{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;display:inline-flex}.y1VbRq_rowFailure{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.y1VbRq_rowFailure p{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0}.y1VbRq_mcpStatus,.y1VbRq_unavailable{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_mcpFailure{color:var(--dsw-alias-state-error-primary);flex-wrap:wrap;align-items:center;gap:10px;display:flex}.y1VbRq_mcpFailure p{font:var(--dsw-font-xs-13);margin:0}.y1VbRq_mcpNotice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-success-primary);margin:0}.y1VbRq_skeletonList{flex-direction:column;gap:10px;display:flex}.y1VbRq_skeletonRow{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:8px;padding:15px 14px;display:flex}.y1VbRq_skeletonBar{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);width:38%;height:14px}.y1VbRq_skeletonBar+.y1VbRq_skeletonBar{width:78%;height:12px}.y1VbRq_visuallyHidden{clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@keyframes y1VbRq_mcp-skeleton-pulse{0%{opacity:1}40%{opacity:.55}80%,to{opacity:1}}@media (prefers-reduced-motion:no-preference){.y1VbRq_skeletonBar{animation:2s ease-in-out infinite y1VbRq_mcp-skeleton-pulse}}@media (prefers-reduced-motion:reduce){.y1VbRq_skeletonBar{animation:none}}.y1VbRq_mcpForm{flex-direction:column;gap:12px;display:flex}.y1VbRq_mcpEditorDialog{box-sizing:border-box;width:min(640px,100%)}.y1VbRq_mcpEditorContent{max-height:min(70dvh,640px);overflow:auto}.y1VbRq_editorTabs{flex:none}.y1VbRq_editorPanel{flex-direction:column;gap:12px;min-height:320px;display:flex}.y1VbRq_editorPanel[hidden]{display:none}.y1VbRq_formActions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}.y1VbRq_formField{flex-direction:column;gap:6px;display:flex}.y1VbRq_formLabel{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}.y1VbRq_requiredMark{color:var(--dsw-alias-state-error-primary);margin-left:2px}.y1VbRq_fieldError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin-left:8px}.y1VbRq_fieldHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.y1VbRq_formSelect{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);padding:0 10px}.y1VbRq_formJson{box-sizing:border-box;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:220px;color:var(--dsw-alias-label-primary);font:12px/18px var(--ds-font-family-code);resize:vertical;white-space:pre;padding:10px 14px;overflow:auto}.y1VbRq_formError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0}.y1VbRq_rosterSearch:focus-visible,.y1VbRq_mcpFilterSelect:focus-visible,.y1VbRq_formSelect:focus-visible,.y1VbRq_formJson:focus-visible,.y1VbRq_mcpDesc:focus-visible,.y1VbRq_descText:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.y1VbRq_toolsHead{flex-wrap:wrap;align-items:center;gap:8px;min-height:28px;display:flex}.y1VbRq_toolsCount{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.y1VbRq_toolsActions{flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto;display:flex}.y1VbRq_toolsList{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);max-height:220px;padding:4px;overflow:auto}.y1VbRq_toolRow{border-radius:var(--dsw-radius-sm);cursor:pointer;align-items:center;gap:8px;padding:4px 6px;display:flex}.y1VbRq_toolRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.y1VbRq_toolName{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:nowrap}.y1VbRq_toolDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.y1VbRq_toolTokens{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;flex:none;margin-left:auto;padding-left:8px}.y1VbRq_toolsLoading{min-height:120px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);flex:auto;justify-content:center;align-items:center;gap:8px;display:flex}.y1VbRq_toolsLoading .y1VbRq_spinner{box-sizing:border-box;border:2px solid var(--dsw-alias-bg-skeleton);border-top-color:var(--dsw-alias-label-tertiary);border-radius:50%;width:14px;height:14px}@keyframes y1VbRq_mcp-tool-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:no-preference){.y1VbRq_toolsLoading .y1VbRq_spinner{animation:.8s linear infinite y1VbRq_mcp-tool-spin}}@media (prefers-reduced-motion:reduce){.y1VbRq_toolsLoading .y1VbRq_spinner{animation:none}}.y1VbRq_credentialFields{flex-direction:column;gap:8px;width:100%;display:flex}.y1VbRq_credentialField{grid-template-columns:minmax(96px,34%) minmax(0,1fr);align-items:center;gap:4px 12px;display:grid}.y1VbRq_credentialKey{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}@container y1VbRq_mcp-manager (width<=480px){.y1VbRq_listActions{margin-left:0}.y1VbRq_mcpRow{flex-direction:column;align-items:stretch}.y1VbRq_mcpRight{justify-content:space-between;align-self:stretch}.y1VbRq_mcpFilterSelect,.y1VbRq_rosterSearch{flex:100%;max-width:none}}@media (pointer:coarse){.y1VbRq_mcpRow,.y1VbRq_toolRow{min-height:44px}}@media (width<=600px){.y1VbRq_mcpDesc,.y1VbRq_rosterSearch,.y1VbRq_mcpFilterSelect,.y1VbRq_formSelect,.y1VbRq_formJson{font-size:16px;line-height:24px}}";
		const tagId$1 = "@guowenzhang/dsh-mcp-manager/McpSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var McpSection_module_css_default = {
			"block": "y1VbRq_block",
			"blockHead": "y1VbRq_blockHead",
			"blockTitle": "y1VbRq_blockTitle",
			"count": "y1VbRq_count",
			"credentialField": "y1VbRq_credentialField",
			"credentialFields": "y1VbRq_credentialFields",
			"credentialKey": "y1VbRq_credentialKey",
			"descOver": "y1VbRq_descOver",
			"descState": "y1VbRq_descState",
			"descText": "y1VbRq_descText",
			"editorPanel": "y1VbRq_editorPanel",
			"editorTabs": "y1VbRq_editorTabs",
			"empty": "y1VbRq_empty",
			"emptyBlock": "y1VbRq_emptyBlock",
			"emptyHint": "y1VbRq_emptyHint",
			"fieldError": "y1VbRq_fieldError",
			"fieldHint": "y1VbRq_fieldHint",
			"formActions": "y1VbRq_formActions",
			"formError": "y1VbRq_formError",
			"formField": "y1VbRq_formField",
			"formJson": "y1VbRq_formJson",
			"formLabel": "y1VbRq_formLabel",
			"formSelect": "y1VbRq_formSelect",
			"listActions": "y1VbRq_listActions",
			"listFilters": "y1VbRq_listFilters",
			"listHead": "y1VbRq_listHead",
			"listHeadText": "y1VbRq_listHeadText",
			"mcp-manager": "y1VbRq_mcp-manager",
			"mcp-skeleton-pulse": "y1VbRq_mcp-skeleton-pulse",
			"mcp-tool-spin": "y1VbRq_mcp-tool-spin",
			"mcpDesc": "y1VbRq_mcpDesc",
			"mcpEditorContent": "y1VbRq_mcpEditorContent",
			"mcpEditorDialog": "y1VbRq_mcpEditorDialog",
			"mcpFailure": "y1VbRq_mcpFailure",
			"mcpFilterSelect": "y1VbRq_mcpFilterSelect",
			"mcpForm": "y1VbRq_mcpForm",
			"mcpList": "y1VbRq_mcpList",
			"mcpMain": "y1VbRq_mcpMain",
			"mcpName": "y1VbRq_mcpName",
			"mcpNotice": "y1VbRq_mcpNotice",
			"mcpRight": "y1VbRq_mcpRight",
			"mcpRow": "y1VbRq_mcpRow",
			"mcpStatus": "y1VbRq_mcpStatus",
			"modeBlock": "y1VbRq_modeBlock",
			"modeDesc": "y1VbRq_modeDesc",
			"modeStatus": "y1VbRq_modeStatus",
			"pageHead": "y1VbRq_pageHead",
			"pageIntro": "y1VbRq_pageIntro",
			"pageTitle": "y1VbRq_pageTitle",
			"requiredMark": "y1VbRq_requiredMark",
			"rosterSearch": "y1VbRq_rosterSearch",
			"rowFailure": "y1VbRq_rowFailure",
			"rowScope": "y1VbRq_rowScope",
			"section": "y1VbRq_section",
			"skeletonBar": "y1VbRq_skeletonBar",
			"skeletonList": "y1VbRq_skeletonList",
			"skeletonRow": "y1VbRq_skeletonRow",
			"spinner": "y1VbRq_spinner",
			"status": "y1VbRq_status",
			"tabPanel": "y1VbRq_tabPanel",
			"tabs": "y1VbRq_tabs",
			"toolDesc": "y1VbRq_toolDesc",
			"toolName": "y1VbRq_toolName",
			"toolRow": "y1VbRq_toolRow",
			"toolTokens": "y1VbRq_toolTokens",
			"toolsActions": "y1VbRq_toolsActions",
			"toolsCount": "y1VbRq_toolsCount",
			"toolsHead": "y1VbRq_toolsHead",
			"toolsList": "y1VbRq_toolsList",
			"toolsLoading": "y1VbRq_toolsLoading",
			"unavailable": "y1VbRq_unavailable",
			"visuallyHidden": "y1VbRq_visuallyHidden"
		};
		//#endregion
		//#region src/client/McpTargetSelect.tsx
		/**
		* The home a dialog's picker opens on, from the plane its caller named.
		*
		* The caller always hands over a plane; only the agent plane can also name the
		* preset it was narrowed to. An agent plane without a preset to name falls back
		* to the global plane, and the list arriving behind it is what offers the first
		* preset instead.
		* @param plane - the plane the caller opened the dialog on.
		* @param preset - the preset the caller was narrowed to, when it was.
		* @returns the picker's initial value.
		*/
		function initialTarget(plane, preset) {
			return plane === "global" ? "" : preset ?? "";
		}
		/**
		* Render the labeled target picker of one write.
		* @param props.label - localized field name, and the control's accessible name.
		* @param props.value - chosen home: `''` for the global plane, else a preset id.
		* @param props.presets - every preset a write can address, in roster order.
		* @param props.globalWritable - whether the global plane has a file to write.
		* @param props.disabled - whether the surrounding form refuses input.
		* @param props.onChange - called with the chosen value.
		* @param props.t - the section's translator.
		* @returns the field, as the `<label>`'s own contents.
		*/
		function McpTargetSelect({ label, value, presets, globalWritable, disabled, onChange, t }) {
			const unlisted = value !== "" && !presets.some((option) => option.id === value);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: McpSection_module_css_default.formLabel,
				children: label
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
				className: McpSection_module_css_default.formSelect,
				value,
				disabled,
				"aria-label": label,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						disabled: !globalWritable,
						children: t("mcp.scopeGlobal")
					}),
					presets.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.id,
						children: `${t("mcp.scopePreset")} · ${option.name}`
					}, option.id)),
					unlisted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value,
						children: `${t("mcp.scopePreset")} · ${value}`
					}) : null
				]
			})] });
		}
		//#endregion
		//#region src/client/locales.ts
		/** Locale namespace owned by this plugin's settings section. */
		const NS = "settings.mcpManager";
		const zh = {
			"nav": "MCP 管理",
			"mcp.page.title": "MCP",
			"mcp.page.intro": "管理可用的 MCP 服务器，决定它们何时进上下文、一次把多少工具内容交给模型。",
			"mcp.tabs.label": "MCP 设置分区",
			"mcp.tab.servers": "服务器",
			"mcp.tab.settings": "设置",
			"mcp.list.title": "服务器列表",
			"mcp.count.rows": "{n} 行 · 已启用 {m}",
			"mcp.count.filtered": "匹配 {n} / 共 {m} 行",
			"mcp.search.label": "按名称或描述筛选服务器",
			"mcp.search.placeholder": "筛选名称或描述",
			"mcp.filter.label": "按 Agent 预设筛选，列表中同时显示全局行",
			"mcp.filter.option": "{name}",
			"mcp.empty.row": "这个筛选下还没有 MCP 服务器",
			"mcp.empty.row.hint": "当前筛选显示「{name}」这一档的行，加上所有全局行（全局行已在上面列出）；这一档还没有行，可以从这里新增。",
			"mcp.empty.addGlobal": "新增到全局",
			"mcp.empty.addAgent": "新增到 Agent 预设",
			"mcp.noMatch": "没有匹配的服务器",
			"mcp.noMatch.hint": "换个关键词，或清空筛选框。",
			"mcp.description.add": "添加描述",
			"mcp.description.budget": "模型只看到前 {n} 个字符，超出部分会被截掉。",
			"mcp.description.count": "{n}/{m}",
			"mcp.mode.title": "MCP 加载方式",
			"mcp.mode.eager": "全部加载",
			"mcp.mode.eager.desc": "原始方式，会话开始时把全部启动的 MCP 和工具加载进系统工具列表，不支持过滤某些工具",
			"mcp.mode.dynamic": "动态插入",
			"mcp.mode.dynamic.desc": "会话开始时不加载 MCP，用到后插入到系统工具列表，会打断一次缓存前缀，参数调用更加稳定",
			"mcp.mode.lazy": "延迟加载",
			"mcp.mode.lazy.desc": "会话开始时不加载 MCP，用到后插入到上下文，不会中断缓存前缀，消耗更少 token",
			"mcp.mode.saving": "正在保存加载方式……",
			"mcp.mode.saveFailed": "加载方式未能保存，列表仍是上一次生效的设置。",
			"mcp.notice.modeSaved": "加载方式已保存",
			"mcp.add": "新增 MCP",
			"mcp.notice.added": "已新增 MCP 服务器",
			"mcp.notice.saved": "已保存 MCP 服务器",
			"mcp.notice.enabled": "已启用 MCP 服务器",
			"mcp.notice.disabled": "已禁用 MCP 服务器",
			"mcp.row.editHint": "点击卡片打开编辑",
			"mcp.credential.tab": "密钥",
			"mcp.credential.env": "环境变量",
			"mcp.credential.header": "请求头",
			"mcp.credential.empty": "这行配置里还没有密钥。",
			"mcp.credential.unreadable": "JSON 暂时不可用：先到「配置」页把 JSON 改对，密钥才能编辑。",
			"mcp.credential.busy": "正在读取这行的配置……",
			"mcp.enable": "启用",
			"mcp.disable": "禁用",
			"mcp.loading": "正在读取……",
			"mcp.refreshing": "正在刷新列表……",
			"mcp.error.unaddressable": "这一行没有可写入的 Loader id，请刷新设置页后重试。",
			"mcp.error": "读取失败",
			"mcp.retry": "重试",
			"mcp.row.toggleFailed": "这次开关没有生效：",
			"mcp.row.scopeLabel": "{scope} · {name}",
			"mcp.issue.missingCommand": "缺少 command：stdio 行没有启动命令",
			"mcp.issue.missingUrl": "缺少 url：HTTP 行没有服务地址",
			"mcp.issue.unsupportedConfig": "传输方式无法识别，或这行配置解析不出可用的 MCP 配置",
			"mcp.issue.unreachableVariable": "引用的环境变量未设置：{names}",
			"mcp.issue.emptyCredential": "“{name}” 的值为空",
			"mcp.scopeGlobal": "全局",
			"mcp.global.unavailable": "这个组合没有唯一的文件型 Include，全局平面没有可写入的文件。",
			"mcp.readonly.composedRow": "这一行由组合或补丁层声明，不在你可写的 Include 文件里，所以设置页不能开关或编辑它。把这一行移动到你自己的 Include 文件后即可操作。",
			"mcp.readonly.noInclude": "这个组合没有你自己可写的文件型 Include，全局行无法从设置页开关或编辑。请在自己的组合文件里用一个 Include 行声明这些全局行。",
			"mcp.readonly.severalIncludes": "组合里有多个可写的文件型 Include，定不出这一行属于哪个文件，所以不能从设置页开关或编辑。",
			"mcp.readonly.unreadableInclude": "唯一可写的 Include 文件读不出来，无法确认这一行由它声明，所以不能从设置页开关或编辑。",
			"mcp.scopePreset": "预设",
			"mcp.descriptionPlaceholder": "描述（模型可见）",
			"mcp.descriptionLabel": "MCP 描述",
			"mcp.form.addTitle": "新增 MCP 服务器",
			"mcp.form.editTitle": "编辑 MCP 服务器",
			"mcp.form.close": "关闭",
			"mcp.form.hint": "粘贴 MCP 服务器的连接 JSON（Claude Code 兼容），保存时会解析校验。",
			"mcp.form.tabs": "编辑器分区",
			"mcp.form.tabConfig": "配置",
			"mcp.form.tabTools": "工具列表",
			"mcp.form.json": "JSON 配置",
			"mcp.form.jsonInvalid": "JSON 格式或字段不合法",
			"mcp.form.pendingConfig": "已保存，但这行配置尚未完整（变量未解析或密钥为空），在补齐前不能开启。",
			"mcp.form.cancel": "取消",
			"mcp.form.save": "保存",
			"mcp.form.saving": "保存中……",
			"mcp.form.saveFailed": "保存失败：",
			"mcp.form.required": "请填写必填项",
			"mcp.form.invalidKeyValue": "KEY=VALUE 格式无效",
			"mcp.form.scope": "配置范围",
			"mcp.form.noTarget": "这个组合里既没有可写入的 Agent 预设，也没有可写的全局 Include，无法在这里新增 MCP 行。",
			"mcp.form.preset": "预设 ID",
			"mcp.form.entryId": "行 ID",
			"mcp.form.entryIdPlaceholder": "默认为服务器名",
			"mcp.form.serverName": "服务器名",
			"mcp.form.description": "描述（写进系统提示，帮模型选要加载哪台）",
			"mcp.form.toolsHint": "取消勾选则不加载进上下文：当前加载 ≈{n} token，取消 ≈{m} token。",
			"mcp.form.toolsGlobal": "全局行由组合直接挂载，工具规则对它不生效，所以这里不可更改。改写到某个 Agent 预设后规则才有效。",
			"mcp.form.toolTokens": "≈{n}",
			"mcp.form.toolsLoading": "连接中……",
			"mcp.form.toolsAll": "全选",
			"mcp.form.toolsNone": "全不选",
			"mcp.form.toolsEmpty": "这台服务器没有提供任何工具。",
			"mcp.form.toolsNeedsName": "先填写服务器名，才能读取工具列表。",
			"mcp.form.transport": "传输方式",
			"mcp.form.stdio": "stdio（本地进程）",
			"mcp.form.streamableHttp": "Streamable HTTP",
			"mcp.form.http": "HTTP",
			"mcp.form.sse": "SSE",
			"mcp.form.command": "命令",
			"mcp.form.args": "参数（每行一个）",
			"mcp.form.argsPlaceholder": "--arg\n--flag",
			"mcp.form.env": "环境变量（每行 KEY=VALUE）",
			"mcp.form.keyValuePlaceholder": "KEY=VALUE",
			"mcp.form.cwd": "工作目录",
			"mcp.form.url": "URL",
			"mcp.form.headers": "请求头（每行 KEY=VALUE）",
			"mcp.status.disabled": "已禁用",
			"mcp.status.unconfigured": "未配置",
			"mcp.status.conditional": "条件启用",
			"mcp.status.configured": "已配置",
			"mcp.status.loading": "加载中",
			"mcp.status.starting": "启动中",
			"mcp.status.stopping": "停止中",
			"mcp.status.active": "运行中",
			"mcp.status.failed": "加载失败",
			"mcp.status.unloading": "卸载中",
			"opt.group.search": "工具检索",
			"opt.group.search.hint": "不加载整台服务器也能按用途找到工具。",
			"opt.search": "启用工具检索（mcp_search）",
			"opt.search.desc": "注册 mcp_search，让模型用关键词在已发现的全部 MCP 工具里查找，只返回命中的工具名与一行描述，不把参数 schema 带进上下文。关闭后模型只能自己猜该加载哪台服务器。",
			"opt.searchIndex": "检索时索引未缓存的服务器",
			"opt.searchIndex.desc": "打开后，检索会为还没有工具目录的服务器临时连一次（最多同时 3 台、单台 8 秒），结果写入缓存。关闭时检索只回答已缓存的服务器，并把未能查看的服务器名列出来，让模型先加载它们。",
			"opt.pageSize": "每次列出条数",
			"opt.pageSize.desc": "mcp_load / mcp_search 一次最多列出多少条工具；更长时结果会带 nextCursor，模型可以继续翻页，不必一次把整台服务器的工具倒进上下文。",
			"opt.group.load": "加载与列出",
			"opt.group.load.hint": "一次调用把多少内容放进上下文。",
			"opt.namesOnly": "默认只列工具名与描述",
			"opt.namesOnly.desc": "开启后 mcp_load 默认不返回参数 schema；模型确定要调用某个工具时，再用 mcp_load 的 tool 参数按名字取那一个的完整参数。关闭则每次列出都带完整参数。",
			"opt.maxTools": "单台服务器最多拉取",
			"opt.maxTools.desc": "一次 tools/list 翻页最多收集多少工具，防止超大服务器把上下文或内存撑满。超出上限时结果会标记 truncated；超出的部分不会被收集，query 也检索不到，只有调高上限才能看到。",
			"opt.group.catalog": "工具目录缓存",
			"opt.group.catalog.hint": "发现结果留在内存里的时长；命中缓存时检索不启动任何进程。",
			"opt.catalogTtl": "缓存有效期（分钟）",
			"opt.catalogTtl.desc": "0 表示不缓存，每次检索都重新连接。服务器自己声明的 ttlMs 更短时以服务器为准；服务器报告 tools/list_changed 时该服务器的缓存立即失效。",
			"opt.catalog.title": "目录状态",
			"opt.catalog.summary": "已缓存 {servers} 台服务器 / {tools} 个工具",
			"opt.catalog.empty": "还没有缓存任何服务器目录。模型加载或检索过一台服务器后，这里才会出现记录。",
			"opt.catalog.row": "{tools} 个工具 · {age}",
			"opt.catalog.age.seconds": "{n} 秒前",
			"opt.catalog.age.minutes": "{n} 分钟前",
			"opt.catalog.refresh": "刷新",
			"opt.catalog.clear": "清空缓存",
			"opt.catalog.cleared": "已清空 {n} 条缓存",
			"opt.catalog.truncated": "被上限截断",
			"opt.group.annotations": "工具注解与安全",
			"opt.group.annotations.hint": "MCP 注解是服务器的自我声明，规范要求客户端按不可信处理，所以这里只作为提示展示。",
			"opt.annotations": "列出时带工具注解",
			"opt.annotations.desc": "在工具列表里附带服务器声明的 read-only / destructive / idempotent / open-world 提示，让模型在调用前就知道哪些操作会改数据。",
			"opt.hideDestructive": "隐藏声明为破坏性的工具",
			"opt.hideDestructive.desc": "把 annotations.destructiveHint 为 true 的工具从本次会话的可见集合里去掉：既不注册也不能调用。只认显式声明，没有注解的工具不受影响；对已经加载的服务器不追溯，下一次加载生效。",
			"opt.state.saving": "保存中",
			"opt.state.saved": "已保存",
			"opt.state.failed": "保存失败",
			"opt.save.notWritable": "MCP 设置文档当前不可写，未能保存。",
			"opt.save.failed": "保存失败：",
			"unavailable": "设置当前不可用"
		};
		const en = {
			"nav": "MCP Management",
			"mcp.page.title": "MCP",
			"mcp.page.intro": "Manage the available MCP servers, when they enter the context, and how much of a tool list one call hands to the model.",
			"mcp.tabs.label": "MCP settings sections",
			"mcp.tab.servers": "Servers",
			"mcp.tab.settings": "Settings",
			"mcp.list.title": "Server list",
			"mcp.count.rows": "{n} row(s) · {m} enabled",
			"mcp.count.filtered": "{n} of {m} row(s) match",
			"mcp.search.label": "Filter servers by name or description",
			"mcp.search.placeholder": "Filter by name or description",
			"mcp.filter.label": "Filter by agent preset; global rows are listed too",
			"mcp.filter.option": "{name}",
			"mcp.empty.row": "No MCP server under this filter yet",
			"mcp.empty.row.hint": "The filter shows the rows of \"{name}\" plus every global row (the global rows, if any, are listed above); this preset holds none yet, and one can be added from here.",
			"mcp.empty.addGlobal": "Add to global",
			"mcp.empty.addAgent": "Add to an agent preset",
			"mcp.noMatch": "No server matches",
			"mcp.noMatch.hint": "Try another term, or clear the filter box.",
			"mcp.description.add": "Add a description",
			"mcp.description.budget": "The model sees the first {n} characters; the rest is cut.",
			"mcp.description.count": "{n}/{m}",
			"mcp.mode.title": "MCP loading",
			"mcp.mode.eager": "Load all",
			"mcp.mode.eager.desc": "The original behavior: at session start every started MCP and its tools load into the system tool list, and filtering individual tools is not supported.",
			"mcp.mode.dynamic": "Dynamic insert",
			"mcp.mode.dynamic.desc": "MCP is not loaded at session start; it is inserted into the system tool list once needed. That breaks the cache prefix once, and argument calls stay more stable.",
			"mcp.mode.lazy": "Lazy",
			"mcp.mode.lazy.desc": "MCP is not loaded at session start; it is inserted into context once needed. The cache prefix survives, and it costs fewer tokens.",
			"mcp.mode.saving": "Saving the loading mode…",
			"mcp.mode.saveFailed": "The loading mode was not saved; the list still shows the last setting that took effect.",
			"mcp.notice.modeSaved": "Loading mode saved",
			"mcp.add": "Add MCP",
			"mcp.notice.added": "MCP server added",
			"mcp.notice.saved": "MCP server saved",
			"mcp.notice.enabled": "MCP server enabled",
			"mcp.notice.disabled": "MCP server disabled",
			"mcp.row.editHint": "Click the card to edit",
			"mcp.credential.tab": "Credentials",
			"mcp.credential.env": "Environment",
			"mcp.credential.header": "Headers",
			"mcp.credential.empty": "This row carries no credentials yet.",
			"mcp.credential.unreadable": "The JSON is not readable right now: fix it on the Config tab before editing credentials.",
			"mcp.credential.busy": "Reading this row's configuration…",
			"mcp.enable": "Enable",
			"mcp.disable": "Disable",
			"mcp.loading": "Loading…",
			"mcp.refreshing": "Refreshing the list…",
			"mcp.error.unaddressable": "This row has no Loader id to write; refresh the settings page and try again.",
			"mcp.error": "Failed to read",
			"mcp.retry": "Retry",
			"mcp.row.toggleFailed": "The switch did not take effect:",
			"mcp.row.scopeLabel": "{scope} · {name}",
			"mcp.issue.missingCommand": "Missing command: a stdio row has no start command",
			"mcp.issue.missingUrl": "Missing url: an HTTP row has no server address",
			"mcp.issue.unsupportedConfig": "The transport is unrecognized, or this row parses to no usable MCP config",
			"mcp.issue.unreachableVariable": "Referenced environment variable(s) are not set: {names}",
			"mcp.issue.emptyCredential": "\"{name}\" is empty",
			"mcp.scopeGlobal": "Global",
			"mcp.global.unavailable": "This composition mounts no single file-backed Include, so the global plane has no file to write.",
			"mcp.readonly.composedRow": "The composition or a patch layer declares this row, not your own Include file, so the settings page cannot switch or edit it. Move the row into your own Include file to change it here.",
			"mcp.readonly.noInclude": "This composition mounts no file-backed Include of your own, so global rows cannot be switched or edited from the settings page. Declare them in an Include row inside your own composition file.",
			"mcp.readonly.severalIncludes": "Several writable file-backed Includes are mounted, so it is unclear which file owns this row; the settings page cannot switch or edit it.",
			"mcp.readonly.unreadableInclude": "The one writable Include file could not be read, so this row cannot be confirmed as one of its rows; the settings page cannot switch or edit it.",
			"mcp.scopePreset": "Preset",
			"mcp.descriptionPlaceholder": "Description (model-visible)",
			"mcp.descriptionLabel": "MCP description",
			"mcp.form.addTitle": "Add MCP server",
			"mcp.form.editTitle": "Edit MCP server",
			"mcp.form.close": "Close",
			"mcp.form.hint": "Paste the MCP connection JSON (Claude Code compatible); it is parsed and validated on save.",
			"mcp.form.tabs": "Editor sections",
			"mcp.form.tabConfig": "Config",
			"mcp.form.tabTools": "Tools",
			"mcp.form.json": "JSON config",
			"mcp.form.jsonInvalid": "Invalid JSON format or fields",
			"mcp.form.pendingConfig": "Saved, but this row is not fully configured yet (an unresolved variable or an empty credential). It cannot be switched on until that is fixed.",
			"mcp.form.cancel": "Cancel",
			"mcp.form.save": "Save",
			"mcp.form.saving": "Saving…",
			"mcp.form.saveFailed": "Save failed:",
			"mcp.form.required": "Required fields are missing",
			"mcp.form.invalidKeyValue": "Invalid KEY=VALUE line",
			"mcp.form.scope": "Config scope",
			"mcp.form.noTarget": "This composition mounts neither a writable agent preset nor a writable global Include, so no MCP row can be added here.",
			"mcp.form.preset": "Preset ID",
			"mcp.form.entryId": "Row ID",
			"mcp.form.entryIdPlaceholder": "Defaults to the server name",
			"mcp.form.serverName": "Server name",
			"mcp.form.description": "Description (written into the system prompt, so the model can pick which server to load)",
			"mcp.form.toolsHint": "An unchecked tool is not loaded into context: ≈{n} tokens loaded, ≈{m} tokens dropped.",
			"mcp.form.toolsGlobal": "The composition mounts a global row directly, so a tool rule cannot take effect on it and this pane is read-only. Author the row inside an agent preset to filter it.",
			"mcp.form.toolTokens": "≈{n}",
			"mcp.form.toolsLoading": "Connecting…",
			"mcp.form.toolsAll": "All",
			"mcp.form.toolsNone": "None",
			"mcp.form.toolsEmpty": "This server publishes no tools.",
			"mcp.form.toolsNeedsName": "Fill in the server name before tools can be listed.",
			"mcp.form.transport": "Transport",
			"mcp.form.stdio": "stdio (local process)",
			"mcp.form.streamableHttp": "Streamable HTTP",
			"mcp.form.http": "HTTP",
			"mcp.form.sse": "SSE",
			"mcp.form.command": "Command",
			"mcp.form.args": "Arguments (one per line)",
			"mcp.form.argsPlaceholder": "--arg\n--flag",
			"mcp.form.env": "Environment (one per line: KEY=VALUE)",
			"mcp.form.keyValuePlaceholder": "KEY=VALUE",
			"mcp.form.cwd": "Working directory",
			"mcp.form.url": "URL",
			"mcp.form.headers": "Headers (one KEY=VALUE per line)",
			"mcp.status.disabled": "Disabled",
			"mcp.status.unconfigured": "Not configured",
			"mcp.status.conditional": "Conditional",
			"mcp.status.configured": "Configured",
			"mcp.status.loading": "Loading",
			"mcp.status.starting": "Starting",
			"mcp.status.stopping": "Stopping",
			"mcp.status.active": "Running",
			"mcp.status.failed": "Failed to load",
			"mcp.status.unloading": "Unloading",
			"opt.group.search": "Tool search",
			"opt.group.search.hint": "Find tools by what they do without loading a server.",
			"opt.search": "Enable tool search (mcp_search)",
			"opt.search.desc": "Registers mcp_search, which matches keywords against every discovered MCP tool and returns only the matching names with a one-line description — no argument schemas in the context. Without it the model has to guess which server to load.",
			"opt.searchIndex": "Index uncached servers while searching",
			"opt.searchIndex.desc": "A search may connect to servers it has no tool list for (at most 3 at a time, 8 seconds each) and record the result. With this off, a search only answers for already-cached servers and names the ones it could not look inside, so the model loads those first.",
			"opt.pageSize": "Items per listing",
			"opt.pageSize.desc": "How many tools mcp_load and mcp_search list at once. A longer listing carries a nextCursor, so the model can page through a large server instead of pulling every tool into the context at once.",
			"opt.group.load": "Loading and listing",
			"opt.group.load.hint": "How much one call puts into the context.",
			"opt.namesOnly": "List names and descriptions only",
			"opt.namesOnly.desc": "With this on, mcp_load omits argument schemas by default; when the model decides to call one tool it fetches that tool's full arguments with mcp_load's `tool` parameter. Off, every listing carries the full schemas.",
			"opt.maxTools": "Tools collected per server",
			"opt.maxTools.desc": "How many tools one paginated tools/list walk may collect, so an enormous server cannot flood the context or memory. A listing cut short is marked truncated; the tools beyond the cap are collected nowhere and no query can reach them — only a higher cap reveals them.",
			"opt.group.catalog": "Tool catalogue cache",
			"opt.group.catalog.hint": "How long a discovery result stays usable; a cache hit means a search starts no process at all.",
			"opt.catalogTtl": "Cache lifetime (minutes)",
			"opt.catalogTtl.desc": "Zero disables reuse and reconnects on every search. A shorter ttlMs published by the server wins over this value, and a tools/list_changed notification invalidates that server immediately.",
			"opt.catalog.title": "Catalogue state",
			"opt.catalog.summary": "{servers} server(s) cached / {tools} tool(s)",
			"opt.catalog.empty": "No server catalogue yet. A record appears once the model loads or searches a server.",
			"opt.catalog.row": "{tools} tool(s) · {age}",
			"opt.catalog.age.seconds": "{n}s ago",
			"opt.catalog.age.minutes": "{n} min ago",
			"opt.catalog.refresh": "Refresh",
			"opt.catalog.clear": "Clear cache",
			"opt.catalog.cleared": "Cleared {n} record(s)",
			"opt.catalog.truncated": "cut short by the cap",
			"opt.group.annotations": "Annotations and safety",
			"opt.group.annotations.hint": "MCP annotations are server claims, and the spec requires clients to treat them as untrusted, so they are shown as hints only.",
			"opt.annotations": "Show tool annotations",
			"opt.annotations.desc": "Carry the server's read-only / destructive / idempotent / open-world hints in a listing, so the model can tell which operations change data before it calls one.",
			"opt.hideDestructive": "Hide tools declared destructive",
			"opt.hideDestructive.desc": "Removes tools whose annotations.destructiveHint is true from the session's visible set: neither registered nor callable. Only an explicit declaration counts, tools without annotations are unaffected, and an already-loaded server is not changed retroactively — the next load applies it.",
			"opt.state.saving": "Saving",
			"opt.state.saved": "Saved",
			"opt.state.failed": "Save failed",
			"opt.save.notWritable": "The MCP settings document is not writable; nothing was saved.",
			"opt.save.failed": "Save failed:",
			"unavailable": "Setting currently unavailable"
		};
		/**
		* The reason one read-only row reports, as a locale key.
		*
		* Both the row's tooltip and its editor's notice read this one map, so the two
		* surfaces cannot explain the same refusal differently.
		*/
		const MCP_READ_ONLY_REASON = {
			"composed-row": "mcp.readonly.composedRow",
			"no-writable-include": "mcp.readonly.noInclude",
			"several-writable-includes": "mcp.readonly.severalIncludes",
			"unreadable-include": "mcp.readonly.unreadableInclude"
		};
		//#endregion
		//#region src/client/McpEditor.tsx
		/** Settings key for one row (`global:<name>` or `preset:<id>:<name>`), shared with the Host's `mcpRowKey`. */
		function rowKey(scope, agentPreset, serverName) {
			return scope === "preset" ? `preset:${agentPreset}:${serverName}` : `global:${serverName}`;
		}
		/**
		* The composition a save addresses: an edited row keeps its own plane, and a new
		* row goes to the home its picker names. Undefined when the edited row has no
		* addressable entry.
		* @param mode - whether the dialog creates a row or replaces one.
		* @param server - the row being edited, when there is one.
		* @param choice - a new row's home: `''` for the global plane, else a preset id.
		* @returns the target to write, or undefined when there is none.
		*/
		function editorTarget(mode, server, choice) {
			if (mode === "edit") {
				if (server === void 0 || server.entryId === null) return void 0;
				return server.scope === "global" ? { scope: "global" } : {
					scope: "preset",
					agentPreset: server.presetId ?? ""
				};
			}
			return choice === "" ? { scope: "global" } : {
				scope: "preset",
				agentPreset: choice
			};
		}
		/** The connection-spec JSON prefilled in the box (no scope/title — those are fields). */
		function specJson(describe) {
			const spec = describe?.spec ?? {
				type: "stdio",
				command: "",
				args: [],
				env: {}
			};
			return JSON.stringify(flattenSpec(spec), null, 2);
		}
		/**
		* The credentials pane: the row's `env` (stdio) or `headers` (HTTP) as fields,
		* read from and written back to the JSON on the config pane.
		*
		* One datum with two views, rather than a second copy of it: a pasted spec, a
		* fixed command and a credential all end in the same save, so the JSON box has
		* to stay the thing that is written.
		* @param props.json - the JSON box's current text.
		* @param props.kind - the map this transport carries.
		* @param props.baseline - the values the pane opened with, for the changed-only merge.
		* @param props.disabled - whether the row's actions are closed.
		* @param props.onPush - apply one field's edit to the JSON box.
		* @param props.t - the section's translator.
		* @returns the credential fields, or why they cannot be shown.
		*/
		function McpCredentialsPane({ json, kind, baseline, disabled, onPush, t }) {
			const values = credentialValues(json, kind);
			if (values === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: McpSection_module_css_default.fieldHint,
				role: "status",
				children: t("mcp.credential.unreadable")
			});
			const label = kind === "env" ? t("mcp.credential.env") : t("mcp.credential.header");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.formField,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.formLabel,
						children: label
					}),
					values.entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.fieldHint,
						children: t("mcp.credential.empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: McpSection_module_css_default.credentialFields,
						children: values.entries.map(([key, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.credentialField,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: McpSection_module_css_default.credentialKey,
								children: key
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
								value,
								disabled: disabled || !values.editable,
								"aria-label": key,
								spellCheck: false,
								onChange: (event) => {
									onPush(kind, key, event.currentTarget.value);
								}
							})]
						}, key))
					}),
					values.editable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.descOver,
						children: t("mcp.credential.unreadable")
					})
				]
			});
		}
		/** Modal editor split into a pane for the row's fields and a pane for its tools. */
		function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, plane, tab: openTab, globalWritable, preset, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }) {
			const [tab, setTab] = (0, react.useState)(openTab);
			const tabId = (0, react.useId)();
			/**
			* A new row's home, as this dialog's own field: the empty value is the global
			* plane, any other value a preset id. An edited row's home is never this field
			* — it keeps its own plane — so the value only decides an add.
			*/
			const [choice, setChoice] = (0, react.useState)(initialTarget(plane, preset));
			const [presetOptions, setPresetOptions] = (0, react.useState)([]);
			/** Whether the preset read answered, so an empty list can be told from a pending one. */
			const [presetLoaded, setPresetLoaded] = (0, react.useState)(false);
			const [title, setTitle] = (0, react.useState)(server?.serverName ?? "");
			const [description, setDescription] = (0, react.useState)(descriptionInitial);
			const [json, setJson] = (0, react.useState)("");
			/**
			* The JSON box as it stood when the credentials pane opened, so a save only
			* writes back the values the user actually changed: a later spec load, or a
			* value left as the box spelled it, must survive untouched.
			*/
			const [credentialBase, setCredentialBase] = (0, react.useState)("");
			/**
			* The box's current text, for a merge that runs from a click rather than from
			* a render. A `setJson` is not visible to a handler that started in the same
			* tick, and the pane's own writes all land here too.
			*/
			const jsonBox = (0, react.useRef)("");
			/**
			* Whether the user has named the row themselves.
			*
			* The name is derivable from the spec (`@scope/pkg` → `pkg`), so a new row is
			* named as soon as its JSON says what it is. Typing in the field takes the name
			* back: from then on the JSON never touches it again.
			*/
			const nameTouched = (0, react.useRef)(false);
			const [localError, setLocalError] = (0, react.useState)(null);
			/**
			* What is wrong with the JSON box, if anything, shown under the box itself.
			*
			* A document that cannot be read is the one failure the user can fix right
			* there, so its reason sits beside the field rather than on the form's shared
			* error line at the bottom of the dialog.
			*/
			const [jsonError, setJsonError] = (0, react.useState)(null);
			const [configNotice, setConfigNotice] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			/**
			* What the rendered listing was taken for, so opening the pane again after the
			* form changed lists again instead of showing a listing that no longer
			* describes the row.
			*/
			const listedFor = (0, react.useRef)(null);
			const [tools, setTools] = (0, react.useState)(null);
			const [hiddenTools, setHiddenTools] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [toolsBusy, setToolsBusy] = (0, react.useState)(false);
			const [toolsError, setToolsError] = (0, react.useState)(null);
			const editKey = `${server?.scope ?? ""}:${server?.presetId ?? ""}:${server?.entryId ?? ""}`;
			/** The credential map this row's transport carries; `env` until the transport is known. */
			const credentialKind = (() => {
				try {
					return parseSpecText(json, t("mcp.form.jsonInvalid")).spec.type === "stdio" ? "env" : "headers";
				} catch {
					return "env";
				}
			})();
			/**
			* Name a new row from the spec it describes, while the user has not named it.
			*
			* The name is the one field of this form the JSON already answers — a spec's
			* `args`/`url` imply it — so asking for it before the paste is asking for
			* something the dialog can fill in. An edited row keeps its own name: renaming
			* it is a deliberate act, not a side effect of touching the JSON.
			* @param text - the JSON box's current text.
			*/
			const syncName = (text) => {
				if (mode !== "add" || nameTouched.current) return;
				try {
					const parsed = parseSpecText(text, t("mcp.form.jsonInvalid"));
					const suggested = parsed.serverName ?? serverNameFromSpec(parsed.spec);
					if (suggested !== "") setTitle(suggested);
				} catch {}
			};
			/**
			* Apply one credential field to the JSON box, which is the document the save
			* reads. A box this pane cannot parse or write leaves the field as it was: the
			* config pane is where a broken document gets fixed.
			*/
			const pushCredential = (kind, key, value) => {
				const next = credentialText(jsonBox.current, kind, key, value);
				if (next === void 0) return;
				jsonBox.current = next;
				setJson(next);
				syncName(next);
			};
			/**
			* Fold the credential fields the user changed into the form's JSON.
			*
			* Only the changed ones: the pane edits the box the user also edits by hand,
			* and a value it never showed must not be replaced by the version it read
			* when it opened.
			* @param text - the JSON box's current text.
			* @returns the text to save, or the input unchanged when nothing was edited.
			*/
			const mergeCredentials = (text) => mergeCredentialEdits(text, credentialBase);
			/**
			* Connect once and list what the server publishes.
			* @param spec - transport to connect with.
			* @param serverName - namespace for diagnostics; required by the Host.
			* @param fromRules - seed the checkboxes from the row's stored rules (the
			*   dialog's first listing); a later listing of the same row keeps the user's
			*   own choices and treats tools it has not seen before as enabled.
			*/
			const loadTools = (spec, serverName, fromRules) => {
				if (serverName.trim() === "") {
					setToolsError(t("mcp.form.toolsNeedsName"));
					return;
				}
				setToolsBusy(true);
				setToolsError(null);
				listMcpTools({
					spec,
					serverName
				}).then((result) => {
					setTools(result.tools);
					listedFor.current = listingKey(serverName, spec);
					setHiddenTools((previous) => {
						const filter = parseMcpToolFilter(toolRulesInitial);
						const next = /* @__PURE__ */ new Set();
						for (const tool of result.tools) if (fromRules ? !admits(filter, tool.name) : previous.has(tool.name)) next.add(tool.name);
						return next;
					});
					setToolsBusy(false);
				}, (cause) => {
					setToolsError(cause instanceof Error ? cause.message : String(cause));
					setToolsBusy(false);
				});
			};
			/**
			* The identity of one listing: the namespace and the spec it was taken for.
			* @param serverName - namespace the listing used.
			* @param spec - transport the listing connected with.
			* @returns the key two listings are compared by.
			*/
			const listingKey = (serverName, spec) => `${serverName}\u0000${JSON.stringify(spec)}`;
			/**
			* The reason the JSON box cannot be used, or null when it describes a usable
			* connection.
			*
			* The two levels the save checks, and nothing else: whether the document
			* parses, and whether the transport it describes is structurally complete. A
			* missing server name is not this box's business, and what only the Host can
			* answer (whether a `${...}` reference resolves) stays with the roster.
			* @param text - the JSON box's current text.
			* @returns the localized reason, or null when the box is usable.
			*/
			const jsonProblem = (text) => {
				try {
					const blocking = diagnoseMcpSpec(parseSpecText(text, t("mcp.form.jsonInvalid")).spec, {}).filter(isBlockingConfigIssue);
					return blocking.length === 0 ? null : formatMcpConfigIssues(blocking, t);
				} catch (cause) {
					return cause instanceof Error ? cause.message : t("mcp.form.jsonInvalid");
				}
			};
			/**
			* The spec and namespace the form currently describes, or null when there is
			* nothing to list.
			*
			* A box that cannot be read is reported beside itself and the pane holding it
			* comes back into view — a connection error about a spec that was never
			* readable would name the wrong thing. A row with no name yet says so in this
			* pane, because the name is the pane's own requirement.
			* @returns what a listing would connect with, or null when it cannot start.
			*/
			const listingTarget = () => {
				const problem = jsonProblem(json);
				if (problem !== null) {
					setJsonError(problem);
					setTab("config");
					return null;
				}
				const parsed = parseSpecText(json, t("mcp.form.jsonInvalid"));
				const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
				if (serverName === "") {
					setToolsError(t("mcp.form.toolsNeedsName"));
					return null;
				}
				return {
					spec: parsed.spec,
					serverName
				};
			};
			/**
			* List the tools of the spec the form currently shows. The JSON box is the
			* source, so an edited command or url is listed as edited.
			* @param fromRules - seed the checkboxes from the row's stored rules.
			*/
			const loadToolsFromForm = (fromRules) => {
				const target = listingTarget();
				if (target === null) return;
				loadTools(target.spec, target.serverName, fromRules);
			};
			/**
			* Opening the tools pane is the only trigger for a listing: connecting spawns
			* a child process for stdio rows, and a row the user only renames never needs
			* one. There is no load button, so the pane opens on what the form describes —
			* and lists again when the form changed since the listing it already has.
			* `tools` stays null until a listing was actually shown, which is what keeps
			* the save from rewriting the stored rules with an empty set.
			*/
			const pickTab = (next) => {
				setTab(next);
				if (next !== "tools" || loading || toolsBusy) return;
				if (toolsReadOnly) return;
				if (tools === null) {
					loadToolsFromForm(true);
					return;
				}
				if (jsonProblem(json) !== null) return;
				const parsed = parseSpecText(json, t("mcp.form.jsonInvalid"));
				const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
				if (listedFor.current === listingKey(serverName, parsed.spec)) return;
				loadTools(parsed.spec, serverName, false);
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				let current = true;
				setLocalError(null);
				setJsonError(null);
				setConfigNotice(null);
				setTab(openTab);
				setChoice(initialTarget(plane, preset));
				setPresetLoaded(false);
				nameTouched.current = false;
				setTitle(server?.serverName ?? "");
				setDescription(descriptionInitial);
				setTools(null);
				listedFor.current = null;
				setHiddenTools(/* @__PURE__ */ new Set());
				setToolsError(null);
				setToolsBusy(false);
				setLoading(false);
				presets().then((list) => {
					if (!current) return;
					setPresetOptions(list);
					setPresetLoaded(true);
					setChoice((previous) => {
						if (previous !== "" || mode !== "add") return previous;
						return plane === "global" && globalWritable ? previous : list[0]?.id ?? previous;
					});
				}, () => {
					if (current) {
						setPresetOptions([]);
						setPresetLoaded(true);
					}
				});
				if (mode === "edit" && server?.entryId) {
					setLoading(true);
					describeMcp({
						target: server.scope === "global" ? { scope: "global" } : {
							scope: "preset",
							agentPreset: server.presetId ?? ""
						},
						entryId: server.entryId
					}).then((described) => {
						if (!current) return;
						const text = specJson(described);
						jsonBox.current = text;
						setJson(text);
						setCredentialBase(text);
						setLoading(false);
					}, () => {
						if (!current) return;
						const text = specJson(void 0);
						jsonBox.current = text;
						setJson(text);
						setCredentialBase(text);
						setLoading(false);
					});
				} else {
					const text = specJson(void 0);
					jsonBox.current = text;
					setJson(text);
					setCredentialBase(text);
				}
				return () => {
					current = false;
				};
			}, [
				editKey,
				mode,
				open,
				openTab,
				server,
				descriptionInitial,
				presets,
				t
			]);
			const submit = async () => {
				try {
					const parsed = parseSpecText(mergeCredentials(json), t("mcp.form.jsonInvalid"));
					const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
					if (serverName === "") throw new Error(t("mcp.form.required"));
					const spec = parsed.spec;
					mcpEntryConfig(spec, serverName);
					const configIssue = diagnoseMcpSpec(spec, {});
					const blocking = configIssue.filter(isBlockingConfigIssue);
					if (blocking.length > 0) throw new Error(formatMcpConfigIssues(blocking, t));
					setConfigNotice(configIssue.length === 0 ? null : t("mcp.form.pendingConfig"));
					const target = editorTarget(mode, server, choice);
					if (target === void 0) throw new Error(noTargetReason);
					const entryId = mode === "edit" ? server?.entryId ?? "" : void 0;
					if (mode === "edit" && entryId === "") throw new Error(t("mcp.form.required"));
					onSubmit({
						target,
						serverName,
						spec,
						...entryId === void 0 ? {} : { entryId }
					});
					const key = rowKey(target.scope === "global" ? "global" : "preset", target.scope === "global" ? "" : target.agentPreset, serverName);
					if (description.trim() !== "") await onUpdateDescription(key, description.trim());
					if (tools !== null && !toolsReadOnly) await onUpdateTools(key, tools.filter((tool) => hiddenTools.has(tool.name)).map((tool) => `!${tool.name}`));
				} catch (cause) {
					setTab("config");
					const fromJson = jsonProblem(mergeCredentials(json));
					if (fromJson === null) setLocalError(cause instanceof Error ? cause.message : t("mcp.form.jsonInvalid"));
					else {
						setJsonError(fromJson);
						setLocalError(null);
					}
				}
			};
			const toggleTool = (name) => {
				setHiddenTools((previous) => {
					const next = new Set(previous);
					if (next.has(name)) next.delete(name);
					else next.add(name);
					return next;
				});
			};
			const readOnlyRow = mode === "edit" && server !== void 0 && !server.writable;
			const formDisabled = disabled || busy || readOnlyRow;
			const enabledCount = tools === null ? 0 : tools.length - tools.filter((tool) => hiddenTools.has(tool.name)).length;
			/**
			* What the current checkboxes cost a request: the definitions that stay in it,
			* and the ones the rules would keep out. Both are the same local estimate the
			* per-tool numbers use, summed.
			*/
			const loadedTokens = tools === null ? 0 : tools.reduce((sum, tool) => sum + (hiddenTools.has(tool.name) ? 0 : tool.tokens), 0);
			const droppedTokens = tools === null ? 0 : tools.reduce((sum, tool) => sum + (hiddenTools.has(tool.name) ? tool.tokens : 0), 0);
			const titleText = mode === "add" ? t("mcp.form.addTitle") : t("mcp.form.editTitle");
			const toolsReadOnly = mode === "edit" ? server?.scope === "global" : choice === "";
			const noTarget = mode === "add" && choice === "" && !globalWritable;
			const noTargetReason = presetLoaded && presetOptions.length === 0 ? t("mcp.form.noTarget") : t("mcp.global.unavailable");
			/** The plane this row is written to, as the dialog states it for an edited row. */
			const scopeLabel = mode === "edit" ? server?.scope === "global" ? t("mcp.scopeGlobal") : `${t("mcp.scopePreset")} · ${server?.presetId ?? ""}` : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose,
				title: titleText,
				closeLabel: t("mcp.form.close"),
				description: t("mcp.form.hint"),
				className: McpSection_module_css_default.mcpEditorDialog ?? "",
				contentClassName: McpSection_module_css_default.mcpEditorContent ?? "",
				footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.formActions,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "outline",
						size: "sm",
						onClick: onClose,
						disabled: busy,
						children: t("mcp.form.cancel")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						variant: "primary",
						size: "sm",
						onClick: () => {
							submit();
						},
						disabled: formDisabled || noTarget,
						children: busy ? t("mcp.form.saving") : t("mcp.form.save")
					})]
				}),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpForm,
					children: [
						readOnlyRow ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.fieldHint,
							role: "status",
							children: t(MCP_READ_ONLY_REASON[server.readOnly ?? "composed-row"])
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
							className: McpSection_module_css_default.editorTabs,
							label: t("mcp.form.tabs"),
							value: tab,
							onChange: pickTab,
							items: [
								{
									value: "config",
									label: t("mcp.form.tabConfig"),
									id: `${tabId}-config-tab`,
									panelId: `${tabId}-config-panel`
								},
								{
									value: "credentials",
									label: t("mcp.credential.tab"),
									id: `${tabId}-credentials-tab`,
									panelId: `${tabId}-credentials-panel`
								},
								{
									value: "tools",
									label: t("mcp.form.tabTools"),
									id: `${tabId}-tools-tab`,
									panelId: `${tabId}-tools-panel`
								}
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							id: `${tabId}-config-panel`,
							role: "tabpanel",
							"aria-labelledby": `${tabId}-config-tab`,
							className: McpSection_module_css_default.editorPanel,
							hidden: tab !== "config",
							children: [
								mode === "add" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: McpSection_module_css_default.formField,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpTargetSelect, {
										label: t("mcp.form.scope"),
										value: choice,
										presets: presetOptions,
										globalWritable,
										disabled: formDisabled,
										onChange: (next) => {
											setChoice(next);
											setLocalError(null);
										},
										t
									})
								}), globalWritable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.fieldHint,
									children: noTargetReason
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.formField,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.form.scope")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.fieldHint,
										children: scopeLabel
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.formField,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpSection_module_css_default.formLabel,
										children: [t("mcp.form.serverName"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.requiredMark,
											"aria-hidden": "true",
											children: "*"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										value: title,
										disabled: formDisabled,
										"aria-label": t("mcp.form.serverName"),
										"aria-required": "true",
										onChange: (event) => {
											nameTouched.current = true;
											setTitle(event.currentTarget.value);
											setLocalError(null);
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.formField,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.form.description")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										value: description,
										disabled: formDisabled,
										"aria-label": t("mcp.form.description"),
										onChange: (event) => {
											setDescription(event.currentTarget.value);
											setLocalError(null);
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.formField,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpSection_module_css_default.formLabel,
										children: [
											t("mcp.form.json"),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.requiredMark,
												"aria-hidden": "true",
												children: "*"
											}),
											jsonError === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.fieldError,
												role: "alert",
												children: jsonError
											})
										]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										className: McpSection_module_css_default.formJson,
										value: json,
										disabled: formDisabled,
										spellCheck: false,
										"aria-label": t("mcp.form.json"),
										"aria-required": "true",
										"aria-invalid": jsonError !== null,
										onChange: (event) => {
											jsonBox.current = event.currentTarget.value;
											setJson(event.currentTarget.value);
											syncName(event.currentTarget.value);
											setJsonError(null);
											setLocalError(null);
										},
										onBlur: () => {
											setJsonError(jsonProblem(jsonBox.current));
										}
									})]
								}),
								loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: McpSection_module_css_default.mcpStatus,
									children: t("mcp.loading")
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							id: `${tabId}-credentials-panel`,
							role: "tabpanel",
							"aria-labelledby": `${tabId}-credentials-tab`,
							className: McpSection_module_css_default.editorPanel,
							hidden: tab !== "credentials",
							children: loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpSection_module_css_default.mcpStatus,
								children: t("mcp.credential.busy")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpCredentialsPane, {
								json,
								kind: credentialKind,
								baseline: credentialBase,
								disabled: formDisabled,
								onPush: pushCredential,
								t
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							id: `${tabId}-tools-panel`,
							role: "tabpanel",
							"aria-labelledby": `${tabId}-tools-tab`,
							className: McpSection_module_css_default.editorPanel,
							hidden: tab !== "tools",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: McpSection_module_css_default.toolsHead,
									children: [tools !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.toolsCount,
										children: `${enabledCount}/${tools.length}`
									}) : null, tools !== null && tools.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpSection_module_css_default.toolsActions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											disabled: formDisabled || toolsReadOnly,
											onClick: () => {
												setHiddenTools(/* @__PURE__ */ new Set());
											},
											children: t("mcp.form.toolsAll")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											disabled: formDisabled || toolsReadOnly,
											onClick: () => {
												setHiddenTools(new Set(tools.map((tool) => tool.name)));
											},
											children: t("mcp.form.toolsNone")
										})]
									}) : null]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.fieldHint,
									children: toolsReadOnly ? t("mcp.form.toolsGlobal") : t("mcp.form.toolsHint").replace("{n}", loadedTokens.toLocaleString()).replace("{m}", droppedTokens.toLocaleString())
								}),
								toolsError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: McpSection_module_css_default.formError,
									role: "alert",
									children: toolsError
								}) : null,
								tools !== null && tools.length === 0 && !toolsBusy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: McpSection_module_css_default.mcpStatus,
									children: t("mcp.form.toolsEmpty")
								}) : null,
								tools !== null && tools.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: McpSection_module_css_default.toolsList,
									children: tools.map((tool) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: McpSection_module_css_default.toolRow,
										title: tool.description,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: !hiddenTools.has(tool.name),
												disabled: formDisabled || toolsReadOnly,
												"aria-label": tool.name,
												onChange: () => {
													toggleTool(tool.name);
												}
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.toolName,
												children: tool.name
											}),
											tool.description === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.toolDesc,
												children: tool.description
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.toolTokens,
												children: t("mcp.form.toolTokens").replace("{n}", tool.tokens.toLocaleString())
											})
										]
									}, tool.name))
								}) : null,
								toolsBusy ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: McpSection_module_css_default.toolsLoading,
									role: "status",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.spinner,
										"aria-hidden": "true"
									}), t("mcp.form.toolsLoading")]
								}) : null
							]
						}),
						localError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.formError,
							role: "alert",
							children: localError
						}) : null,
						configNotice !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpNotice,
							role: "status",
							children: configNotice
						}) : null,
						error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.formError,
							role: "alert",
							children: `${t("mcp.form.saveFailed")} ${error}`
						}) : null
					]
				})
			});
		}
		//#endregion
		//#region src/mcp-optimize.ts
		/** The policy a deployment runs when its settings document says nothing. */
		const MCP_OPTIMIZE_DEFAULTS = Object.freeze({
			search: true,
			searchIndex: false,
			pageSize: 10,
			namesOnly: true,
			catalogTtlMs: 3e5,
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
		/** Accepted range of {@link McpOptimizeFlags.catalogTtlMs}; zero means "never reuse". */
		const MCP_CATALOG_TTL_RANGE = Object.freeze({
			min: 0,
			max: 864e5
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
				catalogTtlMs: readNumber(record.catalogTtlMs, MCP_OPTIMIZE_DEFAULTS.catalogTtlMs, MCP_CATALOG_TTL_RANGE),
				maxTools: readNumber(record.maxTools, MCP_OPTIMIZE_DEFAULTS.maxTools, MCP_MAX_TOOLS_RANGE),
				annotations: readFlag(record.annotations, MCP_OPTIMIZE_DEFAULTS.annotations),
				hideDestructive: readFlag(record.hideDestructive, MCP_OPTIMIZE_DEFAULTS.hideDestructive)
			};
		}
		//#endregion
		//#region \0dsh-css:C:\02-codespace\DeepSeek\dsh-mcp-manager\src\client\McpOptimizeSection.module.css.mjs
		const css = "._tn7CW_section{box-sizing:border-box;flex-direction:column;gap:22px;width:100%;display:flex}._tn7CW_unavailable{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}._tn7CW_group{flex-direction:column;display:flex}._tn7CW_groupTitle{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);margin:0 0 2px;font-weight:600}._tn7CW_groupHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0 0 6px}._tn7CW_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px;padding:14px 0;display:flex}._tn7CW_group>._tn7CW_row:last-child{border-bottom:none;padding-bottom:2px}._tn7CW_rowText{flex-direction:column;gap:3px;min-width:0;padding-right:24px;display:flex}._tn7CW_rowLabel{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}._tn7CW_rowDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}._tn7CW_rowControl{flex:none;align-items:center;gap:8px;display:inline-flex}._tn7CW_rowState{min-width:42px;font:var(--dsw-font-xxs-12);text-align:right;color:var(--dsw-alias-label-tertiary)}._tn7CW_rowState[data-state=saving]{color:var(--dsw-alias-label-secondary)}._tn7CW_rowState[data-state=saved]{color:var(--dsw-alias-state-success-primary)}._tn7CW_rowState[data-state=failed]{color:var(--dsw-alias-state-error-primary)}._tn7CW_numberInput{width:88px}._tn7CW_numberInput input{box-sizing:border-box;text-align:right;width:100%;height:32px;padding:0 10px;font-size:13px;line-height:20px}._tn7CW_status{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-stroke);flex-direction:column;gap:8px;padding:12px 14px;display:flex}._tn7CW_statusHead{align-items:center;gap:10px;display:flex}._tn7CW_catalogSummary{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}._tn7CW_statusActions{align-items:center;gap:6px;margin-left:auto;display:inline-flex}._tn7CW_catalogEmpty{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}._tn7CW_catalogList{flex-direction:column;gap:4px;max-height:220px;margin:0;padding:0;list-style:none;display:flex;overflow:auto}._tn7CW_catalogRow{justify-content:space-between;align-items:baseline;gap:12px;padding:4px 2px;display:flex}._tn7CW_catalogKey{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._tn7CW_catalogMeta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}._tn7CW_failure{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);margin:0}@media (pointer:coarse){._tn7CW_row{min-height:44px}}";
		const tagId = "@guowenzhang/dsh-mcp-manager/McpOptimizeSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var McpOptimizeSection_module_css_default = {
			"catalogEmpty": "_tn7CW_catalogEmpty",
			"catalogKey": "_tn7CW_catalogKey",
			"catalogList": "_tn7CW_catalogList",
			"catalogMeta": "_tn7CW_catalogMeta",
			"catalogRow": "_tn7CW_catalogRow",
			"catalogSummary": "_tn7CW_catalogSummary",
			"failure": "_tn7CW_failure",
			"group": "_tn7CW_group",
			"groupHint": "_tn7CW_groupHint",
			"groupTitle": "_tn7CW_groupTitle",
			"numberInput": "_tn7CW_numberInput",
			"row": "_tn7CW_row",
			"rowControl": "_tn7CW_rowControl",
			"rowDesc": "_tn7CW_rowDesc",
			"rowLabel": "_tn7CW_rowLabel",
			"rowState": "_tn7CW_rowState",
			"rowText": "_tn7CW_rowText",
			"section": "_tn7CW_section",
			"status": "_tn7CW_status",
			"statusActions": "_tn7CW_statusActions",
			"statusHead": "_tn7CW_statusHead",
			"unavailable": "_tn7CW_unavailable"
		};
		//#endregion
		//#region src/client/McpOptimizeSection.tsx
		/**
		* MCP context-budget panel: how much of a tool list enters the context.
		*
		* The second tab of the MCP settings page. The roster answers "which servers
		* exist and when may a session load one"; this panel answers the orthogonal
		* question the MCP client best-practices guide calls progressive discovery —
		* whether the model can search before loading, whether a listing is paged,
		* whether argument schemas are deferred to the moment they are needed, and how
		* long a discovery result may be reused instead of reconnecting.
		*
		* Every control writes one field of the `mcp-manager` namespace's `optimize`
		* map through the shared controller, so the same document the Host reads is the
		* one this panel edits, and each row shows its own save state.
		*
		* Settings and state stay apart here: the policy rows are host-style preference
		* rows, and what the discovery cache currently holds is a status block of its
		* own rather than another row in the cache group it belongs to.
		* @module @guowenzhang/dsh-mcp-manager/client/McpOptimizeSection
		*/
		/** The localized text for one row's save state. */
		function stateText(state, t) {
			if (state === "saving") return t("opt.state.saving");
			if (state === "saved") return t("opt.state.saved");
			if (state === "failed") return t("opt.state.failed");
			return "";
		}
		/**
		* The localized headline for one failed save.
		* @param cause - the rejection the write failed with.
		* @param t - the section's translator.
		* @returns a localized line, with the raw reason kept as technical detail.
		*/
		function saveFailureMessage(cause, t) {
			const code = cause?.code;
			const detail = cause instanceof Error ? cause.message : String(cause);
			return code === "not-writable" ? t("opt.save.notWritable") : `${t("opt.save.failed")} ${detail}`;
		}
		/** How long a row keeps its "saved" note before the slot goes quiet again. */
		const SAVED_NOTE_MS = 2500;
		/** Settings that must be a whole number of milliseconds per minute in the UI. */
		const MS_PER_MINUTE = 6e4;
		/**
		* Render one boolean setting row.
		* @param props.field - the policy field the switch writes.
		* @param props.label - the localized row label, also the switch's accessible name.
		* @param props.desc - the localized one-line explanation under the label.
		* @param props.value - the committed value.
		* @param props.disabled - whether the document is writable.
		* @param props.state - this row's save state.
		* @param props.onWrite - called with the value the user asked for.
		* @param props.t - the section's translator.
		* @returns the row.
		*/
		function SwitchRow({ field, label, desc, value, disabled, state, onWrite, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpOptimizeSection_module_css_default.row,
				"data-optimize-field": field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpOptimizeSection_module_css_default.rowText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowLabel,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowDesc,
						children: desc
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpOptimizeSection_module_css_default.rowControl,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowState,
						"data-state": state,
						role: "status",
						children: stateText(state, t)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
						checked: value,
						onChange: (next) => {
							onWrite(field, next);
						},
						label,
						disabled,
						title: disabled ? t("unavailable") : void 0
					})]
				})]
			});
		}
		/**
		* Render one whole-number setting row.
		*
		* The field keeps a local draft so a half-typed value never reaches the Host;
		* the draft commits on blur or Enter and reverts when it is not a number.
		* @param props.field - the policy field the input writes.
		* @param props.label - the localized row label.
		* @param props.desc - the localized one-line explanation under the label.
		* @param props.value - the committed value, in the field's own unit.
		* @param props.min - smallest accepted value.
		* @param props.max - largest accepted value.
		* @param props.disabled - whether the document is writable.
		* @param props.state - this row's save state.
		* @param props.onWrite - called with the value the user asked for.
		* @param props.t - the section's translator.
		* @returns the row.
		*/
		function NumberRow({ field, label, desc, value, min, max, disabled, state, onWrite, t }) {
			const [draft, setDraft] = (0, react.useState)(String(value));
			(0, react.useEffect)(() => {
				setDraft(String(value));
			}, [value]);
			const commit = () => {
				const parsed = Number(draft);
				if (draft.trim() === "" || !Number.isFinite(parsed)) {
					setDraft(String(value));
					return;
				}
				const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
				setDraft(String(clamped));
				if (clamped !== value) onWrite(field, clamped);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpOptimizeSection_module_css_default.row,
				"data-optimize-field": field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpOptimizeSection_module_css_default.rowText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowLabel,
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowDesc,
						children: desc
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpOptimizeSection_module_css_default.rowControl,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpOptimizeSection_module_css_default.rowState,
						"data-state": state,
						role: "status",
						children: stateText(state, t)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						className: McpOptimizeSection_module_css_default.numberInput ?? "",
						type: "number",
						inputMode: "numeric",
						value: draft,
						min,
						max,
						"aria-label": label,
						disabled,
						onChange: (event) => {
							setDraft(event.currentTarget.value);
						},
						onBlur: commit,
						onKeyDown: (event) => {
							if (event.key === "Enter") event.currentTarget.blur();
						}
					})]
				})]
			});
		}
		/**
		* Localize how long ago one catalogue record was made.
		* @param ageMs - age in milliseconds.
		* @param t - the section's translator.
		* @returns the localized age.
		*/
		function ageText(ageMs, t) {
			const seconds = Math.round(ageMs / 1e3);
			if (seconds < 60) return t("opt.catalog.age.seconds").replace("{n}", String(seconds));
			return t("opt.catalog.age.minutes").replace("{n}", String(Math.round(seconds / 60)));
		}
		/** The MCP context-budget panel body. */
		function McpOptimizeSection(props) {
			const { useMcpSettings, setOptimize, catalogState, clearCatalog, t } = props;
			const state = useMcpSettings((snapshot) => snapshot);
			const policy = parseMcpOptimizeFlags(state.optimize);
			const disabled = !state.available || !state.writable;
			const [rowStates, setRowStates] = (0, react.useState)({});
			const savedTimers = (0, react.useRef)(/* @__PURE__ */ new Map());
			const [failure, setFailure] = (0, react.useState)(null);
			const [catalog, setCatalog] = (0, react.useState)({ status: "loading" });
			const [catalogRequest, setCatalogRequest] = (0, react.useState)(0);
			const [catalogBusy, setCatalogBusy] = (0, react.useState)(false);
			/**
			* The settled outcome of the last catalog clear, in the host's floating banner:
			* the catalog list below can be long, so a line under it scrolls out of view
			* exactly when the reader wants the answer. `seq` restarts the hold when the
			* same outcome is reported again.
			*/
			const [notice, setNotice] = (0, react.useState)(null);
			const noticeSeq = (0, react.useRef)(0);
			(0, react.useEffect)(() => () => {
				for (const timer of savedTimers.current.values()) clearTimeout(timer);
				savedTimers.current.clear();
			}, []);
			const markRow = (0, react.useCallback)((field, next) => {
				setRowStates((previous) => ({
					...previous,
					[field]: next
				}));
				const pending = savedTimers.current.get(field);
				if (pending !== void 0) {
					clearTimeout(pending);
					savedTimers.current.delete(field);
				}
				if (next !== "saved") return;
				savedTimers.current.set(field, window.setTimeout(() => {
					savedTimers.current.delete(field);
					setRowStates((previous) => previous[field] === "saved" ? {
						...previous,
						[field]: "idle"
					} : previous);
				}, SAVED_NOTE_MS));
			}, []);
			const write = (0, react.useCallback)((field, value) => {
				markRow(field, "saving");
				setFailure(null);
				setOptimize(field, value).then(() => {
					markRow(field, "saved");
				}, (cause) => {
					markRow(field, "failed");
					setFailure(saveFailureMessage(cause, t));
				});
			}, [
				markRow,
				setOptimize,
				t
			]);
			(0, react.useEffect)(() => {
				let current = true;
				setCatalog((previous) => previous.status === "ready" ? {
					...previous,
					refreshing: true
				} : { status: "loading" });
				catalogState().then((result) => {
					if (!current) return;
					setCatalog({
						status: "ready",
						entries: result.entries,
						total: result.total,
						refreshing: false
					});
				}, () => {
					if (current) setCatalog((previous) => previous.status === "ready" ? {
						...previous,
						refreshing: false
					} : { status: "error" });
				});
				return () => {
					current = false;
				};
			}, [catalogState, catalogRequest]);
			const rowState = (field) => rowStates[field] ?? "idle";
			const rowProps = {
				disabled,
				t,
				onWrite: write
			};
			const entries = catalog.status === "ready" ? catalog.entries : [];
			const toolCount = entries.reduce((total, entry) => total + entry.tools, 0);
			const clear = () => {
				setCatalogBusy(true);
				setFailure(null);
				setNotice(null);
				clearCatalog().then((result) => {
					noticeSeq.current += 1;
					setNotice({
						text: t("opt.catalog.cleared").replace("{n}", String(result.cleared)),
						seq: noticeSeq.current
					});
					setCatalogRequest((value) => value + 1);
				}, (cause) => {
					setFailure(cause instanceof Error ? cause.message : String(cause));
				}).finally(() => {
					setCatalogBusy(false);
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpOptimizeSection_module_css_default.section,
				children: [
					!state.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpOptimizeSection_module_css_default.unavailable,
						children: t("unavailable")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: McpOptimizeSection_module_css_default.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: McpOptimizeSection_module_css_default.groupTitle,
								children: t("opt.group.search")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpOptimizeSection_module_css_default.groupHint,
								children: t("opt.group.search.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
								field: "search",
								label: t("opt.search"),
								desc: t("opt.search.desc"),
								value: policy.search,
								state: rowState("search"),
								...rowProps
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
								field: "searchIndex",
								label: t("opt.searchIndex"),
								desc: t("opt.searchIndex.desc"),
								value: policy.searchIndex,
								state: rowState("searchIndex"),
								...rowProps
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "pageSize",
								label: t("opt.pageSize"),
								desc: t("opt.pageSize.desc"),
								value: policy.pageSize,
								min: MCP_PAGE_SIZE_RANGE.min,
								max: MCP_PAGE_SIZE_RANGE.max,
								state: rowState("pageSize"),
								...rowProps
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: McpOptimizeSection_module_css_default.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: McpOptimizeSection_module_css_default.groupTitle,
								children: t("opt.group.load")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpOptimizeSection_module_css_default.groupHint,
								children: t("opt.group.load.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
								field: "namesOnly",
								label: t("opt.namesOnly"),
								desc: t("opt.namesOnly.desc"),
								value: policy.namesOnly,
								state: rowState("namesOnly"),
								...rowProps
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "maxTools",
								label: t("opt.maxTools"),
								desc: t("opt.maxTools.desc"),
								value: policy.maxTools,
								min: MCP_MAX_TOOLS_RANGE.min,
								max: MCP_MAX_TOOLS_RANGE.max,
								state: rowState("maxTools"),
								...rowProps
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: McpOptimizeSection_module_css_default.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: McpOptimizeSection_module_css_default.groupTitle,
								children: t("opt.group.catalog")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpOptimizeSection_module_css_default.groupHint,
								children: t("opt.group.catalog.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(NumberRow, {
								field: "catalogTtlMs",
								label: t("opt.catalogTtl"),
								desc: t("opt.catalogTtl.desc"),
								value: Math.round(policy.catalogTtlMs / MS_PER_MINUTE),
								min: Math.round(MCP_CATALOG_TTL_RANGE.min / MS_PER_MINUTE),
								max: Math.round(MCP_CATALOG_TTL_RANGE.max / MS_PER_MINUTE),
								state: rowState("catalogTtlMs"),
								onWrite: (field, value) => {
									write(field, Number(value) * MS_PER_MINUTE);
								},
								disabled,
								t
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: McpOptimizeSection_module_css_default.group,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: McpOptimizeSection_module_css_default.groupTitle,
								children: t("opt.group.annotations")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpOptimizeSection_module_css_default.groupHint,
								children: t("opt.group.annotations.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
								field: "annotations",
								label: t("opt.annotations"),
								desc: t("opt.annotations.desc"),
								value: policy.annotations,
								state: rowState("annotations"),
								...rowProps
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SwitchRow, {
								field: "hideDestructive",
								label: t("opt.hideDestructive"),
								desc: t("opt.hideDestructive.desc"),
								value: policy.hideDestructive,
								state: rowState("hideDestructive"),
								...rowProps
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: McpOptimizeSection_module_css_default.status,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: McpOptimizeSection_module_css_default.statusHead,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpOptimizeSection_module_css_default.rowLabel,
										children: t("opt.catalog.title")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpOptimizeSection_module_css_default.catalogSummary,
										children: catalog.status === "ready" ? t("opt.catalog.summary").replace("{servers}", String(catalog.total)).replace("{tools}", String(toolCount)) : catalog.status === "error" ? t("mcp.error") : t("mcp.loading")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpOptimizeSection_module_css_default.statusActions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: catalogBusy,
											onClick: () => {
												setCatalogRequest((value) => value + 1);
											},
											children: t("opt.catalog.refresh")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: catalogBusy || catalog.status !== "ready" || catalog.total === 0,
											onClick: clear,
											children: t("opt.catalog.clear")
										})]
									})
								]
							}),
							catalog.status === "ready" && entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpOptimizeSection_module_css_default.catalogEmpty,
								children: t("opt.catalog.empty")
							}) : null,
							entries.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
								className: McpOptimizeSection_module_css_default.catalogList,
								children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
									className: McpOptimizeSection_module_css_default.catalogRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpOptimizeSection_module_css_default.catalogKey,
										children: entry.key
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpOptimizeSection_module_css_default.catalogMeta,
										children: [t("opt.catalog.row").replace("{tools}", String(entry.tools)).replace("{age}", ageText(entry.ageMs, t)), entry.truncated ? ` · ${t("opt.catalog.truncated")}` : ""]
									})]
								}, entry.key))
							}) : null
						]
					}),
					failure === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpOptimizeSection_module_css_default.failure,
						role: "alert",
						children: failure
					}),
					notice === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: notice.text,
						tone: "success",
						onDone: () => {
							setNotice((current) => current?.seq === notice.seq ? null : current);
						}
					}, notice.seq)
				]
			});
		}
		//#endregion
		//#region src/client/settings-controller.ts
		/** Settings namespace registered Host-side by @guowenzhang/dsh-mcp-manager: its Loader row id. */
		const MCP_SETTINGS_NS = "mcp-manager";
		/** Stable key for one MCP row (`<scope>:<name>` or `preset:<id>:<name>`), matching the Host's `mcpRowKey`. */
		function mcpRowKey(server) {
			return server.scope === "preset" ? `preset:${server.presetId ?? ""}:${server.serverName}` : `${server.scope}:${server.serverName}`;
		}
		/**
		* The local Loader row id from a loader-qualified id. A global mcp-client row
		* is addressed as `<includePath>:<id>`, and the host writes `serverName` into
		* the row's config; in the default add flow the local id equals that name.
		* @param qualified - loader-qualified entry id.
		* @returns the id segment after the last `:` separator.
		*/
		function localEntryId(qualified) {
			const separator = qualified.lastIndexOf(":");
			return separator < 0 ? qualified : qualified.slice(separator + 1);
		}
		/** The MCP loading modes in display order. */
		const MCP_LOADING_OPTIONS = [
			"eager",
			"dynamic",
			"lazy"
		];
		/**
		* Project the Host roster read onto the rows the section renders, keeping every
		* mcp-client occurrence (global plane plus each preset composition) without
		* deduplicating cross-scope repeats. Descriptions are not read here — they are
		* plugin-owned and merged by the section from the `descriptions` map.
		* @param roster - the roster read from the Host.
		* @returns one row per mcp-client occurrence, tagged with its config scope.
		*/
		function mapMcpServers(roster) {
			const rows = [];
			for (const entry of roster.entries) rows.push({
				entryId: entry.entryId,
				serverName: localEntryId(entry.entryId ?? ""),
				scope: "global",
				presetId: void 0,
				enabled: entry.enabled,
				writable: entry.writable !== false,
				...entry.readOnly === void 0 ? {} : { readOnly: entry.readOnly },
				fiberPhase: entry.fiberPhase,
				secretKeys: entry.secretKeys ?? [],
				...entry.configIssue === void 0 ? {} : { configIssue: entry.configIssue }
			});
			for (const preset of roster.presets) for (const row of preset.rows) rows.push({
				entryId: row.entryId,
				serverName: localEntryId(row.entryId ?? row.moduleName),
				scope: "preset",
				presetId: preset.id,
				enabled: row.enabled,
				writable: row.writable !== false,
				...row.readOnly === void 0 ? {} : { readOnly: row.readOnly },
				fiberPhase: row.fiberPhase,
				secretKeys: row.secretKeys ?? [],
				...row.configIssue === void 0 ? {} : { configIssue: row.configIssue }
			});
			return rows;
		}
		/**
		* A save failure carrying a stable code, so the page can show a localized
		* headline instead of raw Host text.
		*/
		var McpSaveError = class extends Error {
			code;
			constructor(code, message) {
				super(message);
				this.code = code;
				this.name = "McpSaveError";
			}
		};
		/** Owner handle over the `mcp-manager` namespace. */
		var McpSettingsController = class {
			scope;
			mcps;
			authoring;
			presets;
			suppressed;
			store;
			unsubscribe;
			/** One namespace write at a time: each queued write reads after the last landed. */
			writeQueue = Promise.resolve();
			/** Optimization fields this controller wrote, ahead of a possibly stale snapshot. */
			optimizeWritten = {};
			/**
			* @param scope - the `mcp-manager` configuration form.
			* @param mcps - Host-backed MCP roster read.
			* @param authoring - Host-backed MCP mutation callbacks.
			* @param presets - Host-backed agent-preset options loader.
			* @param suppressed - Host-backed reader of the rows the gate holds unmounted.
			*/
			constructor(scope, mcps, authoring, presets, suppressed) {
				this.scope = scope;
				this.mcps = mcps;
				this.authoring = authoring;
				this.presets = presets;
				this.suppressed = suppressed;
				this.store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)(this.projection());
				this.unsubscribe = scope.subscribe(() => this.publish());
			}
			/** Stop observing settings. */
			dispose() {
				this.unsubscribe();
			}
			/** Build the renderer face for this section. */
			inject() {
				return {
					hooks: { mcpSettings: this.store },
					setMcpLoading: (mode) => this.setMcpLoading(mode),
					updateMcpDescription: (key, description) => this.updateMcpDescription(key, description),
					updateMcpTools: (key, patterns) => this.updateMcpTools(key, patterns),
					setOptimize: (field, value) => this.setOptimize(field, value),
					addMcp: this.authoring.addMcp,
					editMcp: this.authoring.editMcp,
					disableMcp: this.authoring.disableMcp,
					describeMcp: this.authoring.describeMcp,
					listMcpTools: this.authoring.listMcpTools,
					catalogState: () => this.authoring.catalogState({}),
					clearCatalog: () => this.authoring.clearCatalog({}),
					suppressedMcps: this.suppressed,
					mcps: this.mcps,
					presets: this.presets
				};
			}
			/** Run one write after every write queued before it, failures not poisoning the chain. */
			enqueueWrite(task) {
				const run = this.writeQueue.then(task, task);
				this.writeQueue = run.then(() => void 0, () => void 0);
				return run;
			}
			/**
			* The current value of one settings map, for a read-modify-write.
			* @param field - the namespace field holding the map.
			* @returns the map as the snapshot currently reports it.
			* @throws {@link McpSaveError} when the document cannot be written.
			*/
			async readWritable(field) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) throw new McpSaveError("not-writable", "the MCP settings document is not writable");
				return snapshot.value?.[field] ?? {};
			}
			/**
			* Write one optimization field.
			*
			* The stored policy is one open map, so a field write is a read-modify-write
			* of that map rather than a separate namespace field. The Host converges every
			* field at read time, which is why nothing here validates the value: a bad one
			* falls back to its default instead of failing the namespace commit. Writes
			* are serialized and fold in every field this controller already wrote, so
			* two rows saving at once cannot drop each other's value through a stale
			* snapshot.
			* @param field - the policy field name.
			* @param value - the value to store.
			* @throws {@link McpSaveError} when the document is not writable, or when the
			*   Host rejects the write.
			*/
			setOptimize(field, value) {
				return this.enqueueWrite(async () => {
					const next = {
						...await this.readWritable("optimize"),
						...this.optimizeWritten,
						[field]: value
					};
					await this.scope.set("optimize", next);
					this.optimizeWritten = {
						...this.optimizeWritten,
						[field]: value
					};
				});
			}
			async updateMcpDescription(key, description) {
				await this.enqueueWrite(async () => {
					const next = { ...await this.readWritable("descriptions") };
					if (description === "") Reflect.deleteProperty(next, key);
					else next[key] = description;
					await this.scope.set("descriptions", next);
				});
			}
			async updateMcpTools(key, patterns) {
				await this.enqueueWrite(async () => {
					const next = { ...await this.readWritable("tools") };
					if (patterns.length === 0) Reflect.deleteProperty(next, key);
					else next[key] = [...patterns];
					await this.scope.set("tools", next);
				});
			}
			async setMcpLoading(mode) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) return;
				if (snapshot.value?.loading === mode) return;
				await this.scope.set("loading", mode);
			}
			projection() {
				const snapshot = this.scope.getSnapshot();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					loading: snapshot.value?.loading ?? "dynamic",
					descriptions: snapshot.value?.descriptions ?? {},
					tools: snapshot.value?.tools ?? {},
					optimize: snapshot.value?.optimize ?? {}
				};
			}
			publish() {
				this.store.set(this.projection());
			}
		};
		/**
		* Build the agent plane's filter from one roster read. Only presets that own
		* rows become options: the filter exists to shorten a long list, and an option
		* with nothing behind it would only add another empty view. Heaviest presets
		* come first, because they are what makes the list long.
		* @param rows - every roster row, both planes.
		* @param presets - the presets that same read declared, for display names.
		* @returns one option per preset that owns at least one MCP row.
		*/
		function mcpAgentFilterOptions(rows, presets) {
			const counts = /* @__PURE__ */ new Map();
			for (const row of rows) {
				const id = row.scope === "preset" ? row.presetId ?? "" : "";
				if (id === "") continue;
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
			const names = new Map(presets.map((preset) => [preset.id, preset.name]));
			return [...counts.entries()].map(([id, count]) => ({
				id,
				name: names.get(id) ?? id,
				count
			})).sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
		}
		/**
		* The agent rows one filter value shows. Callers pass a value the roster still
		* offers (see {@link mcpAgentFilterOptions}), so an unknown id shows nothing —
		* the section keeps the select and the list on one value instead of guessing.
		* @param rows - every roster row, both planes.
		* @param presetId - the chosen preset, or {@link MCP_ALL_PRESETS} for all of them.
		* @returns the agent-plane rows that value shows.
		*/
		function narrowMcpRows(rows, presetId) {
			const agentRows = rows.filter((row) => row.scope === "preset");
			return presetId === "" ? agentRows : agentRows.filter((row) => row.presetId === presetId);
		}
		//#endregion
		//#region src/client/mcp-row-state.ts
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
		function rowAllowed(enabled, suppressed) {
			if (enabled === false) return false;
			return enabled === true || enabled === "conditional" || suppressed;
		}
		//#endregion
		//#region src/client/McpSection.tsx
		/**
		* MCP management settings section: one settings page carrying both faces of the
		* plugin, the server roster and the context-budget policy.
		*
		* One list carries both planes, and no control chooses between them. The agent
		* picker narrows the list to one preset's rows plus every global row, and the
		* global rows keep their own "Global" tag: a session carries its global rows
		* whatever preset it runs, so a view that named a preset and then dropped them
		* would misstate what that session mounts. Which plane a *new* row goes to is
		* the creating dialog's own choice — the section cannot infer it: deriving the
		* target from the row the user last edited left the global plane unreachable in
		* a composition with no global row yet.
		*
		* A row is edited by clicking the card itself, which opens the pane the row
		* needs: credentials for a row that carries them, its configuration otherwise.
		*
		* The two faces are in-page tabs rather than two `settings.section`
		* registrations: the shell's nav is a flat, order-sorted list, so a second
		* registration reads as a second plugin.
		* @module @guowenzhang/dsh-mcp-manager/client/McpSection
		*/
		/**
		* Whether one row's actions are closed, and why.
		*
		* A row the Host's roster marks read-only has nowhere to write: a global row
		* only exists in the user's Include file when that file declares it. The
		* plane-level answer stays the fallback for a Host that reports no per-row flag
		* or that mounts no addressable file at all.
		* @param server - the rendered row.
		* @param busy - whether another authoring action is in flight.
		* @param planeUnavailable - whether the global plane has no addressable file.
		* @param planeReason - the plane-level reason, already localized.
		* @param t - the section's translator.
		* @returns the row's disabled flag and its tooltip reason.
		*/
		function rowActionState(server, busy, planeUnavailable, planeReason, t) {
			if (!server.writable) return {
				actionsDisabled: true,
				actionsReason: server.readOnly === void 0 ? planeReason : t(MCP_READ_ONLY_REASON[server.readOnly])
			};
			return planeUnavailable && server.scope === "global" ? {
				actionsDisabled: true,
				actionsReason: planeReason
			} : { actionsDisabled: busy };
		}
		/** Non-empty fiber-phase → localized status key. */
		const PHASE_LABEL = {
			loading: "mcp.status.loading",
			active: "mcp.status.active",
			failed: "mcp.status.failed",
			unloading: "mcp.status.unloading"
		};
		/** Non-empty fiber-phase → state-dot semantic. */
		const PHASE_DOT = {
			loading: "ongoing",
			active: "done",
			failed: "error",
			unloading: "ongoing"
		};
		/** MCP loading mode → localized option name. */
		const MODE_LABEL = {
			eager: "mcp.mode.eager",
			dynamic: "mcp.mode.dynamic",
			lazy: "mcp.mode.lazy"
		};
		/** MCP loading mode → localized one-line explanation. */
		const MODE_DESC = {
			eager: "mcp.mode.eager.desc",
			dynamic: "mcp.mode.dynamic.desc",
			lazy: "mcp.mode.lazy.desc"
		};
		/** One thrown value as the line a reader can act on. */
		function failureText(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/**
		* The stored loading mode, narrowed to a value the picker offers. The Host
		* narrows unknown stored values itself; this keeps the control's own value
		* inside its option set.
		* @param value - the mode the settings snapshot carries.
		* @returns an offered mode, defaulting the way the Host does.
		*/
		function loadingMode(value) {
			return value === "eager" || value === "lazy" ? value : "dynamic";
		}
		/**
		* Resolve one MCP row's displayed status label and dot, or undefined when the
		* row has nothing to report.
		*
		* An allowed row that the loading mode keeps unmounted is NOT a state: under
		* `dynamic`/`lazy` that is simply what every allowed row looks like, so
		* reporting it would put a badge on the whole list and mean nothing. What the
		* list still has to show is the one condition that stops a row from starting —
		* an incomplete connection config — and the life-cycle phases a user can act on.
		*
		* A row that renders a switch states its own on/off position, so a row the user
		* turned off needs no second label saying so; one the Host reports as off with
		* no switch to show it (a read-only row, or a row whose entry has no Loader id)
		* still does.
		* @param server - the rendered row.
		* @param hasSwitch - whether this row renders its own switch.
		* @param t - the section's translator.
		* @returns the label and dot to show, or undefined for a resting row.
		*/
		function statusOf(server, hasSwitch, t) {
			if ((server.configIssue ?? []).length > 0) return {
				label: t("mcp.status.unconfigured"),
				dot: "warning"
			};
			if (server.enabled === false) return hasSwitch ? void 0 : {
				label: t("mcp.status.disabled"),
				dot: "idle"
			};
			if (server.enabled === "conditional") return {
				label: t("mcp.status.conditional"),
				dot: "warning"
			};
			const phase = server.fiberPhase;
			if (phase === null || phase === "pending" || phase === "held") return void 0;
			return {
				label: t(PHASE_LABEL[phase]),
				dot: PHASE_DOT[phase]
			};
		}
		/**
		* The MCP loading mode picker: the shared segmented control for the three-way
		* choice, with the selected mode's one-line explanation underneath, so the
		* trade-off (prompt cost and cache-prefix churn against tool-binding quality) is
		* readable without leaving the page. The write reports its own saving and failed
		* states next to the control.
		*/
		function McpLoadingPicker({ value, disabled, status, onPick, onRetry, t }) {
			const pickerId = (0, react.useId)();
			const current = loadingMode(value);
			const options = MCP_LOADING_OPTIONS.map((mode) => ({
				value: mode,
				label: t(MODE_LABEL[mode]),
				...disabled ? {
					disabled: true,
					title: t("unavailable")
				} : {}
			}));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.modeBlock,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
						id: pickerId,
						value: current,
						options,
						onChange: onPick,
						label: t("mcp.mode.title"),
						disabled
					}),
					MCP_LOADING_OPTIONS.map((mode) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: `${pickerId}-${mode}-panel`,
						role: "tabpanel",
						"aria-labelledby": `${pickerId}-${mode}`,
						hidden: mode !== current,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.modeDesc,
							children: t(MODE_DESC[mode])
						})
					}, mode)),
					status.phase === "saving" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.modeStatus,
						role: "status",
						children: t("mcp.mode.saving")
					}) : null,
					status.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.mcpFailure,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "alert",
							children: t("mcp.mode.saveFailed")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled,
							onClick: () => {
								onRetry(status.mode);
							},
							children: t("mcp.retry")
						})]
					}) : null
				]
			});
		}
		/**
		* One row's authoring description.
		*
		* The description is the only user-written text that reaches the model (it is
		* the roster line in the system prompt), so it reads as content rather than as
		* an empty field: a borderless text at rest, a real input only while it is being
		* edited. Only an over-budget description warns, because the model sees the
		* first {@link MAX_DESCRIPTION_CHARS} characters of it and nothing says so
		* anywhere else.
		* @param props.value - the committed description.
		* @param props.disabled - whether the row's actions are closed.
		* @param props.onCommit - persist the edited text; rejects with the save reason.
		* @param props.t - the section's translator.
		* @returns the description control.
		*/
		function McpDescription({ value, disabled, onCommit, t }) {
			const [draft, setDraft] = (0, react.useState)(null);
			const [save, setSave] = (0, react.useState)("idle");
			const [failure, setFailure] = (0, react.useState)(null);
			const composing = (0, react.useRef)(false);
			const savedTimer = (0, react.useRef)(void 0);
			(0, react.useEffect)(() => () => {
				if (savedTimer.current !== void 0) clearTimeout(savedTimer.current);
			}, []);
			const commit = async (next) => {
				if (next === value) {
					setDraft(null);
					return;
				}
				setSave("saving");
				setFailure(null);
				try {
					await onCommit(next);
					setDraft(null);
					setSave("saved");
					if (savedTimer.current !== void 0) clearTimeout(savedTimer.current);
					savedTimer.current = window.setTimeout(() => {
						savedTimer.current = void 0;
						setSave((previous) => previous === "saved" ? "idle" : previous);
					}, 2500);
				} catch (cause) {
					setSave("failed");
					setFailure(saveFailureMessage(cause, t));
				}
			};
			if (draft === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: McpSection_module_css_default.descText,
				"data-empty": value === "",
				disabled,
				title: value === "" ? t("mcp.descriptionPlaceholder") : value,
				onClick: (event) => {
					event.stopPropagation();
					setDraft(value);
					setSave("idle");
					setFailure(null);
				},
				children: value === "" ? t("mcp.description.add") : value
			}), save === "saved" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: McpSection_module_css_default.descState,
				role: "status",
				children: t("opt.state.saved")
			}) : null] });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: McpSection_module_css_default.mcpDesc,
					value: draft,
					autoFocus: true,
					placeholder: t("mcp.descriptionPlaceholder"),
					"aria-label": t("mcp.descriptionLabel"),
					"aria-invalid": draft.length > 80,
					onChange: (event) => {
						setDraft(event.currentTarget.value);
					},
					onCompositionStart: () => {
						composing.current = true;
					},
					onCompositionEnd: () => {
						composing.current = false;
					},
					onBlur: () => {
						if (composing.current) return;
						commit(draft);
					},
					onKeyDown: (event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) event.currentTarget.blur();
						if (event.key === "Escape") {
							event.stopPropagation();
							setDraft(null);
							setSave("idle");
							setFailure(null);
						}
					}
				}),
				draft.length > 80 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: McpSection_module_css_default.descOver,
					role: "status",
					children: t("mcp.description.budget").replace("{n}", String(80))
				}) : null,
				save === "saving" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: McpSection_module_css_default.descState,
					role: "status",
					children: t("opt.state.saving")
				}) : null,
				save === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: McpSection_module_css_default.descState,
					"data-state": "failed",
					role: "alert",
					children: failure ?? t("opt.state.failed")
				}) : null
			] });
		}
		/** One rendered MCP server row: name, plugin-owned description, scope, status, and row actions. */
		function McpRow({ server, description, suppressed, action, onEditDescription, onEdit, onToggleDisabled, onRetry, actionsDisabled, actionsReason, t }) {
			const configIssue = server.configIssue ?? [];
			const unconfigured = configIssue.length > 0;
			const pending = action !== null && action.phase !== "failed" ? action.phase : null;
			const failure = action !== null && action.phase === "failed" ? action : null;
			const hasSwitch = server.entryId !== null;
			const status = pending === "enabling" ? {
				label: t("mcp.status.starting"),
				dot: "warning"
			} : pending === "disabling" ? {
				label: t("mcp.status.stopping"),
				dot: "warning"
			} : statusOf(server, hasSwitch, t);
			const allowed = rowAllowed(server.enabled, suppressed);
			const checked = pending === "enabling" ? true : pending === "disabling" ? false : allowed;
			const disabledNow = !allowed;
			const cannotEnable = unconfigured && !checked && pending === null;
			const editorTab = server.secretKeys.length > 0 ? "credentials" : "config";
			/** The plane marker's text: the global plane's own name, or the preset's id. */
			const planeLabel = server.scope === "global" ? t("mcp.scopeGlobal") : server.presetId ?? "";
			const openEditor = () => {
				onEdit(editorTab);
			};
			const clickable = !actionsDisabled;
			const fromRowControl = (target) => target instanceof HTMLElement && target.closest("button, input, select, textarea, a, label") !== null;
			const clickProps = clickable ? {
				onClick: (event) => {
					if (fromRowControl(event.target)) return;
					openEditor();
				},
				tabIndex: 0,
				onKeyDown: (event) => {
					if (fromRowControl(event.target)) return;
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					openEditor();
				},
				title: actionsReason === void 0 ? t("mcp.row.editHint") : void 0
			} : {};
			const switchTitle = actionsReason !== void 0 ? actionsReason : cannotEnable ? `${t("mcp.status.unconfigured")}: ${formatMcpConfigIssues(configIssue, t)}` : checked ? t("mcp.disable") : t("mcp.enable");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.mcpRow,
				"data-mcp-scope": server.scope,
				"data-mcp-name": server.serverName,
				"data-clickable": clickable ? "true" : void 0,
				...clickProps,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpMain,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.mcpName,
							children: server.serverName
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpDescription, {
							value: description,
							disabled: actionsDisabled,
							onCommit: onEditDescription,
							t
						}),
						failure === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.rowFailure,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								children: `${t("mcp.row.toggleFailed")} ${failure.message}`
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: actionsDisabled,
								onClick: () => {
									onRetry(failure.target);
								},
								children: t("mcp.retry")
							})]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpRight,
					children: [
						status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.status,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: status.dot }), status.label]
						}),
						planeLabel === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.rowScope,
							children: planeLabel
						}),
						hasSwitch ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked,
							onChange: onToggleDisabled,
							label: disabledNow ? t("mcp.enable") : t("mcp.disable"),
							disabled: actionsDisabled || pending !== null || cannotEnable,
							title: switchTitle
						}) : null
					]
				})]
			});
		}
		/**
		* First-paint placeholder shaped like the roster cards it replaces, so the
		* section does not reflow when the read answers.
		*/
		function McpRosterSkeleton({ label }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: McpSection_module_css_default.visuallyHidden,
				role: "status",
				children: label
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: McpSection_module_css_default.skeletonList,
				"aria-hidden": "true",
				children: [
					0,
					1,
					2
				].map((index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.skeletonRow,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: McpSection_module_css_default.skeletonBar }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: McpSection_module_css_default.skeletonBar })]
				}, index))
			})] });
		}
		/** The MCP management section body: the roster tab and the context-budget tab. */
		function McpSection(props) {
			const { useMcpSettings, t, setMcpLoading, addMcp, editMcp, disableMcp, describeMcp, listMcpTools, suppressedMcps, mcps, presets, updateMcpDescription, updateMcpTools } = props;
			const state = useMcpSettings((snapshot) => snapshot);
			const [tab, setTab] = (0, react.useState)("servers");
			const tabsId = (0, react.useId)();
			const [mcpView, setMcpView] = (0, react.useState)({ status: "loading" });
			const [mcpRequest, setMcpRequest] = (0, react.useState)(0);
			const [editor, setEditor] = (0, react.useState)({
				mode: "add",
				server: void 0,
				open: false
			});
			/**
			* The pane the editor opens on. Held beside {@link editor} so opening the same
			* row's credentials twice re-states the request instead of leaving the dialog
			* on whatever pane the user left it.
			*/
			const [openedTab, setOpenedTab] = (0, react.useState)("config");
			/** The plane a dialog opened from the section starts on; the dialog owns it from there. */
			const [openedPlane, setOpenedPlane] = (0, react.useState)("agent");
			const [editorBusy, setEditorBusy] = (0, react.useState)(false);
			const [editorError, setEditorError] = (0, react.useState)(null);
			/**
			* The settled outcome of the last row edit, toggle or mode change, reported in
			* the host's floating banner: the roster can be long, so a line under it
			* scrolls out of view exactly when the reader wants the answer. `seq` restarts
			* the hold when the same outcome is reported again. A failure keeps its own
			* longer hold and names what the Host refused.
			*/
			const [notice, setNotice] = (0, react.useState)(null);
			const noticeSeq = (0, react.useRef)(0);
			const reportNotice = (text) => {
				noticeSeq.current += 1;
				setNotice({
					text,
					seq: noticeSeq.current
				});
				setMcpActionError(null);
			};
			const reportRefusal = (text) => {
				noticeSeq.current += 1;
				setNotice(null);
				setMcpActionError({
					text,
					seq: noticeSeq.current
				});
			};
			const [rowAction, setRowAction] = (0, react.useState)({});
			const [modeSave, setModeSave] = (0, react.useState)({ phase: "idle" });
			const [search, setSearch] = (0, react.useState)("");
			/**
			* A failure no single row can carry.
			*
			* A row whose entry has no Loader id renders no switch at all, so the click
			* that reaches the toggle came from a roster that moved underneath it; there
			* is no row left to hold the reason, and the page states it instead.
			*/
			const [mcpActionError, setMcpActionError] = (0, react.useState)(null);
			const [agentFilter, setAgentFilter] = (0, react.useState)("");
			const disabled = !state.available || !state.writable;
			const servers = mcpView.status === "ready" ? mcpView.servers : [];
			const presetNames = mcpView.status === "ready" ? mcpView.presets : [];
			const globalServers = servers.filter((server) => server.scope === "global");
			const presetChoices = (() => {
				const merged = /* @__PURE__ */ new Map();
				for (const preset of presetNames) merged.set(preset.id, {
					id: preset.id,
					name: preset.name,
					count: 0
				});
				for (const option of mcpAgentFilterOptions(servers, presetNames)) merged.set(option.id, {
					id: option.id,
					name: option.name,
					count: option.count
				});
				return [...merged.values()];
			})();
			const activePreset = presetChoices.some((option) => option.id === agentFilter) ? agentFilter : presetChoices[0]?.id ?? "";
			const activePresetName = presetChoices.find((option) => option.id === activePreset)?.name ?? "";
			const presetServers = narrowMcpRows(servers, activePreset);
			const listedServers = [...globalServers, ...presetServers];
			const descriptionOf = (server) => server.description ?? state.descriptions[mcpRowKey(server)] ?? "";
			const needle = search.trim().toLowerCase();
			const matches = (server) => needle === "" || server.serverName.toLowerCase().includes(needle) || descriptionOf(server).toLowerCase().includes(needle);
			const visibleGlobal = globalServers.filter(matches);
			const visiblePreset = presetServers.filter(matches);
			const visibleCount = visibleGlobal.length + visiblePreset.length;
			const enabledCount = listedServers.filter((server) => server.enabled !== false).length;
			const globalUnavailable = mcpView.status === "ready" && !mcpView.globalWritable;
			const unavailableReason = t("mcp.global.unavailable");
			(0, react.useEffect)(() => {
				let current = true;
				setMcpView((previous) => previous.status === "ready" ? {
					...previous,
					refreshing: true
				} : { status: "loading" });
				Promise.resolve().then(suppressedMcps).catch((error) => {
					console.error("[mcp-manager] MCP gate read failed", error);
					return [];
				}).then(async (suppressed) => ({
					suppressed,
					roster: await mcps()
				})).then(({ roster, suppressed }) => {
					if (!current) return;
					setMcpView({
						status: "ready",
						servers: roster.servers,
						presets: roster.presets,
						suppressed: new Set(suppressed),
						globalWritable: roster.globalWritable,
						refreshing: false
					});
				}, () => {
					if (current) setMcpView((previous) => previous.status === "ready" ? {
						...previous,
						refreshing: false
					} : { status: "error" });
				});
				return () => {
					current = false;
				};
			}, [
				mcps,
				suppressedMcps,
				mcpRequest
			]);
			/**
			* Persisting the mode changes which rows are mounted, so the roster is
			* re-read once the Host has applied it: the gate read resolves only after
			* every composed row reached its new state. The picker reports the write's own
			* saving and failed states; a failing gate read after a committed write is not
			* a failed save, so the roster is refreshed from whatever the read can answer.
			*/
			const pickMode = (mode) => {
				setModeSave({ phase: "saving" });
				setNotice(null);
				(async () => {
					try {
						await setMcpLoading(mode);
					} catch {
						setModeSave({
							phase: "failed",
							mode
						});
						return;
					}
					setModeSave({ phase: "idle" });
					reportNotice(t("mcp.notice.modeSaved"));
					await suppressedMcps().catch(() => []);
					refreshMcps();
				})();
			};
			const openAdd = (plane = "agent") => {
				setOpenedPlane(plane);
				setOpenedTab("config");
				setEditor({
					mode: "add",
					server: void 0,
					open: true
				});
				setEditorError(null);
				setNotice(null);
				setMcpActionError(null);
			};
			const openEdit = (server, tab = "config") => {
				setOpenedTab(tab);
				setEditor({
					mode: "edit",
					server,
					open: true
				});
				setEditorError(null);
				setNotice(null);
				setMcpActionError(null);
			};
			const closeEditor = () => {
				if (editorBusy) return;
				setEditor((previous) => ({
					...previous,
					open: false
				}));
				setEditorError(null);
			};
			const refreshMcps = () => {
				setMcpRequest((value) => value + 1);
			};
			const submitEditor = async (request) => {
				setEditorBusy(true);
				setEditorError(null);
				try {
					if (editor.mode === "add") await addMcp(request);
					else await editMcp(request);
					setEditor({
						mode: editor.mode,
						server: void 0,
						open: false
					});
					reportNotice(editor.mode === "add" ? t("mcp.notice.added") : t("mcp.notice.saved"));
					refreshMcps();
				} catch (cause) {
					setEditorError(failureText(cause));
				} finally {
					setEditorBusy(false);
				}
			};
			/**
			* Flip one row's enablement without blocking the list. The row immediately
			* shows its target state and a transient starting/stopping label; the Host
			* call (which starts or stops the child MCP process) runs in the background
			* and the list refreshes with the real state when it settles. A failed call
			* leaves the roster as it was and keeps the reason and a retry in that row.
			*/
			const toggleDisabled = (server, enabled) => {
				const entryId = server.entryId;
				setMcpActionError(null);
				if (entryId === null) {
					reportRefusal(t("mcp.error.unaddressable"));
					return;
				}
				const key = mcpRowKey(server);
				const target = server.scope === "global" ? { scope: "global" } : {
					scope: "preset",
					agentPreset: server.presetId ?? ""
				};
				setNotice(null);
				setRowAction((previous) => ({
					...previous,
					[key]: { phase: enabled ? "enabling" : "disabling" }
				}));
				(async () => {
					try {
						await disableMcp({
							target,
							entryId,
							disabled: !enabled
						});
						reportNotice(enabled ? t("mcp.notice.enabled") : t("mcp.notice.disabled"));
						setRowAction((previous) => {
							const next = { ...previous };
							delete next[key];
							return next;
						});
					} catch (cause) {
						setRowAction((previous) => ({
							...previous,
							[key]: {
								phase: "failed",
								message: failureText(cause),
								target: enabled
							}
						}));
					} finally {
						refreshMcps();
					}
				})();
			};
			const rowFor = (server) => {
				const key = mcpRowKey(server);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpRow, {
					server,
					description: descriptionOf(server),
					suppressed: mcpView.status === "ready" && mcpView.suppressed.has(key),
					action: rowAction[key] ?? null,
					onEditDescription: (value) => updateMcpDescription(key, value),
					onEdit: (tab) => {
						openEdit(server, tab);
					},
					onToggleDisabled: (enabled) => {
						toggleDisabled(server, enabled);
					},
					onRetry: (enabled) => {
						toggleDisabled(server, enabled);
					},
					...rowActionState(server, editorBusy, globalUnavailable, unavailableReason, t),
					t
				}, key);
			};
			/**
			* What the list says when the current view renders no row.
			*
			* Two different nothings: a search that matched nothing (the roster itself is
			* not what is wrong), and a view whose preset and global planes are both
			* empty. The second one carries the way out, because a plane with no row is
			* exactly where a user looks for one — and it only offers the write that
			* view's plane can take, so a button cannot promise what the Host refuses.
			* @returns the empty-state block, or null when the list has rows.
			*/
			const emptyList = () => {
				if (mcpView.status !== "ready" || visibleGlobal.length + visiblePreset.length > 0) return null;
				const searching = needle !== "";
				const plane = presetServers.length + visiblePreset.length > 0 || presetChoices.length > 0 ? "agent" : "global";
				const canAdd = plane === "global" ? !globalUnavailable : presetChoices.length > 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.emptyBlock,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.empty,
							children: searching ? t("mcp.noMatch") : t("mcp.empty.row")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.emptyHint,
							children: searching ? t("mcp.noMatch.hint") : t("mcp.empty.row.hint").replace("{name}", activePresetName)
						}),
						!searching && !disabled && canAdd ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								openAdd(plane);
							},
							children: plane === "global" ? t("mcp.empty.addGlobal") : t("mcp.empty.addAgent")
						}) : null
					]
				});
			};
			/**
			* The loading mode lives on the settings tab: it is one of the two inputs that
			* govern the roster (the row switch is the other), but it is a page-level
			* preference, not a property of the list it sits beside.
			*/
			const loadingSection = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: McpSection_module_css_default.block,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: McpSection_module_css_default.blockHead,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: McpSection_module_css_default.blockTitle,
							children: t("mcp.mode.title")
						})
					}),
					!state.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.unavailable,
						children: t("unavailable")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpLoadingPicker, {
						value: state.loading,
						disabled,
						status: modeSave,
						onPick: pickMode,
						onRetry: pickMode,
						t
					})
				]
			});
			const rosterPanel = /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: McpSection_module_css_default.block,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.listHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.listHeadText,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								className: McpSection_module_css_default.blockTitle,
								children: t("mcp.list.title")
							}), mcpView.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: McpSection_module_css_default.count,
								children: needle === "" ? t("mcp.count.rows").replace("{n}", String(listedServers.length)).replace("{m}", String(enabledCount)) : t("mcp.count.filtered").replace("{n}", String(visibleCount)).replace("{m}", String(listedServers.length))
							}) : null]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.listActions,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								onClick: () => {
									openAdd();
								},
								disabled: disabled || editorBusy,
								title: disabled ? t("unavailable") : void 0,
								children: t("mcp.add")
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.listFilters,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "search",
							className: McpSection_module_css_default.rosterSearch,
							value: search,
							placeholder: t("mcp.search.placeholder"),
							"aria-label": t("mcp.search.label"),
							onChange: (event) => {
								setSearch(event.currentTarget.value);
							}
						}), presetChoices.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: McpSection_module_css_default.mcpFilterSelect,
							value: activePreset,
							"aria-label": t("mcp.filter.label"),
							onChange: (event) => {
								setAgentFilter(event.currentTarget.value);
							},
							children: presetChoices.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: option.id,
								children: t("mcp.filter.option").replace("{name}", option.name)
							}, option.id))
						}) : null]
					}),
					mcpView.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpRosterSkeleton, { label: t("mcp.loading") }) : null,
					mcpView.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.mcpFailure,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							role: "alert",
							children: t("mcp.error")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							size: "sm",
							onClick: refreshMcps,
							children: t("mcp.retry")
						})]
					}) : null,
					mcpView.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.mcpList,
						children: [
							visibleGlobal.map((server) => rowFor(server)),
							visiblePreset.map((server) => rowFor(server)),
							emptyList()
						]
					}) : null,
					mcpView.status === "ready" && mcpView.refreshing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.mcpStatus,
						role: "status",
						children: t("mcp.refreshing")
					}) : null,
					mcpActionError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: mcpActionError.text,
						holdMs: 6e3,
						onDone: () => {
							setMcpActionError((current) => current?.seq === mcpActionError.seq ? null : current);
						}
					}, `refusal-${String(mcpActionError.seq)}`) : null,
					notice !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: notice.text,
						tone: "success",
						onDone: () => {
							setNotice((current) => current?.seq === notice.seq ? null : current);
						}
					}, `notice-${String(notice.seq)}`) : null
				]
			}) });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: McpSection_module_css_default.pageHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: McpSection_module_css_default.pageTitle,
							children: t("mcp.page.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.pageIntro,
							children: t("mcp.page.intro")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
						className: McpSection_module_css_default.tabs,
						label: t("mcp.tabs.label"),
						value: tab,
						onChange: setTab,
						items: [{
							value: "servers",
							label: t("mcp.tab.servers"),
							id: `${tabsId}-servers-tab`,
							panelId: `${tabsId}-servers-panel`
						}, {
							value: "settings",
							label: t("mcp.tab.settings"),
							id: `${tabsId}-settings-tab`,
							panelId: `${tabsId}-settings-panel`
						}]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: `${tabsId}-servers-panel`,
						role: "tabpanel",
						"aria-labelledby": `${tabsId}-servers-tab`,
						className: McpSection_module_css_default.tabPanel,
						hidden: tab !== "servers",
						children: rosterPanel
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						id: `${tabsId}-settings-panel`,
						role: "tabpanel",
						"aria-labelledby": `${tabsId}-settings-tab`,
						className: McpSection_module_css_default.tabPanel,
						hidden: tab !== "settings",
						children: [loadingSection, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpOptimizeSection, { ...props })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpEditor, {
						open: editor.open,
						mode: editor.mode,
						server: editor.server,
						disabled: false,
						busy: editorBusy,
						error: editorError,
						describeMcp,
						listMcpTools,
						presets,
						plane: openedPlane,
						tab: openedTab,
						globalWritable: mcpView.status === "ready" && mcpView.globalWritable,
						...activePreset === "" ? {} : { preset: activePreset },
						descriptionInitial: editor.server === void 0 ? "" : descriptionOf(editor.server),
						onUpdateDescription: updateMcpDescription,
						toolRulesInitial: editor.server === void 0 ? [] : toolRuleEntries(state.tools[mcpRowKey(editor.server)]),
						onUpdateTools: updateMcpTools,
						t,
						onClose: closeEditor,
						onSubmit: (request) => {
							submitEditor(request);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/remote.ts
		/** Wire namespace and Cordis service key of the MCP authoring owner. */
		const REMOTE_NAMESPACE = "mcpManager";
		/** Permissive strict codec: accepts any value, returns it unchanged. */
		const passthrough = { parse: (value) => value };
		/**
		* One strict codec over {@link passthrough}.
		*
		* Both schema seats carry the same parse contract because the Host's Typert
		* registry changed the strict codec shape: Hosts up to
		* `perf(typert): materialize generated schemas on first use` validate
		* `schema.parse`, later ones require a `create()` factory and call it when a
		* boundary first uses the codec (`validateCodec` rejects a strict codec
		* without it). The published `@deepseek-ai/dsh-typert-protocol` release this
		* package dev-depends on still declares `schema` alone, so the literal cannot
		* satisfy those types while carrying `create`; drop the assertion once a
		* published protocol version declares `create`.
		* @param typeSymbol - generated-style type symbol naming this codec.
		* @returns the strict codec handed to `ctx.remote.$mount`.
		*/
		function codec(typeSymbol) {
			return {
				mode: "strict",
				typeSymbol,
				schema: passthrough,
				create: () => passthrough
			};
		}
		function descriptor(method) {
			const owner = `@guowenzhang/dsh-mcp-manager#${`${REMOTE_NAMESPACE}/${method}`}`;
			return {
				id: owner,
				service: REMOTE_NAMESPACE,
				namespace: REMOTE_NAMESPACE,
				method,
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: codec(`${owner}:request`)
				}],
				result: codec(`${owner}:result`)
			};
		}
		/** Contribution mounted by the browser half to reach the MCP authoring owner. */
		const TYPERT_REMOTE = {
			package: "@guowenzhang/dsh-mcp-manager",
			descriptors: [
				descriptor("addMcp"),
				descriptor("editMcp"),
				descriptor("disableMcp"),
				descriptor("describeMcp"),
				descriptor("listMcps"),
				descriptor("listMcpTools"),
				descriptor("gateState"),
				descriptor("catalogState"),
				descriptor("clearCatalog")
			]
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"configForms",
			"remote"
		];
		/** Unwrap a Typert `RemoteResult` or surface the Host failure. */
		async function unwrapRemote(call) {
			const result = await call();
			if (!result.ok) throw new Error(result.error.message);
			return result.value;
		}
		/**
		* Register the dictionaries and the MCP management settings section.
		* @param ctx - client root context.
		*/
		async function apply(ctx) {
			const disposeMount = await ctx.remote.$mount(TYPERT_REMOTE);
			ctx.effect(() => () => disposeMount(), "mcp-manager: remote mount");
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-mcp-manager: dictionaries");
			const t = ctx.locale.bind(NS);
			const mcpMgr = () => {
				const namespace = ctx.get(`remote.${REMOTE_NAMESPACE}`);
				if (namespace === void 0) throw new Error(`${REMOTE_NAMESPACE} namespace service is not mounted`);
				return namespace;
			};
			const readRoster = () => unwrapRemote(() => mcpMgr().listMcps({}));
			const mcps = async () => {
				const roster = await readRoster();
				return {
					servers: mapMcpServers(roster),
					presets: roster.presets.map((preset) => ({
						id: preset.id,
						name: preset.name ?? preset.id
					})),
					globalWritable: roster.globalWritable
				};
			};
			const authoring = {
				addMcp: (request) => unwrapRemote(() => mcpMgr().addMcp(request)),
				editMcp: (request) => unwrapRemote(() => mcpMgr().editMcp(request)),
				disableMcp: (request) => unwrapRemote(() => mcpMgr().disableMcp(request)),
				describeMcp: (request) => unwrapRemote(() => mcpMgr().describeMcp(request)),
				listMcpTools: (request) => unwrapRemote(() => mcpMgr().listMcpTools(request)),
				catalogState: (request) => unwrapRemote(() => mcpMgr().catalogState(request)),
				clearCatalog: (request) => unwrapRemote(() => mcpMgr().clearCatalog(request))
			};
			const presets = async () => {
				return (await readRoster()).presets.map((preset) => ({
					id: preset.id,
					name: preset.name ?? preset.id
				}));
			};
			const suppressedMcps = async () => unwrapRemote(() => mcpMgr().gateState({})).then((state) => state.suppressed);
			const controller = new McpSettingsController(ctx.configForms.get(MCP_SETTINGS_NS), mcps, authoring, presets, suppressedMcps);
			ctx.effect(() => () => {
				controller.dispose();
			}, "ui-mcp-manager: settings form");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mcp-manager",
				order: 14,
				label: () => t("nav"),
				locale: NS,
				inject: () => controller.inject()
			}, McpSection));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
