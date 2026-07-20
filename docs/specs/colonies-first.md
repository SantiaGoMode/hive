# Colonies-First: Move Work to the People

**Status:** Implemented v1 with follow-up backlog · **Author:** Cristino Santiago · **Date:** 2026-07-07 · **Updated:** 2026-07-16
**Tagline:** Stop bringing the team to the work. Show the teams; let them pull the work.

---

## 1. Problem Statement

Hive's colony experience is work-first: the operator opens a launch flow, fetches a work item from the project board, types a direction, and configures a run — the colony is effectively launch config attached to the work. This hides the durable value of colonies (identity, crew, memory, track record) and makes every unit of work a manual assembly job for the operator.

The cost: idle colonies are invisible, so capacity goes unused; incoming work (board cards, webhooks, schedules) has no default home, so nothing happens until the operator hand-routes it; and recipes — a rich, first-class catalog — are buried behind a config dropdown instead of acting as the storefront for founding teams. Evidence in the current codebase: the only launch surface is the "Launch a run" panel inside `TeamView`, `handleLaunch` early-returns without a team, and `board_card` is bound to a run at birth rather than routed to a team.

## 2. Goals

1. **Roster is the front door.** The primary screen shows all colonies (and foundable recipes) with live status. Success: operator can answer "who's idle and who's working?" in one glance, zero clicks.
2. **Work flows to colonies.** ≥80% of runs originate from a colony's queue (claimed/assigned items) rather than ad-hoc launch-form assembly, within 30 days of shipping.
3. **Idle capacity becomes visible and actionable.** Every idle colony surfaces suggested work; time-from-work-arrival to run-start drops measurably (target: median < 5 min for auto-matched items with standing orders, vs. "whenever the operator gets around to it" today).
4. **Recipes become the hiring hall.** Founding a colony from the catalog takes ≤ 3 inputs (recipe, name, repo). Catalog recipes are browsable on the roster, not hidden in a modal dropdown.
5. **Operator stays the decider.** No run starts without an explicit operator action or a standing order the operator authored. (Consistent with the existing operator-in-the-loop philosophy.)

## 3. Non-Goals

- **Autonomous work claiming without authorization.** Colonies never self-start work outside an operator-defined standing order. Out of scope because it violates the operator-decided model.
- **Cross-colony work marketplace / bidding.** Colonies don't compete or negotiate for items. Matchmaking is suggestion-only. Too complex for v1; single-operator installs don't need it.
- **Replacing pipelines, agents, or the project board.** Standalone agents, pipelines, and the board remain as-is; this spec only changes how board/webhook/schedule work reaches colonies.
- **Renaming or migrating the `colonies` table.** The runs-table naming debt is real but orthogonal; touching it now adds migration risk with no UX payoff. (Parking lot.)
- **Multi-operator / permissions.** Queues and standing orders are single-operator in v1.

## 4. Concept Model

```
Recipe (catalog, static)
   └─ founds ─▶ Colony (persistent team: crew, memory, charter, capacity)
                   ├─ Work Queue (assignments: proposed → queued → claimed)
                   │      ▲
                   │      └── Work Sources: board cards, webhooks, schedules, manual
                   ├─ Standing Orders (durable routing rules, operator-authored)
                   └─ Runs (execution of a claimed item; existing `colonies` rows)
```

The inversion in one sentence: today `work item → configure run (team as context)`; target `colony → queue → claim → run (work as input)`.

## 5. User Stories

Persona: **Operator** — the human running a Hive install, managing multiple AI teams.

**P0**

- As an operator, I want my home screen to be a roster of my colonies with live status (idle / working / blocked, current run, queue depth) so that I manage teams, not launch forms.
- As an operator, I want to open a colony and see its identity first — crew, capabilities, memory, recent output — with its work queue alongside, so that giving it work feels like assigning to a team, not configuring a job.
- As an operator, I want to add work to a colony's queue (from the board, or free-form) and have the colony start it on my go, so that launching is "give them work," not "assemble a run."
- As an operator, I want incoming work (new board cards, webhook events) to appear as *proposed* items in the best-matching colony's queue so that routing is one approval, not a manual assembly.
- As an operator, I want to found a colony from a catalog recipe in one flow (recipe → name → repo) so that the catalog acts as a hiring hall.

