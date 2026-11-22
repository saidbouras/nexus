// The NEXUS dashboard's drawing: lines of explicit-width segments, so every
// column lines up on any surface. No `$`, no state: the caller hands in a Ctx.
import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { ChartGroup, ChartMetric, Loop, ModelUse, RouteMark, Step, ToolRun } from '../../types'
import {
  cacheRate,
  clip,
  connector,
  fit,
  fitCount,
  fmtAgo,
  fmtDur,
  fmtTokens,
  hbar,
  kpiTiles,
  LOW_CONFIDENCE,
  modelSlot,
  pct,
  prettyModel,
  seriesColor,
  spinner,
  stackedColumns,
  table,
  toolSummary,
} from './hud'
import type { Column, Palette, Tile } from './hud'
import { fmtMoney } from './cost'

export type El = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type Route = RouteMark

export type Ctx = {
  p: Palette
  list: readonly Loop[]
  steps: readonly Step[]
  models: readonly ModelUse[]
  frame: number
  now: number
  metric: ChartMetric
  group: ChartGroup
  /** prices configured: Spend tile, Cost column, spend metric */
  hasPrices: boolean
  /** the router's latest decision, null while none (or the router is off or absent) */
  route: Route | null
  /** the recent decisions, oldest first, the latest included */
  routes: readonly Route[]
  setMetric: (m: ChartMetric) => unknown
  setGroup: (g: ChartGroup) => unknown
}

export const MAIN = 'main'
/** Below this the layout is compact (fewer columns, shorter labels). */
export const WIDE = 100

// ---------- segments ----------

export type Seg = { text: string; color?: string; bold?: boolean; inverse?: boolean }
type Group = { key: string; segs: Seg[] }
type Btn = { button: { key: string; label: string; seg: Seg; onPress: () => unknown } }
export type Part = Seg | Group | Btn

const isGroup = (p: Part): p is Group => 'segs' in p
const isBtn = (p: Part): p is Btn => 'button' in p
const segsOf = (p: Part): Seg[] => (isGroup(p) ? p.segs : isBtn(p) ? [p.button.seg] : [p])
export const widthOf = (parts: readonly Part[]): number =>
  parts.reduce((s, p) => s + segsOf(p).reduce((t, x) => t + x.text.length, 0), 0)

const textProps = (s: Seg): TextProps => {
  const out: TextProps = {}
  if (s.color !== undefined) out.color = s.color
  if (s.bold === true) out.bold = true
  if (s.inverse === true) out.inverse = true
  return out
}

const drawSeg = (el: El, s: Seg) => <el.Text {...textProps(s)}>{s.text}</el.Text>

/** One row of parts, exactly as wide as its segments. */
export const drawLine = (el: El, key: string, parts: readonly Part[]): RenderElement => (
  <el.Box key={key} flexDirection="row">
    {parts.map(part =>
      isBtn(part) ? (
        <el.Button key={part.button.key} plain label={part.button.label} onPress={part.button.onPress}>
          {drawSeg(el, part.button.seg)}
        </el.Button>
      ) : isGroup(part) ? (
        <el.Box key={part.key} flexDirection="row">
          {part.segs.map(s => drawSeg(el, s))}
        </el.Box>
      ) : (
        drawSeg(el, part)
      ),
    )}
  </el.Box>
)

const pad = (n: number): Seg => ({ text: ' '.repeat(Math.max(0, n)) })

// ---------- totals ----------

export type Totals = {
  tokensIn: number
  tokensOut: number
  tokens: number
  cacheRead: number
  steps: number
  agents: number
  agentsActive: number
  tools: number
  toolsRunning: number
  isRunning: boolean
  startedAt: number | undefined
  /** USD over the steps that had a price; undefined while none had one */
  spend: number | undefined
}

export const totals = (list: readonly Loop[]): Totals => {
  const agents = list.filter(l => l.id !== MAIN)
  const runs = list.flatMap(l => l.tools)
  const priced = list.filter(l => l.spend !== undefined)
  const tokensIn = list.reduce((s, l) => s + l.tokensIn, 0)
  const tokensOut = list.reduce((s, l) => s + l.tokensOut, 0)
  return {
    tokensIn,
    tokensOut,
    tokens: tokensIn + tokensOut,
    cacheRead: list.reduce((s, l) => s + l.cacheRead, 0),
    steps: list.reduce((s, l) => s + l.steps, 0),
    agents: agents.length,
    agentsActive: agents.filter(l => l.status === 'running').length,
    tools: runs.length,
    toolsRunning: runs.filter(t => t.status === 'running').length,
    isRunning: list.some(l => l.status === 'running') || runs.some(t => t.status === 'running'),
    startedAt: list.length > 0 ? Math.min(...list.map(l => l.startedAt)) : undefined,
    spend: priced.length > 0 ? priced.reduce((s, l) => s + (l.spend ?? 0), 0) : undefined,
  }
}

export const activeLoop = (list: readonly Loop[]): Loop | undefined => {
  const byActivity = [...list].sort((a, b) => b.activeAt - a.activeAt)
  return byActivity.find(l => l.status === 'running') ?? byActivity[0]
}

export type Row = { loop: Loop; lasts: boolean[] }

