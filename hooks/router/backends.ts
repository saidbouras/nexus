// The router's classifier steps: Jev (a Databricks AI Gateway or the TypeSafe
// API direct), Haiku (a small completion through the session's own client)
// and a local Ollama model. Each answers whether it is configured and
// classifies or throws a StepError whose summary is safe to show: an HTTP
// status and a short phrase, never a header, a token or a request body.
// register.ts hands in an `Io` built over `$`, so tests can stand in for it.

import type { HttpInit, HttpResponse, ModelCompleteRequest, ModelCompleteResult, ProcessRunInit, ProcessRunResult } from 'claude-code'
import {
  DIFFICULTIES,
  DIFFICULTY_DESCRIPTIONS,
  JEV_DIFFICULTY_QUESTION,
  JEV_DIRECT_URL,
  JEV_MODEL,
  JEV_QUESTION,
  LABELS,
  LABEL_DESCRIPTIONS,
  OLLAMA_URL,
  TASK_LABELS,
  TASK_LABEL_KEYS,
  difficultyInstruction,
  haikuSystemPrompt,
  instruction,
  labelValues,
  parseAnswer,
  parseHaikuReply,
  systemPrompt,
  timeoutFor,
  truncatePrompt,
} from './classify'
import type { Classification, RouterConfig, StepName } from './classify'

export const TOKEN_TTL_MS = 10 * 60 * 1000
export const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags'
const PROBE_TIMEOUT_MS = 500
const PROBE_TTL_MS = 60 * 1000

export type AskUser = (question: string, options: { options: readonly string[]; header: string }) => Promise<string>

export type Io = {
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  now: () => Promise<number>
  /** Rejects with a TimeoutError when `p` has not settled within `ms`. */
  timeout: <T>(p: Promise<T>, ms: number) => Promise<T>
  /** An environment variable's value, undefined when unset or unreadable. */
  env: (name: string) => Promise<string | undefined>
  /** `$.model.complete`; one that throws a TypeError (an engine without it) makes the haiku step unconfigured. */
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>
  /** `$.ui.ask`: rejects when dismissed or headless. */
  ask: AskUser
}

/** What one classification is asked about: the latest message and where it came from. */
export type Ask = { message: string; channel: string }

// ---------------------------------------------------------------- errors

