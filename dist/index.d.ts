import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

/**
 * AutoBioMemory — DeepSeek Harness plugin entry point.
 *
 * Wires the autobiographical-memory loop into the harness through the extension points dsh
 * actually offers:
 *
 * - **Tool** (`ctx.tools.register`) — `autobiomemory_recall` (recall) and, optionally,
 *   `autobiomemory_consolidate` (explicit 整理), so the agent can ask for its own past on demand.
 * - **System prompt** (`ctx.systemPrompt.section`) — a short-term-memory digest plus the recall
 *   habit, refreshed on every assembly.
 * - **Pre-compaction trigger** (`agent/pre-step`, `{ prepend: true }` waterfall) — runs before
 *   `compaction-basic` decides whether to compact, which is the harness's真 pre-compaction seam, and
 *   consolidates the raw transcript on disk incrementally.
 * - **Session events** (`session/event`) — `compaction/start` is a durable belt-and-braces trigger
 *   even when pressure compaction is driven by another backend.
 *
 * Everything is failure-contained: no hook may throw into the agent loop.
 */

declare const name = "autobiomemory";
/** Services this plugin needs; it stays unloaded in profiles that lack them. */
declare const inject: string[];
interface PluginConfig {
    /** Data root; defaults to `~/.autobiomemory`. */
    dataRoot?: string;
    /** Master switch for the automatic (lifecycle) triggers. */
    autoConsolidate?: boolean;
    /** Also consolidate when an agent goes idle after a turn. */
    consolidateOnIdle?: boolean;
    /** Recall tool name. */
    toolName?: string;
    /** Optional explicit-consolidation tool name; `''` disables it. */
    consolidateToolName?: string;
    /** Upper bound for the pre-compaction consolidation (ms). */
    preCompactionTimeoutMs?: number;
    /** Inject the short-term digest into the system prompt. */
    shortTermInPrompt?: boolean;
    /** Hard cap on the short-term digest size in characters. */
    shortTermPromptChars?: number;
    /** Overrides merged over `<root>/config.json` (advanced). */
    config?: Record<string, unknown>;
}
declare const Config: z<PluginConfig>;
declare function apply(ctx: Context, pluginConfig?: PluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<PluginConfig>;
    apply: typeof apply;
};

/**
 * AutoBioMemory — shared vocabulary.
 *
 * Every module in this package speaks the types in this file. They are the
 * contract between the four feature tracks (core / encode / vector / plugin)
 * so those can be developed in parallel on separate branches.
 */
