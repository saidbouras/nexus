import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { REMINDER, register } from './register'

const reg = register as unknown as (on: unknown, options: unknown) => unknown

const INPUT = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

const BASE = [
  { id: 'intro', text: 'intro text', scope: 'shared' as const },
  { id: 'other:x', text: 'other plugin section', scope: 'session' as const },
]

// The engine beneath the plugin answers a fixed list of sections.
function engine(on: On) {
  on('prompt.compose', async () => ({ sections: BASE }))
}

describe('orchestrator reminder', () => {
  test('default (on): appends exactly one section at the end and keeps the others', async ($, on) => {
    engine(on)
    const { sections } = await $.prompt.compose(INPUT)
    expect(sections.slice(0, 2)).toEqual(BASE)
    expect(sections).toHaveLength(3)
    const last = sections[2]!
    expect(last.id).toBe('nexus:orchestrator')
    expect(last.text).toBe(REMINDER)
    expect(last.scope).toBe('session')
    expect(REMINDER.split(/\s+/).length).toBeLessThanOrEqual(60)
  })
})

describe('orchestrator reminder (options)', () => {
  test('explicit true', { options: { orchestratorReminder: true } }, async ($, on) => {
    engine(on)
    const { sections } = await $.prompt.compose(INPUT)
    expect(sections).toHaveLength(3)
  })

  test('explicit false adds none', { options: { orchestratorReminder: false } }, async ($, on) => {
    engine(on)
    const { sections } = await $.prompt.compose(INPUT)
    expect(sections).toEqual(BASE)
  })
})

describe('orchestrator reminder (robustness)', () => {
  test('missing or undefined options do not throw and default to on', () => {
    for (const opts of [{}, undefined as never, null as never]) {
      const events: string[] = []
      expect(() => reg((e: string) => void events.push(e), opts)).not.toThrow()
      expect(events).toEqual(['prompt.compose'])
    }
  })

  test('string "false" turns it off without registering a hook', () => {
    const events: string[] = []
    reg((e: string) => void events.push(e), { orchestratorReminder: 'false' })
    expect(events).toEqual([])
  })
})
