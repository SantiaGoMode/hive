# Colony Communication Protocol — Design & Implementation Plan

## Goal

Make the seeded **Development Team** colony agents *collaborate* instead of working in
isolation. Today the dev-team recipe (`server/lib/colonyRecipes.js`) already has the right
roster — Business Analyst → Project Manager → UI/UX Designer → Software Developer → QA
Engineer → DevOps Engineer — but coordination is implicit: each worker emits a free-text
"X handoff" string, the operator delegates with `ask_agent`, and nothing enforces order,
shared state, or review gates.

This plan adds a structured **Communication Protocol** so agents share state, hand off
control, and preserve context predictably. It maps the five protocol pillars onto Hive's
existing in-process colony runtime and exposes them over a REST (A2A/ACP) surface.

> Status: **implemented** in this branch. This document is both the design rationale and
> the change log. File references are to the shipped code.

---

## Where the gaps were

| Pillar | Before | Gap |
|--------|--------|-----|
| Shared context | Global `SHARED.md` (`read_shared`/`write_shared`, `agent_tools` group), **replace** semantics, not colony-scoped. Dev-team workers had `['memory']` / `['sandbox','memory']` — no blackboard access at all. | No per-colony, append-only, multi-agent state log. |
| Handoffs | Free-text "BA handoff" strings; operator delegates via `ask_agent`. | No structured command object, no target/precondition validation. |
| A2A/ACP | Agents export as `.agent.json` (portability), but no machine-readable input/output **contract** the orchestrator can read. | No ID cards, no standardized message envelope. |
| Role flow | Prompt *suggests* BA→PM→…→DevOps. | Order not enforced; no payload contracts. |
| Rules of engagement | `delegatedSteps` guard prevents marking a step done without delegating. | No preconditions, no "not-understood" act, no human-in-the-loop. |

---

## The design

### 1. Shared Context Layer (the "Blackboard")

A new **colony-scoped, append-only** blackboard — distinct from the global `SHARED.md`
notepad. Each row is one entry: `state | blocker | checkpoint | progress | assistance |
message`, attributed to the writing agent.

- Table `colony_blackboard` (`server/db.js`, additive `CREATE TABLE`).
- Helpers `writeBlackboard` / `readBlackboard` in `server/lib/colonyProtocol.js` — **append, never overwrite**.
- Tools (`protocol` group, `server/lib/agentTools.js`): `blackboard_read`, `blackboard_write`, and `checkpoint` (writes a resumable `checkpoint` entry with a `NEXT:` pointer so a fresh agent can pick up if one fails).

### 2. Handoff Mechanisms — command objects + ledger

The coordinating operator still delegates, but specialists now pass control with an explicit
**command object** instead of prose.

- `handoff` tool (`protocol` group). Given `to_role`, `summary`, `payload`, `artifacts`, it
  builds a command object `{ target_agent, from, contract, summary, payload, artifacts }`
  and records it to the `colony_handoffs` ledger.
- The caller's role is inferred from `colonyContext.roleByAgentId` (seeded by the runner), so
  agents don't hand-author their own identity.
- Every handoff — accepted, rejected, or awaiting human — is persisted for audit/resume.

### 3. Standardized Message Protocol (A2A/ACP)

- **A2A ID cards** (`buildAgentCard` / `buildAllCards`): a `.agent.json`-style card per role with
  `schema_version`, `capabilities`, `input_schema`, `output_schema`, `accepts_handoff_from`,
  `hands_off_to`, and ACP `endpoints`. The orchestrator (or any external caller) can read a
  card to know how to talk to a role **without** its internal code.
- **ACP REST conventions** (`server/routes/colony.js`): async, REST-based endpoints for
  discovery, messaging, shared state, and progress (see Touch points).
- **ACP envelope** (`acpEnvelope`) standardizes `request_assistance` and `report_progress`
  messages: `{ acp_version, type, performative, from, to, content, ts }`.

### 4. Role-Specific Handoff Flow

The canonical lifecycle is encoded once in `DEV_TEAM_FLOW` (`colonyProtocol.js`) — order in
the array **is** the lifecycle order, which drives precondition checks:

| From | To | Handoff payload | Gate |
|------|----|-----------------|------|
| Business Analyst | Project Manager | Validated Business Rules & Logic Map | — |
| Project Manager | UI/UX Designer | Prioritized Sprint Plan & Feature list | — |
| UI/UX Designer | Software Developer | Component Specs (Tailwind, accessibility) | — |
| Software Developer | QA Engineer | PR Link & API Documentation | 🔒 human |
| QA Engineer | DevOps Engineer | Test Pass/Fail Report & Stability Grade | 🔒 human |
| DevOps Engineer | Project Manager | Deployment URL or Infra Post-Mortem | — |

The flow, role keys, and contracts are injected into each worker's system prompt
(`protocolPromptBlock`) and into the operator prompt — so prompt text and enforcement never drift.

### 5. Handoff Rules of Engagement

- **Mandatory preconditions** (`checkPreconditions`): a handoff `X→Y` is valid only once every
  earlier edge in the flow has a satisfied handoff on record. This is what stops the Developer
  starting before the BA has validated the logic. A human-gated edge is *not* satisfied until
  approved.
