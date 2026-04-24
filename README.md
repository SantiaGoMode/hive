# Hive

A self-hosted, local-first AI agent dashboard powered by [Ollama](https://ollama.com). No cloud accounts, no API keys, no external dependencies — everything runs on your machine.

![Hive](https://img.shields.io/badge/local--first-AI-blue) ![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![License](https://img.shields.io/badge/license-ISC-lightgrey)

---

## Features

### Agents
- Create and manage specialized AI agents with distinct models, system prompts, tools, and memory
- Chat with any agent via real-time WebSocket streaming
- Agent templates: Researcher, Coder, Writer, Analyst, Secretary
- Per-agent persistent memory (`MEMORY.md`) that carries across conversations
- Export/import agents as portable `.agent.json` files
- File attachments (text and images) in chat

### Colony (Multi-Agent Orchestration)
- Spawn a colony: an orchestrator agent that autonomously creates and directs specialized worker agents
- Workers are role-separated: Researchers (web search), Implementers (sandbox/code), Reviewers
- Structured plan execution with step tracking, delegation enforcement, and guard rails
- Live log view showing every tool call, worker message, and plan state update

### Tools
| Group | Tools |
|-------|-------|
| `agent_tools` | `create_agent`, `ask_agent`, `list_agents`, `update_agent`, `delete_agent`, `list_models`, `read_shared`, `write_shared`, pipelines, schedules |
| `web_search` | `web_search`, `web_fetch` (requires `ollama signin`) |
| `memory` | `save_memory` |
| `sandbox` | `shell`, `run_python`, `write_file`, `read_file`, `list_files`, `start_server`, and more |
| `colony_tools` | `set_plan`, `update_plan_step`, `add_plan_step`, `mark_goal_achieved` |

### Pipelines
- Chain agents together: output of one step feeds into the next
- Parallel steps execute concurrently via `Promise.all`
- Real-time SSE streaming with per-step progress, timing, and retry
- Built-in templates: Research→Blog, Code Review→Fix, News Briefing, and more

### Scheduled Runs
- Cron-based agent runs with natural-language preset picker
- Run-now, enable/disable, last output and error tracking

### MCP (Model Context Protocol)
- Connect any MCP server via stdio or HTTP
- 14 built-in presets: filesystem, git, GitHub, Brave Search, PostgreSQL, Slack, and more
- Secret env var masking, auto-reconnect, per-agent tool toggle

### Models
- Browse, pull, and delete Ollama models with real-time progress

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, Tailwind CSS, Zustand |
| Backend | Node.js, Express 5, better-sqlite3 |
| Realtime | WebSocket (`ws`), Server-Sent Events |
| AI runtime | Ollama (local) |
| Storage | SQLite at `~/.hive/hive.db` |

---

## Requirements

- [Node.js](https://nodejs.org) ≥ 18
- [Ollama](https://ollama.com) running locally (`ollama serve`)
- At least one tool-capable model pulled (e.g. `ollama pull qwen2.5:7b`)

---

## Getting Started

```bash
# Install dependencies
npm install
npm install --prefix client

# Start in development mode (server + client with hot reload)
npm run dev

# Or start server only
npm start
```

The app runs at **http://localhost:5173** (Vite proxy to server on port 3001).

### First launch

On first boot, Hive shows an onboarding screen to pull a model directly from the UI.

---

## Data Layout

```
~/.hive/
  hive.db                    # SQLite database
  agents/{id}/
    sessions/{id}.jsonl      # Conversation history
    MEMORY.md                # Agent memory
  shared/
    SHARED.md                # Shared blackboard (all agents can read/write)
```

---

## Running Tests

```bash
npm test
```

Tests use a fake Ollama server and an in-memory SQLite database — no running Ollama instance required.

---

## Configuration

Settings are persisted in SQLite (`app_settings` table). You can change them from the **Settings** page in the UI:

- **Ollama URL** — defaults to `http://localhost:11434`
- **Theme** — light/dark, accent color, font size

---

## Web Search

Web search requires an Ollama account and sign-in:

```bash
ollama signin
```

Once signed in, enable the `web_search` tool group on any agent.
