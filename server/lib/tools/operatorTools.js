// Colony Operator tools (`colony_operator` group — internal, injected only by
// the Discord bridge). Each colony forum thread is fronted by an Operator
// agent; these tools are its hands: start/queue/direct missions and report
// team state. The target team rides in colonyContext.discordTeamId, set by the
// bridge when it invokes the turn — the model never picks the team itself.
const db = require('../../db');
const colonyTeams = require('../colonyTeams');
const workItems = require('../colonyWorkItems');

function teamFromContext(ctx) {
  const teamId = ctx?.colonyContext?.discordTeamId;
  if (!teamId) return { error: 'No team bound to this conversation.' };
  const team = colonyTeams.getTeam(teamId);
  if (!team) return { error: 'The bound colony team no longer exists.' };
  return { team };
}

// Lazy require: missions.js pulls in the colony runner; keep tool-module load
// light and cycle-free.
function missions() {
  return require('../discord/missions');
}

module.exports = {
  start_mission: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'start_mission',
        description: 'Start a new mission for this colony team NOW with the given direction. Only for an idle team — fails if a run is already live (use send_direction) . The human\'s instruction is the authorization; do not ask for confirmation first.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: 'The full mission direction/goal, restated clearly from the human\'s instruction.' },
          },
          required: ['direction'],
        },
      },
    },
    async handler({ direction }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      try {
        const model = ctx?.colonyContext?.discordOperatorModel;
        const { runId } = missions().launchTeamMission(team.id, direction, { model });
        return { success: true, run_id: runId, message: 'Mission started. Progress will post to this thread.' };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  queue_work: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'queue_work',
        description: 'Add work to this colony team\'s queue WITHOUT starting it (use when a mission is already running or the human says "later"). Returns the queue position.',
        parameters: {
          type: 'object',
          properties: {
            direction: { type: 'string', description: 'The work direction.' },
            title: { type: 'string', description: 'Optional short title for the queue item.' },
          },
          required: ['direction'],
        },
      },
    },
    async handler({ direction, title }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      try {
        const { item, position } = missions().queueTeamWork(team.id, direction, title || '');
        return { success: true, item_id: item.id, position };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  send_direction: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'send_direction',
        description: 'Inject a high-priority human direction into this team\'s CURRENTLY RUNNING mission (course-correct, add constraints, answer a question the crew raised). Fails if nothing is running.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The direction text for the running crew.' },
          },
          required: ['content'],
        },
      },
    },
    async handler({ content }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      try {
        const active = missions().activeRunForTeam(team.id);
        if (!active) return { error: 'No mission is running — use start_mission or queue_work instead.' };
        const direction = missions().sendDirection(active.id, content);
        return { success: true, run_id: active.id, direction_id: direction.id, message: 'Direction queued; the crew picks it up between rounds.' };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  schedule_mission: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'schedule_mission',
        description: 'Create a RECURRING mission for this colony team on a cron schedule. Each time it fires, the direction runs as a new mission (or is queued if the team is busy). Use when the human asks for something to run repeatedly ("every morning", "each Monday at 9", "nightly"). Translate their phrasing into a 5-field cron expression. The human\'s request is the authorization; do not ask for confirmation.',
        parameters: {
          type: 'object',
          properties: {
            cron: { type: 'string', description: 'Standard 5-field cron expression, e.g. "0 9 * * 1" (Mondays 09:00), "0 8 * * *" (every day 08:00), "*/30 * * * *" (every 30 min).' },
            direction: { type: 'string', description: 'The full mission direction to run on each fire, restated clearly from the human\'s instruction.' },
            label: { type: 'string', description: 'Optional short name for the schedule (defaults to a snippet of the direction).' },
          },
          required: ['cron', 'direction'],
        },
      },
    },
    async handler({ cron, direction, label }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      try {
        const row = require('../colonySchedules').createColonySchedule(team.id, { cronExpr: cron, prompt: direction, label });
        return { success: true, schedule_id: row.id, label: row.label, cron: row.cron_expr, message: `Scheduled "${row.label}" (${row.cron_expr}). It will run automatically; I'll post each run to this thread.` };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  list_schedules: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'list_schedules',
        description: 'List this colony team\'s recurring scheduled missions (id, label, cron, enabled/paused, last run/error). Use before cancelling or pausing so you have the right schedule id.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler(args, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      const rows = require('../colonySchedules').listColonySchedules(team.id);
      return {
        schedules: rows.map(r => ({
          id: r.id, label: r.label, cron: r.cron_expr,
          direction: String(r.prompt || '').slice(0, 200),
          enabled: !!r.enabled,
          last_run: r.last_run || null,
          last_error: r.last_error || null,
        })),
      };
    },
  },

  cancel_schedule: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'cancel_schedule',
        description: 'Permanently delete one of this team\'s recurring scheduled missions by id (get ids from list_schedules). To temporarily stop one instead, use pause_schedule.',
        parameters: {
          type: 'object',
          properties: { schedule_id: { type: 'string', description: 'The schedule id to delete.' } },
          required: ['schedule_id'],
        },
      },
    },
    async handler({ schedule_id: scheduleId }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      const row = require('../colonySchedules').removeColonySchedule(scheduleId, team.id);
      if (!row) return { error: 'No such schedule for this team (check the id with list_schedules).' };
      return { success: true, message: `Deleted schedule "${row.label}".` };
    },
  },

  pause_schedule: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'pause_schedule',
        description: 'Pause (stop firing) or resume one of this team\'s recurring scheduled missions by id. The schedule is kept and can be resumed later.',
        parameters: {
          type: 'object',
          properties: {
            schedule_id: { type: 'string', description: 'The schedule id (from list_schedules).' },
            paused: { type: 'boolean', description: 'true to pause, false to resume.' },
          },
          required: ['schedule_id', 'paused'],
        },
      },
    },
    async handler({ schedule_id: scheduleId, paused }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      const row = require('../colonySchedules').setColonyScheduleEnabled(scheduleId, !paused, team.id);
      if (!row) return { error: 'No such schedule for this team (check the id with list_schedules).' };
      return { success: true, enabled: !!row.enabled, message: row.enabled ? `Resumed "${row.label}".` : `Paused "${row.label}".` };
    },
  },

  get_team_status: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'get_team_status',
        description: 'Current state of this colony team: live status (idle/working/blocked), active run and its plan, queue depth, crew, recent runs, and cross-run insights (blockers, acceptance failures).',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler(args, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      const overview = colonyTeams.teamOverview(team.id);
      const live = colonyTeams.liveStatusForTeam(team.id);
      let plan = null;
      if (live.active_run) {
        const row = db.prepare('SELECT plan FROM colonies WHERE id=?').get(live.active_run.id);
        try { plan = row?.plan ? JSON.parse(row.plan) : null; } catch { plan = null; }
      }
      return {
        team: { id: team.id, name: team.name, description: team.description, recipe: team.recipe_id, repo: team.repo_path },
        status: live.status,
        active_run: live.active_run,
        active_plan: plan?.steps?.map(s => ({ id: s.id, status: s.status, description: s.description })) || null,
        queue: workItems.queueCountsForTeam(team.id),
        recent_runs: (overview?.runs || []).slice(0, 5).map(r => ({ id: r.id, status: r.status, goal: String(r.goal || '').slice(0, 160), summary: r.summary ? String(r.summary).slice(0, 300) : null, created_at: r.created_at })),
        insights: (overview?.insights || []).slice(0, 8),
        crew: (overview?.crew || []).map(c => ({ name: c.display_name, role: c.role })),
        performance: overview?.performance || null,
      };
    },
  },

  get_run_report: {
    group: 'colony_operator',
    definition: {
      type: 'function',
      function: {
        name: 'get_run_report',
        description: 'Detailed report for one of this team\'s runs: status, plan steps with pass/fail, summary, and deliverable. Defaults to the most recent run.',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'Run id (optional — defaults to the latest run).' },
          },
        },
      },
    },
    async handler({ run_id: runId }, ctx) {
      const { team, error } = teamFromContext(ctx);
      if (error) return { error };
      const row = runId
        ? db.prepare('SELECT * FROM colonies WHERE id=? AND team_id=?').get(runId, team.id)
        : db.prepare('SELECT * FROM colonies WHERE team_id=? ORDER BY created_at DESC LIMIT 1').get(team.id);
      if (!row) return { error: runId ? 'No such run for this team.' : 'This team has no runs yet.' };
      const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };
      const plan = parse(row.plan, null);
      const deliverable = parse(row.deliverable, null);
      return {
        run_id: row.id,
        status: row.status,
        goal: row.goal,
        created_at: row.created_at,
        updated_at: row.updated_at,
        steps: (plan?.steps || []).map(s => ({ id: s.id, status: s.status, description: s.description })),
        summary: row.summary || null,
        deliverable: deliverable ? {
          summary: deliverable.summary ? String(deliverable.summary).slice(0, 1200) : null,
          report: deliverable.report ? String(deliverable.report).slice(0, 6000) : null,
          artifacts: (deliverable.artifacts || []).slice(0, 10),
          links: (deliverable.links || []).slice(0, 10),
          acceptance: deliverable.acceptance?.results?.map(r => ({ criterion: r.criterion, status: r.status })) || null,
        } : null,
      };
    },
  },
};
