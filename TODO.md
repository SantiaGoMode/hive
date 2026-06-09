# Hive — Tech Debt & Enhancements TODO

> Single source of truth for outstanding work. Generated from a full-codebase analysis
> (2026-06). Older design docs were moved to [`plans/archive/`](./archive/) to avoid
> confusion — they're historical, not active.

**Legend:** Impact `High/Med/Low` · Effort `S/M/L`

## ⭐ Top priorities (highest leverage)
- [ ] **Security: lock down CORS + add an auth gate** — `app.use(cors())` is wide open and there's no auth/rate-limit; combined with the ngrok tunnel this is an open remote-control surface. `server/index.js:21`, `:60-90`. **High · M**
- [ ] **Audit sandbox path containment** — `routes/sandbox.js` reads/writes by `?path=` under a workspace; confirm no `../` escape + add a containment test. `server/routes/sandbox.js`, `server/lib/sandbox.js`. **High · S**
- [ ] **Unify SSE/stream parsing** — 4+ copies with *inconsistent delimiters* (`split('\n\n')` vs `split('\n')`) = latent bug. Extract one `streamSSE()` util. `Dashboard.jsx:33`, `PipelinesPage.jsx:524/570`, `ColonyPage.jsx:2314`. **High · M**
- [ ] **Route-level code-splitting** — `App.jsx` eager-imports all 11 pages → ~716KB bundle. `React.lazy`+`Suspense` + vite `manualChunks`. `client/src/App.jsx`, `client/vite.config.js`. **High · S**
- [ ] **Stop swallowing errors** — ~145 empty `catch {}` blocks hide failures. Add a `logSwallowed(ctx, err)` helper and route them through it. server-wide. **High · M**

## Server
- [ ] **Split `agentTools.js` (2,413 lines)** into `server/lib/tools/` with a registry (46 handlers + `runAgentOnce` + prompt assembly). **High · L**
- [ ] **Split `colonyRunner.js` (1,488 lines)** — extract prompt builders, deliverable assembly, blackboard digest. **High · L**
- [ ] **Split `routes/colony.js` (775 lines, 30+ endpoints)** into `colony/teams.js`, `colony/runs.js`, etc. **Med · M**
- [ ] **Dedupe chat system-prompt assembly** — built differently in `websocket.js:60-142` and the colony path; extract `buildSystemPrompt(agent, {mode})`. **Med · M**
- [ ] **Structured logging + `/api/system/metrics`** — replace scattered `console.*`; add levels, request ids, active-runs/scheduler/gateway health. **Med · M**
- [ ] **Versioned migrations** — replace 31 bare `try{ALTER TABLE}catch{}` (`db.js:241-271`) with a `schema_version` table + ordered runner. **Med · M**
- [ ] **Cache `getSetting`/gateway config** — re-prepared per request (`providers/index.js:24-29,57-62`); memoize with write-invalidation. **Low · S**
- [ ] **Staff scheduler: backoff + dedupe error posts** — clock-bump-on-error is in (fixed), but add backoff/jitter and suppress repeated identical "Could not generate…" system messages. `staffScheduler.js`. **Med · S**
- [ ] **Unify scheduler lifecycle** — `scheduler.js` + `staffScheduler.js` are two ad-hoc `setInterval` loops; add a registry with heartbeat/last-tick. **Low · M**
- [ ] **Consolidate GitHub token lookup** — `GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_PERSONAL_ACCESS_TOKEN` read in different places; one resolver + `.env.example`. **Med · S**

