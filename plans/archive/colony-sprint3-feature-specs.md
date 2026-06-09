# Colony — Remaining Work Feature Specs (PRDs)

Feature specs for everything still outstanding from the Colony 2026 vision, grounded in the
current codebase. Each spec is independently shippable. Specs 1–5 are the Sprint 3 epic
("triggers & autonomy"); 6–7 cover the verification/fidelity loose ends.

Shared context (current state):
- A colony is a one-shot run today: `createColony` → `runColony` (`server/lib/colonyRunner.js`)
  → terminal `done`/`error`. Live events flow over a per-colony bus + resumable SSE.
- Webhooks already exist: `webhook_events` (id, webhook_id, event_type, payload, headers),
  the `webhooks` table (with `context_spec`, `actions_config`), `webhookProjection.js`, and a
  "Take Action" → pipeline path (`server/routes/webhooks.js`).
- Colony columns: `repo_path`, `board_card`, `recipe_id`, `model_plan`, `cloud_enabled`,
  `plan`, `deliverable`, `summary`, `status`. GitHub board access via `githubBoard.js`
  (`fetchRepoBoard`, `detectGitHubRepo`, `postIssueComment`).
- The communication protocol (blackboard, handoffs, gated `mark_goal_achieved`) is in place.

Index:
1. Colony Event Triggers (New Issue / Task / Comment)
2. Empty-Board Task Bootstrap (PM drafts tasks from PRD/README)
3. Per-Colony Webhook Filtering
4. Mid-Run Direction (interrupt & redirect a running colony)
5. Board Work-Item Linkage (restore + extend)
6. Sandbox Repo Access — verification & hardening
7. Full-Context Handoffs (A2A fidelity)

---

## 1. Colony Event Triggers

### Problem
A colony only runs when a person clicks "Launch." Real dev work arrives as events — a new
GitHub issue, a new board task, a new comment on a tracked item. Today none of those start or
feed a colony, so the team can't react to incoming work without a human kicking off every run.
This caps Colony's usefulness as an always-on team and forces manual babysitting.

### Goals
- A connected colony can be **triggered automatically** by New Issue, New Task, or New Comment
  events for its repo, with no human launch step.
- Time from a qualifying event to the colony starting work is **under 1 minute** (excluding model latency).
- Triggered runs are **traceable** back to the source event (event id, type, payload snapshot).
- Zero duplicate runs for the same event (idempotency).

### Non-Goals
- Triggers from non-GitHub sources (Jira, Linear, Slack) — separate initiative; design the
  ingestion generically but only wire GitHub for v1.
- Real-time push from GitHub without the existing webhook relay — reuse `webhook_events`
  ingestion rather than building a new listener.
- Auto-merging or auto-deploying as a trigger outcome — out of scope; deployment stays
  human-gated per the protocol.

### User Stories
- As a developer, I want a colony to start working when I open an issue in its repo so that
  triage/implementation begins without me launching it.
- As a developer, I want a comment like "@hive take a look" on a tracked item to wake the
  colony so that I can hand it follow-up work in context.
- As a team lead, I want each triggered run linked to its source issue/comment so that I can
  audit what the colony did and why.
- As a developer, I want a new board task moving to "Ready" to trigger the colony so that the
  team picks up planned work automatically.
- As an operator (edge case), I want duplicate or replayed webhook deliveries ignored so that
  the same issue isn't worked twice.

### Requirements

**P0**
- A colony stores which event types trigger it (see Spec 3 for the filter config) and a
  reference to the webhook feeding it.
- A new ingestion handler maps a `webhook_events` row to a **colony work item**: resolves the
  target colony(ies) by repo + event-type filter, builds the work input (issue title/body, or
  comment + parent item), and starts a run for it.
- **Idempotency:** each event id is recorded against the colony; re-delivery of the same id is a
  no-op. Acceptance: replaying the same webhook event produces exactly one run.
- The triggered run records `trigger: { event_id, event_type, source_url }` on the colony so the
  UI and deliverable can show provenance.
- Trigger evaluation must not block webhook ingestion (fire-and-forget; ingestion still 200s fast).

**P1**
- Comment-based triggers support a configurable mention/command token (default `@hive`) so
  arbitrary comments don't wake the colony.
