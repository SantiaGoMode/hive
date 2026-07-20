// ── Colony Communication Protocol ─────────────────────────────────────────────
// Implements the structured communication layer that lets seeded colony agents
// collaborate instead of working in isolation:
//
//   1. Shared Context Layer (the "Blackboard")  — append-only colony state log
//   2. Handoff Mechanisms                        — tool-based handoffs + command objects
//   3. Standardized Message Protocol (A2A/ACP)   — .agent.json ID cards + REST/ACP envelopes
//   4. Role-Specific Handoff Flow                — the predictable delivery lifecycle
//   5. Handoff Rules of Engagement               — preconditions, not-understood, human-in-the-loop
//
// This module is the single source of truth for the protocol. Tools (agentTools.js),
// the runner (colonyRunner.js), recipes (colonyRecipes.js), and the REST layer
// (routes/colony.js) all consume it so behaviour stays consistent everywhere.

const db = require('../db');
const { logSwallowed } = require('./logSwallowed');

const ACP_VERSION = 'acp/0.1';
const CARD_SCHEMA_VERSION = 'a2a-agent-card/1.0';

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── 4. Role-Specific Handoff Flow ─────────────────────────────────────────────
// The canonical, ordered delivery lifecycle. Each edge is one handoff: a source
// role, a target role, and the payload contract that must travel with it.
// Order in this array IS the lifecycle order — it drives precondition checks.
const DEV_TEAM_FLOW = [
  {
    from: 'business_analyst',
    to: 'project_manager',
    payload: 'Validated Business Rules & Logic Map',
    requires_human: false,
  },
  {
    from: 'project_manager',
    to: 'ui_ux_designer',
    payload: 'Prioritized Sprint Plan & Feature list',
    requires_human: false,
  },
  {
    from: 'ui_ux_designer',
    to: 'software_developer',
    payload: 'Component Specs (Tailwind classes, accessibility)',
    requires_human: false,
  },
  {
    from: 'software_developer',
    to: 'qa_engineer',
    payload: 'PR Link & API Documentation',
    // No in-run human gate: the run must complete unattended. The human review
    // point is the Draft PR the colony opens at the end — merged manually on GitHub.
    requires_human: false,
  },
  {
    from: 'qa_engineer',
    to: 'devops_engineer',
    payload: 'Test Pass/Fail Report & Stability Grade',
    // No in-run human gate — final review happens on the Draft PR.
    requires_human: false,
  },
  {
    from: 'devops_engineer',
    to: 'project_manager',
    payload: 'Deployment URL or Infrastructure Post-Mortem',
    requires_human: false,
  },
];

// Role display metadata, keyed by the recipe role key. Mirrors colonyRecipes.js
// so cards and flow share one vocabulary.
const DEV_TEAM_ROLES = {
  business_analyst: { name: 'Business Analyst', role: 'Business Analyst' },
  project_manager:  { name: 'Project Manager',  role: 'Project Manager' },
  ui_ux_designer:   { name: 'UI/UX Designer',   role: 'UI/UX Designer' },
  software_developer: { name: 'Software Developer', role: 'Software Developer' },
  qa_engineer:      { name: 'QA Engineer',      role: 'QA Engineer' },
  devops_engineer:  { name: 'DevOps Engineer',  role: 'DevOps Engineer' },
};

