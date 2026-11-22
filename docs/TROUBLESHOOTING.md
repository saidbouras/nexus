# Troubleshooting

Format: symptom, cause, fix. Start with `/route status` and `/plugin`.

## No ROUTE line appears in the HUD

- Cause: the router is off (`/route off`), no decision has been made yet, the HUD is collapsed or hidden, or the plugin is not loaded.
- Fix: run `/route status` (it shows on/off and the last decision). Run `/route on`. Run `/workflow expand`. Run `/plugin` and confirm `nexus` is enabled, then `/reload-plugins`. Under `routeMainLoop=adaptive` or `every-turn` every prompt is classified; under `session-start` the first decision is kept and, if none was made, later turns retry.

## The model never switches in a long session

- Cause: expected in `adaptive` and `task` modes. Once the main-loop context exceeds `switchMaxContext` (50,000 tokens by default), the model is kept so the prompt cache keeps serving. Low confidence (below `switchConfidence`) or a target window smaller than the context also keep it. The HUD route trail shows `kept` and the context size.
- Fix: raise `switchMaxContext` (a switch then re-reads the context uncached), lower `switchConfidence`, or use `routeMainLoop=every-turn`. Check `contextWindows` if you think the window guard is wrong.

## The main session always stays on Opus (or one model)

- Cause in `task` mode (the default): the session starts on the model Claude Code is set to. It commits to a model only on the first clear prompt (a vague prompt, an acknowledgement or a follow-up commits nothing), then keeps that model to protect the prompt cache. If `model` is `opus`, the session starts on Opus, and a lighter routed model is only suggested as a subagent hint. A heavier need later is handled by escalation to an Opus subagent, not by a switch.
- Fix in `task` mode: set Claude Code's `model` to `sonnet` so the session starts on the medium model, and open the session with a clear, specific prompt. Check `/route log` for `vague`, `escalated` and `rerouted`.
- Cause in `adaptive` mode: usually only the first prompt can switch. A session's context passes `switchMaxContext` (50,000 tokens by default) after the first turn, since even a fresh session already sends about 30-50k tokens of system prompt and tools. Later decisions are kept and turned into a hidden delegation hint, so the prompt cache keeps serving. A Haiku target is also blocked by the 200k window guard once the context exceeds it.
- Check: run `/route log`. Entries show `kept` with the reason and the context size, and `unknown-context` when the size could not be measured.
- Fix: set `model` to `sonnet`, raise `switchMaxContext`, use `routeMainLoop=every-turn` (it accepts cache re-reads on each switch), or pin a route with `/route pin`.

## The main session didn't escalate

- Cause: NEXUS only attaches a directive; the main model decides whether to delegate to `nexus:frontier` or call `consult`. Escalation also needs `routeMainLoop=task`, `escalation` on, a session that has already committed to a model, and a routed model heavier than the committed one with confidence at least `switchConfidence` and a context above `switchMaxContext` (otherwise it switches, or is kept as `low-confidence`).
- Check: run `/route log`. An `escalated` entry means the directive was sent; a later `nexus:frontier` spawn means the model followed it. No `escalated` entry means the conditions were not met (see `kept`, `low-confidence`, `vague`, `switched`).
- Fix: set `escalation` to `true` and `routeMainLoop` to `task`; ask for the `nexus:frontier` subagent explicitly if the model ignores the directive.

## `consult` is missing

- Cause: `consultMax` is `0`, so the tool is not registered; or the tool is hidden or its permission was denied in the session; or the cap was reached and it answered a refusal.
- Fix: set `consultMax` above 0 (default 5), then `/reload-plugins`. The tool name is `mcp__nexus__consult`. Calls show as `consulted` in `/route log`.

## A short prompt didn't change the model

