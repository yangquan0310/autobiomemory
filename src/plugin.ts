/**
 * AutoBioMemory — DeepSeek Harness plugin entry point.
 *
 * Wires the autobiographical-memory loop into the harness through the extension points dsh
 * actually offers:
 *
 * - **Tool** (`ctx.tools.register`) — `autobiomemory_recall` (recall) and, optionally,
 *   `autobiomemory_consolidate` (explicit 整理), so the agent can ask for its own past on demand.
 * - **System prompt** (`ctx.systemPrompt.section`) — a short-term-memory digest plus the recall
 *   habit, refreshed on every assembly.
 * - **Pre-compaction trigger** (`agent/pre-step`, `{ prepend: true }` waterfall) — runs before
 *   `compaction-basic` decides whether to compact, which is the harness's真 pre-compaction seam, and
 *   consolidates the raw transcript on disk incrementally.
 * - **Session events** (`session/event`) — `compaction/start` is a durable belt-and-braces trigger
 *   even when pressure compaction is driven by another backend.
 *
 * Everything is failure-contained: no hook may throw into the agent loop.
 */

import fs from 'node:fs'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { ensureConfig, loadConfig } from './config.js'
import { consolidateOnce, isConsolidating } from './consolidate.js'
import { createEmbedder, createReranker } from './embed.js'
import { readSecrets, requireSecret } from './env.js'
import { ensureDataLayout, memoryPaths, type MemoryPaths } from './paths.js'
import { recall } from './retrieval.js'
import {
  listEventSummaries,
  eventIndexPath,
  readEvent,
  shortTermMemory,
} from './store.js'
import { VectorStore } from './vectors.js'
import { maskSecret, truncate } from './util.js'
import type {
  EventStatus,
  Logger,
  MemoryConfig,
  RecallQuery,
  RecallResult,
  SecretSource,
} from './types.js'

export const name = 'autobiomemory'

/** Services this plugin needs; it stays unloaded in profiles that lack them. */
export const inject = ['tools', 'systemPrompt']

export interface PluginConfig {
  /** Data root; defaults to `~/.autobiomemory`. */
  dataRoot?: string
  /** Master switch for the automatic (lifecycle) triggers. */
  autoConsolidate?: boolean
  /** Also consolidate when an agent goes idle after a turn. */
  consolidateOnIdle?: boolean
  /** Recall tool name. */
  toolName?: string
  /** Optional explicit-consolidation tool name; `''` disables it. */
  consolidateToolName?: string
  /** Upper bound for the pre-compaction consolidation (ms). */
  preCompactionTimeoutMs?: number
  /** Inject the short-term digest into the system prompt. */
  shortTermInPrompt?: boolean
  /** Hard cap on the short-term digest size in characters. */
  shortTermPromptChars?: number
  /** Overrides merged over `<root>/config.json` (advanced). */
  config?: Record<string, unknown>
}

export const Config: z<PluginConfig> = z.object({
  dataRoot: z.string(),
  autoConsolidate: z.boolean().default(true),
  consolidateOnIdle: z.boolean().default(false),
  toolName: z.string().default('autobiomemory_recall'),
  consolidateToolName: z.string().default('autobiomemory_consolidate'),
  preCompactionTimeoutMs: z.natural().default(20_000),
  shortTermInPrompt: z.boolean().default(true),
  shortTermPromptChars: z.natural().default(2400),
  config: z.dict(z.any()).default({}),
})

