import type { Register } from 'claude-code'

import { createHud, hudSessionStart, hudSpawn, hudStep, hudTurnStart, register as registerHud } from './hud/register'
import { escalateSessionStart, registerEscalate } from './escalate/register'
import { register as registerOrchestrator } from './orchestrator/register'
import { createRouter, escalateConfigOf, observeUsage, registerRouter, routerObserve, routerSessionStart, routerSpawn, routerSpawned, routerStep, routerTurnStart } from './router/register'

// A plugin has one hooks module, and an event is hooked once without a
// matcher. The router and the HUD both need session.start, turn.start,
// turn.step and agent.spawn, so this module holds the one hook of each and
// runs both parts in it; every other event stays in its own module.
//
// Order, as when the router's hook sat above the HUD's: the router's part
// runs first and may rewrite the request, `next` is called once with what it
// settled on, then the HUD observes the request as sent (the routed model)
// and what the engine answered. Each part is isolated: a router failure sends
// the request as the engine had it, a HUD failure changes nothing, and
// neither skips the other's work.
export const register: Register = (on, options) => {
  const router = createRouter(options)
  const hud = createHud(options)
  registerRouter(on, router)
  registerHud(on, options)
  registerOrchestrator(on, options)
  registerEscalate(on, () => escalateConfigOf(router))

  on('session.start', async ($, e, next) => {
    try {
      await routerSessionStart($)
    } catch {
      // fail open: /route is missing this session, the rest goes on
    }
    try {
      await hudSessionStart($, hud)
    } catch {
      // ignore: the band still draws from what the session records
    }
    try {
      await escalateSessionStart($, escalateConfigOf(router))
    } catch {
      // fail open: no nexus:frontier agent or consult tool this session
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      await routerTurnStart($, router, e)
    } catch {
      // fail open: the turn goes unrouted
    }
    try {
      await hudTurnStart($, e)
    } catch {
      // ignore
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    let request = e
    try {
      request = await routerStep($, router, e)
    } catch {
      request = e
    }
    const result = yield* next(request)
    try {
      // the main loop's context size and model, for the next adaptive decision
      routerObserve(router, request, result)
    } catch {
      // fail open: the next decision sees the previous size
    }
    try {
      // token use per session and model, for /route report
      observeUsage($, router, request, result)
    } catch {
      // ignore: the report misses this request
    }
    try {
      await hudStep($, hud, request, result)
    } catch {
      // ignore: the response passes as the engine gave it
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    let decision: Awaited<ReturnType<typeof routerSpawn>>
    try {
      decision = await routerSpawn($, router, e)
    } catch {
      decision = undefined
    }
    const request = decision ? { ...e, model: decision.model } : e
    const started = await next(request)
    // The HUD records the loop first, then the router publishes its decision
    // (as when the HUD's hook sat beneath the router's).
    try {
      await hudSpawn($, request, started)
    } catch {
      // ignore
    }
    try {
      if (decision) await routerSpawned($, router, decision, started)
    } catch {
      // fail open: the subagent runs on the model it started with
    }
    return started
  }).catch(($, e, next) => next(e))
}
