# 运维手册

本文覆盖日常使用、配置、故障排查与调优。开发相关见 `development.md`，架构见 `architecture.md`。

## 1. 安装与初始化

```bash
# A) 从 GitHub 装（推荐；包内已含预构建 dist/，无需编译）
dsh plugin --profile web add "git+https://github.com/yangquan0310/autobiomemory.git#main"

# B) 从本地产物装（离线 / 私有仓库；先 pnpm run build && pnpm run pack:dist）
dsh plugin --profile web add "file:/abs/path/to/autobiomemory/dist/deepseek-harness-autobiomemory-0.1.1.tgz"

# 初始化数据根目录（会自动从 ~/.dsh/.env 导入 DeepSeek / DashScope 密钥）
autobiomemory init
# 或未加 bin 时：
node dist/cli.js init

# 自检
autobiomemory doctor
```

`dsh plugin add` 会把包装进 profile 依赖并**自动**追加到 `dsh.profile.bundles`；
装完必须重启 profile 进程（`dsh web`）才加载新 bundle 层。
私有仓库的 git 安装需要 GitHub 凭据（PAT / credential helper）。

注意：**不要**指望 `prepare` 钩子在安装时编译——pnpm 10 默认拒绝执行 git 依赖的构建脚本
（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，需在安装方 `pnpm-workspace.yaml` 的
`onlyBuiltDependencies` 里白名单）。所以本仓库把 4 个运行时产物（`dist/index.js`、
`dist/index.d.ts`、`dist/cli.js`、`dist/cli.d.ts`）提交进 git，sourcemap 与 tgz 仍忽略。

`init` 之后的数据根目录：

```
~/.autobiomemory/
  config.json
  .env                      (0600)
  events/  vectors/  state/  logs/
```

安装完 bundle 层后需要**重启 profile 进程**才会加载（`dsh web`）。

## 2. 配置

`~/.autobiomemory/config.json`，可用 `autobiomemory config --set key=value` 修改（点号路径）：

```bash
autobiomemory config --set deepseek.model=deepseek-reasoner
autobiomemory config --set session.readDirs='["~/.dsh/sessions","/data/sessions"]'
autobiomemory config --set retrieval.finalLimit=8
autobiomemory config            # 打印当前有效配置
```

关键项：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `session.readDirs` | `["~/.dsh/sessions"]` | 原始会话读取目录（原地读，绝不移动） |
| `session.includeGlobs` | `["**/session*.jsonl.zstd","**/session*.jsonl"]` | 认为哪些文件是会话 |
| `session.maxRecordsPerEvent` | `200` | 单个事件最多吸收多少条原始记录 |
| `session.tailRecords` | `6` | 尾部保留多少条留到下一轮（避免编码半截对话） |
| `consolidation.maxInputChars` | `60000` | 单次编码的输入字符预算 |
| `consolidation.maxEventsPerRun` | `12` | 单轮整理最多产出多少事件（控成本） |
| `consolidation.recentEventLimit` | `20` | 短时记忆窗口（多少条最近日记常驻提示词） |
| `consolidation.cooldownMs` | `60000` | 自动整理冷却时间 |
| `consolidation.serialize` | `true` | 同一进程内是否串行（false 时允许并发，靠片段去重兜底） |
| `consolidation.maxSpanAttempts` | `3` | 同一片段连续失败多少次后放弃并跳过（防止毒片段卡死会话） |
| `trigger.globalCooldownMs` | `120000` | 全局触发冷却；与 `consolidation.cooldownMs` 取**较大值** |
| `trigger.onCompaction` | `true` | 是否注册 `agent/pre-step` 前置触发 |
| `trigger.onTurnEnd` | `false` | 回合结束（agent 空闲）时是否补整理 |
| `trigger.onSessionStart` | `false` | 新会话出现时是否补整理 |
| `deepseek.model` | `deepseek-chat` | 编码模型 |
| `deepseek.baseUrl` | `https://api.deepseek.com` | API 地址 |
| `deepseek.jsonMode` | `true` | 用 JSON 模式约束响应 |
| `dashscope.baseUrl` | `https://dashscope.aliyuncs.com` | 北京区 |
| `dashscope.embeddingModel` | `text-embedding-v4` | 日记正文的 embedding 模型 |
| `dashscope.embeddingDimensions` | `1024` | 向量维度（与索引维度必须一致） |
| `dashscope.rerankModel` | `gte-rerank-v2` | 重排模型 |
| `retrieval.candidateLimit` | `200` | 结构化筛选候选上限 |
| `retrieval.vectorTopK` | `30` | 向量召回条数 |
| `retrieval.rerankTopN` | `8` | 重排保留条数 |
| `retrieval.finalLimit` | `5` | 最终交付条数 |
| `retrieval.maxReplyChars` | `6000` | 回复字符预算 |
| `trigger.onCompaction` | `true` | 压缩前自动整理 |

