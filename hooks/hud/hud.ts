// Pure render helpers for the NEXUS dashboard: no `$`, no state, unit-tested.

import type { Loop, RouteMark, ToolRun } from '../../types'

// ---------- palette ----------

export type Palette = {
  text: string
  muted: string
  faint: string
  rule: string
  ok: string
  /** state words that are neither good nor bad: `kept`, `hint` */
  info: string
  warn: string
  err: string
  /** data series only: violet, orange, teal, pink, blue, green */
  series: readonly string[]
}

const HEX: Palette = {
  text: '#e8e8ea',
  muted: '#8d919a',
  faint: '#7b8089',
  rule: '#3b3e45',
  ok: '#4ade80',
  info: '#60a5fa',
  warn: '#f5b84b',
  err: '#f87171',
  series: ['#a78bfa', '#f59e4b', '#2dd4bf', '#f472b6', '#60a5fa', '#4ade80'],
}

const NAMED: Palette = {
  text: 'white',
  muted: 'gray',
  faint: 'gray',
  rule: 'gray',
  ok: 'green',
  info: 'cyan',
  warn: 'yellow',
  err: 'red',
  series: ['magenta', 'yellow', 'cyan', 'magentaBright', 'blue', 'green'],
}

/** Hex tokens on a truecolor terminal; the 16 named colors otherwise. */
export const palette = (isPalette16: boolean): Palette => (isPalette16 ? NAMED : HEX)

/** Whether `COLORTERM` says the terminal draws 24-bit color. */
export const isTruecolor = (colorterm: string | undefined): boolean => /truecolor|24bit/i.test(colorterm ?? '')

export const seriesColor = (p: Palette, index: number): string =>
  p.series[((index % p.series.length) + p.series.length) % p.series.length] ?? p.text

const LOCAL = /qwen|llama|ollama|local|gemma|mistral|phi|deepseek/i

/** A model's series slot: opus violet, local orange, haiku teal, fable pink, sonnet blue, other green. */
export const modelSlot = (model: string | undefined): number => {
  const low = (model ?? '').toLowerCase()
  return low.includes('opus')
    ? 0
    : LOCAL.test(low)
      ? 1
      : low.includes('haiku')
        ? 2
        : low.includes('fable')
          ? 3
          : low.includes('sonnet')
            ? 4
            : 5
}

// ---------- glyphs and numbers ----------

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
/** Left-anchored eighths, 1/8 to 7/8. */
const LEFT_EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
/** Bottom-anchored eighths, 1/8 to 7/8. */
const LOW_EIGHTHS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇'] as const

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)

/** `▰▰▰▱▱` gauge: `fraction` of `width` cells filled (at least one when above 0). */
export const bar = (fraction: number, width: number): string => {
  const w = Math.max(1, Math.floor(width))
  const f = clamp01(fraction)
  const filled = f > 0 ? Math.max(1, Math.round(f * w)) : 0
  return '▰'.repeat(filled) + '▱'.repeat(w - filled)
}

/**
 * A horizontal bar at eighth-cell precision, exactly `width` cells (padded with
 * spaces): `hbar(0.5, 4)` is `██  `, `hbar(0.3, 4)` is `█▎  `. Above 0 shows at least ▏.
 */
export const hbar = (fraction: number, width: number): string => {
  const w = Math.max(0, Math.floor(width))
  const f = clamp01(fraction)
  let eighths = Math.round(f * w * 8)
  if (f > 0 && eighths === 0 && w > 0) {
    eighths = 1
  }
  const full = Math.floor(eighths / 8)
  const part = LEFT_EIGHTHS[eighths % 8] ?? ''
  return '█'.repeat(full) + part + ' '.repeat(Math.max(0, w - full - (part ? 1 : 0)))
}

/** `▁▂▃▅▇` of the values, scaled to their max; empty for no values. */
export const sparkline = (values: readonly number[]): string => {
  if (values.length === 0) {
    return ''
  }
  const max = Math.max(0, ...values)
  return values
    .map(v =>
      max <= 0 ? SPARKS[0] : SPARKS[Math.min(SPARKS.length - 1, Math.round(clamp01(v / max) * (SPARKS.length - 1)))],
    )
    .join('')
}

/** The spinner frame for a tick. */
export const spinner = (tick: number): string => SPINNER[Math.abs(Math.floor(tick)) % SPINNER.length] ?? SPINNER[0]

export const fmtTokens = (n: number): string =>
  n < 1000
    ? `${Math.round(n)}`
    : n < 1_000_000
      ? `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`
      : `${Number((n / 1_000_000).toFixed(2))}M`

