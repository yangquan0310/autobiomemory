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

import { AbortError, collapseWhitespace, parseIso, throwIfAborted, truncate } from './util.js'
import type {
  Embedder,
  EventRecord,
  EventStatus,
  EventSummary,
  Logger,
  MemoryConfig,
  RecallFilters,
  RecallHit,
  RecallQuery,
  RecallResult,
  Reranker,
  VectorSource,
} from './types.js'

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Tuning knobs
 * ------------------------------------------------------------------ */

/** `RecallHit.via` labels in stage order; also the sort key for merged hits. */
const STAGE_ORDER = ['short-term', 'structured', 'vector', 'rerank'] as const
type RecallStage = (typeof STAGE_ORDER)[number]

/** How many recent short-term hits are guaranteed a slot even without a score. */
const SHORT_TERM_GUARANTEE = 2

/** Characters of the diary sent to the reranker (title excluded). */
const RERANK_DOC_CHARS = 1200

const BLOCK_SEPARATOR = '\n\n---\n\n'

const KNOWN_STATUSES: readonly EventStatus[] = ['completed', 'partial', 'failed', 'ongoing', 'planned']

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function occurredAtMs(summary: EventSummary): number {
  return parseIso(summary.occurredAt) ?? parseIso(summary.endedAt) ?? 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof AbortError || (error instanceof Error && error.name === 'AbortError')
}

/** Positive integer, or `fallback` for 0 / negative / non-finite input. */
function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored > 0 ? floored : fallback
}

/** Newest first by `occurredAt`, then `endedAt`, then id (stable, deterministic). */
function sortSummariesNewestFirst(summaries: EventSummary[]): EventSummary[] {
  return [...summaries].sort((a, b) => {
    const byStart = occurredAtMs(b) - occurredAtMs(a)
    if (byStart !== 0) return byStart
    const byEnd = (parseIso(b.endedAt) ?? 0) - (parseIso(a.endedAt) ?? 0)
    if (byEnd !== 0) return byEnd
    return a.id.localeCompare(b.id)
  })
}

/** Lower-cased, trimmed, non-empty value set; `undefined` when nothing is left. */
function valueSet(values: Iterable<string> | undefined): Set<string> | undefined {
  if (!values) return undefined
  const out = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    if (normalized.length > 0) out.add(normalized)
  }
  return out.size > 0 ? out : undefined
}

function hasAny(candidates: Set<string> | undefined, wanted: Set<string>): boolean {
  if (!candidates) return false
  for (const needle of wanted) {
    if (candidates.has(needle)) return true
  }
  return false
}

function summaryValues(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.filter((value): value is string => typeof value === 'string')
}

/** Case-insensitive cosine similarity of two dense vectors. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number | undefined {
  if (a.length === 0 || a.length !== b.length) return undefined
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0
    const right = b[index] ?? 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/* ------------------------------------------------------------------ *
 * Filter matching
 * ------------------------------------------------------------------ */

