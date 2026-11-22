import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { chartLayout } from './dash'
import { hbar, palette, pushRoute } from './hud'
import { snapshot } from './snapshot'
import type { RouteBackend, RouteDifficulty, RouteMark } from '../../types'

// The test runtime has a console; the hooks module's environment does not.
declare const console: { log: (...args: unknown[]) => void }

const close = (got: unknown, want: number) =>
  expect(typeof got === 'number' && Math.abs(got - want) < 1e-9, `${String(got)} ≈ ${want}`).toBe(true)

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const PANE = {
  component: 'Pane',
  requestId: 'workflow',
  props: {
    title: 'NEXUS',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 120, rows: 40 },
} as const

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }

// Per loop: the usage every one of its steps answers with.
const USAGE: Record<string, Usage> = {
  main: { input: 10_000, output: 2_000, cacheRead: 50_000, cacheWrite: 4_000, model: 'system.ai.claude-opus-5-5[1m]' },
  a1: { input: 2_000, output: 500, cacheRead: 10_000, cacheWrite: 1_000, model: 'databricks-claude-haiku-4-5' },
  a2: { input: 3_000, output: 1_000, cacheRead: 0, cacheWrite: 0, model: 'system.ai.claude-sonnet-5-5' },
  a3: { input: 4_000, output: 800, cacheRead: 0, cacheWrite: 0, model: 'qwen3.6:35b-a3b' },
}
// With the default prices: main 6 × $0.11, a1 2 × $0.00675, a2 1 × $0.016, a3 unknown.
const SPEND = 6 * 0.11 + 2 * 0.00675 + 0.016

/**
 * The engine beneath the plugin, and a session: main (6 steps, 6 tools), 3 subagents.
 * A later tool call whose tool_use_id starts with `held-` runs until `held` settles.
 */
const drive = async ($: Engine, on: On, held?: Promise<void>) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('ui.status', async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.close', async () => ({ value: undefined }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  let n = 0
  on('agent.spawn', async () => ({ model: 'x', agentId: `a${++n}` }))
  on('turn.step', async function* (_$, e) {
    const u = USAGE[e.agentId ?? 'main']!
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_read_input_tokens: u.cacheRead,
        cache_creation_input_tokens: u.cacheWrite,
        model: u.model,
      },
    }
  })
  on('tool.call', async (_$, e) => {
    if (held !== undefined && String(e.tool_use_id).startsWith('held-')) {
      await held
    }
    await clock.advance(1_200)
    return { result: { ok: true } as never, text: 'ok' }
  })
  const drain = async (stream: AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }) => {
    for await (const _chunk of stream) {
      // read to the end
    }
    return stream.result
  }
  const step = async (agentId: string | undefined, index: number) => {
    await clock.advance(5_000)
    const model = USAGE[agentId ?? 'main']!.model
    await drain(
      $.turn.step({ turnId: agentId ?? 't0', index, model, messageCount: 1, ...(agentId ? { agentId } : {}) }),
    )
  }

  await $.turn.start({ text: 'go', turnId: 't0' })
  for (let i = 0; i < 6; i++) {
    await step(undefined, i)
    await $.tool.call({
      tool: i % 2 ? 'Read' : 'Bash',
      ...(i % 2 ? { file_path: '/tmp/x' } : { command: 'ls' }),
    } as never)
  }
  for (const [d, type] of [
    ['Scan repo', 'Explore'],
    ['Write tests', 'general-purpose'],
    ['Local summary', 'general-purpose'],
  ] as const) {
    await $.agent.spawn({
      tool_use_id: d,
      prompt: d,
      description: d,
      subagentType: type,
      provider: { plugin: 'test', tier: 'user' },
      parentModel: 'system.ai.claude-opus-5-5[1m]',
      background: true,
      fork: false,
    })
  }
  for (const [id, count] of [
    ['a1', 2],
    ['a2', 1],
    ['a3', 1],
  ] as const) {
    await $.turn.start({ text: 'sub', turnId: id, agentId: id })
    for (let i = 0; i < count; i++) {
      await step(id, i)
    }
  }
  await $.turn.complete({
    answer: 'done',
    durationMs: 9_000,
    isAborted: false,
    turnId: 'a1',
    agentId: 'a1',
    reason: 'answer',
  })
  return clock
}

const mountBand = ($: Engine, bodyColumns: number, maxRows = 10) =>
  $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns, maxRows } })
type Findable = { find: (q: { key: string }) => Promise<{ text: string } | undefined> }
const textOf = async (ui: Findable, key: string) => (await ui.find({ key }))?.text

