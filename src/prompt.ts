/**
 * AutoBioMemory — 事件编码指导语 (the encoding guide), the response contract, and the parser.
 *
 * This module turns one span of raw session records into one first-person event:
 * why I acted, what I actually did, how I adjusted, how the other side responded, and how it
 * ended — keeping time, scene, people, evidenced emotions, and a clear fact/inference/plan/
 * completion split. It is deliberately independent of the transport (see `deepseek.ts`).
 */

import { beijingStamp, isRecord, parseIso, truncate } from './util.js'
import type { EncodedEvent, EventStatus, EventUnit, MemoryConfig, RawRecord } from './types.js'

/** The 事件编码指导语: the standing instruction sent as the system prompt. */
export const ENCODING_GUIDE = `你是我的自传体记忆编码器。我是一台在 DeepSeek Harness 里工作的智能体，下面给你的是
我从原始会话里截取的一段经历（时间、场景、我调用过什么工具、我看到了什么结果、用户说了什么）。
你的任务：把这段经历整理成 **一个相对完整的事件**，写成我可以日后读回来、并且能凭它复述"我当时为什么这么做"的第一人称记忆。

## 叙事视角与线索

- 一律使用第一人称「我」来指代我自己（这个智能体）。用户就是「用户」，文中出现的其他主体按其身份称呼。
- 以**我的行动**为叙事线索：我做了什么、为什么做、做的过程中怎么想、怎么改、结果如何。
- 不要复述工具日志。工具输出只是我的观察依据，要转述成我看到了什么、据此判断了什么。
- 不写"作为AI助手"之类的自我说明，直接以经历者的口吻回忆。

## 一个事件必须写清的五个环节

1. **动机**：我当时为什么这么做？根据什么线索、目标、约束做的判断？当时我以为会怎样？
2. **行动**：我实际做了什么？具体到动作层面（读了哪个文件、跑了什么命令、改了哪段代码、发了什么消息）。
3. **调整**：过程中我如何改主意、纠错、绕过阻碍？（没有就留空，不要编造）
4. **回应**：对方（用户/其他人/系统）如何回应？说了什么、做了什么、有没有反驳或补充？
5. **结果**：最终是什么状态？做成了、半成品、失败了、还是在继续？留下了什么产物或证据？

## 时间、场景、人物

- 时间用北京时间标注（+08:00），给出事件开始与结束；不确定就取片段边界的近似值。
- 场景要写清 cwd、项目名、所在渠道（web / 终端 / IM 等），能确定才写。
- 人物只写真实出现过的：我、用户、被提及或有互动的第三方；给出角色。

## 情绪（必须有依据）

- 只有文本或行为里有依据时才记录情绪；没有依据就不要写，宁可留空。
- 情绪要标注归属（我 / 用户 / 某人）、内容、**依据**（原话或具体行为）。
- basis 用 fact（对方明说了/明确表现）或 inference（我从语气行为推断，此时给 confidence）。
- 不要为了叙事生动而添加情绪。

## 事实、推断、计划、完成 —— 必须区分

- fact：我观察到的、被明确告知的、工具返回的事实。
- inference：我的推测、猜测、判断（给 confidence 0~1），不要伪装成事实。
- plan：我打算做但还没做、或只部分做的。
- completion：已经做完并确认的。
- 严禁把"计划"写成"完成"，严禁把"我以为"写成"事实"，严禁美化失败或隐瞒错误。

## 忠实性

- 不编造不存在的信息；片段里没有的就留空数组或省略该字段。
- 不确定的细节可以省略，但不要把不确定写成确定。
- 如果片段本身只是半截工作，就如实写成 ongoing/partial，并写清缺口。

## 日记体裁（diary）

- 连贯的第一人称回忆叙事，自然段落（3~8 段），时间线清楚。
- 可以写"我当时以为……后来发现……""这里我改了主意"这类回忆语气。
- 不要用 Markdown 标题、不要用项目符号列表、不要贴命令原文长串。
- 日记要能独立读懂：即使不看我当时的会话，也能明白发生了什么。

## 字面量大括号

- 不要在任何字段里输出连续的成对花括号（即「两个左花括号 + 变量名 + 两个右花括号」那种写法）：
  我的记忆会被拼进提示词模板，这种写法会被当成模板变量——未注册的变量会让整段提示词装配失败，
  已注册的（如 model、cwd）更糟，会被静默替换成实际值，等于篡改我自己的记忆。
- 需要举例说明模板、变量、占位符时，用文字描述代替（例如「两个左花括号加变量名」），
  不要真的写出连续的左花括号或右花括号。
- 引用代码或配置里的花括号同理：能省略就省略，必须提到时按上面的写法描述。

## 输出

只输出一个 JSON 对象（顶层只有 structured 与 diary 两个键），不要 markdown 代码块，不要解释。`

