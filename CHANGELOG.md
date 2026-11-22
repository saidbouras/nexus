# Changelog

All notable changes are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-22

First stable release. Same routing behaviour as 0.7.2.

### Added
- Plugin icon (`.claude-plugin/icon.png`).

### Fixed
- Type check: a classifier step name could include `frontier` (a decision source, not a step), and three tests no longer matched the engine types of Claude Code 2.1.330. `claude plugin validate` now passes with no TypeScript warnings. No behaviour change.

### Documentation
- README rewritten as a short open-source landing page: install in one command (`claude plugin install nexus --marketplace saidbouras/nexus`), quick start, how it works, commands and the main settings.
- New pages: `docs/USAGE.md` (what happens on each prompt, when the classifier is called, choosing a mode, recipes, profiles, `/route` in detail) and `docs/HUD.md` (the dashboard part by part, the route line, the stall alert).
- `docs/INSTALL.md` rewritten around the tested install, configure, verify, update and uninstall commands. `CONFIGURATION.md`, `TROUBLESHOOTING.md`, `PRIVACY.md` and `ARCHITECTURE.md` corrected against the code (settings that apply to `task` mode, the full list of log actions, `consult` controlled by `consultMax` only).
- Added `CODE_OF_CONDUCT.md`, a CI workflow (`claude plugin validate` and `claude plugin test`), an issue template config, `.gitignore`, and the author, homepage and repository fields in `plugin.json`.

## [0.7.2] - 2026-11-11

### Fixed
- `task` mode: every follow-up in a running conversation was logged `vague` and could neither commit a model nor escalate. The classifier reads each prompt alone, so "do that" or "it's still wrong" is vague to it (observed live: 0.95 to 1.0 confidence on clear requests that refer to the conversation). `specified` now matters only at the start of a session, while the context is within `switchMaxContext`; a larger conversation counts as under way, and once a model is committed `specified` blocks nothing (the confidence and difficulty rules decide).

### Changed
- HUD route line and one-line form: readable state words. `kept` and `hint` are blue, `vague` pink, `commit` and `switched` green, `escalated` amber and bold; the arrow, `conf`, the classifier name, the dots and the age use the mid grey instead of the faint one, the model name is white, and the faint grey itself is lighter. Palette gains `info`.

## [0.7.1] - 2026-11-11

### Changed
- HUD route line and one-line form, `task` mode: a vague prompt shows `kept … · vague` instead of a plain `kept` (it looked like a low-confidence keep), and the decision that commits the session's model shows `commit` (`switched · commit`, or `kept … · commit`). The decision's action is now `vague` for such a prompt (`RouteAction` gains `vague`); the decision log is unchanged.

## [0.7.0] - 2026-11-11

