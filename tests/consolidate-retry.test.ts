/**
 * Regression tests for the failure-retry deadlock.
 *
 * `state/status.json` holds failed sessions with exponential backoff. Before this fix the write
 * path computed the **due** set (`nextAttemptAt <= now`, i.e. "retry these now") and used it as a
 * skip list, so a session whose backoff had expired was skipped on every run — forever, because
 * skipping never advances `nextAttemptAt`. `attempts` therefore stayed at 1 and the poison-span
 * give-up (`consolidation.maxSpanAttempts`) could never trigger, so one bad span blocked its
 * session's cursor indefinitely and only `consolidate --force` moved anything.
 *
 * Every test here runs **without** `force`, because `--force` bypasses the backoff check entirely
 * and is exactly what hid the bug.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { beforeEach, describe, expect, it } from 'vitest'

import { defaultConfig, mergeConfig } from '../src/config.js'
import { consolidate } from '../src/consolidate.js'
import { ensureDataLayout, memoryPaths, type MemoryPaths } from '../src/paths.js'
import { listEventSummaries } from '../src/store.js'
import {
  dueFailures,
  failureKey,
  loadCursor,
  loadRunState,
  notYetDueFailures,
  recordFailure,
  saveRunState,
} from '../src/state.js'
import { silentLogger } from '../src/logger.js'
import { sha256 } from '../src/util.js'
import type {
  Distiller,
  Embedder,
  EncodedEvent,
  EventUnit,
  MemoryConfig,
  SecretSource,
} from '../src/types.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const secrets: SecretSource = {
  deepseekApiKey: 'sk-test',
  dashscopeApiKey: 'dash-test',
  origin: { deepseek: '.env', dashscope: '.env' },
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

/** One dsh turn: a few records, enough for the unit builder to see an event. */
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abm-retry-'))
  paths = memoryPaths(root)
  ensureDataLayout(paths)
  sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  config = mergeConfig(defaultConfig(root), {
    session: { readDirs: [sessionsDir], minRecordsPerEvent: 2, tailRecords: 0, maxRecordsPerEvent: 100 },
    // Both cooldown knobs off: these tests measure per-session backoff, not run pacing.
    consolidation: { maxEventsPerRun: 10, cooldownMs: 0, minEventChars: 1 },
    trigger: { globalCooldownMs: 0 },
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
      const request = unit.records.find((record) => record.kind === 'user')?.text ?? '（无请求）'
      return {
        structured: {
          title: `我处理了：${request}`,
          startedAt: unit.startedAt,
          endedAt: unit.endedAt,
          scene: { cwd: '/work', channel: 'web' },
          people: [{ name: '我', role: 'agent' }],
          goals: [request],
          actions: [{ order: 1, why: '用户要求', what: '我执行了命令', result: '看到 a b c' }],
          statements: [{ kind: 'fact', text: '工具返回 a b c' }],
          emotions: [],
          outcome: { status: 'completed', summary: '完成', artifacts: [] },
          tags: ['测试'],
          keywords: ['bash'],
          entities: ['bash'],
          lessons: [],
          openQuestions: [],
          sources: [],
        },
        diary: `第 ${counter} 个事件的日记。用户说：${request}。`,
      }
    },
  }
}

/** The failure the live queue is stuck on. */
const BAD_JSON = '响应不是合法 JSON'

