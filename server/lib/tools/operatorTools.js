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
