/**
 * AutoBioMemory — paired JSON/MD event storage.
 *
 * Every event lives as two files under `<root>/events/`:
 *
 * - `<id>.json` — the full `EventRecord` (structured event + diary + hash).
 * - `<id>.md`   — exactly the diary body, plus one trailing newline.
 *
 * `state/events-index.json` caches one `EventSummary` per pair so list/recall
 * calls do not have to parse every JSON. The index is derived data: whenever it
 * is missing, stale, or explicitly refreshed, the events directory is rescanned
 * and reconciled. Broken pairs are reported through `EventSummary.problem` and
 * fixed by `repairPairs`, which also quarantines files it cannot understand.
 *
 * The module takes `MemoryPaths` as an argument everywhere (it never imports
 * `paths.ts`), so it is trivially testable with temporary roots.
 */

import fs from 'node:fs'
import path from 'node:path'

import { SCHEMA_VERSION } from './constants.js'
import type { EncodedEvent, EventRecord, EventStatus, EventSummary, MemoryPaths } from './types.js'
import * as util from './util.js'

export type { EventSummary } from './types.js'

/** Version of the `state/events-index.json` shape. */
const INDEX_VERSION = 1

/** Character budget for the rendered short-term memory block. */
const SHORT_TERM_BUDGET = 20_000

/** Sub-directory of `events/` that holds files we could not use. */
const QUARANTINE_DIR = '_quarantine'

/** Separator between two rendered events. */
const BLOCK_SEPARATOR = '\n---\n'

/** Heading of the rendered short-term memory block. */
const SHORT_TERM_HEADING = '## 短时记忆'

/** Event ids are used as file names, so keep them to a conservative alphabet. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/u

const EVENT_STATUSES: readonly string[] = ['completed', 'partial', 'failed', 'ongoing', 'planned']

const PROBLEM_LABELS: Record<NonNullable<EventSummary['problem']>, string> = {
  'missing-md': '缺少日记正文',
  'missing-json': '缺少结构化 JSON',
  'hash-mismatch': '日记哈希不一致',
  'unreadable-json': 'JSON 无法解析',
}

interface PairFiles {
  jsonFile: string
  mdFile: string
}

/** On-disk shape of `state/events-index.json`. */
interface EventIndex {
  version: number
  updatedAt: string
  events: Record<string, EventSummary>
}

type JsonOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function pairFiles(paths: MemoryPaths, id: string): PairFiles {
  return {
    jsonFile: path.join(paths.eventsDir, `${id}.json`),
    mdFile: path.join(paths.eventsDir, `${id}.md`),
  }
}

function isSafeEventId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id !== '.' &&
    id !== '..' &&
    EVENT_ID_PATTERN.test(id)
  )
}

function assertEventId(id: string): void {
  if (!isSafeEventId(id)) {
    throw new Error(`invalid event id: ${JSON.stringify(id)}`)
  }
}

function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** Distinguishes a missing JSON file from one that exists but does not parse. */
function readJsonOutcome(file: string): JsonOutcome {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  try {
    const value: unknown = JSON.parse(text)
    return { kind: 'ok', value }
  } catch {
    return { kind: 'unreadable' }
  }
}

function readEventsDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asStatus(value: unknown): EventStatus {
  return typeof value === 'string' && EVENT_STATUSES.includes(value)
    ? (value as EventStatus)
    : 'ongoing'
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asProblem(value: unknown): EventSummary['problem'] | undefined {
  return value === 'missing-md' ||
    value === 'missing-json' ||
    value === 'hash-mismatch' ||
    value === 'unreadable-json'
    ? value
    : undefined
}

function isEventRecordLike(value: unknown): value is Record<string, unknown> {
  return util.isRecord(value) && typeof value.diary === 'string'
}

/**
 * The `.md` half is `diary + "\n"` (a single trailing newline). The digest used
 * for pairing checks therefore ignores exactly that one newline; the raw text
 * is accepted as well so a hand-written file with no trailing newline still
 * validates.
 */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

function diaryBodyDigest(mdText: string): string {
  return util.sha256(stripOneTrailingNewline(mdText))
}

function hashMatchesDiary(mdText: string, diaryHash: string): boolean {
  if (diaryHash === '') return false
  return diaryBodyDigest(mdText) === diaryHash || util.sha256(mdText) === diaryHash
}

function mdTextFor(diary: string): string {
  return diary.endsWith('\n') ? diary : `${diary}\n`
}

/** Canonical diary body: no trailing newlines (`buildRecord` normalises). */
function normalizeDiary(diary: string): string {
  return diary.replace(/(?:\r?\n)+$/u, '')
}

function occurredMs(summary: EventSummary): number {
  return util.parseIso(summary.occurredAt) ?? 0
}

function sortSummaries(summaries: EventSummary[]): EventSummary[] {
  return [...summaries].sort((left, right) => {
    const delta = occurredMs(right) - occurredMs(left)
    if (delta !== 0) return delta
    if (left.id === right.id) return 0
    return left.id < right.id ? 1 : -1
  })
}

function asPeopleNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (util.isRecord(entry) ? asText(entry.name) : asText(entry)))
    .filter((name) => name !== '')
}

/* ------------------------------------------------------------------ *
 * Index rows
 * ------------------------------------------------------------------ */

function emptySummary(id: string, files: PairFiles): EventSummary {
  return {
    id,
    title: '',
    occurredAt: '',
    endedAt: '',
    status: 'ongoing',
    tags: [],
    people: [],
    keywords: [],
    entities: [],
    diaryHash: '',
    diaryChars: 0,
    revision: 1,
    jsonFile: files.jsonFile,
    mdFile: files.mdFile,
    updatedAt: '',
  }
}

/** Build a summary from a parsed `<id>.json` record (tolerates missing fields). */
function summaryFromEventValue(id: string, value: unknown, files: PairFiles): EventSummary {
  const summary = emptySummary(id, files)
  if (!util.isRecord(value)) return summary
  const structured = util.isRecord(value.structured) ? value.structured : {}
  const scene = util.isRecord(structured.scene) ? structured.scene : {}
  const outcome = util.isRecord(structured.outcome) ? structured.outcome : {}
  const project = asText(scene.project)
  const diary = asText(value.diary)
  const diaryHash = asText(value.diaryHash)
  summary.title = asText(structured.title)
  summary.occurredAt = asText(structured.startedAt)
  summary.endedAt = asText(structured.endedAt)
  summary.status = asStatus(outcome.status)
  summary.tags = util.asStringArray(structured.tags)
  summary.people = asPeopleNames(structured.people)
  summary.keywords = util.asStringArray(structured.keywords)
  summary.entities = util.asStringArray(structured.entities)
  if (project !== '') summary.project = project
  summary.diaryHash = diaryHash !== '' ? diaryHash : util.sha256(diary)
  summary.diaryChars = diary.length
  summary.revision = asNumber(value.revision, 1)
  summary.updatedAt = asText(value.updatedAt)
  return summary
}

/** Build a summary from an index entry (already summary-shaped). */
function coerceIndexSummary(
  id: string,
  value: Record<string, unknown>,
  files: PairFiles,
): EventSummary {
  const summary = emptySummary(id, files)
  const project = asText(value.project)
  const problem = asProblem(value.problem)
  summary.title = asText(value.title)
  summary.occurredAt = asText(value.occurredAt)
  summary.endedAt = asText(value.endedAt)
  summary.status = asStatus(value.status)
  summary.tags = util.asStringArray(value.tags)
  summary.people = util.asStringArray(value.people)
  summary.keywords = util.asStringArray(value.keywords)
  summary.entities = util.asStringArray(value.entities)
  if (project !== '') summary.project = project
  summary.diaryHash = asText(value.diaryHash)
  summary.diaryChars = asNumber(value.diaryChars, 0)
  summary.revision = asNumber(value.revision, 1)
  summary.jsonFile = asText(value.jsonFile, files.jsonFile)
  summary.mdFile = asText(value.mdFile, files.mdFile)
  summary.updatedAt = asText(value.updatedAt)
  if (problem !== undefined) summary.problem = problem
  return summary
}

