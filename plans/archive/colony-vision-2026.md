# Colony Vision 2026 — Epic Plan

The Colony redesign so far gave us recipe-seeded crews, the A2A/ACP communication
protocol, gated completion, ephemeral agents, per-colony repo + board write-back, and
role-aware MCP. This epic takes Colony from "runs a seeded crew" to "an operator-led team
that picks up real work from a repo and ships it." It captures the user's June 2026 vision
and sequences it into logical sprints.

Decisions locked with the user:
- **Models:** the operator proposes a per-role model plan; the user can override before launch.
- **UI:** mockup-first — the redesigned Colony page is approved as a mockup before any UI code.
- **Sequencing:** plan everything, then build in logical steps.

---

## Vision → change map

| # | User's thought | Concrete change | Sprint |
|---|----------------|-----------------|--------|
| 1 | Colony tab shows existing colonies / create new, like the Pipelines default page; current UI disliked | Rebuild Colony page as list + detail; new creation flow | 4 (UI) |
| 2 | A colony is run by an operator | Already true (recipe Operator). Make the operator the explicit owner of provisioning + lifecycle | 1 |
| 3 | Operator sets all models at the start after reasoning about needs | Operator proposes a per-role model plan; user can override; workers seeded per-role | 1 |
| 4 | Given a repo with no task board, operator assigns the PM to create tasks from the PRD/README | "Bootstrap tasks" flow: detect empty board → PM reads PRD/README → emits tasks | 3 |
| 5 | Colony actions triggered by: New Issue, New Task, New Comment, or in-UI user direction | Event-trigger layer over webhooks + an in-colony direction input | 3 |
| 6 | On a tooling-permission error, stop retrying and tell the user what to enable + how | Permission circuit-breaker: detect, halt, surface one actionable message | 2 |
| 7 | Coding agents get coding rules/guidelines (June 2026 guidance) so they don't use exotic libs | AGENTS.md-style ruleset injected into coding roles; honor repo's own AGENTS.md | 2 |
| 8 | Colony model list is limited; match what's installed/available | Picker uses the all-provider `/models` endpoint, not Ollama-only | 1 |
| 9 | Button to enable cloud models at creation; operator knows it can use cloud when provisioning | `cloud_enabled` toggle on creation; local-only gating when off | 1 |
| 10 | Webhook configuration in colony creation — filter webhooks per repo for the colony | Per-colony webhook filter config wired to the existing webhooks feature | 3 |
| 11 | Sandbox has enough access/ability to do the coding | Mount the colony's repo into the sandbox; verify toolchain; capability preflight | 2 |

---

## Current-state grounding (where each hooks in)

- **Model picker** (`client/src/pages/ColonyPage.jsx`) calls `api.getModels()` → `/ollama/models`
  (local only). The app already has `api.getAllModels()` → `/models` returning all providers
  grouped (`{ ollama, anthropic, openai, gemini }`, each `{id, provider, name, source}`), plus
  `api.testProvider(p)`. Cloud lists fall back to curated ids when no key is set. → #8/#9.
- **Worker model** is a single `row.model` for the whole colony; `buildRecipeWorkerConfigs`
  stamps it on every role. → #3 needs a per-role plan.
- **Sandbox** (`server/lib/sandbox.js`) is Docker, mounting `~/.hive/agents/{id}/sandbox` →
  `/workspace`. Image (`Dockerfile.sandbox`) has Python 3.11, Node 20, git, build-essential,
  sqlite3, common libs. The colony's actual `repo_path` is **not** mounted. → #11.
- **Webhooks** (`server/routes/webhooks.js`, `webhook_events`, `webhookProjection.js`) ingest
  events and can "Take Action" via pipelines today. → #5/#10 reuse this pipeline.
- **Permission/tool errors** surface as `{ error }` from tool handlers; the runner has a
  duplicate-call breaker but no permission-specific halt + user message. → #6.

