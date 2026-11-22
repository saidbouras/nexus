# Contributing to NEXUS

Thanks for helping. For anything bigger than a small fix, open an issue first so we can agree on the approach before you write code. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## How do I run NEXUS from my clone?

```sh
git clone https://github.com/saidbouras/nexus.git
cd nexus
claude --plugin-dir "$PWD"
```

In an interactive session the folder is watched, so saving a file reloads the hooks module. Other ways to load a clone are in [docs/INSTALL.md](docs/INSTALL.md#develop-from-a-clone).

You need Claude Code 2.1.275 or later and Node.js 20 or later.

## What do I run before a pull request?

From the repository root:

```sh
claude plugin validate .
claude plugin test .
```

`validate` checks `plugin.json` and `marketplace.json`. `test` runs the unit tests (the `*.test.ts` files next to the code). Both must pass; CI runs the same two commands on every pull request.

Add or update a test next to the code you change. There is no separate `tsc` step: Claude Code supplies the engine types to a loaded plugin.

## Code style

- TypeScript, small pure functions, tests for pure logic.
- The router must fail open: an error never blocks a request.
- Use the terms consistently: NEXUS is the plugin; router, HUD and orchestrator are its parts.
- Comments say why, in one line, next to the code.
- Docs are plain and accurate. Put a doubt in a "Known limitations" section at the end of the page, not in the middle of a sentence.

## Commit messages and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

When behaviour or a setting changes, update the docs and add a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). The pull request template lists the checks.

## No secrets, no private data

Never commit tokens, API keys, real workspace URLs, profile names or internal hostnames. Use placeholders such as `<workspace>` and `<profile>`. Never log tokens or prompt text.

## Reporting security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
