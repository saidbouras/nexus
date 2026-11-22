import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventResult, Events, PluginOptions, Register, Timer } from 'claude-code'

import type { BandMode, ChartGroup, ChartMetric, Loop, ModelUse, RouteMark, RouterDecision, Step, ToolRun } from '../../types'
import {
  activeLoop,
  agentTable,
  chartRows,
  collapsedLine,
  header,
  kpiRow,
  MAIN,
  modelTable,
  routeLine,
  rule,
  ticker as tickerLine,
  totals,
  treeRows,
} from './dash'
import type { Ctx, El, Route, Row } from './dash'
import { fmtMoney, parsePrices, stepCost } from './cost'
import { cacheRate, clip, fmtTokens, isTruecolor, palette, pct, prettyModel, pushRoute, spinner, stallText, stalledLoops, toMark } from './hud'

const PANE = 'workflow'
const MAX_LOOPS = 50
const MAX_TOOLS = 30
const MAX_STEPS = 60
const MAX_MODELS = 20
const TICK_MS = 300
const STALL_CHECK_MS = 60_000
const DEFAULT_STALL_MS = 30 * 60_000
// The band takes a quarter of the rows the host gives it (`maxRows`, the terminal's
// height), never fewer than BAND_MIN_ROWS: a short terminal keeps the 10-row band.
const BAND_SHARE = 4
const BAND_MIN_ROWS = 10
const STORE_MODE = 'bandMode'
const STORE_METRIC = 'chartMetric'
const STORE_GROUP = 'chartGroup'
const MODES: readonly BandMode[] = ['expanded', 'collapsed', 'hidden']
const isMode = (v: unknown): v is BandMode => typeof v === 'string' && (MODES as readonly string[]).includes(v)
const isMetric = (v: unknown): v is ChartMetric => v === 'tokens' || v === 'steps' || v === 'spend'
const isGroup = (v: unknown): v is ChartGroup => v === 'agent' || v === 'model'

const loops = atom({ plugin: 'nexus', key: 'loops' } as const, [] as Loop[])
const bandMode = atom({ plugin: 'nexus', key: 'bandMode' } as const, 'expanded' as BandMode)
const isPaneWanted = atom({ plugin: 'nexus', key: 'isPaneWanted' } as const, false)
const steps = atom({ plugin: 'nexus', key: 'steps' } as const, [] as Step[])
const models = atom({ plugin: 'nexus', key: 'models' } as const, [] as ModelUse[])
const chartMetric = atom({ plugin: 'nexus', key: 'chartMetric' } as const, 'tokens' as ChartMetric)
const chartGroup = atom({ plugin: 'nexus', key: 'chartGroup' } as const, 'agent' as ChartGroup)
const isPalette16 = atom({ plugin: 'nexus', key: 'isPalette16' } as const, false)
const tick = atom({ plugin: 'nexus', key: 'tick' } as const, 0)
const routes = atom({ plugin: 'nexus', key: 'routes' } as const, [] as RouteMark[])
// Written by this plugin's router module, read here only: `routerLast` is null (the
// default) until it decides or while it is not loaded; `routerEnabled` false after `/route off`.
const routerLast = atom({ plugin: 'nexus', key: 'routerLast' } as const, null as RouterDecision | null)
const routerEnabled = atom({ plugin: 'nexus', key: 'routerEnabled' } as const, true)

// The interval handle is not state: a hot reload cancels the old environment's
// timers, and the next event starts a fresh one when something runs.
let ticker: Timer | undefined
// The stall watch: every minute, a subagent silent for `stallMinutes` gets one message to the main session.
let stallWatch: Timer | undefined
// `loop id@activeAt` of every silence already reported: one message per silence.
const reportedStalls = new Set<string>()
// Once per environment (a load or a hot reload): close a leftover pane nobody asked for.
let didSweep = false

// ---------- helpers ----------

const loopId = (agentId: string | undefined): string => agentId ?? MAIN

const freshLoop = (id: string, now: number): Loop => ({
  id,
  label: id === MAIN ? 'main session' : id,
  parent: id === MAIN ? undefined : MAIN,
  status: 'running',
  turns: 0,
  steps: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheRead: 0,
  cacheWrite: 0,
  tools: [],
  startedAt: now,
  activeAt: now,
})