- Cause: expected. A prompt that is only an acknowledgement ("ok", "yes do it", "continue", "oui", "vas-y") skips the classifier and the turn stays on the current model. `/route status` counts these as `skipped (continuation)`. A longer prompt such as "ok now redesign the auth flow" is classified as usual.
- Fix: set `continuationSkip` to `false` to classify every prompt, or edit `continuationPhrases` to change the list. See [CONFIGURATION.md](CONFIGURATION.md#continuation-prompts).

## A hint appears but Claude does not delegate

- Cause: the hint is a suggestion added to the prompt. The orchestrator skill ("When the router suggests delegation") decides: quick questions are answered inline, self-contained work is delegated.
- Fix: ask for a subagent explicitly, or set `delegationHint` to `false` to stop the notes.

## `/route status` shows the wrong backend

- Cause: settings were changed but not reloaded; `chain` order differs from what you expect; a step is unconfigured and was skipped silently; `profile` is still `anthropic`.
- Fix: re-open `/plugin configure nexus@nexus`, check `profile`, `chain`, `jevUrl`, then `/reload-plugins`. A step with no URL, key or model is skipped by design.

## The fallback dialog appears every turn

- Cause: a configured step fails on every request (wrong `jevUrl`, expired login, Ollama not running) and `fallbackPolicy` is `ask`.
- Fix: fix the failing step, or choose "for the session" in the dialog, or remove the step from `chain`, or set `fallbackPolicy` to `never` or `auto`.

## First Ollama call times out

- Cause: the model is cold and Ollama is loading it into memory; large models can take longer than the step timeout.
- The default local timeout is 4000 ms, and a cold load of a large model can take longer; the turn then goes unrouted.
- Fix: pre-warm with `ollama run <model> ""`, raise `timeoutMs`, or pick a smaller `localModel`. Subsequent calls are fast while the model stays loaded.

## HUD missing entirely

- Cause: plugin not installed or disabled, terminal too narrow, band hidden, or Claude Code older than required.
- Fix: `claude --version` (2.1.275+), `/plugin`, `/workflow expand`. If nothing helps, `/workflow pane` opens the full dashboard in a pane.

## 401 or 403 from the gateway

- Cause: expired Databricks login, wrong `databricksProfile`, or your user lacks query permission on the Jev endpoint.
- Fix: `databricks auth login --host https://<workspace>.cloud.databricks.com --profile <profile>`; check `databricks auth token --profile <profile>` prints a token; ask your workspace admin for query access to the Jev endpoint. For the direct API route, check that the variable named by `jevApiKeyEnv` is set in the shell that launched Claude Code.

## 404 or connection error from the gateway

- Cause: wrong `jevUrl` or `jevModel`, or a network problem. A 404 whose body says `ENDPOINT_NOT_FOUND` is covered in the next entry.
- Fix: the URL must end in `/ai-gateway/typesafe/v1/systemone` under your workspace host; leave `jevModel` empty unless your workspace names it differently.
- If a gateway rejects the multi-question body, the parser also accepts a single question with combined labels (`coding/high`); see `hooks/router/backends.ts`.

## Jev returns 404 or `ENDPOINT_NOT_FOUND`

- Cause: the Jev model is not deployed in your workspace's region, or the TypeSafe preview is not enabled for the workspace. In some regions Jev also needs cross-Geo processing to be turned on.
- Fix: ask your workspace admin to enable the preview and cross-Geo processing, and to confirm the Jev endpoint exists in your region. Until then, remove `jev` from `chain` (for example `haiku,local`) or set `fallbackPolicy` to `auto`.

## `nexus: its prompt.compose hook was skipped ... cc-plugin-sec-default runs first`

- Cause: a managed security plugin (`cc-plugin-sec-default`) is placed first in the hook order and skips NEXUS's `prompt.compose` hook. That hook only adds the orchestrator reminder to the system prompt, so the reminder is missing. Routing, the delegation hint and the escalation directive use other hooks and still work. The hook order is set by your organisation's managed settings, not by NEXUS.
- Fix: nothing is needed for routing. To get the reminder back, ask whoever manages the Claude Code settings whether NEXUS can run before the security plugin, or call the `orchestrator` skill yourself. To silence the message, set `orchestratorReminder` to `false`.

## Stale plugin after update or reload

- Cause: a plugin installed from GitHub runs the copy made at install time; edits reach a session only as a new version.
- Fix: `claude plugin update nexus@nexus` then `/reload-plugins`, or restart Claude Code. A plugin installed from a local folder is re-read from the folder on `/reload-plugins`.

## Routes use model names my account cannot call

- Cause: the default `routes` name specific model ids (`claude-*-5-5`, or `system.ai.claude-*-5-5` for `databricks`), which can be retired or unavailable to you. A bad name fails the request.
- Fix: set `routes` to ids you can call (a partial map merges per category or cell); see [CONFIGURATION.md](CONFIGURATION.md).

## `routes` seems ignored

- Cause: invalid JSON is ignored silently and the profile table is used; a bad single entry keeps that cell's default.
- Fix: put valid JSON on one line and check `/route status`.

## Costs look wrong

- Cause: the HUD estimate uses a price table and optional uplift; models with no price show nothing.
- Fix: set `prices` and `upliftPct`. The figure is an estimate, not a bill.

## A subagent looks stuck but no alert came

- Cause: `stallMinutes` is `0`, the subagent has not been silent for `stallMinutes` yet (default 30 minutes), or it already finished. Finished subagents do not alert. A subagent is also reported only once per silence. The check runs every minute.
- Fix: check `stallMinutes` is not `0`, then wait for the silence to reach the limit.

## The main session got an alert but did nothing

- Cause: the alert is a message the model reads and answers. If the session was idle, it may not have taken the message. See [Known limitations](CONFIGURATION.md#known-limitations).
- Fix: check the session took the message. If not, ask the subagent for a status yourself.
