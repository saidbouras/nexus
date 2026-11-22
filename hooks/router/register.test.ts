import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteInput, ModelCompleteResult, On, PromptSubmitInput } from 'claude-code'

import { createRouter, decideSwitch, delegationHint, escalateConfigOf, escalationDirective, estimateTokens, isClearPrompt, routerObserve } from './register'
import type { SwitchInput } from './register'
import { readConfig, windowFor } from './classify'
import { LOG_KEY, appended, formatAt, formatEntry, formatLog, parseCount, shortModel } from './log'
import type { RouteLogEntry } from '../../types'

// Databricks-profile models.
const DB_OPUS = 'system.ai.claude-opus-5-5[1m]'
const DB_SONNET = 'system.ai.claude-sonnet-5-5[1m]'
const DB_HAIKU = 'system.ai.claude-haiku-5-5'
const SESSION_MODEL = 'session-model'
// A placeholder workspace: the router ships no organisation's hostname.
const GATEWAY = 'https://example-workspace.cloud.databricks.com/ai-gateway/typesafe/v1/systemone'
const DIRECT = 'https://api.typesafe.ai/v1/systemone'
const TAGS = 'http://localhost:11434/api/tags'
const OLLAMA = 'http://localhost:11434/api/chat'
const API_KEY = 'ts-secret-key-123456'

const DB = { profile: 'databricks', jevUrl: GATEWAY } as const

type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }

const ok = (text: string): Reply => ({ status: 200, ok: true, headers: {}, text })
const fail = (status: number, text = '{"error_code":"PERMISSION_DENIED"}'): Reply => ({ status, ok: false, headers: {}, text })
const ollama = (answer: unknown) => ok(JSON.stringify({ message: { content: JSON.stringify(answer) } }))
// A SystemOne response, shaped as the live gateway answers: the `route`
// answer, and the `difficulty` answer when one is given.
const jev = (choice: string, probabilities: Record<string, number>, difficulty?: Record<string, number>) => {
  const answer = (p: Record<string, number>) => {
    const top = Object.entries(p).sort((a, b) => b[1] - a[1])[0] as [string, number]
    return { type: 'choice', choice: top[0], confidence: top[1], probabilities: p }
  }
  return ok(
    JSON.stringify({
      model: 'jev-1.14.0',
      answers: {
        route: { type: 'choice', choice, confidence: probabilities[choice] ?? 0, probabilities },
        ...(difficulty ? { difficulty: answer(difficulty) } : {}),
      },
      usage: { input_tokens: 455, output_tokens: 74 },
    }),
  )
}
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const haiku = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })
// A haiku reply for one cell, `coding/high`; a category alone has no difficulty (medium).
const says = (cell: string, confidence = 0.9): ModelCompleteResult => {
  const [route, difficulty] = cell.split('/')
  return haiku(JSON.stringify({ route, confidence, ...(difficulty ? { difficulty, difficultyConfidence: confidence } : {}) }))
}

type Sent = { url: string; headers: Record<string, string>; body: unknown }
type Asked = { question: string; labels: string[] }

type Bottom = {
  // What the HTTP layer answers per URL; a thrown error is a failed request. Ollama's
  // tag probe fails (not running) unless the test answers it.
  fetch?: (url: string, n: number) => Reply | Promise<Reply>
  // What `$.model.complete` answers (the haiku step); a thrown error rejects the call.
  complete?: (e: ModelCompleteInput) => ModelCompleteResult | Promise<ModelCompleteResult>
  // What the user picks in the consent dialog; absent, the dialog rejects (headless).
  ask?: (a: Asked) => string | Promise<string>
  env?: Record<string, string>
  // What `$.session` answers; absent, the call has no implementation (it rejects), as
  // an engine that cannot tell would. `messages` is the main conversation in API form,
  // `tokens` the live window's fill.
  session?: { messages?: unknown[]; tokens?: number; model?: string; id?: string }
  // The plugin's `$.store` (mock.store) with these entries; absent, the store rejects.
  store?: Record<string, unknown>
}

