# Changelog

All notable changes to AutoBioMemory. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versions follow the package version.

## [0.2.2] — 2026-10-31

### Fixed

- **Stored events can no longer contain a template-brace pair.** The diary and every model-authored
  structured field are arbitrary prose written by a language model, so they can quote `{{variable}}`,
  `{{{` or `}}}}`. Two things went wrong downstream: a consumer that renders the text through a
  template engine aborted with `unknown prompt variable "…"` — which failed dsh's entire prompt
  assembly, not just the memory digest — and, **worse and silently**, a *registered* name was
  substituted, so `{{model}}` / `{{cwd}}` were replaced by their values and the agent's own memory
  was rewritten on the way into the prompt. `escapePromptBraces` (0.1.3) only defused the prompt
  boundary; anything else reading `events/*.md` or `structured` — another plugin, a script, a future
  consumer — still hit the same trap. Neutralisation now happens on the way to disk, so every
  consumer is safe by construction.

  `neutralizeTemplateBraces()` inserts a zero-width space (U+200B) between adjacent braces, which
  leaves the text visually identical while removing the `{{`/`}}` token. A single `{{` → `{␣{` pass
  is *not* enough — it turns `{{{` into `{␣{{`, still containing a bare `{{` (that is how the
  one-off data sweep needed two rounds) — so the implementation inserts between every adjacent pair
  in one scan, which is that iteration's fixed point. It is idempotent: neutralising twice changes no
  bytes, and a record with no brace pair is written byte-identically.

  `buildRecord` neutralises before the hash is computed, so `diaryHash` describes exactly the diary
  that is written; `.md` is byte-identical to that diary, and the vector `text_hash` matches it, so
  recall freshness tracking stays correct. `writeEventPair` applies the same neutralisation as a
  safety net for writers that bypass `buildRecord`, and re-derives the hash from what it writes.

  Untouched by design: `id`, `sources` (session ids, paths, content hashes, seq numbers, timestamps),
  `startedAt`/`endedAt`, `createdAt`/`updatedAt`, enum fields (`status`, `kind`, `basis`), `revision`,
  and the entire data-root layout. Provenance is evidence, not prose — rewriting a content hash would
  break dedupe.

- **The encoder is asked to avoid brace pairs in the first place.** The encoding guide and the
  response contract now require describing template examples in words instead of emitting literal
  `{{…}}`. That reduces needless neutralisation; it is a soft constraint, which is why storage still
  enforces it.

Historical data: events written before this release were swept once on the install side — all
`events/*.md` and the text fields of `events/*.json` now contain no bare braces, with `diaryHash`,
JSON/MD pairing and vector `text_hash` all consistent, and backups under
`~/.autobiomemory-brace-sweep-*` kept. Nothing in this release re-processes them; the guarantee here
covers everything written from now on.

### Tests

- New `tests/storage-braces.test.ts` (7 tests, 179 → 186): a fixture with `{{a}}`, `{{{`, `}}}}` and
  cross-field mixes in every prose field is written through `buildRecord` + `writeEventPair` and must
  produce an `.md`/`.json` pair with no recognisable brace pair; `diaryHash === sha256(diary)`,
  `.md === diary`, and the vector row's `text_hash` equals the same hash end to end. It also pins
  idempotency (a second neutralisation changes nothing and no double zero-width spaces appear), that
  provenance/identifiers stay byte-identical even when they do contain braces, that the `{{{` case
  resolves to a fixed point, and that a hand-built record bypassing `buildRecord` is still
  neutralised on write. Turning the helper into a no-op fails 4 of them.

## [0.2.1] — 2026-10-31

### Fixed

- **Failed sessions are retried again when their backoff expires.** The write path asked
  `state/status.json` for the failures whose `nextAttemptAt` had **passed** — the set that is due for
  a retry — and then used it as the list of sessions to *skip*. The semantics were inverted in one
  line, so a session was skipped from the exact moment it became eligible again: a skip never
  advances `nextAttemptAt`, so the entry stayed in the skip list forever, `attempts` was frozen at
  `1`, and the only way to make progress was `consolidate --force` (which bypasses the check). The
  skip list is now built from the complement (`notYetDueFailures()`); a due failure goes straight
  through the normal read → segment → encode path like any other session.
- **The poison-span safety net works again.** `consolidation.maxSpanAttempts` can only fire if a
  failing session is actually retried, which the inversion prevented: `attempts` never grew, so
  `recordSkipped` never ran and one unencodable fragment blocked its session's cursor indefinitely.
  A session that keeps failing is now given up on — span recorded, cursor advanced — after
  `maxSpanAttempts` ordinary runs.
