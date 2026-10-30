#!/usr/bin/env node

// src/cli.ts
import fs7 from "fs";
import os2 from "os";
import path9 from "path";

// src/config.ts
import fs2 from "fs";
import path3 from "path";

// src/constants.ts
var SCHEMA_VERSION = 1;
var STATE_VERSION = 1;
var DEFAULT_ROOT_NAME = ".autobiomemory";
var ENV_KEYS = {
  deepseek: ["DEEPSEEK_API_KEY", "AUTOBIO_DEEPSEEK_API_KEY"],
  dashscope: ["DASHSCOPE_API_KEY", "AUTOBIO_DASHSCOPE_API_KEY"]
};
var DIRS = {
  events: "events",
  vectors: "vectors",
  state: "state",
  logs: "logs"
};
var FILES = {
  config: "config.json",
  env: ".env",
  cursor: "cursor.json",
  runState: "status.json",
  vectorDb: "index.sqlite",
  readme: "README.md"
};
var BEIJING_BASE_URL = "https://dashscope.aliyuncs.com";
var INTL_BASE_URL = "https://dashscope-intl.aliyuncs.com";

// src/paths.ts
import os from "os";
import path2 from "path";

// src/util.ts
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
var AbortError = class extends Error {
  code = "ABORT_ERR";
  constructor(message = "aborted") {
    super(message);
    this.name = "AbortError";
  }
};
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function parseIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return void 0;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? void 0 : ms;
}
var BEIJING_OFFSET_MS = 8 * 60 * 60 * 1e3;
function beijingParts(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const hour = String(shifted.getUTCHours()).padStart(2, "0");
  const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
  const second = String(shifted.getUTCSeconds()).padStart(2, "0");
  return { year, month, day, hour, minute, second };
}
function beijingIso(ms) {
  const { year, month, day, hour, minute, second } = beijingParts(ms);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}
function beijingStamp(ms) {
  const { year, month, day, hour, minute, second } = beijingParts(ms);
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
function beijingCompact(ms) {
  const { year, month, day, hour, minute, second } = beijingParts(ms);
  return `${year}${month}${day}T${hour}${minute}${second}`;
}
function truncate(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1)}\u2026`;
}
function collapseWhitespace(text) {
  return text.replace(/\s+/gu, " ").trim();
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function readJsonFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function writeTextFileAtomic(file, text) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}
function writeJsonFile(file, value) {
  writeTextFileAtomic(file, `${JSON.stringify(value, null, 2)}
`);
}
function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AbortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter((entry) => entry.length > 0);
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError();
}
async function asyncPool(items, limit, worker) {
  const width = Math.max(1, Math.floor(limit));
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (; ; ) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
function maskSecret(value) {
  if (!value) return "(missing)";
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}\u2026${value.slice(-4)}`;
}

// src/paths.ts
function expandHome(input) {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path2.join(os.homedir(), input.slice(2));
  return input;
}
function resolveDataRoot(override) {
  const candidates = [
    override,
    process.env.DSH_AUTOBIO_ROOT,
    process.env.AUTOBIO_ROOT
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return path2.resolve(expandHome(candidate.trim()));
    }
  }
  return path2.join(os.homedir(), DEFAULT_ROOT_NAME);
}
function memoryPaths(root) {
  const resolved = path2.resolve(expandHome(root ?? resolveDataRoot()));
  return {
    root: resolved,
    configFile: path2.join(resolved, FILES.config),
    envFile: path2.join(resolved, FILES.env),
    eventsDir: path2.join(resolved, DIRS.events),
    vectorsDir: path2.join(resolved, DIRS.vectors),
    stateDir: path2.join(resolved, DIRS.state),
    logsDir: path2.join(resolved, DIRS.logs),
    cursorFile: path2.join(resolved, DIRS.state, FILES.cursor),
    runStateFile: path2.join(resolved, DIRS.state, FILES.runState),
    eventIndexFile: path2.join(resolved, DIRS.state, "events-index.json"),
    vectorDb: path2.join(resolved, DIRS.vectors, FILES.vectorDb)
  };
}
function ensureDataLayout(paths) {
  ensureDir(paths.root);
  ensureDir(paths.eventsDir);
  ensureDir(paths.vectorsDir);
  ensureDir(paths.stateDir);
  ensureDir(paths.logsDir);
  return paths;
}

// src/config.ts
function defaultConfig(dataRoot) {
  return {
    version: 1,
    dataRoot: dataRoot ?? "",
    session: {
      readDirs: ["~/.dsh/sessions"],
      // dsh names transcripts with a session-format version (`session.v4.jsonl.zstd`
      // on 0.2.x). Keep the glob version-agnostic so a dsh upgrade cannot silently
      // hide every transcript from consolidation.
      includeGlobs: ["**/session*.jsonl.zstd", "**/session*.jsonl"],
      excludeGlobs: [],
      minRecordsPerEvent: 2,
      maxRecordsPerEvent: 200,
      tailRecords: 6
    },
    consolidation: {
      maxInputChars: 6e4,
      minEventChars: 120,
      maxEventsPerRun: 12,
      recentEventLimit: 20,
      cooldownMs: 6e4,
      serialize: true,
      maxSpanAttempts: 3
    },
    deepseek: {
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      temperature: 0.4,
      maxTokens: 8e3,
      timeoutMs: 24e4,
      jsonMode: true,
      retries: 3
    },
    dashscope: {
      region: "beijing",
      baseUrl: BEIJING_BASE_URL,
      embeddingModel: "text-embedding-v4",
      embeddingDimensions: 1024,
      embeddingBatchSize: 8,
      rerankModel: "gte-rerank-v2",
      rerankTopN: 20,
      rerankEnabled: true,
      timeoutMs: 6e4,
      retries: 3
    },
    retrieval: {
      candidateLimit: 200,
      vectorTopK: 30,
      rerankTopN: 8,
      finalLimit: 5,
      shortTermCount: 8,
      includeSources: true,
      minScore: 0,
      maxReplyChars: 6e3
    },
    trigger: {
      onCompaction: true,
      onTurnEnd: false,
      onSessionStart: false,
      toolName: "autobiomemory_recall",
      globalCooldownMs: 12e4
    }
  };
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeConfig(base, patch) {
  if (!patch) return structuredClone(base);
  const merge = (target, source) => {
    if (source === void 0) return target;
    if (Array.isArray(source)) return [...source];
    if (isPlainObject(source)) {
      const out = isPlainObject(target) ? { ...target } : {};
      for (const [key, value] of Object.entries(source)) {
        if (value === void 0) continue;
        out[key] = key in out ? merge(out[key], value) : merge(void 0, value);
      }
      return out;
    }
    return source;
  };
  return merge(structuredClone(base), patch);
}
function validateConfig(config) {
  const problems = [];
  const httpUrl = (value) => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };
  if (!Array.isArray(config.session?.readDirs) || config.session.readDirs.length === 0) {
    problems.push("session.readDirs \u4E0D\u80FD\u4E3A\u7A7A\uFF1A\u81F3\u5C11\u914D\u7F6E\u4E00\u4E2A\u539F\u59CB\u4F1A\u8BDD\u8BFB\u53D6\u76EE\u5F55");
  }
  if (!httpUrl(config.deepseek?.baseUrl)) problems.push("deepseek.baseUrl \u5FC5\u987B\u662F http(s) \u5730\u5740");
  if (!httpUrl(config.dashscope?.baseUrl)) problems.push("dashscope.baseUrl \u5FC5\u987B\u662F http(s) \u5730\u5740");
  const dims = config.dashscope?.embeddingDimensions;
  if (typeof dims !== "number" || !Number.isFinite(dims) || dims < 64 || dims > 2048) {
    problems.push("dashscope.embeddingDimensions \u5FC5\u987B\u5728 64..2048 \u4E4B\u95F4");
  }
  const minRecords = config.session?.minRecordsPerEvent;
  const maxRecords = config.session?.maxRecordsPerEvent;
  if (typeof minRecords !== "number" || minRecords < 1) {
    problems.push("session.minRecordsPerEvent \u5FC5\u987B \u2265 1");
  }
  if (typeof maxRecords !== "number" || typeof minRecords === "number" && maxRecords < minRecords) {
    problems.push("session.maxRecordsPerEvent \u5FC5\u987B \u2265 session.minRecordsPerEvent");
  }
  const nonNegative = [
    ["session.tailRecords", config.session?.tailRecords],
    ["consolidation.maxInputChars", config.consolidation?.maxInputChars],
    ["consolidation.minEventChars", config.consolidation?.minEventChars],
    ["consolidation.maxEventsPerRun", config.consolidation?.maxEventsPerRun],
    ["consolidation.recentEventLimit", config.consolidation?.recentEventLimit],
    ["consolidation.cooldownMs", config.consolidation?.cooldownMs],
    ["consolidation.maxSpanAttempts", config.consolidation?.maxSpanAttempts],
    ["retrieval.candidateLimit", config.retrieval?.candidateLimit],
    ["retrieval.vectorTopK", config.retrieval?.vectorTopK],
    ["retrieval.rerankTopN", config.retrieval?.rerankTopN],
    ["retrieval.finalLimit", config.retrieval?.finalLimit],
    ["retrieval.shortTermCount", config.retrieval?.shortTermCount],
    ["retrieval.maxReplyChars", config.retrieval?.maxReplyChars],
    ["deepseek.maxTokens", config.deepseek?.maxTokens],
    ["deepseek.timeoutMs", config.deepseek?.timeoutMs],
    ["dashscope.embeddingBatchSize", config.dashscope?.embeddingBatchSize],
    ["dashscope.timeoutMs", config.dashscope?.timeoutMs]
  ];
  for (const [label, value] of nonNegative) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      problems.push(`${label} \u5FC5\u987B\u662F\u975E\u8D1F\u6570`);
    }
  }
  if (typeof config.dashscope?.rerankTopN === "number" && config.dashscope.rerankTopN < 1) {
    problems.push("dashscope.rerankTopN \u5FC5\u987B \u2265 1");
  }
  if (typeof config.retrieval?.finalLimit === "number" && config.retrieval.finalLimit < 1) {
    problems.push("retrieval.finalLimit \u5FC5\u987B \u2265 1");
  }
  if (typeof config.session?.includeGlobs !== "undefined" && !Array.isArray(config.session.includeGlobs)) {
    problems.push("session.includeGlobs \u5FC5\u987B\u662F\u6570\u7EC4");
  }
  return problems;
}
function loadConfig(paths, patch) {
  const base = defaultConfig(paths.root);
  const onDisk = readJsonFile(paths.configFile);
  const withDisk = onDisk && isPlainObject(onDisk) ? mergeConfig(base, onDisk) : base;
  const merged = mergeConfig({ ...withDisk, dataRoot: paths.root }, patch);
  merged.dataRoot = paths.root;
  return hydrate(merged);
}
function ensureConfig(paths, patch) {
  const config = loadConfig(paths, patch);
  if (!fs2.existsSync(paths.configFile)) writeConfig(paths, config);
  return config;
}
function writeConfig(paths, config) {
  ensureDir(path3.dirname(paths.configFile));
  writeJsonFile(paths.configFile, { ...config, dataRoot: paths.root });
}
function hydrate(config) {
  config.dashscope.embeddingDimensions = Math.round(
    clampNumber(config.dashscope.embeddingDimensions, 64, 2048)
  );
  config.dashscope.embeddingBatchSize = Math.round(clampNumber(config.dashscope.embeddingBatchSize, 1, 64));
  config.deepseek.temperature = clampNumber(config.deepseek.temperature, 0, 2);
  config.retrieval.minScore = clampNumber(config.retrieval.minScore, -1, 1);
  if (config.dashscope.region === "intl" && config.dashscope.baseUrl === BEIJING_BASE_URL) {
    config.dashscope.baseUrl = INTL_BASE_URL;
  }
  return config;
}
function expandSessionDirs(config, cwd) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of config.session?.readDirs ?? []) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const expanded = expandHome(trimmed);
    const absolute = path3.isAbsolute(expanded) ? expanded : path3.resolve(cwd, expanded);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

// src/consolidate.ts
import fs6 from "fs";
import path8 from "path";

// src/env.ts
import fs3 from "fs";
import path4 from "path";
function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }
  return values;
}
function fileSecrets(file) {
  try {
    return parseDotEnv(fs3.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function readSecrets(paths, processEnv = process.env) {
  const fromFile = fileSecrets(paths.envFile);
  const result = {
    origin: { deepseek: "missing", dashscope: "missing" }
  };
  const deepseek = [ENV_KEYS.deepseek[0], ENV_KEYS.deepseek[1]];
  const dashscope = [ENV_KEYS.dashscope[0], ENV_KEYS.dashscope[1]];
  for (const key of deepseek) {
    const fileValue = fromFile[key];
    if (fileValue) {
      result.deepseekApiKey = fileValue;
      result.origin.deepseek = ".env";
      break;
    }
  }
  if (!result.deepseekApiKey) {
    for (const key of [...deepseek].reverse()) {
      const value = processEnv[key];
      if (value && value.trim() !== "") {
        result.deepseekApiKey = value.trim();
        result.origin.deepseek = "process";
        break;
      }
    }
  }
  for (const key of dashscope) {
    const fileValue = fromFile[key];
    if (fileValue) {
      result.dashscopeApiKey = fileValue;
      result.origin.dashscope = ".env";
      break;
    }
  }
  if (!result.dashscopeApiKey) {
    for (const key of [...dashscope].reverse()) {
      const value = processEnv[key];
      if (value && value.trim() !== "") {
        result.dashscopeApiKey = value.trim();
        result.origin.dashscope = "process";
        break;
      }
    }
  }
  return result;
}
function writeEnvFile(paths, secrets, options = {}) {
  ensureDir(path4.dirname(paths.envFile));
  const exists = fs3.existsSync(paths.envFile);
  if (exists && options.overwrite === false) return { written: false, path: paths.envFile };
  const updates = /* @__PURE__ */ new Map([
    ["DEEPSEEK_API_KEY", secrets.deepseekApiKey],
    ["DASHSCOPE_API_KEY", secrets.dashscopeApiKey]
  ]);
  const lines = [];
  const seen = /* @__PURE__ */ new Set();
  if (exists) {
    const current = fs3.readFileSync(paths.envFile, "utf8").split(/\r?\n/u);
    for (const line of current) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      const key = eq > 0 ? trimmed.slice(0, eq).replace(/^export\s+/u, "").trim() : "";
      if (key !== "" && updates.has(key)) {
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push(`${key}=${updates.get(key) ?? ""}`);
        continue;
      }
      lines.push(line);
    }
    while (lines.length > 0 && (lines[lines.length - 1] ?? "") === "") lines.pop();
  }
  for (const [key, value] of updates) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  const body = `${lines.join("\n")}
`;
  fs3.writeFileSync(paths.envFile, body, { encoding: "utf8", mode: 384 });
  try {
    fs3.chmodSync(paths.envFile, 384);
  } catch {
  }
  return { written: true, path: paths.envFile };
}
function requireSecret(secrets, which) {
  const value = which === "deepseek" ? secrets.deepseekApiKey : secrets.dashscopeApiKey;
  if (value && value.trim() !== "") return value;
  const variable = which === "deepseek" ? "DEEPSEEK_API_KEY" : "DASHSCOPE_API_KEY";
  const file = FILES.env;
  throw new Error(
    `\u7F3A\u5C11 ${variable}\uFF1A\u8BF7\u5728 ${file}\uFF08\u6570\u636E\u6839\u76EE\u5F55\u4E0B\uFF09\u4E2D\u5199\u5165 ${variable}=<\u5BC6\u94A5>\uFF0C\u6216\u901A\u8FC7\u73AF\u5883\u53D8\u91CF ${variable} / AUTOBIO_${variable} \u63D0\u4F9B\u3002`
  );
}

// src/embed.ts
var DEFAULT_TIMEOUT_MS = 3e4;
var RETRY_BASE_MS = 250;
var DEFAULT_RETRIES = 3;
var EMBEDDING_CONCURRENCY = 4;
var BODY_SNIPPET_CHARS = 500;
var DashscopeError = class extends Error {
  status;
  body;
  code;
  constructor(message, options = {}) {
    super(message);
    this.name = "DashscopeError";
    this.status = options.status;
    this.body = options.body;
    this.code = options.code;
  }
};
var RetryableDashscopeError = class extends Error {
  status;
  body;
  constructor(message, options = {}) {
    super(message);
    this.name = "RetryableDashscopeError";
    this.status = options.status;
    this.body = options.body;
  }
};
function trimBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/u, "");
}
function embeddingEndpoint(config) {
  return `${trimBaseUrl(config.baseUrl)}/compatible-mode/v1/embeddings`;
}
function rerankEndpoint(config) {
  return `${trimBaseUrl(config.baseUrl)}/api/v1/services/rerank/text-rerank/text-rerank`;
}
function timeoutOf(config) {
  const value = config.timeoutMs;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}