/** Depth-first rows: main first, children under their parent, with their connector flags. */
export const treeRows = (list: readonly Loop[]): Row[] => {
  const ids = new Set(list.map(l => l.id))
  const parentOf = (l: Loop): string | undefined =>
    l.id === MAIN
      ? undefined
      : l.parent !== undefined && ids.has(l.parent) && l.parent !== l.id
        ? l.parent
        : ids.has(MAIN)
          ? MAIN
          : undefined
  const rows: Row[] = []
  const seen = new Set<string>()
  const visit = (l: Loop, lasts: boolean[]): void => {
    if (seen.has(l.id)) {
      return
    }
    seen.add(l.id)
    rows.push({ loop: l, lasts })
    const kids = list.filter(c => parentOf(c) === l.id && !seen.has(c.id)).sort((a, b) => a.startedAt - b.startedAt)
    kids.forEach((k, i) => visit(k, [...lasts, i === kids.length - 1]))
  }
  const roots = list
    .filter(l => parentOf(l) === undefined)
    .sort((a, b) => (a.id === MAIN ? -1 : b.id === MAIN ? 1 : a.startedAt - b.startedAt))
  roots.forEach(r => visit(r, []))
  list.forEach(l => visit(l, []))
  return rows
}

export const loopElapsed = (l: Loop, now: number): number =>
  l.status === 'running' ? Math.max(l.ms ?? 0, now - l.startedAt) : (l.ms ?? Math.max(0, l.activeAt - l.startedAt))

const statusSeg = (c: Ctx, s: Loop['status']): Seg =>
  s === 'running'
    ? { text: spinner(c.frame), color: c.p.text }
    : s === 'done'
      ? { text: '✓', color: c.p.ok }
      : { text: '✗', color: c.p.err }

const TOOL_GLYPH: Record<ToolRun['status'], string> = { running: '…', done: '✓', error: '✗', denied: '⊘' }
const toolColor = (c: Ctx, s: ToolRun['status']): string =>
  s === 'done' ? c.p.ok : s === 'error' ? c.p.err : s === 'denied' ? c.p.warn : c.p.text

/** The agent's series color: its place in the loop list (main first). */
export const agentColor = (c: Ctx, id: string): string =>
  seriesColor(
    c.p,
    Math.max(
      0,
      c.list.findIndex(l => l.id === id),
    ),
  )
export const modelColor = (c: Ctx, model: string | undefined): string => seriesColor(c.p, modelSlot(model))

// ---------- sections ----------

export const rule = (el: El, c: Ctx, key: string, width: number) =>
  drawLine(el, key, [{ text: '─'.repeat(Math.max(0, width)), color: c.p.rule }])

type HeaderButtons = { collapse?: () => unknown; hide?: () => unknown }

/** `NEXUS  ● ENGAGED   uptime 2m14s` … `Tokens│Steps│Spend   by agent│by model   collapse  hide`. */
export const header = (el: El, c: Ctx, t: Totals, width: number, buttons: HeaderButtons) => {
  const wide = width >= WIDE
  const pulse = t.isRunning ? (c.frame % 2 === 0 ? '●' : '○') : '●'
  const left: Part[] = [
    { key: 'h-title', segs: [{ text: 'NEXUS', color: c.p.text, bold: true }] },
    pad(2),
    {
      key: 'h-status',
      segs: [
        { text: pulse, color: t.isRunning ? c.p.warn : c.p.ok },
        { text: t.isRunning ? ' ENGAGED' : ' ONLINE', color: c.p.muted },
      ],
    },
    pad(3),
    {
      key: 'h-uptime',
      segs: [
        { text: 'uptime ', color: c.p.muted },
        { text: fmtDur(t.startedAt === undefined ? 0 : c.now - t.startedAt), color: c.p.muted },
      ],
    },
  ]
  const toggle = (key: string, label: string, isOn: boolean, onPress: () => unknown): Part => ({
    button: {
      key,
      label,
      seg: isOn ? { text: ` ${label} `, color: c.p.text, inverse: true } : { text: ` ${label} `, color: c.p.muted },
      onPress,
    },
  })
  const bar: Part = { text: '│', color: c.p.rule }
  const metrics: [ChartMetric, string, string][] = [
    ['tokens', 'Tokens', 'tok'],
    ['steps', 'Steps', 'stp'],
    ...(c.hasPrices ? ([['spend', 'Spend', '$']] as [ChartMetric, string, string][]) : []),
  ]
  const metricParts: Part[] = metrics.flatMap(([m, long, short], i) => [
    ...(i > 0 ? [bar] : []),
    toggle(`metric-${m}`, wide ? long : short, c.metric === m, () => c.setMetric(m)),
  ])
  const groupParts: Part[] = [
    toggle('group-agent', wide ? 'by agent' : 'agent', c.group === 'agent', () => c.setGroup('agent')),
    bar,
    toggle('group-model', wide ? 'by model' : 'model', c.group === 'model', () => c.setGroup('model')),
  ]
  const actions: Part[] = [
    ...(buttons.collapse
      ? [
          pad(3),
          {
            button: {
              key: 'collapse',
              label: 'collapse',
              seg: { text: 'collapse', color: c.p.faint },
              onPress: buttons.collapse,
            },
          },
        ]
      : []),
    ...(buttons.hide
      ? [
          pad(2),
          { button: { key: 'hide', label: 'hide', seg: { text: 'hide', color: c.p.faint }, onPress: buttons.hide } },
        ]
      : []),
  ]
  let right: Part[] = [...metricParts, pad(3), ...groupParts, ...actions]
  let l = left
  if (widthOf(l) + widthOf(right) + 1 > width) {
    l = left.slice(0, 3) // drop the uptime
  }
  if (widthOf(l) + widthOf(right) + 1 > width) {
    right = [...metricParts, ...actions]
  }
  return drawLine(el, 'header', [...l, pad(width - widthOf(l) - widthOf(right)), ...right])
}

