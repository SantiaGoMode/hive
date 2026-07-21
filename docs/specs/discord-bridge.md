# Waggle: The Discord Bridge

**Status:** Implemented v1 with follow-up backlog · **Author:** Cristino Santiago · **Date:** 2026-07-07 · **Updated:** 2026-07-16
**Tagline:** Bees tell the hive where the work is by dancing. You tell Hive by typing in Discord.

---

## 1. Problem Statement

Hive is a local-first dashboard: to talk to an agent, direct a colony, or notice that something is degrading, the operator must have the web UI open. There is no ambient channel — no way to fire off an instruction from a phone, get pinged when a mission finishes or a budget burns down, or keep a running conversation with a trusted assistant that persists outside a browser tab.

The operator already lives in a private Discord server. Discord gives us, for free, exactly the primitives Hive lacks on the outbound side: a persistent mobile+desktop client, threads as durable per-topic containers, forums as organized event feeds, and push notifications. Today Hive has **zero outbound integrations** — webhooks are inbound-only (`server/routes/webhooks.js`), and the only external client is GitHub (`server/lib/githubBoard.js`). Every colony event dies in an SSE stream nobody is watching.

## 2. Goals

1. **Hive in your pocket.** The operator can converse with a full-powered executive assistant, direct any colony, and act on health alerts entirely from Discord — web UI optional. Success: a full mission (instruct → watch steps pass → read final status) completes with the operator never opening the dashboard.
2. **One thread = one colony, forever.** Each colony team owns exactly one forum thread that accumulates its whole history: instructions given, steps passed/failed, deliverables shipped. Success: opening a colony's thread answers "what has this team done lately?" without the UI.
3. **Signal, not noise.** Colony threads post milestones (step transitions, handoffs, questions, final status), never token streams. Health posts are deduplicated and self-resolving. Success: a completed mission produces ≤ ~10 messages; a persistent warning produces 1 thread, not 40 posts.
4. **Alerts become issues in one reply.** A health warning the operator deems real becomes a well-formed GitHub issue on the Hive repo from a single conversational reply. Success: reply-to-issue in < 60 seconds, issue link posted back in-thread.
5. **Owner-only by construction.** The bridge answers only the configured operator account(s) in the configured guild. A stranger in the server gets silence.

## 3. Non-Goals

- **Multi-tenant / public bot.** One Hive install ↔ one private guild ↔ one operator (plus optional allowlist). No sharding, no per-guild config marketplace.
- **Slack / Telegram / Matrix.** The bridge is structured as `server/lib/discord/` with a thin transport layer, but v1 ships Discord only. (Parking lot: extract a `bridge` interface if a second platform ever lands.)
- **Replacing the web UI for mission *configuration*.** Founding colonies, editing recipes, wiring MCP servers, and editing skills stay in the UI. Discord is a command-and-conversation surface, not an admin panel.
- **Streaming tokens into Discord.** Discord's rate limits (~5 msg/5 s per channel) and edit limits make token streaming hostile. We post turns and milestones, with typing indicators for liveness.
- **Voice.** Text channels and forums only.

## 4. Concept Model

```
Discord (private guild)                      Hive server (one process)
┌──────────────────────────┐                ┌────────────────────────────────────┐
│ #general (text)          │◀── replies ───│ STEWARD  exec-assistant agent      │
│   the Steward's office   │─── messages ─▶│  runAgentOnce + all tool groups    │
│                          │                │  + load_skill/list_skills tools    │
├──────────────────────────┤                ├────────────────────────────────────┤
│ colony (forum)           │                │ OPERATOR per-team LLM agent        │
│  ├ thread: Team Alpha  ──┼──── 1:1 ──────│  reads msgs, answers questions,    │
│  ├ thread: Team Bravo    │─── messages ─▶│  starts runs / injects directions  │
│  └ thread: …             │◀── events ────│  colonyBus → step ✅/❌, status     │
│                          │                │  (deterministic mission board)     │
├──────────────────────────┤                ├────────────────────────────────────┤
│ health (forum)           │◀── alerts ────│ SENTINEL watcher + triage agent    │
│  ├ thread: gateway spend │                │  metrics/logs/blockers → findings  │
│  └ thread: ollama down   │─── replies ──▶│  reply → triage agent (github      │
│                          │                │  tools) → createGitHubIssue        │
└──────────────────────────┘                └────────────────────────────────────┘
         bindings + thread map + dedupe fingerprints live in SQLite
```