/** Overwrite the diary-derived fields from the `.md` actually on disk. */
function applyDiaryText(summary: EventSummary, mdText: string): void {
  summary.diaryHash = diaryBodyDigest(mdText)
  summary.diaryChars = stripOneTrailingNewline(mdText).length
}

/* ------------------------------------------------------------------ *
 * Index persistence
 * ------------------------------------------------------------------ */

function loadEventIndex(paths: MemoryPaths): EventIndex | undefined {
  const raw = util.readJsonFile<unknown>(paths.eventIndexFile)
  if (!util.isRecord(raw)) return undefined
  if (raw.version !== INDEX_VERSION) return undefined
  if (!util.isRecord(raw.events)) return undefined
  const events: Record<string, EventSummary> = {}
  for (const [id, value] of Object.entries(raw.events)) {
    if (!isSafeEventId(id) || !util.isRecord(value)) return undefined
    events[id] = coerceIndexSummary(id, value, pairFiles(paths, id))
  }
  return { version: INDEX_VERSION, updatedAt: asText(raw.updatedAt), events }
}

function persistEventIndex(paths: MemoryPaths, summaries: EventSummary[]): void {
  const events: Record<string, EventSummary> = {}
  for (const summary of summaries) events[summary.id] = summary
  const index: EventIndex = { version: INDEX_VERSION, updatedAt: util.nowIso(), events }
  util.writeJsonFile(paths.eventIndexFile, index)
}

/** The index is derived data; a failed index write must never fail a write. */
function persistEventIndexQuietly(paths: MemoryPaths, summaries: EventSummary[]): void {
  try {
    persistEventIndex(paths, summaries)
  } catch {
    /* a later `listEventSummaries({ refresh: true })` rebuilds it */
  }
}

/** Fold one freshly written record into the index, keeping other entries. */
function updateIndexWith(paths: MemoryPaths, record: EventRecord): void {
  const index: EventIndex = loadEventIndex(paths) ?? {
    version: INDEX_VERSION,
    updatedAt: util.nowIso(),
    events: {},
  }
  index.events[record.id] = summaryFromEventValue(
    record.id,
    record,
    pairFiles(paths, record.id),
  )
  index.updatedAt = util.nowIso()
  util.writeJsonFile(paths.eventIndexFile, index)
}

/* ------------------------------------------------------------------ *
 * Public API — paths, reads
 * ------------------------------------------------------------------ */

/** Absolute path of the derived event index. */
export function eventIndexPath(paths: MemoryPaths): string {
  return paths.eventIndexFile
}

/** Full record for one event, or `undefined` when the JSON is absent/unusable. */
export function readEvent(paths: MemoryPaths, id: string): EventRecord | undefined {
  if (!isSafeEventId(id)) return undefined
  const outcome = readJsonOutcome(pairFiles(paths, id).jsonFile)
  if (outcome.kind !== 'ok' || !isEventRecordLike(outcome.value)) return undefined
  return outcome.value as unknown as EventRecord
}

/** Diary body for one event, or `undefined` when `<id>.md` is absent. */
export function readDiary(paths: MemoryPaths, id: string): string | undefined {
  if (!isSafeEventId(id)) return undefined
  const text = readTextFile(pairFiles(paths, id).mdFile)
  if (text === undefined) return undefined
  return stripOneTrailingNewline(text)
}

/* ------------------------------------------------------------------ *
 * Public API — writes
 * ------------------------------------------------------------------ */

/**
 * Write one JSON/MD pair atomically and fold it into the index.
 *
 * The JSON is written first, then the MD. If the MD write fails the JSON is
 * rolled back (restored when a previous version existed, removed otherwise), so
 * a failed call never leaves a half-written pair behind.
 */
