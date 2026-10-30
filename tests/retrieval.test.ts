/**
 * Recall pipeline tests — pure in-memory fakes, no network, no sqlite.
 *
 * Covers filter matching (every field + time-window overlap), candidate capping,
 * vector ordering, rerank reordering, `via` union, final-limit/short-term priority,
 * degraded dependencies (missing embedder, throwing reranker), rendering, abort
 * handling, empty queries and the CLI filter parser.
 */

import { describe, expect, it } from 'vitest'
import { AbortError } from '../src/util.js'
import { matchFilters, parseFilterArguments, recall, renderRecallText } from '../src/retrieval.js'
import type { RecallDeps } from '../src/retrieval.js'
import type {
  Embedder,
  EventRecord,
  EventSourceRef,
  EventStatus,
  EventSummary,
  MemoryConfig,
  RecallHit,
  RerankHit,
  Reranker,
  RetrievalConfig,
  VectorRow,
  VectorSource,
} from '../src/types.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const MINUTE = 60_000
/** Newest event starts here; every other event is `ago` minutes older. */
const BASE = Date.UTC(2025, 9, 30, 12, 0, 0)

function iso(offsetMinutes: number): string {
  return new Date(BASE - offsetMinutes * MINUTE).toISOString()
}

interface FixtureSpec {
  id: string
  title: string
  /** Minutes before BASE at which the event started. */
  ago: number
  /** Duration in minutes. */
  span: number
  status: EventStatus
  tags: string[]
  people: string[]
  keywords: string[]
  entities: string[]
  project: string
  diary: string
}

const FIXTURES: FixtureSpec[] = [
  {
    id: 'e1',
    title: '实现 recall 检索管线',
    ago: 0,
    span: 30,
    status: 'completed',
    tags: ['retrieval', '管线'],
    people: ['我', '用户'],
    keywords: ['recall', '向量'],
    entities: ['AutoBioMemory'],
    project: 'autobio',
    diary: '我今天写完了 recall 检索管线，接入了向量余弦与重排阶段。',
  },
  {
    id: 'e2',
    title: '调试向量索引',
    ago: 120,
    span: 20,
    status: 'partial',
    tags: ['vector'],
    people: ['我'],
    keywords: ['sqlite', '索引'],
    entities: ['AutoBioMemory'],
    project: 'autobio',
    diary: '调试 sqlite 向量索引，发现维度不匹配，索引需要重建。',
  },
  {
    id: 'e3',
    title: '撰写编码指导语',
    ago: 240,
    span: 10,
    status: 'completed',
    tags: ['prompt'],
    people: ['我'],
    keywords: ['prompt'],
    entities: ['DeepSeek'],
    project: 'autobio',
    diary: '写了中文的第一人称编码指导语，强调动机与调整。',
  },
  {
    id: 'e4',
    title: '与用户讨论记忆边界',
    ago: 360,
    span: 30,
    status: 'ongoing',
    tags: ['讨论'],
    people: ['我', '用户'],
    keywords: ['边界', '隐私'],
    entities: ['记忆'],
    project: 'autobio',
    diary: '和用户讨论记忆边界与隐私取舍，用户希望记忆可控。',
  },
  {
    id: 'e5',
    title: '会话读取器实现',
    ago: 480,
    span: 30,
    status: 'failed',
    tags: ['session'],
    people: ['我'],
    keywords: ['zstd', '解析'],
    entities: ['dsh'],
    project: 'autobio',
    diary: '解析 zstd 多帧失败，尾部帧被截断，需要逐帧扫描。',
  },
  {
    id: 'e6',
    title: '清理事件目录',
    ago: 600,
    span: 20,
    status: 'completed',
    tags: ['维护'],
    people: ['我'],
    keywords: ['清理'],
    entities: ['目录'],
    project: 'other',
    diary: '整理了事件目录与索引文件，删除重复日记。',
  },
  {
    id: 'e7',
    title: '规划下一步',
    ago: 720,
    span: 15,
    status: 'planned',
    tags: ['计划'],
    people: ['我'],
    keywords: ['排期'],
    entities: ['计划'],
    project: 'other',
    diary: '计划下次实现重排与预算截断。',
  },
  {
    id: 'e8',
    title: '长时间重构检索',
    ago: 780,
    span: 60,
    status: 'partial',
    tags: ['重构'],
    people: ['我', '协作者'],
    keywords: ['重构', 'retrieval'],
    entities: ['AutoBioMemory'],
    project: 'autobio',
    diary: '跨小时重构检索阶段，把过滤与排序拆开。',
  },
  {
    id: 'e9',
    title: '启动仓库',
    ago: 900,
    span: 10,
    status: 'completed',
    tags: ['init'],
    people: ['我'],
    keywords: ['git'],
    entities: ['AutoBioMemory'],
    project: 'autobio',
    diary: '初始化仓库与共享类型契约。',
  },
]

