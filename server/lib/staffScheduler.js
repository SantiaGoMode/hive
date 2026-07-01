const path = require('path');
const os = require('os');
const staff = require('./staffDirectory');
// Namespace import (not destructured) so tests can stub runAgentOnce — the one
// real model call — without invoking a model. Mirrors the `staff` import above.
const agentTools = require('./agentTools');
const { getOllamaUrl } = require('./ollamaUrl');
const { logSwallowed } = require('./logSwallowed');
const lifecycle = require('./schedulerLifecycle');

let intervalHandle = null;
let running = false;

// ── Per-profile failure backoff + error dedupe (issue #34) ─────────────────────
// A persistently-failing model used to post an identical "Could not generate …"
// system message every tick, flooding the lounge. We track failure state per
// profile in memory (reset on success) so we can (a) skip the profile until a
// backoff window elapses instead of retrying it every tick, and (b) suppress a
// duplicate error post when the same normalized error recurs while backed off.
//
// In-memory (not persisted) on purpose: keep it simple and deterministic, and a
// process restart is a natural, cheap "retry now" — the clock-bump-on-error from
// #45 already stops a failing profile from monopolizing the single per-tick slot.
const BACKOFF_BASE_SECONDS = 5 * 60; // first failure waits ~5 min before retry
const BACKOFF_MAX_SECONDS = 60 * 60; // cap the window at 1 hour
const failureState = new Map(); // profileId -> { fails, nextAt, lastError }

// Collapse timestamp/port/pid/hex noise so "connect ECONNREFUSED 127.0.0.1:52413"
// and the same error on a different ephemeral port dedupe to one message.
function normalizeError(message) {
  return String(message || '')
    .replace(/\b\d{4,}\b/g, '#') // ports, pids, long numbers
    .replace(/0x[0-9a-f]+/gi, '#') // hex addresses
    .replace(/\d{1,3}(?:\.\d{1,3}){3}/g, '#') // ipv4
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Compute the next-retry timestamp after a failure. Exponential in the number of
// consecutive failures, capped, with small deterministic-per-profile jitter so a
// fleet of profiles that fail together don't all retry on the exact same tick.
function computeBackoffSeconds(fails, profileId) {
  const raw = BACKOFF_BASE_SECONDS * Math.pow(2, Math.max(0, fails - 1));
  const capped = Math.min(BACKOFF_MAX_SECONDS, raw);
  // Jitter: up to +25% of the window, derived from the profile id (stable, no RNG
  // so tests stay deterministic).
  let hash = 0;
  const key = String(profileId || '');
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) & 0xffff;
  const jitter = Math.floor((capped * 0.25) * (hash / 0xffff));
  return capped + jitter;
}

// Record a failure for a profile: bump the consecutive-fail count, schedule the
// next allowed retry, and remember the normalized error. Returns whether a system
// error message should be posted (true only when the error is new/changed for
// this profile — repeated identical errors are suppressed).
function recordFailure(profileId, errorMessage, now, applyBackoff = true) {
  const prev = failureState.get(profileId) || { fails: 0, nextAt: 0, lastError: null };
  const normalized = normalizeError(errorMessage);
  const isNewError = normalized !== prev.lastError;
  const fails = prev.fails + 1;
  failureState.set(profileId, {
    fails,
    // Mention failures record the error (for dedupe) but keep the existing retry
    // window, so an explicit mention never mutes a profile's interval chat.
    nextAt: applyBackoff ? now + computeBackoffSeconds(fails, profileId) : prev.nextAt,
    lastError: normalized,
  });
  return isNewError;
}

// Clear failure/backoff state after a profile successfully speaks (or is cleanly
// silent/gated), so the next failure starts backoff from scratch.
function clearFailure(profileId) {
  failureState.delete(profileId);
}

// Whether a profile is currently inside its backoff window (skip it this tick).
function isBackedOff(profileId, now) {
  const state = failureState.get(profileId);
  return !!(state && state.nextAt > now);
}

// Test-only: reset in-memory backoff/dedupe state between tests.
function _resetFailureState() {
  failureState.clear();
}