export function writeEventPair(
  paths: MemoryPaths,
  record: EventRecord,
): { jsonFile: string; mdFile: string; created: boolean } {
  assertEventId(record.id)
  const expected = util.sha256(record.diary)
  if (typeof record.diaryHash !== 'string' || record.diaryHash !== expected) {
    throw new Error(
      `diary hash mismatch for ${record.id}: expected ${expected}, got ${String(record.diaryHash)}`,
    )
  }
  const files = pairFiles(paths, record.id)
  util.ensureDir(paths.eventsDir)
  const existed = fs.existsSync(files.jsonFile) || fs.existsSync(files.mdFile)
  const previousJson = fs.existsSync(files.jsonFile) ? readTextFile(files.jsonFile) : undefined
  util.writeJsonFile(files.jsonFile, record)
  try {
    util.writeTextFileAtomic(files.mdFile, mdTextFor(record.diary))
  } catch (error) {
    if (previousJson !== undefined) {
      util.writeTextFileAtomic(files.jsonFile, previousJson)
    } else {
      fs.rmSync(files.jsonFile, { force: true })
    }
    throw error
  }
  try {
    updateIndexWith(paths, record)
  } catch {
    /* derived data; the next refresh rescans the directory */
  }
  return { jsonFile: files.jsonFile, mdFile: files.mdFile, created: !existed }
}

/* ------------------------------------------------------------------ *
 * Public API — listing
 * ------------------------------------------------------------------ */

/** Rescan `events/` and describe every pair, flagging broken ones. */
function scanEventSummaries(paths: MemoryPaths): EventSummary[] {
  const jsonIds = new Set<string>()
  const mdIds = new Set<string>()
  for (const entry of readEventsDir(paths.eventsDir)) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (name.length === 0 || name.startsWith('.')) continue
    if (name.endsWith('.json')) jsonIds.add(name.slice(0, -'.json'.length))
    else if (name.endsWith('.md')) mdIds.add(name.slice(0, -'.md'.length))
  }
  const summaries: EventSummary[] = []
  const ids = new Set<string>([...jsonIds, ...mdIds])
  for (const id of ids) {
    const files = pairFiles(paths, id)
    const hasJson = jsonIds.has(id)
    const hasMd = mdIds.has(id)
    const mdText = hasMd ? readTextFile(files.mdFile) : undefined
    if (!hasJson) {
      const summary = emptySummary(id, files)
      if (mdText !== undefined) applyDiaryText(summary, mdText)
      summary.problem = 'missing-json'
      summaries.push(summary)
      continue
    }
    const outcome = readJsonOutcome(files.jsonFile)
    if (outcome.kind !== 'ok' || !isEventRecordLike(outcome.value)) {
      const summary = emptySummary(id, files)
      if (mdText !== undefined) applyDiaryText(summary, mdText)
      summary.problem = 'unreadable-json'
      summaries.push(summary)
      continue
    }
    const summary = summaryFromEventValue(id, outcome.value, files)
    if (mdText === undefined) {
      summary.problem = 'missing-md'
    } else if (!hashMatchesDiary(mdText, summary.diaryHash)) {
      summary.problem = 'hash-mismatch'
      applyDiaryText(summary, mdText)
    }
    summaries.push(summary)
  }
  return sortSummaries(summaries)
}

/**
 * Event summaries, newest `occurredAt` first.
 *
 * Without `refresh` the persisted index is trusted when present and readable;
 * with `refresh` (or a missing/corrupt index) the events directory is rescanned,
 * reconciled, persisted, and returned.
 */
export function listEventSummaries(
  paths: MemoryPaths,
  options: { refresh?: boolean } = {},
): EventSummary[] {
  if (options.refresh !== true) {
    const index = loadEventIndex(paths)
    if (index !== undefined) return sortSummaries(Object.values(index.events))
  }
  const summaries = scanEventSummaries(paths)
  persistEventIndexQuietly(paths, summaries)
  return summaries
}

