# AGENTS.md — AutoBioMemory

自传体记忆模块（autobiographical memory）for DeepSeek Harness (dsh)。
给在本仓库工作的 agent/开发者的操作手册。读它再动手。

## 这是什么

AutoBioMemory 把 agent 自己的经历变成**第一人称事件日记**，并让 agent 之后能按需回忆：

```
经历（原始会话） → 事件编码（DeepSeek） → 记忆存储（events/*.json + *.md）
                                        → 长时索引（vectors/index.sqlite，DashScope embedding）
                                        → 按需回忆（结构化筛选 → 向量召回 → rerank）
```

- 数据根目录（唯一真相）：`~/.autobiomemory/`
- 插件形态：dsh bundle（`dsh.bundle.patch` → `cordis.patch.yml`），装进 dsh profile 后自动挂载
- 触发点：`agent/pre-step`（prepend，上下文压缩前的真正前置位）+ `session/event: compaction/start`（兜底）
- 工具：`autobiomemory_recall`（回忆）、`autobiomemory_consolidate`（手动整理）

## 目录结构

```
src/
  types.ts           共享类型契约（所有模块都依赖它；改动要协调）
  constants.ts       版本号、目录名、env key、区域 endpoint
  util.ts            哈希、北京时间、原子写、abort、并发池
  logger.ts          分级日志（永不打印密钥）
  paths.ts           数据根目录布局
  env.ts             <root>/.env 读写与密钥优先级
  config.ts          config.json 默认值/合并/校验
  state.ts           cursor.json（处理游标）、status.json（失败队列）
  session-reader.ts  zstd 多帧解码 + dsh 会话事件归一化
  units.ts           把记录切成"相对完整的事件"
  prompt.ts          事件编码指导语 + 响应契约 + 响应解析
  deepseek.ts        DeepSeek chat 客户端（重试/超时/JSON 模式）
  distill.ts         单元 → EncodedEvent（补来源引用）
  store.ts           JSON/MD 配对存储、事件索引、短时记忆、配对修复
  vectors.ts         node:sqlite 本地向量索引（Float32 blob + cosine）
  embed.ts           DashScope（北京）embedding + rerank 客户端
  retrieval.ts       回忆流水线（短时 → 结构化 → 向量 → rerank）
  consolidate.ts     写路径总编排（增量、去重、失败续处理）
  plugin.ts          dsh 集成（工具 + 提示词 + 生命周期触发）
  cli.ts             命令行（init/config/status/consolidate/recall/embed/repair/doctor）
tests/                vitest，全部离线（网络用本地 http server 或注入假实现）
docs/                开发文档
scripts/pack-dist.mjs 打包到 dist/
```

## 硬性约定

- **禁止**为了让测试通过而修改 `src/types.ts` 与 `src/constants.ts` 的既有字段；需要新字段就追加可选字段并同步所有实现。
- 除 `src/plugin.ts` 外，任何模块**不得** import `@deepseek-ai/*`，保证 CLI 与测试能在裸 Node 里跑。
- 不引入原生依赖：SQLite 用 `node:sqlite`，压缩用 `node:zlib`。
- 所有落盘写入走 `util.writeTextFileAtomic`/`writeJsonFile`（原子 + 可重入）。
- 任何生命周期钩子都**不能抛错**到 agent loop；失败只记日志/失败队列。
- **永不**打印或提交密钥；日志里只出现 `maskSecret()` 的结果。
- 时间一律以北京时间（UTC+8）记录到事件里；排序用 ISO。

## 数据根目录

```
~/.autobiomemory/
  config.json          读取目录、模型、API 地址、整理与检索参数
  .env                 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY（0600）
  events/<id>.json     完整事件（structured + diary + 来源引用）
  events/<id>.md       仅日记正文（短时记忆来源、embedding 文本源）
  events/_quarantine/  配对损坏时被隔离的文件
  vectors/index.sqlite 向量索引（event_id, model, dimensions, text_hash, vector, norm）
  state/cursor.json    每个原始会话文件的处理游标
  state/status.json    运行状态与失败队列（指数退避）
  state/spans.json     已编码片段的哈希（增量去重）
  state/events-index.json 事件索引缓存
  logs/                预留
```

原始会话**留在原地**（默认 `~/.dsh/sessions/**/session*.jsonl.zstd`），只增量读取，不移动、不改写。

## 开发流程（分支）

| 分支 | 用途 |
| --- | --- |
| `main` | 共享契约（types/constants/util/logger）与已合并的成果 |
| `feat/<模块>` | 并行开发单个功能模块（worktree 里开发，见下） |
| `alpha` | 集成分支：合并所有 feat，解决冲突 |
| `beta` | 打包分支：构建 + `scripts/pack-dist.mjs` 产出 `dist/` |