/** Keeps at most MAX_LOOPS: main always, then evicts the oldest finished loops first. */
const capLoops = (list: Loop[]): Loop[] => {
  const out = [...list]
  while (out.length > MAX_LOOPS) {
    let victim = out.findIndex(l => l.id !== MAIN && l.status !== 'running')
    if (victim < 0) {
      victim = out.findIndex(l => l.id !== MAIN)
    }
    if (victim < 0) {
      break
    }
    out.splice(victim, 1)
  }
  return out
}

// ---------- state writers (never throw) ----------

async function withLoop($: EngineInterface, id: string, fn: (loop: Loop, now: number) => Loop): Promise<void> {
  try {
    void sweepPane($)
    const now = await $.clock.now()
    await update($, loops, list => {
      const i = list.findIndex(l => l.id === id)
      const base: Loop = i >= 0 ? { ...list[i]!, cacheWrite: list[i]!.cacheWrite ?? 0 } : freshLoop(id, now)
      const changed = fn({ ...base, activeAt: now }, now)
      return capLoops(i >= 0 ? list.map((l, j) => (j === i ? changed : l)) : [...list, changed])
    })
    await refresh($)
  } catch {
    // The viz must never break the session.
  }
}

/** Whether the HUD already has a row for this loop (heard its spawn, start or a step). */
async function isKnownLoop($: EngineInterface, id: string): Promise<boolean> {
  try {
    return (await read($, loops)).some(l => l.id === id)
  } catch {
    return true
  }
}

/** The engine's record of an agent, for a loop the HUD never saw spawned; undefined when absent. */
async function agentInfo($: EngineInterface, id: string): Promise<{ description: string; type: string; name?: string; parentId?: string } | undefined> {
  try {
    return (await $.agent.list()).find(a => a.id === id)
  } catch {
    return undefined
  }
}

/** Starts the stall watch for this session (a reload or a new session starts it again); 0 turns it off. */
function startStallWatch($: EngineInterface, stallMs: number): void {
  stallWatch?.cancel()
  stallWatch = stallMs > 0 ? $.clock.every(STALL_CHECK_MS, () => void checkStalls($, stallMs)) : undefined
}

/** Tells the main session, through its own session, about each subagent silent for `stallMs`. Never throws. */
async function checkStalls($: EngineInterface, stallMs: number): Promise<void> {
  try {
    const now = await $.clock.now()
    const list = await read($, loops)
    for (const l of stalledLoops(list, now, stallMs)) {
      const key = `${l.id}@${l.activeAt}`
      if (reportedStalls.has(key)) {
        continue
      }
      reportedStalls.add(key)
      await $.session.send({ to: { sessionId: await $.session.id() }, text: stallText(l, now, stallMs) })
      await $.ui.toast(`NEXUS: subagent "${l.label}" has been silent for a while; the main session will check on it.`)
    }
  } catch {
    // the watch must never break the session
  }
}

/** Status line, and the animation ticker: on while something runs, off when idle. */
async function refresh($: EngineInterface): Promise<void> {
  try {
    const list = await read($, loops)
    const t = totals(list)
    const active = activeLoop(list)
    const frame = await read($, tick)
    $.ui.status(
      active === undefined
        ? undefined
        : `NEXUS ${active.status === 'running' ? spinner(frame) : active.status === 'done' ? '✓' : '✗'} ` +
            `${clip(active.label, 20)} ▸ ${prettyModel(active.model)} · ${t.agentsActive}/${t.agents} ag · ` +
            `${fmtTokens(t.tokens)} · ${pct(cacheRate(t.tokensIn, t.cacheRead))}` +
            (t.spend !== undefined ? ` · ${fmtMoney(t.spend)}` : ''),
    )
    if (t.isRunning && ticker === undefined) {
      ticker = $.clock.every(TICK_MS, () => {
        void onTick($)
      })
    } else if (!t.isRunning && ticker !== undefined) {
      stopTicker()
    }
  } catch {
    // ignore
  }
}

const stopTicker = (): void => {
  try {
    ticker?.cancel()
  } catch {
    // ignore
  }
  ticker = undefined
}

