import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { beforeEach, describe, expect, it } from 'vitest'

import { defaultConfig, mergeConfig } from '../src/config.js'
import { consolidate } from '../src/consolidate.js'
import { ensureDataLayout, memoryPaths, type MemoryPaths } from '../src/paths.js'
import { listEventSummaries, readDiary, readEvent, repairPairs } from '../src/store.js'
import { loadCursor, loadRunState } from '../src/state.js'
import { VectorStore } from '../src/vectors.js'
import { sha256 } from '../src/util.js'
import { silentLogger } from '../src/logger.js'
import type { Distiller, Embedder, EncodedEvent, EventUnit, MemoryConfig, SecretSource } from '../src/types.js'

const secrets: SecretSource = {
  deepseekApiKey: 'sk-test',
  dashscopeApiKey: 'dash-test',
  origin: { deepseek: '.env', dashscope: '.env' },
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

function turn(sessionIndex: number, turnNo: number, userText: string): string[] {
  const base = 1_700_000_000_000 + sessionIndex * 100_000 + turnNo * 10_000
  return [
    line({ type: 'turn/start', seq: turnNo, time: base, data: { turn: turnNo } }),
    line({
      type: 'user/message',
      seq: turnNo * 10,
      time: base + 100,
      id: `m-${sessionIndex}-${turnNo}`,
      data: { content: [{ type: 'text', text: userText }] },
    }),
    line({
      type: 'assistant/message',
      seq: turnNo * 10 + 1,
      time: base + 200,
      data: { turn: turnNo, message: { role: 'assistant', content: [{ type: 'text', text: '我先看看情况' }] } },
    }),
    line({
      type: 'tool/call',
      seq: turnNo * 10 + 2,
      time: base + 300,
      data: { turn: turnNo, name: 'bash', arguments: '{"command":"ls"}' },
    }),
    line({
      type: 'tool/result',
      seq: turnNo * 10 + 3,
      time: base + 400,
      data: {
        turn: turnNo,
        message: {
          source: { kind: 'tool', tool: 'bash' },
          content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a b c' }] }],
        },
      },
    }),
  ]
}

/** Write a session file the way dsh appends: one independent zstd frame per write. */
function writeSession(file: string, chunks: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')))))
}

function appendSession(file: string, chunks: string[]): void {
  fs.appendFileSync(file, Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')))))
}

let root = ''
let paths: MemoryPaths
let sessionsDir = ''
let config: MemoryConfig

function freshEnv(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abm-consolidate-'))
  paths = memoryPaths(root)
  ensureDataLayout(paths)
  sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  config = mergeConfig(defaultConfig(root), {
    session: { readDirs: [sessionsDir], minRecordsPerEvent: 2, tailRecords: 0, maxRecordsPerEvent: 100 },
    consolidation: { maxEventsPerRun: 10, cooldownMs: 0, minEventChars: 1 },
    dashscope: { embeddingDimensions: 8 },
    retrieval: { shortTermCount: 4 },
  })
}

/** A deterministic distiller: one event per unit, titled after the user's request. */
function fakeDistiller(onEncode?: (unit: EventUnit) => void): Distiller {
  let counter = 0
  return {
    async encode(unit: EventUnit): Promise<EncodedEvent> {
      onEncode?.(unit)
      counter += 1
      const userRecord = unit.records.find((record) => record.kind === 'user')
      const request = userRecord?.text ?? '（无请求）'
      return {
        structured: {
          title: `我处理了：${request}`,
          startedAt: unit.startedAt,
          endedAt: unit.endedAt,
          scene: { cwd: '/work', channel: 'web' },
          people: [{ name: '我', role: 'agent' }, { name: '用户', role: 'human' }],
          goals: [request],
          actions: [{ order: 1, why: '用户要求', what: '我执行了命令', result: '看到 a b c' }],
          statements: [
            { kind: 'fact', text: '工具返回 a b c' },
            { kind: 'completion', text: '我完成了这一步' },
          ],
          emotions: [],
          outcome: { status: 'completed', summary: '完成', artifacts: [] },
          tags: ['测试'],
          keywords: ['bash'],
          entities: ['bash'],
          lessons: [],
          openQuestions: [],
          sources: [],
        },
        diary: `第 ${counter} 个事件的日记。用户说：${request}。我把这条命令跑了，看到 a b c，于是收尾。`,
      }
    },
  }
}

const fakeEmbedder: Embedder = {
  model: 'fake-embed',
  dimensions: 8,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const hash = sha256(text)
      return Array.from({ length: 8 }, (_, index) => Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16) / 255)
    })
  },
}

