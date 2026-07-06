# 01 - Getting Started

This chapter covers the technical specifics of setting up Hive, where data is stored, and how to configure models and environment variables for local or production use.

---

## 1. Directory Structure and Data Layout

All of Hive's persistent state lives in the `~/.hive/` directory in your user's home folder. By default, these files are secured with strict permissions.

```text
~/.hive/
├── hive.db                # SQLite database (Settings, Models, API Keys) [chmod 0600]
├── auth_token             # Auto-generated UI login token [chmod 0600]
├── agents/
│   └── {agent_id}/
│       ├── sessions/      # JSONL files containing chat history
│       └── MEMORY.md      # Markdown file persisting agent context
└── shared/
    └── SHARED.md          # Blackboard file for Colony cross-agent communication
```

> [!CAUTION]
> If you are running Hive on a shared server, ensure `~/.hive` remains `0700` so other users cannot read your database and extract API keys.

---

## 2. API Keys vs. LiteLLM Gateway

Hive provides two ways to connect to cloud models (Anthropic, OpenAI, Gemini).

### Method A: Local Database (Default)
In the Hive UI, navigate to **Settings -> Model Providers** and paste your API keys. 
- These are saved directly to `~/.hive/hive.db`.
- The keys are masked in the UI but exist in cleartext in the SQLite file.
- **Override:** You can override DB keys by passing them as environment variables (e.g., `ANTHROPIC_API_KEY=sk-... npm start`). Environment variables *always* win over DB settings.

### Method B: LiteLLM Gateway (Advanced)
If you want to keep provider keys out of the Node.js process entirely, use the provided Docker-based LiteLLM gateway.
1. The Gateway runs on `127.0.0.1` and holds the real `OPENAI_API_KEY`, etc.
2. Hive is launched with a single `LLM_GATEWAY_KEY`.
3. Hive authenticates to the gateway; the gateway proxies requests to the provider.
4. **Benefit:** This enables spend limits, caching, and fallback aliases (e.g., routing `gateway/hive-coding` to Claude 3.5 Sonnet, and falling back to GPT-4o on failure).

---

## 3. Environment Variables

Hive behavior is heavily driven by process environment variables. These can be set in a `.env` file or passed directly at runtime.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | The HTTP port the Express backend binds to. |
| `HIVE_AUTH_TOKEN` | *Random UUID* | Secures the WebSocket and API routes. If missing on boot, Hive generates one and saves it to `~/.hive/auth_token`. |
| `HIVE_ALLOWED_ORIGINS` | `""` | Comma-separated list of extra CORS origins allowed to hit the API. |
| `HIVE_SANDBOX_NETWORK` | `none` | If set to `bridge`, agent docker containers are given outbound internet access. Otherwise, they are completely offline. |
| `HIVE_MUTATION_RATE_LIMIT` | `60` | Max number of mutating (POST/PUT/DELETE) requests allowed per window. |
| `HIVE_MUTATION_RATE_WINDOW_MS` | `60000` | The window in milliseconds for the rate limit. |
| `HIVE_MAX_TRIGGERED_COLONY_RUNS` | `2` | Number of concurrent Colony runs allowed to be triggered by Webhooks to prevent runaway costs. |
| `LLM_GATEWAY_URL` | *None* | Used alongside `LLM_GATEWAY_KEY` to route traffic through LiteLLM. |

---

## 4. First Boot & Authentication

When you first launch Hive (either via `npm start` or the Desktop app):
1. It validates your Docker installation (required for sandboxes) and Ollama status.
2. It generates a `HIVE_AUTH_TOKEN`.
3. The UI will present an unlock screen. You must paste the token from `~/.hive/auth_token` into this box.
4. **Client-side:** The Vite React app stores this token in browser local storage and sends it via the `Authorization: Bearer` header for all REST calls and via query parameter `?token=` for WebSockets.