/** Absolute paths of everything AutoBioMemory keeps under `~/.autobiomemory`. */
interface MemoryPaths {
    root: string;
    configFile: string;
    envFile: string;
    eventsDir: string;
    vectorsDir: string;
    stateDir: string;
    logsDir: string;
    cursorFile: string;
    runStateFile: string;
    eventIndexFile: string;
    vectorDb: string;
}
/** API keys, wherever they were found. */
interface SecretSource {
    deepseekApiKey?: string;
    dashscopeApiKey?: string;
    origin: {
        deepseek: '.env' | 'process' | 'missing';
        dashscope: '.env' | 'process' | 'missing';
    };
}
interface SessionSourceConfig {
    /** Directories scanned for raw session transcripts (read in place, never moved). */
    readDirs: string[];
    /** File name patterns treated as session transcripts. */
    includeGlobs: string[];
    /** Absolute paths or glob-ish fragments to skip. */
    excludeGlobs: string[];
    /** Minimum number of raw records for a span to be worth encoding. */
    minRecordsPerEvent: number;
    /** Hard cap on raw records folded into one event. */
    maxRecordsPerEvent: number;
    /** Records at the tail of a session that are left for the next pass. */
    tailRecords: number;
}
interface ConsolidationConfig {
    /** Character budget for one DeepSeek encoding call. */
    maxInputChars: number;
    /** Below this many characters a span is carried to the next pass. */
    minEventChars: number;
    /** Max events encoded in one consolidation run. */
    maxEventsPerRun: number;
    /** How many most recent events make up short-term memory. */
    recentEventLimit: number;
    /** Minimum gap between two automatic runs for one data root. */
    cooldownMs: number;
    /** Whether a run may proceed while another is in flight in this process. */
    serialize: boolean;
}
interface DeepseekConfig {
    baseUrl: string;
    model: string;
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    /** Ask DeepSeek for a strict JSON object response. */
    jsonMode: boolean;
    /** Retries for transient failures. */
    retries: number;
}
interface DashscopeConfig {
    /** `beijing` maps to https://dashscope.aliyuncs.com */
    region: 'beijing' | 'intl';
    baseUrl: string;
    embeddingModel: string;
    embeddingDimensions: number;
    embeddingBatchSize: number;
    rerankModel: string;
    rerankTopN: number;
    rerankEnabled: boolean;
    timeoutMs: number;
    retries: number;
}
interface RetrievalConfig {
    /** How many structured-filter candidates are scanned by vector recall. */
    candidateLimit: number;
    /** Vector shortlist size. */
    vectorTopK: number;
    /** Rerank shortlist size. */
    rerankTopN: number;
    /** Final number of diaries handed back to the agent. */
    finalLimit: number;
    /** Short-term memory events always prepended to a recall. */
    shortTermCount: number;
    /** Include raw source refs in the reply. */
    includeSources: boolean;
    /** Drop results below this rerank (or cosine, when rerank is off) score. */
    minScore: number;
    /** Character budget for diary bodies in one reply. */
    maxReplyChars: number;
}
interface TriggerConfig {
    /** Run consolidation automatically before the agent context is compacted. */
    onCompaction: boolean;
    /** Also run when a session goes idle (after a turn ends). */
    onTurnEnd: boolean;
    /** Also run on session start when the cursor is behind. */
    onSessionStart: boolean;
    /** Tool name exposed to the agent. */
    toolName: string;
    /** Global cooldown between automatic runs. */
    globalCooldownMs: number;
}
interface MemoryConfig {
    version: number;
    dataRoot: string;
    session: SessionSourceConfig;
    consolidation: ConsolidationConfig;
    deepseek: DeepseekConfig;
    dashscope: DashscopeConfig;
    retrieval: RetrievalConfig;
    trigger: TriggerConfig;
}
type EventStatus = 'completed' | 'partial' | 'failed' | 'ongoing' | 'planned';
/** Tag on a claim: is it observed, guessed, intended, or done? */
type StatementKind = 'fact' | 'inference' | 'plan' | 'completion';
interface EventAction {
    /** 1-based position inside the event. */
    order: number;
    /** Why I acted — the motive live at the time. */
    why?: string;
    /** What I actually did. */
    what: string;
    /** How I adjusted course mid-way. */
    adjustment?: string;
    /** What came of it. */
    result?: string;
}
interface EventEmotion {
    /** `我`, `用户`, or a named person. */
    who: string;
    emotion: string;
    /** The wording or behaviour that supports the emotion. */
    evidence?: string;
    basis: 'fact' | 'inference';
}
interface EventStatement {
    kind: StatementKind;
    text: string;
    /** Optional confidence for inferences. */
    confidence?: number;
}
interface EventPerson {
    name: string;
    role?: string;
}
interface EventScene {
    cwd?: string;
    project?: string;
    place?: string;
    channel?: string;
    /** Local wall-clock label such as `2025-10-30 16:45 北京时间`. */
    localTime?: string;
}
interface EventOutcome {
    status: EventStatus;
    /** One-sentence-bottom-line of how it ended. */
    summary: string;
    /** Files, commits, artefacts produced. */
    artifacts?: string[];
}
/** Provenance of one event: which raw transcript span it was encoded from. */
interface EventSourceRef {
    sessionId: string;
    /** Absolute path of the raw transcript, read in place. */
    sessionFile: string;
    cwd?: string;
    /** First raw record `seq` folded into this event. */
    fromSeq: number;
    /** Last raw record `seq` folded into this event. */
    toSeq: number;
    recordCount: number;
    /** Turn indices covered. */
    turns: number[];
    capturedAt: string;
    /** Hash of the encoded transcript span (dedupe key). */
    contentHash: string;
    /** True when the span was cut short by the input budget. */
    truncated: boolean;
}
/** The `structured` object DeepSeek returns, plus server-side provenance. */
interface StructuredEvent {
    title: string;
    startedAt: string;
    endedAt: string;
    scene: EventScene;
    people: EventPerson[];
    goals: string[];
    actions: EventAction[];
    statements: EventStatement[];
    emotions: EventEmotion[];
    outcome: EventOutcome;
    tags: string[];
    keywords: string[];
    entities: string[];
    lessons: string[];
    openQuestions: string[];
    sources: EventSourceRef[];
}
interface EventEmbeddingBookkeeping {
    model: string;
    dimensions: number;
    /** sha256 of the diary body that was embedded. */
    textHash: string;
    updatedAt: string;
}
interface EventRecord {
    schemaVersion: number;
    /** `ev_<yyyymmddTHHMMSS>_<hash8>` */
    id: string;
    createdAt: string;
    updatedAt: string;
    /** Canonical structured event, including source refs. */
    structured: StructuredEvent;
    /** The diary body; the .md file contains exactly this. */
    diary: string;
    /** sha256 of `diary`, used for vector freshness and MD/JSON pairing. */
    diaryHash: string;
    /** Mirror of the vector row, for offline inspection. */
    embedding?: EventEmbeddingBookkeeping;
    /** Nothing but facts carried over from encoding. */
    revision: number;
}
/** Index row for one stored event pair. */
interface EventSummary {
    id: string;
    title: string;
    occurredAt: string;
    endedAt: string;
    status: EventStatus;
    tags: string[];
    people: string[];
    keywords: string[];
    entities: string[];
    project?: string;
    /** sha256 of the diary body currently on disk. */
    diaryHash: string;
    diaryChars: number;
    revision: number;
    jsonFile: string;
    mdFile: string;
    updatedAt: string;
    /** Set when the JSON/MD pair on disk is inconsistent. */
    problem?: 'missing-md' | 'missing-json' | 'hash-mismatch' | 'unreadable-json';
}
interface VectorRow {
    eventId: string;
    model: string;
    dimensions: number;
    /** sha256 of the diary body that was embedded. */
    textHash: string;
    vector: number[];
    /** Pre-computed L2 norm. */
    norm: number;
    updatedAt: string;
}
interface VectorHit {
    eventId: string;
    cosine: number;
}
/** Minimal read surface `recall()` needs from the vector index. */
interface VectorSource {
    all(): VectorRow[];
}
type RawRecordKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'system' | 'meta' | 'compact' | 'other';
interface RawRecord {
    /** 1-based index in the decoded transcript. */
    seq: number;
    kind: RawRecordKind;
    /** Turn index, monotonically increasing. */
    turn: number;
    /** ISO timestamp when the transcript carried one. */
    at?: string;
    /** Human-readable rendering of the record, already flattened to text. */
    text: string;
    /** Tool name for tool records. */
    tool?: string;
    /** Original JSON line, kept for provenance/debug. */
    raw: unknown;
}
interface SessionTranscript {
    sessionFile: string;
    sessionId: string;
    cwd?: string;
    /** Total records decoded. */
    records: RawRecord[];
    /** Decoded text size in bytes, used as the byte cursor. */
    bytes: number;
    fileSize: number;
    fileMtimeMs: number;
}
interface SessionCursor {
    sessionFile: string;
    sessionId: string;
    /** Records already folded into events. */
    processedRecords: number;
    /** Decompressed-stream offset of the next unread record. */
    byteOffset: number;
    fileSize: number;
    fileMtimeMs: number;
    /** Hash of the last processed record, guards against rewrites. */
    lastRecordHash: string;
    /** Content hash of the newest emitted event span for this session. */
    lastSpanHash: string;
    updatedAt: string;
}
interface CursorState {
    version: number;
    sessions: Record<string, SessionCursor>;
}
interface FailureEntry {
    kind: 'consolidate' | 'embed' | 'store';
    /** Session file or event id the failure belongs to. */
    target: string;
    attempts: number;
    lastError: string;
    lastAttemptAt: string;
    nextAttemptAt: string;
}
interface RunState {
    version: number;
    lastRunAt?: string;
    lastRunResult?: ConsolidationResult;
    failures: Record<string, FailureEntry>;
    totals: {
        events: number;
        embedded: number;
        runs: number;
    };
}
/** A candidate span of history to be encoded into one event. */
interface EventUnit {
    sessionFile: string;
    sessionId: string;
    /** Records in transcript order. */
    records: RawRecord[];
    fromSeq: number;
    toSeq: number;
    turns: number[];
    /** `YYYY-MM-DDTHH:mm:ss±hh:mm` style bounds. */
    startedAt: string;
    endedAt: string;
    contentHash: string;
    truncated: boolean;
    /** Character count of the rendered transcript. */
    chars: number;
}
/** Result of asking DeepSeek to encode one unit. */
interface EncodedEvent {
    structured: StructuredEvent;
    diary: string;
}
interface ConsolidationResult {
    startedAt: string;
    finishedAt: string;
    sessionsScanned: number;
    unitsFound: number;
    eventsWritten: number;
    eventsSkipped: number;
    eventsFailed: number;
    embedded: number;
    embedFailed: number;
    /** Per-event one-liners for logs. */
    details: string[];
    /** Anything that stopped the run early. */
    aborted?: string;
}
interface RecallQuery {
    /** The question the agent is trying to answer. */
    query: string;
    /** Optional structured filters. */
    filters?: RecallFilters;
    /** Override the config limit. */
    limit?: number;
}
interface RecallFilters {
    /** Inclusive ISO lower bound on the event start. */
    since?: string;
    /** Inclusive ISO upper bound on the event end. */
    until?: string;
    people?: string[];
    projects?: string[];
    tags?: string[];
    keywords?: string[];
    status?: EventStatus[];
    /** Substring match against title/diary. */
    text?: string;
    /** Free-form entity names. */
    entities?: string[];
}
interface RecallHit {
    eventId: string;
    title: string;
    occurredAt: string;
    status: EventStatus;
    /** Diary body (possibly truncated to the reply budget). */
    diary: string;
    /** Cosine similarity from the vector stage, when it ran. */
    cosine?: number;
    /** Rerank score from DashScope, when it ran. */
    rerankScore?: number;
    /** How this hit entered the result set. */
    via: Array<'short-term' | 'structured' | 'vector' | 'rerank'>;
    sources: EventSourceRef[];
    tags: string[];
    people: string[];
}
interface RecallResult {
    query: string;
    hits: RecallHit[];
    /** Human/agent readable block ready to be injected into a prompt. */
    text: string;
    /** Which stages actually ran. */
    stages: {
        shortTerm: number;
        structured: number;
        vector: number;
        rerank: number;
    };
    notes: string[];
}
interface Embedder {
    readonly model: string;
    readonly dimensions: number;
    embed(texts: string[]): Promise<number[][]>;
}
interface Reranker {
    readonly model: string;
    /** Returns indices into `documents`, best first. */
    rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]>;
}
interface RerankHit {
    index: number;
    score: number;
}
interface Distiller {
    encode(unit: EventUnit): Promise<EncodedEvent>;
}
interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