- A per-colony "triggers paused" switch so a user can stop automatic runs without deleting config.
- Surfacing the trigger source inline in the colony detail header ("from issue #142").

**P2**
- A lightweight queue so multiple qualifying events for the same colony are processed in order
  rather than spawning concurrent runs (ties into Spec 4's persistent-colony model).
- Generic adapter interface so Jira/Linear can be added later.

### Acceptance Criteria
- Given a colony configured to trigger on New Issue for `acme/api`, when a `webhook_events` row
  of type `issues`/`opened` for `acme/api` is ingested, then exactly one colony run starts within
  1 minute and its record carries the event id + issue URL.
- Given the same event id is delivered twice, then only one run exists.
- Given a comment event without the mention token, then no run starts.
- Given an event for a repo no colony is configured for, then nothing happens and ingestion
  still returns 200.

### Success Metrics
- Leading: % of qualifying events that produce a run (target ≥ 95% within 30 days); median
  event→run latency (< 60s); duplicate-run rate (0).
- Lagging: reduction in manual launches for trigger-eligible repos; operator-reported time saved.

### Open Questions
- Engineering: do triggered runs reuse one persistent colony per repo, or create a fresh colony
  per event? (Recommend persistent colony + work queue — see Spec 4.) **Blocking.**
- Product: default comment token and whether issue *labels* should gate triggering.
- Data: how long to retain the per-colony processed-event log.

### Timeline / Phasing
Depends on Spec 3 (filter config) for routing. Phase A: issue + task triggers (P0). Phase B:
comment/mention triggers + pause switch (P1).

---

## 2. Empty-Board Task Bootstrap

### Problem
When a colony is pointed at a repo that has no issues/board items, the dev team has nothing to
work from — the operator currently has no defined behavior, so the run stalls or improvises.
Many real repos start with only a README/PRD. The team should be able to turn that into a task
list itself.

### Goals
- When a connected repo has **no board items**, the operator reliably directs the PM to produce
  a concrete, ordered task list derived from the repo's PRD/README.
- The generated tasks are **reviewable** by a human before they become work or board items.
- ≥ 80% of bootstrap runs produce a task list a human accepts with minor edits.

### Non-Goals
- Writing tasks back to GitHub as issues automatically without review — gate behind human
  approval (reuse the human-in-the-loop pattern); auto-creation is a P2.
- Inventing product scope beyond what the PRD/README states — the PM summarizes/decomposes, it
  doesn't hallucinate a roadmap.
- Replacing a real product backlog where one exists (only triggers when the board is empty).

### User Stories
- As a developer with a greenfield repo, I want the team to read my README/PRD and propose a
  task breakdown so that I don't hand-write the backlog.
- As a team lead, I want to review and edit the proposed tasks before the team starts so that
  the plan reflects my intent.
- As a developer, I want accepted tasks optionally pushed to my GitHub board so that the rest of
  the team sees them.

### Requirements

**P0**
- Detection: at run start, if `repo_path` is set and `fetchRepoBoard` returns zero cards, the
  run enters "bootstrap" mode.
- The operator prompt path delegates to the PM with the repo's PRD/README content (the sandbox
  repo mount from Spec 6 provides file access; fall back to reading `README.md`/`docs/` via the
  file tools).
- The PM produces a structured task list (id, title, description, acceptance criteria,
  suggested order) written to the blackboard and surfaced in the colony detail.
- Tasks are **proposed**, not executed, until a human accepts (a "Use these tasks" action).

**P1**
- Accepted tasks become the colony's `plan` steps so the normal delivery flow picks them up.
- Optional "Create as GitHub issues" action (reuses `githubBoard` write path; human-triggered,
  like board comments).

**P2**
- Re-bootstrap / refresh when the PRD changes.
- Detect PRD location heuristically (`docs/PRD.md`, `SPEC.md`, etc.) beyond README.

### Acceptance Criteria
- Given a repo with a README and no issues, when the colony starts, then the PM posts a task
  list to the blackboard and the run does not begin implementation until tasks are accepted.
- Given a repo that already has board items, then bootstrap mode does not trigger.
- Given no README/PRD is found, then the operator reports it needs source material instead of
  fabricating tasks (ties to the "not-understood" act).

