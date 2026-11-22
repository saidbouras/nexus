// The router and the HUD in the one plugin: each shared event (session.start,
// turn.start, turn.step, agent.spawn) has one hook, in hooks/register.tsx,
// that runs the router's part, then `next`, then the HUD's. The router's own
// prompt.submit hook classifies each main-loop prompt before its turn.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, PromptSubmitInput } from 'claude-code'

import type { Loop, ModelUse, RouteMark, Step } from '../types'

const SESSION_MODEL = 'session-model'
const HAIKU = 'claude-haiku-5-5'
const OPUS = 'claude-opus-5-5'
const USAGE = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
// A haiku reply for one cell of the route matrix, `reasoning/high`.
const haiku = (cell: string): ModelCompleteResult => {
  const [route, difficulty] = cell.split('/')
  return { isAnswered: true, text: JSON.stringify({ route, confidence: 0.9, difficulty, difficultyConfidence: 0.9 }), usage: USAGE }
}

const LOOPS = { plugin: 'nexus', key: 'loops' } as const
const STEPS = { plugin: 'nexus', key: 'steps' } as const
const MODELS = { plugin: 'nexus', key: 'models' } as const
const ROUTES = { plugin: 'nexus', key: 'routes' } as const

type World = {
  /** Each model request as the engine received it. */
  sent: { model: string; effort?: unknown; agentId?: string }[]
  /** Each spawn as the engine received it. */
  spawned: { model?: string }[]
  /** routerLast writes as they reached the state. */
  lastSets: unknown[]
  /** The latest value the plugin wrote to each of its state keys. */
  latest: Record<string, unknown>
  /** Commands the plugin registered. */
  registered: string[]
  /** Each prompt as it reached the engine, hidden context included. */
  prompts: PromptSubmitInput[]
  /** The context (tokens) each main-loop step reports in its usage; null: no usage. */
  context: number | null
  clock: ReturnType<typeof mock.clock>
}

/**
 * The engine beneath the plugin: haiku answers the cell `route` (`fast/low`; or
 * each call the next of `route()`; the only classifier
 * reachable: jev unconfigured, Ollama down), and the bottom records what each
 * request and spawn was sent with.
 */
function world(on: On, route: string | (() => string), opts: { failRouterState?: boolean; failHudState?: boolean } = {}): World {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, {})
  mock.store(on)
  const w: World = { sent: [], spawned: [], lastSets: [], latest: {}, registered: [], prompts: [], context: null, clock }
  on('http.fetch', async () => ({ deny: 'no network in this test' }))
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.complete', async () => ({ value: haiku(typeof route === 'string' ? route : route()) }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('command.register', async (_$, e) => (w.registered.push(e.name), { value: { command: e.name } }))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'routerLast') w.lastSets.push(e.value)
    const result = await next(e)
    w.latest[String(e.key)] = e.value
    return result
  })
  if (opts.failRouterState) {
    // The router's own state read fails: its part throws where it is not guarded itself.
    on('state.get', { plugin: 'nexus', key: 'routerEnabled' }, async () => {
      return { deny: 'router state unavailable' } as never
    })
  }
  if (opts.failHudState) {
    on('state.get', { plugin: 'nexus', key: 'loops' }, async () => {
      return { deny: 'hud state unavailable' } as never
    })
    on('state.get', { plugin: 'nexus', key: 'steps' }, async () => {
      return { deny: 'hud state unavailable' } as never
    })
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', async (_$, e) => (w.prompts.push(e), { text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    w.sent.push({ model: e.model, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    const usage =
      w.context === null ? null : { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: w.context - 600, cache_creation_input_tokens: 100, model: e.model }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  let n = 0
  on('agent.spawn', async (_$, e) => {
    w.spawned.push({ model: e.model })
    return { model: e.model ?? SESSION_MODEL, agentId: `agent${++n}` }
  })
  return w
}

async function drain(stream: AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }) {
  for await (const _chunk of stream) {
    // read to the end
  }
  return stream.result
}

// A main-loop turn starts with the user's prompt; a subagent's has none.
async function turn($: Engine, text: string, turnId: string, agentId?: string) {
  if (!agentId) await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text, turnId, ...(agentId ? { agentId } : {}) })
  await drain($.turn.step({ turnId, index: 0, model: SESSION_MODEL, effort: 'medium', messageCount: 1, ...(agentId ? { agentId } : {}) }))
}

const spawn = ($: Engine, prompt: string) =>
  $.agent.spawn({
    prompt,
    description: 'look it up',
    subagentType: 'Explore',
    tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: SESSION_MODEL,
    background: false,
    fork: false,
  } as never) as Promise<{ model: string; agentId?: string }>

const route = (args: string) =>
  ({ command: 'route', args, origin: { kind: 'user' }, presentation: { isFullscreen: false, columns: 120 } }) as never

const held = <T>(w: World, ref: { plugin: 'nexus'; key: string }): T | undefined => w.latest[ref.key] as T | undefined

