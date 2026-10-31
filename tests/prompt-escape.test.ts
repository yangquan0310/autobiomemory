/**
 * Regression tests for the `{{…}}` prompt-interpolation bug.
 *
 * dsh's system-prompt service treats a section's text as a template: every `{{name}}` group is
 * interpolated and an unregistered name aborts the whole prompt assembly with
 * `unknown prompt variable "{{variable}}" in section "autobiomemory:short-term"`. Diary bodies are
 * DeepSeek transcripts, so a diary that *talks about* prompt variables (or about Go/Handlebars
 * templates) used to break every prompt assembly in that profile.
 *
 * The fix is a single escape at the memory → prompt boundary (`escapePromptBraces`), so these tests
 * pin three things: the section text can never be read as a variable reference, the real
 * `renderPrompt` survives it, and everything that is not a brace pair is byte-identical.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'

import { SCHEMA_VERSION } from '../src/constants.js'
import { apply, escapePromptBraces } from '../src/plugin.js'
import { shortTermMemory } from '../src/store.js'
import type { MemoryPaths } from '../src/types.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ZWSP = '\u200b'

/** The interpolator's own recogniser: a complete, simple `{{name}}` group. */
const VARIABLE_GROUP = /\{\{[^{}]*\}\}/u

const roots: string[] = []

