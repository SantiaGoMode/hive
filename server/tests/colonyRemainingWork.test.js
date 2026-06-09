const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const protocol = require('../lib/colonyProtocol');
const { createColony, deleteColony, parseBootstrapTasks } = require('../lib/colonyRunner');

const created = [];

after(() => {
  for (const id of created) {
    try { deleteColony(id); } catch {}
  }
});

describe('bootstrap task parsing', () => {
  it('extracts structured task drafts from PM JSON output', () => {
    const tasks = parseBootstrapTasks(`Here is the backlog:

\`\`\`json
[
  {
    "id": "T1",
    "title": "Implement webhook routing",
    "description": "Persist trigger filters and route issue events.",
    "acceptance_criteria": ["replayed events are ignored"],
    "suggested_order": 1
  }
]
\`\`\``);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'T1');
    assert.equal(tasks[0].title, 'Implement webhook routing');
    assert.deepEqual(tasks[0].acceptance_criteria, ['replayed events are ignored']);
  });

  it('falls back to ordered markdown bullets without fabricating details', () => {
    const tasks = parseBootstrapTasks('1. Read the PRD\n2. Draft acceptance criteria');
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Read the PRD');
    assert.equal(tasks[1].title, 'Draft acceptance criteria');
  });
});

describe('handoff context history refs', () => {
  it('returns persisted upstream conversation history on demand', () => {
    const colonyId = createColony('History ref test', 'llama3', 'development_team');
    created.push(colonyId);
    const agentId = 'agent-history-test';
    const history = [
      { role: 'user', content: 'Build the API endpoint.' },
      { role: 'assistant', content: 'Implemented route and tests.' },
    ];
    const historyRef = protocol.persistAgentHistory(colonyId, agentId, history);
    const handoff = protocol.recordHandoff(colonyId, {
      fromRole: 'software_developer',
      toRole: 'qa_engineer',
      payload: { summary: 'Ready for QA', history_ref: historyRef },
      historyRef,
      requiresHuman: true,
      status: 'awaiting_human',
    });

    const context = protocol.getHandoffContext(handoff.id);
    assert.equal(context.history_ref, `agent:${agentId}`);
    assert.deepEqual(context.history, history);

    const row = db.prepare('SELECT history_ref FROM colony_handoffs WHERE id=?').get(handoff.id);
    assert.equal(row.history_ref, `agent:${agentId}`);
  });
});
