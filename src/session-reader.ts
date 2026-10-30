/**
 * AutoBioMemory — raw session transcripts, read in place.
 *
 * dsh appends one **independent zstd frame per write** to the transcript file
 * (`session.v4.jsonl.zstd` on dsh 0.2.x, `session.jsonl.zstd` on older builds; live
 * files on this machine carry thousands of frames), and `zlib.zstdDecompressSync`
 * decodes only the first frame. So we walk the concatenated frame headers ourselves:
 * magic → frame header → blocks → optional checksum trailer, decompressing each frame
 * separately and concatenating the payloads.
 *
 * The transcript is then normalised from the dsh *session event log* into the flat
 * `RawRecord[]` vocabulary the rest of the memory pipeline speaks.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { sha256, truncate, beijingStamp, collapseWhitespace } from './util.js'
import type { RawRecord, RawRecordKind, SessionCursor, SessionTranscript } from './types.js'

export interface DecodedFrames {
  text: string
  frames: number
  consumedBytes: number
}

const ZSTD_MAGIC = 0xfd2fb528
const SKIPPABLE_MAGIC_MIN = 0x184d2a50
const SKIPPABLE_MAGIC_MAX = 0x184d2a5f

/** Size in bytes of the Frame_Content_Size field for a given descriptor. */
function frameContentSizeBytes(flag: number, singleSegment: number): number {
  if (flag === 0) return singleSegment === 1 ? 1 : 0
  if (flag === 1) return 2
  if (flag === 2) return 4
  return 8
}

/** Byte offset just past the end of the zstd frame starting at `start`. */
function frameEnd(buffer: Buffer, start: number): number {
  let p = start
  if (buffer.length - p < 5) throw new Error('truncated frame header')
  if (buffer.readUInt32LE(p) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at ${p}`)
  p += 4
  const descriptor = buffer[p] as number
  p += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const checksumFlag = (descriptor >> 2) & 1
  const dictionaryIdFlag = descriptor & 3
  if (singleSegment === 0) p += 1 // Window_Descriptor
  p += [0, 1, 2, 4][dictionaryIdFlag] as number
  p += frameContentSizeBytes(contentSizeFlag, singleSegment)
  if (p > buffer.length) throw new Error('truncated frame metadata')
  for (;;) {
    if (buffer.length - p < 3) throw new Error('truncated block header')
    const blockHeader = buffer.readUIntLE(p, 3)
    p += 3
    const lastBlock = blockHeader & 1
    const blockType = (blockHeader >> 1) & 3
    const blockSize = blockHeader >> 3
    if (blockType === 0 || blockType === 2) p += blockSize
    else if (blockType === 1) p += 1
    else throw new Error('reserved zstd block type')
    if (p > buffer.length) throw new Error('truncated block body')
    if (lastBlock === 1) break
  }
  if (checksumFlag === 1) p += 4
  if (p > buffer.length) throw new Error('truncated frame trailer')
  return p
}

/**
 * Decode a concatenation of complete zstd frames.
 *
 * A torn trailing frame (the file was being appended while we read it) is left alone:
 * everything decoded before it is returned and `consumedBytes` says where we stopped.
 */
export function decodeZstdFrames(buffer: Buffer): DecodedFrames {
  const chunks: Buffer[] = []
  let offset = 0
  let frames = 0
  while (buffer.length - offset >= 4) {
    const magic = buffer.readUInt32LE(offset)
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      if (buffer.length - offset < 8) break
      const size = buffer.readUInt32LE(offset + 4)
      const next = offset + 8 + size
      if (next > buffer.length) break
      offset = next
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    let end: number
    try {
      end = frameEnd(buffer, offset)
    } catch {
      break // torn tail: keep what we already have
    }
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)))
    } catch {
      break // corrupted frame: stop at the last good boundary
    }
    frames += 1
    offset = end
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames, consumedBytes: offset }
}

/** Minimal `**` glob → RegExp (posix separators, no brace expansion). */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i += 1
        if (glob[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`, 'u')
}

