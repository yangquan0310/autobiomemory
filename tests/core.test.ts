import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  defaultConfig,
  ensureConfig,
  expandSessionDirs,
  loadConfig,
  mergeConfig,
  validateConfig,
  writeConfig,
} from '../src/config.js'
import { memoryPaths } from '../src/paths.js'
import {
  clearFailure,
  failureKey,
  getSessionCursor,
  isCoolingDown,
  loadCursor,
  loadRunState,
  pendingFailures,
  putSessionCursor,
  recordFailure,
  saveCursor,
  saveRunState,
} from '../src/state.js'
import { parseDotEnv, readSecrets, requireSecret, writeEnvFile } from '../src/env.js'
import { ensureDataLayout, eventPair, resolveDataRoot } from '../src/paths.js'
import type { SessionCursor } from '../src/types.js'

const tmpRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'abm-core-'))

describe('resolveDataRoot', () => {
  it('prefers the explicit override, then env, then the home default', () => {
    const explicit = path.join(os.tmpdir(), 'abm-explicit')
    const fromEnv = path.join(os.tmpdir(), 'abm-from-env')
    expect(resolveDataRoot(explicit)).toBe(path.resolve(explicit))
    const saved = process.env.DSH_AUTOBIO_ROOT
    process.env.DSH_AUTOBIO_ROOT = fromEnv
    try {
      expect(resolveDataRoot()).toBe(path.resolve(fromEnv))
      expect(resolveDataRoot(explicit)).toBe(path.resolve(explicit))
    } finally {
      if (saved === undefined) delete process.env.DSH_AUTOBIO_ROOT
      else process.env.DSH_AUTOBIO_ROOT = saved
    }
    expect(resolveDataRoot()).toMatch(/\.autobiomemory$/u)
  })

  it('expands a leading tilde', () => {
    expect(resolveDataRoot('~/mem-test')).toBe(path.join(os.homedir(), 'mem-test'))
  })
})

describe('paths', () => {
  it('builds the full layout and creates it', () => {
    const root = path.join(tmpRoot(), 'memory')
    const paths = memoryPaths(root)
    expect(paths.configFile).toBe(path.join(root, 'config.json'))
    expect(paths.envFile).toBe(path.join(root, '.env'))
    expect(paths.cursorFile).toBe(path.join(root, 'state', 'cursor.json'))
    expect(paths.vectorDb).toBe(path.join(root, 'vectors', 'index.sqlite'))
    ensureDataLayout(paths)
    for (const dir of [paths.eventsDir, paths.vectorsDir, paths.stateDir, paths.logsDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true)
    }
    expect(eventPair(paths, 'ev_1')).toEqual({
      json: path.join(root, 'events', 'ev_1.json'),
      md: path.join(root, 'events', 'ev_1.md'),
    })
  })
})