密钥永远放在 `.env`，不进 `config.json`：

```
DEEPSEEK_API_KEY=sk-...
DASHSCOPE_API_KEY=sk-...
```

## 3. 命令

```bash
autobiomemory status                    # 事件数、向量数、游标、失败队列
autobiomemory consolidate --force       # 立刻整理一轮（跳过冷却）
autobiomemory consolidate --dry-run     # 只报告会写什么，不落盘
autobiomemory consolidate --session /path/to/session.v4.jsonl.zstd
autobiomemory consolidate --retry-skipped           # 重试"已放弃片段"（会回卷游标）
autobiomemory recall "上次部署是怎么做的" --since 2025-10-01 --status completed
autobiomemory recall "…" --json         # 机器可读
autobiomemory short-term --limit 5      # 打印短时记忆摘要
autobiomemory embed --stale             # 只回填失效向量
autobiomemory embed --force             # 全量重建向量
autobiomemory repair --dry-run          # 检查 JSON/MD 配对
autobiomemory repair                    # 修复缺失/失效的配对
autobiomemory doctor                    # 全链路自检
```

`doctor` 检查项：数据目录、`config.json`、`.env`、配置校验、两个密钥（掩码显示）、会话目录、
DeepSeek 连通性、DashScope embedding/rerank、向量索引、JSON/MD 配对、游标对齐。

## 4. 运行机制速览

- **整理（写）**：`agent/pre-step`（prepend）在每次模型请求前触发；`compaction/start` 兜底；
  也可由 `autobiomemory_consolidate` 工具或 CLI 触发。
- **回忆（读）**：`autobiomemory_recall` 工具；系统提示词里常驻短时记忆摘要。
- **增量**：`state/cursor.json` 记录每个会话文件已处理的最后一条记录。
- **去重**：`state/spans.json` 记录已编码片段的哈希。
- **失败续处理**：`state/status.json` 记录失败并指数退避（30s → 30min），到期自动重试。

## 5. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `doctor` 报缺少密钥 | `.env` 里没有对应键 | `autobiomemory init` 重新导入，或手写 `.env` |
| 整理后 `events/` 没新文件 | 已经有事件覆盖了这些片段（去重），或尾部记录被保留 | `status` 看游标；`consolidate --dry-run` 看会写什么 |
| 编码一直失败 | DeepSeek 401/超时 | 查 `.env`；`doctor` 看连通性；失败会退避重试 |
| 向量数少于事件数 | embedding 失败（配额/网络） | `autobiomemory embed --stale`（或 `--force` 全量） |
| 召回结果为空 | 事件太少或向量未建 | `status` 确认向量数；`short-term` 看是否有日记 |
| 配对异常 `missing-md` | JSON 写了 MD 没写（中断） | `autobiomemory repair` |
| 日记与向量不一致 | 日记被改写但向量未刷新 | 下一轮整理会自动重建；也可 `embed --force` |
| 某会话一直整理不动 | 某片段反复编码失败（毒片段） | 0.1.1 起会自动放弃并跳过（`maxSpanAttempts`）；`status` 看「已放弃片段」，`consolidate --retry-skipped` 重试 |
| 插件没生效 | bundle 层未加载 | 重启 profile；`dsh --profile web --dump-config \| grep autobiomemory` |
| 工具名冲突 | 其他插件也注册同名工具 | `config --set` 改 `toolName`/`consolidateToolName` |

## 6. 调优

- **成本**：降 `consolidation.maxEventsPerRun`（每轮事件数）与 `maxInputChars`（单次输入预算）；
  提高 `cooldownMs` 减少自动触发频率。
- **召回质量**：提高 `retrieval.candidateLimit`/`vectorTopK`/`rerankTopN` 增加候选；
  关掉 rerank（`dashscope.rerankEnabled=false`）可省一次调用但排序变差。
- **上下文占用**：`shortTermPromptChars`（插件配置）与 `consolidation.recentEventLimit` 控制常驻提示词大小；
  设为 0/关掉 `shortTermInPrompt` 就只在工具调用时看记忆。
- **大规模**：事件数超过数万后，向量检索（内存内 cosine）会变慢；可提高 `candidateLimit` 的筛选比重，
  或改用外部向量库（`retrieval.ts` 的 `VectorSource` 是唯一替换点）。

## 7. 备份与迁移

只需备份 `~/.autobiomemory/`（`events/` 是唯一不可再生的产物；`vectors/` 可重建；
`state/` 丢失会导致重复编码但不会丢数据）。迁移到新机器后：

```bash
autobiomemory doctor     # 确认路径与密钥
autobiomemory embed --force   # 重建向量（若换了 embedding 模型/维度，必须重建）
```
