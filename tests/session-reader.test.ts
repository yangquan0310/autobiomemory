import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  decodeZstdFrames,
  listSessionFiles,
  normalizeRecords,
  pendingRecords,
  readTranscript,
  renderRecords,
  sessionIdFromPath,
  spanHash,
} from '../src/session-reader.js'
import { buildUnits, unitOptionsFromConfig } from '../src/units.js'
import type { RawRecord } from '../src/types.js'

/** Build a transcript the way dsh writes it: one independent frame per append. */
function framesOf(chunks: string[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => zlib.zstdCompressSync(Buffer.from(chunk, 'utf8'))))
}

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

describe('decodeZstdFrames', () => {
  it('decodes concatenated frames', () => {
    const buffer = framesOf([line({ type: 'a', n: 1 }), line({ type: 'b', n: 2 }), line({ type: 'c', n: 3 })])
    const decoded = decodeZstdFrames(buffer)
    expect(decoded.frames).toBe(3)
    expect(decoded.consumedBytes).toBe(buffer.length)
    const lines = decoded.text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2] as string).type).toBe('c')
  })

  it('keeps the readable prefix of a torn tail', () => {
    const whole = framesOf([line({ type: 'a' }), line({ type: 'b' })])
    const torn = Buffer.concat([whole, whole.subarray(0, 12)])
    const decoded = decodeZstdFrames(torn)
    expect(decoded.frames).toBe(2)
    expect(decoded.consumedBytes).toBe(whole.length)
    expect(decoded.text).toContain('"a"')
  })

  it('returns nothing for an empty buffer', () => {
    expect(decodeZstdFrames(Buffer.alloc(0))).toEqual({ text: '', frames: 0, consumedBytes: 0 })
  })
})

const sessionHeader = line({ type: 'session', version: 0, id: 'sess-1', createdAt: 1_700_000_000_000, cwd: '/work/x' })
const turnStart = line({ type: 'turn/start', seq: 1, time: 1_700_000_001_000, data: { turn: 1 } })
const userMessage = line({
  type: 'user/message',
  seq: 2,
  time: 1_700_000_002_000,
  id: 'm1',
  data: { content: [{ type: 'text', text: '帮我把插件装进 profile' }], source: { kind: 'user' } },
})
const assistantMessage = line({
  type: 'assistant/message',
  seq: 3,
  time: 1_700_000_003_000,
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '我先看 profile 目录' }] } },
})
const toolCall = line({
  type: 'tool/call',
  seq: 4,
  time: 1_700_000_004_000,
  data: { turn: 1, step: 1, name: 'bash', arguments: '{"command":"ls /home/ubuntu/.dsh/profiles/web"}' },
})
const toolResult = line({
  type: 'tool/result',
  seq: 5,
  time: 1_700_000_005_000,
  data: {
    turn: 1,
    step: 1,
    message: {
      source: { kind: 'tool', tool: 'bash' },
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'cordis.yml\npackage.json' }] }],
    },
  },
})
const streamNoise = line({
  type: 'assistant/chunk',
  seq: 6,
  time: 1_700_000_006_000,
  data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
})
const textChunks = line({
  type: 'text-chunks',
  seq: 7,
  time: 1_700_000_007_000,
  data: { turn: 1, step: 1, index: 0, dt: [1, 2], texts: ['你', '好'] },
})
const compaction = line({
  type: 'compaction/summary',
  seq: 8,
  time: 1_700_000_008_000,
  data: { summary: [{ type: 'text', text: '之前聊过安装插件' }] },
})
const goalChange = line({
  type: 'goal/change',
  seq: 9,
  time: 1_700_000_009_000,
  data: { operation: 'create', goal: { id: 'g1', objective: '把插件装好' } },
})

