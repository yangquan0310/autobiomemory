/**
 * AutoBioMemory — DashScope (Beijing) HTTP clients: embeddings + rerank.
 *
 * Both clients are plain `fetch` calls against the DashScope REST API, with a
 * per-attempt `AbortController` timeout and bounded exponential-backoff retries
 * for transient failures (429 / 5xx / network). Nothing here imports the dsh
 * runtime, so the CLI, `consolidate` and the tests can all drive it.
 *
 * The API key is only ever placed in the `Authorization` header; it never
 * reaches a log line, an error message or a `DashscopeError` body.
 */

import type {
  DashscopeConfig,
  Embedder,
  Logger,
  RerankHit,
  Reranker,
} from './types.js'
import { asyncPool, collapseWhitespace, isRecord, sleep } from './util.js'

/** Default wall-clock budget for one HTTP attempt when the config omits one. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Base delay for the retry backoff: 250ms, 500ms, 1s, … */
const RETRY_BASE_MS = 250

/** Retries attempted when the config carries no usable value. */
const DEFAULT_RETRIES = 3

/** How many embedding batches may be in flight at once. */
const EMBEDDING_CONCURRENCY = 4

/** Maximum characters of a response body kept on an error (diagnostics only). */
const BODY_SNIPPET_CHARS = 500

/** Raised for any DashScope failure: HTTP error, bad payload, exhausted retries. */
export class DashscopeError extends Error {
  readonly status?: number
  readonly body?: string
  readonly code?: string

  constructor(
    message: string,
    options: { status?: number; body?: string; code?: string } = {},
  ) {
    super(message)
    this.name = 'DashscopeError'
    this.status = options.status
    this.body = options.body
    this.code = options.code
  }
}

/** Transient failure that is worth retrying. */
class RetryableDashscopeError extends Error {
  readonly status: number | undefined
  readonly body: string | undefined

  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message)
    this.name = 'RetryableDashscopeError'
    this.status = options.status
    this.body = options.body
  }
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}

/** `POST {baseUrl}/compatible-mode/v1/embeddings` */
export function embeddingEndpoint(config: DashscopeConfig): string {
  return `${trimBaseUrl(config.baseUrl)}/compatible-mode/v1/embeddings`
}

/** `POST {baseUrl}/api/v1/services/rerank/text-rerank/text-rerank` */
export function rerankEndpoint(config: DashscopeConfig): string {
  return `${trimBaseUrl(config.baseUrl)}/api/v1/services/rerank/text-rerank/text-rerank`
}