function specOf(id: string): FixtureSpec {
  const spec = FIXTURES.find((entry) => entry.id === id)
  if (!spec) throw new Error(`unknown fixture ${id}`)
  return spec
}

function makeSummary(spec: FixtureSpec): EventSummary {
  return {
    id: spec.id,
    title: spec.title,
    occurredAt: iso(spec.ago),
    endedAt: iso(spec.ago - spec.span),
    status: spec.status,
    tags: [...spec.tags],
    people: [...spec.people],
    keywords: [...spec.keywords],
    entities: [...spec.entities],
    project: spec.project,
    diaryHash: `hash-${spec.id}`,
    diaryChars: spec.diary.length,
    revision: 1,
    jsonFile: `/root/events/${spec.id}.json`,
    mdFile: `/root/events/${spec.id}.md`,
    updatedAt: iso(0),
  }
}

function makeSource(id: string, fromSeq: number, toSeq: number): EventSourceRef {
  return {
    sessionId: `session-${id}`,
    sessionFile: `/sessions/${id}.jsonl.zstd`,
    cwd: '/work',
    fromSeq,
    toSeq,
    recordCount: toSeq - fromSeq + 1,
    turns: [1, 2],
    capturedAt: iso(0),
    contentHash: `content-${id}`,
    truncated: false,
  }
}

function makeRecord(spec: FixtureSpec): EventRecord {
  return {
    schemaVersion: 1,
    id: spec.id,
    createdAt: iso(0),
    updatedAt: iso(0),
    structured: {
      title: spec.title,
      startedAt: iso(spec.ago),
      endedAt: iso(spec.ago - spec.span),
      scene: { cwd: '/work', project: spec.project, localTime: '2025-10-30 20:00 (北京时间)' },
      people: spec.people.map((name) => ({ name })),
      goals: ['把这一件事做完'],
      actions: [{ order: 1, why: '因为需要', what: '开始实现', result: '完成了' }],
      statements: [{ kind: 'fact', text: '这是一段事实' }],
      emotions: [],
      outcome: { status: spec.status, summary: '一段收尾', artifacts: [`${spec.id}.md`] },
      tags: [...spec.tags],
      keywords: [...spec.keywords],
      entities: [...spec.entities],
      lessons: [],
      openQuestions: [],
      sources: [makeSource(spec.id, 3, 6)],
    },
    diary: spec.diary,
    diaryHash: `hash-${spec.id}`,
    revision: 1,
  }
}