test('band at 80, 120 and 200 columns: KPIs, table, chart, spend', async ($, on) => {
  await drive($, on)
  const total = 6 * (10_000 + 4_000 + 2_000) + 2 * 3_500 + 4_000 + 4_800

  for (const cols of [80, 120, 200] as const) {
    const W = cols - 1
    const ui = await mountBand($, cols)
    const lines = snapshot(await ui.drawn())
    if (cols !== 80) {
      console.log(`\n── band at ${cols} columns ──\n${lines.join('\n')}`)
    }
    // Every line is exactly the band's width.
    expect(lines.length).toBeLessThanOrEqual(10)
    for (const l of lines) {
      expect(l.length).toBe(W)
    }

    // KPI tiles: six, Spend included (default prices), labels in place
    for (const id of ['tokens', 'steps', 'cache', 'agents', 'tools', 'spend']) {
      expect(await ui.find({ key: `kpi-label-${id}` })).toBeDefined()
    }
    expect(await textOf(ui, 'kpi-label-steps')).toMatch(/^STEPS/)
    expect((await textOf(ui, 'kpi-steps'))?.trim()).toBe('10')
    expect((await textOf(ui, 'kpi-spend'))?.trim()).toBe('$0.69')
    expect((await textOf(ui, 'kpi-agents'))?.trim()).toMatch(/^2 ?\/ ?3$/)
    // TOOLS: none runs, so the latest finished names; the counts where no name fits
    if (cols === 80) {
      expect(await textOf(ui, 'kpi-label-tools')).toMatch(/^TOOLS +$/)
      expect((await textOf(ui, 'kpi-tools'))?.trim()).toBe('0 / 6')
    } else {
      expect((await textOf(ui, 'kpi-label-tools'))?.trim()).toBe('TOOLS · 6 runs')
      expect((await textOf(ui, 'kpi-tools'))?.trim()).toBe('last Read · Bash')
      // idle: muted, not bold
      const idle = await ui.find({ type: 'Text', text: (await textOf(ui, 'kpi-tools'))! })
      expect(idle?.props.bold).toBeUndefined()
      expect(idle?.props.color).toBeDefined()
    }

    // Chart: 3 rows, the body as wide as the layout says, a legend with ■
    const lay = chartLayout(W)
    for (let r = 0; r < 3; r++) {
      expect((await textOf(ui, `chart-body-${r}`))?.length).toBe(lay.body)
    }
    expect(await ui.find({ key: 'chart-row-3' })).toBeUndefined()
    expect(await textOf(ui, 'legend-0')).toMatch(/^■ main( session|…| se…) +\d/)

    // Table: right-aligned numbers end on one column: every row is W wide and
    // each numeric cell has one width with no trailing space.
    const ids = ['main', 'a2', 'a3'].filter(Boolean)
    const tokenCells = await Promise.all(ids.map(id => textOf(ui, `t-tokens-${id}`)))
    const shownCells = tokenCells.filter((x): x is string => x !== undefined)
    expect(shownCells.length).toBeGreaterThan(0)
    for (const cell of shownCells) {
      expect(cell.length).toBe(shownCells[0]!.length)
      expect(cell).toMatch(/\S$/)
    }
    expect((await textOf(ui, 'th-tokens'))?.length).toBe(shownCells[0]!.length)
    expect(await textOf(ui, 'th-tokens')).toMatch(/TOKENS$/)

    // The share bar: main's share of all tokens, at eighth-block precision
    const share = await textOf(ui, 't-share-main')
    const shareW = share!.length - 5
    expect(share!.startsWith(hbar((6 * 16_000) / total, shareW))).toBe(true)
    expect(share).toMatch(/\d+%$/)

    // Cost: the unknown local model shows —, main its own dollars
    if (await ui.find({ key: 't-cost-a3' })) {
      expect((await textOf(ui, 't-cost-a3'))?.trim()).toBe('—')
    }
    expect(await textOf(ui, 't-cost-main')).toMatch(/\$0\.66$/)

    // Columns by width
    expect(await ui.find({ key: 'th-steps' })).toEqual(cols >= 100 ? expect.anything() : undefined)
    expect(await ui.find({ key: 'th-last' })).toEqual(cols >= 160 ? expect.anything() : undefined)
    await ui.unmount()
  }
  close(SPEND, 0.6895)
})

test('the TOOLS tile names the running tools, the counts on a narrow band', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(r => {
    release = r
  })
  const clock = await drive($, on, held)
  const calls = [
    $.tool.call({ tool: 'Bash', command: 'sleep 1', tool_use_id: 'held-1' } as never),
    $.tool.call({ tool: 'mcp__idea__search_text', tool_use_id: 'held-2' } as never),
    $.tool.call({ tool: 'Bash', command: 'sleep 2', tool_use_id: 'held-3' } as never),
  ]
  await clock.advance(10) // let the three calls reach the HUD's hook
  try {
    for (const cols of [120, 200, 80, 60] as const) {
      const ui = await mountBand($, cols)
      const lines = snapshot(await ui.drawn())
      const kpi = lines.findIndex(l => l.startsWith('TOKENS'))
      // every KPI line is the band's width (at 60 the agent table's own columns run wider)
      for (const l of cols === 60 ? lines.slice(kpi, kpi + 2) : lines) {
        expect(l.length).toBe(cols - 1)
      }
      const value = (await textOf(ui, 'kpi-tools'))?.trim()
      if (cols === 60) {
        expect(value).toBe('3 / 9') // a 7-column tile: no name fits, the counts do
        expect((await textOf(ui, 'kpi-label-tools'))?.trim()).toBe('TOOLS')
      } else if (cols === 80) {
        expect(value).toBe('Bash ×2 +1') // exactly the 10-column tile
      } else {
        expect(value).toBe(cols === 120 ? 'Bash ×2 +1' : 'Bash ×2 · search_text')
        expect((await ui.find({ type: 'Text', text: (await textOf(ui, 'kpi-tools'))! }))?.props.bold).toBe(true)
        expect((await textOf(ui, 'kpi-label-tools'))?.trim()).toBe('TOOLS · 9 runs')
        console.log(`\n── KPI tiles, tools running, at ${cols} columns ──\n${lines.slice(kpi, kpi + 2).join('\n')}`)
      }
      await ui.unmount()
    }
  } finally {
    release()
    await Promise.all(calls)
  }
})

