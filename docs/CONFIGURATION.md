# Configuration

The settings are exactly the `userConfig` keys of `.claude-plugin/plugin.json`. Edit them with:

```
/plugin configure nexus@nexus
```

Changes apply after `/reload-plugins` or a restart. An empty value means "use the default described". Do not put secrets in settings; use environment variables.

## Router

| Setting | Type, options | Default | Meaning |
|---|---|---|---|
| `profile` | string: `anthropic`, `databricks` | `anthropic` | `anthropic` routes to full Claude model ids; `databricks` routes to the `system.ai.claude-*` gateway models. It picks the default matrix when `routes` is empty, and the Haiku classifier model when `haikuModel` is empty. It does not decide how Jev is reached (see "When Jev counts as configured"). |
| `chain` | string | `jev,haiku,local` | Comma list of classifier steps, tried in order. A step that is not configured is skipped silently. Empty = `jev,haiku,local`. Unknown names and duplicates are dropped; if nothing valid remains, nothing is routed. |
| `fallbackPolicy` | string: `ask`, `never`, `auto` | `ask` | What happens when a configured step fails. See "Fallback policy". |
| `routeMainLoop` | string: `task`, `adaptive`, `every-turn`, `session-start`, `off` | `task` | See "Main-loop routing and the prompt cache". Subagents are classified at each spawn in every mode. |
| `switchConfidence` | number | `0.75` | `adaptive` and `task`: the minimum classifier confidence to switch the main-loop model. Below it the model is kept. |
| `switchMaxContext` | number (tokens) | `50000` | `adaptive` and `task`: the largest main-loop context (input + cache read + cache write of the last request) at which the model may switch. A switch re-reads that context uncached on the new model. In `task` mode it is lifted for the first clear prompt after an idle gap or a compaction, when the cache is cold anyway. |
| `delegationHint` | boolean | `true` | `adaptive` and `task`: when the model is kept although the router chose another (in `task`, a lighter one), attach a one-line hidden note to that prompt suggesting a subagent for self-contained work. The router puts that subagent on the routed model. In `every-turn` the note appears only when the window guard blocks a switch. Off attaches nothing. |
| `labels` | boolean | `true` | Ask the seven label questions (`specified`, `scope`, `evidence`, `failure`, `localization`, `language`, `project`) in the same single classifier request. `task` mode reads `specified` and `evidence`; the decision log and the report keep all of them. `false` sends only category and difficulty; every classified prompt then counts as clear. |
| `escalation` | boolean | `true` | `task`: register the `nexus:frontier` subagent type (on the profile's `reasoning.high` model, Opus by default) and attach the escalation directive when a heavier model is needed but switching would drop the cache. `false`: no frontier agent, and the model is kept with no note. It does not affect `consult`. |
| `consultMax` | number | `5` | Calls of the `consult` tool (`mcp__nexus__consult`) per session. Past the cap it answers a short refusal. `0` does not register the tool. The tool does not depend on `escalation`. |
| `cacheTtlMinutes` | number (minutes) | `5` | `task`: no main-loop request for longer than this and the prompt cache counts as cold, so the commitment is dropped (`rerouted`, reason `idle`). Use `60` when the provider caches for an hour. |
| `decisionLog` | boolean | `true` | Record every routing outcome, main loop and subagents, in the plugin store (persists across sessions, newest 200 kept). Each entry holds the time, session id, loop, action, category and difficulty, confidence, backend, model before and routed model, context tokens and reason; never the prompt text. `false` records nothing. Read it with `/route log [n]` (default 20, at most 200, newest first) and empty it with `/route log clear`. Actions: `switched`, `kept`, `hint`, `low-confidence`, `continuation`, `classifier-failed`, `pinned`, `unknown-context`, `vague`, `escalated`, `consulted`, `rerouted`. |
| `continuationSkip` | boolean | `true` | A main-loop prompt that is only an acknowledgement skips the classifier and the turn stays on the current model. `false` classifies every prompt. See "Continuation prompts". |
| `continuationPhrases` | string (comma list) | empty | Acknowledgement phrases matched against the whole prompt. Empty = the built-in English and French list; a value replaces it. |
| `contextWindows` | string (JSON) | empty | Context window in tokens by model-name substring, e.g. `{"haiku":200000}`; the longest matching key wins. Empty or no match: 1,000,000 for an id with `[1m]`, 200,000 otherwise. No switch goes to a model whose window the context exceeds. |
| `jevUrl` | string | empty | Databricks AI Gateway SystemOne endpoint, e.g. `https://<workspace>.cloud.databricks.com/ai-gateway/typesafe/v1/systemone`. Empty = Jev goes to the TypeSafe API directly when its API key is set. |
| `jevModel` | string | empty | The `model` field sent to SystemOne. Empty = `system.ai.typesafeai-jev-1-14-0` on the gateway, `jev-latest` on the TypeSafe API. |
| `databricksProfile` | string | empty | Profile passed to `databricks auth token -p` for the gateway route (empty = the CLI's default). The token is cached 10 minutes in memory only and refreshed once on a 401. |
| `jevApiKeyEnv` | string | `TYPESAFE_API_KEY` | Name of the environment variable holding the TypeSafe API key for Jev without a gateway. The key is read from the environment, never stored in settings. |
| `haikuModel` | string | empty | Model the Haiku step asks through the session's own client (`$.model.complete`): an alias or a full id. Empty = the `haiku` alias on the `anthropic` profile, `system.ai.claude-haiku-5-5` on `databricks`. |
| `localModel` | string | `qwen3.6:35b-a3b` | Model used by the local step (Ollama on `localhost:11434`). Any Ollama model works. |
| `minConfidence` | number | `0.6` | Below this top probability the route falls back to `general`, and the difficulty falls back to `medium`. |
| `timeoutMs` | number | `0` | Per-step timeout in milliseconds; `0` uses each step's default (2500 for Jev, 4000 for Haiku and local). |
| `routes` | string (JSON) | empty | JSON object mapping a category (`fast`/`general`/`reasoning`/`coding`) or a cell (`coding.high`) to `{"model": id, "effort": level}` (or a model id alone). See "Editing `routes`". |

### Continuation prompts

A main-loop prompt that is only an acknowledgement ("ok", "yes do it", "continue", "oui", "vas-y") is not sent to a classifier. The turn stays on the current model: the last applied decision, or the session model if there is none. No hint is added and the HUD route line is unchanged.

- The match is on the whole text, never a substring. Case, surrounding punctuation and emoji are ignored. Two phrases may be joined by a space or comma ("ok, continue"). The text must be 40 characters or less. "ok now redesign the auth flow" is classified as usual.
- It never picks a model without the classifier; it only keeps the current one. It also avoids a real mistake: the classifier sees only the latest prompt, so "yes" looks trivial and could switch an Opus task down to Haiku in the middle of the work, in a small context.
- "no" and "stop" are not in the list on purpose: a correction is classified.
- Default English: ok, okay, k, yes, y, yep, yeah, sure, go, go on, go ahead, continue, proceed, next, do it, yes do it, yes please, please do, sounds good, looks good, lgtm, perfect, great, thanks, thank you.
- Default French: oui, ouais, d'accord, dac, merci, vas-y, vas y, continue, parfait, c'est bon, fais-le, oui vas-y.
- `continuationPhrases` (comma list) replaces the built-in list; empty restores it. `continuationSkip=false` classifies every prompt.
- With `session-start`, a continuation as the first prompt is skipped and the next real prompt makes the session's decision. Subagent spawns are not affected.
- `/route status` shows a line like `classifier: 38 calls · 12 skipped (continuation)`. The counters are in memory and reset by `/clear`.

### When Jev counts as configured

1. A non-empty `jevUrl` means the Databricks gateway route, whatever the profile. Authentication is `databricks auth token`.
2. Otherwise, if the environment variable named by `jevApiKeyEnv` is set and non-empty, Jev goes to the TypeSafe API directly. See [Known limitations](#known-limitations): this route follows the public API documentation and has not been tested.
3. Otherwise the Jev step is skipped.

`/route status` shows which route is in use.

### When the Haiku step counts as configured

The Haiku step needs the session's `$.model.complete` capability. When the engine does not provide it, the step is skipped (not configured).

### When the local step counts as configured

The local step needs Ollama answering on `localhost:11434` (a quick probe, remembered for a minute). The first call after a cold start can exceed the 4000 ms local timeout while Ollama loads a large model into memory. The turn then goes unrouted. Raise `timeoutMs`, or pre-warm the model with `ollama run <model> ""`. Once loaded, the model stays in memory for 30 minutes.

### Fallback policy

When a configured step fails (timeout, HTTP error, unreadable answer):

- `ask`: a dialog shows a sanitized error (an HTTP status and short phrase, never a token or body) and offers at most four options: "Use <next> this time", "Use <next> for the rest of this session", "Use <later> this time" (only if a later configured step exists), and "Stay on the current model" (the router stays out of the way for 5 minutes). Dismissing the dialog, running headless, or typing free text leaves that request unchanged and remembers nothing. Only one dialog is open at a time; concurrent requests failing on the same step share it (for example subagents spawned together).
- `never`: no fallback; the request is left unchanged.
- `auto`: silent fall-through to the next configured step.

If no later configured step exists, the request is left unchanged without a dialog.

### Main-loop routing and the prompt cache

The prompt cache belongs to one model. A model switch makes the next request re-read the whole conversation uncached.

Estimates from the plugin's default price table (USD per 1M tokens; not bills): a 150k-token conversation costs about $0.03 to re-read cached on Sonnet (cache read 0.2). Switching up to Opus writes it again at the cache-write rate (5), about $0.75. Switching down to Haiku costs about $0.02 (cache write 0.125), but coming back to Sonnet after the 5-minute cache expired costs about $0.37 (cache write 2.5).

- `task` (default): routes per task, not per prompt. The main loop starts on the session model; set Claude Code's `model` to `sonnet` to make Sonnet the medium starting model. The classifier also returns seven labels (see "Labels"). The router remembers one committed model per session.
  - **Before the first commit.** A vague prompt (`specified` is `vague`, or `specified=clear` below `minConfidence`) or a continuation keeps the model and commits nothing (logged `vague` or `continuation`). This holds only while the context is at most `switchMaxContext`: a larger conversation already has its task, and the classifier, which reads each prompt alone, would call its follow-ups vague. The first **clear prompt** (`specified=clear` at `minConfidence` or above, or `evidence` of `snippet` or `traceback`) goes through the same switch rule as `adaptive` (`switchConfidence`, `switchMaxContext`, window guard). Whatever model runs afterwards becomes the committed model.
  - **After the commit.** `specified` blocks nothing. A routed model that is the same, lighter or of unknown tier keeps the model (with `delegationHint`, a hint). A heavier one (`haiku` < `sonnet` < `opus`) with confidence below `switchConfidence` is kept and logged `low-confidence`. A heavier one with enough confidence switches and re-commits if the context is at most `switchMaxContext` and fits the target's window. Otherwise the model is kept and, with `escalation` on, a hidden directive asks the main model to delegate the hard part to the `nexus:frontier` subagent or to call `consult`. This is logged `escalated`.
  - **When the commitment is dropped.** When the cache is lost anyway, the commitment is dropped and logged `rerouted` with the reason `clear`, `compact`, `resume` or `idle`: `/clear`, a compaction, a resume, or no main-loop request for more than `cacheTtlMinutes`. After `idle` or `compact`, the `switchMaxContext` guard is lifted for the next clear prompt (the cache is cold); the window guard stays.
  - With `labels` off, every classified prompt counts as clear.
  - Compared with the others: `adaptive` never escalates and treats each prompt alone; `session-start` decides once and never re-routes.
- `adaptive`: every prompt is classified. The main model switches only when all of these hold: confidence >= `switchConfidence`, the main-loop context <= `switchMaxContext`, and the context fits the target's window (below). The first prompt of a session has no context, so it can always switch. After `/reload-plugins`, a restart or a resumed conversation the context can be unknown; if the conversation is not fresh, the router measures the request before the switch (an estimate when no token count is available) or keeps the current model and logs `unknown-context`. Otherwise the model is kept so the cache keeps serving. Below `switchConfidence` nothing else happens (logged `low-confidence`). If the switch was held back for the context size or the window and `delegationHint` is on, a one-line hidden note is attached to that prompt (model context, not shown in the transcript as typed). It suggests a subagent for self-contained work; the router routes the subagent at spawn. The HUD route trail shows `switched`, `kept` or `hint` with the context size.
- `every-turn`: every prompt is classified and the model switches on every prompt, without the confidence and context checks. The window guard still applies. Fits each turn better, but a switch starts a cold cache.
- `session-start`: the first main-loop turn is classified and that model is kept for the session. If that first turn gets no decision (for example every step failed), later turns retry until one is made.
- `off`: the main loop is never routed. `/route pin` then applies only to subagents.

Cost of `task`, `adaptive` and `every-turn`: one classifier call per prompt, typically well under a second on a Databricks gateway.

**Context-window guard.** Default window: 1,000,000 tokens for a model id containing `[1m]`, 200,000 otherwise. These are assumptions; check them against your provider's documentation and override them with `contextWindows`. A switch (in `adaptive` or `every-turn`) never goes to a model whose window the current context exceeds.

`/clear` resets the kept main-loop decision and the session's consent choices ("for the rest of this session", "stay").

### Labels

Besides `route` and `difficulty`, every classifier step asks seven labels in the same single request, so labels add no extra call.

| Label | Values |
|---|---|
| `specified` | `clear` (the goal and target are stated), `vague` (an acknowledgement, a vague wish, or the goal is missing) |
| `scope` | `none`, `local`, `multi_file`, `cross_system` |
| `evidence` | `snippet`, `traceback`, `reference`, `none` |
| `failure` | `crash`, `wrong_behavior`, `performance`, `none` |
| `localization` | `pinpointed`, `likely_local`, `spread` |
| `language` | `python`, `typescript`, `sql`, `iac`, `shell`, `jvm`, `other` |
| `project` | `data`, `web`, `infra`, `tooling`, `docs`, `other` |

The Haiku and Ollama steps ask for the same labels in their JSON. A missing or invalid label is left out, never guessed. `language` is unreliable, so it feeds the report only and never routing. `labels` = `false` sends only `route` and `difficulty`.

### Escalation: `nexus:frontier` and `consult`

With `escalation` on, a `nexus:frontier` subagent type is registered at session start. Its model is the profile's `reasoning.high` model (Opus by default) at effort `high`. It works from the brief it is given, verifies, and reports what changed and what is uncertain. The main model should use it when stuck, before a risky or hard-to-reverse approach, before declaring hard work done, or when NEXUS asks to escalate. The router does not re-classify a `nexus:frontier` spawn: it keeps Opus with effort `high`, logged `escalated`.

The `consult` tool (`mcp__nexus__consult`) gives the working model an advisor-like second opinion from a frontier model, sent through your own provider. It is NEXUS's own emulation, not Anthropic's advisor tool, so it works on gateways that lack the server-side advisor tool. Input: `goal`, `tried`, `question` and optional `context`. It sees only that brief, nothing from the transcript. It is capped at `consultMax` calls per session and logged `consulted` with the advisor model (the brief is never logged). It is registered whenever `consultMax` is above 0, independent of `escalation`.

NEXUS does not spawn anything itself: the main model decides whether to follow the directive. Check with `/route log`: an `escalated` entry means the directive was sent, and a later `nexus:frontier` spawn means the model followed it.

### Report and export

- `/route report [n]`: the last `n` sessions (default 10). Per model the share of turns and tokens; the estimated cost from the HUD price table (`prices`, `upliftPct`); the same tokens priced at Opus as a baseline and the saving in % and dollars; and the counts of switched, escalated, consulted and rerouted. The baseline is an estimate, because another model would have used different tokens.
- `/route log export [path]`: JSONL, one line per log entry (`{"type":"decision",...}`) and per usage record (`{"type":"usage",...}`). Default path `./nexus-route-<YYYYMMDD-HHmm>.jsonl` in the session's working directory. No prompt text.

Both read the usage store (`router.usage`, token sums per session and model, newest 50 sessions), which is written only while `decisionLog` is on.

### How the model is chosen

Jev (or the fallback step) answers two things in one request: the category (`fast`, `general`, `reasoning`, `coding`) and the difficulty:

- `low`: a small, well-defined change or answer.
- `medium`: normal multi-step work.
- `high`: hard or ambiguous work, many parts, or a mistake that would be costly.

The Haiku and local steps are asked for the same two fields. The category and difficulty pick a cell of the matrix, which gives the model and the effort.

Confidence:

- A category confidence below `minConfidence` gives `general`.
- A difficulty confidence below `minConfidence` gives `medium`. A missing difficulty also gives `medium`.
- The decision's confidence, the one `switchConfidence` compares, is the lower of the two.

### Default matrix

Used when `routes` is empty. The matrix is the plugin's choice, not a recommendation from the models' vendor; override it with `routes`.

| | `low` | `medium` | `high` |
|---|---|---|---|
| `fast` | Haiku low | Haiku medium | Sonnet medium |
| `general` | Haiku medium | Sonnet medium | Sonnet high |
| `coding` | Sonnet medium | Sonnet high | Opus high |
| `reasoning` | Sonnet high | Opus medium | Opus high |

Examples of classifier answers (`anthropic` profile, Databricks gateway). Each answer carries `choice`, `confidence` and `probabilities`. The stated `confidence` can differ from the probability of the choice (for example 0.73 against 0.8 for `coding`); NEXUS uses the probability of the choice when it is present.

| Prompt | Category (confidence) | Difficulty (confidence) | Cell |
|---|---|---|---|
| "what does the --dry-run flag of terraform plan do?" | `fast` (0.86) | `low` (1.0) | Haiku, low effort |
| "add read permission for the data-eng group on the ... bucket in the terraform module" | `general` (0.90) | `low` (0.94) | Haiku, medium effort |
| "refactor the whole router into a plugin system with pluggable backends, keep backward compatibility and migrate all tests" | `coding` (0.80) | `high` (1.0) | Opus, high effort |
| "why does our kafka consumer lose messages only under rebalance? design a fix across the three services" | `reasoning` (1.0) | `high` (0.97) | Opus, high effort |

Model ids per profile:

| Model | `anthropic` | `databricks` |
|---|---|---|
| Haiku | `claude-haiku-5-5` | `system.ai.claude-haiku-5-5` |
| Sonnet | `claude-sonnet-5-5` | `system.ai.claude-sonnet-5-5[1m]` |
| Opus | `claude-opus-5-5` | `system.ai.claude-opus-5-5[1m]` |

The `anthropic` profile uses full ids rather than the `haiku`/`sonnet`/`opus` aliases: the model rewrite at `turn.step` is not documented to resolve aliases, and an unknown name would fail the request. (The Haiku classifier step goes through `$.model.complete`, which is documented to accept aliases, so its default is the `haiku` alias.) **When newer models ship, update these ids by setting `routes`.**

### Editing `routes`

`routes` is one JSON object, put on a single line in the settings screen. What the code does:

- A category key (`coding`) sets all three difficulties of that category. A cell key (`coding.high`; difficulty `low`, `medium` or `high`) overrides one cell and wins over its category key.
- A partial map merges with the profile's matrix: a cell you do not set keeps the profile default.
- An entry may be a model id string (the profile's effort for that cell is kept) or an object `{"model": id, "effort": level}`. `effort` is `low`, `medium`, `high`, `xhigh`, `max`, a positive number, or `null` (leave the effort alone). An omitted or invalid `effort` keeps the profile's.
- An entry with a missing or empty `model`, or of another type, keeps the profile default.
- Invalid JSON, or JSON that is not an object, is ignored entirely and the whole profile matrix is used. There is no error message; check with `/route status`.

```json
{
  "coding.high": { "model": "claude-opus-5-5", "effort": "xhigh" },
  "general": "claude-sonnet-5-5"
}
```

Here hard coding runs on Opus at `xhigh`, and every `general` cell uses Sonnet with the matrix's effort for that cell.

## HUD

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `prices` | string (JSON) | empty | USD per 1M tokens by model-name substring, e.g. `{"opus-5-5":{"inPerM":4,"outPerM":20,"cacheReadPerM":0.2,"cacheWritePerM":5}}`. Entries override the defaults or add models. Empty uses the built-in defaults: public list prices from the Databricks pricing page for proprietary foundation model serving, converted at $0.07 per DBU; `cacheWritePerM` is the 5-minute cache rate. Plain names (`opus`, `claude-opus-5-5`) and gateway names (`system.ai.claude-opus-5-5`) match the same entry. A model with no price shows a dash. |
| `upliftPct` | number | `0` | Added to every price, in percent, e.g. `10` for a +10% regional or data-residency surcharge. |
| `stallMinutes` | number | `30` | Minutes without an event before a running subagent gets one stall alert, sent to the main session. `0` turns the alert off. |

The cost shown is an estimate, not a bill.

HUD commands: `/workflow` with no argument cycles the band expanded, collapsed, hidden. `/workflow expand | collapse | hide` sets it directly (the full names `expanded`, `collapsed`, `hidden` also work). `/workflow pane` opens the full dashboard in a pane. `/nexus` is an alias of `/workflow` and takes the same arguments.

## Orchestrator

| Setting | Type | Default | Meaning |
|---|---|---|---|
| `orchestratorReminder` | boolean | `true` | Adds a short reminder to the system prompt to decide whether to split multi-step work across subagents (see the orchestrator skill). Off adds nothing. The skill itself is always available. |

## Presets

See [presets/README.md](../presets/README.md) for example settings for both profiles.

## Known limitations

- The direct TypeSafe API route (no `jevUrl`, API key set) follows the public API documentation and has not been tested against the live service. `/route status` labels it `unverified`.
- Whether the main model follows the escalation directive, and whether a subagent takes the delegation hint, is model behaviour. Check it with `/route log`.
- The stall alert is delivered to the main session as a message. Delivery into an idle session is covered by tests with the engine's test harness only; if the session does not answer, ask the subagent for a status yourself.
