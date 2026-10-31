/**
 * Regression tests for brace neutralisation in the storage layer.
 *
 * Diary bodies and structured fields are model-authored prose. When such text contains a literal
 * `{{…}}` it causes two different failures downstream:
 *
 * - a consumer that renders it through a template engine aborts
 *   (`unknown prompt variable "…"`, which failed dsh's whole prompt assembly in 0.1.3), or
 * - worse and silently: a *registered* name such as `{{model}}` / `{{cwd}}` is substituted, so the
 *   agent's own memory is rewritten on the way into the prompt.
 *
 * 0.1.3 stopped the bleeding at the prompt boundary. This suite pins the root fix: nothing that
 * reaches `events/*.md` or the prose fields of `events/*.json` may contain a recognisable brace
 * pair, so *any* current or future consumer is safe, and `diaryHash` / the `.md` body / the vector
 * `text_hash` all describe the same neutralised bytes.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultConfig, mergeConfig } from '../src/config.js'
import { consolidate } from '../src/consolidate.js'
import { ensureDataLayout, memoryPaths, type MemoryPaths } from '../src/paths.js'
import {
  buildRecord,
  neutralizeEventRecord,
  readDiary,
  readEvent,
  writeEventPair,
} from '../src/store.js'
import { VectorStore } from '../src/vectors.js'
import { silentLogger } from '../src/logger.js'
import { neutralizeTemplateBraces, sha256, ZERO_WIDTH_SPACE } from '../src/util.js'
import type {
  Distiller,
  Embedder,
  EncodedEvent,
  EventRecord,
  EventSourceRef,
  EventUnit,
  MemoryConfig,
  SecretSource,
  StructuredEvent,
} from '../src/types.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const roots: string[] = []

function makePaths(): MemoryPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abm-braces-'))
  roots.push(root)
  const paths = memoryPaths(root)
  ensureDataLayout(paths)
  return paths
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Every shape that used to slip through: pairs, runs of three and four, and mixes. */
const PAIRS = '{{a}}'
const TRIPLE_OPEN = '{{{'
const QUAD_CLOSE = '}}}}'
const REGISTERED = '{{model}} 和 {{cwd}} 都是已注册变量'
const MIXED = `先 ${TRIPLE_OPEN} 再 ${PAIRS} 最后 ${QUAD_CLOSE}`

/** Provenance, as dsh really writes it: no braces, and never rewritten. */
const SOURCE: EventSourceRef = {
  sessionId: 'sess-abc123',
  sessionFile: '/sessions/proj-1/session.v4.jsonl.zstd',
  cwd: '/work/proj-1',
  fromSeq: 3,
  toSeq: 42,
  recordCount: 40,
  turns: [1, 2],
  capturedAt: '2025-10-30T08:40:00.000Z',
  contentHash: 'a'.repeat(64),
  truncated: false,
}

/** A structured event whose every model-authored text field contains braces. */
function bracedStructured(): StructuredEvent {
  return {
    title: `排障：${PAIRS}`,
    startedAt: '2025-10-31T12:00:00+08:00',
    endedAt: '2025-10-31T12:10:00+08:00',
    scene: {
      cwd: '/work/{{project}}',
      project: `proj-${PAIRS}`,
      place: `机器 ${TRIPLE_OPEN}`,
      channel: 'web',
      localTime: `2025-10-31 12:00 ${QUAD_CLOSE}`,
    },
    people: [
      { name: '我', role: 'agent' },
      { name: `用户${PAIRS}`, role: `human-${TRIPLE_OPEN}` },
    ],
    goals: [`解释 ${PAIRS}`, MIXED],
    actions: [
      {
        order: 1,
        why: `因为 ${PAIRS}`,
        what: `我读了 ${TRIPLE_OPEN} 的插值器`,
        adjustment: `绕开 ${QUAD_CLOSE}`,
        result: `发现 ${PAIRS} 会被替换`,
      },
    ],
    statements: [
      { kind: 'fact', text: `插值器遇到 ${PAIRS} 会抛错` },
      { kind: 'inference', text: `所以 ${TRIPLE_OPEN} 也一样`, confidence: 0.7 },
    ],
    emotions: [{ who: '我', emotion: `警觉 ${PAIRS}`, evidence: `看到 ${TRIPLE_OPEN}`, basis: 'fact' }],
    outcome: {
      status: 'completed',
      summary: `定位到 ${MIXED}`,
      artifacts: [`dist/${PAIRS}.tgz`],
    },
    tags: [`排障 ${PAIRS}`],
    keywords: [PAIRS, MIXED],
    entities: [`plugin.ts ${TRIPLE_OPEN}`],
    lessons: [`不要在提示词里写 ${PAIRS}`],
    openQuestions: [`${QUAD_CLOSE} 从哪来`],
    sources: [SOURCE],
  }
}

