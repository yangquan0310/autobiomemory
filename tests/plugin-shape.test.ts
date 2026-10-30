import { describe, expect, it } from 'vitest'

import plugin, { Config, apply, inject, name } from '../src/index.js'
import { ENCODING_GUIDE, RESPONSE_CONTRACT } from '../src/prompt.js'
import { defaultConfig, validateConfig } from '../src/config.js'
import { memoryPaths } from '../src/paths.js'

describe('plugin surface', () => {
  it('exports the cordis plugin contract', () => {
    expect(name).toBe('autobiomemory')
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof apply).toBe('function')
    expect(Config).toBeDefined()
    expect(plugin).toMatchObject({ name: 'autobiomemory' })
    expect(plugin.apply).toBe(apply)
  })

  it('defaults the model-facing tool names', () => {
    const parsed = Config({
      dataRoot: '/tmp/x',
    }) as Record<string, unknown>
    expect(parsed.toolName).toBe('autobiomemory_recall')
    expect(parsed.consolidateToolName).toBe('autobiomemory_consolidate')
    expect(parsed.autoConsolidate).toBe(true)
    expect(parsed.shortTermInPrompt).toBe(true)
  })

  it('guards apply against an unusable data root instead of throwing', () => {
    // a ctx-less call must fail gracefully, never crash the host
    const ctx = {
      logger: () => () => {},
      get: () => undefined,
      on: () => {},
      effect: () => {},
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }
    expect(() => apply(ctx as never, { dataRoot: '/tmp/abm-plugin-shape' })).not.toThrow()
  })
})

describe('shipped guidance', () => {
  it('ships the encoding guide and the response contract', () => {
    expect(ENCODING_GUIDE.length).toBeGreaterThan(1000)
    expect(RESPONSE_CONTRACT).toContain('"structured"')
    expect(RESPONSE_CONTRACT).toContain('"diary"')
  })

  it('ships a valid default config', () => {
    const config = defaultConfig(memoryPaths('/tmp/abm-defaults').root)
    expect(validateConfig(config)).toEqual([])
    expect(config.session.readDirs).toEqual(['~/.dsh/sessions'])
    expect(config.dashscope.region).toBe('beijing')
    expect(config.trigger.toolName).toBe('autobiomemory_recall')
  })
})
