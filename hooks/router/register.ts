// nexus router: classifies a turn once (the main loop, subagents, workflow
// agents) and rewrites the model/effort of that turn's requests. The
// classifier chain (jev, haiku, local) and its consent flow live in
// consent.ts. Fails open: any error, timeout, invalid answer or declined
// fallback leaves the request as the engine had it.
//
// The main loop and the prompt cache: a request's cached prefix belongs to
// one model, so every switch of the main loop's model re-reads (and pays
// for) the whole conversation again. The main loop is classified at
// `prompt.submit`, once per user prompt, and the decision waits there for the
// turn it starts. `routeMainLoop: adaptive` (the default) switches the model
// only while that is cheap and safe (confident, a small context, one that fits
// the target's window; decideSwitch); otherwise it keeps the model and its
// cache, and may attach a hidden note suggesting a subagent, which the router
// puts on the routed model (delegationHint). `task` (the default since 0.7.0)
// routes per task, not per prompt (decideTask): a vague prompt keeps the
// model and commits nothing; the first clear one goes through the adaptive
// switch rule and commits whatever runs after it; once committed, a lighter
// route keeps the model (the delegation hint), a heavier one switches while
// the context is small and otherwise keeps it and attaches the escalation
// directive (a `nexus:frontier` subagent, or the `consult` tool). A /clear, a
// resume, a compaction or an idle gap past `cacheTtlMinutes` loses the cache
// anyway and drops the commitment (`rerouted`). `every-turn` switches on every
// prompt, the window guard aside; `session-start` classifies the first prompt
// and keeps that model for the session; `off` leaves the main loop alone.
// Subagents start with a fresh context, so they are classified at each spawn
// whatever the mode; a `nexus:frontier` subagent is not classified, it runs
// on the frontier model (the `reasoning/high` cell) at effort high.
//
// An unknown context is never read as an empty one. The router learns the
// main loop's size from its answered requests (routerObserve), so after a
// /reload-plugins, a restart or a resume it has none; readContext then asks
// the engine (the transcript for freshness, the live window's fill or an
// estimate for the size). When nothing answers, a switch waits for the
// turn's first request (routerStep), whose message count tells a fresh
// conversation from one under way; under way and still unmeasured, the
// model is kept (`unknown-context`).
//
// Every outcome is appended to the decision log (log.ts, `decisionLog`).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, EventResult, Events, On, PluginOptions } from 'claude-code'

import type { RerouteReason, RouteAction, RouterDecision, RouteBackend, RouteDifficulty, RouteLabel, RouteLabels, RouteLogAction, RouteLogEntry } from '../../types'
import { DIFFICULTIES, FRONTIER_AGENT, LABELS, frontierModel, isDifficulty, isHeavier, isLabel, parseRoutes, readConfig, routeFor, windowFor } from './classify'
import type { RouteMap, RouterConfig, StepName } from './classify'
import { OllamaProbe, TimeoutError, TokenCache, isConfigured, jevRoute } from './backends'
import type { Io, StepState } from './backends'
import { Consent, runChain } from './consent'
import { isContinuation } from './skip'
import type { Decision } from './consent'
import { LOG_CAP, appendLog, cellName, clearLog, formatLog, formatTokens, parseCount, readLog } from './log'
import { exportCommand, recordUsage, reportCommand } from './report'

export { cellName, formatTokens }

const last = atom({ plugin: 'nexus', key: 'routerLast' } as const, null)

// What a kept decision names before the main loop's first request: the router
// learns the session's model only from a request (routerStep fills it in).
const UNKNOWN_MODEL = 'session model'
const isEnabled = atom({ plugin: 'nexus', key: 'routerEnabled' } as const, true)

const MAX_CACHED = 200
const DEFAULT_KEY_ENV = 'TYPESAFE_API_KEY'
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function ioOf($: EngineInterface): Io {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    run: (argv, init) => $.process.run(argv, init),
    now: () => $.clock.now(),
    timeout: (p, ms) =>
      new Promise((resolve, reject) => {
        const timer = $.clock.after(ms, () => reject(new TimeoutError(ms)))
        p.then(
          v => (timer.cancel(), resolve(v)),
          err => (timer.cancel(), reject(err)),
        )
      }),
    // `$.env.get` takes a literal name only; another `jevApiKeyEnv` is read
    // with printenv. Either way the value stays in memory, never logged.
    env: async name => {
      if (name === DEFAULT_KEY_ENV) return $.env.get('TYPESAFE_API_KEY')
      if (!ENV_NAME.test(name)) return undefined
      const r = await $.process.run(['printenv', name], { timeoutMs: 2_000 })
      return r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, '') : undefined
    },
    // The haiku step's capability check is in backends.ts: an engine without
    // `$.model.complete` throws a TypeError here, and the step is then skipped.
    complete: request => $.model.complete(request),
    ask: (question, options) => $.ui.ask(question, options),
  }
}

/** What a decision shows beyond the route itself: the model kept, the action, the context, a commitment. */
type Shown = Pick<RouterDecision, 'model' | 'effort' | 'action' | 'contextTokens' | 'suggested' | 'committed'>

async function publish($: EngineInterface, loop: string, d: Decision, backend: RouteBackend, shown: Partial<Shown> = {}) {
  const decision: RouterDecision = {
    loop,
    route: d.route,
    difficulty: d.difficulty,
    model: d.model,
    effort: d.effort,
    confidence: d.confidence,
    backend,
    at: await $.clock.now(),
    ...(d.labels ? { labels: d.labels } : {}),
    ...shown,
  }
  await update($, last, () => decision)
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_CACHED) map.delete(map.keys().next().value as K)
}


/**
 * What the router keeps for the session: its config, the classifier chain's
 * state, and its decisions. One per register(), handed with `$` to the
 * functions below (each a plain top-level function, so `$` is only ever
 * passed to code the validator can read).
 */
