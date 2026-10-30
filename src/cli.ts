#!/usr/bin/env node
/**
 * AutoBioMemory — command line interface.
 *
 *   autobiomemory init          create the data root, config.json and .env
 *   autobiomemory config        show or patch config.json
 *   autobiomemory status        cursors, event counts, vectors, failures
 *   autobiomemory consolidate   run one incremental consolidation pass
 *   autobiomemory recall        ask a question of the memory
 *   autobiomemory embed         backfill / refresh the vector index
 *   autobiomemory repair        fix JSON/MD pairing problems
 *   autobiomemory doctor        end-to-end health checks
 *   autobiomemory short-term    print the short-term memory digest
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defaultConfig, ensureConfig, expandSessionDirs, loadConfig, writeConfig } from './config.js'
import { consolidate } from './consolidate.js'
import { createEmbedder, createReranker, embedOne } from './embed.js'
import { parseDotEnv, readSecrets, requireSecret, writeEnvFile } from './env.js'
import { createLogger } from './logger.js'
import { ensureDataLayout, memoryPaths, resolveDataRoot, type MemoryPaths } from './paths.js'
import { recall, parseFilterArguments } from './retrieval.js'
import {
  listEventSummaries,
  readEvent,
  repairPairs,
  shortTermMemory,
} from './store.js'
import { loadCursor, loadRunState } from './state.js'
import { VectorStore, staleEventIds, missingEventIds, vectorNorm } from './vectors.js'
import { maskSecret, nowIso, sha256, truncate } from './util.js'
import { validateConfig, mergeConfig } from './config.js'
import type { RecallFilters } from './types.js'

const VERSION = '0.1.0'

interface Args {
  command: string
  positional: string[]
  flags: Map<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=')
      const key = rawKey ?? ''
      if (inline !== undefined) {
        flags.set(key, inline)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next)
          i += 1
        } else {
          flags.set(key, true)
        }
      }
    } else {
      positional.push(token)
    }
  }
  return { command: positional.shift() ?? 'help', positional, flags }
}

function flagString(args: Args, key: string): string | undefined {
  const value = args.flags.get(key)
  return typeof value === 'string' ? value : undefined
}

function flagBool(args: Args, key: string): boolean {
  return args.flags.has(key)
}

function flagNumber(args: Args, key: string): number | undefined {
  const raw = flagString(args, key)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function setup(args: Args) {
  const root = resolveDataRoot(flagString(args, 'root'))
  const paths = memoryPaths(root)
  const verbose = flagBool(args, 'verbose') || flagBool(args, 'debug')
  const logger = createLogger({ level: verbose ? 'debug' : 'warn', scope: 'cli' })
  return { paths, root, logger, verbose }
}

function printHelp(): void {
  process.stdout.write(`AutoBioMemory ${VERSION} — 自传体记忆

用法：
  autobiomemory <command> [options]

命令：
  init        初始化数据根目录（config.json / .env / events / vectors / state）
  config      查看或修改 config.json（--set key=value，可重复；--json）
  status      查看游标、事件数、向量数、失败队列
  consolidate 执行一次增量整理（--force --dry-run --session <file>）
  recall <q>  回忆（--since --until --tag --status --limit --json）
  embed       回填或刷新向量索引（--stale --missing --force）
  repair      修复 JSON/MD 配对（--dry-run）
  doctor      健康检查（--json）
  short-term  打印短时记忆摘要（--limit n）

通用选项：
  --root <dir>   数据根目录（默认 ~/.autobiomemory，或 $DSH_AUTOBIO_ROOT）
  --verbose      输出调试日志
`)
}

/** Best-effort copy of the harness keys into `<root>/.env`. */
function importHarnessSecrets(paths: MemoryPaths): { deepseek: boolean; dashscope: boolean; source: string } {
  const candidates = [
    path.join(os.homedir(), '.dsh', '.env'),
    path.join(process.cwd(), '.env'),
  ]
  let deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? ''
  let dashscopeApiKey = process.env.DASHSCOPE_API_KEY ?? ''
  let source = 'process-env'
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'))
    deepseekApiKey ||= parsed.DEEPSEEK_API_KEY ?? ''
    dashscopeApiKey ||= parsed.DASHSCOPE_API_KEY ?? ''
    source = file
    break
  }
  if (!deepseekApiKey && !dashscopeApiKey) return { deepseek: false, dashscope: false, source: 'none' }
  writeEnvFile(
    paths,
    { deepseekApiKey: deepseekApiKey || 'MISSING', dashscopeApiKey: dashscopeApiKey || 'MISSING' },
    { overwrite: true },
  )
  return { deepseek: deepseekApiKey !== '', dashscope: dashscopeApiKey !== '', source }
}

