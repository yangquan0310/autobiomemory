/**
 * AutoBioMemory — the write path.
 *
 * Turns raw session transcripts into first-person event diaries:
 * incremental read (by cursor, in place) → event segmentation → DeepSeek encoding →
 * paired JSON/MD storage → embedding into the local vector index → cursor advance.
 *
 * Crash safety: the cursor for one session only advances after the event pair (and, when
 * the embedding succeeded, its vector row) is durable. A failed unit is recorded in
 * `state/status.json` with exponential backoff so the next run resumes it instead of
 * losing it.
 */

import fs from 'node:fs'
import path from 'node:path'

import { DIRS, FILES } from './constants.js'
import { expandSessionDirs } from './config.js'
import { requireSecret, type SecretSource } from './env.js'
import { createEmbedder } from './embed.js'
import { createDistiller, sourceRefFor } from './distill.js'
import { createLogger } from './logger.js'
import { ensureDataLayout, memoryPaths, type MemoryPaths } from './paths.js'
import { listSessionFiles, pendingRecords, readTranscript } from './session-reader.js'
import {
  buildRecord,
  eventIdFor,
  listEventSummaries,
  readEvent,
  writeEventPair,
} from './store.js'
import {
  clearFailure,
  clearSkipped,
  failureAttempts,
  failureKey,
  getSessionCursor,
  isCoolingDown,
  isSkipped,
  loadCursor,
  loadRunState,
  notYetDueFailures,
  putSessionCursor,
  recordFailure,
  recordSkipped,
  saveCursor,
  saveRunState,
} from './state.js'
import { buildUnits, unitOptionsFromConfig, type UnitOptions } from './units.js'
import { VectorStore, missingEventIds, staleEventIds, vectorNorm } from './vectors.js'
import { nowIso, readJsonFile, writeJsonFile, sha256, truncate } from './util.js'
import type {
  ConsolidationResult,
  Distiller,
  Embedder,
  EventUnit,
  Logger,
  MemoryConfig,
  SessionCursor,
  SessionTranscript,
} from './types.js'

/** Sidecar that remembers which spans were already encoded, per raw transcript. */
interface SpanState {
  version: number
  /** sessionFile → content hashes of emitted spans. */
  spans: Record<string, string[]>
}

export interface ConsolidateDeps {
  paths?: MemoryPaths
  config: MemoryConfig
  secrets: SecretSource
  logger?: Logger
  distiller?: Distiller
  embedder?: Embedder
  /** Session file the trigger pointed at; it is consolidated first. */
  currentSessionFile?: string
  /** Skip the cooldown for explicit CLI / tool invocations. */
  force?: boolean
  signal?: AbortSignal
  dryRun?: boolean
  now?: () => number
}

function spansFile(paths: MemoryPaths): string {
  return path.join(paths.stateDir, 'spans.json')
}

function loadSpans(paths: MemoryPaths): SpanState {
  const state = readJsonFile<SpanState>(spansFile(paths))
  if (state && typeof state === 'object' && state.spans) return state
  return { version: 1, spans: {} }
}

function saveSpans(paths: MemoryPaths, state: SpanState): void {
  ensureDataLayout(paths)
  writeJsonFile(spansFile(paths), state)
}

function rememberSpan(state: SpanState, sessionFile: string, hash: string): void {
  const list = state.spans[sessionFile] ?? []
  if (!list.includes(hash)) list.push(hash)
  state.spans[sessionFile] = list.slice(-500)
}

function knownSpanHashes(state: SpanState, sessionFile: string): Set<string> {
  return new Set(state.spans[sessionFile] ?? [])
}

function orderByRecency(files: string[]): string[] {
  const stat = (file: string): number => {
    try {
      return fs.statSync(file).mtimeMs
    } catch {
      return 0
    }
  }
  return [...files].sort((a, b) => stat(b) - stat(a))
}

function sessionLabel(sessionFile: string): string {
  return truncate(path.basename(path.dirname(sessionFile)), 42) || path.basename(sessionFile)
}

function summarizeUnit(unit: EventUnit): string {
  const span = `${sessionLabel(unit.sessionFile)} seq ${unit.fromSeq}-${unit.toSeq}`
  return `${span} · ${unit.records.length} 条记录 · ${unit.chars} 字`
}