/** AutoBioMemory — constants shared by every module. */
/** Bumped whenever the persisted event JSON shape changes. */
declare const SCHEMA_VERSION = 1;
/** Bumped whenever the cursor/state file shape changes. */
declare const STATE_VERSION = 1;
/** Directory names inside the data root. */
declare const DIRS: {
    readonly events: "events";
    readonly vectors: "vectors";
    readonly state: "state";
    readonly logs: "logs";
};
/** File names inside the data root. */
declare const FILES: {
    readonly config: "config.json";
    readonly env: ".env";
    readonly cursor: "cursor.json";
    readonly runState: "status.json";
    readonly vectorDb: "index.sqlite";
    readonly readme: "README.md";
};

/** AutoBioMemory — data-root resolution and layout. */

/**
 * Resolve the data root.
 *
 * Precedence: explicit override → `DSH_AUTOBIO_ROOT` → `AUTOBIO_ROOT` → `~/.autobiomemory`.
 */
declare function resolveDataRoot(override?: string): string;
/** Build the full path layout for one data root. */
declare function memoryPaths(root?: string): MemoryPaths;
/** Create the directory skeleton (`events/`, `vectors/`, `state/`, `logs/`). */
declare function ensureDataLayout(paths: MemoryPaths): MemoryPaths;
/** The paired files of one event. */
declare function eventPair(paths: MemoryPaths, id: string): {
    json: string;
    md: string;
};

/** AutoBioMemory — the two API keys, kept in `<root>/.env`. */

/** Parse a dotenv file: `KEY=VALUE`, `export KEY=VALUE`, quotes and comments. */
declare function parseDotEnv(text: string): Record<string, string>;
/**
 * Resolve both keys.
 *
 * Precedence per key: `<root>/.env` → `AUTOBIO_*` process variable → plain process variable.
 * The data root wins so it stays the single source of truth for this module.
 */
declare function readSecrets(paths: MemoryPaths, processEnv?: NodeJS.ProcessEnv): SecretSource;
/**
 * Write both keys into `<root>/.env` with 0600 permissions.
 *
 * When the file already exists and `overwrite` is allowed, unrelated lines and comments are
 * preserved and only the two keys are rewritten in place.
 */
declare function writeEnvFile(paths: MemoryPaths, secrets: {
    deepseekApiKey: string;
    dashscopeApiKey: string;
}, options?: {
    overwrite?: boolean;
}): {
    written: boolean;
    path: string;
};
/** Read a required key or throw a message that says where to put it. */
declare function requireSecret(secrets: SecretSource, which: 'deepseek' | 'dashscope'): string;

/** AutoBioMemory — `config.json`: defaults, merge, validation. */

type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};
/** Defaults every install starts from. */
declare function defaultConfig(dataRoot?: string): MemoryConfig;
/** Deep merge: objects recurse, arrays replace, `undefined` leaves the base value alone. */
declare function mergeConfig(base: MemoryConfig, patch?: DeepPartial<MemoryConfig>): MemoryConfig;
/** Human-readable problems; an empty array means the config is usable. */
declare function validateConfig(config: MemoryConfig): string[];
/** Read `<root>/config.json`, falling back to defaults, then apply a patch. */
declare function loadConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig;
/** Create `config.json` when it is missing; always returns the effective config. */
declare function ensureConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig;
declare function writeConfig(paths: MemoryPaths, config: MemoryConfig): void;
/** Absolute, de-duplicated session directories (`~` expanded, relative resolved). */
declare function expandSessionDirs(config: MemoryConfig, cwd: string): string[];

/** AutoBioMemory — processing cursor and run state. */

declare function loadCursor(paths: MemoryPaths): CursorState;
declare function saveCursor(paths: MemoryPaths, state: CursorState): void;
declare function getSessionCursor(state: CursorState, sessionFile: string): SessionCursor | undefined;
declare function putSessionCursor(state: CursorState, cursor: SessionCursor): void;
declare function loadRunState(paths: MemoryPaths): RunState;
declare function saveRunState(paths: MemoryPaths, state: RunState): void;
declare function failureKey(kind: FailureEntry['kind'], target: string): string;
/** Record a failure, bumping its attempt count and scheduling the next retry. */
declare function recordFailure(state: RunState, kind: FailureEntry['kind'], target: string, error: unknown, options?: {
    retryDelayMs?: number;
}): FailureEntry;
declare function clearFailure(state: RunState, kind: FailureEntry['kind'], target: string): void;
/** True while the last run is inside the cooldown window. */
declare function isCoolingDown(state: RunState, cooldownMs: number, nowMs?: number): boolean;
/** Failures whose backoff has elapsed, oldest first. */
declare function pendingFailures(state: RunState, nowMs?: number): FailureEntry[];

/**
 * AutoBioMemory — raw session transcripts, read in place.
 *
 * dsh appends one **independent zstd frame per write** to `session.jsonl.zstd`
 * (live files on this machine carry thousands of them), and `zlib.zstdDecompressSync`
 * decodes only the first frame. So we walk the concatenated frame headers ourselves:
 * magic → frame header → blocks → optional checksum trailer, decompressing each frame
 * separately and concatenating the payloads.
 *
 * The transcript is then normalised from the dsh *session event log* into the flat
 * `RawRecord[]` vocabulary the rest of the memory pipeline speaks.
 */

interface DecodedFrames {
    text: string;
    frames: number;
    consumedBytes: number;
}
/**
 * Decode a concatenation of complete zstd frames.
 *
 * A torn trailing frame (the file was being appended while we read it) is left alone:
 * everything decoded before it is returned and `consumedBytes` says where we stopped.
 */
declare function decodeZstdFrames(buffer: Buffer): DecodedFrames;
/** Enumerate session transcripts under the configured directories. */
declare function listSessionFiles(readDirs: string[], includeGlobs?: string[], excludeGlobs?: string[]): string[];
/** `…/agentchat-web-v1-<id>/session.jsonl.zstd` → the directory name, else the file stem. */
declare function sessionIdFromPath(file: string): string;
/**
 * Map dsh session event-log lines onto `RawRecord[]`.
 *
 * `seq` is the 1-based line index; `turn` tracks `turn/start`; streaming deltas
 * (`assistant/chunk`, `text-chunks`, `reasoning-chunks`, `tool-call-chunks`, …) are noise
 * and are dropped, as are pure request bookkeeping records.
 */
declare function normalizeRecords(lines: string[]): RawRecord[];
/** Decode one transcript file and normalise it. */
declare function readTranscript(sessionFile: string): SessionTranscript;
/** Records strictly after the cursor's processed count. */
declare function pendingRecords(transcript: SessionTranscript, cursor?: SessionCursor): RawRecord[];
/** Stable hash of a span, used as the incremental-dedupe key. */
declare function spanHash(records: RawRecord[]): string;
/**
 * Render records as the line-oriented Chinese transcript handed to DeepSeek.
 *
 * ```
 * [3] 2025-10-30 16:45:12 用户：…
 * [5] 2025-10-30 16:45:31 我调用工具 bash：{"command":"ls"}
 * [6] 2025-10-30 16:45:32 工具结果 bash（失败）：…
 * ```
 */
declare function renderRecords(records: RawRecord[], maxChars?: number, fallbackMs?: number): {
    text: string;
    chars: number;
    truncated: boolean;
};

/**
 * AutoBioMemory — event segmentation.
 *
 * A "relatively complete event" starts when the user (or the world) hands me something to do and
 * ends before the next such hand-over. Tool call/result pairs are never split, and the tail of a
 * transcript is held back for the next pass so an in-flight turn is not encoded half-written.
 */