function setByPath(target: Record<string, unknown>, keyPath: string, rawValue: string): void {
  const segments = keyPath.split('.').filter((segment) => segment !== '')
  if (segments.length === 0) throw new Error('空的配置键')
  let node = target
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  const leaf = segments[segments.length - 1] as string
  let value: unknown = rawValue
  const trimmed = rawValue.trim()
  if (trimmed === 'true' || trimmed === 'false') value = trimmed === 'true'
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) value = Number(trimmed)
  else if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      value = JSON.parse(trimmed)
    } catch {
      value = rawValue
    }
  }
  node[leaf] = value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const { paths, logger } = setup(args)

  switch (args.command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return 0

    case 'version':
    case '--version':
      process.stdout.write(`${VERSION}\n`)
      return 0

    case 'init': {
      ensureDataLayout(paths)
      const config = ensureConfig(paths)
      const imported = importHarnessSecrets(paths)
      const secrets = readSecrets(paths)
      process.stdout.write(
        [
          `数据根目录：${paths.root}`,
          `配置文件　：${paths.configFile}`,
          `密钥文件　：${paths.envFile}`,
          `事件目录　：${paths.eventsDir}`,
          `向量目录　：${paths.vectorsDir}`,
          `状态目录　：${paths.stateDir}`,
          '',
          `DeepSeek key : ${maskSecret(secrets.deepseekApiKey)} (${secrets.origin.deepseek})`,
          `DashScope key: ${maskSecret(secrets.dashscopeApiKey)} (${secrets.origin.dashscope})`,
          imported.source !== 'none' && imported.source !== 'process-env'
            ? `已从 ${imported.source} 导入密钥`
            : '',
          '',
          `会话读取目录：${expandSessionDirs(config, process.cwd()).join(', ') || '(未配置)'}`,
          '下一步：autobiomemory doctor，然后 autobiomemory consolidate --force',
        ]
          .filter((line) => line !== '')
          .join('\n') + '\n',
      )
      return 0
    }

    case 'config': {
      ensureDataLayout(paths)
      const assignments: Array<[string, string]> = []
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--set' && argv[i + 1]) {
          const pair = argv[i + 1] as string
          const eq = pair.indexOf('=')
          if (eq > 0) assignments.push([pair.slice(0, eq), pair.slice(eq + 1)])
        }
      }
      if (assignments.length > 0) {
        const current = loadConfig(paths)
        const raw = JSON.parse(JSON.stringify(current)) as Record<string, unknown>
        for (const [key, value] of assignments) setByPath(raw, key, value)
        const merged = mergeConfig(defaultConfig(paths.root), raw as never)
        const problems = validateConfig(merged)
        if (problems.length > 0) {
          process.stderr.write(`配置无效：\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
          return 2
        }
        writeConfig(paths, merged)
        process.stdout.write(`已更新 ${paths.configFile}\n`)
      }
      const config = loadConfig(paths)
      if (flagBool(args, 'json')) {
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
      } else {
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
      }
      const problems = validateConfig(config)
      if (problems.length > 0) {
        process.stderr.write(`警告：\n${problems.map((p) => `  - ${p}`).join('\n')}\n`)
      }
      return 0
    }

    case 'status': {
      ensureDataLayout(paths)
      const config = loadConfig(paths)
      const cursor = loadCursor(paths)
      const run = loadRunState(paths)
      const summaries = listEventSummaries(paths, { refresh: true })
      let vectorCount = 0
      let dominantModel: string | undefined
      try {
        const store = new VectorStore(paths.vectorDb)
        vectorCount = store.count()
        dominantModel = store.modelOf()
        store.close()
      } catch {
        vectorCount = -1
      }
      const payload = {
        root: paths.root,
        events: summaries.length,
        vectors: vectorCount,
        vectorModel: dominantModel ?? null,
        sessions: Object.values(cursor.sessions).map((entry) => ({
          sessionFile: entry.sessionFile,
          processedRecords: entry.processedRecords,
          fileSize: entry.fileSize,
          updatedAt: entry.updatedAt,
        })),
        lastRunAt: run.lastRunAt ?? null,
        totals: run.totals,
        failures: Object.values(run.failures),
        config: {
          sessions: expandSessionDirs(config, process.cwd()),
          deepseek: { model: config.deepseek.model, baseUrl: config.deepseek.baseUrl },
          dashscope: {
            region: config.dashscope.region,
            embeddingModel: config.dashscope.embeddingModel,
            dimensions: config.dashscope.embeddingDimensions,
            rerankModel: config.dashscope.rerankModel,
          },
        },
      }
      if (flagBool(args, 'json')) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        return 0
      }
      const last = summaries[0]
      process.stdout.write(
        [
          `数据根目录   ：${paths.root}`,
          `事件数　　　 ：${summaries.length}${last ? `（最新 ${last.occurredAt} · ${truncate(last.title, 30)}）` : ''}`,
          `向量数　　　 ：${vectorCount}${dominantModel ? `（${dominantModel}）` : ''}`,
          `会话游标　　 ：${payload.sessions.length} 个`,
          `上次整理　　 ：${payload.lastRunAt ?? '从未'}`,
          `累计         ：事件 ${run.totals.events} · 向量 ${run.totals.embedded} · 运行 ${run.totals.runs}`,
          payload.failures.length > 0
            ? `失败队列     ：${payload.failures.length} 条（下次重试最早 ${payload.failures[0]?.nextAttemptAt}）`
            : '失败队列     ：空',
          '',
          ...payload.sessions.map(
            (session) =>
              `  · ${path.basename(path.dirname(session.sessionFile))} — 已处理 ${session.processedRecords} 条记录 / ${session.fileSize} 字节`,
          ),
        ].join('\n') + '\n',
      )
      return 0
    }

    case 'consolidate': {
      ensureDataLayout(paths)
      const config = ensureConfig(paths)
      const secrets = readSecrets(paths)
      const dryRun = flagBool(args, 'dry-run')
      const result = await consolidate({
        paths,
        config,
        secrets,
        logger,
        currentSessionFile: flagString(args, 'session'),
        force: flagBool(args, 'force'),
        dryRun,
      })
      if (flagBool(args, 'json')) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        process.stdout.write(
          [
            `整理${dryRun ? '（dry-run）' : ''}：新增 ${result.eventsWritten} · 跳过 ${result.eventsSkipped} · 失败 ${result.eventsFailed} · 向量 ${result.embedded}`,
            result.aborted ? `提前结束：${result.aborted}` : '',
            ...result.details.map((line) => `  - ${line}`),
          ]
            .filter((line) => line !== '')
            .join('\n') + '\n',
        )
      }
      return result.eventsFailed + result.embedFailed > 0 ? 1 : 0
    }

    case 'recall': {
      const config = ensureConfig(paths)
      const secrets = readSecrets(paths)
      const query = args.positional.join(' ').trim()
      const filters: RecallFilters = parseFilterArguments({
        since: flagString(args, 'since'),
        until: flagString(args, 'until'),
        people: flagString(args, 'people'),
        tags: flagString(args, 'tag'),
        keywords: flagString(args, 'keyword'),
        status: flagString(args, 'status'),
        text: flagString(args, 'text'),
        entities: flagString(args, 'entity'),
      })
      const summaries = listEventSummaries(paths, { refresh: true })
      const store = new VectorStore(paths.vectorDb)
      const embedder = secrets.dashscopeApiKey
        ? createEmbedder(config.dashscope, requireSecret(secrets, 'dashscope'), logger)
        : undefined
      const reranker = secrets.dashscopeApiKey
        ? createReranker(config.dashscope, requireSecret(secrets, 'dashscope'), logger)
        : undefined
      try {
        const result = await recall({
          config,
          summaries,
          readRecord: (id) => readEvent(paths, id),
          vectors: store,
          embedder,
          reranker,
          logger,
        }, { query, filters, limit: flagNumber(args, 'limit') })
        if (flagBool(args, 'json')) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        } else {
          process.stdout.write(`${result.text}\n`)
        }
      } finally {
        store.close()
      }
      return 0
    }

    case 'embed': {
      const config = ensureConfig(paths)
      const secrets = readSecrets(paths)
      const embedder = createEmbedder(
        config.dashscope,
        requireSecret(secrets, 'dashscope'),
        logger,
      )
      const summaries = listEventSummaries(paths, { refresh: true })
      const store = new VectorStore(paths.vectorDb)
      const targets = new Map<string, 'stale' | 'missing'>()
      if (flagBool(args, 'force')) {
        for (const summary of summaries) targets.set(summary.id, 'stale')
      } else {
        for (const id of missingEventIds(store, summaries)) targets.set(id, 'missing')
        for (const id of staleEventIds(store, summaries)) targets.set(id, 'stale')
      }
      let ok = 0
      let failed = 0
      try {
        for (const [eventId, kind] of targets) {
          const record = readEvent(paths, eventId)
          if (!record) continue
          try {
            const vector = await embedOne(embedder, record.diary)
            store.upsert([
              {
                eventId,
                model: embedder.model,
                dimensions: vector.length,
                textHash: sha256(record.diary),
                vector,
                norm: vectorNorm(vector),
                updatedAt: nowIso(),
              },
            ])
            ok += 1
            if (flagBool(args, 'verbose')) {
              process.stdout.write(`  ✓ ${eventId} (${kind})\n`)
            }
          } catch (error) {
            failed += 1
            process.stderr.write(`  ✗ ${eventId}: ${error instanceof Error ? error.message : String(error)}\n`)
          }
        }
      } finally {
        store.close()
      }
      process.stdout.write(`向量索引：写入 ${ok}，失败 ${failed}，跳过 ${summaries.length - targets.size}\n`)
      return failed > 0 ? 1 : 0
    }

    case 'repair': {
      ensureDataLayout(paths)
      const dryRun = flagBool(args, 'dry-run')
      if (dryRun) {
        const summaries = listEventSummaries(paths, { refresh: true })
        const broken = summaries.filter((summary) => summary.problem !== undefined)
        process.stdout.write(
          broken.length === 0
            ? '配对检查：全部一致\n'
            : `配对问题 ${broken.length} 条：\n${broken.map((s) => `  · ${s.id} — ${s.problem}`).join('\n')}\n`,
        )
        return broken.length === 0 ? 0 : 1
      }
      const result = repairPairs(paths)
      process.stdout.write(
        [
          `修复完成：重建 ${result.repaired.length}，隔离 ${result.quarantined.length}，跳过 ${result.skipped.length}`,
          ...result.repaired.map((id) => `  ✓ 重建 ${id}`),
          ...result.quarantined.map((id) => `  ⚠ 隔离 ${id}`),
        ].join('\n') + '\n',
      )
      return 0
    }

    case 'doctor': {
      const checks: Array<{ name: string; ok: boolean; detail: string }> = []
      const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })

      push('数据根目录', fs.existsSync(paths.root), paths.root)
      push('config.json', fs.existsSync(paths.configFile), paths.configFile)
      push('.env', fs.existsSync(paths.envFile), paths.envFile)

      const config = loadConfig(paths)
      const problems = validateConfig(config)
      push('配置校验', problems.length === 0, problems.length === 0 ? '通过' : problems.join('；'))

      const secrets = readSecrets(paths)
      push(
        'DeepSeek key',
        Boolean(secrets.deepseekApiKey),
        `${maskSecret(secrets.deepseekApiKey)} (${secrets.origin.deepseek})`,
      )
      push(
        'DashScope key',
        Boolean(secrets.dashscopeApiKey),
        `${maskSecret(secrets.dashscopeApiKey)} (${secrets.origin.dashscope})`,
      )

      const dirs = expandSessionDirs(config, process.cwd())
      const dirStates = dirs.map((dir) => `${dir}:${fs.existsSync(dir) ? '存在' : '缺失'}`)
      push(
        '会话读取目录',
        dirs.length > 0 && dirs.some((dir) => fs.existsSync(dir)),
        dirStates.join('；') || '(未配置)',
      )

      if (secrets.deepseekApiKey) {
        try {
          const response = await fetch(`${config.deepseek.baseUrl.replace(/\/$/u, '')}/models`, {
            headers: { Authorization: `Bearer ${secrets.deepseekApiKey}` },
            signal: AbortSignal.timeout(10_000),
          })
          push('DeepSeek 连通性', response.ok, `HTTP ${response.status}`)
        } catch (error) {
          push('DeepSeek 连通性', false, error instanceof Error ? error.message : String(error))
        }
      } else {
        push('DeepSeek 连通性', false, '缺少密钥')
      }

      if (secrets.dashscopeApiKey) {
        try {
          const embedder = createEmbedder(config.dashscope, secrets.dashscopeApiKey, logger)
          const vector = await embedder.embed(['记忆自检'])
          push(
            'DashScope embedding',
            vector[0]?.length === config.dashscope.embeddingDimensions,
            `${config.dashscope.embeddingModel} · ${vector[0]?.length ?? 0}d`,
          )
        } catch (error) {
          push('DashScope embedding', false, error instanceof Error ? error.message : String(error))
        }
        if (config.dashscope.rerankEnabled) {
          try {
            const reranker = createReranker(config.dashscope, secrets.dashscopeApiKey, logger)
            const ranked = await reranker.rerank('记忆', ['我整理了今天的日记', '今天天气不错'], 2)
            push('DashScope rerank', ranked.length > 0, `${config.dashscope.rerankModel} · ${ranked.length} 条`)
          } catch (error) {
            push('DashScope rerank', false, error instanceof Error ? error.message : String(error))
          }
        }
      } else {
        push('DashScope embedding', false, '缺少密钥')
      }

      const summaries = listEventSummaries(paths, { refresh: true })
      try {
        const store = new VectorStore(paths.vectorDb)
        const count = store.count()
        store.close()
        push('向量索引', fs.existsSync(paths.vectorDb), `${count} 行 / ${summaries.length} 事件`)
      } catch (error) {
        push('向量索引', false, error instanceof Error ? error.message : String(error))
      }

      const broken = summaries.filter((summary) => summary.problem !== undefined)
      push('JSON/MD 配对', broken.length === 0, broken.length === 0 ? '一致' : `${broken.length} 条异常`)

      const cursor = loadCursor(paths)
      const stale = Object.values(cursor.sessions).filter((entry) => {
        try {
          return fs.statSync(entry.sessionFile).size > entry.fileSize
        } catch {
          return true
        }
      })
      push('处理游标', true, `${Object.keys(cursor.sessions).length} 个会话，${stale.length} 个有待处理内容`)

      if (flagBool(args, 'json')) {
        process.stdout.write(`${JSON.stringify({ root: paths.root, checks }, null, 2)}\n`)
      } else {
        process.stdout.write(
          [
            `AutoBioMemory doctor — ${paths.root}`,
            ...checks.map((check) => `  ${check.ok ? '✓' : '✗'} ${check.name}：${check.detail}`),
            '',
            checks.every((check) => check.ok)
              ? '全部检查通过。'
              : '存在问题：请按上面 ✗ 的提示修复（常见：.env 缺密钥、会话目录不存在、向量未回填）。',
          ].join('\n') + '\n',
        )
      }
      return checks.every((check) => check.ok) ? 0 : 1
    }

    case 'short-term': {
      const config = loadConfig(paths)
      const limit = flagNumber(args, 'limit') ?? config.consolidation.recentEventLimit
      const memory = shortTermMemory(paths, limit)
      if (flagBool(args, 'json')) {
        process.stdout.write(`${JSON.stringify(memory, null, 2)}\n`)
      } else {
        process.stdout.write(`${memory.text}\n`)
      }
      return 0
    }

    default:
      process.stderr.write(`未知命令：${args.command}\n\n`)
      printHelp()
      return 2
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 1
  })
