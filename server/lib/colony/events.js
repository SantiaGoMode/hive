// Colony live-event wiring.
// makeFakeWs adapts runAgentOnce's WebSocket-style event sink into a plain
// callback. makeColonyEventHandler builds the handler that turns raw agent
// events into structured colony log entries + bus events (plan updates,
// handoffs, blackboard writes, goal achievement, …).
const { readAgent } = require('../agentParser');
const protocol = require('../colonyProtocol');
const { logSwallowed } = require('../logSwallowed');
const { addAgentToColony } = require('./persistence');
const { truncateArgs, truncateResult } = require('./format');

function makeFakeWs(onEvent) {
  return {
    OPEN: 1,
    readyState: 1,
    send(raw) {
      try { onEvent(JSON.parse(raw)); } catch (e) { logSwallowed('colonyRunner:fakeWsEvent', e); }
    },
  };
}

// Build the raw-event handler passed (via makeFakeWs) into runAgentOnce.
// `ctx` carries the run-scoped closures/state:
//   { colonyId, signal, addEntry, onEvent, state }
// `state.goalSummary` is set here when mark_goal_achieved fires so the outer
// loop can detect completion.
function makeColonyEventHandler(ctx) {
  const { colonyId, signal, addEntry, onEvent, state } = ctx;

  return (msg) => {
    if (signal?.aborted) return;

    // Track new agents created by orchestrator. runAgentOnce emits every tool
    // call from inside its loop as 'sub_tool_call'/'sub_tool_result', so we
    // must match both forms here.
    const isToolResult = msg.type === 'tool_result' || msg.type === 'sub_tool_result';
    if (isToolResult && msg.name === 'create_agent' && msg.result?.agent_id) {
      addAgentToColony(colonyId, msg.result.agent_id);
      const newAgent = readAgent(msg.result.agent_id);
      if (newAgent) {
        const wa = {
          id: newAgent.id,
          name: newAgent.name,
          persona_role: newAgent.persona_role,
          avatar_color: newAgent.avatar_color,
          model: newAgent.model,
          tools: newAgent.tools,
        };
        onEvent({ type: 'agent_ready', role: 'worker', agent: wa });
        addEntry({ kind: 'agent_ready', role: 'worker', agent: wa });
      }
    }

    // Emit structured log entries for interesting tool calls
    const agentLabel = msg.subAgent || 'Orchestrator';

    // Token deltas stream through the bus directly — NOT persisted to the
    // DB log (would explode it) and NOT wrapped in a {type:'ws'} envelope
    // so the client can handle them with a dedicated case.
    if (msg.type === 'token') {
      onEvent({ type: 'token', agent: agentLabel, kind: msg.kind, delta: msg.delta });
      return;
    }

    if (msg.type === 'thinking') {
      const content = String(msg.content || '').trim();
      if (content) {
        const entry = { kind: 'thinking', agent: agentLabel, content: content.slice(0, 12000), truncated: content.length > 12000 };
        addEntry(entry);
        onEvent({ type: 'thinking', agent: agentLabel, content: entry.content, truncated: entry.truncated });
      }
      return;
    }

    // Permission circuit-breaker tripped — surface one actionable message to the
    // user (log + live event + blackboard) instead of letting the agent retry.
    if (msg.type === 'permission_required') {
      onEvent({ type: 'permission_required', agent: agentLabel, tool: msg.name, message: msg.message });
      addEntry({ kind: 'permission_required', agent: agentLabel, tool: msg.name, message: msg.message });
      try { protocol.writeBlackboard(colonyId, agentLabel, 'blocker', `Permission needed for "${msg.name}": ${msg.message}. Enable the required credential/scope, then re-run.`, { tool: msg.name, permission_required: true }); } catch (e) { logSwallowed('colonyRunner:blackboard', e, { colonyId }); }
      return;
    }

    if (msg.type === 'tool_call' || msg.type === 'sub_tool_call') {
      addEntry({
        kind:  'tool_call',
        agent: agentLabel,
        tool:  msg.name,
        args:  truncateArgs(msg.args),
      });
    }

    if (msg.type === 'tool_result' || msg.type === 'sub_tool_result') {
      addEntry({
        kind:   'tool_result',
        agent:  agentLabel,
        tool:   msg.name,
        result: truncateResult(msg.result),
      });

      // Capture plan state updates and goal-achievement signals. These come
      // from the three colony_tools and must drive: (a) a dedicated
      // plan_update bus event so the UI can rerender the checklist, and
      // (b) goalSummary so the outer loop exits cleanly on completion.
      if (msg.name === 'set_plan' && msg.result?.success && msg.result?.steps) {
        onEvent({ type: 'plan_update', plan: { steps: msg.result.steps } });
        addEntry({ kind: 'plan_set', step_count: msg.result.steps.length });
      }
      if (msg.name === 'update_plan_step' && msg.result?.success && msg.result?.plan) {
        onEvent({ type: 'plan_update', plan: msg.result.plan });
        addEntry({
          kind: 'plan_step_update',
          step_id: msg.result.step?.id,
          status: msg.result.step?.status,
          description: msg.result.step?.description,
        });
      }
      if (msg.name === 'mark_goal_achieved' && msg.result?.goal_achieved && msg.result?.summary) {
        state.goalSummary = msg.result.summary;
      }

      // Communication Protocol signals — surface handoffs (and human-approval
      // holds) so the UI can render the delivery lifecycle and pause points.
      // Auto-recorded handoffs (worker ended with text instead of the handoff
      // tool — see ask_agent) surface exactly like explicit handoffs.
      if (msg.name === 'ask_agent' && msg.result?.auto_handoff) {
        const ah = msg.result.auto_handoff;
        if (ah.plan) {
          onEvent({ type: 'plan_update', plan: ah.plan });
          const doneStep = [...(ah.plan.steps || [])].reverse().find(s => /^auto-completed/.test(s.note || '') && s.status === 'done');
          if (doneStep) {
            addEntry({ kind: 'plan_step_update', step_id: doneStep.id, status: 'done', description: doneStep.description });
          }
        }
        onEvent({ type: 'handoff', handoff: { id: ah.handoff_id, from: ah.from, to: ah.to, contract: ah.contract, status: ah.status, requires_human: false } });
        addEntry({ kind: 'handoff', agent: msg.result.agent_name || agentLabel, from: ah.from, to: ah.to, contract: ah.contract, status: ah.status, requires_human: false, auto_recorded: true });
      }

      if (msg.name === 'handoff' && msg.result) {
        // Accepted handoffs auto-advance the plan (see agentTools handoff handler) —
        // rerender the checklist live.
        if (msg.result.plan) {
          onEvent({ type: 'plan_update', plan: msg.result.plan });
          const doneStep = [...(msg.result.plan.steps || [])].reverse().find(s => /^auto-completed/.test(s.note || '') && s.status === 'done');
          if (doneStep) {
            addEntry({ kind: 'plan_step_update', step_id: doneStep.id, status: 'done', description: doneStep.description });
          }
        }
        if (msg.result.command) {
          const cmd = msg.result.command;
          onEvent({ type: 'handoff', handoff: { id: msg.result.handoff_id, from: cmd.from, to: cmd.target_agent, contract: cmd.contract, status: msg.result.status, requires_human: !!msg.result.requires_human } });
          addEntry({
            kind: 'handoff',
            agent: agentLabel,
            from: cmd.from,
            to: cmd.target_agent,
            contract: cmd.contract,
            status: msg.result.status,
            requires_human: !!msg.result.requires_human,
          });
        } else if (msg.result.ok === false) {
          onEvent({ type: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
          addEntry({ kind: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
        }
      }
      if ((msg.name === 'report_protocol_violation') && msg.result?.reason) {
        onEvent({ type: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
        addEntry({ kind: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
      }
      if (msg.name === 'blackboard_write' && msg.result?.success) {
        addEntry({ kind: 'blackboard', agent: msg.result.agent || agentLabel, entry_type: msg.result.entry_type });
      }
      if (msg.name === 'checkpoint' && msg.result?.success) {
        addEntry({ kind: 'checkpoint', agent: msg.result.agent || agentLabel });
      }
    }

    // Forward raw WS event for live clients
    onEvent({ type: 'ws', msg });
  };
}

module.exports = { makeFakeWs, makeColonyEventHandler };
