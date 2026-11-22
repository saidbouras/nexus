// The zero-cost continuation skip: a main-loop prompt that is only an
// acknowledgement ("ok", "yes do it", "oui, vas-y") picks no new model, so it
// is not sent to the classifier and the turn stays on the loop's model. Pure:
// the matching rules only; register.ts decides when they apply.

/** The longest normalised prompt that can be a continuation. */
export const MAX_CONTINUATION_CHARS = 40

/**
 * The built-in phrases, English then French, normalised. Refusals and
 * corrections ("no", "stop") are left out on purpose: they should be classified.
 */
export const DEFAULT_CONTINUATIONS: readonly string[] = Object.freeze(
  Array.from(
    new Set([
      'ok', 'okay', 'k', 'yes', 'y', 'yep', 'yeah', 'sure', 'go', 'go on', 'go ahead', 'continue', 'proceed', 'next',
      'do it', 'yes do it', 'yes please', 'please do', 'sounds good', 'looks good', 'lgtm', 'perfect', 'great', 'thanks', 'thank you',
      'oui', 'ouais', "d'accord", 'dac', 'merci', 'vas-y', 'vas y', 'continue', 'parfait', "c'est bon", 'fais-le', 'oui vas-y',
    ]),
  ),
)

// Anything but a letter or a digit at either end: punctuation, emoji, symbols, spaces.
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
// Where two phrases may be joined: a comma (and spaces) or spaces.
const JOIN = /\s*,\s*|\s+/g

/**
 * Lowercase, typographic apostrophes as `'`, whitespace collapsed, and the
 * punctuation and emoji around the text stripped. Apostrophes and hyphens
 * inside words stay (d'accord, vas-y).
 */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').replace(EDGES, '')
}

/** The `continuationPhrases` option: a comma list, each normalised, empties dropped; empty or invalid = the defaults. */
export function parsePhrases(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_CONTINUATIONS
  const out = Array.from(new Set(raw.split(',').map(normalise).filter(p => p !== '')))
  return out.length > 0 ? out : DEFAULT_CONTINUATIONS
}

/**
 * Whether the whole prompt is a continuation: its normalised text (40
 * characters at most) is one phrase, or two joined by a comma or a space
 * ("ok, continue", "oui merci"). Never a substring match, so "ok now redesign
 * the auth flow" is not one.
 */
export function isContinuation(text: string, phrases: readonly string[]): boolean {
  // Cheap bail-out before normalising a long prompt.
  if (text.length > MAX_CONTINUATION_CHARS * 4) return false
  const t = normalise(text)
  if (t === '' || t.length > MAX_CONTINUATION_CHARS) return false
  const set = new Set(phrases)
  if (set.has(t)) return true
  for (const m of t.matchAll(JOIN)) {
    const at = m.index ?? 0
    if (set.has(normalise(t.slice(0, at))) && set.has(normalise(t.slice(at + m[0].length)))) return true
  }
  return false
}