/** Adapter from the cordis logger to our own `Logger` seam. */
function bridgeLogger(ctx: Context, scope: string): Logger {
  const base = ctx.logger(scope) as unknown as {
    debug?: (...args: unknown[]) => void
    info?: (...args: unknown[]) => void
    warn?: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
  const call = (level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]) => {
    const suffix = args.length > 0 ? ` ${args.map((a) => safeString(a)).join(' ')}` : ''
    try {
      base[level]?.(`${message}${suffix}`)
    } catch {
      /* logging must never break the loop */
    }
  }
  return {
    debug: (message, ...args) => call('debug', message, args),
    info: (message, ...args) => call('info', message, args),
    warn: (message, ...args) => call('warn', message, args),
    error: (message, ...args) => call('error', message, args),
  }
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function statusList(input: unknown): EventStatus[] | undefined {
  if (!Array.isArray(input) || input.length === 0) return undefined
  const allowed: EventStatus[] = ['completed', 'partial', 'failed', 'ongoing', 'planned']
  const values = input.filter((entry): entry is EventStatus => allowed.includes(entry as EventStatus))
  return values.length > 0 ? values : undefined
}

function stringList(input: unknown): string[] | undefined {
  if (Array.isArray(input)) return input.filter((entry): entry is string => typeof entry === 'string')
  if (typeof input === 'string' && input.trim() !== '') {
    return input
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
  }
  return undefined
}

interface Runtime {
  paths: MemoryPaths
  config: MemoryConfig
  logger: Logger
  secrets: () => SecretSource
}

function loadRuntime(paths: MemoryPaths, logger: Logger, overrides: Record<string, unknown>): Runtime {
  ensureDataLayout(paths)
  const config = ensureConfig(paths, overrides as never)
  let cachedSecrets: SecretSource | undefined
  return {
    paths,
    config,
    logger,
    secrets: () => {
      cachedSecrets ??= readSecrets(paths)
      return cachedSecrets
    },
  }
}

/** Resolve the absolute transcript path of the session that owns this agent. */
function sessionFileFor(ctx: Context, agent: unknown): string | undefined {
  try {
    const session = (agent as { session?: { header?: unknown } } | undefined)?.session
    const header = session?.header
    if (!header) return undefined
    const persistence = ctx.get('sessionPersistence') as
      | { locate?: (meta: unknown) => { kind?: string; path?: string } | undefined }
      | undefined
    const located = persistence?.locate?.(header)
    if (located?.path && located.kind === 'jsonl') return located.path
    const envPath = process.env.DSH_SESSION_JSONL
    if (envPath && fs.existsSync(envPath)) return envPath
    return undefined
  } catch {
    return undefined
  }
}

function renderHits(result: RecallResult): string {
  return result.text
}

export function apply(ctx: Context, pluginConfig: PluginConfig = {}): void {
  const paths = memoryPaths(pluginConfig.dataRoot)
  const logger = bridgeLogger(ctx, name)

  let runtime: Runtime
  try {
    runtime = loadRuntime(paths, logger, pluginConfig.config ?? {})
  } catch (error) {
    logger.error('failed to initialise data root', safeString(error))
    return
  }

  const { config } = runtime
  logger.info(
    `AutoBioMemory ready · root=${runtime.paths.root} · auto=${pluginConfig.autoConsolidate !== false}`,
  )

  // ---------------------------------------------------------------- prompts
  let disposePrompt = () => {}
  if (pluginConfig.shortTermInPrompt !== false) {
    try {
      disposePrompt = ctx.systemPrompt.section({
        name: 'autobiomemory:short-term',
        order: 191,
        text: () => {
          try {
            const memory = shortTermMemory(runtime.paths, config.consolidation.recentEventLimit)
            if (memory.summaries.length === 0) {
              return [
                '## 自传体记忆（AutoBioMemory）',
                '我还没有任何已编码的经历。当我完成一段值得记住的工作后，可以用 `' +
                  pluginConfig.toolName +
                  '` 之外的整理机制补记；平时不必提及此机制。',
              ].join('\n')
            }
            const digest = truncate(
              memory.text,
              pluginConfig.shortTermPromptChars ?? 2400,
            )
            return [
              '## 自传体记忆（AutoBioMemory · 短时记忆）',
              '以下是我最近亲身经历的事件日记，按时间倒序。它们是我的记忆，不是用户提供的信息。',
              '',
              digest,
              '',
              `需要更早或更具体的经历时，调用 \`${pluginConfig.toolName}\`，用自然语言描述"我要回忆什么"，` +
                '可附带 since/until/people/tags/status 等结构化条件。只有调用了工具，才算查看了记忆。',
            ].join('\n')
          } catch (error) {
            logger.warn('short-term prompt failed', safeString(error))
            return ''
          }
        },
      })
    } catch (error) {
      logger.warn('prompt section registration failed', safeString(error))
    }
  }

  // ------------------------------------------------------------------ tools
  let disposeRecallTool: (() => void) | undefined
  try {
    disposeRecallTool = ctx.tools.register(
      defineTool({
        name: pluginConfig.toolName ?? 'autobiomemory_recall',
        description:
          '回忆我自己的过往经历（第一人称事件日记）。结合当前问题，先按结构化条件筛选，再做向量召回与重排，' +
          '返回相关日记正文及其来源（原始会话文件与记录区间）。当用户问“之前那次”“上次我们怎么做的”“还记得吗”，' +
          '或需要复用过去的做法、避免重复踩坑时调用。',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: '我要回忆什么，用自然语言描述当前问题或任务。',
          },
          since: { type: 'string', description: '起始时间（ISO 8601，含当天）。' },
          until: { type: 'string', description: '结束时间（ISO 8601，含当天）。' },
          people: { type: 'array', items: { type: 'string' }, description: '相关人物（我/用户/他人）。' },
          tags: { type: 'array', items: { type: 'string' }, description: '事件标签。' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关键词。' },
          status: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['completed', 'partial', 'failed', 'ongoing', 'planned'],
            },
            description: '完成状态筛选。',
          },
          limit: { type: 'number', description: '最多返回多少条记忆，默认取配置值。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string', required: true },
              hits: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    eventId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    occurredAt: { type: 'string', required: true },
                    status: { type: 'string', required: true },
                  },
                },
              },
              stages: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  shortTerm: { type: 'number' },
                  structured: { type: 'number' },
                  vector: { type: 'number' },
                  rerank: { type: 'number' },
                },
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: value.text }],
          presentationMeta: (_args, value) => ({
            title: `回忆 · ${value.hits?.length ?? 0} 条`,
            hits: value.hits?.length ?? 0,
          }),
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const query: RecallQuery = {
            query: String(args.query ?? ''),
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            filters: {
              since: typeof args.since === 'string' ? args.since : undefined,
              until: typeof args.until === 'string' ? args.until : undefined,
              people: stringList(args.people),
              tags: stringList(args.tags),
              keywords: stringList(args.keywords),
              status: statusList(args.status),
            },
          }
          const summaries = listEventSummaries(runtime.paths, { refresh: true })
          let store: VectorStore | undefined
          try {
            store = new VectorStore(runtime.paths.vectorDb)
            const secrets = runtime.secrets()
            const embedder = secrets.dashscopeApiKey
              ? createEmbedder(config.dashscope, requireSecret(secrets, 'dashscope'), logger)
              : undefined
            const reranker = secrets.dashscopeApiKey
              ? createReranker(config.dashscope, requireSecret(secrets, 'dashscope'), logger)
              : undefined
            const result = await recall(
              {
                config,
                summaries,
                readRecord: (id) => readEvent(runtime.paths, id),
                vectors: store,
                ...(embedder === undefined ? {} : { embedder }),
                ...(reranker === undefined ? {} : { reranker }),
                logger,
                signal: exec.signal,
              },
              query,
            )
            logger.debug(`recall "${truncate(query.query, 40)}" → ${result.hits.length} hits`)
            return {
              text: renderHits(result),
              hits: result.hits.map((hit) => ({
                eventId: hit.eventId,
                title: hit.title,
                occurredAt: hit.occurredAt,
                status: hit.status,
              })),
              stages: result.stages,
            }
          } catch (error) {
            logger.warn('recall failed', safeString(error))
            return {
              text: `记忆检索失败：${safeString(error)}`,
              hits: [],
              stages: { shortTerm: 0, structured: 0, vector: 0, rerank: 0 },
            }
          } finally {
            store?.close()
          }
        },
      }),
    )
  } catch (error) {
    logger.error('recall tool registration failed', safeString(error))
  }

  let disposeConsolidateTool: (() => void) | undefined
  const consolidateTool = pluginConfig.consolidateToolName ?? ''
  if (consolidateTool !== '') {
    try {
      disposeConsolidateTool = ctx.tools.register(
        defineTool({
          name: consolidateTool,
          description:
            '立刻整理并固化我最近的经历（把原始会话增量编码成第一人称事件日记与向量索引）。' +
            '通常不需要手动调用——上下文压缩前会自动整理；只有在明确想"记住刚才这件事"或排查记忆缺失时使用。',
          parameters: {
            force: { type: 'boolean', description: '忽略冷却时间立即整理。' },
            sessionFile: { type: 'string', description: '只整理指定的会话文件（绝对路径）。' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                written: { type: 'number', required: true },
                skipped: { type: 'number', required: true },
                failed: { type: 'number', required: true },
              },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
          },
          isConcurrencySafe: () => false,
          async execute(args, exec) {
            if (isConsolidating()) {
              return { text: '已有一轮整理正在进行，请稍后再试。', written: 0, skipped: 0, failed: 0 }
            }
            const sessionFile =
              typeof args.sessionFile === 'string' && args.sessionFile !== ''
                ? args.sessionFile
                : sessionFileFor(ctx, exec.agent)
            const result = await consolidateOnce({
              paths: runtime.paths,
              config,
              secrets: runtime.secrets(),
              logger,
              currentSessionFile: sessionFile,
              force: args.force === true,
              signal: exec.signal,
            })
            const text = [
              `整理完成：新增 ${result.eventsWritten} 个事件，跳过 ${result.eventsSkipped}，失败 ${result.eventsFailed}，向量 ${result.embedded}。`,
              result.aborted ? `（提前结束：${result.aborted}）` : '',
              ...result.details.slice(0, 8).map((line) => `- ${line}`),
            ]
              .filter((line) => line !== '')
              .join('\n')
            return {
              text,
              written: result.eventsWritten,
              skipped: result.eventsSkipped,
              failed: result.eventsFailed + result.embedFailed,
            }
          },
        }),
      )
    } catch (error) {
      logger.error('consolidate tool registration failed', safeString(error))
    }
  }

  // --------------------------------------------------------------- triggers
  const auto = pluginConfig.autoConsolidate !== false
  const timeoutMs = pluginConfig.preCompactionTimeoutMs ?? 20_000

  const runConsolidation = async (agent: unknown, reason: string): Promise<void> => {
    if (!auto || isConsolidating()) return
    const sessionFile = sessionFileFor(ctx, agent)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    try {
      const result = await consolidateOnce({
        paths: runtime.paths,
        config,
        secrets: runtime.secrets(),
        logger,
        currentSessionFile: sessionFile,
        signal: controller.signal,
      })
      logger.debug(
        `auto consolidation (${reason}) in ${Date.now() - started}ms: ` +
          `${result.eventsWritten} written, ${result.embedded} embedded`,
      )
    } catch (error) {
      logger.warn(`auto consolidation (${reason}) failed: ${safeString(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // The harness's real pre-compaction seam: `compaction-basic` runs `compactIfNeeded()` from its
  // own `agent/pre-step` listener, so a prepended listener observes the moment before it decides.
  ctx.on(
    'agent/pre-step',
    async ({ agent }, next) => {
      await runConsolidation(agent, 'pre-step')
      return next()
    },
    { prepend: true },
  )

  // Belt and braces: `compaction/start` is a durable session event written before summarization.
  ctx.on('session/event', (session, event) => {
    // `compaction/*` arrives through declaration merging from @deepseek-ai/dsh-compaction,
    // which may not be installed in every profile: compare on the widened type.
    if ((event?.type as string | undefined) !== 'compaction/start') return
    const agent = (session as { agent?: unknown } | undefined)?.agent
    void runConsolidation(agent, 'compaction/start')
  })

  if (pluginConfig.consolidateOnIdle === true) {
    ctx.on(
      'agent/status',
      ({ agent, status }: { agent: unknown; status?: string }) => {
        if (status === 'idle') void runConsolidation(agent, 'idle')
      },
    )
  }

  // Warm the index metadata once so the first recall is fast (and so a broken data root is
  // reported at load time rather than mid-turn).
  try {
    const summaries = listEventSummaries(paths)
    logger.info(
      `memory index: ${summaries.length} events · index=${path.basename(eventIndexPath(paths))} · ` +
        `deepseek=${maskSecret(runtime.secrets().deepseekApiKey)} dashscope=${maskSecret(runtime.secrets().dashscopeApiKey)}`,
    )
  } catch (error) {
    logger.warn('memory index warm-up failed', safeString(error))
  }

  ctx.effect(() => () => {
    disposePrompt()
    disposeRecallTool?.()
    disposeConsolidateTool?.()
  })
}

export default { name, inject, Config, apply }
