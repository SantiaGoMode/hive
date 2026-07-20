// Server-owned workflow projection. Models may request transitions, but this
// module owns dependency checks, evidence attachment, and completion evaluation.
const db = require('../../db');

function parse(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function syncPlan(runId, steps = []) {
  const upsert = db.prepare(`
    INSERT INTO colony_workflow_nodes
      (run_id, node_id, role_key, description, status, depends_on, evidence_requirements)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, node_id) DO UPDATE SET
      role_key=excluded.role_key, description=excluded.description,
      depends_on=excluded.depends_on, evidence_requirements=excluded.evidence_requirements,
      updated_at=unixepoch()
  `);
  db.transaction(() => {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const depends = Array.isArray(step.depends_on) ? step.depends_on.map(String) : [];
      upsert.run(
        runId, String(step.id), step.assigned_to || null,
        String(step.description || ''), step.status || 'pending',
        JSON.stringify(depends), JSON.stringify(step.evidence_requirements || []),
      );
    }
  })();
  return listNodes(runId);
}

function listNodes(runId) {
  return db.prepare('SELECT * FROM colony_workflow_nodes WHERE run_id=? ORDER BY rowid ASC').all(runId)
    .map(row => ({ ...row, depends_on: parse(row.depends_on, []), evidence_requirements: parse(row.evidence_requirements, []) }));
}

function transition(runId, nodeId, status, note = null) {
  const node = listNodes(runId).find(n => n.node_id === String(nodeId));
  if (!node) return { ok: false, error: `Unknown workflow node "${nodeId}"` };
  if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) return { ok: false, error: 'Invalid workflow status' };
  if (status === 'in_progress' || status === 'done') {
    const byId = new Map(listNodes(runId).map(n => [n.node_id, n]));
    const missing = node.depends_on.filter(id => byId.get(String(id))?.status !== 'done');
    if (missing.length) return { ok: false, error: `Dependencies are not complete: ${missing.join(', ')}`, missing };
  }
  db.prepare(`UPDATE colony_workflow_nodes SET status=?, note=COALESCE(?, note),
    attempt_count=attempt_count+CASE WHEN ?='in_progress' THEN 1 ELSE 0 END,
    updated_at=unixepoch() WHERE run_id=? AND node_id=?`)
    .run(status, note, status, runId, String(nodeId));
  return { ok: true, node: listNodes(runId).find(n => n.node_id === String(nodeId)) };
}

function addEvidence(runId, { nodeId = null, kind, sourceAgentId = null, payload = {}, verified = false }) {
  const info = db.prepare(`INSERT INTO colony_evidence
    (run_id, node_id, kind, source_agent_id, payload, verified) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, nodeId == null ? null : String(nodeId), kind, sourceAgentId, JSON.stringify(payload || {}), verified ? 1 : 0);
  return info.lastInsertRowid;
}

function evaluate(runId) {
  const nodes = listNodes(runId);
  if (!nodes.length) return { ok: false, outcome: 'failed', reason: 'No workflow nodes exist' };
  const unfinished = nodes.filter(n => n.status !== 'done');
  if (!unfinished.length) return { ok: true, outcome: 'complete', nodes };
  if (unfinished.every(n => n.status === 'blocked')) return { ok: false, outcome: 'blocked', reason: 'All unfinished nodes are blocked', nodes };
  return { ok: false, outcome: 'incomplete', reason: `${unfinished.length} workflow node(s) remain unfinished`, nodes };
}

module.exports = { syncPlan, listNodes, transition, addEvidence, evaluate };
