// escalate, through the plugin as loaded: session.start (hooks/register.tsx)
// registers the `nexus:frontier` agent type and the `consult` tool, and the
// escalate module's tool.call hook answers `mcp__nexus__consult`.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpec, ModelCompleteInput, ModelCompleteResult, On, ToolSpec } from 'claude-code'

import { CONSULT_MAX_TOKENS, CONSULT_TIMEOUT_MS } from './register'
import { CONSULT_TOOL, FRONTIER_DESCRIPTION, FRONTIER_PROMPT, advisorPrompt, briefOf, consultDescription } from './prompts'
import { frontierModel } from '../router/classify'
import { LOG_KEY } from '../router/log'
import { USAGE_KEY } from '../router/report'
import type { RouteLogEntry, UsageRecord } from '../../types'

const OPUS = frontierModel({ profile: 'anthropic' })
const DB_OPUS = frontierModel({ profile: 'databricks' })
const USAGE = { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const advice = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })
const BRIEF = {
  goal: 'Make the parser accept trailing commas (SECRET-GOAL-7)',
  tried: 'Patched the tokenizer; tests still fail (SECRET-TRIED-7)',
  question: 'Is the grammar or the tokenizer the right place? (SECRET-QUESTION-7)',
  context: 'parse error at 3:14 (SECRET-CONTEXT-7)',
}

// The counter is module state, kept across tests in one load: each test gets its own session id.
let sessions = 0

type World = {
  agents: AgentSpec[]
  tools: ToolSpec[]
  completions: ModelCompleteInput[]
  /** The latest value the plugin stored under each key. */
  store: Map<string, unknown>
  session: { id: string }
}

type Bottom = {
  complete?: (e: ModelCompleteInput) => ModelCompleteResult | Promise<ModelCompleteResult>
  rejectRegister?: boolean
  failStore?: boolean
}

