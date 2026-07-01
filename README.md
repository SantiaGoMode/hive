# Hive

**A self-hosted, local-first AI agent dashboard.** Build specialized agents, chat with them in real time, run multi-agent missions, chain them into pipelines, and schedule autonomous work — all on your machine. Local-first via [Ollama](https://ollama.com) with no account required, and cloud models (Anthropic, OpenAI, Gemini) available through a secret-isolating local gateway.

![local-first](https://img.shields.io/badge/local--first-AI-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-green) ![secrets](https://img.shields.io/badge/secrets-0%20plaintext%20at%20rest-success) ![license](https://img.shields.io/badge/license-ISC-lightgrey)

![Hive dashboard](docs/screenshots/dashboard.png)

---

## What is Hive?

Hive is a single dashboard for running AI agents locally. Each **agent** has its own model, system prompt, tool set, and persistent memory. From there you can:

- **Chat** with any agent (streaming, tool use, file attachments, MCP servers).
- Run **Colony** missions — recipe-seeded multi-agent teams led by an orchestrator that plans, delegates, and verifies.
- Build **Pipelines** that chain agents (sequential or parallel) with live progress.
- **Schedule** agents on cron with natural-language presets.
- Watch a **Staff** lounge where autonomous personas chat.
- Trigger agents from **Webhooks**.
- Manage **Models** (pull/delete Ollama, or use cloud providers).

Cloud models route through an optional **LiteLLM gateway** that holds the real API keys, so neither Hive nor the agent code it runs ever sees them. Secrets live in a [scrt4](https://github.com/llmsecrets/llm-secrets) vault and are stored in Hive's DB only as `env:NAME` references — **zero plaintext secrets at rest**.

---

## Screenshots

| Agents | Colony | Pipelines |
|---|---|---|
| ![Agents](docs/screenshots/dashboard.png) | ![Colony](docs/screenshots/colony.png) | ![Pipelines](docs/screenshots/pipelines.png) |

| Staff lounge | Models | Settings |
|---|---|---|
| ![Staff](docs/screenshots/staff.png) | ![Models](docs/screenshots/models.png) | ![Settings](docs/screenshots/settings.png) |

---

## Features

### Agents
- Create specialized agents with distinct models, system prompts, tool groups, and memory.
- Real-time WebSocket streaming chat; file attachments (text + images).
- Per-agent persistent memory (`MEMORY.md`) that carries across sessions.
- Export/import agents as portable `.agent.json`.
- Optional **per-agent spend budget** (USD) enforced by the gateway via a dedicated virtual key.

### Colony — multi-agent missions
- Recipe-seeded crews (e.g. a Development Team: BA → PM → Designer → Developer → QA → DevOps) led by an orchestrator that plans, delegates via `ask_agent`, and gates completion.
- Structured plan execution, a shared blackboard, handoff ledger, and a live log of every tool call and message.
- Per-role model planning — when the gateway is on, roles default to failover aliases for resilience.

### Pipelines
- Chain agents: each step's output feeds the next; parallel steps run concurrently.
- Live SSE streaming with per-step progress, timing, and retry; built-in templates.

### Scheduled runs & Webhooks
- Cron agent runs with a natural-language preset picker; run-now, enable/disable, last-output/error tracking.
- Trigger agents from inbound webhooks with configurable context projection and actions.

### Staff lounge
- Autonomous personas chat on an interval (one speaker per tick, grounded by anti-fabrication gates), on their own dedicated chat models.

### Tools & Skills
| Group | Tools |
|-------|-------|
| `agent_tools` | `create_agent`, `ask_agent`, `list_agents`, `update_agent`, `delete_agent`, `list_models`, `read_shared`, `write_shared`, pipelines, schedules |
| `web_search` | `web_search`, `web_fetch` |
| `memory` | `save_memory` |
| `sandbox` | `shell`, `run_python`, `write_file`, `read_file`, `list_files`, `start_server`, … |
| `colony_tools` | `set_plan`, `update_plan_step`, `add_plan_step`, `mark_goal_achieved` |

### MCP (Model Context Protocol)
- Connect any MCP server via stdio or HTTP; built-in presets (filesystem, git, GitHub, Brave Search, PostgreSQL, Slack, …).
- Secret env vars are stored as `env:NAME` references and resolved at spawn; masked in the UI; auto-reconnect; per-agent tool toggle.

### Models & providers
- Browse, pull, and delete local Ollama models with live progress.
- Cloud models (Anthropic, OpenAI, Gemini) alongside Ollama via the [Vercel AI SDK](https://ai-sdk.dev) — chat, tools, pipelines, and colony work identically across providers.
- Model ids are provider-prefixed (`anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, `gemini/gemini-2.5-pro`); bare names (`llama3.1:8b`) are Ollama; **gateway capability aliases** (`gateway/hive-smart`, `gateway/hive-cheap`, `gateway/hive-coding`) route through the failover pool.

---

## Architecture

### LLM gateway (optional, recommended for cloud)
Cloud calls route through a local **[LiteLLM](https://litellm.ai) gateway** (Docker, bound to `127.0.0.1`) that is the *only* process holding real provider keys:

- **Failover** — `gateway/hive-*` aliases are multi-provider pools with retries, cooldowns, and fallbacks (a billing/quota error on one provider transparently fails over to another).
- **Spend tracking & budgets** — per-agent virtual keys with hard `max_budget` caps, attributed in Postgres `LiteLLM_SpendLogs`.
- **Response caching** and **master-key auth**.

See [`gateway/README.md`](gateway/README.md) for setup, the failover aliases, and spend queries.

### Secret model — zero plaintext at rest
Secrets never live in code or the DB as values:

- Cloud LLM keys live only in the gateway container (injected from the scrt4 vault at launch).
- GitHub / Brave / ngrok tokens are stored as `env:NAME` references and resolved from the scrt4-injected environment at runtime.
- Hive's settings DB holds references and masks, never raw secrets.

```
scrt4 vault ──inject env──▶ LiteLLM gateway (holds real keys) ──▶ providers
                       └────▶ Hive process (env: refs resolve here) ──▶ MCP / ngrok
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, Tailwind CSS, Zustand |
| Backend | Node.js, Express 5, better-sqlite3, zod |
| Realtime | WebSocket (`ws`), Server-Sent Events |
| AI runtime | Ollama (local); Anthropic / OpenAI / Gemini (cloud) via the Vercel AI SDK |
| Gateway | LiteLLM + Postgres in Docker (optional) |
| Secrets | scrt4 vault + `env:` references |
| Storage | SQLite at `~/.hive/hive.db` |

---

## Requirements

- [Node.js](https://nodejs.org) ≥ 18
- [Ollama](https://ollama.com) running locally (`ollama serve`) with a tool-capable model pulled (e.g. `ollama pull qwen2.5:7b`)
- For cloud models / the gateway: [Docker](https://www.docker.com) and the [scrt4](https://github.com/llmsecrets/llm-secrets) CLI

---

## Getting Started

```bash
# Install dependencies
npm install
npm install --prefix client
```

### Run (local-only, no secrets)

For a purely local Ollama setup with no cloud/MCP/ngrok:

```bash
npm run dev        # server + client with hot reload → http://localhost:5173
```

### Run with secrets (cloud, MCP, ngrok)

Hive expects secrets injected from the scrt4 vault — the DB only holds `env:NAME` references, so a bare `npm run dev` leaves cloud models, the GitHub/Brave MCP servers, and ngrok non-functional. Start the gateway first, then Hive, both through scrt4:

```bash
# 1. LLM gateway (Docker) — only this process gets the real provider keys
scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] ANTHROPIC_API_KEY=$env[ANTHROPIC_API_KEY] \
  GEMINI_API_KEY=$env[GEMINI_API_KEY] LITELLM_MASTER_KEY=$env[LITELLM_MASTER_KEY] \
  ./gateway/run-gateway.sh'

# 2. Hive — NO cloud provider keys here. The gateway holds those; Hive reaches
#    cloud models only through LLM_GATEWAY_KEY. Hive gets the non-LLM secrets its
#    own integrations need (GitHub/Brave MCP servers, ngrok, webhooks).
scrt4 run 'GITHUB_TOKEN=$env[GITHUB_TOKEN] BRAVE_API_KEY=$env[BRAVE_API_KEY] \
  NGROK_AUTHTOKEN=$env[NGROK_AUTHTOKEN] WEBHOOK_SECRET=$env[WEBHOOK_SECRET] \
  LLM_GATEWAY_KEY=$env[LITELLM_MASTER_KEY] HIVE_AUTH_TOKEN=$env[HIVE_AUTH_TOKEN] \
  VITE_HIVE_AUTH_TOKEN=$env[HIVE_AUTH_TOKEN] \
  ./run-dev.sh'
```

The app runs at **http://localhost:5173** (Vite proxies the API to the server on port 3001). On first boot, an onboarding screen lets you pull a model from the UI.

> **First boot & auth:** if no `HIVE_AUTH_TOKEN` is configured, Hive generates one and saves it to `~/.hive/auth_token`. When the UI prompts for a token, paste that value — it's remembered in the browser afterwards.

> **Why no `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` in the Hive launch?** That's the point of the gateway: the real provider keys live *only* in the gateway container. `keyFor()` (`server/lib/providers/index.js`) reads `process.env` first, so injecting them into Hive would put the real keys in the same process that runs agent code — defeating the isolation. Hive authenticates to the gateway with `LLM_GATEWAY_KEY` instead.
> `LLM_GATEWAY_KEY` is required only when the gateway has master-key auth enabled. Full gateway + spend/budget setup: [`gateway/README.md`](gateway/README.md).
>
> *(If you run **without** the gateway, then Hive does need the per-provider keys — add them to this launch and skip `LLM_GATEWAY_KEY`.)*

---

## Data Layout

```
~/.hive/
  hive.db                    # SQLite database (settings hold env: references, never raw secrets)
  hive-dev.log               # detached dev-server log
  agents/{id}/
    sessions/{id}.jsonl      # conversation history
    MEMORY.md                # per-agent memory
  shared/
    SHARED.md                # shared blackboard (all agents can read/write)
```

---

## Security model

- **No plaintext secrets at rest** — verified across the repo; cloud keys live in the gateway, other tokens are `env:` references resolved from the vault at runtime.
- **Per-agent spend budgets** cap runaway cost; the gateway enforces hard limits via per-agent virtual keys.
- **Gateway bound to loopback** and (optionally) master-key authenticated.
- **Auth on by default** — if no `HIVE_AUTH_TOKEN` / `hive_auth_token` is configured, Hive generates a random token on first boot, persists it, and writes a copy to `~/.hive/auth_token` (mode 0600). The UI shows a one-time unlock prompt; paste the token there (or set `VITE_HIVE_AUTH_TOKEN` for the Vite client). Mutating requests without an `Origin` header are rejected in tokenless fallback mode.
- **Hive API hardening** — browser CORS restricted to localhost plus `HIVE_ALLOWED_ORIGINS` / `hive_allowed_origins`; API and chat WebSocket traffic gated by the auth token; a bounded rate limiter on mutating requests; constant-time comparison for all webhook secrets/signatures; zod validation on write routes with consistent 400s; ngrok refuses to start unless Hive auth is enabled.
- **Sandbox hardening** — agent containers run with `--cap-drop=ALL`, `no-new-privileges`, a pids/memory/CPU cap, and **no network by default** (opt in with `HIVE_SANDBOX_NETWORK=bridge` or the `sandbox_network` setting). Colony repo mounts are read-only except for roles that explicitly need writes (coding roles, PM).
- **Bounded external triggers** — cron schedules skip a fire while the previous run is still in flight, and webhook-triggered colony runs go through a concurrency cap + queue (`HIVE_MAX_TRIGGERED_COLONY_RUNS`, default 2), so a webhook redelivery storm can't fan out unbounded paid runs.

---

## Testing

```bash
npm test               # server (node:test) — fake Ollama + in-memory SQLite, no running Ollama required
npm run test:client    # client (vitest) — pure-logic tests plus jsdom component tests (ChatWindow, ErrorBoundary)
npm run test:ci        # both suites + lint + client build
```

---

## Configuration

Settings persist in SQLite (`app_settings`) and are editable from the **Settings** page:

- **Ollama URL** — defaults to `http://localhost:11434`
- **Model providers** — per-provider API keys, or an **LLM Gateway** URL + key (when set, the per-provider keys are bypassed)
- **Appearance** — theme, accent color, font size
- **ngrok** — tunnel token/domain for remote access

Web search (the `web_search` tool group) requires an Ollama account: `ollama signin`.

Key environment variables (full inventory in `server/lib/config.js` and `.env.example`):

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default 3001; startup fails fast if it's taken) |
| `HIVE_AUTH_TOKEN` | API auth token (auto-generated on first boot if unset) |
| `HIVE_ALLOWED_ORIGINS` | extra allowed CORS/WebSocket origins |
| `HIVE_SANDBOX_NETWORK` | sandbox container network: `none` (default) or `bridge` |
| `HIVE_MAX_TRIGGERED_COLONY_RUNS` | concurrent webhook-triggered colony runs (default 2) |
| `HIVE_MUTATION_RATE_LIMIT` / `HIVE_MUTATION_RATE_WINDOW_MS` | mutating-request rate limit |
| `LLM_GATEWAY_URL` / `LLM_GATEWAY_KEY` | LiteLLM gateway endpoint + key |

---

## Project layout

```
server/          Express API, WebSocket, providers, colony/pipeline/staff runners, MCP
client/          React + Vite dashboard
gateway/         LiteLLM + Postgres Docker stack (see gateway/README.md)
scripts/         detached-launch helpers (spawn/stop)
docs/            screenshots + supplementary docs
```

Outstanding tech debt and enhancements are tracked in the repo's GitHub issues.

---

## License

ISC