export class TimeoutError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`)
  }
}

/** Thrown by a step that turns out not to be configured: the chain skips it silently, as if never listed. */
export class NotConfigured extends Error {}

export type FailureKind = 'timeout' | 'auth' | 'http' | 'network' | 'bad-answer' | 'token' | 'error'

/** A configured step that failed; `summary` is what the consent dialog and /route status show. */
export class StepError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly summary: string,
    readonly status?: number,
  ) {
    super(summary)
  }
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  408: 'request timeout',
  429: 'rate limited',
  500: 'server error',
  502: 'bad gateway',
  503: 'unavailable',
  504: 'gateway timeout',
}

/** One short line with every secret, and anything after `Bearer`, blanked. */
export function sanitize(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(/\s+/g, ' ').trim()
  for (const s of secrets) if (s !== undefined && s.length >= 4) out = out.split(s).join('***')
  out = out.replace(/bearer\s+\S+/gi, 'Bearer ***')
  return out.length > 120 ? `${out.slice(0, 117)}...` : out
}

/** The StepError for a non-2xx answer: the status, its phrase and an error code the body names, nothing else of the body. */
export function httpError(res: HttpResponse): StepError {
  let code = ''
  try {
    const body = JSON.parse(res.text) as { error_code?: unknown; error?: { type?: unknown } | unknown }
    const c = body.error_code ?? (body.error !== null && typeof body.error === 'object' ? (body.error as { type?: unknown }).type : body.error)
    if (typeof c === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(c)) code = ` (${c})`
  } catch {
    // no readable body: the status says enough
  }
  const phrase = STATUS_TEXT[res.status] ?? (res.status >= 500 ? 'server error' : 'error')
  return new StepError(res.status === 401 || res.status === 403 ? 'auth' : 'http', `HTTP ${res.status} ${phrase}${code}`, res.status)
}

/** Any error out of a step as a StepError, its text sanitized against `secrets`. */
export function toStepError(err: unknown, secrets: readonly (string | undefined)[] = []): StepError {
  if (err instanceof StepError) return err
  if (err instanceof TimeoutError) return new StepError('timeout', err.message)
  const msg = err instanceof Error ? err.message : String(err)
  return new StepError('network', `network error: ${sanitize(msg, secrets)}`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new StepError('bad-answer', 'bad answer: unreadable JSON')
  }
}

function mustClassify(c: Classification | undefined): Classification {
  if (c === undefined) throw new StepError('bad-answer', 'bad answer: not a route label')
  return c
}

// ---------------------------------------------------------------- jev

// The Databricks AI Gateway SystemOne contract (verified with live calls, two
// questions in one request, then nine: the seven task labels too, 2026-11-11):
//   POST <jevUrl>  { model, state: { message, channel }, questions: { route: {...}, difficulty: {...}, specified: {...}, ... } }
//     each question { type: 'choice', instructions, criteria }
//   -> { model, answers: { route: { type: 'choice', choice, confidence, probabilities },
//                          difficulty: { type: 'choice', choice, confidence, probabilities },
//                          specified: { type: 'choice', ... }, ... }, usage }
// `route` is the category, `difficulty` low, medium or high; the labels are
// TASK_LABELS (sent only with `labels` on). An answer's
// `confidence` can differ from the probability of its choice; parseAnswer
// uses the probability. Should a gateway answer one question with combined
// labels instead (`choice: 'coding/high'`, probabilities over the 12 cells),
// parseAnswer reads that form too.
// The TypeSafe API direct (UNVERIFIED: no key was available) is taken from
// its public docs, whose example sends `state` as a plain string:
//   POST https://api.typesafe.ai/v1/systemone  { model, state: '<message>', questions: { ... } }
// and is assumed to answer the same `answers` shape. Billed per token: the
// state is the latest message only, cut to MAX_PROMPT_CHARS; never the conversation.

export type JevRoute =
  | { kind: 'gateway'; url: string; model: string }
  | { kind: 'direct'; url: string; model: string; key: string }

/** A `jevUrl` means the gateway; else the direct API when its key is set; else Jev is not configured. */
export async function jevRoute(io: Io, cfg: RouterConfig): Promise<JevRoute | undefined> {
  if (cfg.jevUrl !== '') return { kind: 'gateway', url: cfg.jevUrl, model: cfg.jevModel || JEV_MODEL.gateway }
  let key: string | undefined
  try {
    key = await io.env(cfg.jevApiKeyEnv)
  } catch {
    key = undefined
  }
  if (key === undefined || key.trim() === '') return undefined
  return { kind: 'direct', url: JEV_DIRECT_URL, model: cfg.jevModel || JEV_MODEL.direct, key: key.trim() }
}

/** The SystemOne request: route and difficulty, and the seven task labels when `labels` is on, in one call. */
export function jevBody(route: JevRoute, ask: Ask, labels = true): string {
  const criteria: Record<string, string> = {}
  for (const l of LABELS) criteria[l] = LABEL_DESCRIPTIONS[l]
  const difficultyCriteria: Record<string, string> = {}
  for (const d of DIFFICULTIES) difficultyCriteria[d] = DIFFICULTY_DESCRIPTIONS[d]
  const message = truncatePrompt(ask.message)
  return JSON.stringify({
    model: route.model,
    state: route.kind === 'gateway' ? { message, channel: ask.channel } : message,
    questions: {
      [JEV_QUESTION]: { type: 'choice', instructions: instruction(), criteria },
      [JEV_DIFFICULTY_QUESTION]: { type: 'choice', instructions: difficultyInstruction(), criteria: difficultyCriteria },
      ...(labels ? labelQuestions() : {}),
    },
  })
}

function labelQuestions(): Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> {
  const out: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> = {}
  for (const k of TASK_LABEL_KEYS) out[k] = { type: 'choice', instructions: TASK_LABELS[k].instructions, criteria: { ...TASK_LABELS[k].criteria } }
  return out
}

function choiceAnswer(answers: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const a = answers[key]
  if (a === null || typeof a !== 'object' || (a as { type?: unknown }).type !== 'choice') return undefined
  return a as Record<string, unknown>
}

/**
 * The answers out of a SystemOne response as one parseAnswer input, or
 * undefined without a `route` answer: the `route` answer as is (its choice may
 * be a combined label), with the `difficulty` answer, when there is one, as
 * `difficulty`, `difficultyConfidence` and `difficultyProbabilities`, and the
 * task-label answers there are as `labels` (parseAnswer validates each).
 */
export function unwrapJev(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const answers = (raw as { answers?: unknown }).answers
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined
  const a = choiceAnswer(answers as Record<string, unknown>, JEV_QUESTION)
  if (a === undefined) return undefined
  const labels: Record<string, unknown> = {}
  for (const k of TASK_LABEL_KEYS) {
    const l = choiceAnswer(answers as Record<string, unknown>, k)
    if (l !== undefined) labels[k] = l
  }
  const withLabels = Object.keys(labels).length > 0 ? { ...a, labels } : a
  const d = choiceAnswer(answers as Record<string, unknown>, JEV_DIFFICULTY_QUESTION)
  if (d === undefined) return withLabels
  return { ...withLabels, difficulty: d.choice, difficultyConfidence: d.confidence, difficultyProbabilities: d.probabilities }
}

/** A Databricks token cache; the token itself is never logged or exposed. */
export class TokenCache {
  private token: string | undefined
  private expiresAt = 0

  /** The cached token, for blanking it out of error text; never shown. */
  peek(): string | undefined {
    return this.token
  }

  async get(io: Io, profile: string): Promise<string> {
    const now = await io.now()
    if (this.token !== undefined && now < this.expiresAt) return this.token
    const argv = profile === '' ? ['databricks', 'auth', 'token'] : ['databricks', 'auth', 'token', '-p', profile]
    let r: ProcessRunResult
    try {
      r = await io.run(argv, { timeoutMs: 10_000 })
    } catch {
      throw new StepError('token', 'databricks auth token could not run')
    }
    if (r.exitCode !== 0) throw new StepError('token', `databricks auth token exited ${r.exitCode}`)
    let parsed: { access_token?: unknown }
    try {
      parsed = JSON.parse(r.stdout) as { access_token?: unknown }
    } catch {
      // The parser's message can quote stdout, which holds the token.
      throw new StepError('token', 'databricks auth token: unreadable output')
    }
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new StepError('token', 'databricks auth token: no access_token')
    }
    this.token = parsed.access_token
    this.expiresAt = now + TOKEN_TTL_MS
    return this.token
  }

  clear(): void {
    this.token = undefined
    this.expiresAt = 0
  }
}

/** One POST: the gateway with the cached token (a 401 clears it and retries once), the direct API with its key. */
async function postJev(io: Io, cfg: RouterConfig, tokens: TokenCache, route: JevRoute, body: string): Promise<HttpResponse> {
  if (route.kind === 'direct') {
    return io.fetch(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${route.key}` },
      body,
    })
  }
  for (let attempt = 0; ; attempt++) {
    const token = await tokens.get(io, cfg.databricksProfile)
    const res = await io.fetch(route.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    })
    if (res.status === 401 || res.status === 403) tokens.clear()
    if (res.status !== 401 || attempt > 0) return res
  }
}

