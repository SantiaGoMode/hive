# Development & Testing Plan

## Issue

- Repository: SantiaGoMode/hive
- Issue: #2 - [Phase 1: Core Activation] Guided First-Run Agent Setup
- Issue URL: https://github.com/SantiaGoMode/hive/issues/2
- Labels: enhancement, frontend, ux, roadmap, critical
- Assignees: none
- Milestone: V1.1 Critical Fixes
- Date: 2026-04-25

## Project Context

- Project: Hive Roadmap (`PVT_kwHOAqDdC84BVnLm`)
- Project item: `PVTI_lAHOAqDdC84BVnLmzgq7N4E`
- Current status: Backlog (`f75ad846`)
- Target status flow: Backlog -> In Progress -> Review
- Sprint / iteration: not set on the project item
- Priority: not set on the project item
- Linked branches: `codex/issue-2-guided-first-run-agent-setup`
- Linked PRs: none found for issue #2 during intake; `gh pr list --search "#2"` only returned unrelated merged PR #13 for issue #1
- Notes: local worktree has untracked `ISSUE_REVIEW_COMMENT.md`, `PR_BODY.md`, and `plans.md`; these appear unrelated to this issue and will be preserved unless explicitly needed.

## Requirements Summary

Users who pull their first local model should be guided directly into creating or using a starter agent and reaching a first successful chat. The current app has a basic first-run onboarding screen when there are no models and no agents, but after a model pull it only refreshes state and returns users to the Agents view. It does not create a starter agent, open the Agent Editor prefilled with the selected model, explicitly test the Ollama connection, or provide strong empty-state CTAs from Models to Agents to Chat.

The requested deliverables are:

- A guided path from no models/no agents to first chat.
- Less confusion after a model is installed but no agent exists.
- Better empty states across Agents and Models.
- Contextual, brief local-first setup copy.

## Technical Approach

Implement a small guided first-run flow around the existing React pages and agent/model APIs rather than introducing a new route or backend domain. The likely product shape is:

- Add an explicit Ollama connection check using a lightweight server endpoint that validates the configured Ollama URL and reports a clear status.
- Update the existing onboarding screen in `Dashboard.jsx` so a successful starter model pull offers the next step immediately: create a starter agent with that model or open `AgentEditor` prefilled with that model.
- Prefer auto-creating a starter agent from a conservative default template when possible, then route directly to `/chat/:agentId` so the user can send their first message.
- Add empty-state CTAs for the installed-model/no-agent state on Agents and for installed models on Models so users can create an agent using a chosen model.
- Keep existing `AgentEditor` behavior intact for normal create/edit flows, while adding optional initial values or a first-run variant where needed.
- Preserve the local-first tone with concise, action-specific copy and avoid adding a marketing-style landing page.

## File Changes

- `server/routes/ollama.js`: add a `GET /api/ollama/status` or equivalent check that verifies Ollama reachability and returns the configured URL, reachable state, and useful error text.
- `client/src/lib/api.js`: add a client helper for the Ollama status check.
- `client/src/pages/Dashboard.jsx`: expand first-run onboarding, handle model-pull completion, create or prefill a starter agent, route to chat, and improve no-agent empty states.
- `client/src/components/models/ModelBrowser.jsx`: add CTAs from installed models and post-pull completion toward starter agent creation or Agent Editor prefill.
- `client/src/components/agents/AgentEditor.jsx`: accept optional initial form values such as a selected model and starter template defaults, while preserving edit behavior.
- `client/src/stores/agentStore.js`: reuse existing `createAgent`; no store shape change expected unless routing needs the created agent returned from a shared helper.
- `server/tests` and/or `client/src/**/*.test.*`: add focused coverage for the Ollama status endpoint and any factored onboarding helper logic.
- `verification/`: capture screenshots for first-run, model-installed/no-agent, and first-chat states after implementation.

## Development Phases

