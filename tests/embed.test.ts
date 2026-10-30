import http from 'node:http'

import { describe, expect, it } from 'vitest'

import {
  DashscopeError,
  createEmbedder,
  createReranker,
  embedOne,
  embeddingEndpoint,
  rerankEndpoint,
} from '../src/embed.js'
import type { DashscopeConfig, Embedder } from '../src/types.js'
import { isRecord } from '../src/util.js'

const API_KEY = 'sk-test-dashscope-key-do-not-log'

interface CapturedRequest {
  method: string
  url: string
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

interface Reply {
  status?: number
  body: string
  delayMs?: number
}

type Handler = (request: CapturedRequest, index: number) => Reply

interface ServerContext {
  baseUrl: string
  requests: CapturedRequest[]
  close: () => Promise<void>
}

async function startServer(handler: Handler): Promise<ServerContext> {
  const requests: CapturedRequest[] = []
  const server = http.createServer((req, res) => {
    res.on('error', () => {})
    const chunks: Buffer[] = []
    req.on('error', () => {})
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown = raw
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = raw
      }
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: parsed,
      }
      requests.push(captured)
      const reply = handler(captured, requests.length - 1)
      const send = () => {
        res.statusCode = reply.status ?? 200
        res.setHeader('content-type', 'application/json')
        res.end(reply.body)
      }
      if (reply.delayMs !== undefined && reply.delayMs > 0) setTimeout(send, reply.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('test server did not bind a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          resolve()
        })
      }),
  }
}

async function withServer(handler: Handler, run: (ctx: ServerContext) => Promise<void>): Promise<void> {
  const ctx = await startServer(handler)
  try {
    await run(ctx)
  } finally {
    await ctx.close()
  }
}

function dashscopeConfig(baseUrl: string, overrides: Partial<DashscopeConfig> = {}): DashscopeConfig {
  return {
    region: 'beijing',
    baseUrl,
    embeddingModel: 'text-embedding-v4',
    embeddingDimensions: 4,
    embeddingBatchSize: 3,
    rerankModel: 'gte-rerank-v2',
    rerankTopN: 3,
    rerankEnabled: true,
    timeoutMs: 2000,
    retries: 1,
    ...overrides,
  }
}

/** Texts of an embedding request body, ignoring any non-string noise. */
function inputTexts(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.input)) return []
  return body.input.filter((value): value is string => typeof value === 'string')
}

/** Deterministic embedding per input text: `t3` → `[3, 0.5, -1, 2]`. */
function embeddingForText(text: string): number[] {
  return [Number(text.slice(1)), 0.5, -1, 2]
}

function embeddingReply(inputs: string[], reverse = true): Reply {
  const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: embeddingForText(text) }))
  return { body: JSON.stringify({ object: 'list', model: 'text-embedding-v4', data: reverse ? data.reverse() : data }) }
}

async function rejectionOf(promise: Promise<unknown>): Promise<DashscopeError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  expect(error).toBeInstanceOf(DashscopeError)
  if (!(error instanceof DashscopeError)) throw new Error('expected a DashscopeError')
  return error
}

describe('endpoints', () => {
  it('builds the DashScope Beijing URLs', () => {
    const config = dashscopeConfig('https://dashscope.aliyuncs.com')
    expect(embeddingEndpoint(config)).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings')
    expect(rerankEndpoint(config)).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
    )
  })

  it('tolerates a trailing slash and serves the intl region', () => {
    const config = dashscopeConfig('https://dashscope-intl.aliyuncs.com/', { region: 'intl' })
    expect(embeddingEndpoint(config)).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings')
    expect(rerankEndpoint(config)).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
    )
  })
})

