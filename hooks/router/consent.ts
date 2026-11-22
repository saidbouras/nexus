// The classifier chain and its consent flow. Steps run in `chain` order; one
// that is not configured is skipped silently. When a configured step fails,
// `fallbackPolicy` decides: `never` stops (the request stays on the session
// model), `auto` moves on to the next configured step, and `ask` puts the
// choice to the user in one `$.ui.ask` dialog. Only one dialog is open at a
// time: a failure of the same step while one is open (subagents spawned
// together) awaits that same answer. Whatever goes wrong, the result is "no
// routing" (undefined), never a thrown error.

import { applyConfidence, routeFor } from './classify'
import type { RouteMap, RouterConfig, StepName } from './classify'
import { NotConfigured, isConfigured, runStep, toStepError } from './backends'
import type { Ask, Io, StepError, StepState } from './backends'
import type { RouteDifficulty, RouteEffort, RouteLabel, RouteLabels } from '../../types'

/** How long "Stay on the current model" keeps every request unrouted, so a dead step does not ask each turn. */
export const STAY_MS = 5 * 60 * 1000

export type Decision = {
  route: RouteLabel
  difficulty: RouteDifficulty
  model: string
  effort: RouteEffort | null
  confidence: number
  backend: StepName
  /** The classifier's task labels (only with `labels` on, and when it gave any). */
  labels?: RouteLabels
}

export type Answer =
  | { kind: 'use'; step: StepName; scope: 'once' | 'session' }
  | { kind: 'stay' }
  /** Dismissed, headless, or free text under "Other": this request stays unrouted. */
  | { kind: 'none' }

export const STAY_LABEL = 'Stay on the current model'
export const useOnce = (s: StepName) => `Use ${s} this time`
export const useSession = (s: StepName) => `Use ${s} for the rest of this session`

/** The dialog's 2-4 labels: the next step once or for the session, each later step once, staying put. */
export function consentOptions(rest: readonly StepName[]): string[] {
  const [first, ...later] = rest
  if (first === undefined) return [STAY_LABEL]
  return [useOnce(first), useSession(first), ...later.slice(0, 1).map(useOnce), STAY_LABEL]
}

export function parseConsent(answer: string, rest: readonly StepName[]): Answer {
  if (answer === STAY_LABEL) return { kind: 'stay' }
  for (const s of rest) {
    if (answer === useOnce(s)) return { kind: 'use', step: s, scope: 'once' }
    if (answer === useSession(s)) return { kind: 'use', step: s, scope: 'session' }
  }
  return { kind: 'none' }
}

export function consentQuestion(step: StepName, err: StepError): string {
  return `The router's ${step} classifier failed (${err.summary}). How should requests be routed?`
}

/** What the user chose this session, and the one dialog that may be open. */
export class Consent {
  /** "For the rest of this session": the chain starts here. */
  preferred: StepName | undefined
  /** Until this `$.clock` time every request stays unrouted. */
  stayUntil = 0
  /** The latest failure, for /route status. */
  lastFailure: { step: StepName; summary: string } | undefined
  private pending: { step: StepName; answer: Promise<Answer> } | undefined

  reset(): void {
    this.preferred = undefined
    this.stayUntil = 0
    this.lastFailure = undefined
  }

  /** The user's answer for `step`'s failure: the open dialog's when it is about the same step, else a new one once none is open. */
  async decide(io: Io, step: StepName, err: StepError, rest: readonly StepName[]): Promise<Answer> {
    for (;;) {
      const open = this.pending
      if (open === undefined) break
      if (open.step === step) return open.answer
      await open.answer
      // The answer to the other dialog may already settle this one.
      if ((await io.now()) < this.stayUntil) return { kind: 'stay' }
    }
    const answer = io
      .ask(consentQuestion(step, err), { options: consentOptions(rest), header: 'Router' })
      .then(
        async (text): Promise<Answer> => {
          const a = parseConsent(text, rest)
          // Applied once here, so every request sharing the answer sees it.
          if (a.kind === 'use' && a.scope === 'session') this.preferred = a.step
          if (a.kind === 'stay') this.stayUntil = (await io.now()) + STAY_MS
          return a
        },
        (): Answer => ({ kind: 'none' }),
      )
      .finally(() => {
        if (this.pending?.answer === answer) this.pending = undefined
      })
    this.pending = { step, answer }
    return answer
  }
}

/**
 * Walks the chain for one request and maps the category and difficulty through the route matrix.
 * Undefined means "no routing": the request keeps the session model. Never throws.
 */
export async function runChain(
  io: Io,
  cfg: RouterConfig,
  routes: RouteMap,
  st: StepState,
  consent: Consent,
  ask: Ask,
): Promise<Decision | undefined> {
  try {
    if (ask.message.trim() === '' || cfg.chain.length === 0) return undefined
    if ((await io.now()) < consent.stayUntil) return undefined
    const chain = cfg.chain
    let i = consent.preferred !== undefined ? Math.max(0, chain.indexOf(consent.preferred)) : 0
    while (i < chain.length) {
      const step = chain[i] as StepName
      if (!(await isConfigured(io, cfg, st, step))) {
        i++
        continue
      }
      let err: StepError
      try {
        const c = await runStep(io, cfg, st, step, ask)
        const { route, difficulty, confidence } = applyConfidence(c, cfg.minConfidence)
        const r = routeFor(routes, route, difficulty)
        const labels = cfg.labels ? c.labels : undefined
        return { route, difficulty, model: r.model, effort: r.effort, confidence, backend: step, ...(labels ? { labels } : {}) }
      } catch (e) {
        if (e instanceof NotConfigured) {
          i++
          continue
        }
        err = toStepError(e)
      }
      consent.lastFailure = { step, summary: err.summary }
      if (cfg.fallbackPolicy === 'never') return undefined

      const rest: StepName[] = []
      for (const s of chain.slice(i + 1)) if (await isConfigured(io, cfg, st, s)) rest.push(s)
      const next = rest[0]
      if (next === undefined) return undefined
      if (cfg.fallbackPolicy === 'auto') {
        i = chain.indexOf(next)
        continue
      }

      const a = await consent.decide(io, step, err, rest)
      if (a.kind !== 'use') return undefined
      i = chain.indexOf(a.step)
      if (i < 0) return undefined
    }
    return undefined
  } catch {
    return undefined
  }
}