## Client
- [ ] **Decompose `ColonyPage.jsx` (3,045 lines)** into `pages/colony/*` + a `useColonyStream` hook. **High · L**
- [ ] **Decompose `PipelinesPage.jsx` (997) & `StaffPage.jsx` (916)**. **Med · L**
- [ ] **Shared `<ModelSelect>`** consuming `modelLabels` — model picker/labeling is duplicated across AgentEditor, ChatWindow, ModelBrowser, StaffPage, ColonyPage, SettingsPage. Promote `gateway/hive-*` aliases as recommended. **Med · M**
- [ ] **Shared `<ToolGroupPicker>`** — tool-group UI + hardcoded group list rebuilt in AgentEditor, PipelinesPage, SchedulesPage, ChatWindow. **Med · M**
- [ ] **Add an ErrorBoundary** around `<Routes>` — a throw currently blanks the whole SPA. `App.jsx`. **Med · S**
- [ ] **Accessibility pass** — near-zero `aria-*`/`role`, clickable `<div>`s, no `alt`. Roles/labels, focusable controls, labeled icon buttons. **Med · M**

## Gateway / LLM
- [ ] **Real abort for the Ollama path** — `ai-sdk-ollama` doesn't cancel the HTTP socket (`providers/index.js:184-274`); call Ollama's API directly with an abort signal, or track upstream. **High · M**
- [ ] **Derive gateway alias list** — `GATEWAY_ALIASES` (`listModels.js:93`) hand-mirrors `litellm.config.yaml`; query the gateway `/models` or parse the yaml to avoid drift. **Med · S**
- [ ] **Gateway startup health probe + Settings status** — server boot never verifies the gateway; failures surface only per-request. **Med · M**
- [ ] **Tune response caching** — `ttl:3600` can replay stale identical chat replies for an hour; lower TTL or scope caching to idempotent/pipeline calls. `gateway/litellm.config.yaml`. **Med · S**
- [ ] **Spend persistence + dashboard** — confirm SpendLogs/budgets survive container restarts; surface per-agent spend, budget headroom, cache hit-rate in the UI. **Med · M**
- [ ] **CI lint of gateway model ids** — validate `litellm.config.yaml` pools resolve (catch model deprecations). **Low · S**

## Testing
- [ ] **Test `providers/index.js`** — gateway routing, `gatewayConfig`, key resolution, abort race (currently only adapters are tested). **High · M**
- [ ] **Test `websocket.js` chat loop** — streaming + tool-loop + session-save (0 coverage). **High · M**
- [ ] **Test `staffScheduler.js`** — due-selection, single-speaker cap, clock-bump-on-error. **High · M**
- [ ] **Cover untested libs** — prioritize `pipelineRunner.js`, `sandbox.js`; then githubBoard, colonyTeams, session reader/writer. **Med · L**
- [ ] **HTTP route tests (supertest is already a devDep)** — agents, mcp, pipelines, schedules, staff, system, skills, sandbox, ollama. **Med · L**
- [ ] **Client tests (vitest + RTL)** — none today; start with the extracted SSE util + `<ModelSelect>`; wire a `client` test script. **Med · L**

## DevEx / Ops
- [ ] **Server lint + CI** — client has eslint; server has none, no CI running `npm test`. Add server eslint + a GitHub Actions workflow. **Med · M**
- [ ] **`.env.example` + config docs** — ~18 distinct `process.env` reads, undocumented. **Med · S**
- [ ] **Repo hygiene** — decide tracked-vs-ignored for `PR_BODY.md`, `ISSUE_REVIEW_COMMENT.md`, `CHANGELOG.md`, scratch files. **Low · S**
- [ ] **Gateway auto-start + portable script** — `run-gateway.sh:13` hardcodes an absolute user path in its doc string; document/script the scrt4 launch + optional login auto-start. **Low · S**

## Recently completed (for context — do not redo)
- ✅ scrt4 secret isolation: 0 plaintext secrets at rest; cloud keys via gateway, GitHub/Brave/ngrok via `env:` refs.
- ✅ LiteLLM gateway (Docker): failover aliases, retries/cooldowns, Postgres spend tracking, per-agent budgets, response caching, master-key auth.
- ✅ scrt4 long-running launch fix (`scripts/spawn-detached.sh`, `run-dev.sh`).
- ✅ Client/server audit fixes (gateway models selectable + labeled, `testProvider` auth).
- ✅ Staff-chat starvation fix (clock-bump-on-error).