function makePaths(): MemoryPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autobiomemory-prompt-'))
  roots.push(root)
  const eventsDir = path.join(root, 'events')
  const stateDir = path.join(root, 'state')
  fs.mkdirSync(eventsDir, { recursive: true })
  fs.mkdirSync(stateDir, { recursive: true })
  return {
    root,
    configFile: path.join(root, 'config.json'),
    envFile: path.join(root, '.env'),
    eventsDir,
    vectorsDir: path.join(root, 'vectors'),
    stateDir,
    logsDir: path.join(root, 'logs'),
    cursorFile: path.join(stateDir, 'cursor.json'),
    runStateFile: path.join(stateDir, 'status.json'),
    eventIndexFile: path.join(stateDir, 'events-index.json'),
    vectorDb: path.join(root, 'vectors', 'index.sqlite'),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** A diary that would break prompt assembly: it *quotes* prompt variables literally. */
const BRACED_DIARY = [
  '用户问 dsh 的提示词为什么装配失败。我把 error 里的 {{variable}} 抄了下来，',
  '并解释 {{model}} 和 {{cwd}} 是已注册的变量，而 {{variable}} 没有注册。',
  '我还顺便提到了 {{{triple}}} 和 {{ key }} 这种写法。',
  '不含大括号的这句必须逐字保留：结论是装配器会把日记当模板。',
].join('\n')

const BRACED_TITLE = '排障：{{model}} 装配失败'

/**
 * Write one event pair straight to disk, as the encoder would: JSON holds the record, MD holds
 * exactly the diary body plus one trailing newline.
 */
function writeBracedEvent(paths: MemoryPaths): { id: string; json: string; md: string } {
  const id = 'ev_20251031T120000_abcd1234'
  const diaryHash = sha256(BRACED_DIARY)
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id,
    createdAt: '2025-10-31T04:00:00.000Z',
    updatedAt: '2025-10-31T04:00:00.000Z',
    structured: {
      title: BRACED_TITLE,
      startedAt: '2025-10-31T12:00:00+08:00',
      endedAt: '2025-10-31T12:10:00+08:00',
      scene: { cwd: '/work/autobiomemory' },
      people: [{ name: '用户' }],
      goals: ['让 dsh 装配提示词不报错'],
      actions: [{ order: 1, why: '想知道根因', what: '读了 dsh-system-prompt 的插值器' }],
      statements: [{ kind: 'fact', text: '{{variable}} 未注册就会抛错' }],
      emotions: [],
      outcome: { status: 'completed', summary: '定位到插值器' },
      tags: ['排障'],
      keywords: ['prompt', 'template'],
      entities: ['plugin.ts'],
      lessons: [],
      openQuestions: [],
      sources: [],
    },
    diary: BRACED_DIARY,
    diaryHash,
    revision: 1,
  }
  const jsonFile = path.join(paths.eventsDir, `${id}.json`)
  const mdFile = path.join(paths.eventsDir, `${id}.md`)
  const json = `${JSON.stringify(record, null, 2)}\n`
  const md = `${BRACED_DIARY}\n`
  fs.writeFileSync(jsonFile, json, 'utf8')
  fs.writeFileSync(mdFile, md, 'utf8')
  return { id, json, md }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface CapturedSection {
  name: string
  order: number
  text: () => string
}

interface Harness {
  sections: CapturedSection[]
  tools: Array<{ name: string; description?: string }>
  section: () => CapturedSection
}

/** Load the plugin against a fake cordis surface and capture what it registers. */
function mount(root: string): Harness {
  const sections: CapturedSection[] = []
  const tools: Array<{ name: string; description?: string }> = []
  const ctx = {
    logger: () => () => {},
    get: () => undefined,
    on: () => {},
    effect: () => {},
    tools: {
      register: (tool: { name: string; description?: string }) => {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section: (section: CapturedSection) => {
        sections.push(section)
        return () => {}
      },
    },
  }
  apply(ctx as never, { dataRoot: root })
  return {
    sections,
    tools,
    section: () => {
      const found = sections.find((entry) => entry.name === 'autobiomemory:short-term')
      if (found === undefined) throw new Error('prompt section not registered')
      return found
    },
  }
}

/** The real deployment's variables, so a leaked `{{model}}` would substitute instead of throw. */
const VARIABLES: Record<string, string> = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  cwd: '/work/autobiomemory',
}

function assemble(section: CapturedSection): string {
  return renderPrompt({
    sections: [{ name: section.name, text: section.text() }],
    contexts: [],
    tools: [],
    variables: VARIABLES,
  } as never)
}

/* ------------------------------------------------------------------ *
 * escapePromptBraces — pure function
 * ------------------------------------------------------------------ */

describe('escapePromptBraces', () => {
  it('separates doubled braces with a zero-width space', () => {
    expect(escapePromptBraces('{{variable}}')).toBe(`{${ZWSP}{variable}${ZWSP}}`)
    expect(escapePromptBraces('a {{model}} b {{cwd}}')).toBe(
      `a {${ZWSP}{model}${ZWSP}} b {${ZWSP}{cwd}${ZWSP}}`,
    )
  })

  it('leaves single braces and brace-free text untouched', () => {
    const plain = '没有大括号的句子：结论是装配器会把日记当模板。'
    expect(escapePromptBraces(plain)).toBe(plain)
    expect(escapePromptBraces('{ "json": true }')).toBe('{ "json": true }')
    expect(escapePromptBraces('')).toBe('')
  })

  it('never leaves a recognisable {{…}} group behind', () => {
    const inputs = [
      '{{a}}',
      '{{{triple}}}',
      '{{{{quad}}}}',
      'a }} b',
      '{{}}',
      '{{ key }}',
      `${'{{'.repeat(20)}x${'}}'.repeat(20)}`,
      '}}}}}}',
    ]
    for (const input of inputs) {
      const output = escapePromptBraces(input)
      expect(output, input).not.toContain('{{')
      expect(output, input).not.toContain('}}')
      expect(VARIABLE_GROUP.test(output), input).toBe(false)
    }
  })

  it('is idempotent', () => {
    for (const input of ['{{variable}}', '{{{a}}}', 'a }} b', 'no braces']) {
      const once = escapePromptBraces(input)
      expect(escapePromptBraces(once), input).toBe(once)
      expect(escapePromptBraces(escapePromptBraces(once)), input).toBe(once)
    }
  })

  it('only inserts zero-width spaces: removing them restores the input verbatim', () => {
    const inputs = [BRACED_DIARY, BRACED_TITLE, '{{{a}}}', 'a }} b {{ c']
    for (const input of inputs) {
      const output = escapePromptBraces(input)
      expect(output.replaceAll(ZWSP, '')).toBe(input)
      // every ZWSP sits strictly between two braces
      expect(/[^{}]\u200b|\u200b[^{}]/u.test(output), input).toBe(false)
    }
  })
})

/* ------------------------------------------------------------------ *
 * prompt section — the end-to-end regression
 * ------------------------------------------------------------------ */

describe('autobiomemory:short-term with a braced diary', () => {
  it('renders a section dsh can interpolate, and keeps the diary byte-identical on disk', () => {
    const paths = makePaths()
    const files = writeBracedEvent(paths)
    const harness = mount(paths.root)

    const section = harness.section()
    expect(section.order).toBe(191)

    const text = section.text()

    // (a) nothing the interpolator can recognise as a variable reference
    expect(text).not.toContain('{{')
    expect(text).not.toContain('}}')
    expect(VARIABLE_GROUP.test(text)).toBe(false)

    // (b) the real assembly path succeeds — including the unregistered {{variable}}
    expect(() => assemble(section)).not.toThrow()

    // and it really contains the memory, just with the braces defused
    expect(text).toContain('## 自传体记忆（AutoBioMemory · 短时记忆）')
    expect(text).toContain('不含大括号的这句必须逐字保留：结论是装配器会把日记当模板。')
    expect(text.replaceAll(ZWSP, '')).toContain(BRACED_DIARY)

    // (c) non-brace content is verbatim: stripping the inserted ZWSP gives the raw digest back
    const memory = shortTermMemory(paths, 20)
    expect(memory.summaries).toHaveLength(1)
    expect(text.replaceAll(ZWSP, '')).toContain(memory.text)
    // the title is escaped too
    expect(text.replaceAll(ZWSP, '')).toContain(BRACED_TITLE)

    // stored memory was NOT rewritten: same bytes, same hash, no ZWSP on disk
    expect(fs.readFileSync(path.join(paths.eventsDir, `${files.id}.json`), 'utf8')).toBe(files.json)
    expect(fs.readFileSync(path.join(paths.eventsDir, `${files.id}.md`), 'utf8')).toBe(files.md)
    const stored = JSON.parse(files.json) as { diary: string; diaryHash: string }
    expect(stored.diary).toBe(BRACED_DIARY)
    expect(stored.diaryHash).toBe(sha256(BRACED_DIARY))
    expect(files.md).not.toContain(ZWSP)
    expect(files.json).not.toContain(ZWSP)
  })

  it('does not let registered variables substitute inside the diary', () => {
    const paths = makePaths()
    writeBracedEvent(paths)
    const prompt = assemble(mount(paths.root).section())
    // {{model}}/{{cwd}} would interpolate to these values if the escape were missing
    expect(prompt).not.toContain(VARIABLES.model)
    expect(prompt).not.toContain(VARIABLES.cwd)
    expect(prompt).toContain(`{${ZWSP}{model}${ZWSP}}`)
  })

  it('renders the empty-memory section without braces', () => {
    const paths = makePaths()
    const harness = mount(paths.root)
    const text = harness.section().text()
    expect(text).toContain('## 自传体记忆（AutoBioMemory）')
    expect(VARIABLE_GROUP.test(text)).toBe(false)
    expect(() => assemble(harness.section())).not.toThrow()
  })

  it('keeps every registered tool description free of bare {{', () => {
    const paths = makePaths()
    const harness = mount(paths.root)
    expect(harness.tools.length).toBeGreaterThanOrEqual(2)
    for (const tool of harness.tools) {
      expect(tool.description ?? '').not.toContain('{{')
    }
  })
})
