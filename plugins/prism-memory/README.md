# @prism/prism-memory

English | [中文](README.zh.md)

Prism long-term memory: durable, scope- and layer-filtered, supersede-tracked records, a cache-safe tail recall block, five model-facing tools, an operator governance command, a Web memory page, automatic distillation and consolidation, import from other tools' memory files, and a deterministic Markdown mirror.

## Summary

`@prism/prism-memory` keeps facts, decisions, pitfalls, preferences, and procedures that outlive one conversation. Records live in a `prism_memory` storage domain, so reads are synchronous from in-memory state and never block a model step; writes reach the backend before they resolve. A prepended `agent/pre-step` listener injects one bounded frame **at the request tail** when the turn has something to say.

Four things distinguish it from the usual "inject memory into the system prompt" plugin:

1. **The cached prefix is never rewritten.** See below.
2. **Claims are filed on three independent axes** — what the claim is about (`layer`), what sort of statement it is (`kind`), and who may see it (`scope`) — and the layer decides whether a claim is stated before it is mentioned.
3. **Governance is a human surface.** Approving, rejecting, restoring, retiring, expiring, consolidating, importing, and exporting are `/memory` subcommands and, for the first two, buttons on the Web memory page — never tools, so the model cannot promote its own claim and the five tool schemas that do sit in the prefix stay fixed.
4. **Memory arrives from three producers at once**: the model calling a tool, a turn being read as it closes (no extra model call), and the memory files another tool already wrote for this user.

## Design constraint: the cached prefix stays byte-stable

Every turn's request is `[system prompt][tool schemas][history]`. That whole prefix is the cache-reuse target, and rewriting any of it discards the reuse. This plugin therefore:

- puts exactly one **static** section in the system prompt (the memory protocol), whose text is re-read from configuration but never assembled per turn;
- adds no per-turn system-prompt text, no per-turn tool-schema change, and no rewriting of earlier history;
- appends **one** message per step at the tail, whatever it carries — the local date, standing memory, dated reminders, and keyword recall ride together in a single frame rather than in one message each;
- emits nothing at all when it has nothing to say, so an eligible turn is byte-identical to a turn from a build without this plugin;
- renders the same hits to the same bytes (total ordering, fixed frame, no generation timestamp, and a date rather than a clock time), so an unchanged corpus cannot cause a spurious miss;
- never re-injects a record the session already received, tracked by a `prismMemory` session projection folded from the plugin's own logged messages;
- keeps the tool surface at five definitions, and adds **zero** schemas when the governance command mounts;
- keeps the memory page off the model path: its routes and its panel add no prompt text, no tool schema, and no injected frame.

Two of those are deployment choices, and the shipped defaults keep the strong form of the claim. `orientationEnabled` is **off**, because the orientation line is the one contribution that says something on a turn with no memory behind it: with it off, an empty corpus changes nothing, and turning it on is a decision rather than a side effect of installing the plugin. `identityLayers` is **on**, but inert until the corpus holds a record on one of those layers — and a record written before the layer axis existed never is, so an upgraded store injects exactly what it injected before.

The resident L0 index (`residentIndex`) is available but **off by default**: it re-states the corpus every turn, which is a real token cost, and the same information is one `memory_search` call away.

## Use this package

Mount the bundle, then let the model call the tools. No configuration is required; every field has a shipped default.

```yaml
- name: '@prism/prism-memory'
- name: '@prism/prism-memory/tools'
- name: '@prism/prism-memory/commands'
- name: '@prism/prism-memory/web'
```

### Tools

| Tool | What the model gets |
|---|---|
| `memory_remember` | Stores one claim with kind, layer, scope, optional tags, confidence, an optional due date, and TTL; `supersedes` invalidates a replaced record in the same write, and near-duplicates come back in the result |
| `memory_search` | Ranked summaries for literal keywords, each line carrying its layer and originating session; an empty query lists the most recent memories, and `conversation` narrows to one session |
| `memory_open` | One record in full, with attribution and the chain of claims it replaced or was replaced by |
| `memory_forget` | Retires one record so it stops being recalled; the record is retained, not deleted |
| `memory_conversations` | The conversations that contributed memory, how much each holds, and their newest claims |