// The world beneath the plugin: a clock, HTTP, the token CLI, the session's
// model client, the question dialog, and a model that records which model
// and effort each step was sent with.
function world(on: On, bottom: Bottom) {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, bottom.env ?? {})
  const s = bottom.session
  if (s?.messages) on('session.messages', async () => ({ value: s.messages as never }))
  if (s && 'tokens' in s) on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: s.tokens, window: 200_000 }, rateLimits: [] } }))
  if (s?.model) on('session.model', async () => ({ value: s.model as string }))
  if (s?.id) on('session.id', async () => ({ value: s.id as string }))
  // Each value the plugin stores under a key, in order.
  const stored: { key: string; value: unknown }[] = []
  if (bottom.store) {
    // An in-memory store as mock.store keeps one (JSON values), recording each write.
    const held = new Map<string, unknown>(Object.entries(bottom.store).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
    on('store.get', async (_$, e) => ({ value: held.has(e.key) ? JSON.parse(JSON.stringify(held.get(e.key))) : undefined }))
    on('store.set', async (_$, e) => {
      const value = JSON.parse(JSON.stringify(e.value))
      held.set(e.key, value)
      stored.push({ key: e.key, value })
      return { value: undefined }
    })
    on('store.delete', async (_$, e) => (held.delete(e.key), { value: undefined }))
    on('store.keys', async () => ({ value: [...held.keys()] }))
  }
  const sent: { model: string; effort?: unknown }[] = []
  const urls: string[] = []
  const requests: Sent[] = []
  const completions: ModelCompleteInput[] = []
  const asks: Asked[] = []
  const argvs: string[][] = []
  let tokenRuns = 0
  on('http.fetch', async (_$, e) => {
    urls.push(e.url)
    requests.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ? JSON.parse(e.init.body as string) : undefined })
    // A `{ deny }` rejects the plugin's `$.http.fetch` with that text: a failed request.
    if (!bottom.fetch) return { deny: e.url === TAGS ? 'connection refused' : 'no network in this test' }
    try {
      return { value: await bottom.fetch(e.url, urls.length) }
    } catch (err) {
      return { deny: (err as Error).message }
    }
  })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    if (e.argv[0] === 'printenv') {
      const v = bottom.env?.[e.argv[1] as string]
      return { value: { exitCode: v === undefined ? 1 : 0, stdout: v === undefined ? '' : `${v}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    tokenRuns++
    return {
      value: { exitCode: 0, stdout: JSON.stringify({ access_token: `tok${tokenRuns}` }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('model.complete', async (_$, e) => {
    completions.push(e)
    if (!bottom.complete) return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE } as ModelCompleteResult }
    return { value: await bottom.complete(e) }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]
    const a: Asked = { question: q?.question ?? '', labels: (q?.options ?? []).map(o => o.label) }
    asks.push(a)
    if (!bottom.ask) throw new Error('dismissed')
    const label = await bottom.ask(a)
    return { result: { questions: (e as unknown as { questions: unknown }).questions, answers: { [a.question]: label } } } as never
  })
  const sets: { key: string; value: unknown }[] = []
  on('state.set', async (_$, e, next) => (sets.push({ key: String(e.key), value: e.value }), next(e)))
  const statuses: unknown[] = []
  on('ui.status', async (_$, e) => (statuses.push((e as { text?: unknown }).text), { value: undefined }))
  const registered: { name: string; description: string; argumentHint?: string }[] = []
  on('command.register', async (_$, e) => (registered.push(e as never), { value: { command: e.name } }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  // The prompt as it reached the engine, hidden context included.
  const prompts: PromptSubmitInput[] = []
  on('prompt.submit', async (_$, e) => (prompts.push(e), { text: e.text, ...(e.context ? { context: e.context } : {}) }))
  // What each main-loop step reports as its usage (the context the next decision sees).
  const usage: { context: number | null } = { context: null }
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    const u = usage.context === null ? null : { input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: usage.context - 1_000, cache_creation_input_tokens: 0, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  let agents = 0
  const spawned: string[] = []
  on('agent.spawn', async (_$, e) => {
    spawned.push(e.model ?? SESSION_MODEL)
    return { model: e.model ?? SESSION_MODEL, agentId: `agent${++agents}` }
  })
  return { clock, sent, urls, requests, completions, asks, argvs, statuses, spawned, sets, prompts, usage, stored, registered, tokenRuns: () => tokenRuns }
}

async function drain(stream: AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }) {
  for await (const _chunk of stream) {
    // read to the end
  }
  return stream.result
}

// A user prompt typed at the terminal, then the turn it starts.
async function turn($: Engine, text: string, turnId = 't1', origin: PromptSubmitInput['origin'] = { kind: 'composer' }) {
  await $.prompt.submit({ text, wait: false, origin })
  await $.turn.start({ text, turnId })
  await drain($.turn.step({ turnId, index: 0, model: SESSION_MODEL, effort: 'medium', messageCount: 1 }))
}

const spawn = ($: Engine, prompt: string) =>
  $.agent.spawn({
    prompt,
    description: 'task',
    subagentType: 'general-purpose',
    tool_use_id: `toolu_${prompt.length}`,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: SESSION_MODEL,
    background: false,
    fork: false,
  } as never) as Promise<{ model: string; agentId?: string }>

const command = (args: string) => ({
  command: 'route',
  args,
  origin: { kind: 'user' },
  presentation: { isFullscreen: false, columns: 120 },
}) as never

const UNCHANGED = [{ model: SESSION_MODEL, effort: 'medium' }]
// The seven task-label questions Jev is asked with the route and the difficulty (labels on, the default).
const LABEL_QUESTIONS = Object.fromEntries(
  ['specified', 'scope', 'evidence', 'failure', 'localization', 'language', 'project'].map(k => [k, { type: 'choice', instructions: expect.any(String), criteria: expect.any(Object) }]),
)
const jevUrls = (urls: string[]) => urls.filter(u => u === GATEWAY || u === DIRECT)

describe('router: Jev through a Databricks gateway', () => {
  test('a confident coding/high answer routes the step to the databricks opus', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('coding', { fast: 0.02, general: 0.04, reasoning: 0.06, coding: 0.88 }, { low: 0.05, medium: 0.15, high: 0.8 }) })
    await turn($, 'Refactor this Scala class to use cats-effect')
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
    expect(w.urls).toEqual([GATEWAY])
    expect(w.completions.length).toBe(0)
  })

  test('the request: default gateway model, object state, nine choice questions in one call, bearer token', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('fast', { fast: 0.9, general: 0.1, reasoning: 0, coding: 0 }, { low: 0.9, medium: 0.1, high: 0 }) })
    await turn($, "what's 2+2")
    const r = w.requests[0] as Sent
    expect(r.headers.authorization).toBe('Bearer tok1')
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.body).toEqual({
      model: 'system.ai.typesafeai-jev-1-14-0',
      state: { message: "what's 2+2", channel: 'claude-code main loop' },
      questions: {
        route: {
          type: 'choice',
          instructions: expect.any(String),
          criteria: { fast: expect.any(String), general: expect.any(String), reasoning: expect.any(String), coding: expect.any(String) },
        },
        difficulty: {
          type: 'choice',
          instructions: expect.any(String),
          criteria: { low: expect.any(String), medium: expect.any(String), high: expect.any(String) },
        },
        ...LABEL_QUESTIONS,
      },
    })
    expect(w.urls).toEqual([GATEWAY])
    expect(w.sent).toEqual([{ model: DB_HAIKU, effort: 'low' }])
  })

  test('a long message is cut to 4000 chars in the state', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('fast', { fast: 0.9, general: 0.1 }) })
    await turn($, 'x'.repeat(10_000))
    expect(((w.requests[0] as Sent).body as { state: { message: string } }).state.message.length).toBe(4000)
  })

  // every-turn: the classifier's route applies whatever its confidence (adaptive would keep the model).
  test('low confidence falls back to general', { options: { ...DB, routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, { fetch: () => jev('reasoning', { fast: 0.2, general: 0.3, reasoning: 0.4, coding: 0.1 }) })
    await turn($, 'hmm, what should we do here?')
    expect(w.sent).toEqual([{ model: DB_SONNET, effort: 'medium' }])
  })

  test('the token CLI runs without -p when databricksProfile is empty', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('fast', { fast: 1 }) })
    await turn($, 'one')
    expect(w.argvs).toEqual([['databricks', 'auth', 'token']])
  })

  test('the token CLI gets -p <profile> when one is set', { options: { ...DB, databricksProfile: 'my-profile' } }, async ($, on) => {
    const w = world(on, { fetch: () => jev('fast', { fast: 1 }) })
    await turn($, 'one')
    expect(w.argvs).toEqual([['databricks', 'auth', 'token', '-p', 'my-profile']])
  })

  test('a 401 refreshes the token and retries once', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: (_url, n) => (n === 1 ? fail(401) : jev('reasoning', { reasoning: 0.8, general: 0.2 }, { high: 0.9, medium: 0.1 })) })
    await turn($, 'Design the event sourcing for billing')
    expect(w.tokenRuns()).toBe(2)
    expect(w.requests.map(r => r.headers.authorization)).toEqual(['Bearer tok1', 'Bearer tok2'])
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
  })

  test('the token is cached for 10 minutes', { options: { ...DB, routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, { fetch: () => jev('fast', { fast: 0.9, general: 0.1 }) })
    await turn($, 'one', 't1')
    await turn($, 'two', 't2')
    expect(w.tokenRuns()).toBe(1)
    await w.clock.advance(10 * 60 * 1000)
    await turn($, 'three', 't3')
    expect(w.tokenRuns()).toBe(2)
  })
})

describe('router: Jev through the TypeSafe API (direct)', () => {
  test('with the API key set: direct URL, string state, jev-latest, the key as bearer', async ($, on) => {
    const w = world(on, { env: { TYPESAFE_API_KEY: API_KEY }, fetch: () => jev('coding', { coding: 0.9, general: 0.1 }) })
    await turn($, 'Implement the parser')
    const r = w.requests[0] as Sent
    expect(r.url).toBe(DIRECT)
    expect(r.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(r.body).toEqual({
      model: 'jev-latest',
      state: 'Implement the parser',
      questions: {
        route: { type: 'choice', instructions: expect.any(String), criteria: expect.any(Object) },
        difficulty: { type: 'choice', instructions: expect.any(String), criteria: expect.any(Object) },
        ...LABEL_QUESTIONS,
      },
    })
    expect(w.tokenRuns()).toBe(0)
    // No difficulty answer: coding/medium.
    expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
  })

  test('a custom jevApiKeyEnv is read through printenv', { options: { jevApiKeyEnv: 'MY_JEV_KEY' } }, async ($, on) => {
    const w = world(on, { env: { MY_JEV_KEY: API_KEY }, fetch: () => jev('fast', { fast: 1 }) })
    await turn($, 'hi')
    expect(w.argvs.length > 0 && w.argvs.every(a => a.join(' ') === 'printenv MY_JEV_KEY')).toBe(true)
    expect((w.requests[0] as Sent).headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'medium' }])
  })

  test('a jevUrl wins over the key: the gateway shape is sent', { options: { jevUrl: GATEWAY } }, async ($, on) => {
    const w = world(on, { env: { TYPESAFE_API_KEY: API_KEY }, fetch: () => jev('fast', { fast: 1 }) })
    await turn($, 'hi')
    expect(w.urls).toEqual([GATEWAY])
    expect(((w.requests[0] as Sent).body as { state: unknown }).state).toEqual({ message: 'hi', channel: 'claude-code main loop' })
  })
})

describe('router: the chain', () => {
  test('jev not configured is skipped silently: haiku classifies', async ($, on) => {
    const w = world(on, { complete: () => says('reasoning/high', 0.92) })
    await turn($, 'Plan the migration')
    expect(jevUrls(w.urls)).toEqual([])
    expect(w.asks).toEqual([])
    expect(w.completions.map(c => c.model)).toEqual(['haiku'])
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    const answer = await $.command.run(command('status'))
    expect(answer).toMatchObject({ text: expect.stringMatching(/last: main · reasoning\/high → claude-opus-5-5 · conf 0\.92 · haiku/) })
  })

  test('the haiku request: strict-JSON system prompt, 4000-char cut, small cap, own timeout', async ($, on) => {
    const w = world(on, { complete: () => haiku('```json\n{"route":"fast","confidence":0.8,"difficulty":"low","difficultyConfidence":0.9}\n```') })
    await turn($, 'y'.repeat(9_000))
    const c = w.completions[0] as ModelCompleteInput
    expect(c.system).toContain('"route"')
    expect(c.system).toContain('"difficulty"')
    expect(c.prompt).toContain('y'.repeat(4000))
    expect(c.prompt).not.toContain('y'.repeat(4001))
    // the task labels make the reply longer (96 with labels off)
    expect(c.maxTokens).toBe(256)
    expect(c.timeoutMs).toBe(4000)
    expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
  })

  test('the databricks profile asks the databricks haiku', { options: { profile: 'databricks', routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"general","confidence":0.7}') })
    await turn($, 'Review this diff')
    expect(w.completions.map(c => c.model)).toEqual([DB_HAIKU])
    expect(w.sent).toEqual([{ model: DB_SONNET, effort: 'medium' }])
  })

  test('chain order is followed: local first when Ollama is up', { options: { chain: 'local,haiku' } }, async ($, on) => {
    const w = world(on, {
      fetch: url => (url === TAGS ? ok('{"models":[]}') : ollama({ choice: 'coding', probabilities: { coding: 0.8, general: 0.2 }, difficulty: 'high', difficultyProbabilities: { high: 0.8, medium: 0.2 } })),
      complete: () => haiku('{"route":"fast","confidence":1}'),
    })
    await turn($, 'Refactor this')
    expect(w.urls).toEqual([TAGS, OLLAMA])
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test('every step unconfigured: the step is unchanged and nobody is asked', { options: { chain: 'jev,local' } }, async ($, on) => {
    const w = world(on, { ask: () => 'Stay on the current model' })
    await turn($, 'anything')
    expect(w.urls).toEqual([TAGS])
    expect(w.asks).toEqual([])
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('an invalid answer from the last step leaves the step unchanged', { options: { chain: 'haiku' } }, async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"gpt-9","confidence":1}') })
    await turn($, 'anything')
    expect(w.sent).toEqual(UNCHANGED)
  })
})

// Each kind of failure of a configured step opens the consent dialog, with a sanitized summary.
const FAILURES: { name: string; options: Record<string, string>; bottom: Bottom; summary: RegExp; advance?: number }[] = [
  { name: 'gateway 401 twice', options: DB, bottom: { fetch: () => fail(401) }, summary: /HTTP 401 unauthorized/ },
  { name: 'gateway 403', options: DB, bottom: { fetch: () => fail(403) }, summary: /HTTP 403 forbidden \(PERMISSION_DENIED\)/ },
  { name: 'gateway 503', options: DB, bottom: { fetch: () => fail(503, 'oops <html>') }, summary: /HTTP 503 unavailable\)/ },
  {
    name: 'network error',
    options: DB,
    bottom: {
      fetch: () => {
        throw new Error('connection refused')
      },
    },
    summary: /network error: .*connection refused/,
  },
  { name: 'unknown label', options: DB, bottom: { fetch: () => jev('gpt-9', { 'gpt-9': 1 }) }, summary: /bad answer: not a route label/ },
  { name: 'no route answer', options: DB, bottom: { fetch: () => ok('{"answers":{"other":{"type":"noul"}}}') }, summary: /bad answer/ },
  { name: 'unreadable JSON', options: DB, bottom: { fetch: () => ok('<html>') }, summary: /bad answer: unreadable JSON/ },
  {
    name: 'haiku api-error 401',
    options: { chain: 'haiku,local' },
    bottom: { complete: () => ({ isAnswered: false, reason: 'api-error', status: 401, error: 'authentication_failed', usage: USAGE }) },
    summary: /HTTP 401 unauthorized \(authentication_failed\)/,
  },
  {
    name: 'haiku aborted',
    options: { chain: 'haiku,local' },
    bottom: { complete: () => ({ isAnswered: false, reason: 'aborted', usage: USAGE }) },
    summary: /timed out after 4000ms/,
  },
  {
    name: 'haiku empty reply',
    options: { chain: 'haiku,local' },
    bottom: { complete: () => ({ isAnswered: false, reason: 'empty-reply', usage: USAGE }) },
    summary: /bad answer: empty reply/,
  },
]

describe('router: failures open the consent dialog', () => {
  for (const f of FAILURES) {
    test(`${f.name}`, { options: f.options }, async ($, on) => {
      const local = f.options.chain === 'haiku,local'
      const fetch = local ? () => ok('{"models":[]}') : f.bottom.fetch
      const w = world(on, { ...f.bottom, fetch, complete: f.bottom.complete, ask: () => 'Stay on the current model' })
      await turn($, 'anything')
      expect(w.asks.length).toBe(1)
      expect((w.asks[0] as Asked).question).toMatch(f.summary)
      expect((w.asks[0] as Asked).question.endsWith('?')).toBe(true)
      expect(w.sent).toEqual(UNCHANGED)
    })
  }

  test('a timeout opens the dialog too', { options: DB }, async ($, on) => {
    let w: ReturnType<typeof world>
    w = world(on, {
      fetch: async url => {
        if (url === TAGS) throw new Error('connection refused')
        await w.clock.sleep(10_000)
        return jev('fast', { fast: 1 })
      },
      ask: () => 'Stay on the current model',
    })
    const started = turn($, 'anything')
    await w.clock.advance(2_500)
    await started
    expect((w.asks[0] as Asked).question).toMatch(/timed out after 2500ms/)
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('the token never reaches the dialog or /route status', { options: DB }, async ($, on) => {
    const w = world(on, {
      fetch: () => {
        throw new Error('refused: authorization: Bearer tok1 for tok1')
      },
      ask: () => 'Stay on the current model',
    })
    await turn($, 'anything')
    const q = (w.asks[0] as Asked).question
    expect(q).not.toContain('tok1')
    const status = (await $.command.run(command('status'))) as { text: string }
    expect(status.text).toContain('last failure: jev')
    expect(status.text).not.toContain('tok1')
  })

  test('the API key never reaches the dialog', async ($, on) => {
    const w = world(on, {
      env: { TYPESAFE_API_KEY: API_KEY },
      fetch: () => {
        throw new Error(`bad header ${API_KEY}`)
      },
      ask: () => 'Stay on the current model',
    })
    await turn($, 'anything')
    expect((w.asks[0] as Asked).question).not.toContain(API_KEY)
    expect((w.asks[0] as Asked).question).toContain('***')
  })
})

describe('router: consent answers', () => {
  const failingJev = { fetch: (url: string) => (url === TAGS ? ok('{"models":[]}') : url === OLLAMA ? ollama({ choice: 'reasoning', probabilities: { reasoning: 0.9, general: 0.1 }, difficulty: 'high', difficultyProbabilities: { high: 0.9, medium: 0.1 } }) : fail(503)) }
  const okHaiku = { complete: () => says('fast/low') }
  const EVERY = { ...DB, routeMainLoop: 'every-turn' } as const

  test('the dialog offers the next step once, for the session, the later step, and staying', { options: DB }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Use haiku this time' })
    await turn($, 'anything')
    expect((w.asks[0] as Asked).labels).toEqual([
      'Use haiku this time',
      'Use haiku for the rest of this session',
      'Use local this time',
      'Stay on the current model',
    ])
  })

  test('"Use haiku this time" uses haiku, and asks again next turn', { options: EVERY }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Use haiku this time' })
    await turn($, 'one', 't1')
    expect(w.sent).toEqual([{ model: DB_HAIKU, effort: 'low' }])
    await turn($, 'two', 't2')
    expect(w.asks.length).toBe(2)
    expect(jevUrls(w.urls).length).toBe(2)
  })

  test('"for the rest of this session" skips jev from then on', { options: EVERY }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Use haiku for the rest of this session' })
    await turn($, 'one', 't1')
    await turn($, 'two', 't2')
    await turn($, 'three', 't3')
    expect(w.asks.length).toBe(1)
    expect(jevUrls(w.urls).length).toBe(1)
    expect(w.completions.length).toBe(3)
    expect(w.sent.every(s => s.model === DB_HAIKU)).toBe(true)
    const status = (await $.command.run(command('status'))) as { text: string }
    expect(status.text).toContain('using haiku for this session')
  })

  test('"Use local this time" jumps to the later step', { options: DB }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Use local this time' })
    await turn($, 'anything')
    expect(w.completions.length).toBe(0)
    expect(w.urls).toContain(OLLAMA)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
  })

  test('"Stay on the current model" stays unrouted for five minutes, then tries again', { options: EVERY }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Stay on the current model' })
    await turn($, 'one', 't1')
    await turn($, 'two', 't2')
    expect(w.asks.length).toBe(1)
    expect(jevUrls(w.urls).length).toBe(1)
    expect(w.sent).toEqual([...UNCHANGED, ...UNCHANGED])
    await w.clock.advance(5 * 60 * 1000)
    await turn($, 'three', 't3')
    expect(w.asks.length).toBe(2)
  })

  test('free text under "Other" leaves the step unchanged', { options: DB }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'whatever' })
    await turn($, 'anything')
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('a dismissed or headless dialog (ask rejects) leaves the step unchanged', { options: DB }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku })
    await turn($, 'anything')
    expect(w.asks.length).toBe(1)
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('fallbackPolicy never: no dialog, no fallback', { options: { ...DB, fallbackPolicy: 'never' } }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku, ask: () => 'Use haiku this time' })
    await turn($, 'anything')
    expect(w.asks).toEqual([])
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('fallbackPolicy auto: falls through silently', { options: { ...DB, fallbackPolicy: 'auto' } }, async ($, on) => {
    const w = world(on, { ...failingJev, ...okHaiku })
    await turn($, 'anything')
    expect(w.asks).toEqual([])
    expect(w.sent).toEqual([{ model: DB_HAIKU, effort: 'low' }])
  })

  test('fallbackPolicy auto: past a failing haiku to local', { options: { ...DB, fallbackPolicy: 'auto' } }, async ($, on) => {
    const w = world(on, { ...failingJev })
    await turn($, 'anything')
    expect(w.completions.length).toBe(1)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
  })

  test('subagents spawned together share one dialog', { options: DB }, async ($, on) => {
    let w: ReturnType<typeof world>
    w = world(on, { ...failingJev, ...okHaiku, ask: async () => (await w.clock.sleep(1_000), 'Use haiku this time') })
    const both = Promise.all([spawn($, 'first task'), spawn($, 'second task')])
    await w.clock.advance(1_000)
    const started = await both
    expect(w.asks.length).toBe(1)
    expect(started.map(s => s.model)).toEqual([DB_HAIKU, DB_HAIKU])
  })
})

describe('router: the main loop and the prompt cache', () => {
  const haikuSays = (cell: string) => ({ complete: () => says(cell) })

  test('session-start classifies the first turn and keeps it', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    let n = 0
    const w = world(on, { complete: () => says(n++ === 0 ? 'coding/high' : 'fast/low') })
    await turn($, 'Implement the feature', 't1')
    await turn($, 'thanks', 't2')
    await turn($, 'one more', 't3')
    expect(w.completions.length).toBe(1)
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })

  test('session-start still classifies each subagent at spawn', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, haikuSays('fast/low'))
    await turn($, 'Implement it', 't1')
    const s = await spawn($, 'look something up')
    expect(s.model).toBe('claude-haiku-5-5')
    expect(w.completions.length).toBe(2)
  })

  test('a /clear classifies the main loop afresh', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, haikuSays('fast'))
    await turn($, 'one', 't1')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    await turn($, 'two', 't2')
    expect(w.completions.length).toBe(2)
  })

  test('every-turn classifies each turn', { options: { routeMainLoop: 'every-turn' } }, async ($, on) => {
    let n = 0
    const w = world(on, { complete: () => says(n++ === 0 ? 'coding/high' : 'fast/low') })
    await turn($, 'Implement the feature', 't1')
    await turn($, 'what is 2+2', 't2')
    expect(w.completions.length).toBe(2)
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-haiku-5-5', effort: 'low' },
    ])
  })

  test('off never routes the main loop, subagents still are', { options: { routeMainLoop: 'off' } }, async ($, on) => {
    const w = world(on, haikuSays('reasoning/high'))
    await turn($, 'Design it', 't1')
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual(UNCHANGED)
    const s = await spawn($, 'design the schema')
    expect(s.model).toBe('claude-opus-5-5')
  })
})

describe('router: profiles and route matrices', () => {
  test('anthropic (default) shows the full-id matrix, one line per category', async ($, on) => {
    world(on, {})
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('profile anthropic')
    expect(text).toContain('  fast      low → claude-haiku-5-5 (low) · medium → claude-haiku-5-5 (medium) · high → claude-sonnet-5-5 (medium)')
    expect(text).toContain('  general   low → claude-haiku-5-5 (medium) · medium → claude-sonnet-5-5 (medium) · high → claude-sonnet-5-5 (high)')
    expect(text).toContain('  reasoning low → claude-sonnet-5-5 (high) · medium → claude-opus-5-5 (medium) · high → claude-opus-5-5 (high)')
    expect(text).toContain('  coding    low → claude-sonnet-5-5 (medium) · medium → claude-sonnet-5-5 (high) · high → claude-opus-5-5 (high)')
    expect(text).toContain('chain: jev (not configured) → haiku (haiku) → local (qwen3.6:35b-a3b, not reachable)')
  })

  test('databricks shows the gateway matrix and the gateway jev', { options: DB }, async ($, on) => {
    world(on, {})
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('profile databricks')
    expect(text).toContain(`fast      low → ${DB_HAIKU} (low) · medium → ${DB_HAIKU} (medium) · high → ${DB_SONNET} (medium)`)
    expect(text).toContain(`coding    low → ${DB_SONNET} (medium) · medium → ${DB_SONNET} (high) · high → ${DB_OPUS} (high)`)
    expect(text).toContain('jev (gateway, system.ai.typesafeai-jev-1-14-0)')
  })

  test('routes JSON: a category key sets its row, a cell key one cell and wins', { options: { routes: '{"fast":"claude-x","coding":{"model":"claude-y","effort":"high"},"coding.low":"claude-z"}' } }, async ($, on) => {
    world(on, {})
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('fast      low → claude-x (low) · medium → claude-x (medium) · high → claude-x (medium)')
    expect(text).toContain('general   low → claude-haiku-5-5 (medium) · medium → claude-sonnet-5-5 (medium)')
    expect(text).toContain('coding    low → claude-z (medium) · medium → claude-y (high) · high → claude-y (high)')
  })
})

describe('router: commands and the HUD atom', () => {
  test('/route off passes every step through', async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"fast","confidence":0.95}') })
    const answer = await $.command.run(command('off'))
    expect(answer).toMatchObject({ text: 'router: routing off.' })
    await turn($, "what's 2+2")
    expect(w.sent).toEqual(UNCHANGED)
    expect(w.completions.length).toBe(0)
  })

  test('/route pin forces a route without asking the classifier; the difficulty defaults to medium', async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"fast","confidence":1}') })
    const answer = await $.command.run(command('pin reasoning'))
    expect(answer).toMatchObject({ text: 'router: pinned to reasoning/medium → claude-opus-5-5.' })
    await turn($, "what's 2+2")
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'medium' }])
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· pinned reasoning/medium')
    expect(text).toMatch(/last: main · reasoning\/medium → claude-opus-5-5 · conf 1\.00 · pin/)
  })

  test('/route pin coding high pins that cell, for the main loop and subagents', async ($, on) => {
    const w = world(on, { complete: () => says('fast/low') })
    const answer = await $.command.run(command('pin coding high'))
    expect(answer).toMatchObject({ text: 'router: pinned to coding/high → claude-opus-5-5.' })
    await turn($, "what's 2+2")
    const s = await spawn($, 'look something up')
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(s.model).toBe('claude-opus-5-5')
    expect(w.sets.filter(x => x.key === 'routerLast').at(-1)?.value).toMatchObject({ route: 'coding', difficulty: 'high', backend: 'pin' })
  })

  test('/route pin rejects an unknown difficulty and keeps the previous pin', async ($, on) => {
    world(on, {})
    await $.command.run(command('pin coding low'))
    const answer = await $.command.run(command('pin coding extreme'))
    expect(answer).toMatchObject({ text: 'router: unknown difficulty "extreme". Difficulties: low, medium, high.' })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· pinned coding/low')
  })

  test('the routerLast atom keeps the RouterDecision shape, the difficulty included', async ($, on) => {
    const w = world(on, { complete: () => says('coding/high', 0.8) })
    await turn($, 'Write the code')
    const value = w.sets.filter(x => x.key === 'routerLast').at(-1)?.value
    expect(value).toEqual({
      loop: 'main',
      route: 'coding',
      difficulty: 'high',
      model: 'claude-opus-5-5',
      effort: 'high',
      confidence: 0.8,
      backend: 'haiku',
      at: 1_000,
      action: 'switched',
      contextTokens: 0,
      // task (the default): the first clear prompt commits the session's model
      committed: true,
    })
  })

  test('session-start publishes the 0.1.0 shape and the difficulty, no adaptive fields', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, { complete: () => says('coding/high', 0.8) })
    await turn($, 'Write the code')
    const value = w.sets.filter(x => x.key === 'routerLast').at(-1)?.value
    expect(value).toEqual({ loop: 'main', route: 'coding', difficulty: 'high', model: 'claude-opus-5-5', effort: 'high', confidence: 0.8, backend: 'haiku', at: 1_000 })
  })

  test('a routing decision draws no status line', async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"fast","confidence":0.9}') })
    await turn($, "what's 2+2")
    await $.command.run(command('off'))
    await $.command.run(command('on'))
    await $.command.run(command('pin reasoning'))
    await turn($, 'hello', 't2')
    // In the one plugin the HUD keeps its own `NEXUS …` status line; the router adds none.
    expect(w.statuses.filter(t => !(typeof t === 'string' && t.startsWith('NEXUS ')))).toEqual([])
  })
})

describe('router: adaptive switch-or-keep (pure)', () => {
  const cfg = readConfig({})
  const at = (over: Partial<SwitchInput>): SwitchInput => ({
    routed: { model: 'claude-opus-5-5', confidence: 0.9 },
    currentModel: 'claude-sonnet-5-5',
    contextTokens: 10_000,
    mode: 'adaptive',
    cfg,
    ...over,
  })

  test('defaults: task, 0.75, 50k, hint on, no window overrides', () => {
    expect(cfg).toMatchObject({ routeMainLoop: 'task', switchConfidence: 0.75, switchMaxContext: 50_000, delegationHint: true, contextWindows: {} })
  })

  test('bad settings fall back to the defaults', () => {
    const bad = readConfig({ switchConfidence: '0.9', switchMaxContext: Number.NaN, delegationHint: 'false', contextWindows: '{not json', routeMainLoop: 'sometimes' })
    expect(bad).toMatchObject({ routeMainLoop: 'task', switchConfidence: 0.75, switchMaxContext: 50_000, delegationHint: true, contextWindows: {} })
    expect(readConfig({ contextWindows: '[1,2]' }).contextWindows).toEqual({})
    expect(readConfig({ contextWindows: '{"haiku":300000,"bad":"x","neg":-1}' }).contextWindows).toEqual({ haiku: 300_000 })
  })

  test('windowFor: [1m] is 1M, others 200k, the longest matching override wins', () => {
    expect(windowFor('system.ai.claude-opus-5-5[1m]', cfg)).toBe(1_000_000)
    expect(windowFor('claude-haiku-5-5', cfg)).toBe(200_000)
    const o = readConfig({ contextWindows: '{"haiku":400000,"claude-haiku-5-5":500000,"opus":900000}' })
    expect(windowFor('claude-haiku-5-5', o)).toBe(500_000)
    expect(windowFor('claude-haiku-4-5', o)).toBe(400_000)
    expect(windowFor('system.ai.claude-opus-5-5[1m]', o)).toBe(900_000)
    expect(windowFor('claude-sonnet-5-5', o)).toBe(200_000)
  })

  test('a small context and a confident route switch', () => {
    expect(decideSwitch(at({}))).toEqual({ action: 'switched', apply: true })
  })

  test('before the first request (no model, context 0) it switches', () => {
    expect(decideSwitch(at({ currentModel: undefined, contextTokens: 0 }))).toEqual({ action: 'switched', apply: true })
  })

  test('the routed model is the current one: applied (its effort too), shown as kept', () => {
    expect(decideSwitch(at({ currentModel: 'claude-opus-5-5', contextTokens: 900_000 }))).toEqual({ action: 'kept', apply: true })
    // Unsure: not even the effort changes.
    expect(decideSwitch(at({ routed: { model: 'claude-opus-5-5', confidence: 0.7 }, currentModel: 'claude-opus-5-5' }))).toEqual({ action: 'kept', apply: false, reason: 'confidence' })
  })

  test('a large context keeps the model, with a hint', () => {
    expect(decideSwitch(at({ contextTokens: 150_000 }))).toEqual({ action: 'hint', apply: false, reason: 'context' })
  })

  test('low confidence keeps the model, no hint', () => {
    expect(decideSwitch(at({ routed: { model: 'claude-opus-5-5', confidence: 0.7 }, contextTokens: 150_000 }))).toEqual({ action: 'kept', apply: false, reason: 'confidence' })
  })

  test('the window guard blocks 300k going to a 200k model, in adaptive and every-turn', () => {
    const wide = { ...cfg, switchMaxContext: 10_000_000 }
    const down = { routed: { model: 'claude-haiku-5-5', confidence: 0.95 }, currentModel: 'claude-sonnet-5-5[1m]', contextTokens: 300_000 }
    expect(decideSwitch(at({ ...down, cfg: wide }))).toEqual({ action: 'hint', apply: false, reason: 'window' })
    expect(decideSwitch(at({ ...down, mode: 'every-turn' }))).toEqual({ action: 'hint', apply: false, reason: 'window' })
    // every-turn ignores the confidence and the size threshold, not the window.
    expect(decideSwitch(at({ routed: { model: 'claude-opus-5-5', confidence: 0.1 }, contextTokens: 150_000, mode: 'every-turn' }))).toEqual({ action: 'switched', apply: true })
  })

  test('delegationHint off: kept, never hint', () => {
    const off = { ...cfg, delegationHint: false }
    expect(decideSwitch(at({ contextTokens: 150_000, cfg: off }))).toEqual({ action: 'kept', apply: false, reason: 'context' })
  })

  test('the hint: one line, route, confidence, kept model, size, suggested model', () => {
    const text = delegationHint({ route: 'reasoning', difficulty: 'high', confidence: 0.82, current: 'claude-sonnet-5-5', suggested: 'claude-opus-5-5', contextTokens: 150_000, reason: 'context' })
    expect(text).toBe(
      'NEXUS router: this prompt classified as reasoning/high (0.82). The session stays on claude-sonnet-5-5 to keep its 150k-token cache. ' +
        'If this is a self-contained sub-task, delegate it to a subagent (orchestrator skill); NEXUS routes the subagent to claude-opus-5-5.',
    )
    expect(text).not.toContain('\n')
    const win = delegationHint({ route: 'fast', confidence: 0.9, current: undefined, suggested: 'claude-haiku-5-5', contextTokens: 300_000, reason: 'window' })
    expect(win).toContain("stays on its current model because its 300k-token context does not fit claude-haiku-5-5's window")
  })

  test('routerObserve records the main loop only: model sent and input + cache read + cache write', () => {
    const r = createRouter({} as never)
    const result = (n: number) => ({ turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { input_tokens: n, output_tokens: 9, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 100, model: 'm' } })
    const step = { turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never
    routerObserve(r, { ...(step as object), agentId: 'agent1', model: 'claude-haiku-5-5' } as never, result(50_000) as never)
    expect([r.mainModel, r.contextTokens]).toEqual([undefined, 0])
    routerObserve(r, step, result(10) as never)
    expect([r.mainModel, r.contextTokens]).toEqual(['claude-opus-5-5', 1_110])
    // No usage (a failed request): the size stays, the model is recorded.
    routerObserve(r, { ...(step as object), model: 'claude-sonnet-5-5' } as never, { ...result(0), usage: null } as never)
    expect([r.mainModel, r.contextTokens]).toEqual(['claude-sonnet-5-5', 1_110])
  })
})

describe('router: adaptive main loop at prompt.submit', () => {
  // Turn 1 routes coding/high (opus, high); turn 2's cell and confidence vary per test.
  const two = (second: string, confidence = 0.9) => {
    let n = 0
    return { complete: () => (n++ === 0 ? says('coding/high') : says(second, confidence)) }
  }
  const lastDecision = (w: ReturnType<typeof world>) => w.sets.filter(x => x.key === 'routerLast').at(-1)?.value

  test('a small context switches on each prompt', { options: { routeMainLoop: 'adaptive' } }, async ($, on) => {
    const w = world(on, two('fast/low'))
    w.usage.context = 12_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'what is 2+2', 't2')
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-haiku-5-5', effort: 'low' },
    ])
    expect(lastDecision(w)).toMatchObject({ route: 'fast', model: 'claude-haiku-5-5', action: 'switched', contextTokens: 12_000 })
    expect(w.prompts.every(p => p.context === undefined)).toBe(true)
  })

  test('a large context keeps the model and attaches one hidden hint', async ($, on) => {
    const w = world(on, two('fast/low'))
    w.usage.context = 150_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.prompts[0]?.context).toBeUndefined()
    expect(w.prompts[1]?.context).toEqual([
      'NEXUS router: this prompt classified as fast/low (0.90). The session stays on claude-opus-5-5 to keep its 150k-token cache. ' +
        'If this is a self-contained sub-task, delegate it to a subagent (orchestrator skill); NEXUS routes the subagent to claude-haiku-5-5.',
    ])
    expect(w.prompts[1]?.text).toBe('list the files')
    expect(lastDecision(w)).toMatchObject({ route: 'fast', difficulty: 'low', model: 'claude-opus-5-5', effort: 'high', action: 'hint', contextTokens: 150_000, suggested: 'claude-haiku-5-5' })
  })

  test('low confidence keeps the model, no hint', async ($, on) => {
    const w = world(on, two('fast/low', 0.65))
    w.usage.context = 5_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.prompts[1]?.context).toBeUndefined()
    expect(lastDecision(w)).toMatchObject({ route: 'fast', action: 'kept', model: 'claude-opus-5-5', suggested: 'claude-haiku-5-5' })
  })

  test('a first prompt kept before any request names the session model once the request goes out', async ($, on) => {
    const w = world(on, { complete: () => haiku('{"route":"fast","confidence":0.6}') })
    await $.prompt.submit({ text: 'list the files', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'list the files', turnId: 't1' })
    const before = lastDecision(w) as { model: string; at: number }
    expect(before).toMatchObject({ route: 'fast', action: 'kept', model: 'session model' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: SESSION_MODEL, effort: 'medium', messageCount: 1 }))
    // the same decision (same `at`, so one trail mark), now naming the model; the request went out unchanged
    expect(lastDecision(w)).toMatchObject({ route: 'fast', action: 'kept', model: SESSION_MODEL, at: before.at })
    expect(w.sent).toEqual([{ model: SESSION_MODEL, effort: 'medium' }])
  })

  test('delegationHint off attaches nothing', { options: { delegationHint: false } }, async ($, on) => {
    const w = world(on, two('fast/low'))
    w.usage.context = 150_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.prompts.every(p => p.context === undefined)).toBe(true)
    expect(lastDecision(w)).toMatchObject({ action: 'kept', suggested: 'claude-haiku-5-5' })
  })

  // Databricks: sonnet[1m] (1M window) down to haiku (200k) with a 300k context.
  const modes: Record<string, string | number>[] = [{ routeMainLoop: 'adaptive', switchMaxContext: 10_000_000 }, { routeMainLoop: 'every-turn' }]
  for (const mode of modes) {
    test(`the window guard keeps a 300k context off a 200k model (${mode.routeMainLoop})`, { options: { profile: 'databricks', ...mode } }, async ($, on) => {
      let n = 0
      const w = world(on, { complete: () => haiku(`{"route":"${n++ === 0 ? 'general' : 'fast'}","confidence":0.9}`) })
      w.usage.context = 300_000
      await turn($, 'Review this diff', 't1')
      await turn($, 'what is 2+2', 't2')
      expect(w.sent).toEqual([
        { model: DB_SONNET, effort: 'medium' },
        { model: DB_SONNET, effort: 'medium' },
      ])
      expect(w.prompts[1]?.context?.[0]).toContain(`does not fit ${DB_HAIKU}'s window`)
      expect(lastDecision(w)).toMatchObject({ action: 'hint', model: DB_SONNET, suggested: DB_HAIKU, contextTokens: 300_000 })
    })
  }

  test('a contextWindows override lets the same switch through', { options: { profile: 'databricks', routeMainLoop: 'every-turn', contextWindows: '{"haiku":400000}' } }, async ($, on) => {
    let n = 0
    const w = world(on, { complete: () => says(n++ === 0 ? 'general' : 'fast/low') })
    w.usage.context = 300_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'what is 2+2', 't2')
    expect(w.sent.at(-1)).toEqual({ model: DB_HAIKU, effort: 'low' })
    expect(lastDecision(w)).toMatchObject({ action: 'switched' })
  })

  const skipped: [string, Partial<PromptSubmitInput>][] = [
    ['a slash command', { command: { name: 'review', args: '' } }],
    ['a hidden (isMeta) prompt', { isMeta: true }],
    ['a task notification', { origin: { kind: 'task-notification' } }],
    ['an sdk host prompt', { origin: { kind: 'sdk' } }],
    ['a prompt delivered into a running turn', { turnId: 't0' }],
  ]
  for (const [name, over] of skipped) {
    test(`${name} is not classified and the turn goes unrouted`, async ($, on) => {
      const w = world(on, { complete: () => says('reasoning/high', 0.95) })
      await $.prompt.submit({ text: 'Design it', wait: false, origin: { kind: 'composer' }, ...over } as PromptSubmitInput)
      await $.turn.start({ text: 'Design it', turnId: 't1' })
      await drain($.turn.step({ turnId: 't1', index: 0, model: SESSION_MODEL, effort: 'medium', messageCount: 1 }))
      expect(w.completions.length).toBe(0)
      expect(w.sent).toEqual(UNCHANGED)
      expect(w.prompts[0]?.context).toBeUndefined()
    })
  }

  test('a bridge (Remote Control) prompt is classified', async ($, on) => {
    const w = world(on, { complete: () => says('reasoning/high', 0.95) })
    await turn($, 'Design it', 't1', { kind: 'bridge' })
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
  })

  test('a later turn with no prompt (a notification) keeps the last decision', async ($, on) => {
    const w = world(on, { complete: () => says('reasoning/high', 0.95) })
    await turn($, 'Design it', 't1')
    await turn($, 'background task done', 't2', { kind: 'task-notification' })
    expect(w.completions.length).toBe(1)
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('/route status shows the mode and the last action and context', { options: { routeMainLoop: 'adaptive' } }, async ($, on) => {
    const w = world(on, two('fast/low'))
    w.usage.context = 150_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('main loop adaptive (switch at conf ≥ 0.75, ctx ≤ 50k, hint)')
    expect(text).toMatch(/last: main · fast\/low → claude-opus-5-5 · conf 0\.90 · haiku · hint \(→ claude-haiku-5-5\) · ctx 150k/)
  })
})