export type Router = {
  cfg: RouterConfig
  routes: RouteMap
  steps: StepState
  consent: Consent
  byTurn: Map<string, Decision>
  byLoop: Map<string, Decision>
  /** `session-start`: the main loop's one decision, kept apart so no LRU drops it. */
  mainDecision: Decision | undefined
  /** `/route pin <category> [difficulty]`: the cell every request takes. */
  pinned: Pin | undefined
  /** The main-loop decision `prompt.submit` made, for the turn that prompt starts. */
  pending: Pending | undefined
  /** The model the main loop's last request was sent with (routerObserve); undefined before the first. */
  mainModel: string | undefined
  /** The main loop's context in tokens at its last answered request; 0 before the first. */
  contextTokens: number
  /** True once an answered main-loop request reported its usage: `contextTokens` is a measure, not a default. */
  contextKnown: boolean
  /** `session-start` in a conversation that was not fresh: the model is kept for the session. */
  mainHeld: boolean
  /** This process saw the conversation from its start (a fresh read, or a main request of one message). */
  sawStart: boolean
  /** A main-loop switch waiting for its turn's first request, where the context can be told (routerStep). */
  deferred: Deferred | undefined
  /** `$.session.id()`, read once for the decision log. */
  sessionId: string | undefined
  /** The decision log's writes, one after another (a read-modify-write of one store key). */
  logWrites: Promise<void>
  /** A spawn's decision -> the model the subagent would have run on, and whether a pin made it. */
  spawnFrom: WeakMap<Decision, { from: string | undefined; pinned: boolean }>
  /** Classifier calls (main loop, spawns, subagent turns) since the session or the last /clear. */
  calls: number
  /** Main-loop prompts that skipped the classifier as continuations, over the same span. */
  skipped: number
  /** The plugin's options as given (for /route report's prices). */
  options: Readonly<Record<string, unknown>>
  /** `task`: the model the session committed to (UNKNOWN_MODEL until its first request names it); undefined while not committed. */
  committed: string | undefined
  /** `task`: after an idle or compact re-route, the next clear prompt's switch is not held back by `switchMaxContext` (the cache is cold). */
  isCacheCold: boolean
  /** `$.clock.now()` of the main loop's last request; undefined before one (or after an idle re-route). */
  lastMainAt: number | undefined
  /** `nexus:frontier` spawn decisions, and the loops they started: never classified. */
  frontier: WeakSet<Decision>
  frontierLoops: Set<string>
}

export type Pin = { route: RouteLabel; difficulty: RouteDifficulty }

/** A decision log entry's own fields; `record` adds the time, session, loop and action. */
type LogFields = Partial<Omit<RouteLogEntry, 'at' | 'session' | 'loop' | 'action'>>
type LogNote = { action: RouteLogAction; fields: LogFields }

/** What the main loop's decision is taken against: the model before it and the loop's last decision. */
type Before = { currentModel: string | undefined; previous: Decision | undefined }

/**
 * A main-loop decision waiting for its turn: `apply` the routed one (or keep
 * the loop's), what to publish and log; `defer` when the context was unknown
 * and the switch waits for the turn's first request.
 */
type Pending = { decision: Decision; apply: boolean; shown: Partial<Shown>; log?: LogNote; defer?: Before; commitTo?: string }

/** A deferred switch, held for the turn `turnId` (routerTurnStart -> routerStep). */
type Deferred = Before & { turnId: string; decision: Decision }

/** The `e` and result of each event the router shares with the HUD (hooks/register.tsx holds those hooks). */
export type TurnStartIn = Parameters<Events['turn.start']>[1]
export type TurnStepIn = Parameters<Events['turn.step']>[1]
export type AgentSpawnIn = Parameters<Events['agent.spawn']>[1]
export type AgentSpawnOut = EventResult<'agent.spawn'>
export type TurnStepResult = EventResult<'turn.step'>
export type PromptSubmitIn = Parameters<Events['prompt.submit']>[1]

export function createRouter(options: PluginOptions): Router {
  const cfg = readConfig(options)
  return {
    cfg,
    routes: parseRoutes(options.routes, cfg.profile),
    steps: { tokens: new TokenCache(), ollama: new OllamaProbe(), hasModelApi: true },
    consent: new Consent(),
    byTurn: new Map(),
    byLoop: new Map(),
    mainDecision: undefined,
    pinned: undefined,
    pending: undefined,
    mainModel: undefined,
    contextTokens: 0,
    contextKnown: false,
    mainHeld: false,
    sawStart: false,
    deferred: undefined,
    sessionId: undefined,
    logWrites: Promise.resolve(),
    spawnFrom: new WeakMap(),
    calls: 0,
    skipped: 0,
    options: options as Readonly<Record<string, unknown>>,
    committed: undefined,
    isCacheCold: false,
    lastMainAt: undefined,
    frontier: new WeakSet(),
    frontierLoops: new Set(),
  }
}

/** What the escalation layer (hooks/escalate) is configured with: the router's parsed settings and the frontier model. */
export function escalateConfigOf(r: Router): { escalation: boolean; consultMax: number; frontierModel: string; decisionLog: boolean } {
  return { escalation: r.cfg.escalation, consultMax: r.cfg.consultMax, frontierModel: frontierModel(r), decisionLog: r.cfg.decisionLog }
}

// ---------- adaptive: switch or keep (pure) ----------

/** Why a switch was held back: an unsure route, a context too costly to re-read, or one past the target's window. */
export type KeepReason = 'confidence' | 'context' | 'window'

export type SwitchInput = {
  routed: Pick<Decision, 'model' | 'confidence'>
  /** The model the main loop last sent; undefined before its first request. */
  currentModel: string | undefined
  contextTokens: number
  mode: 'adaptive' | 'every-turn'
  cfg: Pick<RouterConfig, 'switchConfidence' | 'switchMaxContext' | 'delegationHint' | 'contextWindows'>
}

export type SwitchVerdict = { action: RouteAction; apply: boolean; reason?: KeepReason }

/**
 * Whether the main loop takes the routed model for this prompt, in order:
 *
 * - adaptive only: below `switchConfidence`, keep (and no hint: the route is
 *   unsure), the route's effort included.
 * - The routed model is the current one: nothing is re-read, so the route
 *   applies (its effort too) and the action is `kept` (no switch happened).
 * - The context exceeds the routed model's window: keep, in either mode.
 * - adaptive only: past `switchMaxContext`, keep (the switch would re-read it all).
 * - Otherwise `switched`. A context of 0 is a fresh conversation's (the
 *   caller passes 0 only for one; an unknown size never reaches here as 0 to
 *   switch on, see decideMain), so its first confident prompt switches.
 *
 * A switch held back for the context or the window is a `hint` when
 * `delegationHint` is on (the work fits a subagent's fresh context), else `kept`.
 */
export function decideSwitch(i: SwitchInput): SwitchVerdict {
  const { routed, currentModel, contextTokens, mode, cfg } = i
  const keep = (reason: KeepReason): SwitchVerdict => ({
    action: reason !== 'confidence' && cfg.delegationHint ? 'hint' : 'kept',
    apply: false,
    reason,
  })
  if (mode === 'adaptive' && routed.confidence < cfg.switchConfidence) return keep('confidence')
  if (currentModel !== undefined && routed.model === currentModel) return { action: 'kept', apply: true }
  if (contextTokens > windowFor(routed.model, cfg)) return keep('window')
  if (mode === 'adaptive' && contextTokens > cfg.switchMaxContext) return keep('context')
  return { action: 'switched', apply: true }
}