test('toggles switch the chart metric and grouping', async ($, on) => {
  await drive($, on)
  const ui = await mountBand($, 120)
  // Tokens by agent: main leads with 96.0k
  expect(await textOf(ui, 'legend-0')).toMatch(/^■ main session +96\.0k$/)
  expect((await ui.find({ type: 'Text', text: ' Tokens ' }))?.props.inverse).toBe(true)

  await ui.press({ key: 'metric-steps' })
  expect(await textOf(ui, 'legend-0')).toMatch(/^■ main session +6$/)
  expect((await ui.find({ type: 'Text', text: ' Steps ' }))?.props.inverse).toBe(true)

  await ui.press({ key: 'metric-spend' })
  expect(await textOf(ui, 'legend-0')).toMatch(/^■ main session +\$0\.66$/)

  await ui.press({ key: 'group-model' })
  expect(await textOf(ui, 'legend-0')).toMatch(/^■ opus 5\.5 +\$0\.66$/)
  const legend = (await Promise.all([0, 1, 2].map(i => textOf(ui, `legend-${i}`)))).join('|')
  expect(legend).toContain('sonnet 5.5')
  await ui.unmount()
})

test('empty prices fall back to the defaults: Spend still shown', { options: { prices: '' } }, async ($, on) => {
  await drive($, on)
  const ui = await mountBand($, 200)
  expect((await textOf(ui, 'kpi-spend'))?.trim()).toBe('$0.69')
  expect(await ui.find({ key: 'th-cost' })).toBeDefined()
  expect(await ui.find({ key: 'metric-spend' })).toBeDefined()
  await ui.unmount()
})

test('[1m] matches its base price; an unknown model is —, never a guess', async ($, on) => {
  await drive($, on)
  const ui = await mountBand($, 200)
  // main answers as system.ai.claude-opus-5-5[1m]: 6 × $0.11
  expect(await textOf(ui, 't-cost-main')).toMatch(/\$0\.66$/)
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  expect((await textOf(pane, 'm-cost-qwen3.6'))?.trim()).toBe('—')
  expect((await textOf(pane, 't-cost-a3'))?.trim()).toBe('—')
  await pane.unmount()
})

test('uplift adds its percent to every price', { options: { upliftPct: 10 } }, async ($, on) => {
  await drive($, on)
  const ui = await mountBand($, 120)
  expect((await textOf(ui, 'kpi-spend'))?.trim()).toBe('$0.76')
  await ui.unmount()
})

test('pane: the full dashboard with a by-model breakdown', async ($, on) => {
  await drive($, on)
  const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  const lines = snapshot(await ui.drawn())
  expect(lines.length).toBeLessThanOrEqual(39)
  expect(await ui.find({ key: 'mhead' })).toBeDefined()
  expect(await textOf(ui, 'm-cost-opus-5.5')).toMatch(/\$0\.66$/)
  expect(await textOf(ui, 'm-cost-haiku-4.5')).toMatch(/\$0\.01$/)
  expect((await textOf(ui, 'm-cost-qwen3.6'))?.trim()).toBe('—')
  // all four agents in the table, with thin separators between them
  for (const id of ['main', 'a1', 'a2', 'a3']) {
    expect(await ui.find({ key: `trow-${id}` })).toBeDefined()
  }
  expect(await ui.find({ key: 'tsep-1' })).toBeDefined()
  expect((await textOf(ui, 'chart-body-0'))?.length).toBe(chartLayout(119).body)
  await ui.unmount()
})

test('collapsed: one line spread over the width, then hidden, then /workflow expands', async ($, on) => {
  await drive($, on)
  const ui = await mountBand($, 200)
  await ui.press({ key: 'collapse' })
  const line = await textOf(ui, 'band-line')
  expect(line?.length).toBe(199)
  expect(line).toMatch(
    /^NEXUS [●○] ENGAGED +│ +tok \S+ +│ +cache \d+% +│ +agents 2\/3 +│ +\$0\.69 +│ +⏱ \S+ +expand  hide$/,
  )
  console.log(`\n── collapsed at 200 columns ──\n${snapshot(await ui.drawn()).join('\n')}`)
  const narrow = await mountBand($, 80)
  expect(await textOf(narrow, 'band-line')).toMatch(/^NEXUS [●○] ENGAGED │ tok \S+ │ cache/)
  await narrow.unmount()
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'band-line' })).toBeUndefined()
  const ran = await $.command.run({
    command: 'workflow',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 200 },
  })
  expect(ran.text).toContain('expanded')
  expect(await ui.find({ key: 'kpi-values' })).toBeDefined()
  await ui.unmount()
})

test('a short band drops the ticker, then table rows, then the chart', async ($, on) => {
  await drive($, on)
  const at = async (rows: number) => {
    const ui = await mountBand($, 120, rows)
    const out = {
      lines: snapshot(await ui.drawn()).length,
      chart: (await ui.find({ key: 'chart-row-0' })) !== undefined,
      table: (await ui.find({ key: 'thead' })) !== undefined,
      collapsed: (await ui.find({ key: 'band-line' })) !== undefined,
    }
    await ui.unmount()
    return out
  }
  expect(await at(10)).toMatchObject({ lines: 10, chart: true, table: true })
  expect(await at(6)).toMatchObject({ lines: 6, chart: true, table: false })
  expect(await at(4)).toMatchObject({ lines: 4, chart: false, table: false })
  expect(await at(3)).toMatchObject({ collapsed: true })
})

test('session.start closes the leftover pane and restores mode and toggles', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on, { bandMode: 'collapsed', chartMetric: 'steps', chartGroup: 'model' })
  const closed: string[] = []
  on('ui.close', async (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.status', async () => ({ value: undefined }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(closed).toContain('workflow')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const band = await mountBand($, 120)
  expect(await band.find({ key: 'band-line' })).toBeDefined()
  await band.press({ key: 'expand' })
  expect((await band.find({ type: 'Text', text: ' Steps ' }))?.props.inverse).toBe(true)
  expect((await band.find({ type: 'Text', text: ' by model ' }))?.props.inverse).toBe(true)
  await band.unmount()
})

// ---------- route ----------