// ── Strict flows for the expanded recipe catalog ──────────────────────────────
// Each entry is a linear chain: steps run in order, and every step after the
// first names the payload contract of the handoff INTO it. FLOWS/ROLE_META are
// expanded from this table so adding a staged recipe is one chain declaration.
// Role keys must match the recipe definition in recipeCatalog.js — a test
// asserts the two files agree. Recipes absent here are lightweight: model-
// planned, no enforced handoff protocol (getFlow → null, flow route → 404).
const RECIPE_CHAINS = {
  code_review: {
    team: 'Code Review Crew',
    steps: [
      { key: 'review_lead', role: 'Review Lead' },
      { key: 'implementation_reviewer', role: 'Implementation Reviewer' },
      { key: 'test_reviewer', role: 'Test Reviewer' },
      { key: 'security_reviewer', role: 'Security Reviewer' },
      { key: 'review_synthesizer', role: 'Review Synthesizer' },
    ],
  },
  incident_response: {
    team: 'Incident Response Team',
    steps: [
      { key: 'incident_commander', role: 'Incident Commander' },
      { key: 'evidence_collector', role: 'Evidence Collector', payload: 'Severity Assessment & Evidence Priorities' },
      { key: 'root_cause_analyst', role: 'Root Cause Analyst', payload: 'Timestamped Evidence Inventory' },
      { key: 'fix_engineer', role: 'Fix Engineer', payload: 'Root Cause & Fix Direction' },
      { key: 'verification_lead', role: 'Verification Lead', payload: 'Fix Diff & Verification Output' },
      { key: 'comms_scribe', role: 'Comms Scribe', payload: 'Independent PASS/FAIL Verification Report' },
    ],
  },
  docs_release: {
    team: 'Docs Release Crew',
    steps: [
      { key: 'documentation_planner', role: 'Documentation Planner' },
      { key: 'technical_writer', role: 'Technical Writer', payload: 'Documentation Plan & Outlines' },
      { key: 'changelog_curator', role: 'Changelog Curator', payload: 'Written Docs & Verified Examples' },
      { key: 'qa_editor', role: 'QA Editor', payload: 'Changelog Entry & Shipped-Changes Inventory' },
      { key: 'publisher', role: 'Publisher', payload: 'Edited Docs & Accuracy Report' },
    ],
  },
  security_review: {
    team: 'Security Review Team',
    steps: [
      { key: 'threat_modeler', role: 'Threat Modeler' },
      { key: 'appsec_reviewer', role: 'AppSec Reviewer', payload: 'Attack Surface Map & Ranked Threats' },
      { key: 'dependency_auditor', role: 'Dependency Auditor', payload: 'Confirmed Findings & Exploit Scenarios' },
      { key: 'remediation_engineer', role: 'Remediation Engineer', payload: 'Dependency Audit & Remediation Order' },
      { key: 'security_signoff', role: 'Security Signoff', payload: 'Fixed Findings & Verification Output' },
    ],
  },
  refactor_migration: {
    team: 'Refactor & Migration Crew',
    steps: [
      { key: 'architect', role: 'Architect' },
      { key: 'migration_planner', role: 'Migration Planner', payload: 'Target Architecture & Invariants' },
      { key: 'refactor_engineer', role: 'Refactor Engineer', payload: 'Stepped Migration Plan & Verifications' },
      { key: 'regression_qa', role: 'Regression QA', payload: 'Completed Steps & Changed Files' },
      { key: 'release_coordinator', role: 'Release Coordinator', payload: 'Per-Invariant PASS/FAIL Report' },
    ],
  },
  go_to_market_launch: {
    team: 'Go-to-Market Launch Team',
    steps: [
      { key: 'market_analyst', role: 'Market Analyst' },
      { key: 'positioning_strategist', role: 'Positioning Strategist', payload: 'Market Analysis & Priority Segments' },
      { key: 'campaign_planner', role: 'Campaign Planner', payload: 'Positioning Statement & Message Pillars' },
      { key: 'sales_enablement_lead', role: 'Sales Enablement Lead', payload: 'Phased Campaign Plan' },
      { key: 'launch_pm', role: 'Launch PM', payload: 'Sales Enablement Kit' },
      { key: 'metrics_analyst', role: 'Metrics Analyst', payload: 'Launch Runbook & Go/No-Go Criteria' },
    ],
  },
  marketing_campaign: {
    team: 'Marketing Campaign Team',
    steps: [
      { key: 'audience_researcher', role: 'Audience Researcher' },
      { key: 'messaging_strategist', role: 'Messaging Strategist', payload: 'Audience Profile & Channel Evidence' },
      { key: 'channel_planner', role: 'Channel Planner', payload: 'Core Message & Segment Variations' },
      { key: 'content_producer', role: 'Content Producer', payload: 'Channel Allocation & Format Specs' },
      { key: 'performance_analyst', role: 'Performance Analyst', payload: 'Produced Content Files' },
    ],
  },
  sales_enablement: {
    team: 'Sales Enablement Team',
    steps: [
      { key: 'buyer_researcher', role: 'Buyer Researcher' },
      { key: 'pitch_strategist', role: 'Pitch Strategist', payload: 'Buyer Committee Map & Vocabulary' },
      { key: 'objection_handler', role: 'Objection Handler', payload: 'Pitch Narrative & Discovery Questions' },
      { key: 'collateral_writer', role: 'Collateral Writer', payload: 'Objection/Response Guide' },
      { key: 'sales_coach', role: 'Sales Coach', payload: 'Collateral Assets' },
    ],
  },
  revenue_operations: {
    team: 'Revenue Operations Team',
    steps: [
      { key: 'funnel_analyst', role: 'Funnel Analyst' },
      { key: 'crm_ops_specialist', role: 'CRM Ops Specialist', payload: 'Funnel Leak Analysis' },
      { key: 'sales_process_designer', role: 'Sales Process Designer', payload: 'CRM Stage & Automation Spec' },
      { key: 'forecast_analyst', role: 'Forecast Analyst', payload: 'Redesigned Sales Process' },
      { key: 'revops_synthesizer', role: 'RevOps Synthesizer', payload: 'Forecast & Forecast Ritual' },
    ],
  },
  customer_success: {
    team: 'Customer Success Team',
    steps: [
      { key: 'account_researcher', role: 'Account Researcher' },
      { key: 'health_score_analyst', role: 'Health Score Analyst', payload: 'Account Profiles & Stakeholder Maps' },
      { key: 'playbook_designer', role: 'Playbook Designer', payload: 'Health Scores & Risk Drivers' },
      { key: 'escalation_coordinator', role: 'Escalation Coordinator', payload: 'CS Playbooks & Trigger Mapping' },
      { key: 'renewal_strategist', role: 'Renewal Strategist', payload: 'Escalation Framework & Worked Examples' },
    ],
  },
  operations_improvement: {
    team: 'Operations Improvement Team',
    steps: [
      { key: 'process_mapper', role: 'Process Mapper' },
      { key: 'bottleneck_analyst', role: 'Bottleneck Analyst', payload: 'As-Is Process Map & Timings' },
      { key: 'sop_writer', role: 'SOP Writer', payload: 'Ranked Bottlenecks & Root Causes' },
      { key: 'automation_scout', role: 'Automation Scout', payload: 'SOPs & Addressed Bottlenecks' },
      { key: 'operations_pm', role: 'Operations PM', payload: 'Automation Candidates & Build/Buy Calls' },
    ],
  },
  vendor_procurement: {
    team: 'Vendor Procurement Team',
    steps: [
      { key: 'requirements_analyst', role: 'Requirements Analyst' },
      { key: 'vendor_researcher', role: 'Vendor Researcher', payload: 'Weighted Requirements & Criteria' },
      { key: 'risk_reviewer', role: 'Risk Reviewer', payload: 'Scored Vendor Shortlist' },
      { key: 'cost_analyst', role: 'Cost Analyst', payload: 'Per-Vendor Risk Assessment' },
      { key: 'recommendation_writer', role: 'Recommendation Writer', payload: 'TCO Comparison & Assumptions' },
    ],
  },
  research_brief: {
    team: 'Research Mission',
    steps: [
      { key: 'researcher', role: 'Researcher' },
      { key: 'source_critic', role: 'Source Critic', payload: 'Research Findings & Source List' },
      { key: 'synthesizer', role: 'Synthesizer', payload: 'Verified Claims & Caveats' },
      { key: 'media_producer', role: 'Media Producer', payload: 'Final Brief' },
    ],
  },
};

