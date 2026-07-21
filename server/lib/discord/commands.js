// /hive slash commands — deterministic actions that shouldn't cost an LLM
// call: setup (bind channels + claim ownership), status, colonies, stop,
// new-session, skills. Registered per-guild so they're available instantly.
const db = require('../../db');
const colonyTeams = require('../colonyTeams');
const workItems = require('../colonyWorkItems');
const staffDirectory = require('../staffDirectory');
const gatewayHealth = require('../gatewayHealth');
const { logger } = require('../logger');
const bindings = require('./bindings');
const missions = require('./missions');
const steward = require('./steward');
const operator = require('./operator');
const { truncate, formatDuration } = require('./format');

// Raw application-command JSON (type 1 = subcommand, 3 = string, 7 = channel).
const HIVE_COMMAND = {
  name: 'hive',
  description: 'Control your Hive install',
  options: [
    {
      type: 1,
      name: 'setup',
      description: 'Bind this server\'s channels to Hive (first run claims ownership)',
      options: [
        { type: 7, name: 'general', description: 'Text channel for the Steward (default: #general or this channel)', required: false },
        { type: 7, name: 'colony', description: 'Forum for colony threads (default: forum named "colony")', required: false },
        { type: 7, name: 'health', description: 'Forum for health alerts (default: forum named "health")', required: false },
      ],
    },
    { type: 1, name: 'status', description: 'Hive system status digest' },
    { type: 1, name: 'colonies', description: 'Roster: every colony with live status and queue depth' },
    {
      type: 1,
      name: 'stop',
      description: 'Stop a colony\'s running mission',
      options: [{ type: 3, name: 'team', description: 'Colony name (or id)', required: true }],
    },
    {
      type: 1,
      name: 'report',
      description: 'Latest run report for a colony (status, summary, deliverable)',
      options: [{ type: 3, name: 'team', description: 'Colony name (or id)', required: true }],
    },
    {
      type: 1,
      name: 'queue',
      description: 'Show a colony\'s queued and in-flight work items',
      options: [{ type: 3, name: 'team', description: 'Colony name (or id)', required: true }],
    },
    { type: 1, name: 'staff', description: 'List the staff roster (personas, roles, models)' },
    { type: 1, name: 'new-session', description: 'Start a fresh conversation in this channel/thread' },
    { type: 1, name: 'skills', description: 'List the Hive skill catalog' },
    { type: 1, name: 'settings', description: 'Show non-secret Hive settings and bridge bindings' },
    {
      type: 2, // subcommand group
      name: 'schedule',
      description: 'Recurring missions a colony runs on a cron schedule',
      options: [
        {
          type: 1,
          name: 'add',
          description: 'Schedule a recurring mission for a colony',
          options: [
            { type: 3, name: 'team', description: 'Colony name (or id)', required: true },
            { type: 3, name: 'cron', description: 'Cron expression, e.g. "0 9 * * 1" = Mondays 9am', required: true },
            { type: 3, name: 'prompt', description: 'Instructions the Operator runs each time', required: true },
            { type: 3, name: 'label', description: 'Short name for this schedule (default: derived from the prompt)', required: false },
          ],
        },
        {
          type: 1,
          name: 'list',
          description: 'List colony schedules (optionally filtered to one colony)',
          options: [{ type: 3, name: 'team', description: 'Colony name (or id) to filter by', required: false }],
        },
        {
          type: 1,
          name: 'remove',
          description: 'Delete a colony schedule by id',
          options: [{ type: 3, name: 'id', description: 'Schedule id (from /hive schedule list)', required: true }],
        },
        {
          type: 1,
          name: 'pause',
          description: 'Pause or resume a colony schedule',
          options: [{ type: 3, name: 'id', description: 'Schedule id (from /hive schedule list)', required: true }],
        },
      ],
    },
  ],
};