function walkFiles(dir: string, depth: number, out: string[]): void {
  if (depth > 6) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, depth + 1, out)
    else if (entry.isFile()) out.push(full)
  }
}

/** Enumerate session transcripts under the configured directories. */
export function listSessionFiles(
  readDirs: string[],
  includeGlobs: string[] = ['**/session*.jsonl.zstd', '**/session*.jsonl'],
  excludeGlobs: string[] = [],
): string[] {
  const includes = includeGlobs.map(globToRegExp)
  const excludes = excludeGlobs.map(globToRegExp)
  const found = new Set<string>()
  for (const dir of readDirs) {
    if (!dir) continue
    const candidates: string[] = []
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(dir)
    } catch {
      continue
    }
    if (stat.isFile()) candidates.push(dir)
    else walkFiles(dir, 0, candidates)
    for (const file of candidates) {
      const normalized = file.split(path.sep).join('/')
      const base = path.basename(file)
      const matchesInclude = includes.length === 0
        ? true
        : includes.some((re) => re.test(normalized)) || includes.some((re) => re.test(base))
      if (!matchesInclude) continue
      if (excludes.some((re) => re.test(normalized))) continue
      found.add(file)
    }
  }
  return [...found].sort()
}

/** `…/agentchat-web-v1-<id>/session.jsonl.zstd` → the directory name, else the file stem.
 *  The stem fallback also covers versioned transcripts such as `session.v4.jsonl.zstd`. */
export function sessionIdFromPath(file: string): string {
  const dir = path.basename(path.dirname(file))
  if (dir && dir !== '.' && dir !== path.sep) return dir
  return path.basename(file).replace(/\.(jsonl|zstd|ndjson)$/gu, '')
}

function appendText(parts: string[], text: string): void {
  if (text.trim() !== '') parts.push(text)
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') appendText(parts, record.text)
    else if (Array.isArray(record.content)) appendText(parts, textOfContent(record.content))
  }
  return parts.join('\n').trim()
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
    : []
}

interface NormalizeContext {
  records: RawRecord[]
  seenMessageIds: Set<string>
  turn: number
}

function pushRecord(
  ctx: NormalizeContext,
  kind: RawRecordKind,
  seq: number,
  at: number | undefined,
  text: string,
  raw: unknown,
  extra: { tool?: string } = {},
): void {
  const clean = collapseWhitespace(text)
  if (clean === '' && kind !== 'meta') return
  ctx.records.push({
    seq,
    kind,
    turn: ctx.turn,
    at: at === undefined ? undefined : new Date(at).toISOString(),
    text: clean,
    ...(extra.tool === undefined ? {} : { tool: extra.tool }),
    raw,
  })
}