- **A retried session that gets through leaves the failure queue.** Previously the entry (and its
  stale `attempts`) lingered even after healthy runs, so a later failure could hit the give-up
  threshold early. `attempts` now counts consecutive failures only, and a session that is simply
  caught up or empty also clears its entry.

**No `--force` needed.** An install whose queue contains expired failures heals itself on the next
ordinary run (automatic consolidation or `autobiomemory consolidate`): the sessions are attempted,
and on a repeated failure `attempts` increments until the poison span is given up on. `--force`
remains an operator override that ignores the backoff window.

`autobiomemory status` now shows how many queued failures are already due, and `state.ts` gained
`dueFailures()` / `notYetDueFailures()` (exact complements, named by intent); `pendingFailures()` is
kept as a deprecated alias of `dueFailures()`.

### Tests

- New `tests/consolidate-retry.test.ts` (7 tests, 172 → 179), all offline and all without `force`:
  an expired failure is retried (the distiller is called again and `attempts` goes 1 → 2), a
  successful retry clears the queue and advances the cursor, a poison span is given up on after
  `maxSpanAttempts` plain runs and the session keeps flowing, a not-yet-due failure is skipped (with
  `--force` still overriding), and the due/not-due split partitions the queue. Restoring the old
  inversion fails 4 of them.

## [0.2.0] — 2026-10-31

### Breaking

- **The package is now published as `autobiomemory`** (it was
  `deepseek-harness-autobiomemory`), matching its sibling `autoschema`. The published name is what a
  profile stores, so **an existing install must be migrated by hand** — adding the new name on top
  of the old one leaves a `dsh.profile.bundles` entry that no longer resolves.

  ```bash
  # 1. remove the old dependency (this also drops its `dsh.profile.bundles` entry)
  dsh plugin --profile <profile> remove deepseek-harness-autobiomemory
  # 2. add the new package: registry-style, git, or a release tarball
  dsh plugin --profile <profile> add "file:<path>/autobiomemory-0.2.0.tgz"
  # 3. restart the profile process — the bundle layer is read at startup
  ```

  `dsh.profile.bundles` must then contain `autobiomemory` and no longer mention the old name. The
  data root (`~/.autobiomemory/`), `events/*.json`, `events/*.md`, the vector index, `config.json`
  and `.env` are untouched, so memories carry over unchanged — nothing to re-encode. The plugin's
  runtime id, the composition row id (`id: autobiomemory`) and the `autobiomemory` bin were already
  named `autobiomemory`, so no composed profile tree changes shape.

### Changed

- Release assets are now named `autobiomemory-<version>.tgz`, and the install commands in the
  README, the operations manual and `AGENTS.md` use the new name.

## [0.1.3] — 2026-10-31

### Fixed

- **A diary that merely mentions `{{…}}` no longer breaks system-prompt assembly.** dsh renders a
  prompt section's text as a *template*: it interpolates every `{{name}}` group it finds, and an
  unregistered name aborts the whole assembly with
  `unknown prompt variable "{{variable}}" in section "autobiomemory:short-term"` — so one bad diary
  took down every prompt in the profile, not just the memory digest. Diary bodies are DeepSeek's
  transcription of raw transcripts, which is arbitrary prose: writing the literal string
  `{{variable}}` while explaining prompt variables is enough to poison it. A registered name was
  worse than a crash: `{{model}}` / `{{cwd}}` were silently replaced by their values, rewriting the
  agent's own memory on the way into the prompt.
  The fix is a single escape at the *memory → prompt* boundary: `escapePromptBraces()` inserts a
  zero-width space (U+200B) between adjacent braces, so the interpolator's `{{` scan no longer
  matches while the text reads identically to a human and to the model. It is applied to the
  composed section text, covering diary bodies, event titles, tool names and any future
  structured-field rendering. The escape is idempotent and only ever adds zero-width spaces.
- **Stored memories are deliberately untouched.** `events/<id>.json` and `events/<id>.md` stay
  byte-identical, so `diaryHash`, JSON/MD pair validation and vector freshness keep working; the
  escaping happens only on the way into the prompt, never on the way to disk.
- **The short-term digest no longer renders `undefined` as the tool name** when the plugin is
  applied without schema validation. The recall and consolidate tool names are now resolved once,
  from the same defaults the schema declares.

### Tests

- New `tests/prompt-escape.test.ts` (9 tests, 163 → 172) pins the invariant end to end: an event
  whose diary contains `{{model}}`, `{{cwd}}` and an unregistered `{{variable}}` still assembles
  through dsh's real `renderPrompt` without throwing; no recognisable `{{…}}` survives in the
  section; registered variables are not substituted into the diary; stripping the inserted
  zero-width spaces restores the raw text verbatim; and the files on disk are unchanged. The pure
  function is covered separately, including idempotency and runs such as `{{{`.

