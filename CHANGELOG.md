# Changelog

All notable changes to AutoBioMemory. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/), versions follow the package version.

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