interface UnitOptions {
    minRecordsPerEvent: number;
    maxRecordsPerEvent: number;
    maxInputChars: number;
    minEventChars: number;
    tailRecords: number;
}
declare function unitOptionsFromConfig(config: MemoryConfig): UnitOptions;
/**
 * Split the not-yet-processed part of a transcript into event units.
 *
 * Rules:
 * - only records after `cursor.processedRecords` are considered;
 * - a unit opens at a `user` record;
 * - a `tool-call` is never separated from its `tool-result` (the pair moves together);
 * - a unit closes before the next `user` record, or when the next record would exceed
 *   `maxRecordsPerEvent` / `maxInputChars` (soft: the closing record is kept, so the
 *   character budget may overshoot by one record);
 * - the last `tailRecords` records stay unprocessed;
 * - units below `minRecordsPerEvent` records or `minEventChars` characters are dropped.
 */
declare function buildUnits(transcript: SessionTranscript, options: UnitOptions, cursor?: SessionCursor): EventUnit[];

/**
 * AutoBioMemory — 事件编码指导语 (the encoding guide), the response contract, and the parser.
 *
 * This module turns one span of raw session records into one first-person event:
 * why I acted, what I actually did, how I adjusted, how the other side responded, and how it
 * ended — keeping time, scene, people, evidenced emotions, and a clear fact/inference/plan/
 * completion split. It is deliberately independent of the transport (see `deepseek.ts`).
 */

