# AutoBioMemory 架构

## 一句话

以 agent 自己的行动为线索，把一段段原始会话整理成第一人称事件日记，并把日记同时存成
「可读的记忆（MD）」与「可检索的记忆（向量）」，在需要时按结构化条件 + 语义 + 重排回忆出来。

```
                    ┌────────────────────────── 触发 ──────────────────────────┐
                    │ agent/pre-step (prepend)                                 │
                    │ session/event: compaction/start                          │
                    │ tool: autobiomemory_consolidate / CLI consolidate        │
                    └───────────────────────────┬──────────────────────────────┘
                                                ▼
  原始会话（只读、原地）                    ┌──────────────┐
  ~/.dsh/sessions/**/session.jsonl.zstd ──▶ │ consolidate  │  ← state/cursor.json（游标）
                                            │              │  ← state/spans.json（去重哈希）
                                            └──────┬───────┘
                                                   │ 选"相对完整的事件"片段（units）
                                                   ▼
                                          ┌─────────────────┐
                                          │ DeepSeek 编码    │  system=事件编码指导语
                                          │ → {structured,  │  user=片段文本 + 响应契约
                                          │      diary}     │
                                          └────────┬────────┘
                                                   ▼
                                 ┌─────────────────────────────────┐
                                 │ store.writeEventPair            │
                                 │  events/<id>.json  （+sources）  │
                                 │  events/<id>.md    （仅日记）    │
                                 └────────┬────────────────────────┘
                                          ▼
                            ┌──────────────────────────────┐
                            │ DashScope 北京区 embedding    │
                            │ vectors/index.sqlite         │
                            │ (event_id, model, dim, hash) │
                            └──────────────┬───────────────┘

回忆：query ─┬─▶ 短时记忆（最近 N 条日记，直接在场）
             ├─▶ 结构化筛选（时间/人物/项目/标签/状态/实体/子串）
             ├─▶ 向量召回（query embedding × 候选事件向量 = cosine topK）
             └─▶ DashScope reranking（query × 候选日记）
                                     ▼
                        RecallHit[] + 来源（会话文件 + seq 区间）
```

## 模块与职责

| 模块 | 职责 | 关键实现 |
| --- | --- | --- |
| `session-reader.ts` | 读取并归一化原始会话 | dsh 每次追加写一个**独立 zstd 帧**，必须逐帧解析（`zlib.zstdDecompressSync` 只解第一帧）；把事件日志（`user/message`、`assistant/message`、`tool/call`、`tool/result`…）归一化成 `RawRecord[]`，跳过流式增量 `*chunks` |
| `units.ts` | 事件切分 | 从 `user` 记录起、不切断 `tool-call`/`tool-result` 配对、受 `maxRecordsPerEvent`/`maxInputChars` 预算约束、尾部 `tailRecords` 留给下一轮 |
| `prompt.ts` | 事件编码指导语 + 响应契约 + 解析 | 指导语规定第一人称、动机→行动→调整→回应→结果、事实/推断/计划/完成四态、情绪须有依据；解析器容忍代码块/前后散文，只取第一个平衡的 JSON 对象 |
| `deepseek.ts` | DeepSeek Chat 客户端 | `POST /chat/completions`，JSON 模式，429/5xx 重试，超时与取消 |
| `distill.ts` | 单元 → `EncodedEvent` | 强制写入单条来源引用，缺失时间用片段边界补全 |
| `store.ts` | JSON/MD 配对存储 + 事件索引 + 短时记忆 + 配对修复 | `events/<id>.json` 与 `events/<id>.md` 同 ID 成对；MD 只放日记正文；索引缓存 `state/events-index.json`；`repairPairs()` 重建/隔离 |
| `vectors.ts` | 本地向量索引 | `node:sqlite`（无需原生依赖），Float32 blob + 预计算范数；`staleEventIds()` 以 `text_hash` 判定失效 |
| `embed.ts` | DashScope（北京）embedding / rerank 客户端 | `compatible-mode/v1/embeddings` 与 `api/v1/services/rerank/text-rerank/text-rerank` |
| `retrieval.ts` | 回忆流水线 | 短时 → 结构化 → 向量 → rerank，每级失败只记 note 不中断；输出带来源的日记块 |
| `consolidate.ts` | 写路径编排 | 增量、去重、失败退避、游标原子推进、向量回填 |
| `plugin.ts` | dsh 集成 | 工具注册、系统提示词短时记忆段、`agent/pre-step` 前置触发、`compaction/start` 兜底 |
| `cli.ts` | 运维入口 | init/config/status/consolidate/recall/embed/repair/doctor/short-term |

## 为什么是这些 dsh 扩展点