// Resolve a colony team from a free-text arg: exact id/name first, then a
// case-insensitive substring match. Returns null on no match.
function resolveTeam(query) {
  const q = String(query || '').trim().toLowerCase();
  const teams = colonyTeams.listTeams();
  return teams.find(t => t.id === q || t.name.toLowerCase() === q)
    || teams.find(t => t.name.toLowerCase().includes(q))
    || null;
}

async function registerCommands(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set([HIVE_COMMAND]);
    } catch (e) {
      logger.error('discord', 'command_register_failed', { guildId: guild.id, error: e.message });
    }
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
async function handleInteraction(interaction, ctx) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'hive') return;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  // First-run ownership claim happens inside setup; everything else is
  // owner-only, default-deny.
  if (sub !== 'setup' && !bindings.isOwner(interaction.user.id)) {
    await interaction.reply({ content: 'This Hive install isn\'t yours to drive. Ask the owner, or run `/hive setup` on a fresh install.', ephemeral: true });
    return;
  }

  try {
    if (group === 'schedule') await handleSchedule(interaction, sub);
    else if (sub === 'setup') await handleSetup(interaction, ctx);
    else if (sub === 'status') await handleStatus(interaction);
    else if (sub === 'colonies') await handleColonies(interaction);
    else if (sub === 'stop') await handleStop(interaction);
    else if (sub === 'report') await handleReport(interaction);
    else if (sub === 'queue') await handleQueue(interaction);
    else if (sub === 'staff') await handleStaff(interaction);
    else if (sub === 'new-session') await handleNewSession(interaction);
    else if (sub === 'skills') await handleSkills(interaction);
    else if (sub === 'settings') await handleSettings(interaction);
  } catch (e) {
    logger.error('discord', 'command_failed', { sub, error: e.message });
    const payload = { content: `⚠️ ${e.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

async function handleSetup(interaction, ctx) {
  const owners = bindings.ownerIds();
  if (owners.length && !owners.includes(interaction.user.id)) {
    await interaction.reply({ content: 'This install already has an owner — only they can rebind it.', ephemeral: true });
    return;
  }
  await interaction.deferReply();
  if (!owners.length) bindings.addOwner(interaction.user.id);

  const guild = interaction.guild;
  const channels = await guild.channels.fetch();
  const byName = (name, wantForum) => channels.find(c =>
    c && (wantForum ? typeof c.threads?.create === 'function' && c.isThreadOnly?.() : c.isTextBased?.() && !c.isThread?.())
    && c.name.toLowerCase().includes(name),
  );

  const general = interaction.options.getChannel('general')
    || byName('general', false)
    || (interaction.channel?.isTextBased?.() && !interaction.channel.isThread?.() ? interaction.channel : null);
  const colonyForum = interaction.options.getChannel('colony') || byName('colony', true);
  const healthForum = interaction.options.getChannel('health') || byName('health', true);

  const bound = [];
  const missing = [];
  if (general) { bindings.setBinding('general', guild.id, general.id); bound.push(`Steward → <#${general.id}>`); }
  else missing.push('a text channel for the Steward (pass `general:`)');
  if (colonyForum) { bindings.setBinding('colony_forum', guild.id, colonyForum.id); bound.push(`Colonies → <#${colonyForum.id}>`); }
  else missing.push('a forum channel for colonies (pass `colony:`)');
  if (healthForum) { bindings.setBinding('health_forum', guild.id, healthForum.id); bound.push(`Health → <#${healthForum.id}>`); }
  else missing.push('a forum channel for health (pass `health:`)');

  if (typeof ctx?.onSetupComplete === 'function') {
    // Kick a reconcile so colony threads appear right away.
    ctx.onSetupComplete().catch(e => logger.error('discord', 'setup_reconcile_failed', { error: e.message }));
  }

  const lines = [
    `🐝 **Hive bound to this server.** Owner: <@${bindings.ownerIds()[0]}>`,
    ...bound.map(b => `✅ ${b}`),
    ...missing.map(m => `⚠️ Still missing ${m} — re-run \`/hive setup\` with the option set.`),
  ];
  await interaction.editReply({ content: lines.join('\n') });
}

async function handleStatus(interaction) {
  const runningRuns = db.prepare("SELECT COUNT(*) AS n FROM colonies WHERE status='running'").get().n;
  const teams = db.prepare('SELECT COUNT(*) AS n FROM colony_teams').get().n;
  const agents = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE ephemeral=0 OR ephemeral IS NULL').get().n;
  let gateway = null;
  try { gateway = gatewayHealth.getGatewayStatus(); } catch { /* gateway optional */ }
  const mem = process.memoryUsage();
  const lines = [
    '**Hive status**',
    `Uptime: ${formatDuration(process.uptime() * 1000)} · RSS: ${Math.round(mem.rss / 1024 / 1024)} MB`,
    `Colonies: ${teams} team${teams === 1 ? '' : 's'}, ${runningRuns} mission${runningRuns === 1 ? '' : 's'} running · Agents: ${agents}`,
    gateway?.enabled ? `Gateway: ${gateway.reachable ? '🟢 reachable' : `🔴 ${gateway.message || 'unreachable'}`}` : 'Gateway: not configured',
  ];
  await interaction.reply({ content: lines.join('\n') });
}

const STATUS_ICONS = { idle: '⚪', working: '🟢', blocked: '🔴' };
const STATUS_ICONS_RUN = { running: '🟢', done: '✅', complete: '✅', completed: '✅', error: '🔴', stopped: '🟡' };

async function handleColonies(interaction) {
  const teams = colonyTeams.listTeams();
  if (!teams.length) {
    await interaction.reply({ content: 'No colonies yet — found one in the Hive UI and its thread will appear in the colony forum.' });
    return;
  }
  const lines = teams.map(t => {
    const icon = STATUS_ICONS[t.status] || '⚪';
    const bits = [`${icon} **${t.name}**`, `\`${t.recipe_id}\``];
    if (t.active_run) bits.push(truncate(t.active_run.goal, 60));
    if (t.queue?.depth) bits.push(`${t.queue.depth} queued`);
    return bits.join(' · ');
  });
  await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
}

async function handleStop(interaction) {
  const query = interaction.options.getString('team');
  const team = resolveTeam(query);
  if (!team) {
    await interaction.reply({ content: `No colony matches "${query}".`, ephemeral: true });
    return;
  }
  const result = missions.stopTeamRun(team.id);
  await interaction.reply({
    content: result.stopped
      ? `🛑 Stopped **${team.name}**'s mission (\`${result.runId}\`).`
      : `**${team.name}** has no live mission.`,
  });
}

async function handleReport(interaction) {
  const query = interaction.options.getString('team');
  const team = resolveTeam(query);
  if (!team) {
    await interaction.reply({ content: `No colony matches "${query}".`, ephemeral: true });
    return;
  }
  const row = db.prepare('SELECT id, status, goal, summary, deliverable, created_at, updated_at FROM colonies WHERE team_id=? ORDER BY created_at DESC LIMIT 1').get(team.id);
  if (!row) {
    await interaction.reply({ content: `**${team.name}** has no runs yet.` });
    return;
  }
  let deliverable = null;
  try { deliverable = row.deliverable ? JSON.parse(row.deliverable) : null; } catch { /* deliverable optional */ }
  const icon = STATUS_ICONS_RUN[row.status] || '⚪';
  const lines = [
    `${icon} **${team.name}** — latest run \`${row.id}\` (${row.status})`,
    `> ${truncate(row.goal, 200)}`,
  ];
  const body = deliverable?.report || deliverable?.summary || row.summary || '_No summary recorded._';
  lines.push('', truncate(body, 1600));
  const links = deliverable?.links || [];
  if (links.length) lines.push('', ...links.slice(0, 5).map(l => `🔗 ${truncate(l, 200)}`));
  await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
}

async function handleQueue(interaction) {
  const query = interaction.options.getString('team');
  const team = resolveTeam(query);
  if (!team) {
    await interaction.reply({ content: `No colony matches "${query}".`, ephemeral: true });
    return;
  }
  const items = workItems.listWorkItems(team.id, { statuses: ['proposed', 'queued', 'claimed'] });
  if (!items.length) {
    await interaction.reply({ content: `**${team.name}**'s queue is empty.` });
    return;
  }
  const icon = { proposed: '💡', queued: '⬜', claimed: '🔄' };
  const lines = [`**${team.name}** — queue (${items.length})`];
  for (const it of items.slice(0, 20)) {
    lines.push(`${icon[it.status] || '•'} ${truncate(it.title || it.direction || '(untitled)', 120)}`);
  }
  if (items.length > 20) lines.push(`…and ${items.length - 20} more`);
  await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
}

async function handleStaff(interaction) {
  const profiles = staffDirectory.listProfiles();
  if (!profiles.length) {
    await interaction.reply({ content: 'No staff profiles yet.' });
    return;
  }
  // Group by recipe so the roster reads like the Staff page.
  const byRecipe = new Map();
  for (const p of profiles) {
    if (!byRecipe.has(p.recipe_id)) byRecipe.set(p.recipe_id, []);
    byRecipe.get(p.recipe_id).push(p);
  }
  const lines = ['**Staff roster**'];
  for (const [recipe, list] of byRecipe) {
    lines.push(`__${recipe}__`);
    for (const p of list) {
      const model = p.model_preference ? ` · \`${p.model_preference}\`` : '';
      lines.push(`• **${p.display_name}** — ${truncate(p.role || p.role_key, 40)}${model}`);
    }
  }
  await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
}

async function handleNewSession(interaction) {
  const info = bindings.threadInfo(interaction.channelId);
  if (info?.kind === 'colony') {
    operator.resetSession(info.ref);
    await interaction.reply({ content: '🧹 Fresh Operator session for this colony.' });
    return;
  }
  steward.resetSession(interaction.channelId);
  await interaction.reply({ content: '🧹 Fresh conversation — the Steward forgets this channel\'s chat history (memory notes persist).' });
}

async function handleSkills(interaction) {
  const rows = db.prepare('SELECT name, description FROM skills ORDER BY name').all();
  if (!rows.length) {
    await interaction.reply({ content: 'The skill catalog is empty.' });
    return;
  }
  const lines = rows.map(r => `• **${r.name}** — ${truncate(r.description || '', 80)}`);
  await interaction.reply({ content: truncate(`**Skill catalog** (the Steward can load any of these on the fly)\n${lines.join('\n')}`, 1990) });
}

async function handleSettings(interaction) {
  const setting = (key) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || '';
  const all = bindings.allBindings();
  const chan = (b) => (b ? `<#${b.channel_id}>` : '_unbound_');
  const lines = [
    '**Hive settings** (non-secret)',
    `Models endpoint: \`${setting('ollama_url') || '(default)'}\``,
    `LLM gateway: ${setting('llm_gateway_url') ? `\`${setting('llm_gateway_url')}\`` : '_not configured_'}`,
    `Webhook public URL: ${setting('webhook_public_url') ? `\`${setting('webhook_public_url')}\`` : '_not set_'}`,
    `Health repo: ${setting('discord_health_repo') ? `\`${setting('discord_health_repo')}\`` : '_not set_'}`,
    '',
    '**Bridge bindings**',
    `Steward (#general): ${chan(all.general)}`,
    `Colony forum: ${chan(all.colony_forum)}`,
    `Health forum: ${chan(all.health_forum)}`,
    `Owners: ${bindings.ownerIds().length}`,
    '',
    '-# Secrets/API keys are managed on the Settings page, not here.',
  ];
  await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
}

// ── /hive schedule (colony cron missions) ─────────────────────────────────────
// Thin Discord wrapper over the shared colonySchedules helper so the command,
// the Operator tools, and the web UI all create/manage the same records.
const colonySchedules = require('../colonySchedules');

async function handleSchedule(interaction, action) {
  if (action === 'add') {
    const query = interaction.options.getString('team');
    const cronExpr = interaction.options.getString('cron').trim();
    const prompt = interaction.options.getString('prompt').trim();
    const label = (interaction.options.getString('label') || '').trim();
    const team = resolveTeam(query);
    if (!team) { await interaction.reply({ content: `No colony matches "${query}".`, ephemeral: true }); return; }
    let row;
    try { row = colonySchedules.createColonySchedule(team.id, { cronExpr, prompt, label }); }
    catch (e) { await interaction.reply({ content: `⚠️ ${e.message}`, ephemeral: true }); return; }
    await interaction.reply({
      content: [
        `⏰ Scheduled **${row.label}** for **${team.name}**`,
        `Cron: \`${row.cron_expr}\` · id: \`${row.id}\``,
        `> ${truncate(prompt, 300)}`,
        '-# Each fire launches a mission (or queues it if the team is busy). Manage with `/hive schedule list|pause|remove`.',
      ].join('\n'),
    });
    return;
  }

  if (action === 'list') {
    const query = interaction.options.getString('team');
    let team = null;
    if (query) {
      team = resolveTeam(query);
      if (!team) { await interaction.reply({ content: `No colony matches "${query}".`, ephemeral: true }); return; }
    }
    const rows = colonySchedules.listColonySchedules(team?.id || null);
    if (!rows.length) {
      await interaction.reply({ content: query ? 'That colony has no schedules yet. Add one with `/hive schedule add`.' : 'No colony schedules yet. Add one with `/hive schedule add`.' });
      return;
    }
    const teamName = (tid) => colonyTeams.getTeam(tid)?.name || tid;
    const lines = ['**Colony schedules**'];
    for (const r of rows.slice(0, 20)) {
      const state = r.enabled ? '🟢' : '⏸️';
      const last = r.last_error ? ` · ⚠️ ${truncate(r.last_error, 40)}` : (r.last_run ? ` · last ${formatDuration((Math.floor(Date.now() / 1000) - r.last_run) * 1000)} ago` : '');
      lines.push(`${state} **${truncate(r.label, 40)}** — ${teamName(r.team_id)} · \`${r.cron_expr}\` · \`${r.id}\`${last}`);
    }
    if (rows.length > 20) lines.push(`…and ${rows.length - 20} more`);
    await interaction.reply({ content: truncate(lines.join('\n'), 1990) });
    return;
  }

  if (action === 'remove') {
    const id = interaction.options.getString('id').trim();
    const row = colonySchedules.removeColonySchedule(id);
    if (!row) { await interaction.reply({ content: `No colony schedule with id \`${truncate(id, 40)}\`. Run \`/hive schedule list\` to see ids.`, ephemeral: true }); return; }
    await interaction.reply({ content: `🗑️ Removed schedule **${truncate(row.label, 48)}** (\`${row.id}\`).` });
    return;
  }

  if (action === 'pause') {
    const id = interaction.options.getString('id').trim();
    const current = colonySchedules.getColonySchedule(id);
    if (!current) { await interaction.reply({ content: `No colony schedule with id \`${truncate(id, 40)}\`. Run \`/hive schedule list\` to see ids.`, ephemeral: true }); return; }
    const row = colonySchedules.setColonyScheduleEnabled(id, !current.enabled);
    await interaction.reply({ content: row.enabled ? `▶️ Resumed **${truncate(row.label, 48)}**.` : `⏸️ Paused **${truncate(row.label, 48)}** — it won't fire until resumed.` });
    return;
  }
}

module.exports = { HIVE_COMMAND, registerCommands, handleInteraction };