function makeConfig(overrides: Partial<RetrievalConfig> = {}): MemoryConfig {
  return {
    version: 1,
    dataRoot: '/tmp/autobiomemory-test',
    session: {
      readDirs: ['~/.dsh/sessions'],
      includeGlobs: ['**/session.jsonl.zstd'],
      excludeGlobs: [],
      minRecordsPerEvent: 2,
      maxRecordsPerEvent: 20,
      tailRecords: 4,
    },
    consolidation: {
      maxInputChars: 60_000,
      minEventChars: 200,
      maxEventsPerRun: 5,
      recentEventLimit: 20,
      cooldownMs: 60_000,
      serialize: true,
      maxSpanAttempts: 3,
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 4096,
      timeoutMs: 60_000,
      jsonMode: true,
      retries: 2,
    },
    dashscope: {
      region: 'beijing',
      baseUrl: 'https://dashscope.aliyuncs.com',
      embeddingModel: 'text-embedding-v4',
      embeddingDimensions: 16,
      embeddingBatchSize: 8,
      rerankModel: 'gte-rerank-v2',
      rerankTopN: 3,
      rerankEnabled: true,
      timeoutMs: 60_000,
      retries: 2,
    },
    retrieval: {
      candidateLimit: 20,
      vectorTopK: 3,
      rerankTopN: 3,
      finalLimit: 3,
      shortTermCount: 3,
      includeSources: true,
      minScore: 0,
      maxReplyChars: 4000,
      ...overrides,
    },
    trigger: {
      onCompaction: true,
      onTurnEnd: true,
      onSessionStart: true,
      toolName: 'autobiomemory_recall',
      globalCooldownMs: 60_000,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Deterministic fakes
 * ------------------------------------------------------------------ */

/** ASCII words + CJK character bigrams — enough overlap for cosine to be meaningful. */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = lower.match(/[a-z0-9]+/gu) ?? []
  const cjkChunks = lower.replace(/[^\u4e00-\u9fff]+/gu, ' ').split(/\s+/u)
  for (const chunk of cjkChunks) {
    for (let index = 0; index + 1 < chunk.length; index += 1) {
      tokens.push(chunk.slice(index, index + 2))
    }
  }
  return tokens
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Hash-bucket bag of token bigrams, L2-normalised. */
function embedText(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  for (const token of tokenize(text)) {
    const slot = fnv1a(token) % dimensions
    vector[slot] = (vector[slot] ?? 0) + 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map((value) => value / norm)
}

class HashEmbedder implements Embedder {
  readonly model = 'fake-hash-embed'
  readonly dimensions: number
  calls = 0
  /** Optional hook so a test can abort midway through the async embed. */
  onEmbed?: () => void

  constructor(dimensions = 16) {
    this.dimensions = dimensions
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1
    this.onEmbed?.()
    return texts.map((text) => embedText(text, this.dimensions))
  }
}

class FakeVectorSource implements VectorSource {
  private readonly rows: VectorRow[]

  constructor(dimensions = 16) {
    this.rows = FIXTURES.map((spec) => {
      const vector = embedText(`${spec.title}\n${spec.diary}`, dimensions)
      return {
        eventId: spec.id,
        model: 'fake-hash-embed',
        dimensions,
        textHash: `hash-${spec.id}`,
        vector,
        norm: Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)),
        updatedAt: iso(0),
      }
    })
  }

  all(): VectorRow[] {
    return this.rows
  }
}

class OverlapReranker implements Reranker {
  readonly model = 'fake-overlap-rerank'
  private readonly boost: (document: string) => number

  constructor(boost: (document: string) => number = () => 0) {
    this.boost = boost
  }

  async rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]> {
    const queryTokens = new Set(tokenize(query))
    const hits: RerankHit[] = documents.map((document, index) => {
      const overlap = tokenize(document).filter((token) => queryTokens.has(token)).length
      return { index, score: overlap + this.boost(document) }
    })
    return hits.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(0, topN))
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function makeDeps(overrides: Partial<RecallDeps> = {}): RecallDeps {
  const records = new Map(FIXTURES.map((spec) => [spec.id, makeRecord(spec)]))
  return {
    config: makeConfig(),
    summaries: FIXTURES.map(makeSummary),
    readRecord: (eventId) => records.get(eventId),
    ...overrides,
  }
}

function hitById(hits: RecallHit[], eventId: string): RecallHit | undefined {
  return hits.find((hit) => hit.eventId === eventId)
}

/* ------------------------------------------------------------------ *
 * matchFilters
 * ------------------------------------------------------------------ */

describe('matchFilters', () => {
  const e1 = specOf('e1')
  const e1Summary = makeSummary(e1)
  const e1Record = makeRecord(e1)

  it('accepts everything when there is no filter object', () => {
    expect(matchFilters(e1Summary, undefined)).toBe(true)
    expect(matchFilters(e1Summary, e1Record, {})).toBe(true)
  })

  it('matches tags case-insensitively, any-of within the field', () => {
    expect(matchFilters(e1Summary, e1Record, { tags: ['RETRIEVAL'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { tags: ['nope', '管线'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { tags: ['nope'] })).toBe(false)
  })

  it('matches people and projects', () => {
    expect(matchFilters(e1Summary, e1Record, { people: ['用户'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { people: ['陌生人'] })).toBe(false)
    expect(matchFilters(e1Summary, e1Record, { projects: ['AUTOBIO'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { projects: ['other'] })).toBe(false)
  })

  it('matches keywords and entities', () => {
    expect(matchFilters(e1Summary, e1Record, { keywords: ['RECALL'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { keywords: ['sqlite'] })).toBe(false)
    expect(matchFilters(e1Summary, e1Record, { entities: ['autobiomemory'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { entities: ['dsh'] })).toBe(false)
  })

  it('treats status as a whitelist', () => {
    expect(matchFilters(e1Summary, e1Record, { status: ['completed', 'failed'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { status: ['failed'] })).toBe(false)
  })

  it('requires all fields to match across fields', () => {
    expect(matchFilters(e1Summary, e1Record, { tags: ['retrieval'], people: ['用户'] })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { tags: ['retrieval'], people: ['陌生人'] })).toBe(false)
  })

  it('substring-matches title + diary when the record is present', () => {
    expect(matchFilters(e1Summary, e1Record, { text: '重排阶段' })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { text: 'RECALL' })).toBe(true)
    expect(matchFilters(e1Summary, e1Record, { text: 'zstd' })).toBe(false)
  })

  it('falls back to title + tags when the record is missing', () => {
    expect(matchFilters(e1Summary, undefined, { text: '管线' })).toBe(true) // tag + title
    expect(matchFilters(e1Summary, undefined, { text: '重排阶段' })).toBe(false) // diary only
  })
})

describe('matchFilters time window', () => {
  // e8 runs from 23:00 to 00:00 (the next day), so it overlaps both sides of 23:30.
  const e8 = specOf('e8')
  const summary = makeSummary(e8)
  const record = makeRecord(e8)

  it('matches events that merely overlap the since bound', () => {
    expect(matchFilters(summary, record, { since: iso(750) })).toBe(true) // 23:30 → inside the span
    expect(matchFilters(summary, record, { since: iso(790) })).toBe(true) // 22:50 → before the span
    expect(matchFilters(summary, record, { since: iso(710) })).toBe(false) // 00:10 → after the span
  })

  it('matches events that merely overlap the until bound', () => {
    expect(matchFilters(summary, record, { until: iso(750) })).toBe(true) // 23:30
    expect(matchFilters(summary, record, { until: iso(780) })).toBe(true) // 23:00 → exactly the start
    expect(matchFilters(summary, record, { until: iso(790) })).toBe(false) // 22:50 → before the start
  })

  it('ignores unparseable bounds', () => {
    expect(matchFilters(summary, record, { since: 'not-a-date' })).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * recall — stages
 * ------------------------------------------------------------------ */

describe('recall short-term stage', () => {
  it('always includes the newest summaries with via short-term', async () => {
    const result = await recall(makeDeps(), { query: '向量索引' })
    expect(result.stages.shortTerm).toBe(3)
    const ids = result.hits.map((hit) => hit.eventId)
    for (const id of ['e1', 'e2', 'e3']) expect(ids).toContain(id)
    expect(hitById(result.hits, 'e1')?.via).toContain('short-term')
    expect(hitById(result.hits, 'e3')?.via).toContain('short-term')
  })
})

describe('recall structured stage', () => {
  it('caps candidates at candidateLimit and only reports those', async () => {
    const deps = makeDeps({
      config: makeConfig({ candidateLimit: 2, shortTermCount: 0, finalLimit: 5 }),
    })
    const result = await recall(deps, { query: '检索' })
    expect(result.stages.shortTerm).toBe(0)
    expect(result.stages.structured).toBe(2)
    expect(result.hits.map((hit) => hit.eventId).sort()).toEqual(['e1', 'e2'])
    for (const hit of result.hits) expect(hit.via).toContain('structured')
  })

  it('applies structured filters and keeps matches merged', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, finalLimit: 5, vectorTopK: 5 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
    })
    const result = await recall(deps, { query: '初始化仓库', filters: { tags: ['init'] } })
    expect(result.hits.map((hit) => hit.eventId)).toEqual(['e9'])
    expect(result.stages.vector).toBe(1) // candidate restriction: only e9 may be scored
    expect(hitById(result.hits, 'e9')?.cosine).toBeTypeOf('number')
  })
})

describe('recall vector stage', () => {
  it('orders by cosine similarity and keeps vectorTopK', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, vectorTopK: 3, finalLimit: 5 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
    })
    const result = await recall(deps, { query: '向量索引 sqlite 重建' })
    expect(result.stages.vector).toBe(3)
    const scored = result.hits.filter((hit) => hit.cosine !== undefined)
    expect(scored).toHaveLength(3)
    expect(scored[0]?.eventId).toBe('e2')
    const cosines = scored.map((hit) => hit.cosine ?? Number.NEGATIVE_INFINITY)
    expect(cosines).toEqual([...cosines].sort((a, b) => b - a))
    // cosine-scored hits outrank the unscored structured-only tail
    expect(result.hits.slice(0, 3).every((hit) => hit.cosine !== undefined)).toBe(true)
  })

  it('skips with a note and keeps structured results when embedder is missing', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, finalLimit: 5 }),
      vectors: new FakeVectorSource(),
    })
    const result = await recall(deps, { query: '向量索引' })
    expect(result.notes.some((note) => note.includes('embedder'))).toBe(true)
    expect(result.stages.vector).toBe(0)
    expect(result.hits.length).toBeGreaterThan(0)
    for (const hit of result.hits) {
      expect(hit.cosine).toBeUndefined()
      expect(hit.via).not.toContain('vector')
    }
  })

  it('skips with a note when the vector index is missing', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, finalLimit: 5 }),
      embedder: new HashEmbedder(),
    })
    const result = await recall(deps, { query: '向量索引' })
    expect(result.notes.some((note) => note.includes('vectors'))).toBe(true)
    expect(result.stages.vector).toBe(0)
  })

  it('drops hits whose score falls under minScore', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, finalLimit: 5, minScore: 0.99 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
    })
    const result = await recall(deps, { query: '向量索引 sqlite 重建' })
    expect(result.hits.some((hit) => hit.cosine !== undefined)).toBe(false)
    for (const hit of result.hits) {
      const score = hit.rerankScore ?? hit.cosine
      if (score !== undefined) expect(score).toBeGreaterThanOrEqual(0.99)
    }
  })
})