export type HintInput = {
  route: RouteLabel
  difficulty?: RouteDifficulty
  confidence: number
  /** The model kept; undefined before the main loop's first request. */
  current: string | undefined
  /** The routed model the switch was held back from. */
  suggested: string
  contextTokens: number
  reason: Exclude<KeepReason, 'confidence'>
}

/** The one hidden line attached to a prompt whose switch was held back. Model names and a size only. */
export function delegationHint(i: HintInput): string {
  const current = i.current ?? 'its current model'
  const ctx = formatTokens(i.contextTokens)
  const why = i.reason === 'window' ? `because its ${ctx}-token context does not fit ${i.suggested}'s window` : `to keep its ${ctx}-token cache`
  return (
    `NEXUS router: this prompt classified as ${cellName(i.route, i.difficulty)} (${i.confidence.toFixed(2)}). ` +
    `The session stays on ${current} ${why}. ` +
    `If this is a self-contained sub-task, delegate it to a subagent (orchestrator skill); NEXUS routes the subagent to ${i.suggested}.`
  )
}

export type DirectiveInput = {
  route: RouteLabel
  difficulty?: RouteDifficulty
  confidence: number
  /** The model kept; undefined before the main loop's first request. */
  current: string | undefined
  /** The main loop's context in tokens; undefined when unknown. */
  contextTokens: number | undefined
  /** Whether the `consult` tool is offered (`consultMax` > 0). */
  hasConsult: boolean
}

/**
 * The escalation directive (`task` mode): one hidden paragraph attached to a
 * prompt that needs a heavier model than the committed one when switching
 * would drop a large cache. Model names, a size and the cell only.
 */
export function escalationDirective(i: DirectiveInput): string {
  const current = i.current ?? 'its current model'
  const cache = i.contextTokens !== undefined ? `the ${formatTokens(i.contextTokens)}-token cache` : 'the prompt cache'
  return (
    `NEXUS router: this request was classified ${cellName(i.route, i.difficulty)} (${i.confidence.toFixed(2)}) and needs a stronger model than ${current}. ` +
    `Switching now would drop ${cache}. ` +
    'Delegate the hard part to the `nexus:frontier` subagent (Agent tool, a self-contained brief), then check and integrate its result.' +
    (i.hasConsult ? ' For a short second opinion instead, call the `consult` tool.' : '')
  )
}

/**
 * `task` mode: whether a prompt specifies a task. `specified=clear` at
 * `minConfidence` or more (a missing confidence counts as sure), or code
 * evidence (`snippet`, `traceback`). Without labels, or with no `specified`
 * label at all, every classified prompt counts as clear.
 */
export function isClearPrompt(labels: RouteLabels | undefined, minConfidence: number): boolean {
  if (labels === undefined) return true
  if (labels.evidence === 'snippet' || labels.evidence === 'traceback') return true
  if (labels.specified === undefined) return true
  return labels.specified === 'clear' && (labels.specifiedConfidence ?? 1) >= minConfidence
}

function pinDecision(r: Router, pin: Pin): Decision {
  const cell = routeFor(r.routes, pin.route, pin.difficulty)
  return { route: pin.route, difficulty: pin.difficulty, model: cell.model, effort: cell.effort, confidence: 1, backend: 'local' }
}

function classify($: EngineInterface, r: Router, message: string, channel: string): Promise<Decision | undefined> {
  r.calls++
  return runChain(ioOf($), r.cfg, r.routes, r.steps, r.consent, { message, channel })
}

async function describeStep($: EngineInterface, r: Router, step: StepName): Promise<string> {
  const io = ioOf($)
  if (step === 'jev') {
    const route = await jevRoute(io, r.cfg)
    if (route === undefined) return 'jev (not configured)'
    return route.kind === 'gateway' ? `jev (gateway, ${route.model})` : `jev (TypeSafe API, ${route.model}, unverified)`
  }
  const isUp = await isConfigured(io, r.cfg, r.steps, step).catch(() => false)
  if (step === 'haiku') return isUp ? `haiku (${r.cfg.haikuModel})` : 'haiku (not available)'
  return isUp ? `local (${r.cfg.localModel})` : `local (${r.cfg.localModel}, not reachable)`
}

// ---------- the main loop's context and the decision log ----------

/** What the router knows of the main loop's context before a decision: its size in tokens, and whether nothing was sent yet. */
export type ContextRead = { tokens: number; fresh: boolean }

/**
 * A size for a transcript no request has measured: its Messages API JSON
 * text over 4 characters per token. Conservative where it counts: the JSON
 * overhead (keys, quotes, base64 media) makes it larger than the content's
 * tokens, so a guard trips early rather than late; the system prompt and the
 * tools are not in it.
 */
export function estimateTokens(messages: unknown): number {
  try {
    return Math.ceil(JSON.stringify(messages ?? []).length / 4)
  } catch {
    return 0
  }
}

/**
 * The main loop's context before a decision, or undefined when nothing tells it.
 *
 * - An answered request reported its usage (routerObserve): that size.
 * - Otherwise (before the first request this process saw: a new session, or
 *   one reloaded, restarted or resumed) the transcript tells: no assistant
 *   message and no request seen is a fresh conversation (0); else the size is
 *   the live window's fill (`$.session.usage()`), or estimateTokens of the
 *   transcript when the engine reports none.
 * - The transcript unreadable: undefined (never 0).
 */
export async function readContext($: EngineInterface, r: Router): Promise<ContextRead | undefined> {
  if (r.contextKnown) return { tokens: r.contextTokens, fresh: false }
  let messages: readonly { role: string }[] | undefined
  try {
    const read = await $.session.messages({ as: 'api' })
    messages = Array.isArray(read) ? read : undefined
  } catch {
    messages = undefined
  }
  if (messages !== undefined && r.mainModel === undefined && !messages.some(m => m.role === 'assistant')) {
    r.sawStart = true
    return { tokens: 0, fresh: true }
  }
  let filled: number | undefined
  try {
    const t = (await $.session.usage()).context.tokens
    filled = typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined
  } catch {
    filled = undefined
  }
  if (filled !== undefined) return { tokens: filled, fresh: false }
  return messages !== undefined ? { tokens: estimateTokens(messages), fresh: false } : undefined
}

/** The main loop's model as `/model` names it, before the router saw a request; undefined when the engine says none. */
async function sessionModel($: EngineInterface): Promise<string | undefined> {
  try {
    const m = await $.session.model()
    return typeof m === 'string' && m !== '' ? m : undefined
  } catch {
    return undefined
  }
}