```bash
# 并行开发：每个 feat 一个 worktree
git worktree add ../wt/core feat/core

# 集成
git checkout alpha && git merge --no-ff feat/core feat/session ...

# 打包
git checkout beta && pnpm run check && pnpm run build && pnpm run pack:dist

# 从 dist 安装插件（<version> 取 package.json 的 version）
dsh plugin --profile web add "file:$PWD/dist/autobiomemory-<version>.tgz"
```

安装后**必须重启 profile 进程**（`dsh web`）才会加载新的 bundle 层。

## 发布流程（通用六步）

每次发布都按这六步走；`X.Y.Z` 是本次要发布的版本号，**不要**在文档、脚本或提交信息里写死具体版本。

1. **开分支**：从 `main` 切 `fix/<主题>`（缺陷）或 `feat/<模块>`（功能）。
2. **实现 + 回归测试**：修缺陷必须带能复现原问题的测试；本地 `pnpm run typecheck && pnpm run test` 全绿，
   既有测试数不得下降（只允许增加）。**不要**为了让测试变绿去改 `types.ts` / `constants.ts` 的既有语义。
3. **进集成**：合并进 `alpha`，跑全量 `pnpm run check`（typecheck + test + build）。
4. **打包**：合并 `alpha` → `beta`，`pnpm run build && pnpm run pack:dist`；把 `package.json` 的 `version`
   升到 `X.Y.Z`，在 `CHANGELOG.md` 写清根因、修法与影响面（面向使用者，不写内部流水账）。
5. **发布**：打 tag `vX.Y.Z`，推送所有相关分支与 tag，创建 GitHub Release 并把 `dist/*.tgz` 作为资产上传。
6. **从产物验证一次**（唯一可信的验收）：下载 Release 里的 tgz →
   `dsh plugin --profile <临时profile> add "file:<tgz>"` →
   确认 `dsh.profile.bundles` 里出现 `autobiomemory` →
   `--dump-config` 能看到该层。

打包两条硬约束，缺一条 dsh 就装不对：

- 产物 tgz 必须**包含 `cordis.patch.yml`**（`package.json` 的 `files` 里已列出，改动别删）；
- `package.json` 必须带 **`dsh.bundle.patch`** 字段——没有它 dsh 只会把它当普通依赖安装，不会插进 profile 层；
  有它但 patch 文件缺失则报 invalid plugin。

装完必须**重启 profile 进程**才生效，不要在文档或脚本里假设热加载。

## 验证

```bash
pnpm run typecheck     # tsc --noEmit
pnpm run test          # vitest run（全离线）
pnpm run build         # tsup → dist/
pnpm run pack:dist     # dist/package + tgz

node dist/cli.js doctor            # 环境自检（真调 DeepSeek / DashScope）
node dist/cli.js consolidate --force
node dist/cli.js recall "上次部署是怎么做的"
```

## 常见坑

1. **zstd 多帧**：dsh 每次追加写一个独立 zstd 帧。`zlib.zstdDecompressSync(整个文件)` 只解第一帧，必须逐帧解析（见 `session-reader.ts`）。
2. **会话事件是事件流不是消息流**：`assistant/chunk`/`*chunks` 是流式增量，必须跳过；真正的消息在 `user/message`、`assistant/message`、`tool/call`、`tool/result`。
3. **压缩前触发点**：`agent/pre-step` 是 waterfall，用 `{ prepend: true }` 注册才能先于 `compaction-basic` 的监听器执行；`compaction/*` 是**会话事件**，只能用 `ctx.on('session/event')` 观察。
4. **游标语义**：`cursor.processedRecords` 是"已并入事件的最后一条记录 seq"；编码失败时**不得**前进，否则该片段永久丢失。
5. **向量新鲜度**：以 `sha256(diary)` 为准；改写日记必须让向量失效并回填，否则召回会指向过期文本。
6. **配对一致性**：先写 JSON 再写 MD；MD 只放日记正文；hash 不匹配就修，不匹配就隔离。
7. **打包坑（已修）**：esbuild 会把 `node:` 前缀抹掉，`node:sqlite` 变成不可解析的裸模块 `sqlite` ——
   改用 `createRequire(import.meta.url)('node:sqlite')` 运行时解析，且 `tsup` 里不要再加 shebang banner
   （`src/cli.ts` 自带，重复会 SyntaxError）。
8. **dry-run 不许留痕**：`consolidate --dry-run` 不写 run state、不写游标、不写 spans，只报告。
9. **毒片段**：游标"失败不前进"是对的，但必须有 `maxSpanAttempts` 兜底——否则一个永远编码不出的片段会把整个会话卡在退避里。放弃时要**同时**清 spans 记忆并回卷游标，否则 `--retry-skipped` 也救不回来（`retrySkippedSpans()` 已按此实现）。
