// nexus router: the decision log. Every main-loop and subagent routing
// outcome is appended to `router.log` in the plugin's own `$.store` (kept
// between sessions), newest last, at most LOG_CAP entries. An entry holds
// the decision's labels, models and sizes, never any prompt text. `/route
// log [n]` prints it newest first; `/route log clear` empties it. Writing is
// best-effort: the caller (register.ts `record`) swallows every error, so a
// failed write never changes or holds up routing.

import type { EngineInterface } from 'claude-code'

import type { RouteDifficulty, RouteLabel, RouteLogEntry } from '../../types'

export const LOG_KEY = 'router.log'
export const LOG_CAP = 200
export const LOG_LINES = 20

/** `coding/high`; the category alone for a decision without a difficulty (one made before 0.4.0). */
export function cellName(route: RouteLabel, difficulty?: RouteDifficulty): string {
  return difficulty === undefined ? route : `${route}/${difficulty}`
}

/** 150000 -> "150k", 800 -> "800". */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n)))
}

function isEntry(v: unknown): v is RouteLogEntry {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return typeof e.at === 'number' && typeof e.loop === 'string' && typeof e.action === 'string'
}

/** The log as stored: the valid entries, oldest first; anything else reads as empty. */
export function entriesOf(stored: unknown): RouteLogEntry[] {
  return Array.isArray(stored) ? stored.filter(isEntry) : []
}

/** The log with `entry` appended, cut to the newest LOG_CAP (pure). */
export function appended(stored: unknown, entry: RouteLogEntry, cap = LOG_CAP): RouteLogEntry[] {
  const all = [...entriesOf(stored), entry]
  return all.length > cap ? all.slice(all.length - cap) : all
}

// Every append's read-modify-write runs after the one before it, whoever calls
// (the router's `record`, the escalate module), so none overwrites another's.
let logWrites: Promise<unknown> = Promise.resolve()

/** Appends one entry, queued behind this process's other appends; rejects when the store does. */
export async function appendLog($: EngineInterface, entry: RouteLogEntry): Promise<void> {
  const write = logWrites.then(async () => {
    await $.store.set(LOG_KEY, appended(await $.store.get(LOG_KEY), entry))
  })
  logWrites = write.catch(() => undefined)
  await write
}

export async function readLog($: EngineInterface): Promise<RouteLogEntry[]> {
  return entriesOf(await $.store.get(LOG_KEY))
}

export async function clearLog($: EngineInterface): Promise<void> {
  await $.store.delete(LOG_KEY)
}

/** `system.ai.claude-opus-5-5[1m]` and `claude-opus-5-5` -> "opus 5.5"; another id as it is. */
export function shortModel(id: string): string {
  const m = /(haiku|sonnet|opus)-(\d+)-(\d+)/i.exec(id)
  return m ? `${(m[1] as string).toLowerCase()} ${m[2]}.${m[3]}` : id
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `11-04 13:32`, local time. */
export function formatAt(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `[clear multi_file traceback]`: the labels a log line shows (specified, scope, evidence); '' when it has none of them. */
export function labelsHint(labels: RouteLogEntry['labels']): string {
  if (labels === null || typeof labels !== 'object') return ''
  const shown = [labels.specified, labels.scope, labels.evidence].filter((v): v is NonNullable<typeof v> => typeof v === 'string' && v.length > 0)
  return shown.length > 0 ? `[${shown.join(' ')}]` : ''
}

/**
 * One entry, one line; the parts an entry lacks are left out:
 * `11-04 13:32 main  general/low 0.80 jev  kept (context) opus 5.5 → haiku 5.5  ctx 83k`
 * With 0.7.0's fields, the labels and a commitment follow the action:
 * `11-04 13:32 main  coding/high 0.90 jev  switched opus 5.5 → sonnet 5.5  [clear local snippet]  commit  ctx 12k`
 * (`vague`, `escalated`, `consulted` and `rerouted (idle)` read like any other action).
 */
export function formatEntry(e: RouteLogEntry): string {
  const loop = e.loop.length > 12 ? e.loop.slice(0, 12) : e.loop
  const route = e.route
    ? [cellName(e.route, e.difficulty), e.confidence !== undefined ? e.confidence.toFixed(2) : '', e.backend ?? ''].filter(Boolean).join(' ')
    : ''
  const action = `${e.action}${e.reason ? ` (${e.reason})` : ''}`
  const from = e.from !== undefined ? shortModel(e.from) : undefined
  const to = e.to !== undefined ? shortModel(e.to) : undefined
  const models = from !== undefined && to !== undefined ? (from === to ? from : `${from} → ${to}`) : from !== undefined ? from : to !== undefined ? `→ ${to}` : ''
  const ctx = e.ctx !== undefined ? `ctx ${formatTokens(e.ctx)}` : ''
  const commit = e.committed === true ? 'commit' : ''
  return [`${formatAt(e.at)} ${loop}`, route, [action, models].filter(Boolean).join(' '), labelsHint(e.labels), commit, ctx].filter(Boolean).join('  ')
}

/** `/route log [n]`: a header, then the newest `n` entries, newest first. */
export function formatLog(entries: readonly RouteLogEntry[], n: number, isOn: boolean): string {
  const off = isOn ? '' : ' · decisionLog is off, nothing new is recorded'
  if (entries.length === 0) return `router log: empty${off}.`
  const shown = entries.slice(-n).reverse()
  return [`router log: newest ${shown.length} of ${entries.length}, newest first${off}`, ...shown.map(formatEntry)].join('\n')
}

/** The `n` of `/route log [n]`: LOG_LINES when absent, 1 to LOG_CAP; undefined when it is not a number. */
export function parseCount(arg: string | undefined): number | undefined {
  if (arg === undefined) return LOG_LINES
  if (!/^\d+$/.test(arg)) return undefined
  return Math.min(LOG_CAP, Math.max(1, Number(arg)))
}