async function onTick($: EngineInterface): Promise<void> {
  try {
    const list = await read($, loops)
    if (!totals(list).isRunning) {
      stopTicker()
      return
    }
    await update($, tick, n => (n + 1) % 1_000_000)
  } catch {
    stopTicker()
  }
}

async function remember($: EngineInterface, key: string, value: string): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // the state alone still holds it for this session
  }
}

async function setMode($: EngineInterface, mode: BandMode): Promise<void> {
  await update($, bandMode, () => mode)
  await remember($, STORE_MODE, mode)
}

async function setMetric($: EngineInterface, m: ChartMetric): Promise<void> {
  await update($, chartMetric, () => m)
  await remember($, STORE_METRIC, m)
}

async function setGroup($: EngineInterface, g: ChartGroup): Promise<void> {
  await update($, chartGroup, () => g)
  await remember($, STORE_GROUP, g)
}

/** Closes the pane unless `/workflow pane` asked for it; never throws, never waits. */
async function sweepPane($: EngineInterface): Promise<void> {
  if (didSweep) {
    return
  }
  didSweep = true
  try {
    if (!(await read($, isPaneWanted))) {
      void $.ui.close({ id: PANE }).catch(() => undefined)
    }
  } catch {
    // ignore
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'NEXUS' })
}

/** Keeps a decision in the trail; never throws. */
async function recordRoute($: EngineInterface, last: unknown): Promise<void> {
  try {
    const mark = toMark(last)
    if (mark !== null) {
      await update($, routes, list => pushRoute(list, mark))
    }
  } catch {
    // the trail is a nicety
  }
}

/**
 * The router's latest decision and the trail before it; none while the router
 * module made no decision or `/route off` turned it off. The trail is written as
 * the router writes `routerLast` (hook below); a decision made before this module
 * loaded joins it here, for the drawing only.
 */
async function readRoutes($: EngineInterface): Promise<{ route: RouteMark | null; routes: RouteMark[] }> {
  try {
    if ((await read($, routerEnabled)) === false) {
      return { route: null, routes: [] }
    }
    const last = toMark(await read($, routerLast))
    const kept = await read($, routes)
    const all = last === null || kept.some(m => m.at === last.at) ? kept : pushRoute(kept, last)
    return { route: all[all.length - 1] ?? null, routes: all }
  } catch {
    return { route: null, routes: [] }
  }
}

/**
 * Everything a drawing reads, once per render. `viewing` is the agent whose
 * transcript is on screen (`props.view.agentId`): the route line and trail are
 * that loop's own decisions, none when it was never routed. The main
 * conversation in view shows the latest decision of any loop, as before.
 */
async function context($: EngineInterface, hasPrices: boolean, viewing?: string): Promise<Ctx> {
  const metric = await read($, chartMetric)
  const all = await readRoutes($)
  const own = viewing === undefined ? all.routes : all.routes.filter(m => m.loop === viewing)
  const r = viewing === undefined ? all : { route: own[own.length - 1] ?? null, routes: own }
  return {
    p: palette(await read($, isPalette16)),
    list: await read($, loops),
    steps: await read($, steps),
    models: await read($, models),
    frame: await read($, tick),
    now: await $.clock.now(),
    metric: metric === 'spend' && !hasPrices ? 'tokens' : metric,
    group: await read($, chartGroup),
    hasPrices,
    route: r.route,
    routes: r.routes,
    setMetric: m => setMetric($, m),
    setGroup: g => setGroup($, g),
  }
}

/** `/workflow` and `/nexus`: `pane` opens the pane, a mode sets the band, no argument cycles it. */
async function onCommand($: EngineInterface, e: { args?: string }): Promise<{ text: string }> {
  const arg = String(e.args ?? '')
    .trim()
    .toLowerCase()
  if (arg === 'pane') {
    try {
      await update($, isPaneWanted, () => true)
      await openPane($)
      return { text: 'NEXUS pane opened.' }
    } catch {
      return { text: 'NEXUS pane could not open here.' }
    }
  }
  const current = await read($, bandMode)
  const wanted: BandMode = isMode(arg)
    ? arg
    : arg === 'expand'
      ? 'expanded'
      : arg === 'collapse'
        ? 'collapsed'
        : arg === 'hide'
          ? 'hidden'
          : (MODES[(MODES.indexOf(current) + 1) % MODES.length] ?? 'expanded')
  await setMode($, wanted)
  return { text: `NEXUS band ${wanted}.` }
}

