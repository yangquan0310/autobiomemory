# AutoBioMemory

> 给 DeepSeek Harness 的 agent 一份**自传体记忆**：它以我自己的行动为线索，把经历写成第一人称事件日记，
> 让我在之后需要时按需回忆。

```
经历 → 事件编码 → 记忆存储 → 按需回忆
```

- **事件编码**：DeepSeek 把一段相对完整的原始会话整理成一个事件：我为什么行动、实际做了什么、过程中怎么调整、
  对方如何回应、最终结果如何；保留时间、场景、人物与有依据的情绪；明确区分事实 / 推断 / 计划 / 完成状态。
- **记忆存储**：同一事件 ID 落两份文件 —— `events/<id>.json`（结构化事件 + 来源引用）与 `events/<id>.md`（仅日记正文）。
- **短时记忆**：最近若干事件日记进入系统提示词，让"刚刚发生过什么"始终在场。
- **长时记忆**：DashScope（北京区）对日记正文生成 embedding，向量存入本地 SQLite（`vectors/index.sqlite`），
  连同事件 ID、模型、维度、文本哈希一起，构成长时检索索引。
- **按需回忆**：结构化条件筛选 → 向量召回 → DashScope reranking → 返回相关日记正文与来源（原始会话文件 + 记录区间）。

一切数据都在 `~/.autobiomemory/`：`config.json`、`.env`、`events/`、`vectors/`、`state/`。

## 安装

```bash
# 1) 从 dist 安装（本仓库的打包产物）
dsh plugin --profile web add "file:$PWD/dist/deepseek-harness-autobiomemory-0.1.0.tgz"

# 2) 重启 profile 进程（dsh web），bundle 层才会加载

# 3) 初始化数据根目录（会从 ~/.dsh/.env 导入密钥）
autobiomemory init

# 4) 自检：数据目录 / 密钥 / 两个 API / 向量库 / 配对
autobiomemory doctor

# 5) 第一次整理
autobiomemory consolidate --force
autobiomemory recall "我来这里之后做了哪些事"
```

## 已验证（本机实测）

数据根 `/home/ubuntu/.autobiomemory`，插件从 `dist/` 装入 `web` profile：

- `doctor` 13 项全绿：DeepSeek `HTTP 200`、`text-embedding-v4` 1024d、`gte-rerank-v2`
- `consolidate --force` 从真实会话（4230 条记录 / 2.4MB）写出 **6 个事件**，0 失败，6 条向量
- `recall "我为什么中断了那三个子代理？"` 四段流水线全命中（短时 6 / 结构化 6 / 向量 6 / rerank 6），
  rerank 把《我写文档、锁依赖版本，并中断停滞的子代理》排在第一位（0.46，其余 ≤0.20）
- `plugin --profile web add` 后 `--dump-config` 可见 `deepseek-harness-autobiomemory` 层

## 数据根目录

```
~/.autobiomemory/
  config.json              读取目录、模型、API 地址、整理与检索参数
  .env                     DEEPSEEK_API_KEY / DASHSCOPE_API_KEY
  events/<id>.json         完整事件（structured + diary + sources）
  events/<id>.md           仅日记正文
  vectors/index.sqlite     向量索引（event_id / model / dimensions / text_hash / vector / norm）
  state/cursor.json        每个原始会话文件的处理游标
  state/status.json        运行状态与失败队列
```

`config.json` 覆盖：会话读取目录与包含/排除规则、模型与 API 地址、整理参数（输入预算、单次事件上限、
冷却时间、短时记忆窗口）、检索参数（候选上限、向量 topK、rerank topN、最终条数、回复字符预算）、触发开关。

## 触发机制

| 机制 | 说明 |
| --- | --- |
| `agent/pre-step`（prepend） | 上下文压缩**前**的真正前置位：`compaction-basic` 在自己的 `agent/pre-step` 监听器里判断是否压缩，我们抢在它之前整理 |
| `session/event: compaction/start` | 兜底触发（耐久标记，压缩开始时必然出现） |
| `autobiomemory_consolidate` 工具 | 显式"记住刚才这件事" |
| `autobiomemory_recall` 工具 | 显式回忆（结构化条件 + 语义检索 + 重排） |
| `autobiomemory consolidate` | 命令行/脚本触发，支持 `--force`、`--dry-run` |

整理是**增量**的：按 `state/cursor.json` 记录的游标原地读取原始会话文件，只编码新增片段；原始会话永远留在源目录。
已编码片段按内容哈希去重；失败会进入 `state/status.json` 的失败队列并指数退避重试；游标只在事件配对（及向量）落盘后才前进。

## 文档

- `docs/architecture.md` — 架构、数据流、模块职责、事件编码的字段语义
- `docs/encoding-guide.md` — 事件编码指导语（送进 DeepSeek 的完整说明）
- `docs/operations.md` — 日常运维：配置项、命令、故障排查、调优
- `docs/development.md` — 开发：分支模型、测试、打包与安装
- `docs/module-contracts.md` — 模块级签名契约
- `AGENTS.md` — 给 agent 的操作手册

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run pack:dist
```

分支：`main`（契约）/ `feat/*`（并行功能）/ `alpha`（集成）/ `beta`（打包 → `dist/`）。

## License

MIT
