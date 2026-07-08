// Persistence for the Discord bridge: channel bindings (one guild per
// install), the owner allowlist, and the durable thread map (colony team ↔
// forum thread, health finding ↔ forum thread). Tables from migration 18.
const db = require('../../db');

const BINDING_KINDS = ['general', 'colony_forum', 'health_forum'];

function setBinding(kind, guildId, channelId) {
  if (!BINDING_KINDS.includes(kind)) throw new Error(`Unknown binding kind: ${kind}`);
  db.prepare(`
    INSERT INTO discord_bindings (kind, guild_id, channel_id) VALUES (?, ?, ?)
    ON CONFLICT(kind) DO UPDATE SET guild_id=excluded.guild_id, channel_id=excluded.channel_id, updated_at=unixepoch()
  `).run(kind, String(guildId), String(channelId));
}

function getBinding(kind) {
  return db.prepare('SELECT * FROM discord_bindings WHERE kind=?').get(kind) || null;
}

function allBindings() {
  const out = {};
  for (const kind of BINDING_KINDS) out[kind] = getBinding(kind);
  return out;
}

function clearBindings() {
  db.prepare('DELETE FROM discord_bindings').run();
}

// ── Owner allowlist ───────────────────────────────────────────────────────────
// Stored as a JSON array in app_settings. Default-deny: with no owners the
// bridge only accepts /hive setup, which claims ownership for the invoker.
function ownerIds() {
  try {
    const raw = db.prepare("SELECT value FROM app_settings WHERE key='discord_owner_ids'").get()?.value;
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function addOwner(userId) {
  const ids = ownerIds();
  if (!ids.includes(String(userId))) ids.push(String(userId));
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('discord_owner_ids', ?)")
    .run(JSON.stringify(ids));
  return ids;
}

function isOwner(userId) {
  return ownerIds().includes(String(userId));
}

// ── Thread map ────────────────────────────────────────────────────────────────
function saveThread(threadId, kind, ref) {
  db.prepare('INSERT OR REPLACE INTO discord_threads (thread_id, kind, ref) VALUES (?, ?, ?)')
    .run(String(threadId), kind, String(ref));
}

function threadInfo(threadId) {
  return db.prepare('SELECT * FROM discord_threads WHERE thread_id=?').get(String(threadId)) || null;
}

function threadIdForRef(kind, ref) {
  return db.prepare('SELECT thread_id FROM discord_threads WHERE kind=? AND ref=?').get(kind, String(ref))?.thread_id || null;
}

function listThreads(kind) {
  return db.prepare('SELECT * FROM discord_threads WHERE kind=?').all(kind);
}

function deleteThread(threadId) {
  db.prepare('DELETE FROM discord_threads WHERE thread_id=?').run(String(threadId));
}

module.exports = {
  BINDING_KINDS,
  setBinding,
  getBinding,
  allBindings,
  clearBindings,
  ownerIds,
  addOwner,
  isOwner,
  saveThread,
  threadInfo,
  threadIdForRef,
  listThreads,
  deleteThread,
};
