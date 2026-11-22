# Privacy

NEXUS has no server of its own and sends no telemetry. The router sends text to a classifier you configure; the HUD only reads session events locally and computes cost estimates from token counts.

## What is sent

Per classification, the router builds one message and cuts it to the first 4000 characters (`MAX_PROMPT_CHARS`). Nothing else of the conversation is attached.

- **Main loop** (when `routeMainLoop` is not `off`): the text of the user prompt. With `task` (the default), `adaptive` and `every-turn`, the classifier sees every main prompt, not only the first. `session-start` sends one prompt per session; `off` sends none. Channel hint: `claude-code main loop` (or `claude-code subagent turn` for a subagent's own turn).
- **Subagent spawn:** `[<subagent type>] <description>` followed by the prompt the model wrote for the subagent. Channel hint: `claude-code subagent spawn: <subagent type>`.

Prompts that are only an acknowledgement ("ok", "yes do it", "oui", see `continuationSkip` in [CONFIGURATION.md](CONFIGURATION.md#continuation-prompts)) are not sent to any classifier. For classification they stay on the machine. They still go to the session's own model, as any prompt does.

The router adds no file contents, tool output or earlier messages. But the text it sends is whatever the prompt or subagent prompt contains: if you paste code into your prompt, or the model quotes a file or tool output in a subagent prompt, that text is part of the message (up to 4000 characters). Pinned routes (`/route pin`) send nothing.

Besides the message, each backend gets fixed text: the list of route names and difficulty levels with short descriptions and an instruction to pick one of each. The category and the difficulty are asked in the same single request: the prompt text sent is the same, there is still one request per classification, and nothing new leaves your machine.

| Step | Destination | Exactly what is sent |
|---|---|---|
| Jev via Databricks gateway (`jevUrl` set) | Your Databricks workspace AI Gateway, which forwards to the Jev model under your workspace's terms | The message and the channel hint, plus the fixed route criteria. Authenticated with a token from `databricks auth token`; your workspace's logging and retention rules apply. |
| Jev via TypeSafe API (no `jevUrl`, API key set; see [Known limitations](CONFIGURATION.md#known-limitations)) | `api.typesafe.ai`, a third party | The message as a plain string (no channel hint), plus the fixed route criteria, with your API key. Prompt text leaves your organisation; check TypeSafe's terms first. |
| Haiku | Anthropic or your configured provider, through the session's own client (`$.model.complete`), same relationship as your normal Claude Code use | The message wrapped in `<request channel="...">`, plus a fixed system prompt. |
| Local (Ollama) | Your machine only (`localhost:11434`) | The message (no channel hint) and a fixed system prompt. Nothing leaves the machine. |

The labels (`specified`, `scope`, `evidence`, `failure`, `localization`, `language`, `project`) are asked in the same single request, derived from the same prompt text already sent to the classifier. No extra data is sent and there is no extra request. `labels` = `false` asks only for the route and the difficulty.

The delegation hint (`adaptive` and `task` modes) is generated locally and added to the prompt that goes to the session's own model. It is not sent to any classifier.

The classifier returns a route name and a confidence; the router keeps those and the chosen model for the HUD.

## Decision log

With `decisionLog` on (the default), the router records each routing outcome, from the main loop and from subagents, in the plugin store on your machine. It persists across sessions and keeps the newest 200 entries. The action is one of `switched`, `kept`, `hint`, `low-confidence`, `continuation`, `classifier-failed`, `pinned`, `unknown-context`, `vague`, `escalated`, `consulted` or `rerouted`. An entry has the time, session id, loop, action, category and difficulty, confidence, classifier step, model before and routed model, context tokens, the reason and the task labels. No prompt text is ever stored, and nothing is sent anywhere. `/route log clear` empties it; `decisionLog=false` records nothing.

In `task` mode, the escalation directive is also generated locally and added to the prompt that goes to the session's own model; it is not sent to any classifier.

## Consult tool

The `consult` tool (`mcp__nexus__consult`) sends only the brief the working model writes (`goal`, `tried`, `question`, optional `context`), nothing from the transcript, to the frontier model on your own provider, through the session's own client. The brief can contain whatever the model chose to quote. The brief is never logged. `consultMax` = `0` removes the tool. `escalation` = `false` does not affect it.

## Report and export

`/route report` and `/route log export` store and write no prompt text. The usage store (`router.usage`, token sums per session and model, newest 50 sessions) is kept in the plugin store on your machine and written only when `decisionLog` is on. The export file is written to the session's working directory (or the path you give), so keep it out of version control if the session ids matter to you. Nothing is sent anywhere.

## Consent dialog

When a configured step fails and `fallbackPolicy` is `ask`, a dialog shows a sanitized error (an HTTP status and short phrase, never a token or response body) before the message is sent to the next step. You choose to use the next step this time or for the session, use a later step once, or stay on the current model. Dismissing the dialog or running headless leaves the request unrouted, so the message goes to no further step. This stops a Databricks-only user's prompt from silently going to another provider after a failure. `never` removes the fallback; `auto` removes the question.

## Credentials

- Tokens and API keys are not written to settings or shown in the HUD, and error text has them blanked out.
- The TypeSafe key is read from the environment variable named by `jevApiKeyEnv`.
- Databricks tokens come from the Databricks CLI on demand and are kept in memory for 10 minutes.

## Organisations with a no-third-party policy

- Use only the Databricks gateway and/or the local step: set `chain` to `jev,local` with a `jevUrl`, or `local` alone.
- Do not set the TypeSafe API key variable (otherwise an empty `jevUrl` makes Jev go direct to a third party).
- Set `fallbackPolicy` to `never` (strictest), or leave it at `ask`.
- Remove `haiku` from `chain` if your policy excludes sending prompt text to the model provider through the classifier.
- Set `routeMainLoop` to `session-start` for one main prompt per session, or `off` if you do not want the main prompt classified at all (subagent prompts are still classified).
- Set `consultMax` to `0` if the `consult` tool should not send briefs to the frontier model.
