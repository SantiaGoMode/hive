// Render assigned skills into a prompt section. Shared by staff profiles
// (colony workers, staff chat) and per-agent skills (chat, pipelines,
// schedules via buildSystemPrompt). Skills defined in the catalog contribute
// their full body (description, instructions, templates); names with no
// catalog entry are listed as plain bullet points.
const db = require('../db');
const { logSwallowed } = require('./logSwallowed');

function renderSkillsBlock(skillNames) {
  if (!Array.isArray(skillNames) || !skillNames.length) return '';
  const rows = db.prepare(
    `SELECT * FROM skills WHERE name IN (${skillNames.map(() => '?').join(',')})`
  ).all(...skillNames);
  const byName = new Map(rows.map(r => [r.name, r]));

  const parts = [];
  for (const name of skillNames) {
    const skill = byName.get(name);
    if (!skill) { parts.push(`- ${name}`); continue; }
    const section = [`### ${skill.name}`];
    if (skill.description) section.push(skill.description.trim());
    if (skill.instructions?.trim()) section.push(skill.instructions.trim());
    let templates = [];
    try { templates = JSON.parse(skill.templates || '[]'); } catch (e) { logSwallowed('skillsBlock:parseTemplates', e, { skill: skill.name }); }
    for (const t of Array.isArray(templates) ? templates : []) {
      if (!t?.content?.trim()) continue;
      const title = t.title ? `**Template: ${t.title}**` : '**Template**';
      section.push(t.type === 'code'
        ? `${title}\n\`\`\`\n${t.content.trim()}\n\`\`\``
        : `${title}\n${t.content.trim()}`);
    }
    parts.push(section.join('\n\n'));
  }
  return parts.join('\n\n');
}

module.exports = { renderSkillsBlock };
