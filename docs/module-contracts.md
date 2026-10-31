# AutoBioMemory — module contracts

Every feature branch implements exactly the signatures below. Shared vocabulary lives in
`src/types.ts` and `src/constants.ts` (already on `main`). Do not change those files without
coordination: other branches compile against them.

Conventions for every module:

- ESM TypeScript, `strict` + `noUncheckedIndexedAccess`, no `any` in exported signatures.
- Node built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:zlib`, `node:sqlite`, `node:os`).
  No new runtime dependencies.
- All file writes are atomic (`util.writeTextFileAtomic`).
- Network calls accept an `AbortSignal` and honour a timeout.
- Never log API keys.
- Every module must be importable in a plain Node process (no dsh runtime required), so the CLI and
  the tests can drive it. Only `src/plugin.ts` imports `@deepseek-ai/*`.

Harness-agnostic seams: `Embedder`, `Reranker`, `Distiller` (see `types.ts`) are the injection
points tests use instead of the network.

---

## src/util.ts — pure helpers

```ts
export function sha256(input: string | Buffer): string
export function shortHash(input: string | Buffer, length?: number): string   // default 8
export function nowIso(): string                                             // new Date().toISOString()
export function toIso(ms: number): string
export function parseIso(value: unknown): number | undefined                 // undefined-safe ISO/epoch parse
export function beijingIso(ms: number): string      // 2025-10-30T16:45:12+08:00
export function beijingStamp(ms: number): string    // 2025-10-30 16:45:12 (北京时间)
export function truncate(text: string, max: number): string
export function collapseWhitespace(text: string): string
export function slugify(text: string, max?: number): string
export function ensureDir(dir: string): void
export function readJsonFile<T>(file: string): T | undefined                 // undefined on ENOENT/parse error
export function writeJsonFile(file: string, value: unknown): void            // atomic, 2-space JSON + newline
export function writeTextFileAtomic(file: string, text: string): void        // atomic
export function sleep(ms: number, signal?: AbortSignal): Promise<void>
export function clampNumber(value: number, min: number, max: number): number
export function isRecord(value: unknown): value is Record<string, unknown>
export function asStringArray(value: unknown): string[]
export class AbortError extends Error {}
export function throwIfAborted(signal?: AbortSignal): void
export function asyncPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]>
```

## src/logger.ts

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface LoggerOptions { level?: LogLevel; sink?: (line: string) => void }
export function createLogger(options?: LoggerOptions): Logger      // stderr by default, prefix `[autobiomemory]`
export function silentLogger(): Logger
```

## src/paths.ts — data root layout

`MemoryPaths` is declared in `src/types.ts`; `paths.ts` re-exports it and fills it in.

```ts
export type { MemoryPaths } from './types.js'

/** Precedence: explicit override → DSH_AUTOBIO_ROOT → AUTOBIO_ROOT → ~/.autobiomemory */
export function resolveDataRoot(override?: string): string
export function memoryPaths(root?: string): MemoryPaths
export function ensureDataLayout(paths: MemoryPaths): MemoryPaths   // mkdir -p events/vectors/state/logs
export function eventPair(paths: MemoryPaths, id: string): { json: string; md: string }
```

## src/env.ts — secrets in `<root>/.env`

`SecretSource` is declared in `src/types.ts`; `env.ts` re-exports it.

```ts
export type { SecretSource } from './types.js'
export function parseDotEnv(text: string): Record<string, string>
export function readSecrets(paths: MemoryPaths, processEnv?: NodeJS.ProcessEnv): SecretSource
export function writeEnvFile(
  paths: MemoryPaths,
  secrets: { deepseekApiKey: string; dashscopeApiKey: string },
  options?: { overwrite?: boolean },
): { written: boolean; path: string }   // 0600 perms, preserves unrelated lines when overwriting
export function requireSecret(secrets: SecretSource, which: 'deepseek' | 'dashscope'): string
```

Precedence for each key: `.env` entry first (`DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`), then
`AUTOBIO_*` prefixed process-env vars, then plain process-env vars. `.env` must win so the data
root stays the source of truth.

## src/config.ts

```ts
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }
export function defaultConfig(dataRoot?: string): MemoryConfig
export function mergeConfig(base: MemoryConfig, patch?: DeepPartial<MemoryConfig>): MemoryConfig
export function validateConfig(config: MemoryConfig): string[]            // [] means valid
export function loadConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig
export function ensureConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig  // writes when absent
export function writeConfig(paths: MemoryPaths, config: MemoryConfig): void
export function expandSessionDirs(config: MemoryConfig, cwd: string): string[]  // absolute, `~` expanded, deduped
```

Defaults must match `types.ts` docs: `session.readDirs = ['~/.dsh/sessions']`,
`includeGlobs = ['**/session*.jsonl.zstd', '**/session*.jsonl']`, `deepseek.baseUrl =
'https://api.deepseek.com'`, `deepseek.model = 'deepseek-chat'`, `dashscope.region = 'beijing'`,
`dashscope.baseUrl = 'https://dashscope.aliyuncs.com'`,
`dashscope.embeddingModel = 'text-embedding-v4'`, `dashscope.embeddingDimensions = 1024`,
`dashscope.rerankModel = 'gte-rerank-v2'`, `retrieval.finalLimit = 5`,
`retrieval.shortTermCount = 8`, `consolidation.recentEventLimit = 20`,
`consolidation.maxInputChars = 60000`, `consolidation.tailRecords = 6`,
`consolidation.cooldownMs = 60000`, `trigger.toolName = 'autobiomemory_recall'`.

`validateConfig` must reject: empty `readDirs`, `embeddingDimensions` outside 64..2048,
`consolidation.maxRecordsPerEvent < session.minRecordsPerEvent`, non-`http(s)` base URLs, negative
limits. Unknown extra keys in `config.json` are preserved, not rejected.

## src/state.ts — cursor + run state

```ts
export function loadCursor(paths: MemoryPaths): CursorState
export function saveCursor(paths: MemoryPaths, state: CursorState): void
export function getSessionCursor(state: CursorState, sessionFile: string): SessionCursor | undefined
export function putSessionCursor(state: CursorState, cursor: SessionCursor): void
export function loadRunState(paths: MemoryPaths): RunState
export function saveRunState(paths: MemoryPaths, state: RunState): void
export function failureKey(kind: FailureEntry['kind'], target: string): string
export function recordFailure(state: RunState, kind: FailureEntry['kind'], target: string, error: unknown, options?: { retryDelayMs?: number }): FailureEntry
export function clearFailure(state: RunState, kind: FailureEntry['kind'], target: string): void
export function isCoolingDown(state: RunState, cooldownMs: number, nowMs?: number): boolean
/** Failures whose backoff has elapsed — retry these now. */
export function dueFailures(state: RunState, nowMs?: number): FailureEntry[]
/** Failures still inside their backoff window — leave these alone. */
export function notYetDueFailures(state: RunState, nowMs?: number): FailureEntry[]
/** @deprecated Alias of dueFailures(); the name is ambiguous. */
export function pendingFailures(state: RunState, nowMs?: number): FailureEntry[]
```

Cursor map is keyed by absolute session file path. `recordFailure` increments `attempts` and sets
`nextAttemptAt` with exponential backoff (base `retryDelayMs ?? 30_000`, capped at 30 min).

`dueFailures` and `notYetDueFailures` are exact complements, and callers must pick by intent:
`notYetDueFailures` is what a run **skips**, `dueFailures` is what a run **processes**. Using the
due set as a skip list is what once deadlocked retries (a due entry was skipped forever because
skipping never advanced `nextAttemptAt`). An unparsable `nextAttemptAt` counts as due so a corrupt
timestamp cannot wedge a session either.

## src/session-reader.ts — raw transcripts, read in place

```ts
export interface DecodedFrames { text: string; frames: number; consumedBytes: number }
/** Decode a concatenation of complete zstd frames (dsh appends one frame per write). */
export function decodeZstdFrames(buffer: Buffer): DecodedFrames
export function listSessionFiles(readDirs: string[], includeGlobs: string[], excludeGlobs: string[]): string[]
export function normalizeRecords(lines: string[]): RawRecord[]
export function readTranscript(sessionFile: string): SessionTranscript
/** Records strictly after `cursor.processedRecords`. */
export function pendingRecords(transcript: SessionTranscript, cursor?: SessionCursor): RawRecord[]
export function renderRecords(records: RawRecord[], maxChars?: number): { text: string; chars: number; truncated: boolean }
export function sessionIdFromPath(file: string): string
export function spanHash(records: RawRecord[]): string
```

`decodeZstdFrames` must walk real zstd frame headers (magic `0xFD2FB528`) instead of trusting
`zlib.zstdDecompressSync` on concatenated buffers (it only decodes the first frame). Stop cleanly at
a trailing partial frame and report `consumedBytes`; never throw on a torn tail.

`normalizeRecords` maps dsh session event log records onto `RawRecord`:

| session `type` | RawRecord.kind | notes |
| --- | --- | --- |
| `session` | `meta` | session id, `cwd`, `createdAt` |
| `user/message` | `user` | join text blocks of `data.content`; de-duplicate by message `id` |
| `agent/inbox/spliced` | `user` | `data.inserted[]` entries, same de-dup by `id` |
| `assistant/message` | `assistant` | text blocks of `data.message.content` |
| `tool/call` | `tool-call` | `data.name`, `data.arguments` (compact, truncate 400 chars) |
| `tool/result` | `tool-result` | flatten text blocks, truncate 1200 chars, keep `isError` |
| `compaction/start` / `compaction/summary` / `compaction/end` | `compact` | summary text when present |
| `goal/change`, `todo/write`, `session/title` | `system` | one-line rendering |
| `*-chunk`, `*chunks`, `assistant/chunk` | skipped | streaming deltas are noise |
| `turn/start`, `turn/end`, `step/start`, `step/end` | `meta` | update the turn counter |
| anything else | `other` | skipped by the renderer but counted |

`seq` is the 1-based line index in the decoded transcript; `turn` the turn counter at that point.
`renderRecords` produces the first-person-facing transcript handed to DeepSeek:

```
[3] 2025-10-30 16:45:12 用户：…
[5] 2025-10-30 16:45:31 我调用工具 bash：{"command":"ls"}
[6] 2025-10-30 16:45:32 工具结果 bash（失败）：…
```

Moonshot Chinese punctuation is expected; keep the format line-oriented and stable (tests assert it).

## src/units.ts — event segmentation

```ts
export interface UnitOptions {
  minRecordsPerEvent: number
  maxRecordsPerEvent: number
  maxInputChars: number
  minEventChars: number
  tailRecords: number
}
export function unitOptionsFromConfig(config: MemoryConfig): UnitOptions
export function buildUnits(
  transcript: SessionTranscript,
  options: UnitOptions,
  cursor?: SessionCursor,
): EventUnit[]
```

Rules: consume only `pendingRecords`; start a unit at a `user` record; never end between a
`tool-call` and its `tool-result`; close a unit when the next `user` record starts, or when adding a
record would exceed `maxRecordsPerEvent` or `maxInputChars` (soft, may overshoot by one record);
keep the last `tailRecords` records unprocessed; drop units with fewer than `minRecordsPerEvent`
records or fewer than `minEventChars` characters; timestamps come from the first/last record `at`
(falling back to the transcript mtime); `contentHash` is `spanHash(records)`.

## src/prompt.ts — the 事件编码指导语

```ts
export const ENCODING_GUIDE: string
export function buildSystemPrompt(config: MemoryConfig): string
export function buildEncodingRequest(config: MemoryConfig, unit: EventUnit): { system: string; user: string }
export const RESPONSE_CONTRACT: string
export class EncodingError extends Error { readonly detail: string }
export function parseEncodingResponse(text: string): EncodedEvent
export function normalizeEncodedEvent(value: unknown): EncodedEvent   // shape/type enforcement + defaults
```

`ENCODING_GUIDE` (Chinese, first person) must instruct: 以「我」的视角；把我的行动作为线索；为什么做
（动机）、实际做了什么、过程中如何调整、对方如何回应、最终结果；保留必要的时间、场景、人物；情绪只在有
依据时记录并区分事实/推断；明确区分事实、推断、计划与完成状态；不要编造；未知处留空；日记自然连贯，
不复述工具日志。`RESPONSE_CONTRACT` states the exact JSON: top level has exactly two keys,
`structured` (object) and `diary` (string), with the `StructuredEvent` field list and types, and "no
markdown fences, no commentary".

`parseEncodingResponse` must tolerate code fences, leading prose, trailing text, and BOM; must find the
first balanced JSON object; must throw `EncodingError` with a diagnostic when `structured` or `diary`
is missing/empty or when a required field has the wrong type. `normalizeEncodedEvent` coerces missing
optional arrays to `[]`, clamps `outcome.status` to a valid `EventStatus` (default `ongoing`), and
keeps unknown extra keys out.

## src/deepseek.ts

```ts
export interface DeepseekChatOptions {
  model?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal; jsonMode?: boolean
}
export class DeepseekClient {
  constructor(config: DeepseekConfig, apiKey: string, logger?: Logger)
  chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, options?: DeepseekChatOptions): Promise<string>
  /** Last response metadata, for `doctor`/logs: model, promptTokens, completionTokens. */
  lastUsage?: { model: string; promptTokens: number; completionTokens: number }
}
export class DeepseekError extends Error { readonly status?: number; readonly body?: string }
```

POST `{baseUrl}/chat/completions` with `Authorization: Bearer`. Retry 3× on 429/5xx/network with
exponential backoff (250ms base), never retry 400/401/403. Send
`response_format: { type: 'json_object' }` when `jsonMode`. Timeout via `AbortController`.

## src/distill.ts

```ts
export interface DistillDeps { config: MemoryConfig; apiKey: string; logger?: Logger; client?: DeepseekClient }
export function createDistiller(deps: DistillDeps): Distiller
/** Encode one unit; fills `structured.sources[0]` provenance from the unit. */
export async function encodeUnit(deps: DistillDeps, unit: EventUnit): Promise<EncodedEvent>
```

`encodeUnit` builds the request from `prompt.ts`, calls DeepSeek, parses, then overwrites
`structured.startedAt/endedAt` only when they are missing or unparseable, and always sets
`structured.sources` to a single `EventSourceRef` built from the unit (sessionId, sessionFile, cwd,
fromSeq, toSeq, recordCount, turns, capturedAt, contentHash, truncated).

## src/store.ts — paired JSON/MD storage

`EventSummary` is declared in `src/types.ts`; `store.ts` re-exports it.

```ts
export type { EventSummary } from './types.js'
export function readEvent(paths: MemoryPaths, id: string): EventRecord | undefined
export function readDiary(paths: MemoryPaths, id: string): string | undefined
export function writeEventPair(paths: MemoryPaths, record: EventRecord): { jsonFile: string; mdFile: string; created: boolean }
export function listEventSummaries(paths: MemoryPaths, options?: { refresh?: boolean }): EventSummary[]
export function eventIdFor(startedAt: string, contentHash: string): string      // ev_20251030T164512_ab12cd34
export function buildRecord(encoded: EncodedEvent, options: { id: string; now?: string; revision?: number }): EventRecord
export function shortTermMemory(paths: MemoryPaths, limit: number): { summaries: EventSummary[]; text: string }
export function repairPairs(paths: MemoryPaths): { repaired: string[]; quarantined: string[]; skipped: string[] }
export function eventIndexPath(paths: MemoryPaths): string
```

- `.md` contains exactly `record.diary` (trailing newline allowed). No front-matter, no title heading.
- `writeEventPair` writes JSON first, then MD, both atomic; updates the event index
  (`state/events-index.json`) in the same call; refuses to write when `record.diaryHash` does not
  match `sha256(diary)`.
- `listEventSummaries` trusts the index when `refresh` is false, otherwise rescans `events/` and
  reconciles it. Sorting: `occurredAt` descending.
- `repairPairs` regenerates a missing `.md` from the JSON's `diary`, re-serialises a JSON whose
  `diaryHash` is stale, and moves unparseable/orphan files to `events/_quarantine/`.

## src/vectors.ts — local SQLite index

`VectorRow`, `VectorHit` and `VectorSource` are declared in `src/types.ts`; `vectors.ts` re-exports
them.

```ts
export type { VectorRow, VectorHit, VectorSource } from './types.js'
export class VectorStore implements VectorSource {
  constructor(dbFile: string)                 // creates `vectors/` and schema on demand
  upsert(rows: VectorRow[]): number
  get(eventId: string): VectorRow | undefined
  all(): VectorRow[]
  delete(eventIds: string[]): number
  count(): number
  modelOf(): string | undefined               // dominant model in the table
  close(): void
}
export function vectorToBlob(vector: number[]): Buffer
export function blobToVector(blob: Buffer): number[]
export function vectorNorm(vector: number[]): number
export function cosineSimilarity(a: number[], b: number[]): number
export function searchVectors(store: VectorStore, query: number[], topK: number, allowIds?: Set<string>): VectorHit[]
/** Events whose stored `text_hash` differs from the event's current `diaryHash`, plus ones with no row. */
export function staleEventIds(store: VectorStore, summaries: EventSummary[]): string[]
export function missingEventIds(store: VectorStore, summaries: EventSummary[]): string[]
```

Use `node:sqlite` (`DatabaseSync`). Schema version table `meta(key TEXT PRIMARY KEY, value TEXT)`;
vectors stored as `Float32Array` blobs, `norm` cached for cosine speed. `upsert` replaces existing
rows and bumps `updated_at`. `searchVectors` scores only rows whose `dimensions` match the query.

## src/embed.ts — DashScope (Beijing) HTTP clients

```ts
export class DashscopeError extends Error { readonly status?: number; readonly body?: string; readonly code?: string }
export function embeddingEndpoint(config: DashscopeConfig): string   // `${baseUrl}/compatible-mode/v1/embeddings`
export function rerankEndpoint(config: DashscopeConfig): string      // `${baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`
export function createEmbedder(config: DashscopeConfig, apiKey: string, logger?: Logger): Embedder
export function createReranker(config: DashscopeConfig, apiKey: string, logger?: Logger): Reranker
/** Convenience over Embedder for one text. */
export function embedOne(embedder: Embedder, text: string): Promise<number[]>
```

Embedding request: `{ model, input: string[], dimensions, encoding_format: 'float' }`, batches of
`embeddingBatchSize`, response rows sorted by `index`; throws when a row's length differs from
`dimensions`. Rerank request: `{ model, input: { query, documents }, parameters: { return_documents:
false, top_n } }`, result `output.results[]` → `RerankHit[]` sorted by score desc, filtered
`index < documents.length`. Retries 3× on 429/5xx with backoff; `rerankEnabled === false` means the
reranker must still exist but `createReranker` returns a pass-through ranking of the input order.

## src/retrieval.ts — recall pipeline

`retrieval.ts` must not import `store.ts` or `vectors.ts`: everything it needs is injected, so the
file compiles and tests on its own branch.

```ts
export interface RecallDeps {
  config: MemoryConfig
  /** Every known event, any order (newest-first is fastest). */
  summaries: EventSummary[]
  /** Loads one full event record, or `undefined` when it disappeared. */
  readRecord: (eventId: string) => EventRecord | undefined
  /** Vector rows; when absent the vector stage is skipped and noted. */
  vectors?: VectorSource
  embedder?: Embedder
  reranker?: Reranker
  logger?: Logger
  signal?: AbortSignal
}
export function matchFilters(summary: EventSummary, record: EventRecord | undefined, filters?: RecallFilters): boolean
export function renderRecallText(hits: RecallHit[], config: MemoryConfig, notes: string[]): string
export async function recall(deps: RecallDeps, query: RecallQuery): Promise<RecallResult>
```

Stage order, each stage additive and non-fatal (a stage failure is recorded in `notes` and the run
continues):

1. **short-term**: newest `retrieval.shortTermCount` events (always included, `via: ['short-term']`).
2. **structured**: `listEventSummaries` filtered by `matchFilters` (time window, people, projects,
   tags, keywords, status, entities, text substring over title+diary), capped by `candidateLimit`.
3. **vector**: embed the query once, `searchVectors` restricted to the structured candidate ids
   (all events when there are no filters beyond the cap), keep `vectorTopK`.
4. **rerank**: DashScope rerank over the union of shortlisted diaries (short letters trimmed to
   `maxReplyChars / 2` each), keep `rerankTopN`, then cut to `finalLimit` (or `query.limit`).
   Without a reranker, order by cosine then recency.

Returned `text` is a Chinese-labelled block ready for prompt injection: per hit a header line
(`## 事件 <occurredAt> · <title> · <status>`) then the diary, then a provenance line
(`来源：<sessionFile> seq <from>-<to>`), separated by `---`, and closed with a total-budget note when
truncated.