describe('consolidate', () => {
  beforeEach(() => {
    freshEnv()
  })

  it('writes paired JSON/MD, indexes the vectors and advances the cursor', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '先看一下目录')])

    const result = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })

    expect(result.eventsWritten).toBe(1)
    expect(result.embedded).toBe(1)
    expect(result.eventsFailed).toBe(0)

    const summaries = listEventSummaries(paths, { refresh: true })
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    expect(summary.title).toContain('先看一下目录')
    expect(fs.existsSync(summary.jsonFile)).toBe(true)
    expect(fs.existsSync(summary.mdFile)).toBe(true)

    const record = readEvent(paths, summary.id)!
    // the .md carries exactly the diary
    expect(readDiary(paths, summary.id)).toBe(record.diary)
    expect(record.diaryHash).toBe(sha256(record.diary))
    expect(record.embedding?.model).toBe('fake-embed')
    // provenance points at the raw transcript, in place
    expect(record.structured.sources[0]?.sessionFile).toBe(file)
    expect(record.structured.sources[0]?.contentHash).toHaveLength(64)

    // vector row exists and matches the diary hash
    const store = new VectorStore(paths.vectorDb)
    try {
      expect(store.count()).toBe(1)
      expect(store.get(summary.id)?.textHash).toBe(record.diaryHash)
      expect(store.get(summary.id)?.vector).toHaveLength(8)
    } finally {
      store.close()
    }

    // the cursor caught up with the transcript, and the raw file is untouched
    const cursor = loadCursor(paths).sessions[file]
    expect(cursor?.processedRecords).toBeGreaterThan(0)
    const stat = fs.statSync(file)
    expect(cursor?.fileSize).toBe(stat.size)

    // a second run has nothing to do
    const second = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })
    expect(second.eventsWritten).toBe(0)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(1)
  })

  it('reads incrementally and never re-encodes an earlier span', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '第一步')])
    const deps = { paths, config, secrets, logger: silentLogger(), embedder: fakeEmbedder, force: true }

    const first = await consolidate({ ...deps, distiller: fakeDistiller() })
    expect(first.eventsWritten).toBe(1)

    appendSession(file, turn(1, 2, '第二步'))
    const seen: string[] = []
    const second = await consolidate({
      ...deps,
      distiller: fakeDistiller((unit) => {
        const user = unit.records.find((record) => record.kind === 'user')
        if (user) seen.push(user.text)
      }),
    })
    expect(second.eventsWritten).toBe(1)
    // only the new span was encoded
    expect(seen).toEqual(['第二步'])
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(2)
  })

  it('keeps the cursor behind a failed encode and retries it later', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '会失败的编码')])

    const failing: Distiller = {
      async encode() {
        throw new Error('DeepSeek 挂了')
      },
    }
    const failed = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: failing,
      embedder: fakeEmbedder,
      force: true,
    })
    expect(failed.eventsWritten).toBe(0)
    expect(failed.eventsFailed).toBe(1)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(0)
    const runState = loadRunState(paths)
    expect(Object.values(runState.failures)).toHaveLength(1)
    expect(Object.values(runState.failures)[0]?.kind).toBe('consolidate')
    expect(loadCursor(paths).sessions[file]?.processedRecords ?? 0).toBe(0)

    // the retry encodes the same span once the transport works again
    const recovered = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })
    expect(recovered.eventsWritten).toBe(1)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(1)
  })

  it('keeps the event when embedding fails and backfills on a later run', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '向量会失败')])

    const brokenEmbedder: Embedder = {
      model: 'fake-embed',
      dimensions: 8,
      async embed() {
        throw new Error('DashScope 503')
      },
    }
    const first = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: brokenEmbedder,
      force: true,
    })
    expect(first.eventsWritten).toBe(1)
    expect(first.embedFailed).toBe(1)
    const summaries = listEventSummaries(paths, { refresh: true })
    expect(summaries).toHaveLength(1)

    const store = new VectorStore(paths.vectorDb)
    expect(store.count()).toBe(0)
    store.close()

    // the stale/missing sweep repairs the index without re-encoding
    const healed = await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })
    expect(healed.eventsWritten).toBe(0)
    expect(healed.embedded).toBe(1)
    const store2 = new VectorStore(paths.vectorDb)
    expect(store2.count()).toBe(1)
    store2.close()
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(1)
  })

  it('deduplicates a span that already produced an event', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '重复片段')])
    const deps = { paths, config, secrets, logger: silentLogger(), embedder: fakeEmbedder, force: true }

    await consolidate({ ...deps, distiller: fakeDistiller() })
    // lose the cursor on purpose: the span hash memory must still suppress the duplicate
    const cursor = loadCursor(paths)
    cursor.sessions = {}
    const { saveCursor } = await import('../src/state.js')
    saveCursor(paths, cursor)

    const again = await consolidate({ ...deps, distiller: fakeDistiller() })
    // the span-hash memory suppresses the duplicate even without a cursor
    expect(again.eventsWritten).toBe(0)
    const summaries = listEventSummaries(paths, { refresh: true })
    expect(summaries).toHaveLength(1)
    expect(readEvent(paths, summaries[0]!.id)?.revision).toBe(1)
  })

  it('repairs a missing markdown half from the JSON', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '配对测试')])
    await consolidate({
      paths,
      config,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })
    const summary = listEventSummaries(paths, { refresh: true })[0]!
    fs.rmSync(summary.mdFile)
    expect(listEventSummaries(paths, { refresh: true })[0]?.problem).toBe('missing-md')
    const repaired = repairPairs(paths)
    expect(repaired.repaired).toContain(summary.id)
    expect(fs.existsSync(summary.mdFile)).toBe(true)
    expect(readDiary(paths, summary.id)).toBe(readEvent(paths, summary.id)?.diary)
  })

  it('honours the cooldown unless forced, and supports dry runs', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '冷却测试')])
    const cold = mergeConfig(config, { consolidation: { cooldownMs: 600_000 } as never })

    const dry = await consolidate({
      paths,
      config: cold,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
      dryRun: true,
    })
    expect(dry.eventsWritten).toBe(1)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(0)

    const real = await consolidate({
      paths,
      config: cold,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
      force: true,
    })
    expect(real.eventsWritten).toBe(1)

    const cooled = await consolidate({
      paths,
      config: cold,
      secrets,
      logger: silentLogger(),
      distiller: fakeDistiller(),
      embedder: fakeEmbedder,
    })
    expect(cooled.aborted).toBe('cooldown')
  })

  it('stops when the key is missing instead of throwing', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1' }), ...turn(1, 1, '缺密钥')])
    const result = await consolidate({
      paths,
      config,
      secrets: { origin: { deepseek: 'missing', dashscope: 'missing' } },
      logger: silentLogger(),
      force: true,
    })
    expect(result.aborted).toBe('missing-secret')
    expect(result.eventsWritten).toBe(0)
  })
})
