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
  // Clear in-memory failure/backoff state so tests don't leak into each other.
  scheduler._resetFailureState();
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

// ── backoff + error dedupe (issue #34) ─────────────────────────────────────────

describe('tick — failure backoff + error dedupe', () => {
  // Force a profile "due" again by clearing its clock, so we can drive several
  // ticks in a row without waiting for the chat interval to elapse.
  const makeDue = (id) => db.prepare('UPDATE staff_profiles SET last_chat_at=10 WHERE id=?').run(id);

  it('skips a failing profile on the next tick (backoff) instead of retrying every tick', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    let calls = 0;
    stub(agentTools, 'runAgentOnce', async () => { calls++; throw new Error('model timeout'); });

    // First tick: profile is due, model throws → one attempt, one system note.
    await scheduler.tick();
    assert.equal(calls, 1, 'first tick attempts generation');
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1);

    // Make it due again; backoff window (minutes) is still open → skipped, no call.
    makeDue('flap');
    await scheduler.tick();
    assert.equal(calls, 1, 'second tick is skipped while backed off (no model call)');
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1,
      'no duplicate error post while backed off');
  });

  it('collapses repeated identical errors to a single system post over many ticks', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    stub(agentTools, 'runAgentOnce', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:52413'); });

    // Drive several ticks, forcing the profile due each time. Backoff means most
    // ticks skip the call outright; even the ones that don't would see an identical
    // error → the lounge must never accumulate more than one system note.
    for (let i = 0; i < 5; i++) {
      makeDue('flap');
      await scheduler.tick();
    }
    const sys = chatRows().filter(r => r.author_type === 'system');
    assert.equal(sys.length, 1, 'a flapping model posts the error only once, not per tick');
  });

  it('posts again when the error message changes (different failure is not deduped)', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    let err = 'model timeout';
    stub(agentTools, 'runAgentOnce', async () => { throw new Error(err); });

    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1);

    // A genuinely different error, once the profile is retried, is worth surfacing.
    // Expire the backoff window (keeping the recorded lastError) so the retry runs.
    scheduler._expireBackoff('flap');
    err = 'out of memory';
    makeDue('flap');
    await scheduler.tick();
    const sys = chatRows().filter(r => r.author_type === 'system');
    assert.equal(sys.length, 2, 'a changed error posts a new note');
    assert.match(sys[1].content, /out of memory/);
  });

  it('dedupes identical errors that differ only by port/pid noise', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    let port = 52413;
    stub(agentTools, 'runAgentOnce', async () => { throw new Error(`connect ECONNREFUSED 127.0.0.1:${port}`); });

    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1);

    // Same error, different ephemeral port — normalization must treat it as a dup.
    // Expire backoff (keeping lastError) so the retry actually attempts and hits the
    // error-comparison dedupe rather than being skipped by the window.
    scheduler._expireBackoff('flap');
    port = 61999;
    makeDue('flap');
    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1,
      'port/ip noise does not defeat dedupe');
  });

  it('lets a healthy profile speak while a different profile is backed off', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    insertProfile({ id: 'ok', name: 'Okay', interval: 1, lastChatAt: 20 });
    passAllGates();
    let okSpoke = false;
    stub(agentTools, 'runAgentOnce', async (agent) => {
      if (agent.id === 'staff:flap') throw new Error('model timeout');
      okSpoke = true;
      return 'Morning all.';
    });

    // Tick 1: flap is most overdue → attempts, fails, gets backed off.
    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1);

    // Tick 2: both due again, but flap is backed off → ok speaks instead.
    makeDue('flap');
    makeDue('ok');
    db.prepare('UPDATE staff_profiles SET last_chat_at=5 WHERE id=?').run('flap'); // flap even more overdue
    await scheduler.tick();
    assert.ok(okSpoke, 'the healthy profile speaks despite flap being more overdue');
    assert.equal(chatRows().filter(r => r.author_type === 'profile').length, 1);
  });

  it('resets backoff after a successful message so future failures start fresh', async () => {
    insertProfile({ id: 'flap', name: 'Flappy', interval: 1, lastChatAt: 10 });
    passAllGates();
    let mode = 'fail';
    stub(agentTools, 'runAgentOnce', async () => {
      if (mode === 'fail') throw new Error('model timeout');
      return 'Recovered, hi.';
    });

    // Fail once → backed off.
    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'system').length, 1);

    // Recover: expire the backoff window (simulating time elapsed), then succeed —
    // a successful message clears all failure/dedupe state for the profile.
    scheduler._expireBackoff('flap');
    mode = 'ok';
    makeDue('flap');
    await scheduler.tick();
    assert.equal(chatRows().filter(r => r.author_type === 'profile').length, 1, 'profile spoke after recovery');

    // Fail again with the SAME error as before → still posts, because success reset
    // the dedupe state (this is a brand-new failure episode, not a continuation).
    mode = 'fail';
    makeDue('flap');
    await scheduler.tick();
    const sys = chatRows().filter(r => r.author_type === 'system');
    assert.equal(sys.length, 2, 'a fresh failure after recovery posts a new error note');
  });

  it('dedupes repeated identical mention-response errors but does not back off the profile', async () => {
    insertProfile({ id: 'mflap', name: 'Mflap', interval: 1, lastChatAt: 10 });
    stub(staff, 'detectMentions', () => [staff.getProfile('mflap')]);
    stub(agentTools, 'runAgentOnce', async () => { throw new Error('model timeout'); });

    await scheduler.generateMentionResponses({ content: '@Mflap hi', id: 'm1' });
    await scheduler.generateMentionResponses({ content: '@Mflap hi again', id: 'm2' });

    const sys = chatRows().filter(r => r.author_type === 'system');
    assert.equal(sys.length, 1, 'identical mention errors collapse to one system note');
    assert.match(sys[0].content, /mention response: model timeout/);
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
