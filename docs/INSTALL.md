# Install NEXUS

NEXUS is a Claude Code plugin. This page takes you from nothing to a working install in a few minutes.

Commands in `sh` blocks run in a terminal. Commands that start with `/` are typed at the Claude Code prompt.

## Requirements

- Claude Code 2.1.275 or later. Check with `claude --version`.
- Databricks profile only: the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/install) and a workspace where the Jev endpoint is available through AI Gateway.
- Optional: [Ollama](https://ollama.com), for the local classifier step.

## Install

```sh
claude plugin install nexus --marketplace saidbouras/nexus
```

This adds the `saidbouras/nexus` marketplace to your user settings, then installs the plugin. The command prints `N userConfig options not yet set`. That is normal: every option has a default, and a session works without any setup.

The install scope is `user` by default. Use `--scope project` or `--scope local` to install for one project only.

Inside a Claude Code session, the same install is:

```
/plugin install nexus --marketplace saidbouras/nexus
```

If you prefer two steps (add the marketplace, then install):

```sh
claude plugin marketplace add saidbouras/nexus
claude plugin install nexus@nexus
```

Then run `/reload-plugins`, or restart Claude Code.

## Configure

Every setting is described in [CONFIGURATION.md](CONFIGURATION.md). Ready-made values are in [presets/](../presets/README.md). Pick the profile that matches how you reach Claude.

You can set options at install time with `--config KEY=VALUE` (repeat the flag for each option), or later inside Claude Code:

```
/plugin configure nexus@nexus
```

### Anthropic profile (default)

Nothing to do. The router uses your own Anthropic access for its Haiku classifier step, and skips any step that is not configured.

Optional: to use Jev through the TypeSafe API directly, export a key in the shell that starts Claude Code, then restart Claude Code.

```sh
export TYPESAFE_API_KEY=<your key>
```

If your key lives in another variable, put that variable's name in `jevApiKeyEnv`. Never paste the key into a setting. This route sends prompt text to a third party; read [PRIVACY.md](PRIVACY.md) first. Leave `jevUrl` empty: a non-empty `jevUrl` makes Jev use the Databricks gateway whatever the profile.

This direct TypeSafe API route has not been tested yet.

### Databricks profile

1. Install the Databricks CLI. On macOS with Homebrew:

   ```sh
   brew tap databricks/tap
   brew install databricks
   ```

2. Log in:

   ```sh
   databricks auth login --host https://<workspace>.cloud.databricks.com --profile <profile>
   ```

3. Check that a token can be obtained:

   ```sh
   databricks auth token --profile <profile>
   ```

4. Install with the profile settings in one command:

   ```sh
   claude plugin install nexus --marketplace saidbouras/nexus \
     --config profile=databricks \
     --config jevUrl=https://<workspace>.cloud.databricks.com/ai-gateway/typesafe/v1/systemone \
     --config databricksProfile=<profile>
   ```

   Already installed? Run `/plugin configure nexus@nexus` and set the same three values.

Your Databricks user needs permission to query the Jev endpoint and to use AI Gateway in that workspace. The exact grant depends on your workspace setup, so ask your workspace admin for query access to the Jev endpoint. A 401 or 403 from the gateway means the grant is missing; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

The default routes for this profile name Databricks-hosted Claude models (`system.ai.claude-*-5-5`). Your workspace must serve those names, or you must override `routes`.

### Optional: local Ollama step

```sh
ollama pull qwen3.6:35b-a3b
ollama serve
```

Skip `ollama serve` if the Ollama app is already running. Any Ollama model works: set `localModel` to its name. The first call after a cold start loads the model and can exceed the classifier timeout, which leaves that turn unrouted. Warm it up with `ollama run <model> ""` or raise `timeoutMs`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Verify

1. Run `/plugin` and check that `nexus` is listed and enabled.
2. Run `/route status`. It shows whether routing is on, the configured classifier steps and the route-to-model map.
3. Send a short prompt such as `explain what a mutex is in two sentences`. The HUD above the prompt shows a `ROUTE` line with the category, model, confidence and classifier.
4. Optional: run `/route pin coding`, send a prompt, check that the route shows `pin`, then run `/route pin off`.
5. Optional: run `/workflow` to cycle the HUD between expanded, collapsed and hidden.

## Update

```sh
claude plugin marketplace update nexus
claude plugin update nexus@nexus
```

Then run `/reload-plugins`, or restart Claude Code. The same commands work inside a session with the `/plugin` prefix.

## Disable or uninstall

To keep the plugin but stop the router, run `/route off`. The HUD stays. To disable the whole plugin, run `/plugin`, select `nexus` and disable it.

To uninstall:

```sh
claude plugin uninstall nexus@nexus
```

Optionally remove the marketplace too:

```sh
claude plugin marketplace remove nexus
```

## Develop from a clone

Clone the repository, then load it for one session:

```sh
git clone https://github.com/saidbouras/nexus.git
claude --plugin-dir /path/to/nexus
```

Or add the clone as a marketplace and install from it:

```sh
claude plugin marketplace add /path/to/nexus
claude plugin install nexus@nexus
```

A marketplace that is a local folder is read in place. Your edits take effect at the next session start or after `/reload-plugins`. To run the checks and open a pull request, see [CONTRIBUTING.md](../CONTRIBUTING.md).
