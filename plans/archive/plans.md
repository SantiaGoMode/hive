# Hive Development Plan

## Prioritized Enhancements

| Feature Name | Description | Expected Impact | Technical Complexity |
|---|---|---:|---:|
| Guided First-Run Agent Setup | After model pull, create or prefill a starter agent and route users directly into their first successful chat. | High | Medium |
| Reliable Chat History & Search | Fix session persistence, surface save failures, and make conversation search a dependable core workflow. | High | Low |
| Unified Run Cancellation | Make Stop work consistently across chat, pipelines, schedules, and colony by wiring backend abort signals. | High | Medium |
| Workflow Health Dashboard | Add a single status view for Ollama, installed models, active agents, running pipelines, schedules, and colonies. | High | Medium |
| Pipeline Builder Refactor | Improve pipeline creation with reusable step components, clearer validation, drag/drop ordering, and inline run previews. | High | High |
| Shared Tool Configuration Component | Replace duplicate tool pickers across agents, pipelines, and schedules with one reusable component and consistent semantics. | Medium | Medium |
| Accessible Modal & Form System | Add focus trapping, ARIA labels, keyboard-safe controls, associated labels, and better icon-button accessibility. | Medium | Medium |
| Progressive Advanced Settings | Hide advanced model/tool/MCP/sandbox controls behind clearer defaults and contextual reveal patterns. | Medium | Medium |
| Streaming Event Parser Library | Extract SSE/WebSocket parsing into reusable utilities for chat, pipelines, colony, and model pulls to reduce bugs. | Medium | Medium |
| Frontend Regression Test Suite | Add Vitest/React Testing Library coverage for onboarding, agent creation, chat send/history, pipeline run states, and settings forms. | Medium | Medium |

## Sprint Roadmap

### Sprint 1: Stabilize Core Chat Reliability

**Goal of the Sprint:** Make the primary user loop, agent chat, trustworthy and recoverable.

**Specific Tasks for Developers:**
- Fix chat session persistence by correcting the `sessionWriter`/`agentParser` workspace path issue.
- Add error logging and user-visible failure handling when session saves fail.
- Add tests for session creation, loading, deleting, renaming, and global session search.
- Verify chat history works after a full app restart.
- Add a lightweight regression test around sending a chat and seeing it appear in history.

**Expected Deliverables:**
- Reliable chat history and search.
- Passing backend tests for session persistence.
- Clear error handling instead of swallowed save failures.

### Sprint 2: Improve First-Run Experience

**Goal of the Sprint:** Help new users reach their first successful agent response with minimal setup friction.

**Specific Tasks for Developers:**
- Redesign onboarding flow after model pull.
- Auto-create a starter agent or open the Agent Editor prefilled with the selected model.
- Add a "Test Ollama connection" check during onboarding.
- Add empty-state CTAs that guide users from Models to Agent to Chat.
- Add copy that explains local-first setup only where users need it.

**Expected Deliverables:**
- A guided first-run path from no models/no agents to first chat.
- Reduced confusion around "model installed but no agent created."
- Better empty states across Agents and Models.

### Sprint 3: Make Run Cancellation Honest

**Goal of the Sprint:** Ensure Stop/Cancel controls actually stop backend work, not just the UI stream.

**Specific Tasks for Developers:**
- Add `AbortController` handling to pipeline run routes.
- Wire request/response close events to backend cancellation.
- Pass abort signals through `runAgentOnce`.
- Mark cancelled pipeline runs as `stopped` instead of leaving them as `running`.
- Add tests for cancelled sequential and parallel pipeline runs.
- Review schedules and colony behavior for consistent status language.

**Expected Deliverables:**
- Stop works correctly for pipelines.
- Run history accurately reflects stopped/cancelled runs.
- Lower risk of runaway local model/tool processes.

### Sprint 4: Extract Shared Workflow Infrastructure

**Goal of the Sprint:** Reduce duplicated streaming/tool logic before adding more workflow features.

**Specific Tasks for Developers:**
- Extract a shared SSE parsing utility for model pulls, pipeline runs, and colony streams.
- Extract a reusable Tool Picker used by Agents, Pipelines, and Schedules.
- Standardize loading, error, retry, and empty states for async workflows.
- Add tests for SSE parsing edge cases.
- Remove duplicate tool-picker definitions from `PipelinesPage` and `SchedulesPage`.

**Expected Deliverables:**
- Shared streaming parser utility.
- Shared tool configuration component.
- Smaller, easier-to-maintain workflow pages.
- Reduced risk when modifying pipelines, schedules, or colony.

### Sprint 5: Upgrade Pipeline Builder

**Goal of the Sprint:** Make pipelines easier to create, understand, validate, and debug.

**Specific Tasks for Developers:**
- Add inline validation for missing agents, missing prompts, and unavailable models.
- Improve step ordering controls, preferably drag/drop or clearer move buttons.
- Show step-level tool overrides more clearly.
- Add a pipeline dry preview showing how `{input}` and `{prev}` will flow.
- Improve run modal states for pending, running, stopped, failed, retrying, and complete.
- Add frontend tests for creating and running a simple pipeline.

**Expected Deliverables:**
- More usable pipeline builder.
- Fewer invalid pipeline configurations.
- Clearer pipeline run trace and retry behavior.

### Sprint 6: Add Workflow Health Dashboard

**Goal of the Sprint:** Give users one place to understand whether Hive is ready and what is currently running.

**Specific Tasks for Developers:**
- Add a dashboard/status page or panel showing Ollama connection, installed models, active model memory, active chats, running pipelines, schedules, and colonies.
- Surface common remediation actions: start Ollama instruction, pull model, stop model, open active run.
- Add status badges for agents with no model, disconnected MCP servers, failed schedules, and running colonies.
- Reuse existing `/system/status`, activity SSE, model, schedule, and colony APIs where possible.

**Expected Deliverables:**
- Central operational view of Hive.
- Faster debugging for local-first setup problems.
- Better visibility into background activity.

### Sprint 7: Accessibility & UI System Hardening

**Goal of the Sprint:** Improve usability standards without changing product scope.

**Specific Tasks for Developers:**
- Add accessible modal semantics, focus trap, escape handling, and labelled close buttons.
- Connect form labels with inputs via `htmlFor`/`id`.
- Replace title-only icon accessibility with `aria-label`s and consistent tooltips.
- Make hover-only actions keyboard discoverable.
- Review color contrast in dark and light themes.
- Add basic accessibility tests where practical.

**Expected Deliverables:**
- More keyboard- and screen-reader-friendly UI.
- More consistent modal/form behavior.
- Reduced usability friction for core workflows.

### Sprint 8: Test Coverage & Quality Gate

**Goal of the Sprint:** Lock in reliability after the core product improvements.

**Specific Tasks for Developers:**
- Add React Testing Library or equivalent frontend testing setup if not already present.
- Cover onboarding, agent creation, chat send/history, pipeline creation/run, and settings save.
- Decide which current ESLint rules are actionable versus too noisy for React 19.
- Fix high-signal lint errors or tune config intentionally.
- Add CI-ready commands for server tests, client tests, and lint.

**Expected Deliverables:**
- Meaningful frontend regression coverage.
- Stable quality gate for future development.
- Clear lint baseline instead of noisy failures.

## Recommended Order

Start with Sprints 1-3 because they protect core value: chat, onboarding, and trustworthy execution. Sprints 4-5 reduce technical risk before deeper workflow investment. Sprints 6-8 improve operability, usability, and long-term velocity.