describe('recall rerank stage', () => {
  it('reorders the union by the reranker score', async () => {
    const reranker = new OverlapReranker((document) => (document.includes('zstd') ? 100 : 0))
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, rerankTopN: 20, finalLimit: 3 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
      reranker,
    })
    const result = await recall(deps, { query: '实现 recall 检索管线' })
    expect(result.stages.rerank).toBeGreaterThan(0)
    expect(result.hits[0]?.eventId).toBe('e5') // boosted by the fake reranker
    expect(result.hits[0]?.rerankScore).toBeGreaterThan(0)
  })

  it('falls back to cosine ordering when the reranker throws', async () => {
    const throwing: Reranker = {
      model: 'broken-rerank',
      rerank: async () => {
        throw new Error('rerank exploded')
      },
    }
    const config = makeConfig({ shortTermCount: 0, finalLimit: 3, vectorTopK: 3 })
    const base = {
      config,
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
    }
    const withRerank = await recall(makeDeps({ ...base, reranker: throwing }), { query: '向量索引 sqlite 重建' })
    const without = await recall(makeDeps(base), { query: '向量索引 sqlite 重建' })

    expect(withRerank.notes.some((note) => note.includes('重排'))).toBe(true)
    expect(withRerank.stages.rerank).toBe(0)
    expect(withRerank.hits.map((hit) => hit.eventId)).toEqual(without.hits.map((hit) => hit.eventId))
    expect(withRerank.hits[0]?.eventId).toBe('e2')
  })
})

