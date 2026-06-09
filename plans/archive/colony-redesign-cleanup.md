# Colony Redesign Cleanup — Audit & Enhancement Plan

## Context

The Colony redesign moved from a single generic orchestrator that spawns disposable
workers toward **recipe-seeded, role-separated crews** governed by a structured
[Communication Protocol](./colony-communication-protocol.md). That protocol is now in
place, but the redesign is only half-applied: the old "generic orchestrator + dynamic
`create_agent`" paradigm is still the default backbone, the protocol is invisible in the UI,
and several pre-redesign assumptions linger.

This document audits the remaining legacy concepts and proposes enhancements. The first
sprint (**#1, #2, #4**) is **implemented** in this branch; the rest are scoped for follow-up.

---

## Audit — legacy concepts still embedded

1. **`custom_auto` was the system default**, so the protocol/recipe path never engaged
   unless the UI explicitly chose it. `server/db.js` defaulted `recipe_id` to `'custom_auto'`
   and `routes/colony.js` fell back to it; the UI quietly forced `development_team`
   (`ColonyPage.jsx`). Frontend and backend disagreed about what a colony *is*.

2. **The protocol was invisible in the UI.** The runner emits `handoff`,
   `protocol_violation`, `blackboard`, and `checkpoint` events, but `colonyUtils.js` dropped
   them and there was no Handoffs panel or human-approval control — so the human-in-the-loop
   gate we built was unreachable.

3. **Two competing shared-state mechanisms.** The global `SHARED.md`
   (`read_shared`/`write_shared`, `agent_tools`) coexisted with the new colony-scoped
   blackboard, and the generic orchestrator only had the former.

4. **`MAX_WORKERS_PER_COLONY = 3`** and prompt language like "a colony with one worker is not
   a colony" — relics of the spawn-2-to-3 model, meaningless for a 6-role seeded crew.

5. **Colony agents are full first-class agents** created with `writeAgent(null, …)` every run
   and deleted on colony delete — they leak into the main Agents list and are re-minted each
   run. The redesign implies persistent, reusable *teams*.

6. **Research-centric MCP heuristic** (`colonyRunner.js`): connected MCP tools attach only to
   workers matching `/research/i`, excluding the dev team's Developer/DevOps who would benefit
   from GitHub/filesystem MCP.

7. **One-way, GitHub-only board + a single global repo path.** `colony_repo_path` is one
   app-wide setting; `boardCardToGoal` flattens a card into a string; nothing writes back —
   even though the flow produces "PR Link" and "Deployment URL".

8. **Completion is operator-decided, not protocol-gated.** `mark_goal_achieved` (and the
   `GOAL ACHIEVED:` text sentinel) can fire regardless of whether the handoff flow reached its
   terminal edge. `summary` is a single free-text blob, not a structured deliverable.

9. **Vocabulary drift** — "Operator" (recipe lead) vs "Orchestrator" (generic) vs the UI
   hardcoding "Orchestrator"; `CrewRoster` brittle-regexes `persona_role` to guess the lead.

---

## Enhancements & priority

| # | Enhancement | Status | Effort |
|---|-------------|--------|--------|
| 1 | Render the protocol in the UI: handoff timeline, blackboard panel, violation chips, human-approval button | **Done** | M |
| 2 | Make a recipe the default; demote `custom_auto` to advanced | **Done** | S |
| 4 | Unify colony shared state on the blackboard | **Done** | S |
| 3 | Gate completion on the protocol flow; store a structured deliverable | **Done** | M |
| 5 | Ephemeral colony agents so they don't pollute the Agents list | **Done** | M |
| 6 | Per-colony repo/work-item + board write-back (issue comment) | **Done** | M–L |
| 7 | Attach MCP tools by role need (GitHub → Developer/DevOps), not a research regex | **Done** | S |
| 8 | Worker cap only for custom_auto; robust lead detection | **Done** | S |

---

## What shipped (Sprint 1: #1, #2, #4)

### #2 — Recipe is the default

- `DEFAULT_RECIPE_ID = 'development_team'` added to `colonyRecipes.js` and exported.
- `createColony` default param, the runner's recipe fallback, the `POST /api/colony` route
  fallback, and the `colonies.recipe_id` column default all now point at `development_team`.
- `custom_auto` still works (advanced, open-ended) — it's just no longer the implicit default.
- Tests updated: `colonyCrud` now asserts the `development_team` default; the 27 generic-path
  guard tests in `colonyRunner.test.js` now pass `'custom_auto'` explicitly (they target that
  path on purpose).

### #4 — One shared-state surface inside a colony

- The `custom_auto` orchestrator gains the `protocol` tool group (so generic colonies use the
  same append-only blackboard as recipe crews).
- The generic orchestrator prompt now directs agents to `blackboard_read`/`blackboard_write`
  and to give workers the `protocol` group, instead of leaning on the global `SHARED.md`.
- `SHARED.md` remains for *non-colony* agents (still a legitimate feature); the change only
  unifies coordination *within* a colony.

### #1 — The protocol is now visible and actionable

- **API** (`client/src/lib/api.js`): `getColonyAgents`, `getColonyBlackboard`,
  `getColonyHandoffs`, `approveColonyHandoff`, `getRecipeFlow`.
- **`colonyUtils.js`**: `sseToEntries` and `dbLogToEntries` now translate `handoff`,
  `protocol_violation`, `checkpoint`, and `blackboard` events (live and on replay).
- **`ColonyPage.jsx`**:
  - `LogEntry` renders handoff arrows (with an "awaiting human approval" badge), protocol-
    violation warnings, and checkpoint/blackboard markers inline.
  - **`HandoffsPanel`** — REST-driven (polls while running), shows each command object's
    `from → to · contract` and status, with **Approve / Reject** buttons wired to the
    human-in-the-loop endpoint.
  - **`BlackboardPanel`** — collapsible, polled view of the shared context layer.
- **`colonyRunner.js`** now also emits `protocol_violation` as a live event (not just a DB log
  entry) so it surfaces during a run.

### Touch points

| File | Change |
|------|--------|
| `server/lib/colonyRecipes.js` | `DEFAULT_RECIPE_ID` const + export. |
| `server/lib/colonyRunner.js` | Default recipe fallbacks; `protocol` on the generic orchestrator; blackboard guidance in the generic prompt; live `protocol_violation` events. |
| `server/routes/colony.js` | Route default → `development_team`. |
| `server/db.js` | `recipe_id` column default → `development_team`. |
| `client/src/lib/api.js` | Protocol endpoints. |
| `client/src/lib/colonyUtils.js` | New entry kinds in both converters. |
| `client/src/pages/ColonyPage.jsx` | `HandoffsPanel`, `BlackboardPanel`, `LogEntry` cases, icons. |
| `server/tests/colonyCrud.test.js` | Default assertion → `development_team`. |
| `server/tests/colonyRunner.test.js` | Generic-path tests pin `'custom_auto'`. |

### Verification

- `colonyProtocol` + `colonyCrud` + `colonyRoutes` — 46/46 pass.
- `colonyRunner` guard suites that the default-flip had broken now pass (web_search injection,
  hallucinated-ID guard, backtrack prevention, worker-loop detection, step ordering, duplicate
  names) — 0 failures. (The suite has a pre-existing network/timing test that hangs in the
  Linux CI sandbox; unrelated to these changes.)
- `agentTools` — 0 failures.
- Client: ESLint clean on the changed files. (Full `vite build` can't run in the Linux sandbox
  because esbuild ships a platform-native binary; build on the dev machine as usual.)

---

## What shipped (Sprint 2: #3, #5)

### #3 — Protocol-gated completion + structured deliverable

- `colonyProtocol.flowCompletion(colonyId, recipeId)` — a protocol colony may not complete
  while any critical handoff is `awaiting_human`, or if the handoff flow was never used at all.
  Reaching the terminal edge is reported (`terminal_reached`) but not hard-required, so partial
  missions aren't stalled — they just can't skip the protocol or an unresolved human gate.
- `mark_goal_achieved` now calls the gate for protocol recipes and refuses with a clear reason
  (and `pending_human` list) when it isn't satisfied.
- `colonyProtocol.buildDeliverable(...)` assembles a structured `deliverable` from the handoff
  ledger — summary, `flow_complete`, the handoff trail, and best-effort extracted artifacts/links
  (PR/deployment URLs). Stored in the new `colonies.deliverable` column and returned by
  `getColony`.
- The `GOAL ACHIEVED:` text sentinel is now **disabled for protocol recipes** in the runner —
  those must finish through the gated tool (the sentinel remains a fallback for `custom_auto`).
- UI: the summary card shows a `flow complete` / `partial flow` badge plus clickable links and
  artifacts from the deliverable.

### #5 — Ephemeral colony agents

- New `agents.ephemeral` column. `listAgents()` excludes ephemeral agents by default
  (`{ includeEphemeral: true }` to include); `readAgent` still returns them, so colony internals
  are unaffected and `routes/agents.js` (the Agents page) no longer shows colony workers.
- Recipe workers and the orchestrator are created with `ephemeral: true`; the `custom_auto`
  `create_agent` path marks colony-created workers ephemeral too (and now also gives them the
  `protocol` blackboard group).

### Sprint 2 touch points

| File | Change |
|------|--------|
| `server/db.js` | `agents.ephemeral` + `colonies.deliverable` columns (additive). |
| `server/lib/agentParser.js` | `ephemeral` in rowToAgent; `listAgents({ includeEphemeral })`; INSERT writes the flag. |
| `server/lib/colonyProtocol.js` | `flowCompletion`, `buildDeliverable` (+ exports). |
| `server/lib/agentTools.js` | `mark_goal_achieved` gate + deliverable; `create_agent` marks colony workers ephemeral + protocol. |
| `server/lib/colonyRecipes.js` | Recipe worker configs `ephemeral: true`. |
| `server/lib/colonyRunner.js` | Orchestrator `ephemeral: true`; sentinel disabled for protocol recipes; `deliverable` in `getColony`. |
| `client/src/pages/ColonyPage.jsx` | Deliverable rendering in the summary card. |
| `server/tests/colonyProtocol.test.js` | Gate, deliverable, and ephemeral tests. |
| `server/tests/colonyRoutes.test.js` | Streaming regression test pins `custom_auto`. |

**Verification:** `colonyProtocol` + `colonyCrud` + `colonyRoutes` = 56/56 pass; the runner +
agentTools guard suites pass (web_search injection, worker-loop, create_agent, recipe roster) —
0 failures; client lint clean.

---

## What shipped (Sprint 3: #6, #7, #8)

### #6 — Per-colony repo + board linkage + write-back

- New `colonies.repo_path` and `colonies.board_card` columns. `createColony(goal, model,
  recipe, { repoPath, boardCard })` and the `POST /api/colony` route persist them; the route
  falls back to the global repo path so existing single-repo setups keep working. `getColony`
  returns `repo_path` and the parsed `board_card`. The launch UI sends the selected board card
  and repo path.
- `githubBoard.postIssueComment({ owner, repo, number, body, token })` — the safe, reversible
  half of board write-back (a comment on the linked issue/PR), reusing the existing
  authenticated `githubFetch`. No destructive project-board/lane mutations.
- `POST /api/colony/:id/board/comment` — **human-triggered** write-back. It renders the
  colony's structured deliverable (summary, flow status, links, artifacts, handoff trail) into a
  Markdown comment and posts it to the linked work-item. Resolves the repo from the colony's
  `repo_path` (or the card's `owner/repo`). Keeping it human-triggered fits the protocol's
  human-in-the-loop stance — an autonomous run never mutates an external repo on its own.
- UI: a **"Post update to #N"** button appears on a completed colony that has a linked card.

### #7 — Role-aware MCP attachment

- Replaced the `/research/i` regex with capability classification: `categorizeMcpServer` tags a
  connected server `research` (web/search/fetch) and/or `code` (git/github/filesystem), and
  `mcpCategoriesForWorker` maps each role to the categories it needs (Developer/DevOps → code;
  BA/UX/Researcher → research; PM/critic/synth → none), with a name/role heuristic fallback.
- The runner now attaches matching MCP groups per worker: research MCP still suppresses the
  built-in `web_search`; code MCP is additive to the sandbox. Each gets a tailored prompt note.

### #8 — Worker cap + lead detection

- `MAX_WORKERS_PER_COLONY` is now passed only for `custom_auto`; seeded recipe crews get
  `maxWorkers: null` so the create_agent guard is inert for them (it never applied in practice,
  but the intent is now explicit).
- `CrewRoster` identifies the lead via `colony.orchestrator_id` instead of regex-matching the
  persona-role string.
- Deeper Orchestrator/Operator label unification across utils/UI was left as a cosmetic
  follow-up (cross-file, low value, higher churn risk).

### Sprint 3 touch points

| File | Change |
|------|--------|
| `server/db.js` | `colonies.repo_path` + `colonies.board_card` columns. |
| `server/lib/colonyRunner.js` | MCP categorization helpers + role-aware attachment; `createColony`/`getColony` repo+card; cap only for custom_auto; exports for tests. |
| `server/lib/githubBoard.js` | `postIssueComment` + `githubToken` export. |
| `server/routes/colony.js` | Launch accepts `repo_path`/`board_card`; `POST /:id/board/comment`; comment builder. |
| `client/src/lib/api.js` | `launchColony` opts; `postColonyBoardComment`. |
| `client/src/pages/ColonyPage.jsx` | Launch sends repo/card; board-post button; roster lead via orchestrator_id. |
| `server/tests/colonyProtocol.test.js` | MCP categorization, repo/card storage, board-comment guard tests. |
| `server/tests/colonyRunner.test.js` | Recipe-roster crew-ID regex tolerates the `[role_key: …]` prompt format. |

**Verification:** `colonyProtocol` + `colonyCrud` + `colonyRoutes` = 60/60 pass; the runner's
worker-cap, web_search-injection, and seeded-crew (research_brief) tests pass; client lint clean.

---

## Still open (lower priority)

- **Board lane moves / PR creation** — the write-back is intentionally limited to issue comments.
  Moving GitHub Project lanes or opening PRs autonomously is deferred (needs careful auth + is
  destructive).
- **Vocabulary** — converge fully on "Operator" across runner messages, `colonyUtils`, and the
  live view labels.
- **Per-colony board view** — the launch picker still uses the single global
  `GET /api/colony/project-board`; a per-colony board fetch could use each colony's `repo_path`.

### #6 — Per-colony repo + board write-back
Move `colony_repo_path` from one global app setting to a per-colony field; let the DevOps/PM
roles move board lanes and attach the PR/deployment URL back to the source card via
`githubBoard.js`.

### #7 — Role-aware MCP attachment
Replace the `/research/i` regex with a per-role capability map (e.g. Developer/DevOps →
github/filesystem MCP, Researcher → search/fetch MCP).

### #8 — Cap + vocabulary
Drop/relax `MAX_WORKERS_PER_COLONY` for seeded crews (it only ever guarded runaway
`create_agent`), and converge on one term ("Operator") across runner, utils, and UI; replace
the `CrewRoster` persona-role regex with the explicit role keys the protocol already provides.