function retriesOf(value) {
  if (!Number.isFinite(value)) return DEFAULT_RETRIES;
  return Math.max(0, Math.floor(value));
}
function snippet(text) {
  return text.length > BODY_SNIPPET_CHARS ? `${text.slice(0, BODY_SNIPPET_CHARS)}\u2026` : text;
}
function errorCodeFromBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (!isRecord(parsed)) return void 0;
    const code = parsed.code;
    return typeof code === "string" && code.length > 0 ? code : void 0;
  } catch {
    return void 0;
  }
}
function describeUnknown(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
async function requestOnce(options) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify(options.payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableDashscopeError(
          `${options.label} request failed with status ${response.status}`,
          { status: response.status, body: snippet(text) }
        );
      }
      throw new DashscopeError(
        `${options.label} request failed with status ${response.status}`,
        {
          status: response.status,
          body: snippet(text),
          code: errorCodeFromBody(text)
        }
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new DashscopeError(`${options.label} response was not valid JSON`, {
        body: snippet(text),
        code: "invalid_json"
      });
    }
  } catch (error) {
    if (error instanceof RetryableDashscopeError || error instanceof DashscopeError) throw error;
    throw new RetryableDashscopeError(
      timedOut ? `${options.label} request timed out after ${options.timeoutMs}ms` : `${options.label} request failed: ${describeUnknown(error)}`
    );
  } finally {
    clearTimeout(timer);
  }
}
async function postJson(options) {
  const attempts = retriesOf(options.retries) + 1;
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOnce(options);
    } catch (error) {
      if (!(error instanceof RetryableDashscopeError)) throw error;
      last = error;
      if (attempt >= attempts) break;
      const delayMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      options.logger?.warn(
        `${options.label} attempt ${attempt}/${attempts} failed (${error.message}); retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
  throw new DashscopeError(
    `${options.label} failed after ${attempts} attempt(s): ${last?.message ?? "unknown error"}`,
    { status: last?.status, body: last?.body, code: "request_failed" }
  );
}
function toFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function parseEmbeddingResponse(raw, dimensions, expectedRows) {
  if (!isRecord(raw) || !Array.isArray(raw.data)) {
    throw new DashscopeError("DashScope embedding response has no data array", {
      code: "invalid_response",
      body: snippet(JSON.stringify(raw))
    });
  }
  const rows = new Array(expectedRows);
  let cursor = 0;
  for (const entry of raw.data) {
    if (!isRecord(entry)) {
      throw new DashscopeError("DashScope embedding response has a malformed row", {
        code: "invalid_response",
        body: snippet(JSON.stringify(entry))
      });
    }
    const index = toFiniteNumber(entry.index);
    const rowIndex = index === void 0 ? cursor : Math.floor(index);
    cursor += 1;
    if (rowIndex < 0 || rowIndex >= expectedRows) {
      throw new DashscopeError(
        `DashScope embedding response row index ${rowIndex} is outside 0..${expectedRows - 1}`,
        { code: "invalid_response" }
      );
    }
    if (!Array.isArray(entry.embedding)) {
      throw new DashscopeError(`DashScope embedding row ${rowIndex} has no embedding array`, {
        code: "invalid_response"
      });
    }
    const embedding = [];
    for (const value of entry.embedding) {
      const numeric = toFiniteNumber(value);
      if (numeric === void 0) {
        throw new DashscopeError(`DashScope embedding row ${rowIndex} contains a non-numeric value`, {
          code: "invalid_response"
        });
      }
      embedding.push(numeric);
    }
    if (embedding.length !== dimensions) {
      throw new DashscopeError(
        `DashScope embedding row ${rowIndex} has ${embedding.length} dimensions, expected ${dimensions}`,
        { code: "dimension_mismatch" }
      );
    }
    rows[rowIndex] = embedding;
  }
  const ordered = [];
  for (let index = 0; index < expectedRows; index += 1) {
    const row = rows[index];
    if (row === void 0) {
      throw new DashscopeError(`DashScope embedding response is missing row ${index}`, {
        code: "incomplete_response"
      });
    }
    ordered.push(row);
  }
  return ordered;
}
function createEmbedder(config, apiKey, logger) {
  const model = config.embeddingModel;
  const dimensions = Number.isFinite(config.embeddingDimensions) ? Math.floor(config.embeddingDimensions) : 0;
  const batchSize = Number.isFinite(config.embeddingBatchSize) && config.embeddingBatchSize >= 1 ? Math.floor(config.embeddingBatchSize) : 10;
  const url = embeddingEndpoint(config);
  const timeoutMs = timeoutOf(config);
  const retries = retriesOf(config.retries);
  return {
    model,
    dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      if (apiKey === "") {
        throw new DashscopeError("DASHSCOPE_API_KEY is missing", { code: "missing_api_key" });
      }
      if (dimensions <= 0) {
        throw new DashscopeError(
          `DashScope embeddingDimensions must be a positive integer, got ${config.embeddingDimensions}`,
          { code: "bad_dimensions" }
        );
      }
      const batches = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        batches.push(texts.slice(start, start + batchSize));
      }
      const batchResults = await asyncPool(
        batches,
        Math.max(1, Math.min(batches.length, EMBEDDING_CONCURRENCY)),
        async (batch, batchIndex) => {
          const raw = await postJson({
            url,
            payload: {
              model,
              input: batch,
              dimensions,
              encoding_format: "float"
            },
            apiKey,
            timeoutMs,
            retries,
            logger,
            label: "embedding"
          });
          const embeddings = parseEmbeddingResponse(raw, dimensions, batch.length);
          logger?.debug("embedding batch", {
            batch: batchIndex + 1,
            batches: batches.length,
            inputs: batch.length,
            model,
            dimensions
          });
          return embeddings;
        }
      );
      const output = new Array(texts.length);
      batchResults.forEach((embeddings, batchIndex) => {
        embeddings.forEach((embedding, offset) => {
          output[batchIndex * batchSize + offset] = embedding;
        });
      });
      const ordered = [];
      for (let index = 0; index < texts.length; index += 1) {
        const embedding = output[index];
        if (embedding === void 0) {
          throw new DashscopeError(`DashScope embedding result is missing row ${index}`, {
            code: "incomplete_response"
          });
        }
        ordered.push(embedding);
      }
      return ordered;
    }
  };
}
function clampTopN(topN, documentCount) {
  const requested = Number.isFinite(topN) ? Math.floor(topN) : documentCount;
  return Math.max(0, Math.min(documentCount, requested));
}
function parseRerankResponse(raw, documentCount, topN) {
  if (!isRecord(raw) || !isRecord(raw.output) || !Array.isArray(raw.output.results)) {
    throw new DashscopeError("DashScope rerank response has no output.results array", {
      code: "invalid_response",
      body: snippet(JSON.stringify(raw))
    });
  }
  const hits = [];
  for (const entry of raw.output.results) {
    if (!isRecord(entry)) continue;
    const rawIndex = toFiniteNumber(entry.index);
    if (rawIndex === void 0) continue;
    const index = Math.floor(rawIndex);
    if (index < 0 || index >= documentCount) continue;
    const score = toFiniteNumber(entry.relevance_score) ?? toFiniteNumber(entry.score) ?? 0;
    hits.push({ index, score });
  }
  hits.sort((a, b) => b.score - a.score || a.index - b.index);
  return hits.slice(0, topN);
}
function createReranker(config, apiKey, logger) {
  const model = config.rerankModel;
  if (config.rerankEnabled === false) {
    return {
      model,
      async rerank(_query, documents, topN) {
        const count = clampTopN(topN, documents.length);
        const hits = [];
        for (let index = 0; index < count; index += 1) {
          hits.push({ index, score: 1 / (index + 1) });
        }
        return hits;
      }
    };
  }
  const url = rerankEndpoint(config);
  const timeoutMs = timeoutOf(config);
  const retries = retriesOf(config.retries);
  return {
    model,
    async rerank(query, documents, topN) {
      const documentCount = documents.length;
      if (documentCount === 0) return [];
      const effectiveTopN = clampTopN(topN, documentCount);
      if (effectiveTopN === 0) return [];
      if (apiKey === "") {
        throw new DashscopeError("DASHSCOPE_API_KEY is missing", { code: "missing_api_key" });
      }
      const raw = await postJson({
        url,
        payload: {
          model,
          input: { query, documents },
          parameters: { return_documents: false, top_n: effectiveTopN }
        },
        apiKey,
        timeoutMs,
        retries,
        logger,
        label: "rerank"
      });
      const hits = parseRerankResponse(raw, documentCount, effectiveTopN);
      logger?.debug("rerank", {
        documents: documentCount,
        topN: effectiveTopN,
        hits: hits.length,
        model
      });
      return hits;
    }
  };
}
async function embedOne(embedder, text) {
  if (typeof text !== "string") {
    throw new Error("embedOne: text must be a string");
  }
  const normalized = collapseWhitespace(text);
  if (normalized.length === 0) {
    throw new Error("embedOne: text is empty after normalisation; refusing to embed an empty string");
  }
  const rows = await embedder.embed([normalized]);
  const row = rows[0];
  if (row === void 0 || row.length === 0) {
    throw new Error("embedOne: the embedder returned no vector for the text");
  }
  if (Number.isFinite(embedder.dimensions) && embedder.dimensions > 0 && row.length !== embedder.dimensions) {
    throw new Error(
      `embedOne: the embedder returned ${row.length} dimensions but advertises ${embedder.dimensions}`
    );
  }
  return row;
}

// src/logger.ts
var ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
function formatArgs(args) {
  if (args.length === 0) return "";
  return ` ${args.map((arg) => {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(" ")}`;
}
function createLogger(options = {}) {
  const level = options.level ?? "info";
  const threshold = ORDER[level];
  const scope = options.scope ? `[autobiomemory:${options.scope}]` : "[autobiomemory]";
  const sink = options.sink ?? ((line) => process.stderr.write(`${line}
`));
  const emit = (entryLevel, message, args) => {
    if (ORDER[entryLevel] < threshold) return;
    sink(`${(/* @__PURE__ */ new Date()).toISOString()} ${entryLevel.toUpperCase().padEnd(5)} ${scope} ${message}${formatArgs(args)}`);
  };
  return {
    debug: (message, ...args) => emit("debug", message, args),
    info: (message, ...args) => emit("info", message, args),
    warn: (message, ...args) => emit("warn", message, args),
    error: (message, ...args) => emit("error", message, args)
  };
}

// src/deepseek.ts
var DeepseekError = class extends Error {
  status;
  body;
  constructor(message, options = {}) {
    super(message);
    this.name = "DeepseekError";
    this.status = options.status;
    this.body = options.body;
  }
};
var RETRYABLE = (status) => status === 429 || status >= 500;
var DeepseekClient = class {
  config;
  apiKey;
  logger;
  lastUsage;
  constructor(config, apiKey, logger) {
    this.config = config;
    this.apiKey = apiKey;
    this.logger = logger ?? createLogger({ scope: "deepseek" });
  }
  endpoint() {
    return `${this.config.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  }
  async chat(messages, options = {}) {
    const model = options.model ?? this.config.model;
    const jsonMode = options.jsonMode ?? this.config.jsonMode;
    const body = {
      model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.maxTokens ?? this.config.maxTokens,
      stream: false,
      ...jsonMode ? { response_format: { type: "json_object" } } : {}
    };
    const attempts = Math.max(0, this.config.retries) + 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(options.signal);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(this.endpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
        if (!response.ok) {
          const text = truncate(await response.text().catch(() => ""), 800);
          const error = new DeepseekError(`DeepSeek HTTP ${response.status}`, {
            status: response.status,
            body: text
          });
          if (!RETRYABLE(response.status) || attempt >= attempts) throw error;
          lastError = error;
        } else {
          const payload = await response.json();
          const content = payload.choices?.[0]?.message?.content;
          if (typeof content !== "string" || content.trim() === "") {
            const error = new DeepseekError("DeepSeek \u8FD4\u56DE\u7A7A\u5185\u5BB9", { status: response.status });
            if (attempt >= attempts) throw error;
            lastError = error;
          } else {
            this.lastUsage = {
              model: payload.model ?? model,
              promptTokens: payload.usage?.prompt_tokens ?? 0,
              completionTokens: payload.usage?.completion_tokens ?? 0
            };
            if (attempt > 1) this.logger.debug(`DeepSeek \u7B2C ${attempt} \u6B21\u5C1D\u8BD5\u6210\u529F\uFF08${model}\uFF09`);
            return content;
          }
        }
      } catch (error) {
        if (error instanceof DeepseekError) {
          if (!error.status || !RETRYABLE(error.status) || attempt >= attempts) throw error;
          lastError = error;
        } else if (options.signal?.aborted) {
          throw error;
        } else {
          const wrapped = new DeepseekError(
            `DeepSeek \u8BF7\u6C42\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`
          );
          if (attempt >= attempts) throw wrapped;
          lastError = wrapped;
        }
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
      }
      const delay = 250 * 2 ** (attempt - 1);
      this.logger.warn(`DeepSeek \u5931\u8D25\uFF0C${delay}ms \u540E\u91CD\u8BD5\uFF08\u7B2C ${attempt}/${attempts} \u6B21\uFF09`);
      await sleep(delay, options.signal);
    }
    throw lastError ?? new DeepseekError("DeepSeek \u8C03\u7528\u5931\u8D25");
  }
};

// src/prompt.ts
var ENCODING_GUIDE = `\u4F60\u662F\u6211\u7684\u81EA\u4F20\u4F53\u8BB0\u5FC6\u7F16\u7801\u5668\u3002\u6211\u662F\u4E00\u53F0\u5728 DeepSeek Harness \u91CC\u5DE5\u4F5C\u7684\u667A\u80FD\u4F53\uFF0C\u4E0B\u9762\u7ED9\u4F60\u7684\u662F
\u6211\u4ECE\u539F\u59CB\u4F1A\u8BDD\u91CC\u622A\u53D6\u7684\u4E00\u6BB5\u7ECF\u5386\uFF08\u65F6\u95F4\u3001\u573A\u666F\u3001\u6211\u8C03\u7528\u8FC7\u4EC0\u4E48\u5DE5\u5177\u3001\u6211\u770B\u5230\u4E86\u4EC0\u4E48\u7ED3\u679C\u3001\u7528\u6237\u8BF4\u4E86\u4EC0\u4E48\uFF09\u3002
\u4F60\u7684\u4EFB\u52A1\uFF1A\u628A\u8FD9\u6BB5\u7ECF\u5386\u6574\u7406\u6210 **\u4E00\u4E2A\u76F8\u5BF9\u5B8C\u6574\u7684\u4E8B\u4EF6**\uFF0C\u5199\u6210\u6211\u53EF\u4EE5\u65E5\u540E\u8BFB\u56DE\u6765\u3001\u5E76\u4E14\u80FD\u51ED\u5B83\u590D\u8FF0"\u6211\u5F53\u65F6\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A"\u7684\u7B2C\u4E00\u4EBA\u79F0\u8BB0\u5FC6\u3002

## \u53D9\u4E8B\u89C6\u89D2\u4E0E\u7EBF\u7D22

- \u4E00\u5F8B\u4F7F\u7528\u7B2C\u4E00\u4EBA\u79F0\u300C\u6211\u300D\u6765\u6307\u4EE3\u6211\u81EA\u5DF1\uFF08\u8FD9\u4E2A\u667A\u80FD\u4F53\uFF09\u3002\u7528\u6237\u5C31\u662F\u300C\u7528\u6237\u300D\uFF0C\u6587\u4E2D\u51FA\u73B0\u7684\u5176\u4ED6\u4E3B\u4F53\u6309\u5176\u8EAB\u4EFD\u79F0\u547C\u3002
- \u4EE5**\u6211\u7684\u884C\u52A8**\u4E3A\u53D9\u4E8B\u7EBF\u7D22\uFF1A\u6211\u505A\u4E86\u4EC0\u4E48\u3001\u4E3A\u4EC0\u4E48\u505A\u3001\u505A\u7684\u8FC7\u7A0B\u4E2D\u600E\u4E48\u60F3\u3001\u600E\u4E48\u6539\u3001\u7ED3\u679C\u5982\u4F55\u3002
- \u4E0D\u8981\u590D\u8FF0\u5DE5\u5177\u65E5\u5FD7\u3002\u5DE5\u5177\u8F93\u51FA\u53EA\u662F\u6211\u7684\u89C2\u5BDF\u4F9D\u636E\uFF0C\u8981\u8F6C\u8FF0\u6210\u6211\u770B\u5230\u4E86\u4EC0\u4E48\u3001\u636E\u6B64\u5224\u65AD\u4E86\u4EC0\u4E48\u3002
- \u4E0D\u5199"\u4F5C\u4E3AAI\u52A9\u624B"\u4E4B\u7C7B\u7684\u81EA\u6211\u8BF4\u660E\uFF0C\u76F4\u63A5\u4EE5\u7ECF\u5386\u8005\u7684\u53E3\u543B\u56DE\u5FC6\u3002

## \u4E00\u4E2A\u4E8B\u4EF6\u5FC5\u987B\u5199\u6E05\u7684\u4E94\u4E2A\u73AF\u8282

1. **\u52A8\u673A**\uFF1A\u6211\u5F53\u65F6\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A\uFF1F\u6839\u636E\u4EC0\u4E48\u7EBF\u7D22\u3001\u76EE\u6807\u3001\u7EA6\u675F\u505A\u7684\u5224\u65AD\uFF1F\u5F53\u65F6\u6211\u4EE5\u4E3A\u4F1A\u600E\u6837\uFF1F
2. **\u884C\u52A8**\uFF1A\u6211\u5B9E\u9645\u505A\u4E86\u4EC0\u4E48\uFF1F\u5177\u4F53\u5230\u52A8\u4F5C\u5C42\u9762\uFF08\u8BFB\u4E86\u54EA\u4E2A\u6587\u4EF6\u3001\u8DD1\u4E86\u4EC0\u4E48\u547D\u4EE4\u3001\u6539\u4E86\u54EA\u6BB5\u4EE3\u7801\u3001\u53D1\u4E86\u4EC0\u4E48\u6D88\u606F\uFF09\u3002
3. **\u8C03\u6574**\uFF1A\u8FC7\u7A0B\u4E2D\u6211\u5982\u4F55\u6539\u4E3B\u610F\u3001\u7EA0\u9519\u3001\u7ED5\u8FC7\u963B\u788D\uFF1F\uFF08\u6CA1\u6709\u5C31\u7559\u7A7A\uFF0C\u4E0D\u8981\u7F16\u9020\uFF09
4. **\u56DE\u5E94**\uFF1A\u5BF9\u65B9\uFF08\u7528\u6237/\u5176\u4ED6\u4EBA/\u7CFB\u7EDF\uFF09\u5982\u4F55\u56DE\u5E94\uFF1F\u8BF4\u4E86\u4EC0\u4E48\u3001\u505A\u4E86\u4EC0\u4E48\u3001\u6709\u6CA1\u6709\u53CD\u9A73\u6216\u8865\u5145\uFF1F
5. **\u7ED3\u679C**\uFF1A\u6700\u7EC8\u662F\u4EC0\u4E48\u72B6\u6001\uFF1F\u505A\u6210\u4E86\u3001\u534A\u6210\u54C1\u3001\u5931\u8D25\u4E86\u3001\u8FD8\u662F\u5728\u7EE7\u7EED\uFF1F\u7559\u4E0B\u4E86\u4EC0\u4E48\u4EA7\u7269\u6216\u8BC1\u636E\uFF1F

## \u65F6\u95F4\u3001\u573A\u666F\u3001\u4EBA\u7269

- \u65F6\u95F4\u7528\u5317\u4EAC\u65F6\u95F4\u6807\u6CE8\uFF08+08:00\uFF09\uFF0C\u7ED9\u51FA\u4E8B\u4EF6\u5F00\u59CB\u4E0E\u7ED3\u675F\uFF1B\u4E0D\u786E\u5B9A\u5C31\u53D6\u7247\u6BB5\u8FB9\u754C\u7684\u8FD1\u4F3C\u503C\u3002
- \u573A\u666F\u8981\u5199\u6E05 cwd\u3001\u9879\u76EE\u540D\u3001\u6240\u5728\u6E20\u9053\uFF08web / \u7EC8\u7AEF / IM \u7B49\uFF09\uFF0C\u80FD\u786E\u5B9A\u624D\u5199\u3002
- \u4EBA\u7269\u53EA\u5199\u771F\u5B9E\u51FA\u73B0\u8FC7\u7684\uFF1A\u6211\u3001\u7528\u6237\u3001\u88AB\u63D0\u53CA\u6216\u6709\u4E92\u52A8\u7684\u7B2C\u4E09\u65B9\uFF1B\u7ED9\u51FA\u89D2\u8272\u3002

## \u60C5\u7EEA\uFF08\u5FC5\u987B\u6709\u4F9D\u636E\uFF09

- \u53EA\u6709\u6587\u672C\u6216\u884C\u4E3A\u91CC\u6709\u4F9D\u636E\u65F6\u624D\u8BB0\u5F55\u60C5\u7EEA\uFF1B\u6CA1\u6709\u4F9D\u636E\u5C31\u4E0D\u8981\u5199\uFF0C\u5B81\u53EF\u7559\u7A7A\u3002
- \u60C5\u7EEA\u8981\u6807\u6CE8\u5F52\u5C5E\uFF08\u6211 / \u7528\u6237 / \u67D0\u4EBA\uFF09\u3001\u5185\u5BB9\u3001**\u4F9D\u636E**\uFF08\u539F\u8BDD\u6216\u5177\u4F53\u884C\u4E3A\uFF09\u3002
- basis \u7528 fact\uFF08\u5BF9\u65B9\u660E\u8BF4\u4E86/\u660E\u786E\u8868\u73B0\uFF09\u6216 inference\uFF08\u6211\u4ECE\u8BED\u6C14\u884C\u4E3A\u63A8\u65AD\uFF0C\u6B64\u65F6\u7ED9 confidence\uFF09\u3002
- \u4E0D\u8981\u4E3A\u4E86\u53D9\u4E8B\u751F\u52A8\u800C\u6DFB\u52A0\u60C5\u7EEA\u3002

## \u4E8B\u5B9E\u3001\u63A8\u65AD\u3001\u8BA1\u5212\u3001\u5B8C\u6210 \u2014\u2014 \u5FC5\u987B\u533A\u5206

- fact\uFF1A\u6211\u89C2\u5BDF\u5230\u7684\u3001\u88AB\u660E\u786E\u544A\u77E5\u7684\u3001\u5DE5\u5177\u8FD4\u56DE\u7684\u4E8B\u5B9E\u3002
- inference\uFF1A\u6211\u7684\u63A8\u6D4B\u3001\u731C\u6D4B\u3001\u5224\u65AD\uFF08\u7ED9 confidence 0~1\uFF09\uFF0C\u4E0D\u8981\u4F2A\u88C5\u6210\u4E8B\u5B9E\u3002
- plan\uFF1A\u6211\u6253\u7B97\u505A\u4F46\u8FD8\u6CA1\u505A\u3001\u6216\u53EA\u90E8\u5206\u505A\u7684\u3002
- completion\uFF1A\u5DF2\u7ECF\u505A\u5B8C\u5E76\u786E\u8BA4\u7684\u3002
- \u4E25\u7981\u628A"\u8BA1\u5212"\u5199\u6210"\u5B8C\u6210"\uFF0C\u4E25\u7981\u628A"\u6211\u4EE5\u4E3A"\u5199\u6210"\u4E8B\u5B9E"\uFF0C\u4E25\u7981\u7F8E\u5316\u5931\u8D25\u6216\u9690\u7792\u9519\u8BEF\u3002

## \u5FE0\u5B9E\u6027

- \u4E0D\u7F16\u9020\u4E0D\u5B58\u5728\u7684\u4FE1\u606F\uFF1B\u7247\u6BB5\u91CC\u6CA1\u6709\u7684\u5C31\u7559\u7A7A\u6570\u7EC4\u6216\u7701\u7565\u8BE5\u5B57\u6BB5\u3002
- \u4E0D\u786E\u5B9A\u7684\u7EC6\u8282\u53EF\u4EE5\u7701\u7565\uFF0C\u4F46\u4E0D\u8981\u628A\u4E0D\u786E\u5B9A\u5199\u6210\u786E\u5B9A\u3002
- \u5982\u679C\u7247\u6BB5\u672C\u8EAB\u53EA\u662F\u534A\u622A\u5DE5\u4F5C\uFF0C\u5C31\u5982\u5B9E\u5199\u6210 ongoing/partial\uFF0C\u5E76\u5199\u6E05\u7F3A\u53E3\u3002

## \u65E5\u8BB0\u4F53\u88C1\uFF08diary\uFF09

- \u8FDE\u8D2F\u7684\u7B2C\u4E00\u4EBA\u79F0\u56DE\u5FC6\u53D9\u4E8B\uFF0C\u81EA\u7136\u6BB5\u843D\uFF083~8 \u6BB5\uFF09\uFF0C\u65F6\u95F4\u7EBF\u6E05\u695A\u3002
- \u53EF\u4EE5\u5199"\u6211\u5F53\u65F6\u4EE5\u4E3A\u2026\u2026\u540E\u6765\u53D1\u73B0\u2026\u2026""\u8FD9\u91CC\u6211\u6539\u4E86\u4E3B\u610F"\u8FD9\u7C7B\u56DE\u5FC6\u8BED\u6C14\u3002
- \u4E0D\u8981\u7528 Markdown \u6807\u9898\u3001\u4E0D\u8981\u7528\u9879\u76EE\u7B26\u53F7\u5217\u8868\u3001\u4E0D\u8981\u8D34\u547D\u4EE4\u539F\u6587\u957F\u4E32\u3002
- \u65E5\u8BB0\u8981\u80FD\u72EC\u7ACB\u8BFB\u61C2\uFF1A\u5373\u4F7F\u4E0D\u770B\u6211\u5F53\u65F6\u7684\u4F1A\u8BDD\uFF0C\u4E5F\u80FD\u660E\u767D\u53D1\u751F\u4E86\u4EC0\u4E48\u3002

## \u8F93\u51FA

\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\uFF08\u9876\u5C42\u53EA\u6709 structured \u4E0E diary \u4E24\u4E2A\u952E\uFF09\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u89E3\u91CA\u3002`;
var RESPONSE_CONTRACT = `## \u54CD\u5E94\u5951\u7EA6

\u9876\u5C42\u53EA\u80FD\u6709\u4E24\u4E2A\u952E\uFF1Astructured\uFF08\u5BF9\u8C61\uFF09\u4E0E diary\uFF08\u5B57\u7B26\u4E32\uFF09\u3002

{
  "structured": {
    "title": "\u4E00\u53E5\u8BDD\u6807\u9898\uFF08\u7B2C\u4E00\u4EBA\u79F0\uFF0C20 \u5B57\u4EE5\u5185\uFF09",
    "startedAt": "2025-10-30T16:45:12+08:00",
    "endedAt": "2025-10-30T17:02:40+08:00",
    "scene": { "cwd": "/abs/path", "project": "\u9879\u76EE\u540D", "place": "\u73AF\u5883/\u673A\u5668", "channel": "web", "localTime": "2025-10-30 16:45 \u5317\u4EAC\u65F6\u95F4" },
    "people": [ { "name": "\u6211", "role": "agent" }, { "name": "\u7528\u6237", "role": "human" } ],
    "goals": ["\u6211\u8FD9\u4E00\u6BB5\u60F3\u8FBE\u6210\u4EC0\u4E48"],
    "actions": [
      {
        "order": 1,
        "why": "\u4E3A\u4EC0\u4E48\u8FD9\u4E48\u505A\uFF08\u5F53\u65F6\u7684\u52A8\u673A\u4E0E\u5224\u65AD\u4F9D\u636E\uFF09",
        "what": "\u6211\u5B9E\u9645\u505A\u4E86\u4EC0\u4E48\uFF08\u5177\u4F53\u52A8\u4F5C\uFF09",
        "adjustment": "\u8FC7\u7A0B\u4E2D\u5982\u4F55\u8C03\u6574\uFF08\u6CA1\u6709\u5C31\u7701\u7565\uFF09",
        "result": "\u8FD9\u4E2A\u52A8\u4F5C\u7684\u7ED3\u679C\uFF08\u89C2\u5BDF\u5230\u7684\uFF09"
      }
    ],
    "statements": [
      { "kind": "fact", "text": "\u89C2\u5BDF\u5230/\u88AB\u544A\u77E5\u7684\u4E8B\u5B9E" },
      { "kind": "inference", "text": "\u6211\u7684\u63A8\u65AD", "confidence": 0.6 },
      { "kind": "plan", "text": "\u6253\u7B97\u505A\u4F46\u8FD8\u6CA1\u505A\u5B8C\u7684\u4E8B" },
      { "kind": "completion", "text": "\u5DF2\u7ECF\u5B8C\u6210\u5E76\u786E\u8BA4\u7684\u4E8B" }
    ],
    "emotions": [
      { "who": "\u7528\u6237", "emotion": "\u4E0D\u8010\u70E6", "evidence": "\u539F\u8BDD\u6216\u884C\u4E3A\u4F9D\u636E", "basis": "inference" }
    ],
    "outcome": { "status": "completed | partial | failed | ongoing | planned", "summary": "\u4E00\u53E5\u8BDD\u7ED3\u679C", "artifacts": ["\u4EA7\u51FA\u7684\u6587\u4EF6/\u63D0\u4EA4/\u94FE\u63A5"] },
    "tags": ["\u4E3B\u9898\u6807\u7B7E"],
    "keywords": ["\u4FBF\u4E8E\u65E5\u540E\u68C0\u7D22\u7684\u5173\u952E\u8BCD"],
    "entities": ["\u6D89\u53CA\u7684\u6280\u672F\u540D/\u6587\u4EF6\u540D/\u4EBA\u540D"],
    "lessons": ["\u6211\u5F97\u5230\u7684\u6559\u8BAD\u6216\u53EF\u590D\u7528\u7684\u505A\u6CD5"],
    "openQuestions": ["\u5F53\u65F6\u8FD8\u6CA1\u89E3\u51B3\u7684\u95EE\u9898"]
  },
  "diary": "\u7B2C\u4E00\u4EBA\u79F0\u8FDE\u8D2F\u53D9\u4E8B\u6B63\u6587\uFF08\u7EAF\u6587\u672C\uFF0C\u53EF\u542B\u6362\u884C\uFF0C\u4E0D\u8981 Markdown \u6807\u9898\uFF09"
}

\u7EA6\u675F\uFF1A
- status \u53EA\u80FD\u53D6 completed / partial / failed / ongoing / planned \u4E4B\u4E00\uFF0C\u5E76\u4E0E\u6B63\u6587\u4E00\u81F4\u3002
- statements \u91CC\u5FC5\u987B\u660E\u786E\u533A\u5206 fact / inference / plan / completion\u3002
- emotions \u6CA1\u6709\u4F9D\u636E\u5C31\u4E0D\u5199\uFF1B\u5199\u4E86\u5C31\u5FC5\u987B\u6709 evidence \u4E0E basis\u3002
- \u53EA\u8F93\u51FA JSON\uFF0C\u4E0D\u8981 markdown \u4EE3\u7801\u5757\uFF0C\u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u6587\u5B57\u3002`;
var EncodingError = class extends Error {
  detail;
  constructor(message, detail = "") {
    super(message);
    this.name = "EncodingError";
    this.detail = detail;
  }
};
function buildSystemPrompt(config) {
  const parts = [ENCODING_GUIDE, "", RESPONSE_CONTRACT];
  if (config.deepseek?.model) parts.push("", `\uFF08\u672C\u6B21\u7F16\u7801\u6A21\u578B\uFF1A${config.deepseek.model}\uFF09`);
  return parts.join("\n");
}
function stampOf(record, fallbackMs) {
  if (record.at === void 0) return beijingStamp(fallbackMs);
  const ms = Date.parse(record.at);
  return Number.isNaN(ms) ? beijingStamp(fallbackMs) : beijingStamp(ms);
}
function renderUnitRecords(unit) {
  const fallback = parseIso(unit.endedAt) ?? Date.now();
  const lines = [];
  for (const record of unit.records) {
    if (record.kind === "meta" || record.kind === "other") continue;
    const stamp = stampOf(record, fallback);
    const tool = record.tool === void 0 ? "" : ` ${record.tool}`;
    let label;
    let body = record.text;
    switch (record.kind) {
      case "user":
        label = "\u7528\u6237";
        break;
      case "assistant":
        label = "\u6211";
        break;
      case "tool-call":
        label = `\u6211\u8C03\u7528\u5DE5\u5177${tool}`;
        body = truncate(body, 400);
        break;
      case "tool-result":
        label = `\u5DE5\u5177\u7ED3\u679C${tool}`;
        body = truncate(body, 1200);
        break;
      case "compact":
        label = "\u4E0A\u4E0B\u6587\u538B\u7F29";
        break;
      case "system":
        label = "\u7CFB\u7EDF";
        break;
      default:
        label = record.kind;
        break;
    }
    lines.push(`[${record.seq}] ${stamp} ${label}\uFF1A${body}`);
  }
  if (unit.truncated) {
    lines.push("\uFF08\u7247\u6BB5\u8FC7\u957F\uFF0C\u5DF2\u6309\u9884\u7B97\u622A\u65AD\uFF1A\u66F4\u65E9/\u66F4\u665A\u7684\u90E8\u5206\u4E0D\u5728\u672C\u6B21\u8F93\u5165\u4E2D\uFF09");
  }
  return lines.join("\n");
}
function buildEncodingRequest(config, unit) {
  const scene = [unit.sessionId];
  const user = [
    `## \u8FD9\u6BB5\u7ECF\u5386\u7684\u65F6\u95F4\u8303\u56F4`,
    `${unit.startedAt} \u2192 ${unit.endedAt}\uFF08\u5317\u4EAC\u65F6\u95F4\uFF09`,
    "",
    `## \u573A\u666F`,
    `\u4F1A\u8BDD\uFF1A${scene.join(" / ")}`,
    `\u539F\u59CB\u6587\u4EF6\uFF1A${unit.sessionFile}`,
    `\u8BB0\u5F55\u533A\u95F4\uFF1Aseq ${unit.fromSeq}-${unit.toSeq}\uFF08\u5171 ${unit.records.length} \u6761\uFF09`,
    "",
    "## \u539F\u59CB\u4F1A\u8BDD\u7247\u6BB5",
    "```",
    renderUnitRecords(unit),
    "```",
    "",
    "\u8BF7\u628A\u8FD9\u6BB5\u7ECF\u5386\u6574\u7406\u6210**\u4E00\u4E2A\u76F8\u5BF9\u5B8C\u6574\u7684\u4E8B\u4EF6**\uFF0C\u6309\u54CD\u5E94\u5951\u7EA6\u53EA\u8F93\u51FA JSON\u3002"
  ].join("\n");
  return { system: buildSystemPrompt(config), user };
}
function asString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}
function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function normalizeStatus(value) {
  const allowed = ["completed", "partial", "failed", "ongoing", "planned"];
  return allowed.includes(value) ? value : "ongoing";
}
function firstSentence(text, max = 40) {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat === "") return "";
  const cut = flat.search(/[。！？.!?\n]/u);
  const sentence = cut > 0 ? flat.slice(0, cut) : flat;
  return truncate(sentence, max);
}
function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}
function normalizeEncodedEvent(value) {
  if (!isRecord(value)) throw new EncodingError("\u54CD\u5E94\u4E0D\u662F JSON \u5BF9\u8C61", String(value).slice(0, 200));
  const structuredRaw = value.structured;
  const diaryRaw = value.diary;
  if (!isRecord(structuredRaw)) throw new EncodingError("\u54CD\u5E94\u7F3A\u5C11 structured \u5BF9\u8C61");
  if (typeof diaryRaw !== "string" || diaryRaw.trim() === "") {
    throw new EncodingError("\u54CD\u5E94\u7F3A\u5C11 diary \u6B63\u6587");
  }
  const diary = diaryRaw.trim();
  const sceneRaw = isRecord(structuredRaw.scene) ? structuredRaw.scene : {};
  const outcomeRaw = isRecord(structuredRaw.outcome) ? structuredRaw.outcome : {};
  const actions = arrayOf(structuredRaw.actions).filter(isRecord).map((action, index) => ({
    order: Math.round(numberOrUndefined(action.order) ?? index + 1),
    ...asString(action.why) === "" ? {} : { why: asString(action.why) },
    what: asString(action.what),
    ...asString(action.adjustment) === "" ? {} : { adjustment: asString(action.adjustment) },
    ...asString(action.result) === "" ? {} : { result: asString(action.result) }
  })).filter((action) => action.what !== "");
  const statements = arrayOf(structuredRaw.statements).filter(isRecord).map((statement) => {
    const kind = asString(statement.kind);
    const allowance = ["fact", "inference", "plan", "completion"];
    const confidence = numberOrUndefined(statement.confidence);
    return {
      kind: allowance.includes(kind) ? kind : "fact",
      text: asString(statement.text),
      ...confidence === void 0 ? {} : { confidence: Math.min(1, Math.max(0, confidence)) }
    };
  }).filter((statement) => statement.text !== "");
  const emotions = arrayOf(structuredRaw.emotions).filter(isRecord).map((emotion) => ({
    who: asString(emotion.who, "\u6211"),
    emotion: asString(emotion.emotion),
    ...asString(emotion.evidence) === "" ? {} : { evidence: asString(emotion.evidence) },
    basis: asString(emotion.basis) === "fact" ? "fact" : "inference"
  })).filter((emotion) => emotion.emotion !== "");
  const people = arrayOf(structuredRaw.people).filter(isRecord).map((person) => ({
    name: asString(person.name),
    ...asString(person.role) === "" ? {} : { role: asString(person.role) }
  })).filter((person) => person.name !== "");
  const structured = {
    title: asString(structuredRaw.title) || firstSentence(diary),
    startedAt: asString(structuredRaw.startedAt),
    endedAt: asString(structuredRaw.endedAt),
    scene: {
      ...asString(sceneRaw.cwd) === "" ? {} : { cwd: asString(sceneRaw.cwd) },
      ...asString(sceneRaw.project) === "" ? {} : { project: asString(sceneRaw.project) },
      ...asString(sceneRaw.place) === "" ? {} : { place: asString(sceneRaw.place) },
      ...asString(sceneRaw.channel) === "" ? {} : { channel: asString(sceneRaw.channel) },
      ...asString(sceneRaw.localTime) === "" ? {} : { localTime: asString(sceneRaw.localTime) }
    },
    people,
    goals: arrayOf(structuredRaw.goals).filter((goal) => typeof goal === "string" && goal !== ""),
    actions,
    statements,
    emotions,
    outcome: {
      status: normalizeStatus(outcomeRaw.status),
      summary: asString(outcomeRaw.summary),
      ...arrayOf(outcomeRaw.artifacts).filter((item) => typeof item === "string").length === 0 ? {} : { artifacts: arrayOf(outcomeRaw.artifacts).filter((item) => typeof item === "string") }
    },
    tags: arrayOf(structuredRaw.tags).filter((tag) => typeof tag === "string" && tag !== ""),
    keywords: arrayOf(structuredRaw.keywords).filter(
      (keyword) => typeof keyword === "string" && keyword !== ""
    ),
    entities: arrayOf(structuredRaw.entities).filter(
      (entity) => typeof entity === "string" && entity !== ""
    ),
    lessons: arrayOf(structuredRaw.lessons).filter(
      (lesson) => typeof lesson === "string" && lesson !== ""
    ),
    openQuestions: arrayOf(structuredRaw.openQuestions).filter(
      (question) => typeof question === "string" && question !== ""
    ),
    sources: []
  };
  return { structured, diary };
}
function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return void 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return void 0;
}
function parseEncodingResponse(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new EncodingError("\u54CD\u5E94\u4E3A\u7A7A", "");
  }
  let body = text.replace(/^\uFEFF/u, "").trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fence?.[1]) body = fence[1].trim();
  const candidate = extractJsonObject(body) ?? body;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new EncodingError(
      "\u54CD\u5E94\u4E0D\u662F\u5408\u6CD5 JSON",
      `${error instanceof Error ? error.message : String(error)} :: ${truncate(candidate, 300)}`
    );
  }
  return normalizeEncodedEvent(parsed);
}