describe('router: continuation prompts skip the classifier', () => {
  // Turn 1 routes coding/high (opus, high); any later classification says fast/low.
  const codingThenFast = () => {
    let n = 0
    return { complete: () => (n++ === 0 ? says('coding/high') : says('fast/low', 0.95)) }
  }
  const lasts = (w: ReturnType<typeof world>) => w.sets.filter(x => x.key === 'routerLast')

  test('adaptive: "yes do it" after an opus decision makes no call and stays on opus', async ($, on) => {
    const w = world(on, codingThenFast())
    w.usage.context = 5_000
    await turn($, 'Implement the feature', 't1')
    const published = lasts(w).length
    await turn($, 'Yes, do it!', 't2')
    expect(w.completions.length).toBe(1)
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    // No hint, no new routerLast: the HUD keeps the last real decision.
    expect(w.prompts[1]?.context).toBeUndefined()
    expect(lasts(w).length).toBe(published)
  })

  test('the Jev gateway is not hit for a continuation', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('reasoning', { reasoning: 0.9, general: 0.1 }, { high: 0.85, medium: 0.15 }) })
    await turn($, 'Design the billing schema', 't1')
    await turn($, 'oui vas-y 👍', 't2')
    expect(jevUrls(w.urls).length).toBe(1)
    expect(w.sent.at(-1)).toEqual({ model: DB_OPUS, effort: 'high' })
  })

  test('before any decision a continuation goes out unchanged', async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'ok', 't1')
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual(UNCHANGED)
  })

  test('a prompt that only starts with a phrase is classified', async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    await turn($, 'ok now redesign the auth flow', 't2')
    expect(w.completions.length).toBe(2)
  })

  test('continuationSkip off classifies it', { options: { continuationSkip: false, routeMainLoop: 'adaptive' } }, async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    await turn($, 'yes do it', 't2')
    expect(w.completions.length).toBe(2)
    expect(w.sent.at(-1)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
  })

  test('custom continuationPhrases replace the list', { options: { continuationPhrases: 'banana' } }, async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    await turn($, 'Banana!', 't2')
    await turn($, 'ok', 't3')
    expect(w.completions.length).toBe(2)
  })

  test('every-turn skips it too', { options: { routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    await turn($, 'continue', 't2')
    expect(w.completions.length).toBe(1)
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('session-start: a first-prompt "ok" is skipped, the next prompt decides', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'ok', 't1')
    expect(w.completions.length).toBe(0)
    await turn($, 'Implement the feature', 't2')
    await turn($, 'what is 2+2', 't3')
    expect(w.completions.length).toBe(1)
    expect(w.sent).toEqual([
      ...UNCHANGED,
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })

  test('subagent spawns are classified whatever their prompt', async ($, on) => {
    const w = world(on, codingThenFast())
    await spawn($, 'ok')
    expect(w.completions.length).toBe(1)
  })

  test('/route status counts calls and skips; /clear resets them', async ($, on) => {
    const w = world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    await turn($, 'thanks!', 't2')
    await turn($, 'ok, continue', 't3')
    await spawn($, 'look something up')
    const status = async () => ((await $.command.run(command('status'))) as { text: string }).text
    expect(await status()).toContain('classifier: 2 calls · 2 skipped (continuation)')
    expect(w.completions.length).toBe(2)
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    expect(await status()).toContain('classifier: 0 calls · 0 skipped (continuation)')
  })

  test('/route status says when the skip is off', { options: { continuationSkip: false } }, async ($, on) => {
    world(on, codingThenFast())
    await turn($, 'Implement the feature', 't1')
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('classifier: 1 call · continuation skip off')
  })
})

describe('router: category and difficulty, one Jev request', () => {
  const lastDecision = (w: ReturnType<typeof world>) => w.sets.filter(x => x.key === 'routerLast').at(-1)?.value
  const CODING = { fast: 0.02, general: 0.04, reasoning: 0.04, coding: 0.9 }

  test('a coding/medium first prompt switches to sonnet high', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('coding', CODING, { low: 0.1, medium: 0.8, high: 0.1 }) })
    await turn($, 'Add read-only permissions on a storage volume for one group in a Terraform module')
    expect(jevUrls(w.urls)).toEqual([GATEWAY])
    expect(w.sent).toEqual([{ model: DB_SONNET, effort: 'high' }])
    expect(lastDecision(w)).toMatchObject({ route: 'coding', difficulty: 'medium', model: DB_SONNET, effort: 'high', confidence: 0.8, action: 'switched' })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain(`last: main · coding/medium → ${DB_SONNET} · conf 0.80 · jev · switched`)
  })

  test('a coding/high first prompt switches to opus high', { options: DB }, async ($, on) => {
    const w = world(on, { fetch: () => jev('coding', CODING, { low: 0.05, medium: 0.15, high: 0.8 }) })
    await turn($, 'Redesign the module boundaries of the billing service')
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
    expect(lastDecision(w)).toMatchObject({ route: 'coding', difficulty: 'high', action: 'switched' })
  })

  test('a large context with reasoning/high keeps the model and hints opus', { options: { routeMainLoop: 'adaptive' } }, async ($, on) => {
    let n = 0
    const w = world(on, { complete: () => (n++ === 0 ? says('general/medium') : says('reasoning/high')) })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5-5', effort: 'medium' },
    ])
    expect(w.prompts[1]?.context).toEqual([
      'NEXUS router: this prompt classified as reasoning/high (0.90). The session stays on claude-sonnet-5-5 to keep its 150k-token cache. ' +
        'If this is a self-contained sub-task, delegate it to a subagent (orchestrator skill); NEXUS routes the subagent to claude-opus-5-5.',
    ])
    expect(lastDecision(w)).toMatchObject({ route: 'reasoning', difficulty: 'high', model: 'claude-sonnet-5-5', action: 'hint', suggested: 'claude-opus-5-5' })
  })

  test('the decision confidence is the lower of the two answers', { options: DB }, async ($, on) => {
    // route 0.9, difficulty 0.7: below switchConfidence (0.75), so adaptive keeps the model.
    const w = world(on, { fetch: () => jev('coding', CODING, { low: 0.1, medium: 0.2, high: 0.7 }) })
    await turn($, 'Refactor the parser')
    expect(w.sent).toEqual(UNCHANGED)
    expect(lastDecision(w)).toMatchObject({ route: 'coding', difficulty: 'high', confidence: 0.7, action: 'kept', suggested: DB_OPUS })
  })

  test('a low-confidence difficulty gives medium', { options: { ...DB, routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, { fetch: () => jev('coding', CODING, { low: 0.25, medium: 0.25, high: 0.5 }) })
    await turn($, 'Refactor the parser')
    expect(w.sent).toEqual([{ model: DB_SONNET, effort: 'high' }])
    expect(lastDecision(w)).toMatchObject({ route: 'coding', difficulty: 'medium', confidence: 0.5 })
  })

  test('a combined-label answer (one question, category/difficulty) routes the same', { options: DB }, async ($, on) => {
    const combined = { 'coding/high': 0.82, 'coding/medium': 0.1, 'reasoning/high': 0.08 }
    const w = world(on, {
      fetch: () => ok(JSON.stringify({ model: 'jev-1.14.0', answers: { route: { type: 'choice', choice: 'coding/high', confidence: 0.82, probabilities: combined } } })),
    })
    await turn($, 'Redesign the module boundaries')
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'high' }])
    expect(lastDecision(w)).toMatchObject({ route: 'coding', difficulty: 'high', action: 'switched' })
    // coding: 0.82 + 0.1; high: 0.82 + 0.08; the lower is 0.9.
    expect(Math.abs((lastDecision(w) as { confidence: number }).confidence - 0.9) < 1e-9).toBe(true)
  })

  test('a subagent spawn takes its cell too', async ($, on) => {
    const w = world(on, { complete: () => says('fast/high') })
    const s = await spawn($, 'summarise the logs of every service')
    expect(s.model).toBe('claude-sonnet-5-5')
    expect(lastDecision(w)).toMatchObject({ loop: 'agent1', route: 'fast', difficulty: 'high', model: 'claude-sonnet-5-5', effort: 'medium' })
  })
})