function recordTime(entry: Record<string, unknown>): number | undefined {
  const candidates = [entry.time, entry.time0, (entry.data as Record<string, unknown> | undefined)?.time]
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const STREAMING_TYPE = /chunks?$/u
const SKIPPED_TYPES = new Set(['request/header', 'request/context', 'session/title-llm-request'])

/**
 * Map dsh session event-log lines onto `RawRecord[]`.
 *
 * `seq` is the 1-based line index; `turn` tracks `turn/start`; streaming deltas
 * (`assistant/chunk`, `text-chunks`, `reasoning-chunks`, `tool-call-chunks`, …) are noise
 * and are dropped, as are pure request bookkeeping records.
 */
export function normalizeRecords(lines: string[]): RawRecord[] {
  const ctx: NormalizeContext = { records: [], seenMessageIds: new Set<string>(), turn: 0 }
  let seq = 0
  for (const line of lines) {
    seq += 1
    const trimmed = line.trim()
    if (trimmed === '') continue
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (typeof parsed !== 'object' || parsed === null) continue
      entry = parsed as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof entry.type === 'string' ? entry.type : 'unknown'
    const data = (typeof entry.data === 'object' && entry.data !== null
      ? (entry.data as Record<string, unknown>)
      : {}) as Record<string, unknown>
    const at = recordTime(entry)

    if (STREAMING_TYPE.test(type) || SKIPPED_TYPES.has(type)) continue

    switch (type) {
      case 'session': {
        pushRecord(ctx, 'meta', seq, at, `会话开始 ${String(entry.id ?? '')}`, entry)
        ctx.turn = 0
        break
      }
      case 'turn/start': {
        const turn = typeof data.turn === 'number' ? data.turn : ctx.turn + 1
        ctx.turn = turn
        break
      }
      case 'user/message': {
        const id = typeof entry.id === 'string' ? entry.id : (typeof data.id === 'string' ? data.id : '')
        if (id !== '' && ctx.seenMessageIds.has(id)) break
        if (id !== '') ctx.seenMessageIds.add(id)
        pushRecord(ctx, 'user', seq, at, textOfContent(entry.content ?? data.content), entry)
        break
      }
      case 'agent/inbox/spliced': {
        const inserted = Array.isArray(data.inserted) ? data.inserted : []
        for (const item of inserted) {
          if (typeof item !== 'object' || item === null) continue
          const message = item as Record<string, unknown>
          const id = typeof message.id === 'string' ? message.id : ''
          if (id !== '' && ctx.seenMessageIds.has(id)) continue
          if (id !== '') ctx.seenMessageIds.add(id)
          pushRecord(ctx, 'user', seq, at, textOfContent(message.content), item)
        }
        break
      }
      case 'assistant/message': {
        const message = (typeof data.message === 'object' && data.message !== null
          ? (data.message as Record<string, unknown>)
          : {}) as Record<string, unknown>
        const blocks = contentBlocks(message.content)
        const text = blocks
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join('\n')
        pushRecord(ctx, 'assistant', seq, at, text, entry)
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool'
        const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
        pushRecord(ctx, 'tool-call', seq, at, truncate(collapseWhitespace(args), 400), entry, {
          tool: name,
        })
        break
      }
      case 'tool/result': {
        const message = (typeof data.message === 'object' && data.message !== null
          ? (data.message as Record<string, unknown>)
          : {}) as Record<string, unknown>
        const blocks = contentBlocks(message.content)
        const parts: string[] = []
        let failed = false
        for (const block of blocks) {
          if (block.isError === true) failed = true
          if (typeof block.text === 'string') appendText(parts, block.text)
          else if (Array.isArray(block.content)) appendText(parts, textOfContent(block.content))
        }
        const source = (typeof message.source === 'object' && message.source !== null
          ? (message.source as Record<string, unknown>)
          : {}) as Record<string, unknown>
        const tool = typeof source.tool === 'string' ? source.tool : undefined
        const body = truncate(collapseWhitespace(parts.join('\n')), 1200)
        pushRecord(
          ctx,
          'tool-result',
          seq,
          at,
          failed ? `（失败）${body}` : body,
          entry,
          tool === undefined ? {} : { tool },
        )
        break
      }
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
      case 'compaction/prune': {
        const summary = textOfContent(data.summary)
        pushRecord(
          ctx,
          'compact',
          seq,
          at,
          summary === '' ? `上下文压缩（${type}）` : `上下文压缩：${truncate(summary, 1500)}`,
          entry,
        )
        break
      }
      case 'goal/change': {
        const goal = (typeof data.goal === 'object' && data.goal !== null
          ? (data.goal as Record<string, unknown>)
          : {}) as Record<string, unknown>
        const operation = typeof data.operation === 'string' ? data.operation : 'change'
        const objective = typeof goal.objective === 'string' ? goal.objective : ''
        pushRecord(ctx, 'system', seq, at, `目标${operation}：${truncate(objective, 200)}`, entry)
        break
      }
      case 'todo/write': {
        const todos = Array.isArray(data.todos) ? data.todos : []
        const rendered = todos
          .map((todo) => {
            if (typeof todo !== 'object' || todo === null) return ''
            const item = todo as Record<string, unknown>
            const status = typeof item.status === 'string' ? item.status : ''
            const content = typeof item.content === 'string' ? item.content : ''
            return `${status}:${content}`
          })
          .filter((value) => value !== '')
          .join(' | ')
        pushRecord(ctx, 'system', seq, at, `待办更新：${truncate(rendered, 300)}`, entry)
        break
      }
      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title : ''
        pushRecord(ctx, 'system', seq, at, `会话标题：${truncate(title, 120)}`, entry)
        break
      }
      case 'step/start':
      case 'step/end':
      case 'turn/end':
      case 'permission/preset':
      case 'sandbox/mode':
      case 'approval/policy':
      case 'session/end-seed':
      case 'subagent/descriptor':
      case 'session/title-llm-request': {
        pushRecord(ctx, 'meta', seq, at, '', entry)
        break
      }
      default: {
        pushRecord(ctx, 'other', seq, at, '', entry)
        break
      }
    }
  }
  return ctx.records
}