type Decision = {
  loop: string
  route: 'fast' | 'general' | 'reasoning' | 'coding'
  difficulty?: RouteDifficulty
  model: string
  effort: string | null
  confidence: number
  backend: RouteBackend
  at: number
  action?: 'switched' | 'kept' | 'hint' | 'escalated' | 'vague'
  contextTokens?: number
  suggested?: string
  committed?: boolean
}
const OPUS = 'system.ai.claude-opus-5-5[1m]'
const HAIKU = 'databricks-claude-haiku-4-5'

// The router module is not loaded here, so the test answers the reads beneath the
// hud: the router's `routerLast` (and `routerEnabled`, when held) and the trail the
// hud keeps (its `state.set` hook, which fills the trail, is not driven here).
type Held = {
  last: Decision | null
  routes: RouteMark[]
  enabled?: boolean
  /** every other plugin's key the hud asked for, `plugin.key` */
  others?: string[]
}

const answerState = (on: On, held: Held) => {
  let version = 1
  on('state.get', async (_$, e, next) => {
    if (e.plugin === 'nexus' && e.key === 'routerLast') {
      return { value: { value: held.last, version: ++version } } as never
    }
    if (e.plugin === 'nexus' && e.key === 'routerEnabled' && held.enabled !== undefined) {
      return { value: { value: held.enabled, version: ++version } } as never
    }
    if (e.plugin === 'nexus' && e.key === 'routes') {
      return { value: { value: held.routes, version: ++version } } as never
    }
    if ((e.plugin as string) !== 'nexus') {
      held.others?.push(`${e.plugin}.${e.key}`)
    }
    return next(e)
  })
}

const mark = (d: Decision): RouteMark => {
  const { effort, ...rest } = d
  return effort === null ? rest : { ...rest, effort }
}

/**
 * The session, then 14 decisions 1s apart: the first 13 kept in the trail (one
 * written twice), the 14th, a coding route on opus, the router's `routerLast` alone.
 */
const routed = async ($: Engine, on: On, difficulty?: RouteDifficulty) => {
  const held: Held = { last: null, routes: [] }
  answerState(on, held)
  const clock = await drive($, on)
  const t0 = clock.now()
  for (let i = 0; i < 14; i++) {
    const d: Decision = {
      loop: i === 12 ? 'a2' : 'main',
      route: i === 13 ? 'coding' : i % 4 === 1 ? 'general' : 'fast',
      ...(i === 13 && difficulty !== undefined ? { difficulty } : {}),
      model: i === 13 || i % 3 === 0 ? OPUS : HAIKU,
      effort: i === 13 ? 'high' : null,
      confidence: i !== 13 && i % 4 === 1 ? 0.42 : 0.82,
      backend: 'jev',
      at: t0 + i * 1_000,
    }
    held.last = d
    if (i < 13) {
      held.routes = pushRoute(held.routes, mark(d))
    }
    if (i === 5) {
      held.routes = pushRoute(held.routes, mark(d)) // the same decision again: no second mark
    }
  }
  await clock.advance(13_000)
  return { clock, t0, held }
}

test('route: the trail as kept, the latest decision joined once, 12 marks at most', async ($, on) => {
  const { held, t0 } = await routed($, on)
  expect(held.routes).toHaveLength(12)
  expect(held.routes[0]!.at).toBe(t0 + 1_000)
  // the latest is not in the kept trail yet: the drawing joins it, dropping the oldest
  const ui = await mountBand($, 200)
  expect(await textOf(ui, 'route-trail')).toHaveLength(12)
  expect(await textOf(ui, 'route-core')).toMatch(/coding +→ ▌ opus 5\.5$/)
  await ui.unmount()
  // once kept, drawing it again adds no second mark
  held.routes = pushRoute(held.routes, mark(held.last!))
  const again = await mountBand($, 200)
  expect(await textOf(again, 'route-trail')).toHaveLength(12)
  await again.unmount()
  // a null effort is left out, not kept as null
  expect('effort' in held.routes[0]!).toBe(false)
})

test('route line in the band at 60, 100 and 200 columns', async ($, on) => {
  await routed($, on)
  for (const cols of [60, 100, 200] as const) {
    const W = cols - 1
    const ui = await mountBand($, cols)
    const lines = snapshot(await ui.drawn())
    expect(lines.length).toBeLessThanOrEqual(10)
    // (below 80 the header is wider than the band already; the route line never is)
    for (const l of cols >= 80 ? lines : []) {
      expect(l.length).toBe(W)
    }
    const line = lines.find(l => l.startsWith('ROUTE '))
    expect(line?.length).toBe(W)
    console.log(`\n── route at ${cols} columns ──\n${line}`)
    // the decision just made: ▶, the changed route inverse, then the model
    expect(line).toMatch(/^ROUTE ▶  coding  → ▌ opus 5\.5/)
    expect((await ui.find({ type: 'Text', text: ' coding ' }))?.props.inverse).toBe(true)
    expect(await textOf(ui, 'route-conf')).toMatch(/0\.82$/)
    const trail = await textOf(ui, 'route-trail')
    expect(trail).toMatch(/^[◆◇]+$/)
    if (cols === 60) {
      expect(await ui.find({ key: 'route-backend' })).toBeUndefined()
    } else {
      expect(await textOf(ui, 'route-conf')).toContain('conf ')
      expect(await textOf(ui, 'route-loop')).toMatch(/@main$/)
      expect(await textOf(ui, 'route-age')).toMatch(/now$/)
      expect(await textOf(ui, 'route-effort')).toMatch(/high$/)
      expect(await textOf(ui, 'route-backend')).toMatch(/jev$/)
      // all 12 marks once the room is there; low-confidence ones hollow
      expect(trail).toHaveLength(12)
      expect(trail).toContain('◇')
      expect(line).toMatch(/[◆◇]{12}$/)
    }
    // the table still has its head and a row beside the route
    expect(await ui.find({ key: 'thead' })).toBeDefined()
    await ui.unmount()
  }
})