async function sessionIdOf($: EngineInterface, r: Router): Promise<string> {
  if (r.sessionId !== undefined) return r.sessionId
  try {
    const id = await $.session.id()
    if (typeof id === 'string') r.sessionId = id
    return r.sessionId ?? ''
  } catch {
    return ''
  }
}

/**
 * Appends one outcome to the decision log (log.ts), unless `decisionLog` is
 * off. Best-effort: an error is swallowed and routing goes on unchanged; the
 * only wait is the store write itself, queued behind this process's others so
 * none is lost. Fields left undefined are dropped; no prompt text is ever passed.
 */
async function record($: EngineInterface, r: Router, loop: string, action: RouteLogAction, fields: LogFields = {}): Promise<void> {
  if (!r.cfg.decisionLog) return
  try {
    const entry: RouteLogEntry = { at: await $.clock.now(), session: await sessionIdOf($, r), loop, action }
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) (entry as Record<string, unknown>)[k] = v
    const write = r.logWrites.then(() => appendLog($, entry))
    r.logWrites = write.catch(() => undefined)
    await write
  } catch {
    // the log is best-effort: routing never waits on a failed write
  }
}

/** A decision's log fields: its cell, confidence, step, the models and the context. */
function fieldsOf(d: Decision, from: string | undefined, ctx: ContextRead | undefined): LogFields {
  return { route: d.route, difficulty: d.difficulty, confidence: d.confidence, backend: d.backend, from, to: d.model, ctx: ctx?.tokens, labels: d.labels }
}

type MainInput = Before & {
  decision: Decision
  mode: 'task' | 'adaptive' | 'every-turn' | 'session-start'
  ctx: ContextRead | undefined
  /** At prompt.submit: an unknown context may still defer, and a hint can be attached. At the turn's first request: neither. */
  atPrompt: boolean
  /** The switch rule's settings when not the router's own (task: `switchMaxContext` lifted on a cold cache). */
  switchCfg?: SwitchInput['cfg']
}

/**
 * The main loop's decision for one prompt: what is pending for its turn, the
 * hint to attach, or `defer` (prompt.submit only) when the context is unknown
 * and the outcome would depend on it.
 *
 * - session-start: the first decision holds for the session, in a
 *   conversation this process saw from its start (fresh now, or a first
 *   prompt skipped as a continuation); in one under way when the process
 *   came (a reload, a restart, a resume) the model is kept for the session
 *   (`kept`, `resumed`), unknown: `unknown-context`.
 * - adaptive / every-turn: decideSwitch on the known size. A switch on an
 *   unknown size defers, then (at the request, still unknown) keeps:
 *   `unknown-context`. A kept route that needs no size (low confidence, the
 *   same model) never waits.
 */
type MainOutcome = { pending: Pending; hint?: string }

/** What a kept main-loop decision shows: the model kept (and its effort when the loop's last decision set it), the routed one as suggested. */
function keptShown(i: MainInput, action: RouteAction): Partial<Shown> {
  const { decision: d, currentModel, previous, ctx } = i
  return {
    model: currentModel ?? UNKNOWN_MODEL,
    effort: previous && previous.model === currentModel ? previous.effort : null,
    action,
    ...(ctx ? { contextTokens: ctx.tokens } : {}),
    ...(d.model !== currentModel ? { suggested: d.model } : {}),
  }
}

function decideMain(r: Router, i: MainInput): MainOutcome | 'defer' {
  const { decision: d, currentModel, ctx, atPrompt } = i
  const mode = i.mode
  if (mode === 'task') return decideTask(r, i)
  const fields = fieldsOf(d, currentModel, ctx)
  const kept = (action: RouteAction) => keptShown(i, action)
  const same = currentModel !== undefined && d.model === currentModel

  if (mode === 'session-start') {
    if (ctx?.fresh || r.sawStart) {
      // 0.1.0's behaviour: the first decision holds for the session, no action shown.
      r.mainDecision = d
      return { pending: { decision: d, apply: true, shown: {}, log: { action: same ? 'kept' : 'switched', fields: { ...fields, ...(same ? { reason: 'same-model' } : {}) } } } }
    }
    if (!ctx && atPrompt) return 'defer'
    r.mainHeld = true
    return { pending: { decision: d, apply: false, shown: kept('kept'), log: ctx ? { action: 'kept', fields: { ...fields, reason: 'resumed' } } : { action: 'unknown-context', fields } } }
  }

  const verdict = decideSwitch({ routed: d, currentModel, contextTokens: ctx?.tokens ?? 0, mode, cfg: i.switchCfg ?? r.cfg })
  if (!ctx && verdict.action === 'switched') {
    if (atPrompt) return 'defer'
    return { pending: { decision: d, apply: false, shown: kept('kept'), log: { action: 'unknown-context', fields } } }
  }
  if (verdict.apply) {
    const log: LogNote = { action: verdict.action, fields: { ...fields, ...(verdict.action === 'kept' ? { reason: 'same-model' } : {}) } }
    return { pending: { decision: d, apply: true, shown: { action: verdict.action, ...(ctx ? { contextTokens: ctx.tokens } : {}) }, log } }
  }
  const reason = verdict.reason
  // The hint rides on the prompt: a deferred decision, made at the request, can only keep.
  const hintFor = atPrompt && verdict.action === 'hint' && (reason === 'context' || reason === 'window') ? reason : undefined
  const action: RouteAction = hintFor ? 'hint' : 'kept'
  const log: LogNote = { action: reason === 'confidence' ? 'low-confidence' : action, fields: { ...fields, reason } }
  const pending: Pending = { decision: d, apply: false, shown: kept(action), log }
  if (hintFor === undefined) return { pending }
  return {
    pending,
    hint: delegationHint({ route: d.route, difficulty: d.difficulty, confidence: d.confidence, current: currentModel, suggested: d.model, contextTokens: ctx?.tokens ?? 0, reason: hintFor }),
  }
}

/**
 * The `task` mode's decision for one classified prompt (design 0.7.0 §2).
 *
 * - Not committed: a vague prompt (isClearPrompt) keeps the model, logged
 *   `vague`, nothing committed, but only while the conversation is young
 *   (context within `switchMaxContext`): a larger one has its task already
 *   and its follow-ups are not self-contained (Jev reads each prompt alone,
 *   so it calls them vague), so they count as clear. A clear one goes through the adaptive rule
 *   (`switchMaxContext` lifted after an idle or compact re-route, the window
 *   guard kept); whatever runs after it is committed when its turn starts
 *   (`commitTo`), the entry and the decision marked `committed`.
 * - Committed: `specified` blocks nothing (a follow-up is vague on its own);
 *   the same model applies (its
 *   effort); a route not heavier (by tier) keeps, with the delegation hint;
 *   a heavier one below `switchConfidence` keeps (`low-confidence`); a heavier
 *   one switches and re-commits while the context is known, ≤
 *   `switchMaxContext` and fits the target's window, else it keeps the model
 *   and attaches the escalation directive (`escalated`), or keeps plainly
 *   with `escalation` off.
 */