/** Decode one transcript file and normalise it. */
export function readTranscript(sessionFile: string): SessionTranscript {
  const buffer = fs.readFileSync(sessionFile)
  const stat = fs.statSync(sessionFile)
  const decoded = decodeZstdFrames(buffer)
  const text = decoded.text
  const lines = text.split('\n')
  const records = normalizeRecords(lines)
  const header = records.find((record) => record.kind === 'meta' && record.raw)
  const headerRaw = header?.raw as Record<string, unknown> | undefined
  const cwd = typeof headerRaw?.cwd === 'string' ? headerRaw.cwd : undefined
  return {
    sessionFile,
    sessionId:
      typeof headerRaw?.id === 'string' && headerRaw.id !== '' ? headerRaw.id : sessionIdFromPath(sessionFile),
    ...(cwd === undefined ? {} : { cwd }),
    records,
    bytes: Buffer.byteLength(text, 'utf8'),
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs,
  }
}

/** Records strictly after the cursor's processed count. */
export function pendingRecords(transcript: SessionTranscript, cursor?: SessionCursor): RawRecord[] {
  if (!cursor || cursor.processedRecords <= 0) return [...transcript.records]
  return transcript.records.filter((record) => record.seq > cursor.processedRecords)
}

/** Stable hash of a span, used as the incremental-dedupe key. */
export function spanHash(records: RawRecord[]): string {
  const material = records.map((record) => `${record.seq}:${record.kind}:${record.text}`).join('\u0000')
  return sha256(material)
}

function stampFor(record: RawRecord, fallbackMs: number): string {
  if (record.at === undefined) return beijingStamp(fallbackMs)
  const ms = Date.parse(record.at)
  return Number.isNaN(ms) ? beijingStamp(fallbackMs) : beijingStamp(ms)
}

/**
 * Render records as the line-oriented Chinese transcript handed to DeepSeek.
 *
 * ```
 * [3] 2025-10-30 16:45:12 用户：…
 * [5] 2025-10-30 16:45:31 我调用工具 bash：{"command":"ls"}
 * [6] 2025-10-30 16:45:32 工具结果 bash（失败）：…
 * ```
 */
export function renderRecords(
  records: RawRecord[],
  maxChars = 0,
  fallbackMs = Date.now(),
): { text: string; chars: number; truncated: boolean } {
  const lines: string[] = []
  let used = 0
  let truncated = false
  for (const record of records) {
    if (record.kind === 'other' || record.kind === 'meta') continue
    const stamp = stampFor(record, fallbackMs)
    let label: string
    let body = record.text
    switch (record.kind) {
      case 'user':
        label = '用户'
        break
      case 'assistant':
        label = '我'
        break
      case 'tool-call':
        label = `我调用工具${record.tool !== undefined ? ` ${record.tool}` : ''}`
        break
      case 'tool-result':
        label = `工具结果${record.tool !== undefined ? ` ${record.tool}` : ''}`
        break
      case 'compact':
        label = '上下文压缩'
        break
      case 'system':
        label = '系统'
        break
      default:
        label = record.kind
        break
    }
    if (record.kind === 'tool-result') {
      body = truncate(body, 1200)
    } else if (record.kind === 'tool-call') {
      body = truncate(body, 400)
    }
    const line = `[${record.seq}] ${stamp} ${label}：${body}`
    if (maxChars > 0 && used + line.length + 1 > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  const text = lines.join('\n')
  return { text, chars: text.length, truncated }
}
