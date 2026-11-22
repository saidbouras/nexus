// router report: token use per session and model (`router.usage` in $.store),
// `/route report [n]` and `/route log export [path]`. Usage records and log
// entries hold token counts, labels and model ids only, never prompt text; the
// export writes exactly those. Every store write is queued behind this
// process's others so none is lost; recordUsage swallows every error.

import type { EngineInterface } from 'claude-code'

import type { RouteLogAction, RouteLogEntry, UsageRecord } from '../../types'
import { fmtMoney, parsePrices, stepCost } from '../hud/cost'
import { fmtTokens } from '../hud/hud'
import { formatAt, readLog, shortModel } from './log'

export const USAGE_KEY = 'router.usage'
export const USAGE_SESSIONS = 50
export const REPORT_SESSIONS = 10

/** One step's (or one consult's) token use, added to its session's record for that model. */
export type UsageDelta = {
  session: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** 1 for a `consult` call, else absent */
  consults?: number
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function isRecord(v: unknown): v is UsageRecord {
  if (v === null || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r.session === 'string' && typeof r.model === 'string' && typeof r.at === 'number'
}

/** The usage as stored: the valid records; anything else reads as empty. */
export function usageOf(stored: unknown): UsageRecord[] {
  return Array.isArray(stored) ? stored.filter(isRecord) : []
}

/** The latest `at` of each session, newest session first. */
function sessionsByRecency(records: readonly UsageRecord[]): string[] {
  const latest = new Map<string, number>()
  for (const r of records) latest.set(r.session, Math.max(latest.get(r.session) ?? -Infinity, r.at))
  return [...latest.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)
}

/**
 * The usage with `d` merged into its session+model record at `at`, cut to the
 * newest `cap` sessions (pure). A consult adds its calls, not a turn.
 */
export function mergedUsage(stored: unknown, d: UsageDelta, at: number, cap = USAGE_SESSIONS): UsageRecord[] {
  const all = usageOf(stored)
  const i = all.findIndex(r => r.session === d.session && r.model === d.model)
  const old: UsageRecord = i >= 0 ? (all[i] as UsageRecord) : { session: d.session, model: d.model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, at }
  const consults = count(d.consults)
  const next: UsageRecord = {
    session: d.session,
    model: d.model,
    turns: count(old.turns) + (consults > 0 ? 0 : 1),
    input: count(old.input) + count(d.input),
    output: count(old.output) + count(d.output),
    cacheRead: count(old.cacheRead) + count(d.cacheRead),
    cacheWrite: count(old.cacheWrite) + count(d.cacheWrite),
    ...(count(old.consults) + consults > 0 ? { consults: count(old.consults) + consults } : {}),
    at,
  }
  const merged = i >= 0 ? all.map((r, j) => (j === i ? next : r)) : [...all, next]
  const keep = new Set(sessionsByRecency(merged).slice(0, Math.max(1, cap)))
  return merged.filter(r => keep.has(r.session))
}

let usageWrites: Promise<unknown> = Promise.resolve()

/** Adds one delta to `router.usage`; never throws. */
export async function recordUsage($: EngineInterface, d: UsageDelta): Promise<void> {
  try {
    if (d === null || typeof d !== 'object' || typeof d.model !== 'string' || d.model === '') return
    const session = typeof d.session === 'string' ? d.session : ''
    const write = usageWrites.then(async () => {
      const at = await $.clock.now()
      await $.store.set(USAGE_KEY, mergedUsage(await $.store.get(USAGE_KEY), { ...d, session }, at))
    })
    usageWrites = write.catch(() => undefined)
    await write
  } catch {
    // usage is best-effort: nothing waits on a failed write
  }
}

export async function readUsage($: EngineInterface): Promise<UsageRecord[]> {
  return usageOf(await $.store.get(USAGE_KEY))
}

/** The `n` of `/route report [n]`: REPORT_SESSIONS when absent, 1 to USAGE_SESSIONS; undefined when not a number. */
export function parseSessions(arg: string | undefined): number | undefined {
  const a = arg?.trim()
  if (a === undefined || a === '') return REPORT_SESSIONS
  if (!/^\d+$/.test(a)) return undefined
  return Math.min(USAGE_SESSIONS, Math.max(1, Number(a)))
}

export const REPORT_USAGE = `usage: /route report [n]  (the last n sessions, 1-${USAGE_SESSIONS}, default ${REPORT_SESSIONS})`

type ModelSum = { model: string; turns: number; consults: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }

const tokensOf = (m: Pick<ModelSum, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => m.input + m.output + m.cacheRead + m.cacheWrite
const usageFor = (m: Pick<ModelSum, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>) => ({
  input_tokens: m.input,
  output_tokens: m.output,
  cache_read_input_tokens: m.cacheRead,
  cache_creation_input_tokens: m.cacheWrite,
})
const pctOf = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%')
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The decision counts the report shows, in this order; kept and hint together. */
const COUNTED: readonly (readonly [string, readonly RouteLogAction[]])[] = [
  ['switched', ['switched']],
  ['escalated', ['escalated']],
  ['consulted', ['consulted']],
  ['rerouted', ['rerouted']],
  ['vague', ['vague']],
  ['kept/hint', ['kept', 'hint']],
]

/**
 * The report text (pure): `records` and `log` as stored, the last `n` sessions,
 * priced with the HUD's table and uplift; the baseline prices the same tokens at
 * `baselineModel`.
 */
export function formatReport(records: readonly UsageRecord[], log: readonly RouteLogEntry[], n: number, options: Record<string, unknown> | undefined, baselineModel: string): string {
  const sessions = sessionsByRecency(records).slice(0, n)
  if (sessions.length === 0) return 'router report: no usage recorded yet.'
  const chosen = new Set(sessions)
  const recs = records.filter(r => chosen.has(r.session))
  const entries = log.filter(e => chosen.has(e.session))
  // The HUD's settings, read as hud/register.tsx `createHud` reads them.
  const prices = parsePrices(options?.prices)
  const uplift = typeof options?.upliftPct === 'number' && Number.isFinite(options.upliftPct) ? options.upliftPct : 0

  const byModel = new Map<string, ModelSum>()
  for (const r of recs) {
    const m = byModel.get(r.model) ?? { model: r.model, turns: 0, consults: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    m.turns += count(r.turns)
    m.consults += count(r.consults)
    m.input += count(r.input)
    m.output += count(r.output)
    m.cacheRead += count(r.cacheRead)
    m.cacheWrite += count(r.cacheWrite)
    byModel.set(r.model, m)
  }
  const models = [...byModel.values()]
  for (const m of models) {
    const c = stepCost(usageFor(m), m.model, prices, uplift)
    if (c !== undefined) m.cost = c
  }
  models.sort((a, b) => tokensOf(b) - tokensOf(a) || a.model.localeCompare(b.model))

  const turns = models.reduce((s, m) => s + m.turns, 0)
  const tokens = models.reduce((s, m) => s + tokensOf(m), 0)
  const priced = models.filter(m => m.cost !== undefined)
  const unpriced = models.filter(m => m.cost === undefined)
  const total = priced.reduce((s, m) => s + (m.cost as number), 0)

  const times = [...recs.map(r => r.at), ...entries.map(e => e.at)]
  const from = Math.min(...times)
  const to = Math.max(...times)
  const range = from === to ? formatAt(from) : `${formatAt(from)} – ${formatAt(to)}`
  const name = (m: string) => shortModel(m)
  const nameW = Math.max(5, ...models.map(m => name(m.model).length))

  const line = (label: string, m: Omit<ModelSum, 'model'>, share: boolean) =>
    [
      `  ${label.padEnd(nameW)}`,
      `${plural(m.turns, 'turn')}${share ? ` ${pctOf(m.turns, turns)}` : ''}`,
      `${fmtTokens(tokensOf(m))} tokens${share ? ` ${pctOf(tokensOf(m), tokens)}` : ''}`,
      `in ${fmtTokens(m.input)} · out ${fmtTokens(m.output)} · cache ${fmtTokens(m.cacheRead)} read / ${fmtTokens(m.cacheWrite)} write`,
      ...(m.consults > 0 ? [plural(m.consults, 'consult')] : []),
      m.cost !== undefined ? fmtMoney(m.cost) : 'no price',
    ].join('  ')

  const out: string[] = [`router report: ${plural(sessions.length, 'session')} · ${range}${uplift !== 0 ? ` · prices +${uplift}%` : ''}`]
  for (const m of models) out.push(line(name(m.model), m, true))
  const sum = models.reduce<Omit<ModelSum, 'model'>>(
    (s, m) => ({ turns: s.turns + m.turns, consults: s.consults + m.consults, input: s.input + m.input, output: s.output + m.output, cacheRead: s.cacheRead + m.cacheRead, cacheWrite: s.cacheWrite + m.cacheWrite }),
    { turns: 0, consults: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  out.push(line('total', priced.length > 0 ? { ...sum, cost: total } : sum, false))
  if (unpriced.length > 0) {
    out.push(`unpriced: ${unpriced.map(m => name(m.model)).join(', ')} (no entry in prices; left out of the cost, the baseline and the saving)`)
  }

  const base = name(baselineModel)
  const baseline = priced.length > 0 ? priced.reduce((s, m) => s + (stepCost(usageFor(m), baselineModel, prices, uplift) ?? NaN), 0) : undefined
  if (baseline === undefined) {
    out.push('baseline: no priced usage to compare.')
  } else if (!Number.isFinite(baseline)) {
    out.push(`baseline: ${base} has no price; no saving computed.`)
  } else {
    const saving = baseline - total
    out.push(`baseline: the same tokens at ${base} ${fmtMoney(baseline)} (estimate: another model would have used different tokens)`)
    out.push(`saving: ${saving < 0 ? '-' : ''}${fmtMoney(Math.abs(saving))} (${baseline > 0 ? `${Math.round((saving / baseline) * 100)}%` : '0%'})`)
  }

  const counts = COUNTED.map(([label, actions]) => `${entries.filter(e => actions.includes(e.action)).length} ${label}`)
  out.push(`decisions: ${counts.join(' · ')}${entries.length === 0 ? ' (none in the decision log for these sessions)' : ''}`)
  return out.join('\n')
}

/**
 * `/route report [n]`: the text for the last n sessions (default 10).
 * `options` is the plugin's raw options (for `prices`, `upliftPct`);
 * `baselineModel` is the model the baseline prices every token at (the profile's frontier model).
 */
export async function reportCommand($: EngineInterface, arg: string | undefined, options: Record<string, unknown> | undefined, baselineModel: string): Promise<string> {
  const n = parseSessions(arg)
  if (n === undefined) return REPORT_USAGE
  try {
    return formatReport(await readUsage($), await readLog($), n, options, baselineModel)
  } catch {
    return 'router report: the usage could not be read.'
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `nexus-route-20261111-0932.jsonl`, local time. */
export function defaultExportPath(at: number): string {
  const d = new Date(at)
  return `nexus-route-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.jsonl`
}

/** The JSONL text (pure): one `decision` line per log entry, one `usage` line per record; '' when both are empty. */
export function exportLines(log: readonly RouteLogEntry[], records: readonly UsageRecord[]): string {
  const lines = [...log.map(e => JSON.stringify({ type: 'decision', ...e })), ...records.map(r => JSON.stringify({ type: 'usage', ...r }))]
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')

/** `/route log export [path]`: writes the JSONL file and returns the confirmation text. */
export async function exportCommand($: EngineInterface, path: string | undefined): Promise<string> {
  try {
    const given = path?.trim()
    const target = given !== undefined && given !== '' ? given : defaultExportPath(await $.clock.now())
    const log = await readLog($)
    const records = await readUsage($)
    // A relative path is under the session's working directory: written there in full, so the message names the file written.
    let full = target
    if (!isAbsolute(target)) {
      const cwd = await $.session.cwd().catch(() => undefined)
      if (typeof cwd === 'string' && cwd !== '') full = `${cwd.replace(/[\\/]+$/, '')}/${target.replace(/^\.[\\/]/, '')}`
    }
    try {
      await $.fs.write(full, exportLines(log, records))
    } catch (err) {
      const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '').replace(/^.*?\$\.fs\.write:\s*/, '') : ''
      return `router: export failed, ${full} could not be written${msg ? `: ${msg}` : ''}.`
    }
    return `router: exported ${plural(log.length, 'decision')} and ${plural(records.length, 'usage record')} to ${full}.`
  } catch {
    return 'router: export failed, the log could not be read.'
  }
}
