# Presets

Example values for the settings of the plugin, using the keys and defaults of `.claude-plugin/plugin.json`. They hold placeholders only: replace `<workspace>` and `<profile>`. Never add secrets.

| File | What it is |
|---|---|
| `anthropic.json` | The defaults. Jev is used only if you export `TYPESAFE_API_KEY` (this direct route has not been tested yet). |
| `databricks.json` | Jev through a Databricks AI Gateway workspace, and the `system.ai.claude-*` route table. |

## How do I apply a preset?

Claude Code has no command to import a settings file for a plugin, so pass values yourself.

At install time, one `--config KEY=VALUE` per option:

```sh
claude plugin install nexus --marketplace saidbouras/nexus \
  --config profile=databricks \
  --config jevUrl=https://<workspace>.cloud.databricks.com/ai-gateway/typesafe/v1/systemone \
  --config databricksProfile=<profile>
```

After install:

1. Run `/plugin configure nexus@nexus`.
2. Enter each value from the preset file. An empty string means "use the default".
3. Run `/reload-plugins`, then `/route status` to confirm.

`routes`, `contextWindows` and `prices` are empty strings in the presets. To override one, enter JSON text on one line. All settings are described in [docs/CONFIGURATION.md](../docs/CONFIGURATION.md).