/**
 * The TOOLS tile, `w` wide: the tools in use by name (the latest finished ones,
 * muted, while none runs); the `running / all` counts where no name fits.
 */
const toolsTile = (list: readonly Loop[], t: Totals, w: number): Tile => {
  const sum = toolSummary(list, w)
  return {
    id: 'tools',
    label: `TOOLS · ${t.tools} ${t.tools === 1 ? 'run' : 'runs'}`,
    short: 'TOOLS',
    value: sum?.text ?? `${t.toolsRunning} / ${t.tools}`,
    alt: `${t.toolsRunning}/${t.tools}`,
    ...(sum?.idle === true ? { dim: true } : {}),
  }
}

/** The KPI tiles: a gray label line over a bold number line, `│` rules between. */
export const kpiRow = (el: El, c: Ctx, t: Totals, width: number) => {
  const base: Tile[] = [
    {
      id: 'tokens',
      label: 'TOKENS in / out',
      short: 'TOKENS',
      value: `${fmtTokens(t.tokensIn)} / ${fmtTokens(t.tokensOut)}`,
      alt: fmtTokens(t.tokens),
    },
    { id: 'steps', label: 'STEPS', value: `${t.steps}` },
    { id: 'cache', label: 'CACHE HIT', short: 'CACHE', value: pct(cacheRate(t.tokensIn, t.cacheRead)) },
    {
      id: 'agents',
      label: 'AGENTS live / all',
      short: 'AGENTS',
      value: `${t.agentsActive} / ${t.agents}`,
      alt: `${t.agentsActive}/${t.agents}`,
    },
    { id: 'tools', label: 'TOOLS', value: '' }, // sized below, once its width is known
    ...(c.hasPrices ? [{ id: 'spend', label: 'SPEND', value: fmtMoney(t.spend) }] : []),
  ]
  const widths = kpiTiles(base, width, 3)
  const tiles = base.map((tile, i) => (tile.id === 'tools' ? toolsTile(c.list, t, widths[i] ?? 1) : tile))
  const sep: Seg = { text: ' │ ', color: c.p.rule }
  const line = (pick: (tile: Tile, w: number) => Part): Part[] =>
    tiles.flatMap((tile, i) => [...(i > 0 ? [sep] : []), pick(tile, widths[i] ?? 1)])
  return [
    drawLine(
      el,
      'kpi-labels',
      line((tile, w) => ({
        key: `kpi-label-${tile.id}`,
        segs: [{ text: fit(tile.label.length > w && tile.short ? tile.short : tile.label, w), color: c.p.muted }],
      })),
    ),
    drawLine(
      el,
      'kpi-values',
      line((tile, w) => ({
        key: `kpi-${tile.id}`,
        segs: [
          {
            text: fit(tile.value.length > w && tile.alt ? tile.alt : tile.value, w),
            color: tile.value === '—' ? c.p.faint : tile.dim === true ? c.p.muted : c.p.text,
            bold: tile.dim !== true,
          },
        ],
      })),
    ),
  ]
}

const metricValue = (m: ChartMetric, s: Step): number =>
  m === 'tokens' ? s.in + s.out : m === 'steps' ? 1 : (s.cost ?? 0)
const fmtMetric = (m: ChartMetric, v: number): string =>
  m === 'tokens' ? fmtTokens(v) : m === 'steps' ? `${Math.round(v)}` : fmtMoney(v)

export type ChartLayout = { axis: number; body: number; legend: number }

export const chartLayout = (width: number): ChartLayout => {
  const wide = width >= WIDE
  const legend = wide ? Math.min(30, Math.max(20, Math.floor(width * 0.18))) : 16
  const axis = wide ? 7 : 0
  return { axis, legend, body: Math.max(8, width - axis - legend - 2) }
}