function decideTask(r: Router, i: MainInput): MainOutcome | 'defer' {
  const { decision: d, currentModel, ctx, atPrompt } = i
  const cfg = r.cfg
  const fields = fieldsOf(d, currentModel, ctx)
  // A conversation past `switchMaxContext` has its task: its follow-ups read as vague to a classifier that sees one prompt.
  const isClear = isClearPrompt(d.labels, cfg.minConfidence) || (ctx !== undefined && ctx.tokens > cfg.switchMaxContext)
  const keep = (action: RouteAction, log: LogNote): MainOutcome => ({ pending: { decision: d, apply: false, shown: keptShown(i, action), log } })

  if (r.committed === undefined) {
    if (!isClear) return keep('vague', { action: 'vague', fields })
    const switchCfg = r.isCacheCold ? { ...cfg, switchMaxContext: Number.POSITIVE_INFINITY } : cfg
    const out = decideMain(r, { ...i, mode: 'adaptive', switchCfg })
    if (out === 'defer') return out
    const { pending } = out
    pending.commitTo = pending.apply ? d.model : (currentModel ?? UNKNOWN_MODEL)
    pending.shown = { ...pending.shown, committed: true }
    if (pending.log) pending.log = { ...pending.log, fields: { ...pending.log.fields, committed: true } }
    return out
  }

  if (currentModel !== undefined && d.model === currentModel) {
    return { pending: { decision: d, apply: true, shown: { action: 'kept', ...(ctx ? { contextTokens: ctx.tokens } : {}) }, log: { action: 'kept', fields: { ...fields, reason: 'same-model' } } } }
  }
  if (d.confidence < cfg.switchConfidence) return keep('kept', { action: 'low-confidence', fields: { ...fields, reason: 'confidence' } })
  if (!isHeavier(d.model, currentModel)) {
    // Lighter (or no known tier): the commitment holds; a subagent may still take the routed model.
    const isHint = atPrompt && cfg.delegationHint
    const out = keep(isHint ? 'hint' : 'kept', { action: isHint ? 'hint' : 'kept', fields: { ...fields, reason: 'committed' } })
    if (!isHint) return out
    return { ...out, hint: delegationHint({ route: d.route, difficulty: d.difficulty, confidence: d.confidence, current: currentModel, suggested: d.model, contextTokens: ctx?.tokens ?? 0, reason: 'context' }) }
  }
  const fits = ctx !== undefined && ctx.tokens <= windowFor(d.model, cfg)
  if (fits && ctx.tokens <= cfg.switchMaxContext) {
    return {
      pending: {
        decision: d,
        apply: true,
        commitTo: d.model,
        shown: { action: 'switched', contextTokens: ctx.tokens, committed: true },
        log: { action: 'switched', fields: { ...fields, committed: true } },
      },
    }
  }
  const reason = ctx !== undefined && !fits ? 'window' : 'context'
  if (!cfg.escalation || !atPrompt) return keep('kept', { action: 'kept', fields: { ...fields, reason } })
  return {
    ...keep('escalated', { action: 'escalated', fields: { ...fields, reason } }),
    hint: escalationDirective({ route: d.route, difficulty: d.difficulty, confidence: d.confidence, current: currentModel, contextTokens: ctx?.tokens, hasConsult: cfg.consultMax > 0 }),
  }
}

/** Takes a pending decision's commitment (`task`), once its turn starts. */
function commit(r: Router, pending: Pending): void {
  if (pending.commitTo === undefined) return
  r.committed = pending.commitTo
  r.isCacheCold = false
}

/**
 * `task`: the cache is lost anyway (a /clear, a resume, a compaction, an
 * idle gap), so the commitment is dropped; logged `rerouted` when there was
 * one. After an idle gap or a compaction the next clear prompt may switch
 * whatever the context's size (the cache is cold).
 */
async function reroute($: EngineInterface, r: Router, reason: RerouteReason): Promise<void> {
  const was = r.committed
  r.committed = undefined
  if (reason === 'idle' || reason === 'compact') r.isCacheCold = true
  if (was !== undefined && r.cfg.routeMainLoop === 'task') {
    await record($, r, 'main', 'rerouted', { reason, from: was === UNKNOWN_MODEL ? r.mainModel : was, ctx: r.contextKnown ? r.contextTokens : undefined })
  }
}

/** `task`: no main-loop request for more than `cacheTtlMinutes`: the cache is cold. */
async function checkIdle($: EngineInterface, r: Router): Promise<void> {
  if (r.lastMainAt === undefined) return
  const now = await $.clock.now()
  if (now - r.lastMainAt <= r.cfg.cacheTtlMinutes * 60_000) return
  r.lastMainAt = undefined
  await reroute($, r, 'idle')
}

// ---------- the router's part of the shared events ----------
// hooks/register.tsx calls these from the plugin's one hook per shared event,
// each isolated there: a throw leaves the request as the engine had it.

/** session.start: clear an old status entry, register /route. */
export async function routerSessionStart($: EngineInterface): Promise<void> {
  // Clear the status entry an older jev-router (< 0.2.1) may have left behind.
  $.ui.status(undefined)
  await $.command.register({
    name: 'route',
    description:
      'Model routing: /route status | on | off | pin <fast|general|reasoning|coding> [low|medium|high] | pin off | log [n] (the last routing decisions) | log clear | log export [path] (JSONL) | report [n] (cost per model over the last n sessions)',
    argumentHint: 'status | on | off | pin <category> [low|medium|high] | pin off | log [n] | log clear | log export [path] | report [n]',
  })
}

/**
 * prompt.submit (the router's own hook, registerRouter): classify a user
 * prompt for the main loop and leave the decision pending for the turn it
 * starts. Returns the delegation hint to attach, if any.
 *
 * Only the user's own prompts are classified: origin `composer` (typed at the
 * terminal) and `bridge` (Remote Control). An `sdk` host picks its model
 * itself and has nobody to answer the consent dialog; notifications, peers,
 * schedules and plugins are not the user's request. A prompt submitted while
 * a turn runs (`turnId` set) is not classified either: it is delivered into
 * (or queued behind) a turn already on its model, and a switch mid-turn would
 * re-read the cache for nothing. Slash commands and hidden (`isMeta`)
 * prompts are skipped. Those turns keep the main loop's model.
 *
 * A continuation ("ok", "yes do it", "vas-y"; skip.ts) is not classified
 * either: it picks no new model, and the classifier, seeing only that text,
 * could move a hard task down mid-work. Nothing is pending, so the turn runs
 * on the loop's last decision (routerStep), or unrouted before the first; no
 * hint, no new routerLast. In session-start the next real prompt decides.
 *
 * The context the decision weighs comes from readContext; when it is unknown
 * and would decide, the decision is deferred to the turn's first request.
 */