/** `350ms`, `1.2s`, `2m14s`, `1h02m`. */
export const fmtDur = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`
  }
  const s = Math.floor(ms / 1000)
  if (s < 3600) {
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

/** cacheRead / (in + cacheRead), 0 when nothing was read. */
export const cacheRate = (tokensIn: number, cacheRead: number): number => {
  const all = tokensIn + cacheRead
  return all > 0 ? cacheRead / all : 0
}

export const pct = (fraction: number): string => `${Math.round(clamp01(fraction) * 100)}%`

/** Cuts text to `max` columns with an ellipsis. */
export const clip = (text: string, max: number): string =>
  max <= 1 ? text.slice(0, Math.max(0, max)) : text.length > max ? `${text.slice(0, max - 1)}…` : text

/** Pads or clips text to exactly `width` columns. */
export const fit = (text: string, width: number, align: 'left' | 'right' = 'left'): string => {
  const t = clip(text, Math.max(0, width))
  return align === 'right' ? t.padStart(width) : t.padEnd(width)
}

/**
 * The box-drawing prefix of a tree row: `lasts` holds, for each ancestor level
 * below the root and then the row itself, whether that node is its parent's last child.
 */
export const connector = (lasts: readonly boolean[]): string => {
  if (lasts.length === 0) {
    return ''
  }
  const trunk = lasts
    .slice(0, -1)
    .map(isLast => (isLast ? '  ' : '│ '))
    .join('')
  return trunk + (lasts[lasts.length - 1] ? '└ ' : '├ ')
}

/** How many of the items fit one line of `width`, given each one's width and a gap. */
export const fitCount = (widths: readonly number[], width: number, gap: number): number => {
  let used = 0
  let n = 0
  for (const w of widths) {
    const next = used + (n > 0 ? gap : 0) + w
    if (next > width) {
      break
    }
    used = next
    n += 1
  }
  return n
}

// ---------- tools ----------

/** `mcp__<server>__<tool>` → `<tool>`; any other name as is. */
export const shortTool = (name: string): string => name.replace(/^mcp__.+?__/, '')

export type ToolSummary = { text: string; idle: boolean }

/**
 * The tools in use over every loop, at most `width` columns: the running ones
 * grouped by name, newest first (`Bash ×2 · Read`); while none runs, the latest
 * finished names (`last Edit · Bash`, `idle` set). Names past the width count as
 * `+N`. Undefined when there is no tool yet or not even a clipped first name fits.
 */
export const toolSummary = (
  list: readonly { tools: readonly ToolRun[] }[],
  width: number,
): ToolSummary | undefined => {
  const runs = list
    .flatMap(l => l.tools)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.startedAt - a.t.startedAt || b.i - a.i)
    .map(x => x.t)
  const live = runs.filter(t => t.status === 'running')
  const idle = live.length === 0
  const counts = new Map<string, number>()
  for (const t of idle ? runs : live) {
    const name = shortTool(t.tool)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const items = [...counts].map(([name, n]) => (!idle && n > 1 ? `${name} ×${n}` : name))
  if (items.length === 0) {
    return undefined
  }
  const head = idle ? 'last ' : ''
  const more = (rest: number) => (rest > 0 ? ` +${rest}` : '')
  for (let k = items.length; k >= 1; k--) {
    const text = head + items.slice(0, k).join(' · ') + more(items.length - k)
    if (text.length <= width) {
      return { text, idle }
    }
  }
  // Not even the first name fits whole: clip it, keeping at least five of its characters.
  const room = width - head.length - more(items.length - 1).length
  const first = clip(items[0] ?? '', room).replace(/ +…$/, '…')
  return room >= 6 ? { text: head + first + more(items.length - 1), idle } : undefined
}

// ---------- stalls ----------

/**
 * The subagents running and silent for at least `stallMs`: no event of theirs
 * since `activeAt`. The main loop (no parent) is never one of them.
 */
export const stalledLoops = (list: readonly Loop[], now: number, stallMs: number): Loop[] =>
  list.filter(l => l.parent !== undefined && l.status === 'running' && now - l.activeAt >= stallMs)

/** The message the main session gets about a silent subagent: what it is doing and what to do. */
export const stallText = (l: Loop, now: number, stallMs: number): string => {
  const minutes = Math.round(stallMs / 60_000)
  const running = l.tools.filter(t => t.status === 'running').map(t => shortTool(t.tool))
  const busy = running.length > 0 ? `, still running ${running.join(', ')}` : ''
  return (
    `NEXUS: subagent "${l.label}" (${l.id}) has sent nothing for ${minutes} min` +
    ` (last activity ${Math.round((now - l.activeAt) / 60_000)} min ago${busy}). ` +
    'Check on it: ask it for a status with SendMessage. If it is stuck, stop it, and tell the user what you found.'
  )
}

// ---------- models ----------

/** Strips the gateway prefixes: `system.ai.` and `databricks-`. */
export const shortModel = (model: string | undefined): string =>
  (model ?? '?').replace(/^system\.ai\./, '').replace(/^databricks-/, '')

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'] as const

/** `system.ai.claude-opus-5-5[1m]` → `opus 5.5`; `qwen3.6:35b-a3b` → `qwen3.6`. */
export const prettyModel = (model: string | undefined): string => {
  const base = shortModel(model)
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^claude-/, '')
  const family = FAMILIES.find(f => base.toLowerCase().includes(f))
  if (family !== undefined) {
    const version = (base.match(/\d+/g) ?? []).filter(d => d.length <= 2).join('.')
    return version ? `${family} ${version}` : family
  }
  return base.split(':')[0] || '?'
}

// ---------- layout helpers ----------

/**
 * A KPI tile: `short` and `alt` stand in for the label and value where the tile is too narrow;
 * `dim` draws the value muted (a resting state, not a live number).
 */
export type Tile = { id: string; label: string; value: string; short?: string; alt?: string; dim?: boolean }

/**
 * KPI tiles spread over `width`: each tile's width, `gap` columns (the `│` rule)
 * between them, the remainder handed to the first tiles.
 */
export const kpiTiles = (tiles: readonly Tile[], width: number, gap = 3): number[] => {
  const n = tiles.length
  if (n === 0) {
    return []
  }
  const free = Math.max(n, width - gap * (n - 1))
  const base = Math.floor(free / n)
  const extra = free - base * n
  return tiles.map((_, i) => base + (i < extra ? 1 : 0))
}

export type Column = {
  id: string
  title: string
  align: 'left' | 'right'
  /** a fixed width (the title's length when neither width nor flex is given) */
  width?: number
  /** a share of what the fixed columns leave */
  flex?: number
  /** a flex column's least width */
  min?: number
}

/**
 * Column widths for a table `width` wide with `gap` between columns: fixed
 * columns as given, flex ones sharing the rest (at least their `min`); the
 * rounding leftover goes to the first flex column so a row is exactly `width`.
 */
export const table = (columns: readonly Column[], width: number, gap = 2): number[] => {
  const fixedW = (c: Column) => c.width ?? c.title.length
  const fixed = columns.reduce((s, c) => s + (c.flex === undefined ? fixedW(c) : 0), 0)
  const gaps = gap * Math.max(0, columns.length - 1)
  const flexTotal = columns.reduce((s, c) => s + (c.flex ?? 0), 0)
  const free = Math.max(0, width - fixed - gaps)
  const widths = columns.map(c =>
    c.flex === undefined ? fixedW(c) : Math.max(c.min ?? 1, Math.floor((free * c.flex) / flexTotal)),
  )
  const used = widths.reduce((s, w) => s + w, 0) + gaps
  const firstFlex = columns.findIndex(c => c.flex !== undefined)
  if (firstFlex >= 0 && used < width) {
    widths[firstFlex] = (widths[firstFlex] ?? 0) + (width - used)
  }
  return widths
}

export type ChartCell = { ch: string; series: string | null }

export type Chart = {
  /** top row first; each row `width` cells */
  rows: ChartCell[][]
  /** series by total, largest first: the stacking order, bottom up */
  series: { key: string; total: number }[]
  /** the tallest column's total */
  max: number
}

/**
 * A stacked bar chart of `points` over time: up to `width` time buckets (one per
 * point at most, spread over the width, newest at the right), `height` rows, each column
 * stacked by series (largest series at the bottom), the top cell an eighth block.
 */
export const stackedColumns = (
  points: readonly { at: number; key: string; value: number }[],
  width: number,
  height: number,
): Chart => {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const totals = new Map<string, number>()
  for (const p of points) {
    totals.set(p.key, (totals.get(p.key) ?? 0) + Math.max(0, p.value))
  }
  const series = [...totals.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
  const order = new Map(series.map((s, i) => [s.key, i]))
  // As many time buckets as points (at most one per column); a bucket wider than
  // two cells draws as a bar with a one-cell gap after it.
  const nb = Math.max(1, Math.min(w, points.length))
  const span = w / nb
  const buckets: Map<string, number>[] = Array.from({ length: nb }, () => new Map())
  if (points.length > 0) {
    const t0 = Math.min(...points.map(p => p.at))
    const t1 = Math.max(...points.map(p => p.at))
    for (const p of points) {
      const i = t1 === t0 ? nb - 1 : Math.min(nb - 1, Math.floor(((p.at - t0) / (t1 - t0)) * (nb - 1) + 0.5))
      const b = buckets[i]!
      b.set(p.key, (b.get(p.key) ?? 0) + Math.max(0, p.value))
    }
  }
  const colTotals = buckets.map(b => [...b.values()].reduce((s, v) => s + v, 0))
  const max = Math.max(0, ...colTotals)
  const grid: ChartCell[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => ({ ch: ' ', series: null })),
  )
  buckets.forEach((b, bi) => {
    const total = colTotals[bi] ?? 0
    const x0 = Math.floor(bi * span)
    const x1 = Math.max(x0 + 1, Math.floor((bi + 1) * span) - (span >= 3 ? 1 : 0))
    if (total <= 0 || max <= 0) {
      return
    }
    const eighths = Math.max(1, Math.round((total / max) * h * 8))
    // Segment tops, in eighths from the bottom, in stacking order.
    const segs = [...b.entries()].sort((p, q) => (order.get(p[0]) ?? 0) - (order.get(q[0]) ?? 0))
    let cum = 0
    const bounds = segs.map(([key, v]) => {
      cum += v
      return { key, top: Math.round((cum / total) * eighths) }
    })
    const at = (pos: number): string => bounds.find(s => pos < s.top)?.key ?? bounds[bounds.length - 1]!.key
    for (let r = 0; r < h; r++) {
      const filled = Math.min(8, Math.max(0, eighths - r * 8))
      if (filled === 0) {
        continue
      }
      const cell: ChartCell =
        filled === 8
          ? { ch: '█', series: at(r * 8 + 4) }
          : { ch: LOW_EIGHTHS[filled] ?? '▁', series: at(r * 8 + filled - 1) }
      for (let x = x0; x < Math.min(w, x1); x++) {
        grid[h - 1 - r]![x] = { ...cell }
      }
    }
  })
  return { rows: grid, series, max }
}

// ---------- routes ----------

/** How many router decisions the trail keeps. */
export const MAX_ROUTES = 12
/** Below this the router falls back to general: drawn in the warn color. */
export const LOW_CONFIDENCE = 0.6

/** The history with `mark` last: one mark per `at` (a repeat replaces it in place), at most `cap`. */
export const pushRoute = <M extends { at: number }>(list: readonly M[], mark: M, cap = MAX_ROUTES): M[] => {
  const i = list.findIndex(m => m.at === mark.at)
  const out = i >= 0 ? list.map((m, j) => (j === i ? mark : m)) : [...list, mark]
  return out.sort((a, b) => a.at - b.at).slice(-Math.max(1, cap))
}

/** The difficulties a mark keeps; anything else is dropped. */
const DIFFICULTIES: ReadonlySet<unknown> = new Set(['low', 'medium', 'high'])

/**
 * A router decision as a trail mark; null for anything not shaped like one. The
 * adaptive fields (action, contextTokens, suggested) and the difficulty are
 * copied only when present (the difficulty only when low, medium or high).
 */
export const toMark = (last: unknown): RouteMark | null => {
  if (last === null || typeof last !== 'object') {
    return null
  }
  const d = last as Record<string, unknown>
  if (typeof d.route !== 'string' || typeof d.at !== 'number') {
    return null
  }
  const effort = typeof d.effort === 'string' || typeof d.effort === 'number' ? String(d.effort) : undefined
  return {
    loop: typeof d.loop === 'string' ? d.loop : 'main',
    route: d.route,
    ...(DIFFICULTIES.has(d.difficulty) ? { difficulty: d.difficulty as string } : {}),
    model: typeof d.model === 'string' ? d.model : '?',
    ...(effort !== undefined ? { effort } : {}),
    confidence: typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : 0,
    backend: typeof d.backend === 'string' ? d.backend : '?',
    at: d.at,
    ...(typeof d.action === 'string' ? { action: d.action } : {}),
    ...(typeof d.contextTokens === 'number' && Number.isFinite(d.contextTokens)
      ? { contextTokens: d.contextTokens }
      : {}),
    ...(typeof d.suggested === 'string' ? { suggested: d.suggested } : {}),
    ...(d.committed === true ? { committed: true } : {}),
  }
}

/** `now`, `4s ago`, `3m ago`, `1h ago`: the age of a decision, whole units only. */
export const fmtAgo = (ms: number): string =>
  !Number.isFinite(ms) || ms < 1000
    ? 'now'
    : ms < 60_000
      ? `${Math.floor(ms / 1000)}s ago`
      : ms < 3_600_000
        ? `${Math.floor(ms / 60_000)}m ago`
        : `${Math.floor(ms / 3_600_000)}h ago`