/** The stacked bar chart over time, a legend of `■ name value` on the right. */
export const chartRows = (el: El, c: Ctx, width: number, height: number) => {
  const lay = chartLayout(width)
  const labelOf = (key: string): string => (c.group === 'agent' ? (c.list.find(l => l.id === key)?.label ?? key) : key)
  const colorOf = (key: string): string => (c.group === 'agent' ? agentColor(c, key) : modelColor(c, key))
  const points = c.steps.map(s => ({
    at: s.at,
    key: c.group === 'agent' ? s.loop : prettyModel(s.model),
    value: metricValue(c.metric, s),
  }))
  const chart = stackedColumns(points, lay.body, height)
  const series = chart.series.filter(s => s.total > 0)
  const legendLine = (i: number): Seg[] => {
    const overflow = series.length > height && i === height - 1
    if (overflow) {
      return [{ text: fit(`+${series.length - height + 1} more`, lay.legend), color: c.p.faint }]
    }
    const s = series[i]
    if (s === undefined) {
      return [pad(lay.legend)]
    }
    const value = fmtMetric(c.metric, s.total)
    const name = clip(labelOf(s.key), Math.max(1, lay.legend - value.length - 3))
    return [
      { text: '■ ', color: colorOf(s.key) },
      { text: name, color: c.p.muted },
      pad(lay.legend - 2 - name.length - value.length),
      { text: value, color: c.p.text },
    ]
  }
  return chart.rows.map((row, r) => {
    const runs: Seg[] = []
    for (const cell of row) {
      const color = cell.series === null ? undefined : colorOf(cell.series)
      const last = runs[runs.length - 1]
      if (last !== undefined && last.color === color) {
        last.text += cell.ch
      } else {
        runs.push(color === undefined ? { text: cell.ch } : { text: cell.ch, color })
      }
    }
    const axis: Seg[] =
      lay.axis === 0
        ? []
        : r === 0
          ? [{ text: fit(fmtMetric(c.metric, chart.max), lay.axis - 2, 'right') + ' ┤', color: c.p.faint }]
          : [{ text: ' '.repeat(lay.axis - 2) + ' │', color: c.p.rule }]
    return drawLine(el, `chart-row-${r}`, [
      ...axis,
      { key: `chart-body-${r}`, segs: runs },
      pad(2),
      { key: `legend-${r}`, segs: legendLine(r) },
    ])
  })
}

/** The agent table's columns at this width. */
export const agentColumns = (width: number, hasPrices: boolean): Column[] => {
  const wide = width >= WIDE
  const full = width >= 160
  if (!wide) {
    return [
      { id: 'agent', title: 'AGENT', align: 'left', flex: 3, min: 12 },
      { id: 'model', title: 'MODEL', align: 'left', width: 10 },
      { id: 'tokens', title: 'TOKENS', align: 'right', width: 7 },
      { id: 'share', title: 'SHARE', align: 'left', flex: 1, min: 9 },
      ...(hasPrices ? [{ id: 'cost', title: 'COST', align: 'right' as const, width: 7 }] : []),
      { id: 'time', title: 'TIME', align: 'right', width: 6 },
    ]
  }
  return [
    { id: 'agent', title: 'AGENT', align: 'left', flex: 3, min: 16 },
    { id: 'model', title: 'MODEL', align: 'left', width: 12 },
    ...(full ? [{ id: 'turns', title: 'TURNS', align: 'right' as const, width: 5 }] : []),
    { id: 'steps', title: 'STEPS', align: 'right', width: 5 },
    ...(full
      ? [
          { id: 'in', title: 'IN', align: 'right' as const, width: 7 },
          { id: 'out', title: 'OUT', align: 'right' as const, width: 7 },
        ]
      : []),
    { id: 'tokens', title: 'TOKENS', align: 'right', width: 7 },
    { id: 'share', title: 'SHARE', align: 'left', flex: 2, min: 12 },
    ...(hasPrices ? [{ id: 'cost', title: 'COST', align: 'left' as const, flex: 2, min: 16 }] : []),
    { id: 'time', title: 'TIME', align: 'right', width: 6 },
    ...(full ? [{ id: 'last', title: 'LAST ACTIVE', align: 'right' as const, width: 11 }] : []),
  ]
}

/** A cell's segments for a bar with its value right-aligned after it: `███▍    42%`. */
const barCell = (fraction: number, value: string, w: number, color: string, c: Ctx, valueW: number): Seg[] => {
  const vw = Math.min(w, valueW)
  const bw = Math.max(0, w - vw - 1)
  return [
    { text: hbar(fraction, bw), color },
    ...(bw > 0 ? [pad(1)] : []),
    { text: fit(value, vw, 'right'), color: value === '—' ? c.p.faint : c.p.text },
  ]
}

/**
 * The agent table: a header, then `rows` (tree order), thin separators between
 * rows when `separators`. `rows` comes picked by the caller.
 */
