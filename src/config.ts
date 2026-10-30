/** AutoBioMemory — `config.json`: defaults, merge, validation. */

import fs from 'node:fs'
import path from 'node:path'

import { BEIJING_BASE_URL, INTL_BASE_URL } from './constants.js'
import { expandHome } from './paths.js'
import { clampNumber, ensureDir, readJsonFile, writeJsonFile } from './util.js'
import type { MemoryConfig, MemoryPaths } from './types.js'

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K]
}

/** Defaults every install starts from. */
export function defaultConfig(dataRoot?: string): MemoryConfig {
  return {
    version: 1,
    dataRoot: dataRoot ?? '',
    session: {
      readDirs: ['~/.dsh/sessions'],
      includeGlobs: ['**/session.jsonl.zstd', '**/session.jsonl'],
      excludeGlobs: [],
      minRecordsPerEvent: 2,
      maxRecordsPerEvent: 200,
      tailRecords: 6,
    },
    consolidation: {
      maxInputChars: 60_000,
      minEventChars: 120,
      maxEventsPerRun: 12,
      recentEventLimit: 20,
      cooldownMs: 60_000,
      serialize: true,
      maxSpanAttempts: 3,
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.4,
      maxTokens: 8000,
      timeoutMs: 240_000,
      jsonMode: true,
      retries: 3,
    },
    dashscope: {
      region: 'beijing',
      baseUrl: BEIJING_BASE_URL,
      embeddingModel: 'text-embedding-v4',
      embeddingDimensions: 1024,
      embeddingBatchSize: 8,
      rerankModel: 'gte-rerank-v2',
      rerankTopN: 20,
      rerankEnabled: true,
      timeoutMs: 60_000,
      retries: 3,
    },
    retrieval: {
      candidateLimit: 200,
      vectorTopK: 30,
      rerankTopN: 8,
      finalLimit: 5,
      shortTermCount: 8,
      includeSources: true,
      minScore: 0,
      maxReplyChars: 6000,
    },
    trigger: {
      onCompaction: true,
      onTurnEnd: false,
      onSessionStart: false,
      toolName: 'autobiomemory_recall',
      globalCooldownMs: 120_000,
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep merge: objects recurse, arrays replace, `undefined` leaves the base value alone. */
export function mergeConfig(base: MemoryConfig, patch?: DeepPartial<MemoryConfig>): MemoryConfig {
  if (!patch) return structuredClone(base)
  const merge = (target: unknown, source: unknown): unknown => {
    if (source === undefined) return target
    if (Array.isArray(source)) return [...source]
    if (isPlainObject(source)) {
      const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {}
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue
        out[key] = key in out ? merge(out[key], value) : merge(undefined, value)
      }
      return out
    }
    return source
  }
  return merge(structuredClone(base), patch) as MemoryConfig
}

/** Human-readable problems; an empty array means the config is usable. */
export function validateConfig(config: MemoryConfig): string[] {
  const problems: string[] = []
  const httpUrl = (value: unknown): boolean => {
    if (typeof value !== 'string') return false
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  if (!Array.isArray(config.session?.readDirs) || config.session.readDirs.length === 0) {
    problems.push('session.readDirs 不能为空：至少配置一个原始会话读取目录')
  }
  if (!httpUrl(config.deepseek?.baseUrl)) problems.push('deepseek.baseUrl 必须是 http(s) 地址')
  if (!httpUrl(config.dashscope?.baseUrl)) problems.push('dashscope.baseUrl 必须是 http(s) 地址')

  const dims = config.dashscope?.embeddingDimensions
  if (typeof dims !== 'number' || !Number.isFinite(dims) || dims < 64 || dims > 2048) {
    problems.push('dashscope.embeddingDimensions 必须在 64..2048 之间')
  }

  const minRecords = config.session?.minRecordsPerEvent
  const maxRecords = config.session?.maxRecordsPerEvent
  if (typeof minRecords !== 'number' || minRecords < 1) {
    problems.push('session.minRecordsPerEvent 必须 ≥ 1')
  }
  if (typeof maxRecords !== 'number' || (typeof minRecords === 'number' && maxRecords < minRecords)) {
    problems.push('session.maxRecordsPerEvent 必须 ≥ session.minRecordsPerEvent')
  }

  const nonNegative: Array<[string, unknown]> = [
    ['session.tailRecords', config.session?.tailRecords],
    ['consolidation.maxInputChars', config.consolidation?.maxInputChars],
    ['consolidation.minEventChars', config.consolidation?.minEventChars],
    ['consolidation.maxEventsPerRun', config.consolidation?.maxEventsPerRun],
    ['consolidation.recentEventLimit', config.consolidation?.recentEventLimit],
    ['consolidation.cooldownMs', config.consolidation?.cooldownMs],
    ['consolidation.maxSpanAttempts', config.consolidation?.maxSpanAttempts],
    ['retrieval.candidateLimit', config.retrieval?.candidateLimit],
    ['retrieval.vectorTopK', config.retrieval?.vectorTopK],
    ['retrieval.rerankTopN', config.retrieval?.rerankTopN],
    ['retrieval.finalLimit', config.retrieval?.finalLimit],
    ['retrieval.shortTermCount', config.retrieval?.shortTermCount],
    ['retrieval.maxReplyChars', config.retrieval?.maxReplyChars],
    ['deepseek.maxTokens', config.deepseek?.maxTokens],
    ['deepseek.timeoutMs', config.deepseek?.timeoutMs],
    ['dashscope.embeddingBatchSize', config.dashscope?.embeddingBatchSize],
    ['dashscope.timeoutMs', config.dashscope?.timeoutMs],
  ]
  for (const [label, value] of nonNegative) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      problems.push(`${label} 必须是非负数`)
    }
  }
  if (typeof config.dashscope?.rerankTopN === 'number' && config.dashscope.rerankTopN < 1) {
    problems.push('dashscope.rerankTopN 必须 ≥ 1')
  }
  if (typeof config.retrieval?.finalLimit === 'number' && config.retrieval.finalLimit < 1) {
    problems.push('retrieval.finalLimit 必须 ≥ 1')
  }
  if (typeof config.session?.includeGlobs !== 'undefined' && !Array.isArray(config.session.includeGlobs)) {
    problems.push('session.includeGlobs 必须是数组')
  }
  return problems
}

/** Read `<root>/config.json`, falling back to defaults, then apply a patch. */
export function loadConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig {
  const base = defaultConfig(paths.root)
  const onDisk = readJsonFile<Record<string, unknown>>(paths.configFile)
  const withDisk = onDisk && isPlainObject(onDisk) ? mergeConfig(base, onDisk as never) : base
  const merged = mergeConfig({ ...withDisk, dataRoot: paths.root }, patch)
  merged.dataRoot = paths.root
  return hydrate(merged)
}

/** Create `config.json` when it is missing; always returns the effective config. */
export function ensureConfig(paths: MemoryPaths, patch?: DeepPartial<MemoryConfig>): MemoryConfig {
  const config = loadConfig(paths, patch)
  if (!fs.existsSync(paths.configFile)) writeConfig(paths, config)
  return config
}

export function writeConfig(paths: MemoryPaths, config: MemoryConfig): void {
  ensureDir(path.dirname(paths.configFile))
  writeJsonFile(paths.configFile, { ...config, dataRoot: paths.root })
}

/** Clamp numeric knobs that came from a hand-edited file. */
function hydrate(config: MemoryConfig): MemoryConfig {
  config.dashscope.embeddingDimensions = Math.round(
    clampNumber(config.dashscope.embeddingDimensions, 64, 2048),
  )
  config.dashscope.embeddingBatchSize = Math.round(clampNumber(config.dashscope.embeddingBatchSize, 1, 64))
  config.deepseek.temperature = clampNumber(config.deepseek.temperature, 0, 2)
  config.retrieval.minScore = clampNumber(config.retrieval.minScore, -1, 1)
  if (config.dashscope.region === 'intl' && config.dashscope.baseUrl === BEIJING_BASE_URL) {
    config.dashscope.baseUrl = INTL_BASE_URL
  }
  return config
}

/** Absolute, de-duplicated session directories (`~` expanded, relative resolved). */
export function expandSessionDirs(config: MemoryConfig, cwd: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of config.session?.readDirs ?? []) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const expanded = expandHome(trimmed)
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    out.push(absolute)
  }
  return out
}
