/**
 * AutoBioMemory — local vector index.
 *
 * One SQLite file (`<root>/vectors/index.sqlite`) holds every event embedding.
 * Vectors are stored as little-endian Float32 BLOBs with a cached L2 norm, so a
 * cosine scan is one blob read per row. `node:sqlite` (shipped with Node 24)
 * keeps this module dependency-free and importable from a plain Node process.
 *
 * Contract (docs/module-contracts.md): `VectorStore implements VectorSource`.
 * `VectorRow`/`VectorHit`/`VectorSource` are the shared vocabulary from
 * `types.ts` and are re-exported here for convenience.
 */

import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { EventSummary, VectorHit, VectorRow, VectorSource } from './types.js'
import { ensureDir, nowIso } from './util.js'

export type { VectorHit, VectorRow, VectorSource } from './types.js'

/** Bytes per float32 element in a stored vector blob. */
const FLOAT_BYTES = 4

/** Written to `meta.schema_version`; bump when the table layout changes. */
const SCHEMA_VERSION = '1'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vectors (
  event_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  norm REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`

const UPSERT_SQL = `
INSERT INTO vectors (event_id, model, dimensions, text_hash, vector, norm, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(event_id) DO UPDATE SET
  model = excluded.model,
  dimensions = excluded.dimensions,
  text_hash = excluded.text_hash,
  vector = excluded.vector,
  norm = excluded.norm,
  updated_at = excluded.updated_at
`

const SELECT_SQL =
  'SELECT event_id, model, dimensions, text_hash, vector, norm, updated_at FROM vectors'

function asFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Map one raw SQLite row onto `VectorRow`. */
function toVectorRow(raw: Record<string, unknown>): VectorRow {
  const blob = raw.vector
  const vector = blob instanceof Uint8Array ? blobToVector(blob) : []
  return {
    eventId: asText(raw.event_id),
    model: asText(raw.model),
    dimensions: asFiniteNumber(raw.dimensions, vector.length),
    textHash: asText(raw.text_hash),
    vector,
    norm: asFiniteNumber(raw.norm, vectorNorm(vector)),
    updatedAt: asText(raw.updated_at),
  }
}

/** Serialise a vector the way every row stores it: little-endian Float32. */
export function vectorToBlob(vector: number[]): Buffer {
  const blob = Buffer.allocUnsafe(vector.length * FLOAT_BYTES)
  for (let index = 0; index < vector.length; index += 1) {
    blob.writeFloatLE(vector[index] ?? 0, index * FLOAT_BYTES)
  }
  return blob
}

/** Read back a Float32 blob produced by `vectorToBlob`. */
export function blobToVector(blob: Buffer | Uint8Array): number[] {
  if (blob.length % FLOAT_BYTES !== 0) {
    throw new Error(`blobToVector: blob length ${blob.length} is not a multiple of ${FLOAT_BYTES}`)
  }
  const buffer = Buffer.isBuffer(blob)
    ? blob
    : Buffer.from(blob.buffer, blob.byteOffset, blob.length)
  const length = blob.length / FLOAT_BYTES
  const vector = new Array<number>(length)
  for (let index = 0; index < length; index += 1) {
    vector[index] = buffer.readFloatLE(index * FLOAT_BYTES)
  }
  return vector
}

/** Euclidean (L2) norm; `0` when the vector is empty or not finite. */
export function vectorNorm(vector: number[]): number {
  let total = 0
  for (const value of vector) total += value * value
  return Number.isFinite(total) ? Math.sqrt(total) : 0
}

/**
 * Cosine similarity in `[-1, 1]`.
 *
 * Returns `0` for dimension mismatches, empty vectors and zero vectors instead
 * of throwing: retrieval treats a non-comparable row as "no signal".
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let left = 0
  let right = 0
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    dot += x * y
    left += x * x
    right += y * y
  }
  return normaliseCosine(dot, Math.sqrt(left) * Math.sqrt(right))
}

/** Shared tail: denominator guard, non-finite guard, clamp to `[-1, 1]`. */
function normaliseCosine(dot: number, denominator: number): number {
  if (!(denominator > 0) || !Number.isFinite(dot)) return 0
  const cosine = dot / denominator
  if (!Number.isFinite(cosine)) return 0
  return Math.max(-1, Math.min(1, cosine))
}

/**
 * Cosine of one stored row against a query whose norm is already known.
 * The cached `norm` is trusted only when it is a positive finite number.
 */
function rowCosine(row: VectorRow, query: number[], queryNorm: number): number {
  let dot = 0
  for (let index = 0; index < query.length; index += 1) {
    dot += (row.vector[index] ?? 0) * (query[index] ?? 0)
  }
  const rowNorm = row.norm > 0 && Number.isFinite(row.norm) ? row.norm : vectorNorm(row.vector)
  return normaliseCosine(dot, rowNorm * queryNorm)
}

/** Stable, locale-independent id ordering (code-unit order) used for tie-breaks. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * SQLite-backed vector index.
 *
 * The constructor creates the parent directory, the schema and (when the
 * filesystem supports it) WAL journalling, so `new VectorStore(paths.vectorDb)`
 * is all a caller needs.
 */
export class VectorStore implements VectorSource {
  private readonly db: DatabaseSync
  private closed = false

  constructor(dbFile: string) {
    ensureDir(path.dirname(dbFile))
    // The plugin and the CLI may hold the file at the same time; WAL plus a
    // busy timeout keeps those writers queueing instead of failing.
    const db = new DatabaseSync(dbFile, { timeout: 5000 })
    this.db = db
    try {
      // `:memory:` stays in journal mode `memory`; some network filesystems
      // refuse WAL as well, and the default journal works everywhere.
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
    } catch {
      /* WAL unavailable — keep SQLite's default journalling. */
    }
    db.exec(SCHEMA_SQL)
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(SCHEMA_VERSION)
  }

  /** Insert or replace rows in one transaction; returns the number of rows written. */
  upsert(rows: VectorRow[]): number {
    if (rows.length === 0) return 0
    // Duplicate ids inside one call collapse to the last row, so the return
    // value always equals the number of rows that exist afterwards.
    const byId = new Map<string, VectorRow>()
    for (const row of rows) byId.set(row.eventId, row)
    const statement = this.db.prepare(UPSERT_SQL)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of byId.values()) {
        const updatedAt = typeof row.updatedAt === 'string' && row.updatedAt !== '' ? row.updatedAt : nowIso()
        statement.run(
          row.eventId,
          row.model,
          Number.isFinite(row.dimensions) ? Math.floor(row.dimensions) : row.vector.length,
          row.textHash,
          vectorToBlob(row.vector),
          Number.isFinite(row.norm) ? row.norm : vectorNorm(row.vector),
          updatedAt,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the transaction was already gone */
      }
      throw error
    }
    return byId.size
  }

  get(eventId: string): VectorRow | undefined {
    const raw = this.db.prepare(`${SELECT_SQL} WHERE event_id = ?`).get(eventId)
    return raw === undefined ? undefined : toVectorRow(raw)
  }

  /** Every row, ordered by `event_id` so scans are deterministic. */
  all(): VectorRow[] {
    return this.db
      .prepare(`${SELECT_SQL} ORDER BY event_id ASC`)
      .all()
      .map((raw) => toVectorRow(raw))
  }

  /** Delete the given event ids in one transaction; returns rows actually removed. */
  delete(eventIds: string[]): number {
    if (eventIds.length === 0) return 0
    const unique = [...new Set(eventIds)]
    const statement = this.db.prepare('DELETE FROM vectors WHERE event_id = ?')
    this.db.exec('BEGIN IMMEDIATE')
    let removed = 0
    try {
      for (const eventId of unique) {
        removed += Number(statement.run(eventId).changes)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the transaction was already gone */
      }
      throw error
    }
    return removed
  }

  count(): number {
    const raw = this.db.prepare('SELECT COUNT(*) AS total FROM vectors').get()
    return asFiniteNumber(raw?.total)
  }

  /** Model that owns the most rows, i.e. the model the index was built with. */
  modelOf(): string | undefined {
    const raw = this.db
      .prepare(
        'SELECT model, COUNT(*) AS total FROM vectors GROUP BY model ORDER BY total DESC, model ASC LIMIT 1',
      )
      .get()
    if (raw === undefined) return undefined
    const model = asText(raw.model)
    return model === '' ? undefined : model
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

/**
 * Brute-force cosine search.
 *
 * Only rows whose stored `dimensions` (and actual blob length) match the query
 * are scored. `allowIds` restricts the candidate set; an empty set means "no
 * candidates" and yields `[]` rather than "unrestricted". Ties break by
 * `eventId` ascending, so repeated searches are reproducible.
 */
export function searchVectors(
  store: VectorStore,
  query: number[],
  topK: number,
  allowIds?: Set<string>,
): VectorHit[] {
  if (!Number.isFinite(topK) || topK <= 0) return []
  const limit = Math.floor(topK)
  if (query.length === 0) return []
  if (allowIds !== undefined && allowIds.size === 0) return []
  const queryNorm = vectorNorm(query)
  if (!(queryNorm > 0)) return []

  const hits: VectorHit[] = []
  for (const row of store.all()) {
    if (row.dimensions !== query.length) continue
    if (row.vector.length !== query.length) continue
    if (allowIds !== undefined && !allowIds.has(row.eventId)) continue
    hits.push({ eventId: row.eventId, cosine: rowCosine(row, query, queryNorm) })
  }
  hits.sort((a, b) => b.cosine - a.cosine || compareIds(a.eventId, b.eventId))
  return hits.slice(0, limit)
}

/**
 * Events whose stored `text_hash` differs from the event's current `diaryHash`.
 *
 * Hash-only by design: a row for another embedding model (or another
 * dimension) is still current as far as text freshness goes; callers decide
 * whether the model itself has to change (`store.modelOf()`).
 */
export function staleEventIds(store: VectorStore, summaries: EventSummary[]): string[] {
  const storedHashes = new Map<string, string>()
  for (const row of store.all()) storedHashes.set(row.eventId, row.textHash)
  const stale: string[] = []
  for (const summary of summaries) {
    const stored = storedHashes.get(summary.id)
    if (stored === undefined) continue
    if (stored !== summary.diaryHash) stale.push(summary.id)
  }
  return stale
}

/** Events that have no vector row at all. */
export function missingEventIds(store: VectorStore, summaries: EventSummary[]): string[] {
  const known = new Set(store.all().map((row) => row.eventId))
  return summaries.filter((summary) => !known.has(summary.id)).map((summary) => summary.id)
}