describe('recall merging, via and limits', () => {
  it('merges duplicates and unions via in stage order', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 3, candidateLimit: 20, vectorTopK: 5, rerankTopN: 20, finalLimit: 5 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
      reranker: new OverlapReranker(),
    })
    const result = await recall(deps, { query: '向量索引 sqlite 重建' })
    const matches = result.hits.filter((hit) => hit.eventId === 'e1')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.via).toEqual(['short-term', 'structured', 'vector', 'rerank'])
  })

  it('keeps the newest short-term hits inside the final limit', async () => {
    const reranker = new OverlapReranker((document) =>
      document.includes('初始化仓库') ? 100 : document.includes('长时间重构') ? 90 : 0,
    )
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 5, rerankTopN: 20, finalLimit: 2 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
      reranker,
    })
    const result = await recall(deps, { query: '实现 recall 检索管线' })
    expect(result.hits).toHaveLength(2)
    expect(result.hits.map((hit) => hit.eventId)).toEqual(['e1', 'e2'])
  })

  it('still fills the remaining slots with the best scored hits', async () => {
    const reranker = new OverlapReranker((document) =>
      document.includes('初始化仓库') ? 100 : document.includes('长时间重构') ? 90 : 0,
    )
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 5, rerankTopN: 20, finalLimit: 3 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
      reranker,
    })
    const result = await recall(deps, { query: '实现 recall 检索管线' })
    expect(result.hits.map((hit) => hit.eventId)).toEqual(['e1', 'e2', 'e9'])
  })

  it('honours a per-query limit override', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 0, finalLimit: 5 }),
      vectors: new FakeVectorSource(),
      embedder: new HashEmbedder(),
    })
    const result = await recall(deps, { query: '向量索引 sqlite', limit: 1 })
    expect(result.hits).toHaveLength(1)
  })

  it('trims diaries to maxReplyChars and loads sources from the record', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 1, finalLimit: 1, maxReplyChars: 10 }),
    })
    const result = await recall(deps, { query: '向量索引' })
    const hit = result.hits[0]
    expect(hit?.eventId).toBe('e1')
    expect(hit?.diary.length).toBeLessThanOrEqual(10)
    expect(hit?.sources).toHaveLength(1)
    expect(hit?.sources[0]?.sessionFile).toBe('/sessions/e1.jsonl.zstd')
    expect(hit?.tags).toEqual(['retrieval', '管线'])
  })

  it('notes missing records and returns empty sources instead of throwing', async () => {
    const deps = makeDeps({
      config: makeConfig({ shortTermCount: 1, finalLimit: 1, maxReplyChars: 100 }),
      readRecord: () => undefined,
    })
    const result = await recall(deps, { query: '检索' })
    expect(result.notes.some((note) => note.includes('记录缺失'))).toBe(true)
    expect(result.hits[0]?.diary).toBe('')
    expect(result.hits[0]?.sources).toEqual([])
  })
})