test('route line with a difficulty at 60, 100 and 200 columns: `/high` goes first', async ($, on) => {
  await routed($, on, 'high')
  for (const cols of [60, 100, 200] as const) {
    const W = cols - 1
    const ui = await mountBand($, cols)
    const line = snapshot(await ui.drawn()).find(l => l.startsWith('ROUTE '))
    expect(line?.length).toBe(W)
    console.log(`\n── route with a difficulty at ${cols} columns ──\n${line}`)
    const trail = await textOf(ui, 'route-trail')
    expect(trail).toMatch(/^[◆◇]+$/)
    if (cols === 60) {
      // short of room: the difficulty is dropped, the category stays, the rest as without one
      expect(line).toMatch(/^ROUTE ▶  coding  → ▌ opus 5\.5/)
      expect(line).not.toContain('/high')
      expect((await ui.find({ type: 'Text', text: ' coding ' }))?.props.inverse).toBe(true)
      expect(await ui.find({ key: 'route-backend' })).toBeUndefined()
    } else {
      // the whole `coding/high` label is drawn inverse while fresh
      expect(line).toMatch(/^ROUTE ▶  coding\/high  → ▌ opus 5\.5/)
      expect((await ui.find({ type: 'Text', text: ' coding/high ' }))?.props.inverse).toBe(true)
      expect(await textOf(ui, 'route-conf')).toContain('conf ')
      expect(await textOf(ui, 'route-loop')).toMatch(/@main$/)
      expect(await textOf(ui, 'route-age')).toMatch(/now$/)
      expect(await textOf(ui, 'route-effort')).toMatch(/high$/)
      expect(await textOf(ui, 'route-backend')).toMatch(/jev$/)
      expect(trail).toHaveLength(12)
      expect(line).toMatch(/[◆◇]{12}$/)
    }
    await ui.unmount()
  }
  // the pane's route line, and the collapsed line (which shows no category) as before
  const pane = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  expect(await textOf(pane, 'route-core')).toMatch(/coding\/high +→ ▌ opus 5\.5$/)
  await pane.unmount()
  const band = await mountBand($, 200)
  await band.press({ key: 'collapse' })
  expect(await textOf(band, 'band-line')).toMatch(/│ +→ opus 5\.5 [◆◇]{4} +│/)
  await band.unmount()
})

test('a kept route with a difficulty never draws wider than a very narrow band', async ($, on) => {
  const r = await adaptive($, on, { route: 'reasoning', model: SONNET, confidence: 0.82, action: 'kept', contextTokens: 150_000 })
  r.held.last = { ...r.held.last!, difficulty: 'medium' } as typeof r.held.last
  for (const cols of [41, 42, 43, 44] as const) {
    const ui = await mountBand($, cols)
    const line = snapshot(await ui.drawn()).find(l => l.startsWith('ROUTE '))
    expect(line?.length).toBeLessThanOrEqual(cols - 1)
    await ui.unmount()
  }
})

test('route line without a difficulty is drawn as before', async ($, on) => {
  await routed($, on)
  for (const cols of [60, 100, 200] as const) {
    const ui = await mountBand($, cols)
    const line = snapshot(await ui.drawn()).find(l => l.startsWith('ROUTE '))
    console.log(`\n── route without a difficulty at ${cols} columns ──\n${line}`)
    expect(line).toMatch(/^ROUTE ▶  coding  → ▌ opus 5\.5/)
    expect(line).not.toContain('/')
    await ui.unmount()
  }
})

test('route: the flash fades, the age counts, low confidence is warn, a subagent is named', async ($, on) => {
  const { clock, t0, held } = await routed($, on)
  await clock.advance(4_200)
  let ui = await mountBand($, 160)
  expect(await textOf(ui, 'route-core')).toMatch(/^ROUTE   coding → ▌ opus 5\.5$/)
  expect(await textOf(ui, 'route-age')).toMatch(/4s ago$/)
  await ui.unmount()

  // a general fallback for a subagent, under the floor
  const now = clock.now()
  held.routes = pushRoute(held.routes, mark(held.last!))
  held.last = { loop: 'a2', route: 'general', model: HAIKU, effort: null, confidence: 0.41, backend: 'local', at: now }
  ui = await mountBand($, 160)
  const conf = await ui.find({ type: 'Text', text: ' 0.41' })
  expect(conf?.props.color).toBe('#f5b84b')
  expect((await ui.find({ type: 'Text', text: ' general ' }))?.props.color).toBe('#f5b84b')
  expect(await textOf(ui, 'route-loop')).toMatch(/@Write tests$/)
  expect(await ui.find({ key: 'route-effort' })).toBeUndefined()
  expect(await textOf(ui, 'route-trail')).toMatch(/◇$/)
  expect(t0).toBeLessThan(now)
  await ui.unmount()
})

test('route in the collapsed line only where it fits; in the pane too', async ($, on) => {
  await routed($, on)
  const ui = await mountBand($, 200)
  await ui.press({ key: 'collapse' })
  const line = await textOf(ui, 'band-line')
  expect(line?.length).toBe(199)
  expect(line).toMatch(/^NEXUS [●○] ENGAGED +│ +→ opus 5\.5 [◆◇]{4} +│ +tok \S+ +│ +cache/)
  console.log(`\n── collapsed with a route at 200 columns ──\n${line}`)
  const narrow = await mountBand($, 80)
  expect(await narrow.find({ key: 'c-route' })).toBeUndefined()
  await narrow.unmount()
  const mid = await mountBand($, 120)
  const midLine = await textOf(mid, 'band-line')
  console.log(`\n── collapsed with a route at 120 columns ──\n${midLine}`)
  expect(midLine!.length).toBeLessThanOrEqual(119)
  await mid.unmount()
  await ui.unmount()

  const pane = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  expect(await textOf(pane, 'route-core')).toMatch(/opus 5\.5$/)
  await pane.unmount()
})