1. Backend connection check
   - Add a status endpoint for Ollama reachability.
   - Keep error messages stable and safe for UI display.
   - Verification: focused backend route test and full backend test subset.

2. Starter agent creation path
   - Add a reusable starter agent payload based on the selected model.
   - On successful pull from onboarding, create the starter agent or open the editor prefilled with the model if auto-create fails.
   - Route successful creation to `/chat/:agentId`.
   - Verification: client tests for helper behavior where practical and manual flow through the UI.

3. Empty-state CTAs
   - Improve Agents empty states for no-model/no-agent and model-installed/no-agent cases.
   - Improve Models page installed-model rows and no-model state to guide users toward Agents and Chat.
   - Verification: responsive visual checks for desktop and mobile widths.

4. Contextual local-first copy
   - Add concise Ollama status copy where users act on it.
   - Avoid duplicating setup text across every screen.
   - Verification: manual copy pass and screenshot review.

5. End-to-end verification
   - Exercise no models/no agents, model pull success, Ollama unreachable, installed models/no agents, starter agent creation, and first chat routing.
   - Capture screenshots under `./verification/`.
   - Run backend tests, client tests, and lint where practical.

## Test Map

| Area | Command / Steps | Expected Result |
| --- | --- | --- |
| Backend | `npm test` or focused `node --import ./server/tests/setup.js --test server/tests/<ollama-status>.test.js` | Ollama status endpoint returns reachable/unreachable JSON without crashing. |
| Client unit | `npm run test:client` | Any onboarding helper or component tests pass. |
| Client lint | `npm run lint --prefix client` | Touched files have no lint errors; existing unrelated lint baseline is documented if repo-wide lint fails. |
| UI / E2E | Start `npm run dev`, begin with no models/no agents, test connection, pull a starter model, continue to starter agent, reach chat. | User lands in chat with an agent using the selected model. |
| Manual | With one installed model and zero agents, open Agents and Models. | Empty states clearly offer to create an agent or start chat setup. |
| Failure path | Run with Ollama unavailable, then use first-run onboarding and Models page. | UI shows a clear connection state and action copy without pretending a pull can proceed. |

## Visual Verification Plan

| State | Viewport / Browser State | Screenshot Path |
| --- | --- | --- |
| No models/no agents onboarding with Ollama check | Desktop, Agents root | `./verification/issue-2-onboarding-empty.png` |
| Model pull complete with next-step CTA | Desktop, Agents root after pull completion | `./verification/issue-2-after-model-pull.png` |
| Installed model/no agents empty state | Desktop, Agents root | `./verification/issue-2-no-agent-cta.png` |
| Models page installed model CTA | Desktop, Models page | `./verification/issue-2-models-cta.png` |
| First chat reached with starter agent | Desktop, Chat page | `./verification/issue-2-first-chat.png` |
| Mobile onboarding layout | Mobile viewport | `./verification/issue-2-mobile-onboarding.png` |

## Publish Plan

- Branch: `codex/issue-2-guided-first-run-agent-setup`
- Commit: one issue-scoped commit after implementation and verification.
- Push: push the issue branch to `origin`.
- Issue review comment: post summary, verification evidence, screenshots, and deviations from this plan.
- Draft PR: open a draft PR targeting `main` with `Closes #2`.
- Project transition: move project status to `In Progress` after approval and branch start, then to `Review` after the draft PR opens.

## Risks & Open Questions

- Pulling an actual model can be slow or environment-dependent; automated tests should mock or isolate pull/status behavior, while manual verification can use an already installed or small local model when available.
- Auto-creating an agent is the fastest route to first chat, but users may prefer review before creation; the implementation should bias toward direct progress while still allowing edit/review when creation fails or the user chooses it.
- Existing onboarding is located in `Dashboard.jsx`; if it grows too large, a small local component extraction may be worthwhile, but broad UI refactors are out of scope.
- Browser screenshots may need seeded local state to avoid downloading a real model during visual verification.

## Approval Gate

Implementation was approved by issue comment and user reply on 2026-04-25.