function cursorFor(
  transcript: SessionTranscript,
  unit: EventUnit,
  previous: SessionCursor | undefined,
): SessionCursor {
  const last = unit.records[unit.records.length - 1]
  return {
    sessionFile: transcript.sessionFile,
    sessionId: transcript.sessionId,
    processedRecords: unit.toSeq,
    byteOffset: transcript.bytes,
    fileSize: transcript.fileSize,
    fileMtimeMs: transcript.fileMtimeMs,
    lastRecordHash: last ? sha256(last.text) : (previous?.lastRecordHash ?? ''),
    lastSpanHash: unit.contentHash,
    updatedAt: nowIso(),
  }
}

/** Embed one diary and upsert its vector row; returns `true` when the index is fresh. */
async function indexDiary(
  deps: Required<Pick<ConsolidateDeps, 'config' | 'paths'>> & {
    embedder: Embedder
    store: VectorStore
    logger: Logger
  },
  eventId: string,
  diary: string,
): Promise<boolean> {
  const textHash = sha256(diary)
  const [vector] = await deps.embedder.embed([diary])
  if (!vector || vector.length === 0) throw new Error('embedding returned no vector')
  if (vector.length !== deps.config.dashscope.embeddingDimensions) {
    throw new Error(
      `embedding dimension ${vector.length} != config ${deps.config.dashscope.embeddingDimensions}`,
    )
  }
  deps.store.upsert([
    {
      eventId,
      model: deps.embedder.model,
      dimensions: vector.length,
      textHash,
      vector,
      norm: vectorNorm(vector),
      updatedAt: nowIso(),
    },
  ])
  deps.logger.debug(`indexed ${eventId} (${vector.length}d, ${textHash.slice(0, 8)})`)
  return true
}

/**
 * Run one consolidation pass.
 *
 * Never throws for per-session or per-event problems: they are recorded as failures and the
 * run continues. Throws only when the data root cannot be prepared or no API key is available.
 */