/** The 事件编码指导语: the standing instruction sent as the system prompt. */
declare const ENCODING_GUIDE = "\u4F60\u662F\u6211\u7684\u81EA\u4F20\u4F53\u8BB0\u5FC6\u7F16\u7801\u5668\u3002\u6211\u662F\u4E00\u53F0\u5728 DeepSeek Harness \u91CC\u5DE5\u4F5C\u7684\u667A\u80FD\u4F53\uFF0C\u4E0B\u9762\u7ED9\u4F60\u7684\u662F\n\u6211\u4ECE\u539F\u59CB\u4F1A\u8BDD\u91CC\u622A\u53D6\u7684\u4E00\u6BB5\u7ECF\u5386\uFF08\u65F6\u95F4\u3001\u573A\u666F\u3001\u6211\u8C03\u7528\u8FC7\u4EC0\u4E48\u5DE5\u5177\u3001\u6211\u770B\u5230\u4E86\u4EC0\u4E48\u7ED3\u679C\u3001\u7528\u6237\u8BF4\u4E86\u4EC0\u4E48\uFF09\u3002\n\u4F60\u7684\u4EFB\u52A1\uFF1A\u628A\u8FD9\u6BB5\u7ECF\u5386\u6574\u7406\u6210 **\u4E00\u4E2A\u76F8\u5BF9\u5B8C\u6574\u7684\u4E8B\u4EF6**\uFF0C\u5199\u6210\u6211\u53EF\u4EE5\u65E5\u540E\u8BFB\u56DE\u6765\u3001\u5E76\u4E14\u80FD\u51ED\u5B83\u590D\u8FF0\"\u6211\u5F53\u65F6\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A\"\u7684\u7B2C\u4E00\u4EBA\u79F0\u8BB0\u5FC6\u3002\n\n## \u53D9\u4E8B\u89C6\u89D2\u4E0E\u7EBF\u7D22\n\n- \u4E00\u5F8B\u4F7F\u7528\u7B2C\u4E00\u4EBA\u79F0\u300C\u6211\u300D\u6765\u6307\u4EE3\u6211\u81EA\u5DF1\uFF08\u8FD9\u4E2A\u667A\u80FD\u4F53\uFF09\u3002\u7528\u6237\u5C31\u662F\u300C\u7528\u6237\u300D\uFF0C\u6587\u4E2D\u51FA\u73B0\u7684\u5176\u4ED6\u4E3B\u4F53\u6309\u5176\u8EAB\u4EFD\u79F0\u547C\u3002\n- \u4EE5**\u6211\u7684\u884C\u52A8**\u4E3A\u53D9\u4E8B\u7EBF\u7D22\uFF1A\u6211\u505A\u4E86\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48\u505A\u3001\u505A\u7684\u8FC7\u7A0B\u4E2D\u600E\u4E48\u60F3\u3001\u600E\u4E48\u6539\u3001\u7ED3\u679C\u5982\u4F55\u3002\n- \u4E0D\u8981\u590D\u8FF0\u5DE5\u5177\u65E5\u5FD7\u3002\u5DE5\u5177\u8F93\u51FA\u53EA\u662F\u6211\u7684\u89C2\u5BDF\u4F9D\u636E\uFF0C\u8981\u8F6C\u8FF0\u6210\u6211\u770B\u5230\u4E86\u4EC0\u4E48\u3001\u636E\u6B64\u5224\u65AD\u4E86\u4EC0\u4E48\u3002\n- \u4E0D\u5199\"\u4F5C\u4E3AAI\u52A9\u624B\"\u4E4B\u7C7B\u7684\u81EA\u6211\u8BF4\u660E\uFF0C\u76F4\u63A5\u4EE5\u7ECF\u5386\u8005\u7684\u53E3\u543B\u56DE\u5FC6\u3002\n\n## \u4E00\u4E2A\u4E8B\u4EF6\u5FC5\u987B\u5199\u6E05\u7684\u4E94\u4E2A\u73AF\u8282\n\n1. **\u52A8\u673A**\uFF1A\u6211\u5F53\u65F6\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A\uFF1F\u6839\u636E\u4EC0\u4E48\u7EBF\u7D22\u3001\u76EE\u6807\u3001\u7EA6\u675F\u505A\u7684\u5224\u65AD\uFF1F\u5F53\u65F6\u6211\u4EE5\u4E3A\u4F1A\u600E\u6837\uFF1F\n2. **\u884C\u52A8**\uFF1A\u6211\u5B9E\u9645\u505A\u4E86\u4EC0\u4E48\uFF1F\u5177\u4F53\u5230\u52A8\u4F5C\u5C42\u9762\uFF08\u8BFB\u4E86\u54EA\u4E2A\u6587\u4EF6\u3001\u8DD1\u4E86\u4EC0\u4E48\u547D\u4EE4\u3001\u6539\u4E86\u54EA\u6BB5\u4EE3\u7801\u3001\u53D1\u4E86\u4EC0\u4E48\u6D88\u606F\uFF09\u3002\n3. **\u8C03\u6574**\uFF1A\u8FC7\u7A0B\u4E2D\u6211\u5982\u4F55\u6539\u4E3B\u610F\u3001\u7EA0\u9519\u3001\u7ED5\u8FC7\u963B\u788D\uFF1F\uFF08\u6CA1\u6709\u5C31\u7559\u7A7A\uFF0C\u4E0D\u8981\u7F16\u9020\uFF09\n4. **\u56DE\u5E94**\uFF1A\u5BF9\u65B9\uFF08\u7528\u6237/\u5176\u4ED6\u4EBA/\u7CFB\u7EDF\uFF09\u5982\u4F55\u56DE\u5E94\uFF1F\u8BF4\u4E86\u4EC0\u4E48\u3001\u505A\u4E86\u4EC0\u4E48\u3001\u6709\u6CA1\u6709\u53CD\u9A73\u6216\u8865\u5145\uFF1F\n5. **\u7ED3\u679C**\uFF1A\u6700\u7EC8\u662F\u4EC0\u4E48\u72B6\u6001\uFF1F\u505A\u6210\u4E86\u3001\u534A\u6210\u54C1\u3001\u5931\u8D25\u4E86\u3001\u8FD8\u662F\u5728\u7EE7\u7EED\uFF1F\u7559\u4E0B\u4E86\u4EC0\u4E48\u4EA7\u7269\u6216\u8BC1\u636E\uFF1F\n\n## \u65F6\u95F4\u3001\u573A\u666F\u3001\u4EBA\u7269\n\n- \u65F6\u95F4\u7528\u5317\u4EAC\u65F6\u95F4\u6807\u6CE8\uFF08+08:00\uFF09\uFF0C\u7ED9\u51FA\u4E8B\u4EF6\u5F00\u59CB\u4E0E\u7ED3\u675F\uFF1B\u4E0D\u786E\u5B9A\u5C31\u53D6\u7247\u6BB5\u8FB9\u754C\u7684\u8FD1\u4F3C\u503C\u3002\n- \u573A\u666F\u8981\u5199\u6E05 cwd\u3001\u9879\u76EE\u540D\u3001\u6240\u5728\u6E20\u9053\uFF08web / \u7EC8\u7AEF / IM \u7B49\uFF09\uFF0C\u80FD\u786E\u5B9A\u624D\u5199\u3002\n- \u4EBA\u7269\u53EA\u5199\u771F\u5B9E\u51FA\u73B0\u8FC7\u7684\uFF1A\u6211\u3001\u7528\u6237\u3001\u88AB\u63D0\u53CA\u6216\u6709\u4E92\u52A8\u7684\u7B2C\u4E09\u65B9\uFF1B\u7ED9\u51FA\u89D2\u8272\u3002\n\n## \u60C5\u7EEA\uFF08\u5FC5\u987B\u6709\u4F9D\u636E\uFF09\n\n- \u53EA\u6709\u6587\u672C\u6216\u884C\u4E3A\u91CC\u6709\u4F9D\u636E\u65F6\u624D\u8BB0\u5F55\u60C5\u7EEA\uFF1B\u6CA1\u6709\u4F9D\u636E\u5C31\u4E0D\u8981\u5199\uFF0C\u5B81\u53EF\u7559\u7A7A\u3002\n- \u60C5\u7EEA\u8981\u6807\u6CE8\u5F52\u5C5E\uFF08\u6211 / \u7528\u6237 / \u67D0\u4EBA\uFF09\u3001\u5185\u5BB9\u3001**\u4F9D\u636E**\uFF08\u539F\u8BDD\u6216\u5177\u4F53\u884C\u4E3A\uFF09\u3002\n- basis \u7528 fact\uFF08\u5BF9\u65B9\u660E\u8BF4\u4E86/\u660E\u786E\u8868\u73B0\uFF09\u6216 inference\uFF08\u6211\u4ECE\u8BED\u6C14\u884C\u4E3A\u63A8\u65AD\uFF0C\u6B64\u65F6\u7ED9 confidence\uFF09\u3002\n- \u4E0D\u8981\u4E3A\u4E86\u53D9\u4E8B\u751F\u52A8\u800C\u6DFB\u52A0\u60C5\u7EEA\u3002\n\n## \u4E8B\u5B9E\u3001\u63A8\u65AD\u3001\u8BA1\u5212\u3001\u5B8C\u6210 \u2014\u2014 \u5FC5\u987B\u533A\u5206\n\n- fact\uFF1A\u6211\u89C2\u5BDF\u5230\u7684\u3001\u88AB\u660E\u786E\u544A\u77E5\u7684\u3001\u5DE5\u5177\u8FD4\u56DE\u7684\u4E8B\u5B9E\u3002\n- inference\uFF1A\u6211\u7684\u63A8\u6D4B\u3001\u731C\u6D4B\u3001\u5224\u65AD\uFF08\u7ED9 confidence 0~1\uFF09\uFF0C\u4E0D\u8981\u4F2A\u88C5\u6210\u4E8B\u5B9E\u3002\n- plan\uFF1A\u6211\u6253\u7B97\u505A\u4F46\u8FD8\u6CA1\u505A\u3001\u6216\u53EA\u90E8\u5206\u505A\u7684\u3002\n- completion\uFF1A\u5DF2\u7ECF\u505A\u5B8C\u5E76\u786E\u8BA4\u7684\u3002\n- \u4E25\u7981\u628A\"\u8BA1\u5212\"\u5199\u6210\"\u5B8C\u6210\"\uFF0C\u4E25\u7981\u628A\"\u6211\u4EE5\u4E3A\"\u5199\u6210\"\u4E8B\u5B9E\"\uFF0C\u4E25\u7981\u7F8E\u5316\u5931\u8D25\u6216\u9690\u7792\u9519\u8BEF\u3002\n\n## \u5FE0\u5B9E\u6027\n\n- \u4E0D\u7F16\u9020\u4E0D\u5B58\u5728\u7684\u4FE1\u606F\uFF1B\u7247\u6BB5\u91CC\u6CA1\u6709\u7684\u5C31\u7559\u7A7A\u6570\u7EC4\u6216\u7701\u7565\u8BE5\u5B57\u6BB5\u3002\n- \u4E0D\u786E\u5B9A\u7684\u7EC6\u8282\u53EF\u4EE5\u7701\u7565\uFF0C\u4F46\u4E0D\u8981\u628A\u4E0D\u786E\u5B9A\u5199\u6210\u786E\u5B9A\u3002\n- \u5982\u679C\u7247\u6BB5\u672C\u8EAB\u53EA\u662F\u534A\u622A\u5DE5\u4F5C\uFF0C\u5C31\u5982\u5B9E\u5199\u6210 ongoing/partial\uFF0C\u5E76\u5199\u6E05\u7F3A\u53E3\u3002\n\n## \u65E5\u8BB0\u4F53\u88C1\uFF08diary\uFF09\n\n- \u8FDE\u8D2F\u7684\u7B2C\u4E00\u4EBA\u79F0\u56DE\u5FC6\u53D9\u4E8B\uFF0C\u81EA\u7136\u6BB5\u843D\uFF083~8 \u6BB5\uFF09\uFF0C\u65F6\u95F4\u7EBF\u6E05\u695A\u3002\n- \u53EF\u4EE5\u5199\"\u6211\u5F53\u65F6\u4EE5\u4E3A\u2026\u2026\u540E\u6765\u53D1\u73B0\u2026\u2026\"\"\u8FD9\u91CC\u6211\u6539\u4E86\u4E3B\u610F\"\u8FD9\u7C7B\u56DE\u5FC6\u8BED\u6C14\u3002\n- \u4E0D\u8981\u7528 Markdown \u6807\u9898\u3001\u4E0D\u8981\u7528\u9879\u76EE\u7B26\u53F7\u5217\u8868\u3001\u4E0D\u8981\u8D34\u547D\u4EE4\u539F\u6587\u957F\u4E32\u3002\n- \u65E5\u8BB0\u8981\u80FD\u72EC\u7ACB\u8BFB\u61C2\uFF1A\u5373\u4F7F\u4E0D\u770B\u6211\u5F53\u65F6\u7684\u4F1A\u8BDD\uFF0C\u4E5F\u80FD\u660E\u767D\u53D1\u751F\u4E86\u4EC0\u4E48\u3002\n\n## \u8F93\u51FA\n\n\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF08\u9876\u5C42\u53EA\u6709 structured \u4E0E diary \u4E24\u4E2A\u952E\uFF09\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002";
/** The exact response contract, appended after the guide. */
declare const RESPONSE_CONTRACT = "## \u54CD\u5E94\u5951\u7EA6\n\n\u9876\u5C42\u53EA\u80FD\u6709\u4E24\u4E2A\u952E\uFF1Astructured\uFF08\u5BF9\u8C61\uFF09\u4E0E diary\uFF08\u5B57\u7B26\u4E32\uFF09\u3002\n\n{\n  \"structured\": {\n    \"title\": \"\u4E00\u53E5\u8BDD\u6807\u9898\uFF08\u7B2C\u4E00\u4EBA\u79F0\uFF0C20 \u5B57\u4EE5\u5185\uFF09\",\n    \"startedAt\": \"2025-10-30T16:45:12+08:00\",\n    \"endedAt\": \"2025-10-30T17:02:40+08:00\",\n    \"scene\": { \"cwd\": \"/abs/path\", \"project\": \"\u9879\u76EE\u540D\", \"place\": \"\u73AF\u5883/\u673A\u5668\", \"channel\": \"web\", \"localTime\": \"2025-10-30 16:45 \u5317\u4EAC\u65F6\u95F4\" },\n    \"people\": [ { \"name\": \"\u6211\", \"role\": \"agent\" }, { \"name\": \"\u7528\u6237\", \"role\": \"human\" } ],\n    \"goals\": [\"\u6211\u8FD9\u4E00\u6BB5\u60F3\u8FBE\u6210\u4EC0\u4E48\"],\n    \"actions\": [\n      {\n        \"order\": 1,\n        \"why\": \"\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A\uFF08\u5F53\u65F6\u7684\u52A8\u673A\u4E0E\u5224\u65AD\u4F9D\u636E\uFF09\",\n        \"what\": \"\u6211\u5B9E\u9645\u505A\u4E86\u4EC0\u4E48\uFF08\u5177\u4F53\u52A8\u4F5C\uFF09\",\n        \"adjustment\": \"\u8FC7\u7A0B\u4E2D\u5982\u4F55\u8C03\u6574\uFF08\u6CA1\u6709\u5C31\u7701\u7565\uFF09\",\n        \"result\": \"\u8FD9\u4E2A\u52A8\u4F5C\u7684\u7ED3\u679C\uFF08\u89C2\u5BDF\u5230\u7684\uFF09\"\n      }\n    ],\n    \"statements\": [\n      { \"kind\": \"fact\", \"text\": \"\u89C2\u5BDF\u5230/\u88AB\u544A\u77E5\u7684\u4E8B\u5B9E\" },\n      { \"kind\": \"inference\", \"text\": \"\u6211\u7684\u63A8\u65AD\", \"confidence\": 0.6 },\n      { \"kind\": \"plan\", \"text\": \"\u6253\u7B97\u505A\u4F46\u8FD8\u6CA1\u505A\u5B8C\u7684\u4E8B\" },\n      { \"kind\": \"completion\", \"text\": \"\u5DF2\u7ECF\u5B8C\u6210\u5E76\u786E\u8BA4\u7684\u4E8B\" }\n    ],\n    \"emotions\": [\n      { \"who\": \"\u7528\u6237\", \"emotion\": \"\u4E0D\u8010\u70E6\", \"evidence\": \"\u539F\u8BDD\u6216\u884C\u4E3A\u4F9D\u636E\", \"basis\": \"inference\" }\n    ],\n    \"outcome\": { \"status\": \"completed | partial | failed | ongoing | planned\", \"summary\": \"\u4E00\u53E5\u8BDD\u7ED3\u679C\", \"artifacts\": [\"\u4EA7\u51FA\u7684\u6587\u4EF6/\u63D0\u4EA4/\u94FE\u63A5\"] },\n    \"tags\": [\"\u4E3B\u9898\u6807\u7B7E\"],\n    \"keywords\": [\"\u4FBF\u4E8E\u65E5\u540E\u68C0\u7D22\u7684\u5173\u952E\u8BCD\"],\n    \"entities\": [\"\u6D89\u53CA\u7684\u6280\u672F\u540D/\u6587\u4EF6\u540D/\u4EBA\u540D\"],\n    \"lessons\": [\"\u6211\u5F97\u5230\u7684\u6559\u8BAD\u6216\u53EF\u590D\u7528\u7684\u505A\u6CD5\"],\n    \"openQuestions\": [\"\u5F53\u65F6\u8FD8\u6CA1\u89E3\u51B3\u7684\u95EE\u9898\"]\n  },\n  \"diary\": \"\u7B2C\u4E00\u4EBA\u79F0\u8FDE\u8D2F\u53D9\u4E8B\u6B63\u6587\uFF08\u7EAF\u6587\u672C\uFF0C\u53EF\u542B\u6362\u884C\uFF0C\u4E0D\u8981 Markdown \u6807\u9898\uFF09\"\n}\n\n\u7EA6\u675F\uFF1A\n- status \u53EA\u80FD\u53D6 completed / partial / failed / ongoing / planned \u4E4B\u4E00\uFF0C\u5E76\u4E0E\u6B63\u6587\u4E00\u81F4\u3002\n- statements \u91CC\u5FC5\u987B\u660E\u786E\u533A\u5206 fact / inference / plan / completion\u3002\n- emotions \u6CA1\u6709\u4F9D\u636E\u5C31\u4E0D\u5199\uFF1B\u5199\u4E86\u5C31\u5FC5\u987B\u6709 evidence \u4E0E basis\u3002\n- \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002";
/** Raised when DeepSeek's answer cannot be turned into an event. */
declare class EncodingError extends Error {
    readonly detail: string;
    constructor(message: string, detail?: string);
}
/** System prompt for one encoding pass. */
declare function buildSystemPrompt(config: MemoryConfig): string;
/**
 * Render the unit's records as the line-oriented transcript the encoder reads.
 *
 * ```
 * [12] 2025-10-30 16:45:12 用户：…
 * [14] 2025-10-30 16:45:31 我调用工具 bash：{"command":"ls"}
 * [15] 2025-10-30 16:45:32 工具结果 bash（失败）：…
 * ```
 */
