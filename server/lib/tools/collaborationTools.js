// Collaboration tools: ask_agent (delegation), shared blackboard, webhook events. (#27)
const { readAgent } = require('../agentParser');
const db = require('../../db');
const protocol = require('../colonyProtocol');
const { logSwallowed } = require('../logSwallowed');
const colonyModels = require('../colonyModels');
const { readShared, writeShared } = require('./shared');
// Lazy to avoid a load-time cycle with agentRunner (which requires the registry).
const runAgentOnce = (...a) => require('../agentRunner').runAgentOnce(...a);

module.exports = {
  ask_agent: {
    group: 'agent_tools',
    groups: ['agent_tools', 'delegation'],
    definition: {
      type: 'function',
      function: {
        name: 'ask_agent',
        description: 'Ask another agent a question. The target agent runs with its own system prompt, memory, and tools — so it can search the web, recall past context, etc. Use this to delegate to specialists.',
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'string', description: 'ID of the agent to consult' },
            message:  { type: 'string', description: 'Question or task to send' },
            context:  { type: 'string', description: 'Optional background context to share' },
          },
          required: ['agent_id', 'message'],
        },
      },
    },
    async handler({ agent_id, message, context }, { callerAgentId, ollamaUrl, depth, ws, hivePath, maxRounds, signal, colonyContext }) {
      if (agent_id === callerAgentId) return { error: 'An agent cannot ask itself' };
      if (depth >= 4) return { error: 'Maximum agent conversation depth reached' };

      let target = readAgent(agent_id);
      let resolvedId = agent_id;
      // Small models routinely mangle ids or pass a name/role instead. If the
      // direct lookup fails inside a colony, resolve against the roster by name,
      // persona role, or role key — and on a true miss, return the roster so the
      // model can self-correct next round instead of guessing again.
      let roster = [];
      if (!target && colonyContext?.colonyId) {
        try {
          const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyContext.colonyId);
          const ids = JSON.parse(row?.agent_ids || '[]');
          const wanted = String(agent_id).trim().toLowerCase();
          for (const id of ids) {
            const candidate = readAgent(id);
            if (!candidate) continue;
            const roleKey = colonyContext.roleByAgentId?.get?.(id) || null;
            roster.push({ agent_id: id, name: candidate.name, role: roleKey || candidate.persona_role || '' });
            const names = [candidate.name, candidate.persona_role, roleKey]
              .filter(Boolean).map(v => String(v).trim().toLowerCase());
            if (!target && names.includes(wanted)) {
              target = candidate;
              resolvedId = id;
            }
          }
        } catch (e) { logSwallowed('agentTools:resolveAgentByName', e, { colonyId: colonyContext.colonyId }); }
      }
      if (!target) {
        return {
          error: `Agent "${agent_id}" not found. Use one of these exact agent_ids:`,
          ...(roster.length ? { colony_agents: roster } : {}),
        };
      }
      if (!target.model) return { error: `Agent "${resolvedId}" has no model configured` };

      // In a colony run, maintain a persistent conversation thread per worker so
      // each ask_agent call continues where the last one left off. Without this,
      // every call starts a fresh conversation and the worker loses all prior context
      // (e.g. research findings from the previous step).
      const histories = colonyContext?.agentHistories;
      let userMessages;
      if (histories) {
        if (!histories.has(resolvedId)) {
          // First call to this agent: seed with optional context
          const seed = [];
          if (context) {
            seed.push({ role: 'user', content: `Context: ${context}` });
            seed.push({ role: 'assistant', content: 'Understood.' });
          }
          histories.set(resolvedId, seed);
        }
        const history = histories.get(resolvedId);
        history.push({ role: 'user', content: message });
        userMessages = history;
      } else {
        userMessages = [];
        if (context) {
          userMessages.push({ role: 'user', content: `Context: ${context}` });
          userMessages.push({ role: 'assistant', content: 'Understood.' });
        }
        userMessages.push({ role: 'user', content: message });
      }

      // Analysis roles (BA/PM/designer) deliver text and small files — 20 tool
      // rounds is pure fizzle budget for them; coding roles keep the full one.
      const budgetRole = colonyContext?.roleByAgentId?.get?.(resolvedId);
      const roleMaxRounds = budgetRole && !colonyModels.CODING_ROLES.has(budgetRole)
        ? Math.min(maxRounds || 20, 8)
        : maxRounds;

      const callsBefore = colonyContext?.toolCallsByAgent?.get?.(resolvedId) || 0;
      const response = await runAgentOnce(target, userMessages, ollamaUrl, depth, ws, hivePath, null, roleMaxRounds, signal, colonyContext);
      const callsMade = (colonyContext?.toolCallsByAgent?.get?.(resolvedId) || 0) - callsBefore;

      // Append assistant reply to the thread so the next call has full context.
      if (histories) {
        histories.get(resolvedId).push({ role: 'assistant', content: response });
        if (colonyContext?.colonyId) {
          try { protocol.persistAgentHistory(colonyContext.colonyId, resolvedId, histories.get(resolvedId)); } catch (e) { logSwallowed('agentTools:persistHistory', e, { agentId: resolvedId }); }
        }
      }

      // Track which plan steps have been delegated to workers.
      // update_plan_step uses this to prevent marking steps done without real work.
      // We can't know which step the orchestrator is working on, so we mark the
      // current in_progress step as delegated when any ask_agent succeeds.
      if (colonyContext?.delegatedSteps && colonyContext?.colonyId) {
        try {
          const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
          if (planRow?.plan) {
            const plan = JSON.parse(planRow.plan);
            const inProgress = plan.steps.find(s => s.status === 'in_progress');
            if (inProgress) colonyContext.delegatedSteps.add(String(inProgress.id));
          }
        } catch (e) { logSwallowed('agentTools:markDelegated', e, { colonyId: colonyContext.colonyId }); }
      }

      const noOutput = response === '(no response)' || response === '(agent reached max tool rounds without a final answer)';
      // Consecutive silent turns per worker: after two, retrying is a doom loop
      // (observed: six identical re-delegations to a fizzling designer). The
      // warning below flips from "retry" to "move on".
      const silentCounts = colonyContext ? (colonyContext.noOutputCounts ||= new Map()) : null;
      if (silentCounts) {
        if (noOutput) silentCounts.set(resolvedId, (silentCounts.get(resolvedId) || 0) + 1);
        else silentCounts.set(resolvedId, 0);
      }
      const silentTurns = silentCounts?.get(resolvedId) || 0;

      // Protocol fallback: weak models routinely END WITH TEXT ("BA handoff: …")
      // instead of calling the handoff tool, which leaves the ledger empty, blocks
      // downstream preconditions, and freezes plan auto-advance. If this worker's
      // role has exactly one outgoing flow edge whose preconditions are satisfied
      // and no handoff on record, record it from the response on the worker's behalf.
      let autoHandoff = null;
      let flowHint = null;
      if (!noOutput && colonyContext?.colonyId && protocol.hasProtocol(colonyContext.recipeId)) {
        try {
          const roleKey = colonyContext.roleByAgentId?.get?.(resolvedId);
          const flow = protocol.getFlow(colonyContext.recipeId) || [];
          // Flow-order nudge: if the operator delegated to a role that is NOT the
          // next expected one, say so explicitly. Without this the operator can
          // delegate in plan order (dev first), no edge ever becomes eligible,
          // and the run ends with zero handoffs on the ledger.
          {
            const ledgerNow = protocol.listHandoffs(colonyContext.colonyId);
            const satisfiedEdge = (e) => ledgerNow.some(h =>
              h.from_agent === e.from && h.to_agent === e.to &&
              h.protocol_status === 'ok' && h.status !== 'rejected');
            const nextEdge = flow.find(e => !satisfiedEdge(e));
            if (nextEdge && roleKey && roleKey !== nextEdge.from) {
              flowHint = `Out of flow order: the next expected handoff is ${nextEdge.from}→${nextEdge.to} (${nextEdge.payload}), so you should be delegating to ${nextEdge.from} now. Work done out of order cannot be handed off and will not count toward completion.`;
            }
          }
          const outgoing = flow.filter(e => e.from === roleKey);
          if (roleKey && outgoing.length === 1) {
            const edge = outgoing[0];
            const ledger = protocol.listHandoffs(colonyContext.colonyId);
            const alreadyRecorded = ledger.some(h =>
              h.from_agent === edge.from && h.to_agent === edge.to &&
              h.protocol_status === 'ok' && h.status !== 'rejected');
            const check = protocol.checkPreconditions(colonyContext.colonyId, colonyContext.recipeId, edge.from, edge.to);
            if (!alreadyRecorded && check.ok) {
              const summary = String(response).slice(0, 600);
              const record = protocol.recordHandoff(colonyContext.colonyId, {
                fromRole: edge.from, toRole: edge.to,
                payload: {
                  target_agent: edge.to, from: edge.from, contract: edge.payload,
                  summary, auto_recorded: true,
                },
                protocolStatus: 'ok', status: 'accepted',
                historyRef: protocol.historyRefForAgent(resolvedId),
              });
              protocol.writeBlackboard(colonyContext.colonyId, target.name, 'message',
                `Handoff → ${edge.to} (${edge.payload}) [auto-recorded from worker response]: ${summary.slice(0, 200)}`,
                { handoff_id: record.id, auto_recorded: true });
              // Auto-advance the plan exactly like an explicit handoff tool call.
              let updatedPlan = null;
              const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
              if (planRow?.plan) {
                const plan = JSON.parse(planRow.plan);
                // Same ownership scoping as the handoff tool: only complete the
                // handing-off role's own step, or an unassigned in_progress one.
                const steps = plan.steps || [];
                const ownSteps = steps.filter(s => (s.assigned_to || null) === edge.from);
                const step = ownSteps.find(s => s.status === 'in_progress')
                  || ownSteps.find(s => s.status === 'pending')
                  || steps.find(s => s.status === 'in_progress' && !s.assigned_to);
                if (step) {
                  step.status = 'done';
                  step.note = `auto-completed: handoff ${edge.from}→${edge.to} accepted`;
                  plan.updated_at = Date.now();
                  db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
                    .run(JSON.stringify(plan), colonyContext.colonyId);
                  if (colonyContext.delegatedSteps) colonyContext.delegatedSteps.add(String(step.id));
                  updatedPlan = plan;
                }
              }
              autoHandoff = {
                handoff_id: record.id, from: edge.from, to: edge.to,
                contract: edge.payload, status: 'accepted',
                ...(updatedPlan ? { plan: updatedPlan } : {}),
              };
            }
          }
        } catch (e) { logSwallowed('agentTools:autoHandoff', e, { colonyId: colonyContext.colonyId }); }
      }

      // A coding-role worker that "responds" without a single tool call has
      // described work, not done it (typical of small coding models). Flag it
      // so the operator re-delegates demanding execution instead of treating
      // the prose as progress.
      const workerRoleKey = colonyContext?.roleByAgentId?.get?.(resolvedId);
      const proseOnly = !noOutput && callsMade === 0
        && workerRoleKey && colonyModels.CODING_ROLES.has(workerRoleKey);

      return {
        agent_name: target.name,
        agent_id: resolvedId,
        response,
        ...(autoHandoff ? { auto_handoff: autoHandoff, note: `The worker did not call the handoff tool, so its ${autoHandoff.from}→${autoHandoff.to} handoff was auto-recorded from its response. The flow has advanced — delegate to the next role.` } : {}),
        ...(flowHint && !autoHandoff ? { flow_hint: flowHint } : {}),
        ...(noOutput ? {
          warning: silentTurns >= 2
            ? `${target.name} has produced no output ${silentTurns} times in a row — re-delegating to it AGAIN will fail the same way and is forbidden. Instead: mark its plan step blocked with a note, call report_workaround (issue: worker unresponsive), and continue the flow — delegate the NEXT role using the best available context.`
            : 'Worker produced no output. Retry ONCE with a simpler, more explicit task description. If it happens again, mark the step blocked and move on — do NOT keep retrying. Do NOT mark the step done until you have real output.',
        } : {}),
        ...(proseOnly ? { execution_warning: `${target.name} made ZERO tool calls — the response above is a plan in prose, NOT executed work. No files changed, nothing ran. Re-delegate with an explicit instruction to EXECUTE with sandbox tools (shell/write_file) and report actual command output. Do NOT mark any step done based on this response.` } : {}),
      };
    },
  },

  // ── Shared blackboard ────────────────────────────────────────────────────────
  read_shared: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'read_shared',
        description: 'Read the shared blackboard — a common notepad all agents can see. Use this to check what other agents have written or to read shared context before starting a task.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_args, { hivePath }) {
      const content = readShared(hivePath);
      return { content: content || '(shared blackboard is empty)' };
    },
  },

  write_shared: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'write_shared',
        description: 'Write to the shared blackboard that all agents can read. Use this to leave findings, summaries, or coordination notes for other agents. Content REPLACES the current shared notes.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full content to write to the shared blackboard (replaces existing)' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content }, { hivePath }) {
      writeShared(content, hivePath);
      return { success: true };
    },
  },

  get_webhook_event: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'get_webhook_event',
        description: 'Fetch the FULL raw payload of a webhook event by its id. The initial ' +
          'context you were given is a distilled subset of the event; call this only when you ' +
          'need fields that were not included in that context. Pass the _event_id from your input.',
        parameters: {
          type: 'object',
          properties: {
            event_id: { type: 'string', description: 'The _event_id from the provided context envelope' },
            include_headers: { type: 'boolean', description: 'Also return the request headers (default false)' },
          },
          required: ['event_id'],
        },
      },
    },
    async handler({ event_id, include_headers = false }) {
      if (!event_id) return { error: 'event_id is required' };
      const row = db.prepare('SELECT payload, headers, event_type FROM webhook_events WHERE id = ?').get(event_id);
      if (!row) return { error: `No webhook event with id ${event_id}` };
      const out = { event_type: row.event_type };
      try { out.payload = JSON.parse(row.payload); } catch { out.payload = row.payload; }
      if (include_headers) {
        try { out.headers = JSON.parse(row.headers); } catch { out.headers = row.headers; }
      }
      return out;
    },
  },

};
