# agent-mux

`agent-mux` is an unofficial, extensible profile wrapper for AI agent CLIs.

Command: `amux`.

Current built-in providers:
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)

It lets you keep account A in terminal A and account B in terminal B, while isolating provider storage per profile.

## Why agent-mux

- Avoid repeated logout/login switching
- Keep auth and local state separated per profile
- Use one command shape across providers (`amux <provider> ...`)
- Add new providers (Gemini, etc.) without rewriting core profile logic

## Important Notice (Unofficial)

- This project is not an official OpenAI, Anthropic, or Google product.
- Product names are trademarks of their respective owners.
- amux only wraps installed CLIs and routes profile-specific environment variables.

## Prerequisites

- Node.js + npm
- Provider CLIs installed and available in PATH
  - Codex CLI: `codex`
  - Claude Code CLI: `claude`

## Install (Local)

```bash
npm install
npm run build
npm link
```

Then:

```bash
amux --help
```

## Command Model

Common profile commands:
- `amux use <profile>`
- `amux current`
- `amux list`
- `amux providers`

Provider commands:
- `amux codex login|logout|status|run [args...]`
- `amux claude login|logout|status|run [args...]`

Legacy compatibility aliases:
- `amux login` -> `amux codex login`
- `amux logout` -> `amux codex logout`
- `amux run` -> `amux codex run`
- `amux run <profile>` -> run Codex with that profile without `amux use`

Run shortcuts (both providers):
- `amux codex run <profile>`
- `amux claude run <profile>`

## Quick Start

Terminal 1 (account A):

```bash
amux use a
amux codex login
amux claude login
amux codex run
amux run a
```

Terminal 2 (account B):

```bash
amux use b
amux codex login
amux claude login
amux claude run
```

Status:

```bash
amux current
amux list
amux list --json
amux codex status
amux claude status
```

## Auth Flow Policy

amux does not automate OAuth/browser flows.

When running `amux codex login` or `amux claude login`, users complete browser sign-in and terminal confirmation directly. amux only isolates each profile's storage path.

## Storage and Update Safety

Default home resolution order:
1. `AMUX_HOME`
2. fallback `~/.amux`

State files:
- `state.json`
- `state.backup.json` (automatic backup before overwrite)

amux uses:
- state schema versioning (`v3`)
- automatic migration from older schemas (`codex-mux v1`, unified v2)
- atomic write (`temp file + rename`) to reduce corruption risk

This is designed to prevent data loss during upgrades.

amux is intentionally isolated from legacy `mux` paths to avoid cross-project profile collisions.

## Extending Providers (Gemini etc.)

The CLI is provider-registry based. To add a provider, define in `src/index.ts`:
- provider id/label
- binary name
- env var key
- default home dir name
- login/logout args
- status reader

After adding one provider definition, `amux <provider> login/logout/run/status` is created automatically.

## Korean README

Korean documentation is available at `README.ko.md`.
