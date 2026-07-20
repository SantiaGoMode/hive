// Colony communication-protocol tools (context/blackboard/handoff). Split from agentTools.js (#27).
const db = require('../../db');
const protocol = require('../colonyProtocol');
const { logSwallowed } = require('../logSwallowed');
const { agentLabel, readProjectContextFiles, resolveRoleKey } = require('./shared');
const workflow = require('../colony/workflow');

module.exports = {
  // ── Colony Communication Protocol tools (group: 'protocol') ─────────────────
  // The structured layer that lets seeded colony agents collaborate: a shared
  // blackboard, checkpointing, tool-based handoffs with command objects, ACP
  // messaging, and the "not-understood" act. All gate on colonyContext.colonyId.

  project_context: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'project_context',
        description: 'Read the colony work-item source context: linked GitHub issue/project card, repo path, and local PRD/README/SPEC excerpts. Call this before role work so requirements are grounded in the repo and board item, not just the operator summary.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'project_context is only available inside a Colony run' };
      const row = db.prepare('SELECT goal, repo_path, board_card FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row) return { error: `Colony "${colonyContext.colonyId}" not found` };
      let board_card = null;
      try { board_card = row.board_card ? JSON.parse(row.board_card) : null; } catch (e) { logSwallowed('agentTools:parseBoardCard', e, { colonyId: colonyContext.colonyId }); }
      const reviewTarget = board_card?.review_target || null;
      const changedFiles = Array.isArray(reviewTarget?.changed_files) ? reviewTarget.changed_files : [];
      const guidance = reviewTarget
        ? [
          `Use review_target as the authoritative pull request under review (PR #${reviewTarget.number}).`,
          'Use changed_files with status values for scope. Read added/modified/renamed files from the checked-out PR head.',
          'Do NOT read removed/deleted files from the working tree; inspect their diff or base revision instead.',
          'Do NOT substitute HEAD~1..HEAD unless review_target.diff_command explicitly says to.',
        ].join(' ')
        : 'Use this source context in your handoff payload. Cite the GitHub issue/project card and any PRD/README/SPEC file you relied on. If no files are returned, say that explicitly.';
      return {
        repo_path: row.repo_path || null,
        board_card,
        review_target: reviewTarget,
        changed_files: changedFiles,
        goal: row.goal,
        source_files: readProjectContextFiles(row.repo_path),
        guidance,
      };
    },
  },

  blackboard_read: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'blackboard_read',
        description: 'Read the colony Shared Context Layer (the "Blackboard") — an append-only log of state, blockers, checkpoints, and progress from every agent. ALWAYS read this before starting work so you pick up where others left off. Optionally filter by entry_type or agent.',
        parameters: {
          type: 'object',
          properties: {
            entry_type: { type: 'string', enum: ['state', 'blocker', 'checkpoint', 'progress', 'assistance', 'message'], description: 'Only return entries of this type.' },
            agent: { type: 'string', description: 'Only return entries written by this agent label.' },
            limit: { type: 'number', description: 'Max entries (default 100).' },
          },
          required: [],
        },
      },
    },
    async handler({ entry_type, agent, limit }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'blackboard_read is only available inside a Colony run' };
      let entries = protocol.readBlackboard(colonyContext.colonyId, { entryType: entry_type, agent, limit });
      // Workers habitually filter by their OWN role and see nothing, then redo
      // upstream work from scratch. If a filter matched nothing but the board
      // has entries, return the unfiltered board with a note instead of an
      // empty result.
      if (entries.length === 0 && (agent || entry_type)) {
        const all = protocol.readBlackboard(colonyContext.colonyId, { limit });
        if (all.length > 0) {
          return {
            count: all.length,
            entries: all,
            note: `No entries matched your filter (${agent ? `agent="${agent}"` : ''}${agent && entry_type ? ', ' : ''}${entry_type ? `entry_type="${entry_type}"` : ''}) — showing ALL ${all.length} blackboard entries so you have the full shared context.`,
          };
        }
        // Whole board empty: small models cycle through every entry_type filter
        // looking for content that doesn't exist, burning their entire turn.
        return {
          count: 0,
          entries: [],
          note: 'The ENTIRE blackboard is empty — you are likely the first role to act this run. Do NOT read it again with other filters; start your role\'s work now.',
        };
      }
      return { count: entries.length, entries };
    },
  },

  blackboard_write: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'blackboard_write',
        description: 'Append an entry to the colony Blackboard so other agents can see your state. APPENDS — it never overwrites prior notes. Use entry_type "blocker" to flag something that stops progress, "state" for completed work or shared facts. Write ONE consolidated entry per stage of work — do not narrate each micro-step in separate entries.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What to record for the rest of the team.' },
            entry_type: { type: 'string', enum: ['state', 'blocker', 'progress'], description: 'Kind of entry (default state).' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content, entry_type = 'state' }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'blackboard_write is only available inside a Colony run' };
      if (!content || !String(content).trim()) return { error: 'content is required' };
      const author = agentLabel(colonyContext, callerAgentId);
      // Suppress exact repeats: small models re-post the same status every round,
      // burning context for every reader of blackboard_read.
      try {
        const last = db.prepare(
          'SELECT content FROM colony_blackboard WHERE colony_id=? AND agent=? AND entry_type=? ORDER BY id DESC LIMIT 1',
        ).get(colonyContext.colonyId, author, entry_type);
        const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (last && norm(last.content) === norm(content)) {
          return { success: true, deduplicated: true, message: 'Identical entry already on the blackboard — not re-posted. Move on to the actual work.' };
        }
      } catch (e) { logSwallowed('protocolTools:blackboardDedup', e, { colonyId: colonyContext.colonyId }); }
      const entry = protocol.writeBlackboard(colonyContext.colonyId, author, entry_type, content);
      return { success: true, entry_id: entry.id, agent: author, entry_type: entry.entry_type };
    },
  },

  checkpoint: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'checkpoint',
        description: 'Persist a progress checkpoint to the Blackboard so that if you fail or are interrupted, another agent can resume from a fresh context. Record what is done and what remains.',
        parameters: {
          type: 'object',
          properties: {
            progress: { type: 'string', description: 'Summary of work completed so far.' },
            next_step: { type: 'string', description: 'The next action a fresh agent should take.' },
          },
          required: ['progress'],
        },
      },
    },
    async handler({ progress, next_step }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'checkpoint is only available inside a Colony run' };
      const author = agentLabel(colonyContext, callerAgentId);
      const content = next_step ? `${progress}\n\nNEXT: ${next_step}` : String(progress || '');
      const entry = protocol.writeBlackboard(colonyContext.colonyId, author, 'checkpoint', content, { next_step: next_step || null });
      return { success: true, checkpoint_id: entry.id, agent: author };
    },
  },

  handoff: {
    // Worker-only group: the operator delegates via ask_agent and must not see
    // this tool at all — every operator "handoff" is either impersonation or a
    // wasted round on the rejection.
    group: 'protocol_worker',
    definition: {
      type: 'function',
      function: {
        name: 'handoff',
        description: 'Hand off control to the next specialist using a structured command object. Verifies the handoff is allowed by the role-specific flow and that all preconditions are met BEFORE proceeding. If the target or ordering is invalid it returns a protocol violation instead of proceeding. Accepted handoffs auto-advance the colony plan.',
        parameters: {
          type: 'object',
          properties: {
            to_role: { type: 'string', description: 'Role key of the target agent, e.g. "project_manager", "software_developer", "qa_engineer".' },
            summary: { type: 'string', description: 'Concise summary of the work you completed.' },
            payload: { type: 'object', description: 'The contract payload for this edge (e.g. validated business rules, component specs, PR link). Match your output_schema.' },
            artifacts: { type: 'array', items: { type: 'string' }, description: 'Optional file paths, PR links, or URLs.' },
            from_role: { type: 'string', description: 'Your own role key. Usually inferred automatically; only set if asked.' },
          },
          required: ['to_role', 'summary'],
        },
      },
    },
    async handler({ to_role, summary, payload = {}, artifacts = [], from_role }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'handoff is only available inside a Colony run' };
      const recipeId = colonyContext.recipeId;
      if (!protocol.hasProtocol(recipeId)) {
        return { error: `No communication protocol flow is defined for this colony (recipe "${recipeId}").` };
      }
      // Impersonation guard: the caller's REGISTERED role wins over the claimed
      // from_role. Without this the orchestrator can forge handoffs on behalf of
      // workers (observed in real runs: fabricated payloads, empty artifacts),
      // and each forged acceptance auto-completes a plan step no one worked on.
      const registeredRole = colonyContext?.roleByAgentId?.get?.(callerAgentId) || null;
      const hasRoster = colonyContext?.roleByAgentId && typeof colonyContext.roleByAgentId.get === 'function'
        && colonyContext.roleByAgentId.size > 0;
      if (hasRoster && !registeredRole) {
        return {
          error: `handoff is a worker tool — you are not a registered worker in the ${recipeId} flow, and handing off on a worker's behalf is not allowed. ` +
            `To advance work, call ask_agent for the target worker (use its agent_id); each worker calls handoff itself when its work is complete.`,
        };
      }
      const fromRole = registeredRole || resolveRoleKey(colonyContext, callerAgentId, from_role);
      if (!fromRole) {
        return protocol.protocolViolation('Could not determine your role key. Pass from_role explicitly (e.g. "business_analyst").');
      }
      const claimedMismatch = registeredRole && from_role && from_role !== registeredRole;

      // The flow only recognizes its own roles — anything else gets redirected.
      const flowRoles = new Set((protocol.getFlow(recipeId) || []).flatMap(e => [e.from, e.to]));
      if (!flowRoles.has(fromRole)) {
        return {
          error: `handoff is a worker tool — "${fromRole}" is not a role in the ${recipeId} flow. ` +
            `To advance work, call ask_agent for the target worker (use its agent_id); each worker calls handoff itself when its work is complete.`,
        };
      }

      // Idempotency: re-recording the same handoff with the same summary is a
      // loop, not progress. handoff used to mint a fresh handoff_id every call,
      // which defeated the identical-result breaker — a worker alternated
      // report_progress ↔ handoff 15 times, stacking 15 "accepted" handoffs.
      // (A re-handoff after rework carries a DIFFERENT summary and still passes.)
      try {
        const prior = protocol.listHandoffs(colonyContext.colonyId).find(h =>
          h.from_agent === fromRole && h.to_agent === to_role &&
          h.status !== 'rejected' &&
          String(h.payload?.summary || '').trim() === String(summary || '').trim());
        if (prior) {
          return {
            success: true,
            deduplicated: true,
            handoff_id: prior.id,
            message: `This exact ${fromRole}→${to_role} handoff is ALREADY RECORDED (${prior.id}) and the flow has advanced. Your work here is COMPLETE — END YOUR TURN NOW with a plain-text summary of what you did. Do not call handoff or report_progress again.`,
          };
        }
      } catch (e) { logSwallowed('protocolTools:handoffDedup', e, { colonyId: colonyContext.colonyId }); }

      // Rule of engagement: verify target + preconditions before acting.
      const check = protocol.checkPreconditions(colonyContext.colonyId, recipeId, fromRole, to_role);
      if (!check.ok) {
        // Record the rejected attempt for auditability and surface a clear protocol error.
        protocol.recordHandoff(colonyContext.colonyId, {
          fromRole, toRole: to_role, payload: { summary, ...payload },
          protocolStatus: check.protocol_status || 'precondition_failed', status: 'rejected',
        });
        protocol.writeBlackboard(colonyContext.colonyId, agentLabel(colonyContext, callerAgentId, fromRole), 'blocker',
          `Handoff ${fromRole}→${to_role} rejected: ${check.reason}`);
        return protocol.protocolViolation(check.reason, { from: fromRole, to: to_role, missing: check.missing });
      }

      const edge = check.edge;
      const requiresHuman = !!edge.requires_human;
      const historyRef = protocol.historyRefForAgent(callerAgentId);
      if (colonyContext?.agentHistories?.has(callerAgentId)) {
        try { protocol.persistAgentHistory(colonyContext.colonyId, callerAgentId, colonyContext.agentHistories.get(callerAgentId)); } catch (e) { logSwallowed('agentTools:persistHistory', e, { agentId: callerAgentId }); }
      }
      const commandObject = {
        target_agent: to_role,
        from: fromRole,
        contract: edge.payload,
        summary,
        payload,
        artifacts,
        history_ref: historyRef,
      };
      const record = protocol.recordHandoff(colonyContext.colonyId, {
        fromRole, toRole: to_role, payload: commandObject,
        protocolStatus: 'ok',
        requiresHuman,
        status: requiresHuman ? 'awaiting_human' : 'pending',
        historyRef,
      });
      workflow.addEvidence(colonyContext.colonyId, {
        kind: 'handoff', sourceAgentId: callerAgentId,
        payload: { handoff_id: record.id, from: fromRole, to: to_role, contract: edge.payload, artifacts },
      });

      const author = agentLabel(colonyContext, callerAgentId, fromRole);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'message',
        `Handoff → ${to_role} (${edge.payload}): ${summary}`,
        { handoff_id: record.id, requires_human: requiresHuman });

      if (requiresHuman) {
        return {
          success: true,
          handoff_id: record.id,
          status: 'awaiting_human',
          requires_human: true,
          command: commandObject,
          message: `This is a critical handoff (${edge.payload}) and is HELD for human approval. Do not assume the next role has started. A reviewer must approve via the colony Handoffs panel before ${to_role} proceeds.`,
        };
      }

      // Auto-advance the colony plan: an accepted handoff is hard evidence that a
      // stage of work completed. Operators (especially small local models) routinely
      // forget update_plan_step, leaving the plan checklist frozen at "pending" for
      // the whole run — so the protocol drives plan progress deterministically.
      let updatedPlan = null;
      try {
        const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
        if (planRow?.plan) {
          const plan = JSON.parse(planRow.plan);
          // Complete only work attributable to the handing-off role: its own
          // assigned step, or an unassigned step already in progress. A blanket
          // "next pending" would let a BA handoff complete an env-setup step.
          const steps = plan.steps || [];
          const ownSteps = steps.filter(s => (s.assigned_to || null) === fromRole);
          const step = ownSteps.find(s => s.status === 'in_progress')
            || ownSteps.find(s => s.status === 'pending')
            || steps.find(s => s.status === 'in_progress' && !s.assigned_to);
          if (step) {
            step.status = 'done';
            step.note = `auto-completed: handoff ${fromRole}→${to_role} accepted`;
            plan.updated_at = Date.now();
            db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
              .run(JSON.stringify(plan), colonyContext.colonyId);
            workflow.transition(colonyContext.colonyId, step.id, 'done', step.note);
            if (colonyContext.delegatedSteps) colonyContext.delegatedSteps.add(String(step.id));
            updatedPlan = plan;
          }
        }
      } catch (e) { logSwallowed('agentTools:planAdvance', e, { colonyId: colonyContext.colonyId }); }

      return {
        success: true,
        handoff_id: record.id,
        status: 'accepted',
        command: commandObject,
        ...(claimedMismatch ? { note: `from_role "${from_role}" ignored — recorded under your registered role "${registeredRole}".` } : {}),
        ...(updatedPlan ? { plan: updatedPlan } : {}),
      };
    },
  },

  get_handoff_context: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'get_handoff_context',
        description: 'Fetch the full upstream conversation history for a handoff by id. Use only when the handoff summary/payload is not enough; normal operation should rely on the command object to save tokens.',
        parameters: {
          type: 'object',
          properties: {
            handoff_id: { type: 'string', description: 'The handoff_id from a handoff command object or ledger entry.' },
          },
          required: ['handoff_id'],
        },
      },
    },
    async handler({ handoff_id }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'get_handoff_context is only available inside a Colony run' };
      if (!handoff_id) return { error: 'handoff_id is required' };
      const context = protocol.getHandoffContext(handoff_id);
      if (context?.handoff && context.handoff.colony_id !== colonyContext.colonyId) {
        return { error: `Handoff "${handoff_id}" does not belong to this colony.` };
      }
      return context;
    },
  },

};