// Test-only: expire a profile's backoff window (so the next tick retries it) while
// preserving the recorded lastError — lets tests exercise the error-comparison
// dedupe path without waiting minutes for the real window to elapse.
function _expireBackoff(profileId) {
  const state = failureState.get(profileId);
  if (state) state.nextAt = 0;
}

function virtualAgentForProfile(profile, systemPrompt) {
  return {
    id: `staff:${profile.id}`,
    name: profile.display_name,
    persona_role: profile.role,
    // Autonomous chat can run on a dedicated (typically smaller) model than
    // the one used for colony work.
    model: profile.chat_model || profile.model_preference || '',
    tools: [],
    // The lounge system prompt (buildStaffChatMessages) — identity, voice,
    // memory facts, and hard anti-fabrication rules. Never the colony work
    // prompt, which makes chat models hallucinate fake colony work.
    system_prompt: systemPrompt,
    workspace: null,
    // Low temperature on purpose: lounge chat runs on small models and higher
    // temps make them invent work that never happened.
    temperature: 0.15,
    max_tokens: 180,
    context_length: 8192,
  };
}

// Strip decoration small models add around chat replies — wrapping quotes,
// "Name:" prefixes — so messages read like real chat.
function cleanChatOutput(profile, raw) {
  let out = String(raw || '').trim();
  out = out.replace(/^"([\s\S]+)"$/, '$1').replace(/^[“”]([\s\S]+)[“”]$/, '$1').trim();
  const namePrefix = new RegExp(`^${profile.display_name.split(/\\s+/)[0]}[^a-zA-Z0-9]{0,3}\\s*:`, 'i');
  out = out.replace(namePrefix, '').trim();
  out = out.replace(/^[-*]\s+/, '').trim();
  return out;
}

async function generateProfileMessage(profile, triggerType = 'interval', seedContent = '') {
  if (!profile?.chat_model && !profile?.model_preference) return null;
  const { system, messages } = staff.buildStaffChatMessages(profile, triggerType, seedContent);
  const raw = await agentTools.runAgentOnce(
    virtualAgentForProfile(profile, system),
    messages,
    getOllamaUrl(),
    0,
    null,
    path.join(os.homedir(), '.hive'),
    [],
    4,
  );
  // The model call returned without throwing — treat that as recovery and clear
  // any failure/backoff state, regardless of whether the reply is usable. A live
  // model that chooses silence isn't "failing"; only a thrown error is.
  clearFailure(profile.id);
  if (!raw || raw === '(no response)') return null;
  const output = cleanChatOutput(profile, raw);
  const bumpClock = () => {
    const db = require('../db');
    db.prepare('UPDATE staff_profiles SET last_chat_at=unixepoch() WHERE id=?').run(profile.id);
  };
  if (!output) { bumpClock(); return null; }
  if (/^silence\.?$/i.test(output)) { bumpClock(); return null; }
  // Reject prompt/meta leakage ("You are Priya Shah, the team's QA…").
  if (staff.isPromptLeak(profile, output)) { bumpClock(); return null; }
  // Reject formatting / roleplay patterns that make the lounge feel synthetic.
  if (staff.isAwkwardChatOutput(output)) { bumpClock(); return null; }
  // Hallucination gate: claims of builds/specs/meetings/handoffs must be
  // grounded in the profile's memory or the message being answered.
  if (staff.isUngroundedWorkClaim(profile, output, seedContent)) { bumpClock(); return null; }
  // Drop near-duplicates of recent lounge messages (own AND others') — small
  // models repeat themselves and copy each other. Applies to mention replies
  // too: a repeated answer is noise, silence is honest.
  if (staff.isDuplicateChatMessage(profile.id, output)) { bumpClock(); return null; }
  return staff.addChatMessage({
    authorType: 'profile',
    authorProfileId: profile.id,
    content: output,
    mentions: [],
    triggerType,
  });
}