export async function consolidate(input: ConsolidateDeps): Promise<ConsolidationResult> {
  const startedAt = nowIso()
  const logger = input.logger ?? createLogger({ scope: 'consolidate' })
  const config = input.config
  const paths = input.paths ?? memoryPaths(config.dataRoot)
  const options: UnitOptions = unitOptionsFromConfig(config)

  const result: ConsolidationResult = {
    startedAt,
    finishedAt: startedAt,
    sessionsScanned: 0,
    unitsFound: 0,
    eventsWritten: 0,
    eventsSkipped: 0,
    eventsFailed: 0,
    embedded: 0,
    embedFailed: 0,
    details: [],
  }
  const finish = (patch: Partial<ConsolidationResult> = {}): ConsolidationResult => {
    Object.assign(result, patch)
    result.finishedAt = nowIso()
    return result
  }

  ensureDataLayout(paths)

  const runState = loadRunState(paths)
  // Both knobs are real: the per-run cooldown and the global trigger cooldown. Whichever is
  // larger wins, so an automatic trigger can never run more often than either says.
  const cooldownMs = Math.max(
    config.consolidation.cooldownMs,
    config.trigger?.globalCooldownMs ?? 0,
  )
  if (!input.force && isCoolingDown(runState, cooldownMs)) {
    logger.debug(`consolidation skipped: cooldown active (${cooldownMs}ms)`)
    return finish({ aborted: 'cooldown' })
  }

  const dirs = expandSessionDirs(config, process.cwd())
  if (dirs.length === 0) return finish({ aborted: 'no-session-dirs' })

  let distiller = input.distiller
  let embedder = input.embedder
  if (!input.dryRun) {
    try {
      distiller ??= createDistiller({
        config,
        apiKey: requireSecret(input.secrets, 'deepseek'),
        logger,
      })
      embedder ??= createEmbedder(config.dashscope, requireSecret(input.secrets, 'dashscope'), logger)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`consolidation disabled: ${message}`)
      return finish({ aborted: `missing-secret`, details: [message] })
    }
  }

  const files = orderByRecency(
    listSessionFiles(dirs, config.session.includeGlobs, config.session.excludeGlobs),
  )
  const current = input.currentSessionFile ? path.resolve(input.currentSessionFile) : undefined
  if (current) {
    const index = files.findIndex((file) => path.resolve(file) === current)
    if (index > 0) {
      const [only] = files.splice(index, 1)
      if (only) files.unshift(only)
    } else if (index === -1 && fs.existsSync(current)) {
      files.unshift(current)
    }
  }

  const cursorState = loadCursor(paths)
  const spanState = loadSpans(paths)
  const store = input.dryRun ? undefined : new VectorStore(paths.vectorDb)
  // Only failures still *inside* their backoff window are skipped. A failure whose
  // `nextAttemptAt` has passed is due and must flow through the normal read → encode path again;
  // treating the due set as a skip list is what made expired failures retry forever-never, which
  // in turn kept `attempts` stuck at 1 and disabled the poison-span give-up below.
  const backingOff = new Map(
    notYetDueFailures(runState)
      .filter((entry) => entry.kind === 'consolidate')
      .map((entry) => [entry.target, entry] as const),
  )
  /**
   * Forget a session's consolidation failure once this run got through it without a new one, so
   * the entry (and its `attempts`, which feeds the poison-span threshold) stops lingering.
   */
  const leaveBackoff = (target: string): void => {
    if (runState.failures[failureKey('consolidate', target)] === undefined) return
    clearFailure(runState, 'consolidate', target)
    if (!input.dryRun) saveRunState(paths, runState)
  }
  /** Events whose embedding was already attempted in this run (success or not). */
  const attemptedEmbed = new Set<string>()
  let budget = Math.max(1, config.consolidation.maxEventsPerRun)
  let caughtUpSessions = 0

  try {
    for (const file of files) {
      if (input.signal?.aborted) {
        result.aborted = 'aborted'
        break
      }
      if (budget <= 0) break

      result.sessionsScanned += 1
      const backoff = backingOff.get(file)
      if (backoff !== undefined && !input.force) {
        result.details.push(
          `跳过（失败退避中，${backoff.nextAttemptAt} 重试）：${sessionLabel(file)}`,
        )
        continue
      }
      // Whether this session failed again in *this* run: a retried session that made it through
      // leaves the failure queue, so `attempts` only ever counts consecutive failures.
      let failedThisSession = false

      let transcript: SessionTranscript
      try {
        transcript = readTranscript(file)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        recordFailure(runState, 'consolidate', file, error)
        failedThisSession = true
        result.eventsFailed += 1
        result.details.push(`读取失败：${sessionLabel(file)} — ${message}`)
        continue
      }
      if (transcript.records.length === 0) {
        // Nothing could have failed yet in this iteration: reading an empty transcript is a
        // successful retry, so the session leaves the backoff queue.
        leaveBackoff(file)
        continue
      }

      let previous = getSessionCursor(cursorState, transcript.sessionFile)
      if (previous && transcript.fileSize < previous.fileSize) {
        // The transcript was rotated or rewritten: start over for this file.
        result.details.push(`检测到会话被重写，游标重置：${sessionLabel(file)}`)
        previous = undefined
      }

      const pending = pendingRecords(transcript, previous)
      if (pending.length === 0) {
        caughtUpSessions += 1
        leaveBackoff(file)
        continue
      }

      const known = knownSpanHashes(spanState, transcript.sessionFile)
      const units = buildUnits(transcript, options, previous).filter((unit) => {
        if (isSkipped(runState, transcript.sessionFile, unit.contentHash)) {
          result.details.push(`跳过已放弃的片段：${summarizeUnit(unit)}`)
          return false
        }
        return !known.has(unit.contentHash)
      })
      result.unitsFound += units.length

      for (const unit of units) {
        if (input.signal?.aborted) {
          result.aborted = 'aborted'
          break
        }
        if (budget <= 0) break

        const eventId = eventIdFor(unit.startedAt, unit.contentHash)
        const existing = input.dryRun ? undefined : readEvent(paths, eventId)
        if (existing && existing.structured.sources.some((ref) => ref.contentHash === unit.contentHash)) {
          result.eventsSkipped += 1
          rememberSpan(spanState, transcript.sessionFile, unit.contentHash)
          const advanced = cursorFor(transcript, unit, previous)
          putSessionCursor(cursorState, advanced)
          saveCursor(paths, cursorState)
          continue
        }

        if (input.dryRun) {
          result.eventsWritten += 1
          result.details.push(`[dry-run] 将编码事件 ${eventId}：${summarizeUnit(unit)}`)
          rememberSpan(spanState, transcript.sessionFile, unit.contentHash)
          putSessionCursor(cursorState, cursorFor(transcript, unit, previous))
          budget -= 1
          continue
        }

        let encoded
        try {
          if (!distiller) throw new Error('缺少编码器（请检查 DeepSeek 密钥与配置）')
          encoded = await distiller.encode(unit)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const failure = recordFailure(runState, 'consolidate', file, error)
          failedThisSession = true
          result.eventsFailed += 1
          result.details.push(`编码失败：${summarizeUnit(unit)} — ${message}`)

          const maxAttempts = Math.max(1, config.consolidation.maxSpanAttempts)
          if (failure.attempts >= maxAttempts) {
            // Poison span: give up on this one span only, record it, and step the cursor
            // past it so the rest of the session keeps flowing. `--retry-skipped` undoes it.
            recordSkipped(runState, {
              sessionFile: transcript.sessionFile,
              spanHash: unit.contentHash,
              fromSeq: unit.fromSeq,
              toSeq: unit.toSeq,
              attempts: failure.attempts,
              reason: message.slice(0, 400),
            })
            rememberSpan(spanState, transcript.sessionFile, unit.contentHash)
            putSessionCursor(cursorState, cursorFor(transcript, unit, previous))
            saveCursor(paths, cursorState)
            saveSpans(paths, spanState)
            clearFailure(runState, 'consolidate', file)
            saveRunState(paths, runState)
            result.details.push(
              `放弃片段（连续失败 ${failure.attempts} 次，游标前进）：${summarizeUnit(unit)} — ${message}`,
            )
            logger.warn(
              `放弃片段 ${summarizeUnit(unit)}（连续失败 ${failure.attempts} 次），游标继续前进`,
            )
            continue
          }

          saveRunState(paths, runState)
          // Budgeted retry: the next run retries the same span, cursor stays put.
          break
        }

        budget -= 1

        // Provenance is ours: never trust (or lose) what the encoder said about sources.
        const sources = encoded.structured.sources ?? []
        if (sources.length === 0 || sources.some((ref) => ref.contentHash !== unit.contentHash)) {
          encoded.structured.sources = [sourceRefFor(unit)]
        }
        const revision = existing ? existing.revision + 1 : 1
        const record = buildRecord(encoded, { id: eventId, revision })
        try {
          writeEventPair(paths, record)
          result.eventsWritten += 1
          result.details.push(`写入事件 ${eventId}：${truncate(record.structured.title, 40)}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          recordFailure(runState, 'store', eventId, error)
          failedThisSession = true
          result.eventsFailed += 1
          result.details.push(`存储失败：${eventId} — ${message}`)
          saveRunState(paths, runState)
          break
        }

        // Embedding is best-effort: a failure leaves the event on disk and the vector
        // index behind, which the stale-vector sweep below repairs on a later run.
        if (embedder && store) {
          attemptedEmbed.add(eventId)
          try {
            await indexDiary({ config, paths, embedder, store, logger }, eventId, record.diary)
            result.embedded += 1
            clearFailure(runState, 'embed', eventId)
            const withVector = {
              ...record,
              embedding: {
                model: embedder.model,
                dimensions: config.dashscope.embeddingDimensions,
                textHash: record.diaryHash,
                updatedAt: nowIso(),
              },
            }
            writeJsonFile(path.join(paths.eventsDir, `${eventId}.json`), withVector)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            recordFailure(runState, 'embed', eventId, error)
            result.embedFailed += 1
            result.details.push(`向量失败：${eventId} — ${message}`)
          }
        }

        rememberSpan(spanState, transcript.sessionFile, unit.contentHash)
        putSessionCursor(cursorState, cursorFor(transcript, unit, previous))
        saveCursor(paths, cursorState)
        saveSpans(paths, spanState)
        clearFailure(runState, 'consolidate', file)
        saveRunState(paths, runState)
      }

      if (units.length === 0 && pending.length > options.tailRecords) {
        // Nothing worth encoding yet: walk the cursor over the noise so the file stops
        // being rescanned from zero on every run.
        const lastConsumed = pending[pending.length - 1 - options.tailRecords]
        if (lastConsumed && (!previous || lastConsumed.seq > previous.processedRecords)) {
          putSessionCursor(cursorState, {
            sessionFile: transcript.sessionFile,
            sessionId: transcript.sessionId,
            processedRecords: lastConsumed.seq,
            byteOffset: transcript.bytes,
            fileSize: transcript.fileSize,
            fileMtimeMs: transcript.fileMtimeMs,
            lastRecordHash: sha256(lastConsumed.text),
            lastSpanHash: previous?.lastSpanHash ?? '',
            updatedAt: nowIso(),
          })
          saveCursor(paths, cursorState)
        }
      }

      // The session was retried and nothing failed this run: it is no longer backing off.
      if (!failedThisSession) leaveBackoff(file)
    }

    // --- stale / missing vector sweep (failure continuation) ---
    if (store && embedder && !input.signal?.aborted) {
      const summaries = listEventSummaries(paths, { refresh: true })
      const stale = [
        ...new Set([...missingEventIds(store, summaries), ...staleEventIds(store, summaries)]),
      ]
      for (const eventId of stale.slice(0, config.consolidation.maxEventsPerRun)) {
        if (attemptedEmbed.has(eventId)) continue
        const record = readEvent(paths, eventId)
        if (!record) continue
        try {
          await indexDiary({ config, paths, embedder, store, logger }, eventId, record.diary)
          result.embedded += 1
          clearFailure(runState, 'embed', eventId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          recordFailure(runState, 'embed', eventId, error)
          result.embedFailed += 1
          result.details.push(`向量回填失败：${eventId} — ${message}`)
        }
      }
    }
  } finally {
    store?.close()
  }

  if (caughtUpSessions > 0) result.details.push(`已追平的会话：${caughtUpSessions}`)
  const skippedSpans = Object.keys(runState.skipped ?? {}).length
  if (skippedSpans > 0) result.details.push(`历史跳过片段：${skippedSpans}（consolidate --retry-skipped 可重试）`)
  if (input.dryRun) {
    // A dry run must leave no trace: no run timestamp, no totals, no cursor, no span memory.
    logger.info(`consolidation dry-run: ${result.eventsWritten} event(s) would be written`)
    return finish()
  }
  runState.lastRunAt = nowIso()
  runState.totals.runs += 1
  runState.totals.events += result.eventsWritten
  runState.totals.embedded += result.embedded
  runState.lastRunResult = finish()
  saveRunState(paths, runState)
  logger.info(
    `consolidation done: ${result.eventsWritten} written, ${result.embedded} embedded, ` +
      `${result.eventsSkipped} skipped, ${result.eventsFailed + result.embedFailed} failed`,
  )
  return runState.lastRunResult ?? result
}

/** Convenience wrapper used by the plugin/tool: do not run twice concurrently. */
let inFlight: Promise<ConsolidationResult> | undefined

export function consolidateOnce(input: ConsolidateDeps): Promise<ConsolidationResult> {
  const serialize = input.config.consolidation.serialize !== false
  if (serialize && inFlight) return inFlight
  inFlight = consolidate(input).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

export function isConsolidating(): boolean {
  return inFlight !== undefined
}

/** Forget skipped spans so they are attempted again (`consolidate --retry-skipped`). */
export function retrySkippedSpans(
  paths: Parameters<typeof loadRunState>[0],
  sessionFile?: string,
): number {
  const runState = loadRunState(paths)
  const doomed = Object.values(runState.skipped ?? {}).filter(
    (span) => sessionFile === undefined || span.sessionFile === sessionFile,
  )
  if (doomed.length === 0) return 0

  // Forget both the skip mark AND the span memory, otherwise the dedupe layer would
  // still filter the span out before the encoder ever sees it.
  const spans = loadSpans(paths)
  for (const span of doomed) {
    const list = spans.spans[span.sessionFile]
    if (list) spans.spans[span.sessionFile] = list.filter((hash) => hash !== span.spanHash)
  }
  saveSpans(paths, spans)

  // Rewind each affected session's cursor to just before its earliest skipped span, so the
  // retry can actually reach it without hand-editing state/cursor.json.
  const cursors = loadCursor(paths)
  const rewind = new Map<string, number>()
  for (const span of doomed) {
    const current = rewind.get(span.sessionFile)
    const target = Math.max(0, span.fromSeq - 1)
    rewind.set(span.sessionFile, current === undefined ? target : Math.min(current, target))
  }
  for (const [file, processed] of rewind) {
    const cursor = cursors.sessions[file]
    if (cursor && cursor.processedRecords > processed) {
      cursors.sessions[file] = { ...cursor, processedRecords: processed, updatedAt: nowIso() }
    }
  }
  saveCursor(paths, cursors)

  const cleared = clearSkipped(runState, sessionFile)
  for (const key of Object.keys(runState.failures)) {
    if (runState.failures[key]?.kind === 'consolidate') delete runState.failures[key]
  }
  saveRunState(paths, runState)
  return cleared
}

/** Names of the sub-directories the write path owns (for `doctor`). */
export const CONSOLIDATION_DIRS = [DIRS.events, DIRS.vectors, DIRS.state, DIRS.logs]
export const CONSOLIDATION_FILES = [FILES.cursor, FILES.runState, FILES.vectorDb]