export const agentTable = (
  el: El,
  c: Ctx,
  t: Totals,
  width: number,
  rows: readonly Row[],
  hidden: number,
  separators: boolean,
) => {
  const cols = agentColumns(width, c.hasPrices)
  const widths = table(cols, width, 2)
  const gap: Seg = pad(2)
  const maxSpend = Math.max(0, ...c.list.map(l => l.spend ?? 0))
  const cellFor = (col: Column, w: number, { loop, lasts }: Row): Seg[] => {
    const tokens = loop.tokensIn + loop.tokensOut
    switch (col.id) {
      case 'agent': {
        const conn = connector(lasts)
        const type = loop.subagentType !== undefined ? ` · ${loop.subagentType}` : ''
        const room = Math.max(1, w - 2 - conn.length)
        const label = clip(loop.label, room)
        const rest = clip(type, Math.max(0, room - label.length))
        return [
          statusSeg(c, loop.status),
          pad(1),
          { text: conn, color: c.p.rule },
          { text: label, color: c.p.text, bold: loop.status === 'running' },
          { text: rest, color: c.p.faint },
          pad(room - label.length - rest.length),
        ]
      }
      case 'model':
        return [
          { text: '▌', color: modelColor(c, loop.model) },
          { text: ' ' + fit(prettyModel(loop.model), w - 2), color: c.p.muted },
        ]
      case 'turns':
        return [{ text: fit(`${loop.turns}`, w, 'right'), color: c.p.text }]
      case 'steps':
        return [{ text: fit(`${loop.steps}`, w, 'right'), color: c.p.text }]
      case 'in':
        return [{ text: fit(fmtTokens(loop.tokensIn), w, 'right'), color: c.p.muted }]
      case 'out':
        return [{ text: fit(fmtTokens(loop.tokensOut), w, 'right'), color: c.p.muted }]
      case 'tokens':
        return [{ text: fit(fmtTokens(tokens), w, 'right'), color: c.p.text, bold: true }]
      case 'share':
        return barCell(
          t.tokens > 0 ? tokens / t.tokens : 0,
          pct(t.tokens > 0 ? tokens / t.tokens : 0),
          w,
          agentColor(c, loop.id),
          c,
          4,
        )
      case 'cost':
        return loop.spend === undefined
          ? [{ text: fit('—', w, 'right'), color: c.p.faint }]
          : barCell(maxSpend > 0 ? loop.spend / maxSpend : 0, fmtMoney(loop.spend), w, c.p.series[1] ?? c.p.text, c, 8)
      case 'time':
        return [{ text: fit(fmtDur(loopElapsed(loop, c.now)), w, 'right'), color: c.p.muted }]
      case 'last':
        return [
          {
            text: fit(loop.status === 'running' ? 'now' : `${fmtDur(c.now - loop.activeAt)} ago`, w, 'right'),
            color: c.p.faint,
          },
        ]
      default:
        return [pad(w)]
    }
  }
  const head: Part[] = cols.flatMap((col, i) => {
    const title = col.id === 'agent' && hidden > 0 ? `${col.title} (+${hidden})` : col.title
    return [
      ...(i > 0 ? [gap] : []),
      { key: `th-${col.id}`, segs: [{ text: fit(title, widths[i] ?? 1, col.align), color: c.p.muted }] },
    ]
  })
  const lines = [drawLine(el, 'thead', head)]
  rows.forEach((row, r) => {
    if (separators && r > 0) {
      lines.push(rule(el, c, `tsep-${r}`, width))
    }
    lines.push(
      drawLine(
        el,
        `trow-${row.loop.id}`,
        cols.flatMap((col, i) => [
          ...(i > 0 ? [gap] : []),
          { key: `t-${col.id}-${row.loop.id}`, segs: cellFor(col, widths[i] ?? 1, row) },
        ]),
      ),
    )
  })
  return lines
}

/** The pane's by-model breakdown: model, steps, tokens, cost with its bar. */
export const modelTable = (el: El, c: Ctx, width: number) => {
  const cols: Column[] = [
    { id: 'model', title: 'BY MODEL', align: 'left', flex: 2, min: 14 },
    { id: 'steps', title: 'STEPS', align: 'right', width: 5 },
    { id: 'tokens', title: 'TOKENS', align: 'right', width: 7 },
    ...(c.hasPrices ? [{ id: 'cost', title: 'COST', align: 'left' as const, flex: 3, min: 16 }] : []),
  ]
  const widths = table(cols, width, 2)
  const rows = [...c.models].sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || b.output - a.output)
  const maxSpend = Math.max(0, ...rows.map(m => m.spend ?? 0))
  const gap = pad(2)
  const lines = [
    drawLine(
      el,
      'mhead',
      cols.flatMap((col, i) => [
        ...(i > 0 ? [gap] : []),
        { key: `mh-${col.id}`, segs: [{ text: fit(col.title, widths[i] ?? 1, col.align), color: c.p.muted }] },
      ]),
    ),
  ]
  for (const m of rows) {
    const cells: Seg[][] = cols.map((col, i) => {
      const w = widths[i] ?? 1
      switch (col.id) {
        case 'model':
          return [
            { text: '▌', color: modelColor(c, m.model) },
            { text: ' ' + fit(prettyModel(m.model), w - 2), color: c.p.muted },
          ]
        case 'steps':
          return [{ text: fit(`${m.steps}`, w, 'right'), color: c.p.text }]
        case 'tokens':
          return [{ text: fit(fmtTokens(m.input + m.cacheWrite + m.output), w, 'right'), color: c.p.text }]
        default:
          return m.spend === undefined
            ? [{ text: fit('—', w, 'right'), color: c.p.faint }]
            : barCell(maxSpend > 0 ? m.spend / maxSpend : 0, fmtMoney(m.spend), w, modelColor(c, m.model), c, 8)
      }
    })
    const key = prettyModel(m.model).replace(/\s+/g, '-')
    lines.push(
      drawLine(
        el,
        `mrow-${key}`,
        cells.flatMap((segs, i) => [...(i > 0 ? [gap] : []), { key: `m-${cols[i]?.id}-${key}`, segs }]),
      ),
    )
  }
  return lines
}

/** As many of the latest tool runs as fit one line: `› Bash 1.2s ✓`. */
export const ticker = (el: El, c: Ctx, width: number) => {
  const runs = c.list
    .flatMap(l => l.tools)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 60)
  const items = runs.map(run => {
    const dur = run.status === 'running' ? fmtDur(c.now - run.startedAt) : fmtDur(run.ms)
    const glyph = run.status === 'running' ? spinner(c.frame) : TOOL_GLYPH[run.status]
    const tool = clip(run.tool, 18)
    return {
      run,
      w: 2 + tool.length + 1 + dur.length + 1 + glyph.length,
      segs: [
        { text: '› ', color: c.p.faint },
        { text: tool, color: c.p.text },
        { text: ` ${dur} `, color: c.p.muted },
        { text: glyph, color: toolColor(c, run.status) },
      ] as Seg[],
    }
  })
  const n = fitCount(
    items.map(i => i.w),
    width,
    3,
  )
  return drawLine(
    el,
    'ticker',
    items
      .slice(0, n)
      .flatMap((item, i) => [...(i > 0 ? [pad(3)] : []), { key: `run-${item.run.id}`, segs: item.segs }]),
  )
}

