// The non-streaming agent tool-loop (runAgentOnce), split out of agentTools.js
// (#27). Requires the tool registry for getToolDefinitions/executeTool; the tool
// modules that call back into runAgentOnce (e.g. ask_agent) require this module
// lazily, so there is no load-time cycle.
const providers = require('./providers');
const { logSwallowed } = require('./logSwallowed');
const {
  readMemory, extractTextToolCalls, isPermissionError, permissionGuidance,
  MODEL_ROUND_TIMEOUT_MS, MAX_SUB_ROUNDS,
} = require('./tools/shared');
const { getToolDefinitions, executeTool } = require('./tools/registry');
const { buildSystemPrompt } = require('./systemPrompt');

async function runAgentOnce(targetAgent, userMessages, ollamaUrl, depth, ws = null, hivePath = null, toolsOverride = null, maxRounds = MAX_SUB_ROUNDS, signal = null, colonyContext = null) {
  const agentName = targetAgent.name || targetAgent.id;

  // Build target's system prompt with identity + memory. The identity + user-prompt
  // + memory scaffold is shared with the WebSocket chat loop via buildSystemPrompt;
  // this path uses the 'agent' mode (leaner anchor, no chat formatting/hello lines).
  const memory = readMemory(targetAgent.workspace);
  const systemContent = buildSystemPrompt(targetAgent, {
    mode: 'agent',
    agentId: targetAgent.id,
    memory,
  });

  // toolsOverride (non-empty array) lets callers (pipeline steps, schedules) supply
  // a specific tool list that takes precedence over the agent's own configuration.
  const effectiveTools = (toolsOverride?.length > 0) ? toolsOverride : (targetAgent.tools || []);
  const targetTools = effectiveTools.length > 0 ? getToolDefinitions(effectiveTools) : [];

  const messages = [{ role: 'system', content: systemContent }, ...userMessages];

  // Detect worker tool-call loops: if the same tool+args is called 3+ times
  // consecutively the worker is stuck (e.g. retrying a successful pip install
  // because it misreads a WARNING as failure). Break the loop with an error.
  let lastCallKey = null;
  let consecutiveRepeats = 0;
  // Permission circuit-breaker: tools that have already returned a permission/
  // auth error this turn. On the first hit we tell the agent what to do; a second
  // hit on the same tool short-circuits so it can't loop on an unfixable error.
  const permissionTools = (colonyContext && colonyContext.permissionTools) || new Set();
  if (colonyContext && !colonyContext.permissionTools) colonyContext.permissionTools = permissionTools;

  // Per-agent budget: mint (once) a gateway virtual key carrying this agent's
  // max_budget so the gateway enforces the cap. Falls back to the shared key.
  let agentGatewayKey = targetAgent.gateway_key || null;
  if (!agentGatewayKey && Number(targetAgent.gateway_budget_usd) > 0) {
    try { agentGatewayKey = await providers.ensureAgentGatewayKey(targetAgent); } catch (e) { logSwallowed('agentTools:ensureGatewayKey', e, { agentId: targetAgent.id }); }
  }

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error('Colony run was stopped');

    // Stream one model round through the provider layer (Ollama or a cloud
    // provider, routed by the model id prefix). The provider yields normalized
    // events; we accumulate them into the same { content, thinking, tool_calls }
    // shape the tool loop below already expects.
    const acc = { content: '', thinking: '', tool_calls: null };

    const roundAc = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { roundAc.abort(); } catch {} /* abort is best-effort */
    }, MODEL_ROUND_TIMEOUT_MS);
    const onAbort = () => { try { roundAc.abort(); } catch {} /* abort is best-effort */ };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      for await (const ev of providers.streamChat(targetAgent.model, {
        messages,
        tools: targetTools,
        options: {
          ...(colonyContext?.reasoningByAgentId?.has?.(targetAgent.id)
            ? { reasoning: colonyContext.reasoningByAgentId.get(targetAgent.id) }
            : {}),
          // Spend attribution (gateway logs this per request).
          metadata: {
            agent_id: targetAgent.id,
            agent_name: agentName,
            ...(colonyContext?.colonyId ? { colony_id: colonyContext.colonyId } : {}),
            ...(colonyContext?.roleByAgentId?.get?.(targetAgent.id)
              ? { role: colonyContext.roleByAgentId.get(targetAgent.id) }
              : {}),
            source: colonyContext ? 'colony' : (depth > 0 ? 'sub_agent' : 'agent'),
          },
          // Per-agent virtual key (budget enforcement) when minted; else shared key.
          gatewayKey: agentGatewayKey || undefined,
        },
        signal: roundAc.signal,
      })) {
        if (ev.type === 'content') {
          acc.content += ev.delta;
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: ev.delta, kind: 'content' }));
          }
        } else if (ev.type === 'thinking') {
          acc.thinking += ev.delta;
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'token', subAgent: agentName, delta: ev.delta, kind: 'thinking' }));
          }
        } else if (ev.type === 'tool_call') {
          (acc.tool_calls ||= []).push(ev.call);
        }
      }
    } catch (streamErr) {
      if (timedOut) throw new Error(`Model request timed out for "${targetAgent.model}" after ${Math.round(MODEL_ROUND_TIMEOUT_MS / 1000)}s`);
      if (streamErr.name === 'AbortError' || streamErr.message === 'Colony run was stopped' || signal?.aborted) throw streamErr;
      throw new Error(`Model request failed for "${targetAgent.model}": ${streamErr.message}`);
    } finally {
      clearTimeout(timeout);
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch {} /* listener may already be removed */
      }
    }

    // If the model didn't emit proper tool_calls but wrote JSON tool descriptions
    // in its text (common with llama3.1, mistral, and other 7-8B models), parse
    // them out and execute them as if they were real tool calls.
    const syntacticToolCalls = (!acc.tool_calls?.length && acc.content && targetTools.length > 0)
      ? extractTextToolCalls(acc.content, targetTools)
      : [];
    if (syntacticToolCalls.length > 0) acc.tool_calls = syntacticToolCalls;

    const msg = {
      content: acc.content,
      ...(acc.thinking ? { thinking: acc.thinking } : {}),
      ...(acc.tool_calls ? { tool_calls: acc.tool_calls } : {}),
    };

    if (acc.thinking && ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'thinking', subAgent: agentName, content: acc.thinking }));
    }

    messages.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });

    if (!msg.tool_calls?.length) {
      return msg.content || '(no response)';
    }

    // Execute each tool call and append results
    for (const tc of msg.tool_calls) {
      if (signal?.aborted) throw new Error('Colony run was stopped');

      const toolName = tc.function?.name;
      const rawArgs  = tc.function?.arguments ?? {};
      let args;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch {
          // Python-style single quotes (llama3.1 quirk)
          try { args = JSON.parse(rawArgs.replace(/'/g, '"')); } catch { args = {}; }
        }
      } else {
        args = rawArgs;
      }

      // Loop detection: same tool + same args called 3 consecutive times → stuck.
      const callKey = toolName + '|' + JSON.stringify(args);
      if (callKey === lastCallKey) {
        consecutiveRepeats++;
      } else {
        lastCallKey = callKey;
        consecutiveRepeats = 1;
      }

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'sub_tool_call', subAgent: agentName, name: toolName, args }));
      }

      let result;
      if (consecutiveRepeats >= 3) {
        result = {
          error: `Duplicate call detected: "${toolName}" has been called with identical arguments ${consecutiveRepeats} times in a row. The previous call likely succeeded (check the prior result). Stop retrying this operation and move on to the next task.`,
        };
      } else if (permissionTools.has(toolName)) {
        // Already failed on permissions once — do not run it again.
        result = { error: `HALTED: "${toolName}" already failed with a permissions/auth error and was not retried. The required access is still not enabled. Report what the user needs to enable and proceed without this tool.`, permission_required: true, halted: true };
      } else {
        result = await executeTool(toolName, args, targetAgent.id, ollamaUrl, depth + 1, targetAgent.workspace, hivePath, ws, maxRounds, signal, colonyContext);
        if (isPermissionError(result)) {
          permissionTools.add(toolName);
          const original = result.error;
          result = { error: permissionGuidance(toolName, original), permission_required: true, tool: toolName, original_error: original };
          if (ws && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'permission_required', subAgent: agentName, name: toolName, message: original }));
          }
        }
      }

      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'sub_tool_result', subAgent: agentName, name: toolName, result }));
      }

      messages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id, name: toolName });
    }
  }

  return '(agent reached max tool rounds without a final answer)';
}

module.exports = { runAgentOnce };