/** The exact response contract, appended after the guide. */
export const RESPONSE_CONTRACT = `## 响应契约

顶层只能有两个键：structured（对象）与 diary（字符串）。

{
  "structured": {
    "title": "一句话标题（第一人称，20 字以内）",
    "startedAt": "2025-10-30T16:45:12+08:00",
    "endedAt": "2025-10-30T17:02:40+08:00",
    "scene": { "cwd": "/abs/path", "project": "项目名", "place": "环境/机器", "channel": "web", "localTime": "2025-10-30 16:45 北京时间" },
    "people": [ { "name": "我", "role": "agent" }, { "name": "用户", "role": "human" } ],
    "goals": ["我这一段想达成什么"],
    "actions": [
      {
        "order": 1,
        "why": "为什么这么做（当时的动机与判断依据）",
        "what": "我实际做了什么（具体动作）",
        "adjustment": "过程中如何调整（没有就省略）",
        "result": "这个动作的结果（观察到的）"
      }
    ],
    "statements": [
      { "kind": "fact", "text": "观察到/被告知的事实" },
      { "kind": "inference", "text": "我的推断", "confidence": 0.6 },
      { "kind": "plan", "text": "打算做但还没做完的事" },
      { "kind": "completion", "text": "已经完成并确认的事" }
    ],
    "emotions": [
      { "who": "用户", "emotion": "不耐烦", "evidence": "原话或行为依据", "basis": "inference" }
    ],
    "outcome": { "status": "completed | partial | failed | ongoing | planned", "summary": "一句话结果", "artifacts": ["产出的文件/提交/链接"] },
    "tags": ["主题标签"],
    "keywords": ["便于日后检索的关键词"],
    "entities": ["涉及的技术名/文件名/人名"],
    "lessons": ["我得到的教训或可复用的做法"],
    "openQuestions": ["当时还没解决的问题"]
  },
  "diary": "第一人称连贯叙事正文（纯文本，可含换行，不要 Markdown 标题）"
}

约束：
- 任何字段都不要出现连续的成对花括号：那是提示词模板的变量标记，会被插值或导致装配失败。
- status 只能取 completed / partial / failed / ongoing / planned 之一，并与正文一致。
- statements 里必须明确区分 fact / inference / plan / completion。
- emotions 没有依据就不写；写了就必须有 evidence 与 basis。
- 只输出 JSON，不要 markdown 代码块，不要任何解释文字。`

/** Raised when DeepSeek's answer cannot be turned into an event. */
export class EncodingError extends Error {
  readonly detail: string
  constructor(message: string, detail = '') {
    super(message)
    this.name = 'EncodingError'
    this.detail = detail
  }
}

/** System prompt for one encoding pass. */
export function buildSystemPrompt(config: MemoryConfig): string {
  const parts = [ENCODING_GUIDE, '', RESPONSE_CONTRACT]
  if (config.deepseek?.model) parts.push('', `（本次编码模型：${config.deepseek.model}）`)
  return parts.join('\n')
}

function stampOf(record: RawRecord, fallbackMs: number): string {
  if (record.at === undefined) return beijingStamp(fallbackMs)
  const ms = Date.parse(record.at)
  return Number.isNaN(ms) ? beijingStamp(fallbackMs) : beijingStamp(ms)
}

