/** AutoBioMemory — DeepSeek chat client (encoding calls). */

import { createLogger } from './logger.js'
import { sleep, throwIfAborted, truncate } from './util.js'
import type { DeepseekConfig, Logger } from './types.js'

export class DeepseekError extends Error {
  readonly status?: number
  readonly body?: string
  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message)
    this.name = 'DeepseekError'
    this.status = options.status
    this.body = options.body
  }
}

export interface DeepseekChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  jsonMode?: boolean
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

interface ChatResponse {
  model?: string
  choices?: Array<{ message?: { content?: unknown } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const RETRYABLE = (status: number): boolean => status === 429 || status >= 500

export class DeepseekClient {
  private readonly config: DeepseekConfig
  private readonly apiKey: string
  private readonly logger: Logger
  lastUsage: { model: string; promptTokens: number; completionTokens: number } | undefined

  constructor(config: DeepseekConfig, apiKey: string, logger?: Logger) {
    this.config = config
    this.apiKey = apiKey
    this.logger = logger ?? createLogger({ scope: 'deepseek' })
  }

  private endpoint(): string {
    return `${this.config.baseUrl.replace(/\/+$/u, '')}/chat/completions`
  }

  async chat(messages: ChatMessage[], options: DeepseekChatOptions = {}): Promise<string> {
    const model = options.model ?? this.config.model
    const jsonMode = options.jsonMode ?? this.config.jsonMode
    const body = {
      model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }

    const attempts = Math.max(0, this.config.retries) + 1
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(options.signal)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
      const onAbort = () => controller.abort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const response = await fetch(this.endpoint(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = truncate(await response.text().catch(() => ''), 800)
          const error = new DeepseekError(`DeepSeek HTTP ${response.status}`, {
            status: response.status,
            body: text,
          })
          if (!RETRYABLE(response.status) || attempt >= attempts) throw error
          lastError = error
        } else {
          const payload = (await response.json()) as ChatResponse
          const content = payload.choices?.[0]?.message?.content
          if (typeof content !== 'string' || content.trim() === '') {
            const error = new DeepseekError('DeepSeek 返回空内容', { status: response.status })
            if (attempt >= attempts) throw error
            lastError = error
          } else {
            this.lastUsage = {
              model: payload.model ?? model,
              promptTokens: payload.usage?.prompt_tokens ?? 0,
              completionTokens: payload.usage?.completion_tokens ?? 0,
            }
            if (attempt > 1) this.logger.debug(`DeepSeek 第 ${attempt} 次尝试成功（${model}）`)
            return content
          }
        }
      } catch (error) {
        if (error instanceof DeepseekError) {
          if (!error.status || !RETRYABLE(error.status) || attempt >= attempts) throw error
          lastError = error
        } else if (options.signal?.aborted) {
          throw error
        } else {
          const wrapped = new DeepseekError(
            `DeepSeek 请求失败：${error instanceof Error ? error.message : String(error)}`,
          )
          if (attempt >= attempts) throw wrapped
          lastError = wrapped
        }
      } finally {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }

      const delay = 250 * 2 ** (attempt - 1)
      this.logger.warn(`DeepSeek 失败，${delay}ms 后重试（第 ${attempt}/${attempts} 次）`)
      await sleep(delay, options.signal)
    }

    throw lastError ?? new DeepseekError('DeepSeek 调用失败')
  }
}