/* ------------------------------------------------------------------ *
 * recall — query edge cases and abort
 * ------------------------------------------------------------------ */

describe('recall edge cases', () => {
  it('treats an empty query as recent events (short-term only)', async () => {
    const embedder = new HashEmbedder()
    const deps = makeDeps({ vectors: new FakeVectorSource(), embedder, reranker: new OverlapReranker() })
    const result = await recall(deps, { query: '   ' })
    expect(result.hits).toHaveLength(3)
    for (const hit of result.hits) {
      expect(hit.via).toEqual(['short-term'])
      expect(hit.cosine).toBeUndefined()
    }
    expect(result.stages).toEqual({ shortTerm: 3, structured: 0, vector: 0, rerank: 0 })
    expect(result.notes.some((note) => note.includes('查询为空'))).toBe(true)
    expect(embedder.calls).toBe(0)
    expect(result.query).toBe('   ')
  })

  it('keeps structured filters out of the picture for an empty query and says so', async () => {
    const result = await recall(makeDeps(), { query: '', filters: { tags: ['init'] } })
    expect(result.hits.every((hit) => hit.via.join() === 'short-term')).toBe(true)
    expect(result.notes.some((note) => note.includes('过滤条件未生效'))).toBe(true)
  })

  it('rejects with AbortError for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const deps = makeDeps({ signal: controller.signal })
    await expect(recall(deps, { query: '检索' })).rejects.toBeInstanceOf(AbortError)
  })

  it('rejects with AbortError when the embedder aborts the signal', async () => {
    const controller = new AbortController()
    const embedder = new HashEmbedder()
    embedder.onEmbed = () => controller.abort()
    const deps = makeDeps({
      signal: controller.signal,
      embedder,
      vectors: new FakeVectorSource(),
    })
    await expect(recall(deps, { query: '检索' })).rejects.toBeInstanceOf(AbortError)
  })
})

