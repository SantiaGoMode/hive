# Discord Bridge

Run Hive from your own private Discord server. One bot account, three personas:

| Channel | Persona | What it does |
| --- | --- | --- |
| `#general` (text) | **The Steward** | Executive assistant with every tool group, all connected MCP servers, and on-the-fly skill loading (`list_skills` / `load_skill`). Just talk to it. |
| `colony` (forum) | **The Operator** | One thread per colony team, created automatically. Instructions in a thread start missions (or steer a live run); questions get answered from team state. Step-by-step progress (✅/❌ mission board) and a final status card post automatically. |
| `health` (forum) | **The Sentinel** | Posts deduplicated findings — budget burn, provider outages, failed missions, blockers, repeated errors — one thread per problem, auto-resolved when it clears. Reply in a thread and a triage agent investigates and can file a GitHub issue. |

The full design lives in [docs/specs/discord-bridge.md](specs/discord-bridge.md).

## Setup

1. **Create the bot.** In the [Discord Developer Portal](https://discord.com/developers/applications): New Application → Bot. Under *Privileged Gateway Intents*, enable **Message Content Intent**. Copy the bot token.
2. **Invite it to your private server.** OAuth2 → URL Generator: scopes `bot` + `applications.commands`; bot permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Threads, Read Message History, Add Reactions. Open the generated URL and pick your server.
3. **Give Hive the token.** Settings → Discord Bridge in the Hive UI, or set `DISCORD_BOT_TOKEN` in the environment (env wins). The bridge hot-starts on save — no restart needed.
4. **Prepare the channels.** You need one text channel (e.g. `#general`) and two forum channels (e.g. `colony` and `health`). Default name-matching finds channels whose names contain `general` / `colony` / `health`.
5. **Run `/hive setup` in your server.** The first person to run it becomes the owner — the bridge ignores everyone else (default-deny). Pass `general:` / `colony:` / `health:` options to bind specific channels; re-running rebinds idempotently.
6. **Pick models.** The bridge personas are staff profiles — open the Staff page and set a model preference for **Steward**, **Colony Operator**, and **Health Triage**. Until a model is set, the persona replies with a pointer here instead of an answer.

## Slash commands

- `/hive setup` — bind channels, claim ownership (first run)
- `/hive status` — uptime, running missions, gateway health
- `/hive colonies` — roster with live status and queue depth
- `/hive stop team:<name>` — stop a colony's running mission
- `/hive new-session` — fresh conversation in the current channel/thread (sessions also roll after 24h idle)
- `/hive skills` — the skill catalog the Steward can load

## How the colony threads behave

- Every colony team gets exactly one thread, created within a minute of the team existing. Deleting a team archives its thread with a farewell post — history is never deleted.
- Message an **idle** team → the Operator starts a mission immediately (your message is the authorization). Message a **working** team → your message is injected as a high-priority direction the crew picks up between rounds.
- A mission posts: a start note, one mission-board message edited in place as steps flip 🔄→✅/❌, at most one orchestrator summary per round, questions when a human gate or permission block is hit, and a final status card (steps passed, duration, artifacts, summary). Token streams and raw logs never post.

## Security notes

- Only the owner allowlist gets responses; strangers in the server get silence — no acks, no side effects.
- The bot token is stored like every other Hive secret (masked in the UI, `0600` SQLite, env-var override).
- Everything the bridge posts to Discord leaves your machine: deliverable summaries, health evidence, mission goals. Keep the server private.
- Issues from health triage go to the repo in the `discord_health_repo` setting (`owner/repo`), falling back to the git remote of the Hive checkout itself.
