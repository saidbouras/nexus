# Architecture

NEXUS is one Claude Code plugin with one hooks module, `hooks/register.tsx` (listed in `hooks/hooks.json`). It composes three modules: router, hud and orchestrator.

Order of work: the router decides first, then the request runs, then the HUD observes. A plugin has one hooks module, and an event is hooked once without a matcher, so `hooks/register.tsx` holds the one hook for each shared event (`session.start`, `turn.start`, `turn.step`, `agent.spawn`) and runs the router's, the HUD's and the escalation layer's parts in turn. Each part is isolated: an error in one leaves the request as the engine had it and does not skip the others. Events used by one module only (`prompt.submit` for the router, `prompt.compose` for the orchestrator reminder) stay in that module.

| Module | Files | Role |
|---|---|---|
| `router` | `hooks/router/` | Classifies requests and sets the model and effort. Writes `routerLast`, `routerEnabled`, and the decision log. |
| `hud` | `hooks/hud/` | Tracks loops, steps and models; renders the band above the prompt. Reads `routerLast`. |
| `orchestrator` | `hooks/orchestrator/`, `skills/orchestrator/` | The skill plus an optional system-prompt reminder. Keeps no state. |

## Shared state

Defined in `types/index.d.ts` under `PluginState.nexus`:

- Router: `routerLast` (latest `RouterDecision`: loop, route, difficulty, model, effort, confidence, backend, at, and for the main loop action, contextTokens, suggested), `routerEnabled`, `router.log` in the plugin store (the decision log: the 200 newest entries, persisted across sessions).
- HUD: `loops`, `steps` (last 60), `models`, `routes` (last 12 `RouteMark`s, copied from `routerLast` so the trail outlives the next decision), `bandMode`, `chartMetric`, `chartGroup`, `isPaneWanted`, `isPalette16`, `tick`.

The HUD copies each new `routerLast` into `routes`; that is the only coupling between the two modules.

## Classifier chain

```
 request (main-loop prompt, or subagent spawn)
        |
        v
   +---------+  ok   +---------------------------+
   |  Jev    |-----> | label + difficulty + conf |
   +---------+       +---------------------------+
     | fail / unconfigured (skipped silently)
     v                                 ^
   +---------+  ok                     |
   |  Haiku  |-------------------------+
   +---------+
     | fail / unconfigured
     v                                 ^
   +---------+  ok                     |
   |  Local  |-------------------------+
   | (Ollama)|
   +---------+
     | fail
     v
 stay on the session model
```

A configured step that fails triggers the `fallbackPolicy` check (ask, never, auto) before the next step is tried. One request returns a category, a difficulty and, with `labels` on, seven labels (a missing or invalid label is left out). The category and difficulty are mapped through the matrix (`routes` overrides) to a model and effort. Below `minConfidence` the category becomes `general` and the difficulty `medium`; the decision's confidence is the lower of the two. See [Configuration](CONFIGURATION.md#how-the-model-is-chosen).

Subagents are classified at each spawn, and the model is set on `agent.spawn`. The main loop depends on `routeMainLoop`; the rules for each mode are in [Main-loop routing and the prompt cache](CONFIGURATION.md#main-loop-routing-and-the-prompt-cache). What the code does around them:

- The router's `prompt.submit` hook classifies the user's own prompts only (typed at the terminal, or from Remote Control). Slash commands, hidden meta prompts, other origins, prompts submitted while a turn runs and, with `continuationSkip` on, acknowledgement-only prompts are skipped; a skipped turn keeps the current model. The result is kept as a pending decision. The delegation hint or escalation directive, if any, is added to that prompt's context after the cached prefix, so the cache is kept.
- At the next `turn.step` the router applies the pending decision and rewrites the request's model. For `adaptive` and `task`, a switch needs confidence >= `switchConfidence`, a context <= `switchMaxContext` and a target window that fits the context.
- After each step the router records the main loop's context size (input + cache read + cache write of the last request) from the usage of the result; the next decision reads it.
- A switch is never decided on an unknown context unless the conversation is fresh (for example after `/reload-plugins`, a restart or a resume). The router measures the request first (an estimate when no token count is available), or keeps the current model and records `unknown-context`.
- In `task` mode the router also remembers one committed model per session and drops it when the cache is lost (`session.compact`, a `/clear`, a resume, or no main-loop request for more than `cacheTtlMinutes`).
- Every outcome (main loop and subagents) is appended to the decision log in the plugin store (key `router.log`; setting `decisionLog`, default on), newest 200 kept; `/route log` reads it. Entries hold no prompt text. The action is one of `switched`, `kept`, `hint`, `low-confidence`, `continuation`, `classifier-failed`, `pinned`, `unknown-context`, `vague`, `escalated`, `consulted` or `rerouted`.

Each decision carries an `action` (`switched`, `kept`, `hint`, and in `task` mode `escalated` or `vague`), the `contextTokens` and, for a kept decision, the `suggested` model; the HUD copies them into the route trail.

## Escalation layer

`hooks/escalate/` holds two pieces. At `session.start`, with `escalation` on, `$.agent.register` adds the `nexus:frontier` agent type on the profile's `reasoning.high` model (Opus by default), with its own system prompt. At spawn the router does not classify it: it keeps that model and effort `high` (logged `escalated`). With `consultMax` above 0, whatever `escalation` says, `$.tool.register` adds the `consult` tool (`mcp__nexus__consult`, not deferred); it calls `$.model.complete` on the same Opus model with effort `high` with only the brief the caller wrote, and is capped at `consultMax` calls per session (logged `consulted`). This is NEXUS's own emulation, not Anthropic's advisor tool. NEXUS never spawns a subagent: the main model decides whether to follow the directive.

## Usage store, report and export

From every `turn.complete` with usage (main loop and subagents) and every `consult` call, the router adds to `router.usage` in the plugin store the sums of input, output, cache-read and cache-write tokens and turns, per session and model. The newest 50 sessions are kept, and it is written only when `decisionLog` is on. `hooks/router/report.ts` builds `/route report [n]` from it (cost with the HUD price table, the same tokens priced at Opus as an estimated baseline); `log.ts` writes `/route log export [path]` as JSONL. Neither holds prompt text.

## Stall watch

The HUD runs a `$.clock.every` timer, started at `session.start`. Every 60 seconds it reads the loop list and finds running subagents with no event for `stallMinutes`. For each one it sends a message with `$.session.send` to the session's own id (`$.session.id()`) and shows a toast. It remembers which subagents it reported and clears that when the subagent speaks again. The main session is never reported.

## Fail-open design

- Unconfigured steps are skipped without noise.
- Any error, timeout, malformed response or unknown label leaves the request on the session model.
- A declined or unanswerable fallback dialog (dismissed, headless) leaves that request unchanged.
- `/route off` and `routeMainLoop=off` disable routing without disabling the HUD.
- Credentials are fetched on demand and never logged.
