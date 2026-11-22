// Pure cost helpers for the NEXUS HUD. No runtime imports from the engine.

export type Price = { inPerM: number; outPerM: number; cacheReadPerM?: number; cacheWritePerM?: number }
export type PriceTable = Record<string, Price>
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

// The default table: public list prices, USD per 1M tokens, from
// https://www.databricks.com/product/pricing/proprietary-foundation-model-serving
// (retrieved 2026-10-18, DBU/1M × $0.07); cacheWrite = 5-minute rate; haiku-5-5 =
// short-context rate; opus/sonnet [1m] same as standard. A default only: the `prices`
// setting overrides any entry or adds models, `upliftPct` scales them all.
export const DEFAULT_PRICES: PriceTable = Object.freeze({
  'haiku-5-5': { inPerM: 0.1, outPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 },
  'sonnet-5-5': { inPerM: 2.0, outPerM: 10.0, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  'opus-5-5': { inPerM: 4.0, outPerM: 20.0, cacheReadPerM: 0.2, cacheWritePerM: 5.0 },
  'haiku-4-5': { inPerM: 1.0, outPerM: 5.0, cacheReadPerM: 0.1, cacheWritePerM: 1.25 },
}) as PriceTable

const okNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

function toPrice(v: unknown): Price | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (!okNum(o.inPerM) || !okNum(o.outPerM)) return undefined
  const p: Price = { inPerM: o.inPerM, outPerM: o.outPerM }
  for (const k of ['cacheReadPerM', 'cacheWritePerM'] as const) {
    if (o[k] === undefined) continue
    if (!okNum(o[k])) return undefined
    p[k] = o[k] as number
  }
  return p
}

/** Parse the userConfig JSON (string or already-parsed object). Defaults on empty/invalid input. */
export function parsePrices(raw: unknown): PriceTable {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return DEFAULT_PRICES
    try {
      obj = JSON.parse(raw)
    } catch {
      return DEFAULT_PRICES
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return DEFAULT_PRICES
  const out: PriceTable = { ...DEFAULT_PRICES }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = normModel(k)
    const p = toPrice(v)
    if (key && p) out[key] = p
  }
  return out
}

/** Normalise a model id: strip `system.ai.`, `databricks-`, `claude-`, `[…]` suffix; lower-case. */
export function normModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]\s*$/, '')
    .replace(/system\.ai\./g, '')
    .replace(/databricks-/g, '')
    .replace(/claude-/g, '')
    .trim()
}

/** A bare alias (`opus`, `claude-sonnet`) stands for its family's newest default. */
const ALIASES: ReadonlyMap<string, string> = new Map([
  ['opus', 'opus-5-5'],
  ['sonnet', 'sonnet-5-5'],
  ['haiku', 'haiku-5-5'],
])

/**
 * Longest table key contained in the normalised model id wins, so `claude-opus-5-5`,
 * `claude-opus-5-5-20261001`, `system.ai.claude-opus-5-5[1m]` and a bare `opus` all
 * find `opus-5-5`; a table key for the bare family (`opus`) beats the alias.
 */
export function priceFor(model: string, table: PriceTable): Price | undefined {
  if (typeof model !== 'string' || !model) return undefined
  const norm = normModel(model)
  const alias = ALIASES.get(norm)
  const m = alias !== undefined && !Object.keys(table).some(k => normModel(k) === norm) ? alias : norm
  let best: string | undefined
  for (const k of Object.keys(table)) {
    const nk = normModel(k)
    if (nk && m.includes(nk) && (best === undefined || nk.length > normModel(best).length)) best = k
  }
  return best === undefined ? undefined : table[best]
}

/** USD for one step; undefined for unknown models (never 0, never a guess). */
export function stepCost(usage: Usage, model: string, table: PriceTable, upliftPct = 0): number | undefined {
  const p = priceFor(model, table)
  if (!p) return undefined
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0)
  const raw =
    n(usage.input_tokens) * p.inPerM +
    n(usage.output_tokens) * p.outPerM +
    n(usage.cache_read_input_tokens) * (p.cacheReadPerM ?? p.inPerM) +
    n(usage.cache_creation_input_tokens) * (p.cacheWritePerM ?? p.inPerM)
  return (raw / 1e6) * (1 + (Number.isFinite(upliftPct) ? upliftPct : 0) / 100)
}

export function fmtMoney(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '—'
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  if (usd < 1000) return `$${Math.round(usd)}`
  return `$${(usd / 1000).toFixed(1)}k`
}

/** JSON-serialisable running totals (per loop, per model, …). */
export type CostTotals = { total: number; by: Record<string, number> }

export const emptyTotals = (): CostTotals => ({ total: 0, by: {} })

/** Immutable add; undefined/invalid usd leaves totals unchanged. */
export function addCost(totals: CostTotals | undefined, key: string, usd: number | undefined): CostTotals {
  const t = totals ?? emptyTotals()
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return t
  return { total: t.total + usd, by: { ...t.by, [key]: (t.by[key] ?? 0) + usd } }
}

/** Fraction (0..1) of the total attributed to key; 0 when total is 0. */
export function share(totals: CostTotals | undefined, key: string): number {
  if (!totals || !(totals.total > 0)) return 0
  return (totals.by[key] ?? 0) / totals.total
}
