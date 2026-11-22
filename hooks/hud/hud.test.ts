import { describe, expect, test } from 'claude-code/testing'

import {
  stallText,
  stalledLoops,
  cacheRate,
  clip,
  connector,
  fit,
  fitCount,
  fmtAgo,
  fmtDur,
  fmtTokens,
  hbar,
  isTruecolor,
  kpiTiles,
  MAX_ROUTES,
  modelSlot,
  palette,
  pct,
  prettyModel,
  pushRoute,
  shortTool,
  spinner,
  stackedColumns,
  table,
  toMark,
  toolSummary,
} from './hud'
import type { Loop, ToolRun } from '../../types'

describe('hud helpers', () => {
  test('hbar draws eighths, exactly `width` cells', async () => {
    expect(hbar(0, 4)).toBe('    ')
    expect(hbar(1, 4)).toBe('████')
    expect(hbar(0.5, 4)).toBe('██  ')
    expect(hbar(0.3, 4)).toBe('█▎  ') // 9.6 → 10 eighths: one full cell and 2/8
    expect(hbar(1 / 32, 4)).toBe('▏   ')
    expect(hbar(0.0001, 4)).toBe('▏   ')
    expect(hbar(7, 3)).toBe('███')
    expect(hbar(0.5, 0)).toBe('')
    for (let i = 0; i <= 40; i++) {
      expect(hbar(i / 40, 10)).toHaveLength(10)
    }
  })

  test('stackedColumns stacks by series over time buckets', async () => {
    const chart = stackedColumns(
      [
        { at: 0, key: 'a', value: 8 },
        { at: 100, key: 'a', value: 4 },
        { at: 100, key: 'b', value: 4 },
      ],
      3,
      2,
    )
    expect(chart.max).toBe(8)
    expect(chart.series.map(s => s.key)).toEqual(['a', 'b'])
    expect(chart.rows).toHaveLength(2)
    expect(chart.rows.every(r => r.length === 3)).toBe(true)
    // first bucket: a full column of a; middle bucket empty; last: a below, b on top
    expect(chart.rows.map(r => r[0]!.ch).join('')).toBe('██')
    expect(chart.rows.map(r => r[0]!.series)).toEqual(['a', 'a'])
    expect(chart.rows.map(r => r[1]!.ch).join('')).toBe('  ')
    expect(chart.rows[0]![2]).toEqual({ ch: '█', series: 'b' })
    expect(chart.rows[1]![2]).toEqual({ ch: '█', series: 'a' })
    // a partial top cell
    const half = stackedColumns(
      [
        { at: 0, key: 'a', value: 2 },
        { at: 1, key: 'a', value: 1 },
      ],
      2,
      1,
    )
    expect(half.rows[0]![1]!.ch).toBe('▄')
    expect(
      stackedColumns([], 4, 2)
        .rows.flat()
        .every(c => c.ch === ' '),
    ).toBe(true)
    // few points over a wide chart: each bucket a bar with a one-cell gap
    const wide = stackedColumns(
      [
        { at: 0, key: 'a', value: 1 },
        { at: 1, key: 'a', value: 1 },
      ],
      8,
      1,
    )
    expect(wide.rows[0]!.map(c => c.ch).join('')).toBe('███ ███ ')
  })

  test('kpiTiles spreads tiles over the width', async () => {
    const tiles = [1, 2, 3].map(i => ({ id: `${i}`, label: `L${i}`, value: `${i}` }))
    expect(kpiTiles(tiles, 30, 3)).toEqual([8, 8, 8])
    expect(kpiTiles(tiles, 31, 3)).toEqual([9, 8, 8])
    expect(kpiTiles([], 30)).toEqual([])
  })

  test('table gives fixed widths and shares the rest', async () => {
    const widths = table(
      [
        { id: 'a', title: 'AGENT', align: 'left', flex: 3, min: 5 },
        { id: 'n', title: 'N', align: 'right', width: 6 },
        { id: 'b', title: 'BAR', align: 'left', flex: 1, min: 4 },
      ],
      50,
      2,
    )
    expect(widths[1]).toBe(6)
    expect(widths.reduce((s, w) => s + w, 0) + 4).toBe(50)
    expect(widths[0]).toBeGreaterThan(widths[2]!)
    expect(fit('abc', 5, 'right')).toBe('  abc')
    expect(fit('abcdef', 4)).toBe('abc…')
  })

  test('tokens, durations, percents', async () => {
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(12_300)).toBe('12.3k')
    expect(fmtTokens(412_000)).toBe('412k')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtDur(350)).toBe('350ms')
    expect(fmtDur(134_000)).toBe('2m14s')
    expect(fmtDur(undefined)).toBe('—')
    expect(pct(0.784)).toBe('78%')
    expect(cacheRate(25, 75)).toBe(0.75)
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(spinner(10)).toBe('⠋')
    expect(fitCount([5, 5, 5], 13, 3)).toBe(2)
  })

  test('models, palette, connectors', async () => {
    expect(prettyModel('system.ai.claude-opus-5-5[1m]')).toBe('opus 5.5')
    expect(prettyModel('databricks-claude-haiku-4-5')).toBe('haiku 4.5')
    expect(prettyModel('qwen3.6:35b-a3b')).toBe('qwen3.6')
    expect(modelSlot('opus 5.5')).toBe(0)
    expect(modelSlot('qwen3.6')).toBe(1)
    expect(modelSlot('haiku 4.5')).toBe(2)
    expect(modelSlot('sonnet 5.5')).toBe(4)
    expect(palette(false).series).toHaveLength(6)
    expect(palette(false).text).toMatch(/^#/)
    expect(palette(true).series.every(c => !c.startsWith('#'))).toBe(true)
    expect(isTruecolor('truecolor')).toBe(true)
    expect(isTruecolor(undefined)).toBe(false)
    expect(connector([])).toBe('')
    expect(connector([false, true])).toBe('│ └ ')
  })

  test('pushRoute keeps one mark per `at`, oldest first, at most the cap', async () => {
    const m = (at: number, route = 'coding') => ({ at, route })
    let list: { at: number; route: string }[] = []
    for (const at of [1, 2, 2, 3]) {
      list = pushRoute(list, m(at))
    }
    expect(list.map(x => x.at)).toEqual([1, 2, 3])
    // a repeat of `at` replaces the mark in place, never a second one
    expect(pushRoute(list, m(2, 'fast')).map(x => `${x.at}${x.route}`)).toEqual(['1coding', '2fast', '3coding'])
    // late arrivals sort in; the cap drops the oldest
    expect(pushRoute(list, m(0)).map(x => x.at)).toEqual([0, 1, 2, 3])
    for (let at = 4; at < 30; at++) {
      list = pushRoute(list, m(at))
    }
    expect(list).toHaveLength(MAX_ROUTES)
    expect(list[0]!.at).toBe(30 - MAX_ROUTES)
    expect(list[list.length - 1]!.at).toBe(29)
    expect(pushRoute(list, m(99), 3).map(x => x.at)).toEqual([28, 29, 99])
    // the input is never changed
    expect(list).toHaveLength(MAX_ROUTES)
  })

  test('toMark copies a decision, the adaptive fields only when present', async () => {
    const base = { loop: 'main', route: 'reasoning', model: 'm', effort: null, confidence: 0.82, backend: 'jev', at: 7 }
    const plain = toMark(base)
    expect(plain).toEqual({ loop: 'main', route: 'reasoning', model: 'm', confidence: 0.82, backend: 'jev', at: 7 })
    expect(toMark({ ...base, action: 'hint', contextTokens: 150_000, suggested: 'opus' })).toEqual({
      ...plain!,
      action: 'hint',
      contextTokens: 150_000,
      suggested: 'opus',
    })
    expect(toMark({ ...base, action: 'switched', contextTokens: 12_000 })).toEqual({
      ...plain!,
      action: 'switched',
      contextTokens: 12_000,
    })
    // malformed adaptive fields are dropped, not kept
    expect(toMark({ ...base, action: 3, contextTokens: Number.NaN, suggested: null })).toEqual(plain)
    expect(toMark(null)).toBeNull()
    expect(toMark({ route: 'fast' })).toBeNull()
  })

  test('toMark copies a valid difficulty, ignores any other', async () => {
    const base = { loop: 'main', route: 'coding', model: 'm', effort: 'high', confidence: 0.82, backend: 'jev', at: 7 }
    const plain = toMark(base)
    expect(plain).not.toHaveProperty('difficulty')
    for (const difficulty of ['low', 'medium', 'high'] as const) {
      expect(toMark({ ...base, difficulty })).toEqual({ ...plain!, difficulty })
    }
    for (const difficulty of ['extreme', 'HIGH', '', 3, null, undefined, { level: 'high' }]) {
      expect(toMark({ ...base, difficulty })).toEqual(plain)
    }
  })

  test('fmtAgo: whole units', async () => {
    expect(fmtAgo(0)).toBe('now')
    expect(fmtAgo(999)).toBe('now')
    expect(fmtAgo(-5)).toBe('now')
    expect(fmtAgo(3_400)).toBe('3s ago')
    expect(fmtAgo(125_000)).toBe('2m ago')
    expect(fmtAgo(7_300_000)).toBe('2h ago')
  })

  const run = (tool: string, startedAt: number, status: ToolRun['status'] = 'running'): ToolRun => ({
    id: `${tool}-${startedAt}`,
    tool,
    status,
    startedAt,
  })

  test('shortTool drops the MCP server prefix', async () => {
    expect(shortTool('mcp__idea__search_text')).toBe('search_text')
    expect(shortTool('mcp__system-ai-atlassian__getJiraIssue')).toBe('getJiraIssue')
    expect(shortTool('Bash')).toBe('Bash')
    expect(shortTool('mcp_nope')).toBe('mcp_nope')
  })

  test('toolSummary: running tools grouped by name, newest first, over every loop', async () => {
    const list = [
      { tools: [run('Read', 10), run('Bash', 30), run('Edit', 5, 'done')] },
      { tools: [run('Bash', 20), run('mcp__idea__search_text', 15), run('Grep', 1, 'error')] },
    ]
    expect(toolSummary(list, 80)).toEqual({ text: 'Bash ×2 · search_text · Read', idle: false })
  })

  test('toolSummary: +N for the names past the width, never wider than it', async () => {
    const list = [{ tools: [run('Bash', 4), run('Bash', 3), run('Read', 2), run('Grep', 1)] }]
    expect(toolSummary(list, 21)?.text).toBe('Bash ×2 · Read · Grep')
    expect(toolSummary(list, 20)?.text).toBe('Bash ×2 · Read +1')
    expect(toolSummary(list, 16)?.text).toBe('Bash ×2 +2')
    expect(toolSummary(list, 10)?.text).toBe('Bash ×2 +2')
    expect(toolSummary(list, 9)?.text).toBe('Bash… +2')
    expect(toolSummary(list, 8)).toBeUndefined()
    // a long name is clipped rather than dropped
    const long = [{ tools: [run('mcp__db__get_database_object_description', 1)] }]
    expect(toolSummary(long, 17)?.text).toBe('get_database_obj…')
    for (let w = 0; w <= 30; w++) {
      expect((toolSummary(list, w)?.text ?? '').length).toBeLessThanOrEqual(w)
    }
  })

  test('toolSummary: idle, the latest finished names, distinct, newest first', async () => {
    const list = [
      { tools: [run('Read', 1, 'done'), run('Bash', 2, 'error'), run('Edit', 4, 'done')] },
      { tools: [run('Read', 3, 'denied'), run('mcp__srv__lookup', 0, 'done')] },
    ]
    expect(toolSummary(list, 80)).toEqual({ text: 'last Edit · Read · Bash · lookup', idle: true })
    expect(toolSummary(list, 20)).toEqual({ text: 'last Edit · Read +2', idle: true })
    // the same start: the later run in the list is the newer
    expect(toolSummary([{ tools: [run('A', 1, 'done'), run('B', 1, 'done')] }], 20)?.text).toBe('last B · A')
    expect(toolSummary([{ tools: [] }], 80)).toBeUndefined()
    expect(toolSummary([], 80)).toBeUndefined()
  })
})