// ---------- route ----------

/** How long a new decision is marked `▶` (and a changed route drawn inverse). */
const FLASH_MS = 2_500

const isLow = (r: Route): boolean => r.confidence < LOW_CONFIDENCE
/** The route's accent: warn under the confidence floor, else its model's series color. */
const routeColor = (c: Ctx, r: Route): string => (isLow(r) ? c.p.warn : modelColor(c, r.model))

/** `main`, or the subagent's label as the table shows it. */
const loopName = (c: Ctx, id: string): string =>
  id === MAIN ? MAIN : (c.list.find(l => l.id === id)?.label ?? id)

/** The trail: one `◆` per decision in its model's color, `◇` under the floor, newest last and bold. */
const trailSegs = (c: Ctx, n: number): Seg[] => {
  const shown = c.routes.slice(-Math.max(0, n))
  return shown.map((r, i) => ({
    text: isLow(r) ? '◇' : '◆',
    color: modelColor(c, r.model),
    ...(i === shown.length - 1 ? { bold: true } : {}),
  }))
}

/**
 * The router stayed on the session's model (0.2.0 adaptive): `kept`, `hint` with
 * a delegation hint, `escalated` (0.7.0 `task` mode) with the escalation directive,
 * or `vague` (`task` mode, the prompt specified no task, nothing committed).
 */
const isKept = (r: Route): boolean =>
  r.action === 'kept' || r.action === 'hint' || r.action === 'escalated' || r.action === 'vague'

/** `ctx 150k`, when the decision carries the main loop's context. */
const ctxText = (r: Route): string | undefined =>
  r.contextTokens === undefined ? undefined : `ctx ${fmtTokens(r.contextTokens)}`

/**
 * `hint opus 5.5`: the model a kept decision would have switched to, in its color;
 * `escalated → opus 5.5` for an escalation (`escalated` alone without a model);
 * `vague` for a prompt that committed nothing; `commit` after a decision that
 * committed the session's model (`task` mode).
 */
const hintSegs = (c: Ctx, r: Route): Seg[] => {
  if (r.action === 'vague') {
    return [{ text: 'vague', color: noteColor(c), bold: true }]
  }
  if (r.committed === true && r.action !== 'switched') {
    return [...noteSegs(c, r), ...(noteSegs(c, r).length > 0 ? [{ text: ' · ', color: c.p.muted }] : []), { text: 'commit', color: c.p.ok, bold: true }]
  }
  return noteSegs(c, r)
}

/** `vague`'s color: a pink of its own, apart from the amber of a low confidence. */
const noteColor = (c: Ctx): string => c.p.series[3] ?? c.p.warn

const noteSegs = (c: Ctx, r: Route): Seg[] => {
  if (r.action === 'hint' && r.suggested !== undefined) {
    return [
      { text: 'hint ', color: c.p.info, bold: true },
      { text: prettyModel(r.suggested), color: modelColor(c, r.suggested) },
    ]
  }
  if (r.action === 'escalated') {
    return r.suggested !== undefined
      ? [
          { text: 'escalated → ', color: c.p.warn, bold: true },
          { text: prettyModel(r.suggested), color: modelColor(c, r.suggested) },
        ]
      : [{ text: 'escalated', color: c.p.warn, bold: true }]
  }
  return []
}

/**
 * The action part of the route line: `· ctx 150k · hint opus 5.5` right after a
 * kept model, `switched · ctx 12.0k` after the loop; the alt drops the context.
 * None for a decision without an action (subagent, session start, pin).
 */
const actionOpt = (c: Ctx, r: Route): { rank: number; part: Group; alt?: Group } | undefined => {
  const ctx = ctxText(r)
  const dot: Seg = { text: ' · ', color: c.p.muted }
  if (isKept(r)) {
    const hint = hintSegs(c, r)
    const full: Seg[] = [
      ...(ctx !== undefined ? [dot, { text: ctx, color: c.p.muted }] : []),
      ...(hint.length > 0 ? [dot, ...hint] : []),
    ]
    if (full.length === 0) {
      return undefined
    }
    return {
      rank: 0,
      part: { key: 'route-action', segs: full },
      ...(ctx !== undefined && hint.length > 0 ? { alt: { key: 'route-action', segs: [dot, ...hint] } } : {}),
    }
  }
  if (r.action === 'switched') {
    const word: Seg = { text: 'switched', color: c.p.ok, bold: true }
    const commit: Seg[] = r.committed === true ? [dot, { text: 'commit', color: c.p.ok, bold: true }] : []
    return {
      rank: 2,
      part: {
        key: 'route-action',
        segs: [pad(3), word, ...commit, ...(ctx !== undefined ? [dot, { text: ctx, color: c.p.muted }] : [])],
      },
      ...(ctx !== undefined ? { alt: { key: 'route-action', segs: [pad(3), word, ...commit] } } : {}),
    }
  }
  return undefined
}