function bracedEncoded(): EncodedEvent {
  return {
    structured: bracedStructured(),
    diary: [
      `今天我在解释提示词变量时写下了 ${REGISTERED}。`,
      `还写了 ${TRIPLE_OPEN} 和 ${QUAD_CLOSE}，以及混排 ${MIXED}，外加跨段的 ${PAIRS}。`,
      '不含大括号的这句必须逐字保留。',
    ].join('\n'),
  }
}

/** No recognisable template reference survives anywhere in the text. */
function expectNoBracePairs(text: string, label: string): void {
  expect(text.includes('{{'), `${label} still contains "{{"`).toBe(false)
  expect(text.includes('}}'), `${label} still contains "}}"`).toBe(false)
}

/** Every string value of an object graph, keyed by path, for per-field assertions. */
function strings(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (Array.isArray(value)) return value.flatMap((entry, index) => strings(entry, `${prefix}[${index}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      strings(entry, prefix === '' ? key : `${prefix}.${key}`),
    )
  }
  return []
}

/* ------------------------------------------------------------------ *
 * buildRecord — the root fix
 * ------------------------------------------------------------------ */

describe('buildRecord neutralises braces before the hash exists', () => {
  it('stores a pair whose prose is brace-free and whose hash matches the stored diary', () => {
    const paths = makePaths()
    const record = buildRecord(bracedEncoded(), {
      id: 'ev_20251031T120000_abcdef12',
      now: '2025-10-31T04:00:00.000Z',
    })
    writeEventPair(paths, record)

    const id = record.id
    const md = fs.readFileSync(path.join(paths.eventsDir, `${id}.md`), 'utf8')
    const json = fs.readFileSync(path.join(paths.eventsDir, `${id}.json`), 'utf8')
    const stored = readEvent(paths, id)!

    // (a) no recognisable pair in either half of the pair — whole file, not a whitelist
    expectNoBracePairs(md, '.md')
    expectNoBracePairs(json, '.json')
    for (const [where, text] of strings(stored)) {
      if (where === 'diaryHash' || where.startsWith('embedding.')) continue // hashes, no braces by nature
      expectNoBracePairs(text, where)
    }

    // (b) hash and MD describe exactly the neutralised diary
    expect(stored.diaryHash).toBe(sha256(stored.diary))
    expect(md).toBe(`${stored.diary}\n`)
    expect(readDiary(paths, id)).toBe(stored.diary)
    // the diary was rewritten, not silently dropped: removing the inserted separators restores it
    expect(stored.diary).toContain('不含大括号的这句必须逐字保留。')
    expect(stored.diary.replaceAll(ZERO_WIDTH_SPACE, '')).toBe(bracedEncoded().diary)

    // (c) protected fields survive byte-for-byte
    expect(stored.id).toBe(id)
    expect(stored.createdAt).toBe('2025-10-31T04:00:00.000Z')
    expect(stored.updatedAt).toBe('2025-10-31T04:00:00.000Z')
    expect(stored.structured.startedAt).toBe(bracedStructured().startedAt)
    expect(stored.structured.endedAt).toBe(bracedStructured().endedAt)
    expect(stored.structured.sources).toEqual([SOURCE])
    expect(stored.structured.actions[0]?.order).toBe(1)
    expect(stored.structured.outcome.status).toBe('completed')
    expect(stored.structured.statements.map((statement) => statement.kind)).toEqual([
      'fact',
      'inference',
    ])
    expect(stored.structured.statements[1]?.confidence).toBe(0.7)
    expect(stored.structured.emotions[0]?.basis).toBe('fact')
    expect(stored.revision).toBe(1)
    expect(stored.schemaVersion).toBe(1)
  })

  it('leaves provenance and identifiers untouched even when they contain braces', () => {
    // Provenance is evidence, not prose: rewriting a hash or a path would break dedupe, so the
    // neutraliser must skip `sources` entirely.
    const encoded = bracedEncoded()
    const bracedSource: EventSourceRef = {
      ...SOURCE,
      sessionId: 'sess-{{id}}',
      sessionFile: '/sessions/{{proj}}/session.jsonl.zstd',
      cwd: '/work/{{x}}',
    }
    const record = buildRecord(
      { ...encoded, structured: { ...encoded.structured, sources: [bracedSource] } },
      { id: 'ev_20251031T120000_abcdef12' },
    )
    expect(record.structured.sources).toEqual([bracedSource])
    expect(record.id).toBe('ev_20251031T120000_abcdef12')
  })

  it('is idempotent: neutralising twice changes nothing', () => {
    const record = buildRecord(bracedEncoded(), { id: 'ev_20251031T120000_abcdef12' })
    const once = neutralizeEventRecord(record)
    const twice = neutralizeEventRecord(once)

    expect(twice).toEqual(once)
    expect(twice.diary).toBe(once.diary)
    expect(twice.diaryHash).toBe(once.diaryHash)
    expect(twice.diary.includes(`${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}`)).toBe(false)
    expect(neutralizeTemplateBraces(once.diary)).toBe(once.diary)
    for (const [where, text] of strings(twice)) {
      expect(neutralizeTemplateBraces(text), where).toBe(text)
    }
  })

  it('resolves a brace run to a fixed point, not just one pass', () => {
    // one naive pass over `{{{` yields `{␣{{`, which still contains a bare `{{`
    expect(neutralizeTemplateBraces('{{{')).toBe(`{${ZERO_WIDTH_SPACE}{${ZERO_WIDTH_SPACE}{`)
    expectNoBracePairs(neutralizeTemplateBraces(TRIPLE_OPEN), 'triple open')
    expectNoBracePairs(neutralizeTemplateBraces(QUAD_CLOSE), 'quad close')
    expectNoBracePairs(neutralizeTemplateBraces(MIXED), 'mixed')
    expectNoBracePairs(neutralizeTemplateBraces('{'.repeat(10) + '}'.repeat(10)), 'long runs')
    // braces that are not adjacent are left exactly as they were
    expect(neutralizeTemplateBraces('{ a } {b}')).toBe('{ a } {b}')
    expect(neutralizeTemplateBraces('没有大括号')).toBe('没有大括号')
  })
})

/* ------------------------------------------------------------------ *
 * writeEventPair — safety net for writers that skip buildRecord
 * ------------------------------------------------------------------ */

describe('writeEventPair neutralises whatever it is handed', () => {
  it('re-derives the hash from the text it actually writes', () => {
    const paths = makePaths()
    const encoded = bracedEncoded()
    const id = 'ev_20251031T120000_deadbeef'
    // assembled by hand, with the hash computed over the RAW diary: no buildRecord involved
    const raw: EventRecord = {
      schemaVersion: 1,
      id,
      createdAt: '2025-10-31T04:00:00.000Z',
      updatedAt: '2025-10-31T04:00:00.000Z',
      structured: encoded.structured,
      diary: encoded.diary,
      diaryHash: sha256(encoded.diary),
      revision: 1,
    }
    writeEventPair(paths, raw)

    const stored = readEvent(paths, id)!
    expectNoBracePairs(stored.diary, 'diary')
    expectNoBracePairs(fs.readFileSync(path.join(paths.eventsDir, `${id}.md`), 'utf8'), '.md')
    expectNoBracePairs(fs.readFileSync(path.join(paths.eventsDir, `${id}.json`), 'utf8'), '.json')
    expect(stored.diaryHash).toBe(sha256(stored.diary))
    expect(stored.diaryHash).not.toBe(raw.diaryHash) // the raw hash no longer describes the bytes
    expect(readDiary(paths, id)).toBe(stored.diary)
    // the caller's object is not mutated behind its back
    expect(raw.diary).toBe(encoded.diary)
  })

  it('still refuses a record whose hash matches neither the raw nor the stored diary', () => {
    const paths = makePaths()
    const record = buildRecord(bracedEncoded(), { id: 'ev_20251031T120000_abcdef12' })
    const broken: EventRecord = { ...record, diaryHash: sha256('别的正文') }
    expect(() => writeEventPair(paths, broken)).toThrow(/diary hash mismatch/u)
  })
})

/* ------------------------------------------------------------------ *
 * End to end: consolidation stores and indexes the same neutralised bytes
 * ------------------------------------------------------------------ */

describe('consolidation keeps storage brace-free end to end', () => {
  it('stores neutralised text and indexes exactly the bytes it wrote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abm-braces-e2e-'))
    roots.push(root)
    const paths = memoryPaths(root)
    ensureDataLayout(paths)
    const sessionsDir = path.join(root, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const config: MemoryConfig = mergeConfig(defaultConfig(root), {
      session: {
        readDirs: [sessionsDir],
        minRecordsPerEvent: 2,
        tailRecords: 0,
        maxRecordsPerEvent: 100,
      },
      consolidation: { maxEventsPerRun: 10, cooldownMs: 0, minEventChars: 1 },
      trigger: { globalCooldownMs: 0 },
      dashscope: { embeddingDimensions: 8 },
      retrieval: { shortTermCount: 4 },
    })

    const line = (value: unknown): string => `${JSON.stringify(value)}\n`
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      Buffer.concat(
        [
          line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }),
          line({
            type: 'user/message',
            seq: 10,
            time: 1_700_000_000_100,
            id: 'm-1',
            data: { content: [{ type: 'text', text: '解释一下 {{model}} 是怎么插值的' }] },
          }),
          line({
            type: 'assistant/message',
            seq: 11,
            time: 1_700_000_000_200,
            data: {
              turn: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: '我看了 {{{ 插值器 }}}' }] },
            },
          }),
        ].map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))),
      ),
    )

    // the encoder answers with prose full of braces, exactly like a real transcript would
    const encoded = bracedEncoded()
    const distiller: Distiller = {
      async encode(_unit: EventUnit): Promise<EncodedEvent> {
        return encoded
      },
    }
    const embedder: Embedder = {
      model: 'fake-embed',
      dimensions: 8,
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => {
          const hash = sha256(text)
          return Array.from(
            { length: 8 },
            (_, index) => Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16) / 255,
          )
        })
      },
    }
    const secrets: SecretSource = {
      deepseekApiKey: 'sk-test',
      dashscopeApiKey: 'dash-test',
      origin: { deepseek: '.env', dashscope: '.env' },
    }

    const result = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller,
      embedder,
    })
    expect(result.eventsWritten).toBe(1)

    const stored = fs.readdirSync(paths.eventsDir).filter((name) => name.endsWith('.json'))
    expect(stored).toHaveLength(1)
    const id = stored[0]!.replace(/\.json$/u, '')
    const record = readEvent(paths, id)!

    expectNoBracePairs(fs.readFileSync(path.join(paths.eventsDir, `${id}.md`), 'utf8'), '.md')
    expectNoBracePairs(fs.readFileSync(path.join(paths.eventsDir, `${id}.json`), 'utf8'), '.json')

    // hash, .md body and vector row all describe the neutralised diary
    const diary = readDiary(paths, id)!
    expect(record.diaryHash).toBe(sha256(diary))
    expect(record.embedding?.textHash).toBe(record.diaryHash)
    const store = new VectorStore(paths.vectorDb)
    try {
      expect(store.get(id)?.textHash).toBe(record.diaryHash)
    } finally {
      store.close()
    }

    // the encoder's in-memory answer keeps its braces; only the stored copy is neutralised
    expect(encoded.diary).toContain(PAIRS)
  })
})
