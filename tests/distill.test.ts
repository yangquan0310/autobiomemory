import { describe, expect, it } from 'vitest'

import { createDistiller, encodeUnit } from '../src/distill.js'
import { EncodingError } from '../src/prompt.js'
import { silentLogger } from '../src/logger.js'
import type { EventUnit, MemoryConfig, RawRecord } from '../src/types.js'

const config = {
  version: 1,
  dataRoot: '/tmp/root',
  session: { readDirs: ['~'], includeGlobs: [], excludeGlobs: [], minRecordsPerEvent: 2, maxRecordsPerEvent: 200, tailRecords: 6 },
  consolidation: { maxInputChars: 60000, minEventChars: 120, maxEventsPerRun: 12, recentEventLimit: 20, cooldownMs: 60000, serialize: true },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0.4, maxTokens: 8000, timeoutMs: 240000, jsonMode: true, retries: 3 },
  dashscope: { region: 'beijing', baseUrl: 'https://dashscope.aliyuncs.com', embeddingModel: 'text-embedding-v4', embeddingDimensions: 1024, embeddingBatchSize: 8, rerankModel: 'gte-rerank-v2', rerankTopN: 20, rerankEnabled: true, timeoutMs: 60000, retries: 3 },
  retrieval: { candidateLimit: 200, vectorTopK: 30, rerankTopN: 8, finalLimit: 5, shortTermCount: 8, includeSources: true, minScore: 0, maxReplyChars: 6000 },
  trigger: { onCompaction: true, onTurnEnd: false, onSessionStart: false, toolName: 'autobiomemory_recall', globalCooldownMs: 120000 },
} as MemoryConfig

const record = (over: Partial<RawRecord> & { seq: number; kind: RawRecord['kind']; text: string }): RawRecord => ({
  turn: 1,
  at: '2025-10-30T08:45:12.000Z',
  raw: {},
  ...over,
})

const unit = (): EventUnit => ({
  sessionFile: '/home/ubuntu/.dsh/sessions/proj/sess-1/session.jsonl.zstd',
  sessionId: 'sess-1',
  records: [
    record({ seq: 10, kind: 'user', text: '把插件装上' }),
    record({ seq: 11, kind: 'assistant', text: '我先打包' }),
    record({ seq: 12, kind: 'tool-call', text: '{"command":"pnpm build"}', tool: 'bash' }),
    record({ seq: 13, kind: 'tool-result', text: 'build ok', tool: 'bash' }),
  ],
  fromSeq: 10,
  toSeq: 13,
  turns: [2, 3],
  startedAt: '2025-10-30T16:45:12+08:00',
  endedAt: '2025-10-30T16:52:40+08:00',
  contentHash: 'deadbeefcafe',
  truncated: true,
  chars: 400,
})

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    structured: {
      title: '我把插件装上了',
      startedAt: 'not-a-date',
      endedAt: '',
      outcome: { status: 'completed', summary: '装好了' },
      ...over,
    },
    diary: '我先打包，然后装上去了。',
  })

describe('encodeUnit', () => {
  it('stamps provenance and repairs times from the unit', async () => {
    const calls: unknown[] = []
    const encoded = await encodeUnit(
      {
        config,
        apiKey: 'sk-test',
        logger: silentLogger(),
        client: {
          chat: async (messages, options) => {
            calls.push({ messages, options })
            return payload()
          },
        },
      },
      unit(),
    )
    expect(calls).toHaveLength(1)
    expect(encoded.structured.sources).toHaveLength(1)
    const source = encoded.structured.sources[0]
    expect(source?.sessionFile).toBe(unit().sessionFile)
    expect(source?.fromSeq).toBe(10)
    expect(source?.toSeq).toBe(13)
    expect(source?.recordCount).toBe(4)
    expect(source?.turns).toEqual([2, 3])
    expect(source?.contentHash).toBe('deadbeefcafe')
    expect(source?.truncated).toBe(true)
    expect(source?.capturedAt).toMatch(/Z$/u)
    // model's unparsable times are replaced by the unit's bounds
    expect(encoded.structured.startedAt).toBe('2025-10-30T16:45:12+08:00')
    expect(encoded.structured.endedAt).toBe('2025-10-30T16:52:40+08:00')
  })

  it('keeps parsed times and overwrites model-provided source refs', async () => {
    const encoded = await encodeUnit(
      {
        config,
        apiKey: 'sk-test',
        logger: silentLogger(),
        client: {
          chat: async () =>
            payload({
              startedAt: '2025-10-30T16:44:00+08:00',
              sources: [{ sessionFile: '/evil', fromSeq: 0, toSeq: 1 }],
            }),
        },
      },
      unit(),
    )
    expect(encoded.structured.startedAt).toBe('2025-10-30T16:44:00+08:00')
    expect(encoded.structured.sources).toHaveLength(1)
    expect(encoded.structured.sources[0]?.sessionFile).toBe(unit().sessionFile)
  })

  it('surfaces an invalid answer as EncodingError', async () => {
    await expect(
      encodeUnit(
        { config, apiKey: 'sk-test', logger: silentLogger(), client: { chat: async () => 'totally not json' } },
        unit(),
      ),
    ).rejects.toThrow(EncodingError)
  })

  it('createDistiller exposes the same behaviour', async () => {
    const distiller = createDistiller({
      config,
      apiKey: 'sk-test',
      logger: silentLogger(),
      client: { chat: async () => payload() },
    })
    const encoded = await distiller.encode(unit())
    expect(encoded.diary).toContain('我先打包')
  })
})
