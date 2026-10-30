import { describe, expect, it } from 'vitest'

import {
  EncodingError,
  ENCODING_GUIDE,
  RESPONSE_CONTRACT,
  buildEncodingRequest,
  buildSystemPrompt,
  extractJsonObject,
  normalizeEncodedEvent,
  parseEncodingResponse,
  renderUnitRecords,
} from '../src/prompt.js'
import type { EventUnit, MemoryConfig, RawRecord } from '../src/types.js'

const config = {
  version: 1,
  dataRoot: '/tmp/root',
  session: { readDirs: ['~/.dsh/sessions'], includeGlobs: [], excludeGlobs: [], minRecordsPerEvent: 2, maxRecordsPerEvent: 200, tailRecords: 6 },
  consolidation: { maxInputChars: 60000, minEventChars: 120, maxEventsPerRun: 12, recentEventLimit: 20, cooldownMs: 60000, serialize: true, maxSpanAttempts: 3 },
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

const unit = (records: RawRecord[]): EventUnit => ({
  sessionFile: '/home/ubuntu/.dsh/sessions/proj/sess-1/session.jsonl.zstd',
  sessionId: 'sess-1',
  records,
  fromSeq: records[0]?.seq ?? 0,
  toSeq: records[records.length - 1]?.seq ?? 0,
  turns: [1],
  startedAt: '2025-10-30T16:45:12+08:00',
  endedAt: '2025-10-30T16:52:40+08:00',
  contentHash: 'abc123',
  truncated: false,
  chars: 500,
})

const goodPayload = {
  structured: {
    title: '我把插件装进了 web profile',
    startedAt: '2025-10-30T16:45:12+08:00',
    endedAt: '2025-10-30T16:52:40+08:00',
    scene: { cwd: '/home/ubuntu/dsh-agentchat/runtime', project: 'AutoBioMemory', channel: 'web' },
    people: [{ name: '我', role: 'agent' }, { name: '用户', role: 'human' }],
    goals: ['把插件装进正在运行的 profile'],
    actions: [
      { order: 1, why: '用户要求从 dist 安装', what: '打包产物并生成 tarball', adjustment: 'profile 目录不可写', result: '改用全权限安装' },
    ],
    statements: [
      { kind: 'fact', text: 'bundle 层已注册' },
      { kind: 'inference', text: '重启后会加载', confidence: 0.8 },
      { kind: 'plan', text: '稍后验证工具' },
      { kind: 'completion', text: '插件已安装' },
    ],
    emotions: [{ who: '用户', emotion: '急切', evidence: '“你先把1234完成”', basis: 'inference' }],
    outcome: { status: 'partial', summary: '安装完成，待重启验证', artifacts: ['dist/x.tgz'] },
    tags: ['部署'],
    keywords: ['dsh plugin add'],
    entities: ['deepseek-harness-autobiomemory'],
    lessons: ['安装后需重启'],
    openQuestions: ['谁来重启'],
  },
  diary: '我先把产物打包好，然后才意识到 profile 目录不可写……最后装上去了，但还没验证。',
}

describe('guide', () => {
  it('covers the required encoding rules', () => {
    for (const phrase of [
      '第一人称',
      '动机',
      '行动',
      '调整',
      '回应',
      '结果',
      '北京时间',
      '依据',
      'fact',
      'inference',
      'plan',
      'completion',
      '不编造',
      '计划',
    ]) {
      expect(ENCODING_GUIDE).toContain(phrase)
    }
    expect(ENCODING_GUIDE.length).toBeGreaterThan(1200)
    expect(RESPONSE_CONTRACT).toContain('structured')
    expect(RESPONSE_CONTRACT).toContain('diary')
    expect(RESPONSE_CONTRACT).toContain('只输出 JSON')
    expect(buildSystemPrompt(config)).toContain('diary')
  })
})

describe('renderUnitRecords', () => {
  it('renders the Chinese transcript format', () => {
    const text = renderUnitRecords(
      unit([
        record({ seq: 3, kind: 'user', text: '帮我把插件装进去' }),
        record({ seq: 4, kind: 'assistant', text: '我先看 profile 目录' }),
        record({ seq: 5, kind: 'tool-call', text: '{"command":"ls"}', tool: 'bash' }),
        record({ seq: 6, kind: 'tool-result', text: '（失败）permission denied', tool: 'bash' }),
        record({ seq: 7, kind: 'meta', text: '' }),
      ]),
    )
    expect(text).toContain('[3] 2025-10-30 16:45:12 用户：帮我把插件装进去')
    expect(text).toContain('[4] 2025-10-30 16:45:12 我：我先看 profile 目录')
    expect(text).toContain('[5] 2025-10-30 16:45:12 我调用工具 bash：{"command":"ls"}')
    expect(text).toContain('[6] 2025-10-30 16:45:12 工具结果 bash：（失败）permission denied')
    expect(text).not.toContain('[7]')
  })

  it('notes truncation', () => {
    const text = renderUnitRecords({ ...unit([record({ seq: 1, kind: 'user', text: 'x' })]), truncated: true })
    expect(text).toContain('截断')
  })
})

describe('buildEncodingRequest', () => {
  it('carries the transcript, the range and the contract', () => {
    const { system, user } = buildEncodingRequest(
      config,
      unit([record({ seq: 1, kind: 'user', text: '你好' })]),
    )
    expect(system).toContain('自传体记忆编码器')
    expect(user).toContain('2025-10-30T16:45:12+08:00')
    expect(user).toContain('会话：sess-1')
    expect(user).toContain('原始会话片段')
    expect(user).toContain('你好')
    expect(user).toContain('只输出 JSON')
  })
})

describe('parseEncodingResponse', () => {
  it('parses a clean payload', () => {
    const parsed = parseEncodingResponse(JSON.stringify(goodPayload))
    expect(parsed.structured.title).toBe('我把插件装进了 web profile')
    expect(parsed.structured.actions).toHaveLength(1)
    expect(parsed.structured.actions[0]?.adjustment).toBe('profile 目录不可写')
    expect(parsed.structured.statements.map((s) => s.kind)).toEqual([
      'fact',
      'inference',
      'plan',
      'completion',
    ])
    expect(parsed.structured.statements[1]?.confidence).toBe(0.8)
    expect(parsed.diary).toContain('我先把产物打包好')
    expect(parsed.structured.sources).toEqual([])
  })

  it('tolerates fences, prose and BOM', () => {
    const wrapped = `\uFEFF好的，这是结果：\n\n\`\`\`json\n${JSON.stringify(goodPayload)}\n\`\`\`\n\n希望有帮助。`
    expect(parseEncodingResponse(wrapped).structured.title).toBe('我把插件装进了 web profile')
    expect(parseEncodingResponse(`前言 {${JSON.stringify(goodPayload).slice(1)}`).diary).toContain('我先把')
  })

  it('handles braces and quotes inside strings', () => {
    const tricky = JSON.parse(JSON.stringify(goodPayload))
    tricky.diary = '他说“把 {这个} 加上”，然后我照做了。'
    const text = `说明前后缀 ${JSON.stringify(tricky)} 收尾`
    expect(parseEncodingResponse(text).diary).toBe(tricky.diary)
    expect(extractJsonObject(text)?.endsWith('}')).toBe(true)
  })

  it('throws a diagnostic when the shape is wrong', () => {
    expect(() => parseEncodingResponse('not json at all')).toThrow(EncodingError)
    expect(() => parseEncodingResponse('{}')).toThrow(/structured/u)
    expect(() => parseEncodingResponse('{"structured":{}}')).toThrow(/diary/u)
    expect(() => parseEncodingResponse('{"structured":{},"diary":"   "}')).toThrow(/diary/u)
    expect(() => parseEncodingResponse('')).toThrow(EncodingError)
  })
})

describe('normalizeEncodedEvent', () => {
  it('clamps status, coerces arrays and drops unknown keys', () => {
    const parsed = normalizeEncodedEvent({
      structured: {
        title: '',
        status: 'weird',
        statements: [{ kind: 'guess', text: 'x', confidence: 4 }, 'noise'],
        outcome: { status: 'weird', summary: '' },
        tags: ['a', 3, 'b'],
        emotions: [{ who: '', emotion: '开心', basis: 'fact', evidence: '笑了' }],
        actions: [{ what: '' }, { what: '做了事', order: 2 }],
        extraKey: 'ignored',
      },
      diary: '第一句是标题。后面还有内容。',
      extraTop: 1,
    })
    expect(parsed.structured.outcome.status).toBe('ongoing')
    expect(parsed.structured.title).toBe('第一句是标题')
    expect(parsed.structured.statements[0]?.kind).toBe('fact')
    expect(parsed.structured.statements[0]?.confidence).toBe(1)
    expect(parsed.structured.tags).toEqual(['a', 'b'])
    expect(parsed.structured.emotions[0]?.who).toBe('我')
    expect(parsed.structured.actions).toHaveLength(1)
    expect(parsed.structured.actions[0]?.order).toBe(2)
    expect((parsed.structured as unknown as Record<string, unknown>).extraKey).toBeUndefined()
    expect((parsed as unknown as Record<string, unknown>).extraTop).toBeUndefined()
  })

  it('keeps every valid status', () => {
    for (const status of ['completed', 'partial', 'failed', 'ongoing', 'planned']) {
      const parsed = normalizeEncodedEvent({
        structured: { outcome: { status } },
        diary: '正文',
      })
      expect(parsed.structured.outcome.status).toBe(status)
    }
  })
})