### Success Metrics
- Leading: % of empty-board runs that enter bootstrap; % producing an accepted task list;
  median tasks proposed per run.
- Lagging: bootstrap → first completed task conversion; user edits-per-task (lower is better).

### Open Questions
- Product: is task acceptance per-task or all-or-nothing? **Blocking for UI.**
- Engineering: file access via sandbox mount (Spec 6) vs reading files server-side — pick one.

### Timeline / Phasing
Best after Spec 6 (repo file access). Phase A: propose to blackboard + accept → plan. Phase B:
push to GitHub issues.

---

## 3. Per-Colony Webhook Filtering

### Problem
You asked to "filter in the webhooks per repo for the colony" at creation. Today webhooks are
global and a colony has no concept of which webhook/events belong to it, so triggers (Spec 1)
have nothing to route on and the creation UI's trigger chips are inert.

### Goals
- At creation, a colony can select a **source webhook** and **which event types** feed it,
  filtered to its repo.
- Trigger routing (Spec 1) has a deterministic config to match events against.
- Config is editable after creation without recreating the colony.

### Non-Goals
- Building a new webhook delivery system — reuse the existing `webhooks` + `webhook_events`.
- Per-event payload transformation beyond the existing `webhookProjection` field-mapping.

### User Stories
- As a developer, I want to pick which repo events start this colony when I create it so that
  only relevant work wakes it.
- As a developer, I want to change the trigger filter later so that I can tune noisy triggers.
- As an operator, I want the colony to ignore events from other repos so that crossed wires
  don't start the wrong team.

### Requirements

**P0**
- New colony field `trigger_config` (JSON): `{ webhook_id, repo, event_types: [...], comment_token? }`.
- `POST /api/colony` and a new `PUT /api/colony/:id/triggers` accept and persist it; `getColony`
  returns it. The creation UI's trigger chips + repo write into this config (replaces today's
  inert chips).
- A list endpoint of available webhooks for the picker (or reuse the webhooks list API).

**P1**
- Validation that the chosen webhook's recent events actually match the repo (warn if mismatch).
- Show, in the colony detail, the active trigger filter and last matched event time.

**P2**
- Auto-create a scoped webhook for the repo if none exists (depends on GitHub app/token scope).

### Acceptance Criteria
- Given creation with webhook W, repo `acme/api`, events `[issue, task]`, when the colony is
  created, then `trigger_config` persists and is returned by `getColony`.
- Given a `PUT` updating event types, then subsequent trigger evaluation uses the new set.
- Given an empty `trigger_config`, then the colony is launch-only (no triggers) — current behavior.

### Success Metrics
- Leading: % of new colonies that configure triggers; mismatch-warning rate.
- Lagging: trigger precision (matched events that were actually relevant).

### Open Questions
- Product: one webhook per colony or many? (Recommend one for v1.)
- Engineering: store `trigger_config` on `colonies` vs a join table for many-webhooks (v1: column).

### Timeline / Phasing
Prerequisite for Spec 1 routing. Ship the config + UI wiring first, then Spec 1 consumes it.

---

## 4. Mid-Run Direction (interrupt & redirect)

### Problem
The colony detail has a direction input, but it only appends to the blackboard — a running
operator won't necessarily read it before the next decision, so users can't actually steer an
in-flight run ("focus on v2 endpoints first," "skip the migration"). `runColony` is a synchronous
loop with no inbound channel.

### Goals
- A user message sent to a running colony is **seen and acted on by the operator within one
  review round** (not just stored).
- Direction can **re-prioritize or halt** the current plan without killing the run.
- Clear feedback that the direction was received and applied.

### Non-Goals
- Token-level interruption of an in-progress model call — inject at round boundaries, not mid-stream.
- Editing a worker's in-flight task — direction goes to the operator, which re-delegates.

### User Stories
- As a developer, I want to tell a running colony to reprioritize so that it works on what
  matters now without a restart.
- As a developer, I want to pause/redirect rather than stop+relaunch so that accumulated context
  (blackboard, handoffs) is preserved.
- As a developer, I want confirmation the operator saw my direction so that I'm not guessing.

### Requirements

**P0**
- A pending-direction queue per colony (DB-backed, e.g. unconsumed blackboard `message` entries
  from `user`, or a `colony_directions` table).
