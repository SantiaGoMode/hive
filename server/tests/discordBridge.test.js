// Discord bridge unit tests (docs/specs/discord-bridge.md): message formatting
// (chunking, mission board, status card), binding/owner/thread persistence,
// Sentinel detection rules, the runtime skill loader, and the Operator tools'
// team-context guards. No discord.js client is involved — everything below the
// transport is plain functions.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const format = require('../lib/discord/format');
const bindings = require('../lib/discord/bindings');
const { computeFindings } = require('../lib/discord/sentinel');
const skillTools = require('../lib/tools/skillTools');
const operatorTools = require('../lib/tools/operatorTools');
const missions = require('../lib/discord/missions');
const discordBridge = require('../lib/discord');
const teams = require('../lib/colonyTeams');

const createdTeams = [];
const createdItems = [];
after(() => {
  for (const id of createdItems) { try { db.prepare('DELETE FROM colony_work_items WHERE id=?').run(id); } catch { /* already gone */ } }
  for (const id of createdTeams) { try { db.prepare('DELETE FROM colony_teams WHERE id=?').run(id); } catch { /* already gone */ } }
  try { db.prepare('DELETE FROM discord_bindings').run(); } catch { /* table may be empty */ }
  try { db.prepare('DELETE FROM discord_threads').run(); } catch { /* table may be empty */ }
  try { db.prepare("DELETE FROM app_settings WHERE key='discord_owner_ids'").run(); } catch { /* setting may be absent */ }
});

function makeTeam(extra = {}) {
  const t = teams.createTeam({ name: `Discord team ${Date.now()}-${Math.round(performance.now())}`, ...extra });
  createdTeams.push(t.id);
  return t;
}

// ── format ────────────────────────────────────────────────────────────────────
describe('format.chunkMessage', () => {
  it('passes short messages through untouched', () => {
    assert.deepEqual(format.chunkMessage('hello'), ['hello']);
    assert.deepEqual(format.chunkMessage(''), []);
    assert.deepEqual(format.chunkMessage(null), []);
  });

  it('splits long text into chunks within the Discord limit', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} of a reasonably long message`).join('\n');
    const chunks = format.chunkMessage(text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 2000, `chunk too long: ${chunk.length}`);
    // No content lost (modulo whitespace trimming at boundaries)
    assert.ok(chunks.join('\n').includes('line 299'));
  });

  it('closes and reopens code fences across chunk boundaries', () => {
    const code = Array.from({ length: 200 }, (_, i) => `console.log(${i});`).join('\n');
    const text = `Intro paragraph\n\`\`\`js\n${code}\n\`\`\`\nOutro`;
    const chunks = format.chunkMessage(text);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) || []).length;
      assert.equal(fences % 2, 0, `unbalanced fences in chunk: ${chunk.slice(0, 80)}…`);
      assert.ok(chunk.length <= 2000);
    }
  });
});

describe('format.missionBoard / statusCard / toolFooter', () => {
  it('renders step statuses with icons and a progress count', () => {
    const board = format.missionBoard({
      steps: [
        { id: '1', status: 'done', description: 'Write the failing test' },
        { id: '2', status: 'in_progress', description: 'Fix the bug' },
        { id: '3', status: 'pending', description: 'Ship it' },
      ],
    }, { goal: 'Fix auth', runId: 'run1' });
    assert.match(board, /✅ Write the failing test/);
    assert.match(board, /🔄 Fix the bug/);
    assert.match(board, /⬜ Ship it/);
    assert.match(board, /1\/3 steps done/);
    assert.match(board, /run1/);
  });

  it('renders a placeholder while planning', () => {
    assert.match(format.missionBoard({ steps: [] }), /Planning/);
  });

  it('status card reports outcome, counts, and duration', () => {
    const card = format.statusCard({
      status: 'done',
      goal: 'Fix auth',
      steps: [{ status: 'done' }, { status: 'done' }, { status: 'blocked' }],
      durationMs: 95_000,
      summary: 'Fixed the token refresh race.',
      artifacts: ['src/auth.js'],
      runId: 'run1',
    });
    assert.match(card, /🟢/);
    assert.match(card, /2\/3 passed, 1 failed/);
    assert.match(card, /1m 35s/);
    assert.match(card, /src\/auth\.js/);
    assert.match(card, /token refresh race/);
  });

  it('tool footer aggregates repeated calls', () => {
    assert.equal(format.toolFooter([]), '');
    const footer = format.toolFooter(['web_search', 'sandbox', 'sandbox']);
    assert.match(footer, /web_search/);
    assert.match(footer, /sandbox ×2/);
  });
});