/* ------------------------------------------------------------------ *
 * Public API — ids and records
 * ------------------------------------------------------------------ */

/** `ev_<YYYYMMDDTHHMMSS in Beijing time>_<8 hex>`; stable and filesystem-safe. */
export function eventIdFor(startedAt: string, contentHash: string): string {
  const ms = util.parseIso(startedAt) ?? 0
  return `ev_${util.beijingCompact(ms)}_${hashFragment(contentHash)}`
}

function hashFragment(contentHash: string): string {
  const hex = (typeof contentHash === 'string' ? contentHash : '')
    .toLowerCase()
    .replace(/[^0-9a-f]/gu, '')
  if (hex.length >= 8) return hex.slice(0, 8)
  return util.sha256(typeof contentHash === 'string' ? contentHash : '').slice(0, 8)
}

/**
 * Assemble a persisted record from an encoded event.
 *
 * The diary is normalised (trailing newlines removed) so the MD half is exactly
 * `diary + "\n"` and `sha256(diary)` is stable across a JSON/MD round-trip.
 */
export function buildRecord(
  encoded: EncodedEvent,
  options: { id: string; now?: string; revision?: number },
): EventRecord {
  assertEventId(options.id)
  const now = options.now ?? util.nowIso()
  const diary = normalizeDiary(encoded.diary)
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id,
    createdAt: now,
    updatedAt: now,
    structured: encoded.structured,
    diary,
    diaryHash: util.sha256(diary),
    revision: options.revision ?? 1,
  }
}

/* ------------------------------------------------------------------ *
 * Public API — short-term memory
 * ------------------------------------------------------------------ */

function describeBroken(summary: EventSummary): string {
  const label = summary.problem === undefined ? '无法读取' : PROBLEM_LABELS[summary.problem]
  return `${summary.id}（${label}）`
}

/**
 * The newest `limit` event summaries plus a Chinese block ready for prompt
 * injection. Broken pairs are skipped and called out; the rendered block is
 * capped at ~20k characters with an explicit truncation note.
 */
export function shortTermMemory(
  paths: MemoryPaths,
  limit: number,
): { summaries: EventSummary[]; text: string } {
  const summaries = listEventSummaries(paths, { refresh: true })
  const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const candidates = wanted > 0 ? summaries.slice(0, wanted) : []
  const included: EventSummary[] = []
  const broken: EventSummary[] = []
  const blocks: string[] = []
  let used = SHORT_TERM_HEADING.length
  let truncated = false
  for (const candidate of candidates) {
    if (candidate.problem !== undefined) {
      broken.push(candidate)
      continue
    }
    const diary = readDiary(paths, candidate.id)
    if (diary === undefined) {
      broken.push(candidate)
      continue
    }
    const heading = `### ${candidate.occurredAt} · ${candidate.title} · ${candidate.status}`
    const block = `${heading}\n${diary}`
    const separator = blocks.length === 0 ? 0 : BLOCK_SEPARATOR.length
    if (used + separator + block.length > SHORT_TERM_BUDGET) {
      truncated = true
      const headingRoom = used + separator + heading.length + 1
      const room = SHORT_TERM_BUDGET - headingRoom - 64 // keep room for the note
      if (blocks.length === 0 && room > 200) {
        const clipped = util.truncate(diary, room)
        blocks.push(`${heading}\n${clipped}`)
        included.push(candidate)
      }
      break
    }
    blocks.push(block)
    included.push(candidate)
    used += separator + block.length
  }
  const parts: string[] = [SHORT_TERM_HEADING]
  if (blocks.length > 0) parts.push(blocks.join(BLOCK_SEPARATOR))
  const notes: string[] = []
  if (broken.length > 0) {
    notes.push(
      `（已跳过 ${broken.length} 条配对异常事件：${broken.map(describeBroken).join('、')}）`,
    )
  }
  if (truncated) {
    notes.push(
      `（短时记忆已截断：超出 ${SHORT_TERM_BUDGET} 字符预算，仅保留最新 ${included.length} 条事件。）`,
    )
  }
  if (notes.length > 0) parts.push(notes.join('\n'))
  if (blocks.length === 0 && notes.length === 0) parts.push('（暂无事件记忆。）')
  return { summaries: included, text: parts.join('\n\n') }
}