/** True when a filter needs the full record (diary text / project scene). */
function filtersNeedRecord(filters: RecallFilters | undefined): boolean {
  if (!filters) return false
  const text = typeof filters.text === 'string' ? filters.text.trim() : ''
  return text.length > 0 || (Array.isArray(filters.projects) && filters.projects.length > 0)
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
export function matchFilters(
  summary: EventSummary,
  record: EventRecord | undefined,
  filters?: RecallFilters,
): boolean {
  if (!filters) return true
  const structured = record?.structured

  const sinceMs = parseIso(filters.since)
  const untilMs = parseIso(filters.until)
  if (sinceMs !== undefined || untilMs !== undefined) {
    const startMs = parseIso(summary.occurredAt) ?? parseIso(structured?.startedAt)
    const parsedEnd = parseIso(summary.endedAt) ?? parseIso(structured?.endedAt) ?? startMs
    if (startMs === undefined || parsedEnd === undefined) return false
    const endMs = Math.max(startMs, parsedEnd)
    if (sinceMs !== undefined && endMs < sinceMs) return false
    if (untilMs !== undefined && startMs > untilMs) return false
  }

  if (Array.isArray(filters.status) && filters.status.length > 0) {
    const wanted = new Set(filters.status.map((status) => String(status).trim().toLowerCase()))
    if (!wanted.has(String(summary.status).toLowerCase())) return false
  }

  const peopleWanted = valueSet(filters.people)
  if (peopleWanted) {
    const present = valueSet([
      ...summaryValues(summary.people),
      ...(structured?.people ?? []).map((person) => person?.name ?? ''),
    ])
    if (!hasAny(present, peopleWanted)) return false
  }

  const projectsWanted = valueSet(filters.projects)
  if (projectsWanted) {
    const present = valueSet([
      summary.project ?? '',
      structured?.scene?.project ?? '',
    ])
    if (!hasAny(present, projectsWanted)) return false
  }

  const tagsWanted = valueSet(filters.tags)
  if (tagsWanted) {
    const present = valueSet([...summaryValues(summary.tags), ...summaryValues(structured?.tags)])
    if (!hasAny(present, tagsWanted)) return false
  }

  const keywordsWanted = valueSet(filters.keywords)
  if (keywordsWanted) {
    const present = valueSet([
      ...summaryValues(summary.keywords),
      ...summaryValues(structured?.keywords),
    ])
    if (!hasAny(present, keywordsWanted)) return false
  }

  const entitiesWanted = valueSet(filters.entities)
  if (entitiesWanted) {
    const present = valueSet([
      ...summaryValues(summary.entities),
      ...summaryValues(structured?.entities),
    ])
    if (!hasAny(present, entitiesWanted)) return false
  }

  const needle = typeof filters.text === 'string' ? filters.text.trim().toLowerCase() : ''
  if (needle.length > 0) {
    const haystack = record
      ? `${summary.title}\n${record.diary ?? ''}`
      : `${summary.title}\n${summaryValues(summary.tags).join(' ')}`
    if (!haystack.toLowerCase().includes(needle)) return false
  }

  return true
}

/* ------------------------------------------------------------------ *
 * Filter parsing (used by the CLI and the recall tool)
 * ------------------------------------------------------------------ */

function toFilterValues(value: unknown): string[] {
  const collected: string[] = []
  const absorb = (text: string): void => {
    for (const part of text.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length > 0) collected.push(trimmed)
    }
  }
  if (typeof value === 'string') absorb(value)
  else if (typeof value === 'number' && Number.isFinite(value)) absorb(String(value))
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') absorb(item)
      else if (typeof item === 'number' && Number.isFinite(item)) absorb(String(item))
    }
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of collected) {
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const ARRAY_FILTER_KEYS = {
  people: ['people', 'person', 'who'],
  projects: ['projects', 'project'],
  tags: ['tags', 'tag'],
  keywords: ['keywords', 'keyword'],
  entities: ['entities', 'entity'],
} as const

/**
 * Normalise loose CLI/tool arguments into `RecallFilters`.
 *
 * Accepts arrays *or* comma-separated strings (and singular aliases such as
 * `tag` / `person`), validates `status` against `EventStatus`, and only keeps
 * `since` / `until` when `util.parseIso` can read them. Unknown keys are ignored.
 */
export function parseFilterArguments(input: Record<string, unknown>): RecallFilters {
  const filters: RecallFilters = {}

  for (const field of ['since', 'until'] as const) {
    const raw = input[field]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    if (parseIso(trimmed) === undefined) continue
    filters[field] = trimmed
  }

  const people = mergeKeys(input, ARRAY_FILTER_KEYS.people)
  if (people.length > 0) filters.people = people
  const projects = mergeKeys(input, ARRAY_FILTER_KEYS.projects)
  if (projects.length > 0) filters.projects = projects
  const tags = mergeKeys(input, ARRAY_FILTER_KEYS.tags)
  if (tags.length > 0) filters.tags = tags
  const keywords = mergeKeys(input, ARRAY_FILTER_KEYS.keywords)
  if (keywords.length > 0) filters.keywords = keywords
  const entities = mergeKeys(input, ARRAY_FILTER_KEYS.entities)
  if (entities.length > 0) filters.entities = entities

  const status = toFilterValues(input.status)
    .map((value) => value.toLowerCase())
    .filter((value): value is EventStatus => (KNOWN_STATUSES as readonly string[]).includes(value))
  if (status.length > 0) filters.status = [...new Set(status)]

  if (typeof input.text === 'string' && input.text.trim().length > 0) filters.text = input.text.trim()

  return filters
}

/** Collect every alias of one filter field, de-duplicated case-insensitively. */
function mergeKeys(input: Record<string, unknown>, keys: readonly string[]): string[] {
  const values: string[] = []
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    values.push(...toFilterValues(input[key]))
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = value.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(value)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function sourceLabel(source: EventSummarySource): string {
  return `${source.sessionFile} seq ${source.fromSeq}-${source.toSeq}`
}

/** Structural subset of `EventSourceRef` used for the provenance line. */
interface EventSummarySource {
  sessionFile: string
  fromSeq: number
  toSeq: number
}

function provenanceLine(hit: RecallHit): string {
  const labels = (hit.sources ?? []).map((source) => sourceLabel(source))
  return labels.length > 0 ? `来源：${labels.join('；')}` : ''
}

/**
 * The Chinese-labelled block handed back to the agent.
 *
 * One `## 事件 …` header per hit, the diary body, then (when
 * `retrieval.includeSources`) a `来源：…` line; blocks are separated by `---`.
 * The whole hit section honours `retrieval.maxReplyChars`, and when the budget
 * cuts something an explicit `已截断` note closes the block.
 */
export function renderRecallText(hits: RecallHit[], config: MemoryConfig, notes: string[]): string {
  const budget = Math.max(0, Math.floor(config.retrieval.maxReplyChars))
  const includeSources = config.retrieval.includeSources
  const blocks: string[] = []
  let used = 0
  let truncated = false

  for (const hit of hits) {
    const header = `## 事件 ${collapseWhitespace(hit.occurredAt)} · ${collapseWhitespace(hit.title)} · ${hit.status}`
    const provenance = includeSources ? provenanceLine(hit) : ''
    const body = typeof hit.diary === 'string' ? hit.diary : ''

    const layout = (diaryBody: string): string => {
      const parts = [header]
      if (diaryBody.length > 0) parts.push('', diaryBody)
      if (provenance.length > 0) parts.push('', provenance)
      return parts.join('\n')
    }

    const separatorCost = blocks.length > 0 ? BLOCK_SEPARATOR.length : 0
    const overhead = layout('').length + separatorCost
    const available = budget - used - overhead
    if (available < 0) {
      truncated = true
      break
    }

    const kept = body.length > available ? truncate(body, available) : body
    if (kept.length < body.length) truncated = true
    const block = layout(kept)
    blocks.push(block)
    used += block.length + separatorCost

    if (body.length > available) break
  }

  const parts: string[] = []
  if (blocks.length > 0) parts.push(blocks.join(BLOCK_SEPARATOR))
  else if (hits.length === 0) parts.push('（没有找到匹配的记忆）')

  const cleanNotes = notes.map((note) => note.trim()).filter((note) => note.length > 0)
  if (cleanNotes.length > 0) parts.push(cleanNotes.map((note) => `（${note}）`).join('\n'))
  if (truncated) parts.push(`（已截断：超出 ${budget} 字符预算，后续内容未显示）`)

  return parts.join('\n\n')
}

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

interface RecallEntry {
  summary: EventSummary
  via: Set<RecallStage>
  cosine?: number
  rerankScore?: number
}

/** Stage-order sort key for a merged hit's `via` array. */
function orderedVia(via: Set<RecallStage>): RecallHit['via'] {
  return STAGE_ORDER.filter((stage) => via.has(stage))
}

/**
 * Ordering used once no reranker is in play (and as the tie-break under rerank):
 * reranked hits first, then cosine-scored hits, then the rest; inside a group the
 * better score wins, then the newer event. Fully deterministic.
 */
function compareEntries(a: RecallEntry, b: RecallEntry): number {
  const rank = (entry: RecallEntry): number =>
    entry.rerankScore !== undefined ? 0 : entry.cosine !== undefined ? 1 : 2
  const rankA = rank(a)
  const rankB = rank(b)
  if (rankA !== rankB) return rankA - rankB

  if (a.rerankScore !== undefined && b.rerankScore !== undefined && a.rerankScore !== b.rerankScore) {
    return b.rerankScore - a.rerankScore
  }
  if (a.cosine !== undefined && b.cosine !== undefined && a.cosine !== b.cosine) {
    return b.cosine - a.cosine
  }
  const byTime = occurredAtMs(b.summary) - occurredAtMs(a.summary)
  if (byTime !== 0) return byTime
  return a.summary.id.localeCompare(b.summary.id)
}

/**
 * Run the four-stage recall pipeline.
 *
 * Never throws for data/transport problems — those are recorded in `notes` and the
 * surviving stages still produce hits. `deps.signal` aborts with `util.AbortError`.
 */
export async function recall(deps: RecallDeps, query: RecallQuery): Promise<RecallResult> {
  const config = deps.config
  const retrieval = config.retrieval
  const logger = deps.logger
  const notes: string[] = []
  const stages: RecallResult['stages'] = { shortTerm: 0, structured: 0, vector: 0, rerank: 0 }

  throwIfAborted(deps.signal)

  const rawQuery = typeof query?.query === 'string' ? query.query : ''
  const queryText = rawQuery.trim()
  const emptyQuery = queryText.length === 0
  const filters = query?.filters
  if (emptyQuery) {
    notes.push('查询为空：按最近事件返回（仅短期记忆）')
    if (filters && Object.keys(filters).length > 0) notes.push('查询为空，结构化过滤条件未生效')
  }

  const summaries = Array.isArray(deps.summaries) ? deps.summaries : []
  const ordered = sortSummariesNewestFirst(summaries)
  const summaryById = new Map<string, EventSummary>()
  for (const summary of ordered) summaryById.set(summary.id, summary)

  const entries = new Map<string, RecallEntry>()
  const recordCache = new Map<string, EventRecord | undefined>()
  const missingRecordIds = new Set<string>()

  /** Page in a full record; failures degrade to `undefined` instead of throwing. */
  const loadRecord = (eventId: string): EventRecord | undefined => {
    throwIfAborted(deps.signal)
    if (recordCache.has(eventId)) return recordCache.get(eventId)
    let record: EventRecord | undefined
    try {
      record = deps.readRecord(eventId)
    } catch (error) {
      if (isAbortError(error)) throw error
      logger?.warn('读取事件记录失败', eventId, error)
      record = undefined
    }
    recordCache.set(eventId, record)
    return record
  }

  const addEntry = (summary: EventSummary, stage: RecallStage): RecallEntry => {
    let entry = entries.get(summary.id)
    if (!entry) {
      entry = { summary, via: new Set<RecallStage>() }
      entries.set(summary.id, entry)
    }
    entry.via.add(stage)
    return entry
  }

  const stageFailure = (label: string, error: unknown): void => {
    if (isAbortError(error)) throw error
    logger?.warn(`回忆阶段失败：${label}`, error)
    notes.push(`${label}阶段失败：${errorMessage(error)}`)
  }

  /* ---------------- stage 1: short-term ---------------- */

  const shortTermCount = Math.max(0, Math.floor(retrieval.shortTermCount))
  const shortTermEntries: RecallEntry[] = []
  try {
    for (const summary of ordered.slice(0, shortTermCount)) {
      shortTermEntries.push(addEntry(summary, 'short-term'))
    }
    stages.shortTerm = shortTermEntries.length
  } catch (error) {
    stageFailure('短期记忆', error)
  }

  /* ---------------- stage 2: structured ---------------- */

  let structuredCandidates: EventSummary[] = []
  if (!emptyQuery) {
    try {
      const candidateCap = positiveInt(retrieval.candidateLimit, ordered.length)
      const needsRecord = filtersNeedRecord(filters)
      const matched: EventSummary[] = []
      for (const summary of ordered) {
        throwIfAborted(deps.signal)
        const record = needsRecord ? loadRecord(summary.id) : undefined
        if (!matchFilters(summary, record, filters)) continue
        matched.push(summary)
        if (matched.length >= candidateCap) break
      }
      structuredCandidates = matched
      stages.structured = matched.length
      for (const summary of matched) addEntry(summary, 'structured')
    } catch (error) {
      stageFailure('结构化过滤', error)
    }
  }

  /* ---------------- stage 3: vector ---------------- */

  if (!emptyQuery) {
    const embedder = deps.embedder
    const vectors = deps.vectors
    if (!embedder || !vectors) {
      const missing: string[] = []
      if (!embedder) missing.push('embedder')
      if (!vectors) missing.push('vectors')
      notes.push(`向量阶段已跳过：缺少 ${missing.join(' 与 ')}`)
      logger?.debug('向量阶段跳过，缺少依赖', missing.join(','))
    } else {
      try {
        // An empty candidate set means "score everything" (contract wording).
        const allowed =
          structuredCandidates.length > 0
            ? new Set(structuredCandidates.map((summary) => summary.id))
            : new Set(ordered.map((summary) => summary.id))

        const embedded = await embedder.embed([queryText])
        throwIfAborted(deps.signal)
        const queryVector = Array.isArray(embedded) ? embedded[0] : undefined

        if (!queryVector || queryVector.length === 0) {
          notes.push('向量阶段已跳过：查询向量为空')
        } else {
          const scored = new Map<string, number>()
          for (const row of vectors.all()) {
            if (!row || typeof row.eventId !== 'string') continue
            if (!allowed.has(row.eventId) || !summaryById.has(row.eventId)) continue
            const score = cosineSimilarity(queryVector, Array.isArray(row.vector) ? row.vector : [])
            if (score === undefined) continue
            const previous = scored.get(row.eventId)
            if (previous === undefined || score > previous) scored.set(row.eventId, score)
          }

          const topK = positiveInt(retrieval.vectorTopK, scored.size)
          const ranked = [...scored.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, topK)

          for (const [eventId, cosine] of ranked) {
            const summary = summaryById.get(eventId)
            if (!summary) continue
            const entry = addEntry(summary, 'vector')
            if (entry.cosine === undefined || cosine > entry.cosine) entry.cosine = cosine
          }
          stages.vector = ranked.length
          if (ranked.length === 0) notes.push('向量阶段没有命中')
        }
      } catch (error) {
        stageFailure('向量', error)
      }
    }
  }

  /* ---------------- stage 4: rerank ---------------- */

  const union = [...entries.values()]
  if (!emptyQuery && union.length > 0) {
    if (!deps.reranker) {
      logger?.debug('未配置 reranker：按余弦与时间排序')
    } else {
      const reranker = deps.reranker
      try {
        const rerankLimit = positiveInt(retrieval.rerankTopN, union.length)
        const documents = union.map((entry) => {
          const record = loadRecord(entry.summary.id)
          const diary = record?.diary ?? ''
          return `${entry.summary.title}\n${truncate(diary, RERANK_DOC_CHARS)}`
        })

        const ranked = await reranker.rerank(queryText, documents, rerankLimit)
        throwIfAborted(deps.signal)

        for (const hit of Array.isArray(ranked) ? ranked : []) {
          if (!hit || !Number.isFinite(hit.index) || !Number.isFinite(hit.score)) continue
          const entry = union[Math.floor(hit.index)]
          if (!entry) continue
          if (entry.rerankScore === undefined || hit.score > entry.rerankScore) {
            entry.rerankScore = hit.score
          }
          entry.via.add('rerank')
        }
        stages.rerank = documents.length
      } catch (error) {
        stageFailure('重排', error)
      }
    }
  }

  /* ---------------- merge, score gate, cut ---------------- */

  const minScore = Number.isFinite(retrieval.minScore) ? retrieval.minScore : Number.NEGATIVE_INFINITY
  const survivors = union
    .filter((entry) => {
      const score = entry.rerankScore !== undefined ? entry.rerankScore : entry.cosine
      return score === undefined || score >= minScore
    })
    .sort(compareEntries)

  const requestedLimit = query?.limit !== undefined && Number.isFinite(query.limit) ? query.limit : retrieval.finalLimit
  const limit = Math.max(0, Math.floor(requestedLimit))

  const selected: RecallEntry[] = []
  // The newest short-term hits are reserved slots inside the limit, not extra ones:
  // the agent should always see its most recent past, even without keyword overlap.
  const guaranteeSlots = Math.min(SHORT_TERM_GUARANTEE, limit)
  for (const entry of shortTermEntries) {
    if (selected.length >= guaranteeSlots) break
    if (survivors.includes(entry)) selected.push(entry)
  }
  for (const entry of survivors) {
    if (selected.length >= limit) break
    if (!selected.includes(entry)) selected.push(entry)
  }

  /* ---------------- hits ---------------- */

  const maxReplyChars = Math.max(0, Math.floor(retrieval.maxReplyChars))
  const hits: RecallHit[] = []
  for (const entry of selected) {
    const summary = entry.summary
    const record = loadRecord(summary.id)
    if (!record && !missingRecordIds.has(summary.id)) {
      missingRecordIds.add(summary.id)
      notes.push(`事件 ${summary.id} 的记录缺失，仅返回索引信息`)
    }
    const diary = typeof record?.diary === 'string' ? truncate(record.diary, maxReplyChars) : ''
    const hit: RecallHit = {
      eventId: summary.id,
      title: summary.title,
      occurredAt: summary.occurredAt,
      status: summary.status,
      diary,
      via: orderedVia(entry.via),
      sources: Array.isArray(record?.structured?.sources) ? (record?.structured.sources ?? []) : [],
      tags: summaryValues(summary.tags),
      people: summaryValues(summary.people),
    }
    if (entry.cosine !== undefined) hit.cosine = entry.cosine
    if (entry.rerankScore !== undefined) hit.rerankScore = entry.rerankScore
    hits.push(hit)
  }

  const text = renderRecallText(hits, config, notes)
  logger?.debug('回忆完成', {
    query: queryText,
    hits: hits.length,
    stages,
    notes: notes.length,
  })

  return { query: rawQuery, hits, text, stages, notes }
}