// ── bindings ──────────────────────────────────────────────────────────────────
describe('bindings', () => {
  it('rebinding a kind is idempotent (kind is the primary key)', () => {
    bindings.setBinding('general', 'g1', 'c1');
    bindings.setBinding('general', 'g1', 'c2');
    assert.equal(bindings.getBinding('general').channel_id, 'c2');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM discord_bindings WHERE kind='general'").get().n, 1);
  });

  it('rejects unknown binding kinds', () => {
    assert.throws(() => bindings.setBinding('dms', 'g1', 'c1'), /Unknown binding kind/);
  });

  it('owner allowlist is default-deny and additive', () => {
    db.prepare("DELETE FROM app_settings WHERE key='discord_owner_ids'").run();
    assert.equal(bindings.isOwner('u1'), false);
    bindings.addOwner('u1');
    assert.equal(bindings.isOwner('u1'), true);
    assert.equal(bindings.isOwner('u2'), false);
    bindings.addOwner('u1'); // no dupes
    assert.deepEqual(bindings.ownerIds(), ['u1']);
  });

  it('maps threads to refs both ways', () => {
    bindings.saveThread('t1', 'colony', 'team-a');
    bindings.saveThread('t2', 'health', 'spend:x');
    assert.equal(bindings.threadInfo('t1').ref, 'team-a');
    assert.equal(bindings.threadIdForRef('colony', 'team-a'), 't1');
    assert.equal(bindings.threadIdForRef('health', 'spend:x'), 't2');
    assert.equal(bindings.listThreads('colony').some(t => t.thread_id === 't1'), true);
    bindings.deleteThread('t1');
    assert.equal(bindings.threadIdForRef('colony', 'team-a'), null);
  });

  it('discord status marks connected-but-unbound installs as setup-required', () => {
    bindings.clearBindings();
    db.prepare("DELETE FROM app_settings WHERE key='discord_owner_ids'").run();
    discordBridge._state.status = 'connected';
    discordBridge._state.guild = 'Hive Test';

    const unbound = discordBridge.status();
    assert.equal(unbound.setup_required, true);
    assert.equal(unbound.ready, false);
    assert.deepEqual(unbound.missing_setup, ['owner', 'general', 'colony_forum', 'health_forum']);

    bindings.addOwner('u1');
    bindings.setBinding('general', 'g1', 'c1');
    const ready = discordBridge.status();
    assert.equal(ready.setup_required, false);
    assert.equal(ready.ready, true);
    assert.deepEqual(ready.missing_setup, ['colony_forum', 'health_forum']);
  });
});

// ── Sentinel detection rules ──────────────────────────────────────────────────
describe('sentinel.computeFindings', () => {
  it('flags budget burn at 80% (warning) and 100% (alert)', () => {
    const findings = computeFindings({
      spend: { agents: [
        { agent_id: 'a1', agent_name: 'Dev', spend_usd: 0.9, budget_usd: 1 },
        { agent_id: 'a2', agent_name: 'QA', spend_usd: 1.2, budget_usd: 1 },
        { agent_id: 'a3', agent_name: 'PM', spend_usd: 0.1, budget_usd: 1 },
        { agent_id: 'a4', agent_name: 'NoCap', spend_usd: 99, budget_usd: null },
      ] },
    });
    const byFp = new Map(findings.map(f => [f.fingerprint, f]));
    assert.equal(byFp.get('spend:a1').severity, 'warning');
    assert.equal(byFp.get('spend:a2').severity, 'alert');
    assert.equal(byFp.has('spend:a3'), false);
    assert.equal(byFp.has('spend:a4'), false);
  });

  it('flags an unreachable gateway and unreachable in-use Ollama', () => {
    const findings = computeFindings({
      gateway: { enabled: true, reachable: false, message: 'ECONNREFUSED' },
      ollama: { inUse: true, reachable: false, url: 'http://localhost:11434' },
    });
    const fps = findings.map(f => f.fingerprint);
    assert.ok(fps.includes('gateway:unreachable'));
    assert.ok(fps.includes('ollama:unreachable'));
  });

  it('ignores a healthy gateway and unused Ollama', () => {
    const findings = computeFindings({
      gateway: { enabled: true, reachable: true },
      ollama: { inUse: false, reachable: false, url: null },
    });
    assert.equal(findings.length, 0);
  });

  it('groups repeated error-log signatures (≥3) and skips its own component', () => {
    const entry = (component, event) => ({ level: 'error', component, event });
    const findings = computeFindings({
      logs: [
        entry('mcp', 'server_crashed'), entry('mcp', 'server_crashed'), entry('mcp', 'server_crashed'),
        entry('scheduler', 'run_failed'), entry('scheduler', 'run_failed'),
        entry('discord', 'client_error'), entry('discord', 'client_error'), entry('discord', 'client_error'),
      ],
    });
    const fps = findings.map(f => f.fingerprint);
    assert.deepEqual(fps, ['logs:mcp:server_crashed']);
    assert.match(findings[0].title, /×3/);
  });

  it('reports errored runs, live blockers, and unrouted work', () => {
    const findings = computeFindings({
      erroredRuns: [{ id: 'run9', goal: 'Ship dark mode', team_id: 't1', team_name: 'UI Guild', summary: null }],
      blockers: [{ colony_id: 'run8', agent: 'qa_engineer', content: 'Cannot reach staging', team_name: 'UI Guild' }],
      unroutedCount: 2,
    });
    const byFp = new Map(findings.map(f => [f.fingerprint, f]));
    assert.equal(byFp.get('run_error:run9').severity, 'alert');
    assert.equal(byFp.get('blocker:run8').severity, 'warning');
    assert.equal(byFp.get('unrouted:items').severity, 'suggestion');
    assert.match(byFp.get('unrouted:items').title, /2 unrouted/);
  });

  it('emits nothing on a quiet system', () => {
    assert.deepEqual(computeFindings({}), []);
  });
});