describe('router + HUD: one hook per shared event', () => {
  test('a subagent spawn is routed by the router and recorded by the HUD with the routed model', async ($, on) => {
    const w = world(on, 'fast/low')
    const s = await spawn($, 'find the config loader')
    expect(s).toMatchObject({ model: HAIKU, agentId: 'agent1' })
    expect(w.spawned).toEqual([{ model: HAIKU }])

    await turn($, 'sub', 'ts1', 'agent1')
    // The subagent's request goes out on the spawn's decision.
    expect(w.sent).toEqual([{ model: HAIKU, effort: 'low', agentId: 'agent1' }])

    const loops = (held<Loop[]>(w, LOOPS)) ?? []
    const loop = loops.find(l => l.id === 'agent1')
    expect(loop).toBeDefined()
    expect(loop!.model).toBe(HAIKU)
    expect(loop!.subagentType).toBe('Explore')
    expect(loop!.label).toBe('look it up')
    expect(loop!.steps).toBe(1)
    expect(loop!.turns).toBe(1)
    const steps = (held<Step[]>(w, STEPS)) ?? []
    expect(steps.map(x => [x.loop, x.model])).toEqual([['agent1', HAIKU]])
    const models = (held<ModelUse[]>(w, MODELS)) ?? []
    expect(models.map(m => m.model)).toEqual([HAIKU])
  })

  test('the main loop: the HUD records the model the router sent, not the session model', async ($, on) => {
    const w = world(on, 'reasoning/high')
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await turn($, 'Design the schema', 't1')
    expect(w.sent).toEqual([{ model: OPUS, effort: 'high' }])
    const loops = (held<Loop[]>(w, LOOPS)) ?? []
    expect(loops.find(l => l.id === 'main')?.model).toBe(OPUS)
    const steps = (held<Step[]>(w, STEPS)) ?? []
    expect(steps.map(x => x.model)).toEqual([OPUS])
  })

  test('a router failure sends each request as the engine had it, and the HUD still records', async ($, on) => {
    const w = world(on, 'reasoning/high', { failRouterState: true })
    await turn($, 'Design the schema', 't1')
    expect(w.sent).toEqual([{ model: SESSION_MODEL, effort: 'medium' }])
    const s = await spawn($, 'find it')
    expect(s.model).toBe(SESSION_MODEL)
    expect(w.spawned).toEqual([{ model: undefined }])
    const loops = (held<Loop[]>(w, LOOPS)) ?? []
    const main = loops.find(l => l.id === 'main')
    expect(main).toMatchObject({ status: 'running', turns: 1, steps: 1, model: SESSION_MODEL })
    expect(loops.find(l => l.id === 'agent1')).toMatchObject({ subagentType: 'Explore', model: SESSION_MODEL })
    // The router's part did fail: no decision was made or published.
    expect(w.lastSets).toEqual([])
  })

  test('a HUD failure does not change routing', async ($, on) => {
    const w = world(on, 'fast/low', { failHudState: true })
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await turn($, "what's 2+2", 't1')
    expect(w.sent).toEqual([{ model: HAIKU, effort: 'low' }])
    const s = await spawn($, 'look something up')
    expect(s.model).toBe(HAIKU)
    expect(w.spawned).toEqual([{ model: HAIKU }])
    await turn($, 'sub', 'ts1', 'agent1')
    expect(w.sent.at(-1)).toEqual({ model: HAIKU, effort: 'low', agentId: 'agent1' })
    // The HUD's part did fail: it could not read, so it wrote no loop and no step.
    expect(w.latest.loops).toBeUndefined()
    expect(w.latest.steps).toBeUndefined()
    // The router's decisions were published all the same.
    expect(w.lastSets).toHaveLength(2)
  })

  test("the router's routerLast writes still feed the HUD's route trail", async ($, on) => {
    const w = world(on, 'coding/high')
    await turn($, 'Write the code', 't1')
    await w.clock.advance(1_000)
    await spawn($, 'write the tests')
    expect(w.lastSets).toHaveLength(2)
    expect(w.lastSets).toEqual([expect.objectContaining({ route: 'coding', difficulty: 'high' }), expect.objectContaining({ route: 'coding', difficulty: 'high' })])
    const trail = (held<RouteMark[]>(w, ROUTES)) ?? []
    expect(trail.map(m => [m.loop, m.route, m.model])).toEqual([
      ['main', 'coding', OPUS],
      ['agent1', 'coding', OPUS],
    ])
  })

  test('/route off: the HUD still records, the requests go out unrouted', async ($, on) => {
    const w = world(on, 'fast/low')
    await $.command.run(route('off'))
    await turn($, "what's 2+2", 't1')
    const s = await spawn($, 'look')
    expect(w.sent).toEqual([{ model: SESSION_MODEL, effort: 'medium' }])
    expect(s.model).toBe(SESSION_MODEL)
    const loops = (held<Loop[]>(w, LOOPS)) ?? []
    expect(loops.find(l => l.id === 'main')).toMatchObject({ steps: 1, model: SESSION_MODEL })
    expect(loops.find(l => l.id === 'agent1')).toBeDefined()
  })

  // Haiku's cells in order, one per classified prompt.
  const answers = (...routes: string[]) => {
    let n = 0
    return () => routes[Math.min(n++, routes.length - 1)] as string
  }

  test("a turn.step's usage is the context the next prompt's decision sees", { options: { routeMainLoop: 'adaptive' } }, async ($, on) => {
    const w = world(on, answers('reasoning/high', 'fast/low', 'reasoning/high', 'fast/low'))
    w.context = 20_000
    await turn($, 'Design the schema', 't1')
    await turn($, 'list the tables', 't2')
    // t1 reported 20k, under switchMaxContext: switched to haiku.
    expect(w.lastSets.at(-1)).toMatchObject({ route: 'fast', model: HAIKU, action: 'switched', contextTokens: 20_000 })
    w.context = 180_000
    await turn($, 'Design the indexes', 't3')
    // t2 still reported 20k: switched back to opus. t3 reports 180k.
    expect(w.lastSets.at(-1)).toMatchObject({ route: 'reasoning', model: OPUS, action: 'switched', contextTokens: 20_000 })
    await turn($, 'list them', 't4')
    expect(w.lastSets.at(-1)).toMatchObject({ route: 'fast', model: OPUS, action: 'hint', contextTokens: 180_000, suggested: HAIKU })
    expect(w.sent.map(x => x.model)).toEqual([OPUS, HAIKU, OPUS, OPUS])
  })

  test('a kept model and its hint reach the prompt and the HUD trail', async ($, on) => {
    const w = world(on, answers('reasoning/high', 'fast/low'))
    w.context = 180_000
    await turn($, 'Design the schema', 't1')
    await turn($, 'list the tables', 't2')
    expect(w.sent.map(x => x.model)).toEqual([OPUS, OPUS])
    expect(w.prompts[0]?.context).toBeUndefined()
    expect(w.prompts[1]?.context?.[0]).toContain('to keep its 180k-token cache')
    const trail = (held<RouteMark[]>(w, ROUTES)) ?? []
    expect(trail.at(-1)).toMatchObject({ loop: 'main', action: 'hint', suggested: HAIKU, contextTokens: 180_000 })
  })

  test('a router failure in prompt.submit lets the prompt through unchanged', async ($, on) => {
    const w = world(on, 'reasoning/high', { failRouterState: true })
    await $.prompt.submit({ text: 'Design the schema', wait: false, origin: { kind: 'composer' } })
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toMatchObject({ text: 'Design the schema', origin: { kind: 'composer' } })
    expect(w.prompts[0]?.context).toBeUndefined()
    expect(w.lastSets).toEqual([])
  })

  test('after a reload mid-conversation (173k) the first prompt does not switch opus to haiku', async ($, on) => {
    const w = world(on, 'fast/low')
    // A new process, a conversation under way: the router has seen no request of it.
    on('session.messages', async () => ({
      value: [
        { role: 'user', content: [{ type: 'text', text: 'Design the schema' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      ] as never,
    }))
    on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 173_000, window: 1_000_000 }, rateLimits: [] } }))
    on('session.model', async () => ({ value: OPUS }))
    await $.prompt.submit({ text: 'list the tables', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'list the tables', turnId: 't1' })
    await drain($.turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'high', messageCount: 40 }))
    expect(w.sent).toEqual([{ model: OPUS, effort: 'high' }])
    expect(w.lastSets.at(-1)).toMatchObject({ route: 'fast', model: OPUS, action: 'hint', contextTokens: 173_000, suggested: HAIKU })
    const trail = (held<RouteMark[]>(w, ROUTES)) ?? []
    expect(trail.at(-1)).toMatchObject({ loop: 'main', action: 'hint', contextTokens: 173_000 })
  })

  test('the decision log records the main loop and a spawn; /route log prints them newest first', async ($, on) => {
    const w = world(on, answers('reasoning/high', 'fast/low'))
    await turn($, 'Design the schema', 't1')
    await spawn($, 'find the config loader')
    const { text } = (await $.command.run(route('log'))) as { text: string }
    const lines = text.split('\n')
    expect(lines[0]).toBe('router log: newest 2 of 2, newest first')
    expect(lines[1]).toMatch(/^\d\d-\d\d \d\d:\d\d agent1  fast\/low 0\.90 haiku  switched session-model → haiku 5\.5$/)
    // task (the default): the first clear prompt commits the model, marked `commit`
    expect(lines[2]).toMatch(/^\d\d-\d\d \d\d:\d\d main  reasoning\/high 0\.90 haiku  switched session-model → opus 5\.5  commit  ctx 0$/)
    expect(text).not.toContain('Design the schema')
    expect(text).not.toContain('config loader')
    expect(((await $.command.run(route('log clear'))) as { text: string }).text).toBe('router: decision log cleared.')
    expect(((await $.command.run(route('log'))) as { text: string }).text).toBe('router log: empty.')
    expect(w.sent).toEqual([{ model: OPUS, effort: 'high' }])
  })

  test('session.start registers /route, /workflow and /nexus in one hook', async ($, on) => {
    const w = world(on, 'fast/low')
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect([...w.registered].sort()).toEqual(['nexus', 'route', 'workflow'])
  })
})
