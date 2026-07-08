// Colony plan tools (set_plan/add_plan_step/update_plan_step/mark_goal_achieved). (#27)
const db = require('../../db');
const protocol = require('../colonyProtocol');
const { updateGitHubIssue, detectGitHubRepo } = require('../githubBoard');

module.exports = {
  // ── Colony tools (only meaningful inside a Colony run) ──────────────────────
  // These tools let the Orchestrator register a structured plan, update step
  // status, and explicitly signal goal completion. They gate on colonyContext
  // so they no-op with a clear error if invoked outside a Colony.

  set_plan: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'set_plan',
        description: 'Register the Colony plan as a structured checklist of concrete steps. Call this FIRST, before creating any worker agents. Replaces any existing plan. Each step should be a concrete, verifiable task. Keep descriptions short (one sentence).',
        parameters: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              description: 'Ordered list of plan steps',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short unique id, e.g. "1", "2"' },
                  description: { type: 'string', description: 'One-sentence description of the step' },
                  assigned_to: { type: 'string', description: 'role_key of the role responsible (e.g. "software_developer"). Assign technical steps (env setup, installs, coding, config) ONLY to software_developer / qa_engineer / devops_engineer.' },
                },
                required: ['id', 'description'],
              },
            },
          },
          required: ['steps'],
        },
      },
    },
    async handler({ steps }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'set_plan is only available inside a Colony run' };
      // Block re-planning once work has started — prevents the orchestrator from
      // wiping completed steps mid-run by calling set_plan a second time.
      const existingRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (existingRow?.plan) {
        const existing = JSON.parse(existingRow.plan);
        const hasStarted = (existing.steps || []).some(s => s.status !== 'pending');
        if (hasStarted) {
          return { error: 'Plan is already in progress and cannot be replaced. Use update_plan_step to update existing steps, or add_plan_step to append new ones.' };
        }
      }
      // Some models (llama3.1, mistral) stringify complex arguments instead of
      // sending a proper JSON array. Try to recover before rejecting.
      let stepsArr = steps;
      if (typeof stepsArr === 'string') {
        try {
          // Handle Python-style single-quoted strings too
          stepsArr = JSON.parse(stepsArr.replace(/'/g, '"'));
        } catch {
          return { error: 'steps must be an array of {id, description} objects' };
        }
      }
      if (!Array.isArray(stepsArr) || stepsArr.length === 0) return { error: 'steps must be a non-empty array' };
      const normalized = stepsArr
        .map((s, i) => ({
          id: String(s.id ?? i + 1),
          description: String(s.description || '').trim(),
          assigned_to: s.assigned_to ? String(s.assigned_to) : null,
          status: 'pending',
        }))
        .filter(s => s.description);
      if (normalized.length === 0) return { error: 'all steps had empty descriptions' };
      const plan = { steps: normalized, updated_at: Date.now() };
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      return { success: true, step_count: normalized.length, steps: normalized };
    },
  },

  add_plan_step: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'add_plan_step',
        description: 'Append a new step to the existing plan mid-run. Use this when you discover additional work that was not in the original plan. Do NOT use set_plan to add steps — it is locked once work has started.',
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'One-sentence description of the new step' },
            assigned_to:  { type: 'string', description: 'Optional: worker name to assign this step to' },
          },
          required: ['description'],
        },
      },
    },
    async handler({ description, assigned_to }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'add_plan_step is only available inside a Colony run' };
      const trimmed = String(description || '').trim();
      if (!trimmed) return { error: 'description is required' };
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row?.plan) return { error: 'No plan has been set yet. Call set_plan first.' };
      const plan = JSON.parse(row.plan);
      // Generate a new ID that doesn't collide with existing ones.
      const existingIds = plan.steps.map(s => Number(s.id)).filter(n => !isNaN(n));
      const nextId = String(existingIds.length > 0 ? Math.max(...existingIds) + 1 : plan.steps.length + 1);
      const newStep = {
        id: nextId,
        description: trimmed,
        assigned_to: assigned_to ? String(assigned_to) : null,
        status: 'pending',
      };
      plan.steps.push(newStep);
      plan.updated_at = Date.now();
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      return { success: true, step: newStep, total_steps: plan.steps.length };
    },
  },

  update_plan_step: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'update_plan_step',
        description: 'Update one plan step as work progresses. Use this whenever a step changes state — in_progress when a worker starts it, done when verified working, blocked if something is preventing progress. Add a short note for context when blocked.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id of the step to update' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done', 'blocked'],
              description: 'New status for this step',
            },
            note: { type: 'string', description: 'Optional short note (max 500 chars)' },
          },
          required: ['id', 'status'],
        },
      },
    },
    async handler({ id, status, note }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'update_plan_step is only available inside a Colony run' };
      const validStatuses = ['pending', 'in_progress', 'done', 'blocked'];
      if (!validStatuses.includes(status)) return { error: `status must be one of: ${validStatuses.join(', ')}` };
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (!row?.plan) return { error: 'No plan has been set yet. Call set_plan first.' };
      const plan = JSON.parse(row.plan);
      const stepIndex = plan.steps.findIndex(s => String(s.id) === String(id));
      if (stepIndex === -1) return { error: `No plan step with id "${id}". Known ids: ${plan.steps.map(s => s.id).join(', ')}` };
      const step = plan.steps[stepIndex];
      // Idempotency nudge: if status unchanged, tell the model what to do next.
      if (step.status === status) {
        const nextPending = plan.steps.find(s => s.status === 'pending');
        const hint = status === 'in_progress'
          ? `Call ask_agent to have the worker complete this step, then mark it done.`
          : nextPending
            ? `Move on to step "${nextPending.id}": ${nextPending.description}`
            : `All steps are accounted for. Call mark_goal_achieved if everything is done.`;
        return { warning: `Step "${id}" is already ${status}. No change made. ${hint}`, step, plan };
      }
      // Prevent backtracking: can't reopen a completed step.
      if (step.status === 'done' && status === 'in_progress') {
        return { error: `Step "${id}" is already done and cannot be re-opened. Move on to the next pending step.` };
      }
      // Protocol recipes: accepted handoffs auto-advance the plan and are the
      // evidence of real work, so the strict in_progress/ordering/delegation
      // guards below only generate error ping-pong that burns the operator's
      // tool rounds (observed: ~15 of 20 rounds lost to guard errors). Apply
      // the transition directly and tell the operator the plan is auto-managed.
      const lenientProtocol = protocol.hasProtocol(colonyContext.recipeId);
      if (!lenientProtocol) {
      // Prevent skipping: can't mark a step in_progress if any earlier step is incomplete.
      if (status === 'in_progress') {
        const stuck = plan.steps.slice(0, stepIndex).find(s => s.status === 'in_progress');
        if (stuck) {
          return { error: `Step "${stuck.id}" is still in_progress. Mark it done (or blocked) before starting step "${id}".` };
        }
        const skipped = plan.steps.slice(0, stepIndex).find(s => s.status === 'pending');
        if (skipped) {
          return { error: `Step "${skipped.id}" hasn't been started yet. Work through steps in order — start step "${skipped.id}" before step "${id}".` };
        }
      }
      // Guard: can't jump from pending → done. Step must be in_progress first.
      if (status === 'done' && step.status === 'pending') {
        return {
          error: `Step "${id}" is still pending (never started). You must: (1) mark it in_progress, (2) call ask_agent to do the work, then (3) mark it done.`,
        };
      }
      // Guard: complete steps in order — can't mark done while earlier steps are unfinished.
      if (status === 'done') {
        const earlierUnfinished = plan.steps.slice(0, stepIndex).find(s => s.status !== 'done');
        if (earlierUnfinished) {
          return {
            error: `Step "${earlierUnfinished.id}" is not done yet (status: ${earlierUnfinished.status}). Complete earlier steps before finishing step "${id}".`,
          };
        }
      }
      // Guard: can't mark done without evidence of real work (ask_agent call).
      // Only applies once workers exist — if workersCreated is empty the orchestrator
      // has no workers yet and the check would be meaningless.
      if (status === 'done') {
        const delegated = colonyContext.delegatedSteps;
        const hasWorkers = colonyContext.workersCreated && colonyContext.workersCreated.size > 0;
        if (delegated && hasWorkers && !delegated.has(String(id))) {
          return {
            error: `Step "${id}" has not been delegated to a worker yet. Call ask_agent to have a worker do the actual work, then mark it done. Skipping delegation produces hollow, hallucinated results.`,
          };
        }
      }
      } // end !lenientProtocol guards
      if (lenientProtocol && colonyContext.delegatedSteps && status === 'done') {
        colonyContext.delegatedSteps.add(String(id));
      }
      step.status = status;
      if (note) step.note = String(note).slice(0, 500);
      plan.updated_at = Date.now();
      db.prepare('UPDATE colonies SET plan=?, updated_at=unixepoch() WHERE id=?')
        .run(JSON.stringify(plan), colonyContext.colonyId);
      
      // GitHub write-back: close issue if done
      if (status === 'done' && step.github_issue_number) {
        const colonyRow = db.prepare('SELECT github_writeback, repo_path FROM colonies WHERE id=?').get(colonyContext.colonyId);
        if (colonyRow?.github_writeback && colonyRow?.repo_path) {
          const detected = detectGitHubRepo(colonyRow.repo_path);
          if (detected) {
            updateGitHubIssue({
              owner: detected.owner,
              repo: detected.repo,
              number: step.github_issue_number,
              state: 'closed',
              comment: `✅ Task completed by Hive Colony.\n\n${step.note ? `**Note:** ${step.note}` : ''}`
            }).catch(err => {
              console.error('Failed to close GitHub issue:', err);
              protocol.writeBlackboard(colonyContext.colonyId, 'system', 'blocker',
                `Failed to update GitHub issue #${step.github_issue_number}: ${err.message}. Please check your token.`,
                { error: err.message }
              );
            });
          }
        }
      }

      return {
        success: true, step, plan,
        ...(lenientProtocol ? { note: 'Plan steps also auto-complete when handoffs are accepted — manual updates are only needed for blocked steps or extra work.' } : {}),
      };
    },
  },

  mark_goal_achieved: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'mark_goal_achieved',
        description: 'Call this EXACTLY ONCE when the mission is fully and verifiably complete. This ends the Colony run successfully. Before calling, confirm every plan step is marked done and the final result actually works (files exist, services respond, tests pass).',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Concise 2–4 sentence summary: what was built, where the key files are, and how to run/use it.',
            },
          },
          required: ['summary'],
        },
      },
    },
    async handler({ summary }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'mark_goal_achieved is only available inside a Colony run' };
      const trimmed = String(summary || '').trim();
      if (!trimmed) return { error: 'summary is required' };
      // Require that at least some plan exists and every step is done before declaring victory.
      // Exception — the failure exit: when every remaining step is BLOCKED, the
      // mission is legitimately concluded as failed. Without this the operator
      // has no legal way to end a failed run and grinds mark_goal_achieved ↔
      // report_workaround until someone kills it (observed: 17 minutes).
      let missionFailed = false;
      const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyContext.colonyId);
      if (row?.plan) {
        const plan = JSON.parse(row.plan);
        const unfinished = (plan.steps || []).filter(s => s.status !== 'done');
        if (unfinished.length > 0) {
          const allBlocked = unfinished.every(s => s.status === 'blocked');
          if (!allBlocked) {
            return {
              error: `Cannot mark goal achieved: ${unfinished.length} plan step(s) are not yet done. Finish and mark them done — or, if the mission cannot proceed, mark every remaining step blocked (with a note) and call this again to conclude the run as FAILED.`,
              unfinished: unfinished.map(s => ({ id: s.id, description: s.description, status: s.status })),
            };
          }
          missionFailed = true;
        }
      }

      // Protocol gate: a protocol-driven colony cannot complete while a critical
      // handoff awaits human approval, or if the handoff flow was never used.
      // A FAILED conclusion (all remaining steps blocked) skips the flow gates —
      // a dead mission cannot complete its handoff chain by definition.
      const recipeId = colonyContext.recipeId;
      let deliverable = null;
      if (protocol.hasProtocol(recipeId) && !missionFailed) {
        const completion = protocol.flowCompletion(colonyContext.colonyId, recipeId);
        if (!completion.ok) {
          return {
            error: `Cannot mark goal achieved: ${completion.reason}`,
            ...(completion.pending_human ? { pending_human: completion.pending_human } : {}),
          };
        }
        // Premature-victory guard: the dev-team flow must run END TO END before
        // the goal can be declared. Without this, an operator that delegated to
        // one role could self-complete the plan and finish with a "partial flow"
        // deliverable and no real work product.
        if (!completion.terminal_reached && Array.isArray(completion.missing_edges) && completion.missing_edges.length > 0) {
          return {
            error: `Cannot mark goal achieved: the handoff flow is incomplete. Missing handoffs: ` +
              `${completion.missing_edges.map(e => `${e.from}→${e.to} (${e.payload})`).join('; ')}. ` +
              `Delegate to each remaining role in order with ask_agent — every role must complete its work and hand off before the run can finish.`,
            missing_edges: completion.missing_edges,
          };
        }
        deliverable = protocol.buildDeliverable(colonyContext.colonyId, recipeId, trimmed);
      }

      // Non-protocol recipes (research, custom) have no handoff ledger to
      // assemble a deliverable from, so the crew's actual work product — the
      // synthesizer's report, the researcher's findings — would be lost, leaving
      // only the operator's short summary. Build a deliverable from the captured
      // worker outputs so the full report survives and reaches the UI + Discord.
      if (!deliverable && !missionFailed) {
        const reports = Array.isArray(colonyContext.workerReports) ? colonyContext.workerReports : [];
        if (reports.length) {
          const linkRe = /https?:\/\/[^\s")\]]+/g;
          const report = reports[reports.length - 1].response || '';
          const links = [...new Set((reports.map(r => r.response).join('\n').match(linkRe) || []))];
          deliverable = {
            summary: trimmed,
            flow_complete: true,
            handoffs: [],
            artifacts: [],
            links,
            report,
            contributions: reports.map(r => ({ agent: r.agent_name, role: r.role })),
          };
        }
      }

      // Generated media (images/audio) written to the run's artifact dir by the
      // media tools are first-class artifacts — fold them into the deliverable so
      // the overview and Discord relay surface and upload them.
      const generated = Array.isArray(colonyContext.generatedArtifacts) ? colonyContext.generatedArtifacts : [];
      if (generated.length) {
        deliverable = deliverable || { summary: trimmed, flow_complete: false, handoffs: [], artifacts: [], links: [] };
        const names = generated.map(g => g.name).filter(Boolean);
        deliverable.artifacts = [...new Set([...(deliverable.artifacts || []), ...names])];
        deliverable.media = generated.map(g => ({ name: g.name, kind: g.kind, mime: g.mime }));
      }

      const workaroundRows = protocol.readBlackboard(colonyContext.colonyId, { limit: 500 })
        .filter(entry => entry.meta?.workaround_report)
        .map(entry => ({
          issue: entry.meta.issue || entry.content,
          workaround: entry.meta.workaround || '',
          recommendation: entry.meta.recommendation || '',
          impact: entry.meta.impact || '',
        }));
      if (workaroundRows.length > 0) {
        deliverable = deliverable || { summary: trimmed, flow_complete: false, handoffs: [], artifacts: [], links: [] };
        deliverable.workarounds = workaroundRows;
      }

      // Mirror a text report into the run's artifact dir so it downloads in the
      // overview and uploads to Discord alongside any generated media — one
      // source of truth for "what files did this run produce".
      if (deliverable?.report && String(deliverable.report).trim()) {
        try { require('../colonyArtifacts').saveArtifact(colonyContext.colonyId, 'report.md', String(deliverable.report)); }
        catch { /* artifact mirror is best-effort */ }
      }

      const finalSummary = missionFailed ? `⚠ MISSION CONCLUDED AS FAILED (all remaining steps blocked): ${trimmed}` : trimmed;
      db.prepare('UPDATE colonies SET summary=?, deliverable=?, updated_at=unixepoch() WHERE id=?')
        .run(finalSummary, deliverable ? JSON.stringify(deliverable) : null, colonyContext.colonyId);
      return {
        success: true, goal_achieved: true, summary: finalSummary,
        ...(missionFailed ? { mission_failed: true, note: 'Run concluded as FAILED — remaining steps were blocked. The summary must describe what was attempted, what blocked it, and what the user should change.' } : {}),
        ...(deliverable ? { deliverable } : {}),
      };
    },
  },

};
