# Hive LLM Gateway (LiteLLM)

A local [LiteLLM](https://litellm.ai) proxy, in Docker, that becomes the **only**
process holding your real OpenAI / Anthropic / Gemini keys. Hive talks to it with a
revocable, localhost-scoped key, so neither Hive nor the agent code it runs can ever
exfiltrate the real provider keys.

```
scrt4 vault ──inject real keys──▶ LiteLLM container (127.0.0.1:4000) ──▶ providers
                                          ▲
                  Hive + agents ──gateway key (sk-hive-gateway)──┘
```

## Files
- `docker-compose.yml` — the container; published on `127.0.0.1:4000` only, `restart: unless-stopped`, with a healthcheck.
- `litellm.config.yaml` — wildcard routing (`openai/*`, `anthropic/*`, `gemini/*`) so Hive's `<provider>/<model>` ids pass through unchanged. Keys read from container env (`os.environ/...`), never inlined.
- `run-gateway.sh` / `stop-gateway.sh` — start/stop wrappers.

## Start

Real keys are injected from the scrt4 vault into the container env at launch (they
never touch the host DB/disk or Hive's process). `docker compose up -d` is natively
detached, so this returns immediately:

```bash
scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] \
  ANTHROPIC_API_KEY=$env[ANTHROPIC_API_KEY] \
  GEMINI_API_KEY=$env[GEMINI_API_KEY] \
  gateway/run-gateway.sh'
```

Run that from the repository root. From another directory, use `cd /path/to/hive &&`
before the `scrt4 run ...` command; `run-gateway.sh` resolves the compose file from its
own location.

- **logs:** `docker logs -f hive-llm-gateway`
- **stop:** `./gateway/stop-gateway.sh`
- **health:** `curl http://127.0.0.1:4000/health/liveliness`

## Optional Login Start

The containers already use `restart: unless-stopped`, so they will come back after Docker
starts as long as they were previously running. For a fresh login or reboot where the
gateway is not already up, use your OS login/startup mechanism to run the same scrt4
command from the repo root:

```bash
cd /path/to/hive && scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] \
  ANTHROPIC_API_KEY=$env[ANTHROPIC_API_KEY] \
  GEMINI_API_KEY=$env[GEMINI_API_KEY] \
  gateway/run-gateway.sh'
```

For macOS, a small LaunchAgent or login item can call a wrapper script that contains the
command above. Keep the wrapper outside the repo if it contains local paths, and keep
secrets in scrt4 rather than in the wrapper.

## Point Hive at it

**Settings → Model Providers → LLM Gateway**, set base URL `http://127.0.0.1:4000/v1`
(or env `LLM_GATEWAY_URL`). When set, cloud providers route through the gateway and the
per-provider keys in Hive are bypassed — so they can be removed from Hive entirely.

## How it routes
`getModel()` (`server/lib/providers/index.js`) sends cloud calls through an
OpenAI-compatible client (`createOpenAI({ baseURL }).chat(...)`) pointed at the gateway;
LiteLLM's wildcard routing maps `anthropic/claude-…` → Anthropic, etc. Ollama is local
and untouched. Model listing (`listModels.js`) returns curated lists when the gateway is
on (no real key in Hive to call provider APIs with).

## Capability aliases & automatic failover
Beyond the wildcard pass-through, the config defines **capability aliases** — each a
multi-provider pool:

| Alias | Pool |
|---|---|
| `hive-smart` | claude-sonnet-4-6 · gpt-4o · gemini-2.5-pro |
| `hive-coding` | claude-sonnet-4-6 · gpt-4o |
| `hive-cheap` | gpt-4o-mini · claude-haiku · gemini-2.5-flash |
| `hive-bigctx` | gemini-2.5-pro (large-context fallback target) |

`router_settings` adds `num_retries`, a `retry_policy` that fails **billing/quota errors
over** (Anthropic credit = 400, OpenAI quota = 429), `cooldown_time`, and `fallbacks` /
`context_window_fallbacks` chains terminating in `hive-bigctx`. Verified: with OpenAI and
Anthropic both billing-broken, requests to every alias still return 200 by failing over to
Gemini.

**Hive uses these aliases** via the `gateway/` prefix — e.g. `gateway/hive-smart`. `parseModel`
recognizes the `gateway` provider and `getModel` sends the bare alias to the proxy
(`providers/index.js`); the picker lists them (`listModels.js`); and when the gateway is on
(cloud enabled), `colonyModels.js` assigns aliases per role by default (`hive-coding` for coding
roles, `hive-smart` otherwise) so colonies get failover automatically. Concrete `provider/model`
ids still pass straight through unchanged (single deployment, no failover) for anyone who picks
a specific model.

Editing this file requires `docker compose -f gateway/docker-compose.yml restart` to reload.

## Response cache policy
LiteLLM response caching is enabled with a local in-process cache and a **300 second TTL**.
That scope is intentionally narrow: it catches accidental duplicate requests and short retry
loops without keeping chat or tool-call responses stale for an hour. If you need fully fresh
responses while debugging a prompt, comment out `cache: true` in `litellm.config.yaml` and
restart the gateway.

## Security model & limits
- **Loopback only** — published on `127.0.0.1`, never reachable off-box.
- **Stops key theft, not capability misuse** — anything that can reach the proxy can make
  calls within a key's scope. Bound that with the hardening below.

## Spend tracking & budgets (Postgres)
The stack includes a `postgres` service (not published to the host). LiteLLM auto-runs its
prisma migrations on start and creates the spend/budget/key tables (`LiteLLM_SpendLogs`,
`LiteLLM_BudgetTable`, `LiteLLM_DailyAgentSpend`, …). Verified: migrations apply and tables
exist. **Spend is only logged for authenticated requests** — i.e. it activates once the master
key is on (spend attributes to a key/user), so the steps below are required, not optional, to
get cost visibility.

### Activate (one vault step + relaunch)
1. Add a master key to the vault (you do this — the value never passes through the assistant):
   ```
   ! scrt4 add LITELLM_MASTER_KEY=sk-<random>
   ```
2. Uncomment `master_key: os.environ/LITELLM_MASTER_KEY` in `litellm.config.yaml`.
3. Relaunch the gateway with the key injected:
   ```
   scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] ANTHROPIC_API_KEY=$env[ANTHROPIC_API_KEY] \
     GEMINI_API_KEY=$env[GEMINI_API_KEY] LITELLM_MASTER_KEY=$env[LITELLM_MASTER_KEY] \
     gateway/run-gateway.sh'
   ```
4. Give Hive the key too (else it gets 401 once auth is on) — add to the `run-dev.sh` launch:
   `LLM_GATEWAY_KEY=$env[LITELLM_MASTER_KEY]`. Hive reads it via `gatewayConfig()`.

Inspect spend: `docker exec hive-llm-gateway-db psql -U litellm -d litellm -c 'SELECT model, total_tokens, spend FROM "LiteLLM_SpendLogs" ORDER BY "startTime" DESC LIMIT 10;'`
or LiteLLM's `/spend/logs` and `/global/spend/report` endpoints.

Hive also reads `/spend/logs` from `/api/system/metrics` and summarizes persisted rows on
the Settings gateway panel by agent, budget headroom, total calls, token count, and cache
hit-rate. The API response is sanitized and never includes the gateway URL or key.

### Per-agent attribution (wired — metadata headers)
Hive tags every gateway call with `x-litellm-spend-logs-metadata` carrying `agent_id`,
`agent_name`, and (for colony work) `colony_id` + `role`, plus a `source`
(`agent`/`colony`/`chat`/`sub_agent`/`memory_synthesis`/`model_planning`). Set in
`getModel()` (`gatewayHeaders`) and threaded from `runAgentOnce` (covers colony workers,
pipelines, scheduled runs, webhooks, staff), the websocket chat loop, and the colony
operator/memory calls. LiteLLM records it in `LiteLLM_SpendLogs.metadata`, so once the master
key is on you can attribute cost per agent/colony:
```sql
-- LiteLLM nests custom metadata under metadata->'spend_logs_metadata'
SELECT metadata->'spend_logs_metadata'->>'agent_id'  AS agent,
       metadata->'spend_logs_metadata'->>'colony_id' AS colony,
       metadata->'spend_logs_metadata'->>'source'    AS source,
       COUNT(*) AS calls, SUM(total_tokens) AS tokens, ROUND(SUM(spend)::numeric,6) AS usd
FROM "LiteLLM_SpendLogs"
WHERE metadata->'spend_logs_metadata'->>'agent_id' IS NOT NULL
GROUP BY 1,2,3 ORDER BY usd DESC;
```
> Attribution rows only populate for authenticated requests — activate the master key above.
> Verified live: tagged calls log rows grouped by `agent_id`/`role`/`source`.

**Hard budgets (next, optional):** for *enforced* per-agent caps (not just visibility), mint a
virtual key per agent via `/key/generate` with `max_budget` + `rpm`/`tpm` and use it as that
agent's gateway key. Heavier (key lifecycle); the metadata layer above gives visibility now.

## Other hardening
- **Egress filtering** on the agent sandbox so agent code can only reach the gateway — then a
  leaked gateway key can't phone home.
- **Auto-start**: containers use `restart: unless-stopped`; for boot persistence, launch from
  your scrt4 session at login.