// ---------- an unknown context (reload, restart, resume) ----------

// A conversation under way, in API form: the prompts and answers before the reload.
const UNDER_WAY = [
  { role: 'user', content: [{ type: 'text', text: 'Design the billing schema' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Here is the schema.' }] },
]
// The first request of the turn after a reload: the conversation so far and the new prompt.
const stepOf = (turnId: string, model: string, messageCount: number) => ({ turnId, index: 0, model, effort: 'medium' as const, messageCount })
async function promptTurn($: Engine, text: string, turnId: string, model: string, messageCount: number) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId })
  await drain($.turn.step(stepOf(turnId, model, messageCount)))
}

describe('router: an unknown context is never taken for an empty one', () => {
  const lastDecision = (w: ReturnType<typeof world>) => w.sets.filter(x => x.key === 'routerLast').at(-1)?.value

  test('a reload mid-conversation with a 173k context keeps opus off haiku (the window fill tells the size)', { options: { profile: 'databricks' } }, async ($, on) => {
    const w = world(on, { complete: () => says('general/low', 0.9), session: { messages: UNDER_WAY, tokens: 173_000, model: DB_OPUS } })
    await promptTurn($, 'list the tables', 't1', DB_OPUS, 40)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'medium' }])
    expect(lastDecision(w)).toMatchObject({ route: 'general', difficulty: 'low', model: DB_OPUS, action: 'hint', contextTokens: 173_000, suggested: DB_HAIKU })
    expect(w.prompts[0]?.context?.[0]).toContain(`The session stays on ${DB_OPUS} to keep its 173k-token cache`)
  })

  test('every-turn after a reload: a context past the target window stays put', { options: { profile: 'databricks', routeMainLoop: 'every-turn' } }, async ($, on) => {
    const w = world(on, { complete: () => says('general/low', 0.9), session: { messages: UNDER_WAY, tokens: 260_000, model: DB_OPUS } })
    await promptTurn($, 'list the tables', 't1', DB_OPUS, 40)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'medium' }])
    expect(lastDecision(w)).toMatchObject({ action: 'hint', contextTokens: 260_000, suggested: DB_HAIKU })
  })

  test('no window fill reported: the transcript is estimated at 4 characters a token', { options: { profile: 'databricks' } }, async ($, on) => {
    const big = [...UNDER_WAY, { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(400_000) }] }, UNDER_WAY[1]]
    const w = world(on, { complete: () => says('general/low', 0.9), session: { messages: big, model: DB_OPUS } })
    await promptTurn($, 'list the tables', 't1', DB_OPUS, 4)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'medium' }])
    const shown = lastDecision(w) as { action: string; contextTokens: number }
    expect(shown.action).toBe('hint')
    expect(shown.contextTokens).toBe(estimateTokens(big))
    expect(shown.contextTokens > 100_000).toBe(true)
  })

  test('nothing tells the size and the request carries a conversation: the model is kept (unknown-context)', { options: { profile: 'databricks', routeMainLoop: 'adaptive' } }, async ($, on) => {
    const w = world(on, { complete: () => says('general/low', 0.9), store: {} })
    await promptTurn($, 'list the tables', 't1', DB_OPUS, 40)
    expect(w.sent).toEqual([{ model: DB_OPUS, effort: 'medium' }])
    expect(w.prompts[0]?.context).toBeUndefined()
    const shown = lastDecision(w) as Record<string, unknown>
    expect(shown).toMatchObject({ route: 'general', action: 'kept', suggested: DB_HAIKU })
    expect(shown.contextTokens).toBeUndefined()
    const log = w.stored.filter(x => x.key === LOG_KEY).at(-1)?.value as RouteLogEntry[]
    expect(log.map(e => e.action)).toEqual(['unknown-context'])
    // The next prompt, once that request reported its usage, is decided on it.
    w.usage.context = 20_000
    await promptTurn($, 'and the views', 't2', DB_OPUS, 42)
    expect(w.sent.at(-1)).toEqual({ model: DB_OPUS, effort: 'medium' })
    await promptTurn($, 'and the indexes', 't3', DB_OPUS, 44)
    expect(w.sent.at(-1)?.model).toBe(DB_HAIKU)
  })

  test('a fresh session: the first prompt still switches at once (transcript empty, no fill yet)', async ($, on) => {
    const w = world(on, { complete: () => says('fast/low', 0.9), session: { messages: [], model: 'claude-opus-5-5' } })
    await promptTurn($, "what's 2+2", 't1', 'claude-opus-5-5', 1)
    expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
    expect(lastDecision(w)).toMatchObject({ action: 'switched', contextTokens: 0 })
  })

  test('a fresh session the engine cannot describe: the first request (one message) proves it fresh, and it switches', async ($, on) => {
    const w = world(on, { complete: () => says('fast/low', 0.9) })
    await promptTurn($, "what's 2+2", 't1', SESSION_MODEL, 1)
    expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
    expect(lastDecision(w)).toMatchObject({ action: 'switched', contextTokens: 0 })
  })

  test('the session model stands in before the first request: routed to the same model is kept, not switched', async ($, on) => {
    const w = world(on, { complete: () => says('coding/high', 0.9), session: { messages: [], model: 'claude-opus-5-5' } })
    await promptTurn($, 'Implement the parser', 't1', 'claude-opus-5-5', 1)
    expect(w.sent).toEqual([{ model: 'claude-opus-5-5', effort: 'high' }])
    expect(lastDecision(w)).toMatchObject({ action: 'kept', model: 'claude-opus-5-5' })
  })

  test('session-start after a reload: a conversation under way keeps its model for the session', { options: { profile: 'databricks', routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, { complete: () => says('fast/low', 0.95), session: { messages: UNDER_WAY, tokens: 173_000, model: DB_OPUS }, store: {} })
    await promptTurn($, 'list the tables', 't1', DB_OPUS, 40)
    await promptTurn($, 'and the views', 't2', DB_OPUS, 42)
    expect(w.sent).toEqual([
      { model: DB_OPUS, effort: 'medium' },
      { model: DB_OPUS, effort: 'medium' },
    ])
    expect(w.completions.length).toBe(1)
    const log = w.stored.filter(x => x.key === LOG_KEY).at(-1)?.value as RouteLogEntry[]
    expect(log).toMatchObject([{ action: 'kept', reason: 'resumed', from: DB_OPUS, to: DB_HAIKU, ctx: 173_000 }])
  })

  test('session-start in a fresh session still decides on the first prompt', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const w = world(on, { complete: () => says('coding/high', 0.9), session: { messages: [] } })
    await promptTurn($, 'Implement the parser', 't1', SESSION_MODEL, 1)
    await promptTurn($, 'and the tests', 't2', SESSION_MODEL, 3)
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })

  test('session-start: after a first-prompt "ok" this process saw, the next real prompt still decides', { options: { routeMainLoop: 'session-start' } }, async ($, on) => {
    const session: { messages: unknown[]; tokens: number | undefined } = { messages: [], tokens: undefined }
    const w = world(on, { complete: () => says('coding/high', 0.9), session })
    w.usage.context = 12_000
    await promptTurn($, 'ok', 't1', SESSION_MODEL, 1)
    session.messages = UNDER_WAY
    session.tokens = 12_000
    await promptTurn($, 'Implement the parser', 't2', SESSION_MODEL, 3)
    expect(w.sent).toEqual([
      { model: SESSION_MODEL, effort: 'medium' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })

  test('a /resume forgets the old conversation: the resumed one is measured before a switch', async ($, on) => {
    let n = 0
    const session: { messages: unknown[]; tokens: number | undefined; model: string } = { messages: [], tokens: undefined, model: 'claude-sonnet-5-5' }
    const w = world(on, { complete: () => says(n++ === 0 ? 'coding/high' : 'fast/low', 0.9), session })
    w.usage.context = 5_000
    await promptTurn($, 'Implement the parser', 't1', 'claude-sonnet-5-5', 1)
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    // Without the reset the 5k this process measured would let the next prompt switch.
    await $.session.end({ reason: 'resume', sessionId: 's1' } as never)
    session.messages = UNDER_WAY
    session.tokens = 300_000
    await promptTurn($, 'list the files', 't2', 'claude-sonnet-5-5', 40)
    expect(w.sent.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.sets.filter(x => x.key === 'routerLast').at(-1)?.value).toMatchObject({ action: 'hint', contextTokens: 300_000, suggested: 'claude-haiku-5-5' })
  })
})

// ---------- the decision log ----------

const logOf = (w: ReturnType<typeof world>) => (w.stored.filter(x => x.key === LOG_KEY).at(-1)?.value ?? []) as RouteLogEntry[]
const entry = (over: Partial<RouteLogEntry>): RouteLogEntry => ({ at: 1_000, session: 's', loop: 'main', action: 'switched', ...over })

describe('router: the decision log', () => {
  test('switched, kept, low-confidence and continuation are recorded, with no prompt text', { options: { delegationHint: false, routeMainLoop: 'adaptive' } }, async ($, on) => {
    const answers = [says('coding/high', 0.9), says('fast/low', 0.9), says('fast/low', 0.6)]
    let n = 0
    const w = world(on, { complete: () => answers[Math.min(n++, answers.length - 1)] as ModelCompleteResult, session: { messages: [], id: 'sess-1' }, store: {} })
    await turn($, 'Implement the secret parser', 't1')
    w.usage.context = 150_000
    // t1 reported no usage; t2's request reports 150k.
    await turn($, 'list the files please', 't2')
    await turn($, 'show me the config', 't3')
    await turn($, 'ok', 't4')
    await spawn($, 'look something up')
    const log = logOf(w)
    const cell = (route: string, difficulty: string, confidence: number) => ({ route, difficulty, confidence, backend: 'haiku' })
    const base = { at: 1_000, session: 'sess-1', loop: 'main' }
    expect(log).toEqual([
      { ...base, action: 'switched', ...cell('coding', 'high', 0.9), to: 'claude-opus-5-5', ctx: 0 },
      // t1 answered without usage and the mock transcript is empty: t2 goes on the estimate (1 token).
      { ...base, action: 'switched', ...cell('fast', 'low', 0.9), from: 'claude-opus-5-5', to: 'claude-haiku-5-5', ctx: 1 },
      { ...base, action: 'low-confidence', ...cell('fast', 'low', 0.6), from: 'claude-haiku-5-5', to: 'claude-haiku-5-5', ctx: 150_000, reason: 'confidence' },
      { ...base, action: 'continuation', from: 'claude-haiku-5-5', ctx: 150_000 },
      { ...base, loop: 'agent1', action: 'switched', ...cell('fast', 'low', 0.6), from: SESSION_MODEL, to: 'claude-haiku-5-5' },
    ])
    const text = JSON.stringify(log)
    for (const prompt of ['secret parser', 'list the files', 'show me the config', 'look something up']) expect(text).not.toContain(prompt)
  })

  test('a large context that keeps the model is logged kept (context), with the size', { options: { delegationHint: false, routeMainLoop: 'adaptive' } }, async ($, on) => {
    let n = 0
    const w = world(on, { complete: () => (n++ === 0 ? says('coding/high') : says('fast/low')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    expect(logOf(w).map(e => [e.action, e.reason, e.from, e.to, e.ctx])).toEqual([
      // the session's model, known only from the first request: the switch waited for it (no transcript in this mock)
      ['switched', undefined, SESSION_MODEL, 'claude-opus-5-5', 0],
      ['kept', 'context', 'claude-opus-5-5', 'claude-haiku-5-5', 150_000],
    ])
  })

  test('a hint, a classifier failure and a pin are logged', { options: { routeMainLoop: 'adaptive' } }, async ($, on) => {
    let n = 0
    const w = world(on, {
      complete: () => {
        n++
        if (n === 3) return { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE } as ModelCompleteResult
        return n === 1 ? says('coding/high') : says('fast/low')
      },
      store: {},
      ask: () => 'Stay on the current model',
    })
    w.usage.context = 150_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files', 't2')
    await turn($, 'and now?', 't3')
    await $.command.run(command('pin reasoning high'))
    await turn($, 'Design it', 't4')
    expect(logOf(w).map(e => [e.loop, e.action, e.reason ?? null])).toEqual([
      ['main', 'switched', null],
      ['main', 'hint', 'context'],
      ['main', 'classifier-failed', null],
      ['main', 'pinned', null],
    ])
    expect(logOf(w).at(-1)).toMatchObject({ route: 'reasoning', difficulty: 'high', to: 'claude-opus-5-5', from: 'claude-opus-5-5' })
  })

  test('the log keeps the newest 200 entries', async ($, on) => {
    const old = Array.from({ length: 200 }, (_, i) => entry({ at: i, session: 'old' }))
    const w = world(on, { complete: () => says('fast/low'), store: { [LOG_KEY]: old } })
    await turn($, "what's 2+2", 't1')
    const log = logOf(w)
    expect(log.length).toBe(200)
    expect(log[0]?.at).toBe(1)
    expect(log.at(-1)).toMatchObject({ action: 'switched', route: 'fast', at: 1_000 })
  })

  test('appended: cut to the cap, the newest last; an unreadable store reads as empty', () => {
    const many = Array.from({ length: 250 }, (_, i) => entry({ at: i }))
    const out = appended(many, entry({ at: 999 }))
    expect(out.length).toBe(200)
    expect(out[0]?.at).toBe(51)
    expect(out.at(-1)?.at).toBe(999)
    expect(appended('garbage', entry({}))).toHaveLength(1)
    expect(appended([{ nope: 1 }, entry({ at: 2 })], entry({ at: 3 })).map(e => e.at)).toEqual([2, 3])
  })

  test('decisionLog off records nothing', { options: { decisionLog: false } }, async ($, on) => {
    const w = world(on, { complete: () => says('fast/low'), store: {} })
    await turn($, "what's 2+2", 't1')
    await turn($, 'ok', 't2')
    await spawn($, 'look something up')
    expect(w.stored.filter(x => x.key === LOG_KEY)).toEqual([])
    expect(w.sent.at(0)).toEqual({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(readConfig({}).decisionLog).toBe(true)
    expect(readConfig({ decisionLog: 'no' }).decisionLog).toBe(true)
  })

  test('a store that fails changes nothing in routing', async ($, on) => {
    const w = world(on, { complete: () => says('fast/low') })
    on('store.get', async () => ({ deny: 'store unavailable' }) as never)
    await turn($, "what's 2+2", 't1')
    expect(w.sent).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }])
  })

  test('/route log prints the newest first, one line each; n caps it; clear empties it', async ($, on) => {
    const at = Date.UTC(2026, 10, 4, 12, 32)
    const seeded = [
      entry({ at: at - 60_000, loop: 'agent7', action: 'switched', route: 'coding', difficulty: 'high', confidence: 0.91, backend: 'haiku', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' }),
      entry({ at, action: 'kept', reason: 'context', route: 'general', difficulty: 'low', confidence: 0.8, backend: 'jev', from: DB_OPUS, to: DB_HAIKU, ctx: 83_000 }),
    ]
    world(on, { store: { [LOG_KEY]: seeded } })
    const run = async (args: string) => ((await $.command.run(command(args))) as { text: string }).text
    const lines = (await run('log')).split('\n')
    expect(lines).toEqual([
      'router log: newest 2 of 2, newest first',
      `${formatAt(at)} main  general/low 0.80 jev  kept (context) opus 5.5 → haiku 5.5  ctx 83k`,
      `${formatAt(at - 60_000)} agent7  coding/high 0.91 haiku  switched sonnet 5.5 → opus 5.5`,
    ])
    expect((await run('log 1')).split('\n')).toEqual(['router log: newest 1 of 2, newest first', lines[1]])
    expect(await run('log many')).toContain('/route log [n]')
    expect(await run('log clear')).toBe('router: decision log cleared.')
    expect(await run('log')).toBe('router log: empty.')
  })

  test('/route status and the command help name the log', { options: { decisionLog: false } }, async ($, on) => {
    const w = world(on, {})
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as never)
    const registered = w.registered.filter(c => c.name === 'route')
    expect(registered[0]?.description).toContain('log [n]')
    expect(registered[0]?.argumentHint).toContain('log clear')
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('decision log: off · /route log [n] shows it, /route log clear empties it')
  })

  test('formatEntry leaves out what an entry lacks; parseCount and shortModel', () => {
    const at = 0
    expect(formatEntry(entry({ at, action: 'continuation', from: 'claude-opus-5-5', ctx: 12_400 }))).toBe(`${formatAt(at)} main  continuation opus 5.5  ctx 12k`)
    expect(formatEntry(entry({ at, loop: 'spawn', action: 'classifier-failed' }))).toBe(`${formatAt(at)} spawn  classifier-failed`)
    expect(formatEntry(entry({ at, action: 'kept', reason: 'same-model', route: 'coding', difficulty: 'high', confidence: 0.9, backend: 'local', from: 'claude-opus-5-5', to: 'claude-opus-5-5' }))).toBe(
      `${formatAt(at)} main  coding/high 0.90 local  kept (same-model) opus 5.5`,
    )
    expect(formatEntry(entry({ at, action: 'pinned', route: 'fast', difficulty: 'low', to: 'claude-haiku-5-5' }))).toBe(`${formatAt(at)} main  fast/low  pinned → haiku 5.5`)
    expect([parseCount(undefined), parseCount('5'), parseCount('0'), parseCount('999'), parseCount('x')]).toEqual([20, 5, 1, 200, undefined])
    expect([shortModel('system.ai.claude-sonnet-5-5[1m]'), shortModel('qwen3.6:35b-a3b')]).toEqual(['sonnet 5.5', 'qwen3.6:35b-a3b'])
    expect(formatLog([], 20, false)).toBe('router log: empty · decisionLog is off, nothing new is recorded.')
    expect(formatAt(Date.UTC(2026, 0, 2, 3, 4))).toMatch(/^\d\d-\d\d \d\d:\d\d$/)
  })
})

// ---------------------------------------------------------------- task mode (0.7.0)

// A haiku reply for one cell, with task labels: clear (0.9) unless told otherwise.
const labelled = (cell: string, labels: Record<string, unknown> = { specified: 'clear', specifiedConfidence: 0.9 }, confidence = 0.9): ModelCompleteResult => {
  const [route, difficulty] = cell.split('/')
  return haiku(JSON.stringify({ route, confidence, difficulty, difficultyConfidence: confidence, ...labels }))
}
const VAGUE = { specified: 'vague', specifiedConfidence: 0.85 }
// Each classification answers the next of `replies` (the last one repeats).
const replies = (...rs: ModelCompleteResult[]) => {
  let n = 0
  return { complete: () => rs[Math.min(n++, rs.length - 1)] as ModelCompleteResult }
}
const taskLog = (w: ReturnType<typeof world>) => (w.stored.filter(x => x.key === LOG_KEY).at(-1)?.value as RouteLogEntry[] | undefined) ?? []
const lastShown = (w: ReturnType<typeof world>) => w.sets.filter(x => x.key === 'routerLast').at(-1)?.value as Record<string, unknown> | undefined
// A compacted transcript: the summary as one message.
const SUMMARY = [{ role: 'user', text: 'summary of the conversation', toolUses: [] }]
const DIRECTIVE_150K =
  'NEXUS router: this request was classified reasoning/high (0.90) and needs a stronger model than claude-sonnet-5-5. ' +
  'Switching now would drop the 150k-token cache. ' +
  'Delegate the hard part to the `nexus:frontier` subagent (Agent tool, a self-contained brief), then check and integrate its result. ' +
  'For a short second opinion instead, call the `consult` tool.'

describe('router: task mode (pure)', () => {
  test('the escalation directive: one paragraph, the cell, the kept model, the cache size, the agent and the tool', () => {
    const text = escalationDirective({ route: 'reasoning', difficulty: 'high', confidence: 0.9, current: 'claude-sonnet-5-5', contextTokens: 150_000, hasConsult: true })
    expect(text).toBe(DIRECTIVE_150K)
    expect(text).not.toContain('\n')
    // consultMax 0: the consult tool is not registered, so it is not offered
    const noConsult = escalationDirective({ route: 'coding', difficulty: 'high', confidence: 0.8, current: undefined, contextTokens: undefined, hasConsult: false })
    expect(noConsult).toBe(
      'NEXUS router: this request was classified coding/high (0.80) and needs a stronger model than its current model. Switching now would drop the prompt cache. ' +
        'Delegate the hard part to the `nexus:frontier` subagent (Agent tool, a self-contained brief), then check and integrate its result.',
    )
  })

  test('a clear prompt: specified=clear at minConfidence, or a snippet or traceback; no labels counts as clear', () => {
    expect(isClearPrompt(undefined, 0.6)).toBe(true)
    expect(isClearPrompt({ specified: 'clear', specifiedConfidence: 0.7 }, 0.6)).toBe(true)
    expect(isClearPrompt({ specified: 'clear', specifiedConfidence: 0.5 }, 0.6)).toBe(false)
    expect(isClearPrompt({ specified: 'clear' }, 0.6)).toBe(true)
    expect(isClearPrompt({ specified: 'vague', specifiedConfidence: 0.9 }, 0.6)).toBe(false)
    expect(isClearPrompt({ specified: 'vague', evidence: 'traceback' }, 0.6)).toBe(true)
    expect(isClearPrompt({ specified: 'vague', evidence: 'snippet' }, 0.6)).toBe(true)
    expect(isClearPrompt({ specified: 'vague', evidence: 'reference' }, 0.6)).toBe(false)
    expect(isClearPrompt({ scope: 'local' }, 0.6)).toBe(true)
  })

  test('escalateConfigOf: the parsed settings and the frontier model', () => {
    expect(escalateConfigOf(createRouter({} as never))).toEqual({ escalation: true, consultMax: 5, frontierModel: 'claude-opus-5-5', decisionLog: true })
    expect(escalateConfigOf(createRouter({ profile: 'databricks', escalation: false, consultMax: 0 } as never))).toEqual({ escalation: false, consultMax: 0, frontierModel: DB_OPUS, decisionLog: true })
    expect(escalateConfigOf(createRouter({ routes: '{"reasoning":"claude-fable-1"}' } as never)).frontierModel).toBe('claude-fable-1')
  })
})

describe('router: task mode (the default)', () => {
  test('a vague prompt keeps the model and commits nothing; the next clear one switches and commits', async ($, on) => {
    const w = world(on, { ...replies(labelled('coding/high', VAGUE), labelled('coding/high')), store: {} })
    await turn($, 'make it better', 't1')
    expect(w.sent).toEqual(UNCHANGED)
    expect(lastShown(w)).toMatchObject({ action: 'vague', labels: VAGUE })
    expect(lastShown(w)?.committed).toBeUndefined()
    await turn($, 'Implement the retry policy in the HTTP client', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(lastShown(w)).toMatchObject({ action: 'switched', committed: true, labels: { specified: 'clear', specifiedConfidence: 0.9 } })
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['vague', 'switched'])
    expect(log[0]).toMatchObject({ route: 'coding', difficulty: 'high', labels: VAGUE })
    expect(log[0]?.committed).toBeUndefined()
    expect(log[1]).toMatchObject({ committed: true, to: 'claude-opus-5-5', labels: { specified: 'clear' } })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('main loop task (switch at conf ≥ 0.75, ctx ≤ 50k, hint, escalation to claude-opus-5-5, cache ttl 5 min) · committed claude-opus-5-5')
  })

  test('a vague prompt with a traceback counts as clear', async ($, on) => {
    const w = world(on, replies(labelled('coding/medium', { ...VAGUE, evidence: 'traceback' })))
    await turn($, 'TypeError: x is undefined at foo.ts:12', 't1')
    expect(w.sent).toEqual([{ model: 'claude-sonnet-5-5', effort: 'high' }])
    expect(lastShown(w)).toMatchObject({ action: 'switched', committed: true })
  })

  test('a clear prompt kept on low confidence still commits the model that runs', async ($, on) => {
    const w = world(on, { ...replies(labelled('fast/low', undefined, 0.65), labelled('reasoning/high')), store: {} })
    await turn($, 'list the files in src', 't1')
    expect(w.sent).toEqual(UNCHANGED)
    expect(lastShown(w)).toMatchObject({ action: 'kept', committed: true })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain(`· committed ${SESSION_MODEL}`)
  })

  test('committed, a heavier route with a large context: kept, escalated, the directive attached', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff of the billing module', 't1')
    await turn($, 'Now design the sharding scheme for the ledger', 't2')
    expect(w.sent).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'medium' },
      { model: 'claude-sonnet-5-5', effort: 'medium' },
    ])
    expect(w.prompts[0]?.context).toBeUndefined()
    expect(w.prompts[1]?.context).toEqual([DIRECTIVE_150K])
    expect(w.prompts[1]?.text).toBe('Now design the sharding scheme for the ledger')
    expect(lastShown(w)).toMatchObject({ route: 'reasoning', difficulty: 'high', model: 'claude-sonnet-5-5', action: 'escalated', suggested: 'claude-opus-5-5', contextTokens: 150_000 })
    expect(lastShown(w)?.committed).toBeUndefined()
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['switched', 'escalated'])
    expect(log[1]).toMatchObject({ from: 'claude-sonnet-5-5', to: 'claude-opus-5-5', reason: 'context', ctx: 150_000 })
    expect(JSON.stringify(log)).not.toContain('sharding')
  })

  test('escalation off: kept plainly, no directive', { options: { escalation: false } }, async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.prompts[1]?.context).toBeUndefined()
    expect(lastShown(w)).toMatchObject({ action: 'kept', suggested: 'claude-opus-5-5' })
    expect(taskLog(w).at(-1)).toMatchObject({ action: 'kept', reason: 'context' })
  })

  test('committed, a heavier route with a small context: switches and re-commits', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 20_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.prompts[1]?.context).toBeUndefined()
    expect(lastShown(w)).toMatchObject({ action: 'switched', committed: true, contextTokens: 20_000 })
    expect(taskLog(w).at(-1)).toMatchObject({ action: 'switched', committed: true, from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· committed claude-opus-5-5')
  })

  test('committed, a lighter route: the model is kept (with the delegation hint), even with a small context', async ($, on) => {
    const w = world(on, { ...replies(labelled('coding/high'), labelled('fast/low')), store: {} })
    w.usage.context = 5_000
    await turn($, 'Implement the feature', 't1')
    await turn($, 'list the files you changed', 't2')
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
    expect(w.prompts[1]?.context?.[0]).toContain('NEXUS routes the subagent to claude-haiku-5-5')
    expect(lastShown(w)).toMatchObject({ action: 'hint', model: 'claude-opus-5-5', suggested: 'claude-haiku-5-5' })
    expect(taskLog(w).at(-1)).toMatchObject({ action: 'hint', reason: 'committed' })
  })

  test('committed, a vague-labelled follow-up is judged like any other: heavier and confident, it escalates', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high', VAGUE)), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'hmm, what now', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.prompts[1]?.context?.[0]).toContain('nexus:frontier')
    expect(taskLog(w).map(e => e.action)).toEqual(['switched', 'escalated'])
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· committed claude-sonnet-5-5')
  })

  test('not committed, a vague prompt in a conversation past switchMaxContext counts as clear (its follow-ups are not self-contained)', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium', VAGUE), labelled('general/medium', VAGUE)), store: {} })
    w.usage.context = 150_000
    await turn($, 'ok let us start', 't1')
    expect(taskLog(w).map(e => e.action)).toEqual(['vague'])
    await turn($, 'it is still vague despite the last prompt', 't2')
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['vague', 'hint'])
    expect(log[1]).toMatchObject({ committed: true })
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· committed ')
  })

  test('labels off: every classified prompt is clear (adaptive plus escalation)', { options: { labels: false } }, async ($, on) => {
    const w = world(on, replies(labelled('general/medium', VAGUE), labelled('reasoning/high', VAGUE)))
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await turn($, 'Now design it', 't2')
    expect(w.sent[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(w.prompts[1]?.context).toEqual([DIRECTIVE_150K])
    expect(lastShown(w)?.labels).toBeUndefined()
    expect((w.completions[0] as ModelCompleteInput).system).not.toContain('"specified"')
  })

  test('an idle gap past cacheTtlMinutes drops the commitment; the next clear prompt switches whatever the size', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await w.clock.advance(6 * 60 * 1000)
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    expect(w.prompts[1]?.context).toBeUndefined()
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['switched', 'rerouted', 'switched'])
    expect(log[1]).toMatchObject({ loop: 'main', reason: 'idle', from: 'claude-sonnet-5-5', ctx: 150_000 })
    expect(log[2]).toMatchObject({ committed: true, ctx: 150_000 })
  })

  test('within cacheTtlMinutes the commitment holds (escalated); a 60-minute TTL holds it longer', { options: { cacheTtlMinutes: 60 } }, async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await w.clock.advance(30 * 60 * 1000)
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(taskLog(w).map(e => e.action)).toEqual(['switched', 'escalated'])
  })

  test('the window guard stays after an idle re-route', { options: { profile: 'databricks', chain: 'haiku' } }, async ($, on) => {
    // sonnet[1m] at 300k: an idle re-route lifts switchMaxContext, not haiku's 200k window
    const w = world(on, { ...replies(labelled('general/medium'), labelled('fast/low')), store: {} })
    w.usage.context = 300_000
    await turn($, 'Review this diff', 't1')
    await w.clock.advance(10 * 60 * 1000)
    await turn($, 'what is 2+2', 't2')
    expect(w.sent.at(-1)).toEqual({ model: DB_SONNET, effort: 'medium' })
    expect(taskLog(w).map(e => e.action)).toEqual(['switched', 'rerouted', 'hint'])
    expect(taskLog(w).at(-1)).toMatchObject({ reason: 'window', committed: true })
  })

  test('a compaction drops the commitment: logged rerouted (compact), the compacted size is used, the guard lifted', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    on('session.compact', async () => ({ messages: SUMMARY as never, tokensBefore: 150_000, tokensAfter: 60_000 }))
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
    w.usage.context = 61_000
    await turn($, 'Now design the sharding scheme', 't2')
    // 60k is past switchMaxContext (50k), but the cache is cold: the clear prompt switches
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['switched', 'rerouted', 'switched'])
    expect(log[1]).toMatchObject({ reason: 'compact', from: 'claude-sonnet-5-5' })
    expect(log[2]).toMatchObject({ ctx: 60_000, committed: true })
  })

  test("a subagent's compaction or a skipped one changes nothing", async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    let n = 0
    on('session.compact', async () => (n++ === 0 ? { messages: SUMMARY as never } : { skip: 'vetoed' }))
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await $.session.compact({ trigger: 'auto', agentId: 'agent9', messages: SUMMARY } as never)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY } as never)
    await turn($, 'Now design the sharding scheme', 't2')
    expect(taskLog(w).map(e => e.action)).toEqual(['switched', 'escalated'])
  })

  test('a /clear drops the commitment (rerouted, clear); the next clear prompt commits afresh', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium'), labelled('reasoning/high')), store: {} })
    w.usage.context = 150_000
    await turn($, 'Review this diff', 't1')
    await $.session.end({ reason: 'clear', sessionId: 's1' } as never)
    await turn($, 'Now design the sharding scheme', 't2')
    expect(w.sent.at(-1)).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
    const log = taskLog(w)
    expect(log.map(e => e.action)).toEqual(['switched', 'rerouted', 'switched'])
    expect(log[1]).toMatchObject({ reason: 'clear', from: 'claude-sonnet-5-5' })
    expect(log[2]).toMatchObject({ committed: true })
  })

  test('a resume drops the commitment (rerouted, resume)', async ($, on) => {
    const w = world(on, { ...replies(labelled('general/medium')), store: {} })
    await turn($, 'Review this diff', 't1')
    await $.session.end({ reason: 'resume', sessionId: 's1' } as never)
    expect(taskLog(w).map(e => [e.action, e.reason])).toEqual([
      ['switched', undefined],
      ['rerouted', 'resume'],
    ])
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· not committed')
  })

  test('a continuation neither classifies nor commits', async ($, on) => {
    const w = world(on, { ...replies(labelled('coding/high')), store: {} })
    await turn($, 'ok', 't1')
    expect(w.completions.length).toBe(0)
    const { text } = (await $.command.run(command('status'))) as { text: string }
    expect(text).toContain('· not committed')
  })
})

