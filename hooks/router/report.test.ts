import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatAt, formatEntry, labelsHint } from './log'
import { LOG_KEY } from './log'
import { REPORT_USAGE, USAGE_KEY, USAGE_SESSIONS, defaultExportPath, exportLines, formatReport, mergedUsage, parseSessions } from './report'
import type { RouteLogEntry, UsageRecord } from '../../types'

// The test runtime has a console; the hooks module's environment does not.
declare const console: { log: (...args: unknown[]) => void }

// A price table of made-up models (no default entry matches them): alpha costs
// 1 in, 2 out, 0.5 cache read, 1.5 cache write per 1M tokens; beta ten times that.
const PRICES = JSON.stringify({
  'alpha-1': { inPerM: 1, outPerM: 2, cacheReadPerM: 0.5, cacheWritePerM: 1.5 },
  'beta-1': { inPerM: 10, outPerM: 20, cacheReadPerM: 5, cacheWritePerM: 15 },
  // the default profile's frontier model (the command's baseline), at beta's rates
  'opus-5-5': { inPerM: 10, outPerM: 20, cacheReadPerM: 5, cacheWritePerM: 15 },
})

// The /route command as the person types it; the plugin's own `$` (store, clock,
// fs, session) is reached only through its hooks, so the commands run the real path.
const command = (args: string) => ({
  command: 'route',
  args,
  origin: { kind: 'user' },
  presentation: { isFullscreen: false, columns: 120 },
}) as never

/** The world beneath the plugin for a command: a clock, the store, command registration, the cwd. */
const world = (on: On, store: Record<string, unknown> = {}, now = 1_000) => {
  const clock = mock.clock(on, { now })
  mock.store(on, store)
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', async () => ({ value: '/work/project' }))
  return clock
}

const rec = (r: Partial<UsageRecord> & Pick<UsageRecord, 'session' | 'model' | 'at'>): UsageRecord => ({ turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...r })
const entry = (e: Partial<RouteLogEntry> & Pick<RouteLogEntry, 'at' | 'action'>): RouteLogEntry => ({ session: 's1', loop: 'main', ...e })

