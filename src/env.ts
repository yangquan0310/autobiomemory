/** AutoBioMemory — the two API keys, kept in `<root>/.env`. */

import fs from 'node:fs'
import path from 'node:path'

import { ENV_KEYS, FILES } from './constants.js'
import { ensureDir } from './util.js'
import type { MemoryPaths, SecretSource } from './types.js'

export type { SecretSource } from './types.js'

/** Parse a dotenv file: `KEY=VALUE`, `export KEY=VALUE`, quotes and comments. */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trim()
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1)
      value = end > 0 ? value.slice(1, end) : value.slice(1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    values[key] = value
  }
  return values
}

function fileSecrets(file: string): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve both keys.
 *
 * Precedence per key: `<root>/.env` → `AUTOBIO_*` process variable → plain process variable.
 * The data root wins so it stays the single source of truth for this module.
 */
export function readSecrets(paths: MemoryPaths, processEnv: NodeJS.ProcessEnv = process.env): SecretSource {
  const fromFile = fileSecrets(paths.envFile)
  const result: SecretSource = {
    origin: { deepseek: 'missing', dashscope: 'missing' },
  }

  const deepseek = [ENV_KEYS.deepseek[0], ENV_KEYS.deepseek[1]] as const
  const dashscope = [ENV_KEYS.dashscope[0], ENV_KEYS.dashscope[1]] as const

  for (const key of deepseek) {
    const fileValue = fromFile[key]
    if (fileValue) {
      result.deepseekApiKey = fileValue
      result.origin.deepseek = '.env'
      break
    }
  }
  if (!result.deepseekApiKey) {
    for (const key of [...deepseek].reverse()) {
      const value = processEnv[key]
      if (value && value.trim() !== '') {
        result.deepseekApiKey = value.trim()
        result.origin.deepseek = 'process'
        break
      }
    }
  }

  for (const key of dashscope) {
    const fileValue = fromFile[key]
    if (fileValue) {
      result.dashscopeApiKey = fileValue
      result.origin.dashscope = '.env'
      break
    }
  }
  if (!result.dashscopeApiKey) {
    for (const key of [...dashscope].reverse()) {
      const value = processEnv[key]
      if (value && value.trim() !== '') {
        result.dashscopeApiKey = value.trim()
        result.origin.dashscope = 'process'
        break
      }
    }
  }

  return result
}

/**
 * Write both keys into `<root>/.env` with 0600 permissions.
 *
 * When the file already exists and `overwrite` is allowed, unrelated lines and comments are
 * preserved and only the two keys are rewritten in place.
 */
export function writeEnvFile(
  paths: MemoryPaths,
  secrets: { deepseekApiKey: string; dashscopeApiKey: string },
  options: { overwrite?: boolean } = {},
): { written: boolean; path: string } {
  ensureDir(path.dirname(paths.envFile))
  const exists = fs.existsSync(paths.envFile)
  if (exists && options.overwrite === false) return { written: false, path: paths.envFile }

  const updates = new Map<string, string>([
    ['DEEPSEEK_API_KEY', secrets.deepseekApiKey],
    ['DASHSCOPE_API_KEY', secrets.dashscopeApiKey],
  ])
  const lines: string[] = []
  const seen = new Set<string>()

  if (exists) {
    const current = fs.readFileSync(paths.envFile, 'utf8').split(/\r?\n/u)
    for (const line of current) {
      const trimmed = line.trim()
      const eq = trimmed.indexOf('=')
      const key = eq > 0 ? trimmed.slice(0, eq).replace(/^export\s+/u, '').trim() : ''
      if (key !== '' && updates.has(key)) {
        if (seen.has(key)) continue
        seen.add(key)
        lines.push(`${key}=${updates.get(key) ?? ''}`)
        continue
      }
      lines.push(line)
    }
    while (lines.length > 0 && (lines[lines.length - 1] ?? '') === '') lines.pop()
  }

  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${value}`)
  }

  const body = `${lines.join('\n')}\n`
  fs.writeFileSync(paths.envFile, body, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(paths.envFile, 0o600)
  } catch {
    /* best effort on exotic filesystems */
  }
  return { written: true, path: paths.envFile }
}

/** Read a required key or throw a message that says where to put it. */
export function requireSecret(secrets: SecretSource, which: 'deepseek' | 'dashscope'): string {
  const value = which === 'deepseek' ? secrets.deepseekApiKey : secrets.dashscopeApiKey
  if (value && value.trim() !== '') return value
  const variable = which === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'DASHSCOPE_API_KEY'
  const file = FILES.env
  throw new Error(
    `缺少 ${variable}：请在 ${file}（数据根目录下）中写入 ${variable}=<密钥>，` +
      `或通过环境变量 ${variable} / AUTOBIO_${variable} 提供。`,
  )
}
