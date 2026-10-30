import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EventSummary, VectorRow } from '../src/types.js'
import {
  VectorStore,
  blobToVector,
  cosineSimilarity,
  missingEventIds,
  searchVectors,
  staleEventIds,
  vectorNorm,
  vectorToBlob,
} from '../src/vectors.js'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobio-vectors-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function vectorRow(eventId: string, vector: number[], extra: Partial<VectorRow> = {}): VectorRow {
  return {
    eventId,
    model: extra.model ?? 'text-embedding-v4',
    dimensions: extra.dimensions ?? vector.length,
    textHash: extra.textHash ?? `hash-${eventId}`,
    vector,
    norm: extra.norm ?? vectorNorm(vector),
    updatedAt: extra.updatedAt ?? '2025-10-30T00:00:00.000Z',
  }
}

function summary(id: string, diaryHash: string, extra: Partial<EventSummary> = {}): EventSummary {
  return {
    id,
    title: `事件 ${id}`,
    occurredAt: '2025-10-30T08:00:00.000Z',
    endedAt: '2025-10-30T08:30:00.000Z',
    status: 'completed',
    tags: [],
    people: [],
    keywords: [],
    entities: [],
    diaryHash,
    diaryChars: 42,
    revision: 1,
    jsonFile: `/tmp/events/${id}.json`,
    mdFile: `/tmp/events/${id}.md`,
    updatedAt: '2025-10-30T08:31:00.000Z',
    ...extra,
  }
}

describe('vector blobs', () => {
  it('round-trips float32 values exactly, including negatives and denormals', () => {
    const source = [0, -1, 1.5, -0.25, 0.1, -1e-40, 1e-40, -3.4028234663852886e38, 12345.678, -0.000123]
    const expected = Array.from(new Float32Array(source))
    const blob = vectorToBlob(source)

    expect(blob).toBeInstanceOf(Buffer)
    expect(blob.length).toBe(source.length * 4)
    expect(blobToVector(blob)).toEqual(expected)

    // Denormals stay non-zero and keep their sign.
    const negativeDenormal = expected[5] ?? Number.NaN
    const positiveDenormal = expected[6] ?? Number.NaN
    expect(Number.isFinite(negativeDenormal)).toBe(true)
    expect(negativeDenormal).toBeLessThan(0)
    expect(Math.abs(negativeDenormal)).toBeGreaterThan(0)
    expect(Math.abs(negativeDenormal)).toBeLessThan(1e-38)
    expect(positiveDenormal).toBeGreaterThan(0)
    expect(Math.abs(positiveDenormal)).toBeLessThan(1e-38)
  })

  it('writes little-endian float32 bytes', () => {
    const blob = vectorToBlob([0, -1, 1.5])
    // 1.5 == 0x3FC00000, little-endian.
    expect([...blob.subarray(8, 12)]).toEqual([0x00, 0x00, 0xc0, 0x3f])
    // -1 == 0xBF800000, little-endian.
    expect([...blob.subarray(4, 8)]).toEqual([0x00, 0x00, 0x80, 0xbf])
    expect(blob.readFloatLE(8)).toBe(1.5)
    expect(blob.readFloatLE(4)).toBe(-1)
  })

  it('reads blobs that are views into a larger buffer (as node:sqlite returns them)', () => {
    const source = [0.5, -2, 8, 0]
    const expected = Array.from(new Float32Array(source))
    const original = vectorToBlob(source)
    const backing = Buffer.alloc(original.length + 8)
    original.copy(backing, 4)
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 4, original.length)
    expect(blobToVector(view)).toEqual(expected)
  })

  it('handles long vectors', () => {
    const source = Array.from({ length: 1025 }, (_, index) => ((index % 7) - 3) / 3)
    const expected = Array.from(new Float32Array(source))
    expect(blobToVector(vectorToBlob(source))).toEqual(expected)
  })

  it('rejects blobs whose length is not a multiple of four', () => {
    expect(() => blobToVector(Buffer.alloc(3))).toThrow(/multiple of 4/u)
    expect(() => blobToVector(Buffer.alloc(0))).not.toThrow()
    expect(blobToVector(Buffer.alloc(0))).toEqual([])
  })
})