## [0.1.2] — 2026-10-30

### Fixed

- **Sessions written by dsh 0.2.x are discovered again.** dsh stamps the session-format version
  into the transcript filename (`session.v4.jsonl.zstd`), so the shipped default
  `**/session.jsonl.zstd` glob matched nothing: a healthy install reported `0 sessions` and
  consolidation silently did nothing. The defaults are now `**/session*.jsonl.zstd` and
  `**/session*.jsonl`, so versioned and unversioned transcripts are both found and a future
  format bump cannot hide every session again. Explicitly configured `session.includeGlobs`
  are untouched.

### Changed

- **The working tree is LF on every platform.** A new `.gitattributes`
  (`* text=auto eol=lf`) stops Git for Windows' `core.autocrlf` from checking `dist/` out as
  CRLF. Without it, `pnpm run pack:dist` on Windows shipped a `#!/usr/bin/env node\r` shebang
  and every Unix install failed with `bad interpreter`. `pack-dist.mjs` now also refuses to
  pack a CRLF-contaminated `dist/`.
- **`pnpm run check` works on pnpm 11 again.** pnpm 11 no longer reads `package.json`'s
  `pnpm.onlyBuiltDependencies`, so the run died with `ERR_PNPM_IGNORED_BUILDS` before executing
  a single test. `pnpm-workspace.yaml` now carries `allowBuilds: {esbuild: true}`.

### Tests

- The suite is platform-neutral: temporary directories come from `os.tmpdir()` and path
  assertions compare against `path.resolve(...)` instead of literal POSIX paths. The suite is
  green on Windows for the first time (162 passed / 1 skipped).
- `lists session files by glob` now places `session.jsonl.zstd` and `session.v4.jsonl.zstd` in
  one directory and asserts that the default globs return both.

## [0.1.1] — 2026-10-30

### Fixed

- **A poison span can no longer stall a session forever.** The cursor still refuses to advance
  past a span whose encode failed (that invariant is what protects against data loss), but the
  failure attempt count is now tracked per span: after
  `consolidation.maxSpanAttempts` (default `3`) consecutive failures the span is recorded under
  `state/status.json → skipped` and the cursor steps over it, so the rest of the session keeps
  flowing. Previously one unencodable fragment (e.g. a 159-char QQ group greeting, where the model
  answers with prose instead of JSON) blocked that transcript indefinitely.
- **`state/status.json` now round-trips the `skipped` map.** `loadRunState()` rebuilt the object
  field by field and silently dropped anything it did not know about.
- **`trigger.globalCooldownMs` is enforced.** It was declared in the config schema but never read;
  the effective cooldown is now `max(consolidation.cooldownMs, trigger.globalCooldownMs)`.
- **`consolidation.serialize` is honoured.** `consolidateOnce()` deduplicated concurrent calls
  unconditionally; with `serialize: false` a second run now starts instead of being folded into the
  in-flight one (span dedupe still prevents double encoding).
- **`trigger.onCompaction` / `trigger.onTurnEnd` / `trigger.onSessionStart` are honoured** by the
  plugin: `onCompaction: false` stops registering the `agent/pre-step` trigger, `onTurnEnd` enables
  the idle trigger, `onSessionStart` runs a catch-up pass on `agent/created`.
- **Skip records now appear in the run report** (`放弃片段（连续失败 N 次，游标前进）：…`) instead of
  only in the log.

### Added

- `consolidation.maxSpanAttempts` config key (default `3`) with validation.
- `SkippedSpan` entries in `state/status.json` (`sessionFile`, `spanHash`, `fromSeq`, `toSeq`,
  `attempts`, `reason`, `skippedAt`).
- `autobiomemory consolidate --retry-skipped` (optionally with `--session <file>`): forgets the skip
  marks, clears the matching span memory and rewinds each affected cursor to just before its
  earliest skipped span, so the retry can reach it.
- `autobiomemory status` reports `已放弃片段：N 条`.
- `retrySkippedSpans()` exported from the package entry point.
- 5 new tests covering poison-span give-up, skip suppression, cooldown merging and both `serialize`
  modes (163 tests total).

### Changed

- Default `deepseek.maxTokens` recommendation raised to `16000` (headroom for a 25k-character unit);
  the shipped default is unchanged, the live data root was tuned.
- `consolidation.minEventChars` recommendation raised to `300` so trivial spans are never sent.

## [0.1.0] — 2026-10-30

First working version: raw-session reading (multi-frame zstd), event segmentation, DeepSeek
first-person event encoding, paired JSON/MD storage, DashScope embeddings into a local SQLite
vector index, four-stage recall (short-term → structured → vector → rerank), dsh integration
(recall/consolidate tools, short-term system-prompt section, pre-compaction trigger), CLI, 158 tests.
