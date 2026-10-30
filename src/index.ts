/**
 * AutoBioMemory — public entry point.
 *
 * The default export is the cordis plugin (bundle layer `cordis.patch.yml` inserts it).
 * Everything else is exported so the CLI, tests and other plugins can drive the loop directly.
 */

export { name, inject, Config, apply, default } from './plugin.js'
export type { PluginConfig } from './plugin.js'

export * from './types.js'
export { SCHEMA_VERSION, STATE_VERSION, DIRS, FILES } from './constants.js'

export { memoryPaths, resolveDataRoot, ensureDataLayout, eventPair } from './paths.js'
export type { MemoryPaths } from './paths.js'

export { parseDotEnv, readSecrets, requireSecret, writeEnvFile } from './env.js'
export type { SecretSource } from './env.js'

export {
  defaultConfig,
  ensureConfig,
  expandSessionDirs,
  loadConfig,
  mergeConfig,
  validateConfig,
  writeConfig,
} from './config.js'

export {
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
} from './state.js'

export {
  decodeZstdFrames,
  listSessionFiles,
  normalizeRecords,
  pendingRecords,
  readTranscript,
  renderRecords,
  sessionIdFromPath,
  spanHash,
} from './session-reader.js'

export { buildUnits, unitOptionsFromConfig } from './units.js'

export {
  ENCODING_GUIDE,
  RESPONSE_CONTRACT,
  EncodingError,
  buildEncodingRequest,
  buildSystemPrompt,
  normalizeEncodedEvent,
  parseEncodingResponse,
  renderUnitRecords,
} from './prompt.js'

export { DeepseekClient, DeepseekError } from './deepseek.js'
export { createDistiller, encodeUnit } from './distill.js'

export {
  buildRecord,
  eventIdFor,
  eventIndexPath,
  listEventSummaries,
  readDiary,
  readEvent,
  repairPairs,
  shortTermMemory,
  writeEventPair,
} from './store.js'
export type { EventSummary } from './store.js'

export {
  VectorStore,
  blobToVector,
  cosineSimilarity,
  missingEventIds,
  searchVectors,
  staleEventIds,
  vectorNorm,
  vectorToBlob,
} from './vectors.js'
export type { VectorHit, VectorRow, VectorSource } from './vectors.js'

export {
  DashscopeError,
  createEmbedder,
  createReranker,
  embedOne,
  embeddingEndpoint,
  rerankEndpoint,
} from './embed.js'

export { matchFilters, parseFilterArguments, recall, renderRecallText } from './retrieval.js'

export {
  consolidate,
  consolidateOnce,
  isConsolidating,
  retrySkippedSpans,
} from './consolidate.js'
export type { ConsolidateDeps } from './consolidate.js'

export { createLogger, silentLogger } from './logger.js'
export type { LogLevel, LoggerOptions } from './logger.js'