/** The engine beneath the plugin: registrations, the model, the store, the clock, the session id. */
function world(on: On, bottom: Bottom = {}): World {
  const w: World = { agents: [], tools: [], completions: [], store: new Map(), session: { id: `S${++sessions}` } }
  mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  on('session.id', async () => ({ value: w.session.id }))
  on('agent.register', async (_$, e) => {
    if (bottom.rejectRegister) return { deny: 'the session is not bound yet' } as never
    w.agents.push(e as AgentSpec)
    return { value: { agent: `nexus:${e.name}` } }
  })
  on('tool.register', async (_$, e) => {
    if (bottom.rejectRegister) return { deny: 'the session is not bound yet' } as never
    w.tools.push(e as ToolSpec)
    return { value: { tool: `mcp__nexus__${e.name}` } }
  })
  on('model.complete', async (_$, e) => {
    w.completions.push(e)
    if (!bottom.complete) return { deny: 'model not allowed' } as never
    return { value: await bottom.complete(e) }
  })
  const clone = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
  on('store.get', async (_$, e) => (bottom.failStore ? ({ deny: 'store down' } as never) : { value: clone(w.store.get(e.key)) }))
  on('store.set', async (_$, e) => {
    if (bottom.failStore) return { deny: 'store down' } as never
    w.store.set(e.key, clone(e.value))
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => (w.store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...w.store.keys()] }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return w
}

const start = ($: Engine) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

type Answer = { result?: unknown; deny?: string; isError?: boolean; text?: string }
let ids = 0
const consult = async ($: Engine, args: Record<string, unknown>): Promise<Answer> =>
  (await $.tool.call({ tool: CONSULT_TOOL, tool_use_id: `toolu_${++ids}`, ...args } as never)) as Answer

const logOf = (w: World) => (w.store.get(LOG_KEY) ?? []) as RouteLogEntry[]
const usageOf = (w: World) => (w.store.get(USAGE_KEY) ?? []) as UsageRecord[]

describe('escalate: session.start registrations', () => {
  test('registers nexus:frontier on the frontier model, effort high, and the consult tool', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.agents).toHaveLength(1)
    const a = w.agents[0]!
    expect(a.name).toBe('frontier')
    expect(a.model).toBe(OPUS)
    expect(a.effort).toBe('high')
    expect(a.description).toBe(FRONTIER_DESCRIPTION)
    expect(a.description).toContain('stuck')
    expect(a.description).toContain('hard-to-reverse')
    expect(a.description).toContain('escalate')
    expect(a.description).toContain('self-contained brief')
    expect(a.prompt).toBe(FRONTIER_PROMPT)
    expect(a.tools).toBeUndefined()
    expect(a.disallowedTools).toEqual(['mcp__nexus__consult'])
    expect(w.tools).toHaveLength(1)
    const t = w.tools[0]!
    expect(t.name).toBe('consult')
    expect(t.isDeferred).toBe(false)
    expect(t.description).toBe(consultDescription(5, true))
    expect(t.description).toContain('at most 5 per session')
    expect(t.description).toContain('a frontier model')
    expect(t.inputSchema).toMatchObject({ type: 'object', required: ['goal', 'tried', 'question'] })
    expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(['goal', 'tried', 'question', 'context'])
  })

  test('the databricks profile puts the agent on the databricks frontier model', { options: { profile: 'databricks' } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.agents[0]!.model).toBe(DB_OPUS)
  })

  test('escalation false: no agent; the tool is registered and does not point at the agent', { options: { escalation: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.agents).toHaveLength(0)
    expect(w.tools).toHaveLength(1)
    expect(w.tools[0]!.description).not.toContain('nexus:frontier')
  })

  test('consultMax 0: no tool, the agent keeps every tool', { options: { consultMax: 0 } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.tools).toHaveLength(0)
    expect(w.agents).toHaveLength(1)
    expect(w.agents[0]!.disallowedTools).toBeUndefined()
  })

  test('consultMax 3 is the cap the description names', { options: { consultMax: 3 } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.tools[0]!.description).toContain('at most 3 per session')
  })

  test('registrations that reject (session not bound) never fail the session start', async ($, on) => {
    const w = world(on, { rejectRegister: true })
    await expect(start($)).resolves.toEqual({ cwd: '/tmp' })
    expect(w.agents).toHaveLength(0)
    expect(w.tools).toHaveLength(0)
  })
})