// ---------- hooks ----------

/** The `e` and result of each event the HUD shares with the router (hooks/register.tsx owns those hooks). */
export type TurnStartIn = Parameters<Events['turn.start']>[1]
export type TurnStepIn = Parameters<Events['turn.step']>[1]
export type TurnStepOut = EventResult<'turn.step'>
export type AgentSpawnIn = Parameters<Events['agent.spawn']>[1]
export type AgentSpawnOut = EventResult<'agent.spawn'>

const hasPrices = true

/** Registers the HUD's own events: its commands, the route trail, tools, the pane and the band. */
export const register: Register = on => {
  on('command.run', { command: 'workflow' }, onCommand)
  on('command.run', { command: 'nexus' }, onCommand)

  // Every decision the router writes joins the trail; its value passes as written.
  on('state.set', { plugin: 'nexus', key: 'routerLast' }, async ($, e, next) => {
    const result = await next(e)
    await recordRoute($, e.value)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // A loop can be heard only at its end (a forked skill raises no
    // agent.spawn; a start held past its bound): its model is the turn's
    // usage, its name the engine's agent list.
    const info = e.agentId !== undefined && !(await isKnownLoop($, e.agentId)) ? await agentInfo($, e.agentId) : undefined
    await withLoop($, loopId(e.agentId), loop => ({
      ...loop,
      ...(info !== undefined ? { label: info.name ?? info.description, subagentType: info.type } : {}),
      ...(info?.parentId !== undefined ? { parent: info.parentId } : {}),
      model: loop.model ?? e.usage?.model,
      status: e.reason === 'error' ? 'error' : 'done',
      ms: (loop.ms ?? 0) + e.durationMs,
    }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = loopId(e.agentId)
    await withLoop($, id, (loop, now) => ({
      ...loop,
      tools: [
        ...loop.tools.filter(t => t.id !== e.tool_use_id),
        { id: e.tool_use_id, tool: e.tool, status: 'running' as const, startedAt: now },
      ].slice(-MAX_TOOLS),
    }))
    const ran = await next(e)
    const status: ToolRun['status'] = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'error' : 'done'
    await withLoop($, id, (loop, now) => ({
      ...loop,
      tools: loop.tools.map(t => (t.id === e.tool_use_id ? { ...t, status, ms: now - t.startedAt } : t)),
    }))
    return ran
  }).catch(($, e, next) => next(e))

  // ---------- pane: the full dashboard ----------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el: El = $.ui.resolve(e)
    const c = await context($, hasPrices, e.props.view?.agentId)
    const t = totals(c.list)
    const W = Math.max(40, (e.viewport?.columns ?? e.props.bodyColumns) - 1)
    const rows = Math.max(12, e.viewport?.rows ?? 30) - 1

    if (c.list.length === 0) {
      return (
        <el.Box flexDirection="column">
          {header(el, c, t, W, {})}
          <el.Text color={c.p.faint}>standing by · no activity yet</el.Text>
        </el.Box>
      )
    }
    const tree = treeRows(c.list)
    const nModels = c.models.length
    // Fixed: header, rule, kpi 2, rule, rule before the table, table head; then the chart,
    // the table rows (separators when room), by-model, route, ticker.
    let room = rows - 6
    const chartH = c.steps.length > 0 ? Math.max(3, Math.min(8, Math.floor(rows / 4))) : 0
    room -= chartH
    const tableRows = Math.min(tree.length, Math.max(1, room))
    room -= tableRows
    const separators = room >= tableRows - 1 + nModels + 4
    if (separators) room -= tableRows - 1
    const showModels = nModels > 0 && room >= nModels + 2
    if (showModels) room -= nModels + 2
    const showRoute = c.route !== null && room >= 1
    if (showRoute) room -= 1
    const showTicker = c.list.some(l => l.tools.length > 0) && room >= 2

    return (
      <el.Box flexDirection="column" width={W}>
        {header(el, c, t, W, {})}
        {rule(el, c, 'r1', W)}
        {kpiRow(el, c, t, W)}
        {rule(el, c, 'r2', W)}
        {chartH > 0 && chartRows(el, c, W, chartH)}
        {chartH > 0 && rule(el, c, 'r3', W)}
        {agentTable(el, c, t, W, tree.slice(0, tableRows), tree.length - tableRows, separators)}
        {showModels && rule(el, c, 'r4', W)}
        {showModels && modelTable(el, c, W)}
        {(showRoute || showTicker) && rule(el, c, 'r5', W)}
        {showRoute && routeLine(el, c, W)}
        {showTicker && tickerLine(el, c, W)}
      </el.Box>
    )
  })

  // ---------- band: the dashboard above the prompt, or one line ----------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const mode = await read($, bandMode)
    if (e.props.hasSurvey || mode === 'hidden') {
      return next(e)
    }
    const list = await read($, loops)
    if (list.length === 0) {
      return next(e)
    }
    const el: El = $.ui.resolve(e)
    const c = await context($, hasPrices, e.props.view?.agentId)
    const t = totals(c.list)
    const W = Math.max(40, e.props.bodyColumns - 1)
    const B = Math.min(Math.max(BAND_MIN_ROWS, Math.floor(e.props.maxRows / BAND_SHARE)), e.props.maxRows)
    const hide = () => setMode($, 'hidden')

    // Top rule + header + KPI (2) is the least an expanded band takes.
    let room = B - 4
    if (mode === 'collapsed' || room < 0) {
      return (
        <el.Box flexDirection="column" width={W}>
          {collapsedLine(el, c, t, W, () => setMode($, 'expanded'), hide)}
        </el.Box>
      )
    }
    // Then: the chart, the route, the table (head + rows), the ticker; dropped in reverse order.
    const chartH = c.steps.length === 0 ? 0 : room >= 5 ? 3 : room >= 2 ? 2 : 0
    room -= chartH
    const tree = treeRows(c.list)
    // The route (the only live view of the router) claims a row once the table
    // has its head and one row; the table's further rows come after it.
    const showRoute = c.route !== null && room >= 3
    if (showRoute) room -= 1
    let tableRows = 0
    if (room >= 2) {
      tableRows = Math.min(tree.length, room - 1)
      room -= tableRows + 1
    }
    // Running loops first claim the rows, then the latest finished; shown in tree order.
    const running = tree.filter(r => r.loop.status === 'running')
    const finished = tree.filter(r => r.loop.status !== 'running').sort((a, b) => b.loop.activeAt - a.loop.activeAt)
    const picked = new Set([...running, ...finished].slice(0, tableRows).map(r => r.loop.id))
    const shown: Row[] = tree.filter(r => picked.has(r.loop.id))
    const showTicker = room >= 1 && c.list.some(l => l.tools.length > 0)

    return (
      <el.Box flexDirection="column" width={W}>
        {rule(el, c, 'rule-top', W)}
        {header(el, c, t, W, { collapse: () => setMode($, 'collapsed'), hide })}
        {kpiRow(el, c, t, W)}
        {chartH > 0 && chartRows(el, c, W, chartH)}
        {tableRows > 0 && agentTable(el, c, t, W, shown, tree.length - shown.length, false)}
        {showRoute && routeLine(el, c, W)}
        {showTicker && tickerLine(el, c, W)}
      </el.Box>
    )
  })
}

