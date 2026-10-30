/** AutoBioMemory — one event unit → one encoded event (with provenance). */

import { DeepseekClient } from './deepseek.js'
import { createLogger } from './logger.js'
import { buildEncodingRequest, parseEncodingResponse } from './prompt.js'
import { nowIso, parseIso } from './util.js'
import type { Distiller, EncodedEvent, EventSourceRef, EventUnit, Logger, MemoryConfig } from './types.js'

export interface DistillDeps {
  config: MemoryConfig
  apiKey: string
  logger?: Logger
  /** Injectable transport for tests; defaults to a real DeepSeek chat client. */
  client?: Pick<DeepseekClient, 'chat'> & { lastUsage?: DeepseekClient['lastUsage'] }
}

function sourceRefFor(unit: EventUnit): EventSourceRef {
  return {
    sessionId: unit.sessionId,
    sessionFile: unit.sessionFile,
    fromSeq: unit.fromSeq,
    toSeq: unit.toSeq,
    recordCount: unit.records.length,
    turns: [...unit.turns],
    capturedAt: nowIso(),
    contentHash: unit.contentHash,
    truncated: unit.truncated,
  }
}

/** Encode one unit, always stamping it with its provenance. */
export async function encodeUnit(deps: DistillDeps, unit: EventUnit): Promise<EncodedEvent> {
  const logger = deps.logger ?? createLogger({ scope: 'distill' })
  const client = deps.client ?? new DeepseekClient(deps.config.deepseek, deps.apiKey, logger)
  const { system, user } = buildEncodingRequest(deps.config, unit)

  const raw = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { signal: undefined, jsonMode: deps.config.deepseek.jsonMode },
  )

  const encoded = parseEncodingResponse(raw)

  // Provenance is ours, never the model's.
  encoded.structured.sources = [sourceRefFor(unit)]

  if (parseIso(encoded.structured.startedAt) === undefined) {
    encoded.structured.startedAt = unit.startedAt
  }
  if (parseIso(encoded.structured.endedAt) === undefined) {
    encoded.structured.endedAt = unit.endedAt
  }
  if (encoded.structured.title === '') {
    encoded.structured.title = `事件 ${unit.startedAt.slice(0, 16)}`
  }
  if (encoded.structured.outcome.summary === '') {
    encoded.structured.outcome.summary = encoded.structured.title
  }

  logger.debug(
    `encoded ${unit.fromSeq}-${unit.toSeq}: ${encoded.structured.title} ` +
      `(${encoded.diary.length} 字, ${encoded.structured.outcome.status})`,
  )
  return encoded
}

/** A `Distiller` bound to one config + key. */
export function createDistiller(deps: DistillDeps): Distiller {
  return {
    encode: (unit: EventUnit) => encodeUnit(deps, unit),
  }
}