describe('dotenv', () => {
  it('parses quotes, comments, export and blank lines', () => {
    const parsed = parseDotEnv(
      [
        '# comment',
        'DEEPSEEK_API_KEY=sk-plain',
        'export DASHSCOPE_API_KEY="sk-quoted value"',
        "OTHER='single'",
        'WITH_COMMENT=value # trailing',
        '',
        'not a pair',
      ].join('\n'),
    )
    expect(parsed.DEEPSEEK_API_KEY).toBe('sk-plain')
    expect(parsed.DASHSCOPE_API_KEY).toBe('sk-quoted value')
    expect(parsed.OTHER).toBe('single')
    expect(parsed.WITH_COMMENT).toBe('value')
    expect(parsed['not a pair']).toBeUndefined()
  })

  it('prefers .env over process env and reports origins', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    writeEnvFile(paths, { deepseekApiKey: 'from-file', dashscopeApiKey: 'dash-from-file' })
    const secrets = readSecrets(paths, { DEEPSEEK_API_KEY: 'from-process', DASHSCOPE_API_KEY: 'dash-process' })
    expect(secrets.deepseekApiKey).toBe('from-file')
    expect(secrets.origin).toEqual({ deepseek: '.env', dashscope: '.env' })
  })

  it('falls back to process env and marks missing keys', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    const secrets = readSecrets(paths, { DEEPSEEK_API_KEY: 'p1' })
    expect(secrets.deepseekApiKey).toBe('p1')
    expect(secrets.origin.deepseek).toBe('process')
    expect(secrets.dashscopeApiKey).toBeUndefined()
    expect(secrets.origin.dashscope).toBe('missing')
    expect(() => requireSecret(secrets, 'dashscope')).toThrow(/DASHSCOPE_API_KEY/u)
  })

  it('rewrites only the two keys and keeps unrelated lines', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    fs.writeFileSync(paths.envFile, '# keep me\nQQBOT=1\nDEEPSEEK_API_KEY=old\n')
    writeEnvFile(paths, { deepseekApiKey: 'new', dashscopeApiKey: 'dash' }, { overwrite: true })
    const body = fs.readFileSync(paths.envFile, 'utf8')
    expect(body).toContain('# keep me')
    expect(body).toContain('QQBOT=1')
    expect(body).toContain('DEEPSEEK_API_KEY=new')
    expect(body).toContain('DASHSCOPE_API_KEY=dash')
    expect(body.match(/DEEPSEEK_API_KEY/gu)).toHaveLength(1)
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.envFile).mode & 0o777).toBe(0o600)
    }
  })
})

describe('config', () => {
  it('has the documented defaults', () => {
    const config = defaultConfig('/tmp/root')
    expect(config.session.readDirs).toEqual(['~/.dsh/sessions'])
    expect(config.deepseek.model).toBe('deepseek-chat')
    expect(config.dashscope.baseUrl).toBe('https://dashscope.aliyuncs.com')
    expect(config.dashscope.embeddingModel).toBe('text-embedding-v4')
    expect(config.dashscope.embeddingDimensions).toBe(1024)
    expect(config.retrieval.finalLimit).toBe(5)
    expect(config.consolidation.recentEventLimit).toBe(20)
    expect(validateConfig(config)).toEqual([])
  })

  it('deep merges, replaces arrays and ignores undefined', () => {
    const base = defaultConfig('/tmp/root')
    const merged = mergeConfig(base, {
      deepseek: { model: 'deepseek-reasoner' },
      session: { readDirs: ['/a', '/b'] },
      retrieval: { finalLimit: undefined },
    })
    expect(merged.deepseek.model).toBe('deepseek-reasoner')
    expect(merged.deepseek.baseUrl).toBe(base.deepseek.baseUrl)
    expect(merged.session.readDirs).toEqual(['/a', '/b'])
    expect(merged.retrieval.finalLimit).toBe(base.retrieval.finalLimit)
    expect(base.deepseek.model).toBe('deepseek-chat')
  })

  it('rejects invalid values', () => {
    const config = defaultConfig('/tmp/root')
    const problems = validateConfig({
      ...config,
      session: { ...config.session, readDirs: [], minRecordsPerEvent: 50, maxRecordsPerEvent: 10 },
      deepseek: { ...config.deepseek, baseUrl: 'ftp://x' },
      dashscope: { ...config.dashscope, embeddingDimensions: 8 },
    })
    expect(problems.length).toBeGreaterThanOrEqual(4)
    expect(problems.join(' ')).toContain('readDirs')
  })

  it('loads from disk, applies a patch and writes once', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    expect(fs.existsSync(paths.configFile)).toBe(false)
    const created = ensureConfig(paths, { deepseek: { model: 'deepseek-reasoner' } })
    expect(created.deepseek.model).toBe('deepseek-reasoner')
    expect(fs.existsSync(paths.configFile)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>
    expect(raw.dataRoot).toBe(paths.root)
    const reloaded = loadConfig(paths)
    expect(reloaded.deepseek.model).toBe('deepseek-reasoner')
    writeConfig(paths, { ...reloaded, retrieval: { ...reloaded.retrieval, finalLimit: 3 } })
    expect(loadConfig(paths).retrieval.finalLimit).toBe(3)
  })

  it('expands, resolves and de-duplicates session dirs', () => {
    const config = defaultConfig(path.join(os.tmpdir(), 'abm-root'))
    const absolute = path.join(os.tmpdir(), 'abm-abs-dir')
    const cwd = path.join(os.tmpdir(), 'abm-work')
    config.session.readDirs = ['~/.dsh/sessions', 'relative/dir', absolute, absolute, '  ']
    const dirs = expandSessionDirs(config, cwd)
    expect(dirs).toEqual([path.join(os.homedir(), '.dsh', 'sessions'), path.resolve(cwd, 'relative/dir'), absolute])
  })
})

