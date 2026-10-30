import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DeepseekClient, DeepseekError } from '../src/deepseek.js'
import type { DeepseekConfig } from '../src/types.js'

interface Recorded {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

const baseConfig = (over: Partial<DeepseekConfig> = {}): DeepseekConfig => ({
  baseUrl: 'http://127.0.0.1:1',
  model: 'deepseek-chat',
  temperature: 0.4,
  maxTokens: 128,
  timeoutMs: 5000,
  jsonMode: true,
  retries: 2,
  ...over,
})

const completion = (content: string): string =>
  JSON.stringify({
    model: 'deepseek-chat',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  })

describe('DeepseekClient', () => {
  let server: http.Server
  let baseUrl = ''
  const seen: Recorded[] = []
  let plan: Array<{ status: number; body: string }> = []

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        })
        const next = plan.shift() ?? { status: 200, body: completion('{}') }
        res.writeHead(next.status, { 'Content-Type': 'application/json' })
        res.end(next.body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('posts a JSON-mode chat completion and records usage', async () => {
    seen.length = 0
    plan = [{ status: 200, body: completion('{"ok":true}') }]
    const client = new DeepseekClient(baseConfig({ baseUrl }), 'sk-test')
    const content = await client.chat([{ role: 'user', content: 'hi' }])
    expect(content).toBe('{"ok":true}')
    expect(seen[0]?.path).toBe('/chat/completions')
    expect(seen[0]?.authorization).toBe('Bearer sk-test')
    expect(seen[0]?.body.model).toBe('deepseek-chat')
    expect(seen[0]?.body.response_format).toEqual({ type: 'json_object' })
    expect(client.lastUsage).toEqual({ model: 'deepseek-chat', promptTokens: 11, completionTokens: 7 })
  })

  it('retries 5xx and then succeeds', async () => {
    seen.length = 0
    plan = [
      { status: 500, body: '{"error":"boom"}' },
      { status: 503, body: '{"error":"again"}' },
      { status: 200, body: completion('{"ok":true}') },
    ]
    const client = new DeepseekClient(baseConfig({ baseUrl }), 'sk-test')
    await expect(client.chat([{ role: 'user', content: 'hi' }])).resolves.toBe('{"ok":true}')
    expect(seen).toHaveLength(3)
  })

  it('does not retry 401', async () => {
    seen.length = 0
    plan = [{ status: 401, body: '{"error":"bad key"}' }]
    const client = new DeepseekClient(baseConfig({ baseUrl }), 'sk-test')
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(DeepseekError)
    expect(seen).toHaveLength(1)
  })

  it('gives up after the retry budget', async () => {
    seen.length = 0
    plan = [
      { status: 500, body: 'x' },
      { status: 500, body: 'x' },
      { status: 500, body: 'x' },
    ]
    const client = new DeepseekClient(baseConfig({ baseUrl, retries: 1 }), 'sk-test')
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 500/u)
    expect(seen).toHaveLength(2)
  })

  it('honours a caller abort signal', async () => {
    const client = new DeepseekClient(baseConfig({ baseUrl }), 'sk-test')
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.chat([{ role: 'user', content: 'hi' }], { signal: controller.signal }),
    ).rejects.toThrow()
  })

  it('times out a stalled endpoint', async () => {
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(completion('{"late":true}'))
      }, 500)
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const address = slow.address() as AddressInfo
    try {
      const client = new DeepseekClient(
        baseConfig({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 50, retries: 0 }),
        'sk-test',
      )
      await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow()
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()))
    }
  })
})