/* ------------------------------------------------------------------ *
 * renderRecallText
 * ------------------------------------------------------------------ */

describe('renderRecallText', () => {
  const source = makeSource('e1', 3, 6)
  const hits: RecallHit[] = [
    {
      eventId: 'e1',
      title: '实现 recall 检索管线',
      occurredAt: iso(0),
      status: 'completed',
      diary: '第一段日记正文。',
      via: ['short-term'],
      sources: [source],
      tags: ['retrieval'],
      people: ['我'],
    },
    {
      eventId: 'e9',
      title: '启动仓库',
      occurredAt: iso(900),
      status: 'completed',
      diary: '第二段日记正文。',
      via: ['structured'],
      sources: [],
      tags: ['init'],
      people: ['我'],
    },
  ]

  it('renders the Chinese-labelled block with provenance and separators', () => {
    const text = renderRecallText(hits, makeConfig(), [])
    expect(text).toContain(`## 事件 ${iso(0)} · 实现 recall 检索管线 · completed`)
    expect(text).toContain('第一段日记正文。')
    expect(text).toContain('来源：/sessions/e1.jsonl.zstd seq 3-6')
    expect(text).toContain('---')
    expect(text).not.toContain('已截断')
    // the second hit has no sources, so no stray provenance line
    expect(text.match(/来源：/gu)).toHaveLength(1)
  })

  it('omits provenance when includeSources is false', () => {
    const text = renderRecallText(hits, makeConfig({ includeSources: false }), [])
    expect(text).not.toContain('来源：')
    expect(text).toContain('## 事件')
  })

  it('stops at the character budget and notes the truncation', () => {
    const text = renderRecallText(hits, makeConfig({ maxReplyChars: 100, includeSources: false }), [])
    expect(text).toContain('已截断')
    expect(text).toContain('## 事件') // the first block still fits
  })

  it('renders a placeholder and the notes for an empty result', () => {
    const text = renderRecallText([], makeConfig(), ['向量阶段已跳过：缺少 embedder'])
    expect(text).toContain('没有找到匹配的记忆')
    expect(text).toContain('（向量阶段已跳过：缺少 embedder）')
  })
})

/* ------------------------------------------------------------------ *
 * parseFilterArguments
 * ------------------------------------------------------------------ */

describe('parseFilterArguments', () => {
  it('normalises arrays, comma-separated strings and singular aliases', () => {
    const parsed = parseFilterArguments({
      tag: 'retrieval, 管线',
      tags: ['retrieval', 'pgvector'],
      status: 'completed, bogus',
      people: '我, 用户',
      project: 'autobio',
      keyword: 'zstd',
      entity: 'DeepSeek',
      since: iso(240),
      until: 'not-a-date',
      text: '  向量  ',
      limit: 4,
      unknown: 'ignored',
    })
    expect(parsed).toEqual({
      since: iso(240),
      people: ['我', '用户'],
      projects: ['autobio'],
      tags: ['retrieval', 'pgvector', '管线'],
      keywords: ['zstd'],
      entities: ['DeepSeek'],
      status: ['completed'],
      text: '向量',
    })
    expect(parsed.until).toBeUndefined()
    expect(parsed).not.toHaveProperty('limit')
  })

  it('drops invalid statuses and empty input', () => {
    expect(parseFilterArguments({ status: 'nope, planned' })).toEqual({ status: ['planned'] })
    expect(parseFilterArguments({ status: 'nope' })).toEqual({})
    expect(parseFilterArguments({ tags: '   ', people: [] })).toEqual({})
    expect(parseFilterArguments({ since: 12345, until: new Date(iso(10)) })).toEqual({})
  })

  it('feeds straight into matchFilters', () => {
    const filters = parseFilterArguments({ tag: 'RETRIEVAL, vector', status: 'completed' })
    expect(matchFilters(makeSummary(specOf('e1')), makeRecord(specOf('e1')), filters)).toBe(true)
    expect(matchFilters(makeSummary(specOf('e2')), makeRecord(specOf('e2')), filters)).toBe(false) // status partial
  })
})