declare function renderUnitRecords(unit: EventUnit): string;
/** Build the system + user messages for one unit. */
declare function buildEncodingRequest(config: MemoryConfig, unit: EventUnit): {
    system: string;
    user: string;
};
/** Coerce one unknown value into a validated structure:never-invented event. */
declare function normalizeEncodedEvent(value: unknown): EncodedEvent;
/** Parse whatever DeepSeek returned into a validated event. */
declare function parseEncodingResponse(text: string): EncodedEvent;

/** AutoBioMemory — DeepSeek chat client (encoding calls). */

declare class DeepseekError extends Error {
    readonly status?: number;
    readonly body?: string;
    constructor(message: string, options?: {
        status?: number;
        body?: string;
    });
}
interface DeepseekChatOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    jsonMode?: boolean;
}
type ChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};
declare class DeepseekClient {
    private readonly config;
    private readonly apiKey;
    private readonly logger;
    lastUsage: {
        model: string;
        promptTokens: number;
        completionTokens: number;
    } | undefined;
    constructor(config: DeepseekConfig, apiKey: string, logger?: Logger);
    private endpoint;
    chat(messages: ChatMessage[], options?: DeepseekChatOptions): Promise<string>;
}

/** AutoBioMemory — one event unit → one encoded event (with provenance). */

interface DistillDeps {
    config: MemoryConfig;
    apiKey: string;
    logger?: Logger;
    /** Injectable transport for tests; defaults to a real DeepSeek chat client. */
    client?: Pick<DeepseekClient, 'chat'> & {
        lastUsage?: DeepseekClient['lastUsage'];
    };
}
/** Encode one unit, always stamping it with its provenance. */
declare function encodeUnit(deps: DistillDeps, unit: EventUnit): Promise<EncodedEvent>;
/** A `Distiller` bound to one config + key. */
declare function createDistiller(deps: DistillDeps): Distiller;

/**
 * AutoBioMemory — paired JSON/MD event storage.
 *
 * Every event lives as two files under `<root>/events/`:
 *
 * - `<id>.json` — the full `EventRecord` (structured event + diary + hash).
 * - `<id>.md`   — exactly the diary body, plus one trailing newline.
 *
 * `state/events-index.json` caches one `EventSummary` per pair so list/recall
 * calls do not have to parse every JSON. The index is derived data: whenever it
 * is missing, stale, or explicitly refreshed, the events directory is rescanned
 * and reconciled. Broken pairs are reported through `EventSummary.problem` and
 * fixed by `repairPairs`, which also quarantines files it cannot understand.
 *
 * The module takes `MemoryPaths` as an argument everywhere (it never imports
 * `paths.ts`), so it is trivially testable with temporary roots.
 */