describe('router report: usage records', () => {
  test('a delta merges into its session+model record; a consult adds no turn', () => {
    let u = mergedUsage(undefined, { session: 's1', model: 'm', input: 10, output: 5, cacheRead: 100, cacheWrite: 7 }, 1)
    u = mergedUsage(u, { session: 's1', model: 'm', input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 2)
    u = mergedUsage(u, { session: 's1', model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, consults: 1 }, 3)
    u = mergedUsage(u, { session: 's1', model: 'other', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 4)
    u = mergedUsage(u, { session: 's2', model: 'm', input: Number.NaN, output: -5, cacheRead: 0, cacheWrite: 0 }, 5)
    expect(u).toEqual([
      { session: 's1', model: 'm', turns: 2, input: 12, output: 8, cacheRead: 103, cacheWrite: 11, consults: 1, at: 3 },
      { session: 's1', model: 'other', turns: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, at: 4 },
      { session: 's2', model: 'm', turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, at: 5 },
    ])
  })

  test('only the newest USAGE_SESSIONS sessions are kept, by their latest update', () => {
    let u: UsageRecord[] = []
    for (let i = 0; i < USAGE_SESSIONS + 3; i++) u = mergedUsage(u, { session: `s${i}`, model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 100 + i)
    // s0 is updated last: it is the newest now, so s1..s3 go
    u = mergedUsage(u, { session: 's0', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 1_000)
    u = mergedUsage(u, { session: 'fresh', model: 'm', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 1_001)
    const sessions = new Set(u.map(r => r.session))
    expect(sessions.size).toBe(USAGE_SESSIONS)
    expect(['s0', 'fresh', `s${USAGE_SESSIONS + 2}`].every(s => sessions.has(s))).toBe(true)
    expect(['s1', 's2', 's3', 's4'].some(s => sessions.has(s))).toBe(false)
  })

  test('parseSessions: 10 by default, 1..50, undefined for anything else', () => {
    expect([parseSessions(undefined), parseSessions(''), parseSessions('3'), parseSessions('0'), parseSessions('999'), parseSessions('x'), parseSessions('-1')]).toEqual([10, 10, 3, 1, USAGE_SESSIONS, undefined, undefined])
  })
})

describe('router report: recordUsage from answered requests', () => {
  test('every answered step adds to its session+model record, none lost when they land together', async ($, on) => {
    world(on, {}, 7_000)
    on('session.id', async () => ({ value: 'sess-u' }))
    on('state.set', async (_$, e, next) => next(e))
    on('ui.status', async () => ({ value: undefined }))
    on('turn.step', async function* (_$, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: 'ok',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5, model: e.model },
      }
    })
    const drain = async (stream: AsyncGenerator<unknown, unknown> & { result: Promise<unknown> }) => {
      for await (const _chunk of stream) {
        // read to the end
      }
      return stream.result
    }
    const step = (index: number, model: string) => drain($.turn.step({ turnId: 't1', index, model, effort: 'medium', messageCount: 1 } as never) as never)
    await Promise.all([step(0, 'alpha-1'), step(1, 'alpha-1'), step(2, 'alpha-1'), step(3, 'beta-1')])
    // the writes are fire-and-forget: a command run after them reads what they left (a few tries to let them land)
    let text = ''
    for (let i = 0; i < 5 && !text.includes('alpha-1'); i++) text = ((await $.command.run(command('report'))) as { text: string }).text
    console.log(`\n── /route report after 4 steps ──\n${text}`)
    expect(text).toContain('  alpha-1  3 turns 75%  3.3k tokens 75%  in 300 · out 30 · cache 3.0k read / 15 write')
    expect(text).toContain('  beta-1   1 turn 25%  1.1k tokens 25%  in 100 · out 10 · cache 1.0k read / 5 write')
  })
})

describe('router report: /route report', () => {
  const T = Date.UTC(2026, 10, 10, 9, 0)
  const records = [
    // s-old: the oldest session, left out of a 2-session report
    rec({ session: 's-old', model: 'beta-1', at: T - 86_400_000, turns: 9, input: 9_000_000 }),
    rec({ session: 's1', model: 'alpha-1', at: T, turns: 3, input: 1_000_000, output: 500_000, cacheRead: 2_000_000 }),
    rec({ session: 's1', model: 'beta-1', at: T + 60_000, turns: 1, input: 100_000, output: 50_000, consults: 2 }),
    rec({ session: 's2', model: 'mystery-9', at: T + 120_000, turns: 1, input: 50_000 }),
  ]
  const log = [
    entry({ session: 's-old', at: T - 86_400_000, action: 'switched' }),
    entry({ session: 's1', at: T - 600_000, action: 'switched' }),
    entry({ session: 's1', at: T - 500_000, action: 'switched', committed: true }),
    entry({ session: 's1', at: T - 400_000, action: 'escalated' }),
    entry({ session: 's1', at: T - 300_000, action: 'consulted' }),
    entry({ session: 's1', at: T - 200_000, action: 'kept' }),
    entry({ session: 's2', at: T - 100_000, action: 'hint' }),
    entry({ session: 's2', at: T, action: 'vague' }),
    entry({ session: 's2', at: T + 1, action: 'rerouted', reason: 'idle' }),
  ]

  test('per model share, tokens, cost; the total, the baseline and the saving; the decision counts', () => {
    const text = formatReport(records, log, 2, { prices: PRICES }, 'beta-1')
    console.log(`\n── /route report 2 ──\n${text}`)
    // alpha: 1 + 1 + 1 = $3.00; beta: 1 + 1 = $2.00; mystery has no price.
    // Baseline at beta: alpha's tokens 10 + 10 + 10 = $30, beta's $2 = $32; saving $27 (84%).
    expect(text.split('\n')).toEqual([
      `router report: 2 sessions · ${formatAt(T - 600_000)} – ${formatAt(T + 120_000)}`,
      '  alpha-1    3 turns 60%  3.5M tokens 95%  in 1M · out 500k · cache 2M read / 0 write  $3.00',
      '  beta-1     1 turn 20%  150k tokens 4%  in 100k · out 50.0k · cache 0 read / 0 write  2 consults  $2.00',
      '  mystery-9  1 turn 20%  50.0k tokens 1%  in 50.0k · out 0 · cache 0 read / 0 write  no price',
      '  total      5 turns  3.7M tokens  in 1.15M · out 550k · cache 2M read / 0 write  2 consults  $5.00',
      'unpriced: mystery-9 (no entry in prices; left out of the cost, the baseline and the saving)',
      'baseline: the same tokens at beta-1 $32.00 (estimate: another model would have used different tokens)',
      'saving: $27.00 (84%)',
      'decisions: 2 switched · 1 escalated · 1 consulted · 1 rerouted · 1 vague · 2 kept/hint',
    ])
  })

  test('the uplift scales cost and baseline alike; a real model id prints short', () => {
    const text = formatReport([rec({ session: 's1', model: 'system.ai.claude-haiku-5-5', at: T, turns: 4, input: 1_000_000, output: 1_000_000, cacheRead: 10_000_000 })], [], 10, { upliftPct: 10 }, 'system.ai.claude-opus-5-5[1m]')
    console.log(`\n── /route report, default prices +10% ──\n${text}`)
    // haiku 5.5 default: 0.1 + 0.5 + 0.1 = $0.70 → $0.77; opus 5.5: 4 + 20 + 2 = $26 → $28.60; saving $27.83 (97%)
    expect(text).toContain(' · prices +10%')
    expect(text).toContain('  haiku 5.5  4 turns 100%  12M tokens 100%')
    expect(text).toContain('$0.77')
    expect(text).toContain('baseline: the same tokens at opus 5.5 $28.60 (estimate: another model would have used different tokens)')
    expect(text).toContain('saving: $27.83 (97%)')
    expect(text).toContain('decisions: 0 switched · 0 escalated · 0 consulted · 0 rerouted · 0 vague · 0 kept/hint (none in the decision log for these sessions)')
  })

  test('an unpriced baseline model, or nothing priced, says so', () => {
    expect(formatReport([rec({ session: 's1', model: 'alpha-1', at: T, input: 1_000 })], [], 10, { prices: PRICES }, 'mystery-9')).toContain('baseline: mystery-9 has no price; no saving computed.')
    expect(formatReport([rec({ session: 's1', model: 'mystery-9', at: T, input: 1_000 })], [], 10, { prices: PRICES }, 'beta-1')).toContain('baseline: no priced usage to compare.')
  })

  test('/route report: from the store, the default profile frontier model as the baseline', { options: { prices: PRICES } }, async ($, on) => {
    world(on, {
      [USAGE_KEY]: [rec({ session: 's1', model: 'alpha-1', at: T, turns: 2, input: 1_000_000 }), rec({ session: 's1', model: 'claude-opus-5-5', at: T, turns: 2, input: 1_000_000 })],
      [LOG_KEY]: [entry({ at: T, action: 'escalated' })],
    })
    const run = async (args: string) => ((await $.command.run(command(args))) as { text: string }).text
    const text = await run('report')
    console.log(`\n── /route report (command) ──\n${text}`)
    // alpha $1 + opus (at beta's rates here) $10 = $11; baseline $20; saving $9 (45%)
    expect(text.split('\n')).toEqual([
      `router report: 1 session · ${formatAt(T)}`,
      '  alpha-1   2 turns 50%  1M tokens 50%  in 1M · out 0 · cache 0 read / 0 write  $1.00',
      '  opus 5.5  2 turns 50%  1M tokens 50%  in 1M · out 0 · cache 0 read / 0 write  $10.00',
      '  total     4 turns  2M tokens  in 2M · out 0 · cache 0 read / 0 write  $11.00',
      'baseline: the same tokens at opus 5.5 $20.00 (estimate: another model would have used different tokens)',
      'saving: $9.00 (45%)',
      'decisions: 0 switched · 1 escalated · 0 consulted · 0 rerouted · 0 vague · 0 kept/hint',
    ])
    expect(await run('report many')).toBe(REPORT_USAGE)
  })

  test('/route report with nothing recorded', async ($, on) => {
    world(on)
    expect(((await $.command.run(command('report 5'))) as { text: string }).text).toBe('router report: no usage recorded yet.')
  })
})

describe('router report: /route log export', () => {
  const at = Date.UTC(2026, 10, 11, 9, 32)
  const log = [entry({ at, action: 'switched', route: 'coding', difficulty: 'high', from: 'a', to: 'b', labels: { specified: 'clear', scope: 'local' }, committed: true })]
  const usage = [rec({ session: 's1', model: 'alpha-1', at, input: 5 }), rec({ session: 's2', model: 'beta-1', at, input: 6 })]

  test('one JSONL line per decision and per usage record', () => {
    const lines = exportLines(log, usage).trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toEqual([
      { type: 'decision', ...log[0] },
      { type: 'usage', ...usage[0] },
      { type: 'usage', ...usage[1] },
    ])
    expect(exportLines([], [])).toBe('')
  })

  test('the default path: in the working directory, named by the local time', async ($, on) => {
    world(on, { [USAGE_KEY]: usage, [LOG_KEY]: log }, at)
    const writes: { path: string; text: string }[] = []
    on('fs.write', async (_$, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    const run = async (args: string) => ((await $.command.run(command(args))) as { text: string }).text
    const name = defaultExportPath(at)
    const d = new Date(at)
    const p2 = (n: number) => String(n).padStart(2, '0')
    expect(name).toBe(`nexus-route-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.jsonl`)
    expect(await run('log export')).toBe(`router: exported 1 decision and 2 usage records to /work/project/${name}.`)
    expect(writes).toEqual([{ path: `/work/project/${name}`, text: exportLines(log, usage) }])
    // a path given is written as given
    expect(await run('log export /tmp/out.jsonl')).toBe('router: exported 1 decision and 2 usage records to /tmp/out.jsonl.')
    expect(writes[1]?.path).toBe('/tmp/out.jsonl')
  })

  test('a write that fails gives a short error', async ($, on) => {
    world(on, {}, at)
    on('fs.write', async () => ({ deny: 'EACCES: permission denied' }) as never)
    const text = ((await $.command.run(command('log export out/x.jsonl'))) as { text: string }).text
    console.log(`\n── export, write refused ──\n${text}`)
    expect(text).toBe('router: export failed, /work/project/out/x.jsonl could not be written: EACCES: permission denied.')
  })
})

describe('router log: 0.7.0 lines', () => {
  test('vague, escalated, consulted, rerouted; the labels hint and the commit marker', () => {
    const at = 0
    const t = formatAt(at)
    expect(formatEntry(entry({ at, action: 'vague', route: 'coding', difficulty: 'medium', confidence: 0.7, backend: 'jev', from: 'claude-sonnet-5-5', labels: { specified: 'vague', scope: 'none', evidence: 'none', language: 'python' } }))).toBe(
      `${t} main  coding/medium 0.70 jev  vague sonnet 5.5  [vague none none]`,
    )
    expect(formatEntry(entry({ at, action: 'escalated', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5', labels: { specified: 'clear', scope: 'multi_file', evidence: 'traceback', failure: 'crash' } }))).toBe(
      `${t} main  escalated sonnet 5.5 → opus 5.5  [clear multi_file traceback]`,
    )
    expect(formatEntry(entry({ at, action: 'consulted', to: 'claude-opus-5-5' }))).toBe(`${t} main  consulted → opus 5.5`)
    expect(formatEntry(entry({ at, action: 'rerouted', reason: 'idle', from: 'claude-sonnet-5-5' }))).toBe(`${t} main  rerouted (idle) sonnet 5.5`)
    expect(formatEntry(entry({ at, action: 'switched', route: 'coding', difficulty: 'high', confidence: 0.9, backend: 'jev', from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', ctx: 12_000, labels: { scope: 'local' }, committed: true }))).toBe(
      `${t} main  coding/high 0.90 jev  switched opus 5.5 → sonnet 5.5  [local]  commit  ctx 12k`,
    )
    // only language/project/failure labels: no hint
    expect(labelsHint({ language: 'sql', project: 'data' })).toBe('')
    expect(labelsHint(undefined)).toBe('')
  })
})
