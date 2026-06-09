# LLM Gateway Proxy — Secret-Isolation Implementation Plan

## Goal

Stop Hive's own runtime — the node server, its npm dependencies, and especially the
**agent-generated code it executes** (`server/lib/sandbox.js`, `server/lib/colonyRunner.js`) —
from ever holding the real OpenAI / Anthropic / Gemini API keys.

We do this by introducing a **local LLM gateway** (LiteLLM OSS, self-hosted, bound to
`127.0.0.1`) that is the *only* process that ever sees the real provider keys. Hive talks to
the gateway with a **revocable, localhost-only virtual key**. Real keys are injected into the
gateway from the scrt4 vault and never touch Hive's DB, disk, or the AI coding assistant's view.

> Threat addressed: in-process exfiltration by Hive's runtime / dependencies / agent code
> (the one thing scrt4 alone does not mitigate, because scrt4 injects whole-process env).
> Out of scope: GitHub / Brave / ngrok secrets (lower ROI — handled separately by token
> scoping + process isolation, see "Out of scope" below).

---

## Why this fits Hive with minimal change

| Existing fact (verified in code) | Consequence |
|---|---|
| `server/lib/providers/index.js` builds cloud clients with `createOpenAI/createAnthropic/createGoogleGenerativeAI({ apiKey })` and **no base-URL override** | One seam (`getModel`) to point at the gateway |
| Ollama path already uses `createOllama({ baseURL: ollamaBaseUrl() })` | The "local OpenAI-compatible endpoint" pattern already exists in the app |
| `keyFor()` resolves **env → DB → `env:NAME` refs** (`providers/index.js:37`, `secrets.js:10`) | Swapping the credential is a config change, not a rewrite |
| Hive already speaks to Ollama (`:11434`) and LM Studio (`:41343`) locally | A gateway on `:4000` is "just another local endpoint" |
| `server/routes/config.js` centralises `SECRET_KEYS` + `ENV_FALLBACK` | Single place to add the gateway base-URL / virtual-key settings |

---

## Target architecture

```
scrt4 vault (FIDO2, AES-256-GCM)
      │  injects REAL keys into ONE process (ephemeral, scrubbed, never on disk)
      ▼
┌─────────────────────────────┐
│  LiteLLM gateway            │  holds OPENAI/ANTHROPIC/GEMINI keys
│  127.0.0.1:4000             │  OpenAI-compatible /v1  (+ optional native passthrough)
│  runs NO agent code/deps    │  per-key budgets · rate limits · spend tracking
└─────────────▲───────────────┘
              │ virtual key (sk-localonly…, worthless off-box, revocable)
   Hive node server + agents ──► only ever holds the virtual key
```

---

## Key design decision (spike first): how to route the 3 providers

LiteLLM's primary surface is an **OpenAI-compatible** `/v1`. Anthropic/Gemini use native
request shapes, so there are two routing strategies — **Phase 2 is a spike to choose**:

- **Option A — Unified OpenAI-compatible (recommended default).** Route *all* cloud
  providers through `createOpenAI({ baseURL: 'http://127.0.0.1:4000/v1', apiKey: virtualKey })`.
  Configure LiteLLM with provider **wildcard** routing (`model_name: "anthropic/*"`, etc.) so
  Hive's existing prefixed model ids (`anthropic/claude-…`, `openai/gpt-…`, `gemini/gemini-…`)
  pass through unchanged. Lowest moving-part count, most battle-tested path.
  - **Risk to validate:** fidelity of the `thinking`/`reasoning` delta path
    (`providers/index.js:170`). LiteLLM surfaces Anthropic reasoning as `reasoning_content`;
    confirm the AI SDK OpenAI provider maps it to a `reasoning` part, or accept that extended
    thinking is not streamed as a separate channel.

- **Option B — Per-provider native passthrough (higher fidelity, more code).** Keep the
  native SDK clients but override each base URL to LiteLLM's passthrough routes
  (`createAnthropic({ baseURL: '…/anthropic', apiKey: virtualKey })`, Gemini passthrough, etc.).
  Preserves native features (prompt caching, thinking) but depends on passthrough auth/route
  behaviour that must be verified per provider.

**Decision rule:** ship Option A unless the spike shows a streaming/tool/thinking regression
in the colony runtime; fall back to B per-provider only where A regresses.

---

## Phases

### Phase 0 — Prerequisite: fix scrt4 long-running launches (blocks Phase 1)
**This is a standalone bug that exists today and must be fixed before the gateway, which would
otherwise inherit it.** `scrt4 run` has a hardcoded ~10s CLI→daemon HTTP timeout
(`urllib.request.urlopen(req, timeout=10)`); any command running longer is reported as
`scrt4 run failed:` exit 1 while the daemon keeps the disowned process alive — a live-but-"failed"
state. No flag overrides it.
- Add a reusable **detached-launch helper** that backgrounds the long-running process
  (`setsid … & echo $! > pidfile`, logs to a file) and `exit 0`s within the 10s window, so
  scrt4 reports success honestly and we get logs + a clean stop handle.
