window.__ModuleLoader__.load({
	id: "@zhang-guo-wen/dsh-mcp-manager",
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
		* @module @zhang-guo-wen/dsh-mcp-manager/mcp-tool-filter
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
		//#region \0dsh-css:C:\02-codespace\deepseek-harness\dsh-mcp-manager\src\client\McpSection.module.css.mjs
		const css = ".T3AhBW_section{flex-direction:column;gap:16px;width:100%;max-width:720px;display:flex}.T3AhBW_panel{flex-direction:column;gap:16px;display:flex}.T3AhBW_fieldLabel{font-size:13px;font-weight:600}.T3AhBW_fieldHint{color:var(--dsw-alias-label-tertiary);font-size:12px}.T3AhBW_mcpSub{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12.5px;line-height:20px}.T3AhBW_mcpToolbar{justify-content:space-between;align-items:center;gap:12px;display:flex}.T3AhBW_modeBlock{flex-direction:column;gap:7px;display:flex}.T3AhBW_modeGroup{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;display:grid}.T3AhBW_modeOption{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;border-radius:12px;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 12px;display:flex}.T3AhBW_modeOption:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.T3AhBW_modeOption:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.T3AhBW_modeOption:disabled{opacity:.55;cursor:not-allowed}.T3AhBW_modeOptionActive{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}.T3AhBW_modeName{font-size:13px;font-weight:600}.T3AhBW_modeDesc{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:17px}.T3AhBW_mcpList{flex-direction:column;gap:10px;display:flex}.T3AhBW_mcpRow{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-stroke);border-radius:12px;justify-content:space-between;align-items:center;gap:14px;padding:12px 14px;display:flex}.T3AhBW_mcpMain{flex-direction:column;gap:3px;min-width:0;display:flex}.T3AhBW_mcpName{font-size:14px;font-weight:600;font-family:var(--ds-font-family-code)}.T3AhBW_mcpDesc{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;background:0 0;border:0;outline:none;padding:0;font-family:inherit;font-size:12px;line-height:18px}.T3AhBW_mcpDesc::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.7}.T3AhBW_mcpDesc:focus{color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-state-business-primary)}.T3AhBW_mcpRight{flex:none;align-items:center;gap:10px;display:inline-flex}.T3AhBW_badge{corner-shape:round;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;padding:2px 8px;font-size:11px}.T3AhBW_status{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;display:inline-flex}.T3AhBW_mcpActions{align-items:center;gap:8px;display:inline-flex}.T3AhBW_mcpAction{appearance:none;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;background:0 0;border-radius:6px;padding:4px 10px;font-size:12px}.T3AhBW_mcpAction:hover{background:var(--dsw-alias-bg-layer-2)}.T3AhBW_mcpAction:disabled{opacity:.5;cursor:not-allowed}.T3AhBW_mcpStatus{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}.T3AhBW_mcpFailure{color:var(--dsw-alias-state-error-primary);align-items:center;gap:10px;display:flex}.T3AhBW_mcpFailure p{margin:0;font-size:13px}.T3AhBW_mcpRetry{border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 10px;font-size:12px}.T3AhBW_mcpRetry:hover{background:var(--dsw-alias-interactive-bg-hover)}.T3AhBW_empty,.T3AhBW_unavailable{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}.T3AhBW_mcpForm{flex-direction:column;gap:12px;display:flex}.T3AhBW_formField{flex-direction:column;gap:6px;display:flex}.T3AhBW_formLabel{color:var(--dsw-alias-label-secondary);font-size:12px}.T3AhBW_formSelect{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 10px;font-size:13px}.T3AhBW_formSelect:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.T3AhBW_formJson{width:100%;min-height:220px;font-family:var(--ds-font-family-code);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical;white-space:pre;border-radius:8px;padding:10px 12px;font-size:12px;line-height:18px;overflow:auto}.T3AhBW_formJson:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}.T3AhBW_formError{color:var(--dsw-alias-state-danger,#e5484d);margin:0;font-size:12px}.T3AhBW_mcpNotice{color:var(--dsw-alias-state-success,#2f9e44);margin:0;font-size:12px}.T3AhBW_mcpActionError{color:var(--dsw-alias-state-danger,#e5484d);margin:0;font-size:12px}.T3AhBW_toolsHead{align-items:center;gap:8px;display:flex}.T3AhBW_toolsCount{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px}.T3AhBW_toolsActions{gap:6px;margin-left:auto;display:flex}.T3AhBW_toolsList{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;max-height:220px;padding:4px;overflow:auto}.T3AhBW_toolRow{cursor:pointer;border-radius:6px;align-items:center;gap:8px;padding:4px 6px;display:flex}.T3AhBW_toolRow:hover{background:var(--dsw-alias-bg-layer-2)}.T3AhBW_toolName{font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);white-space:nowrap;font-size:12px}.T3AhBW_toolDesc{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;overflow:hidden}";
		const tagId = "@zhang-guo-wen/dsh-mcp-manager/McpSection.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var McpSection_module_css_default = {
			"badge": "T3AhBW_badge",
			"empty": "T3AhBW_empty",
			"fieldHint": "T3AhBW_fieldHint",
			"fieldLabel": "T3AhBW_fieldLabel",
			"formError": "T3AhBW_formError",
			"formField": "T3AhBW_formField",
			"formJson": "T3AhBW_formJson",
			"formLabel": "T3AhBW_formLabel",
			"formSelect": "T3AhBW_formSelect",
			"mcpAction": "T3AhBW_mcpAction",
			"mcpActionError": "T3AhBW_mcpActionError",
			"mcpActions": "T3AhBW_mcpActions",
			"mcpDesc": "T3AhBW_mcpDesc",
			"mcpFailure": "T3AhBW_mcpFailure",
			"mcpForm": "T3AhBW_mcpForm",
			"mcpList": "T3AhBW_mcpList",
			"mcpMain": "T3AhBW_mcpMain",
			"mcpName": "T3AhBW_mcpName",
			"mcpNotice": "T3AhBW_mcpNotice",
			"mcpRetry": "T3AhBW_mcpRetry",
			"mcpRight": "T3AhBW_mcpRight",
			"mcpRow": "T3AhBW_mcpRow",
			"mcpStatus": "T3AhBW_mcpStatus",
			"mcpSub": "T3AhBW_mcpSub",
			"mcpToolbar": "T3AhBW_mcpToolbar",
			"modeBlock": "T3AhBW_modeBlock",
			"modeDesc": "T3AhBW_modeDesc",
			"modeGroup": "T3AhBW_modeGroup",
			"modeName": "T3AhBW_modeName",
			"modeOption": "T3AhBW_modeOption",
			"modeOptionActive": "T3AhBW_modeOptionActive",
			"panel": "T3AhBW_panel",
			"section": "T3AhBW_section",
			"status": "T3AhBW_status",
			"toolDesc": "T3AhBW_toolDesc",
			"toolName": "T3AhBW_toolName",
			"toolRow": "T3AhBW_toolRow",
			"toolsActions": "T3AhBW_toolsActions",
			"toolsCount": "T3AhBW_toolsCount",
			"toolsHead": "T3AhBW_toolsHead",
			"toolsList": "T3AhBW_toolsList",
			"unavailable": "T3AhBW_unavailable"
		};
		//#endregion
		//#region src/client/McpEditor.tsx
		/** Settings key for one row (`global:<name>` or `preset:<id>:<name>`), shared with the Host's `mcpRowKey`. */
		function rowKey(scope, agentPreset, serverName) {
			return scope === "preset" ? `preset:${agentPreset}:${serverName}` : `global:${serverName}`;
		}
		/** Flatten a spec into a Claude-shaped object (spec fields at the top level). */
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
		/** Read one spec object (Claude-shaped fields) into the normalized spec. */
		function specFromObject(candidate, invalid) {
			const declared = candidate.type;
			const type = declared === void 0 ? typeof candidate.command === "string" ? "stdio" : typeof candidate.url === "string" ? "streamable-http" : void 0 : declared;
			if (type === "stdio") {
				const command = candidate.command;
				if (typeof command !== "string" || command.trim() === "") throw new Error(invalid);
				const args = Array.isArray(candidate.args) ? candidate.args.map(String) : void 0;
				const env = candidate.env !== null && typeof candidate.env === "object" && !Array.isArray(candidate.env) ? Object.fromEntries(Object.entries(candidate.env).map(([k, v]) => [k, String(v)])) : void 0;
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
				const headers = candidate.headers !== null && typeof candidate.headers === "object" && !Array.isArray(candidate.headers) ? Object.fromEntries(Object.entries(candidate.headers).map(([k, v]) => [k, String(v)])) : void 0;
				return {
					type,
					url,
					...headers === void 0 ? {} : { headers }
				};
			}
			throw new Error(invalid);
		}
		/**
		* Parse the connection JSON. Accepts a flat spec, a single-entry named map
		* (`{ "<name>": { command|url } }`), or a Claude `mcpServers` wrapper; a name
		* carried in the JSON is returned so the editor can fill an empty title.
		*/
		function parseSpec(text, invalid) {
			let value;
			try {
				value = JSON.parse(text);
			} catch {
				throw new Error(invalid);
			}
			if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(invalid);
			let root = value;
			if (root.mcpServers !== null && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) root = root.mcpServers;
			let serverName;
			if (root.type === void 0 && root.command === void 0 && root.url === void 0) {
				const pairs = Object.entries(root);
				if (pairs.length !== 1) throw new Error(invalid);
				const [name, entry] = pairs[0];
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error(invalid);
				serverName = name;
				root = entry;
			}
			return {
				spec: specFromObject(root, invalid),
				...serverName === void 0 ? {} : { serverName }
			};
		}
		/** Modal editor: one scope dropdown, title/description fields, a JSON spec box, and the tool list. */
		function McpEditor({ open, mode, server, disabled, busy, error, describeMcp, listMcpTools, presets, descriptionInitial, onUpdateDescription, toolRulesInitial, onUpdateTools, t, onClose, onSubmit }) {
			const [scopeValue, setScopeValue] = (0, react.useState)(server?.scope === "preset" ? server.presetId ?? "" : "");
			const [presetOptions, setPresetOptions] = (0, react.useState)([]);
			const [title, setTitle] = (0, react.useState)(server?.serverName ?? "");
			const [description, setDescription] = (0, react.useState)(descriptionInitial);
			const [json, setJson] = (0, react.useState)("");
			const [localError, setLocalError] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [tools, setTools] = (0, react.useState)(null);
			const [hiddenTools, setHiddenTools] = (0, react.useState)(() => /* @__PURE__ */ new Set());
			const [toolsBusy, setToolsBusy] = (0, react.useState)(false);
			const [toolsError, setToolsError] = (0, react.useState)(null);
			const editKey = `${server?.scope ?? ""}:${server?.presetId ?? ""}:${server?.entryId ?? ""}`;
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
			(0, react.useEffect)(() => {
				if (!open) return;
				let current = true;
				setLocalError(null);
				setScopeValue(server?.scope === "preset" ? server.presetId ?? "" : "");
				setTitle(server?.serverName ?? "");
				setDescription(descriptionInitial);
				setTools(null);
				setHiddenTools(/* @__PURE__ */ new Set());
				setToolsError(null);
				setToolsBusy(false);
				presets().then((list) => {
					if (current) setPresetOptions(list);
				}, () => {
					if (current) setPresetOptions([]);
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
						loadTools(described.spec, described.serverName, true);
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
					const parsed = parseSpec(json, t("mcp.form.jsonInvalid"));
					const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
					if (serverName === "") throw new Error(t("mcp.form.required"));
					const spec = parsed.spec;
					const target = scopeValue === "" ? { scope: "global" } : {
						scope: "preset",
						agentPreset: scopeValue
					};
					const entryId = mode === "edit" ? server?.entryId ?? "" : void 0;
					if (mode === "edit" && entryId === "") throw new Error(t("mcp.form.required"));
					onSubmit({
						target,
						serverName,
						spec,
						...entryId === void 0 ? {} : { entryId }
					});
					const key = rowKey(scopeValue === "" ? "global" : "preset", scopeValue, serverName);
					if (description.trim() !== "") onUpdateDescription(key, description.trim());
					if (tools !== null) onUpdateTools(key, tools.filter((tool) => hiddenTools.has(tool.name)).map((tool) => `!${tool.name}`));
				} catch (cause) {
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
			const formDisabled = disabled || busy;
			const enabledCount = tools === null ? 0 : tools.length - tools.filter((tool) => hiddenTools.has(tool.name)).length;
			const titleText = mode === "add" ? t("mcp.form.addTitle") : t("mcp.form.editTitle");
			const showsCurrentPreset = scopeValue !== "" && !presetOptions.some((option) => option.id === scopeValue);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose,
				title: titleText,
				closeLabel: t("mcp.form.close"),
				description: t("mcp.form.hint"),
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
						disabled: formDisabled,
						children: busy ? t("mcp.form.saving") : t("mcp.form.save")
					})]
				}),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpForm,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: McpSection_module_css_default.formField,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: McpSection_module_css_default.formLabel,
								children: t("mcp.form.scope")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								className: McpSection_module_css_default.formSelect,
								value: scopeValue,
								disabled: formDisabled || mode === "edit",
								"aria-label": t("mcp.form.scope"),
								onChange: (event) => {
									setScopeValue(event.currentTarget.value);
									setLocalError(null);
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("mcp.scopeGlobal")
									}),
									presetOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: option.id,
										children: option.name
									}, option.id)),
									showsCurrentPreset ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: scopeValue,
										children: scopeValue
									}) : null
								]
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.formField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: McpSection_module_css_default.toolsHead,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.formLabel,
											children: t("mcp.form.tools")
										}),
										tools !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: McpSection_module_css_default.toolsCount,
											children: `${enabledCount}/${tools.length}`
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: McpSection_module_css_default.toolsActions,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: McpSection_module_css_default.mcpAction,
												disabled: formDisabled || toolsBusy,
												onClick: () => {
													try {
														const parsed = parseSpec(json, t("mcp.form.jsonInvalid"));
														const serverName = (title.trim() !== "" ? title.trim() : parsed.serverName ?? "").trim();
														loadTools(parsed.spec, serverName, tools === null);
													} catch (cause) {
														setToolsError(cause instanceof Error ? cause.message : t("mcp.form.jsonInvalid"));
													}
												},
												children: toolsBusy ? t("mcp.form.toolsLoading") : t("mcp.form.toolsReload")
											}), tools !== null && tools.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: McpSection_module_css_default.mcpAction,
												disabled: formDisabled,
												onClick: () => {
													setHiddenTools(/* @__PURE__ */ new Set());
												},
												children: t("mcp.form.toolsAll")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: McpSection_module_css_default.mcpAction,
												disabled: formDisabled,
												onClick: () => {
													setHiddenTools(new Set(tools.map((tool) => tool.name)));
												},
												children: t("mcp.form.toolsNone")
											})] }) : null]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.fieldHint,
									children: t("mcp.form.toolsHint")
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
												disabled: formDisabled,
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
						loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpStatus,
							children: t("mcp.loading")
						}) : null,
						localError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.formError,
							role: "alert",
							children: localError
						}) : null,
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
		//#region src/client/settings-controller.ts
		/** Settings namespace registered Host-side by @zhang-guo-wen/dsh-mcp-manager. */
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
		* Project a Host plugin-inventory snapshot onto the MCP roster, keeping every
		* mcp-client occurrence (global plane plus each preset composition) without
		* deduplicating cross-scope repeats. Descriptions are not read here — they are
		* plugin-owned and merged by the section from the `descriptions` map.
		* @param snapshot - the load-time inventory read from the Host.
		* @returns one row per mcp-client occurrence, tagged with its config scope.
		*/
		function mapMcpServers(snapshot) {
			const rows = [];
			for (const entry of snapshot.entries) {
				if (entry.moduleName !== "@deepseek-ai/dsh-mcp-client") continue;
				rows.push({
					entryId: entry.entryId,
					serverName: localEntryId(entry.entryId),
					scope: "global",
					presetId: void 0,
					enabled: entry.enabled,
					fiberPhase: entry.fiberPhase
				});
			}
			for (const preset of snapshot.agentPresets ?? []) for (const row of preset.rows) {
				if (row.moduleName !== "@deepseek-ai/dsh-mcp-client") continue;
				rows.push({
					entryId: row.entryId,
					serverName: localEntryId(row.entryId ?? row.moduleName),
					scope: "preset",
					presetId: preset.id,
					enabled: row.enabled,
					fiberPhase: row.fiberPhase
				});
			}
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
			* @param scope - bound `mcp-manager` settings scope.
			* @param mcps - Host-backed MCP roster loader.
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
					addMcp: this.authoring.addMcp,
					editMcp: this.authoring.editMcp,
					disableMcp: this.authoring.disableMcp,
					describeMcp: this.authoring.describeMcp,
					listMcpTools: this.authoring.listMcpTools,
					suppressedMcps: this.suppressed,
					mcps: this.mcps,
					presets: this.presets
				};
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
			setMcpLoading(mode) {
				const snapshot = this.scope.getSnapshot();
				if (snapshot.status !== "ready" || !snapshot.writable) return Promise.resolve();
				if (snapshot.value?.loading === mode) return Promise.resolve();
				return this.scope.set("loading", mode);
			}
			projection() {
				const snapshot = this.scope.getSnapshot();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					loading: snapshot.value?.loading ?? "dynamic",
					descriptions: snapshot.value?.descriptions ?? {},
					tools: snapshot.value?.tools ?? {}
				};
			}
			publish() {
				this.store.set(this.projection());
			}
		};
		//#endregion
		//#region src/client/McpSection.tsx
		/**
		* MCP management settings section: the server roster with its loading mode.
		*
		* The section lists the MCP servers the Host has configured — global plane plus
		* every agent-preset composition, surfaced without deduplication and tagged with
		* its config scope — and offers the three settings this plugin owns: when an
		* allowed server enters context, each row's authoring description, and each
		* row's tool filter.
		* @module @zhang-guo-wen/dsh-mcp-manager/client/McpSection
		*/
		/** Non-empty fiber-phase → localized status key. */
		const PHASE_LABEL = {
			pending: "mcp.status.pending",
			loading: "mcp.status.loading",
			active: "mcp.status.active",
			failed: "mcp.status.failed",
			unloading: "mcp.status.unloading"
		};
		/** Non-empty fiber-phase → state-dot semantic. */
		const PHASE_DOT = {
			pending: "idle",
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
		/** Resolve one MCP row's displayed status label and dot. */
		function statusOf(server, suppressed, t) {
			if (server.enabled === false) return suppressed ? {
				label: t("mcp.status.deferred"),
				dot: "idle"
			} : {
				label: t("mcp.status.disabled"),
				dot: "idle"
			};
			if (server.enabled === "conditional") return {
				label: t("mcp.status.conditional"),
				dot: "warning"
			};
			if (server.fiberPhase === null) return {
				label: t("mcp.status.configured"),
				dot: "idle"
			};
			return {
				label: t(PHASE_LABEL[server.fiberPhase]),
				dot: PHASE_DOT[server.fiberPhase]
			};
		}
		/**
		* The MCP loading mode picker: one radio per mode, each carrying its own
		* one-line explanation so the trade-off (prompt cost and cache-prefix churn
		* against tool-binding quality) is readable without leaving the page.
		*/
		function McpLoadingPicker({ value, disabled, onPick, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.modeBlock,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.fieldLabel,
						children: t("mcp.mode.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.fieldHint,
						children: t("mcp.mode.hint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: McpSection_module_css_default.modeGroup,
						role: "radiogroup",
						"aria-label": t("mcp.mode.title"),
						children: MCP_LOADING_OPTIONS.map((mode) => {
							const selected = value === mode;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "radio",
								"aria-checked": selected,
								"data-mcp-mode": mode,
								className: selected ? `${McpSection_module_css_default.modeOption} ${McpSection_module_css_default.modeOptionActive}` : McpSection_module_css_default.modeOption,
								disabled,
								title: disabled ? t("unavailable") : void 0,
								onClick: () => {
									onPick(mode);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.modeName,
									children: t(MODE_LABEL[mode])
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: McpSection_module_css_default.modeDesc,
									children: t(MODE_DESC[mode])
								})]
							}, mode);
						})
					})
				]
			});
		}
		/** One rendered MCP server row: name, plugin-owned description, scope, status, and row actions. */
		function McpRow({ server, description, suppressed, pending, onEditDescription, onEdit, onToggleDisabled, actionsDisabled, t }) {
			const scope = server.scope === "global" ? t("mcp.scopeGlobal") : `${t("mcp.scopePreset")} · ${server.presetId ?? ""}`;
			const status = pending === "enabling" ? {
				label: t("mcp.status.starting"),
				dot: "warning"
			} : pending === "disabling" ? {
				label: t("mcp.status.stopping"),
				dot: "warning"
			} : statusOf(server, suppressed, t);
			const checked = pending === "enabling" ? true : pending === "disabling" ? false : server.enabled !== false || suppressed;
			const disabledNow = server.enabled === false && !suppressed;
			const [draft, setDraft] = (0, react.useState)(null);
			const value = draft ?? description;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: McpSection_module_css_default.mcpRow,
				"data-mcp-scope": server.scope,
				"data-mcp-name": server.serverName,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpMain,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: McpSection_module_css_default.mcpName,
						children: server.serverName
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: McpSection_module_css_default.mcpDesc,
						value,
						placeholder: t("mcp.descriptionPlaceholder"),
						"aria-label": t("mcp.descriptionLabel"),
						onChange: (event) => {
							setDraft(event.currentTarget.value);
						},
						onBlur: () => {
							onEditDescription(value);
							setDraft(null);
						}
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.mcpRight,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: McpSection_module_css_default.badge,
							children: scope
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.status,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: status.dot }), status.label]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: McpSection_module_css_default.mcpActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: McpSection_module_css_default.mcpAction,
								disabled: actionsDisabled,
								onClick: onEdit,
								children: t("mcp.edit")
							}), server.entryId !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
								checked,
								onChange: onToggleDisabled,
								label: disabledNow ? t("mcp.enable") : t("mcp.disable"),
								disabled: actionsDisabled || pending !== null,
								title: t("mcp.status.disabled")
							}) : null]
						})
					]
				})]
			});
		}
		/** The MCP management section body. */
		function McpSection(props) {
			const { useMcpSettings, t, setMcpLoading, addMcp, editMcp, disableMcp, describeMcp, listMcpTools, suppressedMcps, mcps, presets, updateMcpDescription, updateMcpTools } = props;
			const state = useMcpSettings((snapshot) => snapshot);
			const [mcpView, setMcpView] = (0, react.useState)({ status: "loading" });
			const [mcpRequest, setMcpRequest] = (0, react.useState)(0);
			const [editor, setEditor] = (0, react.useState)({
				mode: "add",
				server: void 0,
				open: false
			});
			const [editorBusy, setEditorBusy] = (0, react.useState)(false);
			const [editorError, setEditorError] = (0, react.useState)(null);
			const [mcpActionError, setMcpActionError] = (0, react.useState)(null);
			const [notice, setNotice] = (0, react.useState)(null);
			const [rowPending, setRowPending] = (0, react.useState)({});
			const disabled = !state.available || !state.writable;
			(0, react.useEffect)(() => {
				let current = true;
				setMcpView({ status: "loading" });
				Promise.resolve().then(suppressedMcps).catch((error) => {
					console.error("[mcp-manager] MCP gate read failed", error);
					return [];
				}).then(async (suppressed) => ({
					suppressed,
					servers: await mcps()
				})).then(({ servers, suppressed }) => {
					if (current) setMcpView({
						status: "ready",
						servers,
						suppressed: new Set(suppressed)
					});
				}, () => {
					if (current) setMcpView({ status: "error" });
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
			* every composed row reached its new state.
			*/
			const pickMode = (mode) => {
				Promise.resolve().then(() => setMcpLoading(mode)).then(suppressedMcps).catch(() => []).then(() => {
					refreshMcps();
				});
			};
			const openAdd = () => {
				setEditor({
					mode: "add",
					server: void 0,
					open: true
				});
				setEditorError(null);
				setMcpActionError(null);
				setNotice(null);
			};
			const openEdit = (server) => {
				setEditor({
					mode: "edit",
					server,
					open: true
				});
				setEditorError(null);
				setMcpActionError(null);
				setNotice(null);
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
				setMcpActionError(null);
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
					setEditorError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setEditorBusy(false);
				}
			};
			/**
			* Flip one row's enablement without blocking the list. The row immediately
			* shows its target state and a transient starting/stopping label; the Host
			* call (which starts or stops the child MCP process) runs in the background
			* and the list refreshes with the real state when it settles.
			*/
			const toggleDisabled = (server, enabled) => {
				if (server.entryId === null) return;
				const key = mcpRowKey(server);
				const target = server.scope === "global" ? { scope: "global" } : {
					scope: "preset",
					agentPreset: server.presetId ?? ""
				};
				setMcpActionError(null);
				setRowPending((previous) => ({
					...previous,
					[key]: enabled ? "enabling" : "disabling"
				}));
				(async () => {
					try {
						await disableMcp({
							target,
							entryId: server.entryId,
							disabled: !enabled
						});
						setNotice(enabled ? t("mcp.notice.enabled") : t("mcp.notice.disabled"));
					} catch (cause) {
						setMcpActionError(cause instanceof Error ? cause.message : String(cause));
					} finally {
						setRowPending((previous) => {
							const next = { ...previous };
							delete next[key];
							return next;
						});
						refreshMcps();
					}
				})();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: McpSection_module_css_default.section,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: McpSection_module_css_default.panel,
					children: [
						!state.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.unavailable,
							children: t("unavailable")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpLoadingPicker, {
							value: state.loading,
							disabled,
							onPick: pickMode,
							t
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.mcpToolbar,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: McpSection_module_css_default.mcpSub,
								children: t("mcp.subtitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: openAdd,
								disabled: editorBusy,
								children: t("mcp.add")
							})]
						}),
						mcpView.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.mcpStatus,
							children: t("mcp.loading")
						}) : null,
						mcpView.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: McpSection_module_css_default.mcpFailure,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								children: t("mcp.error")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: McpSection_module_css_default.mcpRetry,
								onClick: () => {
									setMcpRequest((value) => value + 1);
								},
								children: t("mcp.retry")
							})]
						}) : null,
						mcpView.status === "ready" && mcpView.servers.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: McpSection_module_css_default.empty,
							children: t("mcp.empty")
						}) : null,
						mcpView.status === "ready" && mcpView.servers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: McpSection_module_css_default.mcpList,
							children: mcpView.servers.map((server) => {
								const key = mcpRowKey(server);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(McpRow, {
									server,
									description: server.description ?? state.descriptions[key] ?? "",
									suppressed: mcpView.suppressed.has(key),
									pending: rowPending[key] ?? null,
									onEditDescription: (value) => {
										updateMcpDescription(key, value);
									},
									onEdit: () => {
										openEdit(server);
									},
									onToggleDisabled: (enabled) => {
										toggleDisabled(server, enabled);
									},
									actionsDisabled: editorBusy,
									t
								}, key);
							})
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
						}) : null,
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
							descriptionInitial: editor.server === void 0 ? "" : editor.server.description ?? state.descriptions[mcpRowKey(editor.server)] ?? "",
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
				})
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* MCP management settings section dictionaries.
		* @module @zhang-guo-wen/dsh-mcp-manager/client/locales
		*/
		/** Locale namespace owned by this plugin's settings section. */
		const NS = "settings.mcpManager";
		const zh = {
			"nav": "MCP 管理",
			"mcp.subtitle": "已加载的 MCP 服务器",
			"mcp.mode.title": "MCP 加载方式",
			"mcp.mode.hint": "启用 = 允许使用这台 MCP；这一项决定允许的服务器什么时候进上下文。禁用 = 完全不用：不出现在工具列表，也不能 mcp_load。",
			"mcp.mode.eager": "全部加载",
			"mcp.mode.eager.desc": "允许的服务器在会话开始时就挂载，工具始终在请求里。最省事，但每次请求都要付工具描述的 token。",
			"mcp.mode.dynamic": "动态插入",
			"mcp.mode.dynamic.desc": "允许的服务器默认不挂载；需要时用 mcp_load 把它挂进当前会话。工具列表会变化一次，请求缓存前缀随之中断。",
			"mcp.mode.lazy": "延迟加载",
			"mcp.mode.lazy.desc": "允许的服务器默认不挂载；需要时用 mcp_load 连接、用 mcp_call 调用。工具列表永不变化，请求缓存前缀不中断。",
			"mcp.add": "新增 MCP",
			"mcp.notice.added": "已新增 MCP 服务器",
			"mcp.notice.saved": "已保存 MCP 服务器",
			"mcp.notice.enabled": "已启用 MCP 服务器",
			"mcp.notice.disabled": "已禁用 MCP 服务器",
			"mcp.edit": "编辑",
			"mcp.enable": "启用",
			"mcp.disable": "禁用",
			"mcp.loading": "正在读取……",
			"mcp.error": "读取失败",
			"mcp.retry": "重试",
			"mcp.empty": "暂无已加载的 MCP 服务器",
			"mcp.scopeGlobal": "全局",
			"mcp.scopePreset": "预设",
			"mcp.descriptionPlaceholder": "添加描述",
			"mcp.descriptionLabel": "MCP 描述",
			"mcp.form.addTitle": "新增 MCP 服务器",
			"mcp.form.editTitle": "编辑 MCP 服务器",
			"mcp.form.close": "关闭",
			"mcp.form.hint": "粘贴 MCP 服务器的连接 JSON（Claude Code 兼容），保存时会解析校验。",
			"mcp.form.json": "JSON 配置",
			"mcp.form.jsonInvalid": "JSON 格式或字段不合法",
			"mcp.form.cancel": "取消",
			"mcp.form.save": "保存",
			"mcp.form.saving": "保存中……",
			"mcp.form.required": "请填写必填项",
			"mcp.form.invalidKeyValue": "KEY=VALUE 格式无效",
			"mcp.form.scope": "配置范围",
			"mcp.form.preset": "预设 ID",
			"mcp.form.entryId": "行 ID",
			"mcp.form.entryIdPlaceholder": "默认为服务器名",
			"mcp.form.serverName": "服务器名",
			"mcp.form.description": "描述",
			"mcp.form.tools": "工具",
			"mcp.form.toolsHint": "默认全部启用。取消勾选的方法不会交给模型：既不列出，也不能调用。",
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
			"mcp.status.deferred": "待加载",
			"mcp.status.conditional": "条件启用",
			"mcp.status.configured": "已配置",
			"mcp.status.pending": "待加载",
			"mcp.status.loading": "加载中",
			"mcp.status.starting": "启动中",
			"mcp.status.stopping": "停止中",
			"mcp.status.active": "运行中",
			"mcp.status.failed": "加载失败",
			"mcp.status.unloading": "卸载中",
			"unavailable": "设置当前不可用"
		};
		const en = {
			"nav": "MCP Management",
			"mcp.subtitle": "Loaded MCP servers",
			"mcp.mode.title": "MCP loading",
			"mcp.mode.hint": "Enabled means the server may be used; this setting decides when an allowed server enters context. Disabled means never: it is not offered as a tool and cannot be loaded.",
			"mcp.mode.eager": "Load all",
			"mcp.mode.eager.desc": "Allowed servers mount at session start, so their tools are always in the request. Simplest, and you pay the tool descriptions on every request.",
			"mcp.mode.dynamic": "Dynamic insert",
			"mcp.mode.dynamic.desc": "Allowed servers stay unmounted by default; mcp_load mounts one into the calling session. The tool list changes once per load, which breaks the request-cache prefix.",
			"mcp.mode.lazy": "Lazy",
			"mcp.mode.lazy.desc": "Allowed servers stay unmounted by default; mcp_load connects one and mcp_call invokes it. The tool list never changes, so the request-cache prefix survives.",
			"mcp.add": "Add MCP",
			"mcp.notice.added": "MCP server added",
			"mcp.notice.saved": "MCP server saved",
			"mcp.notice.enabled": "MCP server enabled",
			"mcp.notice.disabled": "MCP server disabled",
			"mcp.edit": "Edit",
			"mcp.enable": "Enable",
			"mcp.disable": "Disable",
			"mcp.loading": "Loading…",
			"mcp.error": "Failed to read",
			"mcp.retry": "Retry",
			"mcp.empty": "No MCP servers loaded",
			"mcp.scopeGlobal": "Global",
			"mcp.scopePreset": "Preset",
			"mcp.descriptionPlaceholder": "Add description",
			"mcp.descriptionLabel": "MCP description",
			"mcp.form.addTitle": "Add MCP server",
			"mcp.form.editTitle": "Edit MCP server",
			"mcp.form.close": "Close",
			"mcp.form.hint": "Paste the MCP connection JSON (Claude Code compatible); it is parsed and validated on save.",
			"mcp.form.json": "JSON config",
			"mcp.form.jsonInvalid": "Invalid JSON format or fields",
			"mcp.form.cancel": "Cancel",
			"mcp.form.save": "Save",
			"mcp.form.saving": "Saving…",
			"mcp.form.required": "Required fields are missing",
			"mcp.form.invalidKeyValue": "Invalid KEY=VALUE line",
			"mcp.form.scope": "Config scope",
			"mcp.form.preset": "Preset ID",
			"mcp.form.entryId": "Row ID",
			"mcp.form.entryIdPlaceholder": "Defaults to the server name",
			"mcp.form.serverName": "Server name",
			"mcp.form.description": "Description",
			"mcp.form.tools": "Tools",
			"mcp.form.toolsHint": "All enabled by default. An unchecked tool never reaches the model: it is neither listed nor callable.",
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
			"mcp.status.deferred": "Deferred",
			"mcp.status.conditional": "Conditional",
			"mcp.status.configured": "Configured",
			"mcp.status.pending": "Pending",
			"mcp.status.loading": "Loading",
			"mcp.status.starting": "Starting",
			"mcp.status.stopping": "Stopping",
			"mcp.status.active": "Running",
			"mcp.status.failed": "Failed to load",
			"mcp.status.unloading": "Unloading",
			"unavailable": "Setting currently unavailable"
		};
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
			const owner = `@zhang-guo-wen/dsh-mcp-manager#${`${REMOTE_NAMESPACE}/${method}`}`;
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
			package: "@zhang-guo-wen/dsh-mcp-manager",
			descriptors: [
				descriptor("addMcp"),
				descriptor("editMcp"),
				descriptor("disableMcp"),
				descriptor("describeMcp"),
				descriptor("listMcpTools"),
				descriptor("gateState")
			]
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services (cordis fiber inject). */
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"remote",
			"remote.pluginInventory"
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
			const mcps = async () => {
				const result = await ctx.remote.pluginInventory.list();
				if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
				return mapMcpServers(result.value);
			};
			const mcpMgr = () => {
				const namespace = ctx.get(`remote.${REMOTE_NAMESPACE}`);
				if (namespace === void 0) throw new Error(`${REMOTE_NAMESPACE} namespace service is not mounted`);
				return namespace;
			};
			const authoring = {
				addMcp: (request) => unwrapRemote(() => mcpMgr().addMcp(request)),
				editMcp: (request) => unwrapRemote(() => mcpMgr().editMcp(request)),
				disableMcp: (request) => unwrapRemote(() => mcpMgr().disableMcp(request)),
				describeMcp: (request) => unwrapRemote(() => mcpMgr().describeMcp(request)),
				listMcpTools: (request) => unwrapRemote(() => mcpMgr().listMcpTools(request))
			};
			const presets = async () => {
				const result = await ctx.remote.pluginInventory.list();
				if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
				return (result.value.agentPresets ?? []).map((group) => ({
					id: group.id,
					name: group.name ?? group.id
				}));
			};
			const suppressedMcps = async () => unwrapRemote(() => mcpMgr().gateState({})).then((state) => state.suppressed);
			const controller = new McpSettingsController(ctx.settingsScope.bind({ namespace: MCP_SETTINGS_NS }), mcps, authoring, presets, suppressedMcps);
			ctx.effect(() => () => {
				controller.dispose();
			}, "ui-mcp-manager: scope");
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
