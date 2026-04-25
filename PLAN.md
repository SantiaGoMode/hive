# Development & Testing Plan

## Issue

- Repository: SantiaGoMode/hive
- Issue: #1 - [Phase 1: Core Reliability] Reliable Chat History & Search
- Issue URL: https://github.com/SantiaGoMode/hive/issues/1
- Date: 2026-04-24

## Requirements Summary

Chat sessions must persist reliably, save failures must be logged and surfaced to the user, and conversation search must be dependable across agents. The issue specifically calls out a session writer workspace path bug, swallowed save failures, backend tests for session creation/loading/deleting/renaming/global search, and verification that chat history survives a full app restart.

Current findings from code inspection:

- `server/lib/sessionReader.js` reads from `readAgent(agentId).workspace/sessions`.
- `server/lib/sessionWriter.js` writes to `getAgentsDir()/agentId/sessions`, which can diverge from the agent workspace stored in the database, especially for migrated or custom workspaces.
- `server/lib/websocket.js` catches session save failures with an empty `catch {}`, so users get a normal `done` event even when chat history was not written.
- Session list, detail, delete, rename, and search routes already exist under `server/routes/sessions.js`.
- Global session search is exposed in the dashboard via `client/src/pages/Dashboard.jsx`, and per-agent history is exposed via `client/src/components/sessions/SessionList.jsx`.

## Technical Approach

Align the session writer with the reader by resolving session storage from the database-backed agent workspace. Save failures should throw from the writer, be logged with enough context on the server, and be emitted to the client as a user-visible failure without hiding the assistant response that was just generated.

Expected backend behavior:

- `saveSession` writes to the same `agent.workspace/sessions` directory that `listSessions` and `getSession` read.
- Invalid or missing agents produce explicit save errors instead of creating stray directories.
- Websocket save failures are logged with `console.error` and include `agentId` and `sessionId`.
- The websocket sends a dedicated save-failure event or an equivalent structured error that the client can toast without discarding the completed assistant response.
- Session route operations continue to return JSON responses and sensible HTTP errors.

Expected frontend behavior:

- Chat users see a clear toast or inline warning when a response could not be saved.
- Successful saves continue refreshing the session history drawer.
- Existing history and dashboard search workflows keep their current interaction model.

## File Changes

- `server/lib/sessionWriter.js`: resolve agent workspace through `readAgent`, create `workspace/sessions`, and let write failures propagate with useful error messages.
- `server/lib/websocket.js`: replace the swallowed save failure with logging and a client-visible save-failure signal while preserving normal completion behavior for successful saves.
- `client/src/components/chat/ChatWindow.jsx`: handle the new save-failure signal with a clear user-visible toast or warning.
- `server/tests/sessionPersistence.test.js` or similar: add focused backend coverage for session write/read/list/delete/rename/search behavior and failure paths.
- Potentially `server/routes/sessions.js`: add route-level error handling only if tests show route failures currently leak or crash.

## New Components

No new product-level components are expected. If a persistent save warning is needed beyond a toast, reuse existing UI primitives and keep it inside `ChatWindow`.

## Development Phases

1. Backend persistence alignment
   - Update `sessionWriter` to use the agent workspace as the single source of truth.
   - Add targeted writer/reader tests for session creation, loading, listing, deleting, and search.
   - Verification: run the new backend session tests and the full backend test suite.

2. Save failure handling
   - Update websocket save handling to log failures and notify the client.
   - Add tests for missing/invalid workspace or write failure behavior where practical.
   - Verification: run focused backend tests and inspect websocket event behavior via unit/integration coverage.

3. Rename and route coverage
   - Add route tests for rename metadata and deletion cleanup using `supertest`.
   - Verify search returns renamed sessions with matching content across all agents.
   - Verification: run backend route tests and full `npm test`.

4. Client-visible failure feedback
   - Update `ChatWindow` to display a save failure toast or warning when the server reports persistence failure.
   - Keep existing success flow intact for `done` events with a valid `sessionId`.
   - Verification: run client lint/tests and capture UI screenshots if the feedback is visible in the browser.

5. Restart persistence verification
   - Verify saved session files remain readable after server restart or a simulated process restart using a persistent temp workspace and DB.
   - Verification: manual restart steps plus backend regression test where feasible.

## Test Map

| Area | Command / Steps | Expected Result |
| --- | --- | --- |
| Unit | `npm test -- server/tests/sessionPersistence.test.js` | New session persistence tests pass. |
| Integration | `npm test` | Existing backend tests plus session persistence coverage pass. |
| Client | `npm run lint --prefix client` and `npm run test:client` | Client feedback changes pass lint and tests. |
| UI / E2E | Start `npm run dev`, create a chat, open history, search the conversation from dashboard. | Saved session appears in history, can be opened after restart, and appears in global search. |
| Manual | Stop and restart the app after creating a chat, then reload the same agent history. | Chat history still exists and search still finds the conversation. |
| Failure path | Simulate an unwritable or invalid session workspace, send a chat, inspect server logs and UI. | Server logs the save failure and the user sees a clear save failure message. |

## Visual Verification Plan

| State | Viewport / Browser State | Screenshot Path |
| --- | --- | --- |
| Session history after successful save | Desktop browser, chat page with history drawer open | `./verification/issue-1-history-saved.png` |
| Dashboard global conversation search | Desktop browser, dashboard in History search mode with a known query | `./verification/issue-1-global-search.png` |
| Save failure feedback | Desktop browser, chat page after forced save failure | `./verification/issue-1-save-failure.png` |

## Risks & Open Questions

- The save failure path may be easiest to test by injecting an invalid workspace or mocking filesystem writes; implementation should choose the least brittle option once test patterns are inspected.
- Websocket event shape should be kept small and backward-compatible so normal chat completion still works even if persistence fails.
- Full app restart verification may need a manual run because the server currently initializes long-running services on startup.
- `plans.md` is currently an untracked local file and will be left untouched.

## Approval Gate

Implementation will not begin until the user replies exactly `Approved`.
