# Using NEXUS

After install there is nothing to run: the router and the [HUD](HUD.md) work from the first prompt. This page explains what happens on each prompt, when the classifier is called, how to pick a mode and a profile, and what the `/route` commands show.

Every setting named here is described in [Configuration](CONFIGURATION.md). Open the settings with `/plugin configure nexus@nexus`, then run `/reload-plugins`.

## What happens on each prompt

1. **Classify.** You send a prompt. The router asks the first configured classifier step (Jev, then Haiku, then a local Ollama model) for a category (`fast`, `general`, `reasoning` or `coding`), a difficulty (`low`, `medium` or `high`) and seven task labels, all in one request. A prompt that is only an acknowledgement ("ok", "yes do it", "continue", "oui", "vas-y") skips this step: the turn stays on the current model and nothing is sent to a classifier. See [Continuation prompts](CONFIGURATION.md#continuation-prompts).
2. **Pick a cell.** The category and the difficulty pick a model and an effort from the route matrix (see [Default matrix](CONFIGURATION.md#default-matrix)). A category below `minConfidence` becomes `general`, and a difficulty below it becomes `medium`.
3. **Switch or keep.** The `routeMainLoop` mode decides whether the main model changes. In the default `task` mode the session commits to a model on the first clear prompt and then protects the prompt cache. A vague prompt (one the `specified` label marks vague) keeps the model and commits nothing, but only before the first commit and while the context is at most `switchMaxContext`; after that every classified prompt counts as clear. In `task` and `adaptive` mode a switch normally needs confidence of at least `switchConfidence`, a context of at most `switchMaxContext`, and a context that fits the target model's window. Otherwise the model is kept, so the prompt cache keeps serving. The full rules: [Main-loop routing and the prompt cache](CONFIGURATION.md#main-loop-routing-and-the-prompt-cache).
4. **Add a note when the model is kept.** When the model is kept although another one was chosen, a one-line hidden note can be added to that prompt. If the chosen model is lighter, it suggests handing self-contained work to a subagent, which the router puts on that model (`delegationHint`, in `task` and `adaptive` mode). If it is heavier (`task` mode), it is a directive: delegate the hard part to the `nexus:frontier` subagent and integrate its result, or call `consult` for a short second opinion. See [Escalation](CONFIGURATION.md#escalation-nexusfrontier-and-consult).
5. **Route subagents.** Each subagent is classified once, when it is spawned, in every mode. A `nexus:frontier` subagent is not classified: it runs on the frontier model, the `reasoning/high` cell (Opus by default).
6. **Ask before a fallback.** If a classifier step fails, a dialog shows the error before the next step is used (`fallbackPolicy`). If nothing answers, the request goes out unchanged on the current model.

The HUD's [route line](HUD.md#the-route-line) shows the outcome of each decision, and `/route log` keeps it.

### A session, step by step

This example uses the defaults (`task` mode) with Claude Code's `model` set to `sonnet`.

1. The session starts on Sonnet.
2. Your first prompt, "ok, let's look at the pipeline", states no task. It is labelled vague, so nothing is committed and the session stays on Sonnet. The HUD shows `vague`.
3. Your next prompt is a routine edit that names the module and the resource. It is clear and classified `coding/medium`, whose cell is Sonnet at effort `high`. Sonnet is already running, so the model is kept, the effort `high` applies, and the session commits to Sonnet. The HUD shows `commit`.
4. Two hours later, with 150k tokens of context, you ask for a deep redesign across several components. It is classified `reasoning/high` (Opus) with confidence 0.82. Switching would write the 150k tokens again into Opus's cache, about $0.75 on the default price table. The context is above `switchMaxContext` (50,000), so the model stays on Sonnet and the escalation directive is added. Claude writes a brief and spawns `nexus:frontier`, which runs the redesign on Opus with a small, fresh context. Claude then checks and integrates the result.
5. The HUD shows `reasoning/high → kept sonnet 5.5 · ctx 150k · escalated → opus 5.5`. `/route log` shows an `escalated` entry for the main loop, then an `escalated (frontier)` entry for the spawn.
6. If you `/clear`, or come back after more than `cacheTtlMinutes` without a request, the commitment is dropped (logged `rerouted`). After an idle gap or a compaction the cache is cold, so the next clear prompt may switch straight to Opus whatever the context size, as long as the context fits Opus's window.

## When is the classifier called?

"Jev" in the tables below means the first configured step of the classifier chain. If Jev is not configured, that step is skipped and the next one (Haiku, then Ollama) answers instead. The rules are the same whichever step answers. Results are not cached: every classification is a fresh call.

**Called**

| When | Mode | Calls |
|---|---|---|
| You send a prompt in the main loop | `task` (default), `adaptive`, `every-turn` | One call per prompt |
| You send the first prompt of the session | `session-start` | One call; the decision then holds for the session. If every step failed, the next prompt tries again |
| Claude spawns a subagent (Agent tool) | every mode, including `off` | One call per spawn, on the subagent's type, description and prompt |
| A subagent that was not classified at spawn (a resumed or forked one) starts a turn with text | every mode | One call for that turn; later turns reuse its decision |

**Not called**

| When | Why |
|---|---|
| A tool call, a tool result or any later model request inside a turn | The decision is made once per prompt and reused by every request of that turn |
| An acknowledgement-only prompt ("ok", "yes do it", "oui", "vas-y") | `continuationSkip` (default on). The turn stays on the current model |
| A slash command (`/route`, `/workflow`, ...) or a hidden system prompt | Not a request to the model |
| A prompt typed while a turn is still running | It joins that turn, which keeps its model; a switch mid-turn would only re-read the cache |
| A prompt that does not come from you at the terminal or through Remote Control (headless `claude -p`, notifications, scheduled tasks, other plugins) | Nobody can answer the fallback dialog, and it is not your request |
| An empty prompt | Nothing to classify |
| The main loop under `routeMainLoop=off` | The main loop is never routed; subagents still are |
| After the first decision under `session-start` | The session's decision holds |
| While `/route pin <category>` is active | The pinned category and difficulty are used, with no classifier calls at all |
| After `/route off` | Routing is off; the HUD keeps running |
| A `nexus:frontier` subagent | It always runs on the frontier model |
| A resumed or forked subagent, at spawn | It is not routed at spawn; it gets a call later, when it starts a turn with text |

### What one call costs

- **Time.** The call runs before your prompt is sent, so its latency is added to the start of the turn. On a Databricks gateway it is typically well under a second. Each step has a timeout: 2500 ms for Jev, 4000 ms for Haiku and Ollama (`timeoutMs` overrides both).
- **Text sent.** The prompt, cut to 4000 characters. See [Privacy: What is sent](PRIVACY.md#what-is-sent).
- **Failure.** If the call fails or times out, a dialog shows the error and asks before the next step is used (`fallbackPolicy`). If nothing answers, the request goes out unchanged on the current model.

`/route status` shows how many classifier calls were made and how many prompts were skipped as continuations. The counters reset with `/clear` or a resume.

### Example: calls in one session

In `task` or `adaptive` mode:

| You do | Classifier calls |
|---|---|
| Send "rename this variable" | 1 |
| Claude reads 12 files and edits 3 (about 20 model requests) | 0 |
| Send "ok, go on" | 0 (skipped as a continuation) |
| Send "now review the whole design" | 1 |
| Claude spawns 2 subagents for the review | 2 |
| Type `/route status` | 0 |
| **Total** | **4** |

## Choosing a main-loop mode

| If you want | Set `routeMainLoop` to |
|---|---|
| Route per task: start on Sonnet, commit once the task is clear, escalate to Opus without losing the cache (default) | `task` |
| Every prompt routed on its own, no switch in long sessions, no escalation | `adaptive` |
| The best model for every single prompt, whatever the cache costs | `every-turn` |
| One classification per session, the fewest classifier calls | `session-start` |
| The main model left alone, only subagents routed | `off` |

Subagents are routed at spawn in every mode.

## Common recipes

| Goal | Settings |
|---|---|
| Route every prompt on its own, as before 0.7.0 | `routeMainLoop` = `adaptive` |
| Fewest classifier calls | `routeMainLoop` = `session-start` |
| No silent fallback to another classifier | `fallbackPolicy` = `never`, `chain` = `jev` |
| Classify on your machine only | `chain` = `local`, with Ollama running. See [Optional: local Ollama step](INSTALL.md#optional-local-ollama-step) |
| Use a Databricks AI Gateway | `profile` = `databricks`, `jevUrl` = your workspace endpoint, `databricksProfile` = your Databricks CLI profile. See [Databricks profile](INSTALL.md#databricks-profile) |
| Follow a new model release | `routes`, for example `{"reasoning":{"model":"<new-id>","effort":"high"}}`. A category key sets all three difficulties. Changing `reasoning.high` also changes the `nexus:frontier` model and the report's baseline |
| Give hard coding a higher effort | `routes` = `{"coding.high":{"model":"claude-opus-5-5","effort":"xhigh"}}` (an `anthropic` profile id) |
| Switch models more often in long sessions | Raise `switchMaxContext`, or lower `switchConfidence` |

More on the `routes` format: [Editing `routes`](CONFIGURATION.md#editing-routes). Ready-made values for both profiles: [presets](../presets/README.md).

## Profiles

The profile picks the default route matrix and the default Haiku classifier model.

| | `anthropic` (default) | `databricks` |
|---|---|---|
| Default matrix models | `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5` | `system.ai.claude-haiku-5-5`, `system.ai.claude-sonnet-5-5[1m]`, `system.ai.claude-opus-5-5[1m]` |
| Default Haiku classifier model | `haiku` (alias) | `system.ai.claude-haiku-5-5` |
| Typical setup | Your own Claude Code access; optionally a TypeSafe API key for Jev | The Databricks CLI, plus `jevUrl` for a workspace AI Gateway that serves Jev |

The profile does not decide how Jev is reached; `jevUrl` does:

- A non-empty `jevUrl` sends Jev requests to that Databricks AI Gateway endpoint, authenticated with `databricks auth token` (`databricksProfile` picks the CLI profile).
- With `jevUrl` empty, Jev goes to the TypeSafe API when the environment variable named by `jevApiKeyEnv` (default `TYPESAFE_API_KEY`) is set.
- Otherwise the Jev step is skipped.

`/route status` shows which route is in use. Details: [When Jev counts as configured](CONFIGURATION.md#when-jev-counts-as-configured). Setup for each profile: [Anthropic profile](INSTALL.md#anthropic-profile-default) and [Databricks profile](INSTALL.md#databricks-profile).

## `/route` in detail

The command summary is in the [README](../README.md#commands). This section shows what each command prints.

### `/route status`

Start here when something looks wrong. It prints:

- Whether routing is on, the profile, the main-loop mode with its switch rule (for `task`: the escalation target, the cache TTL and the committed model, or `not committed`), the fallback policy, and the pin if one is set.
- The classifier chain, each step with its state, for example `jev (gateway, <model>)`, `haiku (not available)` or `local (<model>, not reachable)`.
- The classifier counters, for example `classifier: 38 calls · 12 skipped (continuation)`. They are kept in memory and reset by `/clear` or a resume.
- The session's fallback choices, if any (a step chosen for the session, a stay, the last failure).
- Whether the decision log is on.
- The last decision, and the route matrix, one category per line.

### `/route pin`

`/route pin <fast|general|reasoning|coding> [low|medium|high]` forces that cell for the main loop and for subagents, with no classifier calls. The difficulty defaults to `medium`. `/route pin off` (or `/route pin` alone) releases it. With `routeMainLoop=off` a pin applies to subagents only.

### `/route log`

`/route log [n]` prints the newest `n` decisions (default 20, at most 200), newest first, one line each:

```
11-04 16:20 main  rerouted (idle) sonnet 5.5  ctx 152k
11-04 15:40 main  reasoning/high 0.82 jev  escalated (context) sonnet 5.5 → opus 5.5  [clear cross_system none]  ctx 150k
11-04 13:32 main  coding/medium 0.88 jev  kept (same-model) sonnet 5.5  [clear local none]  commit  ctx 4k
```

Each line has the time, the loop, the category and difficulty with the confidence and the classifier step, the action with its reason, the models (before → routed), the labels `specified`, `scope` and `evidence`, `commit` when the decision committed the session's model, and the context size. Parts an entry does not have are left out.

The actions are `switched`, `kept`, `hint`, `low-confidence`, `continuation`, `classifier-failed`, `pinned`, `unknown-context`, `vague`, `escalated`, `consulted` and `rerouted`. A `nexus:frontier` spawn is logged `escalated (frontier)`, and each `consult` call is logged `consulted`. A dropped commitment is logged `rerouted`, with the reason `clear`, `compact`, `resume` or `idle`.

The log is kept in the plugin's own store across sessions, newest 200 entries, and holds no prompt text. `/route log clear` empties it. It needs `decisionLog` on (the default). What an entry holds: [Privacy: Decision log](PRIVACY.md#decision-log).

### `/route log export`

`/route log export [path]` writes the decision log and the usage records as JSONL: one `{"type":"decision",...}` line per log entry and one `{"type":"usage",...}` line per usage record (tokens per session and model). The default file is `nexus-route-<YYYYMMDD-HHmm>.jsonl` in the session's working directory; a relative path is also resolved there. The file holds no prompt text.

### `/route report`

`/route report [n]` summarises the last `n` sessions (default 10, at most 50):

- Per model: turns and their share, tokens and their share, input, output, cache read and cache write, `consult` calls, and the estimated cost.
- A total line. Models with no entry in the price table are listed as unpriced and left out of the cost and the saving.
- A baseline: the same tokens priced at the frontier model (the `reasoning/high` cell, Opus by default), and the saving in dollars and percent. The baseline is an estimate: another model would have used different tokens.
- Decision counts: switched, escalated, consulted, rerouted, vague, and kept or hint.

The report needs `decisionLog` on: token use is recorded only then. Prices come from the HUD's price table (`prices`, `upliftPct`).

## Limitations

- The direct TypeSafe API route for Jev (no `jevUrl`) has not been tested.