- Apply it to `run-dev.sh` (fixes the dev server today) and reuse it for `gateway/run-gateway.sh`.
- Add matching `stop-dev.sh` / `stop-gateway.sh` (kill the process group via the pidfile).
- Caveat: the process's own logs go to a file, **not** through scrt4's stdout scrubber — fine
  here because neither the Hive server nor LiteLLM print secret values (they read from env).
- Kill any orphaned dev-server processes left from earlier `scrt4 run failed` attempts.

### Phase 0.5 — Safety & branch
- Create branch `feat/llm-gateway-proxy`.
- Back up `~/.hive/hive.db` (timestamped copy).
- Confirm scrt4 vault has `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (already verified).

### Phase 1 — Stand up the gateway (no Hive changes yet)
- Add `gateway/litellm.config.yaml` — keys via `os.environ/…` (never inlined). Start with
  wildcard routing per provider (Option A).
- Add `gateway/run-gateway.sh` using the **detached-wrapper pattern** (so scrt4's hard ~10s
  CLI timeout doesn't report a false failure): `setsid litellm … & echo $! > pidfile; exit 0`,
  logs to `~/.hive/gateway.log`. Bind `--host 127.0.0.1 --port 4000`.
- Launch via scrt4: `scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] … gateway/run-gateway.sh'`.
- **Verify** with `curl 127.0.0.1:4000/v1/models` and a chat completion through each provider.
  Gateway holds the only copies of the real keys; nothing in Hive changed.

### Phase 2 — Routing spike (decide A vs B)
- Point a throwaway `createOpenAI({ baseURL, apiKey: master/virtual key })` at the gateway and
  exercise: streaming, tool-call surfacing, Anthropic thinking, Gemini. Record fidelity gaps.
- Lock the routing strategy and the model-id ↔ LiteLLM `model_name` mapping.

### Phase 3 — Wire Hive to the gateway
- `server/lib/providers/index.js`:
  - Add `gatewayConfig()` reading new settings `llm_gateway_url` + `llm_gateway_key`
    (env-first via `keyFor`-style resolution).
  - In `getModel()`, when the gateway is enabled, build cloud models via the chosen routing
    (Option A: single `createOpenAI({ baseURL, apiKey })` for all cloud providers; Ollama
    untouched). Keep a feature flag to fall back to direct SDK calls.
- `server/lib/providers/listModels.js`: route discovery through the gateway's `/v1/models`
  (+ existing `FALLBACK` lists). **Tradeoff:** live per-provider model discovery degrades to
  the gateway's configured/wildcard list — accept fallbacks rather than keep a real key in
  Hive just for listing. Document this.
- `server/routes/config.js`: add `llm_gateway_url` / `llm_gateway_key` to the settings surface
  (and `ENV_FALLBACK`); the virtual key is low-value/revocable so DB storage is acceptable,
  but support `env:` refs for consistency.
- Client `SettingsPage.jsx` (Model Providers): add a "Gateway" section (URL + virtual key,
  masked) and a connection test.

### Phase 4 — Remove real keys from Hive (the security payoff)
- Delete the three plaintext rows (`openai_api_key`, `anthropic_api_key`, `gemini_api_key`)
  from `app_settings` in `hive.db` — they now live only in the vault → gateway.
  (Leave `ngrok_authtoken` for the separate scoping track.)
- Verify Hive still streams chat + runs a colony end-to-end with **zero** cloud keys in its
  process env or DB. `keyFor()` for the gateway resolves only the virtual key.

### Phase 5 — Hardening
- **Per-agent virtual keys** with budgets + RPM/TPM caps and short TTLs → attribution and
  fast revocation. (Requires LiteLLM's Postgres `DATABASE_URL` for dynamic `/key/generate`;
  the minimal no-DB setup uses a single static virtual key. Add Postgres only if per-agent
  keys are wanted.)
