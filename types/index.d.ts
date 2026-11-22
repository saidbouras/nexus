/**
 * NEXUS shared state contract. One plugin (`nexus`), one hooks module
 * (hooks/register.tsx) composing three parts: `router` writes the routing
 * keys, `hud` writes the dashboard keys and reads `routerLast`. The
 * orchestrator part keeps no state.
 */

export type RouteLabel = 'fast' | 'general' | 'reasoning' | 'coding'

export type RouteEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number

/** How hard the classifier judged the prompt; with the category it picks the model. */
export type RouteDifficulty = 'low' | 'medium' | 'high'

/**
 * The classifier's task labels (0.7.0), asked with `route` and `difficulty` in
 * the same request. Each is optional: a missing or invalid one is left out.
 * `language` is unreliable and feeds the report only, never routing.
 */
export type RouteLabels = {
  specified?: 'clear' | 'vague'
  /** probability of the `specified` choice, 0..1 */
  specifiedConfidence?: number
  scope?: 'none' | 'local' | 'multi_file' | 'cross_system'
  evidence?: 'snippet' | 'traceback' | 'reference' | 'none'
  failure?: 'crash' | 'wrong_behavior' | 'performance' | 'none'
  localization?: 'pinpointed' | 'likely_local' | 'spread'
  language?: 'python' | 'typescript' | 'sql' | 'iac' | 'shell' | 'jvm' | 'other'
  project?: 'data' | 'web' | 'infra' | 'tooling' | 'docs' | 'other'
}

/** Why a `task`-mode commitment was dropped (the cache is lost anyway). */
export type RerouteReason = 'clear' | 'compact' | 'resume' | 'idle'

/** Which step produced a decision; `pin` when `/route pin` forced it, `frontier` for a `nexus:frontier` subagent (no classifier). */
export type RouteBackend = 'jev' | 'haiku' | 'local' | 'pin' | 'frontier'

/**
 * What an `adaptive` (or window-guarded `every-turn`) main-loop decision did:
 * `switched` to the routed model; `kept` the current one (low confidence, a
 * context too large to re-read, or one past the target's window); `hint`,
 * kept and a delegation note attached to the prompt; `escalated` (`task`
 * mode), kept and the escalation directive attached; `vague` (`task` mode),
 * kept because the prompt specified no task, nothing committed. Absent on subagent,
 * `session-start` and pinned decisions.
 */
export type RouteAction = 'switched' | 'kept' | 'hint' | 'escalated' | 'vague'

/** One routing decision, as the router last made it. */
export type RouterDecision = {
  /** The loop it applies to: `main` or a subagent's id. */
  loop: string
  route: RouteLabel
  /** The classifier's difficulty; absent from a decision made before 0.4.0. */
  difficulty?: RouteDifficulty
  /** The model the loop's requests are sent with (the kept one when `action` is `kept`/`hint`). */
  model: string
  /** null when the route sets no effort (the step keeps its own). */
  effort: RouteEffort | null
  confidence: number
  backend: RouteBackend
  /** `$.clock.now()` milliseconds. */
  at: number
  action?: RouteAction
  /** The main loop's context, in tokens, when the decision was made. */
  contextTokens?: number
  /** `kept`/`hint`/`escalated`: the model the route would have switched to. */
  suggested?: string
  /** The classifier's task labels, when it gave any. */
  labels?: RouteLabels
  /** `task` mode: the decision committed the session's model. */
  committed?: boolean
}

/**
 * What one entry of the decision log (`router.log` in the plugin's `$.store`)
 * records the router did:
 *
 * - `switched`: the loop took the routed model (a main-loop switch, a
 *   subagent spawned or a subagent turn classified onto it, a `session-start`
 *   first decision).
 * - `kept`: the model stayed (`reason`: `context`, `window`, `same-model`,
 *   or `resumed` for `session-start` in a conversation that was not fresh).
 * - `hint`: kept, and a delegation note was attached to the prompt.
 * - `low-confidence`: kept, the classifier's confidence was below `switchConfidence`.
 * - `continuation`: an acknowledgement prompt skipped the classifier.
 * - `classifier-failed`: no step of the chain gave an answer (failed,
 *   declined, or the session chose to stay unrouted).
 * - `pinned`: `/route pin` decided.
 * - `unknown-context`: kept, the conversation was not fresh and its size
 *   could not be read or estimated.
 * - `vague` (`task` mode): kept, the prompt did not specify a task; nothing committed.
 * - `escalated` (`task` mode): kept, the escalation directive was attached; or a
 *   `nexus:frontier` subagent spawned on the frontier model.
 * - `consulted`: the `consult` tool asked the frontier model (`to`).
 * - `rerouted`: a `task` commitment was dropped (`reason`: clear, compact, resume, idle).
 */
export type RouteLogAction = 'switched' | 'kept' | 'hint' | 'low-confidence' | 'continuation' | 'classifier-failed' | 'pinned' | 'unknown-context' | 'vague' | 'escalated' | 'consulted' | 'rerouted'