function timeoutOf(config: DashscopeConfig): number {
  const value = config.timeoutMs
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

function retriesOf(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRIES
  return Math.max(0, Math.floor(value))
}

function snippet(text: string): string {
  return text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}…` : text
}

/** DashScope's machine-readable error code, when the body carries one. */
function errorCodeFromBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) return undefined
    const code = parsed.code
    return typeof code === 'string' && code.length > 0 ? code : undefined
  } catch {
    return undefined
  }
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface PostJsonOptions {
  url: string
  payload: unknown
  apiKey: string
  timeoutMs: number
  retries: number
  logger?: Logger
  /** Used in log lines and error messages, e.g. `embedding`. */
  label: string
}

/** One HTTP attempt; throws `RetryableDashscopeError` or `DashscopeError`. */
async function requestOnce(options: PostJsonOptions): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableDashscopeError(
          `${options.label} request failed with status ${response.status}`,
          { status: response.status, body: snippet(text) },
        )
      }
      throw new DashscopeError(
        `${options.label} request failed with status ${response.status}`,
        {
          status: response.status,
          body: snippet(text),
          code: errorCodeFromBody(text),
        },
      )
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new DashscopeError(`${options.label} response was not valid JSON`, {
        body: snippet(text),
        code: 'invalid_json',
      })
    }
  } catch (error) {
    if (error instanceof RetryableDashscopeError || error instanceof DashscopeError) throw error
    throw new RetryableDashscopeError(
      timedOut
        ? `${options.label} request timed out after ${options.timeoutMs}ms`
        : `${options.label} request failed: ${describeUnknown(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** POST JSON with retries for transient failures; resolves the parsed body. */
async function postJson(options: PostJsonOptions): Promise<unknown> {
  const attempts = retriesOf(options.retries) + 1
  let last: RetryableDashscopeError | undefined
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(options)
    } catch (error) {
      if (!(error instanceof RetryableDashscopeError)) throw error
      last = error
      if (attempt >= attempts) break
      const delayMs = RETRY_BASE_MS * 2 ** (attempt - 1)
      options.logger?.warn(
        `${options.label} attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
    }
  }
  throw new DashscopeError(
    `${options.label} failed after ${attempts} attempt(s): ${last?.message ?? 'unknown error'}`,
    { status: last?.status, body: last?.body, code: 'request_failed' },
  )
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validate one embedding response for `batch.length` inputs and re-order rows
 * by their `index`, so a batch's order never depends on the wire order.
 */
function parseEmbeddingResponse(
  raw: unknown,
  dimensions: number,
  expectedRows: number,
): number[][] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new DashscopeError('DashScope embedding response has no data array', {
      code: 'invalid_response',
      body: snippet(JSON.stringify(raw)),
    })
  }
  const rows = new Array<number[] | undefined>(expectedRows)
  let cursor = 0
  for (const entry of raw.data) {
    if (!isRecord(entry)) {
      throw new DashscopeError('DashScope embedding response has a malformed row', {
        code: 'invalid_response',
        body: snippet(JSON.stringify(entry)),
      })
    }
    const index = toFiniteNumber(entry.index)
    const rowIndex = index === undefined ? cursor : Math.floor(index)
    cursor += 1
    if (rowIndex < 0 || rowIndex >= expectedRows) {
      throw new DashscopeError(
        `DashScope embedding response row index ${rowIndex} is outside 0..${expectedRows - 1}`,
        { code: 'invalid_response' },
      )
    }
    if (!Array.isArray(entry.embedding)) {
      throw new DashscopeError(`DashScope embedding row ${rowIndex} has no embedding array`, {
        code: 'invalid_response',
      })
    }
    const embedding: number[] = []
    for (const value of entry.embedding) {
      const numeric = toFiniteNumber(value)
      if (numeric === undefined) {
        throw new DashscopeError(`DashScope embedding row ${rowIndex} contains a non-numeric value`, {
          code: 'invalid_response',
        })
      }
      embedding.push(numeric)
    }
    if (embedding.length !== dimensions) {
      throw new DashscopeError(
        `DashScope embedding row ${rowIndex} has ${embedding.length} dimensions, expected ${dimensions}`,
        { code: 'dimension_mismatch' },
      )
    }
    rows[rowIndex] = embedding
  }

  const ordered: number[][] = []
  for (let index = 0; index < expectedRows; index += 1) {
    const row = rows[index]
    if (row === undefined) {
      throw new DashscopeError(`DashScope embedding response is missing row ${index}`, {
        code: 'incomplete_response',
      })
    }
    ordered.push(row)
  }
  return ordered
}

/**
 * DashScope embedding client.
 *
 * Texts are split into `embeddingBatchSize` batches (run with bounded
 * concurrency) and re-assembled in input order. Every batch logs exactly one
 * debug line; failures are retried for transient statuses only and then raised
 * as `DashscopeError`.
 */
export function createEmbedder(
  config: DashscopeConfig,
  apiKey: string,
  logger?: Logger,
): Embedder {
  const model = config.embeddingModel
  const dimensions = Number.isFinite(config.embeddingDimensions)
    ? Math.floor(config.embeddingDimensions)
    : 0
  const batchSize =
    Number.isFinite(config.embeddingBatchSize) && config.embeddingBatchSize >= 1
      ? Math.floor(config.embeddingBatchSize)
      : 10
  const url = embeddingEndpoint(config)
  const timeoutMs = timeoutOf(config)
  const retries = retriesOf(config.retries)

  return {
    model,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      if (apiKey === '') {
        throw new DashscopeError('DASHSCOPE_API_KEY is missing', { code: 'missing_api_key' })
      }
      if (dimensions <= 0) {
        throw new DashscopeError(
          `DashScope embeddingDimensions must be a positive integer, got ${config.embeddingDimensions}`,
          { code: 'bad_dimensions' },
        )
      }

      const batches: string[][] = []
      for (let start = 0; start < texts.length; start += batchSize) {
        batches.push(texts.slice(start, start + batchSize))
      }

      const batchResults = await asyncPool(
        batches,
        Math.max(1, Math.min(batches.length, EMBEDDING_CONCURRENCY)),
        async (batch, batchIndex) => {
          const raw = await postJson({
            url,
            payload: {
              model,
              input: batch,
              dimensions,
              encoding_format: 'float',
            },
            apiKey,
            timeoutMs,
            retries,
            logger,
            label: 'embedding',
          })
          const embeddings = parseEmbeddingResponse(raw, dimensions, batch.length)
          logger?.debug('embedding batch', {
            batch: batchIndex + 1,
            batches: batches.length,
            inputs: batch.length,
            model,
            dimensions,
          })
          return embeddings
        },
      )

      const output = new Array<number[]>(texts.length)
      batchResults.forEach((embeddings, batchIndex) => {
        embeddings.forEach((embedding, offset) => {
          output[batchIndex * batchSize + offset] = embedding
        })
      })
      const ordered: number[][] = []
      for (let index = 0; index < texts.length; index += 1) {
        const embedding = output[index]
        if (embedding === undefined) {
          throw new DashscopeError(`DashScope embedding result is missing row ${index}`, {
            code: 'incomplete_response',
          })
        }
        ordered.push(embedding)
      }
      return ordered
    },
  }
}

/** Clamp a requested `topN` into `[0, documentCount]`. */
function clampTopN(topN: number, documentCount: number): number {
  const requested = Number.isFinite(topN) ? Math.floor(topN) : documentCount
  return Math.max(0, Math.min(documentCount, requested))
}

/** Validate `output.results[]`, drop out-of-range hits, sort by score desc. */
function parseRerankResponse(raw: unknown, documentCount: number, topN: number): RerankHit[] {
  if (!isRecord(raw) || !isRecord(raw.output) || !Array.isArray(raw.output.results)) {
    throw new DashscopeError('DashScope rerank response has no output.results array', {
      code: 'invalid_response',
      body: snippet(JSON.stringify(raw)),
    })
  }
  const hits: RerankHit[] = []
  for (const entry of raw.output.results) {
    if (!isRecord(entry)) continue
    const rawIndex = toFiniteNumber(entry.index)
    if (rawIndex === undefined) continue
    const index = Math.floor(rawIndex)
    if (index < 0 || index >= documentCount) continue
    const score =
      toFiniteNumber(entry.relevance_score) ??
      toFiniteNumber(entry.score) ??
      0
    hits.push({ index, score })
  }
  hits.sort((a, b) => b.score - a.score || a.index - b.index)
  return hits.slice(0, topN)
}

/**
 * DashScope rerank client.
 *
 * With `rerankEnabled === false` this still returns a `Reranker`, but it never
 * touches the network: it returns the input order with a decaying
 * `1 / (i + 1)` score, so the rest of the pipeline keeps working unchanged.
 */
export function createReranker(
  config: DashscopeConfig,
  apiKey: string,
  logger?: Logger,
): Reranker {
  const model = config.rerankModel

  if (config.rerankEnabled === false) {
    return {
      model,
      async rerank(_query: string, documents: string[], topN: number): Promise<RerankHit[]> {
        const count = clampTopN(topN, documents.length)
        const hits: RerankHit[] = []
        for (let index = 0; index < count; index += 1) {
          hits.push({ index, score: 1 / (index + 1) })
        }
        return hits
      },
    }
  }

  const url = rerankEndpoint(config)
  const timeoutMs = timeoutOf(config)
  const retries = retriesOf(config.retries)

  return {
    model,
    async rerank(query: string, documents: string[], topN: number): Promise<RerankHit[]> {
      const documentCount = documents.length
      if (documentCount === 0) return []
      const effectiveTopN = clampTopN(topN, documentCount)
      if (effectiveTopN === 0) return []
      if (apiKey === '') {
        throw new DashscopeError('DASHSCOPE_API_KEY is missing', { code: 'missing_api_key' })
      }
      const raw = await postJson({
        url,
        payload: {
          model,
          input: { query, documents },
          parameters: { return_documents: false, top_n: effectiveTopN },
        },
        apiKey,
        timeoutMs,
        retries,
        logger,
        label: 'rerank',
      })
      const hits = parseRerankResponse(raw, documentCount, effectiveTopN)
      logger?.debug('rerank', {
        documents: documentCount,
        topN: effectiveTopN,
        hits: hits.length,
        model,
      })
      return hits
    },
  }
}

/**
 * Embed exactly one text.
 *
 * The text is whitespace-collapsed first (DashScope rejects empty input), and
 * an empty result, an empty text or a wrong-dimension row raises a descriptive
 * `Error` instead of a silently empty vector.
 */
export async function embedOne(embedder: Embedder, text: string): Promise<number[]> {
  if (typeof text !== 'string') {
    throw new Error('embedOne: text must be a string')
  }
  const normalized = collapseWhitespace(text)
  if (normalized.length === 0) {
    throw new Error('embedOne: text is empty after normalisation; refusing to embed an empty string')
  }
  const rows = await embedder.embed([normalized])
  const row = rows[0]
  if (row === undefined || row.length === 0) {
    throw new Error('embedOne: the embedder returned no vector for the text')
  }
  if (Number.isFinite(embedder.dimensions) && embedder.dimensions > 0 && row.length !== embedder.dimensions) {
    throw new Error(
      `embedOne: the embedder returned ${row.length} dimensions but advertises ${embedder.dimensions}`,
    )
  }
  return row
}
