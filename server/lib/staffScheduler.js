const path = require('path');
const os = require('os');
const staff = require('./staffDirectory');
const { runAgentOnce } = require('./agentTools');
const { getOllamaUrl } = require('./ollamaUrl');

let intervalHandle = null;
let running = false;

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
  const raw = await runAgentOnce(
    virtualAgentForProfile(profile, system),
    messages,
    getOllamaUrl(),
    0,
    null,
    path.join(os.homedir(), '.hive'),
    [],
    4,
  );
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
      staff.addChatMessage({
        authorType: 'system',
        content: `Could not generate ${profile.display_name}'s mention response: ${e.message}`,
        mentions: [],
        triggerType: 'mention',
      });
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
        try { require('../db').prepare('UPDATE staff_profiles SET last_chat_at=unixepoch() WHERE id=?').run(profile.id); } catch {}
        staff.addChatMessage({
          authorType: 'system',
          content: `Could not generate ${profile.display_name}'s scheduled staff message: ${e.message}`,
          mentions: [],
          triggerType: 'interval',
        });
      }
    }
  } finally {
    running = false;
  }
  return created;
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, tick, generateProfileMessage, generateMentionResponses };