/** Absolute path of the derived event index. */
declare function eventIndexPath(paths: MemoryPaths): string;
/** Full record for one event, or `undefined` when the JSON is absent/unusable. */
declare function readEvent(paths: MemoryPaths, id: string): EventRecord | undefined;
/** Diary body for one event, or `undefined` when `<id>.md` is absent. */
declare function readDiary(paths: MemoryPaths, id: string): string | undefined;
/**
 * Write one JSON/MD pair atomically and fold it into the index.
 *
 * The JSON is written first, then the MD. If the MD write fails the JSON is
 * rolled back (restored when a previous version existed, removed otherwise), so
 * a failed call never leaves a half-written pair behind.
 */
declare function writeEventPair(paths: MemoryPaths, record: EventRecord): {
    jsonFile: string;
    mdFile: string;
    created: boolean;
};
/**
 * Event summaries, newest `occurredAt` first.
 *
 * Without `refresh` the persisted index is trusted when present and readable;
 * with `refresh` (or a missing/corrupt index) the events directory is rescanned,
 * reconciled, persisted, and returned.
 */
declare function listEventSummaries(paths: MemoryPaths, options?: {
    refresh?: boolean;
}): EventSummary[];
/** `ev_<YYYYMMDDTHHMMSS in Beijing time>_<8 hex>`; stable and filesystem-safe. */
declare function eventIdFor(startedAt: string, contentHash: string): string;
/**
 * Assemble a persisted record from an encoded event.
 *
 * The diary is normalised (trailing newlines removed) so the MD half is exactly
 * `diary + "\n"` and `sha256(diary)` is stable across a JSON/MD round-trip.
 */
declare function buildRecord(encoded: EncodedEvent, options: {
    id: string;
    now?: string;
    revision?: number;
}): EventRecord;
/**
 * The newest `limit` event summaries plus a Chinese block ready for prompt
 * injection. Broken pairs are skipped and called out; the rendered block is
 * capped at ~20k characters with an explicit truncation note.
 */
declare function shortTermMemory(paths: MemoryPaths, limit: number): {
    summaries: EventSummary[];
    text: string;
};
/**
 * Make every pair internally consistent, idempotently.
 *
 * - missing `.md` → regenerated from the JSON `diary`;
 * - stale `diaryHash` → JSON rewritten with the recomputed hash;
 * - `.md` body that disagrees with the JSON → regenerated from the JSON;
 * - orphan `.md` files and unreadable JSON (plus their companions) → moved to
 *   `events/_quarantine/` with a `.quarantined-<timestamp>` suffix.
 */
declare function repairPairs(paths: MemoryPaths): {
    repaired: string[];
    quarantined: string[];
    skipped: string[];
};

/**
 * AutoBioMemory — local vector index.
 *
 * One SQLite file (`<root>/vectors/index.sqlite`) holds every event embedding.
 * Vectors are stored as little-endian Float32 BLOBs with a cached L2 norm, so a
 * cosine scan is one blob read per row. `node:sqlite` (shipped with Node 24)
 * keeps this module dependency-free and importable from a plain Node process.
 *
 * Contract (docs/module-contracts.md): `VectorStore implements VectorSource`.
 * `VectorRow`/`VectorHit`/`VectorSource` are the shared vocabulary from
 * `types.ts` and are re-exported here for convenience.
 */

/** Serialise a vector the way every row stores it: little-endian Float32. */
declare function vectorToBlob(vector: number[]): Buffer;
/** Read back a Float32 blob produced by `vectorToBlob`. */
declare function blobToVector(blob: Buffer | Uint8Array): number[];
/** Euclidean (L2) norm; `0` when the vector is empty or not finite. */
declare function vectorNorm(vector: number[]): number;
/**
 * Cosine similarity in `[-1, 1]`.
 *
 * Returns `0` for dimension mismatches, empty vectors and zero vectors instead
 * of throwing: retrieval treats a non-comparable row as "no signal".
 */
declare function cosineSimilarity(a: number[], b: number[]): number;
/**
 * SQLite-backed vector index.
 *
 * The constructor creates the parent directory, the schema and (when the
 * filesystem supports it) WAL journalling, so `new VectorStore(paths.vectorDb)`
 * is all a caller needs.
 */
declare class VectorStore implements VectorSource {
    private readonly db;
    private closed;
    constructor(dbFile: string);
    /** Insert or replace rows in one transaction; returns the number of rows written. */
    upsert(rows: VectorRow[]): number;
    get(eventId: string): VectorRow | undefined;
    /** Every row, ordered by `event_id` so scans are deterministic. */
    all(): VectorRow[];
    /** Delete the given event ids in one transaction; returns rows actually removed. */
    delete(eventIds: string[]): number;
    count(): number;
    /** Model that owns the most rows, i.e. the model the index was built with. */
    modelOf(): string | undefined;
    close(): void;
}
/**
 * Brute-force cosine search.
 *
 * Only rows whose stored `dimensions` (and actual blob length) match the query
 * are scored. `allowIds` restricts the candidate set; an empty set means "no
 * candidates" and yields `[]` rather than "unrestricted". Ties break by
 * `eventId` ascending, so repeated searches are reproducible.
 */
declare function searchVectors(store: VectorStore, query: number[], topK: number, allowIds?: Set<string>): VectorHit[];
/**
 * Events whose stored `text_hash` differs from the event's current `diaryHash`.
 *
 * Hash-only by design: a row for another embedding model (or another
 * dimension) is still current as far as text freshness goes; callers decide
 * whether the model itself has to change (`store.modelOf()`).
 */
declare function staleEventIds(store: VectorStore, summaries: EventSummary[]): string[];
/** Events that have no vector row at all. */
declare function missingEventIds(store: VectorStore, summaries: EventSummary[]): string[];

/**
 * AutoBioMemory — DashScope (Beijing) HTTP clients: embeddings + rerank.
 *
 * Both clients are plain `fetch` calls against the DashScope REST API, with a
 * per-attempt `AbortController` timeout and bounded exponential-backoff retries
 * for transient failures (429 / 5xx / network). Nothing here imports the dsh
 * runtime, so the CLI, `consolidate` and the tests can all drive it.
 *
 * The API key is only ever placed in the `Authorization` header; it never
 * reaches a log line, an error message or a `DashscopeError` body.
 */

/** Raised for any DashScope failure: HTTP error, bad payload, exhausted retries. */
declare class DashscopeError extends Error {
    readonly status?: number;
    readonly body?: string;
    readonly code?: string;
    constructor(message: string, options?: {
        status?: number;
        body?: string;
        code?: string;
    });
}
/** `POST {baseUrl}/compatible-mode/v1/embeddings` */
declare function embeddingEndpoint(config: DashscopeConfig): string;
/** `POST {baseUrl}/api/v1/services/rerank/text-rerank/text-rerank` */
declare function rerankEndpoint(config: DashscopeConfig): string;
/**
 * DashScope embedding client.
 *
 * Texts are split into `embeddingBatchSize` batches (run with bounded
 * concurrency) and re-assembled in input order. Every batch logs exactly one
 * debug line; failures are retried for transient statuses only and then raised
 * as `DashscopeError`.
 */
declare function createEmbedder(config: DashscopeConfig, apiKey: string, logger?: Logger): Embedder;
/**
 * DashScope rerank client.
 *
 * With `rerankEnabled === false` this still returns a `Reranker`, but it never
 * touches the network: it returns the input order with a decaying
 * `1 / (i + 1)` score, so the rest of the pipeline keeps working unchanged.
 */
declare function createReranker(config: DashscopeConfig, apiKey: string, logger?: Logger): Reranker;
/**
 * Embed exactly one text.
 *
 * The text is whitespace-collapsed first (DashScope rejects empty input), and
 * an empty result, an empty text or a wrong-dimension row raises a descriptive
 * `Error` instead of a silently empty vector.
 */
