# Security Policy

## How do I report a vulnerability?

Report it privately through a [GitHub security advisory](https://github.com/saidbouras/nexus/security/advisories/new). Do not open a public issue for a security problem.

Include the NEXUS version, the steps to reproduce and the impact. Do not include real tokens or workspace URLs. This is a small project run by volunteers: expect an acknowledgement as soon as someone can look, but no fixed timeline.

## Which versions get fixes?

The latest release. Update with the commands in [docs/INSTALL.md](docs/INSTALL.md#update).

## What rules does NEXUS follow for secrets?

- API keys come from environment variables (`jevApiKeyEnv`). They are never stored in settings, state or files.
- Databricks tokens are fetched on demand from the Databricks CLI and kept in memory for 10 minutes.
- Tokens, keys and error bodies that may quote them are never logged or shown in the HUD or in dialogs.
- Prompt text goes only to the classifier steps you configure. See [docs/PRIVACY.md](docs/PRIVACY.md).

If you find a path that breaks one of these rules, report it as above.