/** One routing outcome as the decision log keeps it. Never any prompt text. */
export type RouteLogEntry = {
  /** Epoch milliseconds (`$.clock.now()`). */
  at: number
  /** The session id (`$.session.id()`); '' when the engine gave none. */
  session: string
  /** `main`, a subagent's id, or `spawn` for a spawn whose classification failed (no id yet). */
  loop: string
  action: RouteLogAction
  /** The classifier's (or the pin's) category; absent when nothing was classified. */
  route?: RouteLabel
  difficulty?: RouteDifficulty
  confidence?: number
  /** The classifier step that answered (jev, haiku, local). */
  backend?: 'jev' | 'haiku' | 'local'
  /** The model before the decision, when known. */
  from?: string
  /** The routed model (the one the route chose, applied or not). */
  to?: string
  /** The main loop's context in tokens, when known (measured or estimated). */
  ctx?: number
  /** Why: `context`, `window`, `confidence`, `same-model`, `resumed`, or a `RerouteReason`. */
  reason?: string
  /** The classifier's task labels, when it gave any. */
  labels?: RouteLabels
  /** `task` mode: this decision committed the session's model. */
  committed?: boolean
}

/** Token use of one model in one session (`router.usage` in the plugin's `$.store`). */
export type UsageRecord = {
  session: string
  model: string
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** `consult` calls answered by this model */
  consults?: number
  /** epoch ms of the last update */
  at: number
}

/** How the band above the prompt shows: the full dashboard, one status-bar line, or nothing. */
export type BandMode = 'expanded' | 'collapsed' | 'hidden'

/** What the chart stacks per time bucket: tokens (in + out), model requests (steps), or USD (spend). */
export type ChartMetric = 'tokens' | 'steps' | 'spend'

/** What the chart's stacks (and legend) are split by. */
export type ChartGroup = 'agent' | 'model'

export type LoopStatus = 'running' | 'done' | 'error'

export type ToolRunStatus = 'running' | 'done' | 'error' | 'denied'

export type ToolRun = {
  id: string
  tool: string
  status: ToolRunStatus
  startedAt: number
  ms?: number
}

export type Loop = {
  /** 'main' for the main loop, else the subagent's agentId */
  id: string
  label: string
  parent?: string
  subagentType?: string
  model?: string
  status: LoopStatus
  turns: number
  steps: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  /** cache-creation tokens (also counted in tokensIn); kept apart for cost */
  cacheWrite: number
  /** USD, summed over the steps whose model has a price; absent while none had one */
  spend?: number
  /** the last ~30 tool runs */
  tools: ToolRun[]
  startedAt: number
  /** last time anything happened on this loop */
  activeAt: number
  /** summed duration of the loop's completed turns */
  ms?: number
}

/** One model request (a `turn.step`), as the chart reads it. */
export type Step = {
  /** 'main' or the subagent's agentId */
  loop: string
  model: string
  /** input + cache-creation tokens */
  in: number
  out: number
  /** USD, when the model has a price */
  cost?: number
  /** `$.clock.now()` ms when it answered */
  at: number
}

/** What one model answered over the session, for the by-model breakdown. */
export type ModelUse = {
  model: string
  steps: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** USD; absent when the model has no price */
  spend?: number
}

/**
 * One router decision as the HUD keeps it: `routerLast`, copied when it is
 * written, so the route trail outlives the next decision.
 */
export type RouteMark = {
  /** 'main' or the subagent's id */
  loop: string
  route: string
  /** copied from the decision: low, medium or high (absent when it had none) */
  difficulty?: string
  model: string
  /** absent when the route set none */
  effort?: string
  confidence: number
  backend: string
  /** `$.clock.now()` ms of the decision; one mark per value */
  at: number
  /** copied from the decision: switched, kept or hint (absent when it had none) */
  action?: string
  /** copied from the decision: the main loop's context in tokens */
  contextTokens?: number
  /** copied from the decision: the model a kept decision would have switched to */
  suggested?: string
  /** copied from the decision: `task` mode, it committed the session's model */
  committed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    nexus: {
      /** router: the latest decision, null before the first one */
      routerLast: RouterDecision | null
      /** router: false after `/route off` */
      routerEnabled: boolean
      /** hud: every loop of the session */
      loops: Loop[]
      bandMode: BandMode
      /** true once `/workflow pane` opened the big pane; otherwise a leftover one is closed */
      isPaneWanted: boolean
      /** the last 60 steps, oldest first */
      steps: Step[]
      /** per model, at most ~20 */
      models: ModelUse[]
      chartMetric: ChartMetric
      chartGroup: ChartGroup
      /** true when the terminal reports no truecolor (COLORTERM): named 16 colors instead of hex */
      isPalette16: boolean
      /** animation frame, bumped every ~300ms while a loop runs */
      tick: number
      /** the router's latest decisions, oldest first, at most 12 */
      routes: RouteMark[]
    }
  }
}