export async function classifyJev(io: Io, cfg: RouterConfig, tokens: TokenCache, route: JevRoute, ask: Ask): Promise<Classification> {
  const secrets = () => [tokens.peek(), route.kind === 'direct' ? route.key : undefined]
  let res: HttpResponse
  try {
    // One deadline over the token CLI, the call and its retry.
    res = await io.timeout(postJev(io, cfg, tokens, route, jevBody(route, ask, cfg.labels)), timeoutFor(cfg, 'jev'))
  } catch (err) {
    throw toStepError(err, secrets())
  }
  if (!res.ok) throw httpError(res)
  return mustClassify(parseAnswer(unwrapJev(parseJson(res.text))))
}

// ---------------------------------------------------------------- haiku

export const HAIKU_MAX_TOKENS = 96
export const HAIKU_MAX_TOKENS_LABELS = 256

export function haikuRequest(cfg: RouterConfig, ask: Ask): ModelCompleteRequest {
  return {
    model: cfg.haikuModel,
    system: haikuSystemPrompt(cfg.labels),
    prompt: `<request channel="${ask.channel}">\n${truncatePrompt(ask.message)}\n</request>`,
    // The labels add about 90 tokens of JSON to the reply.
    maxTokens: cfg.labels ? HAIKU_MAX_TOKENS_LABELS : HAIKU_MAX_TOKENS,
    timeoutMs: timeoutFor(cfg, 'haiku'),
  }
}

export async function classifyHaiku(io: Io, cfg: RouterConfig, st: StepState, ask: Ask): Promise<Classification> {
  let r: ModelCompleteResult
  try {
    r = await io.timeout(io.complete(haikuRequest(cfg, ask)), timeoutFor(cfg, 'haiku'))
  } catch (err) {
    if (err instanceof TimeoutError) throw toStepError(err)
    // The capability check: an engine with no `$.model.complete` has no haiku step.
    if (err instanceof TypeError) {
      st.hasModelApi = false
      throw new NotConfigured('$.model.complete is not available')
    }
    // Any other rejection is a request the engine refused to send (a blocked model).
    throw new StepError('error', `model request refused: ${sanitize(err instanceof Error ? err.message : String(err))}`)
  }
  if (r.isAnswered) return mustClassify(parseHaikuReply(r.text))
  if (r.reason === 'api-error') {
    if (r.status === null) throw new StepError('network', `network error (${r.error})`)
    const phrase = STATUS_TEXT[r.status] ?? 'error'
    throw new StepError(r.status === 401 || r.status === 403 ? 'auth' : 'http', `HTTP ${r.status} ${phrase} (${r.error})`, r.status)
  }
  if (r.reason === 'aborted') throw new StepError('timeout', `timed out after ${timeoutFor(cfg, 'haiku')}ms`)
  throw new StepError('bad-answer', 'bad answer: empty reply')
}