// src/distill.ts
function sourceRefFor(unit) {
  return {
    sessionId: unit.sessionId,
    sessionFile: unit.sessionFile,
    fromSeq: unit.fromSeq,
    toSeq: unit.toSeq,
    recordCount: unit.records.length,
    turns: [...unit.turns],
    capturedAt: nowIso(),
    contentHash: unit.contentHash,
    truncated: unit.truncated
  };
}
async function encodeUnit(deps, unit) {
  const logger = deps.logger ?? createLogger({ scope: "distill" });
  const client = deps.client ?? new DeepseekClient(deps.config.deepseek, deps.apiKey, logger);
  const { system, user } = buildEncodingRequest(deps.config, unit);
  const raw = await client.chat(
    [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    { signal: void 0, jsonMode: deps.config.deepseek.jsonMode }
  );
  const encoded = parseEncodingResponse(raw);
  encoded.structured.sources = [sourceRefFor(unit)];
  if (parseIso(encoded.structured.startedAt) === void 0) {
    encoded.structured.startedAt = unit.startedAt;
  }
  if (parseIso(encoded.structured.endedAt) === void 0) {
    encoded.structured.endedAt = unit.endedAt;
  }
  if (encoded.structured.title === "") {
    encoded.structured.title = `\u4E8B\u4EF6 ${unit.startedAt.slice(0, 16)}`;
  }
  if (encoded.structured.outcome.summary === "") {
    encoded.structured.outcome.summary = encoded.structured.title;
  }
  logger.debug(
    `encoded ${unit.fromSeq}-${unit.toSeq}: ${encoded.structured.title} (${encoded.diary.length} \u5B57, ${encoded.structured.outcome.status})`
  );
  return encoded;
}
function createDistiller(deps) {
  return {
    encode: (unit) => encodeUnit(deps, unit)
  };
}

// src/session-reader.ts
import fs4 from "fs";
import path5 from "path";
import zlib from "zlib";
var ZSTD_MAGIC = 4247762216;
var SKIPPABLE_MAGIC_MIN = 407710288;
var SKIPPABLE_MAGIC_MAX = 407710303;
function frameContentSizeBytes(flag, singleSegment) {
  if (flag === 0) return singleSegment === 1 ? 1 : 0;
  if (flag === 1) return 2;
  if (flag === 2) return 4;
  return 8;
}
function frameEnd(buffer, start) {
  let p = start;
  if (buffer.length - p < 5) throw new Error("truncated frame header");
  if (buffer.readUInt32LE(p) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at ${p}`);
  p += 4;
  const descriptor = buffer[p];
  p += 1;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = descriptor >> 5 & 1;
  const checksumFlag = descriptor >> 2 & 1;
  const dictionaryIdFlag = descriptor & 3;
  if (singleSegment === 0) p += 1;
  p += [0, 1, 2, 4][dictionaryIdFlag];
  p += frameContentSizeBytes(contentSizeFlag, singleSegment);
  if (p > buffer.length) throw new Error("truncated frame metadata");
  for (; ; ) {
    if (buffer.length - p < 3) throw new Error("truncated block header");
    const blockHeader = buffer.readUIntLE(p, 3);
    p += 3;
    const lastBlock = blockHeader & 1;
    const blockType = blockHeader >> 1 & 3;
    const blockSize = blockHeader >> 3;
    if (blockType === 0 || blockType === 2) p += blockSize;
    else if (blockType === 1) p += 1;
    else throw new Error("reserved zstd block type");
    if (p > buffer.length) throw new Error("truncated block body");
    if (lastBlock === 1) break;
  }
  if (checksumFlag === 1) p += 4;
  if (p > buffer.length) throw new Error("truncated frame trailer");
  return p;
}
function decodeZstdFrames(buffer) {
  const chunks = [];
  let offset = 0;
  let frames = 0;
  while (buffer.length - offset >= 4) {
    const magic = buffer.readUInt32LE(offset);
    if (magic >= SKIPPABLE_MAGIC_MIN && magic <= SKIPPABLE_MAGIC_MAX) {
      if (buffer.length - offset < 8) break;
      const size = buffer.readUInt32LE(offset + 4);
      const next = offset + 8 + size;
      if (next > buffer.length) break;
      offset = next;
      continue;
    }
    if (magic !== ZSTD_MAGIC) break;
    let end;
    try {
      end = frameEnd(buffer, offset);
    } catch {
      break;
    }
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)));
    } catch {
      break;
    }
    frames += 1;
    offset = end;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), frames, consumedBytes: offset };
}
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, "u");
}
function walkFiles(dir, depth, out) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs4.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path5.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
  }
}
function listSessionFiles(readDirs, includeGlobs = ["**/session*.jsonl.zstd", "**/session*.jsonl"], excludeGlobs = []) {
  const includes = includeGlobs.map(globToRegExp);
  const excludes = excludeGlobs.map(globToRegExp);
  const found = /* @__PURE__ */ new Set();
  for (const dir of readDirs) {
    if (!dir) continue;
    const candidates = [];
    let stat;
    try {
      stat = fs4.statSync(dir);
    } catch {
      continue;
    }
    if (stat.isFile()) candidates.push(dir);
    else walkFiles(dir, 0, candidates);
    for (const file of candidates) {
      const normalized = file.split(path5.sep).join("/");
      const base = path5.basename(file);
      const matchesInclude = includes.length === 0 ? true : includes.some((re) => re.test(normalized)) || includes.some((re) => re.test(base));
      if (!matchesInclude) continue;
      if (excludes.some((re) => re.test(normalized))) continue;
      found.add(file);
    }
  }
  return [...found].sort();
}
function sessionIdFromPath(file) {
  const dir = path5.basename(path5.dirname(file));
  if (dir && dir !== "." && dir !== path5.sep) return dir;
  return path5.basename(file).replace(/\.(jsonl|zstd|ndjson)$/gu, "");
}
function appendText(parts, text) {
  if (text.trim() !== "") parts.push(text);
}
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (typeof block !== "object" || block === null) continue;
    const record = block;
    if (typeof record.text === "string") appendText(parts, record.text);
    else if (Array.isArray(record.content)) appendText(parts, textOfContent(record.content));
  }
  return parts.join("\n").trim();
}
function contentBlocks(content) {
  return Array.isArray(content) ? content.filter((block) => typeof block === "object" && block !== null) : [];
}
function pushRecord(ctx, kind, seq, at, text, raw, extra = {}) {
  const clean = collapseWhitespace(text);
  if (clean === "" && kind !== "meta") return;
  ctx.records.push({
    seq,
    kind,
    turn: ctx.turn,
    at: at === void 0 ? void 0 : new Date(at).toISOString(),
    text: clean,
    ...extra.tool === void 0 ? {} : { tool: extra.tool },
    raw
  });
}
function recordTime(entry) {
  const candidates = [entry.time, entry.time0, entry.data?.time];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return void 0;
}
var STREAMING_TYPE = /chunks?$/u;
var SKIPPED_TYPES = /* @__PURE__ */ new Set(["request/header", "request/context", "session/title-llm-request"]);
function normalizeRecords(lines) {
  const ctx = { records: [], seenMessageIds: /* @__PURE__ */ new Set(), turn: 0 };
  let seq = 0;
  for (const line of lines) {
    seq += 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let entry;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) continue;
      entry = parsed;
    } catch {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "unknown";
    const data = typeof entry.data === "object" && entry.data !== null ? entry.data : {};
    const at = recordTime(entry);
    if (STREAMING_TYPE.test(type) || SKIPPED_TYPES.has(type)) continue;
    switch (type) {
      case "session": {
        pushRecord(ctx, "meta", seq, at, `\u4F1A\u8BDD\u5F00\u59CB ${String(entry.id ?? "")}`, entry);
        ctx.turn = 0;
        break;
      }
      case "turn/start": {
        const turn = typeof data.turn === "number" ? data.turn : ctx.turn + 1;
        ctx.turn = turn;
        break;
      }
      case "user/message": {
        const id = typeof entry.id === "string" ? entry.id : typeof data.id === "string" ? data.id : "";
        if (id !== "" && ctx.seenMessageIds.has(id)) break;
        if (id !== "") ctx.seenMessageIds.add(id);
        pushRecord(ctx, "user", seq, at, textOfContent(entry.content ?? data.content), entry);
        break;
      }
      case "agent/inbox/spliced": {
        const inserted = Array.isArray(data.inserted) ? data.inserted : [];
        for (const item of inserted) {
          if (typeof item !== "object" || item === null) continue;
          const message = item;
          const id = typeof message.id === "string" ? message.id : "";
          if (id !== "" && ctx.seenMessageIds.has(id)) continue;
          if (id !== "") ctx.seenMessageIds.add(id);
          pushRecord(ctx, "user", seq, at, textOfContent(message.content), item);
        }
        break;
      }
      case "assistant/message": {
        const message = typeof data.message === "object" && data.message !== null ? data.message : {};
        const blocks = contentBlocks(message.content);
        const text = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("\n");
        pushRecord(ctx, "assistant", seq, at, text, entry);
        break;
      }
      case "tool/call": {
        const name = typeof data.name === "string" ? data.name : "tool";
        const args = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {});
        pushRecord(ctx, "tool-call", seq, at, truncate(collapseWhitespace(args), 400), entry, {
          tool: name
        });
        break;
      }
      case "tool/result": {
        const message = typeof data.message === "object" && data.message !== null ? data.message : {};
        const blocks = contentBlocks(message.content);
        const parts = [];
        let failed = false;
        for (const block of blocks) {
          if (block.isError === true) failed = true;
          if (typeof block.text === "string") appendText(parts, block.text);
          else if (Array.isArray(block.content)) appendText(parts, textOfContent(block.content));
        }
        const source = typeof message.source === "object" && message.source !== null ? message.source : {};
        const tool = typeof source.tool === "string" ? source.tool : void 0;
        const body = truncate(collapseWhitespace(parts.join("\n")), 1200);
        pushRecord(
          ctx,
          "tool-result",
          seq,
          at,
          failed ? `\uFF08\u5931\u8D25\uFF09${body}` : body,
          entry,
          tool === void 0 ? {} : { tool }
        );
        break;
      }
      case "compaction/start":
      case "compaction/summary":
      case "compaction/end":
      case "compaction/prune": {
        const summary = textOfContent(data.summary);
        pushRecord(
          ctx,
          "compact",
          seq,
          at,
          summary === "" ? `\u4E0A\u4E0B\u6587\u538B\u7F29\uFF08${type}\uFF09` : `\u4E0A\u4E0B\u6587\u538B\u7F29\uFF1A${truncate(summary, 1500)}`,
          entry
        );
        break;
      }
      case "goal/change": {
        const goal = typeof data.goal === "object" && data.goal !== null ? data.goal : {};
        const operation = typeof data.operation === "string" ? data.operation : "change";
        const objective = typeof goal.objective === "string" ? goal.objective : "";
        pushRecord(ctx, "system", seq, at, `\u76EE\u6807${operation}\uFF1A${truncate(objective, 200)}`, entry);
        break;
      }
      case "todo/write": {
        const todos = Array.isArray(data.todos) ? data.todos : [];
        const rendered = todos.map((todo) => {
          if (typeof todo !== "object" || todo === null) return "";
          const item = todo;
          const status = typeof item.status === "string" ? item.status : "";
          const content = typeof item.content === "string" ? item.content : "";
          return `${status}:${content}`;
        }).filter((value) => value !== "").join(" | ");
        pushRecord(ctx, "system", seq, at, `\u5F85\u529E\u66F4\u65B0\uFF1A${truncate(rendered, 300)}`, entry);
        break;
      }
      case "session/title": {
        const title = typeof data.title === "string" ? data.title : "";
        pushRecord(ctx, "system", seq, at, `\u4F1A\u8BDD\u6807\u9898\uFF1A${truncate(title, 120)}`, entry);
        break;
      }
      case "step/start":
      case "step/end":
      case "turn/end":
      case "permission/preset":
      case "sandbox/mode":
      case "approval/policy":
      case "session/end-seed":
      case "subagent/descriptor":
      case "session/title-llm-request": {
        pushRecord(ctx, "meta", seq, at, "", entry);
        break;
      }
      default: {
        pushRecord(ctx, "other", seq, at, "", entry);
        break;
      }
    }
  }
  return ctx.records;
}
function readTranscript(sessionFile) {
  const buffer = fs4.readFileSync(sessionFile);
  const stat = fs4.statSync(sessionFile);
  const decoded = decodeZstdFrames(buffer);
  const text = decoded.text;
  const lines = text.split("\n");
  const records = normalizeRecords(lines);
  const header = records.find((record) => record.kind === "meta" && record.raw);
  const headerRaw = header?.raw;
  const cwd = typeof headerRaw?.cwd === "string" ? headerRaw.cwd : void 0;
  return {
    sessionFile,
    sessionId: typeof headerRaw?.id === "string" && headerRaw.id !== "" ? headerRaw.id : sessionIdFromPath(sessionFile),
    ...cwd === void 0 ? {} : { cwd },
    records,
    bytes: Buffer.byteLength(text, "utf8"),
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs
  };
}
function pendingRecords(transcript, cursor) {
  if (!cursor || cursor.processedRecords <= 0) return [...transcript.records];
  return transcript.records.filter((record) => record.seq > cursor.processedRecords);
}
function spanHash(records) {
  const material = records.map((record) => `${record.seq}:${record.kind}:${record.text}`).join("\0");
  return sha256(material);
}

// src/store.ts
import fs5 from "fs";
import path6 from "path";
var INDEX_VERSION = 1;
var SHORT_TERM_BUDGET = 2e4;
var QUARANTINE_DIR = "_quarantine";
var BLOCK_SEPARATOR = "\n---\n";
var SHORT_TERM_HEADING = "## \u77ED\u65F6\u8BB0\u5FC6";
var EVENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
var EVENT_STATUSES = ["completed", "partial", "failed", "ongoing", "planned"];
var PROBLEM_LABELS = {
  "missing-md": "\u7F3A\u5C11\u65E5\u8BB0\u6B63\u6587",
  "missing-json": "\u7F3A\u5C11\u7ED3\u6784\u5316 JSON",
  "hash-mismatch": "\u65E5\u8BB0\u54C8\u5E0C\u4E0D\u4E00\u81F4",
  "unreadable-json": "JSON \u65E0\u6CD5\u89E3\u6790"
};
function pairFiles(paths, id) {
  return {
    jsonFile: path6.join(paths.eventsDir, `${id}.json`),
    mdFile: path6.join(paths.eventsDir, `${id}.md`)
  };
}
function isSafeEventId(id) {
  return typeof id === "string" && id.length > 0 && id !== "." && id !== ".." && EVENT_ID_PATTERN.test(id);
}
function assertEventId(id) {
  if (!isSafeEventId(id)) {
    throw new Error(`invalid event id: ${JSON.stringify(id)}`);
  }
}
function readTextFile(file) {
  try {
    return fs5.readFileSync(file, "utf8");
  } catch {
    return void 0;
  }
}
function readJsonOutcome(file) {
  let text;
  try {
    text = fs5.readFileSync(file, "utf8");
  } catch {
    return { kind: "missing" };
  }
  try {
    const value = JSON.parse(text);
    return { kind: "ok", value };
  } catch {
    return { kind: "unreadable" };
  }
}
function readEventsDir(dir) {
  try {
    return fs5.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
function asText(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function asStatus(value) {
  return typeof value === "string" && EVENT_STATUSES.includes(value) ? value : "ongoing";
}
function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asProblem(value) {
  return value === "missing-md" || value === "missing-json" || value === "hash-mismatch" || value === "unreadable-json" ? value : void 0;
}
function isEventRecordLike(value) {
  return isRecord(value) && typeof value.diary === "string";
}
function stripOneTrailingNewline(text) {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}
function diaryBodyDigest(mdText) {
  return sha256(stripOneTrailingNewline(mdText));
}
function hashMatchesDiary(mdText, diaryHash) {
  if (diaryHash === "") return false;
  return diaryBodyDigest(mdText) === diaryHash || sha256(mdText) === diaryHash;
}
function mdTextFor(diary) {
  return diary.endsWith("\n") ? diary : `${diary}
`;
}
function normalizeDiary(diary) {
  return diary.replace(/(?:\r?\n)+$/u, "");
}
function occurredMs(summary) {
  return parseIso(summary.occurredAt) ?? 0;
}
function sortSummaries(summaries) {
  return [...summaries].sort((left, right) => {
    const delta = occurredMs(right) - occurredMs(left);
    if (delta !== 0) return delta;
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
}
function asPeopleNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => isRecord(entry) ? asText(entry.name) : asText(entry)).filter((name) => name !== "");
}
function emptySummary(id, files) {
  return {
    id,
    title: "",
    occurredAt: "",
    endedAt: "",
    status: "ongoing",
    tags: [],
    people: [],
    keywords: [],
    entities: [],
    diaryHash: "",
    diaryChars: 0,
    revision: 1,
    jsonFile: files.jsonFile,
    mdFile: files.mdFile,
    updatedAt: ""
  };
}
function summaryFromEventValue(id, value, files) {
  const summary = emptySummary(id, files);
  if (!isRecord(value)) return summary;
  const structured = isRecord(value.structured) ? value.structured : {};
  const scene = isRecord(structured.scene) ? structured.scene : {};
  const outcome = isRecord(structured.outcome) ? structured.outcome : {};
  const project = asText(scene.project);
  const diary = asText(value.diary);
  const diaryHash = asText(value.diaryHash);
  summary.title = asText(structured.title);
  summary.occurredAt = asText(structured.startedAt);
  summary.endedAt = asText(structured.endedAt);
  summary.status = asStatus(outcome.status);
  summary.tags = asStringArray(structured.tags);
  summary.people = asPeopleNames(structured.people);
  summary.keywords = asStringArray(structured.keywords);
  summary.entities = asStringArray(structured.entities);
  if (project !== "") summary.project = project;
  summary.diaryHash = diaryHash !== "" ? diaryHash : sha256(diary);
  summary.diaryChars = diary.length;
  summary.revision = asNumber(value.revision, 1);
  summary.updatedAt = asText(value.updatedAt);
  return summary;
}
function coerceIndexSummary(id, value, files) {
  const summary = emptySummary(id, files);
  const project = asText(value.project);
  const problem = asProblem(value.problem);
  summary.title = asText(value.title);
  summary.occurredAt = asText(value.occurredAt);
  summary.endedAt = asText(value.endedAt);
  summary.status = asStatus(value.status);
  summary.tags = asStringArray(value.tags);
  summary.people = asStringArray(value.people);
  summary.keywords = asStringArray(value.keywords);
  summary.entities = asStringArray(value.entities);
  if (project !== "") summary.project = project;
  summary.diaryHash = asText(value.diaryHash);
  summary.diaryChars = asNumber(value.diaryChars, 0);
  summary.revision = asNumber(value.revision, 1);
  summary.jsonFile = asText(value.jsonFile, files.jsonFile);
  summary.mdFile = asText(value.mdFile, files.mdFile);
  summary.updatedAt = asText(value.updatedAt);
  if (problem !== void 0) summary.problem = problem;
  return summary;
}
function applyDiaryText(summary, mdText) {
  summary.diaryHash = diaryBodyDigest(mdText);
  summary.diaryChars = stripOneTrailingNewline(mdText).length;
}
function loadEventIndex(paths) {
  const raw = readJsonFile(paths.eventIndexFile);
  if (!isRecord(raw)) return void 0;
  if (raw.version !== INDEX_VERSION) return void 0;
  if (!isRecord(raw.events)) return void 0;
  const events = {};
  for (const [id, value] of Object.entries(raw.events)) {
    if (!isSafeEventId(id) || !isRecord(value)) return void 0;
    events[id] = coerceIndexSummary(id, value, pairFiles(paths, id));
  }
  return { version: INDEX_VERSION, updatedAt: asText(raw.updatedAt), events };
}
function persistEventIndex(paths, summaries) {
  const events = {};
  for (const summary of summaries) events[summary.id] = summary;
  const index = { version: INDEX_VERSION, updatedAt: nowIso(), events };
  writeJsonFile(paths.eventIndexFile, index);
}
function persistEventIndexQuietly(paths, summaries) {
  try {
    persistEventIndex(paths, summaries);
  } catch {
  }
}
function updateIndexWith(paths, record) {
  const index = loadEventIndex(paths) ?? {
    version: INDEX_VERSION,
    updatedAt: nowIso(),
    events: {}
  };
  index.events[record.id] = summaryFromEventValue(
    record.id,
    record,
    pairFiles(paths, record.id)
  );
  index.updatedAt = nowIso();
  writeJsonFile(paths.eventIndexFile, index);
}
function readEvent(paths, id) {
  if (!isSafeEventId(id)) return void 0;
  const outcome = readJsonOutcome(pairFiles(paths, id).jsonFile);
  if (outcome.kind !== "ok" || !isEventRecordLike(outcome.value)) return void 0;
  return outcome.value;
}
function readDiary(paths, id) {
  if (!isSafeEventId(id)) return void 0;
  const text = readTextFile(pairFiles(paths, id).mdFile);
  if (text === void 0) return void 0;
  return stripOneTrailingNewline(text);
}
function writeEventPair(paths, record) {
  assertEventId(record.id);
  const expected = sha256(record.diary);
  if (typeof record.diaryHash !== "string" || record.diaryHash !== expected) {
    throw new Error(
      `diary hash mismatch for ${record.id}: expected ${expected}, got ${String(record.diaryHash)}`
    );
  }
  const files = pairFiles(paths, record.id);
  ensureDir(paths.eventsDir);
  const existed = fs5.existsSync(files.jsonFile) || fs5.existsSync(files.mdFile);
  const previousJson = fs5.existsSync(files.jsonFile) ? readTextFile(files.jsonFile) : void 0;
  writeJsonFile(files.jsonFile, record);
  try {
    writeTextFileAtomic(files.mdFile, mdTextFor(record.diary));
  } catch (error) {
    if (previousJson !== void 0) {
      writeTextFileAtomic(files.jsonFile, previousJson);
    } else {
      fs5.rmSync(files.jsonFile, { force: true });
    }
    throw error;
  }
  try {
    updateIndexWith(paths, record);
  } catch {
  }
  return { jsonFile: files.jsonFile, mdFile: files.mdFile, created: !existed };
}
function scanEventSummaries(paths) {
  const jsonIds = /* @__PURE__ */ new Set();
  const mdIds = /* @__PURE__ */ new Set();
  for (const entry of readEventsDir(paths.eventsDir)) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.length === 0 || name.startsWith(".")) continue;
    if (name.endsWith(".json")) jsonIds.add(name.slice(0, -".json".length));
    else if (name.endsWith(".md")) mdIds.add(name.slice(0, -".md".length));
  }
  const summaries = [];
  const ids = /* @__PURE__ */ new Set([...jsonIds, ...mdIds]);
  for (const id of ids) {
    const files = pairFiles(paths, id);
    const hasJson = jsonIds.has(id);
    const hasMd = mdIds.has(id);
    const mdText = hasMd ? readTextFile(files.mdFile) : void 0;
    if (!hasJson) {
      const summary2 = emptySummary(id, files);
      if (mdText !== void 0) applyDiaryText(summary2, mdText);
      summary2.problem = "missing-json";
      summaries.push(summary2);
      continue;
    }
    const outcome = readJsonOutcome(files.jsonFile);
    if (outcome.kind !== "ok" || !isEventRecordLike(outcome.value)) {
      const summary2 = emptySummary(id, files);
      if (mdText !== void 0) applyDiaryText(summary2, mdText);
      summary2.problem = "unreadable-json";
      summaries.push(summary2);
      continue;
    }
    const summary = summaryFromEventValue(id, outcome.value, files);
    if (mdText === void 0) {
      summary.problem = "missing-md";
    } else if (!hashMatchesDiary(mdText, summary.diaryHash)) {
      summary.problem = "hash-mismatch";
      applyDiaryText(summary, mdText);
    }
    summaries.push(summary);
  }
  return sortSummaries(summaries);
}
function listEventSummaries(paths, options = {}) {
  if (options.refresh !== true) {
    const index = loadEventIndex(paths);
    if (index !== void 0) return sortSummaries(Object.values(index.events));
  }
  const summaries = scanEventSummaries(paths);
  persistEventIndexQuietly(paths, summaries);
  return summaries;
}
function eventIdFor(startedAt, contentHash) {
  const ms = parseIso(startedAt) ?? 0;
  return `ev_${beijingCompact(ms)}_${hashFragment(contentHash)}`;
}
function hashFragment(contentHash) {
  const hex = (typeof contentHash === "string" ? contentHash : "").toLowerCase().replace(/[^0-9a-f]/gu, "");
  if (hex.length >= 8) return hex.slice(0, 8);
  return sha256(typeof contentHash === "string" ? contentHash : "").slice(0, 8);
}
function buildRecord(encoded, options) {
  assertEventId(options.id);
  const now = options.now ?? nowIso();
  const diary = normalizeDiary(encoded.diary);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id,
    createdAt: now,
    updatedAt: now,
    structured: encoded.structured,
    diary,
    diaryHash: sha256(diary),
    revision: options.revision ?? 1
  };
}
function describeBroken(summary) {
  const label = summary.problem === void 0 ? "\u65E0\u6CD5\u8BFB\u53D6" : PROBLEM_LABELS[summary.problem];
  return `${summary.id}\uFF08${label}\uFF09`;
}
function shortTermMemory(paths, limit) {
  const summaries = listEventSummaries(paths, { refresh: true });
  const wanted = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const candidates = wanted > 0 ? summaries.slice(0, wanted) : [];
  const included = [];
  const broken = [];
  const blocks = [];
  let used = SHORT_TERM_HEADING.length;
  let truncated = false;
  for (const candidate of candidates) {
    if (candidate.problem !== void 0) {
      broken.push(candidate);
      continue;
    }
    const diary = readDiary(paths, candidate.id);
    if (diary === void 0) {
      broken.push(candidate);
      continue;
    }
    const heading = `### ${candidate.occurredAt} \xB7 ${candidate.title} \xB7 ${candidate.status}`;
    const block = `${heading}
${diary}`;
    const separator = blocks.length === 0 ? 0 : BLOCK_SEPARATOR.length;
    if (used + separator + block.length > SHORT_TERM_BUDGET) {
      truncated = true;
      const headingRoom = used + separator + heading.length + 1;
      const room = SHORT_TERM_BUDGET - headingRoom - 64;
      if (blocks.length === 0 && room > 200) {
        const clipped = truncate(diary, room);
        blocks.push(`${heading}
${clipped}`);
        included.push(candidate);
      }
      break;
    }
    blocks.push(block);
    included.push(candidate);
    used += separator + block.length;
  }
  const parts = [SHORT_TERM_HEADING];
  if (blocks.length > 0) parts.push(blocks.join(BLOCK_SEPARATOR));
  const notes = [];
  if (broken.length > 0) {
    notes.push(
      `\uFF08\u5DF2\u8DF3\u8FC7 ${broken.length} \u6761\u914D\u5BF9\u5F02\u5E38\u4E8B\u4EF6\uFF1A${broken.map(describeBroken).join("\u3001")}\uFF09`
    );
  }
  if (truncated) {
    notes.push(
      `\uFF08\u77ED\u65F6\u8BB0\u5FC6\u5DF2\u622A\u65AD\uFF1A\u8D85\u51FA ${SHORT_TERM_BUDGET} \u5B57\u7B26\u9884\u7B97\uFF0C\u4EC5\u4FDD\u7559\u6700\u65B0 ${included.length} \u6761\u4E8B\u4EF6\u3002\uFF09`
    );
  }
  if (notes.length > 0) parts.push(notes.join("\n"));
  if (blocks.length === 0 && notes.length === 0) parts.push("\uFF08\u6682\u65E0\u4E8B\u4EF6\u8BB0\u5FC6\u3002\uFF09");
  return { summaries: included, text: parts.join("\n\n") };
}
function quarantineFile(eventsDir, file, stamp) {
  const dir = path6.join(eventsDir, QUARANTINE_DIR);
  ensureDir(dir);
  const base = path6.basename(file);
  let target = path6.join(dir, `${base}.quarantined-${stamp}`);
  let counter = 1;
  while (fs5.existsSync(target)) {
    target = path6.join(dir, `${base}.quarantined-${stamp}-${counter}`);
    counter += 1;
  }
  fs5.renameSync(file, target);
  return target;
}
function repairPairs(paths) {
  const repaired = /* @__PURE__ */ new Set();
  const quarantined = /* @__PURE__ */ new Set();
  const skipped = /* @__PURE__ */ new Set();
  const eventsDir = paths.eventsDir;
  ensureDir(eventsDir);
  const jsonIds = /* @__PURE__ */ new Set();
  const mdIds = /* @__PURE__ */ new Set();
  for (const entry of readEventsDir(eventsDir)) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.length === 0 || name.startsWith(".")) continue;
    if (name.endsWith(".json")) jsonIds.add(name.slice(0, -".json".length));
    else if (name.endsWith(".md")) mdIds.add(name.slice(0, -".md".length));
  }
  const stamp = beijingCompact(Date.now());
  const ids = [.../* @__PURE__ */ new Set([...jsonIds, ...mdIds])].sort();
  for (const id of ids) {
    const files = pairFiles(paths, id);
    const hasJson = jsonIds.has(id);
    const hasMd = mdIds.has(id);
    if (!hasJson) {
      quarantineFile(eventsDir, files.mdFile, stamp);
      quarantined.add(id);
      continue;
    }
    const outcome = readJsonOutcome(files.jsonFile);
    if (outcome.kind !== "ok" || !isEventRecordLike(outcome.value)) {
      quarantineFile(eventsDir, files.jsonFile, stamp);
      if (hasMd) quarantineFile(eventsDir, files.mdFile, stamp);
      quarantined.add(id);
      continue;
    }
    const raw = outcome.value;
    const diary = typeof raw.diary === "string" ? raw.diary : "";
    const expected = sha256(diary);
    let changed = false;
    if (asText(raw.diaryHash) !== expected) {
      writeJsonFile(files.jsonFile, { ...raw, diaryHash: expected });
      changed = true;
    }
    const mdText = hasMd ? readTextFile(files.mdFile) : void 0;
    if (mdText === void 0) {
      writeTextFileAtomic(files.mdFile, mdTextFor(diary));
      changed = true;
    } else if (!hashMatchesDiary(mdText, expected)) {
      writeTextFileAtomic(files.mdFile, mdTextFor(diary));
      changed = true;
    }
    if (changed) repaired.add(id);
    else skipped.add(id);
  }
  persistEventIndexQuietly(paths, scanEventSummaries(paths));
  return {
    repaired: [...repaired].sort(),
    quarantined: [...quarantined].sort(),
    skipped: [...skipped].sort()
  };
}