async function routerPrompt($: EngineInterface, r: Router, e: PromptSubmitIn): Promise<string | undefined> {
  r.pending = undefined
  r.deferred = undefined
  const mode = r.cfg.routeMainLoop
  if (e.command || e.isMeta || e.turnId !== undefined) return undefined
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return undefined
  if (mode === 'off' || e.text.trim() === '' || r.pinned) return undefined
  if (mode === 'session-start' && (r.mainDecision || r.mainHeld)) return undefined
  if (!(await read($, isEnabled))) return undefined
  if (mode === 'task') await checkIdle($, r)
  const previous = r.byLoop.get('main')
  if (r.cfg.continuationSkip && isContinuation(e.text, r.cfg.continuationPhrases)) {
    r.skipped++
    await record($, r, 'main', 'continuation', { from: r.mainModel ?? previous?.model, ctx: r.contextKnown ? r.contextTokens : undefined })
    return undefined
  }

  const d = await classify($, r, e.text, 'claude-code main loop')
  // The model before the decision: the last request's, the loop's last decision's, else the session's own.
  const currentModel = r.mainModel ?? previous?.model ?? (await sessionModel($))
  if (!d) {
    await record($, r, 'main', 'classifier-failed', { from: currentModel, ctx: r.contextKnown ? r.contextTokens : undefined })
    return undefined
  }
  const ctx = await readContext($, r)
  const out = decideMain(r, { decision: d, mode, currentModel, previous, ctx, atPrompt: true })
  if (out === 'defer') {
    r.pending = { decision: d, apply: false, shown: {}, defer: { currentModel, previous } }
    return undefined
  }
  r.pending = out.pending
  return out.hint
}

/** turn.start: take the main loop's pending decision, keep a spawn's, or classify a subagent's later turn. */
export async function routerTurnStart($: EngineInterface, r: Router, e: TurnStartIn): Promise<void> {
  const isMain = e.agentId === undefined
  const loop = e.agentId ?? 'main'
  // The main loop's decision (if any) was made at prompt.submit; it holds for this turn only.
  const pending = isMain ? r.pending : undefined
  if (isMain) {
    r.pending = undefined
    r.deferred = undefined
  }
  if (isMain && r.cfg.routeMainLoop === 'off') return
  if (!(await read($, isEnabled))) return

  if (r.pinned) {
    const d = pinDecision(r, r.pinned)
    remember(r.byTurn, e.turnId, d)
    await publish($, loop, d, 'pin')
    // A subagent's pin was logged at its spawn.
    if (isMain) await record($, r, 'main', 'pinned', { route: d.route, difficulty: d.difficulty, from: r.mainModel, to: d.model })
    return
  }

  if (isMain) {
    if (!pending) return
    if (pending.defer) {
      // Nothing is published yet: the turn's first request settles it (routerStep).
      r.deferred = { ...pending.defer, turnId: e.turnId, decision: pending.decision }
      return
    }
    // A kept decision changes nothing: the turn goes on the loop's last decision (or none).
    if (pending.apply) {
      remember(r.byTurn, e.turnId, pending.decision)
      remember(r.byLoop, loop, pending.decision)
    }
    commit(r, pending)
    await publish($, loop, pending.decision, pending.decision.backend, pending.shown)
    if (pending.log) await record($, r, loop, pending.log.action, pending.log.fields)
    return
  }

  // A subagent's first turn was already classified at its spawn; a frontier subagent's every turn keeps its model.
  const spawned = r.byLoop.get(loop)
  if (spawned && (!r.byTurn.has(e.turnId) || r.frontierLoops.has(loop))) {
    remember(r.byTurn, e.turnId, spawned)
    return
  }

  if (e.text.trim() !== '') {
    const d = await classify($, r, e.text, 'claude-code subagent turn')
    if (d) {
      remember(r.byTurn, e.turnId, d)
      remember(r.byLoop, loop, d)
      await publish($, loop, d, d.backend)
      const from = spawned?.model
      await record($, r, loop, from === d.model ? 'kept' : 'switched', { ...fieldsOf(d, from, undefined), ...(from === d.model ? { reason: 'same-model' } : {}) })
    } else {
      await record($, r, loop, 'classifier-failed', { from: spawned?.model })
    }
  }
}

/**
 * turn.step, the turn's first main-loop request, when its switch was
 * deferred: the request is known now. One message means nothing came before
 * the prompt (a fresh conversation, context 0); more, and the context is read
 * again (readContext); still unknown, the model is kept (`unknown-context`).
 */
async function settleDeferred($: EngineInterface, r: Router, e: TurnStepIn): Promise<void> {
  const p = r.deferred
  r.deferred = undefined
  const mode = r.cfg.routeMainLoop
  if (!p || mode === 'off') return
  const ctx: ContextRead | undefined = e.messageCount <= 1 ? { tokens: 0, fresh: true } : await readContext($, r)
  // Unknown at the prompt, the model before the decision is the one this request names now.
  const out = decideMain(r, { decision: p.decision, mode, currentModel: p.currentModel ?? e.model, previous: p.previous, ctx, atPrompt: false })
  if (out === 'defer') return
  const { pending } = out
  if (pending.apply) {
    remember(r.byTurn, e.turnId, pending.decision)
    remember(r.byLoop, 'main', pending.decision)
  }
  commit(r, pending)
  await publish($, 'main', pending.decision, pending.decision.backend, pending.shown)
  if (pending.log) await record($, r, 'main', pending.log.action, pending.log.fields)
}

/** turn.step: the request to send, its model/effort rewritten where a decision holds. */
export async function routerStep($: EngineInterface, r: Router, e: TurnStepIn): Promise<TurnStepIn> {
  let d: Decision | undefined
  try {
    const isMain = e.agentId === undefined
    // A request of one message: the conversation starts here, in this process.
    if (isMain && e.messageCount <= 1) r.sawStart = true
    // The prompt cache's clock (task: an idle gap past cacheTtlMinutes drops the commitment).
    if (isMain) r.lastMainAt = await $.clock.now()
    if (isMain && r.deferred !== undefined && r.deferred.turnId === e.turnId) await settleDeferred($, r, e)
    if (!(isMain && r.cfg.routeMainLoop === 'off') && (await read($, isEnabled))) {
      if (r.pinned) d = pinDecision(r, r.pinned)
      else if (isMain && r.cfg.routeMainLoop === 'session-start') d = r.mainDecision
      else d = r.byTurn.get(e.turnId) ?? r.byLoop.get(e.agentId ?? 'main')
    }
  } catch {
    r.deferred = undefined
    d = undefined
  }
  if (!d) {
    if (e.agentId === undefined && r.mainModel === undefined) await nameSessionModel($, e.model)
    return e
  }
  return { ...e, model: d.model, ...(d.effort === null ? {} : { effort: d.effort }) }
}