- **The "Not-Understood" act**: `report_protocol_violation` and any rejected `handoff` return a
  standardized `protocol_violation` envelope (`performative: 'not-understood'`) instead of
  hallucinating. The operator prompt instructs resolving the gap rather than forcing the step.
- **Human-in-the-loop**: critical handoffs (final code review → QA; deploy promotion → DevOps)
  are recorded `awaiting_human`. The `handoff` tool returns `requires_human: true` and a HOLD
  message; the run does not advance until a reviewer approves via
  `POST /api/colony/:id/handoffs/:hid/approve`.

---

## Agent roles / connections / integrations — updated & sanity-checked

- **Tools per role** now include the `protocol` group (blackboard + handoff + ACP) for all six
  dev-team roles and the operator. Implementers (Developer/QA/DevOps) keep `sandbox`; analysts
  (BA/PM/UX) keep `memory`. The operator gets `['colony_tools', 'delegation', 'protocol']`.
- **Role keys** (`business_analyst`, `project_manager`, `ui_ux_designer`, `software_developer`,
  `qa_engineer`, `devops_engineer`) are the single shared vocabulary across recipe, flow, cards,
  and the `roleByAgentId` map — no more matching on display names alone.
- **Integrations**: the dev-team flow's payloads align with the existing GitHub board
  integration (`server/lib/githubBoard.js`) — "PR Link & API Documentation" and "Deployment
  URL" are first-class handoff contracts. The connected-MCP search/fetch attachment logic in
  `colonyRunner.js` is unchanged (it targets research workers only). The `research_brief` recipe
  has **no** protocol flow and is unaffected — `hasProtocol()` returns false and all protocol
  surfaces degrade gracefully.

---

## Touch points (file-by-file)

| File | Change |
|------|--------|
| `server/db.js` | **New** tables `colony_blackboard`, `colony_handoffs` + colony-scoped indexes (additive). |
| `server/lib/colonyProtocol.js` | **New.** Flow, role meta, A2A cards, blackboard + handoff helpers, preconditions, ACP envelope, protocol-violation. |
| `server/lib/agentTools.js` | **New `protocol` tool group**: `blackboard_read/write`, `checkpoint`, `handoff`, `request_assistance`, `report_progress`, `report_protocol_violation`; `resolveRoleKey`/`agentLabel` helpers. |
| `server/lib/colonyRecipes.js` | Add `protocol` to all dev-team role tools; `protocolPromptBlock` injected per role; operator prompt enforces flow + gates; role keys surfaced. |
| `server/lib/colonyRunner.js` | Operator gets `protocol`; `roleByAgentId` + `recipeId` passed in `colonyContext`; protocol log/stream events (`handoff`, `protocol_violation`, `blackboard`, `checkpoint`); cleanup of new tables on delete. |
| `server/routes/colony.js` | A2A/ACP REST: `GET /recipes/:rid/flow`, `GET /:id/agents`, `GET /:id/agents/:key/card`, `GET/POST /:id/blackboard`, `POST /:id/acp/messages`, `GET /:id/handoffs`, `POST /:id/handoffs/:hid/approve`. |
| `server/tests/colonyProtocol.test.js` | **New.** 17 tests: cards, preconditions/ordering, human-gate, blackboard append, tool handlers, REST. |

---

## Verification

- `colonyProtocol.test.js` — 17/17 pass: card schema + edges, undefined-edge → `not_understood`,
  developer blocked until BA/PM/UX handoffs exist, human-gated edge unsatisfied until approved,
  blackboard append (not overwrite), `handoff` command object + out-of-order violation + human
  hold, REST flow/cards/blackboard/approval.
- Existing `colonyRoutes`, `colonyCrud`, `colonyHelpers`, `agentTools` suites still pass (46/46)
  — the changes are additive and the protocol gates on `colonyContext.colonyId`.
- Module smoke test: dev-team recipe builds 6 workers with the `protocol` tool, protocol prompt
  blocks, and a flow-aware operator prompt.

> Note: `better-sqlite3` is a native module. Tests were verified by recompiling it for the local
> platform; on the original (macOS) machine `npm test` runs against the prebuilt binary as usual.

---

## Decisions still open (future build phases)

1. **UI surface** — the runner now emits `handoff` / `protocol_violation` / `blackboard` /
   `checkpoint` events on the colony bus, but `client/src/pages/ColonyPage.jsx` doesn't render a
   Handoffs panel or an Approve button yet. Recommend a lifecycle strip + an approval modal that
   calls the approve endpoint.
2. **Auto-resume after approval** — approval currently unblocks preconditions; wiring it to
   automatically re-nudge the operator mid-run (vs. on the next round) is a follow-up.
3. **Protocol for other recipes** — only `development_team` has a flow. `research_brief` could
   get a Researcher→Critic→Synthesizer flow using the same machinery.
4. **External A2A** — cards advertise ACP endpoints; exposing them to *external* agents (auth,
   rate limiting) is out of scope for the local-first v1.
