import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION } from '../src/constants.js'
import {
  buildRecord,
  eventIdFor,
  eventIndexPath,
  listEventSummaries,
  readDiary,
  readEvent,
  repairPairs,
  shortTermMemory,
  writeEventPair,
} from '../src/store.js'
import type {
  EncodedEvent,
  EventRecord,
  EventScene,
  EventSourceRef,
  EventStatus,
  MemoryPaths,
  StructuredEvent,
} from '../src/types.js'
import * as util from '../src/util.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const roots: string[] = []

function makePaths(): MemoryPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autobiomemory-store-'))
  roots.push(root)
  const eventsDir = path.join(root, 'events')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  return {
    root,
    configFile: path.join(root, 'config.json'),
    envFile: path.join(root, '.env'),
    eventsDir,
    vectorsDir: path.join(root, 'vectors'),
    stateDir,
    logsDir: path.join(root, 'logs'),
    cursorFile: path.join(stateDir, 'cursor.json'),
    runStateFile: path.join(stateDir, 'status.json'),
    eventIndexFile: path.join(stateDir, 'events-index.json'),
    vectorDb: path.join(root, 'vectors', 'index.sqlite'),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function filesFor(paths: MemoryPaths, id: string): { jsonFile: string; mdFile: string } {
  return {
    jsonFile: path.join(paths.eventsDir, `${id}.json`),
    mdFile: path.join(paths.eventsDir, `${id}.md`),
  }
}

const SOURCE: EventSourceRef = {
  sessionId: 'sess-demo',
  sessionFile: '/sessions/demo/session.jsonl.zstd',
  cwd: '/work/demo',
  fromSeq: 1,
  toSeq: 24,
  recordCount: 24,
  turns: [1, 2],
  capturedAt: '2025-10-30T08:40:00.000Z',
  contentHash: 'abcd1234',
  truncated: false,
}

interface EventInput {
  title: string
  startedAt: string
  endedAt?: string
  status?: EventStatus
  diary: string
  project?: string
  people?: string[]
  tags?: string[]
  keywords?: string[]
  entities?: string[]
}

function makeStructured(input: EventInput): StructuredEvent {
  const scene: EventScene = { cwd: '/work/demo' }
  if (input.project !== undefined) scene.project = input.project
  return {
    title: input.title,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? input.startedAt,
    scene,
    people: (input.people ?? []).map((name) => ({ name })),
    goals: ['把事情做完'],
    actions: [{ order: 1, why: '想把存储层做对', what: '实现 writeEventPair' }],
    statements: [{ kind: 'fact', text: '配对写入完成' }],
    emotions: [],
    outcome: { status: input.status ?? 'completed', summary: '完成' },
    tags: input.tags ?? [],
    keywords: input.keywords ?? [],
    entities: input.entities ?? [],
    lessons: [],
    openQuestions: [],
    sources: [SOURCE],
  }
}

function makeEncoded(input: EventInput): EncodedEvent {
  return { structured: makeStructured(input), diary: input.diary }
}

/** Build + write one record; returns the persisted record. */
function persist(
  paths: MemoryPaths,
  input: EventInput,
  options: { now?: string; revision?: number; id?: string } = {},
): EventRecord {
  const contentHash = util.sha256(`${input.title}|${input.diary}`)
  const id = options.id ?? eventIdFor(input.startedAt, contentHash)
  const record = buildRecord(makeEncoded(input), {
    id,
    now: options.now ?? '2025-10-30T08:45:12.000Z',
    revision: options.revision,
  })
  writeEventPair(paths, record)
  return record
}

interface StoredIndex {
  version: number
  updatedAt: string
  events: Record<string, { problem?: string }>
}

function readIndex(paths: MemoryPaths): StoredIndex {
  return JSON.parse(fs.readFileSync(eventIndexPath(paths), 'utf8')) as StoredIndex
}

/* ------------------------------------------------------------------ *
 * write / read round-trip
 * ------------------------------------------------------------------ */

describe('writeEventPair / readEvent', () => {
  it('writes a JSON/MD pair and reads it back', () => {
    const paths = makePaths()
    const diary = '今天我实现了存储层。\n第二段：配对写入先写 JSON 再写 MD。'
    const record = persist(paths, {
      title: '实现配对存储',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary,
      project: 'AutoBioMemory',
      people: ['用户', '小助手'],
      tags: ['存储'],
      keywords: ['json', 'md'],
      entities: ['store.ts'],
    })
    const { jsonFile, mdFile } = filesFor(paths, record.id)

    expect(fs.existsSync(jsonFile)).toBe(true)
    expect(fs.existsSync(mdFile)).toBe(true)
    expect(record.schemaVersion).toBe(SCHEMA_VERSION)
    expect(record.diary).toBe(diary)
    expect(record.diaryHash).toBe(util.sha256(diary))
    expect(record.createdAt).toBe('2025-10-30T08:45:12.000Z')
    expect(record.updatedAt).toBe(record.createdAt)
    expect(record.revision).toBe(1)

    const back = readEvent(paths, record.id)
    expect(back).toEqual(record)
    expect(readDiary(paths, record.id)).toBe(diary)
  })

  it('keeps the MD half to the diary body only', () => {
    const paths = makePaths()
    const diary = '只有正文，没有标题。'
    const record = persist(paths, {
      title: '标题不该出现在 MD 里',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary,
    })
    const { mdFile } = filesFor(paths, record.id)
    const md = fs.readFileSync(mdFile, 'utf8')

    expect(md).toBe(`${diary}\n`)
    expect(md).not.toContain(record.structured.title)
    expect(md).not.toContain('{')
    expect(md).not.toContain('---')
    expect(md.startsWith('#')).toBe(false)
  })

  it('derives index summaries from the record', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '结构化摘要',
      startedAt: '2025-10-30T16:45:12+08:00',
      endedAt: '2025-10-30T17:02:00+08:00',
      status: 'partial',
      diary: '摘要需要的字段都必须来自记录本身。',
      project: 'AutoBioMemory',
      people: ['用户', '小助手'],
      tags: ['存储', '索引'],
      keywords: ['summary'],
      entities: ['events-index.json'],
    })
    const summary = listEventSummaries(paths)[0]

    expect(summary).toBeDefined()
    expect(summary?.id).toBe(record.id)
    expect(summary?.title).toBe('结构化摘要')
    expect(summary?.occurredAt).toBe('2025-10-30T16:45:12+08:00')
    expect(summary?.endedAt).toBe('2025-10-30T17:02:00+08:00')
    expect(summary?.status).toBe('partial')
    expect(summary?.tags).toEqual(['存储', '索引'])
    expect(summary?.people).toEqual(['用户', '小助手'])
    expect(summary?.keywords).toEqual(['summary'])
    expect(summary?.entities).toEqual(['events-index.json'])
    expect(summary?.project).toBe('AutoBioMemory')
    expect(summary?.diaryHash).toBe(record.diaryHash)
    expect(summary?.diaryChars).toBe(record.diary.length)
    expect(summary?.revision).toBe(1)
    expect(summary?.jsonFile).toBe(filesFor(paths, record.id).jsonFile)
    expect(summary?.mdFile).toBe(filesFor(paths, record.id).mdFile)
    expect(summary?.problem).toBeUndefined()

    const index = readIndex(paths)
    expect(Object.keys(index.events)).toEqual([record.id])
  })

  it('refuses a record whose diaryHash does not match the diary', () => {
    const paths = makePaths()
    const id = 'ev_20251030T164512_badbad00'
    const base = buildRecord(
      makeEncoded({ title: '哈希检查', startedAt: '2025-10-30T16:45:12+08:00', diary: '日记正文' }),
      { id, now: '2025-10-30T08:45:12.000Z' },
    )
    const broken: EventRecord = { ...base, diaryHash: util.sha256('别的正文') }

    expect(() => writeEventPair(paths, broken)).toThrow(/diary hash mismatch/u)
    expect(fs.existsSync(filesFor(paths, id).jsonFile)).toBe(false)
    expect(fs.existsSync(filesFor(paths, id).mdFile)).toBe(false)
  })

  it('rolls the JSON back when the MD write fails', () => {
    const paths = makePaths()
    const id = 'ev_20251030T164512_abcdef12'
    const record = buildRecord(
      makeEncoded({ title: '失败回滚', startedAt: '2025-10-30T16:45:12+08:00', diary: '写不出来的日记' }),
      { id, now: '2025-10-30T08:45:12.000Z' },
    )
    const { jsonFile, mdFile } = filesFor(paths, id)
    // A directory where the MD file should go makes the atomic rename fail.
    fs.mkdirSync(mdFile)

    expect(() => writeEventPair(paths, record)).toThrow()
    expect(fs.existsSync(jsonFile)).toBe(false)
  })

  it('returns undefined instead of throwing for missing or unsafe ids', () => {
    const paths = makePaths()
    expect(readEvent(paths, 'ev_20250101T000000_deadbeef')).toBeUndefined()
    expect(readDiary(paths, 'ev_20250101T000000_deadbeef')).toBeUndefined()
    expect(readEvent(paths, '../escape')).toBeUndefined()
    expect(readDiary(paths, '..')).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * Pair consistency detection
 * ------------------------------------------------------------------ */

describe('pair consistency detection', () => {
  it('flags a JSON without an MD as missing-md', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '缺少正文',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary: '正文被删掉了。',
    })
    fs.rmSync(filesFor(paths, record.id).mdFile)

    const summary = listEventSummaries(paths, { refresh: true })[0]
    expect(summary?.problem).toBe('missing-md')
    expect(summary?.title).toBe('缺少正文')
    expect(readIndex(paths).events[record.id]?.problem).toBe('missing-md')
  })

  it('flags an MD without a JSON as missing-json', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '缺少记录',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary: '结构化记录被删掉了。',
    })
    fs.rmSync(filesFor(paths, record.id).jsonFile)

    const summary = listEventSummaries(paths, { refresh: true })[0]
    expect(summary?.problem).toBe('missing-json')
    expect(summary?.diaryChars).toBe(record.diary.length)
    expect(summary?.diaryHash).toBe(util.sha256(record.diary))
  })

  it('flags a tampered MD as hash-mismatch', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '哈希不一致',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary: '原始正文。',
    })
    fs.writeFileSync(filesFor(paths, record.id).mdFile, '被篡改的正文\n')

    const summary = listEventSummaries(paths, { refresh: true })[0]
    expect(summary?.problem).toBe('hash-mismatch')
    expect(summary?.diaryHash).toBe(util.sha256('被篡改的正文'))
    expect(summary?.diaryChars).toBe('被篡改的正文'.length)
  })

  it('flags unparsable JSON as unreadable-json', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '坏 JSON',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary: '正文仍然可读。',
    })
    fs.writeFileSync(filesFor(paths, record.id).jsonFile, '{ this is not json')

    const summary = listEventSummaries(paths, { refresh: true })[0]
    expect(summary?.problem).toBe('unreadable-json')
    expect(summary?.diaryHash).toBe(util.sha256(record.diary))
  })
})