/**
 * The main loop's first request goes out unrouted on the session's model: a
 * decision kept before it named UNKNOWN_MODEL, so name the real one. The
 * decision keeps its `at`, so the HUD replaces its trail mark rather than
 * adding one.
 */
async function nameSessionModel($: EngineInterface, model: string): Promise<void> {
  const shown = await read($, last)
  if (shown === null || shown.loop !== 'main' || shown.model !== UNKNOWN_MODEL) return
  await update($, last, v => {
    if (v === null || v.loop !== 'main' || v.model !== UNKNOWN_MODEL) return v
    const { suggested, ...rest } = v
    // with the model unknown, the route's own model was named as suggested; it may be this one
    return suggested === undefined || suggested === model ? { ...rest, model } : { ...rest, model, suggested }
  })
}

/**
 * turn.step, once answered (synchronous): the main loop's context size
 * (input + cache read + cache write, as the HUD reads `usage`) and the model
 * the request was sent with, for the next adaptive decision. Subagent steps
 * are ignored; a step with no usage keeps the previous size.
 */
export function routerObserve(r: Router, request: TurnStepIn, result: TurnStepResult): void {
  if (request.agentId !== undefined) return
  r.mainModel = request.model
  if (r.committed === UNKNOWN_MODEL) r.committed = request.model
  const usage = result.usage
  if (!usage) return
  r.contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  r.contextKnown = true
}

/**
 * turn.step, once answered (synchronous): with `decisionLog` on, the
 * request's tokens, the main loop's and every subagent's, are added to the
 * usage store (report.ts recordUsage), one call per answered request, under
 * the model it was sent with. Fire-and-forget: never awaited, never throwing.
 */
export function observeUsage($: EngineInterface, r: Router, request: TurnStepIn, result: TurnStepResult): void {
  try {
    const usage = result.usage
    if (!usage || !r.cfg.decisionLog) return
    const delta = {
      model: request.model || usage.model,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    }
    void sessionIdOf($, r)
      .then(session => recordUsage($, { session, ...delta }))
      .catch(() => undefined)
  } catch {
    // usage is best-effort: routing never waits on it
  }
}

/** agent.spawn, before the start: the decision for the new subagent, if any (its `model` goes to `next`). */
export async function routerSpawn($: EngineInterface, r: Router, e: AgentSpawnIn): Promise<Decision | undefined> {
  if (e.resume || e.fork || !(await read($, isEnabled))) return undefined
  const from = e.model ?? e.parentModel
  // The escalation target: not classified, on the frontier model at effort high.
  if (e.subagentType === FRONTIER_AGENT) {
    const d: Decision = { route: 'reasoning', difficulty: 'high', model: frontierModel(r), effort: 'high', confidence: 1, backend: 'local' }
    r.frontier.add(d)
    r.spawnFrom.set(d, { from, pinned: false })
    return d
  }
  if (r.pinned) {
    const d = pinDecision(r, r.pinned)
    r.spawnFrom.set(d, { from, pinned: true })
    return d
  }
  const d = await classify($, r, `[${e.subagentType}] ${e.description}\n\n${e.prompt}`, `claude-code subagent spawn: ${e.subagentType}`)
  // No agent id before the start: a failed spawn classification is logged under `spawn`.
  if (!d) await record($, r, 'spawn', 'classifier-failed', { from })
  else r.spawnFrom.set(d, { from, pinned: false })
  return d
}

/** agent.spawn, once started: keep the decision for the new loop and publish it. */
export async function routerSpawned($: EngineInterface, r: Router, d: Decision, started: AgentSpawnOut): Promise<void> {
  if (r.frontier.has(d)) {
    if (started.deny !== undefined) return
    const loop = started.agentId ?? 'spawn'
    if (started.agentId !== undefined) {
      remember(r.byLoop, started.agentId, d)
      r.frontierLoops.add(started.agentId)
      if (r.frontierLoops.size > MAX_CACHED) r.frontierLoops.delete(r.frontierLoops.values().next().value as string)
      // A forced decision: no classifier answered it.
      await publish($, started.agentId, d, 'frontier')
    }
    await record($, r, loop, 'escalated', { route: d.route, difficulty: d.difficulty, from: r.spawnFrom.get(d)?.from, to: d.model, reason: 'frontier' })
    return
  }
  if (started.deny === undefined && started.agentId !== undefined) {
    remember(r.byLoop, started.agentId, d)
    await publish($, started.agentId, d, r.pinned ? 'pin' : d.backend)
    const spawn = r.spawnFrom.get(d)
    const from = spawn?.from
    if (spawn?.pinned) await record($, r, started.agentId, 'pinned', { route: d.route, difficulty: d.difficulty, from, to: d.model })
    else await record($, r, started.agentId, from === d.model ? 'kept' : 'switched', { ...fieldsOf(d, from, undefined), ...(from === d.model ? { reason: 'same-model' } : {}) })
  }
}

// ---------- the router's own events ----------

/**
 * A /clear starts a new conversation: its cache is cold, so the main loop is
 * classified afresh. A /resume moves to another conversation: what the router
 * observed of this one (its model, its size) no longer holds, so the next
 * prompt reads the resumed one's context (readContext).
 */
function forget(r: Router, reason: string): void {
  if (reason !== 'clear' && reason !== 'resume') return
  r.mainDecision = undefined
  r.mainHeld = false
  r.sawStart = false
  r.pending = undefined
  r.deferred = undefined
  r.mainModel = undefined
  r.contextTokens = 0
  r.contextKnown = false
  r.sessionId = undefined
  r.calls = 0
  r.skipped = 0
  r.byTurn.clear()
  r.byLoop.clear()
  r.consent.reset()
  r.committed = undefined
  r.isCacheCold = false
  r.lastMainAt = undefined
  r.frontierLoops.clear()
}

/** One category's row of the matrix: `low → model (effort) · medium → … · high → …`. */
function matrixRow(routes: RouteMap, label: RouteLabel): string {
  return DIFFICULTIES.map(d => {
    const cell = routeFor(routes, label, d)
    return `${d} → ${cell.model}${cell.effort ? ` (${cell.effort})` : ''}`
  }).join(' · ')
}