test('no decision: no route line, no route in the collapsed line', async ($, on) => {
  answerState(on, { last: null, routes: [] })
  await drive($, on)
  const ui = await mountBand($, 200)
  expect(snapshot(await ui.drawn()).some(l => l.startsWith('ROUTE'))).toBe(false)
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'c-route' })).toBeUndefined()
  await ui.unmount()
})

test('router: the decision is read from nexus.routerLast, not the old key', async ($, on) => {
  const d: Decision = {
    loop: 'main',
    route: 'reasoning',
    model: OPUS,
    effort: 'max',
    confidence: 0.9,
    backend: 'jev',
    at: 0,
  }
  const held: Held = { last: null, routes: [], others: [] }
  answerState(on, held)
  const clock = await drive($, on)
  held.last = { ...d, at: clock.now() }
  const ui = await mountBand($, 200)
  expect(await textOf(ui, 'route-core')).toMatch(/reasoning +→ ▌ opus 5\.5$/)
  expect(await textOf(ui, 'route-effort')).toMatch(/max$/)
  // no state but the plugin's own is read: the old router plugin's key is gone
  expect(held.others).toEqual([])
  await ui.unmount()
})

test('router absent: nothing answers routerLast, no route line, no errors', async ($, on) => {
  await drive($, on)
  for (const cols of [80, 200] as const) {
    const ui = await mountBand($, cols)
    const lines = snapshot(await ui.drawn())
    expect(lines.some(l => l.startsWith('NEXUS'))).toBe(true)
    expect(lines.some(l => l.startsWith('ROUTE'))).toBe(false)
    expect(await ui.find({ key: 'route-core' })).toBeUndefined()
    if (cols === 200) {
      await ui.press({ key: 'collapse' })
      expect(await ui.find({ key: 'band-line' })).toBeDefined()
      expect(await ui.find({ key: 'c-route' })).toBeUndefined()
    }
    await ui.unmount()
  }
  const pane = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  expect(await pane.find({ key: 'route-core' })).toBeUndefined()
  expect(await pane.find({ key: 'thead' })).toBeDefined()
  await pane.unmount()
})

test('router off: a decision held from before `/route off` is not drawn', async ($, on) => {
  const { held } = await routed($, on)
  held.enabled = false
  const ui = await mountBand($, 200)
  expect(snapshot(await ui.drawn()).some(l => l.startsWith('ROUTE'))).toBe(false)
  await ui.unmount()
  held.enabled = true
  const back = await mountBand($, 200)
  expect(await textOf(back, 'route-core')).toMatch(/coding +→ ▌ opus 5\.5$/)
  await back.unmount()
})

test('router: backend haiku (and pin) drawn as named', async ($, on) => {
  const { clock, held } = await routed($, on)
  for (const backend of ['haiku', 'pin'] as const) {
    held.routes = pushRoute(held.routes, mark(held.last!))
    await clock.advance(1_000)
    held.last = { ...held.last!, route: 'fast', model: HAIKU, backend, at: clock.now() }
    const ui = await mountBand($, 200)
    expect(await textOf(ui, 'route-backend')).toMatch(new RegExp(`${backend}$`))
    expect(await textOf(ui, 'route-core')).toMatch(/fast +→ ▌ haiku 4\.5$/)
    await ui.unmount()
  }
})

// ---------- adaptive routing (0.2.0): switched, kept, hint ----------

const SONNET = 'system.ai.claude-sonnet-5-5'

/** The 14 decisions of `routed`, then a 15th from the adaptive router, 1s later. */
const adaptive = async ($: Engine, on: On, d: Omit<Decision, 'at' | 'loop' | 'backend' | 'effort'> & Partial<Decision>) => {
  const r = await routed($, on)
  r.held.routes = pushRoute(r.held.routes, mark(r.held.last!))
  await r.clock.advance(1_000)
  r.held.last = { loop: 'main', backend: 'jev', effort: null, ...d, at: r.clock.now() }
  return r
}

const routeAt = async ($: Engine, cols: number) => {
  const ui = await mountBand($, cols)
  const line = snapshot(await ui.drawn()).find(l => l.startsWith('ROUTE '))
  expect(line?.length).toBe(cols - 1)
  return { ui, line: line! }
}

test('adaptive: switched shows `switched · ctx` after the loop; drops the ctx, then itself, when narrow', async ($, on) => {
  await adaptive($, on, { route: 'reasoning', model: OPUS, effort: 'high', confidence: 0.82, action: 'switched', contextTokens: 12_000 })
  const { ui, line } = await routeAt($, 200)
  console.log(`\n── switched at 200 columns ──\n${line}`)
  expect(await textOf(ui, 'route-core')).toMatch(/reasoning +→ ▌ opus 5\.5$/)
  expect(await textOf(ui, 'route-action')).toBe('   switched · ctx 12.0k')
  expect(line).toMatch(/^ROUTE ▶  reasoning  → ▌ opus 5\.5   high   conf .{5} 0\.82   jev   @main   now   switched · ctx 12\.0k /)
  await ui.unmount()
  const narrow = await routeAt($, 60)
  console.log(`\n── switched at 60 columns ──\n${narrow.line}`)
  expect(await textOf(narrow.ui, 'route-conf')).toMatch(/0\.82$/)
  await narrow.ui.unmount()
})

