import { describe, expect, test } from 'claude-code/testing'

import { addCost, DEFAULT_PRICES, emptyTotals, fmtMoney, parsePrices, priceFor, share, stepCost } from './cost'
import type { PriceTable, Usage } from './cost'

const close = (got: unknown, want: number) =>
  expect(typeof got === 'number' && Math.abs(got - want) < 1e-9, `${String(got)} ≈ ${want}`).toBe(true)

// 1M of each token kind => cost = sum of the four per-M rates
const U: Usage = {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 1_000_000,
}
const small: Usage = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 20_000,
  cache_creation_input_tokens: 4000,
}

describe('cost', () => {
  test('exact $ on opus/sonnet/haiku-5.5 incl. cache read/write', () => {
    close(stepCost(U, 'system.ai.claude-opus-5-5', DEFAULT_PRICES), 4 + 20 + 0.2 + 5)
    close(stepCost(U, 'databricks-claude-sonnet-5-5', DEFAULT_PRICES), 2 + 10 + 0.2 + 2.5)
    close(stepCost(U, 'claude-haiku-5-5', DEFAULT_PRICES), 0.1 + 0.5 + 0.01 + 0.125)
    // opus: 1000*4 + 500*20 + 20000*0.2 + 4000*5 = 4000+10000+4000+20000 = 38000 / 1e6
    close(stepCost(small, 'opus-5-5', DEFAULT_PRICES), 0.038)
  })

  test('uplift 10%', () => {
    close(stepCost(U, 'opus-5-5', DEFAULT_PRICES, 10), 29.2 * 1.1)
  })

  test('[1m] suffix matches', () => {
    expect(priceFor('system.ai.claude-opus-5-5[1m]', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['opus-5-5'])
    expect(priceFor('claude-sonnet-5-5[1M]', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['sonnet-5-5'])
  })

  test('haiku-5-5 vs haiku-4-5', () => {
    expect(priceFor('databricks-claude-haiku-4-5', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['haiku-4-5'])
    expect(priceFor('system.ai.claude-haiku-5-5', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['haiku-5-5'])
    // longest key wins when one key is a substring of another
    const t = { haiku: { inPerM: 9, outPerM: 9 }, 'haiku-5-5': { inPerM: 1, outPerM: 1 } }
    expect(priceFor('claude-haiku-5-5', t)).toBe(t['haiku-5-5'])
    expect(priceFor('claude-haiku-3', t)).toBe(t.haiku)
  })

  test('plain Anthropic names and gateway names find the same price', () => {
    for (const family of ['opus', 'sonnet', 'haiku'] as const) {
      const want = DEFAULT_PRICES[`${family}-5-5`]
      for (const name of [
        family,
        `claude-${family}`,
        `claude-${family}-5-5`,
        `claude-${family}-5-5-20261001`,
        `claude-${family}-5-5[1m]`,
        `system.ai.claude-${family}-5-5`,
        `system.ai.claude-${family}-5-5[1m]`,
        `databricks-claude-${family}-5-5`,
        `us.anthropic.claude-${family}-5-5-v1:0`,
        `Claude-${family.toUpperCase()}-5-5`,
      ]) {
        expect(priceFor(name, DEFAULT_PRICES), name).toBe(want)
      }
    }
    expect(priceFor('claude-haiku-4-5-20251001', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['haiku-4-5'])
    expect(priceFor('system.ai.claude-haiku-4-5', DEFAULT_PRICES)).toBe(DEFAULT_PRICES['haiku-4-5'])
    // a table key for the bare family beats the alias
    const t: PriceTable = { ...DEFAULT_PRICES, opus: { inPerM: 7, outPerM: 7 } }
    expect(priceFor('opus', t)).toBe(t.opus)
    expect(priceFor('claude-opus-5-5', t)).toBe(t['opus-5-5'])
    // an alias names no price of its own: a family the table lacks stays unknown
    expect(priceFor('fable', DEFAULT_PRICES)).toBe(undefined)
    expect(priceFor('constructor', DEFAULT_PRICES)).toBe(undefined)
  })

  test('unknown model → undefined and —', () => {
    expect(priceFor('gpt-9', DEFAULT_PRICES)).toBe(undefined)
    const c = stepCost(U, 'gpt-9', DEFAULT_PRICES)
    expect(c).toBe(undefined)
    expect(fmtMoney(c)).toBe('—')
  })

  test('parsePrices: invalid/empty, partial override, bad entry', () => {
    expect(parsePrices('{not json')).toBe(DEFAULT_PRICES)
    expect(parsePrices('')).toBe(DEFAULT_PRICES)
    expect(parsePrices(undefined)).toBe(DEFAULT_PRICES)
    expect(parsePrices('[1,2]')).toBe(DEFAULT_PRICES)
    const t = parsePrices(
      JSON.stringify({
        'opus-5-5': { inPerM: 5, outPerM: 25 },
        'mythos-1': { inPerM: 10, outPerM: 50, cacheReadPerM: 1 },
        'sonnet-5-5': { inPerM: -1, outPerM: 10 },
        'haiku-4-5': { inPerM: 1 },
      }),
    )
    expect(t['opus-5-5']).toEqual({ inPerM: 5, outPerM: 25 })
    expect(t['mythos-1']).toEqual({ inPerM: 10, outPerM: 50, cacheReadPerM: 1 })
    expect(t['sonnet-5-5']).toEqual(DEFAULT_PRICES['sonnet-5-5'])
    expect(t['haiku-4-5']).toEqual(DEFAULT_PRICES['haiku-4-5'])
    expect(t['haiku-5-5']).toEqual(DEFAULT_PRICES['haiku-5-5'])
    // override without cache rates → cache falls back to inPerM
    close(stepCost(U, 'opus-5-5', t), 5 + 25 + 5 + 5)
  })

  test('fmtMoney boundaries', () => {
    expect(fmtMoney(undefined)).toBe('—')
    expect(fmtMoney(0)).toBe('<$0.01')
    expect(fmtMoney(0.0099)).toBe('<$0.01')
    expect(fmtMoney(0.01)).toBe('$0.01')
    expect(fmtMoney(1.234)).toBe('$1.23')
    expect(fmtMoney(99.99)).toBe('$99.99')
    expect(fmtMoney(100)).toBe('$100')
    expect(fmtMoney(123.4)).toBe('$123')
    expect(fmtMoney(999)).toBe('$999')
    expect(fmtMoney(1000)).toBe('$1.0k')
    expect(fmtMoney(1234)).toBe('$1.2k')
  })

  test('CostTotals add/share are immutable and serialisable', () => {
    const a = emptyTotals()
    const b = addCost(a, 'opus', 3)
    const c = addCost(b, 'haiku', 1)
    const d = addCost(c, 'opus', undefined)
    expect(a).toEqual({ total: 0, by: {} })
    expect(d).toBe(c)
    close(c.total, 4)
    close(share(c, 'opus'), 0.75)
    expect(share(a, 'opus')).toBe(0)
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)
  })
})