### Added
- Main-loop mode `task`, the new default. The session starts on the session model (set Claude Code's `model` to `sonnet` as the medium model), commits to a model on the first clear prompt, keeps it to protect the prompt cache, escalates to an Opus subagent when a later prompt needs a stronger model and switching would drop the cache, and re-routes when the cache is lost anyway (`/clear`, compaction, resume, idle longer than `cacheTtlMinutes`). A clear prompt is one with `specified=clear`, or a traceback or snippet. `adaptive`, `every-turn`, `session-start` and `off` are unchanged.
- Labels: seven choice labels (`specified`, `scope`, `evidence`, `failure`, `localization`, `language`, `project`) asked in the same single classifier request, by Jev, Haiku and Ollama. Jev verified live 2026-11-11: 6 of 6 HTTP 200 in 0.30 to 0.47 s, as fast as two questions. `language` is unreliable and feeds the report only.
- Escalation layer: the `nexus:frontier` subagent type (Opus) and the `consult` tool (`mcp__nexus__consult`), an advisor-like second opinion from a frontier model through your own provider that works on gateways without Anthropic's server-side advisor tool. It is NEXUS's own emulation, sees only the brief the model writes, and is capped by `consultMax`.
- `/route report [n]`: per model share of turns and tokens, estimated cost, saving against an all-Opus baseline, and counts of switched, escalated, consulted and rerouted.
- `/route log export [path]`: the log and the usage records as JSONL, written to the working directory by default. No prompt text.
- Settings `labels` (`true`), `escalation` (`true`), `consultMax` (`5`) and `cacheTtlMinutes` (`5`). New log actions `vague`, `escalated`, `consulted` and `rerouted`.
- HUD route line: `escalated → <model>` when task mode kept the model and asked for escalation; a `nexus:frontier` subagent's decision shows the backend `frontier`.

### Changed
- Default `routeMainLoop` is `task` (was `adaptive`). To get the old behaviour, set `routeMainLoop` to `adaptive`.

### Limits
- Whether the main model follows the escalation directive is model behaviour; check it with `/route log` (`escalated`, then a `nexus:frontier` spawn).
- The report's all-Opus baseline is an estimate: another model would have used different tokens.
- The commit rule, `nexus:frontier` and `consult` are tested with the engine's test harness only, not yet in a live session.

## [0.6.0] - 2026-11-06

### Added
- Decision log: every routing outcome, from the main loop and from subagents, is recorded in the plugin store, so it persists across sessions. The newest 200 are kept. Each entry has the time, session id, loop, action (`switched`, `kept`, `hint`, `low-confidence`, `continuation`, `classifier-failed`, `pinned`, `unknown-context`), category and difficulty, confidence, backend, the model before and the routed model, the context tokens and the reason. No prompt text is ever stored.
- Setting `decisionLog` (default `true`; `false` records nothing).
- Command `/route log [n]` prints the newest `n` entries (default 20, at most 200), newest first, one line each. `/route log clear` empties the log.

### Fixed
- Unknown context after `/reload-plugins`, a restart or a resumed conversation: the router kept the context size in memory only, so the next prompt could switch the main model with no size check (observed: a 173k-token conversation switched to Haiku, whose window is 200k). A switch is now never decided on an unknown context unless the conversation is fresh. The router measures the request before applying the switch (an estimate when no token count is available), or keeps the current model when it cannot, logged as `unknown-context`.
- `session-start` mode after a reload, restart or resume: the first decision is applied only if the conversation is fresh; otherwise the model is kept for the session (logged `kept`, reason `resumed`).
- `/resume` now resets the router's context, model and session state, as `/clear` does.
- Limit: the live sources of the context size after a reload (the session's usage figure, else the transcript length / 4) are verified in tests with the engine's test harness only, not yet in a live session.

## [0.5.0] - 2026-11-01

### Added
- HUD stall alert: every 60 seconds the HUD checks running subagents. One with no event for `stallMinutes` gets one message to the main session, from NEXUS, naming the subagent, its id, the silence and any tool still running. It asks the main session to request a status, stop the subagent if stuck, and tell the user. The HUD also shows a toast. One message per silence; the main session is never reported. A long-running tool counts as silence.
- Setting `stallMinutes` (default `30`, `0` turns it off).
- Limit: delivery of the message into an idle main session (whether it wakes to answer) is verified in tests with the engine's test harness only, not yet in a live session.

## [0.4.3] - 2026-10-31

### Changed
- HUD band height: the band takes a quarter of the terminal's rows (up to the full height the host gives), never fewer than 10. It was capped at 10 rows, so a tall terminal showed no more of the table, chart or route line.

## [0.4.2] - 2026-10-31

### Changed
- HUD `TOOLS` tile: lists the tools in use instead of two counts. While tools run it shows their names across every loop, grouped and newest first (`Bash ×2 · search_text`, MCP names without their `mcp__<server>__` prefix, `+N` past the width); when none runs, the latest ones (`last Read · Bash`, muted). The label carries the total (`TOOLS · 387 runs`). A tile too narrow for a name falls back to the counts (`2 / 387`).

### Fixed
- HUD route line: with a subagent's transcript in view, the band and the pane kept showing the main session's latest decision. They now show the decision and trail of the agent in view, and no route line for an agent that was never routed. The main conversation in view is unchanged.

## [0.4.1] - 2026-10-31

### Fixed
- HUD agent table: an agent heard only at the end of its turn (a forked skill raises no `agent.spawn`, or its start was held back) showed `?` as its model and its id as its name. It now takes the model from the turn's usage and the name, type and parent from the engine's agent list.

## [0.4.0] - 2026-10-27

### Added
- The classifier answers a category and a difficulty (`low`, `medium`, `high`) in one request, and the model and effort follow both through a default matrix (category by difficulty). The matrix is the plugin's choice and can be overridden. Count of classifier calls is unchanged.
- `routes` cell keys such as `coding.high` override one cell and win over a category key (`coding`), which sets all three difficulties. Existing overrides keep working.
- `/route pin <category> [low|medium|high]`: the difficulty is optional and defaults to `medium`.
- The HUD route line shows the category and difficulty, for example `coding/high → ▌ opus 5.5 high`.
- A route confidence below `minConfidence` still gives `general`; a difficulty confidence below it, or a missing difficulty, gives `medium`. The decision's confidence is the lower of the two.
- The two-question request (`route` and `difficulty`, both `choice` questions in one SystemOne request) was verified live on a Databricks gateway: 4 of 4 requests returned HTTP 200 in about 0.4 to 0.8 s. The direct TypeSafe API route remains unverified.

### Changed
- A `coding` prompt no longer always goes to Opus: routine coding goes to Sonnet and hard coding to Opus. To restore the old behavior (Opus, medium effort, for every `coding` prompt), set `routes` to `{"coding":{"model":"claude-opus-5-5","effort":"medium"}}`, or `system.ai.claude-opus-5-5[1m]` on the `databricks` profile.

## [0.3.0] - 2026-10-27

### Added
- Zero-cost continuation skip: in the main loop, a prompt that is only an acknowledgement ("ok", "yes do it", "continue", "oui", "vas-y"; whole-text match, 40 characters at most) skips the classifier and the turn stays on the current model. No hint is added and the HUD route line is unchanged.
- Settings `continuationSkip` (true) and `continuationPhrases` (empty = built-in English and French list).
- `/route status` shows classifier counters, for example `classifier: 38 calls · 12 skipped (continuation)`; they are kept in memory and reset by `/clear`.

### Fixed
- HUD route line: a main-loop decision kept before the session's first request showed `session model` instead of a model; it now names the model once that request goes out (the same trail mark is updated, not duplicated).

## [0.2.0] - 2026-10-23

### Added
- `routeMainLoop=adaptive` (new default): every main-loop prompt is classified; the model switches only when confidence, context size and the target's context window allow it, otherwise it is kept (with its prompt cache) and a hidden one-line hint suggests delegating to a subagent.
- Settings `switchConfidence` (0.75), `switchMaxContext` (50000), `delegationHint` (true) and `contextWindows`.
- Context-window guard, also in `every-turn` (defaults 1,000,000 tokens for `[1m]` ids and 200,000 otherwise; assumptions to check).
- HUD route trail shows `switched`, `kept` or `hint` with the context size.
- Orchestrator skill: "When the router suggests delegation".

### Changed
- Default `routeMainLoop` is `adaptive` instead of `session-start`. `session-start` and `off` behave as in 0.1.0.
- Privacy: the classifier now sees every main prompt in `adaptive` and `every-turn`. Use `session-start` or `off` for fewer or no calls.
- One classifier call per prompt (about 0.5 s observed on a Databricks gateway).

## [0.1.0] - 2026-10-20

### Added
- One plugin, one hooks module (`hooks/register.tsx`), three modules: `router`, `hud`, `orchestrator`.
- `router`: classifier chain (Jev, Haiku through `$.model.complete`, local Ollama); routes `fast`, `general`, `reasoning`, `coding` with per-category merge of a partial `routes` map; `/route status | on | off | pin <label> | pin off`; consent dialog before fallback and `fallbackPolicy` (`ask`, `never`, `auto`); `routeMainLoop` (`session-start`, `every-turn`, `off`); `minConfidence`, `timeoutMs`.
- Jev via a Databricks gateway (verified live) or directly via the TypeSafe API (unverified, no key tested); the Haiku step is tested only with mocks.
- `anthropic` and `databricks` profiles with full model ids as default routes (update them when newer models ship).
- `hud`: dashboard above the prompt with KPIs, usage chart, agent table, tools, cost estimate (`prices`, `upliftPct`) and route trail; `/workflow` and `/nexus` with `expand`, `collapse`, `hide`, `pane`.
- `orchestrator`: skill plus an optional system-prompt reminder (`orchestratorReminder`).
- Documentation and presets.