const FLOWS = { development_team: DEV_TEAM_FLOW };
const ROLE_META = { development_team: DEV_TEAM_ROLES };
const TEAM_LABELS = { development_team: 'Development Team' };

for (const [recipeId, chain] of Object.entries(RECIPE_CHAINS)) {
  FLOWS[recipeId] = chain.steps.slice(1).map((step, i) => ({
    from: chain.steps[i].key,
    to: step.key,
    payload: step.payload,
    requires_human: false,
  }));
  ROLE_META[recipeId] = Object.fromEntries(
    chain.steps.map(step => [step.key, { name: step.role, role: step.role }]),
  );
  TEAM_LABELS[recipeId] = chain.team;
}

// Code review is a fan-in, not a production line. Each lens can complete even
// when another lens is blocked, and the synthesizer receives every independent
// result. This prevents one missing upstream handoff from discarding the rest of
// the review. All four edges are required for a fully complete review; blocked
// runs may still conclude with a partial artifact via conclude_run.
FLOWS.code_review = [
  { from: 'review_lead', to: 'review_synthesizer', payload: 'Review Scope & File Inventory', requires_human: false },
  { from: 'implementation_reviewer', to: 'review_synthesizer', payload: 'Implementation Findings & Severities', requires_human: false },
  { from: 'test_reviewer', to: 'review_synthesizer', payload: 'Executed Test Results & Coverage Map', requires_human: false },
  { from: 'security_reviewer', to: 'review_synthesizer', payload: 'Security Findings & Cleared Areas', requires_human: false },
];