describe('cosineSimilarity / vectorNorm', () => {
  it('matches hand-computed values', () => {
    expect(vectorNorm([3, 4])).toBe(5)
    expect(vectorNorm([])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12)
    expect(cosineSimilarity([1, 0], [1, 1])).toBeCloseTo(Math.SQRT1_2, 12)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 12)
    expect(cosineSimilarity([3, 4], [4, -3])).toBeCloseTo(0, 12)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 12)
    expect(cosineSimilarity([2, -1], [2, -1])).toBeCloseTo(1, 12)
  })

  it('returns 0 instead of NaN for incomparable inputs', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([Number.NaN, 1], [1, 1])).toBe(0)
  })
})

describe('VectorStore', () => {
  it('creates the directory and schema on demand', () => {
    const dbFile = path.join(tempDir(), 'vectors', 'index.sqlite')
    const store = new VectorStore(dbFile)
    try {
      expect(fs.existsSync(path.dirname(dbFile))).toBe(true)
      expect(fs.existsSync(dbFile)).toBe(true)
      expect(store.count()).toBe(0)
      expect(store.all()).toEqual([])
      expect(store.modelOf()).toBeUndefined()
      expect(store.get('ev_missing')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('upserts, reads back, replaces, deletes and survives a reopen', () => {
    const dbFile = path.join(tempDir(), 'vectors', 'index.sqlite')
    const store = new VectorStore(dbFile)
    const first = vectorRow('ev_a', [1, 0, 0])
    const second = vectorRow('ev_b', [0, 1, 0], { updatedAt: '2025-10-31T00:00:00.000Z' })

    expect(store.upsert([])).toBe(0)
    expect(store.upsert([first, second])).toBe(2)
    expect(store.count()).toBe(2)
    expect(store.get('ev_a')).toEqual(first)
    expect(store.get('ev_b')).toEqual(second)
    expect(store.all().map((row) => row.eventId)).toEqual(['ev_a', 'ev_b'])
    expect(store.modelOf()).toBe('text-embedding-v4')

    // Replacing an id keeps the row count and updates the payload.
    const replacement = vectorRow('ev_a', [0, 0, 1], {
      textHash: 'hash-new',
      updatedAt: '2025-11-01T00:00:00.000Z',
    })
    expect(store.upsert([replacement])).toBe(1)
    expect(store.count()).toBe(2)
    expect(store.get('ev_a')).toEqual(replacement)

    // Deletion reports rows actually removed, ignoring duplicates/unknown ids.
    expect(store.delete([])).toBe(0)
    expect(store.delete(['ev_a', 'ev_a'])).toBe(1)
    expect(store.delete(['ev_a'])).toBe(0)
    expect(store.delete(['ev_b', 'ev_unknown'])).toBe(1)
    expect(store.count()).toBe(0)

    store.upsert([first, second])
    store.close()
    store.close() // idempotent

    const reopened = new VectorStore(dbFile)
    try {
      expect(reopened.count()).toBe(2)
      expect(reopened.get('ev_b')).toEqual(second)
      expect(reopened.all().map((row) => row.eventId)).toEqual(['ev_a', 'ev_b'])
    } finally {
      reopened.close()
    }
  })

  it('collapses duplicate ids inside one upsert call (last row wins)', () => {
    const store = new VectorStore(path.join(tempDir(), 'vectors', 'index.sqlite'))
    try {
      const written = store.upsert([vectorRow('ev_a', [1, 0]), vectorRow('ev_a', [0, 1])])
      expect(written).toBe(1)
      expect(store.count()).toBe(1)
      expect(store.get('ev_a')?.vector).toEqual([0, 1])
    } finally {
      store.close()
    }
  })

  it('reports the dominant model', () => {
    const store = new VectorStore(path.join(tempDir(), 'vectors', 'index.sqlite'))
    try {
      store.upsert([
        vectorRow('ev_a', [1, 0]),
        vectorRow('ev_b', [0, 1]),
        vectorRow('ev_c', [1, 1], { model: 'legacy-model' }),
      ])
      expect(store.modelOf()).toBe('text-embedding-v4')
    } finally {
      store.close()
    }
  })
})

describe('searchVectors', () => {
  function seedStore(): VectorStore {
    const store = new VectorStore(path.join(tempDir(), 'vectors', 'index.sqlite'))
    store.upsert([
      vectorRow('ev_a', [1, 0]),
      vectorRow('ev_b', [0.8, 0.6]),
      vectorRow('ev_dup', [0.8, 0.6]),
      vectorRow('ev_c', [0.6, 0.8]),
      vectorRow('ev_neg', [-1, 0]),
      vectorRow('ev_zero_norm_cache', [0, 1], { norm: 0 }),
      // Different embedding dimension: never scored against a 2-d query.
      vectorRow('ev_3d', [1, 0, 0]),
    ])
    return store
  }

  it('orders by cosine descending with a stable eventId tie-break', () => {
    const store = seedStore()
    try {
      const hits = searchVectors(store, [1, 0], 10)
      expect(hits.map((hit) => hit.eventId)).toEqual([
        'ev_a',
        'ev_b',
        'ev_dup',
        'ev_c',
        'ev_zero_norm_cache',
        'ev_neg',
      ])
      expect(hits[0]?.cosine).toBeCloseTo(1, 10)
      expect(hits[1]?.cosine).toBeCloseTo(0.8, 6)
      expect(hits[2]?.cosine).toBeCloseTo(0.8, 6)
      expect(hits[3]?.cosine).toBeCloseTo(0.6, 6)
      expect(hits[4]?.cosine).toBeCloseTo(0, 10)
      expect(hits[5]?.cosine).toBeCloseTo(-1, 10)
    } finally {
      store.close()
    }
  })

  it('applies topK', () => {
    const store = seedStore()
    try {
      expect(searchVectors(store, [1, 0], 2).map((hit) => hit.eventId)).toEqual(['ev_a', 'ev_b'])
      expect(searchVectors(store, [1, 0], 0)).toEqual([])
      expect(searchVectors(store, [1, 0], -3)).toEqual([])
      expect(searchVectors(store, [1, 0], 1.9).map((hit) => hit.eventId)).toEqual(['ev_a'])
    } finally {
      store.close()
    }
  })

  it('restricts candidates to allowIds, where an empty set means no candidates', () => {
    const store = seedStore()
    try {
      expect(searchVectors(store, [1, 0], 10, new Set(['ev_c', 'ev_neg'])).map((hit) => hit.eventId)).toEqual([
        'ev_c',
        'ev_neg',
      ])
      expect(searchVectors(store, [1, 0], 10, new Set())).toEqual([])
      expect(searchVectors(store, [1, 0], 10, new Set(['ev_unknown']))).toEqual([])
    } finally {
      store.close()
    }
  })

  it('skips dimension mismatches instead of throwing', () => {
    const store = seedStore()
    try {
      const threeDim = searchVectors(store, [1, 0, 0], 10)
      expect(threeDim.map((hit) => hit.eventId)).toEqual(['ev_3d'])
      expect(threeDim[0]?.cosine).toBeCloseTo(1, 10)
      expect(searchVectors(store, [], 10)).toEqual([])
      expect(searchVectors(store, [0, 0], 10)).toEqual([])
    } finally {
      store.close()
    }
  })
})

describe('staleEventIds / missingEventIds', () => {
  it('finds hash mismatches and events with no row', () => {
    const store = new VectorStore(path.join(tempDir(), 'vectors', 'index.sqlite'))
    try {
      store.upsert([
        vectorRow('ev_fresh', [1, 0], { textHash: 'hash-fresh' }),
        vectorRow('ev_stale', [1, 0], { textHash: 'hash-old' }),
        vectorRow('ev_other_model', [1, 0], { model: 'legacy-model', textHash: 'hash-other' }),
      ])
      const summaries = [
        summary('ev_fresh', 'hash-fresh'),
        summary('ev_stale', 'hash-new'),
        summary('ev_other_model', 'hash-other'),
        summary('ev_missing', 'hash-missing'),
      ]

      expect(staleEventIds(store, summaries)).toEqual(['ev_stale'])
      expect(missingEventIds(store, summaries)).toEqual(['ev_missing'])
      expect(staleEventIds(store, [])).toEqual([])
      expect(missingEventIds(store, [])).toEqual([])
      expect(staleEventIds(store, [summary('ev_missing', 'anything')])).toEqual([])
    } finally {
      store.close()
    }
  })

  it('treats a model difference alone as fresh (hash-only comparison)', () => {
    const store = new VectorStore(path.join(tempDir(), 'vectors', 'index.sqlite'))
    try {
      store.upsert([vectorRow('ev_a', [1, 0], { model: 'text-embedding-v3', textHash: 'hash-a' })])
      const summaries = [summary('ev_a', 'hash-a')]
      expect(staleEventIds(store, summaries)).toEqual([])
      expect(missingEventIds(store, summaries)).toEqual([])
    } finally {
      store.close()
    }
  })
})