describe('normalizeRecords', () => {
  const lines = [
    sessionHeader,
    turnStart,
    userMessage,
    assistantMessage,
    toolCall,
    toolResult,
    streamNoise,
    textChunks,
    compaction,
    goalChange,
  ]

  it('maps each event type onto the flat vocabulary and skips stream noise', () => {
    const records = normalizeRecords(lines)
    const kinds = records.map((record) => record.kind)
    expect(kinds).toContain('meta')
    expect(kinds).toContain('user')
    expect(kinds).toContain('assistant')
    expect(kinds).toContain('tool-call')
    expect(kinds).toContain('tool-result')
    expect(kinds).toContain('compact')
    expect(kinds).toContain('system')
    const user = records.find((record) => record.kind === 'user') as RawRecord
    expect(user.text).toBe('帮我把插件装进 profile')
    expect(user.turn).toBe(1)
    const call = records.find((record) => record.kind === 'tool-call') as RawRecord
    expect(call.tool).toBe('bash')
    // streaming deltas must not become records of their own
    expect(records.some((record) => record.kind === 'other')).toBe(false)
  })

  it('de-duplicates spliced inbox messages against the delivered user message', () => {
    const spliced = line({
      type: 'agent/inbox/spliced',
      seq: 1,
      time: 1_700_000_002_000,
      data: { target: 'next-turn', start: 0, inserted: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    })
    const delivered = line({
      type: 'user/message',
      seq: 2,
      time: 1_700_000_002_000,
      id: 'm1',
      data: { content: [{ type: 'text', text: 'hello' }] },
    })
    const records = normalizeRecords([spliced, delivered])
    expect(records.filter((record) => record.kind === 'user')).toHaveLength(1)
  })

  it('marks failed tool results', () => {
    const failed = line({
      type: 'tool/result',
      seq: 3,
      time: 1_700_000_003_000,
      data: {
        message: {
          source: { kind: 'tool' },
          content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'permission denied' }] }],
        },
      },
    })
    const records = normalizeRecords([failed])
    expect(records[0]?.text).toContain('失败')
    expect(records[0]?.text).toContain('permission denied')
  })

  it('ignores unparsable lines', () => {
    expect(normalizeRecords(['{not json', ''])).toHaveLength(0)
  })
})

describe('renderRecords', () => {
  it('renders the Chinese line format', () => {
    const records = normalizeRecords(
      [sessionHeader, turnStart, userMessage, assistantMessage, toolCall, toolResult],
    )
    const { text, chars } = renderRecords(records)
    expect(text).toMatch(/^\[\d+\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 用户：帮我把插件装进 profile$/mu)
    expect(text).toContain('我调用工具 bash：{"command":"ls /home/ubuntu/.dsh/profiles/web"}')
    expect(text).toContain('工具结果 bash：cordis.yml package.json')
    expect(chars).toBe(text.length)
  })

  it('honours a character budget', () => {
    const records = normalizeRecords([sessionHeader, userMessage, assistantMessage])
    const { truncated } = renderRecords(records, 40)
    expect(truncated).toBe(true)
  })
})

describe('helpers', () => {
  it('derives a session id from the directory name', () => {
    expect(sessionIdFromPath('/a/b/agentchat-web-v1-abc/session.jsonl.zstd')).toBe('agentchat-web-v1-abc')
  })

  it('hashes spans stably', () => {
    const records = normalizeRecords([userMessage])
    expect(spanHash(records)).toBe(spanHash(records))
    expect(spanHash(records)).not.toBe(spanHash([]))
  })

  it('lists session files by glob', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'abm-session-'))
    const nested = path.join(root, 'proj', 'sess-1')
    fs.mkdirSync(nested, { recursive: true })
    const file = path.join(nested, 'session.jsonl.zstd')
    fs.writeFileSync(file, framesOf([line({ type: 'session', id: 'x' })]))
    fs.writeFileSync(path.join(nested, 'other.txt'), 'ignore me')
    expect(listSessionFiles([root])).toEqual([file])
    expect(listSessionFiles([root], ['**/session.jsonl.zstd'], ['**/skip/**'])).toEqual([file])
  })
})

