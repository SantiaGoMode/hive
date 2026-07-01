# Hive — Roadmap & Tech-Debt TODO

> Readable companion to the GitHub **Hive Roadmap** project (issues are the source of truth).
> Ordered by execution phase: **P1 first → P4 last**. Each item links its issue, priority, and
> key dependencies. Priority: `🔴 critical · 🟠 high · 🟡 med · ⚪ low`.

Filter on GitHub: `is:issue is:open label:critical`, `label:"priority: high"`, or group the
Roadmap board by the **Phase** field.

---

## ▶ P1 — Security & Reliability (do first)
- [x] 🔴 [#20](../../issues/20) API hardening — lock down CORS, add an auth gate, guard ngrok exposure
- [x] 🔴 [#21](../../issues/21) Audit sandbox path containment (prevent `../` escape)
- [x] 🔴 [#3](../../issues/3) Unified Run Cancellation — *parent of #37*
- [x] 🔴 [#2](../../issues/2) Guided First-Run Agent Setup
- [x] 🟠 [#26](../../issues/26) Stop swallowing errors (~145 empty `catch`) + `logSwallowed()` — *PR #56*
- [x] 🟠 [#37](../../issues/37) Real abort for the Ollama path — *child of #3; PR #58 (stacked on #57)*

## ▶ P2 — Foundations (build the safety net + shared utils before refactoring)
- [x] 🟠 [#5](../../issues/5) Streaming Event Parser library — *PR #62*
- [x] 🟠 [#43](../../issues/43) Test `providers/index.js` — *PR #57*
- [x] 🟠 [#44](../../issues/44) Test `websocket.js` chat loop — *PR #59 (also fixes a tool-round-exhaustion hang)*
- [x] 🟠 [#45](../../issues/45) Test `staffScheduler.js` — *PR #60*
- [x] 🟡 [#24](../../issues/24) Shared `<ModelSelect>` — *PR #63*
- [x] 🟡 [#4](../../issues/4) Shared Tool Configuration component — *PR #64*
- [x] 🟡 [#31](../../issues/31) Structured logging + `/api/system/metrics` — *PR #66; feeds #7*
- [x] 🟡 [#32](../../issues/32) Versioned schema migrations — *PR #78*
- [x] 🟡 [#36](../../issues/36) Consolidate env/config + `.env.example` — *PR #71*
- [x] 🟡 [#46](../../issues/46) Tests for untested libs (pipelineRunner, sandbox, …) — *PR #76*
- [x] 🟡 [#47](../../issues/47) HTTP route tests via supertest — *PR #73*
- [x] 🟡 [#48](../../issues/48) Server eslint + CI workflow — *PR #69; parent of #42*

## ▶ P3 — Refactors (depend on P2 foundations)
- [x] 🟠 [#27](../../issues/27) Split `agentTools.js` (2,413 lines) into a tools/ registry — *PR #79*
- [x] 🟠 [#28](../../issues/28) Split `colonyRunner.js` (1,488 lines) — *PR #82*
- [x] 🟠 [#22](../../issues/22) Route-level code-splitting (~716KB bundle) — *implemented on main*
- [ ] 🟠 [#23](../../issues/23) Decompose oversized client pages — *PipelinesPage done (PR #86); StaffPage + ColonyPage pending*
- [x] 🟡 [#29](../../issues/29) Split `routes/colony.js` (775 lines) — *PR #85*
- [x] 🟡 [#30](../../issues/30) Dedupe chat system-prompt assembly — *PR #84*
- [ ] 🟡 [#6](../../issues/6) Pipeline Builder Refactor — *after #4, #5, #24*
- [x] 🟡 [#25](../../issues/25) Client ErrorBoundary around routes — *PR #80*
- [x] 🟡 [#34](../../issues/34) Staff scheduler backoff + dedupe error posts — *PR #81*
- [x] 🟡 [#38](../../issues/38) Derive gateway alias list (avoid drift) — *PR #83*
- [x] ⚪ [#33](../../issues/33) Memoize `getSetting` / gateway-config reads — *implemented on main*
- [x] ⚪ [#35](../../issues/35) Unify scheduler lifecycle + heartbeat — *implemented on main*

## ▶ P4 — Observability & Polish (last)
- [ ] 🟡 [#7](../../issues/7) Workflow Health Dashboard — *needs #31, #39, #41 (sub-issues)*
- [ ] 🟡 [#39](../../issues/39) Gateway startup health probe + Settings status — *child of #7*
- [ ] 🟡 [#41](../../issues/41) Gateway spend persistence + per-agent dashboard — *child of #7*
- [ ] 🟡 [#40](../../issues/40) Tune response cache TTL / scope caching
- [ ] 🟡 [#8](../../issues/8) Accessible Modal & Form System
- [ ] 🟡 [#10](../../issues/10) Frontend Regression Test Suite
- [ ] ⚪ [#9](../../issues/9) Progressive Advanced Settings
- [ ] ⚪ [#42](../../issues/42) CI lint: validate gateway model ids resolve — *child of #48*
- [ ] ⚪ [#49](../../issues/49) Gateway auto-start + portable `run-gateway.sh`

---

## Dependency quick-reference
- **Shared client utils before page refactors:** #5, #24, #4 → #23, #6
- **Tests before the code they guard:** #43 → #37 · #44 → #30 · #45 → #34, #35
- **Sub-issue rollups:** #7 ← #31, #39, #41 · #3 ← #37 · #48 ← #42

## 🔀 Open PRs (awaiting merge)
- #79 (#27 split agentTools.js). Also open if unmerged: #78 (#32 migrations), #75 (security).
- **P1 + P2 complete.** P3 started: #27 done → next candidates #28 (split colonyRunner.js), #23/#6 (client refactors), #30.

## ✅ Recently completed (do not redo)
- #26 `logSwallowed()` — observable swallowed errors (redaction + rate-limit); 91 call sites across 19 modules.
- #37 Real Ollama abort — direct `/api/chat` streaming with the real `AbortSignal` (Stop now closes the upstream socket).
- #43 / #44 / #45 — provider-dispatcher, websocket chat-loop, and staff-scheduler test foundations (the P2 test trio).
- #5 Shared streaming-event parser (`client/src/lib/streamParser.js`) — deduped six SSE loops; unblocks #23, #6.
- #24 Shared `<ModelSelect>` (`client/src/components/ui/ModelSelect.jsx`) — single picker source via `modelLabels`; gateway promoted; unblocks #23, #6.
- #4 Shared `<ToolPicker>` (`client/src/components/ToolPicker.jsx` + `lib/toolGroups.js`) — deduped Pipelines/Schedules pickers; completes the shared-client-utils trio.
- #31 Structured logger + `/api/system/metrics` (`server/lib/logger.js`) — leveled logs + ring buffer (fed by all 91 `logSwallowed` sites); metrics endpoint feeds #7.
- #48 Server eslint (`eslint.config.js`, `lint:server`) + GitHub Actions CI (`.github/workflows/ci.yml`) — tests/lint/build on push & PR.
- #36 Central config surface (`server/lib/config.js`) + `.env.example` — env inventory, typed accessors, canonical `githubToken()` resolver.
- #47 HTTP route tests (`server/tests/*Routes.test.js` + `helpers/testApp.js`) — supertest coverage for agents/pipelines/skills/schedules/mcp/staff/sandbox/ollama/system (56 tests, externals faked/stubbed).
- #46 Lib unit tests — githubBoard pure helpers, pipelineRunner (groupSteps/renderStepPrompt/abort), colonyTeams CRUD.
- #32 Versioned schema migrations (`server/lib/migrations.js` + `schema_migrations` table) — replaced ~40 bare `ALTER … catch {}` with an ordered, idempotent, recorded runner. **Completes P2.**
- #27 Split `agentTools.js` (2,413 lines) → `server/lib/tools/` (registry + 10 domain modules, all <400 lines) + `agentRunner.js` + a thin `agentTools.js` façade. 46 handlers moved byte-identical; public API + behavior unchanged.
- scrt4 secret isolation — 0 plaintext secrets at rest (cloud keys via gateway; GitHub/Brave/ngrok via `env:` refs).
- LiteLLM gateway (Docker) — failover aliases, retries/cooldowns, Postgres spend tracking, per-agent budgets, response caching, master-key auth.
- scrt4 long-running launch fix (`scripts/spawn-detached.sh`, `run-dev.sh`).
- Client/server audit fixes (gateway models selectable + labeled, `testProvider` auth).
- Staff-chat starvation fix (clock-bump-on-error).
- Repo cleanup + full README rewrite with screenshots.
