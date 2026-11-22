// escalate: the `nexus:frontier` subagent type and the `consult` tool.
//
// At session.start (called from hooks/register.tsx) `escalateSessionStart`
// registers, as the config allows, the `frontier` agent type (the engine names
// it `nexus:frontier`) on the frontier model with effort high, and the
// `consult` tool (`mcp__nexus__consult`), not deferred. `registerEscalate`
// adds the tool.call hook that answers the tool: it asks the frontier model
// through `$.model.complete` with the caller's brief alone (nothing of the
// transcript is added) and returns the advice.
//
// The per-session cap is kept in memory, in a module-level variable,
// keyed by `$.session.id()`: a new session id (a /clear) starts a fresh count,
// a restarted process too. No `$.state` key is used, so the contract in
// types/index.d.ts is unchanged.
//
// Each call is logged `consulted` (log.ts) with the advisor model, never the
// brief, and its token use goes to `router.usage` (report.ts). Nothing here
// throws: a failed registration leaves the session without the agent or the
// tool, a failed call answers the model an error result.

import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import { appendLog } from '../router/log'
import { recordUsage } from '../router/report'
import type { RouteLogEntry } from '../../types'
import {
  ADVISOR_SYSTEM,
  CONSULT_NAME,
  CONSULT_SCHEMA,
  CONSULT_TOOL,
  FRONTIER_DESCRIPTION,
  FRONTIER_NAME,
  FRONTIER_PROMPT,
  advisorPrompt,
  briefOf,
  capRefusal,
  consultDescription,
} from './prompts'

export type EscalateConfig = {
  /** register nexus:frontier (and let the router send the escalation directive) */
  escalation: boolean
  /** consult calls per session; 0 = the tool is not registered */
  consultMax: number
  /** the model both run on (the profile's reasoning.high model) */
  frontierModel: string
  /** the plugin's `decisionLog` option: false = consult calls are not logged; default true */
  decisionLog?: boolean
}

/** How long one consult may take before it resolves `aborted`. */
export const CONSULT_TIMEOUT_MS = 120_000
/** The advisor reply's token cap (thinking at effort high counts against it). */
export const CONSULT_MAX_TOKENS = 8_000

/** session.start: registers the agent type and the tool as the config allows; never throws. */
export async function escalateSessionStart($: EngineInterface, cfg: EscalateConfig): Promise<void> {
  const hasTool = cfg.consultMax > 0
  if (hasTool) {
    try {
      await $.tool.register({
        name: CONSULT_NAME,
        description: consultDescription(cfg.consultMax, cfg.escalation),
        inputSchema: CONSULT_SCHEMA,
        isDeferred: false,
      })
    } catch {
      // rejected (unbound session, an engine without tools): no consult tool this session
    }
  }
  if (cfg.escalation) {
    try {
      await $.agent.register({
        name: FRONTIER_NAME,
        description: FRONTIER_DESCRIPTION,
        prompt: FRONTIER_PROMPT,
        model: cfg.frontierModel,
        effort: 'high',
        // every tool the parent has, less the advisor: it already runs on the frontier model
        ...(hasTool ? { disallowedTools: [CONSULT_TOOL] } : {}),
      })
    } catch {
      // rejected (unbound session, a refused spec, a hook's deny): no frontier agent this session
    }
  }
}

/** A log entry less its time, which `record` stamps. */
type RouteLogEntryFields = Omit<RouteLogEntry, 'at'>

/** The consult count of the current session, in memory (module state, not `$.state`). */
const counter: { session: string | undefined; used: number } = { session: undefined, used: 0 }

async function sessionIdOf($: EngineInterface): Promise<string> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
}

/** One consult's outcome for the log: undefined when answered, else why not. */
function reasonOf(r: ModelCompleteResult | undefined): string | undefined {
  if (r === undefined) return 'refused'
  if (r.isAnswered) return undefined
  return r.reason
}

