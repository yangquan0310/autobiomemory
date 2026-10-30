/** AutoBioMemory — pure helpers shared by every module. */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Raised when an operation is cancelled through an AbortSignal. */
export class AbortError extends Error {
  readonly code = 'ABORT_ERR'
  constructor(message = 'aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Short stable hash used inside event ids. */
export function shortHash(input: string | Buffer, length = 8): string {
  return sha256(input).slice(0, Math.max(1, Math.min(64, length)))
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Parse an ISO-8601 string or epoch milliseconds; `undefined` when unusable. */
export function parseIso(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? undefined : ms
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function beijingParts(ms: number) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  const hour = String(shifted.getUTCHours()).padStart(2, '0')
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0')
  const second = String(shifted.getUTCSeconds()).padStart(2, '0')
  return { year, month, day, hour, minute, second }
}

/** `2025-10-30T16:45:12+08:00` — the local label every diary keeps. */
export function beijingIso(ms: number): string {
  const { year, month, day, hour, minute, second } = beijingParts(ms)
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`
}

/** `2025-10-30 16:45:12` (Beijing wall clock). */
export function beijingStamp(ms: number): string {
  const { year, month, day, hour, minute, second } = beijingParts(ms)
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

/** Compact sortable stamp used in event ids: `20251030T164512`. */
export function beijingCompact(ms: number): string {
  const { year, month, day, hour, minute, second } = beijingParts(ms)
  return `${year}${month}${day}T${hour}${minute}${second}`
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max <= 1) return text.slice(0, max)
  return `${text.slice(0, max - 1)}…`
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

export function slugify(text: string, max = 60): string {
  const cleaned = text
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
  return truncate(cleaned, max)
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Read JSON, returning `undefined` for a missing or unparsable file. */
export function readJsonFile<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function writeTextFileAtomic(file: string, text: string): void {
  const dir = path.dirname(file)
  ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

export function writeJsonFile(file: string, value: unknown): void {
  writeTextFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new AbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError()
}

/** Run `worker` over `items` with a bounded concurrency; results keep input order. */
export async function asyncPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit))
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

/** Mask a secret for logs and `doctor` output. */
export function maskSecret(value: string | undefined): string {
  if (!value) return '(missing)'
  if (value.length <= 8) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}
