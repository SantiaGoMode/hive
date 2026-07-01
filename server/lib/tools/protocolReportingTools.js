// Colony protocol reporting tools (assistance/progress/violation/workaround/acceptance). (#27)
const protocol = require('../colonyProtocol');
const { agentLabel, resolveRoleKey } = require('./shared');

module.exports = {
  request_assistance: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'request_assistance',
        description: 'ACP: ask the team for help when blocked, without breaking the handoff flow. Posts an assistance request to the Blackboard for the orchestrator or another role to pick up.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Short subject of what you need help with.' },
            detail: { type: 'string', description: 'Specifics of the blocker or question.' },
            to_role: { type: 'string', description: 'Optional role key best suited to help.' },
          },
          required: ['topic'],
        },
      },
    },
    async handler({ topic, detail, to_role }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'request_assistance is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'assistance',
        `ASSISTANCE [${topic}]${to_role ? ` → ${to_role}` : ''}: ${detail || ''}`, { topic, to_role: to_role || null });
      return protocol.acpEnvelope('assistance', { from, to: to_role || null, performative: 'request', content: { topic, detail } });
    },
  },

  report_progress: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_progress',
        description: 'ACP: report progress on your current task to the Blackboard so the orchestrator can track status asynchronously.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Short status, e.g. "in_progress", "blocked", "done".' },
            detail: { type: 'string', description: 'What changed / what you are doing.' },
          },
          required: ['status'],
        },
      },
    },
    async handler({ status, detail }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_progress is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'progress', `[${status}] ${detail || ''}`, { status });
      return protocol.acpEnvelope('progress', { from, performative: 'inform', content: { status, detail } });
    },
  },

  report_protocol_violation: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_protocol_violation',
        description: 'The "Not-Understood" act. If you receive a task or message you do not recognise or cannot handle with your role and tools, call this to gracefully report a protocol violation INSTEAD of hallucinating a response.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why you cannot handle this (unknown task, missing precondition, out of scope for your role).' },
          },
          required: ['reason'],
        },
      },
    },
    async handler({ reason }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_protocol_violation is only available inside a Colony run' };
      const from = resolveRoleKey(colonyContext, callerAgentId) || 'agent';
      const author = agentLabel(colonyContext, callerAgentId);
      protocol.writeBlackboard(colonyContext.colonyId, author, 'message', `PROTOCOL VIOLATION: ${reason}`, { violation: true });
      return protocol.protocolViolation(reason, { from });
    },
  },

  report_workaround: {
    group: 'colony_tools',
    definition: {
      type: 'function',
      function: {
        name: 'report_workaround',
        description: 'Record an issue that forced the colony to work around missing app capability, poor tooling, model weakness, access limits, or unclear workflow. Use this during the run so the final report can tell the user how to improve Hive for future colonies.',
        parameters: {
          type: 'object',
          properties: {
            issue: { type: 'string', description: 'The problem encountered.' },
            workaround: { type: 'string', description: 'What the operator/team did instead.' },
            recommendation: { type: 'string', description: 'Concrete app/product change that would make future agents perform better.' },
            impact: { type: 'string', description: 'How this affected quality, speed, confidence, or completeness.' },
          },
          required: ['issue', 'workaround', 'recommendation'],
        },
      },
    },
    async handler({ issue, workaround, recommendation, impact }, { colonyContext }) {
      if (!colonyContext?.colonyId) return { error: 'report_workaround is only available inside a Colony run' };
      const note = {
        issue: String(issue || '').trim(),
        workaround: String(workaround || '').trim(),
        recommendation: String(recommendation || '').trim(),
        impact: impact ? String(impact).trim() : '',
      };
      if (!note.issue || !note.workaround || !note.recommendation) {
        return { error: 'issue, workaround, and recommendation are required' };
      }
      protocol.writeBlackboard(
        colonyContext.colonyId,
        'Operator',
        'message',
        `WORKAROUND: ${note.issue}\nUsed: ${note.workaround}\nImprove Hive: ${note.recommendation}${note.impact ? `\nImpact: ${note.impact}` : ''}`,
        { workaround_report: true, ...note },
      );
      return { success: true, workaround: note };
    },
  },

  report_acceptance: {
    group: 'protocol',
    definition: {
      type: 'function',
      function: {
        name: 'report_acceptance',
        description: 'Record a per-criterion verdict against the work item\'s acceptance criteria. QA MUST call this after executing its checks, before handing off. Each verdict needs the criterion text, pass/fail/not_verified, and the command output or observation used as evidence.',
        parameters: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              description: 'One entry per acceptance criterion.',
              items: {
                type: 'object',
                properties: {
                  criterion: { type: 'string', description: 'The acceptance criterion text (verbatim or close).' },
                  status: { type: 'string', enum: ['pass', 'fail', 'not_verified'], description: 'Verdict from executed checks.' },
                  evidence: { type: 'string', description: 'Command output or observation proving the verdict.' },
                },
                required: ['criterion', 'status'],
              },
            },
          },
          required: ['results'],
        },
      },
    },
    async handler({ results }, { colonyContext, callerAgentId }) {
      if (!colonyContext?.colonyId) return { error: 'report_acceptance is only available inside a Colony run' };
      if (!Array.isArray(results) || results.length === 0) return { error: 'results must be a non-empty array' };
      const normalized = results.map(r => ({
        criterion: String(r?.criterion || '').trim(),
        status: ['pass', 'fail', 'not_verified'].includes(r?.status) ? r.status : 'not_verified',
        evidence: r?.evidence ? String(r.evidence).slice(0, 600) : '',
      })).filter(r => r.criterion);
      if (normalized.length === 0) return { error: 'every result needs a criterion' };
      const author = agentLabel(colonyContext, callerAgentId, 'qa_engineer');
      protocol.writeBlackboard(
        colonyContext.colonyId,
        author,
        'state',
        `Acceptance criteria verdicts:\n${normalized.map(r => `- [${r.status.toUpperCase()}] ${r.criterion}`).join('\n')}`,
        { acceptance_results: normalized },
      );
      return { success: true, recorded: normalized.length, results: normalized };
    },
  },

};
