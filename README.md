# agent-mux

`agent-mux` is an unofficial, extensible profile wrapper for AI agent CLIs.

Command: `amux`.

Current built-in providers:
- Codex CLI (`codex`)
- Claude Code CLI (`claude`)
- Gemini CLI (`gemini`)

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
  - Gemini CLI: `gemini`

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
- `amux use [profile]`
- `amux current`
- `amux list`
- `amux providers`

Provider commands:
- `amux codex login|logout|status|run [args...]`
- `amux claude login|logout|status|run [args...]`
- `amux gemini login|logout|status|run [args...]`

Codex remote login helpers:
- `amux codex login-device` -> `codex login --device-auth`
- `amux codex callback` -> forward a browser `http://localhost:<port>/...` redirect URL to the Codex login server on this machine

Selection aliases:
- `amux use` -> choose from registered profiles
- `amux login` -> choose a provider, then run login
- `amux login <provider>` -> run that provider login without a prompt

Legacy compatibility aliases:
- `amux logout` -> `amux codex logout`
- `amux run` -> `amux codex run`
- `amux run <profile>` -> run Codex with that profile without `amux use`

Run shortcuts:
- `amux codex run <profile>`
- `amux claude run <profile>`
- `amux gemini run <profile>`

## Quick Start

Terminal 1 (account A):

```bash
amux use a
amux login
amux claude login
amux codex run
amux run a
```

Terminal 2 (account B):

```bash
amux use b
amux login claude
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
amux gemini status
```

## Auth Flow Policy

amux does not automate OAuth/browser flows.

When running `amux login`, `amux codex login`, `amux claude login`, or `amux gemini login`, users complete browser sign-in and terminal confirmation directly. amux only isolates each profile's storage path.

Gemini CLI does not expose a separate `login` CLI subcommand; it starts auth from the `gemini` app. `amux gemini login` and `amux login gemini` launch Gemini CLI with the selected profile's `GEMINI_CLI_HOME`.

## SSH/Remote Codex Login

On a remote server, VM, or EC2 instance without a local browser, prefer device-code login.

```bash
amux use a
amux codex login-device
```

You can also pass the Codex option directly.

```bash
amux codex login --device-auth
```

If you must use the browser redirect flow, keep the Codex login process running on the remote terminal. After signing in locally, copy the browser address bar's `http://localhost:<port>/...` redirect URL and paste it into `amux codex callback` on the remote machine.

```bash
# Remote terminal A
amux codex login

# Authenticate in your local browser and copy the localhost redirect URL.

# Remote terminal B
amux codex callback
```

The redirect URL can contain a one-time code or token. Do not paste it into chats, issues, or shell history; prefer pasting it directly into the `amux codex callback` prompt.

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