2026 coding-agent guidance (for #7): the de-facto standard is an explicit `AGENTS.md` ruleset
read natively by major agents; rules must be explicit, pin known libraries/patterns, forbid
exotic deps and outdated APIs, and require tests + review. Honor a repo's own `AGENTS.md` when
present. Sources at the end.

---

## Sprint plan

### Sprint 1 — Model system & operator provisioning  *(shipped — backend)*
Foundation for everything else.
- **Cloud toggle:** `colonies.cloud_enabled` (default off). `colonyModels.gateModel/gatePlan`
  reject cloud model ids when off — at the launch route (400) and again at runner preflight.
- **Per-role model plan:** `colonies.model_plan` (JSON role_key → model). `buildRecipeWorkerConfigs`
  takes the plan and seeds each worker with `resolveRoleModel(plan, role, fallback)`; the operator
  runs on `plan.operator`. The runner preflights every distinct model in the plan.
- **Operator proposes, user overrides:** `POST /api/colony/propose-models` returns a per-role plan
  via `colonyModels.proposeModelPlan` — a transparent heuristic that ranks the available pool
  (cloud flagships first when enabled; locally, bigger params + coder variants; coding roles get
  the coder model). Returns the editable plan + the allowed pool. `POST /api/colony` accepts
  `cloud_enabled` + `model_plan`; `api.proposeColonyModels`/`launchColony` opts are wired client-side.
- New: `server/lib/colonyModels.js`. **UI for the picker/plan editor lands in Sprint 4** (the
  current picker still uses the Ollama-only list until the redesign is approved).
- *Verified:* 68/68 on protocol/crud/routes suites incl. new model tests; runner seeded-crew +
  worker-cap + web_search + hallucinated-ID tests pass.

### Sprint 2 — Coding readiness  *(shipped — backend; UI banner in Sprint 4)*
- **Coding guidelines / AGENTS.md ruleset:** `server/lib/codingGuidelines.js` injects an explicit
  2026 ruleset into coding roles (`software_developer`, `qa_engineer`, `devops_engineer`) — use the
  existing stack, no new/exotic deps, no deprecated APIs, scoped diffs, write+run tests. The runner
  reads the repo's own `AGENTS.md`/`CONTRIBUTING.md`/`.cursorrules` when `repo_path` is set and
  prepends it as authoritative.
- **Sandbox repo access:** `sandbox.setAgentRepo(agentId, repoPath)` mounts the colony's repo as a
  coding worker's `/workspace` so it edits the real project; `sandbox.capabilities()` reports Docker
  + image readiness, surfaced as a colony preflight log line. (Docker paths are integration-verified
  on a Docker host; the CI sandbox can't run Docker.)
- **Tooling-permission circuit-breaker:** `isPermissionError` classifies permission/auth failures;
  on the first hit the agent gets one actionable instruction and a `permission_required` event +
  Blackboard `blocker` are emitted; a second hit on the same tool short-circuits (no retry loop).
  Rendered inline in the colony log now; the dedicated banner lands with the UI.
- *Verified:* 74/74 on protocol/crud/routes (incl. coding-guidelines, permission-classifier, and
  LLM-proposer tests); 7/7 targeted runner tests; client lint clean.

### Proposer upgrade — operator actually reasons  *(shipped)*
`POST /api/colony/propose-models` now calls `colonyModels.proposeModelPlanLLM`: the strongest
available model reasons (via `providers.generateText`, 30s timeout) over the goal + roles + allowed
pool and returns a per-role JSON plan. Every pick is validated against the pool + cloud gate and any
invalid/missing role is repaired from the heuristic, so the result is always launchable; on any
error/timeout it falls back to the heuristic entirely (`source: 'operator' | 'heuristic'`).

### Sprint 3 — Triggers & autonomy
- **Per-colony webhook filter config:** at creation, choose which webhook(s)/repo events feed
  this colony (filter by repo + event type), persisted on the colony.
- **Event triggers:** New Issue / New Task / New Comment route to the colony as a new work item
  (reusing webhook ingestion + projection); plus an **in-UI direction input** to message the
  running colony directly.
- **Empty-board bootstrap:** when a connected repo has no tasks, the operator directs the PM to
  read the PRD/README and emit a task list (written back as issues/board items, human-gated).

### Sprint 4 — UI redesign  *(rebuilt to match the approved mockup)*
The Colony page was rebuilt: header "Colony" + "New colony"; a left **colonies list rail** + a
**main pane** that shows either the creation panel or the colony detail (Pipelines-style
list+detail). The old top-banner form and the kanban `ProjectBoardPanel` were removed.
- **Creation panel:** team preset + seeded-role chips; repository input + Connect + detected
  GitHub-slug chip + "no task board → PM drafts tasks" hint; **trigger-event chips** (New issue /
  task / comment) with a per-repo filter label; **cloud-enable toggle**; **operator-proposed,
  editable per-role model plan** (all-provider grouped model list); initial-direction textarea;
  Launch. Launch sends `cloud_enabled` + `model_plan`.
- **Detail pane:** plan checklist, handoffs (+human approve), blackboard, deliverable (+post to
  board), permission-required line, and a **direction input** that posts to the colony blackboard.
- **Still backend-pending (Sprint 3):** the trigger chips select intent but only activate once
  webhook triggers exist; the direction input currently writes to the blackboard (real, but the
  full "interrupt/redirect the run" behavior comes with Sprint 3).
- *Verified:* ColonyPage lints clean. Full visual render needs `npm run dev` on a machine with
  Node (esbuild/vite can't run in the CI sandbox).

---

## Verification approach
Each sprint ships with tests in `server/tests/` and a client lint pass. Model gating, the
per-role plan, the propose endpoint, the permission breaker, and webhook filtering are all
unit-testable against the in-memory DB + supertest harness already in use. Sandbox repo
mounting is integration-verified on a machine with Docker (the CI sandbox can't run Docker).

## Sources (2026 coding-agent guidance)
- [Coding guidelines for AI agents (and people too) — Stack Overflow](https://stackoverflow.blog/2026/03/26/coding-guidelines-for-ai-agents-and-people-too/)
- [AGENTS.md complete guide for engineering teams (2026)](https://blog.buildbetter.ai/agents-md-complete-guide-for-engineering-teams-in-2026/)
- [6 best practices for coding with AI agent platforms (2026) — Zencoder](https://zencoder.ai/blog/best-practices-for-coding-with-ai-agent-platforms)
- [Standardize AI code generation across your team — IBM](https://www.ibm.com/think/insights/standardize-ai-code-generation-across-your-development-team)