/** The error text the model reads for a consult that got no advice; never the brief, never a body. */
function failureText(r: ModelCompleteResult | undefined): string {
  if (r === undefined) return 'consult failed: the model request was refused. Go on without the advice.'
  if (r.isAnswered) return ''
  if (r.reason === 'api-error') return `consult failed: the advisor model answered an error (${r.status ?? 'no response'}, ${r.error}). Go on without the advice.`
  if (r.reason === 'aborted') return `consult failed: no answer within ${CONSULT_TIMEOUT_MS / 1000}s. Go on without the advice.`
  return 'consult failed: the advisor gave an empty reply. Go on without the advice.'
}

/** Logs one consult (unless decisionLog is off) and adds its token use to `router.usage`; never throws. */
async function record($: EngineInterface, cfg: EscalateConfig, entry: RouteLogEntryFields, r: ModelCompleteResult | undefined): Promise<void> {
  const tasks: Promise<unknown>[] = []
  if (cfg.decisionLog !== false) {
    // appendLog queues its own writes (log.ts), so none is lost to another's
    tasks.push(writeLog($, entry))
  }
  const u = r?.usage
  const tokens = u ? u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
  if (r?.isAnswered || tokens > 0) {
    tasks.push(
      recordUsage($, {
        session: entry.session,
        model: cfg.frontierModel,
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
        ...(r?.isAnswered ? { consults: 1 } : {}),
      }),
    )
  }
  // best-effort: a failed write never changes the tool's answer
  await Promise.allSettled(tasks)
}

async function writeLog($: EngineInterface, entry: RouteLogEntryFields): Promise<void> {
  const full: RouteLogEntry = { at: await $.clock.now(), ...entry }
  await appendLog($, full)
}

/** Answers one consult call: the frontier model's advice, a refusal past the cap, or an error result. */
async function consult($: EngineInterface, cfg: EscalateConfig, args: Record<string, unknown>, agentId: unknown): Promise<{ result: string } | { deny: string }> {
  const session = await sessionIdOf($)
  const loop = typeof agentId === 'string' && agentId !== '' ? agentId : 'main'
  const base = { session, loop, action: 'consulted' as const, to: cfg.frontierModel }

  if (cfg.consultMax <= 0) return { deny: 'consult is turned off for this session.' }
  const brief = briefOf(args)
  if (typeof brief === 'string') return { deny: brief }

  if (counter.session !== session) {
    counter.session = session
    counter.used = 0
  }
  if (counter.used >= cfg.consultMax) {
    await record($, cfg, { ...base, reason: 'cap' }, undefined)
    return { result: capRefusal(cfg.consultMax, cfg.escalation) }
  }
  // reserved before the call, so parallel consults cannot pass the cap
  counter.used++
  const n = counter.used

  let r: ModelCompleteResult | undefined
  try {
    r = await $.model.complete({
      model: cfg.frontierModel,
      system: ADVISOR_SYSTEM,
      prompt: advisorPrompt(brief),
      effort: 'high',
      maxTokens: CONSULT_MAX_TOKENS,
      timeoutMs: CONSULT_TIMEOUT_MS,
    })
  } catch {
    r = undefined
  }
  // a call that cost nothing (refused, an API error) gives its slot back
  if (counter.session === session && (r === undefined || (!r.isAnswered && r.reason === 'api-error'))) counter.used = Math.max(0, counter.used - 1)

  const reason = reasonOf(r)
  await record($, cfg, reason === undefined ? base : { ...base, reason }, r)
  if (r === undefined || !r.isAnswered) return { deny: failureText(r) }
  return { result: `${r.text.trim()}\n\n(consult ${n} of ${cfg.consultMax} this session)` }
}

/** Adds the escalate module's own hooks (the consult tool's tool.call). */
export const registerEscalate = (on: Parameters<Register>[0], getCfg: () => EscalateConfig): void => {
  on('tool.call', { tool: CONSULT_TOOL }, async ($, e) => consult($, getCfg(), e as unknown as Record<string, unknown>, e.agentId)).catch(() => ({
    deny: 'consult failed. Go on without the advice.',
  }))
}
