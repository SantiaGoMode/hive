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
- [ ] 🟠 [#26](../../issues/26) Stop swallowing errors (~145 empty `catch`) + `logSwallowed()`
- [ ] 🟠 [#37](../../issues/37) Real abort for the Ollama path — *child of #3; do after #43*

## ▶ P2 — Foundations (build the safety net + shared utils before refactoring)
- [ ] 🟠 [#5](../../issues/5) Streaming Event Parser library — *blocks #23, #6*
- [ ] 🟠 [#43](../../issues/43) Test `providers/index.js` — *blocks #37*
- [ ] 🟠 [#44](../../issues/44) Test `websocket.js` chat loop — *blocks #30*
- [ ] 🟠 [#45](../../issues/45) Test `staffScheduler.js` — *blocks #34, #35*
- [ ] 🟡 [#24](../../issues/24) Shared `<ModelSelect>` — *blocks #23, #6*
- [ ] 🟡 [#4](../../issues/4) Shared Tool Configuration component — *blocks #23, #6*
- [ ] 🟡 [#31](../../issues/31) Structured logging + `/api/system/metrics` — *feeds #7*
- [ ] 🟡 [#32](../../issues/32) Versioned schema migrations
- [ ] 🟡 [#36](../../issues/36) Consolidate env/config + `.env.example`
- [ ] 🟡 [#46](../../issues/46) Tests for untested libs (pipelineRunner, sandbox, …)
- [ ] 🟡 [#47](../../issues/47) HTTP route tests via supertest
- [ ] 🟡 [#48](../../issues/48) Server eslint + CI workflow — *parent of #42*

## ▶ P3 — Refactors (depend on P2 foundations)
- [ ] 🟠 [#27](../../issues/27) Split `agentTools.js` (2,413 lines) into a tools/ registry
- [ ] 🟠 [#28](../../issues/28) Split `colonyRunner.js` (1,488 lines)
- [ ] 🟠 [#22](../../issues/22) Route-level code-splitting (~716KB bundle)
- [ ] 🟠 [#23](../../issues/23) Decompose oversized client pages — *after #5, #24, #4*
- [ ] 🟡 [#29](../../issues/29) Split `routes/colony.js` (775 lines)
- [ ] 🟡 [#30](../../issues/30) Dedupe chat system-prompt assembly — *after #44*
- [ ] 🟡 [#6](../../issues/6) Pipeline Builder Refactor — *after #4, #5, #24*
- [ ] 🟡 [#25](../../issues/25) Client ErrorBoundary around routes
- [ ] 🟡 [#34](../../issues/34) Staff scheduler backoff + dedupe error posts — *after #45*
- [ ] 🟡 [#38](../../issues/38) Derive gateway alias list (avoid drift) — *related #24*
- [ ] ⚪ [#33](../../issues/33) Memoize `getSetting` / gateway-config reads
- [ ] ⚪ [#35](../../issues/35) Unify scheduler lifecycle + heartbeat — *after #45*

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

## ✅ Recently completed (do not redo)
- scrt4 secret isolation — 0 plaintext secrets at rest (cloud keys via gateway; GitHub/Brave/ngrok via `env:` refs).
- LiteLLM gateway (Docker) — failover aliases, retries/cooldowns, Postgres spend tracking, per-agent budgets, response caching, master-key auth.
- scrt4 long-running launch fix (`scripts/spawn-detached.sh`, `run-dev.sh`).
- Client/server audit fixes (gateway models selectable + labeled, `testProvider` auth).
- Staff-chat starvation fix (clock-bump-on-error).
- Repo cleanup + full README rewrite with screenshots.