async function generateMentionResponses(message) {
  const profiles = staff.listProfiles();
  // Mentions are explicit, but still honor the profile's chat switch. Without
  // this, "chat off" staff can unexpectedly jump into the lounge.
  const mentioned = staff.detectMentions(message.content, profiles)
    .filter(p => p.chat_enabled && (p.chat_model || p.model_preference));
  const responses = [];
  for (const profile of mentioned) {
    try {
      const response = await generateProfileMessage(profile, 'mention', message.content);
      if (response) responses.push(response);
    } catch (e) {
      // Dedupe repeated identical mention errors for the same profile too, but do
      // NOT apply the interval backoff window here: a mention is an explicit user
      // action and should still attempt the profile next time it's mentioned, and
      // mention failures must not suppress unrelated interval profiles (#34).
      const shouldPost = recordFailure(profile.id, e.message, Math.floor(Date.now() / 1000), false);
      if (shouldPost) {
        staff.addChatMessage({
          authorType: 'system',
          content: `Could not generate ${profile.display_name}'s mention response: ${e.message}`,
          mentions: [],
          triggerType: 'mention',
        });
      }
    }
  }
  return responses;
}

async function tick() {
  if (running) return [];
  running = true;
  const created = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const due = staff.listProfiles()
      .filter(p => p.chat_enabled && (p.chat_model || p.model_preference))
      .filter(profile => {
        const intervalSeconds = Math.max(1, profile.chat_interval_minutes || 10) * 60;
        return !profile.last_chat_at || now - profile.last_chat_at >= intervalSeconds;
      })
      // Skip profiles inside their failure backoff window (issue #34): a flapping
      // model is retried after an exponential delay, not every tick. Other due
      // profiles are unaffected and can still speak.
      .filter(profile => !isBackedOff(profile.id, now))
      .sort((a, b) => (a.last_chat_at || 0) - (b.last_chat_at || 0));
    // Let at most one staff member speak per scheduler tick. A burst of every
    // enabled profile talking at once reads like forced roleplay, not chat.
    for (const profile of due.slice(0, 1)) {
      const intervalSeconds = Math.max(1, profile.chat_interval_minutes || 10) * 60;
      if (profile.last_chat_at && now - profile.last_chat_at < intervalSeconds) continue;
      try {
        const msg = await generateProfileMessage(profile, 'interval');
        if (msg) created.push(msg);
      } catch (e) {
        // Advance the clock even on failure, so one erroring profile (e.g. a
        // transient model timeout) doesn't stay "most overdue" and monopolize
        // the single per-tick slot — which would starve every other staffer.
        try { require('../db').prepare('UPDATE staff_profiles SET last_chat_at=unixepoch() WHERE id=?').run(profile.id); } catch (e2) { logSwallowed('staffScheduler:advanceLastChat', e2, { profileId: profile.id }); }
        // Record the failure and back the profile off before its next retry. Only
        // post a system note when the error is new/changed for this profile — a
        // repeated identical error just extends the backoff without re-spamming.
        const shouldPost = recordFailure(profile.id, e.message, now);
        if (shouldPost) {
          staff.addChatMessage({
            authorType: 'system',
            content: `Could not generate ${profile.display_name}'s scheduled staff message: ${e.message}`,
            mentions: [],
            triggerType: 'interval',
          });
        }
      }
    }
  } catch (e) {
    lifecycle.recordError('staffScheduler', e);
    throw e;
  } finally {
    running = false;
    lifecycle.heartbeat('staffScheduler', { event: 'tick', created_count: created.length });
  }
  return created;
}

function startLoop() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
}

function stopLoop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

function start() {
  return lifecycle.start('staffScheduler');
}

function stop() {
  return lifecycle.stop('staffScheduler');
}

// Lightweight status for /api/system/metrics: whether the interval loop is
// started and whether a tick is currently in flight.
function rawStatus() {
  return { started: !!intervalHandle, ticking: running, interval_ms: 60 * 1000 };
}

function status() {
  return lifecycle.status('staffScheduler');
}

lifecycle.register('staffScheduler', { start: startLoop, stop: stopLoop, status: rawStatus });

module.exports = { start, stop, tick, status, generateProfileMessage, generateMentionResponses, _resetFailureState, _expireBackoff };