/** A distiller that always fails, recording every call so retries are observable. */
function failingDistiller(calls: EventUnit[]): Distiller {
  return {
    async encode(unit: EventUnit): Promise<EncodedEvent> {
      calls.push(unit)
      throw new Error(BAD_JSON)
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

type Deps = Parameters<typeof consolidate>[0]

/** Run one consolidation **without** `force`: the backoff rules must decide on their own. */
function run(deps: Partial<Deps> & { distiller: Distiller }): Promise<Awaited<ReturnType<typeof consolidate>>> {
  return consolidate({
    paths,
    config,
    secrets,
    logger: silentLogger(),
    embedder: fakeEmbedder,
    ...deps,
  })
}

/** Move the session's failure entry into the past, i.e. make it due for a retry. */
function makeDue(file: string): void {
  const state = loadRunState(paths)
  const key = failureKey('consolidate', file)
  const entry = state.failures[key]
  if (!entry) throw new Error(`no failure recorded for ${file}`)
  state.failures[key] = { ...entry, nextAttemptAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
  saveRunState(paths, state)
}

/** Push the entry far into the future, i.e. keep it inside its backoff window. */
function makeNotDue(file: string, delayMs = 60 * 60 * 1000): void {
  const state = loadRunState(paths)
  const key = failureKey('consolidate', file)
  const entry = state.failures[key]
  if (!entry) throw new Error(`no failure recorded for ${file}`)
  state.failures[key] = { ...entry, nextAttemptAt: new Date(Date.now() + delayMs).toISOString() }
  saveRunState(paths, state)
}

function failureOf(file: string) {
  return loadRunState(paths).failures[failureKey('consolidate', file)]
}

function processed(file: string): number {
  return loadCursor(paths).sessions[file]?.processedRecords ?? 0
}

/* ------------------------------------------------------------------ *
 * The deadlock: a due failure must be retried
 * ------------------------------------------------------------------ */

describe('due failures are retried without --force', () => {
  beforeEach(() => {
    freshEnv()
  })

  it('retries an expired failure instead of skipping it forever', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '会失败的一段')])

    // run 1: the encode fails, the session enters backoff and the cursor stays put
    const firstCalls: EventUnit[] = []
    const first = await run({ distiller: failingDistiller(firstCalls) })
    expect(first.eventsFailed).toBe(1)
    expect(firstCalls).toHaveLength(1)
    expect(failureOf(file)?.attempts).toBe(1)
    expect(processed(file)).toBe(0)

    // the entry is now inside its backoff window: a second run must leave it alone
    const earlyCalls: EventUnit[] = []
    const early = await run({ distiller: failingDistiller(earlyCalls) })
    expect(earlyCalls).toHaveLength(0)
    expect(early.details.some((detail) => detail.includes('失败退避中'))).toBe(true)
    expect(failureOf(file)?.attempts).toBe(1)

    // ... and once it expires it must actually be attempted again
    makeDue(file)
    const retryCalls: EventUnit[] = []
    const retry = await run({ distiller: failingDistiller(retryCalls) })
    expect(retryCalls).toHaveLength(1) // ← the regression: this used to be 0, forever
    expect(retry.eventsFailed).toBe(1)
    expect(failureOf(file)?.attempts).toBe(2)
    expect(processed(file)).toBe(0)
  })

  it('clears the failure and moves the cursor when the retry succeeds', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '先失败后成功')])

    await run({ distiller: failingDistiller([]) })
    expect(failureOf(file)?.attempts).toBe(1)

    makeDue(file)
    const calls: EventUnit[] = []
    const retry = await run({ distiller: fakeDistiller((unit) => calls.push(unit)) })

    expect(calls).toHaveLength(1)
    expect(retry.eventsWritten).toBe(1)
    expect(retry.eventsFailed).toBe(0)
    // a retry that got through leaves the queue: `attempts` only counts consecutive failures
    expect(failureOf(file)).toBeUndefined()
    expect(Object.keys(loadRunState(paths).failures)).toHaveLength(0)
    expect(processed(file)).toBeGreaterThan(0)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(1)
  })

  it('gives up on a poison span after maxSpanAttempts using plain runs only', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '永远失败的一段')])

    config = mergeConfig(config, { consolidation: { maxSpanAttempts: 2 } })

    await run({ distiller: failingDistiller([]) })
    expect(failureOf(file)?.attempts).toBe(1)
    expect(Object.keys(loadRunState(paths).skipped ?? {})).toHaveLength(0)

    // attempts can only reach the threshold if the expired entry is retried — that is the point
    makeDue(file)
    const second = await run({ distiller: failingDistiller([]) })
    expect(second.eventsFailed).toBe(1)
    expect(second.details.some((detail) => detail.includes('放弃片段'))).toBe(true)

    const state = loadRunState(paths)
    expect(Object.keys(state.skipped ?? {})).toHaveLength(1)
    expect(failureOf(file)).toBeUndefined()
    expect(processed(file)).toBeGreaterThan(0)

    // the session keeps flowing afterwards, still without --force
    appendSession(file, turn(1, 2, '第二段正常'))
    const third = await run({ distiller: fakeDistiller() })
    expect(third.eventsWritten).toBe(1)
    expect(listEventSummaries(paths, { refresh: true })).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ *
 * The opposite direction: a not-yet-due failure is skipped
 * ------------------------------------------------------------------ */