function getFlow(recipeId) {
  return FLOWS[recipeId] || null;
}

function hasProtocol(recipeId) {
  return Boolean(FLOWS[recipeId]);
}

// Find the canonical edge for a from→to pair (the contract for that handoff).
function findEdge(recipeId, fromRole, toRole) {
  const flow = getFlow(recipeId);
  if (!flow) return null;
  return flow.find(e => e.from === fromRole && e.to === toRole) || null;
}

// ── 3. Standardized Message Protocol — .agent.json ID cards (A2A) ──────────────
// An "ID card" the orchestrator (or any external system) can read to know how
// to talk to an agent WITHOUT knowing its internal code: its capabilities, the
// payload it accepts, the payload it emits, and who it hands off to/from.
function buildAgentCard(recipeId, roleKey, opts = {}) {
  const flow = getFlow(recipeId);
  const meta = (ROLE_META[recipeId] || {})[roleKey];
  if (!flow || !meta) return null;

  const incoming = flow.filter(e => e.to === roleKey);
  const outgoing = flow.filter(e => e.from === roleKey);

  const colonyId = opts.colonyId || ':colonyId';

  return {
    schema_version: CARD_SCHEMA_VERSION,
    protocols: ['A2A', 'ACP'],
    key: roleKey,
    name: opts.name || meta.name,
    role: meta.role,
    agent_id: opts.agentId || null,
    description: `${meta.role} in a Hive ${TEAM_LABELS[recipeId] || 'colony crew'}. Communicates via the colony ` +
      `blackboard and tool-based handoffs using the A2A/ACP protocol.`,
    capabilities: opts.tools || [],
    // What this agent accepts when invoked / handed off to.
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The work item or instruction for this role.' },
        from: { type: 'string', description: 'Role key of the upstream agent, if this is a handoff.' },
        payload: {
          type: 'object',
          description: incoming.length
            ? `Expected upstream payload: ${incoming.map(e => e.payload).join(' | ')}`
            : 'Initial mission context.',
        },
      },
      required: ['task'],
    },
    // What this agent emits on completion (its handoff command object payload).
    output_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Concise result of the work performed.' },
        payload: {
          type: 'object',
          description: outgoing.length
            ? `Handoff payload produced: ${outgoing.map(e => e.payload).join(' | ')}`
            : 'Terminal output; no downstream handoff.',
        },
        artifacts: { type: 'array', items: { type: 'string' }, description: 'Files, PR links, URLs.' },
      },
      required: ['summary'],
    },
    accepts_handoff_from: incoming.map(e => e.from),
    hands_off_to: outgoing.map(e => ({ to: e.to, payload: e.payload, requires_human: !!e.requires_human })),
    // ACP REST conventions — where to send messages / read shared state for this colony.
    endpoints: {
      card:        `/api/colony/${colonyId}/agents/${roleKey}/card`,
      acp_message: `/api/colony/${colonyId}/acp/messages`,
      blackboard:  `/api/colony/${colonyId}/blackboard`,
      handoffs:    `/api/colony/${colonyId}/handoffs`,
    },
  };
}