test('adaptive: hint shows `kept` and the suggested model right after the model, first to claim room', async ($, on) => {
  await adaptive($, on, { route: 'reasoning', model: SONNET, confidence: 0.82, action: 'hint', contextTokens: 150_000, suggested: OPUS })
  for (const cols of [60, 100, 200] as const) {
    const { ui, line } = await routeAt($, cols)
    console.log(`\n── hint at ${cols} columns ──\n${line}`)
    expect(await textOf(ui, 'route-core')).toMatch(/reasoning +→ kept ▌ sonnet 5\.5$/)
    expect(await textOf(ui, 'route-action')).toBe(cols === 60 ? ' · hint opus 5.5' : ' · ctx 150k · hint opus 5.5')
    expect(line).toMatch(/→ kept ▌ sonnet 5\.5 · (ctx 150k · )?hint opus 5\.5/)
    // the suggested model in its own series color, as the trail and the table draw opus
    expect((await ui.find({ type: 'Text', text: 'opus 5.5' }))?.props.color).toMatch(/^#/)
    await ui.unmount()
  }
})

test('adaptive: kept (low confidence, no hint) shows `kept` and the ctx; still a fresh decision', async ($, on) => {
  await adaptive($, on, { route: 'fast', model: SONNET, confidence: 0.55, action: 'kept', contextTokens: 150_000 })
  const { ui, line } = await routeAt($, 200)
  console.log(`\n── kept at 200 columns ──\n${line}`)
  // a new `at`: marked ▶ like any new decision, the route inverse as it moved off coding
  expect(line).toMatch(/^ROUTE ▶  fast  → kept ▌ sonnet 5\.5 · ctx 150k   conf .{5} 0\.55/)
  expect(await textOf(ui, 'route-action')).toBe(' · ctx 150k')
  expect((await ui.find({ type: 'Text', text: ' 0.55' }))?.props.color).toBe('#f5b84b')
  expect(await ui.find({ type: 'Text', text: 'hint ' })).toBeUndefined()
  // the trail counts it: 12 marks, the newest last
  expect(await textOf(ui, 'route-trail')).toHaveLength(12)
  await ui.unmount()
})

test('adaptive: the collapsed line says kept and hint briefly; switched reads as before', async ($, on) => {
  const { held, clock } = await adaptive($, on, {
    route: 'reasoning',
    model: SONNET,
    confidence: 0.82,
    action: 'hint',
    contextTokens: 150_000,
    suggested: OPUS,
  })
  const ui = await mountBand($, 200)
  await ui.press({ key: 'collapse' })
  const line = await textOf(ui, 'band-line')
  console.log(`\n── collapsed, hint, at 200 columns ──\n${line}`)
  expect(line?.length).toBe(199)
  expect(line).toMatch(/│ +→ kept sonnet 5\.5 · hint opus 5\.5 [◆◇]{4} +│ +tok/)
  held.routes = pushRoute(held.routes, mark(held.last!))
  await clock.advance(1_000)
  held.last = { ...held.last!, model: OPUS, action: 'switched', contextTokens: 2_000, at: clock.now() }
  const sw = await mountBand($, 200)
  const swLine = await textOf(sw, 'band-line')
  expect(swLine).toMatch(/│ +→ opus 5\.5 [◆◇]{4} +│ +tok/)
  await sw.unmount()
  await ui.unmount()
})

test('task mode: escalated shows `kept` and `escalated → opus 5.5` like a hint, in the full and the collapsed line', async ($, on) => {
  const { held } = await adaptive($, on, { route: 'coding', model: SONNET, confidence: 0.9, action: 'escalated', contextTokens: 40_000, suggested: OPUS })
  for (const cols of [60, 200] as const) {
    const { ui, line } = await routeAt($, cols)
    console.log(`\n── escalated at ${cols} columns ──\n${line}`)
    expect(await textOf(ui, 'route-core')).toMatch(/coding +→ kept ▌ sonnet 5\.5$/)
    expect(await textOf(ui, 'route-action')).toBe(cols === 60 ? ' · escalated → opus 5.5' : ' · ctx 40.0k · escalated → opus 5.5')
    expect((await ui.find({ type: 'Text', text: 'opus 5.5' }))?.props.color).toMatch(/^#/)
    await ui.unmount()
  }
  const band = await mountBand($, 200)
  await band.press({ key: 'collapse' })
  const collapsed = await textOf(band, 'band-line')
  console.log(`\n── collapsed, escalated, at 200 columns ──\n${collapsed}`)
  expect(collapsed).toMatch(/│ +→ kept sonnet 5\.5 · escalated → opus 5\.5 [◆◇]{4} +│ +tok/)
  // no suggested model: the word alone
  const { suggested: _gone, ...bare } = held.last!
  held.last = bare
  const again = await mountBand($, 200)
  expect(await textOf(again, 'band-line')).toMatch(/│ +→ kept sonnet 5\.5 · escalated [◆◇]{4} +│ +tok/)
  await again.unmount()
  await band.unmount()
})

test('task mode: a vague prompt shows `kept` and `vague`; a committing decision shows `commit`', async ($, on) => {
  const { held } = await adaptive($, on, { route: 'general', model: SONNET, confidence: 0.9, action: 'vague', contextTokens: 12_000, suggested: OPUS })
  const vague = held.last!
  const { ui, line } = await routeAt($, 200)
  console.log(`\n── vague at 200 columns ──\n${line}`)
  expect(await textOf(ui, 'route-core')).toMatch(/general +→ kept ▌ sonnet 5\.5$/)
  expect(await textOf(ui, 'route-action')).toBe(' · ctx 12.0k · vague')
  // readable: the state words have colors of their own, none of them the faint grey
  const p = palette(false)
  const colorOf = async (text: string) => (await ui.find({ type: 'Text', text }))?.props.color
  expect(await colorOf('kept ')).toBe(p.info)
  expect(await colorOf('vague')).toBe(p.series[3])
  expect(await colorOf('ROUTE ')).toBe(p.muted)
  for (const text of ['kept ', 'vague', 'conf ', 'jev']) expect(await colorOf(text)).not.toBe(p.faint)
  await ui.unmount()
  // kept and committed (a clear prompt kept on low confidence commits the model that runs)
  const { suggested: _s, ...rest } = vague
  held.last = { ...rest, action: 'kept', committed: true, at: vague.at + 1 }
  const kept = await routeAt($, 200)
  expect(await textOf(kept.ui, 'route-action')).toBe(' · ctx 12.0k · commit')
  await kept.ui.unmount()
  // switched and committed
  held.last = { ...rest, model: OPUS, action: 'switched', committed: true, at: vague.at + 2 }
  const sw = await routeAt($, 200)
  console.log(`\n── switched and committed at 200 columns ──\n${sw.line}`)
  expect(await textOf(sw.ui, 'route-action')).toMatch(/switched · commit · ctx 12\.0k$/)
  await sw.ui.unmount()
  // the collapsed line, vague
  held.last = { ...vague, at: vague.at + 3 }
  const band = await mountBand($, 200)
  await band.press({ key: 'collapse' })
  expect(await textOf(band, 'band-line')).toMatch(/│ +→ kept sonnet 5\.5 · vague [◆◇]{4} +│ +tok/)
  await band.unmount()
})

test('adaptive: no action (subagent, session start, pin) draws no action part', async ($, on) => {
  await routed($, on)
  const ui = await mountBand($, 200)
  expect(await ui.find({ key: 'route-action' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'kept ' })).toBeUndefined()
  await ui.unmount()
})

test('an agent heard only at its end (no spawn, start or step) gets its model and name, not `?`', async ($, on) => {
  on('agent.list', async () => ({ value: [{ id: 'f1', description: 'Forked skill', type: 'general-purpose', status: 'completed' } as never] }))
  await drive($, on)
  await $.turn.complete({
    answer: 'done',
    durationMs: 60_000,
    isAborted: false,
    turnId: 'f1',
    agentId: 'f1',
    reason: 'answer',
    usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'system.ai.claude-sonnet-5-5[1m]' },
  })
  const ui = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'trow-f1' })).toBeDefined()
  expect(await textOf(ui, 't-model-f1')).toMatch(/sonnet 5\.5/)
  expect(await textOf(ui, 't-agent-f1')).toMatch(/Forked skill/)
  await ui.unmount()
})

