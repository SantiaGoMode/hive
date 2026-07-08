// The Discord bridge (spec: docs/specs/discord-bridge.md). One bot account,
// three personas: the Steward (#general executive assistant), the Colony
// Operator (one LLM-fronted forum thread per team, with a deterministic event
// relay underneath), and the Sentinel (health findings + triage replies).
//
// Lifecycle: started from the server boot block when a bot token is
// configured; hot-starts/stops when the token setting changes. Hive core never
// blocks on Discord — every failure lands in the logger and the bridge
// reconnects with discord.js's built-in backoff.
const { settingSecret } = require('../secrets');
const config = require('../config');
const { logger } = require('../logger');
const bindings = require('./bindings');
const steward = require('./steward');
const operator = require('./operator');
const relay = require('./relay');
const sentinel = require('./sentinel');
const triage = require('./triage');
const commands = require('./commands');

const state = {
  status: 'disabled', // disabled | starting | connected | error
  error: null,
  client: null,
  guild: null,
  agents: { steward: null, operator: null, triage: null },
  lastToken: null,
  starting: false,
};

function currentToken() {
  return settingSecret('discord_bot_token', ['DISCORD_BOT_TOKEN']);
}

async function start() {
  if (state.starting || state.client) return;
  const token = currentToken();
  state.lastToken = token;
  if (!token) {
    state.status = 'disabled';
    logger.info('discord', 'bridge_disabled', { hint: 'Set a Discord bot token (Settings or DISCORD_BOT_TOKEN) to enable the bridge.' });
    return;
  }
  state.starting = true;
  state.status = 'starting';

  try {
    // Lazy require keeps discord.js off the boot path for installs without a token.
    const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');

    // Seed the bridge personas (staff profiles + agents) before going online.
    try {
      state.agents.steward = steward.ensureStewardAgent()?.id || null;
      state.agents.operator = operator.ensureOperatorAgent()?.id || null;
      state.agents.triage = triage.ensureTriageAgent()?.id || null;
    } catch (e) {
      logger.error('discord', 'persona_seed_failed', { error: e.message });
    }

    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });

    client.once(Events.ClientReady, async (ready) => {
      state.status = 'connected';
      state.guild = ready.guilds.cache.first()?.name || null;
      logger.info('discord', 'bridge_connected', { user: ready.user.tag, guilds: ready.guilds.cache.size });
      await commands.registerCommands(client);
      try { await relay.start(client); } catch (e) { logger.error('discord', 'relay_start_failed', { error: e.message }); }
      try { sentinel.start(client); } catch (e) { logger.error('discord', 'sentinel_start_failed', { error: e.message }); }
    });

    client.on(Events.GuildCreate, (guild) => {
      guild.commands.set([commands.HIVE_COMMAND]).catch(e =>
        logger.error('discord', 'command_register_failed', { guildId: guild.id, error: e.message }));
    });

    client.on(Events.MessageCreate, (message) => {
      handleMessage(message).catch(e =>
        logger.error('discord', 'message_handler_failed', { error: e?.message || String(e) }));
    });

    client.on(Events.InteractionCreate, (interaction) => {
      commands.handleInteraction(interaction, { onSetupComplete: () => relay.reconcile() })
        .catch(e => logger.error('discord', 'interaction_failed', { error: e?.message || String(e) }));
    });

    client.on(Events.Error, (e) => logger.error('discord', 'client_error', { error: e?.message || String(e) }));
    client.on(Events.ShardDisconnect, () => logger.warn('discord', 'gateway_disconnected', {}));
    client.on(Events.ShardResume, () => logger.info('discord', 'gateway_resumed', {}));

    await client.login(token);
    state.client = client;
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    logger.error('discord', 'bridge_start_failed', { error: e.message });
  } finally {
    state.starting = false;
  }
}

async function stop() {
  relay.stop();
  sentinel.stop();
  if (state.client) {
    try { await state.client.destroy(); } catch { /* teardown is best-effort */ }
    state.client = null;
  }
  if (state.status !== 'error') state.status = 'disabled';
  state.guild = null;
}

// Default-deny inbound routing: only the owner allowlist gets a response, and
// only in bound channels/threads. Everyone else gets silence (R9).
async function handleMessage(message) {
  if (!message?.author || message.author.bot) return;
  if (!bindings.isOwner(message.author.id)) return;
  if (!message.content?.trim()) return;

  const general = bindings.getBinding('general');
  if (general && message.channelId === general.channel_id) {
    if (!state.agents.steward) state.agents.steward = steward.ensureStewardAgent()?.id || null;
    if (state.agents.steward) steward.handleGeneralMessage(message, { agentId: state.agents.steward });
    return;
  }

  if (message.channel?.isThread?.()) {
    const info = bindings.threadInfo(message.channelId);
    if (info?.kind === 'colony') {
      if (!state.agents.operator) state.agents.operator = operator.ensureOperatorAgent()?.id || null;
      if (state.agents.operator) operator.handleColonyThreadMessage(message, { agentId: state.agents.operator, teamId: info.ref });
    } else if (info?.kind === 'health') {
      if (!state.agents.triage) state.agents.triage = triage.ensureTriageAgent()?.id || null;
      if (state.agents.triage) triage.handleHealthReply(message, { agentId: state.agents.triage, fingerprint: info.ref });
    }
  }
}

// Hot start/stop when the token setting changes (Settings page save).
let reconfigureTimer = null;
config.onSettingsCacheInvalidated(() => {
  if (reconfigureTimer) clearTimeout(reconfigureTimer);
  reconfigureTimer = setTimeout(async () => {
    reconfigureTimer = null;
    const token = currentToken();
    if (token === state.lastToken) return;
    logger.info('discord', 'token_changed_restarting', {});
    await stop();
    await start();
  }, 2000);
  reconfigureTimer.unref?.();
});

function status() {
  const all = bindings.allBindings();
  const owners = bindings.ownerIds();
  const missingSetup = [];
  if (!owners.length) missingSetup.push('owner');
  if (!all.general) missingSetup.push('general');
  if (!all.colony_forum) missingSetup.push('colony_forum');
  if (!all.health_forum) missingSetup.push('health_forum');
  const chatReady = owners.length > 0 && !!all.general;

  return {
    state: state.status,
    error: state.error,
    guild: state.guild,
    bindings: Object.fromEntries(
      Object.entries(all).map(([k, v]) => [k, v ? v.channel_id : null]),
    ),
    owners: owners.length,
    ready: state.status === 'connected' && chatReady,
    setup_required: state.status === 'connected' && !chatReady,
    missing_setup: missingSetup,
  };
}

module.exports = { start, stop, status, handleMessage, _state: state };