describe('not-yet-due failures are skipped', () => {
  beforeEach(() => {
    freshEnv()
  })

  it('skips a session whose backoff has not expired and reports when it will retry', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '还在退避中')])

    await run({ distiller: failingDistiller([]) })
    makeNotDue(file)
    const nextAttemptAt = failureOf(file)?.nextAttemptAt

    const calls: EventUnit[] = []
    const skipped = await run({ distiller: failingDistiller(calls) })

    expect(calls).toHaveLength(0)
    expect(skipped.eventsFailed).toBe(0)
    expect(skipped.eventsWritten).toBe(0)
    expect(skipped.details.some((detail) => detail.includes('失败退避中'))).toBe(true)
    expect(skipped.details.some((detail) => detail.includes(String(nextAttemptAt)))).toBe(true)
    // skipping must not count as an attempt
    expect(failureOf(file)?.attempts).toBe(1)
  })

  it('--force stays available as an operator override for a not-yet-due failure', async () => {
    const file = path.join(sessionsDir, 'proj', 'sess-1', 'session.jsonl.zstd')
    writeSession(file, [line({ type: 'session', id: 'sess-1', createdAt: 1, cwd: '/work' }), ...turn(1, 1, '强制重试')])

    await run({ distiller: failingDistiller([]) })
    makeNotDue(file)

    const calls: EventUnit[] = []
    const forced = await run({ distiller: failingDistiller(calls), force: true })
    expect(calls).toHaveLength(1)
    expect(forced.eventsFailed).toBe(1)
    expect(failureOf(file)?.attempts).toBe(2)
  })
})

/* ------------------------------------------------------------------ *
 * The helper split that makes the inversion impossible to repeat
 * ------------------------------------------------------------------ */

describe('dueFailures / notYetDueFailures', () => {
  beforeEach(() => {
    freshEnv()
  })

  it('partitions the queue into "retry now" and "leave alone"', () => {
    const state = loadRunState(paths)
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    state.failures[failureKey('consolidate', '/session/due')] = {
      kind: 'consolidate',
      target: '/session/due',
      attempts: 1,
      lastError: BAD_JSON,
      lastAttemptAt: past,
      nextAttemptAt: past,
    }
    state.failures[failureKey('consolidate', '/session/backoff')] = {
      kind: 'consolidate',
      target: '/session/backoff',
      attempts: 2,
      lastError: BAD_JSON,
      lastAttemptAt: past,
      nextAttemptAt: future,
    }

    expect(dueFailures(state).map((entry) => entry.target)).toEqual(['/session/due'])
    expect(notYetDueFailures(state).map((entry) => entry.target)).toEqual(['/session/backoff'])
  })

  it('treats an unparsable nextAttemptAt as due so it can never wedge a session', () => {
    const state = loadRunState(paths)
    const entry = recordFailure(state, 'consolidate', '/session/broken', new Error(BAD_JSON), {
      retryDelayMs: 1000,
    })
    state.failures[failureKey('consolidate', '/session/broken')] = { ...entry, nextAttemptAt: 'not-a-date' }
    expect(dueFailures(state).map((failure) => failure.target)).toEqual(['/session/broken'])
    expect(notYetDueFailures(state)).toHaveLength(0)
  })
})