test('route: a subagent in view shows its own decision and trail, not the main session one', async ($, on) => {
  await routed($, on)
  const mountViewing = (agentId: string) =>
    $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: 200, view: { agentId } } })
  // a2 was routed once (fast, opus); the main session's latest is coding
  const a2 = await mountViewing('a2')
  expect(await textOf(a2, 'route-core')).toMatch(/fast +→ ▌ opus 5\.5$/)
  // one decision of its own: no trail (a trail needs two), not the main session's 12
  expect(await a2.find({ key: 'route-trail' })).toBeUndefined()
  await a2.unmount()
  // a1 was never routed: no route line rather than another loop's
  const a1 = await mountViewing('a1')
  expect(await a1.find({ key: 'route-core' })).toBeUndefined()
  await a1.unmount()
  // the pane follows the view too
  const pane = await $.ui.mount({ plugin: 'nexus', surface: 'terminal', ...PANE, props: { ...PANE.props, view: { agentId: 'a2' } } })
  expect(await textOf(pane, 'route-core')).toMatch(/fast +→ ▌ opus 5\.5$/)
  await pane.unmount()
  // back on the main conversation: the latest decision, as before
  const main = await mountBand($, 200)
  expect(await textOf(main, 'route-core')).toMatch(/coding +→ ▌ opus 5\.5$/)
  await main.unmount()
})

test('band height: a quarter of the terminal rows, never under 10, never over them', async ($, on) => {
  await drive($, on)
  // the band draws what its content needs, up to its share: a tree of this session's loops is shorter
  for (const [rows, max] of [[40, 10], [60, 15], [100, 25]] as const) {
    const ui = await mountBand($, 120, rows)
    expect(snapshot(await ui.drawn()).length).toBeLessThanOrEqual(max)
    await ui.unmount()
  }
  // a 6-row terminal keeps the band in what it has
  const tiny = await mountBand($, 120, 6)
  expect(snapshot(await tiny.drawn()).length).toBeLessThanOrEqual(6)
  await tiny.unmount()
})

test('stall watch: a silent subagent gets one message to its main session, again only after new silence', { options: { stallMinutes: 1 } }, async ($, on) => {
  const sent: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-under-test' }))
  on('session.send', async (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true } as never
  })
  on('ui.toast', async () => ({ value: undefined }))
  const clock = await drive($, on)
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  // a2 and a3 are running and silent since their last steps; the main loop and the finished a1 never count
  await clock.advance(2 * 60_000)
  expect(sent).toHaveLength(2)
  expect(sent.every(t => t.includes('sent nothing for 1 min'))).toBe(true)
  expect(sent.some(t => t.includes('"Write tests" (a2)'))).toBe(true)
  expect(sent.some(t => t.includes('"Local summary" (a3)'))).toBe(true)
  // the same silence is reported once
  await clock.advance(3 * 60_000)
  expect(sent).toHaveLength(2)
  // a2 speaks again, then falls silent: one more message, for a2 alone
  for await (const _chunk of $.turn.step({ turnId: 'a2', index: 9, model: OPUS, messageCount: 1, agentId: 'a2' })) {
    // read to the end
  }
  await clock.advance(2 * 60_000)
  expect(sent).toHaveLength(3)
  expect(sent[2]).toContain('"Write tests" (a2)')
})
