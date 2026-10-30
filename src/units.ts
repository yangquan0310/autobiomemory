/**
 * AutoBioMemory — event segmentation.
 *
 * A "relatively complete event" starts when the user (or the world) hands me something to do and
 * ends before the next such hand-over. Tool call/result pairs are never split, and the tail of a
 * transcript is held back for the next pass so an in-flight turn is not encoded half-written.
 */

import { pendingRecords, spanHash } from './session-reader.js'
import { beijingIso, truncate } from './util.js'
import type { EventUnit, MemoryConfig, RawRecord, SessionCursor, SessionTranscript } from './types.js'

export interface UnitOptions {
  minRecordsPerEvent: number
  maxRecordsPerEvent: number
  maxInputChars: number
  minEventChars: number
  tailRecords: number
}

export function unitOptionsFromConfig(config: MemoryConfig): UnitOptions {
  return {
    minRecordsPerEvent: Math.max(1, config.session.minRecordsPerEvent),
    maxRecordsPerEvent: Math.max(1, config.session.maxRecordsPerEvent),
    maxInputChars: Math.max(1000, config.consolidation.maxInputChars),
    minEventChars: Math.max(0, config.consolidation.minEventChars),
    tailRecords: Math.max(0, config.session.tailRecords),
  }
}

/** Char cost of one record as the encoder will see it. */
function recordCost(record: RawRecord): number {
  if (record.kind === 'tool-result') return Math.min(record.text.length, 1200) + 24
  if (record.kind === 'tool-call') return Math.min(record.text.length, 400) + 24
  return record.text.length + 24
}

const CONVERSATIONAL: ReadonlySet<RawRecord['kind']> = new Set<RawRecord['kind']>([
  'user',
  'assistant',
  'tool-call',
  'tool-result',
  'compact',
  'system',
])

function timeOf(record: RawRecord, fallbackMs: number): number {
  if (record.at === undefined) return fallbackMs
  const ms = Date.parse(record.at)
  return Number.isNaN(ms) ? fallbackMs : ms
}

/**
 * Split the not-yet-processed part of a transcript into event units.
 *
 * Rules:
 * - only records after `cursor.processedRecords` are considered;
 * - a unit opens at a `user` record;
 * - a `tool-call` is never separated from its `tool-result` (the pair moves together);
 * - a unit closes before the next `user` record, or when the next record would exceed
 *   `maxRecordsPerEvent` / `maxInputChars` (soft: the closing record is kept, so the
 *   character budget may overshoot by one record);
 * - the last `tailRecords` records stay unprocessed;
 * - units below `minRecordsPerEvent` records or `minEventChars` characters are dropped.
 */
export function buildUnits(
  transcript: SessionTranscript,
  options: UnitOptions,
  cursor?: SessionCursor,
): EventUnit[] {
  const pending = pendingRecords(transcript, cursor)
  if (pending.length === 0) return []
  const usable = options.tailRecords > 0 ? pending.slice(0, Math.max(0, pending.length - options.tailRecords)) : pending
  if (usable.length === 0) return []

  const fallbackMs = transcript.fileMtimeMs || Date.now()
  const units: EventUnit[] = []
  let start = -1
  let records: RawRecord[] = []
  let chars = 0

  const flush = () => {
    if (start < 0 || records.length === 0) {
      start = -1
      records = []
      chars = 0
      return
    }
    const first = records[0] as RawRecord
    const last = records[records.length - 1] as RawRecord
    const recordCount = records.length
    if (recordCount >= options.minRecordsPerEvent && chars >= options.minEventChars) {
      units.push({
        sessionFile: transcript.sessionFile,
        sessionId: transcript.sessionId,
        records: [...records],
        fromSeq: first.seq,
        toSeq: last.seq,
        turns: [...new Set(records.map((record) => record.turn))],
        startedAt: beijingIso(timeOf(first, fallbackMs - 1000)),
        endedAt: beijingIso(timeOf(last, fallbackMs)),
        contentHash: spanHash(records),
        truncated: chars > options.maxInputChars,
        chars,
      })
    }
    start = -1
    records = []
    chars = 0
  }

  for (let index = 0; index < usable.length; index += 1) {
    const record = usable[index] as RawRecord
    if (!CONVERSATIONAL.has(record.kind)) continue

    if (record.kind === 'user' && start >= 0) {
      // a new hand-over closes the previous unit
      flush()
    }
    if (start < 0) {
      start = index
      records = []
      chars = 0
    }

    const cost = recordCost(record)
    const wouldOverflow =
      records.length > 0 &&
      (records.length + 1 > options.maxRecordsPerEvent || chars + cost > options.maxInputChars)

    if (wouldOverflow && record.kind !== 'tool-result') {
      // keep call/result pairs together: only close here when this record is not a result
      flush()
      start = index
      records = []
      chars = 0
    }

    records.push(record)
    chars += cost
  }
  flush()

  return units
}

/** Short human label for logs. */
export function describeUnit(unit: EventUnit): string {
  const firstUser = unit.records.find((record) => record.kind === 'user')
  const lead = firstUser === undefined ? '' : truncate(firstUser.text, 40)
  return `${unit.fromSeq}-${unit.toSeq} (${unit.records.length} 条, ${unit.chars} 字)${lead === '' ? '' : ` · ${lead}`}`
}