describe('state', () => {
  const cursorOf = (file: string): SessionCursor => ({
    sessionFile: file,
    sessionId: 'sess',
    processedRecords: 12,
    byteOffset: 999,
    fileSize: 1000,
    fileMtimeMs: 1,
    lastRecordHash: 'h',
    lastSpanHash: 's',
    updatedAt: new Date().toISOString(),
  })

  it('round-trips cursors and recovers from a corrupt file', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    const state = loadCursor(paths)
    expect(state.sessions).toEqual({})
    putSessionCursor(state, cursorOf('/a/session.jsonl.zstd'))
    saveCursor(paths, state)
    const reloaded = loadCursor(paths)
    expect(getSessionCursor(reloaded, '/a/session.jsonl.zstd')?.processedRecords).toBe(12)
    fs.writeFileSync(paths.cursorFile, '{not json')
    expect(loadCursor(paths).sessions).toEqual({})
  })

  it('backs off exponentially and caps the delay', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    const state = loadRunState(paths)
    const first = recordFailure(state, 'consolidate', '/a/session', new Error('boom'))
    expect(first.attempts).toBe(1)
    const firstDelay = Date.parse(first.nextAttemptAt) - Date.parse(first.lastAttemptAt)
    expect(firstDelay).toBeGreaterThanOrEqual(29_000)
    const second = recordFailure(state, 'consolidate', '/a/session', new Error('boom'))
    const secondDelay = Date.parse(second.nextAttemptAt) - Date.parse(second.lastAttemptAt)
    expect(secondDelay).toBeGreaterThan(firstDelay)
    const third = recordFailure(state, 'consolidate', '/a/session', new Error('boom'), { retryDelayMs: 60 * 60 * 1000 })
    const thirdDelay = Date.parse(third.nextAttemptAt) - Date.parse(third.lastAttemptAt)
    expect(thirdDelay).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(state.failures[failureKey('consolidate', '/a/session')]?.attempts).toBe(3)
    clearFailure(state, 'consolidate', '/a/session')
    expect(Object.keys(state.failures)).toHaveLength(0)
  })

  it('reports pending failures and cooldown', () => {
    const paths = memoryPaths(tmpRoot())
    ensureDataLayout(paths)
    const state = loadRunState(paths)
    recordFailure(state, 'embed', 'ev_1', new Error('x'), { retryDelayMs: 1000 })
    expect(pendingFailures(state, Date.now())).toHaveLength(0)
    expect(pendingFailures(state, Date.now() + 5000)).toHaveLength(1)
    saveRunState(paths, state)
    const reloaded = loadRunState(paths)
    reloaded.lastRunAt = new Date().toISOString()
    expect(isCoolingDown(reloaded, 60_000)).toBe(true)
    expect(isCoolingDown(reloaded, 0)).toBe(false)
    reloaded.lastRunAt = new Date(Date.now() - 120_000).toISOString()
    expect(isCoolingDown(reloaded, 60_000)).toBe(false)
  })
})