describe('router: the nexus:frontier subagent', () => {
  const frontier = ($: Engine, prompt = 'design the sharding scheme') =>
    $.agent.spawn({
      prompt,
      description: 'hard part',
      subagentType: 'nexus:frontier',
      tool_use_id: 'toolu_frontier',
      provider: { plugin: 'nexus', tier: 'plugin' },
      parentModel: 'claude-sonnet-5-5',
      background: false,
      fork: false,
    } as never) as Promise<{ model: string; agentId?: string }>

  test('spawned on the frontier model at effort high, never classified; logged escalated', async ($, on) => {
    const w = world(on, { complete: () => labelled('fast/low'), store: {} })
    const s = await frontier($)
    expect(s.model).toBe('claude-opus-5-5')
    expect(w.completions.length).toBe(0)
    expect(lastShown(w)).toMatchObject({ loop: 'agent1', route: 'reasoning', difficulty: 'high', model: 'claude-opus-5-5', effort: 'high', confidence: 1 })
    expect(taskLog(w)).toEqual([
      { at: 1_000, session: '', loop: 'agent1', action: 'escalated', route: 'reasoning', difficulty: 'high', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5', reason: 'frontier' },
    ])
    // Its turns (the first and a later one with text) stay on the frontier model, unclassified.
    await $.turn.start({ text: 'the brief', turnId: 'f1', agentId: 'agent1' })
    await drain($.turn.step({ turnId: 'f1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1, agentId: 'agent1' }))
    await $.turn.start({ text: 'a follow-up message', turnId: 'f2', agentId: 'agent1' })
    await drain($.turn.step({ turnId: 'f2', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 3, agentId: 'agent1' }))
    expect(w.completions.length).toBe(0)
    expect(w.sent).toEqual([
      { model: 'claude-opus-5-5', effort: 'high' },
      { model: 'claude-opus-5-5', effort: 'high' },
    ])
  })

  test('the databricks profile spawns it on the gateway opus; another subagent is still classified', { options: { profile: 'databricks', chain: 'haiku' } }, async ($, on) => {
    const w = world(on, { complete: () => labelled('fast/low') })
    expect((await frontier($)).model).toBe(DB_OPUS)
    expect((await spawn($, 'look something up')).model).toBe(DB_HAIKU)
    expect(w.completions.length).toBe(1)
  })
})