## src/consolidate.ts — the write path (integration, owned by the plugin track)

```ts
export interface ConsolidateDeps {
  paths: MemoryPaths; config: MemoryConfig; secrets: SecretSource
  logger?: Logger
  distiller?: Distiller; embedder?: Embedder
  /** Session file the trigger pointed at; it is consolidated first. */
  currentSessionFile?: string
  /** Skip the cooldown for explicit CLI/tool invocations. */
  force?: boolean
  signal?: AbortSignal
  dryRun?: boolean
}
export function consolidate(deps: ConsolidateDeps): Promise<ConsolidationResult>
```

`consolidate` owns: cursor load/save, session enumeration, per-file incremental reading, unit
building, dedupe against existing events (same `contentHash` in any event's sources, or same span
already covered), encoding, pair writing, embedding + vector upsert, stale-vector refresh, failure
recording/backoff, and the cooldown. It must be crash-safe: cursor advances only after an event's
pair and its vector row are durable.

## src/plugin.ts — dsh integration (plugin track)

Registers the recall tool, a system-prompt section, and the pre-compaction trigger (see
`docs/architecture.md`). Never throws out of a lifecycle hook; every failure is logged and contained.

## src/cli.ts

```
autobiomemory init [--root <dir>]
autobiomemory config [--root <dir>] [--set key=value ...]
autobiomemory status [--root <dir>] [--json]
autobiomemory consolidate [--root <dir>] [--session <file>] [--force] [--dry-run] [--verbose]
autobiomemory recall <question> [--root <dir>] [--since <iso>] [--until <iso>] [--tag t] [--status s] [--limit n] [--json]
autobiomemory embed [--root <dir>] [--missing] [--stale] [--force]
autobiomemory repair [--root <dir>] [--dry-run]
autobiomemory doctor [--root <dir>] [--json]
autobiomemory short-term [--root <dir>] [--limit n]
```

`init` creates the layout, `config.json`, `.env` (copied from the harness `.env` when available, never
printed), and prints the next steps. `doctor` checks: data-root layout, key presence (masked), config
validity, DeepSeek reachability, DashScope embedding + rerank reachability, vector DB integrity,
cursor alignment, pair consistency.