// ---------------------------------------------------------------- local (Ollama)

/** The Ollama request; with `labels`, the schema asks the task labels too (parseAnswer still treats each as optional). */
export function ollamaBody(model: string, prompt: string, labels = true): string {
  const probProps: Record<string, { type: 'number' }> = {}
  for (const l of LABELS) probProps[l] = { type: 'number' }
  const difficultyProps: Record<string, { type: 'number' }> = {}
  for (const d of DIFFICULTIES) difficultyProps[d] = { type: 'number' }
  const labelProps: Record<string, { type: 'string'; enum: string[] } | { type: 'number' }> = {}
  if (labels) {
    for (const k of TASK_LABEL_KEYS) labelProps[k] = { type: 'string', enum: [...labelValues(k)] }
    labelProps.specifiedConfidence = { type: 'number' }
  }
  return JSON.stringify({
    model,
    stream: false,
    think: false,
    keep_alive: '30m',
    format: {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: [...LABELS] },
        probabilities: { type: 'object', properties: probProps, required: [...LABELS] },
        difficulty: { type: 'string', enum: [...DIFFICULTIES] },
        difficultyProbabilities: { type: 'object', properties: difficultyProps, required: [...DIFFICULTIES] },
        ...labelProps,
      },
      required: ['choice', 'probabilities', 'difficulty', 'difficultyProbabilities', ...Object.keys(labelProps)],
    },
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: systemPrompt(labels) },
      { role: 'user', content: truncatePrompt(prompt) },
    ],
  })
}

/** Whether Ollama answers on localhost, remembered for a minute. */
export class OllamaProbe {
  private known: { isUp: boolean; at: number } | undefined

  async isUp(io: Io): Promise<boolean> {
    const now = await io.now()
    if (this.known !== undefined && now - this.known.at < PROBE_TTL_MS) return this.known.isUp
    let isUp: boolean
    try {
      isUp = (await io.timeout(io.fetch(OLLAMA_TAGS_URL, { method: 'GET' }), PROBE_TIMEOUT_MS)).ok
    } catch {
      isUp = false
    }
    this.known = { isUp, at: now }
    return isUp
  }

  clear(): void {
    this.known = undefined
  }
}

export async function classifyLocal(io: Io, cfg: RouterConfig, ask: Ask): Promise<Classification> {
  let res: HttpResponse
  try {
    res = await io.timeout(
      io.fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ollamaBody(cfg.localModel, ask.message, cfg.labels),
      }),
      timeoutFor(cfg, 'local'),
    )
  } catch (err) {
    throw toStepError(err)
  }
  if (!res.ok) throw httpError(res)
  const outer = parseJson(res.text) as { message?: { content?: unknown } } | null
  const content = outer?.message?.content
  if (typeof content !== 'string') throw new StepError('bad-answer', 'bad answer: no message content')
  return mustClassify(parseAnswer(parseJson(content)))
}

// ---------------------------------------------------------------- steps

/** The per-session state the steps keep: the Databricks token and Ollama's reachability. */
export type StepState = {
  tokens: TokenCache
  ollama: OllamaProbe
  /** False once `$.model.complete` turned out missing. */
  hasModelApi: boolean
}

/** Whether `step` can run at all; an unconfigured step is skipped silently. */
export async function isConfigured(io: Io, cfg: RouterConfig, st: StepState, step: StepName): Promise<boolean> {
  if (step === 'jev') return (await jevRoute(io, cfg)) !== undefined
  if (step === 'haiku') return st.hasModelApi && cfg.haikuModel !== ''
  return st.ollama.isUp(io)
}

/** Runs one configured step; throws a StepError when it fails. */
export async function runStep(io: Io, cfg: RouterConfig, st: StepState, step: StepName, ask: Ask): Promise<Classification> {
  if (step === 'jev') {
    const route = await jevRoute(io, cfg)
    if (route === undefined) throw new NotConfigured('jev is not configured')
    return classifyJev(io, cfg, st.tokens, route, ask)
  }
  if (step === 'haiku') return classifyHaiku(io, cfg, st, ask)
  return classifyLocal(io, cfg, ask)
}
