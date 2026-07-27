---
layout: guide
title: Configuration
description: Reference for Hive paths, authentication, networking, concurrency, backups, providers, and integrations.
permalink: /docs/configuration/
section: Start here
previous_url: /docs/models-and-providers/
previous_label: Models and providers
next_url: /docs/guides/first-hour/
next_label: Your first hour with Hive
---

Hive reads configuration from environment variables and locally stored settings. Environment-backed secrets override stored values.

## Core settings

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3001` | Production HTTP port |
| `HIVE_HOME` | `~/.hive` | State, agents, logs, backups, and auth token |
| `HIVE_DB_PATH` | `$HIVE_HOME/hive.db` | SQLite database path |
| `HIVE_BIND_HOST` | `127.0.0.1` | Server bind address |
| `HIVE_AUTH_TOKEN` | generated | Protects the UI and API |
| `HIVE_ALLOWED_ORIGINS` | local origins | Additional browser origins |
| `LOG_LEVEL` | `info` | Server log verbosity |
| `LOG_SWALLOWED` | disabled | Log errors normally suppressed by fallback handling |

On first boot, Hive generates an auth token and saves it under `HIVE_HOME`. Treat it as a password. Binding beyond localhost expands the threat boundary; use a trusted reverse proxy, TLS, and strict allowed origins.

## Sandboxing and concurrency

| Variable | Default | Purpose |
|---|---:|---|
| `HIVE_SANDBOX_NETWORK` | `none` | `none` blocks container egress; `bridge` enables it |
| `HIVE_MAX_CONCURRENT_AUTOMATION_RUNS` | `4` | Combined unattended automation concurrency |
| `HIVE_MAX_CONCURRENT_COLONY_RUNS` | `2` | Concurrent Colony runs |
| `HIVE_MAX_COLONY_RUN_ATTEMPTS` | `3` | Colony retry ceiling |
| `HIVE_OUTBOX_MAX_ATTEMPTS` | `5` | Durable delivery retry ceiling |

Enable sandbox network access only for tools that require it. Network access does not grant repository or GitHub write authority; those permissions remain separately scoped.

## Rate limits

| Variable | Default |
|---|---:|
| `HIVE_MUTATION_RATE_LIMIT` | `120` |
| `HIVE_MUTATION_RATE_WINDOW_MS` | `60000` |
| `HIVE_WEBHOOK_RATE_LIMIT` | `60` |
| `HIVE_WEBHOOK_RATE_WINDOW_MS` | `60000` |

## Backups

| Variable | Default | Purpose |
|---|---:|---|
| `HIVE_BACKUP_INTERVAL_HOURS` | `24` | Online backup interval |
| `HIVE_BACKUP_RETENTION` | `7` | Number of protected backups retained |

## Providers and integrations

Supported secret variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLM_GATEWAY_URL`, `LLM_GATEWAY_KEY`, `DISCORD_BOT_TOKEN`, and `NGROK_AUTHTOKEN`.

GitHub authentication resolves in this order: a stored Hive setting, `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GH_TOKEN`, then the active `gh` CLI token.

Copy `.env.example` from the repository for a launch-ready template. Never commit populated secret values.