/** The HUD's settings for the shared events: the price table and uplift. */
export type Hud = { prices: ReturnType<typeof parsePrices>; uplift: number; stallMs: number }

export function createHud(options: PluginOptions): Hud {
  // Empty `prices` means the cited defaults (cost.ts); a model with no price shows —.
  return {
    prices: parsePrices(options.prices),
    uplift: typeof options.upliftPct === 'number' ? options.upliftPct : 0,
    stallMs: typeof options.stallMinutes === 'number' && options.stallMinutes >= 0 ? options.stallMinutes * 60_000 : DEFAULT_STALL_MS,
  }
}

// ---------- the HUD's part of the shared events ----------
// hooks/register.tsx calls these from the plugin's one hook per shared event,
// each isolated there. They only observe: none calls `next` or changes the request.

/** session.start: /workflow and /nexus, the leftover pane, the stored mode and toggles, the palette. */
export async function hudSessionStart($: EngineInterface, h: Hud): Promise<void> {
  // Two names, one behaviour: `/nexus` is an alias of `/workflow` (the spec has no alias field).
  try {
    await $.command.register({
      name: 'workflow',
      description: 'NEXUS: toggle the band (expanded, collapsed, hidden); `/workflow pane` opens the full dashboard',
    })
  } catch {
    // ignore
  }
  try {
    await $.command.register({
      name: 'nexus',
      description: 'NEXUS: same as /workflow; `/nexus pane` opens the full dashboard',
    })
  } catch {
    // ignore
  }
  didSweep = false
  await sweepPane($)
  startStallWatch($, h.stallMs)
  try {
    // The band's mode and the chart's toggles carry across sessions through the store.
    const mode = await $.store.get(STORE_MODE)
    if (isMode(mode)) {
      await update($, bandMode, () => mode)
    }
    const metric = await $.store.get(STORE_METRIC)
    if (isMetric(metric)) {
      await update($, chartMetric, () => metric)
    }
    const group = await $.store.get(STORE_GROUP)
    if (isGroup(group)) {
      await update($, chartGroup, () => group)
    }
  } catch {
    // ignore
  }
  try {
    // 16 named colors only where the terminal says neither truecolor nor 256 colors.
    const colorterm = await $.env.get('COLORTERM')
    const term = await $.env.get('TERM')
    const is16 = !isTruecolor(colorterm) && !/256/.test(term ?? '')
    await update($, isPalette16, () => is16 && term !== undefined)
  } catch {
    // ignore: hex it is
  }
}

