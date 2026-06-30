// Tests for the staff-chat scheduler (server/lib/staffScheduler.js, issue #45).
//
// staffScheduler is reliability-critical and was untested. These tests guard the
// scheduling rules against a real test DB (clock + chat messages persist there),
// stubbing only the one real model call (agentTools.runAgentOnce) and — where the
// focus is scheduler orchestration rather than gate logic — the staffDirectory
// content gates. Covered: due-selection, the single-speaker-per-tick cap, the
// clock-bump-on-error (no starvation), and silence/gate handling returning null
// without throwing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const staff = require('../lib/staffDirectory');
const agentTools = require('../lib/agentTools');
const scheduler = require('../lib/staffScheduler');

// ── Monkeypatch helpers (restored after each test) ─────────────────────────────
const restores = [];
function stub(obj, name, fn) {
  const orig = obj[name];
  obj[name] = fn;
  restores.push(() => { obj[name] = orig; });
}
// Make all staffDirectory content gates pass, so a test can isolate scheduler
// orchestration from gate heuristics (those are covered by staffDirectory.test).
function passAllGates() {
  stub(staff, 'isPromptLeak', () => false);
  stub(staff, 'isAwkwardChatOutput', () => false);
  stub(staff, 'isUngroundedWorkClaim', () => false);
  stub(staff, 'isDuplicateChatMessage', () => false);
}

function insertProfile({ id, name = id, chat_enabled = 1, chat_model = 'llama3', interval = 10, lastChatAt = null }) {
  db.prepare(`INSERT INTO staff_profiles
      (id, recipe_id, role_key, display_name, role, personality, chat_enabled, chat_model, chat_interval_minutes, last_chat_at)
      VALUES (?, 'rec', ?, ?, 'Engineer', 'pragmatic', ?, ?, ?, ?)`)
    .run(id, id, name, chat_enabled ? 1 : 0, chat_model, interval, lastChatAt);
}
const lastChatAt = (id) => db.prepare('SELECT last_chat_at FROM staff_profiles WHERE id=?').get(id)?.last_chat_at;
const chatRows = () => db.prepare('SELECT * FROM staff_chat_messages ORDER BY created_at, id').all();

beforeEach(() => {
  db.prepare('DELETE FROM staff_chat_messages').run();
  db.prepare('DELETE FROM staff_profiles').run();
  db.prepare('DELETE FROM agents').run();
  db.prepare("DELETE FROM app_settings WHERE key='staff_assigned_agents_backfilled_v1'").run();
});
afterEach(() => { while (restores.length) restores.pop()(); });

// ── due-selection + single-speaker cap ─────────────────────────────────────────

describe('tick — due selection and cap', () => {
  it('lets only the single most-overdue profile speak per tick', async () => {
    insertProfile({ id: 'pA', lastChatAt: 100 });
    insertProfile({ id: 'pB', lastChatAt: 50 });
    insertProfile({ id: 'pC', lastChatAt: 10 }); // most overdue (smallest last_chat_at)
    passAllGates();
    let calls = 0;
    stub(agentTools, 'runAgentOnce', async () => { calls++; return 'Morning all.'; });

    const created = await scheduler.tick();

    assert.equal(calls, 1, 'cap: exactly one generation per tick');
    assert.equal(created.length, 1);
    assert.equal(created[0].author_profile_id, 'pC', 'the most-overdue profile speaks');
    assert.equal(chatRows().length, 1);
    assert.ok(lastChatAt('pC') > 10, 'speaker clock advanced via addChatMessage');
  });

  it('skips profiles that are not yet due, and calls no model', async () => {
    const now = Math.floor(Date.now() / 1000);
    insertProfile({ id: 'fresh', interval: 10, lastChatAt: now }); // spoke just now
    let calls = 0;
    stub(agentTools, 'runAgentOnce', async () => { calls++; return 'hi'; });

    const created = await scheduler.tick();

    assert.equal(calls, 0);
    assert.deepEqual(created, []);
    assert.equal(lastChatAt('fresh'), now, 'clock untouched when not due');
  });

  it('ignores chat-disabled profiles and profiles with no model', async () => {
    insertProfile({ id: 'disabled', chat_enabled: 0, lastChatAt: 10 });
    insertProfile({ id: 'nomodel', chat_model: '', lastChatAt: 10 });
    let calls = 0;
    stub(agentTools, 'runAgentOnce', async () => { calls++; return 'hi'; });

    const created = await scheduler.tick();
    assert.equal(calls, 0);
    assert.deepEqual(created, []);
  });
});

// ── clock-bump-on-error (no starvation) ────────────────────────────────────────

describe('tick — failure handling', () => {
  it('advances last_chat_at and posts a system note when generation throws', async () => {
    insertProfile({ id: 'boom', name: 'Boomer', lastChatAt: 100 });
    stub(agentTools, 'runAgentOnce', async () => { throw new Error('model timeout'); });

    const created = await scheduler.tick();

    assert.deepEqual(created, []);
    assert.ok(lastChatAt('boom') > 100, 'clock bumped on error so it cannot monopolize the slot');
    const sys = chatRows().filter(r => r.author_type === 'system');
    assert.equal(sys.length, 1);
    assert.match(sys[0].content, /Could not generate Boomer's scheduled staff message: model timeout/);
  });
});

// ── silence / gate handling returns null without erroring ───────────────────────

describe('generateProfileMessage — silence & gates', () => {
  it('treats a "silence." reply as no-message and bumps the clock', async () => {
    insertProfile({ id: 'quiet', lastChatAt: 100 });
    stub(agentTools, 'runAgentOnce', async () => 'silence.');
    const profile = staff.getProfile('quiet');

    const result = await scheduler.generateProfileMessage(profile, 'interval');

    assert.equal(result, null);
    assert.ok(lastChatAt('quiet') > 100, 'clock bumped so silence does not starve others');
    assert.equal(chatRows().length, 0, 'no chat message persisted');
  });

  it('drops empty output (after cleaning) without throwing', async () => {
    insertProfile({ id: 'blank', lastChatAt: 100 });
    stub(agentTools, 'runAgentOnce', async () => '""'); // cleans down to ''
    const profile = staff.getProfile('blank');

    const result = await scheduler.generateProfileMessage(profile, 'interval');
    assert.equal(result, null);
    assert.ok(lastChatAt('blank') > 100);
  });

  it('returns null (no throw) when no chat model is configured', async () => {
    const result = await scheduler.generateProfileMessage({ id: 'x', display_name: 'X' }, 'interval');
    assert.equal(result, null);
  });

  it('persists a message when the reply passes every gate', async () => {
    insertProfile({ id: 'talker', lastChatAt: 100 });
    passAllGates();
    stub(agentTools, 'runAgentOnce', async () => 'Looking forward to today.');
    const profile = staff.getProfile('talker');

    const result = await scheduler.generateProfileMessage(profile, 'interval');
    assert.ok(result);
    assert.equal(result.content, 'Looking forward to today.');
    assert.equal(result.author_profile_id, 'talker');
  });
});