Five tools is a deliberate bound: tool schemas sit in the cached prefix and are paid for on cold start and on every profile switch.

### The operator command

`/memory` is where a human decides things a model must not decide for itself. It costs no tool schema, so it cannot bloat the prefix, and the model has no way to call it.

| Subcommand | Effect |
|---|---|
| `/memory status` | Counts by status, scope, layer, and kind (also the default with no argument) |
| `/memory remember <text>` | Store one claim of your own, with no model turn; prints the id it landed on |
| `/memory search <query>` | Ranked claims with layer, kind, scope, and originating session; an empty query lists the most recent |
| `/memory review [limit]` | The review inbox: records held back until approved, newest first |
| `/memory approve <id> [note]` | Promote one pending record to active |
| `/memory reject <id> [reason]` | Archive one pending record |
| `/memory forget <id> [reason]` | Retire one live claim so it stops being recalled; the record is retained |
| `/memory show <id>` | One record with attribution, dates, tags, corroboration, and its supersede chain |
| `/memory restore <id> [reason]` | Roll a record back to current |
| `/memory conversations [limit]` | Browse the corpus by originating conversation |
| `/memory maintain [apply]` | Hygiene pass; a dry run unless `apply` is given |
| `/memory dream [apply]` | Consolidation pass; a dry run unless `apply` is given |
| `/memory journal [limit]` | The consolidation journal and the daily reflections |
| `/memory import [apply] [sources]` | Read other tools' memory files; a dry run unless `apply` is given |
| `/memory export [dir]` | Write the Markdown mirror and its JSON index |

### The memory page

`@prism/prism-memory/web` registers four exact Fetch routes under `/api/prism-memory` — `overview`, `search`, `remember`, and `review` — each answering one `{ ok, value }` envelope. The three that carry a body validate it with zod; `overview` reads none. The browser half renders them as one panel in the sidebar: counts over the store, a keyword search, an add form, the review inbox with approve and reject handed out oldest decision first, and the live claims.

A page has no calling session, so it reads and settles through the service's operator surface — `operatorRecords`, `operatorSearch`, `operatorApprove`, and `operatorReject`, none of them narrowed by scope. Every row renders its own scope, so the narrowing stays visible where the decision is made. Model-facing callers are unchanged: a tool passes the agent it runs in and `/memory` passes the one it was invoked from, and both are still filtered by them.

A claim the page stores is `global`, because there is no session to derive a project or conversation scope from — so a `user` or `rule` claim added there is stated on every session's first turn. Retiring it is `/memory forget <id>`, the only human retraction for a live claim.

The row declares `webServer`, so a profile that composes no Web server leaves it pending rather than failing to load. The browser bundle is one module-loader closure that requests React and the shared primitives as baseline modules instead of inlining a second copy of either.

## The layer axis

A claim is filed on three axes, and each answers a different question: `layer` (what it is about), `kind` (what sort of statement it is), and `scope` (who may see it).

| Layer | What it is about |
|---|---|
| `soul` | Stable settings of the assistant itself: persona, language, working style |
| `user` | The person: preferences, habits, how they want to be spoken to |
| `project` | This working directory: layout, conventions, current state |
| `fact` | An objective fact about the world or the code |
| `lesson` | A mistake made and what it taught |
| `topic` | Domain knowledge worth recalling on its own terms |
| `rule` | A hard constraint: something that must or must not happen |

Two behaviours are attached to the axis rather than to each record:

- **Layers decide the always-on set.** Records on a layer named in `identityLayers` (default `soul`, `user`, `rule`) are injected on a session's first turn without waiting for a keyword match, because a preference or a constraint is relevant before it is mentioned.
- **Layers weight relevance.** A matched `rule` or `lesson` outranks a matched `fact` of the same wording.

A record that declares no layer — every record written before this axis existed — is ranked as `fact`. That default is deliberately a *relevance* layer and not an identity one: defaulting a legacy record into an always-on layer would change what an upgraded corpus injects.

## Retrieval

Ranking is BM25 over a literal tokenizer that handles ASCII words and CJK characters with adjacent bigrams (no segmenter, and no embeddings — see limitations).