declare function embedOne(embedder: Embedder, text: string): Promise<number[]>;

/**
 * AutoBioMemory — recall pipeline.
 *
 * Four additive stages over injected data only: this module must stay importable
 * on its own branch, so it never imports `store.ts` or `vectors.ts`. Everything a
 * recall needs arrives through `RecallDeps` (summaries, a record loader, and the
 * optional vector index / embedder / reranker seams).
 *
 * Stage order (`docs/module-contracts.md`, "src/retrieval.ts"):
 *   1. short-term  — newest `retrieval.shortTermCount` events, always included.
 *   2. structured  — `matchFilters` over every summary, capped by `candidateLimit`.
 *   3. vector      — cosine over the candidate ids, keep `vectorTopK`.
 *   4. rerank      — score the union with the reranker, cut to the final limit,
 *                    but always keep the newest two short-term hits.
 *
 * Every stage is try/catch-contained: a failure becomes a note and the pipeline
 * continues. An abort is the one exception and is re-thrown as `util.AbortError`.
 */

interface RecallDeps {
    config: MemoryConfig;
    /** Every known event, any order (newest-first is fastest). */
    summaries: EventSummary[];
    /** Loads one full event record, or `undefined` when it disappeared. */
    readRecord: (eventId: string) => EventRecord | undefined;
    /** Vector rows; when absent the vector stage is skipped and noted. */
    vectors?: VectorSource;
    embedder?: Embedder;
    reranker?: Reranker;
    logger?: Logger;
    signal?: AbortSignal;
}
/**
 * Structured-filter predicate.
 *
 * - `since` / `until` intersect the event span `[occurredAt, endedAt]`, so an event
 *   that merely *overlaps* the window matches.
 * - `people` / `projects` / `tags` / `keywords` / `entities` are case-insensitive
 *   intersections: any-of inside one field, all-of across fields. The record (when
 *   loaded) contributes extra values so filters keep working for sparse summaries.
 * - `status` is a whitelist.
 * - `text` is a substring test over title + diary; without a record it falls back
 *   to title + tags, since that is all the summary carries.
 */
declare function matchFilters(summary: EventSummary, record: EventRecord | undefined, filters?: RecallFilters): boolean;
/**
 * Normalise loose CLI/tool arguments into `RecallFilters`.
 *
 * Accepts arrays *or* comma-separated strings (and singular aliases such as
 * `tag` / `person`), validates `status` against `EventStatus`, and only keeps
 * `since` / `until` when `util.parseIso` can read them. Unknown keys are ignored.
 */
declare function parseFilterArguments(input: Record<string, unknown>): RecallFilters;
/**
 * The Chinese-labelled block handed back to the agent.
 *
 * One `## 事件 …` header per hit, the diary body, then (when
 * `retrieval.includeSources`) a `来源：…` line; blocks are separated by `---`.
 * The whole hit section honours `retrieval.maxReplyChars`, and when the budget
 * cuts something an explicit `已截断` note closes the block.
 */
declare function renderRecallText(hits: RecallHit[], config: MemoryConfig, notes: string[]): string;
/**
 * Run the four-stage recall pipeline.
 *
 * Never throws for data/transport problems — those are recorded in `notes` and the
 * surviving stages still produce hits. `deps.signal` aborts with `util.AbortError`.
 */
declare function recall(deps: RecallDeps, query: RecallQuery): Promise<RecallResult>;

/**
 * AutoBioMemory — the write path.
 *
 * Turns raw session transcripts into first-person event diaries:
 * incremental read (by cursor, in place) → event segmentation → DeepSeek encoding →
 * paired JSON/MD storage → embedding into the local vector index → cursor advance.
 *
 * Crash safety: the cursor for one session only advances after the event pair (and, when
 * the embedding succeeded, its vector row) is durable. A failed unit is recorded in
 * `state/status.json` with exponential backoff so the next run resumes it instead of
 * losing it.
 */

interface ConsolidateDeps {
    paths?: MemoryPaths;
    config: MemoryConfig;
    secrets: SecretSource;
    logger?: Logger;
    distiller?: Distiller;
    embedder?: Embedder;
    /** Session file the trigger pointed at; it is consolidated first. */
    currentSessionFile?: string;
    /** Skip the cooldown for explicit CLI / tool invocations. */
    force?: boolean;
    signal?: AbortSignal;
    dryRun?: boolean;
    now?: () => number;
}
/**
 * Run one consolidation pass.
 *
 * Never throws for per-session or per-event problems: they are recorded as failures and the
 * run continues. Throws only when the data root cannot be prepared or no API key is available.
 */
declare function consolidate(input: ConsolidateDeps): Promise<ConsolidationResult>;
declare function consolidateOnce(input: ConsolidateDeps): Promise<ConsolidationResult>;
declare function isConsolidating(): boolean;

/** AutoBioMemory — minimal leveled logger (never logs secrets). */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
interface LoggerOptions {
    level?: LogLevel;
    /** Receives one fully formatted line. Defaults to stderr. */
    sink?: (line: string) => void;
    /** Prefix shown on every line. */
    scope?: string;
}
declare function createLogger(options?: LoggerOptions): Logger;
declare function silentLogger(): Logger;

export { Config, type ConsolidateDeps, type ConsolidationConfig, type ConsolidationResult, type CursorState, DIRS, type DashscopeConfig, DashscopeError, DeepseekClient, type DeepseekConfig, DeepseekError, type Distiller, ENCODING_GUIDE, type Embedder, type EncodedEvent, EncodingError, type EventAction, type EventEmbeddingBookkeeping, type EventEmotion, type EventOutcome, type EventPerson, type EventRecord, type EventScene, type EventSourceRef, type EventStatement, type EventStatus, type EventSummary, type EventUnit, FILES, type FailureEntry, type LogLevel, type Logger, type LoggerOptions, type MemoryConfig, type MemoryPaths, type PluginConfig, RESPONSE_CONTRACT, type RawRecord, type RawRecordKind, type RecallFilters, type RecallHit, type RecallQuery, type RecallResult, type RerankHit, type Reranker, type RetrievalConfig, type RunState, SCHEMA_VERSION, STATE_VERSION, type SecretSource, type SessionCursor, type SessionSourceConfig, type SessionTranscript, type StatementKind, type StructuredEvent, type TriggerConfig, type VectorHit, type VectorRow, type VectorSource, VectorStore, apply, blobToVector, buildEncodingRequest, buildRecord, buildSystemPrompt, buildUnits, clearFailure, consolidate, consolidateOnce, cosineSimilarity, createDistiller, createEmbedder, createLogger, createReranker, decodeZstdFrames, _default as default, defaultConfig, embedOne, embeddingEndpoint, encodeUnit, ensureConfig, ensureDataLayout, eventIdFor, eventIndexPath, eventPair, expandSessionDirs, failureKey, getSessionCursor, inject, isConsolidating, isCoolingDown, listEventSummaries, listSessionFiles, loadConfig, loadCursor, loadRunState, matchFilters, memoryPaths, mergeConfig, missingEventIds, name, normalizeEncodedEvent, normalizeRecords, parseDotEnv, parseEncodingResponse, parseFilterArguments, pendingFailures, pendingRecords, putSessionCursor, readDiary, readEvent, readSecrets, readTranscript, recall, recordFailure, renderRecallText, renderRecords, renderUnitRecords, repairPairs, requireSecret, rerankEndpoint, resolveDataRoot, saveCursor, saveRunState, searchVectors, sessionIdFromPath, shortTermMemory, silentLogger, spanHash, staleEventIds, unitOptionsFromConfig, validateConfig, vectorNorm, vectorToBlob, writeConfig, writeEnvFile, writeEventPair };
