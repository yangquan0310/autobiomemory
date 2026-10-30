/** AutoBioMemory — minimal leveled logger (never logs secrets). */

import type { Logger } from './types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  level?: LogLevel
  /** Receives one fully formatted line. Defaults to stderr. */
  sink?: (line: string) => void
  /** Prefix shown on every line. */
  scope?: string
}

function formatArgs(args: unknown[]): string {
  if (args.length === 0) return ''
  return ` ${args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')}`
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const threshold = ORDER[level]
  const scope = options.scope ? `[autobiomemory:${options.scope}]` : '[autobiomemory]'
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`))
  const emit = (entryLevel: LogLevel, message: string, args: unknown[]) => {
    if (ORDER[entryLevel] < threshold) return
    sink(`${new Date().toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${scope} ${message}${formatArgs(args)}`)
  }
  return {
    debug: (message, ...args) => emit('debug', message, args),
    info: (message, ...args) => emit('info', message, args),
    warn: (message, ...args) => emit('warn', message, args),
    error: (message, ...args) => emit('error', message, args),
  }
}

export function silentLogger(): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: noop, error: noop }
}
