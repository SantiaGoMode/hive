// Health-forum triage — an owner reply in a finding thread wakes an LLM triage
// agent (github + memory tools) with the finding, its evidence block, and the
// thread conversation as context. It converses on ambiguity and files a GitHub
// issue on the Hive repo only on clear instruction, posting the link back.
const staffDirectory = require('../staffDirectory');
const { detectGitHubRepo } = require('../githubBoard');
const config = require('../config');
const { logger } = require('../logger');
const { personaTurn } = require('./turns');
const { chunkMessage, toolFooter, truncate } = require('./format');

const TRIAGE_RECIPE = 'discord';
const TRIAGE_ROLE_KEY = 'health_triage';
const TRIAGE_MAX_ROUNDS = 8;
const TRIAGE_TOOL_GROUPS = ['github', 'memory'];

const TRIAGE_PROMPT = `You are Hive's health triage agent, replying inside a health-alert thread on the operator's private Discord server. Each thread is one finding (a warning, alert, or suggestion about the Hive install) with a JSON evidence block.

Rules of engagement:
- The operator replied to the finding. Discuss it: explain likely causes from the evidence, answer questions, suggest fixes.
- File a GitHub issue ONLY when the operator clearly asks ("file it", "create an issue", "track this"). Use github_create_issue with the repo given below. The issue title should be specific; the body must include the finding, the evidence block (fenced JSON), likely cause, and a link back to this Discord thread if provided.
- Label alerts as bugs and suggestions as enhancements in the issue body text (mention the intended label — labels may need the operator to add them).
- After filing, state the issue URL plainly in your reply.
- If the operator's intent is ambiguous, ask — never file speculatively.
- Keep replies short and Discord-friendly. English only.`;

const TRIAGE_PERSONALITY = 'Incident-channel veteran. Reads the evidence before speaking, separates confirmed facts from hypotheses, and never files paperwork nobody asked for.';

function ensureTriageAgent() {
  let profile = staffDirectory.getProfileByRole(TRIAGE_RECIPE, TRIAGE_ROLE_KEY);
  if (!profile) {
    profile = staffDirectory.createProfile({
      recipe_id: TRIAGE_RECIPE,
      role_key: TRIAGE_ROLE_KEY,
      display_name: 'Health Triage',
      role: 'Site Reliability Triage',
      system_prompt: TRIAGE_PROMPT,
      personality: TRIAGE_PERSONALITY,
      skills: [],
      tools: TRIAGE_TOOL_GROUPS,
      avatar_color: '#ef4444',
    });
    logger.info('discord', 'triage_profile_created', { profileId: profile.id });
  }
  const result = staffDirectory.createAgentFromProfile(profile.id);
  return result?.agent || null;
}

// The Hive repo issues land in: explicit setting first, else the repo this
// server runs from.
function healthRepoSlug() {
  const setting = String(config.getSetting('discord_health_repo') || '').trim();
  if (setting) return setting;
  const detected = detectGitHubRepo(process.cwd());
  return detected ? `${detected.owner}/${detected.repo}` : null;
}

async function threadContext(thread) {
  const parts = [];
  try {
    const starter = await thread.fetchStarterMessage();
    if (starter?.content) parts.push(`[Finding]\n${truncate(starter.content, 2500)}`);
  } catch { /* starter may be deleted */ }
  try {
    const messages = await thread.messages.fetch({ limit: 12 });
    const ordered = [...messages.values()].reverse();
    const convo = ordered
      .filter(m => m.content)
      .map(m => `${m.author?.bot ? 'hive' : 'operator'}: ${truncate(m.content, 400)}`)
      .join('\n');
    if (convo) parts.push(`[Thread so far]\n${convo}`);
  } catch { /* history is optional context */ }
  return parts.join('\n\n');
}

const threadQueues = new Map(); // threadId → { tail, depth }

function handleHealthReply(message, { agentId, fingerprint }) {
  const threadId = message.channelId;
  const queue = threadQueues.get(threadId) || { tail: Promise.resolve(), depth: 0 };
  if (queue.depth > 0) message.react('⏳').catch(() => {});

  queue.depth++;
  queue.tail = queue.tail
    .then(() => processTurn(message, agentId, fingerprint))
    .catch(err => {
      logger.error('discord', 'triage_turn_failed', { fingerprint, error: err?.message || String(err) });
    })
    .finally(() => {
      queue.depth--;
      if (queue.depth === 0) threadQueues.delete(threadId);
    });
  threadQueues.set(threadId, queue);
  return queue.tail;
}

async function processTurn(message, agentId, fingerprint) {
  const thread = message.channel;
  const tick = () => thread.sendTyping().catch(() => {});
  tick();
  const interval = setInterval(tick, 8000);
  try {
    const repo = healthRepoSlug();
    const context = await threadContext(thread);
    const systemSuffix = [
      '[Triage context]',
      `Finding fingerprint: ${fingerprint}`,
      repo ? `GitHub repo for issues: ${repo}` : 'No GitHub repo is configured — say so if asked to file an issue (set discord_health_repo in Hive settings).',
      `Discord thread link: https://discord.com/channels/${message.guildId}/${thread.id}`,
      context,
    ].filter(Boolean).join('\n');

    const { text, toolCalls } = await personaTurn({
      agentId,
      conversationKey: `health_${thread.id}`,
      userContent: message.content,
      tools: TRIAGE_TOOL_GROUPS,
      maxRounds: TRIAGE_MAX_ROUNDS,
      systemSuffix,
    });
    const footer = toolFooter(toolCalls);
    const body = footer ? `${text}\n\n${footer}` : text;
    for (const chunk of chunkMessage(body)) {
      await thread.send({ content: chunk });
    }
  } catch (err) {
    await thread.send({ content: `⚠️ ${err.message}` }).catch(() => {});
  } finally {
    clearInterval(interval);
  }
}

module.exports = { ensureTriageAgent, handleHealthReply, healthRepoSlug, TRIAGE_RECIPE, TRIAGE_ROLE_KEY };