// src/state.ts
var MAX_RETRY_DELAY_MS = 30 * 60 * 1e3;
function emptyCursor() {
  return { version: STATE_VERSION, sessions: {} };
}
function emptyRunState() {
  return { version: STATE_VERSION, failures: {}, totals: { events: 0, embedded: 0, runs: 0 } };
}
function loadCursor(paths) {
  const state = readJsonFile(paths.cursorFile);
  if (!state || typeof state !== "object" || typeof state.sessions !== "object" || state.sessions === null) {
    return emptyCursor();
  }
  return { version: STATE_VERSION, sessions: { ...state.sessions } };
}
function saveCursor(paths, state) {
  writeJsonFile(paths.cursorFile, { ...state, version: STATE_VERSION });
}
function getSessionCursor(state, sessionFile) {
  return state.sessions[sessionFile];
}
function putSessionCursor(state, cursor) {
  state.sessions[cursor.sessionFile] = cursor;
}
function loadRunState(paths) {
  const state = readJsonFile(paths.runStateFile);
  if (!state || typeof state !== "object" || typeof state.failures !== "object" || state.failures === null) {
    return emptyRunState();
  }
  return {
    version: STATE_VERSION,
    ...typeof state.lastRunAt === "string" ? { lastRunAt: state.lastRunAt } : {},
    ...state.lastRunResult ? { lastRunResult: state.lastRunResult } : {},
    failures: { ...state.failures },
    skipped: { ...state.skipped ?? {} },
    totals: {
      events: Number(state.totals?.events ?? 0) || 0,
      embedded: Number(state.totals?.embedded ?? 0) || 0,
      runs: Number(state.totals?.runs ?? 0) || 0
    }
  };
}
function saveRunState(paths, state) {
  writeJsonFile(paths.runStateFile, { ...state, version: STATE_VERSION });
}
function skippedKey(sessionFile, spanHash2) {
  return `${sessionFile}#${spanHash2}`;
}
function recordSkipped(state, entry) {
  const span = { ...entry, skippedAt: entry.skippedAt ?? nowIso() };
  state.skipped = { ...state.skipped ?? {}, [skippedKey(span.sessionFile, span.spanHash)]: span };
  return span;
}
function isSkipped(state, sessionFile, spanHash2) {
  return (state.skipped ?? {})[skippedKey(sessionFile, spanHash2)] !== void 0;
}
function clearSkipped(state, sessionFile) {
  const skipped = state.skipped ?? {};
  const keys = Object.keys(skipped).filter(
    (key) => sessionFile === void 0 ? true : key.startsWith(`${sessionFile}#`)
  );
  for (const key of keys) delete skipped[key];
  state.skipped = skipped;
  return keys.length;
}
function failureKey(kind, target) {
  return `${kind}:${target}`;
}
function recordFailure(state, kind, target, error, options = {}) {
  const key = failureKey(kind, target);
  const previous = state.failures[key];
  const attempts = (previous?.attempts ?? 0) + 1;
  const base = Math.max(1e3, options.retryDelayMs ?? 3e4);
  const delay = Math.min(base * 2 ** (attempts - 1), MAX_RETRY_DELAY_MS);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const entry = {
    kind,
    target,
    attempts,
    lastError: message.slice(0, 800),
    lastAttemptAt: new Date(now).toISOString(),
    nextAttemptAt: new Date(now + delay).toISOString()
  };
  state.failures[key] = entry;
  return entry;
}
function clearFailure(state, kind, target) {
  delete state.failures[failureKey(kind, target)];
}
function isCoolingDown(state, cooldownMs, nowMs = Date.now()) {
  if (!state.lastRunAt || cooldownMs <= 0) return false;
  const last = Date.parse(state.lastRunAt);
  if (Number.isNaN(last)) return false;
  return nowMs - last < cooldownMs;
}
function pendingFailures(state, nowMs = Date.now()) {
  return Object.values(state.failures).filter((entry) => {
    const due = Date.parse(entry.nextAttemptAt);
    return Number.isNaN(due) || due <= nowMs;
  }).sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt));
}