**P1**

- As an operator, I want to write standing orders ("own the `security` label in repo X") so that matching work queues automatically and starts without me touching it.
- As an operator, I want to see and adjust a colony's capacity (serial vs. N parallel runs) so that queued work drains at the pace I choose.
- As an operator, I want to reroute a queued item to a different colony so that a bad match is a drag, not a delete-and-recreate.

**Edge cases**

- As an operator, I want unmatched incoming work to land in a visible "Unrouted" tray so that nothing silently disappears.
- As an operator, I want a colony with an empty queue to show suggested work from its repo's board so that idle teams prompt me instead of sitting blank.
- As an operator, I want deleting a colony to release (not delete) its queued items back to Unrouted so that work survives team changes. (Runs keep existing cascade behavior.)

## 6. Requirements

### P0 — Must Have

**R1. Colony Roster (new home for the feature).**
Route `/colony` becomes a roster: one card per colony showing name, recipe identity, crew avatars, status (idle / working / blocked / backed-up), current run title, queue depth, last-shipped artifact. Catalog recipes render as "foundable" ghost cards in a secondary section or tab.
*Acceptance:*
- [ ] Roster shows every `colony_teams` row with live status derived from its runs
- [ ] Status updates live via existing SSE/WS without full refresh
- [ ] Ghost cards: clicking a catalog recipe opens Found-a-Colony (R5)
- [ ] Empty state: no colonies → roster is the recipe catalog with "found your first colony" framing

