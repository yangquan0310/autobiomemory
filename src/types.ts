/**
 * AutoBioMemory — shared vocabulary.
 *
 * Every module in this package speaks the types in this file. They are the
 * contract between the four feature tracks (core / encode / vector / plugin)
 * so those can be developed in parallel on separate branches.
 */

/* ------------------------------------------------------------------ *
 * Data-root layout and secrets
 * ------------------------------------------------------------------ */

/** Absolute paths of everything AutoBioMemory keeps under `~/.autobiomemory`. */
export interface MemoryPaths {
  root: string
  configFile: string
  envFile: string
  eventsDir: string
  vectorsDir: string
  stateDir: string
  logsDir: string
  cursorFile: string
  runStateFile: string
  eventIndexFile: string
  vectorDb: string
}

/** API keys, wherever they were found. */
export interface SecretSource {
  deepseekApiKey?: string
  dashscopeApiKey?: string
  origin: {
    deepseek: '.env' | 'process' | 'missing'
    dashscope: '.env' | 'process' | 'missing'
  }
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

export interface SessionSourceConfig {
  /** Directories scanned for raw session transcripts (read in place, never moved). */
  readDirs: string[]
  /** File name patterns treated as session transcripts. */
  includeGlobs: string[]
  /** Absolute paths or glob-ish fragments to skip. */
  excludeGlobs: string[]
  /** Minimum number of raw records for a span to be worth encoding. */
  minRecordsPerEvent: number
  /** Hard cap on raw records folded into one event. */
  maxRecordsPerEvent: number
  /** Records at the tail of a session that are left for the next pass. */
  tailRecords: number
}

export interface ConsolidationConfig {
  /** Character budget for one DeepSeek encoding call. */
  maxInputChars: number
  /** Below this many characters a span is carried to the next pass. */
  minEventChars: number
  /** Max events encoded in one consolidation run. */
  maxEventsPerRun: number
  /** How many most recent events make up short-term memory. */
  recentEventLimit: number
  /** Minimum gap between two automatic runs for one data root. */
  cooldownMs: number
  /** Whether a run may proceed while another is in flight in this process. */
  serialize: boolean
  /**
   * How many encode attempts one span gets before it is marked skipped and the cursor
   * moves past it. Keeps a poison span from stalling a session forever.
   */
  maxSpanAttempts: number
}

export interface DeepseekConfig {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  /** Ask DeepSeek for a strict JSON object response. */
  jsonMode: boolean
  /** Retries for transient failures. */
  retries: number
}

export interface DashscopeConfig {
  /** `beijing` maps to https://dashscope.aliyuncs.com */
  region: 'beijing' | 'intl'
  baseUrl: string
  embeddingModel: string
  embeddingDimensions: number
  embeddingBatchSize: number
  rerankModel: string
  rerankTopN: number
  rerankEnabled: boolean
  timeoutMs: number
  retries: number
}

export interface RetrievalConfig {
  /** How many structured-filter candidates are scanned by vector recall. */
  candidateLimit: number
  /** Vector shortlist size. */
  vectorTopK: number
  /** Rerank shortlist size. */
  rerankTopN: number
  /** Final number of diaries handed back to the agent. */
  finalLimit: number
  /** Short-term memory events always prepended to a recall. */
  shortTermCount: number
  /** Include raw source refs in the reply. */
  includeSources: boolean
  /** Drop results below this rerank (or cosine, when rerank is off) score. */
  minScore: number
  /** Character budget for diary bodies in one reply. */
  maxReplyChars: number
}

export interface TriggerConfig {
  /** Run consolidation automatically before the agent context is compacted. */
  onCompaction: boolean
  /** Also run when a session goes idle (after a turn ends). */
  onTurnEnd: boolean
  /** Also run on session start when the cursor is behind. */
  onSessionStart: boolean
  /** Tool name exposed to the agent. */
  toolName: string
  /** Global cooldown between automatic runs. */
  globalCooldownMs: number
}

export interface MemoryConfig {
  version: number
  dataRoot: string
  session: SessionSourceConfig
  consolidation: ConsolidationConfig
  deepseek: DeepseekConfig
  dashscope: DashscopeConfig
  retrieval: RetrievalConfig
  trigger: TriggerConfig
}

/* ------------------------------------------------------------------ *
 * Structured event (what DeepSeek produces)
 * ------------------------------------------------------------------ */

export type EventStatus = 'completed' | 'partial' | 'failed' | 'ongoing' | 'planned'

/** Tag on a claim: is it observed, guessed, intended, or done? */
export type StatementKind = 'fact' | 'inference' | 'plan' | 'completion'

export interface EventAction {
  /** 1-based position inside the event. */
  order: number
  /** Why I acted — the motive live at the time. */
  why?: string
  /** What I actually did. */
  what: string
  /** How I adjusted course mid-way. */
  adjustment?: string
  /** What came of it. */
  result?: string
}

export interface EventEmotion {
  /** `我`, `用户`, or a named person. */
  who: string
  emotion: string
  /** The wording or behaviour that supports the emotion. */
  evidence?: string
  basis: 'fact' | 'inference'
}

export interface EventStatement {
  kind: StatementKind
  text: string
  /** Optional confidence for inferences. */
  confidence?: number
}

export interface EventPerson {
  name: string
  role?: string
}

export interface EventScene {
  cwd?: string
  project?: string
  place?: string
  channel?: string
  /** Local wall-clock label such as `2025-10-30 16:45 北京时间`. */
  localTime?: string
}

export interface EventOutcome {
  status: EventStatus
  /** One-sentence-bottom-line of how it ended. */
  summary: string
  /** Files, commits, artefacts produced. */
  artifacts?: string[]
}

/** Provenance of one event: which raw transcript span it was encoded from. */
export interface EventSourceRef {
  sessionId: string
  /** Absolute path of the raw transcript, read in place. */
  sessionFile: string
  cwd?: string
  /** First raw record `seq` folded into this event. */
  fromSeq: number
  /** Last raw record `seq` folded into this event. */
  toSeq: number
  recordCount: number
  /** Turn indices covered. */
  turns: number[]
  capturedAt: string
  /** Hash of the encoded transcript span (dedupe key). */
  contentHash: string
  /** True when the span was cut short by the input budget. */
  truncated: boolean
}

/** The `structured` object DeepSeek returns, plus server-side provenance. */
export interface StructuredEvent {
  title: string
  startedAt: string
  endedAt: string
  scene: EventScene
  people: EventPerson[]
  goals: string[]
  actions: EventAction[]
  statements: EventStatement[]
  emotions: EventEmotion[]
  outcome: EventOutcome
  tags: string[]
  keywords: string[]
  entities: string[]
  lessons: string[]
  openQuestions: string[]
  sources: EventSourceRef[]
}

/* ------------------------------------------------------------------ *
 * Persisted event (the .json half of the pair)
 * ------------------------------------------------------------------ */

export interface EventEmbeddingBookkeeping {
  model: string
  dimensions: number
  /** sha256 of the diary body that was embedded. */
  textHash: string
  updatedAt: string
}

export interface EventRecord {
  schemaVersion: number
  /** `ev_<yyyymmddTHHMMSS>_<hash8>` */
  id: string
  createdAt: string
  updatedAt: string
  /** Canonical structured event, including source refs. */
  structured: StructuredEvent
  /** The diary body; the .md file contains exactly this. */
  diary: string
  /** sha256 of `diary`, used for vector freshness and MD/JSON pairing. */
  diaryHash: string
  /** Mirror of the vector row, for offline inspection. */
  embedding?: EventEmbeddingBookkeeping
  /** Nothing but facts carried over from encoding. */
  revision: number
}

/** Index row for one stored event pair. */
export interface EventSummary {
  id: string
  title: string
  occurredAt: string
  endedAt: string
  status: EventStatus
  tags: string[]
  people: string[]
  keywords: string[]
  entities: string[]
  project?: string
  /** sha256 of the diary body currently on disk. */
  diaryHash: string
  diaryChars: number
  revision: number
  jsonFile: string
  mdFile: string
  updatedAt: string
  /** Set when the JSON/MD pair on disk is inconsistent. */
  problem?: 'missing-md' | 'missing-json' | 'hash-mismatch' | 'unreadable-json'
}

/* ------------------------------------------------------------------ *
 * Vector index rows
 * ------------------------------------------------------------------ */

export interface VectorRow {
  eventId: string
  model: string
  dimensions: number
  /** sha256 of the diary body that was embedded. */
  textHash: string
  vector: number[]
  /** Pre-computed L2 norm. */
  norm: number
  updatedAt: string
}

export interface VectorHit {
  eventId: string
  cosine: number
}

/** Minimal read surface `recall()` needs from the vector index. */
export interface VectorSource {
  all(): VectorRow[]
}

/* ------------------------------------------------------------------ *
 * Raw session records (normalised view over session.jsonl.zstd)
 * ------------------------------------------------------------------ */

export type RawRecordKind =
  | 'user'
  | 'assistant'
  | 'tool-call'
  | 'tool-result'
  | 'system'
  | 'meta'
  | 'compact'
  | 'other'

export interface RawRecord {
  /** 1-based index in the decoded transcript. */
  seq: number
  kind: RawRecordKind
  /** Turn index, monotonically increasing. */
  turn: number
  /** ISO timestamp when the transcript carried one. */
  at?: string
  /** Human-readable rendering of the record, already flattened to text. */
  text: string
  /** Tool name for tool records. */
  tool?: string
  /** Original JSON line, kept for provenance/debug. */
  raw: unknown
}

export interface SessionTranscript {
  sessionFile: string
  sessionId: string
  cwd?: string
  /** Total records decoded. */
  records: RawRecord[]
  /** Decoded text size in bytes, used as the byte cursor. */
  bytes: number
  fileSize: number
  fileMtimeMs: number
}

/* ------------------------------------------------------------------ *
 * Cursor + run state
 * ------------------------------------------------------------------ */

export interface SessionCursor {
  sessionFile: string
  sessionId: string
  /** Records already folded into events. */
  processedRecords: number
  /** Decompressed-stream offset of the next unread record. */
  byteOffset: number
  fileSize: number
  fileMtimeMs: number
  /** Hash of the last processed record, guards against rewrites. */
  lastRecordHash: string
  /** Content hash of the newest emitted event span for this session. */
  lastSpanHash: string
  updatedAt: string
}

export interface CursorState {
  version: number
  sessions: Record<string, SessionCursor>
}

export interface FailureEntry {
  kind: 'consolidate' | 'embed' | 'store'
  /** Session file or event id the failure belongs to. */
  target: string
  attempts: number
  lastError: string
  lastAttemptAt: string
  nextAttemptAt: string
}

/** A span that repeatedly failed to encode and was deliberately stepped over. */
export interface SkippedSpan {
  sessionFile: string
  spanHash: string
  fromSeq: number
  toSeq: number
  attempts: number
  reason: string
  skippedAt: string
}

export interface RunState {
  version: number
  lastRunAt?: string
  lastRunResult?: ConsolidationResult
  failures: Record<string, FailureEntry>
  /** Spans given up on, keyed by `<sessionFile>#<spanHash>`. */
  skipped?: Record<string, SkippedSpan>
  totals: { events: number; embedded: number; runs: number }
}

/* ------------------------------------------------------------------ *
 * Events built by units + distill
 * ------------------------------------------------------------------ */

/** A candidate span of history to be encoded into one event. */
export interface EventUnit {
  sessionFile: string
  sessionId: string
  /** Records in transcript order. */
  records: RawRecord[]
  fromSeq: number
  toSeq: number
  turns: number[]
  /** `YYYY-MM-DDTHH:mm:ss±hh:mm` style bounds. */
  startedAt: string
  endedAt: string
  contentHash: string
  truncated: boolean
  /** Character count of the rendered transcript. */
  chars: number
}

/** Result of asking DeepSeek to encode one unit. */
export interface EncodedEvent {
  structured: StructuredEvent
  diary: string
}

export interface ConsolidationResult {
  startedAt: string
  finishedAt: string
  sessionsScanned: number
  unitsFound: number
  eventsWritten: number
  eventsSkipped: number
  eventsFailed: number
  embedded: number
  embedFailed: number
  /** Per-event one-liners for logs. */
  details: string[]
  /** Anything that stopped the run early. */
  aborted?: string
}

/* ------------------------------------------------------------------ *
 * Retrieval
 * ------------------------------------------------------------------ */

export interface RecallQuery {
  /** The question the agent is trying to answer. */
  query: string
  /** Optional structured filters. */
  filters?: RecallFilters
  /** Override the config limit. */
  limit?: number
}

export interface RecallFilters {
  /** Inclusive ISO lower bound on the event start. */
  since?: string
  /** Inclusive ISO upper bound on the event end. */
  until?: string
  people?: string[]
  projects?: string[]
  tags?: string[]
  keywords?: string[]
  status?: EventStatus[]
  /** Substring match against title/diary. */
  text?: string
  /** Free-form entity names. */
  entities?: string[]
}

export interface RecallHit {
  eventId: string
  title: string
  occurredAt: string
  status: EventStatus
  /** Diary body (possibly truncated to the reply budget). */
  diary: string
  /** Cosine similarity from the vector stage, when it ran. */
  cosine?: number
  /** Rerank score from DashScope, when it ran. */
  rerankScore?: number
  /** How this hit entered the result set. */
  via: Array<'short-term' | 'structured' | 'vector' | 'rerank'>
  sources: EventSourceRef[]
  tags: string[]
  people: string[]
}

export interface RecallResult {
  query: string
  hits: RecallHit[]
  /** Human/agent readable block ready to be injected into a prompt. */
  text: string
  /** Which stages actually ran. */
  stages: {
    shortTerm: number
    structured: number
    vector: number
    rerank: number
  }
  notes: string[]
}

/* ------------------------------------------------------------------ *
 * Pluggable services (so tests can inject fakes)
 * ------------------------------------------------------------------ */

export interface Embedder {
  readonly model: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

export interface Reranker {
  readonly model: string
  /** Returns indices into `documents`, best first. */
  rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]>
}

export interface RerankHit {
  index: number
  score: number
}

export interface Distiller {
  encode(unit: EventUnit): Promise<EncodedEvent>
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