- The runner's outer review loop (`runColony`, between `runAgentOnce` turns) drains pending
  directions and injects them into the operator's `messages` as a high-priority user turn before
  the next round. Acceptance: a direction sent during round N is in the operator's context by
  round N+1.
- The operator prompt instructs it to treat injected user direction as authoritative and adjust
  the plan (`add_plan_step`/`update_plan_step`) accordingly.
- UI shows the direction in the log and a "delivered to operator" state.

**P1**
- "Pause" and "Resume" controls (the run parks between rounds awaiting input).
- Direction targeting a specific role ("tell QA to also test X").

**P2**
- Persisted directions replay if the server restarts mid-run.

### Acceptance Criteria
- Given a running colony, when the user sends direction, then within one outer round the
  operator's messages include it and the UI marks it delivered.
- Given direction "stop after current step," then the operator completes the current step and
  calls `mark_goal_achieved` (subject to the completion gate) rather than continuing.
- Given the run has already completed, then the input is disabled (current behavior).

### Success Metrics
- Leading: direction delivery latency (≤ 1 round); % of directions acknowledged in operator output.
- Lagging: reduction in stop+relaunch cycles; user-reported steerability satisfaction.

### Open Questions
- Engineering: queue via `colony_directions` table vs reuse blackboard `message` entries with a
  consumed flag. (Recommend a small table for clear consume semantics.) **Blocking.**
- Product: should direction be allowed to expand scope, or only re-prioritize/cut?

### Timeline / Phasing
Independent of triggers; can ship standalone. Phase A: inject at round boundary (P0). Phase B:
pause/resume (P1).

---

## 5. Board Work-Item Linkage (restore + extend)

### Problem
The mockup-driven UI rebuild removed the board-item picker, so `board_card` is never set from
the UI anymore. As a result the deliverable's "Post update to #N" write-back (already built) has
no way to obtain a card, and triggered runs (Spec 1) need a first-class way to attach their
source item. Linkage is currently orphaned.

### Goals
- Every colony that works on a specific item has a populated `board_card` again — set manually
  at creation **and** automatically by triggers.
- The board write-back ("Post update to #N") is reachable whenever a card is linked.

### Non-Goals
- Re-adding the full kanban board into the creation flow (the mockup intentionally dropped it) —
  use a compact picker instead.
- Bi-directional board sync (lane moves) — still out of scope.

### User Stories
- As a developer, I want to optionally attach an existing issue/task when I create a colony so
  that its deliverable posts back to the right place.
- As a developer, I want a triggered run to auto-link the issue/comment that started it so that
  provenance and write-back work without manual steps.

### Requirements

**P0**
- A compact "Link a work item (optional)" control in the creation panel: searches/lists the
  connected repo's items (`fetchRepoBoard`) and sets `board_card` — restoring the dropped path
  in mockup-consistent styling (a small searchable list, not the kanban).
- Spec 1 triggers set `board_card` from the source event automatically.
- Acceptance: after linking (manual or triggered), the colony detail shows the "Post update to
  #N" action.