/** /route log [n] | log clear: the decision log, newest first (log.ts). */
async function logCommand($: EngineInterface, r: Router, arg: string | undefined): Promise<{ text: string }> {
  try {
    // Let this process's queued writes land first.
    await r.logWrites
    if (arg === 'clear') {
      await clearLog($)
      return { text: 'router: decision log cleared.' }
    }
    const n = parseCount(arg)
    if (n === undefined) return { text: `router: /route log [n] prints the newest n decisions (default 20, at most ${LOG_CAP}); /route log clear empties the log.` }
    return { text: formatLog(await readLog($), n, r.cfg.decisionLog) }
  } catch {
    return { text: 'router: the decision log could not be read.' }
  }
}

/** /route status | on | off | pin <category> [low|medium|high] | pin off | log [n] | log clear. */
async function command($: EngineInterface, r: Router, args: string): Promise<{ text: string }> {
  const { cfg, routes, consent } = r
  const words = args.trim().split(/\s+/).filter(Boolean)
  const [verb = 'status', arg, level] = words

  if (verb === 'log' && arg === 'export') {
    await r.logWrites
    const path = args.trim().replace(/^log\s+export\s*/, '')
    return { text: await exportCommand($, path === '' ? undefined : path) }
  }
  if (verb === 'log') return logCommand($, r, arg)
  if (verb === 'report') return { text: await reportCommand($, arg, { ...r.options }, frontierModel(r)) }

  if (verb === 'on' || verb === 'off') {
    await update($, isEnabled, () => verb === 'on')
    return { text: `router: routing ${verb}.` }
  }

  if (verb === 'pin') {
    if (arg === 'off' || arg === undefined) {
      r.pinned = undefined
      return { text: 'router: pin cleared, the classifier decides again.' }
    }
    if (!isLabel(arg)) return { text: `router: unknown route "${arg}". Routes: ${LABELS.join(', ')}.` }
    const difficulty = level ?? 'medium'
    if (!isDifficulty(difficulty)) return { text: `router: unknown difficulty "${difficulty}". Difficulties: ${DIFFICULTIES.join(', ')}.` }
    const pin: Pin = { route: arg, difficulty }
    r.pinned = pin
    return { text: `router: pinned to ${cellName(pin.route, pin.difficulty)} → ${routeFor(routes, pin.route, pin.difficulty).model}.` }
  }

  const enabled = await read($, isEnabled)
  const d = await read($, last)
  const chain = cfg.chain.length > 0 ? (await Promise.all(cfg.chain.map(s => describeStep($, r, s)))).join(' → ') : 'none'
  const now = await $.clock.now()
  const session = [
    consent.preferred ? `using ${consent.preferred} for this session` : '',
    now < consent.stayUntil ? `unrouted for ${Math.ceil((consent.stayUntil - now) / 60_000)} min` : '',
    consent.lastFailure ? `last failure: ${consent.lastFailure.step}, ${consent.lastFailure.summary}` : '',
  ].filter(Boolean)
  const rule = `switch at conf ≥ ${cfg.switchConfidence}, ctx ≤ ${formatTokens(cfg.switchMaxContext)}${cfg.delegationHint ? ', hint' : ''}`
  const committed = r.committed === undefined ? 'not committed' : `committed ${r.committed === UNKNOWN_MODEL ? (r.mainModel ?? UNKNOWN_MODEL) : r.committed}`
  const mode =
    cfg.routeMainLoop === 'adaptive'
      ? `adaptive (${rule})`
      : cfg.routeMainLoop === 'task'
        ? `task (${rule}${cfg.escalation ? `, escalation to ${frontierModel(r)}` : ''}, cache ttl ${cfg.cacheTtlMinutes} min) · ${committed}`
        : cfg.routeMainLoop
  const action = d?.action ? ` · ${d.action}${d.suggested ? ` (→ ${d.suggested})` : ''}` : ''
  const ctx = d?.contextTokens !== undefined ? ` · ctx ${formatTokens(d.contextTokens)}` : ''
  const map = LABELS.map(l => `  ${l.padEnd(9)} ${matrixRow(routes, l)}`)
  return {
    text: [
      `router: ${enabled ? 'on' : 'off'} · profile ${cfg.profile} · main loop ${mode} · fallback ${cfg.fallbackPolicy}${r.pinned ? ` · pinned ${cellName(r.pinned.route, r.pinned.difficulty)}` : ''}`,
      `chain: ${chain}`,
      `classifier: ${r.calls} call${r.calls === 1 ? '' : 's'} · ${cfg.continuationSkip ? `${r.skipped} skipped (continuation)` : 'continuation skip off'}`,
      ...(session.length > 0 ? [`session: ${session.join(' · ')}`] : []),
      `decision log: ${cfg.decisionLog ? 'on' : 'off'} · /route log [n] shows it, /route log clear empties it, /route log export [path] writes it · /route report [n]`,
      d ? `last: ${d.loop} · ${cellName(d.route, d.difficulty)} → ${d.model} · conf ${d.confidence.toFixed(2)} · ${d.backend}${action}${ctx}` : 'last: none yet',
      'routes:',
      ...map,
    ].join('\n'),
  }
}

/** Registers the router's own events: prompt.submit, session.end, session.compact and /route. The shared ones are in hooks/register.tsx. */
export function registerRouter(on: On, r: Router): void {
  // Fails open: an error leaves the prompt as it came (and nothing pending).
  on('prompt.submit', async ($, e, next) => {
    let hint: string | undefined
    try {
      hint = await routerPrompt($, r, e)
    } catch {
      r.pending = undefined
      hint = undefined
    }
    const result = await next(hint ? { ...e, context: [...(e.context ?? []), hint] } : e)
    // A prompt dropped below starts no turn: its decision must not reach the next one.
    if (result.drop !== undefined) r.pending = undefined
    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    try {
      if (e.reason === 'clear' || e.reason === 'resume') await reroute($, r, e.reason)
    } catch {
      // the log is best-effort
    }
    forget(r, e.reason)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A compaction of the main conversation rewrites its prefix: the cache is
  // lost, the commitment dropped. The context is the compacted one's.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
        const after = result.tokensAfter
        if (typeof after === 'number' && Number.isFinite(after) && after >= 0) r.contextTokens = after
        else r.contextKnown = false
        await reroute($, r, 'compact')
      }
    } catch {
      // fail open: the compaction went through as the engine had it
    }
    return result
  })

  on('command.run', { command: 'route' }, async ($, e) => command($, r, e.args)).catch(() => ({ text: 'router: /route failed.' }))
}