describe('createEmbedder', () => {
  it('splits inputs into batches and re-assembles them in input order', async () => {
    const logs: string[] = []
    const logger = {
      debug: (message: string) => logs.push(message),
      info: () => {},
      warn: () => {},
      error: () => {},
    }

    await withServer(
      (request) => embeddingReply(inputTexts(request.body)),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl), API_KEY, logger)
        expect(embedder.model).toBe('text-embedding-v4')
        expect(embedder.dimensions).toBe(4)

        const vectors = await embedder.embed(['t0', 't1', 't2', 't3', 't4'])

        expect(ctx.requests).toHaveLength(2)
        expect(inputTexts(ctx.requests[0]?.body)).toEqual(['t0', 't1', 't2'])
        expect(inputTexts(ctx.requests[1]?.body)).toEqual(['t3', 't4'])
        expect(vectors).toEqual([
          [0, 0.5, -1, 2],
          [1, 0.5, -1, 2],
          [2, 0.5, -1, 2],
          [3, 0.5, -1, 2],
          [4, 0.5, -1, 2],
        ])

        const first = ctx.requests[0]
        expect(first?.method).toBe('POST')
        expect(first?.url).toBe('/compatible-mode/v1/embeddings')
        expect(first?.authorization).toBe(`Bearer ${API_KEY}`)
        expect(first?.contentType).toBe('application/json')
        const payload = first?.body
        if (!isRecord(payload)) throw new Error('embedding request body was not an object')
        expect(payload.model).toBe('text-embedding-v4')
        expect(payload.dimensions).toBe(4)
        expect(payload.encoding_format).toBe('float')

        // One debug line per batch, and the API key never reaches the logger.
        expect(logs).toHaveLength(2)
        expect(logs.some((line) => line.includes(API_KEY))).toBe(false)
      },
    )
  })

  it('returns [] without calling the network for no inputs', async () => {
    await withServer(
      () => ({ body: '{}' }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl), API_KEY)
        expect(await embedder.embed([])).toEqual([])
        expect(ctx.requests).toHaveLength(0)
      },
    )
  })

  it('retries a 500 response and then succeeds', async () => {
    await withServer(
      (_request, index) =>
        index === 0
          ? { status: 500, body: JSON.stringify({ code: 'InternalError', message: 'boom' }) }
          : { body: JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }) },
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl, { retries: 1 }), API_KEY)
        expect(await embedder.embed(['only'])).toEqual([[1, 2, 3, 4]])
        expect(ctx.requests).toHaveLength(2)
      },
    )
  })

  it('does not retry a 4xx and surfaces a DashscopeError', async () => {
    await withServer(
      () => ({ status: 400, body: JSON.stringify({ code: 'InvalidApiKey', message: 'bad key' }) }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl, { retries: 3 }), API_KEY)
        const error = await rejectionOf(embedder.embed(['x']))
        expect(error.status).toBe(400)
        expect(error.code).toBe('InvalidApiKey')
        expect(error.body).toContain('InvalidApiKey')
        expect(ctx.requests).toHaveLength(1)
      },
    )
  })

  it('gives up after the configured retries with a DashscopeError', async () => {
    await withServer(
      () => ({ status: 503, body: JSON.stringify({ code: 'ServiceUnavailable' }) }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl, { retries: 1 }), API_KEY)
        const error = await rejectionOf(embedder.embed(['x']))
        expect(error.status).toBe(503)
        expect(error.code).toBe('request_failed')
        expect(error.message).toMatch(/after 2 attempt/u)
        expect(ctx.requests).toHaveLength(2)
      },
    )
  })

  it('throws when a returned row has the wrong number of dimensions', async () => {
    await withServer(
      () => ({ body: JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }) }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl, { embeddingDimensions: 4 }), API_KEY)
        const error = await rejectionOf(embedder.embed(['x']))
        expect(error.code).toBe('dimension_mismatch')
        expect(error.message).toMatch(/expected 4/u)
        expect(ctx.requests).toHaveLength(1)
      },
    )
  })

  it('throws when a row is missing from the response', async () => {
    await withServer(
      () => ({ body: JSON.stringify({ data: [{ index: 1, embedding: [1, 2, 3, 4] }] }) }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl), API_KEY)
        const error = await rejectionOf(embedder.embed(['a', 'b']))
        expect(error.code).toBe('incomplete_response')
      },
    )
  })

  it('aborts a slow request once timeoutMs elapses', async () => {
    await withServer(
      () => ({
        delayMs: 250,
        body: JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3, 4] }] }),
      }),
      async (ctx) => {
        const embedder = createEmbedder(dashscopeConfig(ctx.baseUrl, { timeoutMs: 60, retries: 0 }), API_KEY)
        const error = await rejectionOf(embedder.embed(['x']))
        expect(error.code).toBe('request_failed')
        expect(error.message).toMatch(/timed out/u)
      },
    )
  })
})