**P1**
- Show the linked item (title, #number, link) in the colony detail header.
- Allow linking/unlinking after creation.

**P2**
- Suggest a likely item based on the goal text.

### Acceptance Criteria
- Given a connected repo with items, when the user links item #142 at creation, then `board_card`
  persists and the deliverable post button targets #142.
- Given a triggered run from issue #200, then `board_card` is set to #200 with no manual step.
- Given no item linked, then the colony runs goal-only (current behavior) and no post button shows.

### Success Metrics
- Leading: % of item-specific runs with a populated `board_card`; board-post usage rate.
- Lagging: fewer "where did the work go" support questions.

### Open Questions
- Design: compact picker pattern (typeahead vs short list) consistent with the new create panel.

### Timeline / Phasing
Small; ship alongside Spec 1 (shares the card-attachment data path). The manual picker can land
immediately to close the regression.

---

## 6. Sandbox Repo Access — verification & hardening

### Problem
Repo mounting (`sandbox.setAgentRepo` + `capabilities()`) is code-complete but unverified — it
couldn't run in CI (no Docker). Before coding agents are trusted to edit real repos, the mount,
isolation, and failure modes need validation and guardrails.

### Goals
- Confirmed: coding workers can read/write the colony repo in the sandbox and run build/test.
- Safe failure when Docker/toolchain is missing (clear message, no silent corruption).
- No accidental edits outside the intended working copy.

### Non-Goals
- Replacing Docker with another runtime.
- Multi-repo mounts in one colony (v1: one repo).

### User Stories
- As a developer, I want coding agents to edit my actual repo and run its tests so that output is
  real, working code.
- As a developer, I want a clear message when Docker isn't running so that I know why coding
  didn't happen.
- As a cautious developer, I want changes confined to a working copy/branch so that my main tree
  is safe.

### Requirements

**P0**
- Integration test on a Docker host: mount resolves, a worker writes a file, runs the project's
  tests, and changes appear in the mounted path.
- Capability preflight already surfaces readiness; verify the "Docker missing" path halts coding
  cleanly (and pairs with the permission breaker rather than looping).

**P1**
- Work on a dedicated branch / working copy rather than the live working tree (configurable).
- Resource caps validated (the existing `--memory`, `--cpus`, `--pids-limit`).

**P2**
- Ephemeral overlay so the original tree is never mutated until a human accepts a diff.

### Acceptance Criteria
- Given Docker is running and a repo is linked, when a coding worker edits and tests, then the
  changes exist in the repo path and test output is captured.
- Given Docker is not available, then the colony logs the capability message and does not retry
  in a loop.

### Success Metrics
- Leading: sandbox-ready rate at run start; coding-task success rate.
- Lagging: human-accepted diff rate from colony coding runs.

### Open Questions
- Product/Security: edit the live tree vs a branch/working copy by default? (Recommend working
  copy.) **Blocking before enabling write on real repos.**

### Timeline / Phasing
Verification first (P0). Working-copy isolation (P1) before promoting to non-experimental.

---

## 7. Full-Context Handoffs (A2A fidelity)

### Problem
The original A2A note specified that a handoff "passes the full conversation history to preserve
context." The shipped `handoff` command object carries a structured payload (summary, contract,
artifacts); worker context persists separately via the per-worker thread map. For complex
handoffs the receiving role may lack relevant prior reasoning.

### Goals
- The receiving agent can access the full upstream context for a handoff when it needs it,
  without bloating every prompt.

### Non-Goals
- Pasting entire transcripts into every delegation by default (token cost, noise).

### User Stories
- As a downstream role (e.g. QA), I want access to the developer's full reasoning/history for the
  handoff so that I can verify against intent, not just the summary.

### Requirements

**P1**
- Persist a reference (`history_ref`) on each handoff record pointing to the upstream worker's
  thread, and a `get_handoff_context(handoff_id)` tool that returns the full upstream history on
  demand (mirrors the webhook `get_webhook_event` escape-hatch pattern).
- The command object includes `history_ref` so the protocol is literally A2A-complete.

**P2**
- Configurable inline-history depth per edge (none / summary / full).

### Acceptance Criteria
- Given a handoff, when the receiving agent calls `get_handoff_context(handoff_id)`, then it
  receives the upstream worker's conversation history.
- Given normal operation, then full history is not injected unless requested (token-efficient).

### Success Metrics
- Leading: rework rate after handoffs (should drop); context-fetch usage.

### Open Questions
- Engineering: where to store thread history durably (currently in-memory `agentHistories`) so a
  `history_ref` survives a restart. **Blocking for durability.**

### Timeline / Phasing
Low urgency; bundle with Spec 4's durability work (both need persisted run context).

---

## Cross-cutting notes
- **Persistent vs one-shot colonies:** Specs 1 and 4 both point toward a colony that lives beyond
  a single run and processes a queue of work (events + directions). Decide this early — it's the
  one architectural choice that ripples across triggers, direction, and history durability.
- **Human-in-the-loop everywhere:** task bootstrap (2), board write-back (5), and external repo
  edits (6) should all reuse the existing approval/gating pattern rather than inventing new ones.
- **Suggested build order:** 3 → 5 → 1 → 2 → 4 → 6 → 7 (config + linkage unblock triggers;
  bootstrap and direction build on triggers/queue; verification and fidelity last).
