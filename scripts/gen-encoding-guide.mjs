#!/usr/bin/env node
/**
 * Generate `docs/encoding-guide.md` from the shipped 事件编码指导语.
 *
 *   node scripts/gen-encoding-guide.mjs
 *
 * Keeps the human-readable guide in lockstep with `src/prompt.ts` (reads the built
 * `dist/index.js`, so run `pnpm run build` first).
 */

import fs from 'node:fs'

const { ENCODING_GUIDE, RESPONSE_CONTRACT } = await import('../dist/index.js')

const doc = `# 事件编码指导语（encoding guide）

> 本文件由 \`src/prompt.ts\` 的 \`ENCODING_GUIDE\` / \`RESPONSE_CONTRACT\` 生成，是送进 DeepSeek 的原始指令的人读版本。
> 改代码后重跑：\`pnpm run build && node scripts/gen-encoding-guide.mjs\`。

## 它在流水线中的位置

\`\`\`
原始会话片段（units：从一次用户交付到下一个人接手之间）
   ↓  system = ENCODING_GUIDE + RESPONSE_CONTRACT
   ↓  user   = 时间范围 + 场景 + renderUnitRecords(片段)
DeepSeek
   ↓  顶层只有两个键：{ structured, diary }
事件 JSON（structured + diary 正文）→ events/<id>.json
                                    → events/<id>.md（仅 diary）
\`\`\`

## 指导语原文

\`\`\`text
${ENCODING_GUIDE}
\`\`\`

## 响应契约原文

\`\`\`text
${RESPONSE_CONTRACT}
\`\`\`

## 字段语义速查

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| \`title\` | 一句话标题 | 第一人称；缺失时用日记首句兜底 |
| \`startedAt\` / \`endedAt\` | 事件起止 | 北京时间带 +08:00；不可解析时用片段边界补 |
| \`scene\` | cwd / project / place / channel / localTime | 只写能确定的 |
| \`people[]\` | 真实出现过的人 | 角色：我 / 用户 / 第三方 |
| \`goals[]\` | 这一段想达成什么 | — |
| \`actions[]\` | 动机 → 行动 → 调整 → 结果 | \`why\`/\`adjustment\`/\`result\` 可省略；\`what\` 必填 |
| \`statements[]\` | 四态陈述 | \`kind\` ∈ fact / inference / plan / completion；inference 带 \`confidence\` |
| \`emotions[]\` | 有依据的情绪 | 必须有 \`evidence\` 与 \`basis\`(fact/inference) |
| \`outcome\` | 结果 | \`status\` ∈ completed / partial / failed / ongoing / planned |
| \`tags\` / \`keywords\` / \`entities\` | 检索面 | 供结构化筛选与重排 |
| \`lessons\` / \`openQuestions\` | 教训与未解问题 | 可选 |
| \`sources[]\` | 来源引用 | **由代码强制写入**，模型给的会被覆盖 |
| \`diary\` | 日记正文 | 连贯第一人称叙事；MD 文件内容即它 |

## 编码器不做什么

- 不编造片段里没有的信息（缺就留空数组）
- 不把计划写成完成、不把推断写成事实
- 不复述工具日志，只转述"我看到了什么、据此判断了什么"
- 不为叙事生动添加情绪
`

fs.writeFileSync(new URL('../docs/encoding-guide.md', import.meta.url), doc)
console.log(`docs/encoding-guide.md written (${doc.length} chars)`)
