// The Steward — the executive assistant behind #general. A real Hive agent
// backed by a staff profile (editable on the Staff page: model, prompt,
// personality), invoked through the shared persona-turn engine with every
// built-in tool group, the runtime skill loader, and all connected MCP servers.
const staffDirectory = require('../staffDirectory');
const { builtInToolCatalog } = require('../tools/registry');
const mcpManager = require('../mcpClient');
const { logger } = require('../logger');
const sessions = require('./sessions');
const { personaTurn } = require('./turns');
const { chunkMessage, toolFooter } = require('./format');

const STEWARD_RECIPE = 'discord';
const STEWARD_ROLE_KEY = 'steward';
const STEWARD_MAX_ROUNDS = 12;

const STEWARD_PROMPT = `You are the Steward — Hive's executive assistant, reachable through the operator's private Discord server. You are the operator's chief of staff for their whole Hive install: agents, colonies, pipelines, schedules, skills, and every connected tool.

How to work:
- You have broad tool access (sandbox, web search, memory, colony tools, agent delegation, GitHub, MCP servers) plus list_skills/load_skill to pull specialist skills from the catalog mid-conversation. When a request matches a cataloged skill, load it before answering.
- You administer the whole install, not just the live agent roster. Use list_staff/get_staff/update_staff to view and retune the staff profiles (personas, prompts, models, skills, tools) that back every crew and bridge persona — these are distinct from live agents (list_agents). Use list_tool_groups to see grantable tools, create_skill/update_skill/delete_skill to manage the skill catalog, and get_settings/update_setting for non-secret settings. When the operator asks to "list/change staff, skills, tools, or settings," reach for these — don't just dump the agent list.
- To START A COLONY RUN / kick off a mission for a named team, call start_colony_mission with the team name and the work item — that launches the real seeded crew and its handoff flow. NEVER fulfill a colony-run request by creating agents (create_agent) or building a pipeline (create_pipeline/run_pipeline) — those are unrelated primitives and will not run the team's crew.
- Act first, ask second: for read-only work (status checks, searches, summaries) just do it. Confirm before destructive or expensive actions.
- You are on Discord: keep answers tight and mobile-readable. Short paragraphs, minimal headers, code blocks only for actual code or command output. Never dump raw tool output — distill it.
- Remember durable facts about the operator and their projects with save_memory.
- Answer in English only.`;

const STEWARD_PERSONALITY = 'Unflappable chief of staff. Direct, warm, zero filler. Anticipates the follow-up question and answers it in the same breath. Says plainly when something failed or is unknown.';

function ensureStewardAgent() {
  let profile = staffDirectory.getProfileByRole(STEWARD_RECIPE, STEWARD_ROLE_KEY);
  if (!profile) {
    profile = staffDirectory.createProfile({
      recipe_id: STEWARD_RECIPE,
      role_key: STEWARD_ROLE_KEY,
      display_name: 'Steward',
      role: 'Executive Assistant',
      system_prompt: STEWARD_PROMPT,
      personality: STEWARD_PERSONALITY,
      skills: [],
      tools: stewardToolGroups(),
      avatar_color: '#f59e0b',
    });
    logger.info('discord', 'steward_profile_created', { profileId: profile.id });
  }
  // createAgentFromProfile updates the linked agent in place, so Staff-page
  // edits (model_preference, prompt, personality) flow through on every boot.
  const result = staffDirectory.createAgentFromProfile(profile.id);
  return result?.agent || null;
}

// Full capability: every non-internal built-in group + runtime skill loading
// + all connected MCP servers, resolved fresh at invocation time.
function stewardToolGroups() {
  const internal = new Set(['delegation', 'protocol_worker', 'sandbox_files', 'colony_operator']);
  const builtin = Object.keys(builtInToolCatalog()).filter(g => !internal.has(g));
  let mcp = [];
  try {
    mcp = mcpManager.getStatus().filter(s => s.connected).map(s => `mcp:${s.id}`);
  } catch { /* MCP manager not loaded yet — built-ins still apply */ }
  return [...new Set([...builtin, ...mcp])];
}

// ── Discord-facing handler ────────────────────────────────────────────────────
// Strict per-channel ordering: one turn at a time, later messages queue and
// get an ⏳ reaction so the operator knows they were seen.
const channelQueues = new Map(); // channelId → { tail: Promise, depth: number }

function handleGeneralMessage(message, { agentId }) {
  const channelId = message.channelId;
  const queue = channelQueues.get(channelId) || { tail: Promise.resolve(), depth: 0 };
  if (queue.depth > 0) message.react('⏳').catch(() => {});

  queue.depth++;
  queue.tail = queue.tail
    .then(() => processTurn(message, agentId))
    .catch(err => {
      logger.error('discord', 'steward_turn_failed', { error: err?.message || String(err) });
    })
    .finally(() => {
      queue.depth--;
      if (queue.depth === 0) channelQueues.delete(channelId);
    });
  channelQueues.set(channelId, queue);
  return queue.tail;
}

async function processTurn(message, agentId) {
  const typing = startTyping(message.channel);
  try {
    const { text, toolCalls } = await personaTurn({
      agentId,
      conversationKey: `general_${message.channelId}`,
      userContent: message.content,
      tools: stewardToolGroups(),
      maxRounds: STEWARD_MAX_ROUNDS,
    });
    const footer = toolFooter(toolCalls);
    const body = footer ? `${text}\n\n${footer}` : text;
    for (const chunk of chunkMessage(body)) {
      await message.channel.send({ content: chunk });
    }
  } catch (err) {
    await message.channel.send({ content: `⚠️ ${err.message}` }).catch(() => {});
  } finally {
    typing.stop();
  }
}

function startTyping(channel) {
  const tick = () => channel.sendTyping().catch(() => {});
  tick();
  const interval = setInterval(tick, 8000);
  return { stop: () => clearInterval(interval) };
}

function resetSession(channelId) {
  sessions.resetConversation(`general_${channelId}`);
}

module.exports = {
  ensureStewardAgent,
  stewardToolGroups,
  handleGeneralMessage,
  resetSession,
  STEWARD_RECIPE,
  STEWARD_ROLE_KEY,
};
