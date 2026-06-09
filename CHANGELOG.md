# Changelog

All notable changes to Hive are documented here.

## [1.3.0] — 2026-06-04

### Changed — Colony = persistent team; runs live under it

The Colony tab no longer asks you to "Select a Run". A **Colony** is now a named, persistent team (e.g. **Hive-TaskMaster**) created once with a name, quick description, team preset, and repo/project + base config. Runs are launched from the colony's own page against work items picked there.

- **Data model:** new `colony_teams` table; the legacy `colonies` rows become *runs* via a `team_id` column. One-time migration folds all pre-existing runs into a default **Hive-TaskMaster** colony.
- **API:** `GET/POST /api/colony/teams`, `GET/PUT/DELETE /api/colony/teams/:id`, `GET /api/colony/teams/:id/board`. `POST /api/colony` accepts `team_id` and inherits repo/recipe/cloud/write-back from the team. Webhook-triggered runs stay inside their source run's colony.
- **UI flow:** main Colony tab shows colony cards + a "New colony" config modal (name, description, preset, repo — no issue selection). Each colony page shows overview, crew, performance, runs, and artifacts from all runs; work items are picked and runs launched there. Run pages are unchanged, with back buttons run → colony → main throughout (URLs: `/colony`, `/colony/:teamId`, `/colony/:teamId/run/:runId`).

### Changed — Staff tab overhaul

- **Staff Chat fixed:** the lounge prompt no longer includes the work system prompt (which made small models role-play fake handoffs/standups). Chat is now grounded in the profile's personality, actual memory, and the chat history, with explicit anti-fabrication and anti-repetition rules; near-duplicate interval messages are dropped before saving; wrapping quotes/name prefixes are stripped; direct @mentions get answered even when autonomous chat is off for that profile.
- **Staff memory auto-populates:** after every colony run, each recipe-role profile gets a dated run note (goal + outcome) appended to its memory (bounded ~4KB, oldest lines trimmed). Memory remains fully editable on the Memory tab; applying Suggestions also writes here.
- **Personalities pre-populated** for all seeded personas (distinct voice per role), one-time backfill for existing profiles with empty personality.
- **Create/delete staff:** "New staff" button + `POST/DELETE /api/staff/profiles`. Custom staff become operator-staffing candidates for matching preset roles. Team-preset roles can't be deleted (they re-seed), only edited.
- **Conversation History:** worker "user" turns are now labeled **Operator** (that's who delegates), full transcripts render scrollable instead of truncated to 3 lines/6 turns.
- **Tools picker** lists the exact function names each tool group grants.

### Added — Colony memory, insights, and openable artifacts

- **Colony memory:** each colony has a shared, editable memory (`colony_teams.memory`, on the colony page). It is injected into the operator and every worker at launch, and after each run (done or stopped) the operator distills 2–5 lessons and appends a dated section — bounded at ~12KB by dropping the oldest run sections while preserving the user-edited preamble.
- **Insights panel** (replaces the Crew section on the colony page — the live roster lives on each run page; the team preset + crew size now shows as a header chip): operator workaround reports, failed acceptance criteria, and blockers aggregated across all of the colony's runs.
- **Openable artifacts:** artifact file names on the colony page and the run summary card open in a viewer (`GET /api/colony/:id/artifact?path=…` — traversal-safe, text-only, 256KB cap, markdown rendered).

### Changed — Reasoning is an operator decision, not a run-screen toggle

- The "Reasoning on/off" toggle is gone from the run screen, and the per-run worker-reasoning selector is gone from launch. The **operator always reasons** and assigns reasoning per agent at run start (coding roles always reason; analysis/planning roles reason when the mission signals complexity). The decision is logged in the run preflight.

### Changed — Operator staffing from the Staff directory

- Team presets still define the roles, but the operator now **picks the best staff member for each preset role** based on the colony's requirements (team name + description + mission): candidates are matched across profiles and scored on preset fit, skill overlap, accumulated memory, and handoff track record, falling back to the recipe's seeded persona. Selections are logged at run start.

## [1.2.0] — 2026-06-01

### Added — Multi-provider models (cloud + local)

Agents can now run on cloud models in addition to local Ollama, selected per agent.

- **Providers:** Anthropic (Claude), OpenAI (GPT), and Google Gemini, alongside Ollama. Model ids are provider-prefixed (`anthropic/…`, `openai/…`, `gemini/…`); bare names resolve to Ollama.
- **Provider layer** (`server/lib/providers/`) built on the Vercel AI SDK v6 — one `streamChat` dispatcher routes by prefix and normalizes streaming + tool-calling into the app's existing event shape, using each provider's native API (OpenAI via the Responses API).
- **API keys** stored locally in `app_settings`, masked on read and never returned in cleartext; `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` environment variables are also honored.
- **Settings → Model Providers** — masked key inputs with a per-provider "Test" button.
- **Unified model list** (`GET /api/models`) — live per-provider fetch (filtered to chat/tool-capable models) with a curated fallback when no key is set; the picker also accepts custom ids.
- **Models page** now shows a Cloud Models section per provider in addition to the local Ollama browser.

### Changed

- Both chat call sites (`runAgentOnce`, the websocket chat loop) and the colony preflight now go through the provider layer instead of calling Ollama's HTTP API directly.
- Tool-call/result **id correlation** is threaded through the tool loops (required by cloud providers).
- New runtime dependencies: `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ai-sdk-ollama`, `zod` — run `npm install` after pulling.

### Behavior & compatibility

- **Backward compatible.** Existing agents with bare or `ollama/`-prefixed model names are unchanged; Ollama remains the zero-config default and cloud providers are inert until a key is added.
- Client WebSocket/SSE event shapes are unchanged.

## [1.1.0] — 2026-06-01

### Added — Webhook context projection

You can now control exactly how much of a webhook payload reaches an AI agent, instead of passing the entire raw event every time.

- **Agent Context Fields** on each webhook — map raw payload fields to a distilled context using dot-notation paths (e.g. `repository.full_name`, `commits.0.id`). The agent receives only the fields you choose.
- **Per-event-type mappings** — a single webhook that receives multiple event types (e.g. `push`, `issues`) can project each type differently. Mappings with no event type apply to all events.
- **`get_webhook_event` tool** — agents in the Agent Tools group can fetch the full raw payload on demand by event id (with optional request headers), so the complete data is always one call away when the distilled context isn't enough.
- **Webhook → Triage pipeline template** — a ready-made pipeline whose first step enables `get_webhook_event` and explains the context envelope to the agent.
- **`GET /api/webhooks/:id/events/:eventId/projected`** — returns the distilled context envelope for a single stored event.

### Changed

- The Webhooks "Take Action" flow now passes the projected context envelope to the pipeline instead of the full raw JSON payload.
- Webhook create/update endpoints accept and return a `context_spec` field.

### Behavior & compatibility

- **Opt-in and backward compatible.** Webhooks with no fields mapped fall back to sending the full raw payload (`_projected: false`), so existing webhooks work unchanged until you add a spec.
- **No data loss.** Raw events are still stored in full in `webhook_events`; projection only narrows what is passed into the agent's context.

### Migration

- Additive, automatic: a `context_spec` column is added to the `webhooks` table on startup. No manual steps required.

[1.1.0]: #110--2026-06-01