Three properties do the work. A term's weight falls as more records contain it, so a claim is found by what distinguishes it. Repetition inside one record saturates, so a record is not ranked up for saying the same word three times. And a longer record is discounted, so a verbatim phrase in a short claim outranks the same phrase buried in a paragraph. `bm25K1` and `bm25B` are the two knobs; `k1: 0` disables frequency weighting and `b: 0` disables length normalization.

The score is normalized by the square root of the query's own term weight. The square root rather than the sum is deliberate: a user's message is long and mostly incidental, so dividing by its full weight would score a record that matches the one term that matters as badly as one that matches nothing. The shipped floor `minInjectScore: 0.6` is comparable with the pre-BM25 ranker's, so upgrading does not silently stop recalling what used to be recalled.

## Automatic memory

Three producers write without a tool call. None of them can put an unreviewed claim in front of a model: distillation and import default to `pending`, which never injects and is reviewed only by `/memory approve` or `/memory reject`.

### Distillation, on the turn's own path

An `agent/turn-stopping` listener reads the turn that just closed — the person's message and the assistant's own account — and extracts sentences that state something durable: a constraint ("must never…", "禁止…"), a preference ("I prefer…", "以后都…"), an established cause ("the root cause was…", "根因是…"), or a convention of this workspace.

There is no model call in this path. It costs nothing per turn and is deterministic for identical text, which is why it can run on every turn rather than behind a scheduler. It also never inflates the reuse counter: a claim the corpus already holds is dropped instead, because `hits` is read as evidence that a human or a model actually reached for a record.

The trade is stated plainly: a form-recognizing reader has false negatives (a claim phrased some other way is missed) and false positives (a sentence that reads like a constraint but is not). The false positives are why the shipped status is `pending`.

### Consolidation, on a window

An `agent/turn-stopping` listener also runs a consolidation pass once the corpus has moved far enough. The window boundary is the corpus itself — the last journal entry's write time — rather than a private counter, so it survives a restart, a fork, and a second process reading the same store.

The pass concludes three things and refuses a fourth:

- **Corroboration.** A claim written from more than one conversation has survived more than one chance to be wrong. The write path records this when an identical claim arrives from a different session; the pass confirms those claims by stamping `corroboratedAt`. It does not touch `confidence`: the certainty a claim carries is its author's statement, and a background pass raising it would be inventing evidence.
- **Topic digests.** Claims that keep returning under one recall tag become a single `topic` record listing them, so later recall has one entry point instead of N. A digest is written `pending`: it is machine-written prose about other records, and a wrong index entry would misdirect every recall through it.
- **A journal.** Each pass writes one archived entry naming what it found, and each completed local day with activity writes one reflection. Both are deterministic, so the journal reads as a diff.
- **Contradictions are reported, never resolved.** Two live claims that share a recall tag and overlap in wording without saying the same thing are surfaced for a person. Choosing between two claims is a judgement, and a wrong automatic choice is worse than an open question.

Nothing here deletes. Consolidation that archives is `/memory maintain`, which stays a separate operator action.

### Dates

A record may carry a due date, distinct from its expiry. An expiry retires a claim; a due date keeps it live and surfaces it as a reminder once the date arrives, within `reminderWindowDays`. This is the plugin's whole reminder surface: it is memory that has become actionable, not a scheduler.

### Importing another tool's memory