describe('buildUnits', () => {
  const options = {
    minRecordsPerEvent: 2,
    maxRecordsPerEvent: 50,
    maxInputChars: 100_000,
    minEventChars: 1,
    tailRecords: 0,
  }

  const transcriptOf = (chunks: string[], file: string) => {
    fs.writeFileSync(file, framesOf(chunks))
    return readTranscript(file)
  }

  it('starts a unit at a user record and splits before the next one', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'abm-units-'))
    const file = path.join(root, 'session.jsonl.zstd')
    const secondUser = line({
      type: 'user/message',
      seq: 6,
      time: 1_700_000_010_000,
      id: 'm2',
      data: { content: [{ type: 'text', text: '再来一次' }] },
    })
    const secondReply = line({
      type: 'assistant/message',
      seq: 7,
      time: 1_700_000_011_000,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '好，我重新装一次' }] } },
    })
    const transcript = transcriptOf(
      [sessionHeader, turnStart, userMessage, assistantMessage, toolCall, toolResult, secondUser, secondReply],
      file,
    )
    const units = buildUnits(transcript, options)
    expect(units).toHaveLength(2)
    expect(units[0]?.fromSeq).toBe(3)
    expect(units[0]?.toSeq).toBe(6)
    expect(units[0]?.records.some((record) => record.kind === 'tool-result')).toBe(true)
    expect(units[1]?.fromSeq).toBe(7)
    expect(units[1]?.toSeq).toBe(8)
  })

  it('never splits a tool call from its result when the budget forces a close', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'abm-units-'))
    const file = path.join(root, 'session.jsonl.zstd')
    const transcript = transcriptOf(
      [sessionHeader, turnStart, userMessage, assistantMessage, toolCall, toolResult],
      file,
    )
    const units = buildUnits(transcript, { ...options, maxRecordsPerEvent: 4, minRecordsPerEvent: 1 })
    for (const unit of units) {
      const callIndex = unit.records.findIndex((record) => record.kind === 'tool-call')
      if (callIndex >= 0) expect(unit.records.some((record) => record.kind === 'tool-result')).toBe(true)
    }
  })

  it('holds the tail back and drops undersized units', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'abm-units-'))
    const file = path.join(root, 'session.jsonl.zstd')
    const transcript = transcriptOf(
      [sessionHeader, turnStart, userMessage, assistantMessage, toolCall, toolResult],
      file,
    )
    expect(buildUnits(transcript, { ...options, tailRecords: 100 })).toHaveLength(0)
    expect(buildUnits(transcript, { ...options, minEventChars: 100_000 })).toHaveLength(0)
  })

  it('respects the cursor', () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'abm-units-'))
    const file = path.join(root, 'session.jsonl.zstd')
    const transcript = transcriptOf(
      [sessionHeader, turnStart, userMessage, assistantMessage, toolCall, toolResult],
      file,
    )
    const cursor = {
      sessionFile: transcript.sessionFile,
      sessionId: transcript.sessionId,
      processedRecords: 6,
      byteOffset: transcript.bytes,
      fileSize: transcript.fileSize,
      fileMtimeMs: transcript.fileMtimeMs,
      lastRecordHash: '',
      lastSpanHash: '',
      updatedAt: new Date().toISOString(),
    }
    expect(pendingRecords(transcript, cursor)).toHaveLength(0)
    expect(buildUnits(transcript, options, cursor)).toHaveLength(0)
  })

  it('maps config onto unit options', () => {
    const config = {
      session: { minRecordsPerEvent: 2, maxRecordsPerEvent: 40, tailRecords: 5 },
      consolidation: { maxInputChars: 9000, minEventChars: 120 },
    } as unknown as Parameters<typeof unitOptionsFromConfig>[0]
    const mapped = unitOptionsFromConfig(config)
    expect(mapped).toEqual({
      minRecordsPerEvent: 2,
      maxRecordsPerEvent: 40,
      maxInputChars: 9000,
      minEventChars: 120,
      tailRecords: 5,
    })
  })
})

describe('real transcripts', () => {
  const root = '/home/ubuntu/.dsh/sessions'
  const available = fs.existsSync(root)

  it.skipIf(!available)('decodes every frame of every live session file', () => {
    const files = listSessionFiles([root])
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const stat = fs.statSync(file)
      const decoded = decodeZstdFrames(fs.readFileSync(file))
      expect(decoded.consumedBytes).toBe(stat.size)
      const lines = decoded.text.split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(0)
      for (const entry of lines.slice(0, 40)) {
        expect(() => JSON.parse(entry)).not.toThrow()
      }
      const records = normalizeRecords(lines)
      expect(records.some((record) => record.kind === 'meta')).toBe(true)
    }
  })
})