/* ------------------------------------------------------------------ *
 * repairPairs
 * ------------------------------------------------------------------ */

describe('repairPairs', () => {
  it('regenerates missing MDs, fixes stale hashes, and quarantines orphans', () => {
    const paths = makePaths()
    const missingMd = persist(paths, {
      title: '缺正文',
      startedAt: '2025-10-30T09:00:00+08:00',
      diary: '需要重新生成正文。',
    })
    const tampered = persist(paths, {
      title: '正文被改',
      startedAt: '2025-10-30T10:00:00+08:00',
      diary: '以 JSON 为准的正文。',
    })
    const staleHash = persist(paths, {
      title: '哈希过期',
      startedAt: '2025-10-30T11:00:00+08:00',
      diary: '哈希需要重算。',
    })
    const orphanId = 'ev_20250101T000000_orphan01'
    const brokenId = 'ev_20250102T000000_brokennn'

    fs.rmSync(filesFor(paths, missingMd.id).mdFile)
    fs.writeFileSync(filesFor(paths, tampered.id).mdFile, '被人改过的正文\n')
    const staleRaw = JSON.parse(
      fs.readFileSync(filesFor(paths, staleHash.id).jsonFile, 'utf8'),
    ) as Record<string, unknown>
    staleRaw.diaryHash = util.sha256('旧正文')
    fs.writeFileSync(
      filesFor(paths, staleHash.id).jsonFile,
      `${JSON.stringify(staleRaw, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(paths.eventsDir, `${orphanId}.md`), '孤儿正文\n')
    fs.writeFileSync(path.join(paths.eventsDir, `${brokenId}.json`), '{ 坏掉的 json')
    fs.writeFileSync(path.join(paths.eventsDir, `${brokenId}.md`), '无法配对\n')

    const result = repairPairs(paths)

    expect(result.repaired).toEqual([missingMd.id, tampered.id, staleHash.id].sort())
    expect(result.quarantined).toEqual([orphanId, brokenId].sort())
    expect(result.skipped).toEqual([])

    expect(readDiary(paths, missingMd.id)).toBe(missingMd.diary)
    expect(readDiary(paths, tampered.id)).toBe(tampered.diary)
    const repairedJson = JSON.parse(
      fs.readFileSync(filesFor(paths, staleHash.id).jsonFile, 'utf8'),
    ) as { diaryHash: string; diary: string }
    expect(repairedJson.diaryHash).toBe(util.sha256(repairedJson.diary))
    expect(repairedJson.diary).toBe(staleHash.diary)

    expect(fs.existsSync(path.join(paths.eventsDir, `${orphanId}.md`))).toBe(false)
    expect(fs.existsSync(path.join(paths.eventsDir, `${brokenId}.json`))).toBe(false)
    expect(fs.existsSync(path.join(paths.eventsDir, `${brokenId}.md`))).toBe(false)

    const quarantinedFiles = fs.readdirSync(path.join(paths.eventsDir, '_quarantine'))
    expect(quarantinedFiles).toHaveLength(3)
    for (const name of quarantinedFiles) {
      expect(name).toContain('.quarantined-')
    }

    const summaries = listEventSummaries(paths, { refresh: true })
    // Newest `occurredAt` first.
    expect(summaries.map((summary) => summary.id)).toEqual([
      staleHash.id,
      tampered.id,
      missingMd.id,
    ])
    expect(summaries.every((summary) => summary.problem === undefined)).toBe(true)
  })

  it('is idempotent', () => {
    const paths = makePaths()
    const record = persist(paths, {
      title: '幂等',
      startedAt: '2025-10-30T09:00:00+08:00',
      diary: '第一次修复之后就不需要再动了。',
    })
    fs.rmSync(filesFor(paths, record.id).mdFile)
    fs.writeFileSync(path.join(paths.eventsDir, 'ev_20250101T000000_orphan02.md'), '孤儿\n')

    const first = repairPairs(paths)
    expect(first.repaired).toEqual([record.id])
    expect(first.quarantined).toEqual(['ev_20250101T000000_orphan02'])

    const second = repairPairs(paths)
    expect(second.repaired).toEqual([])
    expect(second.quarantined).toEqual([])
    expect(second.skipped).toEqual([record.id])
    expect(readDiary(paths, record.id)).toBe(record.diary)
  })
})

/* ------------------------------------------------------------------ *
 * Index reconciliation
 * ------------------------------------------------------------------ */

describe('listEventSummaries index reconciliation', () => {
  it('sorts newest first and drops events deleted out of band', () => {
    const paths = makePaths()
    const older = persist(paths, {
      title: '较早事件',
      startedAt: '2025-10-29T09:00:00+08:00',
      diary: '较早的正文。',
    })
    const newer = persist(paths, {
      title: '较新事件',
      startedAt: '2025-10-30T09:00:00+08:00',
      diary: '较新的正文。',
    })

    expect(listEventSummaries(paths).map((summary) => summary.id)).toEqual([newer.id, older.id])

    fs.rmSync(filesFor(paths, newer.id).jsonFile)
    fs.rmSync(filesFor(paths, newer.id).mdFile)

    const reconciled = listEventSummaries(paths, { refresh: true })
    expect(reconciled.map((summary) => summary.id)).toEqual([older.id])
    expect(Object.keys(readIndex(paths).events)).toEqual([older.id])
  })

  it('picks up events added out of band', () => {
    const paths = makePaths()
    const known = persist(paths, {
      title: '已有事件',
      startedAt: '2025-10-29T09:00:00+08:00',
      diary: '已有的正文。',
    })
    expect(listEventSummaries(paths)).toHaveLength(1)

    const addedId = 'ev_20251031T090000_cafebabe'
    const added = buildRecord(
      makeEncoded({ title: '外部新增', startedAt: '2025-10-31T09:00:00+08:00', diary: '外部写入的正文。' }),
      { id: addedId, now: '2025-10-31T01:00:00.000Z' },
    )
    fs.writeFileSync(
      filesFor(paths, addedId).jsonFile,
      `${JSON.stringify(added, null, 2)}\n`,
    )
    fs.writeFileSync(filesFor(paths, addedId).mdFile, `${added.diary}\n`)

    const refreshed = listEventSummaries(paths, { refresh: true })
    expect(refreshed.map((summary) => summary.id)).toEqual([addedId, known.id])
    expect(Object.keys(readIndex(paths).events).sort()).toEqual([addedId, known.id].sort())
  })
})

/* ------------------------------------------------------------------ *
 * eventIdFor
 * ------------------------------------------------------------------ */

describe('eventIdFor', () => {
  it('is stable, filesystem-safe, and uses Beijing time', () => {
    const id = eventIdFor('2025-10-30T16:45:12+08:00', 'ab12cd34ef56')
    expect(id).toBe('ev_20251030T164512_ab12cd34')
    expect(id).toMatch(/^ev_\d{8}T\d{6}_[0-9a-f]{8}$/u)
    expect(id).not.toMatch(/[\\/]/u)
    // The same instant expressed in UTC yields the same id.
    expect(eventIdFor('2025-10-30T08:45:12.000Z', 'ab12cd34ef56')).toBe(id)
    // Hex input is lower-cased; other inputs are hashed into 8 hex chars.
    expect(eventIdFor('2025-10-30T16:45:12+08:00', 'AB12CD34EF56')).toBe(id)
    expect(eventIdFor('2025-10-30T16:45:12+08:00', 'ffeeddcc')).not.toBe(id)
    const odd = eventIdFor('not-a-date', '这不是十六进制')
    expect(odd).toMatch(/^ev_\d{8}T\d{6}_[0-9a-f]{8}$/u)
    expect(eventIdFor('not-a-date', '这不是十六进制')).toBe(odd)
  })
})

/* ------------------------------------------------------------------ *
 * shortTermMemory
 * ------------------------------------------------------------------ */

describe('shortTermMemory', () => {
  it('renders the newest events first', () => {
    const paths = makePaths()
    const oldest = persist(paths, {
      title: '最早的一件',
      startedAt: '2025-10-30T08:00:00+08:00',
      diary: '最早的日记正文。',
    })
    const middle = persist(paths, {
      title: '中间的一件',
      startedAt: '2025-10-30T09:00:00+08:00',
      diary: '中间的日记正文。',
    })
    const newest = persist(paths, {
      title: '最新的一件',
      startedAt: '2025-10-30T10:00:00+08:00',
      diary: '最新的日记正文。',
    })

    const { summaries, text } = shortTermMemory(paths, 2)

    expect(summaries.map((summary) => summary.id)).toEqual([newest.id, middle.id])
    expect(text.startsWith('## 短时记忆')).toBe(true)
    expect(text).toContain('### 2025-10-30T10:00:00+08:00 · 最新的一件 · completed')
    expect(text).toContain('最新的日记正文。')
    expect(text).toContain('\n---\n')
    expect(text).not.toContain(oldest.structured.title)
    expect(text).not.toContain(oldest.diary)
    expect(text.indexOf(newest.diary)).toBeLessThan(text.indexOf(middle.diary))
  })

  it('caps the block and notes the truncation', () => {
    const paths = makePaths()
    const huge = '记'.repeat(30_000)
    persist(paths, {
      title: '超长事件',
      startedAt: '2025-10-30T10:00:00+08:00',
      diary: huge,
    })

    const { summaries, text } = shortTermMemory(paths, 5)

    expect(summaries).toHaveLength(1)
    expect(text).toContain('短时记忆已截断')
    expect(text).toContain('### ')
    expect(text.length).toBeLessThanOrEqual(20_300)
  })

  it('skips broken pairs and notes them', () => {
    const paths = makePaths()
    const good = persist(paths, {
      title: '完好的一件',
      startedAt: '2025-10-30T10:00:00+08:00',
      diary: '完好的日记正文。',
    })
    const broken = persist(paths, {
      title: '坏掉的一件',
      startedAt: '2025-10-30T11:00:00+08:00',
      diary: '正文被删掉了。',
    })
    fs.rmSync(filesFor(paths, broken.id).mdFile)

    const { summaries, text } = shortTermMemory(paths, 5)

    expect(summaries.map((summary) => summary.id)).toEqual([good.id])
    expect(text).toContain('已跳过 1 条配对异常事件')
    expect(text).toContain(broken.id)
    expect(text).not.toContain('坏掉的一件')
  })

  it('renders an empty-state block on a fresh root', () => {
    const paths = makePaths()
    const { summaries, text } = shortTermMemory(paths, 5)
    expect(summaries).toEqual([])
    expect(text.startsWith('## 短时记忆')).toBe(true)
    expect(text).toContain('暂无事件记忆')
  })
})

/* ------------------------------------------------------------------ *
 * Revision handling
 * ------------------------------------------------------------------ */

describe('revision handling', () => {
  it('keeps the id, replaces both files, and bumps revision', () => {
    const paths = makePaths()
    const first = persist(paths, {
      title: '可修订的事件',
      startedAt: '2025-10-30T16:45:12+08:00',
      diary: '第一版正文。',
    })
    const second = buildRecord(
      makeEncoded({ title: '可修订的事件', startedAt: '2025-10-30T16:45:12+08:00', diary: '第二版正文。' }),
      { id: first.id, now: '2025-10-30T10:00:00.000Z', revision: 2 },
    )
    const result = writeEventPair(paths, second)

    expect(result.created).toBe(false)
    expect(result.jsonFile).toBe(filesFor(paths, first.id).jsonFile)
    expect(result.mdFile).toBe(filesFor(paths, first.id).mdFile)

    const back = readEvent(paths, first.id)
    expect(back?.revision).toBe(2)
    expect(back?.diary).toBe('第二版正文。')
    expect(back?.diaryHash).toBe(second.diaryHash)
    expect(back?.createdAt).toBe('2025-10-30T10:00:00.000Z')
    expect(back?.updatedAt).toBe('2025-10-30T10:00:00.000Z')
    expect(readDiary(paths, first.id)).toBe('第二版正文。')

    const summary = listEventSummaries(paths)[0]
    expect(summary?.id).toBe(first.id)
    expect(summary?.revision).toBe(2)
    expect(summary?.diaryHash).toBe(second.diaryHash)
    expect(summary?.problem).toBeUndefined()
  })
})
