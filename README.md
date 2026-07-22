# Hive

**A self-hosted, local-first AI agent dashboard.** Build specialized agents, chat with them in real time, run multi-agent missions, chain them into pipelines, and schedule autonomous work — all on your machine. Run completely offline via [Ollama](https://ollama.com) with no account required, or integrate cloud models (Anthropic, OpenAI, Gemini) securely using your own API keys.

![local-first](https://img.shields.io/badge/local--first-AI-blue) ![node](https://img.shields.io/badge/node-%E2%89%A522-green) ![license](https://img.shields.io/badge/license-ISC-lightgrey)

![Hive dashboard](<docs/screenshots/1. Agents Tab  - Home.png>)

---

## What is Hive?

Hive is a unified command center for running AI agents locally. Instead of relying on a single monolithic LLM chat window, Hive lets you create a fleet of distinct **agents**, each with its own designated model, custom system prompt, specific toolsets, and persistent memory.

With Hive, you can:
- **Chat** seamlessly with any agent (includes real-time streaming, tool use, and file attachments).
- **Run Colony Missions**: Deploy multi-agent teams seeded from recipes (e.g., PM → Designer → Developer) orchestrated automatically to achieve complex goals.
- **Build Pipelines**: Chain agents together sequentially or concurrently to process data continuously.
- **Schedule Autonomous Work**: Use natural language to set up cron jobs for agents to execute routines automatically.
- **Manage Tools via MCP**: Integrate any external tool or API using the Model Context Protocol (MCP).
- **Integrate Webhooks**: Trigger agent pipelines from external services.
- **Use a Hive-native interface**: bee/hive branding, a custom packaged app icon, and honey-accented UI defaults.

Hive prioritizes your privacy and security. By default, API keys are stored locally in a secure SQLite database. For even stronger isolation, Hive integrates optionally with a LiteLLM gateway to keep secret keys completely out of the agent sandbox.

---

## Features

### 🤖 Custom Agents
- Create specialized agents with distinct models, prompts, tool groups, and memory.
- Real-time WebSocket streaming chat with markdown support.
- File attachments (text and images).
- Persistent per-agent memory (`MEMORY.md`) maintained across sessions.
- Export and import agents easily via `.agent.json` files.
- Configure per-agent spend budgets (enforced by the optional gateway).

### 🏢 Colony (Multi-Agent Missions)
- Launch recipe-seeded crews (e.g., a full software development team: BA → PM → Designer → Developer → QA → DevOps).
- An automated orchestrator plans the steps, delegates tasks via `ask_agent`, and verifies completion.
- Features a shared blackboard, handoff ledger, and a live log of every tool call and inter-agent message.

### ⛓️ Pipelines
- Chain agents where each step's output feeds directly into the next.
- Execute steps sequentially or in parallel.
- Live Server-Sent Events (SSE) streaming with step-by-step progress, timing, and automated retries.

### ⏱️ Schedules & Webhooks
- Schedule agent tasks using standard cron syntax or a natural-language preset picker.
- Track historical runs, including last-output and error logs.
- Trigger agents from inbound webhooks, projecting request context directly into the agent's prompt.

### 🛠️ Tools & MCP (Model Context Protocol)
- **Built-in Tools**: `agent_tools` (create/update/ask agents), `web_search`, `memory` (save_memory), `sandbox` (shell, run_python, file I/O, server management), and `colony_tools`.
- **MCP Integration**: Connect any external MCP server via stdio or HTTP (e.g., filesystem, git, GitHub, Brave Search, PostgreSQL, Slack).
- Environment variables are safely resolved at runtime.

### 🎙️ Media Generation
- Generate local images and speech through Hive's host-side `media` tool group.
- `generate_image` uses the configured local FLUX/Ollama image model and saves PNG artifacts.
- `generate_speech` uses the configured local Orpheus/Ollama TTS model, decodes with SNAC, and saves WAV artifacts.
- Media backends run outside the sandbox. Agents should call `generate_image` or `generate_speech` directly, not install Orpheus, SNAC, FLUX, torch, npm packages, or model files inside sandbox containers.

### 🧠 Models & Providers
- Browse, pull, and delete local Ollama models with live progress tracking.
- First-class support for cloud models (Anthropic, OpenAI, Gemini) via the [Vercel AI SDK](https://ai-sdk.dev).
- Seamless failover routing when using the LiteLLM gateway capability aliases (`gateway/hive-smart`, `gateway/hive-coding`, etc.).

---

## Architecture & Security

### Project Structure
Hive is organized as a monorepo:
- **`client/`**: React 19, Vite, Tailwind CSS, and Zustand frontend.
- **`server/`**: Node.js, Express 5 backend with WebSocket (`ws`), Server-Sent Events, and `better-sqlite3`.
- **`desktop/`**: Electron wrapper for a native application experience.
- **`gateway/`**: Dockerized LiteLLM + Postgres stack for advanced routing, caching, and spend management.
- **`scripts/`**: Utilities for detached launching and validation.

### Security Model
- **Local-First Secrets**: `~/.hive` permissions are strictly `0700` and the database `hive.db` is `0600`. Secrets are masked in the UI.
- **Sandbox Hardening**: Agent sandboxes run in Docker containers with `--cap-drop=ALL`, `no-new-privileges`, CPU/memory caps, and **no network access** by default.
- **Authentication**: Gated by `HIVE_AUTH_TOKEN`. A random token is generated on first boot for UI authentication.
- **External automation**: Enabled webhooks require their own secret, retain only allowlisted delivery metadata, and share bounded automation concurrency. Unattended runs do not inherit repo/GitHub write authority.
- **Rate Limiting**: Bounded rate limiters protect mutating API requests and incoming webhook deliveries.

### Optional Hardening: Gateway + Environment-Backed Secrets
For enterprise-grade security, you can isolate API keys completely:
1. **LiteLLM Gateway**: Runs in Docker (bound to `127.0.0.1`), holding the real provider keys. Hive connects via a revocable `LLM_GATEWAY_KEY`. Provides failover and spend limits.
2. **Environment References**: Store references (like `env:NAME`) in Hive, and inject the real values from your shell, OS secret store, or deployment environment at launch.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org) ≥ 22 (current LTS recommended)
- [Ollama](https://ollama.com) running locally (`ollama serve`) with at least one model pulled (e.g., `ollama pull qwen2.5:7b`).
- *(Optional)* [Docker](https://www.docker.com) for secure agent sandboxing and LiteLLM gateway.

### 1. Desktop App (Recommended)
Download the installer from [GitHub Releases](https://github.com/SantiaGoMode/hive/releases) (macOS `.dmg` or Linux `.AppImage`/`.deb`). Windows packaging remains available for local builds but is not published until Authenticode signing is configured. The setup wizard handles model connection and starter agent creation automatically.

Production macOS releases are Developer ID signed and notarized. If Gatekeeper rejects a release artifact, do not bypass quarantine; verify the release checksum and report the rejected version.

### 2. From Source
Clone the repository and install dependencies:
```bash
git clone https://github.com/SantiaGoMode/hive.git
cd hive
npm install
npm install --prefix client
```

#### Running Development Mode (Hot Reload)
```bash
npm run dev
```
Access the dashboard at `http://localhost:5173`.

#### Running Production Mode
```bash
npm run build && npm start
```
Access the dashboard at `http://localhost:3001`.

*On first boot, Hive will check your environment, help you connect models, and generate a `HIVE_AUTH_TOKEN` (saved to `~/.hive/auth_token`) for login.*

Hive creates protected online SQLite backups under `~/.hive/backups` (seven daily backups by default). Check integrity through `/api/system/database/integrity`. To restore, stop Hive and run `npm run db:restore -- <backup-name> --confirm-stopped`; the utility validates the backup and preserves the current database before replacement.

The update, schema-compatibility, rollback, and redacted-support-diagnostics policy is documented in [docs/RELEASE_AND_RECOVERY.md](docs/RELEASE_AND_RECOVERY.md). A support report can be downloaded from Settings → Advanced → Maintenance actions without including prompts, stored rows, paths, URLs, headers, or credential values.

---

## Data & Configuration

All Hive data is stored locally in your home directory under `~/.hive/`:
- `hive.db`: SQLite database for configuration, models, and keys.
- `agents/{id}/`: Contains per-agent `MEMORY.md` and conversation history.
- `shared/SHARED.md`: A shared blackboard accessible by all agents.

Key Environment Variables:
- `PORT`: HTTP port (default 3001).
- `HIVE_AUTH_TOKEN`: Protects your API and UI.
- `HIVE_SANDBOX_NETWORK`: Set to `bridge` to allow sandbox containers internet access (default is `none`).
- `LLM_GATEWAY_URL` / `LLM_GATEWAY_KEY`: Used if deploying with the LiteLLM gateway.

Media Settings:
- `media_python`: Optional path to the Python interpreter that has SNAC/Torch installed for local speech decoding. This is stored in Hive settings, not bundled into the desktop app.
- `media_tts_model`: Ollama model tag for local Orpheus TTS.
- `media_image_model`: Ollama model tag for local image generation.

---

## Testing

Hive has comprehensive test coverage. To run the suites:
```bash
npm test               # Run backend tests (uses mock Ollama and in-memory DB)
npm run test:client    # Run frontend tests (Vitest + JSDOM)
npm run test:ci        # Run all tests, linting, and build
```

---

## License

ISC License. See the `package.json` for more details.