Three personas, one bot account:

- **The Steward** — the executive assistant behind `#general`. A real Hive agent (staff profile) with every built-in tool group, all connected MCP servers, and a new runtime skill loader. Talks like a chief of staff, acts like one.
- **The Operator** — an LLM agent fronting each colony thread. It takes instructions and turns them into missions (start a run, queue work, inject a direction into a live run), and it answers questions conversationally from team state (overview, queue, run history, memory) without launching anything. Milestone posts (mission board, final status card) remain a deterministic event relay underneath — the Operator speaks; the plumbing signals.
- **The Sentinel** — a watcher loop that turns metrics/logs/blockers into deduplicated health findings, plus a triage agent (with `github` tools) that wakes only when the operator replies in a health thread.

## 5. User Stories

Persona: **Operator** — the human running the Hive install, in their own private Discord server.

**P0**

- As an operator, I want to message `#general` from my phone ("summarize what the colonies shipped today", "search the web for X and save it to memory") and get an answer from an assistant with full tool access, so Hive is useful when I'm away from my desk.
- As an operator, I want the Steward to pull in a skill mid-conversation ("load the code-reviewer skill and look at PR #42") without me editing agent config, so its capabilities match the conversation.
- As an operator, I want every colony to have its own forum thread, created automatically, so each team has a durable channel.
- As an operator, I want to talk to each colony's Operator agent in its thread — instructions become the team's next mission (or an in-flight direction if it's already running), and questions get answered from team state without launching anything — so directing a team is just talking to it.
- As an operator, I want the thread to show each plan step flip to ✅/❌ as the colony works, and a final status card (result, steps passed, duration, spend, artifacts) when it finishes, so I can watch a mission like a CI run.
- As an operator, I want warnings (budget burn, provider down, colony blocked, repeated errors) to appear as health threads — one thread per distinct problem, updated in place — so I hear about problems without watching a dashboard.
- As an operator, I want to reply to a health thread ("yeah, file this") and get a GitHub issue on the Hive repo, with the link posted back, so triage ends in a tracked artifact.
- As an operator, I want the bot to ignore everyone except me, so a leaked invite isn't a remote-code-execution invite.

**P1**

- As an operator, I want the colony thread to relay `permission_required` and human-gated handoffs as questions I can answer inline (reply or ✅/❌ reaction), so missions don't silently stall while I'm mobile.
- As an operator, I want `/hive` slash commands (`/hive status`, `/hive colonies`, `/hive stop <team>`, `/hive new-session`) for fast, deterministic actions that shouldn't cost an LLM call.
- As an operator, I want health findings to auto-post a "resolved" note when the condition clears, so the forum reflects current reality.
- As an operator, I want the Sentinel to include *suggestions* (staff prompt drift, idle colonies with queued work, unrouted work items) at a lower severity, so the health forum is also a coach, not just an alarm.

**Edge cases**

- Discord is down / bot disconnected → Hive keeps running untouched; the bridge reconnects with backoff and posts a "missed window" digest for terminal colony events it can recover from persisted run logs (`GET /api/colony/:id/stream?since=` semantics).
- A colony team is deleted in the UI → its thread gets a farewell post and is archived, never deleted (history is the point).
- A thread is deleted by the operator on Discord → the binding is dropped; the next event re-creates a thread.
- Two instructions land in one idle colony's thread back-to-back → both become queued work items; the second starts when the first run finishes (respecting capacity), and the Herald says so.
- A message in `#general` arrives while the Steward is still working on the previous one → queued and answered in order; the bot reacts with ⏳ so the operator knows it was seen.

## 6. Requirements

### P0 — Must Have

**R1. The bridge service (`server/lib/discord/`).**
A long-lived service started from the `server.listen` boot block (`server/index.js:144-171`, alongside `mcpManager.loadAll()`), using `discord.js` v14 with `Guilds`, `GuildMessages`, `MessageContent` intents. Disabled cleanly when no token is configured. Token stored per the secrets pattern: new `discord_bot_token` in `SECRET_KEYS` (`server/routes/config.js:14`) with env fallback `DISCORD_BOT_TOKEN` via `settingSecret` (`server/lib/secrets.js:24`).
*Acceptance:*
- [ ] No token configured → server boots exactly as today, one info log line
- [ ] Token revoked / gateway drop → exponential-backoff reconnect; Hive core never blocks on Discord
- [ ] All outbound posts go through one rate-limit-aware queue (respecting `discord.js` built-in throttling)
- [ ] Bot ignores: its own messages, non-allowlisted users, unbound channels

**R2. Setup & bindings.**
Operator invites the bot, then runs `/hive setup` once in the guild. The bot discovers the bindings: the invoking channel (or a named option) becomes `general`, and the two forums are bound by picking from the guild's forum channels (name-matched `colony`/`health` by default, overridable via command options). Bindings + the invoker's user id (owner allowlist) persist in a new `discord_bindings` table (migration 18, per `server/lib/migrations.js` conventions): `id, guild_id, kind ('general'|'colony_forum'|'health_forum'), channel_id, created_at`, plus `discord_threads`: `thread_id, kind ('colony'|'health'), ref (team_id | finding fingerprint), created_at`. Owner allowlist in `app_settings` (`discord_owner_ids`).
*Acceptance:*
- [ ] `/hive setup` by anyone not already an owner is rejected unless no owner exists yet (first-run claims ownership)
- [ ] Re-running setup rebinds idempotently
- [ ] Settings page shows bridge status (connected guild, bound channels, owner) read-only with the token field editable, masked like other secrets

**R3. The Steward — `#general` executive assistant.**
A seeded staff-profile-backed agent (`staff_profiles` + `createAgentFromProfile`, per `server/lib/staffDirectory.js`) named **Steward**, provisioned with *all* built-in tool groups (`sandbox`, `web_search`, `memory`, `protocol`, `colony_tools`, `agent_tools`, `github`) plus every connected `mcp:*` group at invocation time. Messages in `#general` run through `runAgentOnce` (`server/lib/agentRunner.js:14`) with rolling conversation history persisted as a normal Hive session (JSONL under `~/.hive/agents/{id}/sessions/`, metadata in `sessions_meta`) — one active session per channel, so the web UI can inspect the same conversation. `/hive new-session` (P1) or a 24 h idle window rolls the session.
*Acceptance:*
- [ ] Operator message → typing indicator → final answer posted (chunked at 2000 chars, code blocks kept intact)
- [ ] Tool activity is summarized as a single compact footer line (e.g. `🛠 web_search, sandbox ×2`), never streamed
- [ ] Conversation context survives server restarts (session reload)
- [ ] Concurrent messages are processed strictly in order; queued ones get an ⏳ reaction immediately

**R4. Runtime skill loading (new tool group `skills`).**
New tool module `server/lib/tools/skillTools.js` exposing `list_skills()` (names + descriptions from the `skills` table) and `load_skill(name)` (returns the rendered skill body via `renderSkillsBlock`, `server/lib/skillsBlock.js`, injected as the tool result so it enters context immediately). Registered in `server/lib/tools/registry.js` and available to any agent, not just the Steward — this closes a real platform gap (today skills bind only at prompt-build time).
*Acceptance:*
- [ ] Steward can name-drop a skill it wasn't configured with, load it, and apply it in the same turn
- [ ] `load_skill` of an unknown name returns the available list instead of erroring
- [ ] Tool group appears in `GET /api/skills/tool-options` so UI agents can opt in

**R5. Colony forum — thread lifecycle (event relay, outbound).**
On boot and on `rosterBus` team events (`server/lib/rosterBus.js:16`), reconcile: every `colony_teams` row has exactly one live thread in the colony forum (create missing ones with a **team card** starter post: name, recipe, crew, repo, status, queue depth from `teamOverview`). During a run, subscribe to `colonyBus.getBus(colonyId)` (`server/lib/colonyBus.js:17`) and translate:
- `plan_update` → one **mission board message edited in place**: `🔄/✅/❌/⬜` per step description (statuses `in_progress`/`done`/failed/`pending`)
- `orchestrator_message` → posted only for round summaries (throttled: max 1 per round)
- `handoff` (`requires_human`) and `permission_required` → posted as a question with an @-mention of the owner
- `done`/`error` → **final status card**: outcome, steps passed/failed count, duration, artifacts, gateway spend for the run (from spend metadata), deliverable summary trimmed to ~1500 chars
*Acceptance:*
- [ ] Creating a team in the UI produces a thread within one reconcile tick; deleting archives it with a farewell post
- [ ] A full mission posts: acknowledgment, mission board (edited, not reposted), ≤1 summary per round, final card — token/log/thinking events never appear
- [ ] Bridge restart mid-run reattaches to the live bus (or replays persisted log via `seq`) without duplicate posts (dedupe on `seq`, matching `runAndStreamColony` semantics, `server/routes/colony/shared.js:61`)

**R6. Colony forum — the Operator (inbound, LLM).**
An owner message in a colony thread goes to that team's **Operator agent** — an LLM invoked via `runAgentOnce` with the team's identity, live status, queue, and recent-run context, plus a scoped tool set (`operator_tools`): `start_mission(direction)`, `queue_work(direction)`, `send_direction(text)` (into a live run), `get_team_status()`, `get_run_report(runId)`. The Operator decides:
- **Instruction, team idle** → `start_mission`: `createWorkItem` (source `manual`) + immediate start via the shared lib path behind `queue/:itemId/start` (`server/routes/colony/queue.js:109`, factored so route and bridge share one call). The human's message *is* the explicit operator action, consistent with the operator-in-the-loop rule.
- **Instruction, run live** → `send_direction`: the `/api/colony/:id/directions` path (`server/routes/colony/lifecycle.js:94`), ack'd conversationally.
- **Instruction, backlog** → `queue_work`; the Operator reports queue position.
- **Question** ("what did you ship last run?", "why is step 3 failing?") → answered from team state; nothing launches.
Each thread keeps a rolling Operator session so follow-ups have context.
*Acceptance:*
- [ ] Idle-team instruction → run starts, Operator confirms with the run id; mission board appears within seconds
- [ ] Running-team instruction → direction injected; `direction_queued`/`direction_delivered` reflected in-thread
- [ ] A question never starts a run; the Operator answers from `teamOverview`/run data
- [ ] Non-owner messages in threads are ignored (no ack, no action)

**R7. Health forum — the Sentinel (outbound).**
A watcher (interval sweep, default 5 min, plus event triggers from the logger's warn/error ring buffer) evaluates **findings**, each with a stable fingerprint, severity (`warning`/`alert`/`suggestion`), title, and evidence:
- Gateway/budget: per-agent spend ≥ 80% of `gateway_budget_usd` (`getGatewaySpendSummary`, `server/lib/gatewaySpend.js:194`)
- Availability: Ollama unreachable, gateway unhealthy, sandbox image missing (`/api/system/metrics` sources)
- Colonies: run ended in `error`, blockers on the blackboard (`colony_blackboard` where `entry_type='blocker'`), acceptance-criteria failures (via `teamOverview` insights), runs hitting the 30-min wall clock
- Process: repeated warn/error log signatures (≥3 of the same signature in a sweep window)
One finding = one forum thread keyed by fingerprint (in `discord_threads`). Re-detections bump the existing thread (edit a status line, at most one bump per hour); no new thread.
*Acceptance:*
- [ ] The same persistent condition across 10 sweeps yields exactly 1 thread
- [ ] Severity is visible at a glance (thread title prefix `🔴/🟡/💡`)
- [ ] A finding thread includes machine-readable evidence (fenced JSON block) sufficient for the triage agent to act without re-querying

**R8. Health forum — reply-to-issue (triage agent).**
An owner reply in a health thread wakes a **triage agent** (seeded staff profile, tools: `github` + `memory`), invoked via `runAgentOnce` with the full thread (finding + evidence + operator reply) as context. It converses; when the operator's intent is "file it," it calls the existing github tool path (ultimately `createGitHubIssue`, `server/lib/githubBoard.js:290`) against the Hive repo (resolved via `detectGitHubRepo` on the install's own checkout, override in settings `discord_health_repo`), then posts the issue URL back and edits the thread title to append `→ #123`.
*Acceptance:*
- [ ] "File this" reply → issue exists with a title, a body containing the evidence block and thread permalink, and appropriate labels (`bug` for alerts, `enhancement` for suggestions)
- [ ] Ambiguous replies get a conversational answer, not an issue — issue creation only on clear instruction
- [ ] Issue link posted in-thread within the same exchange

**R9. Security posture.**
- Owner allowlist enforced on every inbound event before any processing; default-deny
- The bridge shares the server process but touches Hive only through the same lib functions the REST routes use — no new privileged paths
- Outbound content is operator-authored or operator-visible telemetry; deliverable/log excerpts are truncated and never include settings/secrets (reuse the masking rules from `server/routes/config.js`)
- Bot token never logged; stored 0600 in SQLite like other secrets
*Acceptance:*
- [ ] A non-owner message in any bound channel produces zero side effects and zero replies
- [ ] Secrets scan: no token or API key can appear in any posted message path

### P1 — Nice to Have

**R10. Slash commands.** `/hive status` (system metrics digest), `/hive colonies` (roster with live status), `/hive stop <team>`, `/hive new-session`, `/hive skills` — deterministic, no LLM.
**R11. Inline approvals.** `permission_required` / human-gated handoffs answered by replying `approve`/`deny` or reacting ✅/❌; wired into the existing direction/permission plumbing.
**R12. Resolution posts.** Sentinel detects a fingerprint has cleared for 2 consecutive sweeps → posts `✅ Resolved` and archives the thread.
**R13. Digest mode.** Optional daily `#general` morning digest from the Steward: what shipped, what's queued, what's burning money.
**R14. Missed-events recovery.** After downtime, post a compact digest per colony thread for terminal events that occurred while disconnected (from persisted run logs), instead of silence.

### P2 — Future Considerations (design-for, don't build)

- **Second platform (Slack/Telegram).** Keep `transport` (Discord API calls) separate from `bridge` logic (event translation, session mapping) so a second transport is additive.
- **Voice notes → instructions.** Discord voice-message attachments transcribed and treated as thread instructions.
- **Multiple operators with roles.** Allowlist already a list; per-user permissions (observer vs. director) if the install ever grows.
- **Steward-initiated colony ops.** The Steward already has `colony_tools`; a future mode lets it *propose* queue items into colony threads for one-tap approval.

## 7. Success Metrics

**Leading**
- Bridge uptime ≥ 99% of server uptime (reconnects count as up if < 60 s)
- Median Steward response latency < 15 s for tool-free turns
- Colony mission → first mission-board post < 5 s from run start

**Lagging (30 days post-ship)**
- ≥ 50% of colony runs initiated from Discord threads
- ≥ 1 GitHub issue filed via health-forum triage (the loop has been exercised end-to-end)
- Zero health-forum duplicate threads for the same fingerprint

## 8. Open Questions

**Blocking**
- **Q1 (owner: Cris):** Bot hosting assumption — the Hive server must be running for the bridge to work (it lives in-process). Fine for a local-first install, but should the desktop app surface "bridge offline" when Hive isn't running? *Proposed: yes, out of scope here; note in desktop backlog.*
- **Q2 (owner: Cris):** Which model powers the Steward and the triage agent by default? *Proposed: the install's default cloud model with a `gateway_budget_usd` cap; configurable per staff profile like any other.*

**Non-blocking**
- **Q3:** Should `#general` Steward sessions be one rolling session per channel or per-day? *Proposed: rolling with 24 h idle rollover + `/hive new-session`.*
- **Q4:** Forum tags (Discord supports per-forum tags) for colony threads (`idle`/`working`/`blocked`) and health threads (`alert`/`warning`/`suggestion`/`resolved`)? Cheap polish; do it if the API cooperates.
- **Q5:** Should the mission board also mirror to the thread title (e.g. `Team Alpha — 3/5 ✅`)? Title edits are rate-limited (2/10 min) — probably final-status only.

## 9. Timeline & Phasing

**Phase 1 — The Steward (ship first, smallest loop).**
R1, R2, R3, R4, R9. Bot boots, binds, and `#general` works with runtime skill loading. This alone delivers "Hive in your pocket."

**Phase 2 — The Operator.**
R5, R6 (+ R10, R11 if cheap). Colony threads, mission boards, instructions in. Depends on nothing from Phase 3.

**Phase 3 — The Sentinel.**
R7, R8 (+ R12). Health findings, dedupe, reply-to-issue.

Each phase is independently shippable and independently disable-able (per-binding kill switch in settings).

---

*Parking lot: transport abstraction for Slack; waggle-dance Easter egg (bot reacts 🐝 to its 100th instruction); Steward proactive mode ("you asked me to remind you…" via schedules integration); per-thread colony memory notes written back to `colony_teams.memory`.*