| 需求 | dsh 机制 | 说明 |
| --- | --- | --- |
| 上下文压缩**前**整理 | `agent/pre-step` waterfall（`{ prepend: true }`） | `compaction-basic` 在自己的 `agent/pre-step` 监听器里调用 `compactIfNeeded()`；prepend 让我们先跑 |
| 压缩发生时的兜底 | `session/event` 里的 `compaction/start` | `compaction/*` 是**会话事件**（非 cordis 事件），只能这样观察 |
| 主动回忆 | `ctx.tools.register(defineTool({...}))` | 参数为 JSON Schema DSL，输出声明 canonical schema + render |
| 记忆常驻上下文 | `ctx.systemPrompt.section({name, order, text})` | `order: 191`（工具指导带之后），`text` 每次装配重新求值 |
| 当前会话文件路径 | `ctx.get('sessionPersistence')?.locate(agent.session.header)` | 纯函数、不触盘，返回 `{kind:'jsonl', path}` |

## 事件的数据形状

`events/<id>.json`：

```jsonc
{
  "schemaVersion": 1,
  "id": "ev_20251030T164512_ab12cd34",
  "createdAt": "2025-10-30T08:45:12.000Z",
  "updatedAt": "2025-10-30T08:45:12.000Z",
  "revision": 1,
  "diaryHash": "sha256(diary)",
  "embedding": { "model": "text-embedding-v4", "dimensions": 1024, "textHash": "...", "updatedAt": "..." },
  "diary": "（第一人称连贯叙事，正是 .md 的内容）",
  "structured": {
    "title": "我把插件从 dist 装进了 web profile",
    "startedAt": "2025-10-30T16:45:12+08:00",
    "endedAt": "2025-10-30T17:02:40+08:00",
    "scene": { "cwd": "/home/ubuntu/…", "project": "AutoBioMemory", "channel": "web" },
    "people": [{ "name": "我", "role": "agent" }, { "name": "用户" }],
    "goals": ["把插件装进正在运行的 dsh profile"],
    "actions": [
      { "order": 1, "why": "用户要求从 dist 安装", "what": "在 beta 分支打包并生成本地 tarball",
        "adjustment": "发现 profile 目录不可写，改为…", "result": "bundle 层注册成功" }
    ],
    "statements": [
      { "kind": "fact", "text": "…" },
      { "kind": "plan", "text": "…" },
      { "kind": "completion", "text": "…" },
      { "kind": "inference", "text": "…", "confidence": 0.6 }
    ],
    "emotions": [
      { "who": "用户", "emotion": "不耐烦", "evidence": "“你从dist安装吧”", "basis": "inference" }
    ],
    "outcome": { "status": "partial", "summary": "…", "artifacts": ["dist/…tgz"] },
    "tags": ["插件", "部署"], "keywords": ["dsh plugin add", "bundle"],
    "entities": ["deepseek-harness-autobiomemory"],
    "lessons": ["安装后必须重启 profile 才加载新 bundle 层"],
    "openQuestions": ["重启窗口期由谁负责"],
    "sources": [{ "sessionId": "…", "sessionFile": "/home/ubuntu/.dsh/sessions/…/session.jsonl.zstd",
                  "fromSeq": 120, "toSeq": 210, "recordCount": 91, "contentHash": "…" }]
  }
}
```

`events/<id>.md`：仅 `diary` 正文（短时记忆的数据源，也是 embedding 的文本源）。

## 增量、去重与一致性

1. **游标**：`state/cursor.json` 按会话文件路径记录 `processedRecords`（已并入事件的最后一条记录 seq）。
   编码失败时**不前进**，下一轮从同一位置重试。
2. **去重**：`state/spans.json` 记录每个会话文件已编码片段的 `contentHash`；同哈希片段不再重复编码。
   若事件 ID 已存在且来源哈希相同，也直接跳过。
3. **配对一致性**：先写 JSON 再写 MD；MD 内容必须等于 JSON 的 `diary`，`diaryHash` 必须匹配；
   不匹配由 `repairPairs()` 重建，无法修复的移入 `events/_quarantine/`。
4. **向量随正文更新**：向量行保存 `text_hash`；日记被改写后 `text_hash ≠ diaryHash`，
   下一轮整理会自动重新 embedding（`staleEventIds`）。
5. **失败续处理**：`state/status.json` 记录 `consolidate`/`embed`/`store` 三类失败，指数退避
   （30s 起，上限 30min），到点自动重试；`consolidate --force` 可跳过退避。

## 首版边界

- 只有短时记忆（最近 N 条事件日记常驻提示词）与长时记忆（结构化 + 向量 + rerank）两档；
  不做遗忘曲线、不做多 agent 共享记忆、不做事件之间的因果图谱。
- 多模态（图片/语音）暂不进入日记正文，只作为工具结果文本的一部分。
- 向量检索是内存内暴力 cosine（事件规模在数万条以内足够）；超过后可换 `vec0`/HNSW。
