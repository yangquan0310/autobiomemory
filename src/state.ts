/** AutoBioMemory — processing cursor and run state. */

import { STATE_VERSION } from './constants.js'
import { nowIso, readJsonFile, writeJsonFile } from './util.js'
import type {
  CursorState,
  FailureEntry,
  MemoryPaths,
  RunState,
  SessionCursor,
} from './types.js'

const MAX_RETRY_DELAY_MS = 30 * 60 * 1000

function emptyCursor(): CursorState {
  return { version: STATE_VERSION, sessions: {} }
}

function emptyRunState(): RunState {
  return { version: STATE_VERSION, failures: {}, totals: { events: 0, embedded: 0, runs: 0 } }
}

export function loadCursor(paths: MemoryPaths): CursorState {
  const state = readJsonFile<CursorState>(paths.cursorFile)
  if (!state || typeof state !== 'object' || typeof state.sessions !== 'object' || state.sessions === null) {
    return emptyCursor()
  }
  return { version: STATE_VERSION, sessions: { ...state.sessions } }
}

export function saveCursor(paths: MemoryPaths, state: CursorState): void {
  writeJsonFile(paths.cursorFile, { ...state, version: STATE_VERSION })
}

export function getSessionCursor(state: CursorState, sessionFile: string): SessionCursor | undefined {
  return state.sessions[sessionFile]
}

export function putSessionCursor(state: CursorState, cursor: SessionCursor): void {
  state.sessions[cursor.sessionFile] = cursor
}

export function loadRunState(paths: MemoryPaths): RunState {
  const state = readJsonFile<RunState>(paths.runStateFile)
  if (!state || typeof state !== 'object' || typeof state.failures !== 'object' || state.failures === null) {
    return emptyRunState()
  }
  return {
    version: STATE_VERSION,
    ...(typeof state.lastRunAt === 'string' ? { lastRunAt: state.lastRunAt } : {}),
    ...(state.lastRunResult ? { lastRunResult: state.lastRunResult } : {}),
    failures: { ...state.failures },
    totals: {
      events: Number(state.totals?.events ?? 0) || 0,
      embedded: Number(state.totals?.embedded ?? 0) || 0,
      runs: Number(state.totals?.runs ?? 0) || 0,
    },
  }
}

export function saveRunState(paths: MemoryPaths, state: RunState): void {
  writeJsonFile(paths.runStateFile, { ...state, version: STATE_VERSION })
}

export function failureKey(kind: FailureEntry['kind'], target: string): string {
  return `${kind}:${target}`
}

/** Record a failure, bumping its attempt count and scheduling the next retry. */
export function recordFailure(
  state: RunState,
  kind: FailureEntry['kind'],
  target: string,
  error: unknown,
  options: { retryDelayMs?: number } = {},
): FailureEntry {
  const key = failureKey(kind, target)
  const previous = state.failures[key]
  const attempts = (previous?.attempts ?? 0) + 1
  const base = Math.max(1000, options.retryDelayMs ?? 30_000)
  const delay = Math.min(base * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS)
  const now = Date.now()
  const message = error instanceof Error ? error.message : String(error)
  const entry: FailureEntry = {
    kind,
    target,
    attempts,
    lastError: message.slice(0, 800),
    lastAttemptAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now + delay).toISOString(),
  }
  state.failures[key] = entry
  return entry
}

export function clearFailure(state: RunState, kind: FailureEntry['kind'], target: string): void {
  delete state.failures[failureKey(kind, target)]
}

/** True while the last run is inside the cooldown window. */
export function isCoolingDown(state: RunState, cooldownMs: number, nowMs = Date.now()): boolean {
  if (!state.lastRunAt || cooldownMs <= 0) return false
  const last = Date.parse(state.lastRunAt)
  if (Number.isNaN(last)) return false
  return nowMs - last < cooldownMs
}

/** Failures whose backoff has elapsed, oldest first. */
export function pendingFailures(state: RunState, nowMs = Date.now()): FailureEntry[] {
  return Object.values(state.failures)
    .filter((entry) => {
      const due = Date.parse(entry.nextAttemptAt)
      return Number.isNaN(due) || due <= nowMs
    })
    .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
}

export { nowIso }
