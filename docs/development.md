# 开发文档

## 环境

- Node ≥ 22.19（本机 24.19）；`node:sqlite` 与 `node:zlib` 的 zstd 支持都在这个版本里可用
- pnpm 10
- 无需任何原生编译依赖（SQLite 走内置模块）

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit（strict + noUncheckedIndexedAccess）
pnpm run test        # vitest run，全离线
pnpm run build       # tsup → dist/index.js + dist/cli.js（+ .d.ts）
pnpm run pack:dist   # dist/package/ 与 dist/*.tgz
```

## 分支模型

| 分支 | 角色 |
| --- | --- |
| `main` | 共享契约与已验收成果（`types.ts`/`constants.ts`/`util.ts`/`logger.ts`/`docs/module-contracts.md`） |
| `feat/*` | 一个功能一个分支，独立 worktree 并行开发 |
| `alpha` | 集成分支：合并所有 `feat/*`，解决冲突，跑全量测试 |
| `beta` | 打包分支：`pnpm run check && pnpm run build && pnpm run pack:dist`，产物进 `dist/` |

并行开发用 worktree，避免互相踩文件：

```bash
git worktree add ../wt/core feat/core
ln -s ../../AutoBioMemory/node_modules ../wt/core/node_modules
```

分支划分（首版）：

```
feat/core     paths / env / config / state
feat/session  session-reader（zstd 多帧）/ units
feat/encode   prompt（编码指导语）/ deepseek / distill
feat/vector   vectors（node:sqlite）/ embed（DashScope）
feat/store    store（JSON/MD 配对、索引、短时记忆、修复）
feat/recall   retrieval（筛选 → 向量 → rerank）
feat/plugin   consolidate / plugin（dsh 集成）/ cli / 打包 / 文档
```

## 模块边界

- 所有模块只依赖 `types.ts` + `constants.ts` + `util.ts` + `logger.ts`，**除 `src/plugin.ts` 外不得 import `@deepseek-ai/*`**。
  这样 CLI 与测试可以在裸 Node 里跑，也保证了下游模块可被单独替换。
- 三个注入点：`Distiller`（编码）、`Embedder`（向量）、`Reranker`（重排）。测试全部用假实现注入，不打真网。
- `retrieval.ts` 不 import `store.ts`/`vectors.ts`：事件摘要、记录读取、向量行都通过 `RecallDeps` 注入。

## 测试策略

| 层 | 做法 |
| --- | --- |
| 纯函数 | `util`/`config`/`state`/`units` 直接单测 |
| 二进制 | `session-reader` 用 `zlib.zstdCompressSync` 手工拼多帧（含撕裂尾帧），并对本机真实会话做整文件解码断言（`consumedBytes === fileSize`） |
| 网络 | `deepseek`/`embed` 用本地 `node:http` 假服务：重试、4xx 不重试、超时、abort、批量顺序、维度校验 |
| 存储 | `store`/`vectors` 用 `fs.mkdtempSync` 临时目录；SQLite 关闭再打开验证持久化 |
| 集成 | `consolidate` 用假 distiller/embedder 跑完整写路径：配对、游标、去重、失败续处理、向量回填、配对修复 |
| 打包面 | `plugin-shape` 断言 cordis 插件契约导出（name/inject/Config/apply/default）|

跑单个文件：`npx vitest run tests/consolidate.test.ts`

## 调试

```bash
# 只看会写什么
node dist/cli.js consolidate --dry-run --verbose

# 当前状态
node dist/cli.js status --json

# 直接问记忆
node dist/cli.js recall "上次安装插件是怎么做的" --json
```

会话读取出问题时，先确认解码器：`decodeZstdFrames` 对任何 `session.jsonl.zstd` 都应
`consumedBytes === file.size`。若小于，说明尾部是正在写入的半帧（正常），若为 0 则是帧头解析错误。

## 加一个新模块

1. 从 `main` 拉 `feat/<name>`，在 worktree 里开发；
2. 在 `main` 的 `types.ts` 追加类型（只能加可选字段，不改既有字段语义）；
3. 实现 + 单测（离线），`npx tsc --noEmit && npx vitest run` 通过后提交；
4. 合到 `alpha`，跑全量 `pnpm run check`；
5. `beta` 重新打包并从 `dist/` 安装验证。

## 改动编码约定（`prompt.ts`）

`ENCODING_GUIDE` 是产品的语义契约，改动要同时更新：

- `docs/encoding-guide.md`（人读版本，由 guide 提炼）
- `tests/prompt.test.ts` 的关键短语断言
- 若新增 `structured` 字段：`types.ts`、`normalizeEncodedEvent`、`docs/architecture.md` 的示例、`store` 的索引字段

## 发布检查清单

- [ ] `pnpm run check` 全绿（typecheck + test + build）
- [ ] `node dist/cli.js doctor` 全绿
- [ ] `node dist/cli.js consolidate --force` 产出事件，`status` 向量数 = 事件数
- [ ] `node dist/cli.js recall "<真实问题>"` 能返回相关日记与来源
- [ ] `dsh plugin --profile web add file:dist/*.tgz` 后 `--dump-config` 能看到 `autobiomemory` 层
- [ ] 重启 profile 后工具与提示词生效