function buildAllCards(recipeId, opts = {}) {
  const flow = getFlow(recipeId);
  if (!flow) return [];
  const keys = Object.keys(ROLE_META[recipeId] || {});
  return keys.map(k => buildAgentCard(recipeId, k, opts));
}

// ── 1. Shared Context Layer (Blackboard) ──────────────────────────────────────
const VALID_ENTRY_TYPES = new Set(['state', 'blocker', 'checkpoint', 'progress', 'assistance', 'message']);

function writeBlackboard(colonyId, agent, entryType, content, meta = {}) {
  const type = VALID_ENTRY_TYPES.has(entryType) ? entryType : 'state';
  const info = db.prepare(
    `INSERT INTO colony_blackboard (colony_id, agent, entry_type, content, meta)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(colonyId, String(agent || 'unknown'), type, String(content ?? ''), JSON.stringify(meta || {}));
  return { id: info.lastInsertRowid, colony_id: colonyId, agent, entry_type: type, content };
}

// Agents pass role keys ("business_analyst") while entries are stored under
// display names ("Business Analyst") — normalize both sides so the filter
// actually matches instead of silently returning 0 entries.
function normalizeAgentName(s) {
  return String(s || '').toLowerCase().replace(/[\s_-]+/g, '_').trim();
}

function readBlackboard(colonyId, { entryType, agent, limit = 100 } = {}) {
  let sql = 'SELECT id, agent, entry_type, content, meta, created_at FROM colony_blackboard WHERE colony_id = ?';
  const args = [colonyId];
  if (entryType) { sql += ' AND entry_type = ?'; args.push(entryType); }
  sql += ' ORDER BY id ASC LIMIT ?';
  args.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  let rows = db.prepare(sql).all(...args).map(r => ({
    ...r,
    meta: safeParse(r.meta, {}),
  }));
  if (agent) {
    const want = normalizeAgentName(agent);
    rows = rows.filter(r => normalizeAgentName(r.agent) === want);
  }
  return rows;
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ── 2. Handoff Mechanisms — command objects + ledger ───────────────────────────
// A command object names the target agent and carries the context needed to
// continue work. We persist every one to the handoff ledger so the lifecycle is
// auditable and resumable.
function recordHandoff(colonyId, { fromRole, toRole, payload, protocolStatus = 'ok', requiresHuman = false, status = 'pending', historyRef = null }) {
  const id = newId();
  db.prepare(
    `INSERT INTO colony_handoffs (id, colony_id, from_agent, to_agent, payload, status, protocol_status, requires_human, history_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, colonyId, String(fromRole), String(toRole), JSON.stringify(payload || {}), status, protocolStatus, requiresHuman ? 1 : 0, historyRef);
  return getHandoff(id);
}

function getHandoff(id) {
  const row = db.prepare('SELECT * FROM colony_handoffs WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, payload: safeParse(row.payload, {}), requires_human: !!row.requires_human };
}

function listHandoffs(colonyId) {
  return db.prepare('SELECT * FROM colony_handoffs WHERE colony_id = ? ORDER BY created_at ASC, rowid ASC').all(colonyId)
    .map(r => ({ ...r, payload: safeParse(r.payload, {}), requires_human: !!r.requires_human }));
}

function updateHandoff(id, fields) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return getHandoff(id);
  args.push(id);
  db.prepare(`UPDATE colony_handoffs SET ${sets.join(', ')}, updated_at = unixepoch() WHERE id = ?`).run(...args);
  return getHandoff(id);
}

function historyRefForAgent(agentId) {
  return agentId ? `agent:${agentId}` : null;
}

function persistAgentHistory(colonyId, agentId, history = []) {
  if (!colonyId || !agentId) return null;
  db.prepare(`
    INSERT INTO colony_agent_histories (colony_id, agent_id, history, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(colony_id, agent_id)
    DO UPDATE SET history=excluded.history, updated_at=unixepoch()
  `).run(colonyId, agentId, JSON.stringify(Array.isArray(history) ? history : []));
  return historyRefForAgent(agentId);
}

function getHandoffContext(handoffId) {
  const handoff = getHandoff(handoffId);
  if (!handoff) return { error: `Handoff "${handoffId}" not found` };
  const historyRef = handoff.history_ref || handoff.payload?.history_ref || null;
  if (!historyRef) return { error: `Handoff "${handoffId}" has no history_ref`, handoff };
  const match = String(historyRef).match(/^agent:(.+)$/);
  if (!match) return { error: `Unsupported history_ref "${historyRef}"`, handoff };
  const row = db.prepare('SELECT history, updated_at FROM colony_agent_histories WHERE colony_id=? AND agent_id=?')
    .get(handoff.colony_id, match[1]);
  if (!row) return { error: `No persisted history found for ${historyRef}`, handoff, history_ref: historyRef };
  return {
    handoff,
    history_ref: historyRef,
    updated_at: row.updated_at,
    history: safeParse(row.history, []),
  };
}

// ── 5. Rules of Engagement ─────────────────────────────────────────────────────
// Mandatory preconditions: a handoff X→Y is only valid once every earlier edge
// in the canonical flow has a satisfied (accepted/approved) handoff on record.
// This is what stops the Developer starting before the BA has validated logic.
function checkPreconditions(colonyId, recipeId, fromRole, toRole) {
  const flow = getFlow(colonyId && recipeId ? recipeId : recipeId);
  if (!flow) return { ok: true, note: 'No protocol flow for this recipe; preconditions not enforced.' };

  const edgeIndex = flow.findIndex(e => e.from === fromRole && e.to === toRole);
  if (edgeIndex === -1) {
    return {
      ok: false,
      protocol_status: 'not_understood',
      reason: `No defined handoff from "${fromRole}" to "${toRole}" in the ${recipeId} flow. ` +
        `Valid edges: ${flow.map(e => `${e.from}→${e.to}`).join(', ')}.`,
    };
  }

  // Fan-in review lenses are intentionally independent. The operator controls
  // delegation order (scope first, specialists next); protocol enforcement only
  // validates that each reviewer hands its own result to the synthesizer.
  if (recipeId === 'code_review') return { ok: true, edge: flow[edgeIndex] };

  const ledger = listHandoffs(colonyId);
  const isSatisfied = (edge) => ledger.some(h =>
    h.from_agent === edge.from && h.to_agent === edge.to &&
    h.protocol_status === 'ok' &&
    (h.status === 'accepted' || h.status === 'approved' || (!edge.requires_human && h.status === 'pending')),
  );

  const missing = flow.slice(0, edgeIndex).filter(edge => !isSatisfied(edge));
  if (missing.length) {
    return {
      ok: false,
      protocol_status: 'precondition_failed',
      reason: `Preconditions not met for ${fromRole}→${toRole}. Missing upstream handoffs: ` +
        `${missing.map(e => `${e.from}→${e.to} (${e.payload})`).join('; ')}.`,
      missing: missing.map(e => ({ from: e.from, to: e.to, payload: e.payload })),
    };
  }
  return { ok: true, edge: flow[edgeIndex] };
}

// The "Not-Understood" act — a standardized protocol-violation envelope an agent
// returns instead of hallucinating a response it can't actually produce.
function protocolViolation(reason, extra = {}) {
  return {
    acp_version: ACP_VERSION,
    type: 'protocol_violation',
    performative: 'not-understood',
    ok: false,
    reason,
    ...extra,
  };
}

// Is the colony's protocol flow in a state where the run may be declared done?
// Blocks completion if any critical handoff still awaits human approval, or if
// the handoff flow was never used at all. Reaching the terminal edge is reported
// (terminal_reached) but not hard-required — a mission may legitimately stop
// short of deployment, but it may NOT skip the protocol or an unresolved gate.
function flowCompletion(colonyId, recipeId) {
  const flow = getFlow(recipeId);
  if (!flow) return { ok: true, protocol: false };

  const ledger = listHandoffs(colonyId);
  // Legacy `awaiting_human` handoffs (from runs recorded before in-run human
  // gates were removed) are auto-approved — the human review point is the
  // Draft PR on GitHub, not the Handoffs panel.
  for (const h of ledger) {
    if (h.status === 'awaiting_human') {
      try { updateHandoff(h.id, { status: 'approved', human_note: 'auto-approved (in-run human gates removed; review happens on the Draft PR)' }); h.status = 'approved'; } catch (e) { logSwallowed('colonyProtocol:autoApproveHandoff', e, { handoffId: h.id, colonyId }); }
    }
  }

  const satisfied = ledger.filter(h =>
    h.protocol_status === 'ok' && (h.status === 'accepted' || h.status === 'approved' || h.status === 'pending'));
  if (satisfied.length === 0) {
    return {
      ok: false,
      protocol: true,
      reason: 'No handoffs recorded — the team has not used the handoff flow. Each role must hand off to the next (handoff tool) before the run can complete.',
    };
  }

  const missingEdges = flow.filter(edge =>
    !satisfied.some(h => h.from_agent === edge.from && h.to_agent === edge.to));
  const terminal = flow[flow.length - 1];
  const terminalReached = recipeId === 'code_review'
    ? missingEdges.length === 0
    : satisfied.some(h => h.from_agent === terminal.from && h.to_agent === terminal.to);
  return {
    ok: true,
    protocol: true,
    terminal_reached: terminalReached,
    missing_edges: missingEdges.map(e => ({ from: e.from, to: e.to, payload: e.payload })),
  };
}

// Assemble a structured deliverable from the handoff ledger — replaces the old
// single free-text `summary` blob with auditable artifacts, links, and the
// handoff trail. Links/artifacts are best-effort extracted from payloads.
function buildDeliverable(colonyId, recipeId, summary) {
  const ledger = listHandoffs(colonyId);
  const completion = flowCompletion(colonyId, recipeId);
  const artifacts = [];
  const links = [];
  const linkRe = /https?:\/\/[^\s")]+/g;

  for (const h of ledger) {
    const p = h.payload || {};
    if (Array.isArray(p.artifacts)) {
      for (const a of p.artifacts) {
        if (typeof a === 'string' && a.trim()) {
          artifacts.push(a.trim());
          const m = a.match(linkRe);
          if (m) links.push(...m);
        }
      }
    }
    const blob = JSON.stringify(p);
    const m = blob.match(linkRe);
    if (m) links.push(...m);
  }

  // Latest per-criterion acceptance verdicts recorded via report_acceptance.
  let acceptance = null;
  try {
    const bbEntries = readBlackboard(colonyId, { limit: 500 });
    for (const entry of bbEntries) {
      if (Array.isArray(entry.meta?.acceptance_results) && entry.meta.acceptance_results.length > 0) {
        acceptance = { results: entry.meta.acceptance_results, by: entry.agent, at: entry.created_at };
      }
    }
  } catch (e) { logSwallowed('colonyProtocol:readAcceptance', e, { colonyId }); }

  return {
    summary: summary || null,
    flow_complete: !!completion.terminal_reached,
    handoffs: ledger.map(h => ({
      from: h.from_agent,
      to: h.to_agent,
      contract: (h.payload && h.payload.contract) || null,
      status: h.status,
    })),
    artifacts: [...new Set(artifacts)],
    links: [...new Set(links)],
    ...(acceptance ? { acceptance } : {}),
  };
}

// Standardized ACP message envelope (REST-friendly, async-friendly).
function acpEnvelope(type, { from, to, performative, content, meta = {} }) {
  return {
    acp_version: ACP_VERSION,
    id: newId(),
    type,                       // message | assistance | progress | handoff
    performative: performative || type,
    from: from || null,
    to: to || null,
    content: content ?? null,
    meta,
    ts: Date.now(),
  };
}

module.exports = {
  ACP_VERSION,
  CARD_SCHEMA_VERSION,
  DEV_TEAM_FLOW,
  DEV_TEAM_ROLES,
  RECIPE_CHAINS,
  getFlow,
  hasProtocol,
  findEdge,
  buildAgentCard,
  buildAllCards,
  writeBlackboard,
  readBlackboard,
  recordHandoff,
  getHandoff,
  listHandoffs,
  updateHandoff,
  historyRefForAgent,
  persistAgentHistory,
  getHandoffContext,
  checkPreconditions,
  flowCompletion,
  buildDeliverable,
  protocolViolation,
  acpEnvelope,
};