`/memory import` reads layouts this plugin knows by id — `claude-code`, `mimocode`, `cursor`, and `workspace` (the calling workspace's `AGENTS.md` / `CLAUDE.md`) — and turns their headings and list items into claims. A file's headings decide the layer where they name one, and the layout decides the scope. Every read is bounded by file count, file size, and depth, and a missing root or an unreadable directory is an ordinary outcome rather than a failure: these directories belong to other tools.

Nothing is read unless a layout is named. `importSources` is empty by default, so another tool's memory is never enumerated behind the user's back.

A claim the corpus already holds is counted as skipped rather than stored again — including a claim this importer itself parked for review, and one an operator has since archived, so a retired claim is not resurrected by the next run.

## Governance and library hygiene

- **Review inbox.** With `requireApproval`, or for any write below `pendingBelowConfidence`, a claim is stored as `pending`. Injection and search visibility are separate decisions: a pending record never injects and is never counted as live, but `memory_search` returns it — under **every** configuration, `requireApproval` included — so the model can always find a claim it wrote, whatever confidence it carried. Settling the review is only `/memory approve` or `/memory reject`, neither of which the model can call; `/memory forget <id>` archives any claim it is given, a pending one included, without recording a review decision.
- **Two-time records.** Every record carries `validAt` and `invalidAt`. Superseding, expiring, merging, and forgetting all invalidate rather than delete, so an old answer stays auditable while only the current claim injects.
- **Rollback.** `/memory restore` re-activates a record and archives a live successor, recording the rollback in the successor's evidence.
- **Maintenance.** `/memory maintain` reports what it would do and writes nothing until `apply`: live records past their deadline are archived, near-duplicates at or above `dedupeJaccard` are merged into the record a reader would keep (higher confidence, then newer), archived records are evicted when the store is at capacity, and supersede links that no longer resolve are reported.
- **Deterministic mirror.** `/memory export` writes `memory.md` and `memory.index.json` with a full write to a sibling temporary path and a rename. Identical corpora produce identical bytes, so the mirror is commit-able and a `git diff` shows only real memory changes.

## The second layer: a durable session-history index

Distilled claims answer "what do we know". They do not answer "what was concluded in that conversation we had about X", where a keyword match over summaries often misses. The harness already ships that read path — the `sessionQuery` service and, where its tool package is installed, the five `session_*` tools. What it ships **disabled** is the index underneath them. The second patch file turns it on:

```yaml
# session-search.patch.yml
- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-search.db')
    openAt: first-search
```

The shipped base and Web layers mount `session-query-sqlite` with `path: ':memory:'` and `openAt: never`, so ranked content search is off and `node:sqlite` is never imported. This layer gives that index a durable file under the Harness home and defers the import to the first search, which keeps startup quiet.

**This bundle deliberately mounts no tool.** `@deepseek-ai/dsh-tool-session-query` is not part of every Harness installation — the bundled desktop runtime ships the `session-query` service and its SQLite provider but not the tool package — so a row naming it fails to import on every boot of a runtime that lacks it. Where that package *is* installed, mount it from the deployment's own patch layer:

```yaml
# the deployment's patch, not this bundle's
- insert:
    - id: tool-session-query
      name: '@deepseek-ai/dsh-tool-session-query'
```

That row is what puts `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, and `session_event_read` in front of the model. Its authority is the harness's own: cross-session access requires the target session's `cwd` to equal the caller's exactly.

The two layers meet through attribution: `memory_search` and `memory_conversations` render the originating session id on every line, so a claim can be traced back into that conversation's original messages.

Drop `./session-search.patch.yml` from this package's `dsh.bundle.patch` list to keep the shipped ephemeral index; the memory rows are unaffected. The cost of keeping it is the derived database alone.

### Scope and authority

Scope is derived from the immutable calling session, never from model-supplied arguments:

| Scope | Stored key | Visible to |
|---|---|---|
| `global` | `''` | every session |
| `project` | the session's `cwd` | sessions with that exact working directory |
| `conversation` | the owning session id | that session only |

A record outside the caller's scope is not merely ranked lower; it is filtered out before ranking, and every by-id operation rejects it with `PRISM_MEMORY_OUT_OF_SCOPE`. The one narrowing the model may request — `memory_search`'s `conversation` argument — can only reduce the caller's visible set, never widen it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `protocolSection` | shipped protocol | Static system-prompt text describing the tools |
| `injectEnabled` | `true` | Whether the pre-step listener may inject |
| `maxInjectedRecords` | `3` | Records per injected block, keyword-matched recall included |
| `maxInjectedChars` | `900` | Character cap on the whole injected frame |
| `minInjectScore` | `0.6` | Relevance floor for keyword recall |
| `residentIndex` | `false` | Inject the L0 index when no record matched |
| `maxIndexChars` | `600` | Character cap on the L0 index |
| `searchLimit` | `6` | Hard cap on `memory_search` results, including a model-requested `limit` |
| `maxTextChars` | `2000` | Stored text cap |
| `maxTags` | `8` | Stored tag cap |
| `maxRecords` | `5000` | Store cap; a write at the cap evicts the oldest archived record, and fails with `PRISM_MEMORY_FULL` when there is none |
| `requireApproval` | `false` | Route every write through `pending`; a pending record never injects but stays searchable |
| `pendingBelowConfidence` | `0.5` | Writes below this confidence become `pending`; a pending record never injects but stays searchable |
| `dedupeJaccard` | `0.85` | Floor at which a write reports a near-duplicate, and the floor `maintain` merges at |
| `dedupeReplaceJaccard` | `0.97` | Floor at which a write is treated as an identical claim and not stored twice |
| `autoTag` | `true` | Derive recall tags for a write that supplied none |
| `defaultTtlDays` | `0` | Expiry for writes that request none; `0` means never |
| `exportDir` | unset | Default mirror directory; `/memory export <dir>` overrides it, and an absent value fails loud with `PRISM_MEMORY_NO_EXPORT_DIR` |
| `identityLayers` | `[soul, user, rule]` | Layers recalled on a first turn without a keyword match, in injection order; `[]` turns the always-on path off |
| `maxIdentityRecords` | `4` | Records the always-on path may inject per first turn |
| `bm25K1` | `1.2` | Term-frequency saturation; `0` disables frequency weighting |
| `bm25B` | `0.75` | Document-length normalization; `0` ignores length |
| `injectEveryStep` | `false` | Recall on a turn's later steps too, when that step admitted new user text |
| `orientationEnabled` | `false` | Inject the local date, weekday, and greeting on a first turn |
| `reminderEnabled` | `true` | Surface records whose due date has arrived |
| `reminderWindowDays` | `7` | How far ahead a due date is surfaced |
| `maxReminders` | `3` | Reminders injected per first turn |
| `autoDistill` | `true` | Read each turn's own text for durable claims |
| `autoDistillStatus` | `pending` | Status a distilled claim is written with |
| `autoDistillConfidence` | `0.4` | Confidence a distilled claim is written with; below the review floor, so it parks |
| `autoDistillLimit` | `3` | Claims one turn may contribute |
| `dreamEnabled` | `true` | Run the consolidation pass on a window |
| `dreamEveryWrites` | `25` | Claims written since the last pass before another runs |
| `dreamWindowRecords` | `200` | New-material records one pass compares against the corpus |
| `dreamConflictFloor` | `0.5` | Similarity floor at which two live claims count as comparable but disagreeing |
| `dreamClusterFloor` | `3` | Claims sharing a tag before that tag earns a digest |
| `dreamMaxTopics` | `3` | Digests one pass writes |
| `dailyReflection` | `true` | Write one account per completed local day that wrote something |
| `importSources` | `[]` | External layouts `/memory import` may read; none is read unless named |
| `importStatus` | `pending` | Status an imported claim is written with |
| `importConfidence` | `0.6` | Confidence an imported claim is written with |

`dedupeReplaceJaccard` below `dedupeJaccard`, an unknown or repeated name in `identityLayers`, `dreamClusterFloor` below `2`, and an unknown name in `importSources` all fail plugin load. Every field is volatile, so it is editable from the running configuration surface.

## Record model

```
id            mem_<uuid>
scope         global | project | conversation
scopeKey      '' | cwd | session id
kind          fact | decision | pitfall | preference | procedure
layer         soul | user | project | fact | lesson | topic | rule (absent ⇒ ranked as fact)
text          one self-contained claim, ≤ maxTextChars
tags          lowercase keywords, ≤ maxTags
status        active | pending | superseded | archived
confidence    0..1
createdAt     epoch ms
updatedAt     epoch ms
validAt       epoch ms, or null
invalidAt     epoch ms, or null
expiresAt     epoch ms, or null
dueAt         epoch ms, or null
supersedes    memory id, or null
supersededBy  memory id, or null
origin        model | operator | session | import
reviewedAt    epoch ms, or null
reviewNote    operator note, or null
mergedInto    memory id this record was folded into, or null
restoredAt    epoch ms, or null
corroborations  times an identical claim arrived from another conversation
corroboratedAt  epoch ms a consolidation pass confirmed it, or null
evidence      { sessionId, messageId, note }
hits          reuse count, incremented by memory_open
```

The domain stays at version 1. Every field any later layer added is optional in the record schema, so a store written by an earlier build reopens under the current schema instead of being rejected or discarded: `per-record` layouts validate each stored document, and a required new field would have made every pre-existing record invalid.

Records this plugin writes for itself — journal entries, reflections, and topic digests — carry a `dream-journal`, `dream-reflection`, or `dream-topic` tag and a status that keeps them out of injection and out of search. They are readable through `/memory journal` and visible in the export mirror.

## Model Experience

### System prompt

One fixed section, `prism-memory`, at order 2500, resolved from `protocolSection` on every assembly. Its bytes do not change while configuration and the plugin stay unchanged. It names the layer axis, because a model cannot use a field it has not been told about. Token effect: one short paragraph per request. KV-cache effect: prefix-stable.

### Tool schemas

Five fixed schemas are sent on each request while visible. Mounting the governance command adds none. Token effect: five short schemas. KV-cache effect: prefix-stable while tool visibility and definitions are unchanged.

### Injected frame

The model sees at most one additional user-role message per step, and only when a section has something to contribute:

```
<prism-memory>
Good evening. Today is Monday, 2026-10-05 (evening, local time).
Standing memory:
- [mem_…] (user, preference, 2026-09-14) prefers short answers with no preamble
Due now (a date recorded earlier has arrived):
- [mem_…] (project, decision, 2026-10-01) rotate the staging credentials
Possibly relevant memory:
- [mem_…] (lesson, pitfall, 2026-09-30) the root cause was a stale build cache
</prism-memory>
Treat memory as background: verify before relying on it, and call memory_search or
memory_open when the exact record matters.
```

Sections that have nothing to contribute are omitted, so a turn carrying only a greeting has no memory headings. Token effect: bounded by `maxInjectedChars`, absent when every section is empty. KV-cache effect: append-only at the tail; it becomes reusable prefix on the following turn and never invalidates earlier cache entries.

### Turn-end passes

Distillation and consolidation write records and append no message, so they are invisible to the model in the turn that triggers them. What they wrote becomes visible later, through recall or through the tools, exactly as any other record would. Token effect on the triggering turn: none.

### The memory page

Token effect: none. The page reads and writes through its own routes, and what it settles — an approved claim, a stored one — reaches the model only through the injection and search paths that were already there. KV-cache effect: none, because nothing on this path is part of a request.

## Verification

```sh
node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit          # host face against the checkout's declarations
node ../../node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit   # browser face against the DOM library
node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts       # 178 specs over the real services
node ../../node_modules/.bin/tsdown --config tsdown.config.ts                 # emit lib/
node scripts/smoke.mjs                                                        # artifact plane
```

The specs drive production services — the storage hub with its SQLite backend, the domain facility, the session store, the system-prompt registry, the session-projection registry, the tool runtime, and the agent loop — so an assertion about memory is an assertion about what the model sees.

`tests/cache-safety.spec.ts` is the suite for this package's central claim: an unmatched turn adds no message, a matched turn appends exactly one message after an untouched prefix, the block is deterministic for a fixed corpus, a delivered record is never repeated, the block respects its character budget, the five tool schemas are byte-stable across reads, and mounting the governance command adds no schema.

`tests/automatic.spec.ts` is the suite for the automatic half: a turn's own text is distilled without a model call and parked for review, a repeated claim is not stored twice and does not inflate its reuse count, the consolidation window opens on the corpus rather than on a counter, a contradiction is reported and both claims survive, standing memory arrives without a keyword match, a due date surfaces, and an import reads a workspace file into project-scoped claims without duplicating what it already read.

`tests/commands.spec.ts` is the suite for the operator command surface: every case types a `/memory` line into the real command runtime and reads the settled result, so a `remember` that stored nothing, a `search` that rendered the wrong line, or a subcommand that stopped resolving fails there.

`tests/web.spec.ts` and `tests/web-composition.host.spec.ts` are the suites for the browser routes: one drives every route through the objects it registers and asserts the envelopes, the body validation, and the operator surface behind them; the other boots the row through the real Loader over a real web server and Connection, and asserts it stays pending — never failed — in a profile that composes neither. `tests/client/api.spec.ts` covers the browser request client's own decoding, including the case where the host answers something it cannot read.

## Known Limitations and Deferred Work

- **No embeddings.** Ranking is BM25 over literal tokens (ASCII words plus CJK characters and bigrams). Paraphrase recall is weak; there is no reranker and no vector index. The harness ships no embedding provider, so a vector path would need one first.
- **The memory corpus is not FTS-indexed.** Records live in a storage domain and are ranked in memory, which keeps retrieval synchronous and I/O-free on the model path. That is the right trade below the `maxRecords` cap; above it, or once paraphrase recall matters more than latency, a `node:sqlite` FTS5 index over the same records is the next step.
- **Distillation recognizes sentence forms, not meanings.** It is a regex table. A durable claim phrased some other way is missed, and a sentence that reads like a constraint without being one is captured. Both are why the shipped status is `pending`; a deployment that raises `autoDistillStatus` to `active` is accepting the false positives into injection.
- **Contradiction detection is a heuristic.** It requires a shared recall tag and a similarity band, so it misses contradictions phrased with different words and can flag two nuanced claims about one subject. It only ever reports; nothing is resolved automatically.
- **The daily reflection reports a completed day, so it appears the day after.** A session that runs for weeks without a local midnight rollover never produces one.
- **Consolidation runs on the turn's path.** The pass is bounded by `dreamWindowRecords`, but it is awaited before the turn closes, so a very large corpus makes the turn that crosses the window slower.
- **A turn-end pass failure is part of the turn.** Distillation and consolidation propagate their errors rather than swallowing them, on the principle that a broken store should be loud. A deployment that would rather lose a pass than fail a turn should widen the catch at its own layer.
- **The corpus is held in memory.** Every record is resident in the domain's synchronous state, bounded by `maxRecords` but not by bytes.
- **`hits` counts explicit opens only**, so reuse weighting is a weak signal. Distillation deliberately does not touch it.
- **The maintenance and consolidation passes are not scheduled.** They run on the turn path and on operator command; a deployment that wants them at a fixed hour needs a schedule row pointing at `/memory maintain apply` or `/memory dream apply`.
- **The page adds and settles; it does not edit.** Rewriting a claim is `memory_remember` with `supersedes`, and retiring a live record is `/memory forget <id>`; the panel offers neither, so an edit made there would have no audit story.
- **The page's overview reads the whole store on each write.** That is bounded by `maxRecords` and correct for the corpus sizes this store is designed for; a store near that cap would want a paged read first.
- **The four operator methods are un-narrowed public service methods.** No model-facing caller can reach them, and `maintain`, `dream`, `importMemories`, and `exportMarkdown` were already whole-store, so this adds no new authority class — but any plugin that injects `prismMemory` can read the whole corpus, and the type does not say so beyond the name.
- **The page has no component spec.** The bundle declares no React runtime of its own and the plugin's Vitest config sets no jsdom environment, so the page is covered only by the route suites, the request-client spec, and the smoke test that loads the bundle and runs its `apply`.
- **The model-facing session tools are not in this bundle.** `session-search.patch.yml` turns on the durable `sessionQuery` index, but mounting `@deepseek-ai/dsh-tool-session-query` is the deployment's decision, because that package is not part of every Harness installation. Without that row the model can still reach a claim's originating session through `memory_search`'s attribution, but it has no tool that reads session history directly.
- **Import layouts are hardcoded by id.** Adding a tool means adding an entry to `IMPORT_SOURCES`; there is no configuration format for a custom layout.

## Installation

The bundle is a profile-layer install: place the package where the profile resolves bundles, add it to the profile's `dsh.profile.bundles`, and restart. No global dependency and no external service is required; the domain routes through the profile's configured storage backend, and the two schema libraries (`zod`, `@deepseek-ai/schemastery`) plus the harness seams resolve from the profile as they do for the harness's own plugins.
