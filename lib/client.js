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
		//#region src/client/locales.ts
		/** Locale namespace owned by this plugin's settings section. */
		const NS = "settings.mcpManager";
		const zh = {
			"nav": "MCP 管理",
			"mcp.page.title": "MCP",
			"mcp.page.intro": "管理可用的 MCP 服务器，决定它们何时进上下文、一次把多少工具内容交给模型。",
			"mcp.tabs.label": "MCP 设置分区",
			"mcp.tab.servers": "服务器",
			"mcp.tab.context": "上下文",
			"mcp.list.title": "服务器列表",
			"mcp.list.hint": "开关决定「允不允许用」；什么时候进上下文由上面的加载方式决定。",
			"mcp.count.rows": "{n} 行 · 已启用 {m}",
			"mcp.count.filtered": "匹配 {n} / 共 {m} 行",
			"mcp.search.label": "按名称或描述筛选服务器",
			"mcp.search.placeholder": "筛选名称或描述",
			"mcp.filter.label": "按 Agent 预设过滤",
			"mcp.filter.all": "全部 Agent 预设",
			"mcp.filter.option": "{name}",
			"mcp.group.global": "全局 · {n} 行",
			"mcp.group.agentAll": "Agent 预设 · {n} 行",
			"mcp.group.agent": "Agent 预设 · {name} · {n} 行",
			"mcp.empty.global": "还没有全局行",
			"mcp.empty.global.hint": "全局行对所有会话都可用；工具过滤对它不生效。",
			"mcp.empty.agent": "还没有 Agent 预设里的 MCP 行",
			"mcp.empty.agent.hint": "加到某个 Agent 预设后，才能按需加载和过滤工具。",
			"mcp.empty.addGlobal": "新增到全局",
			"mcp.empty.addAgent": "新增到 Agent 预设",
			"mcp.noMatch": "没有匹配的服务器",
			"mcp.noMatch.hint": "换个关键词，或清空筛选框。",
			"mcp.description.add": "添加描述",
			"mcp.description.budget": "模型只看到前 {n} 个字符，超出部分会被截掉。",
			"mcp.description.count": "{n}/{m}",
			"mcp.mode.title": "MCP 加载方式",
			"mcp.mode.when": "立即生效：切换会重建工具面，已加载的连接可能被释放。",
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
			"mcp.import": "导入 Claude 配置",
			"mcp.import.title": "导入 Claude MCP 配置",
			"mcp.import.hint": "从 Claude Code 的配置文件读取 MCP 服务器，勾选后导入到下面选定的范围。来源文件不会被修改。",
			"mcp.import.loading": "正在读取配置……",
			"mcp.import.empty": "没有找到可导入的 MCP 服务器",
			"mcp.import.emptyHint": "已查找 ~/.claude.json、~/.claude/settings.json、~/.claude/settings.local.json 和项目 .mcp.json。",
			"mcp.import.retry": "重新读取",
			"mcp.import.selectAll": "全选",
			"mcp.import.selectNone": "全不选",
			"mcp.import.selected": "已选 {n}/{m}",
			"mcp.import.duplicate": "重复",
			"mcp.import.existing": "已存在",
			"mcp.import.unsupported": "不支持的传输方式",
			"mcp.import.secrets": "环境变量",
			"mcp.import.headers": "请求头",
			"mcp.import.scope": "导入到",
			"mcp.import.submit": "导入所选",
			"mcp.import.submitting": "导入中……",
			"mcp.import.noneSelected": "请先勾选要导入的服务器",
			"mcp.import.done": "已导入 {n} 台服务器",
			"mcp.import.partial": "已导入 {n} 台，{m} 台失败",
			"mcp.import.failed": "导入失败",
			"mcp.import.close": "关闭",
			"mcp.import.source.user": "Claude Code 用户配置",
			"mcp.import.source.projectScope": "用户配置中的项目分区",
			"mcp.import.source.settings": "Claude Code 设置",
			"mcp.import.source.projectFile": "项目 .mcp.json",
			"mcp.import.problem.missing": "文件不存在",
			"mcp.import.problem.unreadable": "文件无法读取",
			"mcp.import.problem.malformed": "JSON 解析失败",
			"mcp.import.problem.too-large": "文件过大",
			"mcp.import.problem.unsupported": "无法解析该条目",
			"mcp.import.problem.unsupported-name": "名称不符合服务器名规范",
			"mcp.notice.added": "已新增 MCP 服务器",
			"mcp.notice.saved": "已保存 MCP 服务器",
			"mcp.notice.enabled": "已启用 MCP 服务器",
			"mcp.notice.disabled": "已禁用 MCP 服务器",
			"mcp.edit": "编辑",
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
			"mcp.form.presetScope": "Agent 预设",
			"mcp.form.noPreset": "这个组合里没有可写入的 Agent 预设，无法新增 MCP 行。",
			"mcp.form.noTarget": "这个组合里既没有可写入的 Agent 预设，也没有可写的全局 Include，无法在这里新增 MCP 行。",
			"mcp.form.preset": "预设 ID",
			"mcp.form.entryId": "行 ID",
			"mcp.form.entryIdPlaceholder": "默认为服务器名",
			"mcp.form.serverName": "服务器名",
			"mcp.form.description": "描述（写进系统提示，帮模型选要加载哪台）",
			"mcp.form.toolsHint": "默认全部启用。取消勾选的方法不会交给模型：既不列出，也不能调用。",
			"mcp.form.toolsGlobal": "全局行由组合直接挂载，工具规则对它不生效，所以这里不可更改。改写到某个 Agent 预设后规则才有效。",
			"mcp.form.toolsReload": "加载工具列表",
			"mcp.form.toolsLoading": "连接中……",
			"mcp.form.toolsAll": "全选",
			"mcp.form.toolsNone": "全不选",
			"mcp.form.toolsEmpty": "这台服务器没有提供任何工具。",
			"mcp.form.toolsNeedsName": "先填写服务器名，再加载工具列表。",
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
			"opt.intro": "控制一次调用把多少工具内容交给模型：先检索、按需加载、按页列出、默认只带名称。改动对下一次加载或检索生效，已经加载的服务器不追溯。",
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
			"opt.maxTools.desc": "一次 tools/list 翻页最多收集多少工具，防止超大服务器把上下文或内存撑满。超出上限时结果会标记 truncated，提示模型改用 query 检索。",
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
			"unavailable": "设置当前不可用"
		};
		const en = {
			"nav": "MCP Management",
			"mcp.page.title": "MCP",
			"mcp.page.intro": "Manage the available MCP servers, when they enter the context, and how much of a tool list one call hands to the model.",
			"mcp.tabs.label": "MCP settings sections",
			"mcp.tab.servers": "Servers",
			"mcp.tab.context": "Context",
			"mcp.list.title": "Server list",
			"mcp.list.hint": "The switch means \"may be used\"; the loading mode above decides when it enters the context.",
			"mcp.count.rows": "{n} row(s) · {m} enabled",
			"mcp.count.filtered": "{n} of {m} row(s) match",
			"mcp.search.label": "Filter servers by name or description",
			"mcp.search.placeholder": "Filter by name or description",
			"mcp.filter.label": "Filter by agent preset",
			"mcp.filter.all": "All agent presets",
			"mcp.filter.option": "{name}",
			"mcp.group.global": "Global · {n} row(s)",
			"mcp.group.agentAll": "Agent presets · {n} row(s)",
			"mcp.group.agent": "Agent preset · {name} · {n} row(s)",
			"mcp.empty.global": "No global rows yet",
			"mcp.empty.global.hint": "A global row is available to every session; tool filters never apply to it.",
			"mcp.empty.agent": "No MCP rows in an agent preset yet",
			"mcp.empty.agent.hint": "Add one to an agent preset to load it on demand and filter its tools.",
			"mcp.empty.addGlobal": "Add to global",
			"mcp.empty.addAgent": "Add to an agent preset",
			"mcp.noMatch": "No server matches",
			"mcp.noMatch.hint": "Try another term, or clear the filter box.",
			"mcp.description.add": "Add a description",
			"mcp.description.budget": "The model sees the first {n} characters; the rest is cut.",
			"mcp.description.count": "{n}/{m}",
			"mcp.mode.title": "MCP loading",
			"mcp.mode.when": "Takes effect immediately: switching rebuilds the tool surface and may release loaded connections.",
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
			"mcp.import": "Import Claude config",
			"mcp.import.title": "Import Claude MCP configuration",
			"mcp.import.hint": "Read MCP servers from the Claude Code configuration files and import the selected ones into the scope chosen below. Source files are not modified.",
			"mcp.import.loading": "Reading configuration…",
			"mcp.import.empty": "No importable MCP servers found",
			"mcp.import.emptyHint": "Looked in ~/.claude.json, ~/.claude/settings.json, ~/.claude/settings.local.json, and the project .mcp.json.",
			"mcp.import.retry": "Read again",
			"mcp.import.selectAll": "All",
			"mcp.import.selectNone": "None",
			"mcp.import.selected": "Selected {n}/{m}",
			"mcp.import.duplicate": "Duplicate",
			"mcp.import.existing": "Already exists",
			"mcp.import.unsupported": "Unsupported transport",
			"mcp.import.secrets": "Environment",
			"mcp.import.headers": "Headers",
			"mcp.import.scope": "Import into",
			"mcp.import.submit": "Import selected",
			"mcp.import.submitting": "Importing…",
			"mcp.import.noneSelected": "Select at least one server to import",
			"mcp.import.done": "Imported {n} servers",
			"mcp.import.partial": "Imported {n}, {m} failed",
			"mcp.import.failed": "Import failed",
			"mcp.import.close": "Close",
			"mcp.import.source.user": "Claude Code user config",
			"mcp.import.source.projectScope": "Project scope in the user config",
			"mcp.import.source.settings": "Claude Code settings",
			"mcp.import.source.projectFile": "Project .mcp.json",
			"mcp.import.problem.missing": "File not found",
			"mcp.import.problem.unreadable": "File is unreadable",
			"mcp.import.problem.malformed": "JSON could not be parsed",
			"mcp.import.problem.too-large": "File is too large",
			"mcp.import.problem.unsupported": "Entry could not be parsed",
			"mcp.import.problem.unsupported-name": "Name does not fit the server-name rule",
			"mcp.notice.added": "MCP server added",
			"mcp.notice.saved": "MCP server saved",
			"mcp.notice.enabled": "MCP server enabled",
			"mcp.notice.disabled": "MCP server disabled",
			"mcp.edit": "Edit",
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
			"mcp.form.presetScope": "Agent preset",
			"mcp.form.noPreset": "This composition mounts no writable agent preset, so no MCP row can be added.",
			"mcp.form.noTarget": "This composition mounts neither a writable agent preset nor a writable global Include, so no MCP row can be added here.",
			"mcp.form.preset": "Preset ID",
			"mcp.form.entryId": "Row ID",
			"mcp.form.entryIdPlaceholder": "Defaults to the server name",
			"mcp.form.serverName": "Server name",
			"mcp.form.description": "Description (written into the system prompt, so the model can pick which server to load)",
			"mcp.form.toolsHint": "All enabled by default. An unchecked tool never reaches the model: it is neither listed nor callable.",
			"mcp.form.toolsGlobal": "The composition mounts a global row directly, so a tool rule cannot take effect on it and this pane is read-only. Author the row inside an agent preset to filter it.",
			"mcp.form.toolsReload": "Load tools",
			"mcp.form.toolsLoading": "Connecting…",
			"mcp.form.toolsAll": "All",
			"mcp.form.toolsNone": "None",
			"mcp.form.toolsEmpty": "This server publishes no tools.",
			"mcp.form.toolsNeedsName": "Fill in the server name before loading tools.",
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
			"opt.intro": "Control how much of a tool list one call hands to the model: search first, load on demand, list by page, names only by default. A change applies to the next load or search; already-loaded servers are not revisited.",
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
			"opt.maxTools.desc": "How many tools one paginated tools/list walk may collect, so an enormous server cannot flood the context or memory. A listing cut short is marked truncated and tells the model to narrow it with a query.",
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
		//#region \0dsh-css:C:\02-codespace\DeepSeek\dsh-mcp-manager\src\client\McpSection.module.css.mjs
		const css$1 = ".y1VbRq_section{box-sizing:border-box;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;display:flex;container:y1VbRq_mcp-manager/inline-size}.y1VbRq_pageHead{flex-direction:column;gap:4px;display:flex}.y1VbRq_pageTitle{font:var(--dsw-font-base-strong-16);margin:0}.y1VbRq_pageIntro{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_tabs{box-sizing:border-box;flex:none;align-self:flex-start;width:100%;max-width:320px}.y1VbRq_tabPanel{flex-direction:column;gap:16px;display:flex}.y1VbRq_tabPanel[hidden]{display:none}.y1VbRq_block{flex-direction:column;gap:12px;display:flex}.y1VbRq_blockHead{flex-wrap:wrap;align-items:baseline;gap:4px 12px;display:flex}.y1VbRq_blockTitle{font:var(--dsw-font-s-14);margin:0;font-weight:600}.y1VbRq_when{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.y1VbRq_modeBlock{flex-direction:column;align-items:flex-start;gap:8px;display:flex}.y1VbRq_modeDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);margin:0}.y1VbRq_modeStatus{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_listHead{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;display:flex}.y1VbRq_listHeadText{align-items:baseline;gap:8px;min-width:0;display:flex}.y1VbRq_count{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}.y1VbRq_listActions{flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;display:inline-flex}.y1VbRq_listHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_listFilters{flex-wrap:wrap;gap:8px;display:flex}.y1VbRq_rosterSearch{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);min-width:0;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);flex:220px;padding:0 10px}.y1VbRq_rosterSearch::placeholder{color:var(--dsw-alias-label-caption)}.y1VbRq_mcpFilterSelect{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);max-width:240px;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);padding:0 10px}.y1VbRq_mcpList{flex-direction:column;gap:10px;display:flex}.y1VbRq_mcpGroup{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-tertiary);margin:6px 0 0}.y1VbRq_emptyBlock{flex-direction:column;align-items:flex-start;gap:6px;padding:2px 0 4px;display:flex}.y1VbRq_empty{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_emptyHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_mcpRow{box-sizing:border-box;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);justify-content:space-between;align-items:flex-start;gap:14px;padding:12px 14px;display:flex}.y1VbRq_mcpMain{flex-direction:column;flex:auto;gap:4px;min-width:0;display:flex}.y1VbRq_mcpName{font:var(--dsw-font-s-14);font-weight:600;font-family:var(--ds-font-family-code);overflow-wrap:anywhere}.y1VbRq_descText{appearance:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:left;overflow-wrap:anywhere;cursor:pointer;background:0 0;border:0;margin:0;padding:0}.y1VbRq_descText:hover{color:var(--dsw-alias-label-secondary)}.y1VbRq_descText[data-empty=true]{color:var(--dsw-alias-label-dimmed)}.y1VbRq_descText:disabled{opacity:.5;cursor:default}.y1VbRq_mcpDesc{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);width:100%;height:28px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere;margin:0;padding:0 8px}.y1VbRq_mcpDesc::placeholder{color:var(--dsw-alias-label-dimmed)}.y1VbRq_descOver{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-warn-label)}.y1VbRq_mcpRight{flex-wrap:wrap;flex:none;justify-content:flex-end;align-items:center;gap:8px;max-width:100%;display:inline-flex}.y1VbRq_status{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;display:inline-flex}.y1VbRq_mcpActions{flex-wrap:wrap;align-items:center;gap:8px;display:inline-flex}.y1VbRq_rowFailure{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.y1VbRq_rowFailure p{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0}.y1VbRq_mcpStatus,.y1VbRq_unavailable{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}.y1VbRq_mcpFailure{color:var(--dsw-alias-state-error-primary);flex-wrap:wrap;align-items:center;gap:10px;display:flex}.y1VbRq_mcpFailure p{font:var(--dsw-font-xs-13);margin:0}.y1VbRq_mcpNotice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-success-primary);margin:0}.y1VbRq_mcpActionError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0}.y1VbRq_skeletonList{flex-direction:column;gap:10px;display:flex}.y1VbRq_skeletonRow{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:8px;padding:15px 14px;display:flex}.y1VbRq_skeletonBar{border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-skeleton);width:38%;height:14px}.y1VbRq_skeletonBar+.y1VbRq_skeletonBar{width:78%;height:12px}.y1VbRq_visuallyHidden{clip-path:inset(50%);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}@keyframes y1VbRq_mcp-skeleton-pulse{0%{opacity:1}40%{opacity:.55}80%,to{opacity:1}}@media (prefers-reduced-motion:no-preference){.y1VbRq_skeletonBar{animation:2s ease-in-out infinite y1VbRq_mcp-skeleton-pulse}}@media (prefers-reduced-motion:reduce){.y1VbRq_skeletonBar{animation:none}}.y1VbRq_mcpForm{flex-direction:column;gap:12px;display:flex}.y1VbRq_mcpEditorDialog{box-sizing:border-box;width:min(640px,100%)}.y1VbRq_mcpEditorContent{max-height:min(70dvh,640px);overflow:auto}.y1VbRq_editorTabs{flex:none}.y1VbRq_editorPanel{flex-direction:column;gap:12px;min-height:320px;display:flex}.y1VbRq_editorPanel[hidden]{display:none}.y1VbRq_formActions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}.y1VbRq_formField{flex-direction:column;gap:6px;display:flex}.y1VbRq_formLabel{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary)}.y1VbRq_fieldHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}.y1VbRq_formSelect{box-sizing:border-box;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);padding:0 10px}.y1VbRq_formJson{box-sizing:border-box;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:220px;color:var(--dsw-alias-label-primary);font:12px/18px var(--ds-font-family-code);resize:vertical;white-space:pre;padding:10px 14px;overflow:auto}.y1VbRq_formError{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0}.y1VbRq_rosterSearch:focus-visible,.y1VbRq_mcpFilterSelect:focus-visible,.y1VbRq_formSelect:focus-visible,.y1VbRq_formJson:focus-visible,.y1VbRq_mcpDesc:focus-visible,.y1VbRq_descText:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.y1VbRq_toolsHead{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.y1VbRq_toolsCount{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.y1VbRq_toolsActions{flex-wrap:wrap;align-items:center;gap:6px;margin-left:auto;display:flex}.y1VbRq_toolsList{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);max-height:220px;padding:4px;overflow:auto}.y1VbRq_toolRow{border-radius:var(--dsw-radius-sm);cursor:pointer;align-items:center;gap:8px;padding:4px 6px;display:flex}.y1VbRq_toolRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.y1VbRq_toolName{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:nowrap}.y1VbRq_toolDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.y1VbRq_importToolbar{flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px;display:flex}.y1VbRq_importScope{flex-direction:column;flex:0 240px;gap:6px;min-width:0;display:flex}.y1VbRq_importChecks{flex-wrap:wrap;align-items:center;gap:8px;margin-left:auto;display:flex}.y1VbRq_importList{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:12px;max-height:340px;padding:4px;display:flex;overflow:auto}.y1VbRq_importSource{flex-direction:column;gap:4px;display:flex}.y1VbRq_importSourceHead{align-items:baseline;gap:8px;min-width:0;padding:2px 4px;display:flex}.y1VbRq_importSourceLabel{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);flex:none}.y1VbRq_importSourcePath{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.y1VbRq_importProblem{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;margin:0;padding:0 4px}.y1VbRq_importRow{border-radius:var(--dsw-radius-sm);cursor:pointer;align-items:flex-start;gap:8px;padding:6px;display:flex}.y1VbRq_importRow:hover{background:var(--dsw-alias-interactive-bg-hover)}.y1VbRq_importMain{flex-direction:column;gap:2px;min-width:0;display:flex}.y1VbRq_importName{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-primary);flex-wrap:wrap;align-items:center;gap:6px;display:inline-flex}.y1VbRq_importMeta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}@container y1VbRq_mcp-manager (width<=480px){.y1VbRq_tabs{max-width:none}.y1VbRq_listActions{margin-left:0}.y1VbRq_mcpRow{flex-direction:column;align-items:stretch}.y1VbRq_mcpRight{justify-content:space-between}.y1VbRq_mcpFilterSelect,.y1VbRq_rosterSearch{flex:100%;max-width:none}.y1VbRq_importScope{flex:100%}}@media (pointer:coarse){.y1VbRq_mcpRow,.y1VbRq_toolRow,.y1VbRq_importRow{min-height:44px}}@media (width<=600px){.y1VbRq_mcpDesc,.y1VbRq_rosterSearch,.y1VbRq_formSelect,.y1VbRq_formJson{font-size:16px;line-height:24px}}";
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
			"descOver": "y1VbRq_descOver",
			"descText": "y1VbRq_descText",
			"editorPanel": "y1VbRq_editorPanel",
			"editorTabs": "y1VbRq_editorTabs",
			"empty": "y1VbRq_empty",
			"emptyBlock": "y1VbRq_emptyBlock",
			"emptyHint": "y1VbRq_emptyHint",
			"fieldHint": "y1VbRq_fieldHint",
			"formActions": "y1VbRq_formActions",
			"formError": "y1VbRq_formError",
			"formField": "y1VbRq_formField",
			"formJson": "y1VbRq_formJson",
			"formLabel": "y1VbRq_formLabel",
			"formSelect": "y1VbRq_formSelect",
			"importChecks": "y1VbRq_importChecks",
			"importList": "y1VbRq_importList",
			"importMain": "y1VbRq_importMain",
			"importMeta": "y1VbRq_importMeta",
			"importName": "y1VbRq_importName",
			"importProblem": "y1VbRq_importProblem",
			"importRow": "y1VbRq_importRow",
			"importScope": "y1VbRq_importScope",
			"importSource": "y1VbRq_importSource",
			"importSourceHead": "y1VbRq_importSourceHead",
			"importSourceLabel": "y1VbRq_importSourceLabel",
			"importSourcePath": "y1VbRq_importSourcePath",
			"importToolbar": "y1VbRq_importToolbar",
			"listActions": "y1VbRq_listActions",
			"listFilters": "y1VbRq_listFilters",
			"listHead": "y1VbRq_listHead",
			"listHeadText": "y1VbRq_listHeadText",
			"listHint": "y1VbRq_listHint",
			"mcp-manager": "y1VbRq_mcp-manager",
			"mcp-skeleton-pulse": "y1VbRq_mcp-skeleton-pulse",
			"mcpActionError": "y1VbRq_mcpActionError",
			"mcpActions": "y1VbRq_mcpActions",
			"mcpDesc": "y1VbRq_mcpDesc",
			"mcpEditorContent": "y1VbRq_mcpEditorContent",
			"mcpEditorDialog": "y1VbRq_mcpEditorDialog",
			"mcpFailure": "y1VbRq_mcpFailure",
			"mcpFilterSelect": "y1VbRq_mcpFilterSelect",
			"mcpForm": "y1VbRq_mcpForm",
			"mcpGroup": "y1VbRq_mcpGroup",
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
			"rosterSearch": "y1VbRq_rosterSearch",
			"rowFailure": "y1VbRq_rowFailure",
			"section": "y1VbRq_section",
			"skeletonBar": "y1VbRq_skeletonBar",
			"skeletonList": "y1VbRq_skeletonList",
			"skeletonRow": "y1VbRq_skeletonRow",
			"status": "y1VbRq_status",
			"tabPanel": "y1VbRq_tabPanel",
			"tabs": "y1VbRq_tabs",
			"toolDesc": "y1VbRq_toolDesc",
			"toolName": "y1VbRq_toolName",
			"toolRow": "y1VbRq_toolRow",
			"toolsActions": "y1VbRq_toolsActions",
			"toolsCount": "y1VbRq_toolsCount",
			"toolsHead": "y1VbRq_toolsHead",
			"toolsList": "y1VbRq_toolsList",
			"unavailable": "y1VbRq_unavailable",
			"visuallyHidden": "y1VbRq_visuallyHidden",
			"when": "y1VbRq_when"
		};
		//#endregion
		//#region src/client/McpEditor.tsx
		/** Settings key for one row (`global:<name>` or `preset:<id>:<name>`), shared with the Host's `mcpRowKey`. */
		function rowKey(scope, agentPreset, serverName) {
			return scope === "preset" ? `preset:${agentPreset}:${serverName}` : `global:${serverName}`;
		}
		/**
		* The plane one row lives in, in this dialog's own vocabulary. A row's scope is
		* `global` or `preset`; a plane a new row can be written to is `global` or
		* `agent` (an agent row addressed through one preset).
		* @param server - the row being edited, when there is one.
		* @returns the plane that row belongs to.
		*/
		function planeOf(server) {
			return server?.scope === "global" ? "global" : "agent";
		}
		/**
		* The composition a save addresses: an edited row keeps its own plane, and a new
		* row goes to the plane the section shows. Undefined when that plane cannot be
		* named — an agent row with no preset to address.
		*/
		function editorTarget(mode, server, plane, presetId) {
			if (mode === "edit") {
				if (server === void 0 || server.entryId === null) return void 0;
				return server.scope === "global" ? { scope: "global" } : {
					scope: "preset",
					agentPreset: server.presetId ?? ""
				};
			}
			if (plane === "global") return { scope: "global" };
			return presetId === "" ? void 0 : {
				scope: "preset",
				agentPreset: presetId
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
		/** Modal editor split into a pane for the row's fields and a pane for its tools. */
		function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, plane, globalWritable, preset, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }) {
			const [tab, setTab] = (0, react.useState)("config");
			const tabId = (0, react.useId)();
			/** Chosen agent preset for a new row; a placeholder while the list loads. */
			const [presetId, setPresetId] = (0, react.useState)(server?.scope === "preset" ? server.presetId ?? "" : preset ?? "");
			const [presetOptions, setPresetOptions] = (0, react.useState)([]);
			/** Whether the preset read answered, so an empty list can be told from a pending one. */
			const [presetLoaded, setPresetLoaded] = (0, react.useState)(false);
			/** Chosen plane for a new row, as this dialog's own field. */
			const [planeChoice, setPlaneChoice] = (0, react.useState)(plane);
			const [title, setTitle] = (0, react.useState)(server?.serverName ?? "");
			const [description, setDescription] = (0, react.useState)(descriptionInitial);
			const [json, setJson] = (0, react.useState)("");
			const [localError, setLocalError] = (0, react.useState)(null);
			const [configNotice, setConfigNotice] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [tools, setTools] = (0, react.useState)(null);
			const [hiddenTools, setHiddenTools] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [toolsBusy, setToolsBusy] = (0, react.useState)(false);
			const [toolsError, setToolsError] = (0, react.useState)(null);
			const editKey = `${server?.scope ?? ""}:${server?.presetId ?? ""}:${server?.entryId ?? ""}`;
			/**
			* The plane this save addresses: an edited row keeps its own, a new one uses
			* the field below. Editing never follows the field, so a row cannot be written
			* to the wrong side by opening its editor after a scope change.
			*/
			const targetPlane = mode === "edit" ? planeOf(server) : planeChoice;
			/**
			* Connect once and list what the server publishes.
			* @param spec - transport to connect with.
			* @param serverName - namespace for diagnostics; required by the Host.
			* @param fromRules - seed the checkboxes from the row's stored rules (the
			*   dialog's first listing); a manual reload keeps the user's own choices and
			*   treats tools it has not seen before as enabled.
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
			* List the tools of the spec the form currently shows. The JSON box is the
			* source, so an edited command or url is listed as edited.
			* @param fromRules - seed the checkboxes from the row's stored rules.
			*/
			const loadToolsFromForm = (fromRules) => {
				try {
					const parsed = parseSpecText(json, t("mcp.form.jsonInvalid"));
					const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
					loadTools(parsed.spec, serverName, fromRules);
				} catch (cause) {
					setToolsError(cause instanceof Error ? cause.message : t("mcp.form.jsonInvalid"));
				}
			};
			/**
			* Opening the tools pane is what asks the server for its listing: connecting
			* spawns a child process for stdio rows, and a row the user only renames never
			* needs one. `tools` stays null until a listing was actually shown, which is
			* what keeps the save from rewriting the stored rules with an empty set.
			*/
			const pickTab = (next) => {
				setTab(next);
				if (next !== "tools" || mode !== "edit" || loading) return;
				if (toolsReadOnly) return;
				if (tools !== null || toolsBusy) return;
				loadToolsFromForm(true);
			};
			(0, react.useEffect)(() => {
				if (!open) return;
				let current = true;
				setLocalError(null);
				setConfigNotice(null);
				setTab("config");
				setPresetId(server?.scope === "preset" ? server.presetId ?? "" : preset ?? "");
				setPlaneChoice(mode === "edit" ? planeOf(server) : plane);
				setPresetLoaded(false);
				setTitle(server?.serverName ?? "");
				setDescription(descriptionInitial);
				setTools(null);
				setHiddenTools(/* @__PURE__ */ new Set());
				setToolsError(null);
				setToolsBusy(false);
				setLoading(false);
				presets().then((list) => {
					if (!current) return;
					setPresetOptions(list);
					setPresetLoaded(true);
					setPresetId((previous) => previous !== "" ? previous : mode === "add" ? list[0]?.id ?? "" : "");
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
						setJson(specJson(described));
						setLoading(false);
					}, () => {
						if (current) {
							setJson(specJson(void 0));
							setLoading(false);
						}
					});
				} else setJson(specJson(void 0));
				return () => {
					current = false;
				};
			}, [
				editKey,
				mode,
				open,
				server,
				descriptionInitial,
				presets,
				t
			]);
			const submit = () => {
				try {
					const parsed = parseSpecText(json, t("mcp.form.jsonInvalid"));
					const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
					if (serverName === "") throw new Error(t("mcp.form.required"));
					const spec = parsed.spec;
					mcpEntryConfig(spec, serverName);
					const configIssue = diagnoseMcpSpec(spec, {});
					const blocking = configIssue.filter(isBlockingConfigIssue);
					if (blocking.length > 0) throw new Error(formatMcpConfigIssues(blocking, t));
					setConfigNotice(configIssue.length === 0 ? null : t("mcp.form.pendingConfig"));
					const target = editorTarget(mode, server, targetPlane, presetId);
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
					if (description.trim() !== "") onUpdateDescription(key, description.trim());
					if (tools !== null && !toolsReadOnly) onUpdateTools(key, tools.filter((tool) => hiddenTools.has(tool.name)).map((tool) => `!${tool.name}`));
				} catch (cause) {
					setTab("config");
					setLocalError(cause instanceof Error ? cause.message : t("mcp.form.jsonInvalid"));
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
			const titleText = mode === "add" ? t("mcp.form.addTitle") : t("mcp.form.editTitle");
			const toolsReadOnly = mode === "edit" ? server?.scope === "global" : targetPlane === "global";
			const agentTargetMissing = mode === "add" && targetPlane === "agent" && presetId === "";
			const globalTargetMissing = mode === "add" && targetPlane === "global" && !globalWritable;
			const noTarget = agentTargetMissing || globalTargetMissing;
			const noTargetReason = presetLoaded && presetOptions.length === 0 && !globalWritable ? t("mcp.form.noTarget") : globalTargetMissing ? t("mcp.global.unavailable") : t("mcp.form.noPreset");
			const showsCurrentPreset = presetId !== "" && !presetOptions.some((option) => option.id === presetId);
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
						onClick: submit,
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
							items: [{
								value: "config",
								label: t("mcp.form.tabConfig"),
								id: `${tabId}-config-tab`,
								panelId: `${tabId}-config-panel`
							}, {
								value: "tools",
								label: t("mcp.form.tabTools"),
								id: `${tabId}-tools-tab`,
								panelId: `${tabId}-tools-panel`
							}]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							id: `${tabId}-config-panel`,
							role: "tabpanel",
							"aria-labelledby": `${tabId}-config-tab`,
							className: McpSection_module_css_default.editorPanel,
							hidden: tab !== "config",
							children: [
								mode === "add" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: McpSection_module_css_default.formField,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.formLabel,
												children: t("mcp.form.scope")
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: McpSection_module_css_default.formSelect,
												value: targetPlane,
												disabled: formDisabled,
												"aria-label": t("mcp.form.scope"),
												onChange: (event) => {
													setPlaneChoice(event.currentTarget.value);
													setLocalError(null);
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "global",
													disabled: !globalWritable,
													children: t("mcp.scopeGlobal")
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "agent",
													disabled: presetOptions.length === 0,
													children: t("mcp.form.presetScope")
												})]
											}),
											globalWritable ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: McpSection_module_css_default.fieldHint,
												children: t("mcp.global.unavailable")
											})
										]
									}),
									targetPlane === "agent" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: McpSection_module_css_default.formField,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.formLabel,
											children: t("mcp.form.presetScope")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											className: McpSection_module_css_default.formSelect,
											value: presetId,
											disabled: formDisabled,
											"aria-label": t("mcp.form.presetScope"),
											onChange: (event) => {
												setPresetId(event.currentTarget.value);
												setLocalError(null);
											},
											children: [presetOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: option.id,
												children: option.name
											}, option.id)), showsCurrentPreset ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: presetId,
												children: presetId
											}) : null]
										})]
									}) : null,
									presetLoaded && noTarget ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.fieldHint,
										children: noTargetReason
									}) : null
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.form.serverName")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										value: title,
										disabled: formDisabled,
										"aria-label": t("mcp.form.serverName"),
										onChange: (event) => {
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.form.json")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										className: McpSection_module_css_default.formJson,
										value: json,
										disabled: formDisabled,
										spellCheck: false,
										"aria-label": t("mcp.form.json"),
										onChange: (event) => {
											setJson(event.currentTarget.value);
											setLocalError(null);
										}
									})]
								}),
								loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: McpSection_module_css_default.mcpStatus,
									children: t("mcp.loading")
								}) : null
							]
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
									}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: McpSection_module_css_default.toolsActions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: formDisabled || toolsBusy || toolsReadOnly,
											onClick: () => {
												loadToolsFromForm(tools === null);
											},
											children: toolsBusy ? t("mcp.form.toolsLoading") : t("mcp.form.toolsReload")
										}), tools !== null && tools.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
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
										})] }) : null]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.fieldHint,
									children: toolsReadOnly ? t("mcp.form.toolsGlobal") : t("mcp.form.toolsHint")
								}),
								toolsError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: McpSection_module_css_default.formError,
									role: "alert",
									children: toolsError
								}) : null,
								tools !== null && tools.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
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
											})
										]
									}, tool.name))
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
		//#region src/client/ClaudeImportDialog.tsx
		/**
		* Import dialog: the MCP servers the Claude Code configuration files declare,
		* offered as a checklist.
		*
		* The scan is a read; the import is one `addMcps` call carrying every selected
		* entry. That reuse is deliberate: a row imported here goes through the same
		* validation, conflict detection, atomic write, and live reconciliation as one
		* typed into the editor, so the two paths cannot drift. One call, not one per
		* entry, because an agent preset re-mounts once per write and every MCP server
		* that preset declares starts again on each mount. Entries are still validated
		* individually, so a failure is reported per entry rather than discarding the
		* batch, because one colliding name must not cost the rest.
		*
		* The plane is the settings tab's, not a field of its own: a user who opened the
		* import from the global tab is importing into the global plane, and one who
		* opened it from the agent tab picks the preset there.
		*
		* @module @guowenzhang/dsh-mcp-manager/client/ClaudeImportDialog
		*/
		/** The composition target one import scope addresses. */
		function targetOf(scope) {
			return scope.kind === "global" ? { scope: "global" } : {
				scope: "preset",
				agentPreset: scope.presetId
			};
		}
		/**
		* The names one composition already carries, which an import into it would
		* collide with. A row's `serverName` is its local entry id unless the file said
		* otherwise, so both spellings are treated as taken.
		*/
		function configuredNames(servers, scope) {
			const names = /* @__PURE__ */ new Set();
			for (const server of servers) {
				if (!(scope.kind === "global" ? server.scope === "global" : server.scope === "preset" && server.presetId === scope.presetId)) continue;
				names.add(server.serverName);
				if (server.entryId !== null) names.add(server.entryId);
			}
			return names;
		}
		/**
		* One checkbox line: the server's name, transport, origin, and secret key names.
		*
		* Memoized, and every prop is stable between renders except `checked`: with a
		* real Claude configuration the list runs to dozens of rows, and re-rendering
		* all of them under the modal's blurred backdrop is what makes the dialog feel
		* slow while the user ticks boxes.
		*/
		const EntryRow = (0, react.memo)(function EntryRow({ entryKey, entry, checked, disabled, onToggle, t }) {
			const transport = entry.spec.type === "stdio" ? `stdio · ${entry.spec.command}` : `${entry.spec.type} · ${entry.spec.url}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: McpSection_module_css_default.importRow,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					checked,
					disabled,
					"aria-label": entry.serverName,
					onChange: (event) => {
						onToggle(entryKey, event.currentTarget.checked);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: McpSection_module_css_default.importMain,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.importName,
							children: [
								entry.serverName,
								entry.duplicate ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: "outline",
									children: t("mcp.import.duplicate")
								}) : null,
								entry.problem !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: "warning",
									children: t(`mcp.import.problem.${entry.problem}`)
								}) : null,
								disabled && entry.problem === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
									tone: "outline",
									children: t("mcp.import.existing")
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.importMeta,
							children: transport
						}),
						entry.envKeys.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.importMeta,
							children: `${t(entry.spec.type === "stdio" ? "mcp.import.secrets" : "mcp.import.headers")}: ${entry.envKeys.join(", ")}`
						}) : null
					]
				})]
			});
		});
		/** The Claude configuration import dialog. */
		function ClaudeImportDialog({ open, busy, error, scanClaudeMcp, addMcps, servers, presets, plane, globalWritable, preset, t, onClose, onImported }) {
			const [view, setView] = (0, react.useState)({ status: "loading" });
			const [excluded, setExcluded] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [outcome, setOutcome] = (0, react.useState)(null);
			const [importing, setImporting] = (0, react.useState)(false);
			const [presetOptions, setPresetOptions] = (0, react.useState)([]);
			const [presetId, setPresetId] = (0, react.useState)("");
			/** Chosen plane for this batch, as the dialog's own field. */
			const [planeChoice, setPlaneChoice] = (0, react.useState)(plane);
			/** Whether the previous render had the dialog open, so a re-scan is told apart from a fresh open. */
			const wasOpen = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				const opening = open && !wasOpen.current;
				wasOpen.current = open;
				if (!open) return;
				let current = true;
				setView({ status: "loading" });
				setOutcome(null);
				setImporting(false);
				if (opening) {
					setExcluded(/* @__PURE__ */ new Set());
					setPresetId(preset ?? "");
					setPlaneChoice(plane);
				}
				presets().then((list) => {
					if (!current) return;
					setPresetOptions(list);
					setPresetId((previous) => previous !== "" ? previous : list[0]?.id ?? "");
				}, () => {
					if (current) setPresetOptions([]);
				});
				scanClaudeMcp({}).then((result) => {
					if (current) setView({
						status: "ready",
						sources: result.sources
					});
				}, () => {
					if (current) setView({ status: "error" });
				});
				return () => {
					current = false;
				};
			}, [
				open,
				attempt,
				scanClaudeMcp,
				presets
			]);
			/** The composition the batch writes into: the field's plane, or its preset. */
			const scope = planeChoice === "global" ? { kind: "global" } : {
				kind: "preset",
				presetId
			};
			const existing = configuredNames(servers, scope);
			/** A key is source-scoped, because the same name may appear in two files. */
			const keyOf = (source, entry) => `${source.id}\u0000${entry.serverName}`;
			const selectable = (entry) => entry.problem === void 0 && !existing.has(entry.serverName);
			const allEntries = view.status === "ready" ? view.sources.flatMap((source) => source.entries.map((entry) => ({
				source,
				entry
			}))) : [];
			const chosen = allEntries.filter(({ source, entry }) => selectable(entry) && !excluded.has(keyOf(source, entry)));
			const toggle = (0, react.useCallback)((key, next) => {
				setExcluded((previous) => {
					const set = new Set(previous);
					if (next) set.delete(key);
					else set.add(key);
					return set;
				});
			}, []);
			const setAll = (next) => {
				setExcluded(next ? /* @__PURE__ */ new Set() : new Set(allEntries.filter(({ entry }) => selectable(entry)).map(({ source, entry }) => keyOf(source, entry))));
			};
			/**
			* Import every selected entry in one `addMcps` call. The Host validates each
			* row on its own and reports what became of it, so a collision still costs only
			* its own row, while the accepted rows commit together — one write, which means
			* one preset re-mount instead of one per row.
			*/
			const runImport = async () => {
				setOutcome(null);
				setImporting(true);
				try {
					const result = await addMcps({
						target: targetOf(scope),
						rows: chosen.map(({ entry }) => ({
							serverName: entry.serverName,
							spec: entry.spec
						}))
					});
					const refused = result.outcomes.filter((outcome) => outcome.entryId === null);
					const imported = result.outcomes.length - refused.length;
					setOutcome({
						imported,
						failures: refused.map((row) => ({
							serverName: row.serverName,
							reason: row.reason ?? t("unavailable")
						}))
					});
					if (imported > 0) onImported();
					if (refused.length === 0) {
						onClose();
						return;
					}
					setAttempt((value) => value + 1);
				} catch (cause) {
					setOutcome({
						imported: 0,
						failures: [{
							serverName: "",
							reason: cause instanceof Error ? cause.message : String(cause)
						}]
					});
				} finally {
					setImporting(false);
				}
			};
			const total = allEntries.length;
			const importable = allEntries.filter(({ entry }) => selectable(entry)).length;
			const noTarget = planeChoice === "agent" ? presetId === "" : !globalWritable;
			const footer = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.formActions,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "outline",
					size: "sm",
					onClick: onClose,
					disabled: busy || importing,
					children: t("mcp.import.close")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					variant: "primary",
					size: "sm",
					disabled: busy || importing || chosen.length === 0 || noTarget,
					onClick: () => {
						runImport();
					},
					children: importing ? t("mcp.import.submitting") : t("mcp.import.submit")
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose,
				title: t("mcp.import.title"),
				closeLabel: t("mcp.import.close"),
				description: t("mcp.import.hint"),
				className: McpSection_module_css_default.mcpEditorDialog ?? "",
				contentClassName: McpSection_module_css_default.mcpEditorContent ?? "",
				footer,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpForm,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.importToolbar,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.importScope,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.import.scope")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										className: McpSection_module_css_default.formSelect,
										value: planeChoice,
										disabled: busy || importing,
										"aria-label": t("mcp.import.scope"),
										onChange: (event) => {
											setPlaneChoice(event.currentTarget.value);
											setExcluded(/* @__PURE__ */ new Set());
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "global",
											disabled: !globalWritable,
											children: t("mcp.scopeGlobal")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "agent",
											disabled: presetOptions.length === 0,
											children: t("mcp.form.presetScope")
										})]
									})]
								}),
								planeChoice === "agent" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: McpSection_module_css_default.importScope,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: McpSection_module_css_default.formLabel,
										children: t("mcp.form.presetScope")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										className: McpSection_module_css_default.formSelect,
										value: presetId,
										disabled: busy || importing || presetOptions.length === 0,
										"aria-label": t("mcp.form.presetScope"),
										onChange: (event) => {
											setPresetId(event.currentTarget.value);
											setExcluded(/* @__PURE__ */ new Set());
										},
										children: presetOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: option.id,
											children: `${t("mcp.scopePreset")} · ${option.name}`
										}, option.id))
									})]
								}) : null,
								noTarget ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.formLabel,
									children: planeChoice === "global" ? t("mcp.global.unavailable") : t("mcp.form.noPreset")
								}) : null,
								view.status === "ready" && total > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: McpSection_module_css_default.importChecks,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.toolsCount,
											role: "status",
											children: t("mcp.import.selected").replace("{n}", String(chosen.length)).replace("{m}", String(importable))
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											disabled: busy || importing,
											onClick: () => {
												setAll(true);
											},
											children: t("mcp.import.selectAll")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											disabled: busy || importing,
											onClick: () => {
												setAll(false);
											},
											children: t("mcp.import.selectNone")
										})
									]
								}) : null
							]
						}),
						noTarget ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.fieldHint,
							children: t("mcp.form.noPreset")
						}) : null,
						view.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpStatus,
							children: t("mcp.import.loading")
						}) : null,
						view.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.mcpFailure,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								children: t("mcp.error")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: () => {
									setAttempt((value) => value + 1);
								},
								children: t("mcp.import.retry")
							})]
						}) : null,
						view.status === "ready" && total === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.empty,
							children: t("mcp.import.empty")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.empty,
							children: t("mcp.import.emptyHint")
						})] }) : null,
						view.status === "ready" && total > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: McpSection_module_css_default.importList,
							children: view.sources.map((source) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: McpSection_module_css_default.importSource,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: McpSection_module_css_default.importSourceHead,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.importSourceLabel,
											children: t(`mcp.import.source.${source.label}`)
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.importSourcePath,
											title: source.path,
											children: source.path
										})]
									}),
									source.problem !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: McpSection_module_css_default.importProblem,
										children: t(`mcp.import.problem.${source.problem}`)
									}) : null,
									source.entries.map((entry) => {
										const disabled = !selectable(entry);
										const entryKey = keyOf(source, entry);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(EntryRow, {
											entryKey,
											entry,
											checked: !disabled && !excluded.has(entryKey),
											disabled,
											onToggle: toggle,
											t
										}, entryKey);
									})
								]
							}, source.id))
						}), importable === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpStatus,
							children: t("mcp.import.noneSelected")
						}) : null] }) : null,
						outcome !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: outcome.failures.length > 0 ? McpSection_module_css_default.mcpActionError : McpSection_module_css_default.mcpNotice,
							role: "status",
							children: outcome.failures.length === 0 ? t("mcp.import.done").replace("{n}", String(outcome.imported)) : t("mcp.import.partial").replace("{n}", String(outcome.imported)).replace("{m}", String(outcome.failures.length))
						}) : null,
						outcome?.failures.map((failure, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpActionError,
							role: "alert",
							children: `${failure.serverName}: ${failure.reason}`
						}, `${failure.serverName}:${index}`)),
						error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.formError,
							role: "alert",
							children: error
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
		const css = "._tn7CW_section{box-sizing:border-box;flex-direction:column;gap:22px;width:100%;display:flex}._tn7CW_intro{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}._tn7CW_unavailable{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);margin:0}._tn7CW_group{flex-direction:column;display:flex}._tn7CW_groupTitle{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary);margin:0 0 2px;font-weight:600}._tn7CW_groupHint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0 0 6px}._tn7CW_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:16px;padding:14px 0;display:flex}._tn7CW_group>._tn7CW_row:last-child{border-bottom:none;padding-bottom:2px}._tn7CW_rowText{flex-direction:column;gap:3px;min-width:0;padding-right:24px;display:flex}._tn7CW_rowLabel{font:var(--dsw-font-s-14);color:var(--dsw-alias-label-primary)}._tn7CW_rowDesc{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}._tn7CW_rowControl{flex:none;align-items:center;gap:8px;display:inline-flex}._tn7CW_rowState{min-width:42px;font:var(--dsw-font-xxs-12);text-align:right;color:var(--dsw-alias-label-tertiary)}._tn7CW_rowState[data-state=saving]{color:var(--dsw-alias-label-secondary)}._tn7CW_rowState[data-state=saved]{color:var(--dsw-alias-state-success-primary)}._tn7CW_numberInput{width:88px}._tn7CW_numberInput input{box-sizing:border-box;text-align:right;width:100%;height:32px;padding:0 10px;font-size:13px;line-height:20px}._tn7CW_status{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-stroke);flex-direction:column;gap:8px;padding:12px 14px;display:flex}._tn7CW_statusHead{align-items:center;gap:10px;display:flex}._tn7CW_catalogSummary{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}._tn7CW_statusActions{align-items:center;gap:6px;margin-left:auto;display:inline-flex}._tn7CW_catalogEmpty{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin:0}._tn7CW_catalogList{flex-direction:column;gap:4px;max-height:220px;margin:0;padding:0;list-style:none;display:flex;overflow:auto}._tn7CW_catalogRow{justify-content:space-between;align-items:baseline;gap:12px;padding:4px 2px;display:flex}._tn7CW_catalogKey{font:12px/18px var(--ds-font-family-code);color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}._tn7CW_catalogMeta{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}._tn7CW_failure{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);margin:0}._tn7CW_notice{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-success-primary);margin:0}@media (pointer:coarse){._tn7CW_row{min-height:44px}}";
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
			"intro": "_tn7CW_intro",
			"notice": "_tn7CW_notice",
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
						children: state === "saving" ? t("opt.state.saving") : state === "saved" ? t("opt.state.saved") : ""
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
						children: state === "saving" ? t("opt.state.saving") : state === "saved" ? t("opt.state.saved") : ""
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
			const [notice, setNotice] = (0, react.useState)(null);
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
					markRow(field, "idle");
					setFailure(cause instanceof Error ? cause.message : String(cause));
				});
			}, [markRow, setOptimize]);
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
					setNotice(t("opt.catalog.cleared").replace("{n}", String(result.cleared)));
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpOptimizeSection_module_css_default.intro,
						children: t("opt.intro")
					}),
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
					notice === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpOptimizeSection_module_css_default.notice,
						role: "status",
						children: notice
					})
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
				...row.configIssue === void 0 ? {} : { configIssue: row.configIssue }
			});
			return rows;
		}
		/** Owner handle over the `mcp-manager` namespace. */
		var McpSettingsController = class {
			scope;
			mcps;
			authoring;
			presets;
			suppressed;
			store;
			unsubscribe;
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
					updateMcpDescription: (key, description) => {
						this.updateMcpDescription(key, description);
					},
					updateMcpTools: (key, patterns) => {
						this.updateMcpTools(key, patterns);
					},
					setOptimize: (field, value) => this.setOptimize(field, value),
					addMcp: this.authoring.addMcp,
					addMcps: this.authoring.addMcps,
					editMcp: this.authoring.editMcp,
					disableMcp: this.authoring.disableMcp,
					describeMcp: this.authoring.describeMcp,
					listMcpTools: this.authoring.listMcpTools,
					scanClaudeMcp: this.authoring.scanClaudeMcp,
					catalogState: () => this.authoring.catalogState({}),
					clearCatalog: () => this.authoring.clearCatalog({}),
					suppressedMcps: this.suppressed,
					mcps: this.mcps,
					presets: this.presets
				};
			}
			/**
			* Write one optimization field.
			*
			* The stored policy is one open map, so a field write is a read-modify-write
			* of that map rather than a separate namespace field. The Host converges every
			* field at read time, which is why nothing here validates the value: a bad one
			* falls back to its default instead of failing the namespace commit.
			* @param field - the policy field name.
			* @param value - the value to store.
			* @throws when the document is not writable, or when the Host rejects the write.
			*/
			async setOptimize(field, value) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) throw new Error("the MCP settings document is not writable");
				const next = {
					...snapshot.value?.optimize,
					[field]: value
				};
				await this.scope.set("optimize", next);
			}
			updateMcpDescription(key, description) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) return;
				const next = { ...snapshot.value?.descriptions ?? {} };
				if (description === "") Reflect.deleteProperty(next, key);
				else next[key] = description;
				this.scope.set("descriptions", next);
			}
			updateMcpTools(key, patterns) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) return;
				const next = { ...snapshot.value?.tools };
				if (patterns.length === 0) Reflect.deleteProperty(next, key);
				else next[key] = [...patterns];
				this.scope.set("tools", next);
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
		* One list carries both planes, and no control chooses between them. Global rows
		* come first and in full, whatever agent preset the list is narrowed to: a
		* session carries its global rows regardless of the preset it runs, so hiding
		* them behind a selector would misstate what the composition mounts. The preset
		* picker narrows the agent rows only, and the name filter narrows what is
		* rendered without changing any count that is reported about the composition.
		*
		* Which plane a *new* row goes to is the creating dialog's own choice. The
		* section cannot infer it: deriving the target from the row the user last edited
		* left the global plane unreachable in a composition with no global row yet, and
		* leaving it unset left "Add" disabled on the view every user starts from.
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
		* @param props.onCommit - persist the edited text.
		* @param props.t - the section's translator.
		* @returns the description control.
		*/
		function McpDescription({ value, disabled, onCommit, t }) {
			const [draft, setDraft] = (0, react.useState)(null);
			if (draft === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: McpSection_module_css_default.descText,
				"data-empty": value === "",
				disabled,
				title: value === "" ? t("mcp.descriptionPlaceholder") : value,
				onClick: () => {
					setDraft(value);
				},
				children: value === "" ? t("mcp.description.add") : value
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				className: McpSection_module_css_default.mcpDesc,
				value: draft,
				autoFocus: true,
				placeholder: t("mcp.descriptionPlaceholder"),
				"aria-label": t("mcp.descriptionLabel"),
				"aria-invalid": draft.length > 80,
				onChange: (event) => {
					setDraft(event.currentTarget.value);
				},
				onBlur: () => {
					onCommit(draft);
					setDraft(null);
				},
				onKeyDown: (event) => {
					if (event.key === "Enter") event.currentTarget.blur();
					if (event.key === "Escape") setDraft(null);
				}
			}), draft.length > 80 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: McpSection_module_css_default.descOver,
				role: "status",
				children: t("mcp.description.budget").replace("{n}", String(80))
			}) : null] });
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
			const switchTitle = actionsReason !== void 0 ? actionsReason : cannotEnable ? `${t("mcp.status.unconfigured")}: ${formatMcpConfigIssues(configIssue, t)}` : checked ? t("mcp.disable") : t("mcp.enable");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.mcpRow,
				"data-mcp-scope": server.scope,
				"data-mcp-name": server.serverName,
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
						server.scope === "global" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "neutral",
							children: t("mcp.scopeGlobal")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "outline",
							children: t("mcp.row.scopeLabel").replace("{scope}", t("mcp.scopePreset")).replace("{name}", server.presetId ?? "")
						}),
						status === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.status,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: status.dot }), status.label]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.mcpActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								disabled: actionsDisabled,
								title: actionsDisabled && actionsReason !== void 0 ? actionsReason : void 0,
								onClick: onEdit,
								children: t("mcp.edit")
							}), hasSwitch ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked,
								onChange: onToggleDisabled,
								label: disabledNow ? t("mcp.enable") : t("mcp.disable"),
								disabled: actionsDisabled || pending !== null || cannotEnable,
								title: switchTitle
							}) : null]
						})
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
			const { useMcpSettings, t, setMcpLoading, addMcp, addMcps, editMcp, disableMcp, describeMcp, listMcpTools, suppressedMcps, mcps, presets, updateMcpDescription, updateMcpTools, scanClaudeMcp } = props;
			const state = useMcpSettings((snapshot) => snapshot);
			const [tab, setTab] = (0, react.useState)("servers");
			const tabsId = (0, react.useId)();
			const [mcpView, setMcpView] = (0, react.useState)({ status: "loading" });
			const [mcpRequest, setMcpRequest] = (0, react.useState)(0);
			const [importerOpen, setImporterOpen] = (0, react.useState)(false);
			const [editor, setEditor] = (0, react.useState)({
				mode: "add",
				server: void 0,
				open: false
			});
			/** The plane a dialog opened from the section starts on; the dialog owns it from there. */
			const [openedPlane, setOpenedPlane] = (0, react.useState)("agent");
			const [editorBusy, setEditorBusy] = (0, react.useState)(false);
			const [editorError, setEditorError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
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
			narrowMcpRows(servers, "");
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
			const activePreset = presetChoices.some((option) => option.id === agentFilter) ? agentFilter : "";
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
					setNotice(t("mcp.notice.modeSaved"));
					await suppressedMcps().catch(() => []);
					refreshMcps();
				})();
			};
			const openAdd = (plane = "agent") => {
				setOpenedPlane(plane);
				setEditor({
					mode: "add",
					server: void 0,
					open: true
				});
				setEditorError(null);
				setNotice(null);
				setMcpActionError(null);
			};
			const openEdit = (server) => {
				setEditor({
					mode: "edit",
					server,
					open: true
				});
				setEditorError(null);
				setNotice(null);
				setMcpActionError(null);
			};
			const openImport = (plane = "agent") => {
				setOpenedPlane(plane);
				setImporterOpen(true);
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
					setNotice(editor.mode === "add" ? t("mcp.notice.added") : t("mcp.notice.saved"));
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
					setMcpActionError(t("mcp.error.unaddressable"));
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
						setNotice(enabled ? t("mcp.notice.enabled") : t("mcp.notice.disabled"));
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
					onEditDescription: (value) => {
						updateMcpDescription(key, value);
					},
					onEdit: () => {
						openEdit(server);
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
			const groupEmpty = (plane, rows) => {
				if (rows > 0) return null;
				const searching = needle !== "";
				const canAdd = plane === "global" ? !globalUnavailable : presetChoices.length > 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.emptyBlock,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.empty,
							children: searching ? t("mcp.noMatch") : plane === "global" ? t("mcp.empty.global") : t("mcp.empty.agent")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.emptyHint,
							children: searching ? t("mcp.noMatch.hint") : plane === "global" ? t("mcp.empty.global.hint") : t("mcp.empty.agent.hint")
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
			const rosterPanel = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: McpSection_module_css_default.block,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: McpSection_module_css_default.blockHead,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: McpSection_module_css_default.blockTitle,
							children: t("mcp.mode.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.when,
							children: t("mcp.mode.when")
						})]
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
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
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
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.listActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: () => {
									openImport();
								},
								disabled: disabled || editorBusy,
								title: disabled ? t("unavailable") : void 0,
								children: t("mcp.import")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								onClick: () => {
									openAdd();
								},
								disabled: disabled || editorBusy,
								title: disabled ? t("unavailable") : void 0,
								children: t("mcp.add")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.listHint,
						children: t("mcp.list.hint")
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
						}), presetChoices.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: McpSection_module_css_default.mcpFilterSelect,
							value: activePreset,
							"aria-label": t("mcp.filter.label"),
							onChange: (event) => {
								setAgentFilter(event.currentTarget.value);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("mcp.filter.all")
							}), presetChoices.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: option.id,
								children: t("mcp.filter.option").replace("{name}", option.name)
							}, option.id))]
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpSection_module_css_default.mcpGroup,
								children: t("mcp.group.global").replace("{n}", String(visibleGlobal.length))
							}),
							groupEmpty("global", visibleGlobal.length),
							visibleGlobal.map((server) => rowFor(server)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpSection_module_css_default.mcpGroup,
								children: activePreset === "" ? t("mcp.group.agentAll").replace("{n}", String(visiblePreset.length)) : t("mcp.group.agent").replace("{name}", presetChoices.find((option) => option.id === activePreset)?.name ?? activePreset).replace("{n}", String(visiblePreset.length))
							}),
							groupEmpty("agent", visiblePreset.length),
							visiblePreset.map((server) => rowFor(server))
						]
					}) : null,
					mcpView.status === "ready" && mcpView.refreshing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.mcpStatus,
						role: "status",
						children: t("mcp.refreshing")
					}) : null,
					mcpActionError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.mcpActionError,
						role: "alert",
						children: mcpActionError
					}) : null,
					notice !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: McpSection_module_css_default.mcpNotice,
						role: "status",
						children: notice
					}) : null
				]
			})] });
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
							value: "context",
							label: t("mcp.tab.context"),
							id: `${tabsId}-context-tab`,
							panelId: `${tabsId}-context-panel`
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						id: `${tabsId}-context-panel`,
						role: "tabpanel",
						"aria-labelledby": `${tabsId}-context-tab`,
						className: McpSection_module_css_default.tabPanel,
						hidden: tab !== "context",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpOptimizeSection, { ...props })
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
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ClaudeImportDialog, {
						open: importerOpen,
						busy: false,
						error: editorError,
						scanClaudeMcp,
						addMcps,
						servers,
						presets,
						plane: openedPlane,
						globalWritable: mcpView.status === "ready" && mcpView.globalWritable,
						...activePreset === "" ? {} : { preset: activePreset },
						t,
						onClose: () => {
							setImporterOpen(false);
						},
						onImported: () => {
							setNotice(t("mcp.notice.added"));
							refreshMcps();
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
				descriptor("addMcps"),
				descriptor("editMcp"),
				descriptor("disableMcp"),
				descriptor("describeMcp"),
				descriptor("listMcps"),
				descriptor("listMcpTools"),
				descriptor("gateState"),
				descriptor("catalogState"),
				descriptor("clearCatalog"),
				descriptor("scanClaudeMcp")
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
				addMcps: (request) => unwrapRemote(() => mcpMgr().addMcps(request)),
				editMcp: (request) => unwrapRemote(() => mcpMgr().editMcp(request)),
				disableMcp: (request) => unwrapRemote(() => mcpMgr().disableMcp(request)),
				describeMcp: (request) => unwrapRemote(() => mcpMgr().describeMcp(request)),
				listMcpTools: (request) => unwrapRemote(() => mcpMgr().listMcpTools(request)),
				scanClaudeMcp: (request) => unwrapRemote(() => mcpMgr().scanClaudeMcp(request)),
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