/** Whether `r`, the latest, is new (inside FLASH_MS) and whether it moved off the one before. */
const freshness = (c: Ctx, r: Route): { fresh: boolean; changed: boolean } => {
  const age = c.now - r.at
  const fresh = age >= 0 && age < FLASH_MS
  const prev = c.routes.length >= 2 ? c.routes[c.routes.length - 2] : undefined
  return { fresh, changed: fresh && prev !== undefined && (prev.route !== r.route || prev.model !== r.model) }
}

/**
 * The router's decisions, exactly `width` wide:
 * `ROUTE ▶ coding/high → ▌ opus 5.5   high   conf ███▊ 0.82   jev   @main   3s ago     ◆◆◇◆◆`.
 * The category carries the difficulty (`/high`) when the decision has one; it is
 * the first thing dropped when the room runs short.
 * Always the route and model; then, while they fit: the confidence (bar, else the
 * number), 3 trail marks, the loop, the age, the effort, the backend; the trail
 * takes what room is left. `▶` and an inverse route mark a fresh decision.
 * A kept decision reads `fast → kept ▌ sonnet 5.5 · ctx 150k · hint opus 5.5`
 * (its action claims room first); a switch adds `switched · ctx 12.0k` after the loop.
 */
export const routeLine = (el: El, c: Ctx, width: number) => {
  const r = c.route
  if (r === null) {
    return drawLine(el, 'route', [pad(width)])
  }
  const { fresh, changed } = freshness(c, r)
  const accent = routeColor(c, r)
  const conf = r.confidence.toFixed(2)
  const confColor = isLow(r) ? c.p.warn : (c.p.series[2] ?? c.p.text)
  // `coding/high` with a difficulty; the flash's inverse covers the whole label.
  const coreOf = (label: string): Group => ({
    key: 'route-core',
    segs: [
      { text: 'ROUTE ', color: c.p.muted, bold: true },
      { text: fresh ? '▶ ' : '  ', color: accent, bold: true },
      changed
        ? { text: ` ${label} `, color: accent, bold: true, inverse: true }
        : { text: label, color: isLow(r) ? c.p.warn : c.p.text, bold: true },
      { text: ' → ', color: c.p.muted },
      ...(isKept(r) ? [{ text: 'kept ', color: c.p.info, bold: true }] : []),
      { text: '▌', color: modelColor(c, r.model) },
      { text: ` ${prettyModel(r.model)}`, color: c.p.text },
    ],
  })
  // Each optional part, in the order of the line; `rank` is who claims the room first.
  type Opt = { rank: number; part: Group; alt?: Group }
  const action = actionOpt(c, r)
  const opts: Opt[] = [
    ...(action !== undefined && isKept(r) ? [action] : []),
    ...(r.effort !== undefined
      ? [{ rank: 5, part: { key: 'route-effort', segs: [pad(3), { text: r.effort, color: c.p.muted }] } }]
      : []),
    {
      rank: 1,
      part: {
        key: 'route-conf',
        segs: [
          pad(3),
          { text: 'conf ', color: c.p.muted },
          { text: hbar(r.confidence, 5), color: confColor },
          { text: ` ${conf}`, color: isLow(r) ? c.p.warn : c.p.text },
        ],
      },
      alt: { key: 'route-conf', segs: [pad(2), { text: conf, color: isLow(r) ? c.p.warn : c.p.text }] },
    },
    { rank: 6, part: { key: 'route-backend', segs: [pad(3), { text: r.backend, color: c.p.muted }] } },
    {
      rank: 3,
      part: { key: 'route-loop', segs: [pad(3), { text: `@${clip(loopName(c, r.loop), 16)}`, color: c.p.muted }] },
    },
    { rank: 4, part: { key: 'route-age', segs: [pad(3), { text: fmtAgo(c.now - r.at), color: c.p.muted }] } },
    ...(action !== undefined && !isKept(r) ? [action] : []),
  ]
  // The trail sits on the right, 3 columns clear: it claims 3 marks after the
  // confidence, and whatever room is left over at the end.
  const marks = c.routes.length > 1 ? c.routes.length : 0
  const layout = (core: Group) => {
    let used = widthOf([core])
    let trailN = 0
    const picked = new Map<Opt, Group>()
    for (const o of [...opts].sort((x, y) => x.rank - y.rank)) {
      for (const g of [o.part, o.alt]) {
        if (g !== undefined && used + widthOf([g]) <= width) {
          picked.set(o, g)
          used += widthOf([g])
          break
        }
      }
      if (o.rank === 1 && marks > 0 && used + 3 + Math.min(marks, 3) <= width) {
        trailN = Math.min(marks, 3)
        used += 3 + trailN
      }
    }
    const spare = width - used
    trailN = trailN > 0 ? Math.min(marks, trailN + spare) : Math.max(0, Math.min(marks, spare - 3))
    const left: Part[] = [core, ...opts.filter(o => picked.has(o)).map(o => picked.get(o)!)]
    // Labelled `recent` where the trail would otherwise float alone at the far right.
    const recent = trailN > 0 && width - widthOf(left) - trailN >= 3 + 7 + 8
    return { picked, trailN, left, recent }
  }
  // The difficulty is the first thing to go: kept only while the line with it
  // fits and the line without it would show nothing more (the same parts, none
  // shortened, as many marks).
  const plain = layout(coreOf(r.route))
  const rated = r.difficulty !== undefined ? layout(coreOf(`${r.route}/${r.difficulty}`)) : undefined
  const fits = (l: NonNullable<typeof rated>) => widthOf(l.left) + (l.trailN > 0 ? l.trailN + (l.recent ? 7 : 0) : 0) <= width
  const { left, trailN, recent } =
    rated !== undefined &&
    fits(rated) &&
    rated.trailN === plain.trailN &&
    rated.recent === plain.recent &&
    opts.every(o => rated.picked.get(o) === plain.picked.get(o))
      ? rated
      : plain
  const leftW = widthOf(left)
  const label = recent ? [{ text: 'recent ', color: c.p.muted }] : []
  const trail: Part[] = trailN > 0 ? [...label, { key: 'route-trail', segs: trailSegs(c, trailN) }] : []
  return drawLine(el, 'route', [...left, pad(width - leftW - widthOf(trail)), ...trail])
}

