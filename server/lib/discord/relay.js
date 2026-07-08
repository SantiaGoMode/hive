// Colony forum relay — the deterministic half of the colony threads. Keeps one
// forum thread per colony team (created on reconcile, archived with a farewell
// when the team goes away) and translates colonyBus events into milestone
// posts: an edited-in-place mission board, at most one orchestrator summary per
// round, human-gate questions, and a final status card. Token/log/thinking
// events never reach Discord.
const db = require('../../db');
const colonyTeams = require('../colonyTeams');
const { getBus } = require('../colonyBus');
const { onRoster } = require('../rosterBus');
const { logger } = require('../logger');
const bindings = require('./bindings');
const { missionBoard, statusCard, chunkMessage, truncate } = require('./format');

const BOARD_EDIT_THROTTLE_MS = 2000;

// colonyId → watcher state
const watchers = new Map();
let client = null;
let unsubscribeRoster = null;
let reconcileTimer = null;

function safeParse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function ownerMention() {
  const [first] = bindings.ownerIds();
  return first ? `<@${first}>` : '';
}

// ── Thread lifecycle ──────────────────────────────────────────────────────────
function teamCard(team) {
  const overview = colonyTeams.teamOverview(team.id);
  const crew = (overview?.crew || []).map(c => c.display_name).filter(Boolean);
  const lines = [
    `**${team.name}**`,
    team.description ? `> ${truncate(team.description, 300)}` : '',
    `Recipe: \`${team.recipe_id}\`${team.repo_path ? ` · Repo: \`${team.repo_path}\`` : ''}`,
    crew.length ? `Crew: ${crew.join(', ')}` : '',
    '',
    'Talk to this team\'s **Operator** here — instructions start missions, questions get answers. Mission progress posts automatically.',
  ];
  return lines.filter(l => l !== '').join('\n');
}

async function fetchForum() {
  const binding = bindings.getBinding('colony_forum');
  if (!binding || !client) return null;
  try {
    const channel = await client.channels.fetch(binding.channel_id);
    return channel?.threads ? channel : null;
  } catch {
    return null;
  }
}

async function fetchThread(threadId) {
  try {
    const thread = await client.channels.fetch(threadId);
    return thread?.isThread?.() ? thread : null;
  } catch {
    return null;
  }
}

async function ensureTeamThread(team) {
  const existingId = bindings.threadIdForRef('colony', team.id);
  if (existingId) {
    const thread = await fetchThread(existingId);
    if (thread) return thread;
    bindings.deleteThread(existingId); // deleted on Discord → recreate below
  }
  const forum = await fetchForum();
  if (!forum) return null;
  const thread = await forum.threads.create({
    name: truncate(team.name, 96),
    message: { content: teamCard(team) },
  });
  bindings.saveThread(thread.id, 'colony', team.id);
  logger.info('discord', 'colony_thread_created', { teamId: team.id, threadId: thread.id });
  return thread;
}

// Reflect a team edit (rename, description, recipe, repo) in its forum thread:
// rename the thread and rewrite the pinned starter card. Thread renames are
// heavily rate-limited by Discord (≈2 per 10 min), so only rename on an actual
// change.
async function syncTeamThread(teamId) {
  if (!client) return;
  const team = colonyTeams.getTeam(teamId);
  if (!team) return;
  const threadId = bindings.threadIdForRef('colony', teamId);
  if (!threadId) return; // no thread yet — reconcile/attachRun will create it
  const thread = await fetchThread(threadId);
  if (!thread) return;

  const wantName = truncate(team.name, 96);
  if (thread.name !== wantName) {
    await thread.setName(wantName).catch(e => logger.warn('discord', 'thread_rename_failed', { teamId, error: e.message }));
  }
  try {
    const starter = await thread.fetchStarterMessage();
    if (starter?.editable) await starter.edit({ content: teamCard(team) });
  } catch (e) {
    logger.warn('discord', 'thread_card_edit_failed', { teamId, error: e.message });
  }
}

// Every team has a live thread; threads whose team vanished get a farewell and
// are archived (never deleted — the history is the point).
async function reconcile() {
  if (!client) return;
  const forum = await fetchForum();
  if (!forum) return;
  let teams = [];
  try { teams = colonyTeams.listTeams(); } catch (e) {
    logger.error('discord', 'reconcile_teams_failed', { error: e.message });
    return;
  }
  const teamIds = new Set(teams.map(t => t.id));
  for (const team of teams) {
    try { await ensureTeamThread(team); } catch (e) {
      logger.error('discord', 'ensure_thread_failed', { teamId: team.id, error: e.message });
    }
  }
  for (const row of bindings.listThreads('colony')) {
    if (teamIds.has(row.ref)) continue;
    const thread = await fetchThread(row.thread_id);
    if (thread) {
      await thread.send({ content: '🪦 This colony was disbanded. Thanks for the missions — archiving the thread.' }).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
    bindings.deleteThread(row.thread_id);
  }
}

// ── Run watching ──────────────────────────────────────────────────────────────
function teamIdForRun(colonyId) {
  return db.prepare('SELECT team_id FROM colonies WHERE id=?').get(colonyId)?.team_id || null;
}

async function attachRun(colonyId) {
  if (!client || watchers.has(colonyId)) return;
  const teamId = teamIdForRun(colonyId);
  if (!teamId) return; // teamless runs (tests, scripts) have no thread
  const team = colonyTeams.getTeam(teamId);
  if (!team) return;
  const thread = await ensureTeamThread(team);
  if (!thread) return;

  const run = db.prepare('SELECT goal, created_at FROM colonies WHERE id=?').get(colonyId);
  const state = {
    colonyId,
    teamId,
    thread,
    goal: run?.goal || '',
    startedAt: (run?.created_at || Math.floor(Date.now() / 1000)) * 1000,
    boardMessage: null,
    boardTimer: null,
    pendingPlan: null,
    lastBoardEditAt: 0,
    roundsPosted: new Set(),
    detached: false,
    listener: null,
  };
  state.listener = (event) => { handleEvent(state, event).catch(e => {
    logger.error('discord', 'relay_event_failed', { colonyId, error: e?.message || String(e) });
  }); };
  getBus(colonyId).on('event', state.listener);
  watchers.set(colonyId, state);

  await thread.send({ content: `🚀 **Mission started** — ${truncate(state.goal, 300)}\n-# run \`${colonyId}\`` }).catch(() => {});
}