describe('escalate: consult', () => {
  test('asks the frontier model with the brief at effort high, returns the advice, logs without the brief', async ($, on) => {
    const w = world(on, { complete: () => advice('Assessment: fix the grammar.') })
    await start($)
    const r = await consult($, BRIEF)
    expect(r.deny).toBeUndefined()
    expect(r.isError).toBeUndefined()
    expect(String(r.result)).toContain('Assessment: fix the grammar.')
    expect(String(r.result)).toContain('consult 1 of 5')
    expect(w.completions).toHaveLength(1)
    const req = w.completions[0]!
    expect(req.model).toBe(OPUS)
    expect(req.effort).toBe('high')
    expect(req.timeoutMs).toBe(CONSULT_TIMEOUT_MS)
    expect(req.maxTokens).toBe(CONSULT_MAX_TOKENS)
    expect(req.prompt).toBe(advisorPrompt(briefOf(BRIEF) as never))
    for (const s of ['SECRET-GOAL-7', 'SECRET-TRIED-7', 'SECRET-QUESTION-7', 'SECRET-CONTEXT-7']) expect(req.prompt).toContain(s)
    expect(String(req.system)).toContain('senior software engineer')
    expect(logOf(w)).toEqual([{ at: 1_000, session: w.session.id, loop: 'main', action: 'consulted', to: OPUS }])
    expect(usageOf(w)).toHaveLength(1)
    expect(usageOf(w)[0]).toMatchObject({ session: w.session.id, model: OPUS, input: 300, output: 120, consults: 1 })
    // nothing of the brief is stored anywhere
    expect(JSON.stringify([...w.store.entries()])).not.toMatch(/SECRET/)
  })

  test('context is optional', async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    const { context: _c, ...noContext } = BRIEF
    const r = await consult($, noContext)
    expect(r.deny).toBeUndefined()
    expect(w.completions[0]!.prompt).not.toContain('<context>')
  })

  test('a missing required field is an error result, no model call', async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    const r = await consult($, { goal: 'g', question: 'q' })
    expect(r.deny).toContain('tried')
    expect(w.completions).toHaveLength(0)
  })

  test('the cap: past consultMax a short refusal, no model call, logged as cap', { options: { consultMax: 2 } }, async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    await consult($, BRIEF)
    await consult($, BRIEF)
    const r = await consult($, BRIEF)
    expect(w.completions).toHaveLength(2)
    expect(r.deny).toBeUndefined()
    expect(String(r.result)).toContain('used up')
    expect(logOf(w).map(l => l.reason)).toEqual([undefined, undefined, 'cap'])
    expect(usageOf(w)[0]).toMatchObject({ consults: 2 })
  })

  test('parallel calls cannot pass the cap', { options: { consultMax: 1 } }, async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    const rs = await Promise.all([consult($, BRIEF), consult($, BRIEF), consult($, BRIEF)])
    expect(w.completions).toHaveLength(1)
    expect(rs.filter(r => String(r.result).includes('used up'))).toHaveLength(2)
  })

  test('a new session id (a /clear) starts a fresh count', { options: { consultMax: 1 } }, async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    await consult($, BRIEF)
    expect(String((await consult($, BRIEF)).result)).toContain('used up')
    w.session.id = `${w.session.id}-cleared`
    expect(String((await consult($, BRIEF)).result)).toContain('consult 1 of 1')
    expect(w.completions).toHaveLength(2)
  })

  test('a model request that rejects: an error result, no throw, the slot given back', { options: { consultMax: 1 } }, async ($, on) => {
    const w = world(on)
    await start($)
    const r = await consult($, BRIEF)
    expect(r.deny).toContain('consult failed')
    expect(logOf(w)[0]).toMatchObject({ action: 'consulted', reason: 'refused', to: OPUS })
    expect(usageOf(w)).toHaveLength(0)
    // the slot came back: the next call reaches the model again
    await consult($, BRIEF)
    expect(w.completions).toHaveLength(2)
  })

  test('an API error: an error result naming the status, never a body', async ($, on) => {
    const w = world(on, { complete: () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }) as ModelCompleteResult })
    await start($)
    const r = await consult($, BRIEF)
    expect(r.deny).toContain('529')
    expect(r.deny).toContain('overloaded')
    expect(logOf(w)[0]!.reason).toBe('api-error')
  })

  test('a timeout (aborted): an error result, the slot kept', { options: { consultMax: 1 } }, async ($, on) => {
    const w = world(on, { complete: () => ({ isAnswered: false, reason: 'aborted', usage: ZERO }) as ModelCompleteResult })
    await start($)
    const r = await consult($, BRIEF)
    expect(r.deny).toContain('120s')
    expect(String((await consult($, BRIEF)).result)).toContain('used up')
    expect(w.completions).toHaveLength(1)
  })

  test('decisionLog false: no log entry, usage still recorded', { options: { decisionLog: false } }, async ($, on) => {
    const w = world(on, { complete: () => advice('ok') })
    await start($)
    await consult($, BRIEF)
    expect(logOf(w)).toHaveLength(0)
    expect(usageOf(w)).toHaveLength(1)
  })

  test('a failing store never changes the answer', async ($, on) => {
    const w = world(on, { complete: () => advice('still fine'), failStore: true })
    await start($)
    const r = await consult($, BRIEF)
    expect(String(r.result)).toContain('still fine')
    expect(w.completions).toHaveLength(1)
  })

  test('a long field is cut before it is sent', () => {
    const p = advisorPrompt({ goal: 'g'.repeat(10_000), tried: 't', question: 'q' })
    expect(p.length).toBeLessThan(5_000)
    expect(p).toContain('[... cut at 4000 characters]')
  })
})
