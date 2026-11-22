import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_CONTINUATIONS, MAX_CONTINUATION_CHARS, isContinuation, normalise, parsePhrases } from './skip'
import { readConfig } from './classify'

const D = DEFAULT_CONTINUATIONS

describe('continuation skip: normalise', () => {
  test('lowercase, whitespace collapsed, punctuation and emoji stripped at the ends', () => {
    expect(normalise('  Yes,   DO it!  ')).toBe('yes, do it')
    expect(normalise('oui vas-y 👍')).toBe('oui vas-y')
    expect(normalise('…ok?!🙏')).toBe('ok')
    expect(normalise('!!!')).toBe('')
  })

  test("apostrophes and hyphens inside words stay; a typographic ’ becomes '", () => {
    expect(normalise("D'accord.")).toBe("d'accord")
    expect(normalise('D’accord')).toBe("d'accord")
    expect(normalise('Fais-le !')).toBe('fais-le')
  })
})

describe('continuation skip: isContinuation', () => {
  for (const text of ['ok', 'Yes, do it!', 'oui vas-y 👍', 'ok, continue', "D'accord.", 'thanks!', 'oui merci', 'Yes please', 'LGTM 👍', 'vas y']) {
    test(`"${text}" is a continuation`, () => {
      expect(isContinuation(text, D)).toBe(true)
    })
  }

  for (const text of ['ok now redesign the auth flow', 'yes but use opus for the review', 'no', 'stop', '', '   ', '👍', 'ok, continue, thanks', 'okay then']) {
    test(`"${text}" is not`, () => {
      expect(isContinuation(text, D)).toBe(false)
    })
  }

  test('over 40 normalised characters is never a match', () => {
    const long = 'a'.repeat(MAX_CONTINUATION_CHARS + 1)
    const custom = parsePhrases(`${long},${'b'.repeat(MAX_CONTINUATION_CHARS)}`)
    expect(isContinuation(long, custom)).toBe(false)
    expect(isContinuation('b'.repeat(MAX_CONTINUATION_CHARS), custom)).toBe(true)
    // 41 characters made of phrases.
    const phrases = 'ok ok ok ok ok ok ok ok ok ok ok ok ok ok'
    expect(phrases.length).toBe(41)
    expect(isContinuation(phrases, D)).toBe(false)
  })
})

describe('continuation skip: the phrase list', () => {
  test('the defaults hold the English and French phrases once each, normalised', () => {
    expect(D).toContain('yes do it')
    expect(D).toContain("c'est bon")
    expect(D.filter(p => p === 'continue').length).toBe(1)
    expect(D.every(p => normalise(p) === p)).toBe(true)
  })

  test('a custom list replaces the defaults', () => {
    const custom = parsePhrases(' Go Go , Banana!, ,')
    expect(custom).toEqual(['go go', 'banana'])
    expect(isContinuation('go go!', custom)).toBe(true)
    expect(isContinuation('banana, go go', custom)).toBe(true)
    expect(isContinuation('ok', custom)).toBe(false)
  })

  test('empty, blank or invalid means the defaults', () => {
    expect(parsePhrases('')).toBe(D)
    expect(parsePhrases('   ')).toBe(D)
    expect(parsePhrases(' , ,')).toBe(D)
    expect(parsePhrases(42)).toBe(D)
    expect(parsePhrases(undefined)).toBe(D)
  })

  test('readConfig: skip on by default, a non-boolean is on, the phrases parsed', () => {
    expect(readConfig({})).toMatchObject({ continuationSkip: true, continuationPhrases: D })
    expect(readConfig({ continuationSkip: 'false' }).continuationSkip).toBe(true)
    expect(readConfig({ continuationSkip: false }).continuationSkip).toBe(false)
    expect(readConfig({ continuationPhrases: 'yo, go go' }).continuationPhrases).toEqual(['yo', 'go go'])
  })
})