function detachRun(state) {
  if (state.detached) return;
  state.detached = true;
  if (state.boardTimer) { clearTimeout(state.boardTimer); state.boardTimer = null; }
  try { getBus(state.colonyId).off('event', state.listener); } catch { /* bus may be gone */ }
  watchers.delete(state.colonyId);
}

async function handleEvent(state, event) {
  if (!event || state.detached) return;
  switch (event.type) {
    case 'plan_update':
      state.pendingPlan = event.plan;
      scheduleBoardEdit(state);
      break;
    case 'orchestrator_message': {
      const round = event.round ?? 0;
      if (state.roundsPosted.has(round)) break;
      state.roundsPosted.add(round);
      const content = truncate(String(event.content || '').trim(), 900);
      if (content) {
        await state.thread.send({ content: `🗣️ **Round ${round}** — ${content}` }).catch(() => {});
      }
      break;
    }
    case 'handoff': {
      const h = event.handoff || {};
      if (!h.requires_human) break;
      await state.thread.send({
        content: `✋ ${ownerMention()} **Human gate**: ${truncate(h.contract || `${h.from} → ${h.to}`, 500)}\nReview it in the Hive UI, or answer here and I'll pass it on.`,
      }).catch(() => {});
      break;
    }
    case 'permission_required':
      await state.thread.send({
        content: `🔐 ${ownerMention()} **Permission needed** — \`${event.tool || 'tool'}\`: ${truncate(event.message || '', 400)}`,
      }).catch(() => {});
      break;
    case 'direction_queued':
      await state.thread.send({ content: `📨 Direction queued for the crew: ${truncate(event.direction?.content || '', 200)}` }).catch(() => {});
      break;
    case 'direction_delivered':
      await state.thread.send({ content: '📬 Direction delivered to the crew.' }).catch(() => {});
      break;
    case 'done':
    case 'error':
      await flushBoard(state);
      await postFinalCard(state, event);
      detachRun(state);
      break;
    default:
      break; // tokens, thinking, log entries: never posted
  }
}

// Edit the single mission-board message in place, at most one edit per
// BOARD_EDIT_THROTTLE_MS (trailing edit guaranteed).
function scheduleBoardEdit(state) {
  if (state.boardTimer) return;
  const wait = Math.max(0, BOARD_EDIT_THROTTLE_MS - (Date.now() - state.lastBoardEditAt));
  state.boardTimer = setTimeout(() => {
    state.boardTimer = null;
    flushBoard(state).catch(e => {
      logger.error('discord', 'board_edit_failed', { colonyId: state.colonyId, error: e?.message || String(e) });
    });
  }, wait);
}

async function flushBoard(state) {
  if (!state.pendingPlan) return;
  const content = truncate(missionBoard(state.pendingPlan, { goal: state.goal, runId: state.colonyId }), 1990);
  state.pendingPlan = null;
  state.lastBoardEditAt = Date.now();
  if (state.boardMessage) {
    await state.boardMessage.edit({ content }).catch(() => { state.boardMessage = null; });
    if (state.boardMessage) return;
  }
  state.boardMessage = await state.thread.send({ content }).catch(() => null);
}

// Discord's per-message upload ceiling on an unboosted server. Larger files are
// named but not uploaded (they stay downloadable from the colony overview).
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 10;