describe('createReranker', () => {
  const documents = ['d0', 'd1', 'd2', 'd3']

  function rerankReply(): Reply {
    return {
      body: JSON.stringify({
        output: {
          results: [
            { index: 2, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.5 },
            // Out of range for four documents: dropped.
            { index: 9, relevance_score: 0.95 },
            { index: 1, relevance_score: 0.7 },
          ],
        },
      }),
    }
  }

  it('parses results, sorts by score and clamps top_n to the document count', async () => {
    await withServer(rerankReply, async (ctx) => {
      const reranker = createReranker(dashscopeConfig(ctx.baseUrl), API_KEY)
      expect(reranker.model).toBe('gte-rerank-v2')

      const hits = await reranker.rerank('今天做了什么？', documents, 10)
      expect(hits).toEqual([
        { index: 2, score: 0.9 },
        { index: 1, score: 0.7 },
        { index: 0, score: 0.5 },
      ])

      const request = ctx.requests[0]
      expect(request?.url).toBe('/api/v1/services/rerank/text-rerank/text-rerank')
      expect(request?.authorization).toBe(`Bearer ${API_KEY}`)
      const payload = request?.body
      if (!isRecord(payload)) throw new Error('rerank request body was not an object')
      expect(payload.model).toBe('gte-rerank-v2')
      expect(payload.input).toEqual({ query: '今天做了什么？', documents })
      expect(payload.parameters).toEqual({ return_documents: false, top_n: 4 })
    })
  })

  it('honours a smaller topN and drops out-of-range indices', async () => {
    await withServer(rerankReply, async (ctx) => {
      const reranker = createReranker(dashscopeConfig(ctx.baseUrl), API_KEY)
      const hits = await reranker.rerank('q', documents, 2)
      expect(hits).toEqual([
        { index: 2, score: 0.9 },
        { index: 1, score: 0.7 },
      ])
      const payload = ctx.requests[0]?.body
      if (!isRecord(payload) || !isRecord(payload.parameters)) {
        throw new Error('rerank request body was not an object')
      }
      expect(payload.parameters.top_n).toBe(2)
    })
  })

  it('returns [] for no documents or a zero topN without calling the network', async () => {
    await withServer(rerankReply, async (ctx) => {
      const reranker = createReranker(dashscopeConfig(ctx.baseUrl), API_KEY)
      expect(await reranker.rerank('q', [], 5)).toEqual([])
      expect(await reranker.rerank('q', documents, 0)).toEqual([])
      expect(ctx.requests).toHaveLength(0)
    })
  })

  it('surfaces a DashscopeError for an unparseable rerank payload', async () => {
    await withServer(
      () => ({ body: JSON.stringify({ output: {} }) }),
      async (ctx) => {
        const reranker = createReranker(dashscopeConfig(ctx.baseUrl), API_KEY)
        const error = await rejectionOf(reranker.rerank('q', documents, 3))
        expect(error.code).toBe('invalid_response')
      },
    )
  })

  it('falls back to a pass-through ranking when rerankEnabled is false', async () => {
    // Port 9 is never a working HTTP server: a network call here would fail.
    const config = dashscopeConfig('http://127.0.0.1:9', { rerankEnabled: false })
    const reranker = createReranker(config, API_KEY)

    expect(reranker.model).toBe('gte-rerank-v2')
    expect(await reranker.rerank('q', ['a', 'b', 'c'], 2)).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 0.5 },
    ])
    expect(await reranker.rerank('q', ['a', 'b', 'c'], 10)).toEqual([
      { index: 0, score: 1 },
      { index: 1, score: 0.5 },
      { index: 2, score: 1 / 3 },
    ])
    expect(await reranker.rerank('q', [], 3)).toEqual([])
    expect(await reranker.rerank('q', ['a'], 0)).toEqual([])
  })
})

describe('embedOne', () => {
  function fakeEmbedder(vectorLength = 2): { embedder: Embedder; calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      embedder: {
        model: 'fake-embedder',
        dimensions: vectorLength,
        async embed(texts: string[]): Promise<number[][]> {
          calls.push(texts)
          return texts.map(() => [1, 2])
        },
      },
    }
  }

  it('normalises whitespace and returns the single row', async () => {
    const { embedder, calls } = fakeEmbedder()
    expect(await embedOne(embedder, '  今天   做了什么？ \n ')).toEqual([1, 2])
    expect(calls).toEqual([['今天 做了什么？']])
  })

  it('throws a descriptive error for empty text without calling the embedder', async () => {
    const { embedder, calls } = fakeEmbedder()
    await expect(embedOne(embedder, '')).rejects.toThrow(/empty/u)
    await expect(embedOne(embedder, '   \n\t  ')).rejects.toThrow(/empty/u)
    expect(calls).toHaveLength(0)
  })

  it('throws when the embedder returns nothing or the wrong dimension', async () => {
    const empty: Embedder = {
      model: 'empty',
      dimensions: 2,
      async embed(): Promise<number[][]> {
        return []
      },
    }
    await expect(embedOne(empty, 'text')).rejects.toThrow(/no vector/u)

    const wrongDimensions: Embedder = {
      model: 'wrong',
      dimensions: 4,
      async embed(): Promise<number[][]> {
        return [[1, 2]]
      },
    }
    await expect(embedOne(wrongDimensions, 'text')).rejects.toThrow(/dimensions/u)
  })
})