/* ------------------------------------------------------------------ *
 * Public API — repair
 * ------------------------------------------------------------------ */

function quarantineFile(eventsDir: string, file: string, stamp: string): string {
  const dir = path.join(eventsDir, QUARANTINE_DIR)
  util.ensureDir(dir)
  const base = path.basename(file)
  let target = path.join(dir, `${base}.quarantined-${stamp}`)
  let counter = 1
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base}.quarantined-${stamp}-${counter}`)
    counter += 1
  }
  fs.renameSync(file, target)
  return target
}

/**
 * Make every pair internally consistent, idempotently.
 *
 * - missing `.md` → regenerated from the JSON `diary`;
 * - stale `diaryHash` → JSON rewritten with the recomputed hash;
 * - `.md` body that disagrees with the JSON → regenerated from the JSON;
 * - orphan `.md` files and unreadable JSON (plus their companions) → moved to
 *   `events/_quarantine/` with a `.quarantined-<timestamp>` suffix.
 */
export function repairPairs(paths: MemoryPaths): {
  repaired: string[]
  quarantined: string[]
  skipped: string[]
} {
  const repaired = new Set<string>()
  const quarantined = new Set<string>()
  const skipped = new Set<string>()
  const eventsDir = paths.eventsDir
  util.ensureDir(eventsDir)
  const jsonIds = new Set<string>()
  const mdIds = new Set<string>()
  for (const entry of readEventsDir(eventsDir)) {
    if (!entry.isFile()) continue
    const name = entry.name
    if (name.length === 0 || name.startsWith('.')) continue
    if (name.endsWith('.json')) jsonIds.add(name.slice(0, -'.json'.length))
    else if (name.endsWith('.md')) mdIds.add(name.slice(0, -'.md'.length))
  }
  const stamp = util.beijingCompact(Date.now())
  const ids = [...new Set<string>([...jsonIds, ...mdIds])].sort()
  for (const id of ids) {
    const files = pairFiles(paths, id)
    const hasJson = jsonIds.has(id)
    const hasMd = mdIds.has(id)
    if (!hasJson) {
      quarantineFile(eventsDir, files.mdFile, stamp)
      quarantined.add(id)
      continue
    }
    const outcome = readJsonOutcome(files.jsonFile)
    if (outcome.kind !== 'ok' || !isEventRecordLike(outcome.value)) {
      quarantineFile(eventsDir, files.jsonFile, stamp)
      if (hasMd) quarantineFile(eventsDir, files.mdFile, stamp)
      quarantined.add(id)
      continue
    }
    const raw = outcome.value
    const diary = typeof raw.diary === 'string' ? raw.diary : ''
    const expected = util.sha256(diary)
    let changed = false
    if (asText(raw.diaryHash) !== expected) {
      util.writeJsonFile(files.jsonFile, { ...raw, diaryHash: expected })
      changed = true
    }
    const mdText = hasMd ? readTextFile(files.mdFile) : undefined
    if (mdText === undefined) {
      util.writeTextFileAtomic(files.mdFile, mdTextFor(diary))
      changed = true
    } else if (!hashMatchesDiary(mdText, expected)) {
      util.writeTextFileAtomic(files.mdFile, mdTextFor(diary))
      changed = true
    }
    if (changed) repaired.add(id)
    else skipped.add(id)
  }
  persistEventIndexQuietly(paths, scanEventSummaries(paths))
  return {
    repaired: [...repaired].sort(),
    quarantined: [...quarantined].sort(),
    skipped: [...skipped].sort(),
  }
}