async function postFinalCard(state, event) {
  const row = db.prepare('SELECT status, goal, plan, summary, deliverable, repo_path, created_at, updated_at FROM colonies WHERE id=?').get(state.colonyId);
  const plan = safeParse(row?.plan, null);
  const deliverable = safeParse(row?.deliverable, null);
  const status = event.type === 'error' ? 'error' : (event.status || row?.status || 'done');
  const card = statusCard({
    status,
    goal: row?.goal || state.goal,
    steps: plan?.steps || [],
    durationMs: row ? (row.updated_at - row.created_at) * 1000 : Date.now() - state.startedAt,
    summary: deliverable?.summary || row?.summary || (event.type === 'error' ? event.message : '') || '',
    artifacts: [...(deliverable?.artifacts || []), ...(deliverable?.links || [])],
    runId: state.colonyId,
  });
  for (const chunk of chunkMessage(card)) {
    await state.thread.send({ content: chunk }).catch(() => {});
  }

  // The status card carries only the short summary. When the run produced a
  // full report (research briefs, syntheses), post it in its own chunked
  // message(s) so the actual deliverable isn't truncated away in the thread.
  const report = String(deliverable?.report || '').trim();
  const summary = String(deliverable?.summary || row?.summary || '').trim();
  if (report && report !== summary) {
    await state.thread.send({ content: '📄 **Full report**' }).catch(() => {});
    for (const chunk of chunkMessage(report)) {
      await state.thread.send({ content: chunk }).catch(() => {});
    }
  }

  // Repo-backed runs: link the code rather than upload it. Repo-less runs: send
  // every produced artifact (media, report, files) as downloadable attachments.
  if (row?.repo_path) {
    await postRepoLinks(state, row.repo_path).catch(e => logger.warn('discord', 'repo_link_failed', { colonyId: state.colonyId, error: e.message }));
  } else {
    await uploadArtifacts(state).catch(e => logger.warn('discord', 'artifact_upload_failed', { colonyId: state.colonyId, error: e.message }));
  }
}

async function postRepoLinks(state, repoPath) {
  let gh = null;
  try { gh = require('../githubBoard').detectGitHubRepo(repoPath); } catch { gh = null; }
  if (!gh) return;
  const base = `https://github.com/${gh.owner}/${gh.repo}`;
  const lines = [
    '📦 **Repository**',
    base,
    `🌿 Run branch: ${base}/tree/colony-${state.colonyId}`,
  ];
  await state.thread.send({ content: lines.join('\n') }).catch(() => {});
}

async function uploadArtifacts(state) {
  const artifactsLib = require('../colonyArtifacts');
  const files = artifactsLib.listArtifacts(state.colonyId);
  if (!files.length) return;
  const uploadable = files.filter(f => f.size > 0 && f.size <= MAX_UPLOAD_BYTES);
  const skipped = files.filter(f => f.size > MAX_UPLOAD_BYTES);
  for (let i = 0; i < uploadable.length; i += MAX_FILES_PER_MESSAGE) {
    const batch = uploadable.slice(i, i + MAX_FILES_PER_MESSAGE).map(f => ({
      attachment: artifactsLib.resolveArtifact(state.colonyId, f.name),
      name: f.name,
    }));
    await state.thread.send({
      content: i === 0 ? `📎 **Artifacts** (${uploadable.length} file${uploadable.length === 1 ? '' : 's'})` : null,
      files: batch,
    }).catch(e => logger.warn('discord', 'artifact_batch_failed', { colonyId: state.colonyId, error: e.message }));
  }
  if (skipped.length) {
    await state.thread.send({
      content: `⚠️ Too large to upload here (open them from the colony overview): ${skipped.map(f => f.name).join(', ')}`,
    }).catch(() => {});
  }
}

// ── Service lifecycle ─────────────────────────────────────────────────────────
async function start(discordClient) {
  client = discordClient;
  await reconcile();
  // Roster hints cover run starts from ANY launch path (UI, webhook, queue,
  // Discord). Team create/delete has no event — the periodic reconcile catches it.
  unsubscribeRoster = onRoster((event) => {
    if (event.reason === 'run_started' && event.run_id) {
      attachRun(event.run_id).catch(e => logger.error('discord', 'attach_run_failed', { runId: event.run_id, error: e.message }));
    } else if (event.reason === 'team_updated' && event.team_id) {
      syncTeamThread(event.team_id).catch(e => logger.error('discord', 'team_sync_failed', { teamId: event.team_id, error: e.message }));
    }
  });
  reconcileTimer = setInterval(() => {
    reconcile().catch(e => logger.error('discord', 'reconcile_failed', { error: e.message }));
  }, 60_000);
  reconcileTimer.unref?.();
  // Reattach to runs already live (bridge restarted mid-run).
  for (const row of db.prepare("SELECT id FROM colonies WHERE status='running'").all()) {
    attachRun(row.id).catch(e => logger.error('discord', 'reattach_failed', { runId: row.id, error: e.message }));
  }
}

function stop() {
  if (unsubscribeRoster) { unsubscribeRoster(); unsubscribeRoster = null; }
  if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
  for (const state of [...watchers.values()]) detachRun(state);
  client = null;
}

function threadTeamId(threadId) {
  const info = bindings.threadInfo(threadId);
  return info?.kind === 'colony' ? info.ref : null;
}

module.exports = { start, stop, reconcile, attachRun, syncTeamThread, threadTeamId, teamCard };