- **Loopback-only** bind confirmed; never `0.0.0.0`.
- **Egress filtering** on the sandbox so agent code can only reach the gateway, not arbitrary
  hosts (a stolen virtual key then can't phone home; pairs with the gateway being the choke point).
- Gateway as a **managed service**: health check + restart; store LiteLLM `master_key` in the
  vault and inject at launch.

### Phase 6 — Verify, test, document
- E2E: single chat, multi-turn, tool calls, colony run, streaming abort (`providers/index.js`
  abort path), model listing.
- Tests: extend provider/config tests for the gateway code path + the disabled/fallback flag.
- Docs: README section + a `gateway/stop-gateway.sh`; update `run-dev.sh` notes (server launch
  is independent of gateway launch).

---

## Risks & open questions
- **Thinking/reasoning fidelity** under Option A (primary risk — gates the A/B decision).
- **Live model discovery** degrades to fallbacks once real keys leave Hive (accepted tradeoff).
- **Gateway is now critical path** — if it's down, no cloud LLM calls. Mitigated by managed-service
  + health check; Ollama/LM Studio paths are unaffected.
- **Capability misuse ≠ credential theft**: the proxy stops key *theft*, not misuse within a
  token's scope. Budgets/rate limits/TTLs (Phase 5) bound the blast radius.
- **LiteLLM dependency surface**: the key-holding process now trusts LiteLLM's (large) Python
  dep tree. If that surface is unacceptable, the fallback is a ~100-line custom localhost proxy
  with the same Hive-side wiring (Phases 3–6 unchanged). Revisit after Phase 1.

## Out of scope (separate tracks)
- GitHub token → fine-grained / GitHub App installation token given only to the isolated MCP
  process.
- ngrok authtoken → used once at tunnel start; isolate that process.
- Brave key → low value; optional egress-header injection later.

## Files touched (summary)
- New: `gateway/litellm.config.yaml`, `gateway/run-gateway.sh`, `gateway/stop-gateway.sh`
- Edit: `server/lib/providers/index.js`, `server/lib/providers/listModels.js`,
  `server/routes/config.js`, `client/src/pages/SettingsPage.jsx`
- Data: remove 3 plaintext cloud keys from `~/.hive/hive.db` (Phase 4)

> Status: **implemented** on branch `feat/llm-gateway-proxy` (Docker variant — gateway runs
> as a container, not a host venv).
>
> **Done:** Phase 0 (scrt4 detached-launch fix, `scripts/spawn-detached.sh` + `run-dev.sh`),
> Phase 0.5 (branch + `hive.db.bak-phase4`), Phase 1 (`gateway/` Docker stack, launched via
> scrt4, healthy on `127.0.0.1:4000`), Phase 2 (routing spike — **Option A** chosen; all three
> providers route correctly; OpenAI/Anthropic returned account-billing errors, not routing
> errors), Phase 3 (gateway wiring in `providers/index.js` + `listModels.js` + `routes/config.js`
> + `SettingsPage.jsx`), Phase 4 (3 plaintext cloud keys removed from `hive.db`; Hive verified
> routing a real Gemini call with **zero** cloud keys present), Phase 6 (tests in
> `secrets.test.js`, full suite green; `gateway/README.md` + main README).
>
> **Remaining:** Phase 5 hardening — `master_key` (needs `LITELLM_MASTER_KEY` added to the
> vault by the user), per-agent virtual keys (needs Postgres), sandbox egress filtering. See
> `gateway/README.md` → Hardening. Loopback bind + restart policy already done.
>
> **Note:** end-to-end cloud calls for OpenAI/Anthropic need credit on those accounts (the
> spike hit "exceeded quota" / "credit balance too low"); Gemini + Ollama work now.
>
> **Follow-on (reliability/routing, beyond original scope):** the gateway now defines
> capability aliases (`hive-smart`/`hive-coding`/`hive-cheap`/`hive-bigctx`) as multi-provider
> failover pools with `num_retries` + a `retry_policy` (fails billing 400 / quota 429 over) +
> `fallbacks`/`context_window_fallbacks`. Hive emits them via a `gateway/` model prefix
> (`adapters.parseModel`, `getModel`, `listModels`), and `colonyModels.proposeModelPlan` assigns
> aliases per role when the gateway is on. Verified: with OpenAI+Anthropic billing-broken, both
> raw alias calls and `generateText("gateway/hive-smart")` through Hive still succeed via
> failover. See `gateway/README.md` → "Capability aliases & automatic failover".
>
> **Follow-on (cost governance):** the gateway stack now includes **Postgres** (compose
> `postgres` service, not host-published) — LiteLLM ran its prisma migrations and the
> spend/budget/key tables exist (verified). `run-gateway.sh` is now detached (startup waits on
> Postgres health > scrt4's 10s). **Spend logging activates only with the master key** (spend
> attributes to an authenticated key) — one vault step + relaunch, documented in
> `gateway/README.md` → "Spend tracking & budgets".
>
> **Per-agent attribution (wired — metadata headers):** every gateway call is tagged with
> `x-litellm-spend-logs-metadata` (`agent_id`/`agent_name`/`colony_id`/`role`/`source`) via
> `getModel`'s `gatewayHeaders`, threaded from `runAgentOnce` (covers colony/pipelines/
> scheduled/webhooks/staff), the websocket chat loop, and colony operator/memory/planning
> calls. Verified non-breaking (18 unit + colony tests green; tagged call routes + fails over).
> **ACTIVATED & verified live:** `LITELLM_MASTER_KEY` added to the vault; `master_key` enabled;
> gateway + Hive relaunched with it injected. Gateway now requires auth (unauthenticated → 401 —
> the Phase 5 hardening, delivered). Spend rows land in `LiteLLM_SpendLogs` with our metadata under
> `metadata->'spend_logs_metadata'`; the per-agent rollup returns real cost grouped by
> `agent_id`/`role`/`source` (confirmed via both a raw call and `generateText` through Hive's stack).
> Hive authenticates via `LLM_GATEWAY_KEY=$env[LITELLM_MASTER_KEY]` in its launch; MCP/ngrok still
> connect. Not done: *enforced* per-agent budgets (per-agent virtual keys), response caching.
