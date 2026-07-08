// Runtime skill loading (`skills` group). Skills normally bind at prompt-build
// time from the agent's `skills` column; these tools let an agent pull a skill
// from the catalog mid-conversation instead — the rendered body arrives as the
// tool result, so it enters context immediately without editing agent config.
const db = require('../../db');
const { renderSkillsBlock } = require('../skillsBlock');

function catalogSummaries() {
  return db.prepare('SELECT name, description FROM skills ORDER BY name').all();
}

module.exports = {
  list_skills: {
    group: 'skills',
    definition: {
      type: 'function',
      function: {
        name: 'list_skills',
        description: 'List every skill in the Hive skill catalog (name + description). Use this to discover capabilities you can pull in with load_skill.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async handler() {
      return { skills: catalogSummaries() };
    },
  },

  load_skill: {
    group: 'skills',
    definition: {
      type: 'function',
      function: {
        name: 'load_skill',
        description: 'Load a skill from the Hive catalog by name. Returns the full skill body (description, instructions, templates) — apply it for the rest of this conversation.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Exact skill name as returned by list_skills.' },
          },
          required: ['name'],
        },
      },
    },
    async handler({ name }) {
      const wanted = String(name || '').trim();
      const row = wanted
        ? db.prepare('SELECT name FROM skills WHERE name = ? COLLATE NOCASE').get(wanted)
        : null;
      if (!row) {
        // Unknown name → hand back the catalog instead of a dead-end error.
        return {
          error: `No skill named "${wanted}" in the catalog.`,
          available: catalogSummaries(),
        };
      }
      return { skill: row.name, body: renderSkillsBlock([row.name]) };
    },
  },
};
