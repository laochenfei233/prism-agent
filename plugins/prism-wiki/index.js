import { dirname, join, relative, resolve, sep } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
//#region lib/types/vault.js
/**
* Filesystem core of the markdown knowledge vault.
*
* The module owns the vault directory, the page frontmatter format, atomic page
* writes, the two derived navigation files, and the vault-wide link relations
* and lint report. It reads and writes with `node:fs/promises` directly because
* the vault sits outside the session workspace and is touched by trusted plugin
* code; the sandbox around the model's own file tools does not apply here. The
* module has no Cordis dependency and calls no model.
*
* @module @prism-ai/prism-wiki/vault
*/
/** Every page kind, in the order the catalog and the lint report use. */
const PAGE_TYPES = [
	"overview",
	"entity",
	"concept",
	"source",
	"comparison",
	"synthesis"
];
/** Every page status. */
const PAGE_STATUSES = [
	"current",
	"stub",
	"superseded",
	"disputed"
];
/** The directory each non-overview page kind is filed in, relative to `wiki/`. */
const PAGE_TYPE_DIRECTORIES = {
	entity: "entities",
	concept: "concepts",
	source: "sources",
	comparison: "comparisons",
	synthesis: "syntheses"
};
/** The catalog heading for each page kind. */
const PAGE_TYPE_HEADINGS = {
	overview: "Overview",
	entity: "Entities",
	concept: "Concepts",
	source: "Sources",
	comparison: "Comparisons",
	synthesis: "Syntheses"
};
/** The order findings are sorted in, matching the declaration order of `WikiLintKind`. */
const LINT_KIND_ORDER = [
	"orphan-page",
	"broken-link",
	"missing-page",
	"unintegrated-source",
	"missing-source",
	"frontmatter",
	"contradiction"
];
/** How many distinct pages must ask for a missing name before the lint report raises it. */
const MISSING_PAGE_THRESHOLD = 3;
/** Longest body summary the generated catalog quotes from a page. */
const SUMMARY_MAX_CHARS = 160;
/** The date format `updated` must use. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Directory names under `raw/` that hold attachments rather than sources. */
const ASSET_DIRECTORIES = new Set(["assets"]);
/** The heading an empty log file carries, before its first dated entry. */
const LOG_HEADING = "# Log";
/** One vault failure, carrying the class of failure callers branch on. */
var WikiVaultError = class extends Error {
	code;
	/**
	* @param message - what failed, naming the page, source, or frontmatter field at fault.
	* @param code - the class of failure.
	*/
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "WikiVaultError";
	}
};
/** The schema seeded at `<vaultRoot>/AGENTS.md` on first use. */
const VAULT_SCHEMA_TEMPLATE = `# Wiki schema

This file is the vault's own schema. It is seeded once and never regenerated, so edit it as this wiki's conventions
change: the human and the model co-own it.

## Categories

- \`entities/\` - one page per durable thing: a person, project, product, organization, or tool.
- \`concepts/\` - one page per idea, method, or term that outlives any single source.
- \`sources/\` - one page per ingested raw source, recording what it says and how far it is trusted.
- \`comparisons/\` - one page per decision between alternatives, carrying its criteria and its outcome.
- \`syntheses/\` - one page per conclusion drawn across several pages.
- \`overview.md\` - the single front door: what this wiki covers and where to start.

## What earns a page

Write a page when the subject is likely to be referenced again by name. A fact that belongs to exactly one page stays
on that page. Two pages that keep contradicting each other are a comparison, not two entities.

## Page files

A page lives at \`wiki/<directory>/<slug>.md\`. The slug is lowercase and hyphen-separated. Keep it stable: to rename a
page, add the old slug to \`aliases\` instead of moving the file. Open the body with one paragraph saying what the
subject is, because the generated index quotes that paragraph.

## Frontmatter

Every page opens with a flat YAML block:

\`\`\`yaml
---
title: The page's human-facing name
type: entity
status: current
updated: 2026-01-31
tags: [retrieval, ranking]
aliases: [Other Name]
sources: [notes/paper.md]
confidence: 0.8
contradicts: [concepts/other-page.md]
---
\`\`\`

\`title\`, \`type\`, \`tags\`, \`updated\`, and \`status\` are required; the rest are optional. \`type\` is one of \`entity\`,
\`concept\`, \`source\`, \`comparison\`, \`synthesis\`, or \`overview\`, and it fixes the directory the file lives in. Lists
are written either as \`[a, b]\` or as indented \`- a\` items.

## Citing a source

Keep every raw input under \`raw/\` unchanged and cite it by its path relative to \`raw/\` in \`sources\`. Name the source
in the sentence that uses it. When two pages disagree, record the disagreement in both pages' \`contradicts\` so the
health report stops asking about it.

## Linking

Link with \`[[name]]\`, using the file's slug without \`.md\`, its path relative to \`wiki/\`, or one of its aliases. A
link to a page that does not exist yet is a request for one; the health report lists names that three or more pages
ask for.

## Syntheses

Open a synthesis with the conclusion, then the evidence in the order that supports it, then what would change the
conclusion. Cite the pages it draws on and never restate one in full.

## Derived files

\`index.md\` is regenerated from page frontmatter and \`log.md\` receives one line per write. Neither is edited by hand.
`;
/**
* Extract the target names of every `[[wikilink]]` in a markdown body, in order, de-duplicated.
* The display text of `[[target|display]]` and the heading of `[[target#heading]]` are dropped.
* Two spellings that differ only in case count as one target, keeping the first spelling.
* @param body - markdown with the frontmatter block removed.
* @returns the link targets, in first-appearance order.
*/
function extractWikiLinks(body) {
	const pattern = /\[\[([^\[\]]+)\]\]/g;
	const seen = /* @__PURE__ */ new Set();
	const links = [];
	for (const match of body.matchAll(pattern)) {
		const target = linkTarget(match[1] ?? "");
		if (target === "") continue;
		const key = target.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		links.push(target);
	}
	return links;
}
/**
* Parse and validate one page's file text.
* A required field that is missing or malformed raises `WIKI_FRONTMATTER_INVALID`
* with the field name in the message. Optional fields that are absent default to
* an empty list, or to null for `confidence`.
* @param text - the complete file text, frontmatter block included.
* @param path - the page identity the text was read from, used in error messages.
* @returns the validated frontmatter and the body with the frontmatter block removed.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID`.
*/
function parsePageText(text, path) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if ((lines[0] ?? "").trim() !== "---") throw invalidField(path, "title", "is missing because the file has no frontmatter block");
	const closing = closingDelimiterIndex(lines);
	if (closing < 0) throw new WikiVaultError(`${path}: frontmatter block is not closed by a --- line`, "WIKI_FRONTMATTER_INVALID");
	return {
		frontmatter: readFrontmatter(readFrontmatterFields(lines.slice(1, closing)), path),
		body: lines.slice(closing + 1).join("\n").replace(/^\n+/, "").replace(/\s+$/, "")
	};
}
/**
* Render one page's complete file text, including the YAML frontmatter block.
* Optional fields are written only when they carry a value, and lists are always
* written in the inline form the parser also reads.
* @param frontmatter - the validated frontmatter to store.
* @param body - markdown stored below the frontmatter block.
* @returns the file text, ending with exactly one trailing newline.
*/
function serializePageText(frontmatter, body) {
	const lines = [
		"---",
		`title: ${renderScalar(frontmatter.title)}`,
		`type: ${frontmatter.type}`,
		`status: ${frontmatter.status}`,
		`updated: ${frontmatter.updated}`,
		`tags: ${renderList(frontmatter.tags)}`
	];
	if (frontmatter.aliases.length > 0) lines.push(`aliases: ${renderList(frontmatter.aliases)}`);
	if (frontmatter.sources.length > 0) lines.push(`sources: ${renderList(frontmatter.sources)}`);
	if (frontmatter.confidence !== null) lines.push(`confidence: ${String(frontmatter.confidence)}`);
	if (frontmatter.contradicts.length > 0) lines.push(`contradicts: ${renderList(frontmatter.contradicts)}`);
	lines.push("---");
	const head = `${lines.join("\n")}\n`;
	const trimmedBody = body.replace(/\s+$/, "");
	return trimmedBody === "" ? head : `${head}\n${trimmedBody}\n`;
}
/**
* SHA-256 (hex) of the complete file text; the value `expectedRevision` compares against.
* @param text - the complete file text.
* @returns the lowercase hexadecimal digest.
*/
function revisionOf(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}
/**
* The vault-wide health report. Pure: it reads only its arguments, so a caller
* supplies the pages and raw sources it already listed. Findings are ordered by
* kind, then by page, then by detail.
*
* `pages` and `sources` are the examined counts. A page no other page links to
* is orphaned; the generated catalog is not a page, and it is not an argument
* here, so a page reachable only from `index.md` still counts as orphaned.
* @param pages - every parsed page in the vault.
* @param sources - every raw source path in the vault, relative to `raw/`.
* @returns the counts examined and every finding, in report order.
*/
function lintVault(pages, sources) {
	const findings = [];
	const index = buildLinkIndex(pages);
	const backlinks = /* @__PURE__ */ new Map();
	const unresolved = /* @__PURE__ */ new Map();
	for (const page of pages) {
		for (const target of extractWikiLinks(page.body)) {
			const resolved = index.get(normalizePageTarget(target)) ?? null;
			if (resolved === null) {
				recordUnresolved(unresolved, target, page.path);
				findings.push({
					kind: "broken-link",
					page: page.path,
					detail: `[[${target}]] resolves to no page`
				});
				continue;
			}
			if (resolved.path === page.path) continue;
			const linked = backlinks.get(resolved.path) ?? /* @__PURE__ */ new Set();
			linked.add(page.path);
			backlinks.set(resolved.path, linked);
		}
		if (!pathMatchesType(page.path, page.frontmatter.type)) findings.push({
			kind: "frontmatter",
			page: page.path,
			detail: `type "${page.frontmatter.type}" expects the directory ${describeTypeDirectory(page.frontmatter.type)}`
		});
	}
	for (const page of pages) if ((backlinks.get(page.path)?.size ?? 0) === 0) findings.push({
		kind: "orphan-page",
		page: page.path,
		detail: "no page links to this page"
	});
	for (const entry of unresolved.values()) {
		if (entry.pages.size < MISSING_PAGE_THRESHOLD) continue;
		findings.push({
			kind: "missing-page",
			page: null,
			detail: `${entry.pages.size} pages link to [[${entry.name}]] but no page exists`
		});
	}
	const available = /* @__PURE__ */ new Set();
	for (const source of sources) {
		const key = sourceKey(source);
		if (key !== "") available.add(key);
	}
	const cited = /* @__PURE__ */ new Map();
	for (const page of pages) {
		const reported = /* @__PURE__ */ new Set();
		for (const entry of page.frontmatter.sources) {
			const key = sourceKey(entry);
			if (key === "" || reported.has(key)) continue;
			reported.add(key);
			if (!available.has(key)) {
				findings.push({
					kind: "missing-source",
					page: page.path,
					detail: `cites raw source "${entry}" which does not exist`
				});
				continue;
			}
			const citing = cited.get(key) ?? /* @__PURE__ */ new Set();
			citing.add(page.path);
			cited.set(key, citing);
		}
	}
	for (const source of sources) {
		const key = sourceKey(source);
		if (key === "" || (cited.get(key)?.size ?? 0) > 0) continue;
		findings.push({
			kind: "unintegrated-source",
			page: null,
			detail: `raw source "${source}" is cited by no page`
		});
	}
	for (const page of pages) {
		const reported = /* @__PURE__ */ new Set();
		for (const name of page.frontmatter.contradicts) {
			const other = index.get(normalizePageTarget(name)) ?? null;
			if (other === null) {
				findings.push({
					kind: "contradiction",
					page: page.path,
					detail: `contradicts [[${name}]], which resolves to no page`
				});
				continue;
			}
			if (other.path === page.path) continue;
			if (reported.has(other.path)) continue;
			reported.add(other.path);
			if (other.frontmatter.contradicts.some((value) => (index.get(normalizePageTarget(value)) ?? null)?.path === page.path)) continue;
			findings.push({
				kind: "contradiction",
				page: page.path,
				detail: `contradicts [[${name}]] but ${other.path} does not name this page back`
			});
		}
	}
	findings.sort(compareFindings);
	return {
		pages: pages.length,
		sources: sources.length,
		findings
	};
}
/** The filesystem half of the vault. */
var VaultFiles = class {
	root;
	/**
	* @param root - absolute path of the vault directory the instance manages.
	*/
	constructor(root) {
		this.root = root;
	}
	/**
	* Create the layout and seed the schema when the vault is absent; refuse a
	* non-empty directory that is not a vault. Idempotent.
	*
	* A directory counts as a vault when it holds `AGENTS.md`. An absent or empty
	* directory is adopted and receives `AGENTS.md`, `raw/`, `raw/assets/`,
	* `wiki/`, the five page directories, and the two derived files `index.md`
	* and `log.md`. `AGENTS.md` is written only when that file is absent, so an
	* edited schema is never overwritten, and `index.md` is built only when it is
	* absent, so a later call never discards an existing catalog. `.wiki/` is
	* created by the module that owns the search cache.
	* @returns nothing.
	* @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when the target is a non-empty non-vault directory.
	*/
	async ensureLayout() {
		const existing = await readDirectoryNames(this.root);
		if (existing !== null && existing.length > 0 && !existing.some((name) => name.toLowerCase() === "agents.md")) throw new WikiVaultError(`"${this.root}" is not empty and holds no AGENTS.md, so it is not a wiki vault`, "WIKI_ROOT_NOT_VAULT");
		if (existing === null && await fileExists(this.root)) throw new WikiVaultError(`"${this.root}" is a file, not a wiki vault directory`, "WIKI_ROOT_NOT_VAULT");
		const wiki = join(this.root, "wiki");
		const directories = [
			this.root,
			join(this.root, "raw"),
			join(this.root, "raw", "assets"),
			wiki,
			...Object.values(PAGE_TYPE_DIRECTORIES).map((name) => join(wiki, name))
		];
		for (const directory of directories) await mkdir(directory, { recursive: true });
		const schema = join(this.root, "AGENTS.md");
		if (!await fileExists(schema)) await writeAtomically(schema, VAULT_SCHEMA_TEMPLATE);
		const log = join(this.root, "log.md");
		if (!await fileExists(log)) await writeAtomically(log, `${LOG_HEADING}\n`);
		if (!await fileExists(join(this.root, "index.md"))) await this.rebuildIndex();
	}
	/**
	* Every page, parsed, with its mtime. Throws if any page's frontmatter is invalid.
	* @returns the parsed pages, ordered by path.
	* @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when `wiki/` is absent.
	* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` for the first unparsable page.
	*/
	async listPageEntries() {
		const files = await this.pageFiles();
		const entries = [];
		for (const file of files.sort(compareStrings)) {
			const text = await readFile(file, "utf8");
			const path = pagePathOf(this.root, file);
			const { frontmatter, body } = parsePageText(text, path);
			const metadata = await stat(file);
			entries.push({
				page: {
					path,
					frontmatter,
					body,
					revision: revisionOf(text)
				},
				mtimeMs: metadata.mtimeMs
			});
		}
		return entries;
	}
	/**
	* One page.
	* @param path - page identity relative to `wiki/`, including the `.md` suffix.
	* @returns the parsed page with the revision of its file text.
	* @throws WikiVaultError with code `WIKI_PAGE_NOT_FOUND` when no such page file exists.
	* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the file is unparsable.
	*/
	async readPage(path) {
		const normalized = normalizePagePath(path);
		if (normalized === null) throw new WikiVaultError(`"${path}" is not a vault page path`, "WIKI_PAGE_NOT_FOUND");
		const text = await readFileOrNull(join(this.root, "wiki", normalized));
		if (text === null) throw new WikiVaultError(`page "${path}" does not exist`, "WIKI_PAGE_NOT_FOUND");
		const { frontmatter, body } = parsePageText(text, path);
		return {
			path,
			frontmatter,
			body,
			revision: revisionOf(text)
		};
	}
	/**
	* Whether a page file exists.
	* @param path - page identity relative to `wiki/`, including the `.md` suffix.
	* @returns true when a regular page file is present at that path.
	*/
	async hasPage(path) {
		const normalized = normalizePagePath(path);
		if (normalized === null) return false;
		return await fileExists(join(this.root, "wiki", normalized));
	}
	/**
	* The vault schema text.
	* @returns the current contents of `<vaultRoot>/AGENTS.md`.
	* @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when that file is absent.
	*/
	async readSchema() {
		const text = await readFileOrNull(join(this.root, "AGENTS.md"));
		if (text === null) throw new WikiVaultError(`"${this.root}" holds no AGENTS.md, so it is not a wiki vault`, "WIKI_ROOT_NOT_VAULT");
		return text;
	}
	/**
	* Register a new raw source. Refuses to overwrite an existing source.
	* @param path - source identity relative to `raw/`; a leading `raw/` is accepted and ignored.
	* @param text - the source text to store unchanged.
	* @returns nothing.
	* @throws WikiVaultError with code `WIKI_SOURCE_NOT_FOUND` when the path is unusable or names an attachment directory.
	* @throws WikiVaultError with code `WIKI_REVISION_CONFLICT` when the source already exists.
	*/
	async addSource(path, text) {
		const key = sourceKey(path);
		if (key === "" || ASSET_DIRECTORIES.has(key.split("/")[0] ?? "")) throw new WikiVaultError(`"${path}" is not a storable raw source path`, "WIKI_SOURCE_NOT_FOUND");
		const target = join(this.root, "raw", key);
		if (await fileExists(target)) throw new WikiVaultError(`raw source "${path}" already exists`, "WIKI_REVISION_CONFLICT");
		await writeAtomically(target, text);
	}
	/**
	* A bounded slice of one source's text, plus whether it was truncated.
	* @param path - source identity relative to `raw/`.
	* @param maxChars - largest slice to return, counted in UTF-16 code units; a value at or below zero returns no text.
	* @returns the text slice and whether more text follows it.
	* @throws WikiVaultError with code `WIKI_SOURCE_NOT_FOUND` when the path is unusable or the source does not exist.
	*/
	async readSource(path, maxChars) {
		const key = sourceKey(path);
		if (key === "") throw new WikiVaultError(`"${path}" is not a raw source path`, "WIKI_SOURCE_NOT_FOUND");
		const text = await readFileOrNull(join(this.root, "raw", key));
		if (text === null) throw new WikiVaultError(`raw source "${path}" does not exist`, "WIKI_SOURCE_NOT_FOUND");
		const limit = Math.max(0, Math.floor(maxChars));
		if (text.length <= limit) return {
			text,
			truncated: false
		};
		return {
			text: sliceWithoutSplittingPair(text, limit),
			truncated: true
		};
	}
	/**
	* Every raw source path, recursive, excluding the `assets/` directory.
	* @returns the source paths relative to `raw/`, ordered lexicographically.
	*/
	async listSources() {
		const raw = join(this.root, "raw");
		const files = await walkFiles(raw, { excludedDirectories: ASSET_DIRECTORIES });
		if (files === null) return [];
		return files.map((file) => brandString(vaultRelativePath(raw, file))).sort(compareStrings);
	}
	/**
	* Create or replace one page atomically, then refresh `index.md` and append one `log.md` entry.
	*
	* The write goes to a sibling temporary file and is renamed over the target, so
	* no reader sees a partial page. A draft whose path disagrees with its `type`
	* is refused before anything is written.
	* @param draft - the page to store, with an optional expected revision.
	* @param logKind - the kind recorded in the appended log entry.
	* @returns the stored page, as parsed back from the written text.
	* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the draft's path or frontmatter is invalid.
	* @throws WikiVaultError with code `WIKI_REVISION_CONFLICT` when `expectedRevision` does not match the stored text.
	*/
	async writePage(draft, logKind) {
		const normalized = normalizePagePath(draft.path);
		if (normalized === null) throw new WikiVaultError(`${draft.path}: frontmatter field "path" is not a vault page path`, "WIKI_FRONTMATTER_INVALID");
		assertFrontmatter(draft.frontmatter, draft.path);
		if (!pathMatchesType(draft.path, draft.frontmatter.type)) {
			const expected = describeTypeDirectory(draft.frontmatter.type);
			throw new WikiVaultError(`${draft.path}: frontmatter field "type" is "${draft.frontmatter.type}", which belongs in ${expected}`, "WIKI_FRONTMATTER_INVALID");
		}
		const target = join(this.root, "wiki", normalized);
		const existing = await readFileOrNull(target);
		if (draft.expectedRevision !== void 0) {
			if (existing === null) throw new WikiVaultError(`page "${draft.path}" does not exist, so the expected revision cannot match`, "WIKI_REVISION_CONFLICT");
			const current = revisionOf(existing);
			if (current !== draft.expectedRevision) throw new WikiVaultError(`page "${draft.path}" changed: expected revision "${draft.expectedRevision}" but found "${current}"`, "WIKI_REVISION_CONFLICT");
		}
		const text = serializePageText(draft.frontmatter, draft.body);
		await writeAtomically(target, text);
		const { frontmatter, body } = parsePageText(text, draft.path);
		const page = {
			path: draft.path,
			frontmatter,
			body,
			revision: revisionOf(text)
		};
		await this.rebuildIndex();
		await this.appendLog(logKind, `${page.path} ${page.frontmatter.title}`);
		return page;
	}
	/**
	* Rewrite `index.md` from every page's frontmatter, grouped by page kind.
	* Each entry names the page title, quotes the page's first body paragraph, and
	* carries the page's `[[wikilink]]`. A page whose frontmatter cannot be parsed
	* is listed under a `Needs attention` heading instead of aborting the rebuild.
	* The catalog's own frontmatter carries `generated: true`.
	* @returns nothing.
	* @throws WikiVaultError with code `WIKI_ROOT_NOT_VAULT` when `wiki/` is absent.
	*/
	async rebuildIndex() {
		const files = await this.pageFiles();
		const grouped = /* @__PURE__ */ new Map();
		const attention = [];
		for (const file of files.sort(compareStrings)) {
			const path = pagePathOf(this.root, file);
			const text = await readFile(file, "utf8");
			let parsed = null;
			let failure = null;
			try {
				parsed = parsePageText(text, path);
			} catch (error) {
				if (!(error instanceof WikiVaultError)) throw error;
				failure = error.message;
			}
			if (parsed === null) {
				attention.push(`- \`${path}\`: ${failure ?? "frontmatter is invalid"}`);
				continue;
			}
			const parts = [parsed.frontmatter.title];
			const summary = firstParagraph(parsed.body);
			if (summary !== "") parts.push(summary);
			parts.push(`[[${pagePathWithoutExtension(path)}]]`);
			const entries = grouped.get(parsed.frontmatter.type) ?? [];
			entries.push(`- ${parts.join(" | ")}`);
			grouped.set(parsed.frontmatter.type, entries);
		}
		const lines = [
			"---",
			"generated: true",
			"title: Index",
			`updated: ${today()}`,
			"---",
			"",
			"# Index",
			""
		];
		for (const type of PAGE_TYPES) {
			const entries = grouped.get(type);
			if (entries === void 0 || entries.length === 0) continue;
			lines.push(`## ${PAGE_TYPE_HEADINGS[type]}`, "");
			lines.push(...entries);
			lines.push("");
		}
		if (attention.length > 0) {
			lines.push("## Needs attention", "");
			lines.push(...attention);
			lines.push("");
		}
		if (lines[lines.length - 1] === "") lines.pop();
		const text = `${lines.join("\n")}\n`;
		await writeAtomically(join(this.root, "index.md"), text);
	}
	/**
	* Append one entry to `log.md`. The file is created with a `# Log` heading when absent.
	* The entry heading has the form `## [YYYY-MM-DD] <kind> | <summary>`.
	* @param kind - the class of mutation being recorded.
	* @param summary - one line naming what changed.
	* @returns nothing.
	*/
	async appendLog(kind, summary) {
		const target = join(this.root, "log.md");
		const existing = await readFileOrNull(target);
		await writeAtomically(target, `${existing === null || existing.trim() === "" ? LOG_HEADING : existing.replace(/\s+$/, "")}\n\n${`## [${today()}] ${kind} | ${summary}`}\n`);
	}
	/**
	* The newest `limit` log entry headings, newest first.
	* @param limit - how many headings to return; a value at or below zero returns none.
	* @returns the complete heading lines, newest first.
	*/
	async logTail(limit) {
		if (limit <= 0) return [];
		const text = await readFileOrNull(join(this.root, "log.md"));
		if (text === null) return [];
		const headings = text.split(/\r?\n/).filter((line) => line.startsWith("## ["));
		return headings.slice(Math.max(0, headings.length - limit)).reverse();
	}
	/**
	* The page files present under `wiki/`.
	* @returns absolute file paths, or a rejection when the vault has no `wiki/` directory.
	*/
	async pageFiles() {
		const files = await walkFiles(join(this.root, "wiki"), { extensions: [".md"] });
		if (files === null) throw new WikiVaultError(`"${this.root}" holds no wiki directory, so it is not a wiki vault`, "WIKI_ROOT_NOT_VAULT");
		return files;
	}
};
/**
* Build the lookup from every name a wikilink may use to the page it addresses.
* The keys are lowercased: the page path without `.md`, the file stem, and every
* declared alias. The first page in iteration order wins a key claimed twice, so
* a caller listing pages in path order gets a stable resolution.
* @param pages - every parsed page in the vault.
* @returns the lookup keyed by lowercased name.
*/
function buildLinkIndex(pages) {
	const index = /* @__PURE__ */ new Map();
	for (const page of pages) {
		const keys = [
			pagePathWithoutExtension(page.path).toLowerCase(),
			pageStem(page.path).toLowerCase(),
			...page.frontmatter.aliases.map((alias) => alias.trim().toLowerCase())
		];
		for (const key of keys) {
			if (key === "" || index.has(key)) continue;
			index.set(key, page);
		}
	}
	return index;
}
/**
* The lookup key of a written link target.
* @param target - the text between `[[` and `]]`.
* @returns the lowercased key, with `./`, `wiki/`, and a `.md` suffix removed.
*/
function normalizePageTarget(target) {
	let value = target.trim().replace(/\\/g, "/").toLowerCase();
	if (value.startsWith("./")) value = value.slice(2);
	if (value.startsWith("wiki/")) value = value.slice(5);
	if (value.endsWith(".md")) value = value.slice(0, -3);
	return value;
}
/**
* The target name of one `[[...]]` payload.
* @param payload - the text between `[[` and `]]`.
* @returns the target with any display text and heading dropped, trimmed.
*/
function linkTarget(payload) {
	return ((payload.split("|")[0] ?? "").split("#")[0] ?? "").trim();
}
/**
* Record one unresolved link target per page that wrote it.
* @param unresolved - the accumulator keyed by lowercased target.
* @param target - the target as written.
* @param page - the page that wrote the link.
*/
function recordUnresolved(unresolved, target, page) {
	const key = normalizePageTarget(target);
	const entry = unresolved.get(key) ?? {
		name: target,
		pages: /* @__PURE__ */ new Set()
	};
	entry.pages.add(page);
	unresolved.set(key, entry);
}
/**
* Whether a page path sits in the directory its `type` selects.
* @param path - page identity relative to `wiki/`.
* @param type - the page kind.
* @returns true when the path and the kind agree.
*/
function pathMatchesType(path, type) {
	if (type === "overview") return path === "overview.md";
	const directory = PAGE_TYPE_DIRECTORIES[type];
	return pageDirectoryOf(path) === directory;
}
/**
* The directory a page kind expects, as reported in a diagnostic.
* @param type - the page kind.
* @returns the vault-relative directory, with a trailing slash.
*/
function describeTypeDirectory(type) {
	return type === "overview" ? "\"wiki/\"" : `"wiki/${PAGE_TYPE_DIRECTORIES[type]}/"`;
}
/**
* The directory part of a vault-relative path.
* @param path - a vault-relative page path.
* @returns the directory without a trailing slash, or an empty string at the vault root.
*/
function pageDirectoryOf(path) {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}
/**
* A page path without its `.md` suffix, the form its catalog wikilink uses.
* @param path - a vault-relative page path.
* @returns the path without the suffix.
*/
function pagePathWithoutExtension(path) {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}
/**
* The file stem of a vault-relative page path.
* @param path - a vault-relative page path.
* @returns the last segment without its `.md` suffix.
*/
function pageStem(path) {
	const withoutExtension = pagePathWithoutExtension(path);
	const slash = withoutExtension.lastIndexOf("/");
	return slash === -1 ? withoutExtension : withoutExtension.slice(slash + 1);
}
/**
* Read a page path from disk-relative form, rejecting anything that leaves `wiki/`.
* @param value - the candidate path.
* @returns the normalized path, or null when it is not a page path.
*/
function normalizePagePath(value) {
	const normalized = normalizeRelativePath(value);
	if (normalized === null || !normalized.endsWith(".md")) return null;
	return normalized;
}
/**
* Read a raw source path from disk-relative form, rejecting anything that leaves `raw/`.
* @param value - the candidate path, with or without a leading `raw/`.
* @returns the normalized path, or an empty string when it is unusable.
*/
function sourceKey(value) {
	const trimmed = value.trim().replace(/\\/g, "/");
	return normalizeRelativePath(trimmed.startsWith("raw/") ? trimmed.slice(4) : trimmed) ?? "";
}
/**
* Normalize a relative path, rejecting absolute paths and parent traversal.
* @param value - the candidate path.
* @returns the path with forward slashes, or null when it is unusable.
*/
function normalizeRelativePath(value) {
	const unified = value.trim().replace(/\\/g, "/");
	if (unified === "" || unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) return null;
	const segments = unified.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
	return segments.join("/");
}
/**
* The vault-relative path of one file, with forward slashes.
* @param base - the directory the path is relative to.
* @param file - the absolute file path.
* @returns the relative path.
*/
function vaultRelativePath(base, file) {
	return relative(base, file).split(sep).join("/");
}
/**
* The page identity of one page file.
* @param root - the vault root.
* @param file - the absolute page file path under `wiki/`.
* @returns the page identity relative to `wiki/`.
*/
function pagePathOf(root, file) {
	return brandString(vaultRelativePath(join(root, "wiki"), file));
}
/**
* Collect files under one directory, recursively.
* @param directory - the absolute directory to walk.
* @param options - directory names to skip and file suffixes to keep.
* @returns the absolute file paths, or null when the directory is absent.
*/
async function walkFiles(directory, options = {}) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (options.excludedDirectories?.has(entry.name) === true) continue;
			const nested = await walkFiles(path, options);
			if (nested !== null) files.push(...nested);
			continue;
		}
		if (!entry.isFile()) continue;
		if (options.extensions !== void 0 && !options.extensions.some((extension) => entry.name.endsWith(extension))) continue;
		files.push(path);
	}
	return files;
}
/**
* Write one file durably: a full write to a sibling temporary path, then a rename.
* @param path - the target file path.
* @param content - the complete file text.
* @returns nothing.
*/
async function writeAtomically(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, content, "utf8");
	await rename(temporary, path);
}
/**
* Read a file, treating an absent file as null.
* @param path - the file to read.
* @returns the file text, or null when it does not exist.
*/
async function readFileOrNull(path) {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}
/**
* List one directory's entry names.
* @param directory - the directory to list.
* @returns the entry names, or null when the directory does not exist.
*/
async function readDirectoryNames(directory) {
	try {
		return (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name);
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}
/**
* Whether a regular file exists at one path.
* @param path - the path to test.
* @returns true when the path names an existing regular file.
*/
async function fileExists(path) {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}
/**
* Whether a filesystem failure means "nothing there".
* @param error - the caught value.
* @returns true for ENOENT and ENOTDIR.
*/
function isMissing(error) {
	if (typeof error !== "object" || error === null) return false;
	const code = error.code;
	return code === "ENOENT" || code === "ENOTDIR";
}
/**
* Cut a string at a code-unit limit without splitting a surrogate pair.
* @param text - the text to cut.
* @param limit - the maximum number of code units.
* @returns the leading slice.
*/
function sliceWithoutSplittingPair(text, limit) {
	let end = limit;
	const last = text.charCodeAt(end - 1);
	if (last >= 55296 && last <= 56319) end -= 1;
	return text.slice(0, end);
}
/** The current UTC calendar date. */
function today() {
	return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
/**
* The first body paragraph, collapsed to one line and clipped for the catalog.
* @param body - the markdown body.
* @returns the summary text, or an empty string when the body opens with a heading, table, or code fence.
*/
function firstParagraph(body) {
	for (const block of body.split(/\n\s*\n/)) {
		const cleaned = block.replace(/\s+/g, " ").trim();
		if (cleaned === "") continue;
		if (/^(#{1,6}\s|>|\||```)/.test(cleaned)) continue;
		return clipSummary(cleaned);
	}
	return "";
}
/**
* Clip a summary to the catalog's line budget.
* @param value - the collapsed paragraph.
* @returns the paragraph, shortened at a word boundary when it exceeds the budget.
*/
function clipSummary(value) {
	if (value.length <= SUMMARY_MAX_CHARS) return value;
	const clipped = value.slice(0, SUMMARY_MAX_CHARS - 3);
	const boundary = clipped.lastIndexOf(" ");
	return `${boundary > SUMMARY_MAX_CHARS / 2 ? clipped.slice(0, boundary) : clipped}...`;
}
/**
* Validate frontmatter a caller assembled in memory.
* @param frontmatter - the frontmatter to store.
* @param path - the page identity, used in error messages.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` naming the offending field.
*/
function assertFrontmatter(frontmatter, path) {
	if (frontmatter.title.trim() === "") throw invalidField(path, "title", "must not be empty");
	if (enumValue(PAGE_TYPES, frontmatter.type) === null) throw invalidField(path, "type", `must be one of ${PAGE_TYPES.join(", ")}`);
	if (enumValue(PAGE_STATUSES, frontmatter.status) === null) throw invalidField(path, "status", `must be one of ${PAGE_STATUSES.join(", ")}`);
	if (!DATE_PATTERN.test(frontmatter.updated)) throw invalidField(path, "updated", "must be a YYYY-MM-DD date");
	const confidence = frontmatter.confidence;
	if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw invalidField(path, "confidence", "must be a number between 0 and 1");
}
/**
* Build the error for one invalid frontmatter field.
* @param path - the page identity.
* @param field - the field at fault.
* @param detail - the clause completing the message.
* @returns the error to throw.
*/
function invalidField(path, field, detail) {
	return new WikiVaultError(`${path}: frontmatter field "${field}" ${detail}`, "WIKI_FRONTMATTER_INVALID");
}
/**
* Find the line that closes the frontmatter block.
* @param lines - the file text split on newlines.
* @returns the index of the closing `---` line, or -1 when there is none.
*/
function closingDelimiterIndex(lines) {
	for (let index = 1; index < lines.length; index += 1) if ((lines[index] ?? "").trim() === "---") return index;
	return -1;
}
/**
* Read the flat frontmatter fields of one block.
* Keys are recognized as `name:` at column zero; an empty value followed by
* indented `- item` lines is read as a list, and an unrecognized line is ignored.
* @param lines - the lines between the two `---` delimiters.
* @returns the raw field values by key.
*/
function readFrontmatterFields(lines) {
	const fields = /* @__PURE__ */ new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (match === null) continue;
		const key = match[1] ?? "";
		const rest = (match[2] ?? "").trim();
		if (rest !== "") {
			fields.set(key, parseInlineValue(rest));
			continue;
		}
		const items = [];
		let next = index + 1;
		while (next < lines.length) {
			const item = /^\s*-\s*(.*)$/.exec(lines[next] ?? "");
			if (item === null) break;
			pushListValue(items, unquote((item[1] ?? "").trim()));
			next += 1;
		}
		if (items.length > 0) {
			fields.set(key, {
				kind: "list",
				values: items
			});
			index = next - 1;
			continue;
		}
		fields.set(key, {
			kind: "scalar",
			value: ""
		});
	}
	return fields;
}
/**
* Read one inline value: a bracketed list, or a scalar.
* @param rest - the text after the `:` on one frontmatter line.
* @returns the raw field.
*/
function parseInlineValue(rest) {
	if (rest.startsWith("[") && rest.endsWith("]")) return {
		kind: "list",
		values: splitInlineList(rest.slice(1, -1))
	};
	return {
		kind: "scalar",
		value: unquote(rest)
	};
}
/**
* Split the inside of an inline list on top-level commas.
* @param inner - the text between `[` and `]`.
* @returns the non-empty items, with surrounding quotes removed.
*/
function splitInlineList(inner) {
	const values = [];
	let current = "";
	let quote = null;
	for (let index = 0; index < inner.length; index += 1) {
		const character = inner[index] ?? "";
		if (quote !== null) {
			current += character;
			if (character === "\\") {
				index += 1;
				current += inner[index] ?? "";
				continue;
			}
			if (character === quote) quote = null;
			continue;
		}
		if (character === "\"" || character === "'") {
			quote = character;
			current += character;
			continue;
		}
		if (character === ",") {
			pushListValue(values, unquote(current));
			current = "";
			continue;
		}
		current += character;
	}
	pushListValue(values, unquote(current));
	return values;
}
/**
* Append one non-empty list item.
* @param values - the accumulator.
* @param candidate - the raw item text.
*/
function pushListValue(values, candidate) {
	const value = candidate.trim();
	if (value !== "") values.push(value);
}
/**
* Remove one layer of matching quotes.
* @param value - the raw scalar text.
* @returns the value without its surrounding quotes.
*/
function unquote(value) {
	const first = value[0];
	const last = value[value.length - 1];
	if (value.length < 2) return value;
	if (first === "\"" && last === "\"") return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
	if (first === "'" && last === "'") return value.slice(1, -1);
	return value;
}
/**
* Validate the parsed fields of one page.
* @param fields - the raw field values read from the frontmatter block.
* @param path - the page identity, used in error messages.
* @returns the validated frontmatter.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` naming the offending field.
*/
function readFrontmatter(fields, path) {
	const title = readRequiredScalar(fields, "title", path).trim();
	if (title === "") throw invalidField(path, "title", "must not be empty");
	const type = readEnumField(fields, "type", PAGE_TYPES, path);
	const updated = readRequiredScalar(fields, "updated", path);
	if (!DATE_PATTERN.test(updated)) throw invalidField(path, "updated", "must be a YYYY-MM-DD date");
	return {
		title,
		type,
		updated,
		status: readEnumField(fields, "status", PAGE_STATUSES, path),
		tags: readRequiredList(fields, "tags", path),
		sources: readOptionalList(fields, "sources", path),
		aliases: readOptionalList(fields, "aliases", path),
		confidence: readOptionalNumber(fields, "confidence", path),
		contradicts: readOptionalList(fields, "contradicts", path)
	};
}
/**
* Read one required scalar field.
* @param fields - the raw field values.
* @param key - the field name.
* @param path - the page identity, used in error messages.
* @returns the scalar text.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or a list.
*/
function readRequiredScalar(fields, key, path) {
	const field = fields.get(key);
	if (field === void 0) throw invalidField(path, key, "is missing");
	if (field.kind !== "scalar") throw invalidField(path, key, "must be a single value");
	return field.value;
}
/**
* Read one required field whose value must come from a closed set.
* @param fields - the raw field values.
* @param key - the field name.
* @param values - the admitted values.
* @param path - the page identity, used in error messages.
* @returns the matching value.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or unrecognized.
*/
function readEnumField(fields, key, values, path) {
	const value = enumValue(values, readRequiredScalar(fields, key, path).trim());
	if (value === null) throw invalidField(path, key, `must be one of ${values.join(", ")}`);
	return value;
}
/**
* Read one required list field.
* @param fields - the raw field values.
* @param key - the field name.
* @param path - the page identity, used in error messages.
* @returns the list items, empty when the field carries no items.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is absent or a non-empty scalar.
*/
function readRequiredList(fields, key, path) {
	const field = fields.get(key);
	if (field === void 0) throw invalidField(path, key, "is missing");
	return listValue(field, key, path);
}
/**
* Read one optional list field.
* @param fields - the raw field values.
* @param key - the field name.
* @param path - the page identity, used in error messages.
* @returns the list items, empty when the field is absent.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the field is a non-empty scalar.
*/
function readOptionalList(fields, key, path) {
	const field = fields.get(key);
	if (field === void 0) return [];
	return listValue(field, key, path);
}
/**
* Read one list value from its raw form.
* @param field - the raw field.
* @param key - the field name, used in error messages.
* @param path - the page identity, used in error messages.
* @returns the list items.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when a non-empty scalar cannot be a list.
*/
function listValue(field, key, path) {
	if (field.kind === "list") return field.values;
	if (field.value.trim() === "") return [];
	throw invalidField(path, key, "must be a list, written as [a, b] or as indented - items");
}
/**
* Read one optional number field held between 0 and 1.
* @param fields - the raw field values.
* @param key - the field name.
* @param path - the page identity, used in error messages.
* @returns the number, or null when the field is absent.
* @throws WikiVaultError with code `WIKI_FRONTMATTER_INVALID` when the value is not a number in range.
*/
function readOptionalNumber(fields, key, path) {
	const field = fields.get(key);
	if (field === void 0) return null;
	if (field.kind !== "scalar") throw invalidField(path, key, "must be a number between 0 and 1");
	const raw = field.value.trim();
	const value = Number(raw);
	if (raw === "" || !Number.isFinite(value) || value < 0 || value > 1) throw invalidField(path, key, "must be a number between 0 and 1");
	return value;
}
/**
* The value of a closed set that equals one candidate string.
* @param values - the admitted values.
* @param value - the candidate.
* @returns the admitted value, or null when the candidate is not admitted.
*/
function enumValue(values, value) {
	return values.find((candidate) => candidate === value) ?? null;
}
/** Render one list value in the inline form the parser reads. */
function renderList(values) {
	return `[${values.map(renderScalar).join(", ")}]`;
}
/** Render one scalar, quoting it unless it is unambiguously plain. */
function renderScalar(value) {
	if (/^[A-Za-z0-9][A-Za-z0-9 ._/@()-]*$/.test(value)) return value;
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
/** Compare two strings by code unit, for a stable order on every platform. */
function compareStrings(left, right) {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
/** Order findings by kind, then by page, then by detail. */
function compareFindings(left, right) {
	const kind = LINT_KIND_ORDER.indexOf(left.kind) - LINT_KIND_ORDER.indexOf(right.kind);
	if (kind !== 0) return kind;
	const page = compareStrings(left.page ?? "", right.page ?? "");
	if (page !== 0) return page;
	return compareStrings(left.detail, right.detail);
}
//#endregion
//#region lib/types/search.js
/**
* Rebuildable full-text cache over the pages of a wiki vault.
*
* The FTS5 table is never authoritative: rows are reproduced from the page
* entries the caller hands in, and a database file that is missing, foreign, or
* unusable is replaced instead of reported. `node:sqlite` is imported on first
* use so a process that never searches never loads it.
*
* @module @prism-ai/prism-wiki/search
*/
/** Database path that keeps the cache in memory instead of on disk. */
const MEMORY_PATH = ":memory:";
/** SQLite `application_id` marking a file as this index's own cache. */
const WIKI_SEARCH_APPLICATION_ID = 1347898161;
/** Derived-index version; a file carrying any other version is reset in place. */
const WIKI_SEARCH_SCHEMA_VERSION = 1;
/** Longest excerpt the index returns, in Unicode code points. */
const EXCERPT_MAX_CHARACTERS = 200;
/** Marker showing that an excerpt was cut out of a longer body. */
const ELLIPSIS = "…";
/** Shortest query the trigram tokenizer can match. */
const TRIGRAM_MIN_LENGTH = 3;
/** Separator between the literal terms of one query. */
const QUERY_SEPARATOR = /\s+/u;
/**
* Derived schema. `trigram` indexes every three-character sequence, which is the
* only built-in tokenizer that matches Chinese text; the default `unicode61`
* treats a whole CJK run as one token and returns no hits for a substring query.
* `path` and `mtime_ms` are carried unindexed for row lookup and reconciliation.
*/
const WIKI_PAGES_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages USING fts5(
  title,
  body,
  tags,
  type,
  status,
  updated,
  path UNINDEXED,
  mtime_ms UNINDEXED,
  tokenize = 'trigram'
)`;
/** Insert covering every column of `wiki_pages`. */
const INSERT_PAGE_SQL = "INSERT INTO wiki_pages (title, body, tags, type, status, updated, path, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
/** Removal addressed by page identity. */
const DELETE_PAGE_SQL = "DELETE FROM wiki_pages WHERE path = ?";
/** Columns a hit needs before ranking and limiting. */
const SELECT_HIT_COLUMNS = "SELECT path, title, type, status, updated, body FROM wiki_pages";
/** A file at the index path that this cache did not create and must not delete. */
var ForeignDatabaseError = class extends Error {
	/**
	* @param path - Database path holding the foreign file.
	* @param reason - What the file holds instead of this index's schema.
	*/
	constructor(path, reason) {
		super(`wiki search cache at "${path}" ${reason}`);
		this.name = "ForeignDatabaseError";
	}
};
/**
* SQLite FTS5 cache over vault pages. Safe to construct without opening.
*/
var WikiSearchIndex = class {
	dbPath;
	databasePath;
	database = null;
	opening = null;
	/**
	* @param dbPath - Absolute path of the cache database, or `:memory:`.
	*/
	constructor(dbPath) {
		this.dbPath = dbPath;
		this.databasePath = dbPath === MEMORY_PATH ? MEMORY_PATH : resolve(dbPath);
	}
	/**
	* Open the database, importing `node:sqlite` on first use. Idempotent.
	* @returns A promise that settles once the handle is open and its schema is current.
	*/
	async open() {
		await this.ensureDatabase();
	}
	/**
	* Bring the index in line with these entries: upsert rows whose mtime changed,
	* delete rows whose page is gone.
	* @param entries - Current pages, each carrying the mtime of its file.
	* @returns A promise that settles once the index matches the entries.
	*/
	async reconcile(entries) {
		await this.run((db) => {
			const stored = readStoredMtimes(db);
			const present = new Set(entries.map((entry) => entry.path));
			const removed = [...stored.keys()].filter((path) => !present.has(path));
			const changed = entries.filter((entry) => stored.get(entry.path) !== entry.mtimeMs);
			db.exec("BEGIN");
			try {
				const remove = db.prepare(DELETE_PAGE_SQL);
				for (const path of removed) remove.run(path);
				const insert = db.prepare(INSERT_PAGE_SQL);
				for (const entry of changed) {
					remove.run(entry.path);
					writeEntry(insert, entry);
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}
	/**
	* Drop and rebuild every row from these entries.
	* @param entries - Current pages, replacing whatever the index held.
	* @returns A promise that settles once the index holds exactly these entries.
	*/
	async rebuild(entries) {
		await this.run((db) => {
			db.exec("BEGIN");
			try {
				db.exec("DELETE FROM wiki_pages");
				const insert = db.prepare(INSERT_PAGE_SQL);
				for (const entry of entries) writeEntry(insert, entry);
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		});
	}
	/**
	* Ranked hits for a literal query, narrowed by the filter.
	* @param query - Literal query text; FTS5 operators in it are searched for, not applied.
	* @param filter - Kind, tag, and status narrowing plus the result cap.
	* @returns Ranked hits, never more than `filter.limit`, and empty when the query cannot match.
	*/
	async search(query, filter) {
		const match = buildMatchQuery(query);
		const limit = Math.floor(filter.limit);
		if (match === null || !Number.isFinite(limit) || limit <= 0) return [];
		try {
			return await this.run((db) => selectHits(db, match, filter, limit));
		} catch (error) {
			if (!isSqliteError(error)) throw error;
			return [];
		}
	}
	/**
	* Close the database. Idempotent.
	* @returns A promise that settles once the handle is closed.
	*/
	async close() {
		const pending = this.opening;
		if (pending !== null) await pending.catch(() => null);
		const db = this.database;
		this.database = null;
		if (db !== null) db.close();
	}
	async ensureDatabase() {
		if (this.database !== null) return this.database;
		const pending = this.opening ?? this.openWithRecovery();
		this.opening = pending;
		try {
			return await pending;
		} finally {
			this.opening = null;
		}
	}
	async openWithRecovery() {
		try {
			return await this.openDatabase();
		} catch (error) {
			if (error instanceof ForeignDatabaseError) throw error;
			await this.discardDatabase();
			return await this.openDatabase();
		}
	}
	async openDatabase() {
		const path = this.databasePath;
		if (path !== MEMORY_PATH) {
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await createDatabaseFile(path);
		}
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(path);
		try {
			initializeSchema(db, path);
		} catch (error) {
			closeQuietly(db);
			throw error;
		}
		this.database = db;
		return db;
	}
	async discardDatabase() {
		const db = this.database;
		this.database = null;
		if (db !== null) closeQuietly(db);
		const path = this.databasePath;
		if (path === MEMORY_PATH) return;
		await rm(path, { force: true });
		await rm(`${path}-wal`, { force: true });
		await rm(`${path}-shm`, { force: true });
	}
	/**
	* Run one SQLite operation, replacing the file once when SQLite reports that
	* it cannot be read, and retrying the operation exactly once.
	*/
	async run(operation) {
		const db = await this.ensureDatabase();
		try {
			return operation(db);
		} catch (error) {
			if (!isSqliteError(error)) throw error;
			await this.discardDatabase();
			return operation(await this.openDatabase());
		}
	}
};
/**
* Exclusively create a missing database file with owner-only permissions.
* Existing files retain their modes, and errors other than `EEXIST` propagate.
* @param path - Resolved database path.
* @returns A promise that settles once the file exists.
*/
async function createDatabaseFile(path) {
	try {
		await (await open(path, "wx", 384)).close();
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
}
/**
* Close a handle that recovery is about to replace.
* @param db - Handle to close.
*/
function closeQuietly(db) {
	try {
		db.close();
	} catch {}
}
/**
* Apply the application id, the derived schema, and its version to an open handle.
* @param db - Handle opened on `path`.
* @param path - Database path, named in the refusal of a foreign file.
*/
function initializeSchema(db, path) {
	const { application_id: applicationId } = db.prepare("PRAGMA application_id").get();
	const { user_version: userVersion } = db.prepare("PRAGMA user_version").get();
	if (applicationId !== 0 && applicationId !== WIKI_SEARCH_APPLICATION_ID) throw new ForeignDatabaseError(path, "belongs to another application");
	const userTables = listUserTables(db);
	if (applicationId === 0 && userTables.length > 0) throw new ForeignDatabaseError(path, "holds tables this index did not create");
	if (applicationId === WIKI_SEARCH_APPLICATION_ID && userVersion !== WIKI_SEARCH_SCHEMA_VERSION) resetDerivedSchema(db, userTables);
	db.exec(`PRAGMA application_id = ${WIKI_SEARCH_APPLICATION_ID}`);
	db.exec(WIKI_PAGES_DDL);
	db.exec(`PRAGMA user_version = ${WIKI_SEARCH_SCHEMA_VERSION}`);
}
/**
* User tables present in the file.
* @param db - Open handle.
* @returns Table names, excluding SQLite's own.
*/
function listUserTables(db) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map((row) => row.name);
}
/**
* Drop the tables of an older derived schema so the current one can be created.
* @param db - Open handle.
* @param userTables - Tables to drop, as listed by {@link listUserTables}.
*/
function resetDerivedSchema(db, userTables) {
	for (const name of userTables) db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`);
	db.exec("PRAGMA user_version = 0");
}
/**
* Quote a table name read from `sqlite_master` for use in DDL.
* @param value - Table name.
* @returns The name as a quoted SQL identifier.
*/
function quoteIdentifier(value) {
	return `"${value.replaceAll("\"", "\"\"")}"`;
}
/**
* Stored mtime per page identity, read once per reconcile pass.
* @param db - Open handle.
* @returns Page identity to stored file mtime.
*/
function readStoredMtimes(db) {
	const rows = db.prepare("SELECT path, mtime_ms FROM wiki_pages").all();
	return new Map(rows.map((row) => [row.path, row.mtime_ms]));
}
/**
* Bind one page to the insert statement.
* @param insert - Prepared insert over every `wiki_pages` column.
* @param entry - Page to store.
*/
function writeEntry(insert, entry) {
	insert.run(entry.title, entry.body, entry.tags.join(" "), entry.type, entry.status, entry.updated, entry.path, entry.mtimeMs);
}
/**
* Escape a literal query as an FTS5 expression.
* @param query - Query text as the caller typed it.
* @returns The escaped expression with its terms, or null when the query cannot match anything.
*/
function buildMatchQuery(query) {
	const literal = query.trim();
	if (literal.length < TRIGRAM_MIN_LENGTH) return null;
	const terms = literal.split(QUERY_SEPARATOR);
	return {
		expression: terms.map(quoteTerm).join(" AND "),
		terms
	};
}
/**
* Quote one term as an FTS5 phrase so its text is searched for rather than applied.
* @param term - Literal term.
* @returns A double-quoted phrase with embedded quotes doubled.
*/
function quoteTerm(term) {
	return `"${term.replaceAll("\"", "\"\"")}"`;
}
/**
* Rank and select the rows matching one query.
* @param db - Open handle.
* @param match - Escaped query expression and its terms.
* @param filter - Kind, tag, and status narrowing.
* @param limit - Maximum hits, already known to be a positive integer.
* @returns Ranked hits carrying an excerpt of each body.
*/
function selectHits(db, match, filter, limit) {
	const clauses = ["wiki_pages MATCH ?"];
	const parameters = [match.expression];
	if (filter.type !== void 0) {
		clauses.push("type = ?");
		parameters.push(filter.type);
	}
	if (filter.status !== void 0) {
		clauses.push("status = ?");
		parameters.push(filter.status);
	}
	for (const tag of filter.tags ?? []) {
		clauses.push("(' ' || tags || ' ') LIKE ? ESCAPE '!'");
		parameters.push(`% ${escapeLikePattern(tag)} %`);
	}
	parameters.push(limit);
	const sql = `${SELECT_HIT_COLUMNS} WHERE ${clauses.join(" AND ")} ORDER BY bm25(wiki_pages) LIMIT ?`;
	return db.prepare(sql).all(...parameters).map((row) => ({
		path: brandString(row.path),
		title: row.title,
		type: row.type,
		status: row.status,
		updated: row.updated,
		excerpt: buildExcerpt(row.body, match.terms)
	}));
}
/**
* Escape the LIKE metacharacters of a tag so it matches as plain text.
* @param value - Tag text.
* @returns The tag with `!`, `%`, and `_` escaped for `ESCAPE '!'`.
*/
function escapeLikePattern(value) {
	return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}
/**
* Bound an excerpt around the first query term the body contains.
* @param body - Complete page body.
* @param terms - Literal query terms.
* @returns Body text within the character budget, marking each cut edge with an ellipsis.
*/
function buildExcerpt(body, terms) {
	const characters = Array.from(body);
	if (characters.length <= EXCERPT_MAX_CHARACTERS) return body;
	const located = locateFirstTerm(body, terms);
	if (located === null) return `${characters.slice(0, EXCERPT_MAX_CHARACTERS - 1).join("")}${ELLIPSIS}`;
	if (located.length >= EXCERPT_MAX_CHARACTERS) return characters.slice(located.offset, located.offset + EXCERPT_MAX_CHARACTERS).join("");
	const content = EXCERPT_MAX_CHARACTERS - 2;
	const offset = located.offset - Math.floor((content - located.length) / 2);
	const start = Math.max(0, Math.min(offset, characters.length - content));
	const end = Math.min(characters.length, start + content);
	const prefix = start > 0 ? ELLIPSIS : "";
	const suffix = end < characters.length ? ELLIPSIS : "";
	return `${prefix}${characters.slice(start, end).join("").trim()}${suffix}`;
}
/**
* Find the earliest query term in a body.
* @param body - Complete page body.
* @param terms - Literal query terms.
* @returns The first match's code-point offset and length, or null when the body holds none of them.
*/
function locateFirstTerm(body, terms) {
	let first = null;
	for (const term of terms) {
		const offset = countCodePoints(body, findTermOffset(body, term));
		if (offset < 0) continue;
		if (first === null || offset < first.offset) first = {
			offset,
			length: Array.from(term).length
		};
	}
	return first;
}
/**
* Locate one term in a body, folding case as the tokenizer does.
* @param body - Complete page body.
* @param term - Literal term.
* @returns The code-unit offset of the term, or -1 when it is absent.
*/
function findTermOffset(body, term) {
	const loweredBody = body.toLowerCase();
	const loweredTerm = term.toLowerCase();
	if (loweredBody.length === body.length && loweredTerm.length === term.length) return loweredBody.indexOf(loweredTerm);
	return body.indexOf(term);
}
/**
* Convert a code-unit offset into a code-point offset.
* @param body - Complete page body.
* @param offset - Code-unit offset, or a negative value to pass through.
* @returns The number of code points before `offset`.
*/
function countCodePoints(body, offset) {
	if (offset <= 0) return offset;
	return Array.from(body.slice(0, offset)).length;
}
/**
* Whether an error came from SQLite rather than from this module.
* @param error - Caught value.
* @returns True when SQLite raised the error.
*/
function isSqliteError(error) {
	return error instanceof Error && errorCode(error) === "ERR_SQLITE_ERROR";
}
/**
* Read the string `code` an error carries.
* @param error - Error to inspect.
* @returns The code, or undefined when the error carries none.
*/
function errorCode(error) {
	if (!("code" in error)) return void 0;
	const code = error.code;
	return typeof code === "string" ? code : void 0;
}
//#endregion
//#region lib/types/service.js
/**
* The wiki vault service (`ctx.wikiVault`): opens the vault, answers the page,
* source, search, and lint operations the tools, the operator command, and the
* Web routes share, and puts the vault schema in front of the model once per
* session.
*
* The service owns no model call. Reading, synthesis, and page authoring belong
* to the model; everything here is mechanical and checkable.
* @module @prism-ai/prism-wiki
*/
/**
* Prompt-section order for the wiki protocol. `getSectionOrder()` only knows
* repository-allocated names, so this plugin claims a slot inside the tool
* guidance band, between the goal section (2400) and workflow (2600).
*/
const WIKI_SECTION_ORDER = 2550;
/** Directory the SQLite cache lives in, hidden from Obsidian and from git. */
const STATE_DIRECTORY = ".wiki";
/** Shipped protocol section: the vault's mechanics, never its domain conventions. */
const DEFAULT_PROTOCOL = [
	"A wiki vault is a persistent, interlinked body of markdown pages that is compiled once and kept current, instead of being re-derived per question.",
	"Three layers: `raw/` holds immutable sources; `wiki/` holds the pages you own; `AGENTS.md` holds this vault's conventions.",
	"Read the vault schema with `wiki_read` before authoring anything, because it carries the conventions this deployment expects.",
	"Ingest: read a source with `wiki_source`, then write or revise every page it changes with `wiki_write`. One source commonly touches several pages.",
	"Query: find pages with `wiki_search`, read them with `wiki_read`, and answer from them. A good answer is worth filing back as a page.",
	"Lint: run `wiki_lint` periodically and act on what it reports."
].join(" ");
/** A wiki operation that cannot proceed on the current configuration or vault. */
var WikiError = class extends Error {
	code;
	/**
	* @param message - Operator-facing description of the failure.
	* @param code - Stable machine-readable discriminant.
	*/
	constructor(message, code) {
		super(message);
		this.code = code;
		this.name = "WikiError";
	}
};
/**
* The markdown knowledge vault. Operations are safe to call concurrently; each
* write is atomic and each read observes a whole file.
*/
var WikiVaultService = class extends Service {
	/** Services required before the vault can be served. */
	static inject = ["systemPrompt"];
	/** Validated deployment configuration. */
	static Config = z.object({
		vaultRoot: z.string().volatile(),
		protocolSection: z.string().default(DEFAULT_PROTOCOL).volatile(),
		schemaDeliveryEnabled: z.boolean().default(true).volatile(),
		maxSearchResults: z.number().step(1).min(1).default(6).volatile(),
		maxSourceChars: z.number().step(1).min(1).default(4e4).volatile(),
		maxPageChars: z.number().step(1).min(1).default(2e5).volatile()
	});
	files;
	index;
	opening;
	/** Sessions whose next step still owes them the vault schema. */
	schemaPending = /* @__PURE__ */ new WeakSet();
	/**
	* @param ctx - Owning Cordis context.
	* @param config - Validated deployment configuration.
	*/
	constructor(ctx, config) {
		super(ctx, "wikiVault");
		this.config = config;
	}
	config;
	/**
	* Register the protocol section and the tail-frame listener.
	* @returns A promise that settles once contributions are registered.
	*/
	[Service.init]() {
		this.ctx.systemPrompt.section({
			name: "prism-wiki",
			order: WIKI_SECTION_ORDER,
			text: () => this.config.protocolSection.get()
		});
		this.ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject" || signal.aborted) return decision;
			const text = await this.takeSchemaFrame(agent);
			if (text === "") return decision;
			return {
				...decision,
				messages: [...decision.messages, createUserMessage({
					content: [{
						type: "text",
						text
					}],
					source: {
						kind: "prism-wiki",
						form: "snapshot",
						sections: [{
							name: "prism-wiki-schema",
							text
						}]
					}
				})]
			};
		});
	}
	/**
	* Mark a session as owing the vault schema, so its next step carries it.
	* @param agent - The calling session's agent, when the call has one.
	*/
	noteSchemaDue(agent) {
		if (agent === void 0) return;
		if (!this.config.schemaDeliveryEnabled.get()) return;
		this.schemaPending.add(agent);
	}
	/**
	* Read the vault schema for one session and clear the debt.
	* @param agent - The session whose step is starting.
	* @returns The frame text, or an empty string when nothing is owed.
	*/
	async takeSchemaFrame(agent) {
		if (!this.schemaPending.has(agent)) return "";
		this.schemaPending.delete(agent);
		return `<prism-wiki-schema>\n${(await (await this.ready()).readSchema()).trim()}\n</prism-wiki-schema>\nThese are this vault's conventions. Follow them for every page you write.`;
	}
	/**
	* Resolve the vault root, or fail loudly when the deployment set none.
	* @returns The absolute vault directory.
	*/
	vaultRoot() {
		const root = this.config.vaultRoot.get();
		if (root === void 0 || root === "") throw new WikiError("no vault root: set vaultRoot on the prism-wiki row, for example vaultRoot: !!js dshHomePath('knowledge')", "PRISM_WIKI_NO_VAULT_ROOT");
		return root;
	}
	/**
	* Open the vault on first use: create the layout when absent, then open the
	* search cache. Idempotent, and concurrent callers share one attempt.
	* @returns The opened vault files.
	*/
	async ready() {
		if (this.files !== void 0) return this.files;
		this.opening ??= this.open();
		return await this.opening;
	}
	async open() {
		const root = this.vaultRoot();
		const files = new VaultFiles(root);
		await files.ensureLayout();
		const index = new WikiSearchIndex(join(root, STATE_DIRECTORY, "index.db"));
		this.files = files;
		this.index = index;
		this.ctx.effect(() => async () => {
			await index.close();
		}, "prismWiki.searchClose");
		return files;
	}
	/**
	* Search the vault, reconciling the cache against the files first.
	* @param query - Literal query text.
	* @param filter - Narrowing applied on top of the query.
	* @returns Ranked hits, never more than the configured cap.
	*/
	async search(query, filter) {
		const files = await this.ready();
		const index = this.requireIndex();
		const limit = Math.min(filter.limit, this.config.maxSearchResults.get());
		await index.reconcile(await this.entries(files));
		return await index.search(query, {
			...filter,
			limit
		});
	}
	/**
	* Read one page together with its links, backlinks, and cited sources.
	* @param path - Vault-relative page identity.
	* @returns The page and its relations.
	*/
	async read(path) {
		const files = await this.ready();
		const entries = await files.listPageEntries();
		const page = await files.readPage(path);
		return {
			page,
			links: resolveLinks(page.body, entries.map((entry) => entry.page)),
			backlinks: entries.filter((entry) => resolveLinks(entry.page.body, [page]).includes(path)).map((entry) => entry.page.path),
			sources: page.frontmatter.sources
		};
	}
	/**
	* Create or replace one page, refreshing the catalog, the log, and the cache.
	* @param draft - The page to store.
	* @returns The stored page.
	*/
	async write(draft) {
		const files = await this.ready();
		const body = enforceChars(draft.body, this.config.maxPageChars.get(), "page body");
		return await files.writePage({
			...draft,
			body
		}, "write");
	}
	/**
	* List every raw source with the pages that cite it.
	* @returns One view per source, ordered by path.
	*/
	async sources() {
		const files = await this.ready();
		const paths = await files.listSources();
		const pages = (await files.listPageEntries()).map((entry) => entry.page);
		return paths.map((path) => {
			const citing = pages.filter((page) => page.frontmatter.sources.includes(path)).map((page) => page.path);
			return {
				path,
				integrated: citing.length > 0,
				pages: citing
			};
		});
	}
	/**
	* Read a bounded slice of one raw source.
	* @param path - Source identity relative to `raw/`.
	* @param maxChars - Caller-requested bound; the configured cap still applies.
	* @returns The text and whether the bound truncated it.
	*/
	async readSource(path, maxChars) {
		return await (await this.ready()).readSource(path, Math.min(maxChars ?? this.config.maxSourceChars.get(), this.config.maxSourceChars.get()));
	}
	/**
	* Register a new raw source.
	* @param path - Source identity relative to `raw/`.
	* @param text - Source text.
	* @returns The registered source's view.
	*/
	async addSource(path, text) {
		await (await this.ready()).addSource(path, enforceChars(text, this.config.maxSourceChars.get(), "source text"));
		return {
			path,
			integrated: false,
			pages: []
		};
	}
	/**
	* Report the pages already citing one source, refusing a source nothing cites.
	* @param path - Source identity relative to `raw/`.
	* @returns The citing pages.
	*/
	async confirmIntegrated(path) {
		const found = (await this.sources()).find((source) => source.path === path);
		if (found === void 0) throw new WikiError(`no such raw source: ${path}`, "PRISM_WIKI_SOURCE_NOT_FOUND");
		if (!found.integrated) throw new WikiError(`no page cites ${path} yet: write the pages this source changes, then confirm again`, "PRISM_WIKI_SOURCE_NOT_INTEGRATED");
		return found.pages;
	}
	/**
	* Health-check the whole vault.
	* @returns Counts and findings.
	*/
	async lint() {
		const files = await this.ready();
		return lintVault((await files.listPageEntries()).map((entry) => entry.page), await files.listSources());
	}
	/**
	* Vault statistics.
	* @returns Counts and the newest log heading.
	*/
	async status() {
		const files = await this.ready();
		const entries = await files.listPageEntries();
		const sources = await this.sources();
		const tail = await files.logTail(1);
		return {
			vaultRoot: this.vaultRoot(),
			pages: entries.length,
			sources: sources.length,
			pendingSources: sources.filter((source) => !source.integrated).length,
			lastLogEntry: tail[0] ?? null
		};
	}
	/**
	* Discard the search cache and rebuild it from the files.
	* @returns A promise that settles once the rebuild finished.
	*/
	async rebuildIndex() {
		const files = await this.ready();
		await this.requireIndex().rebuild(await this.entries(files));
	}
	/**
	* The newest log entry headings.
	* @param limit - How many entries to return.
	* @returns Headings, newest first.
	*/
	async logTail(limit) {
		return await (await this.ready()).logTail(limit);
	}
	/**
	* The vault schema as authored in the vault.
	* @returns The `AGENTS.md` text.
	*/
	async schema() {
		return await (await this.ready()).readSchema();
	}
	requireIndex() {
		if (this.index === void 0) throw new WikiError("the search cache is not open", "PRISM_WIKI_NOT_READY");
		return this.index;
	}
	async entries(files) {
		return (await files.listPageEntries()).map(({ page, mtimeMs }) => ({
			path: page.path,
			title: page.frontmatter.title,
			body: page.body,
			type: page.frontmatter.type,
			status: page.frontmatter.status,
			updated: page.frontmatter.updated,
			tags: page.frontmatter.tags,
			mtimeMs
		}));
	}
};
/**
* Resolve every `[[wikilink]]` in a body against a known page set, matching a
* page's path, its filename stem, or one of its declared aliases.
* @param body - Markdown body to scan.
* @param pages - Pages the links may resolve to.
* @returns Resolved page identities, de-duplicated, unresolvable links dropped.
*/
function resolveLinks(body, pages) {
	const byName = /* @__PURE__ */ new Map();
	for (const page of pages) {
		const stem = page.path.slice(page.path.lastIndexOf("/") + 1).replace(/\.md$/u, "");
		byName.set(stem.toLowerCase(), page.path);
		byName.set(page.path.replace(/\.md$/u, "").toLowerCase(), page.path);
		for (const alias of page.frontmatter.aliases) byName.set(alias.toLowerCase(), page.path);
	}
	const resolved = /* @__PURE__ */ new Set();
	for (const name of extractWikiLinks(body)) {
		const target = byName.get(name.trim().toLowerCase());
		if (target !== void 0) resolved.add(target);
	}
	return [...resolved];
}
/**
* Enforce a character bound on caller-supplied text.
* @param text - Text to bound.
* @param max - Maximum accepted length in Unicode code units.
* @param label - Name of the bounded value, used in the failure message.
* @returns The text unchanged when it fits.
*/
function enforceChars(text, max, label) {
	if (text.length > max) throw new WikiError(`${label} exceeds ${max} characters`, "PRISM_WIKI_TOO_LARGE");
	return text;
}
//#endregion
export { DEFAULT_PROTOCOL, VAULT_SCHEMA_TEMPLATE, VaultFiles, WikiError, WikiSearchIndex, WikiVaultError, WikiVaultService, WikiVaultService as default, lintVault, parsePageText, serializePageText };