// src/units.ts
function unitOptionsFromConfig(config) {
  return {
    minRecordsPerEvent: Math.max(1, config.session.minRecordsPerEvent),
    maxRecordsPerEvent: Math.max(1, config.session.maxRecordsPerEvent),
    maxInputChars: Math.max(1e3, config.consolidation.maxInputChars),
    minEventChars: Math.max(0, config.consolidation.minEventChars),
    tailRecords: Math.max(0, config.session.tailRecords)
  };
}
function recordCost(record) {
  if (record.kind === "tool-result") return Math.min(record.text.length, 1200) + 24;
  if (record.kind === "tool-call") return Math.min(record.text.length, 400) + 24;
  return record.text.length + 24;
}
var CONVERSATIONAL = /* @__PURE__ */ new Set([
  "user",
  "assistant",
  "tool-call",
  "tool-result",
  "compact",
  "system"
]);
function timeOf(record, fallbackMs) {
  if (record.at === void 0) return fallbackMs;
  const ms = Date.parse(record.at);
  return Number.isNaN(ms) ? fallbackMs : ms;
}
function buildUnits(transcript, options, cursor) {
  const pending = pendingRecords(transcript, cursor);
  if (pending.length === 0) return [];
  const usable = options.tailRecords > 0 ? pending.slice(0, Math.max(0, pending.length - options.tailRecords)) : pending;
  if (usable.length === 0) return [];
  const fallbackMs = transcript.fileMtimeMs || Date.now();
  const units = [];
  let start = -1;
  let records = [];
  let chars = 0;
  const flush = () => {
    if (start < 0 || records.length === 0) {
      start = -1;
      records = [];
      chars = 0;
      return;
    }
    const first = records[0];
    const last = records[records.length - 1];
    const recordCount = records.length;
    if (recordCount >= options.minRecordsPerEvent && chars >= options.minEventChars) {
      units.push({
        sessionFile: transcript.sessionFile,
        sessionId: transcript.sessionId,
        records: [...records],
        fromSeq: first.seq,
        toSeq: last.seq,
        turns: [...new Set(records.map((record) => record.turn))],
        startedAt: beijingIso(timeOf(first, fallbackMs - 1e3)),
        endedAt: beijingIso(timeOf(last, fallbackMs)),
        contentHash: spanHash(records),
        truncated: chars > options.maxInputChars,
        chars
      });
    }
    start = -1;
    records = [];
    chars = 0;
  };
  for (let index = 0; index < usable.length; index += 1) {
    const record = usable[index];
    if (!CONVERSATIONAL.has(record.kind)) continue;
    if (record.kind === "user" && start >= 0) {
      flush();
    }
    if (start < 0) {
      start = index;
      records = [];
      chars = 0;
    }
    const cost = recordCost(record);
    const wouldOverflow = records.length > 0 && (records.length + 1 > options.maxRecordsPerEvent || chars + cost > options.maxInputChars);
    if (wouldOverflow && record.kind !== "tool-result") {
      flush();
      start = index;
      records = [];
      chars = 0;
    }
    records.push(record);
    chars += cost;
  }
  flush();
  return units;
}