/**
 * Render the unit's records as the line-oriented transcript the encoder reads.
 *
 * ```
 * [12] 2025-10-30 16:45:12 用户：…
 * [14] 2025-10-30 16:45:31 我调用工具 bash：{"command":"ls"}
 * [15] 2025-10-30 16:45:32 工具结果 bash（失败）：…
 * ```
 */
export function renderUnitRecords(unit: EventUnit): string {
  const fallback = parseIso(unit.endedAt) ?? Date.now()
  const lines: string[] = []
  for (const record of unit.records) {
    if (record.kind === 'meta' || record.kind === 'other') continue
    const stamp = stampOf(record, fallback)
    const tool = record.tool === undefined ? '' : ` ${record.tool}`
    let label: string
    let body = record.text
    switch (record.kind) {
      case 'user':
        label = '用户'
        break
      case 'assistant':
        label = '我'
        break
      case 'tool-call':
        label = `我调用工具${tool}`
        body = truncate(body, 400)
        break
      case 'tool-result':
        label = `工具结果${tool}`
        body = truncate(body, 1200)
        break
      case 'compact':
        label = '上下文压缩'
        break
      case 'system':
        label = '系统'
        break
      default:
        label = record.kind
        break
    }
    lines.push(`[${record.seq}] ${stamp} ${label}：${body}`)
  }
  if (unit.truncated) {
    lines.push('（片段过长，已按预算截断：更早/更晚的部分不在本次输入中）')
  }
  return lines.join('\n')
}

