// The Colony Operator — the LLM persona fronting each colony forum thread.
// One shared staff profile backs every team; per-turn the bridge injects the
// team's identity + live snapshot into the system prompt and binds the team id
// into colonyContext so the operator_tools act on the right team. Instructions
// become missions (start_mission / queue_work / send_direction); questions get
// answered from team state without launching anything.
const staffDirectory = require('../staffDirectory');
const colonyTeams = require('../colonyTeams');
const workItems = require('../colonyWorkItems');
const { readAgent } = require('../agentParser');
const { logger } = require('../logger');
const sessions = require('./sessions');
const { personaTurn } = require('./turns');
const { chunkMessage, toolFooter, truncate } = require('./format');
const missions = require('./missions');

const OPERATOR_RECIPE = 'discord';
const OPERATOR_ROLE_KEY = 'colony_operator';
const OPERATOR_MAX_ROUNDS = 8;
const OPERATOR_TOOL_GROUPS = ['colony_operator'];

const OPERATOR_PROMPT = `You are the Operator for a Hive colony team, speaking in the team's Discord thread. The human you talk to runs this Hive install; your job is to take their instructions and turn them into missions, and to answer their questions about the team from real state.

Rules of engagement:
- An INSTRUCTION ("fix the flaky auth test", "ship the changelog") is authorization to act now: if the team is idle call start_mission; if a mission is live call send_direction; if the human says "later" or the team is mid-mission and the work is separate, call queue_work. Never ask "shall I start?" — the message is the go.
- A QUESTION ("what shipped last run?", "why is step 3 failing?", "who's on this team?") is answered from get_team_status / get_run_report. Never launch anything for a question.
- Always check get_team_status first when you're unsure whether a mission is live.
- Confirm actions concisely: what started/queued, the run id, and what happens next. Progress (step pass/fail, final status) posts to the thread automatically — don't promise to narrate it yourself.
- Keep replies short and Discord-friendly. Answer in English only.`;

const OPERATOR_PERSONALITY = 'Seasoned mission control. Calm, decisive, brief. Translates fuzzy asks into crisp directions and reads the team\'s state before speaking.';

function ensureOperatorAgent() {
  let profile = staffDirectory.getProfileByRole(OPERATOR_RECIPE, OPERATOR_ROLE_KEY);
  if (!profile) {
    profile = staffDirectory.createProfile({
      recipe_id: OPERATOR_RECIPE,
      role_key: OPERATOR_ROLE_KEY,
      display_name: 'Colony Operator',
      role: 'Mission Operator',
      system_prompt: OPERATOR_PROMPT,
      personality: OPERATOR_PERSONALITY,
      skills: [],
      tools: OPERATOR_TOOL_GROUPS,
      avatar_color: '#8b5cf6',
    });
    logger.info('discord', 'operator_profile_created', { profileId: profile.id });
  }
  const result = staffDirectory.createAgentFromProfile(profile.id);
  return result?.agent || null;
}

// Compact live snapshot injected into the system prompt each turn — the
// Operator never answers from stale context.
function teamSnapshot(team) {
  const live = colonyTeams.liveStatusForTeam(team.id);
  let queue = { proposed: 0, queued: 0, claimed: 0, depth: 0 };
  try { queue = workItems.queueCountsForTeam(team.id); } catch { /* queue counts are cosmetic here */ }
  const lines = [
    '[Team snapshot — live, trust this over memory]',
    `Team: ${team.name} (${team.recipe_id})${team.repo_path ? ` · repo: ${team.repo_path}` : ''}`,
    team.description ? `Charter: ${truncate(team.description, 200)}` : '',
    `Status: ${live.status}${live.active_run ? ` · active run ${live.active_run.id}: ${truncate(live.active_run.goal, 140)}` : ''}`,
    `Queue: ${queue.queued} queued, ${queue.proposed} proposed, ${queue.claimed} in flight`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ── Discord-facing handler ────────────────────────────────────────────────────
const threadQueues = new Map(); // threadId → { tail, depth }

function handleColonyThreadMessage(message, { agentId, teamId }) {
  const threadId = message.channelId;
  const queue = threadQueues.get(threadId) || { tail: Promise.resolve(), depth: 0 };
  if (queue.depth > 0) message.react('⏳').catch(() => {});

  queue.depth++;
  queue.tail = queue.tail
    .then(() => processTurn(message, agentId, teamId))
    .catch(err => {
      logger.error('discord', 'operator_turn_failed', { teamId, error: err?.message || String(err) });
    })
    .finally(() => {
      queue.depth--;
      if (queue.depth === 0) threadQueues.delete(threadId);
    });
  threadQueues.set(threadId, queue);
  return queue.tail;
}

async function processTurn(message, agentId, teamId) {
  const typing = { stop: () => {} };
  try {
    const team = colonyTeams.getTeam(teamId);
    if (!team) {
      await message.channel.send({ content: '⚠️ This thread\'s colony no longer exists.' }).catch(() => {});
      return;
    }
    const tick = () => message.channel.sendTyping().catch(() => {});
    tick();
    const interval = setInterval(tick, 8000);
    typing.stop = () => clearInterval(interval);

    const agent = readAgent(agentId);
    const { text, toolCalls } = await personaTurn({
      agentId,
      conversationKey: `operator_${teamId}`,
      userContent: message.content,
      tools: OPERATOR_TOOL_GROUPS,
      maxRounds: OPERATOR_MAX_ROUNDS,
      systemSuffix: teamSnapshot(team),
      colonyContext: {
        discordTeamId: teamId,
        discordOperatorModel: agent?.model || null,
        source: 'discord_operator',
      },
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

function resetSession(teamId) {
  sessions.resetConversation(`operator_${teamId}`);
}

module.exports = {
  ensureOperatorAgent,
  handleColonyThreadMessage,
  teamSnapshot,
  resetSession,
  OPERATOR_RECIPE,
  OPERATOR_ROLE_KEY,
  missionsLib: missions,
};