// ── Runtime skill loader ──────────────────────────────────────────────────────
describe('skill tools', () => {
  it('list_skills returns the seeded catalog', async () => {
    const { skills } = await skillTools.list_skills.handler({}, {});
    assert.ok(Array.isArray(skills) && skills.length > 0, 'expected seeded skills');
    assert.ok(skills[0].name);
  });

  it('load_skill returns the rendered body for a known skill', async () => {
    const { skills } = await skillTools.list_skills.handler({}, {});
    const result = await skillTools.load_skill.handler({ name: skills[0].name }, {});
    assert.equal(result.skill, skills[0].name);
    assert.ok(result.body.includes(skills[0].name));
  });

  it('load_skill hands back the catalog instead of a dead-end on unknown names', async () => {
    const result = await skillTools.load_skill.handler({ name: 'definitely-not-a-skill' }, {});
    assert.match(result.error, /No skill named/);
    assert.ok(Array.isArray(result.available) && result.available.length > 0);
  });
});

// ── Operator tools ────────────────────────────────────────────────────────────
describe('operator tools', () => {
  it('every tool requires a team bound in colonyContext', async () => {
    for (const name of ['start_mission', 'queue_work', 'send_direction', 'get_team_status', 'get_run_report']) {
      const result = await operatorTools[name].handler({ direction: 'x', content: 'x' }, {});
      assert.match(result.error, /No team bound/, name);
    }
  });

  it('get_team_status reports an idle team with queue counts and crew', async () => {
    const team = makeTeam();
    const ctx = { colonyContext: { discordTeamId: team.id } };
    const status = await operatorTools.get_team_status.handler({}, ctx);
    assert.equal(status.team.id, team.id);
    assert.equal(status.status, 'idle');
    assert.equal(status.active_run, null);
    assert.equal(status.queue.depth, 0);
    assert.ok(Array.isArray(status.crew));
  });

  it('queue_work adds a queued item and reports its position', async () => {
    const team = makeTeam();
    const ctx = { colonyContext: { discordTeamId: team.id } };
    const first = await operatorTools.queue_work.handler({ direction: 'Refactor the parser' }, ctx);
    createdItems.push(first.item_id);
    assert.equal(first.success, true);
    assert.equal(first.position, 1);
    const second = await operatorTools.queue_work.handler({ direction: 'Then add tests' }, ctx);
    createdItems.push(second.item_id);
    assert.equal(second.position, 2);
  });

  it('send_direction refuses when nothing is running', async () => {
    const team = makeTeam();
    const ctx = { colonyContext: { discordTeamId: team.id } };
    const result = await operatorTools.send_direction.handler({ content: 'steer left' }, ctx);
    assert.match(result.error, /No mission is running/);
  });

  it('start_mission surfaces launch preconditions as tool errors', async () => {
    const team = makeTeam();
    const ctx = { colonyContext: { discordTeamId: team.id, discordOperatorModel: null } };
    const result = await operatorTools.start_mission.handler({ direction: 'Do the thing' }, ctx);
    assert.match(result.error, /No model available/);
  });

  it('get_run_report explains when the team has no runs', async () => {
    const team = makeTeam();
    const ctx = { colonyContext: { discordTeamId: team.id } };
    const result = await operatorTools.get_run_report.handler({}, ctx);
    assert.match(result.error, /no runs yet/);
  });
});

// ── Missions lib ──────────────────────────────────────────────────────────────
describe('missions', () => {
  it('launchTeamMission validates team, direction, and model up front', () => {
    assert.throws(() => missions.launchTeamMission('nope', 'x', { model: 'm' }), /not found/);
    const team = makeTeam();
    assert.throws(() => missions.launchTeamMission(team.id, '', { model: 'm' }), /needs a direction/);
    assert.throws(() => missions.launchTeamMission(team.id, 'go', { model: null }), /No model/);
  });

  it('sendDirection rejects unknown and non-running runs', () => {
    assert.throws(() => missions.sendDirection('missing-run', 'hello'), /Run not found/);
  });

  it('stopTeamRun is a no-op on an idle team', () => {
    const team = makeTeam();
    assert.deepEqual(missions.stopTeamRun(team.id), { stopped: false, message: 'No live run' });
  });
});