/** turn.start: the loop is running, one turn more. */
export async function hudTurnStart($: EngineInterface, e: TurnStartIn): Promise<void> {
  await withLoop($, loopId(e.agentId), loop => ({ ...loop, status: 'running', turns: loop.turns + 1 }))
}

/** turn.step, once answered: `e` the request as sent (the routed model), `result` the response. */
export async function hudStep($: EngineInterface, h: Hud, e: TurnStepIn, result: TurnStepOut): Promise<void> {
  const { prices, uplift } = h
  const usage = result.usage
  const model = usage?.model ?? e.model
  const counts = {
    input: usage?.input_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
  }
  const cost = usage ? stepCost(usage, model, prices, uplift) : undefined
  try {
    const now = await $.clock.now()
    const step: Step = {
      loop: loopId(e.agentId),
      model,
      in: counts.input + counts.cacheWrite,
      out: counts.output,
      at: now,
      ...(cost !== undefined ? { cost } : {}),
    }
    await update($, steps, s => [...s, step].slice(-MAX_STEPS))
    await update($, models, list => {
      const i = list.findIndex(m => m.model === model)
      const base: ModelUse = i >= 0 ? list[i]! : { model, steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const merged: ModelUse = {
        ...base,
        steps: base.steps + 1,
        input: base.input + counts.input,
        output: base.output + counts.output,
        cacheRead: base.cacheRead + counts.cacheRead,
        cacheWrite: base.cacheWrite + counts.cacheWrite,
        ...(cost !== undefined ? { spend: (base.spend ?? 0) + cost } : {}),
      }
      return (i >= 0 ? list.map((m, j) => (j === i ? merged : m)) : [...list, merged]).slice(-MAX_MODELS)
    })
  } catch {
    // ignore
  }
  await withLoop($, loopId(e.agentId), loop => ({
    ...loop,
    steps: loop.steps + 1,
    model,
    tokensIn: loop.tokensIn + counts.input + counts.cacheWrite,
    tokensOut: loop.tokensOut + counts.output,
    cacheRead: loop.cacheRead + counts.cacheRead,
    cacheWrite: loop.cacheWrite + counts.cacheWrite,
    ...(cost !== undefined ? { spend: (loop.spend ?? 0) + cost } : {}),
  }))
}

/** agent.spawn, once started: the new loop's label, parent, type and model. */
export async function hudSpawn($: EngineInterface, e: AgentSpawnIn, result: AgentSpawnOut): Promise<void> {
  if (result.deny === undefined && result.agentId !== undefined) {
    const parent = e.parentAgentId ?? MAIN
    await withLoop($, result.agentId, loop => ({
      ...loop,
      label: e.name ?? e.description,
      parent,
      subagentType: e.subagentType,
      model: loop.model ?? result.model,
    }))
  }
}
