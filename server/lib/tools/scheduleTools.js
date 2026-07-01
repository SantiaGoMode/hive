// Schedule-management tools (list/create/delete/toggle). Split from agentTools.js (#27).
const db = require('../../db');

module.exports = {
  // ── Schedule management ───────────────────────────────────────────────────────
  list_schedules: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'list_schedules',
        description: 'List all scheduled agent runs. Returns id, label, agent_id, cron_expr, enabled, last_run, and run_count for each.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler() {
      const rows = db.prepare(
        'SELECT id, agent_id, label, cron_expr, enabled, last_run, run_count FROM scheduled_runs ORDER BY created_at DESC',
      ).all();
      return rows;
    },
  },

  create_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'create_schedule',
        description: 'Create a scheduled run that fires an agent on a cron schedule. Uses standard 5-field cron syntax (e.g. "0 9 * * 1" = every Monday at 9am, "*/30 * * * *" = every 30 minutes).',
        parameters: {
          type: 'object',
          properties: {
            agent_id:  { type: 'string', description: 'ID of the agent to run' },
            label:     { type: 'string', description: 'Human-readable name for this schedule' },
            cron_expr: { type: 'string', description: 'Cron expression (5 fields: min hour day month weekday)' },
            prompt:    { type: 'string', description: 'Prompt to send to the agent on each run' },
            enabled:   { type: 'boolean', description: 'Enable immediately (default: true)' },
          },
          required: ['agent_id', 'label', 'cron_expr', 'prompt'],
        },
      },
    },
    async handler({ agent_id, label, cron_expr, prompt, enabled = true }) {
      const cron = require('node-cron');
      if (!cron.validate(cron_expr)) return { error: `Invalid cron expression: "${cron_expr}"` };

      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      db.prepare('INSERT INTO scheduled_runs (id, agent_id, label, cron_expr, prompt, enabled, tools) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, agent_id, label, cron_expr, prompt, enabled ? 1 : 0, '[]');

      // Require scheduler lazily to avoid circular dependency (scheduler imports agentTools)
      const scheduler = require('../scheduler');
      const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(id);
      scheduler.register(row);
      return { success: true, schedule_id: id, label, cron_expr, enabled };
    },
  },

  delete_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'delete_schedule',
        description: 'Delete a scheduled run permanently.',
        parameters: {
          type: 'object',
          properties: { schedule_id: { type: 'string', description: 'ID of the schedule to delete' } },
          required: ['schedule_id'],
        },
      },
    },
    async handler({ schedule_id }) {
      const existing = db.prepare('SELECT id FROM scheduled_runs WHERE id = ?').get(schedule_id);
      if (!existing) return { error: `Schedule "${schedule_id}" not found` };
      const scheduler = require('../scheduler');
      scheduler.unregister(schedule_id);
      db.prepare('DELETE FROM scheduled_runs WHERE id = ?').run(schedule_id);
      return { success: true, deleted_id: schedule_id };
    },
  },

  toggle_schedule: {
    group: 'agent_tools',
    definition: {
      type: 'function',
      function: {
        name: 'toggle_schedule',
        description: 'Enable or disable a scheduled run.',
        parameters: {
          type: 'object',
          properties: {
            schedule_id: { type: 'string', description: 'ID of the schedule' },
            enabled:     { type: 'boolean', description: 'true to enable, false to disable' },
          },
          required: ['schedule_id', 'enabled'],
        },
      },
    },
    async handler({ schedule_id, enabled }) {
      const existing = db.prepare('SELECT id FROM scheduled_runs WHERE id = ?').get(schedule_id);
      if (!existing) return { error: `Schedule "${schedule_id}" not found` };
      db.prepare('UPDATE scheduled_runs SET enabled=? WHERE id=?').run(enabled ? 1 : 0, schedule_id);
      const scheduler = require('../scheduler');
      const row = db.prepare('SELECT * FROM scheduled_runs WHERE id = ?').get(schedule_id);
      scheduler.register(row);
      return { success: true, schedule_id, enabled, label: row.label };
    },
  },

};