describe('hud: stalled subagents', () => {
  const MIN = 60_000
  const loop = (id: string, over: Partial<Loop> = {}): Loop => ({
    id,
    label: `label ${id}`,
    parent: 'main',
    status: 'running',
    turns: 1,
    steps: 1,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tools: [],
    startedAt: 0,
    activeAt: 0,
    ...over,
  })

  test('a running subagent silent for the threshold, never the main loop, never a finished one', () => {
    const list = [
      loop('main', { parent: undefined, label: 'main session' }),
      loop('quiet', { activeAt: 0 }),
      loop('recent', { activeAt: 25 * MIN }),
      loop('done', { activeAt: 0, status: 'done' }),
    ]
    expect(stalledLoops(list, 30 * MIN, 30 * MIN).map(l => l.id)).toEqual(['quiet'])
    expect(stalledLoops(list, 24 * MIN, 30 * MIN)).toEqual([])
  })

  test('the message names the subagent, its silence, and any tool still running', () => {
    const l = loop('a7', {
      label: 'Terraform plan',
      activeAt: 0,
      tools: [{ id: 't1', tool: 'mcp__idea__execute_terminal_command', status: 'running', startedAt: 0 }],
    })
    const text = stallText(l, 31 * MIN, 30 * MIN)
    expect(text).toContain('"Terraform plan" (a7)')
    expect(text).toContain('sent nothing for 30 min')
    expect(text).toContain('31 min ago')
    expect(text).toContain('still running execute_terminal_command')
    expect(text).toContain('SendMessage')
  })
})