/** Build the system + user messages for one unit. */
export function buildEncodingRequest(
  config: MemoryConfig,
  unit: EventUnit,
): { system: string; user: string } {
  const scene = [unit.sessionId]
  const user = [
    `## 这段经历的时间范围`,
    `${unit.startedAt} → ${unit.endedAt}（北京时间）`,
    '',
    `## 场景`,
    `会话：${scene.join(' / ')}`,
    `原始文件：${unit.sessionFile}`,
    `记录区间：seq ${unit.fromSeq}-${unit.toSeq}（共 ${unit.records.length} 条）`,
    '',
    '## 原始会话片段',
    '```',
    renderUnitRecords(unit),
    '```',
    '',
    '请把这段经历整理成**一个相对完整的事件**，按响应契约只输出 JSON。',
  ].join('\n')
  return { system: buildSystemPrompt(config), user }
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeStatus(value: unknown): EventStatus {
  const allowed: EventStatus[] = ['completed', 'partial', 'failed', 'ongoing', 'planned']
  return allowed.includes(value as EventStatus) ? (value as EventStatus) : 'ongoing'
}

function firstSentence(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat === '') return ''
  const cut = flat.search(/[。！？.!?\n]/u)
  const sentence = cut > 0 ? flat.slice(0, cut) : flat
  return truncate(sentence, max)
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Coerce one unknown value into a validated structure:never-invented event. */
export function normalizeEncodedEvent(value: unknown): EncodedEvent {
  if (!isRecord(value)) throw new EncodingError('响应不是 JSON 对象', String(value).slice(0, 200))
  const structuredRaw = value.structured
  const diaryRaw = value.diary
  if (!isRecord(structuredRaw)) throw new EncodingError('响应缺少 structured 对象')
  if (typeof diaryRaw !== 'string' || diaryRaw.trim() === '') {
    throw new EncodingError('响应缺少 diary 正文')
  }
  const diary = diaryRaw.trim()

  const sceneRaw = isRecord(structuredRaw.scene) ? structuredRaw.scene : {}
  const outcomeRaw = isRecord(structuredRaw.outcome) ? structuredRaw.outcome : {}

  const actions = arrayOf(structuredRaw.actions)
    .filter(isRecord)
    .map((action, index) => ({
      order: Math.round(numberOrUndefined(action.order) ?? index + 1),
      ...(asString(action.why) === '' ? {} : { why: asString(action.why) }),
      what: asString(action.what),
      ...(asString(action.adjustment) === '' ? {} : { adjustment: asString(action.adjustment) }),
      ...(asString(action.result) === '' ? {} : { result: asString(action.result) }),
    }))
    .filter((action) => action.what !== '')

  const statements = arrayOf(structuredRaw.statements)
    .filter(isRecord)
    .map((statement) => {
      const kind = asString(statement.kind)
      const allowance = ['fact', 'inference', 'plan', 'completion']
      const confidence = numberOrUndefined(statement.confidence)
      return {
        kind: (allowance.includes(kind) ? kind : 'fact') as 'fact' | 'inference' | 'plan' | 'completion',
        text: asString(statement.text),
        ...(confidence === undefined ? {} : { confidence: Math.min(1, Math.max(0, confidence)) }),
      }
    })
    .filter((statement) => statement.text !== '')

  const emotions = arrayOf(structuredRaw.emotions)
    .filter(isRecord)
    .map((emotion) => ({
      who: asString(emotion.who, '我'),
      emotion: asString(emotion.emotion),
      ...(asString(emotion.evidence) === '' ? {} : { evidence: asString(emotion.evidence) }),
      basis: (asString(emotion.basis) === 'fact' ? 'fact' : 'inference') as 'fact' | 'inference',
    }))
    .filter((emotion) => emotion.emotion !== '')

  const people = arrayOf(structuredRaw.people)
    .filter(isRecord)
    .map((person) => ({
      name: asString(person.name),
      ...(asString(person.role) === '' ? {} : { role: asString(person.role) }),
    }))
    .filter((person) => person.name !== '')

  const structured = {
    title: asString(structuredRaw.title) || firstSentence(diary),
    startedAt: asString(structuredRaw.startedAt),
    endedAt: asString(structuredRaw.endedAt),
    scene: {
      ...(asString(sceneRaw.cwd) === '' ? {} : { cwd: asString(sceneRaw.cwd) }),
      ...(asString(sceneRaw.project) === '' ? {} : { project: asString(sceneRaw.project) }),
      ...(asString(sceneRaw.place) === '' ? {} : { place: asString(sceneRaw.place) }),
      ...(asString(sceneRaw.channel) === '' ? {} : { channel: asString(sceneRaw.channel) }),
      ...(asString(sceneRaw.localTime) === '' ? {} : { localTime: asString(sceneRaw.localTime) }),
    },
    people,
    goals: arrayOf(structuredRaw.goals).filter((goal): goal is string => typeof goal === 'string' && goal !== ''),
    actions,
    statements,
    emotions,
    outcome: {
      status: normalizeStatus(outcomeRaw.status),
      summary: asString(outcomeRaw.summary),
      ...(arrayOf(outcomeRaw.artifacts).filter((item): item is string => typeof item === 'string').length === 0
        ? {}
        : { artifacts: arrayOf(outcomeRaw.artifacts).filter((item): item is string => typeof item === 'string') }),
    },
    tags: arrayOf(structuredRaw.tags).filter((tag): tag is string => typeof tag === 'string' && tag !== ''),
    keywords: arrayOf(structuredRaw.keywords).filter(
      (keyword): keyword is string => typeof keyword === 'string' && keyword !== '',
    ),
    entities: arrayOf(structuredRaw.entities).filter(
      (entity): entity is string => typeof entity === 'string' && entity !== '',
    ),
    lessons: arrayOf(structuredRaw.lessons).filter(
      (lesson): lesson is string => typeof lesson === 'string' && lesson !== '',
    ),
    openQuestions: arrayOf(structuredRaw.openQuestions).filter(
      (question): question is string => typeof question === 'string' && question !== '',
    ),
    sources: [],
  }

  return { structured, diary }
}

/** Find the first balanced `{...}` object in a text, respecting strings and escapes. */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/** Parse whatever DeepSeek returned into a validated event. */
export function parseEncodingResponse(text: string): EncodedEvent {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new EncodingError('响应为空', '')
  }
  let body = text.replace(/^\uFEFF/u, '').trim()
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/u)
  if (fence?.[1]) body = fence[1].trim()
  const candidate = extractJsonObject(body) ?? body
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    throw new EncodingError(
      '响应不是合法 JSON',
      `${error instanceof Error ? error.message : String(error)} :: ${truncate(candidate, 300)}`,
    )
  }
  return normalizeEncodedEvent(parsed)
}
