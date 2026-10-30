/** AutoBioMemory — data-root resolution and layout. */

import os from 'node:os'
import path from 'node:path'

import { DEFAULT_ROOT_NAME, DIRS, FILES } from './constants.js'
import { ensureDir } from './util.js'
import type { MemoryPaths } from './types.js'

export type { MemoryPaths } from './types.js'

/** Expand a leading `~` against the home directory. */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

/**
 * Resolve the data root.
 *
 * Precedence: explicit override → `DSH_AUTOBIO_ROOT` → `AUTOBIO_ROOT` → `~/.autobiomemory`.
 */
export function resolveDataRoot(override?: string): string {
  const candidates = [
    override,
    process.env.DSH_AUTOBIO_ROOT,
    process.env.AUTOBIO_ROOT,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return path.resolve(expandHome(candidate.trim()))
    }
  }
  return path.join(os.homedir(), DEFAULT_ROOT_NAME)
}

/** Build the full path layout for one data root. */
export function memoryPaths(root?: string): MemoryPaths {
  const resolved = path.resolve(expandHome(root ?? resolveDataRoot()))
  return {
    root: resolved,
    configFile: path.join(resolved, FILES.config),
    envFile: path.join(resolved, FILES.env),
    eventsDir: path.join(resolved, DIRS.events),
    vectorsDir: path.join(resolved, DIRS.vectors),
    stateDir: path.join(resolved, DIRS.state),
    logsDir: path.join(resolved, DIRS.logs),
    cursorFile: path.join(resolved, DIRS.state, FILES.cursor),
    runStateFile: path.join(resolved, DIRS.state, FILES.runState),
    eventIndexFile: path.join(resolved, DIRS.state, 'events-index.json'),
    vectorDb: path.join(resolved, DIRS.vectors, FILES.vectorDb),
  }
}

/** Create the directory skeleton (`events/`, `vectors/`, `state/`, `logs/`). */
export function ensureDataLayout(paths: MemoryPaths): MemoryPaths {
  ensureDir(paths.root)
  ensureDir(paths.eventsDir)
  ensureDir(paths.vectorsDir)
  ensureDir(paths.stateDir)
  ensureDir(paths.logsDir)
  return paths
}

/** The paired files of one event. */
export function eventPair(paths: MemoryPaths, id: string): { json: string; md: string } {
  return {
    json: path.join(paths.eventsDir, `${id}.json`),
    md: path.join(paths.eventsDir, `${id}.md`),
  }
}
