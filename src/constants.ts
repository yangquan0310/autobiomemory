/** AutoBioMemory — constants shared by every module. */

/** Bumped whenever the persisted event JSON shape changes. */
export const SCHEMA_VERSION = 1

/** Bumped whenever the cursor/state file shape changes. */
export const STATE_VERSION = 1

/** Default data root: the user's home directory. */
export const DEFAULT_ROOT_NAME = '.autobiomemory'

/** Environment variables read from `<root>/.env`. */
export const ENV_KEYS = {
  deepseek: ['DEEPSEEK_API_KEY', 'AUTOBIO_DEEPSEEK_API_KEY'],
  dashscope: ['DASHSCOPE_API_KEY', 'AUTOBIO_DASHSCOPE_API_KEY'],
} as const

/** Directory names inside the data root. */
export const DIRS = {
  events: 'events',
  vectors: 'vectors',
  state: 'state',
  logs: 'logs',
} as const

/** File names inside the data root. */
export const FILES = {
  config: 'config.json',
  env: '.env',
  cursor: 'cursor.json',
  runState: 'status.json',
  vectorDb: 'index.sqlite',
  readme: 'README.md',
} as const

export const BEIJING_BASE_URL = 'https://dashscope.aliyuncs.com'
export const INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com'