/** The collapsed line's route: `→ opus 5.5 ◆◆◇` (`→ kept sonnet 5.5 · hint opus 5.5 ◆◆◇`), the model in its accent. */
const collapsedRoute = (c: Ctx, r: Route): Group => ({
  key: 'c-route',
  segs: [
    { text: '→ ', color: c.p.muted },
    ...(isKept(r) ? [{ text: 'kept ', color: c.p.info, bold: true }] : []),
    { text: prettyModel(r.model), color: routeColor(c, r), ...(freshness(c, r).fresh ? { bold: true } : {}) },
    ...(hintSegs(c, r).length > 0 ? [{ text: ' · ', color: c.p.muted }, ...hintSegs(c, r)] : []),
    ...(c.routes.length > 1 ? [pad(1), ...trailSegs(c, 4)] : []),
  ],
})

/** The one-line form: `NEXUS ● ENGAGED │ → opus 5.5 ◆◆◇ │ tok 212k │ cache 78% │ agents 2/5 │ $1.23 │ ⏱ 2m14s`. */
export const collapsedLine = (el: El, c: Ctx, t: Totals, width: number, expand: () => unknown, hide: () => unknown) => {
  const pulse = t.isRunning ? (c.frame % 2 === 0 ? '●' : '○') : '●'
  const segments: Group[] = [
    {
      key: 'c-title',
      segs: [
        { text: 'NEXUS ', color: c.p.text, bold: true },
        { text: pulse, color: t.isRunning ? c.p.warn : c.p.ok },
        { text: t.isRunning ? ' ENGAGED' : ' ONLINE', color: c.p.muted },
      ],
    },
    {
      key: 'c-tok',
      segs: [
        { text: 'tok ', color: c.p.faint },
        { text: fmtTokens(t.tokens), color: c.p.text },
      ],
    },
    {
      key: 'c-cache',
      segs: [
        { text: 'cache ', color: c.p.faint },
        { text: pct(cacheRate(t.tokensIn, t.cacheRead)), color: c.p.text },
      ],
    },
    {
      key: 'c-agents',
      segs: [
        { text: 'agents ', color: c.p.faint },
        { text: `${t.agentsActive}/${t.agents}`, color: c.p.text },
      ],
    },
    ...(c.hasPrices
      ? [
          {
            key: 'c-spend',
            segs: [
              {
                text: t.spend === undefined ? '$—' : fmtMoney(t.spend),
                color: t.spend === undefined ? c.p.faint : c.p.text,
              },
            ],
          },
        ]
      : []),
    {
      key: 'c-time',
      segs: [
        { text: '⏱ ', color: c.p.faint },
        { text: fmtDur(t.startedAt === undefined ? 0 : c.now - t.startedAt), color: c.p.muted },
      ],
    },
  ]
  const buttons: Part[] = [
    pad(3),
    { button: { key: 'expand', label: 'expand', seg: { text: 'expand', color: c.p.faint }, onPress: expand } },
    pad(2),
    { button: { key: 'hide', label: 'hide', seg: { text: 'hide', color: c.p.faint }, onPress: hide } },
  ]
  // The route, after the title, only where the line keeps its narrow ` │ ` gaps with it.
  if (c.route !== null) {
    const route = collapsedRoute(c, c.route)
    if (widthOf(segments) + widthOf(buttons) + 3 * segments.length + widthOf([route]) <= width) {
      segments.splice(1, 0, route)
    }
  }
  const textW = widthOf(segments) + widthOf(buttons)
  const gaps = segments.length - 1
  // Narrow: ` │ `; wide: the free width spread evenly over the gaps, a rule in each.
  const each = width >= WIDE ? Math.max(3, Math.floor((width - textW) / gaps)) : 3
  let spare = width >= WIDE ? Math.max(0, width - textW - each * gaps) : 0
  const parts: Part[] = []
  segments.forEach((s, i) => {
    if (i > 0) {
      const g = each + (spare > 0 ? 1 : 0)
      spare = Math.max(0, spare - 1)
      const lead = Math.floor((g - 1) / 2)
      parts.push(pad(lead), { text: '│', color: c.p.rule }, pad(g - 1 - lead))
    }
    parts.push(s)
  })
  return drawLine(el, 'band-line', [...parts, ...buttons])
}