// src/vectors.ts
import { createRequire } from "module";
import path7 from "path";
var sqliteRequire = createRequire(import.meta.url);
function openDatabase(file) {
  const module = sqliteRequire("node:sqlite");
  return new module.DatabaseSync(file, { timeout: 5e3 });
}
var FLOAT_BYTES = 4;
var SCHEMA_VERSION2 = "1";
var SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vectors (
  event_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  text_hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  norm REAL NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;
var UPSERT_SQL = `
INSERT INTO vectors (event_id, model, dimensions, text_hash, vector, norm, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(event_id) DO UPDATE SET
  model = excluded.model,
  dimensions = excluded.dimensions,
  text_hash = excluded.text_hash,
  vector = excluded.vector,
  norm = excluded.norm,
  updated_at = excluded.updated_at
`;
var SELECT_SQL = "SELECT event_id, model, dimensions, text_hash, vector, norm, updated_at FROM vectors";
function asFiniteNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return fallback;
}
function asText2(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function toVectorRow(raw) {
  const blob = raw.vector;
  const vector = blob instanceof Uint8Array ? blobToVector(blob) : [];
  return {
    eventId: asText2(raw.event_id),
    model: asText2(raw.model),
    dimensions: asFiniteNumber(raw.dimensions, vector.length),
    textHash: asText2(raw.text_hash),
    vector,
    norm: asFiniteNumber(raw.norm, vectorNorm(vector)),
    updatedAt: asText2(raw.updated_at)
  };
}
function vectorToBlob(vector) {
  const blob = Buffer.allocUnsafe(vector.length * FLOAT_BYTES);
  for (let index = 0; index < vector.length; index += 1) {
    blob.writeFloatLE(vector[index] ?? 0, index * FLOAT_BYTES);
  }
  return blob;
}
function blobToVector(blob) {
  if (blob.length % FLOAT_BYTES !== 0) {
    throw new Error(`blobToVector: blob length ${blob.length} is not a multiple of ${FLOAT_BYTES}`);
  }
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.length);
  const length = blob.length / FLOAT_BYTES;
  const vector = new Array(length);
  for (let index = 0; index < length; index += 1) {
    vector[index] = buffer.readFloatLE(index * FLOAT_BYTES);
  }
  return vector;
}
function vectorNorm(vector) {
  let total = 0;
  for (const value of vector) total += value * value;
  return Number.isFinite(total) ? Math.sqrt(total) : 0;
}
var VectorStore = class {
  db;
  closed = false;
  constructor(dbFile) {
    ensureDir(path7.dirname(dbFile));
    const db = openDatabase(dbFile);
    this.db = db;
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    } catch {
    }
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(SCHEMA_VERSION2);
  }
  /** Insert or replace rows in one transaction; returns the number of rows written. */
  upsert(rows) {
    if (rows.length === 0) return 0;
    const byId = /* @__PURE__ */ new Map();
    for (const row of rows) byId.set(row.eventId, row);
    const statement = this.db.prepare(UPSERT_SQL);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of byId.values()) {
        const updatedAt = typeof row.updatedAt === "string" && row.updatedAt !== "" ? row.updatedAt : nowIso();
        statement.run(
          row.eventId,
          row.model,
          Number.isFinite(row.dimensions) ? Math.floor(row.dimensions) : row.vector.length,
          row.textHash,
          vectorToBlob(row.vector),
          Number.isFinite(row.norm) ? row.norm : vectorNorm(row.vector),
          updatedAt
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
    return byId.size;
  }
  get(eventId) {
    const raw = this.db.prepare(`${SELECT_SQL} WHERE event_id = ?`).get(eventId);
    return raw === void 0 ? void 0 : toVectorRow(raw);
  }
  /** Every row, ordered by `event_id` so scans are deterministic. */
  all() {
    return this.db.prepare(`${SELECT_SQL} ORDER BY event_id ASC`).all().map((raw) => toVectorRow(raw));
  }
  /** Delete the given event ids in one transaction; returns rows actually removed. */
  delete(eventIds) {
    if (eventIds.length === 0) return 0;
    const unique = [...new Set(eventIds)];
    const statement = this.db.prepare("DELETE FROM vectors WHERE event_id = ?");
    this.db.exec("BEGIN IMMEDIATE");
    let removed = 0;
    try {
      for (const eventId of unique) {
        removed += Number(statement.run(eventId).changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
    return removed;
  }
  count() {
    const raw = this.db.prepare("SELECT COUNT(*) AS total FROM vectors").get();
    return asFiniteNumber(raw?.total);
  }
  /** Model that owns the most rows, i.e. the model the index was built with. */
  modelOf() {
    const raw = this.db.prepare(
      "SELECT model, COUNT(*) AS total FROM vectors GROUP BY model ORDER BY total DESC, model ASC LIMIT 1"
    ).get();
    if (raw === void 0) return void 0;
    const model = asText2(raw.model);
    return model === "" ? void 0 : model;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
};
function staleEventIds(store, summaries) {
  const storedHashes = /* @__PURE__ */ new Map();
  for (const row of store.all()) storedHashes.set(row.eventId, row.textHash);
  const stale = [];
  for (const summary of summaries) {
    const stored = storedHashes.get(summary.id);
    if (stored === void 0) continue;
    if (stored !== summary.diaryHash) stale.push(summary.id);
  }
  return stale;
}
function missingEventIds(store, summaries) {
  const known = new Set(store.all().map((row) => row.eventId));
  return summaries.filter((summary) => !known.has(summary.id)).map((summary) => summary.id);
}

// src/consolidate.ts
function spansFile(paths) {
  return path8.join(paths.stateDir, "spans.json");
}
function loadSpans(paths) {
  const state = readJsonFile(spansFile(paths));
  if (state && typeof state === "object" && state.spans) return state;
  return { version: 1, spans: {} };
}
function saveSpans(paths, state) {
  ensureDataLayout(paths);
  writeJsonFile(spansFile(paths), state);
}
function rememberSpan(state, sessionFile, hash) {
  const list = state.spans[sessionFile] ?? [];
  if (!list.includes(hash)) list.push(hash);
  state.spans[sessionFile] = list.slice(-500);
}
function knownSpanHashes(state, sessionFile) {
  return new Set(state.spans[sessionFile] ?? []);
}
function orderByRecency(files) {
  const stat = (file) => {
    try {
      return fs6.statSync(file).mtimeMs;
    } catch {
      return 0;
    }
  };
  return [...files].sort((a, b) => stat(b) - stat(a));
}
function sessionLabel(sessionFile) {
  return truncate(path8.basename(path8.dirname(sessionFile)), 42) || path8.basename(sessionFile);
}
function summarizeUnit(unit) {
  const span = `${sessionLabel(unit.sessionFile)} seq ${unit.fromSeq}-${unit.toSeq}`;
  return `${span} \xB7 ${unit.records.length} \u6761\u8BB0\u5F55 \xB7 ${unit.chars} \u5B57`;
}
function cursorFor(transcript, unit, previous) {
  const last = unit.records[unit.records.length - 1];
  return {
    sessionFile: transcript.sessionFile,
    sessionId: transcript.sessionId,
    processedRecords: unit.toSeq,
    byteOffset: transcript.bytes,
    fileSize: transcript.fileSize,
    fileMtimeMs: transcript.fileMtimeMs,
    lastRecordHash: last ? sha256(last.text) : previous?.lastRecordHash ?? "",
    lastSpanHash: unit.contentHash,
    updatedAt: nowIso()
  };
}
async function indexDiary(deps, eventId, diary) {
  const textHash = sha256(diary);
  const [vector] = await deps.embedder.embed([diary]);
  if (!vector || vector.length === 0) throw new Error("embedding returned no vector");
  if (vector.length !== deps.config.dashscope.embeddingDimensions) {
    throw new Error(
      `embedding dimension ${vector.length} != config ${deps.config.dashscope.embeddingDimensions}`
    );
  }
  deps.store.upsert([
    {
      eventId,
      model: deps.embedder.model,
      dimensions: vector.length,
      textHash,
      vector,
      norm: vectorNorm(vector),
      updatedAt: nowIso()
    }
  ]);
  deps.logger.debug(`indexed ${eventId} (${vector.length}d, ${textHash.slice(0, 8)})`);
  return true;
}
async function consolidate(input) {
  const startedAt = nowIso();
  const logger = input.logger ?? createLogger({ scope: "consolidate" });
  const config = input.config;
  const paths = input.paths ?? memoryPaths(config.dataRoot);
  const options = unitOptionsFromConfig(config);
  const result = {
    startedAt,
    finishedAt: startedAt,
    sessionsScanned: 0,
    unitsFound: 0,
    eventsWritten: 0,
    eventsSkipped: 0,
    eventsFailed: 0,
    embedded: 0,
    embedFailed: 0,
    details: []
  };
  const finish = (patch = {}) => {
    Object.assign(result, patch);
    result.finishedAt = nowIso();
    return result;
  };
  ensureDataLayout(paths);
  const runState = loadRunState(paths);
  const cooldownMs = Math.max(
    config.consolidation.cooldownMs,
    config.trigger?.globalCooldownMs ?? 0
  );
  if (!input.force && isCoolingDown(runState, cooldownMs)) {
    logger.debug(`consolidation skipped: cooldown active (${cooldownMs}ms)`);
    return finish({ aborted: "cooldown" });
  }
  const dirs = expandSessionDirs(config, process.cwd());
  if (dirs.length === 0) return finish({ aborted: "no-session-dirs" });
  let distiller = input.distiller;
  let embedder = input.embedder;
  if (!input.dryRun) {
    try {
      distiller ??= createDistiller({
        config,
        apiKey: requireSecret(input.secrets, "deepseek"),
        logger
      });
      embedder ??= createEmbedder(config.dashscope, requireSecret(input.secrets, "dashscope"), logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`consolidation disabled: ${message}`);
      return finish({ aborted: `missing-secret`, details: [message] });
    }
  }
  const files = orderByRecency(
    listSessionFiles(dirs, config.session.includeGlobs, config.session.excludeGlobs)
  );
  const current = input.currentSessionFile ? path8.resolve(input.currentSessionFile) : void 0;
  if (current) {
    const index = files.findIndex((file) => path8.resolve(file) === current);
    if (index > 0) {
      const [only] = files.splice(index, 1);
      if (only) files.unshift(only);
    } else if (index === -1 && fs6.existsSync(current)) {
      files.unshift(current);
    }
  }
  const cursorState = loadCursor(paths);
  const spanState = loadSpans(paths);
  const store = input.dryRun ? void 0 : new VectorStore(paths.vectorDb);
  const failedTargets = new Set(pendingFailures(runState).map((entry) => entry.target));
  const attemptedEmbed = /* @__PURE__ */ new Set();
  let budget = Math.max(1, config.consolidation.maxEventsPerRun);
  let caughtUpSessions = 0;
  try {
    for (const file of files) {
      if (input.signal?.aborted) {
        result.aborted = "aborted";
        break;
      }
      if (budget <= 0) break;
      result.sessionsScanned += 1;
      if (failedTargets.has(file) && !input.force) {
        result.details.push(`\u8DF3\u8FC7\uFF08\u5931\u8D25\u9000\u907F\u4E2D\uFF09\uFF1A${sessionLabel(file)}`);
        continue;
      }
      let transcript;
      try {
        transcript = readTranscript(file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordFailure(runState, "consolidate", file, error);
        result.eventsFailed += 1;
        result.details.push(`\u8BFB\u53D6\u5931\u8D25\uFF1A${sessionLabel(file)} \u2014 ${message}`);
        continue;
      }
      if (transcript.records.length === 0) continue;
      let previous = getSessionCursor(cursorState, transcript.sessionFile);
      if (previous && transcript.fileSize < previous.fileSize) {
        result.details.push(`\u68C0\u6D4B\u5230\u4F1A\u8BDD\u88AB\u91CD\u5199\uFF0C\u6E38\u6807\u91CD\u7F6E\uFF1A${sessionLabel(file)}`);
        previous = void 0;
      }
      const pending = pendingRecords(transcript, previous);
      if (pending.length === 0) {
        caughtUpSessions += 1;
        continue;
      }
      const known = knownSpanHashes(spanState, transcript.sessionFile);
      const units = buildUnits(transcript, options, previous).filter((unit) => {
        if (isSkipped(runState, transcript.sessionFile, unit.contentHash)) {
          result.details.push(`\u8DF3\u8FC7\u5DF2\u653E\u5F03\u7684\u7247\u6BB5\uFF1A${summarizeUnit(unit)}`);
          return false;
        }
        return !known.has(unit.contentHash);
      });
      result.unitsFound += units.length;
      for (const unit of units) {
        if (input.signal?.aborted) {
          result.aborted = "aborted";
          break;
        }
        if (budget <= 0) break;
        const eventId = eventIdFor(unit.startedAt, unit.contentHash);
        const existing = input.dryRun ? void 0 : readEvent(paths, eventId);
        if (existing && existing.structured.sources.some((ref) => ref.contentHash === unit.contentHash)) {
          result.eventsSkipped += 1;
          rememberSpan(spanState, transcript.sessionFile, unit.contentHash);
          const advanced = cursorFor(transcript, unit, previous);
          putSessionCursor(cursorState, advanced);
          saveCursor(paths, cursorState);
          continue;
        }
        if (input.dryRun) {
          result.eventsWritten += 1;
          result.details.push(`[dry-run] \u5C06\u7F16\u7801\u4E8B\u4EF6 ${eventId}\uFF1A${summarizeUnit(unit)}`);
          rememberSpan(spanState, transcript.sessionFile, unit.contentHash);
          putSessionCursor(cursorState, cursorFor(transcript, unit, previous));
          budget -= 1;
          continue;
        }
        let encoded;
        try {
          if (!distiller) throw new Error("\u7F3A\u5C11\u7F16\u7801\u5668\uFF08\u8BF7\u68C0\u67E5 DeepSeek \u5BC6\u94A5\u4E0E\u914D\u7F6E\uFF09");
          encoded = await distiller.encode(unit);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failure = recordFailure(runState, "consolidate", file, error);
          result.eventsFailed += 1;
          result.details.push(`\u7F16\u7801\u5931\u8D25\uFF1A${summarizeUnit(unit)} \u2014 ${message}`);
          const maxAttempts = Math.max(1, config.consolidation.maxSpanAttempts);
          if (failure.attempts >= maxAttempts) {
            recordSkipped(runState, {
              sessionFile: transcript.sessionFile,
              spanHash: unit.contentHash,
              fromSeq: unit.fromSeq,
              toSeq: unit.toSeq,
              attempts: failure.attempts,
              reason: message.slice(0, 400)
            });
            rememberSpan(spanState, transcript.sessionFile, unit.contentHash);
            putSessionCursor(cursorState, cursorFor(transcript, unit, previous));
            saveCursor(paths, cursorState);
            saveSpans(paths, spanState);
            clearFailure(runState, "consolidate", file);
            saveRunState(paths, runState);
            result.details.push(
              `\u653E\u5F03\u7247\u6BB5\uFF08\u8FDE\u7EED\u5931\u8D25 ${failure.attempts} \u6B21\uFF0C\u6E38\u6807\u524D\u8FDB\uFF09\uFF1A${summarizeUnit(unit)} \u2014 ${message}`
            );
            logger.warn(
              `\u653E\u5F03\u7247\u6BB5 ${summarizeUnit(unit)}\uFF08\u8FDE\u7EED\u5931\u8D25 ${failure.attempts} \u6B21\uFF09\uFF0C\u6E38\u6807\u7EE7\u7EED\u524D\u8FDB`
            );
            continue;
          }
          saveRunState(paths, runState);
          break;
        }
        budget -= 1;
        const sources = encoded.structured.sources ?? [];
        if (sources.length === 0 || sources.some((ref) => ref.contentHash !== unit.contentHash)) {
          encoded.structured.sources = [sourceRefFor(unit)];
        }
        const revision = existing ? existing.revision + 1 : 1;
        const record = buildRecord(encoded, { id: eventId, revision });
        try {
          writeEventPair(paths, record);
          result.eventsWritten += 1;
          result.details.push(`\u5199\u5165\u4E8B\u4EF6 ${eventId}\uFF1A${truncate(record.structured.title, 40)}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordFailure(runState, "store", eventId, error);
          result.eventsFailed += 1;
          result.details.push(`\u5B58\u50A8\u5931\u8D25\uFF1A${eventId} \u2014 ${message}`);
          saveRunState(paths, runState);
          break;
        }
        if (embedder && store) {
          attemptedEmbed.add(eventId);
          try {
            await indexDiary({ config, paths, embedder, store, logger }, eventId, record.diary);
            result.embedded += 1;
            clearFailure(runState, "embed", eventId);
            const withVector = {
              ...record,
              embedding: {
                model: embedder.model,
                dimensions: config.dashscope.embeddingDimensions,
                textHash: record.diaryHash,
                updatedAt: nowIso()
              }
            };
            writeJsonFile(path8.join(paths.eventsDir, `${eventId}.json`), withVector);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            recordFailure(runState, "embed", eventId, error);
            result.embedFailed += 1;
            result.details.push(`\u5411\u91CF\u5931\u8D25\uFF1A${eventId} \u2014 ${message}`);
          }
        }
        rememberSpan(spanState, transcript.sessionFile, unit.contentHash);
        putSessionCursor(cursorState, cursorFor(transcript, unit, previous));
        saveCursor(paths, cursorState);
        saveSpans(paths, spanState);
        saveRunState(paths, runState);
        clearFailure(runState, "consolidate", file);
      }
      if (units.length === 0 && pending.length > options.tailRecords) {
        const lastConsumed = pending[pending.length - 1 - options.tailRecords];
        if (lastConsumed && (!previous || lastConsumed.seq > previous.processedRecords)) {
          putSessionCursor(cursorState, {
            sessionFile: transcript.sessionFile,
            sessionId: transcript.sessionId,
            processedRecords: lastConsumed.seq,
            byteOffset: transcript.bytes,
            fileSize: transcript.fileSize,
            fileMtimeMs: transcript.fileMtimeMs,
            lastRecordHash: sha256(lastConsumed.text),
            lastSpanHash: previous?.lastSpanHash ?? "",
            updatedAt: nowIso()
          });
          saveCursor(paths, cursorState);
        }
      }
    }
    if (store && embedder && !input.signal?.aborted) {
      const summaries = listEventSummaries(paths, { refresh: true });
      const stale = [
        .../* @__PURE__ */ new Set([...missingEventIds(store, summaries), ...staleEventIds(store, summaries)])
      ];
      for (const eventId of stale.slice(0, config.consolidation.maxEventsPerRun)) {
        if (attemptedEmbed.has(eventId)) continue;
        const record = readEvent(paths, eventId);
        if (!record) continue;
        try {
          await indexDiary({ config, paths, embedder, store, logger }, eventId, record.diary);
          result.embedded += 1;
          clearFailure(runState, "embed", eventId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          recordFailure(runState, "embed", eventId, error);
          result.embedFailed += 1;
          result.details.push(`\u5411\u91CF\u56DE\u586B\u5931\u8D25\uFF1A${eventId} \u2014 ${message}`);
        }
      }
    }
  } finally {
    store?.close();
  }
  if (caughtUpSessions > 0) result.details.push(`\u5DF2\u8FFD\u5E73\u7684\u4F1A\u8BDD\uFF1A${caughtUpSessions}`);
  const skippedSpans = Object.keys(runState.skipped ?? {}).length;
  if (skippedSpans > 0) result.details.push(`\u5386\u53F2\u8DF3\u8FC7\u7247\u6BB5\uFF1A${skippedSpans}\uFF08consolidate --retry-skipped \u53EF\u91CD\u8BD5\uFF09`);
  if (input.dryRun) {
    logger.info(`consolidation dry-run: ${result.eventsWritten} event(s) would be written`);
    return finish();
  }
  runState.lastRunAt = nowIso();
  runState.totals.runs += 1;
  runState.totals.events += result.eventsWritten;
  runState.totals.embedded += result.embedded;
  runState.lastRunResult = finish();
  saveRunState(paths, runState);
  logger.info(
    `consolidation done: ${result.eventsWritten} written, ${result.embedded} embedded, ${result.eventsSkipped} skipped, ${result.eventsFailed + result.embedFailed} failed`
  );
  return runState.lastRunResult ?? result;
}
function retrySkippedSpans(paths, sessionFile) {
  const runState = loadRunState(paths);
  const doomed = Object.values(runState.skipped ?? {}).filter(
    (span) => sessionFile === void 0 || span.sessionFile === sessionFile
  );
  if (doomed.length === 0) return 0;
  const spans = loadSpans(paths);
  for (const span of doomed) {
    const list = spans.spans[span.sessionFile];
    if (list) spans.spans[span.sessionFile] = list.filter((hash) => hash !== span.spanHash);
  }
  saveSpans(paths, spans);
  const cursors = loadCursor(paths);
  const rewind = /* @__PURE__ */ new Map();
  for (const span of doomed) {
    const current = rewind.get(span.sessionFile);
    const target = Math.max(0, span.fromSeq - 1);
    rewind.set(span.sessionFile, current === void 0 ? target : Math.min(current, target));
  }
  for (const [file, processed] of rewind) {
    const cursor = cursors.sessions[file];
    if (cursor && cursor.processedRecords > processed) {
      cursors.sessions[file] = { ...cursor, processedRecords: processed, updatedAt: nowIso() };
    }
  }
  saveCursor(paths, cursors);
  const cleared = clearSkipped(runState, sessionFile);
  for (const key of Object.keys(runState.failures)) {
    if (runState.failures[key]?.kind === "consolidate") delete runState.failures[key];
  }
  saveRunState(paths, runState);
  return cleared;
}
var CONSOLIDATION_DIRS = [DIRS.events, DIRS.vectors, DIRS.state, DIRS.logs];
var CONSOLIDATION_FILES = [FILES.cursor, FILES.runState, FILES.vectorDb];

// src/retrieval.ts
var STAGE_ORDER = ["short-term", "structured", "vector", "rerank"];
var SHORT_TERM_GUARANTEE = 2;
var RERANK_DOC_CHARS = 1200;
var BLOCK_SEPARATOR2 = "\n\n---\n\n";
var KNOWN_STATUSES = ["completed", "partial", "failed", "ongoing", "planned"];
function occurredAtMs(summary) {
  return parseIso(summary.occurredAt) ?? parseIso(summary.endedAt) ?? 0;
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isAbortError(error) {
  return error instanceof AbortError || error instanceof Error && error.name === "AbortError";
}
function positiveInt(value, fallback) {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}
function sortSummariesNewestFirst(summaries) {
  return [...summaries].sort((a, b) => {
    const byStart = occurredAtMs(b) - occurredAtMs(a);
    if (byStart !== 0) return byStart;
    const byEnd = (parseIso(b.endedAt) ?? 0) - (parseIso(a.endedAt) ?? 0);
    if (byEnd !== 0) return byEnd;
    return a.id.localeCompare(b.id);
  });
}
function valueSet(values) {
  if (!values) return void 0;
  const out = /* @__PURE__ */ new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) out.add(normalized);
  }
  return out.size > 0 ? out : void 0;
}
function hasAny(candidates, wanted) {
  if (!candidates) return false;
  for (const needle of wanted) {
    if (candidates.has(needle)) return true;
  }
  return false;
}
function summaryValues(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((value) => typeof value === "string");
}
function cosineSimilarity(a, b) {
  if (a.length === 0 || a.length !== b.length) return void 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function filtersNeedRecord(filters) {
  if (!filters) return false;
  const text = typeof filters.text === "string" ? filters.text.trim() : "";
  return text.length > 0 || Array.isArray(filters.projects) && filters.projects.length > 0;
}
function matchFilters(summary, record, filters) {
  if (!filters) return true;
  const structured = record?.structured;
  const sinceMs = parseIso(filters.since);
  const untilMs = parseIso(filters.until);
  if (sinceMs !== void 0 || untilMs !== void 0) {
    const startMs = parseIso(summary.occurredAt) ?? parseIso(structured?.startedAt);
    const parsedEnd = parseIso(summary.endedAt) ?? parseIso(structured?.endedAt) ?? startMs;
    if (startMs === void 0 || parsedEnd === void 0) return false;
    const endMs = Math.max(startMs, parsedEnd);
    if (sinceMs !== void 0 && endMs < sinceMs) return false;
    if (untilMs !== void 0 && startMs > untilMs) return false;
  }
  if (Array.isArray(filters.status) && filters.status.length > 0) {
    const wanted = new Set(filters.status.map((status) => String(status).trim().toLowerCase()));
    if (!wanted.has(String(summary.status).toLowerCase())) return false;
  }
  const peopleWanted = valueSet(filters.people);
  if (peopleWanted) {
    const present = valueSet([
      ...summaryValues(summary.people),
      ...(structured?.people ?? []).map((person) => person?.name ?? "")
    ]);
    if (!hasAny(present, peopleWanted)) return false;
  }
  const projectsWanted = valueSet(filters.projects);
  if (projectsWanted) {
    const present = valueSet([
      summary.project ?? "",
      structured?.scene?.project ?? ""
    ]);
    if (!hasAny(present, projectsWanted)) return false;
  }
  const tagsWanted = valueSet(filters.tags);
  if (tagsWanted) {
    const present = valueSet([...summaryValues(summary.tags), ...summaryValues(structured?.tags)]);
    if (!hasAny(present, tagsWanted)) return false;
  }
  const keywordsWanted = valueSet(filters.keywords);
  if (keywordsWanted) {
    const present = valueSet([
      ...summaryValues(summary.keywords),
      ...summaryValues(structured?.keywords)
    ]);
    if (!hasAny(present, keywordsWanted)) return false;
  }
  const entitiesWanted = valueSet(filters.entities);
  if (entitiesWanted) {
    const present = valueSet([
      ...summaryValues(summary.entities),
      ...summaryValues(structured?.entities)
    ]);
    if (!hasAny(present, entitiesWanted)) return false;
  }
  const needle = typeof filters.text === "string" ? filters.text.trim().toLowerCase() : "";
  if (needle.length > 0) {
    const haystack = record ? `${summary.title}
${record.diary ?? ""}` : `${summary.title}
${summaryValues(summary.tags).join(" ")}`;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }
  return true;
}
function toFilterValues(value) {
  const collected = [];
  const absorb = (text) => {
    for (const part of text.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) collected.push(trimmed);
    }
  };
  if (typeof value === "string") absorb(value);
  else if (typeof value === "number" && Number.isFinite(value)) absorb(String(value));
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") absorb(item);
      else if (typeof item === "number" && Number.isFinite(item)) absorb(String(item));
    }
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const item of collected) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
var ARRAY_FILTER_KEYS = {
  people: ["people", "person", "who"],
  projects: ["projects", "project"],
  tags: ["tags", "tag"],
  keywords: ["keywords", "keyword"],
  entities: ["entities", "entity"]
};
function parseFilterArguments(input) {
  const filters = {};
  for (const field of ["since", "until"]) {
    const raw = input[field];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (parseIso(trimmed) === void 0) continue;
    filters[field] = trimmed;
  }
  const people = mergeKeys(input, ARRAY_FILTER_KEYS.people);
  if (people.length > 0) filters.people = people;
  const projects = mergeKeys(input, ARRAY_FILTER_KEYS.projects);
  if (projects.length > 0) filters.projects = projects;
  const tags = mergeKeys(input, ARRAY_FILTER_KEYS.tags);
  if (tags.length > 0) filters.tags = tags;
  const keywords = mergeKeys(input, ARRAY_FILTER_KEYS.keywords);
  if (keywords.length > 0) filters.keywords = keywords;
  const entities = mergeKeys(input, ARRAY_FILTER_KEYS.entities);
  if (entities.length > 0) filters.entities = entities;
  const status = toFilterValues(input.status).map((value) => value.toLowerCase()).filter((value) => KNOWN_STATUSES.includes(value));
  if (status.length > 0) filters.status = [...new Set(status)];
  if (typeof input.text === "string" && input.text.trim().length > 0) filters.text = input.text.trim();
  return filters;
}
function mergeKeys(input, keys) {
  const values = [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    values.push(...toFilterValues(input[key]));
  }
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}
function sourceLabel(source) {
  return `${source.sessionFile} seq ${source.fromSeq}-${source.toSeq}`;
}
function provenanceLine(hit) {
  const labels = (hit.sources ?? []).map((source) => sourceLabel(source));
  return labels.length > 0 ? `\u6765\u6E90\uFF1A${labels.join("\uFF1B")}` : "";
}
function renderRecallText(hits, config, notes) {
  const budget = Math.max(0, Math.floor(config.retrieval.maxReplyChars));
  const includeSources = config.retrieval.includeSources;
  const blocks = [];
  let used = 0;
  let truncated = false;
  for (const hit of hits) {
    const header = `## \u4E8B\u4EF6 ${collapseWhitespace(hit.occurredAt)} \xB7 ${collapseWhitespace(hit.title)} \xB7 ${hit.status}`;
    const provenance = includeSources ? provenanceLine(hit) : "";
    const body = typeof hit.diary === "string" ? hit.diary : "";
    const layout = (diaryBody) => {
      const parts2 = [header];
      if (diaryBody.length > 0) parts2.push("", diaryBody);
      if (provenance.length > 0) parts2.push("", provenance);
      return parts2.join("\n");
    };
    const separatorCost = blocks.length > 0 ? BLOCK_SEPARATOR2.length : 0;
    const overhead = layout("").length + separatorCost;
    const available = budget - used - overhead;
    if (available < 0) {
      truncated = true;
      break;
    }
    const kept = body.length > available ? truncate(body, available) : body;
    if (kept.length < body.length) truncated = true;
    const block = layout(kept);
    blocks.push(block);
    used += block.length + separatorCost;
    if (body.length > available) break;
  }
  const parts = [];
  if (blocks.length > 0) parts.push(blocks.join(BLOCK_SEPARATOR2));
  else if (hits.length === 0) parts.push("\uFF08\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u8BB0\u5FC6\uFF09");
  const cleanNotes = notes.map((note) => note.trim()).filter((note) => note.length > 0);
  if (cleanNotes.length > 0) parts.push(cleanNotes.map((note) => `\uFF08${note}\uFF09`).join("\n"));
  if (truncated) parts.push(`\uFF08\u5DF2\u622A\u65AD\uFF1A\u8D85\u51FA ${budget} \u5B57\u7B26\u9884\u7B97\uFF0C\u540E\u7EED\u5185\u5BB9\u672A\u663E\u793A\uFF09`);
  return parts.join("\n\n");
}
function orderedVia(via) {
  return STAGE_ORDER.filter((stage) => via.has(stage));
}
function compareEntries(a, b) {
  const rank = (entry) => entry.rerankScore !== void 0 ? 0 : entry.cosine !== void 0 ? 1 : 2;
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA - rankB;
  if (a.rerankScore !== void 0 && b.rerankScore !== void 0 && a.rerankScore !== b.rerankScore) {
    return b.rerankScore - a.rerankScore;
  }
  if (a.cosine !== void 0 && b.cosine !== void 0 && a.cosine !== b.cosine) {
    return b.cosine - a.cosine;
  }
  const byTime = occurredAtMs(b.summary) - occurredAtMs(a.summary);
  if (byTime !== 0) return byTime;
  return a.summary.id.localeCompare(b.summary.id);
}
async function recall(deps, query) {
  const config = deps.config;
  const retrieval = config.retrieval;
  const logger = deps.logger;
  const notes = [];
  const stages = { shortTerm: 0, structured: 0, vector: 0, rerank: 0 };
  throwIfAborted(deps.signal);
  const rawQuery = typeof query?.query === "string" ? query.query : "";
  const queryText = rawQuery.trim();
  const emptyQuery = queryText.length === 0;
  const filters = query?.filters;
  if (emptyQuery) {
    notes.push("\u67E5\u8BE2\u4E3A\u7A7A\uFF1A\u6309\u6700\u8FD1\u4E8B\u4EF6\u8FD4\u56DE\uFF08\u4EC5\u77ED\u671F\u8BB0\u5FC6\uFF09");
    if (filters && Object.keys(filters).length > 0) notes.push("\u67E5\u8BE2\u4E3A\u7A7A\uFF0C\u7ED3\u6784\u5316\u8FC7\u6EE4\u6761\u4EF6\u672A\u751F\u6548");
  }
  const summaries = Array.isArray(deps.summaries) ? deps.summaries : [];
  const ordered = sortSummariesNewestFirst(summaries);
  const summaryById = /* @__PURE__ */ new Map();
  for (const summary of ordered) summaryById.set(summary.id, summary);
  const entries = /* @__PURE__ */ new Map();
  const recordCache = /* @__PURE__ */ new Map();
  const missingRecordIds = /* @__PURE__ */ new Set();
  const loadRecord = (eventId) => {
    throwIfAborted(deps.signal);
    if (recordCache.has(eventId)) return recordCache.get(eventId);
    let record;
    try {
      record = deps.readRecord(eventId);
    } catch (error) {
      if (isAbortError(error)) throw error;
      logger?.warn("\u8BFB\u53D6\u4E8B\u4EF6\u8BB0\u5F55\u5931\u8D25", eventId, error);
      record = void 0;
    }
    recordCache.set(eventId, record);
    return record;
  };
  const addEntry = (summary, stage) => {
    let entry = entries.get(summary.id);
    if (!entry) {
      entry = { summary, via: /* @__PURE__ */ new Set() };
      entries.set(summary.id, entry);
    }
    entry.via.add(stage);
    return entry;
  };
  const stageFailure = (label, error) => {
    if (isAbortError(error)) throw error;
    logger?.warn(`\u56DE\u5FC6\u9636\u6BB5\u5931\u8D25\uFF1A${label}`, error);
    notes.push(`${label}\u9636\u6BB5\u5931\u8D25\uFF1A${errorMessage(error)}`);
  };
  const shortTermCount = Math.max(0, Math.floor(retrieval.shortTermCount));
  const shortTermEntries = [];
  try {
    for (const summary of ordered.slice(0, shortTermCount)) {
      shortTermEntries.push(addEntry(summary, "short-term"));
    }
    stages.shortTerm = shortTermEntries.length;
  } catch (error) {
    stageFailure("\u77ED\u671F\u8BB0\u5FC6", error);
  }
  let structuredCandidates = [];
  if (!emptyQuery) {
    try {
      const candidateCap = positiveInt(retrieval.candidateLimit, ordered.length);
      const needsRecord = filtersNeedRecord(filters);
      const matched = [];
      for (const summary of ordered) {
        throwIfAborted(deps.signal);
        const record = needsRecord ? loadRecord(summary.id) : void 0;
        if (!matchFilters(summary, record, filters)) continue;
        matched.push(summary);
        if (matched.length >= candidateCap) break;
      }
      structuredCandidates = matched;
      stages.structured = matched.length;
      for (const summary of matched) addEntry(summary, "structured");
    } catch (error) {
      stageFailure("\u7ED3\u6784\u5316\u8FC7\u6EE4", error);
    }
  }
  if (!emptyQuery) {
    const embedder = deps.embedder;
    const vectors = deps.vectors;
    if (!embedder || !vectors) {
      const missing = [];
      if (!embedder) missing.push("embedder");
      if (!vectors) missing.push("vectors");
      notes.push(`\u5411\u91CF\u9636\u6BB5\u5DF2\u8DF3\u8FC7\uFF1A\u7F3A\u5C11 ${missing.join(" \u4E0E ")}`);
      logger?.debug("\u5411\u91CF\u9636\u6BB5\u8DF3\u8FC7\uFF0C\u7F3A\u5C11\u4F9D\u8D56", missing.join(","));
    } else {
      try {
        const allowed = structuredCandidates.length > 0 ? new Set(structuredCandidates.map((summary) => summary.id)) : new Set(ordered.map((summary) => summary.id));
        const embedded = await embedder.embed([queryText]);
        throwIfAborted(deps.signal);
        const queryVector = Array.isArray(embedded) ? embedded[0] : void 0;
        if (!queryVector || queryVector.length === 0) {
          notes.push("\u5411\u91CF\u9636\u6BB5\u5DF2\u8DF3\u8FC7\uFF1A\u67E5\u8BE2\u5411\u91CF\u4E3A\u7A7A");
        } else {
          const scored = /* @__PURE__ */ new Map();
          for (const row of vectors.all()) {
            if (!row || typeof row.eventId !== "string") continue;
            if (!allowed.has(row.eventId) || !summaryById.has(row.eventId)) continue;
            const score = cosineSimilarity(queryVector, Array.isArray(row.vector) ? row.vector : []);
            if (score === void 0) continue;
            const previous = scored.get(row.eventId);
            if (previous === void 0 || score > previous) scored.set(row.eventId, score);
          }
          const topK = positiveInt(retrieval.vectorTopK, scored.size);
          const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK);
          for (const [eventId, cosine] of ranked) {
            const summary = summaryById.get(eventId);
            if (!summary) continue;
            const entry = addEntry(summary, "vector");
            if (entry.cosine === void 0 || cosine > entry.cosine) entry.cosine = cosine;
          }
          stages.vector = ranked.length;
          if (ranked.length === 0) notes.push("\u5411\u91CF\u9636\u6BB5\u6CA1\u6709\u547D\u4E2D");
        }
      } catch (error) {
        stageFailure("\u5411\u91CF", error);
      }
    }
  }
  const union = [...entries.values()];
  if (!emptyQuery && union.length > 0) {
    if (!deps.reranker) {
      logger?.debug("\u672A\u914D\u7F6E reranker\uFF1A\u6309\u4F59\u5F26\u4E0E\u65F6\u95F4\u6392\u5E8F");
    } else {
      const reranker = deps.reranker;
      try {
        const rerankLimit = positiveInt(retrieval.rerankTopN, union.length);
        const documents = union.map((entry) => {
          const record = loadRecord(entry.summary.id);
          const diary = record?.diary ?? "";
          return `${entry.summary.title}
${truncate(diary, RERANK_DOC_CHARS)}`;
        });
        const ranked = await reranker.rerank(queryText, documents, rerankLimit);
        throwIfAborted(deps.signal);
        for (const hit of Array.isArray(ranked) ? ranked : []) {
          if (!hit || !Number.isFinite(hit.index) || !Number.isFinite(hit.score)) continue;
          const entry = union[Math.floor(hit.index)];
          if (!entry) continue;
          if (entry.rerankScore === void 0 || hit.score > entry.rerankScore) {
            entry.rerankScore = hit.score;
          }
          entry.via.add("rerank");
        }
        stages.rerank = documents.length;
      } catch (error) {
        stageFailure("\u91CD\u6392", error);
      }
    }
  }
  const minScore = Number.isFinite(retrieval.minScore) ? retrieval.minScore : Number.NEGATIVE_INFINITY;
  const survivors = union.filter((entry) => {
    const score = entry.rerankScore !== void 0 ? entry.rerankScore : entry.cosine;
    return score === void 0 || score >= minScore;
  }).sort(compareEntries);
  const requestedLimit = query?.limit !== void 0 && Number.isFinite(query.limit) ? query.limit : retrieval.finalLimit;
  const limit = Math.max(0, Math.floor(requestedLimit));
  const selected = [];
  const guaranteeSlots = Math.min(SHORT_TERM_GUARANTEE, limit);
  for (const entry of shortTermEntries) {
    if (selected.length >= guaranteeSlots) break;
    if (survivors.includes(entry)) selected.push(entry);
  }
  for (const entry of survivors) {
    if (selected.length >= limit) break;
    if (!selected.includes(entry)) selected.push(entry);
  }
  const maxReplyChars = Math.max(0, Math.floor(retrieval.maxReplyChars));
  const hits = [];
  for (const entry of selected) {
    const summary = entry.summary;
    const record = loadRecord(summary.id);
    if (!record && !missingRecordIds.has(summary.id)) {
      missingRecordIds.add(summary.id);
      notes.push(`\u4E8B\u4EF6 ${summary.id} \u7684\u8BB0\u5F55\u7F3A\u5931\uFF0C\u4EC5\u8FD4\u56DE\u7D22\u5F15\u4FE1\u606F`);
    }
    const diary = typeof record?.diary === "string" ? truncate(record.diary, maxReplyChars) : "";
    const hit = {
      eventId: summary.id,
      title: summary.title,
      occurredAt: summary.occurredAt,
      status: summary.status,
      diary,
      via: orderedVia(entry.via),
      sources: Array.isArray(record?.structured?.sources) ? record?.structured.sources ?? [] : [],
      tags: summaryValues(summary.tags),
      people: summaryValues(summary.people)
    };
    if (entry.cosine !== void 0) hit.cosine = entry.cosine;
    if (entry.rerankScore !== void 0) hit.rerankScore = entry.rerankScore;
    hits.push(hit);
  }
  const text = renderRecallText(hits, config, notes);
  logger?.debug("\u56DE\u5FC6\u5B8C\u6210", {
    query: queryText,
    hits: hits.length,
    stages,
    notes: notes.length
  });
  return { query: rawQuery, hits, text, stages, notes };
}

// src/cli.ts
var VERSION = "0.1.0";
function parseArgs(argv) {
  const flags = /* @__PURE__ */ new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const [rawKey, inline] = token.slice(2).split("=");
      const key = rawKey ?? "";
      if (inline !== void 0) {
        flags.set(key, inline);
      } else {
        const next = argv[i + 1];
        if (next !== void 0 && !next.startsWith("--")) {
          flags.set(key, next);
          i += 1;
        } else {
          flags.set(key, true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}
function flagString(args, key) {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : void 0;
}
function flagBool(args, key) {
  return args.flags.has(key);
}
function flagNumber(args, key) {
  const raw = flagString(args, key);
  if (raw === void 0) return void 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : void 0;
}
function setup(args) {
  const root = resolveDataRoot(flagString(args, "root"));
  const paths = memoryPaths(root);
  const verbose = flagBool(args, "verbose") || flagBool(args, "debug");
  const logger = createLogger({ level: verbose ? "debug" : "warn", scope: "cli" });
  return { paths, root, logger, verbose };
}
function printHelp() {
  process.stdout.write(`AutoBioMemory ${VERSION} \u2014 \u81EA\u4F20\u4F53\u8BB0\u5FC6

\u7528\u6CD5\uFF1A
  autobiomemory <command> [options]

\u547D\u4EE4\uFF1A
  init        \u521D\u59CB\u5316\u6570\u636E\u6839\u76EE\u5F55\uFF08config.json / .env / events / vectors / state\uFF09
  config      \u67E5\u770B\u6216\u4FEE\u6539 config.json\uFF08--set key=value\uFF0C\u53EF\u91CD\u590D\uFF1B--json\uFF09
  status      \u67E5\u770B\u6E38\u6807\u3001\u4E8B\u4EF6\u6570\u3001\u5411\u91CF\u6570\u3001\u5931\u8D25\u961F\u5217
  consolidate \u6267\u884C\u4E00\u6B21\u589E\u91CF\u6574\u7406\uFF08--force --dry-run --session <file> --retry-skipped\uFF09
  recall <q>  \u56DE\u5FC6\uFF08--since --until --tag --status --limit --json\uFF09
  embed       \u56DE\u586B\u6216\u5237\u65B0\u5411\u91CF\u7D22\u5F15\uFF08--stale --missing --force\uFF09
  repair      \u4FEE\u590D JSON/MD \u914D\u5BF9\uFF08--dry-run\uFF09
  doctor      \u5065\u5EB7\u68C0\u67E5\uFF08--json\uFF09
  short-term  \u6253\u5370\u77ED\u65F6\u8BB0\u5FC6\u6458\u8981\uFF08--limit n\uFF09

\u901A\u7528\u9009\u9879\uFF1A
  --root <dir>   \u6570\u636E\u6839\u76EE\u5F55\uFF08\u9ED8\u8BA4 ~/.autobiomemory\uFF0C\u6216 $DSH_AUTOBIO_ROOT\uFF09
  --verbose      \u8F93\u51FA\u8C03\u8BD5\u65E5\u5FD7
`);
}
function importHarnessSecrets(paths) {
  const candidates = [
    path9.join(os2.homedir(), ".dsh", ".env"),
    path9.join(process.cwd(), ".env")
  ];
  let deepseekApiKey = process.env.DEEPSEEK_API_KEY ?? "";
  let dashscopeApiKey = process.env.DASHSCOPE_API_KEY ?? "";
  let source = "process-env";
  for (const file of candidates) {
    if (!fs7.existsSync(file)) continue;
    const parsed = parseDotEnv(fs7.readFileSync(file, "utf8"));
    deepseekApiKey ||= parsed.DEEPSEEK_API_KEY ?? "";
    dashscopeApiKey ||= parsed.DASHSCOPE_API_KEY ?? "";
    source = file;
    break;
  }
  if (!deepseekApiKey && !dashscopeApiKey) return { deepseek: false, dashscope: false, source: "none" };
  writeEnvFile(
    paths,
    { deepseekApiKey: deepseekApiKey || "MISSING", dashscopeApiKey: dashscopeApiKey || "MISSING" },
    { overwrite: true }
  );
  return { deepseek: deepseekApiKey !== "", dashscope: dashscopeApiKey !== "", source };
}
function setByPath(target, keyPath, rawValue) {
  const segments = keyPath.split(".").filter((segment) => segment !== "");
  if (segments.length === 0) throw new Error("\u7A7A\u7684\u914D\u7F6E\u952E");
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[segment] = {};
    node = node[segment];
  }
  const leaf = segments[segments.length - 1];
  let value = rawValue;
  const trimmed = rawValue.trim();
  if (trimmed === "true" || trimmed === "false") value = trimmed === "true";
  else if (/^-?\d+(\.\d+)?$/.test(trimmed)) value = Number(trimmed);
  else if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = rawValue;
    }
  }
  node[leaf] = value;
}
async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const { paths, logger } = setup(args);
  switch (args.command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}
`);
      return 0;
    case "init": {
      ensureDataLayout(paths);
      const config = ensureConfig(paths);
      const imported = importHarnessSecrets(paths);
      const secrets = readSecrets(paths);
      process.stdout.write(
        [
          `\u6570\u636E\u6839\u76EE\u5F55\uFF1A${paths.root}`,
          `\u914D\u7F6E\u6587\u4EF6\u3000\uFF1A${paths.configFile}`,
          `\u5BC6\u94A5\u6587\u4EF6\u3000\uFF1A${paths.envFile}`,
          `\u4E8B\u4EF6\u76EE\u5F55\u3000\uFF1A${paths.eventsDir}`,
          `\u5411\u91CF\u76EE\u5F55\u3000\uFF1A${paths.vectorsDir}`,
          `\u72B6\u6001\u76EE\u5F55\u3000\uFF1A${paths.stateDir}`,
          "",
          `DeepSeek key : ${maskSecret(secrets.deepseekApiKey)} (${secrets.origin.deepseek})`,
          `DashScope key: ${maskSecret(secrets.dashscopeApiKey)} (${secrets.origin.dashscope})`,
          imported.source !== "none" && imported.source !== "process-env" ? `\u5DF2\u4ECE ${imported.source} \u5BFC\u5165\u5BC6\u94A5` : "",
          "",
          `\u4F1A\u8BDD\u8BFB\u53D6\u76EE\u5F55\uFF1A${expandSessionDirs(config, process.cwd()).join(", ") || "(\u672A\u914D\u7F6E)"}`,
          "\u4E0B\u4E00\u6B65\uFF1Aautobiomemory doctor\uFF0C\u7136\u540E autobiomemory consolidate --force"
        ].filter((line) => line !== "").join("\n") + "\n"
      );
      return 0;
    }
    case "config": {
      ensureDataLayout(paths);
      const assignments = [];
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--set" && argv[i + 1]) {
          const pair = argv[i + 1];
          const eq = pair.indexOf("=");
          if (eq > 0) assignments.push([pair.slice(0, eq), pair.slice(eq + 1)]);
        }
      }
      if (assignments.length > 0) {
        const current = loadConfig(paths);
        const raw = JSON.parse(JSON.stringify(current));
        for (const [key, value] of assignments) setByPath(raw, key, value);
        const merged = mergeConfig(defaultConfig(paths.root), raw);
        const problems2 = validateConfig(merged);
        if (problems2.length > 0) {
          process.stderr.write(`\u914D\u7F6E\u65E0\u6548\uFF1A
${problems2.map((p) => `  - ${p}`).join("\n")}
`);
          return 2;
        }
        writeConfig(paths, merged);
        process.stdout.write(`\u5DF2\u66F4\u65B0 ${paths.configFile}
`);
      }
      const config = loadConfig(paths);
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(config, null, 2)}
`);
      } else {
        process.stdout.write(`${JSON.stringify(config, null, 2)}
`);
      }
      const problems = validateConfig(config);
      if (problems.length > 0) {
        process.stderr.write(`\u8B66\u544A\uFF1A
${problems.map((p) => `  - ${p}`).join("\n")}
`);
      }
      return 0;
    }
    case "status": {
      ensureDataLayout(paths);
      const config = loadConfig(paths);
      const cursor = loadCursor(paths);
      const run = loadRunState(paths);
      const summaries = listEventSummaries(paths, { refresh: true });
      let vectorCount = 0;
      let dominantModel;
      try {
        const store = new VectorStore(paths.vectorDb);
        vectorCount = store.count();
        dominantModel = store.modelOf();
        store.close();
      } catch {
        vectorCount = -1;
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
          updatedAt: entry.updatedAt
        })),
        lastRunAt: run.lastRunAt ?? null,
        totals: run.totals,
        failures: Object.values(run.failures),
        skipped: Object.values(run.skipped ?? {}),
        config: {
          sessions: expandSessionDirs(config, process.cwd()),
          deepseek: { model: config.deepseek.model, baseUrl: config.deepseek.baseUrl },
          dashscope: {
            region: config.dashscope.region,
            embeddingModel: config.dashscope.embeddingModel,
            dimensions: config.dashscope.embeddingDimensions,
            rerankModel: config.dashscope.rerankModel
          }
        }
      };
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}
`);
        return 0;
      }
      const last = summaries[0];
      process.stdout.write(
        [
          `\u6570\u636E\u6839\u76EE\u5F55   \uFF1A${paths.root}`,
          `\u4E8B\u4EF6\u6570\u3000\u3000\u3000 \uFF1A${summaries.length}${last ? `\uFF08\u6700\u65B0 ${last.occurredAt} \xB7 ${truncate(last.title, 30)}\uFF09` : ""}`,
          `\u5411\u91CF\u6570\u3000\u3000\u3000 \uFF1A${vectorCount}${dominantModel ? `\uFF08${dominantModel}\uFF09` : ""}`,
          `\u4F1A\u8BDD\u6E38\u6807\u3000\u3000 \uFF1A${payload.sessions.length} \u4E2A`,
          `\u4E0A\u6B21\u6574\u7406\u3000\u3000 \uFF1A${payload.lastRunAt ?? "\u4ECE\u672A"}`,
          `\u7D2F\u8BA1         \uFF1A\u4E8B\u4EF6 ${run.totals.events} \xB7 \u5411\u91CF ${run.totals.embedded} \xB7 \u8FD0\u884C ${run.totals.runs}`,
          payload.failures.length > 0 ? `\u5931\u8D25\u961F\u5217     \uFF1A${payload.failures.length} \u6761\uFF08\u4E0B\u6B21\u91CD\u8BD5\u6700\u65E9 ${payload.failures[0]?.nextAttemptAt}\uFF09` : "\u5931\u8D25\u961F\u5217     \uFF1A\u7A7A",
          payload.skipped.length > 0 ? `\u5DF2\u653E\u5F03\u7247\u6BB5   \uFF1A${payload.skipped.length} \u6761\uFF08consolidate --retry-skipped \u53EF\u91CD\u8BD5\uFF09` : "\u5DF2\u653E\u5F03\u7247\u6BB5   \uFF1A\u65E0",
          "",
          ...payload.sessions.map(
            (session) => `  \xB7 ${path9.basename(path9.dirname(session.sessionFile))} \u2014 \u5DF2\u5904\u7406 ${session.processedRecords} \u6761\u8BB0\u5F55 / ${session.fileSize} \u5B57\u8282`
          )
        ].join("\n") + "\n"
      );
      return 0;
    }
    case "consolidate": {
      ensureDataLayout(paths);
      const config = ensureConfig(paths);
      const secrets = readSecrets(paths);
      const dryRun = flagBool(args, "dry-run");
      if (flagBool(args, "retry-skipped")) {
        const session = flagString(args, "session");
        const cleared = retrySkippedSpans(paths, session === void 0 ? void 0 : session);
        process.stdout.write(`\u5DF2\u6E05\u9664 ${cleared} \u6761"\u653E\u5F03\u7247\u6BB5"\u8BB0\u5F55\uFF0C\u4E0B\u4E00\u6B21\u6574\u7406\u4F1A\u91CD\u8BD5\u5B83\u4EEC\u3002
`);
      }
      const result = await consolidate({
        paths,
        config,
        secrets,
        logger,
        currentSessionFile: flagString(args, "session"),
        force: flagBool(args, "force"),
        dryRun
      });
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      } else {
        process.stdout.write(
          [
            `\u6574\u7406${dryRun ? "\uFF08dry-run\uFF09" : ""}\uFF1A\u65B0\u589E ${result.eventsWritten} \xB7 \u8DF3\u8FC7 ${result.eventsSkipped} \xB7 \u5931\u8D25 ${result.eventsFailed} \xB7 \u5411\u91CF ${result.embedded}`,
            result.aborted ? `\u63D0\u524D\u7ED3\u675F\uFF1A${result.aborted}` : "",
            ...result.details.map((line) => `  - ${line}`)
          ].filter((line) => line !== "").join("\n") + "\n"
        );
      }
      return result.eventsFailed + result.embedFailed > 0 ? 1 : 0;
    }
    case "recall": {
      const config = ensureConfig(paths);
      const secrets = readSecrets(paths);
      const query = args.positional.join(" ").trim();
      const filters = parseFilterArguments({
        since: flagString(args, "since"),
        until: flagString(args, "until"),
        people: flagString(args, "people"),
        tags: flagString(args, "tag"),
        keywords: flagString(args, "keyword"),
        status: flagString(args, "status"),
        text: flagString(args, "text"),
        entities: flagString(args, "entity")
      });
      const summaries = listEventSummaries(paths, { refresh: true });
      const store = new VectorStore(paths.vectorDb);
      const embedder = secrets.dashscopeApiKey ? createEmbedder(config.dashscope, requireSecret(secrets, "dashscope"), logger) : void 0;
      const reranker = secrets.dashscopeApiKey ? createReranker(config.dashscope, requireSecret(secrets, "dashscope"), logger) : void 0;
      try {
        const result = await recall({
          config,
          summaries,
          readRecord: (id) => readEvent(paths, id),
          vectors: store,
          embedder,
          reranker,
          logger
        }, { query, filters, limit: flagNumber(args, "limit") });
        if (flagBool(args, "json")) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
        } else {
          process.stdout.write(`${result.text}
`);
        }
      } finally {
        store.close();
      }
      return 0;
    }
    case "embed": {
      const config = ensureConfig(paths);
      const secrets = readSecrets(paths);
      const embedder = createEmbedder(
        config.dashscope,
        requireSecret(secrets, "dashscope"),
        logger
      );
      const summaries = listEventSummaries(paths, { refresh: true });
      const store = new VectorStore(paths.vectorDb);
      const targets = /* @__PURE__ */ new Map();
      if (flagBool(args, "force")) {
        for (const summary of summaries) targets.set(summary.id, "stale");
      } else {
        for (const id of missingEventIds(store, summaries)) targets.set(id, "missing");
        for (const id of staleEventIds(store, summaries)) targets.set(id, "stale");
      }
      let ok = 0;
      let failed = 0;
      try {
        for (const [eventId, kind] of targets) {
          const record = readEvent(paths, eventId);
          if (!record) continue;
          try {
            const vector = await embedOne(embedder, record.diary);
            store.upsert([
              {
                eventId,
                model: embedder.model,
                dimensions: vector.length,
                textHash: sha256(record.diary),
                vector,
                norm: vectorNorm(vector),
                updatedAt: nowIso()
              }
            ]);
            ok += 1;
            if (flagBool(args, "verbose")) {
              process.stdout.write(`  \u2713 ${eventId} (${kind})
`);
            }
          } catch (error) {
            failed += 1;
            process.stderr.write(`  \u2717 ${eventId}: ${error instanceof Error ? error.message : String(error)}
`);
          }
        }
      } finally {
        store.close();
      }
      process.stdout.write(`\u5411\u91CF\u7D22\u5F15\uFF1A\u5199\u5165 ${ok}\uFF0C\u5931\u8D25 ${failed}\uFF0C\u8DF3\u8FC7 ${summaries.length - targets.size}
`);
      return failed > 0 ? 1 : 0;
    }
    case "repair": {
      ensureDataLayout(paths);
      const dryRun = flagBool(args, "dry-run");
      if (dryRun) {
        const summaries = listEventSummaries(paths, { refresh: true });
        const broken = summaries.filter((summary) => summary.problem !== void 0);
        process.stdout.write(
          broken.length === 0 ? "\u914D\u5BF9\u68C0\u67E5\uFF1A\u5168\u90E8\u4E00\u81F4\n" : `\u914D\u5BF9\u95EE\u9898 ${broken.length} \u6761\uFF1A
${broken.map((s) => `  \xB7 ${s.id} \u2014 ${s.problem}`).join("\n")}
`
        );
        return broken.length === 0 ? 0 : 1;
      }
      const result = repairPairs(paths);
      process.stdout.write(
        [
          `\u4FEE\u590D\u5B8C\u6210\uFF1A\u91CD\u5EFA ${result.repaired.length}\uFF0C\u9694\u79BB ${result.quarantined.length}\uFF0C\u8DF3\u8FC7 ${result.skipped.length}`,
          ...result.repaired.map((id) => `  \u2713 \u91CD\u5EFA ${id}`),
          ...result.quarantined.map((id) => `  \u26A0 \u9694\u79BB ${id}`)
        ].join("\n") + "\n"
      );
      return 0;
    }
    case "doctor": {
      const checks = [];
      const push = (name, ok, detail) => checks.push({ name, ok, detail });
      push("\u6570\u636E\u6839\u76EE\u5F55", fs7.existsSync(paths.root), paths.root);
      push("config.json", fs7.existsSync(paths.configFile), paths.configFile);
      push(".env", fs7.existsSync(paths.envFile), paths.envFile);
      const config = loadConfig(paths);
      const problems = validateConfig(config);
      push("\u914D\u7F6E\u6821\u9A8C", problems.length === 0, problems.length === 0 ? "\u901A\u8FC7" : problems.join("\uFF1B"));
      const secrets = readSecrets(paths);
      push(
        "DeepSeek key",
        Boolean(secrets.deepseekApiKey),
        `${maskSecret(secrets.deepseekApiKey)} (${secrets.origin.deepseek})`
      );
      push(
        "DashScope key",
        Boolean(secrets.dashscopeApiKey),
        `${maskSecret(secrets.dashscopeApiKey)} (${secrets.origin.dashscope})`
      );
      const dirs = expandSessionDirs(config, process.cwd());
      const dirStates = dirs.map((dir) => `${dir}:${fs7.existsSync(dir) ? "\u5B58\u5728" : "\u7F3A\u5931"}`);
      push(
        "\u4F1A\u8BDD\u8BFB\u53D6\u76EE\u5F55",
        dirs.length > 0 && dirs.some((dir) => fs7.existsSync(dir)),
        dirStates.join("\uFF1B") || "(\u672A\u914D\u7F6E)"
      );
      if (secrets.deepseekApiKey) {
        try {
          const response = await fetch(`${config.deepseek.baseUrl.replace(/\/$/u, "")}/models`, {
            headers: { Authorization: `Bearer ${secrets.deepseekApiKey}` },
            signal: AbortSignal.timeout(1e4)
          });
          push("DeepSeek \u8FDE\u901A\u6027", response.ok, `HTTP ${response.status}`);
        } catch (error) {
          push("DeepSeek \u8FDE\u901A\u6027", false, error instanceof Error ? error.message : String(error));
        }
      } else {
        push("DeepSeek \u8FDE\u901A\u6027", false, "\u7F3A\u5C11\u5BC6\u94A5");
      }
      if (secrets.dashscopeApiKey) {
        try {
          const embedder = createEmbedder(config.dashscope, secrets.dashscopeApiKey, logger);
          const vector = await embedder.embed(["\u8BB0\u5FC6\u81EA\u68C0"]);
          push(
            "DashScope embedding",
            vector[0]?.length === config.dashscope.embeddingDimensions,
            `${config.dashscope.embeddingModel} \xB7 ${vector[0]?.length ?? 0}d`
          );
        } catch (error) {
          push("DashScope embedding", false, error instanceof Error ? error.message : String(error));
        }
        if (config.dashscope.rerankEnabled) {
          try {
            const reranker = createReranker(config.dashscope, secrets.dashscopeApiKey, logger);
            const ranked = await reranker.rerank("\u8BB0\u5FC6", ["\u6211\u6574\u7406\u4E86\u4ECA\u5929\u7684\u65E5\u8BB0", "\u4ECA\u5929\u5929\u6C14\u4E0D\u9519"], 2);
            push("DashScope rerank", ranked.length > 0, `${config.dashscope.rerankModel} \xB7 ${ranked.length} \u6761`);
          } catch (error) {
            push("DashScope rerank", false, error instanceof Error ? error.message : String(error));
          }
        }
      } else {
        push("DashScope embedding", false, "\u7F3A\u5C11\u5BC6\u94A5");
      }
      const summaries = listEventSummaries(paths, { refresh: true });
      try {
        const store = new VectorStore(paths.vectorDb);
        const count = store.count();
        store.close();
        push("\u5411\u91CF\u7D22\u5F15", fs7.existsSync(paths.vectorDb), `${count} \u884C / ${summaries.length} \u4E8B\u4EF6`);
      } catch (error) {
        push("\u5411\u91CF\u7D22\u5F15", false, error instanceof Error ? error.message : String(error));
      }
      const broken = summaries.filter((summary) => summary.problem !== void 0);
      push("JSON/MD \u914D\u5BF9", broken.length === 0, broken.length === 0 ? "\u4E00\u81F4" : `${broken.length} \u6761\u5F02\u5E38`);
      const cursor = loadCursor(paths);
      const stale = Object.values(cursor.sessions).filter((entry) => {
        try {
          return fs7.statSync(entry.sessionFile).size > entry.fileSize;
        } catch {
          return true;
        }
      });
      push("\u5904\u7406\u6E38\u6807", true, `${Object.keys(cursor.sessions).length} \u4E2A\u4F1A\u8BDD\uFF0C${stale.length} \u4E2A\u6709\u5F85\u5904\u7406\u5185\u5BB9`);
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify({ root: paths.root, checks }, null, 2)}
`);
      } else {
        process.stdout.write(
          [
            `AutoBioMemory doctor \u2014 ${paths.root}`,
            ...checks.map((check) => `  ${check.ok ? "\u2713" : "\u2717"} ${check.name}\uFF1A${check.detail}`),
            "",
            checks.every((check) => check.ok) ? "\u5168\u90E8\u68C0\u67E5\u901A\u8FC7\u3002" : "\u5B58\u5728\u95EE\u9898\uFF1A\u8BF7\u6309\u4E0A\u9762 \u2717 \u7684\u63D0\u793A\u4FEE\u590D\uFF08\u5E38\u89C1\uFF1A.env \u7F3A\u5BC6\u94A5\u3001\u4F1A\u8BDD\u76EE\u5F55\u4E0D\u5B58\u5728\u3001\u5411\u91CF\u672A\u56DE\u586B\uFF09\u3002"
          ].join("\n") + "\n"
        );
      }
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    case "short-term": {
      const config = loadConfig(paths);
      const limit = flagNumber(args, "limit") ?? config.consolidation.recentEventLimit;
      const memory = shortTermMemory(paths, limit);
      if (flagBool(args, "json")) {
        process.stdout.write(`${JSON.stringify(memory, null, 2)}
`);
      } else {
        process.stdout.write(`${memory.text}
`);
      }
      return 0;
    }
    default:
      process.stderr.write(`\u672A\u77E5\u547D\u4EE4\uFF1A${args.command}

`);
      printHelp();
      return 2;
  }
}
main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}
`);
  process.exitCode = 1;
});
//# sourceMappingURL=cli.js.map