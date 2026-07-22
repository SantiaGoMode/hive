const PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#f59e0b', '#22c55e', '#06b6d4'];

function defaultMcp(def) {
  if (def.mcp) return def.mcp;
  const cats = [];
  if ((def.caps || []).includes('coding') || def.github) cats.push('code');
  if ((def.caps || []).includes('research') || def.web) cats.push('research');
  return cats;
}

function defaultTools(def, strict) {
  const tools = [];
  if ((def.caps || []).includes('coding') || def.sandbox) tools.push('sandbox');
  else if (def.files || def.artifact) tools.push('sandbox_files');
  if ((def.caps || []).includes('research') || def.web) tools.push('web_search');
  tools.push('memory');
  if (strict) tools.push('protocol', 'protocol_worker');
  if (def.github) tools.push('github');
  if (def.media) tools.push('media'); // local image/TTS generation
  return tools;
}

function buildRolePrompt(teamName, def, tools) {
  const hasFileTool = tools.includes('sandbox') || tools.includes('sandbox_files');
  const lines = [
    `You are the ${def.title} in a Hive ${teamName} crew.`,
    '',
    `Your job is ${def.mission}`,
    '',
    'When delegated work:',
    ...def.duties.map(d => `- ${d}`),
  ];
  if (def.artifact && hasFileTool) {
    lines.push(`- WRITE YOUR DELIVERABLE TO A FILE: save ${def.artifact} with write_file and list the path in your handoff artifacts. A note saying the work is "complete" is NOT a deliverable — if no file exists, the work does not exist.`);
  }
  if (tools.includes('media')) {
    lines.push('- Media generation is a Hive host-side capability: call generate_image/generate_speech directly. Do NOT install Orpheus, SNAC, FLUX, torch, npm packages, or model files in the sandbox; sandbox network failures are not media-generation blockers.');
  }
  lines.push('- Be direct about assumptions, evidence gaps, and anything you could not verify.');
  lines.push(`- End with "${def.handoff || `${def.title} handoff`}" containing ${def.handoffContents || 'your key findings, decisions, artifacts, and open questions'}.`);
  return lines.join('\n');
}

function defineRole(teamName, strict, def, index) {
  const tools = def.tools || defaultTools(def, strict);
  return {
    key: def.key,
    name: def.title,
    agent_name: def.agent,
    role: def.title,
    color: def.color || PALETTE[index % PALETTE.length],
    tools,
    capabilities: def.caps || ['analysis'],
    repo_access: def.repo ?? null,
    network: def.network ?? null,
    mcp: defaultMcp(def),
    artifact_expectations: def.artifact || '',
    prompt: buildRolePrompt(teamName, def, tools),
  };
}

function defineRecipe({ id, name, category, summary, placeholder, strict = false, executionPolicy = null, roles }) {
  return {
    id,
    name,
    category,
    summary,
    placeholder,
    strict,
    execution_policy: executionPolicy || { mode: 'artifact_only', github_review: false, github_publish: false },
    roles: roles.map((def, i) => defineRole(name, strict, def, i)),
  };
}

module.exports = { defineRecipe };