**R2. Colony Home = team room.**
`/colony/:teamId` reorders around identity + queue. Panels: (a) Crew (staff profiles for the team's recipe), (b) Charter (description, repo, standing orders in P1), (c) Work — queue with proposed/queued/claimed states, (d) History (runs, artifacts, memory). The "Launch a run" form is removed as a headline; its inputs (direction, model, model plan) move into the "Start" step of a queue item.
*Acceptance:*
- [ ] Opening a colony shows crew + status above any launch affordance
- [ ] "Give them work" affordance adds an item to the queue (board picker or free-form direction)
- [ ] Starting a queued item collects/edits direction + model plan, then launches (reuses `handleLaunch` path with `team_id`)
- [ ] Given a queued item, when the operator hits Start, then a run is created linked to both the team and the queue item

**R3. Work Queue entity (the schema addition).**
New table `colony_work_items`: `id, team_id (FK colony_teams), source ('board'|'webhook'|'schedule'|'manual'), source_ref (e.g. board card id / webhook event id), title, direction, status ('proposed'|'queued'|'claimed'|'done'|'dismissed'), run_id (FK colonies, nullable), match_reason, created_at, updated_at`. Runs gain nothing; the queue item points at the run it became.
*Acceptance:*
- [ ] Migration adds table; no changes to `colonies` or `colony_teams` columns
- [ ] `board_card` on the run is still populated at launch (backward compatible) but sourced from the claimed queue item
- [ ] Deleting a team sets its non-done items to `team_id = NULL` (Unrouted) rather than deleting them
- [ ] API: CRUD under `/api/colony/teams/:teamId/queue` + `POST .../queue/:itemId/start`

**R4. Intake & matchmaking (suggestion-only).**
When a board card is created/labeled or a webhook event arrives, Hive proposes a destination colony: match on repo (`repo_path`), recipe category vs. card labels, and crew skills. The item lands as `proposed` in that colony's queue; no match → Unrouted tray on the roster.
*Acceptance:*
- [ ] Given a new card in a repo owned by exactly one colony, then it appears as `proposed` in that colony's queue with a `match_reason`
- [ ] Given no matching colony, then the item appears in Unrouted
- [ ] Proposed items never start runs on their own (P0 has no standing orders)
- [ ] Operator can accept (→ queued), dismiss, or reroute a proposed item

**R5. Found-a-Colony from the catalog.**
From a roster ghost card: recipe (pre-filled) → name → repo path → optional toggles (cloud, github writeback) → Found. Reuses `TeamConfigModal` guts with the recipe locked.
*Acceptance:*
- [ ] ≤ 3 required inputs; team created via existing teams API
- [ ] New colony appears on roster immediately, idle, with suggested work if its repo's board has open cards

### P1 — Nice to Have

**R6. Standing orders.** Per-colony rules: `{source filter (label/repo/webhook), action: propose | queue | queue+autostart}` with autostart requiring explicit per-rule opt-in. Reuses existing webhook/trigger and scheduled-run plumbing, re-homed to the team instead of per-run config.
**R7. Capacity.** `max_concurrent_runs` on the team (default 1); queue drains respecting it; roster shows "backed up" when queue depth > threshold.
**R8. Reroute.** Move a queue item between colonies, preserving history (`match_reason` appends).
**R9. Idle-colony suggestions.** Empty queue → show top open board cards for the colony's repo as one-click "propose to me" items.

### P2 — Future Considerations (design-for, don't build)

- **Multiple colonies per recipe with load rules** (round-robin routing). Keep matchmaking pluggable.
- **Cross-repo colonies** (a team owning several repos). Keep `repo_path` matching isolated in one module.
- **Runs-table rename** (`colonies` → `runs`). Queue table already uses `run_id` naming to ease this later.
- **Colony-to-colony handoffs** (one team's deliverable enqueues work for another).

## 7. Success Metrics

**Leading (evaluate 2–4 weeks post-ship):**
- % of runs launched from a queue item vs. legacy path — target ≥ 80%
- % of incoming board cards/webhook events auto-proposed to a colony (match rate) — target ≥ 70%, with Unrouted tray < 10% lingering > 48h
- Time from work arrival → run start, median — target < 1 day manual, < 5 min with standing orders (P1)
- Colonies founded from catalog ghost cards — target ≥ 1 new colony per active install in first month

**Lagging (evaluate 1 quarter post-ship):**
- Runs per colony per week (throughput) trending up vs. pre-inversion baseline
- Share of colonies with > 1 completed run (teams being *reused*, the whole point) — target ≥ 75%

Measurement: derive from `colony_work_items` + `colonies` timestamps; no external analytics needed.

## 8. Open Questions

1. **Blocking (product):** Does the roster replace `/colony` outright, or ship behind a toggle with the legacy launch panel intact for one release? *Owner: Cristino.* Recommendation: replace outright — single-operator product, low blast radius, and the legacy `POST /api/colony` path stays for tests/webhooks either way.
2. **Blocking (product):** Should "Hive-TaskMaster" (the backfill default team) appear on the roster like any colony, or be styled as a legacy/system team? *Owner: Cristino.*
3. **Non-blocking (eng):** Where does matchmaking run — inline in the board/webhook route handlers, or a small router module both call? Recommendation: `server/lib/workRouter.js`, called from both, to keep P2 pluggability.
4. **Non-blocking (eng):** Does the free-form "Direction" live on the queue item (`direction` column, as specced) or stay launch-time-only? Specced as: stored on the item, editable at Start.
5. **Non-blocking (design):** Roster card density — how much live run detail before cards need a compact mode? Resolve during mockups.

## 9. Timeline & Phasing

No hard deadline. Suggested phasing keeps each slice shippable:

- **Phase 1 — Roster + Found (R1, R5).** Pure re-skin of existing data; no schema change. Home screen inverts immediately.
- **Phase 2 — Queue + team room (R2, R3).** The schema addition and the new launch path. Legacy launch panel removed at the end of this phase.
- **Phase 3 — Intake/matchmaking (R4).** Board + webhook routing into queues; Unrouted tray.
- **Phase 4 (P1) — Standing orders, capacity, reroute, suggestions (R6–R9).**

Dependencies: none external. Internal touchpoints: `client/src/pages/colony/{views,useColonyPage}.jsx`, `client/src/App.jsx` routing, `server/routes/colony/{teams,lifecycle,meta}.js`, `server/lib/{colonyTeams,colonyRecipes,recipeCatalog}.js`, new `server/lib/workRouter.js`, migration in `server/lib/migrations.js`. Note: server tests can't run in the Cowork sandbox (native sqlite) — verify migrations locally.

---

*Parking lot: runs-table rename; colony marketplace/bidding; multi-operator permissions; cross-colony handoffs.*
