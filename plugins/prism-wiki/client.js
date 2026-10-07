window.__ModuleLoader__.load({
	id: "@prism-ai/prism-wiki",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		//#region lib/types/client/api.js
		/**
		* Browser client for the wiki routes: one typed request per operation, with
		* every response narrowed at this wire boundary before the page renders it.
		* Requests are document-relative so a host mount prefix keeps working.
		* @module @prism-ai/prism-wiki/src/client/api
		*/
		/** Path prefix below `/api` every request of this client addresses. */
		const BASE = "api/prism-wiki";
		/** Every page kind the wire vocabulary carries. */
		const PAGE_TYPES$1 = [
			"overview",
			"entity",
			"concept",
			"source",
			"comparison",
			"synthesis"
		];
		/** Every page state the wire vocabulary carries. */
		const PAGE_STATUSES$1 = [
			"current",
			"stub",
			"superseded",
			"disputed"
		];
		/** Every lint-finding class the wire vocabulary carries. */
		const LINT_KINDS = [
			"orphan-page",
			"broken-link",
			"missing-page",
			"unintegrated-source",
			"missing-source",
			"frontmatter",
			"contradiction"
		];
		/** One wiki operation failed; `code` names the failing layer. */
		var WikiRequestError = class extends Error {
			code;
			/**
			* @param code - Host failure code, or the client-side validation code.
			* @param message - Operator-readable failure text.
			*/
			constructor(code, message) {
				super(message);
				this.code = code;
				this.name = "WikiRequestError";
			}
		};
		/** Build the failure for a host response this client cannot read. */
		function invalidResponse(subject) {
			return new WikiRequestError("prism-wiki/invalid-response", `the host answered with an invalid ${subject}`);
		}
		/**
		* Whether one decoded value is this plugin's response envelope.
		* @param value - decoded JSON value.
		* @returns true for either arm of the envelope.
		*/
		function isEnvelope(value) {
			if (typeof value !== "object" || value === null) return false;
			const record = value;
			if (record.ok === true) return "value" in record;
			if (record.ok !== false || typeof record.error !== "object" || record.error === null) return false;
			const error = record.error;
			return typeof error.code === "string" && typeof error.message === "string";
		}
		/**
		* Read one named field from a decoded value.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the field value.
		*/
		function readField(value, field) {
			if (typeof value !== "object" || value === null || !(field in value)) throw invalidResponse(field);
			return value[field];
		}
		/**
		* Whether one decoded value is a member of a closed string union.
		* @param value - decoded JSON value.
		* @param allowed - every member of that union.
		* @returns true when the value is one of the members.
		*/
		function isOneOf(value, allowed) {
			return typeof value === "string" && allowed.some((entry) => entry === value);
		}
		/**
		* Read one required string field.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the field text.
		*/
		function stringField(value, field) {
			const read = readField(value, field);
			if (typeof read !== "string") throw invalidResponse(field);
			return read;
		}
		/**
		* Read one required finite-number field.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the field number.
		*/
		function numberField(value, field) {
			const read = readField(value, field);
			if (typeof read !== "number" || !Number.isFinite(read)) throw invalidResponse(field);
			return read;
		}
		/**
		* Read one required string-list field.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the field entries, in wire order.
		*/
		function stringListField(value, field) {
			const read = readField(value, field);
			if (!Array.isArray(read) || !read.every((entry) => typeof entry === "string")) throw invalidResponse(field);
			return read;
		}
		/**
		* Read one required member of a closed string union.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @param allowed - every member of that union.
		* @returns the field member.
		*/
		function unionField(value, field, allowed) {
			const read = readField(value, field);
			if (!isOneOf(read, allowed)) throw invalidResponse(field);
			return read;
		}
		/**
		* Read one page path the wire carries as a plain string.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the path, branded for the frozen wire vocabulary.
		*/
		function pagePathField(value, field) {
			return stringField(value, field);
		}
		/**
		* Read the nullable page path of one lint finding.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @returns the page path, or null when the finding is about the vault as a whole.
		*/
		function nullablePagePathField(value, field) {
			const read = readField(value, field);
			if (read === null) return null;
			if (typeof read !== "string") throw invalidResponse(field);
			return read;
		}
		/**
		* Read the stated certainty of one page.
		* @param value - decoded frontmatter value.
		* @returns the number, or null when the author stated none.
		*/
		function confidenceField(value) {
			const read = readField(value, "confidence");
			if (read === null) return null;
			if (typeof read !== "number" || !Number.isFinite(read)) throw invalidResponse("confidence");
			return read;
		}
		/**
		* Read one stored page's frontmatter.
		* @param value - decoded frontmatter value.
		* @returns the frontmatter with every declared field at its declared type.
		*/
		function readFrontmatter(value) {
			return {
				title: stringField(value, "title"),
				type: unionField(value, "type", PAGE_TYPES$1),
				tags: stringListField(value, "tags"),
				updated: stringField(value, "updated"),
				status: unionField(value, "status", PAGE_STATUSES$1),
				sources: stringListField(value, "sources"),
				aliases: stringListField(value, "aliases"),
				confidence: confidenceField(value),
				contradicts: stringListField(value, "contradicts")
			};
		}
		/**
		* Read one stored page payload.
		* @param value - decoded payload value.
		* @returns the payload with its revision.
		*/
		function readPayload(value) {
			return {
				path: stringField(value, "path"),
				frontmatter: readFrontmatter(readField(value, "frontmatter")),
				body: stringField(value, "body"),
				revision: stringField(value, "revision")
			};
		}
		/**
		* Read one vault-tree row.
		* @param value - decoded summary value.
		* @returns the row with every declared field at its declared type.
		*/
		function readSummary(value) {
			return {
				path: stringField(value, "path"),
				title: stringField(value, "title"),
				type: unionField(value, "type", PAGE_TYPES$1),
				status: unionField(value, "status", PAGE_STATUSES$1),
				updated: stringField(value, "updated"),
				tags: stringListField(value, "tags")
			};
		}
		/**
		* Read one ranked search hit.
		* @param value - decoded hit value.
		* @returns the hit with every declared field at its declared type.
		*/
		function readHit(value) {
			return {
				path: pagePathField(value, "path"),
				title: stringField(value, "title"),
				type: unionField(value, "type", PAGE_TYPES$1),
				status: unionField(value, "status", PAGE_STATUSES$1),
				updated: stringField(value, "updated"),
				excerpt: stringField(value, "excerpt")
			};
		}
		/**
		* Read one lint finding.
		* @param value - decoded finding value.
		* @returns the finding with every declared field at its declared type.
		*/
		function readFinding(value) {
			return {
				kind: unionField(value, "kind", LINT_KINDS),
				page: nullablePagePathField(value, "page"),
				detail: stringField(value, "detail")
			};
		}
		/**
		* Read the vault health report.
		* @param value - decoded report value.
		* @returns the report with its findings.
		*/
		function readReport(value) {
			const findings = readField(value, "findings");
			if (!Array.isArray(findings)) throw invalidResponse("findings");
			return {
				pages: numberField(value, "pages"),
				sources: numberField(value, "sources"),
				findings: findings.map((entry) => readFinding(entry))
			};
		}
		/**
		* Read one array field by narrowing each entry.
		* @param value - decoded host value.
		* @param field - field the operation's value carries.
		* @param read - entry reader for that field's element type.
		* @returns the narrowed entries, in wire order.
		*/
		function arrayField(value, field, read) {
			const listed = readField(value, field);
			if (!Array.isArray(listed)) throw invalidResponse(field);
			return listed.map((entry) => read(entry));
		}
		/**
		* Build the page's wiki client over the page's own fetch.
		* @param doFetch - page fetch, injectable for tests.
		* @returns typed wiki operations.
		*/
		function createWikiApi(doFetch = (input, init) => globalThis.fetch(input, init)) {
			/** Read one envelope, turning its failure arm into a request error. */
			const readEnvelope = async (response, endpoint) => {
				const body = await response.json();
				if (!isEnvelope(body)) throw invalidResponse(endpoint);
				if (!body.ok) throw new WikiRequestError(body.error.code, body.error.message);
				return body.value;
			};
			/** Send one JSON request and return its envelope value. */
			const postJson = async (endpoint, body, signal) => {
				return await readEnvelope(await doFetch(`${BASE}/${endpoint}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					...signal === void 0 ? {} : { signal }
				}), endpoint);
			};
			return {
				async list(signal) {
					return { pages: arrayField(await postJson("list", {}, signal), "pages", readSummary) };
				},
				async read(request, signal) {
					const value = await postJson("read", request, signal);
					return {
						page: readPayload(readField(value, "page")),
						links: stringListField(value, "links"),
						backlinks: stringListField(value, "backlinks"),
						sources: stringListField(value, "sources")
					};
				},
				async search(request, signal) {
					return { hits: arrayField(await postJson("search", request, signal), "hits", readHit) };
				},
				async save(request, signal) {
					return { page: readPayload(readField(await postJson("save", request, signal), "page")) };
				},
				async lint(signal) {
					return { report: readReport(readField(await postJson("lint", {}, signal), "report")) };
				}
			};
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** Knowledge-page interface copy. */
		/** Simplified Chinese dictionary and key source of truth. */
		const zh = {
			panel: "知识库",
			title: "知识库",
			intro: "浏览、检索并编辑知识库页面。",
			refresh: "刷新",
			newPage: "新建页面",
			searchPlaceholder: "搜索知识库",
			search: "搜索",
			searching: "正在搜索…",
			tabsLabel: "知识库视图",
			tabPage: "页面",
			tabSearch: "搜索",
			tabHealth: "健康",
			tree: "页面目录",
			filter: "筛选页面",
			filterType: "类型",
			filterStatus: "状态",
			clearFilters: "清除筛选",
			typeOverview: "总览",
			typeEntity: "实体",
			typeConcept: "概念",
			typeSource: "来源",
			typeComparison: "对比",
			typeSynthesis: "综合",
			statusCurrent: "现行",
			statusStub: "待补",
			statusSuperseded: "已取代",
			statusDisputed: "有争议",
			pagesInGroup: "{count} 页",
			treeEmpty: "没有匹配的页面",
			vaultEmpty: "知识库还没有页面",
			vaultEmptyHint: "用「新建页面」写下第一页。",
			loading: "正在读取知识库…",
			pageLoading: "正在读取页面…",
			loadFailed: "无法读取知识库：{reason}",
			pageFailed: "无法读取页面：{reason}",
			detailPlaceholder: "从左侧选择一个页面。",
			updated: "更新于",
			edit: "编辑",
			backlinks: "反向链接",
			noBacklinks: "还没有页面链接到这里",
			sources: "引用来源",
			noSources: "未引用任何来源",
			pageMissing: "知识库里没有「{target}」",
			searchTitle: "搜索结果",
			searchEmpty: "输入关键词搜索知识库",
			searchHint: "搜索标题、正文和前置数据。",
			searchNone: "没有匹配的页面",
			hitsCount: "找到 {count} 个页面",
			searchFailed: "搜索失败：{reason}",
			healthTitle: "知识库健康",
			healthIntro: "运行一次检查，看看哪些页面需要处理。",
			lint: "检查",
			linting: "正在检查…",
			lintFailed: "检查失败：{reason}",
			lintSummary: "检查了 {pages} 个页面和 {sources} 个来源",
			lintClean: "没有发现问题",
			kindOrphanPage: "孤立页面",
			kindBrokenLink: "失效链接",
			kindMissingPage: "缺失页面",
			kindUnintegratedSource: "未整合来源",
			kindMissingSource: "缺失来源",
			kindFrontmatter: "前置数据",
			kindContradiction: "矛盾",
			editorNew: "新建页面",
			editorEdit: "编辑页面",
			fieldPath: "路径",
			fieldPathPlaceholder: "例如 concepts/attention.md",
			fieldTitle: "标题",
			fieldTitlePlaceholder: "页面标题",
			fieldType: "类型",
			fieldStatus: "状态",
			fieldTags: "标签",
			fieldTagsPlaceholder: "用逗号分隔",
			fieldSources: "来源",
			fieldSourcesPlaceholder: "raw/ 下的相对路径，用逗号分隔",
			fieldAliases: "别名",
			fieldAliasesPlaceholder: "用逗号分隔",
			fieldContradicts: "矛盾页面",
			fieldContradictsPlaceholder: "用逗号分隔",
			fieldConfidence: "置信度",
			fieldConfidencePlaceholder: "0 到 1，留空表示未说明",
			fieldUpdated: "更新日期",
			fieldBody: "正文",
			fieldBodyPlaceholder: "用 Markdown 编写；[[页面名]] 建立页面链接。",
			save: "保存",
			saving: "正在保存…",
			cancel: "取消",
			saved: "已保存 {path}",
			saveFailed: "保存失败：{reason}",
			conflict: "这一页在别处被改过，本次保存没有写入。你的内容还在，请对比后重试。",
			invalidPath: "请填写页面路径",
			invalidTitle: "请填写标题",
			dismiss: "知道了",
			codeCopy: "复制",
			codeCopied: "已复制",
			codeBlock: "代码",
			codeWrap: "自动换行",
			codeUnwrap: "保持列宽",
			footnotes: "脚注"
		};
		/** English dictionary checked complete against the Chinese key set. */
		const en = {
			panel: "Knowledge",
			title: "Knowledge",
			intro: "Browse, search, and edit the vault pages.",
			refresh: "Refresh",
			newPage: "New page",
			searchPlaceholder: "Search the vault",
			search: "Search",
			searching: "Searching…",
			tabsLabel: "Knowledge views",
			tabPage: "Page",
			tabSearch: "Search",
			tabHealth: "Health",
			tree: "Page catalog",
			filter: "Filter pages",
			filterType: "Type",
			filterStatus: "Status",
			clearFilters: "Clear filters",
			typeOverview: "Overview",
			typeEntity: "Entity",
			typeConcept: "Concept",
			typeSource: "Source",
			typeComparison: "Comparison",
			typeSynthesis: "Synthesis",
			statusCurrent: "Current",
			statusStub: "Stub",
			statusSuperseded: "Superseded",
			statusDisputed: "Disputed",
			pagesInGroup: "{count} pages",
			treeEmpty: "No page matches",
			vaultEmpty: "The vault has no pages yet",
			vaultEmptyHint: "Write the first one with \"New page\".",
			loading: "Reading the vault…",
			pageLoading: "Reading the page…",
			loadFailed: "Could not read the vault: {reason}",
			pageFailed: "Could not read the page: {reason}",
			detailPlaceholder: "Select a page on the left.",
			updated: "Updated",
			edit: "Edit",
			backlinks: "Backlinks",
			noBacklinks: "No page links here yet",
			sources: "Sources",
			noSources: "No source cited",
			pageMissing: "The vault has no page named \"{target}\"",
			searchTitle: "Search results",
			searchEmpty: "Type a query to search the vault",
			searchHint: "Searches titles, body text, and frontmatter.",
			searchNone: "No page matches the query",
			hitsCount: "{count} pages found",
			searchFailed: "Could not search: {reason}",
			healthTitle: "Vault health",
			healthIntro: "Run a check to see which pages need work.",
			lint: "Check",
			linting: "Checking…",
			lintFailed: "The check failed: {reason}",
			lintSummary: "Checked {pages} pages and {sources} sources",
			lintClean: "No problem found",
			kindOrphanPage: "Orphan page",
			kindBrokenLink: "Broken link",
			kindMissingPage: "Missing page",
			kindUnintegratedSource: "Unintegrated source",
			kindMissingSource: "Missing source",
			kindFrontmatter: "Frontmatter",
			kindContradiction: "Contradiction",
			editorNew: "New page",
			editorEdit: "Edit page",
			fieldPath: "Path",
			fieldPathPlaceholder: "For example concepts/attention.md",
			fieldTitle: "Title",
			fieldTitlePlaceholder: "Page title",
			fieldType: "Type",
			fieldStatus: "Status",
			fieldTags: "Tags",
			fieldTagsPlaceholder: "Separate with commas",
			fieldSources: "Sources",
			fieldSourcesPlaceholder: "Paths under raw/, separated with commas",
			fieldAliases: "Aliases",
			fieldAliasesPlaceholder: "Separate with commas",
			fieldContradicts: "Contradicts",
			fieldContradictsPlaceholder: "Separate with commas",
			fieldConfidence: "Confidence",
			fieldConfidencePlaceholder: "0 to 1; blank when unstated",
			fieldUpdated: "Updated",
			fieldBody: "Body",
			fieldBodyPlaceholder: "Write Markdown; [[page name]] links a page.",
			save: "Save",
			saving: "Saving…",
			cancel: "Cancel",
			saved: "Saved {path}",
			saveFailed: "Could not save: {reason}",
			conflict: "This page changed elsewhere, so nothing was written. Your text is kept; compare and try again.",
			invalidPath: "Enter a page path",
			invalidTitle: "Enter a title",
			dismiss: "Dismiss",
			codeCopy: "Copy",
			codeCopied: "Copied",
			codeBlock: "Code",
			codeWrap: "Wrap lines",
			codeUnwrap: "Keep columns",
			footnotes: "Footnotes"
		};
		//#endregion
		//#region \0dsh-css:C:\Users\chenfei\Documents\GitHub\prism-agent\.worktrees\prism-wiki\packages\prism\prism-wiki\src\client\WikiPage.module.css.mjs
		const css = ".Nl52LG_page{box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);flex-direction:column;gap:18px;padding:28px clamp(20px,3vw,40px) 24px;display:flex}.Nl52LG_head{justify-content:space-between;align-items:flex-start;gap:16px;display:flex}[data-platform=darwin] .Nl52LG_head{padding-top:var(--dsh-frame-top-clearance,0px)}.Nl52LG_headText{min-width:0}.Nl52LG_title{margin:0;font-size:20px;font-weight:500;line-height:28px}.Nl52LG_intro{color:var(--dsw-alias-label-secondary);margin:4px 0 0;font-size:13px;line-height:20px}.Nl52LG_toolbar{align-items:center;gap:10px;display:flex}.Nl52LG_search{width:200px}.Nl52LG_failure,.Nl52LG_conflict{background:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:center;gap:12px;margin:0;padding:8px 12px;font-size:13px;line-height:20px;display:flex}.Nl52LG_dismiss{color:inherit;font:inherit;cursor:pointer;background:0 0;border:0;flex:none;padding:0;text-decoration:underline}.Nl52LG_body{flex:1;grid-template-columns:minmax(240px,320px) minmax(0,1fr);gap:20px;min-height:0;display:grid}.Nl52LG_tree{border-right:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:10px;min-height:0;padding:0 8px 0 0;display:flex;overflow:auto}.Nl52LG_filter{width:100%}.Nl52LG_filters{flex-direction:column;gap:8px;display:flex}.Nl52LG_filterGroup{flex-direction:column;gap:4px;display:flex}.Nl52LG_filterLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.Nl52LG_pills{flex-wrap:wrap;gap:6px;display:flex}.Nl52LG_groupCount{color:var(--dsw-alias-label-tertiary);margin-left:auto;padding-left:8px;font-size:11px;line-height:16px}.Nl52LG_rows{flex-direction:column;gap:2px;margin:0;padding:2px 0 6px 20px;list-style:none;display:flex}.Nl52LG_row{width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:8px;padding:6px 8px;display:flex}.Nl52LG_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.Nl52LG_row[data-selected]{background:var(--dsw-alias-interactive-bg-active)}.Nl52LG_rowText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex}.Nl52LG_rowTitle{white-space:nowrap;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:20px;overflow:hidden}.Nl52LG_rowPath{max-width:100%;font-size:11px;line-height:16px}.Nl52LG_detail{flex-direction:column;gap:12px;min-height:0;display:flex}.Nl52LG_panel{flex-direction:column;flex:1;gap:12px;min-height:0;padding-right:4px;display:flex;overflow:auto}.Nl52LG_placeholder{color:var(--dsw-alias-label-tertiary);align-items:center;gap:8px;margin:0;font-size:13px;line-height:20px;display:flex}.Nl52LG_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.Nl52LG_columns{flex-direction:column;gap:10px;display:flex}.Nl52LG_sectionTitle{color:var(--dsw-alias-label-secondary);align-items:center;gap:8px;margin:0;font-size:13px;font-weight:500;line-height:20px;display:flex}.Nl52LG_article{flex-direction:column;gap:12px;max-width:820px;display:flex}.Nl52LG_articleHead{align-items:center;gap:10px;display:flex}.Nl52LG_articleTitle{margin:0;font-size:16px;font-weight:500;line-height:24px}.Nl52LG_metaLine{align-items:center;gap:6px;min-width:0;font-size:11px;line-height:16px;display:flex}.Nl52LG_metaLabel{color:var(--dsw-alias-label-tertiary)}.Nl52LG_metaValue{color:var(--dsw-alias-label-secondary)}.Nl52LG_metaPath{min-width:0;color:var(--dsw-alias-label-tertiary);margin-left:4px}.Nl52LG_markdown{min-width:0}.Nl52LG_section{border-top:.5px solid var(--dsw-alias-border-l1);flex-direction:column;gap:6px;padding-top:8px;display:flex}.Nl52LG_chips{flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none;display:flex}.Nl52LG_chip{border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:0 0;border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px}.Nl52LG_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.Nl52LG_chipText{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 8px;font-size:12px;line-height:18px;display:inline-block}.Nl52LG_hits,.Nl52LG_findings{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.Nl52LG_hit,.Nl52LG_finding{border:.5px solid var(--dsw-alias-border-l1);width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border-radius:8px;gap:8px;padding:8px 10px;display:flex}.Nl52LG_hit{flex-direction:column}.Nl52LG_hit:hover,.Nl52LG_finding:hover{background:var(--dsw-alias-interactive-bg-hover)}.Nl52LG_hit:disabled,.Nl52LG_finding:disabled{cursor:default}.Nl52LG_hitHead{align-items:center;gap:8px;min-width:0;display:flex}.Nl52LG_hitPath{max-width:100%;font-size:11px;line-height:16px}.Nl52LG_hitExcerpt{color:var(--dsw-alias-label-secondary);word-break:break-word;font-size:12px;line-height:18px}.Nl52LG_hitMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.Nl52LG_healthHead{justify-content:space-between;align-items:center;gap:12px;display:flex}.Nl52LG_finding{align-items:center}.Nl52LG_findingDetail{word-break:break-word;flex:1;min-width:0;font-size:13px;line-height:20px}.Nl52LG_findingPath{max-width:40%;font-size:11px;line-height:16px}.Nl52LG_editor{flex-direction:column;gap:10px;max-width:820px;display:flex}.Nl52LG_fieldRow{grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;display:grid}.Nl52LG_field{flex-direction:column;gap:6px;min-width:0;font-size:13px;line-height:20px;display:flex}.Nl52LG_fieldLabel{color:var(--dsw-alias-label-secondary)}.Nl52LG_select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:100%;height:32px;color:inherit;font:inherit;border-radius:8px;padding:0 8px;font-size:13px}.Nl52LG_textarea{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:100%;min-height:260px;color:inherit;font:inherit;resize:vertical;border-radius:8px;padding:8px 10px;font-size:13px;line-height:20px}.Nl52LG_actions{gap:8px;display:flex}";
		const tagId = "@prism-ai/prism-wiki/WikiPage.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@prism-ai/prism-wiki";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var WikiPage_module_css_default = {
			"actions": "Nl52LG_actions",
			"article": "Nl52LG_article",
			"articleHead": "Nl52LG_articleHead",
			"articleTitle": "Nl52LG_articleTitle",
			"body": "Nl52LG_body",
			"chip": "Nl52LG_chip",
			"chipText": "Nl52LG_chipText",
			"chips": "Nl52LG_chips",
			"columns": "Nl52LG_columns",
			"conflict": "Nl52LG_conflict",
			"detail": "Nl52LG_detail",
			"dismiss": "Nl52LG_dismiss",
			"editor": "Nl52LG_editor",
			"failure": "Nl52LG_failure",
			"field": "Nl52LG_field",
			"fieldLabel": "Nl52LG_fieldLabel",
			"fieldRow": "Nl52LG_fieldRow",
			"filter": "Nl52LG_filter",
			"filterGroup": "Nl52LG_filterGroup",
			"filterLabel": "Nl52LG_filterLabel",
			"filters": "Nl52LG_filters",
			"finding": "Nl52LG_finding",
			"findingDetail": "Nl52LG_findingDetail",
			"findingPath": "Nl52LG_findingPath",
			"findings": "Nl52LG_findings",
			"groupCount": "Nl52LG_groupCount",
			"head": "Nl52LG_head",
			"headText": "Nl52LG_headText",
			"healthHead": "Nl52LG_healthHead",
			"hint": "Nl52LG_hint",
			"hit": "Nl52LG_hit",
			"hitExcerpt": "Nl52LG_hitExcerpt",
			"hitHead": "Nl52LG_hitHead",
			"hitMeta": "Nl52LG_hitMeta",
			"hitPath": "Nl52LG_hitPath",
			"hits": "Nl52LG_hits",
			"intro": "Nl52LG_intro",
			"markdown": "Nl52LG_markdown",
			"metaLabel": "Nl52LG_metaLabel",
			"metaLine": "Nl52LG_metaLine",
			"metaPath": "Nl52LG_metaPath",
			"metaValue": "Nl52LG_metaValue",
			"page": "Nl52LG_page",
			"panel": "Nl52LG_panel",
			"pills": "Nl52LG_pills",
			"placeholder": "Nl52LG_placeholder",
			"row": "Nl52LG_row",
			"rowPath": "Nl52LG_rowPath",
			"rowText": "Nl52LG_rowText",
			"rowTitle": "Nl52LG_rowTitle",
			"rows": "Nl52LG_rows",
			"search": "Nl52LG_search",
			"section": "Nl52LG_section",
			"sectionTitle": "Nl52LG_sectionTitle",
			"select": "Nl52LG_select",
			"textarea": "Nl52LG_textarea",
			"title": "Nl52LG_title",
			"toolbar": "Nl52LG_toolbar",
			"tree": "Nl52LG_tree"
		};
		//#endregion
		//#region lib/types/client/WikiPage.js
		/**
		* The Knowledge page over one markdown vault: the type-grouped vault tree with
		* its filters, the selected page rendered through `MarkdownText` with its
		* clickable wikilinks and its backlinks, ranked search hits, the frontmatter
		* editor, and the vault health report. Every read and write crosses the
		* injected wiki face, so the component reaches no context and owns no
		* subscription machinery.
		* @module @prism-ai/prism-wiki/src/client/WikiPage
		*/
		/** Every page kind, in catalog order. */
		const PAGE_TYPES = [
			"overview",
			"entity",
			"concept",
			"source",
			"comparison",
			"synthesis"
		];
		/** Every page state, in dispute order. */
		const PAGE_STATUSES = [
			"current",
			"stub",
			"superseded",
			"disputed"
		];
		/** Locale key of one page kind's label. */
		const TYPE_KEYS = {
			overview: "typeOverview",
			entity: "typeEntity",
			concept: "typeConcept",
			source: "typeSource",
			comparison: "typeComparison",
			synthesis: "typeSynthesis"
		};
		/** Locale key of one page state's label. */
		const STATUS_KEYS = {
			current: "statusCurrent",
			stub: "statusStub",
			superseded: "statusSuperseded",
			disputed: "statusDisputed"
		};
		/** Locale key of one lint-finding class's label. */
		const KIND_KEYS = {
			"orphan-page": "kindOrphanPage",
			"broken-link": "kindBrokenLink",
			"missing-page": "kindMissingPage",
			"unintegrated-source": "kindUnintegratedSource",
			"missing-source": "kindMissingSource",
			"frontmatter": "kindFrontmatter",
			"contradiction": "kindContradiction"
		};
		/** Hits one search asks for; the host's deployment cap still applies. */
		const SEARCH_LIMIT = 30;
		/** Operator-readable text for one thrown value. */
		function reasonOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/** Split one comma-separated frontmatter field, dropping blank entries. */
		function splitList(input) {
			return input.split(/[,，]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
		}
		/** Read the stated certainty field; blank means unstated. */
		function parseConfidence(input) {
			const trimmed = input.trim();
			if (trimmed.length === 0) return null;
			const value = Number(trimmed);
			return Number.isFinite(value) ? value : null;
		}
		/** The wire frontmatter one draft describes. */
		function frontmatterOf(draft) {
			return {
				title: draft.title.trim(),
				type: draft.type,
				tags: splitList(draft.tags),
				updated: draft.updated.trim(),
				status: draft.status,
				sources: splitList(draft.sources),
				aliases: splitList(draft.aliases),
				confidence: parseConfidence(draft.confidence),
				contradicts: splitList(draft.contradicts)
			};
		}
		/** One read page as an editable draft. */
		function draftOf(view) {
			const { frontmatter, path, body, revision } = view.page;
			return {
				path,
				title: frontmatter.title,
				type: frontmatter.type,
				status: frontmatter.status,
				tags: frontmatter.tags.join(", "),
				sources: frontmatter.sources.join(", "),
				aliases: frontmatter.aliases.join(", "),
				contradicts: frontmatter.contradicts.join(", "),
				confidence: frontmatter.confidence === null ? "" : String(frontmatter.confidence),
				updated: frontmatter.updated,
				body,
				revision,
				conflict: null
			};
		}
		/** One empty draft for a page that does not exist yet. */
		function emptyDraft(type, updated) {
			return {
				path: "",
				title: "",
				type,
				status: "stub",
				tags: "",
				sources: "",
				aliases: "",
				contradicts: "",
				confidence: "",
				updated,
				body: "",
				revision: null,
				conflict: null
			};
		}
		/** Today as the `YYYY-MM-DD` the vault's frontmatter carries. */
		function todayText() {
			return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
		}
		/** One page kind from a form control's value, keeping the current kind for an unknown value. */
		function pageTypeOf(value, fallback) {
			return PAGE_TYPES.find((type) => type === value) ?? fallback;
		}
		/** One page state from a form control's value, keeping the current state for an unknown value. */
		function statusOf(value, fallback) {
			return PAGE_STATUSES.find((status) => status === value) ?? fallback;
		}
		/** The tag tint one page state renders with. */
		function statusTone(status) {
			if (status === "current") return "success";
			if (status === "disputed") return "warning";
			return status === "stub" ? "info" : "neutral";
		}
		/** The tag tint one lint-finding class renders with. */
		function kindTone(kind) {
			if (kind === "broken-link" || kind === "missing-page") return "danger";
			if (kind === "frontmatter") return "neutral";
			return kind === "unintegrated-source" ? "info" : "warning";
		}
		/** A wiki path without its `.md` suffix. */
		function stripMarkdownSuffix(path) {
			const trimmed = path.toLocaleLowerCase();
			return trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
		}
		/**
		* The vault path one wikilink name addresses, so a link written the Obsidian
		* way (`[[Attention]]`) reaches the page its author meant.
		* @param target - the link target as written in the body.
		* @param pages - every page in the vault.
		* @returns the stored path, or undefined when no page answers to that name.
		*/
		function resolvePagePath(target, pages) {
			const needle = target.trim().toLocaleLowerCase();
			if (needle.length === 0) return void 0;
			const bare = stripMarkdownSuffix(needle);
			return pages.find((entry) => {
				const path = entry.path.toLocaleLowerCase();
				const entryBare = stripMarkdownSuffix(entry.path);
				const name = entryBare.slice(entryBare.lastIndexOf("/") + 1);
				const title = entry.title.toLocaleLowerCase();
				return path === needle || entryBare === bare || name === bare || title === bare || title === needle;
			})?.path;
		}
		/**
		* Percent-encode one wikilink target into a Markdown destination the renderer's
		* file delegate decodes back verbatim.
		* @param target - the target as written, with any heading or block anchor.
		* @returns the local `.md` destination.
		*/
		function wikilinkDestination(target) {
			const trimmed = (target.split(/[#^]/u)[0] ?? "").trim();
			return (trimmed.toLocaleLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`).split("/").map((segment) => encodeURIComponent(segment)).join("/");
		}
		/** One link text with the characters that would end it escaped. */
		function escapeLinkText(text) {
			return text.replace(/([\\[\]])/gu, "\\$1");
		}
		/** The fence marker opening a fenced code block on one line, or null. */
		function fenceOpening(line) {
			const match = /^(`{3,}|~{3,})/u.exec(line.trimStart());
			return match === null ? null : match[1] ?? null;
		}
		/** Whether one line closes the fence the given marker opened. */
		function fenceClosing(line, marker) {
			const closing = fenceOpening(line);
			return closing !== null && closing.charAt(0) === marker.charAt(0) && closing.length >= marker.length;
		}
		/** The index of the next backtick run of exactly `width`, or -1. */
		function backtickRun(body, from, width) {
			let index = from;
			while (index < body.length) {
				if (body.charAt(index) !== "`") {
					index += 1;
					continue;
				}
				let run = index;
				while (body.charAt(run) === "`") run += 1;
				if (run - index === width) return index;
				index = run;
			}
			return -1;
		}
		/** One `[[...]]` body as a local Markdown link, keeping its written label. */
		function wikilinkMarkdown(inner) {
			const bar = inner.indexOf("|");
			const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
			const label = (bar < 0 ? inner : inner.slice(bar + 1)).trim();
			if (target.length === 0) return `[[${inner}]]`;
			return `[${escapeLinkText(label.length === 0 ? target : label)}](${wikilinkDestination(target)})`;
		}
		/**
		* Rewrite the body's `[[wikilinks]]` into local Markdown links, so the shared
		* renderer draws them and its file delegate receives the click. Fenced code
		* blocks and inline code spans are copied verbatim, so a wikilink written
		* inside code stays literal.
		* @param body - the page body as stored.
		* @returns the body with every wikilink replaced by a local Markdown link.
		*/
		function rewriteWikilinks(body) {
			const out = [];
			let index = 0;
			let fence = null;
			while (index < body.length) {
				const stop = body.indexOf("\n", index);
				const line = stop < 0 ? body.slice(index) : body.slice(index, stop + 1);
				if (fence !== null) {
					out.push(line);
					index += line.length;
					if (fenceClosing(line, fence)) fence = null;
					continue;
				}
				if (index === 0 || body.charAt(index - 1) === "\n") {
					const opening = fenceOpening(line);
					if (opening !== null) {
						out.push(line);
						index += line.length;
						fence = opening;
						continue;
					}
				}
				const character = body.charAt(index);
				if (character === "`") {
					let run = index;
					while (body.charAt(run) === "`") run += 1;
					const close = backtickRun(body, run, run - index);
					const after = close < 0 ? run : close + (run - index);
					out.push(body.slice(index, after));
					index = after;
					continue;
				}
				const close = character === "[" && body.charAt(index + 1) === "[" ? body.indexOf("]]", index + 2) : -1;
				if (close >= 0) {
					out.push(wikilinkMarkdown(body.slice(index + 2, close)));
					index = close + 2;
					continue;
				}
				out.push(character);
				index += 1;
			}
			return out.join("");
		}
		/** Keep the pages one tree filter matches, in catalog order. */
		function matchesFilter(page, needle, type, status) {
			if (type !== null && page.type !== type) return false;
			if (status !== null && page.status !== status) return false;
			if (needle.length === 0) return true;
			return page.title.toLocaleLowerCase().includes(needle) || page.path.toLocaleLowerCase().includes(needle);
		}
		/** Group the given pages by kind, in catalog order, dropping empty groups. */
		function groupPages(pages) {
			const groups = [];
			for (const type of PAGE_TYPES) {
				const members = pages.filter((page) => page.type === type);
				if (members.length > 0) groups.push({
					type,
					pages: members
				});
			}
			return groups;
		}
		/**
		* Render the Knowledge page.
		* @param props - the keyed main panel's standard seats, this namespace's translator, and the wiki face.
		* @returns the page element tree.
		*/
		function WikiPage(props) {
			const { t, list, read, search, save, lint, notify } = props;
			const [pages, setPages] = (0, react.useState)([]);
			const [listState, setListState] = (0, react.useState)("loading");
			const [filter, setFilter] = (0, react.useState)("");
			const [typeFilter, setTypeFilter] = (0, react.useState)(null);
			const [statusFilter, setStatusFilter] = (0, react.useState)(null);
			const [collapsed, setCollapsed] = (0, react.useState)([]);
			const [selected, setSelected] = (0, react.useState)(null);
			const [page, setPage] = (0, react.useState)(null);
			const [pageState, setPageState] = (0, react.useState)("idle");
			const [tab, setTab] = (0, react.useState)("page");
			const [failure, setFailure] = (0, react.useState)(null);
			const [draft, setDraft] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [query, setQuery] = (0, react.useState)("");
			const [searching, setSearching] = (0, react.useState)(false);
			const [hits, setHits] = (0, react.useState)(null);
			const [lintState, setLintState] = (0, react.useState)("idle");
			const [report, setReport] = (0, react.useState)(null);
			/** Re-read the whole vault tree. */
			const refresh = (0, react.useCallback)(async () => {
				try {
					setPages((await list()).pages);
					setListState("ready");
				} catch (error) {
					setListState("ready");
					setFailure(t("loadFailed", { reason: reasonOf(error) }));
				}
			}, [list, t]);
			(0, react.useEffect)(() => {
				refresh();
			}, [refresh]);
			/** Open one vault page in the center column. */
			const openPage = (0, react.useCallback)(async (path) => {
				setSelected(path);
				setTab("page");
				setDraft(null);
				setPage(null);
				setPageState("loading");
				setFailure(null);
				try {
					setPage(await read(path));
				} catch (error) {
					setFailure(t("pageFailed", { reason: reasonOf(error) }));
				} finally {
					setPageState("ready");
				}
			}, [read, t]);
			/** Follow one wikilink, or report the name no page answers to. */
			const openTarget = (0, react.useCallback)((target) => {
				if (target === null) return;
				const resolved = resolvePagePath(target, pages);
				if (resolved === void 0) {
					setFailure(t("pageMissing", { target }));
					return;
				}
				openPage(resolved);
			}, [
				openPage,
				pages,
				t
			]);
			const openFile = (0, react.useCallback)((path) => {
				openTarget(path);
			}, [openTarget]);
			/** Rank the pages the current query matches. */
			const runSearch = (0, react.useCallback)(async () => {
				setTab("search");
				setSearching(true);
				setFailure(null);
				try {
					setHits((await search({
						query: query.trim(),
						limit: SEARCH_LIMIT
					})).hits);
				} catch (error) {
					setFailure(t("searchFailed", { reason: reasonOf(error) }));
				} finally {
					setSearching(false);
				}
			}, [
				query,
				search,
				t
			]);
			/** Run the vault health pass. */
			const runLint = (0, react.useCallback)(async () => {
				setLintState("loading");
				setFailure(null);
				try {
					setReport((await lint()).report);
				} catch (error) {
					setFailure(t("lintFailed", { reason: reasonOf(error) }));
				} finally {
					setLintState("ready");
				}
			}, [lint, t]);
			(0, react.useEffect)(() => {
				if (tab !== "health" || lintState !== "idle") return;
				runLint();
			}, [
				lintState,
				runLint,
				tab
			]);
			/** Update the open draft through its latest value. */
			const patchDraft = (0, react.useCallback)((patch) => {
				setDraft((current) => current === null ? current : patch(current));
			}, []);
			/** Toggle one type group of the vault tree. */
			const toggleGroup = (0, react.useCallback)((type) => {
				setCollapsed((current) => current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type]);
			}, []);
			/** Store the open draft, echoing the revision it loaded. */
			const onSave = (0, react.useCallback)(async () => {
				if (draft === null) return;
				const path = draft.path.trim();
				if (path.length === 0) {
					setFailure(t("invalidPath"));
					return;
				}
				if (draft.title.trim().length === 0) {
					setFailure(t("invalidTitle"));
					return;
				}
				setSaving(true);
				setFailure(null);
				try {
					const stored = await save({
						path,
						frontmatter: frontmatterOf(draft),
						body: draft.body,
						...draft.revision === null ? {} : { expectedRevision: draft.revision }
					});
					setDraft(null);
					await refresh();
					await openPage(stored.page.path);
					notify(t("saved", { path }), "success");
				} catch (error) {
					if (error instanceof WikiRequestError && error.code === "prism-wiki/revision-conflict") {
						const conflict = t("conflict");
						patchDraft((current) => ({
							...current,
							conflict
						}));
					} else notify(t("saveFailed", { reason: reasonOf(error) }), "warning");
				} finally {
					setSaving(false);
				}
			}, [
				draft,
				notify,
				openPage,
				patchDraft,
				refresh,
				save,
				t
			]);
			const markdownLabels = (0, react.useMemo)(() => ({
				code: {
					copyLabel: t("codeCopy"),
					copiedLabel: t("codeCopied"),
					toolbarLabels: {
						codeLabel: t("codeBlock"),
						wrapLabel: t("codeWrap"),
						unwrapLabel: t("codeUnwrap")
					}
				},
				footnotes: t("footnotes")
			}), [t]);
			const visible = (0, react.useMemo)(() => {
				const needle = filter.trim().toLocaleLowerCase();
				return pages.filter((entry) => matchesFilter(entry, needle, typeFilter, statusFilter));
			}, [
				filter,
				pages,
				statusFilter,
				typeFilter
			]);
			const groups = (0, react.useMemo)(() => groupPages(visible), [visible]);
			const body = page === null ? "" : page.page.body;
			const markdown = (0, react.useMemo)(() => rewriteWikilinks(body), [body]);
			const frontmatter = page === null ? null : page.page.frontmatter;
			const findings = report === null ? [] : report.findings;
			const filtered = typeFilter !== null || statusFilter !== null;
			return (0, react_jsx_runtime.jsxs)("section", {
				className: WikiPage_module_css_default.page,
				"aria-busy": listState === "loading" || pageState === "loading",
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: WikiPage_module_css_default.head,
						children: [(0, react_jsx_runtime.jsxs)("div", {
							className: WikiPage_module_css_default.headText,
							children: [(0, react_jsx_runtime.jsx)("h1", {
								className: WikiPage_module_css_default.title,
								children: t("title")
							}), (0, react_jsx_runtime.jsx)("p", {
								className: WikiPage_module_css_default.intro,
								children: t("intro")
							})]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: WikiPage_module_css_default.toolbar,
							children: [
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									type: "search",
									className: WikiPage_module_css_default.search,
									placeholder: t("searchPlaceholder"),
									"aria-label": t("searchPlaceholder"),
									value: query,
									onChange: (event) => {
										setQuery(event.target.value);
									},
									onKeyDown: (event) => {
										if (event.key !== "Enter") return;
										event.preventDefault();
										runSearch();
									}
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									disabled: searching,
									onClick: () => {
										runSearch();
									},
									children: searching ? t("searching") : t("search")
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									onClick: () => {
										refresh();
									},
									children: t("refresh")
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									onClick: () => {
										setTab("page");
										setDraft(emptyDraft("concept", todayText()));
									},
									children: t("newPage")
								})
							]
						})]
					}),
					failure !== null && (0, react_jsx_runtime.jsxs)("p", {
						className: WikiPage_module_css_default.failure,
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("span", { children: failure }), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: WikiPage_module_css_default.dismiss,
							onClick: () => {
								setFailure(null);
							},
							children: t("dismiss")
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: WikiPage_module_css_default.body,
						children: [(0, react_jsx_runtime.jsxs)("nav", {
							className: WikiPage_module_css_default.tree,
							"aria-label": t("tree"),
							children: [
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									type: "search",
									className: WikiPage_module_css_default.filter,
									placeholder: t("filter"),
									"aria-label": t("filter"),
									value: filter,
									onChange: (event) => {
										setFilter(event.target.value);
									}
								}),
								(0, react_jsx_runtime.jsxs)("div", {
									className: WikiPage_module_css_default.filters,
									children: [
										(0, react_jsx_runtime.jsxs)("div", {
											className: WikiPage_module_css_default.filterGroup,
											children: [(0, react_jsx_runtime.jsx)("span", {
												className: WikiPage_module_css_default.filterLabel,
												children: t("filterType")
											}), (0, react_jsx_runtime.jsx)("div", {
												className: WikiPage_module_css_default.pills,
												children: PAGE_TYPES.map((type) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
													active: typeFilter === type,
													onClick: () => {
														setTypeFilter((current) => current === type ? null : type);
													},
													children: t(TYPE_KEYS[type])
												}, type))
											})]
										}),
										(0, react_jsx_runtime.jsxs)("div", {
											className: WikiPage_module_css_default.filterGroup,
											children: [(0, react_jsx_runtime.jsx)("span", {
												className: WikiPage_module_css_default.filterLabel,
												children: t("filterStatus")
											}), (0, react_jsx_runtime.jsx)("div", {
												className: WikiPage_module_css_default.pills,
												children: PAGE_STATUSES.map((status) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
													active: statusFilter === status,
													onClick: () => {
														setStatusFilter((current) => current === status ? null : status);
													},
													children: t(STATUS_KEYS[status])
												}, status))
											})]
										}),
										filtered && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											onClick: () => {
												setTypeFilter(null);
												setStatusFilter(null);
											},
											children: t("clearFilters")
										})
									]
								}),
								listState === "loading" && (0, react_jsx_runtime.jsxs)("p", {
									className: WikiPage_module_css_default.placeholder,
									children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }), (0, react_jsx_runtime.jsx)("span", { children: t("loading") })]
								}),
								listState === "ready" && pages.length === 0 && (0, react_jsx_runtime.jsx)("p", {
									className: WikiPage_module_css_default.placeholder,
									children: t("vaultEmpty")
								}),
								listState === "ready" && pages.length === 0 && (0, react_jsx_runtime.jsx)("p", {
									className: WikiPage_module_css_default.hint,
									children: t("vaultEmptyHint")
								}),
								listState === "ready" && pages.length > 0 && visible.length === 0 && (0, react_jsx_runtime.jsx)("p", {
									className: WikiPage_module_css_default.placeholder,
									children: t("treeEmpty")
								}),
								groups.map((group) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
									icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
										kind: "folder",
										size: 14
									}),
									title: t(TYPE_KEYS[group.type]),
									open: !collapsed.includes(group.type),
									expandable: true,
									onToggle: () => {
										toggleGroup(group.type);
									},
									collapsedContent: (0, react_jsx_runtime.jsx)("span", {
										className: WikiPage_module_css_default.groupCount,
										children: t("pagesInGroup", { count: String(group.pages.length) })
									}),
									children: (0, react_jsx_runtime.jsx)("ul", {
										className: WikiPage_module_css_default.rows,
										children: group.pages.map((entry) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: WikiPage_module_css_default.row,
											"data-selected": selected === entry.path || void 0,
											"aria-current": selected === entry.path ? "true" : void 0,
											onClick: () => {
												openPage(entry.path);
											},
											children: [
												(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
													path: entry.path,
													size: 14
												}),
												(0, react_jsx_runtime.jsxs)("span", {
													className: WikiPage_module_css_default.rowText,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.rowTitle,
														children: entry.title
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.PathLabel, {
														path: entry.path,
														className: WikiPage_module_css_default.rowPath
													})]
												}),
												(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
													tone: statusTone(entry.status),
													children: t(STATUS_KEYS[entry.status])
												})
											]
										}) }, entry.path))
									})
								}, group.type))
							]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: WikiPage_module_css_default.detail,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SegmentedTabs, {
								label: t("tabsLabel"),
								value: tab,
								onChange: setTab,
								items: [
									{
										value: "page",
										label: t("tabPage"),
										id: "wiki-tab-page",
										panelId: "wiki-panel-page"
									},
									{
										value: "search",
										label: t("tabSearch"),
										id: "wiki-tab-search",
										panelId: "wiki-panel-search"
									},
									{
										value: "health",
										label: t("tabHealth"),
										id: "wiki-tab-health",
										panelId: "wiki-panel-health"
									}
								]
							}), (0, react_jsx_runtime.jsxs)("div", {
								className: WikiPage_module_css_default.panel,
								role: "tabpanel",
								id: `wiki-panel-${tab}`,
								"aria-labelledby": `wiki-tab-${tab}`,
								children: [
									tab === "page" && draft !== null && (0, react_jsx_runtime.jsxs)("div", {
										className: WikiPage_module_css_default.editor,
										children: [
											(0, react_jsx_runtime.jsx)("h2", {
												className: WikiPage_module_css_default.sectionTitle,
												children: draft.revision === null ? t("editorNew") : t("editorEdit")
											}),
											draft.conflict !== null && (0, react_jsx_runtime.jsxs)("p", {
												className: WikiPage_module_css_default.conflict,
												role: "alert",
												children: [(0, react_jsx_runtime.jsx)("span", { children: draft.conflict }), (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: WikiPage_module_css_default.dismiss,
													onClick: () => {
														patchDraft((current) => ({
															...current,
															conflict: null
														}));
													},
													children: t("dismiss")
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.fieldRow,
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldTitle")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.title,
														placeholder: t("fieldTitlePlaceholder"),
														onChange: (event) => {
															const title = event.target.value;
															patchDraft((current) => ({
																...current,
																title
															}));
														}
													})]
												}), (0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldPath")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.path,
														placeholder: t("fieldPathPlaceholder"),
														disabled: draft.revision !== null,
														onChange: (event) => {
															const path = event.target.value;
															patchDraft((current) => ({
																...current,
																path
															}));
														}
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.fieldRow,
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldType")
													}), (0, react_jsx_runtime.jsx)("select", {
														className: WikiPage_module_css_default.select,
														value: draft.type,
														onChange: (event) => {
															const value = event.target.value;
															patchDraft((current) => ({
																...current,
																type: pageTypeOf(value, current.type)
															}));
														},
														children: PAGE_TYPES.map((type) => (0, react_jsx_runtime.jsx)("option", {
															value: type,
															children: t(TYPE_KEYS[type])
														}, type))
													})]
												}), (0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldStatus")
													}), (0, react_jsx_runtime.jsx)("select", {
														className: WikiPage_module_css_default.select,
														value: draft.status,
														onChange: (event) => {
															const value = event.target.value;
															patchDraft((current) => ({
																...current,
																status: statusOf(value, current.status)
															}));
														},
														children: PAGE_STATUSES.map((status) => (0, react_jsx_runtime.jsx)("option", {
															value: status,
															children: t(STATUS_KEYS[status])
														}, status))
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.fieldRow,
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldUpdated")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.updated,
														onChange: (event) => {
															const updated = event.target.value;
															patchDraft((current) => ({
																...current,
																updated
															}));
														}
													})]
												}), (0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldConfidence")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.confidence,
														placeholder: t("fieldConfidencePlaceholder"),
														onChange: (event) => {
															const confidence = event.target.value;
															patchDraft((current) => ({
																...current,
																confidence
															}));
														}
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: WikiPage_module_css_default.field,
												children: [(0, react_jsx_runtime.jsx)("span", {
													className: WikiPage_module_css_default.fieldLabel,
													children: t("fieldTags")
												}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
													value: draft.tags,
													placeholder: t("fieldTagsPlaceholder"),
													onChange: (event) => {
														const tags = event.target.value;
														patchDraft((current) => ({
															...current,
															tags
														}));
													}
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: WikiPage_module_css_default.field,
												children: [(0, react_jsx_runtime.jsx)("span", {
													className: WikiPage_module_css_default.fieldLabel,
													children: t("fieldSources")
												}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
													value: draft.sources,
													placeholder: t("fieldSourcesPlaceholder"),
													onChange: (event) => {
														const sources = event.target.value;
														patchDraft((current) => ({
															...current,
															sources
														}));
													}
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.fieldRow,
												children: [(0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldAliases")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.aliases,
														placeholder: t("fieldAliasesPlaceholder"),
														onChange: (event) => {
															const aliases = event.target.value;
															patchDraft((current) => ({
																...current,
																aliases
															}));
														}
													})]
												}), (0, react_jsx_runtime.jsxs)("label", {
													className: WikiPage_module_css_default.field,
													children: [(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.fieldLabel,
														children: t("fieldContradicts")
													}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
														value: draft.contradicts,
														placeholder: t("fieldContradictsPlaceholder"),
														onChange: (event) => {
															const contradicts = event.target.value;
															patchDraft((current) => ({
																...current,
																contradicts
															}));
														}
													})]
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: WikiPage_module_css_default.field,
												children: [(0, react_jsx_runtime.jsx)("span", {
													className: WikiPage_module_css_default.fieldLabel,
													children: t("fieldBody")
												}), (0, react_jsx_runtime.jsx)("textarea", {
													className: WikiPage_module_css_default.textarea,
													"aria-label": t("fieldBody"),
													placeholder: t("fieldBodyPlaceholder"),
													value: draft.body,
													onChange: (event) => {
														const next = event.target.value;
														patchDraft((current) => ({
															...current,
															body: next
														}));
													}
												})]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.actions,
												children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "primary",
													disabled: saving,
													onClick: () => {
														onSave();
													},
													children: saving ? t("saving") : t("save")
												}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "ghost",
													onClick: () => {
														setDraft(null);
													},
													children: t("cancel")
												})]
											})
										]
									}),
									tab === "page" && draft === null && pageState === "loading" && (0, react_jsx_runtime.jsxs)("p", {
										className: WikiPage_module_css_default.placeholder,
										children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }), (0, react_jsx_runtime.jsx)("span", { children: t("pageLoading") })]
									}),
									tab === "page" && draft === null && pageState !== "loading" && page === null && (0, react_jsx_runtime.jsx)("p", {
										className: WikiPage_module_css_default.placeholder,
										children: t("detailPlaceholder")
									}),
									tab === "page" && draft === null && page !== null && frontmatter !== null && (0, react_jsx_runtime.jsxs)("article", {
										className: WikiPage_module_css_default.article,
										children: [
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.articleHead,
												children: [
													(0, react_jsx_runtime.jsx)("h2", {
														className: WikiPage_module_css_default.articleTitle,
														children: frontmatter.title
													}),
													(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
														tone: "quiet",
														children: t(TYPE_KEYS[frontmatter.type])
													}),
													(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
														tone: statusTone(frontmatter.status),
														children: t(STATUS_KEYS[frontmatter.status])
													}),
													(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
														variant: "ghost",
														onClick: () => {
															setDraft(draftOf(page));
														},
														children: t("edit")
													})
												]
											}),
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.metaLine,
												children: [
													(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.metaLabel,
														children: t("updated")
													}),
													(0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.metaValue,
														children: frontmatter.updated
													}),
													(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.PathLabel, {
														path: page.page.path,
														className: WikiPage_module_css_default.metaPath
													})
												]
											}),
											frontmatter.tags.length > 0 && (0, react_jsx_runtime.jsx)("div", {
												className: WikiPage_module_css_default.pills,
												children: frontmatter.tags.map((tag) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
													tone: "outline",
													children: tag
												}, tag))
											}),
											(0, react_jsx_runtime.jsx)("div", {
												className: WikiPage_module_css_default.markdown,
												children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownDelegateProvider, {
													openFile,
													children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.MarkdownText, {
														text: markdown,
														labels: markdownLabels
													})
												})
											}),
											(0, react_jsx_runtime.jsxs)("section", {
												className: WikiPage_module_css_default.section,
												children: [(0, react_jsx_runtime.jsx)("h3", {
													className: WikiPage_module_css_default.sectionTitle,
													children: t("backlinks")
												}), page.backlinks.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
													className: WikiPage_module_css_default.placeholder,
													children: t("noBacklinks")
												}) : (0, react_jsx_runtime.jsx)("ul", {
													className: WikiPage_module_css_default.chips,
													children: page.backlinks.map((link) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: WikiPage_module_css_default.chip,
														onClick: () => {
															openPage(link);
														},
														children: link
													}) }, link))
												})]
											}),
											(0, react_jsx_runtime.jsxs)("section", {
												className: WikiPage_module_css_default.section,
												children: [(0, react_jsx_runtime.jsx)("h3", {
													className: WikiPage_module_css_default.sectionTitle,
													children: t("sources")
												}), page.sources.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
													className: WikiPage_module_css_default.placeholder,
													children: t("noSources")
												}) : (0, react_jsx_runtime.jsx)("ul", {
													className: WikiPage_module_css_default.chips,
													children: page.sources.map((source) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsx)("span", {
														className: WikiPage_module_css_default.chipText,
														children: source
													}) }, source))
												})]
											})
										]
									}),
									tab === "search" && (0, react_jsx_runtime.jsxs)("div", {
										className: WikiPage_module_css_default.columns,
										children: [
											(0, react_jsx_runtime.jsx)("h2", {
												className: WikiPage_module_css_default.sectionTitle,
												children: t("searchTitle")
											}),
											searching && (0, react_jsx_runtime.jsxs)("p", {
												className: WikiPage_module_css_default.placeholder,
												children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }), (0, react_jsx_runtime.jsx)("span", { children: t("searching") })]
											}),
											!searching && hits === null && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.placeholder,
												children: t("searchEmpty")
											}), (0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.hint,
												children: t("searchHint")
											})] }),
											!searching && hits !== null && hits.length === 0 && (0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.placeholder,
												children: t("searchNone")
											}),
											!searching && hits !== null && hits.length > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.hint,
												children: t("hitsCount", { count: String(hits.length) })
											}), (0, react_jsx_runtime.jsx)("ul", {
												className: WikiPage_module_css_default.hits,
												children: hits.map((hit) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: WikiPage_module_css_default.hit,
													onClick: () => {
														openPage(hit.path);
													},
													children: [
														(0, react_jsx_runtime.jsxs)("span", {
															className: WikiPage_module_css_default.hitHead,
															children: [
																(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.FileTypeIcon, {
																	path: hit.path,
																	size: 14
																}),
																(0, react_jsx_runtime.jsx)("span", {
																	className: WikiPage_module_css_default.rowTitle,
																	children: hit.title
																}),
																(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
																	tone: statusTone(hit.status),
																	children: t(STATUS_KEYS[hit.status])
																})
															]
														}),
														(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.PathLabel, {
															path: hit.path,
															className: WikiPage_module_css_default.hitPath
														}),
														(0, react_jsx_runtime.jsx)("span", {
															className: WikiPage_module_css_default.hitExcerpt,
															children: hit.excerpt
														}),
														(0, react_jsx_runtime.jsx)("span", {
															className: WikiPage_module_css_default.hitMeta,
															children: hit.updated
														})
													]
												}) }, hit.path))
											})] })
										]
									}),
									tab === "health" && (0, react_jsx_runtime.jsxs)("div", {
										className: WikiPage_module_css_default.columns,
										children: [
											(0, react_jsx_runtime.jsxs)("div", {
												className: WikiPage_module_css_default.healthHead,
												children: [(0, react_jsx_runtime.jsx)("h2", {
													className: WikiPage_module_css_default.sectionTitle,
													children: t("healthTitle")
												}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "outline",
													disabled: lintState === "loading",
													onClick: () => {
														runLint();
													},
													children: lintState === "loading" ? t("linting") : t("lint")
												})]
											}),
											(0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.hint,
												children: report === null ? t("healthIntro") : t("lintSummary", {
													pages: String(report.pages),
													sources: String(report.sources)
												})
											}),
											lintState === "loading" && (0, react_jsx_runtime.jsxs)("p", {
												className: WikiPage_module_css_default.placeholder,
												children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "ongoing" }), (0, react_jsx_runtime.jsx)("span", { children: t("linting") })]
											}),
											lintState === "ready" && report !== null && findings.length === 0 && (0, react_jsx_runtime.jsx)("p", {
												className: WikiPage_module_css_default.placeholder,
												children: t("lintClean")
											}),
											findings.length > 0 && (0, react_jsx_runtime.jsx)("ul", {
												className: WikiPage_module_css_default.findings,
												children: findings.map((finding, index) => {
													const target = finding.page;
													return (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("button", {
														type: "button",
														className: WikiPage_module_css_default.finding,
														disabled: target === null,
														onClick: () => {
															openTarget(target);
														},
														children: [
															(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
																tone: kindTone(finding.kind),
																children: t(KIND_KEYS[finding.kind])
															}),
															(0, react_jsx_runtime.jsx)("span", {
																className: WikiPage_module_css_default.findingDetail,
																children: finding.detail
															}),
															target !== null && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.PathLabel, {
																path: target,
																className: WikiPage_module_css_default.findingPath
															})
														]
													}) }, `${finding.kind}:${target ?? ""}:${String(index)}`);
												})
											})
										]
									})
								]
							})]
						})]
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/index.js
		/** Dictionary namespace owned by this plugin. */
		const NS = "wikiVault";
		/** The id shared by the sidebar entry and the main panel it opens. */
		const PANEL_ID = "wiki-vault";
		/** Services the three registrations need. */
		const inject = ["slots", "locale"];
		/** Full-opacity hold for a notice that has a reason to read. */
		const NOTICE_HOLD_MS = 6e3;
		/**
		* Create the notice source the page writes and the overlay host reads.
		* @returns a snapshot source carrying its own publisher.
		*/
		function createNoticeSource() {
			let current = null;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => current,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (notice) => {
					current = notice;
					for (const listener of [...listeners]) listener();
				}
			};
		}
		/**
		* Render the Knowledge glyph at the size the sidebar asks for.
		* @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
		* @returns the icon element.
		*/
		function WikiPanelIcon({ size }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": "true",
				children: [(0, react_jsx_runtime.jsx)("path", {
					d: "M8 4.4C7.15 3.7 6 3.4 3.6 3.4v8.6c2.4 0 3.55.3 4.4 1 .85-.7 2-1 4.4-1V3.4C10 3.4 8.85 3.7 8 4.4Z",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinejoin: "round"
				}), (0, react_jsx_runtime.jsx)("path", {
					d: "M8 4.4v8.6",
					stroke: "currentColor",
					strokeWidth: "1.3"
				})]
			});
		}
		/**
		* Render the notice on display in the frame-wide layer, which outlives the
		* page that reported it.
		* @param props - the notice source bound to a selector hook, and its dismissal.
		* @returns the banner on display, or null.
		*/
		function WikiNoticeHost({ useNotice, dismissNotice }) {
			const notice = useNotice((current) => current);
			if (notice === null) return null;
			if (notice.tone === "success") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: notice.text,
				tone: "success",
				onDone: dismissNotice
			}, notice.seq);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: notice.text,
				icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutlineRegular, {}),
				holdMs: NOTICE_HOLD_MS,
				onDone: dismissNotice
			}, notice.seq);
		}
		/**
		* Contribute the Knowledge entry to the sidebar, the page it opens, and the
		* notice host the page reports through.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "prism-wiki: dictionaries");
			const t = ctx.locale.bind(NS);
			const api = createWikiApi();
			const notice = createNoticeSource();
			let noticeSeq = 0;
			const face = {
				list: (signal) => api.list(signal),
				read: (path, signal) => api.read({ path }, signal),
				search: (request, signal) => api.search(request, signal),
				save: (request, signal) => api.save(request, signal),
				lint: (signal) => api.lint(signal),
				notify: (text, tone) => {
					noticeSeq += 1;
					notice.set({
						seq: noticeSeq,
						text,
						tone
					});
				}
			};
			const noticeFace = () => ({
				hooks: { notice },
				dismissNotice: () => {
					notice.set(null);
				}
			});
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: () => t("panel"),
				locale: NS
			}, WikiPanelIcon));
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => face
			}, WikiPage));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "wiki-vault.notice",
				inject: noticeFace
			}, WikiNoticeHost));
		}
		//#endregion
		exports.NS = NS;
		exports.PANEL_ID = PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map