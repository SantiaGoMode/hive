const { writeAgent, readAgent, stripProviderPrefix } = require('./agentParser');
const { runAgentOnce } = require('./agentTools');
const { publish, maybeCleanup } = require('./colonyBus');
const mcpManager = require('./mcpClient');
const protocol = require('./colonyProtocol');
const colonyModels = require('./colonyModels');
const staffDirectory = require('./staffDirectory');
const { readRepoGuidelines } = require('./codingGuidelines');
const sandbox = require('./sandbox');
const { fetchRepoBoard, detectGitHubRepo, createDraftPR, githubToken, postIssueComment, buildBoardComment } = require('./githubBoard');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getOllamaUrl, normalizeOllamaUrl } = require('./ollamaUrl');
const {
  CUSTOM_AUTO_RECIPE_ID,
  DEFAULT_RECIPE_ID,
  getColonyRecipe,
  isCustomAutoRecipe,
  buildRecipeWorkerConfigs,
  recipeOrchestratorPrompt,
  recipeInitialMessage,
} = require('./colonyRecipes');
const db = require('../db');

// Keep the last N entries in the single `colonies.log` TEXT field. Long runs
// trim oldest entries — by seq number, so clients can still tell if they
// missed anything. Previously there was a LOG_MAX_BYTES hard cap that silently
// dropped writes above 200KB; that was a footgun because the UI would just
// stop updating from the DB mid-run with no error.
const LOG_MAX_ENTRIES = 1000;
// Safety caps — prevent runaway resource use.
// MAX_WORKERS_PER_COLONY: hard cap on agents the orchestrator can spawn.
//   The orchestrator prompt already suggests 2–4, but a buggy model can loop
//   on create_agent without this cap. Does NOT count the orchestrator itself.
const MAX_WORKERS_PER_COLONY = 3;

const BOOTSTRAP_DOC_CANDIDATES = [
  'docs/PRD.md',
  'docs/prd.md',
  'PRD.md',
  'SPEC.md',
  'README.md',
  'readme.md',
];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Git write-back helpers ────────────────────────────────────────────────────
// Thin wrappers around git CLI. All failures throw — callers must catch and
// emit a HITL blocker rather than crashing the colony.

function gitExec(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitDefaultBranch(repoPath) {
  try {
    return gitExec(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath).replace(/^origin\//, '');
  } catch {
    for (const b of ['main', 'master']) {
      try { gitExec(['rev-parse', '--verify', b], repoPath); return b; } catch {}
    }
    return 'main';
  }
}

function gitCheckoutBranch(repoPath, branchName) {
  // ALWAYS branch from a fresh default branch. Previously the new colony
  // branch was created from whatever a prior run left checked out, so each
  // run stacked on top of the previous run's unreviewed (possibly broken)
  // commits and could end up with "publishable" work it never produced.
  // Leftover uncommitted changes are stashed (not destroyed) first.
  try {
    if (gitExec(['status', '--porcelain'], repoPath).length > 0) {
      gitExec(['stash', 'push', '--include-untracked', '-m', `hive: leftovers before ${branchName}`], repoPath);
    }
  } catch {}
  const base = gitDefaultBranch(repoPath);
  try { gitExec(['checkout', base], repoPath); } catch {}
  try { gitExec(['pull', '--ff-only'], repoPath); } catch {}
  try {
    gitExec(['checkout', '-b', branchName], repoPath);
  } catch {
    // Branch may already exist (re-run scenario) — just switch to it.
    gitExec(['checkout', branchName], repoPath);
  }
}

async function gitCommitAndPush(repoPath, branchName, message) {
  gitExec(['add', '-A'], repoPath);
  // Secret hygiene: agents sometimes create .env files with credentials and
  // they must never ride along into a pushed PR. Unstage any env files.
  try {
    const staged = gitExec(['diff', '--cached', '--name-only'], repoPath).split('\n').filter(Boolean);
    const envFiles = staged.filter(f => /(^|\/)\.env(\..+)?$/.test(f) && !/\.env\.example$/.test(f));
    if (envFiles.length) gitExec(['reset', '--', ...envFiles], repoPath);
  } catch {}
  // If nothing changed, skip the commit gracefully. git prints "nothing to
  // commit" to STDOUT, so check stdout too — checking only stderr/message
  // turned a clean tree into a hard "Failed to push" blocker.
  try {
    gitExec(['commit', '-m', message], repoPath);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    if (!/nothing to commit|working tree clean|nothing added to commit/i.test(out)) throw e;
  }
  // Only push when the branch actually has commits the default branch lacks —
  // pushing an empty branch just produces a "no commits between..." PR error.
  if (!gitBranchHasNewCommits(repoPath, gitDefaultBranch(repoPath))) {
    return { pushed: false };
  }
  gitExec(['push', '-u', 'origin', branchName], repoPath);
  return { pushed: true };
}

// True when the working tree has uncommitted changes (staged or not).
function gitHasUncommittedChanges(repoPath) {
  try { return gitExec(['status', '--porcelain'], repoPath).length > 0; } catch { return false; }
}

// True when the branch has commits that main does not (i.e. there is something
// worth opening a PR for).
function gitBranchHasNewCommits(repoPath, base = 'main') {
  for (const ref of [`origin/${base}`, base]) {
    try { return Number(gitExec(['rev-list', '--count', `${ref}..HEAD`], repoPath)) > 0; } catch {}
  }
  return false;
}

function orchestratorPrompt(goal, model) {
  return `You are an AI Colony Orchestrator. You lead a team of specialized workers to complete a mission.

MISSION: ${goal}

## Your tools
- set_plan: define the step-by-step plan (call FIRST, only once)
- add_plan_step: append a new step mid-run if extra work is discovered
- update_plan_step: mark a step in_progress, done, or blocked
- mark_goal_achieved: call once every step is done to end the run
- report_workaround: record app/tool/model/access issues that forced a workaround so the final report can tell the user how Hive should improve
- create_agent: spawn a worker with a specific role
- ask_agent: delegate a task to a worker — always use the agent_id from create_agent
- blackboard_read / blackboard_write: read and append to the colony's shared context layer

## Shared context
This colony has a shared Blackboard — an append-only log all agents read and write.
Use blackboard_write to record decisions and state, and tell each worker to call
blackboard_read before starting and blackboard_write when done. This is the colony's
coordination surface; do NOT use the global notepad tools for cross-agent state.
Give workers the "protocol" tool group (alongside web_search/sandbox as needed) so they
can see and contribute to the Blackboard.

## Workflow
1. Call set_plan with 3–5 concrete steps. This is your FIRST tool call — no text before it.
2. Create 2–3 SPECIALIZED workers upfront, one per role. Each worker should be distinct:
   - A Researcher or Analyst: searches the web, finds real information (tools: ["web_search"])
   - An Implementer or Builder: writes files, runs code (tools: ["sandbox"])
   - A Reviewer or Writer: assembles findings into polished documents (tools: ["sandbox"])
3. For each step IN ORDER:
   a. update_plan_step → in_progress
   b. ask_agent with the worker BEST SUITED for that step's role:
      - Research/information gathering → Researcher (web_search)
      - Writing files, running code → Implementer or Builder (sandbox)
      - Reviewing, assembling final output → Reviewer or Writer (sandbox)
   c. Verify the response has real content (not "(no response)") — retry if empty
   d. update_plan_step → done ONLY after the worker returns actual output
4. Call mark_goal_achieved with a 2–4 sentence summary once all steps are done.
5. If any workaround was needed (missing access, weak tool support, unclear workflow, manual fallback, model limitation), call report_workaround before mark_goal_achieved.

## Hard rules
- set_plan is ALWAYS first. No exceptions.
- Create AT LEAST 2 workers — a colony with one worker is not a colony.
- Each worker must have a DIFFERENT role and name. Do not create two "Researcher" agents.
- Do NOT give workers colony management tools (set_plan, update_plan_step, mark_goal_achieved) — those are yours only.
- Researchers MUST have tools: ["web_search"] so they can find real information, not just generate from memory.
- Only give tools: ["sandbox"] to workers that need to write files or run code.
- Do NOT leave a researcher's tools empty — without web_search they can only hallucinate facts.
- NEVER mark a step done if the worker returned "(no response)". Retry with simpler instructions.
- Use the agent_id (hex string from create_agent), not the name, in every ask_agent call.
- Max 3 workers. Reuse them across steps — a researcher can be asked multiple questions.
- USE EACH WORKER for its intended role. Do not delegate all steps to one worker.
- EVERY step must pass through: in_progress → ask_agent → done. Skipping any stage is an error.
- Steps must be completed in order. You cannot mark step N done while step N-1 is in_progress.
- Final summary must mention workaround report notes so the user can improve Hive for future colonies.

## Worker model: ${model}
## Sandbox (for workers with tools: ["sandbox"])
Python 3.11 (flask, numpy, pandas, requests, pytest), Node.js 20, git, curl, sqlite3.
Write files with write_file. Run code with run_python or run_bash. Ports 3000/5000/8000/8080 forwarded.
Do NOT install Jenkins, Docker, databases — unavailable.`;
}

// ── Pre-flight ───────────────────────────────────────────────────────────────
// Fail fast with a clear message if the selected model is missing or doesn't
// support tool calling. Previously the colony would silently produce garbage
// when the user picked a non-tool-capable model.
async function preflightColony(model, ollamaUrl) {
  const providers = require('./providers');
  const { provider } = providers.parseModel(model);
  const normalizedOllamaUrl = normalizeOllamaUrl(ollamaUrl);

  // Cloud providers: no Ollama checks. Just confirm a key is configured — the
  // chosen models are tool-capable, so the Ollama capability gate doesn't apply.
  if (provider !== 'ollama') {
    if (!providers.hasKey(provider)) {
      return { ok: false, error: `${provider} API key not set. Add it in Settings → Model Providers, then try again.` };
    }
    return { ok: true };
  }

  const stripped = stripProviderPrefix(model);

  // 1. Ollama reachable?
  let tagsRes;
  try {
    tagsRes = await fetch(`${normalizedOllamaUrl}/api/tags`);
  } catch (e) {
    const code = e.cause?.code;
    if (code === 'ECONNREFUSED') {
      return { ok: false, error: `Cannot reach Ollama at ${normalizedOllamaUrl}. Start Ollama with "ollama serve" and try again.` };
    }
    return { ok: false, error: `Cannot reach Ollama at ${normalizedOllamaUrl}: ${e.message}` };
  }
  if (!tagsRes.ok) return { ok: false, error: `Ollama returned HTTP ${tagsRes.status} from /api/tags` };
  const tags = await tagsRes.json();

  // 2. Model installed?
  const models = Array.isArray(tags.models) ? tags.models : [];
  const found = models.some(m => m.name === stripped || m.name === `${stripped}:latest` || m.name.startsWith(`${stripped}:`));
  if (!found) {
    const available = models.map(m => m.name).slice(0, 8).join(', ') || '(none)';
    return {
      ok: false,
      error: `Model "${stripped}" is not installed on Ollama. Pull it with "ollama pull ${stripped}". Currently installed: ${available}`,
    };
  }

  // 3. Tool-calling capability. Many popular models (vanilla llama3, gemma) don't
  // support tools and the orchestrator needs tool calls to function at all. Older
  // Ollama versions may not return a capabilities array — in that case we skip
  // the check rather than false-reject.
  try {
    const showRes = await fetch(`${normalizedOllamaUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: stripped }),
    });
    if (showRes.ok) {
      const info = await showRes.json();
      const caps = Array.isArray(info.capabilities) ? info.capabilities : null;
      if (caps && caps.length > 0 && !caps.includes('tools')) {
        return {
          ok: false,
          error: `Model "${stripped}" does not support tool calling (capabilities: ${caps.join(', ')}). Colony requires a tool-capable model — try llama3.1, qwen2.5, qwen3, mistral-nemo, or mistral-small.`,
        };
      }
    }
  } catch {
    // Non-fatal — skip capability check if /api/show misbehaves.
  }

  return { ok: true };
}

function makeFakeWs(onEvent) {
  return {
    OPEN: 1,
    readyState: 1,
    send(raw) {
      try { onEvent(JSON.parse(raw)); } catch {}
    },
  };
}

function addAgentToColony(colonyId, agentId) {
  const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyId);
  if (!row) return;
  const ids = JSON.parse(row.agent_ids || '[]');
  if (!ids.includes(agentId)) {
    ids.push(agentId);
    db.prepare('UPDATE colonies SET agent_ids=?, updated_at=unixepoch() WHERE id=?')
      .run(JSON.stringify(ids), colonyId);
  }
}

function persistLog(colonyId, entries) {
  const json = JSON.stringify(entries);
  db.prepare('UPDATE colonies SET log=?, updated_at=unixepoch() WHERE id=?').run(json, colonyId);
}

// Classify a connected MCP server by capability so we can attach it to the
// roles that actually need it — research (web/search/fetch) vs code (git/
// github/filesystem). A server can match more than one category.
const MCP_CATEGORY_PATTERNS = {
  research: /(search|fetch|crawl|browser|brave|tavily|perplexity|firecrawl|web)/i,
  code: /(github|gitlab|\bgit\b|repo|pull[\s_-]?request|commit|issue|filesystem|\bfs\b|\bfile\b|code)/i,
};

function categorizeMcpServer(server) {
  const hay = `${server.name} ${(server.tool_names || []).join(' ')}`;
  return Object.entries(MCP_CATEGORY_PATTERNS)
    .filter(([, re]) => re.test(hay))
    .map(([cat]) => cat);
}

function connectedMcpServers() {
  return mcpManager.getStatus()
    .filter(server => server.enabled && server.connected && server.tool_count > 0)
    .map(server => ({ id: server.id, name: server.name, group: `mcp:${server.id}`, categories: categorizeMcpServer(server) }));
}

function readBootstrapSource(repoPath) {
  if (!repoPath) return null;
  for (const rel of BOOTSTRAP_DOC_CANDIDATES) {
    const p = path.join(repoPath, rel);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return { path: rel, content: fs.readFileSync(p, 'utf8').slice(0, 20000) };
      }
    } catch {}
  }
  try {
    const docsDir = path.join(repoPath, 'docs');
    if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
      const md = fs.readdirSync(docsDir).find(name => /\.md$/i.test(name));
      if (md) {
        const rel = path.join('docs', md);
        return { path: rel, content: fs.readFileSync(path.join(repoPath, rel), 'utf8').slice(0, 20000) };
      }
    }
  } catch {}
  return null;
}

function parseBootstrapTasks(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)```/i) || raw.match(/(\[[\s\S]+\])/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed)) return parsed.map(normalizeBootstrapTask).filter(Boolean);
      if (Array.isArray(parsed.tasks)) return parsed.tasks.map(normalizeBootstrapTask).filter(Boolean);
    } catch {}
  }
  return raw.split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+|\d+[.)]\s+/.test(line))
    .slice(0, 12)
    .map((line, i) => normalizeBootstrapTask({
      id: `T${i + 1}`,
      title: line.replace(/^[-*]\s+|\d+[.)]\s+/, '').slice(0, 120),
      description: line.replace(/^[-*]\s+|\d+[.)]\s+/, ''),
      acceptance_criteria: [],
      suggested_order: i + 1,
    }))
    .filter(Boolean);
}

function normalizeBootstrapTask(task, idx = 0) {
  if (!task || typeof task !== 'object') return null;
  const title = String(task.title || task.name || '').trim();
  if (!title) return null;
  const criteria = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria.map(v => String(v).trim()).filter(Boolean)
    : (task.acceptance_criteria ? [String(task.acceptance_criteria)] : []);
  return {
    id: String(task.id || `T${idx + 1}`),
    title,
    description: String(task.description || task.details || '').trim(),
    acceptance_criteria: criteria,
    suggested_order: Number(task.suggested_order || task.order || idx + 1),
  };
}

function drainPendingDirections(colonyId) {
  const rows = db.prepare(`
    SELECT * FROM colony_directions
    WHERE colony_id=? AND status='queued'
    ORDER BY id ASC
  `).all(colonyId);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE colony_directions SET status='delivered', delivered_at=unixepoch() WHERE id IN (${placeholders})`).run(...ids);
  return rows;
}

// Which MCP capability categories each role should receive. Keyed by the recipe
// role_key, with a name/role heuristic fallback for roles without an explicit key.
const ROLE_MCP_CATEGORIES = {
  business_analyst: ['research'],
  // The PM owns board upkeep — comments on the work item, status updates,
  // release notes — which needs the GitHub/code MCP tools.
  project_manager: ['code'],
  ui_ux_designer: ['research'],
  software_developer: ['code'],
  qa_engineer: ['code'],
  devops_engineer: ['code'],
  researcher: ['research'],
  source_critic: [],
  synthesizer: [],
};

function mcpCategoriesForWorker(workerConfig) {
  const key = workerConfig.role_key;
  if (key && ROLE_MCP_CATEGORIES[key]) return ROLE_MCP_CATEGORIES[key];
  const hay = `${workerConfig.persona_role || ''} ${workerConfig.name || ''}`.toLowerCase();
  if (/research|analyst/.test(hay)) return ['research'];
  if (/develop|devops|implement|\bbuild\b|engineer/.test(hay)) return ['code'];
  return [];
}

// Registry of in-flight runs, keyed by colonyId. Owned here (not in the route)
// so every launch path — POST /api/colony, bootstrap accept, webhook triggers —
// is stoppable via stopColonyRun() for the run's entire lifetime.
const runningColonies = new Map();

// Abort a running colony regardless of how it was launched.
// Returns true if a live run was found and aborted.
function stopColonyRun(colonyId) {
  const ac = runningColonies.get(colonyId);
  if (!ac) return false;
  try { ac.abort(); } catch {}
  return true;
}

function isColonyRunning(colonyId) {
  return runningColonies.has(colonyId);
}

async function runColony(colonyId, onEventArg, signal) {
  // Internal AbortController for this run. An external signal (from the HTTP
  // route's timeout/disconnect handling) is chained into it; stopColonyRun()
  // aborts it directly. All internal checks use this controller's signal.
  const externalSignal = signal;
  const ac = new AbortController();
  const onExternalAbort = () => { try { ac.abort(); } catch {} };
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  signal = ac.signal;
  runningColonies.set(colonyId, ac);

  const logEntries = [];
  let logDirty = false;
  let seqCounter = 0;

  // Every event goes to: (a) the per-colony event bus for resumable SSE,
  // (b) the legacy onEvent callback if supplied (used by tests and the old
  // direct-streaming path). Either can be absent.
  const onEvent = (event) => {
    try { publish(colonyId, event); } catch {}
    if (onEventArg) {
      try { onEventArg(event); } catch {}
    }
  };

  // Persist log to DB immediately on every entry — avoids data loss on refresh/crash.
  const flush = () => {
    if (!logDirty) return;
    try {
      persistLog(colonyId, logEntries.slice(-LOG_MAX_ENTRIES));
    } catch {}
    logDirty = false;
  };

  const addEntry = (entry) => {
    const e = { ...entry, ts: Date.now(), seq: ++seqCounter };
    logEntries.push(e);
    logDirty = true;
    onEvent({ type: 'log_entry', entry: e });
    flush();
  };

  // Captured goal-achievement signal from the mark_goal_achieved tool.
  let goalSummary = null;

  // Hoisted so the writeback helper can run from BOTH the happy path and the
  // abort/stop path — partial work must still be pushed and PR'd.
  let row = null;
  let githubWriteback = false;
  const colonyBranch = `colony-${colonyId}`;

  // ── Git write-back: commit, push, and open Draft PR ────────────────────────
  // This is ALWAYS the last act of the run when the agents produced real work:
  // commit whatever is in the working tree, push the colony branch, and open a
  // Draft PR for the user to review and merge to main manually on GitHub.
  // It runs for done AND stopped runs — partial work should never be stranded
  // uncommitted on a local branch.
  const performWriteback = async (status) => {
    if (!githubWriteback || !row?.repo_path) return;
    const hasPublishableWork = gitHasUncommittedChanges(row.repo_path)
      || gitBranchHasNewCommits(row.repo_path);
    if (!hasPublishableWork) {
      if (status === 'done') {
        addEntry({ kind: 'writeback', message: '⚠️ No file changes were produced on the colony branch — nothing to push or open a PR for. The agents completed the flow without committing real work.' });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
      }
      return;
    }
    const repoInfo = detectGitHubRepo(row.repo_path);
    if (!repoInfo) return;
    addEntry({ kind: 'writeback', message: `🔀 Committing and pushing colony work to branch "${colonyBranch}"…` });
    onEvent({ type: 'writeback', phase: 'push_start', branch: colonyBranch });
    try {
      const commitMsg = `feat(colony): ${(goalSummary || row.goal || 'Colony completed').slice(0, 72)}\n\nColony ID: ${colonyId}`;
      const pushRes = await gitCommitAndPush(row.repo_path, colonyBranch, commitMsg);
      if (!pushRes.pushed) {
        addEntry({ kind: 'writeback', message: '⚠️ Nothing to publish: after excluding secret files, the branch has no commits beyond the default branch. No push or PR.' });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
        return;
      }

      let diffStat = '';
      try { diffStat = gitExec(['diff', '--stat', 'origin/main...HEAD'], row.repo_path).slice(0, 2000); } catch {
        try { diffStat = gitExec(['diff', '--stat', 'main...HEAD'], row.repo_path).slice(0, 2000); } catch {}
      }

      const prBody = [
        `## 🐝 Hive Colony — Automated Delivery`,
        '',
        `**Goal:** ${row.goal}`,
        '',
        goalSummary ? `**Summary:** ${goalSummary}` : '',
        status !== 'done' ? `**Note:** the run ended early (status: ${status}) — this PR contains the partial work committed so far.` : '',
        diffStat ? `\n**Changes:**\n\`\`\`\n${diffStat}\n\`\`\`` : '',
        '',
        `> This pull request was opened automatically by Hive Colony \`${colonyId}\`.`,
        `> Verify the changes against the work item's acceptance criteria, then merge to \`main\` when satisfied.`,
      ].filter(l => l !== null).join('\n');

      const pr = await createDraftPR({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title: `[Colony] ${(row.goal || 'Automated delivery').slice(0, 72)}`,
        body: prBody,
        head: colonyBranch,
        base: 'main',
      });

      addEntry({ kind: 'writeback', message: `✅ Draft PR opened: ${pr.html_url}`, pr_url: pr.html_url });
      db.prepare("UPDATE colonies SET summary=COALESCE(summary,'') || ? WHERE id=?")
        .run(`\n\n**Draft PR:** ${pr.html_url}`, colonyId);
      onEvent({ type: 'writeback', phase: 'pr_opened', pr_url: pr.html_url, branch: colonyBranch });
    } catch (gitErr) {
      const msg = [
        `Failed to push branch "${colonyBranch}" or open a Draft PR: ${gitErr.message}`,
        '',
        '**What to do:**',
        `1. Open a terminal and navigate to: \`${row.repo_path}\``,
        `2. Run: \`git push -u origin ${colonyBranch}\``,
        `3. Open a Pull Request from \`${colonyBranch}\` → \`main\` on GitHub.`,
        '',
        'Once you have resolved the issue, click **"Retry Push"** in the colony panel.',
      ].join('\n');
      addEntry({ kind: 'writeback', message: `⚠️ ${msg}` });
      protocol.writeBlackboard(colonyId, 'system', 'blocker', msg, { action_required: 'retry_push', branch: colonyBranch, repo_path: row.repo_path });
      onEvent({ type: 'blocker', blocker: { message: msg, action: 'retry_push', branch: colonyBranch } });
    }
  };

  const cleanupSandboxContainers = () => {
    let ids = [];
    try {
      const latest = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(colonyId);
      ids = JSON.parse(latest?.agent_ids || '[]');
    } catch {}
    if (!ids.length) return;
    let removed = 0;
    for (const id of ids) {
      try { if (sandbox.cleanupContainer(id)) removed++; } catch {}
    }
    if (removed > 0) {
      addEntry({ kind: 'sandbox_cleanup', message: `Cleaned up ${removed} sandbox container${removed === 1 ? '' : 's'}.`, removed });
    }
  };

  try {
    row = db.prepare('SELECT * FROM colonies WHERE id=?').get(colonyId);
    if (!row) throw new Error(`Colony ${colonyId} not found`);

    const ollamaUrl = getOllamaUrl();

    // Per-role model plan + cloud setting. The operator (or user) may assign a
    // different model per role; fall back to the colony's single model.
    let modelPlan = null;
    if (row.model_plan) { try { modelPlan = JSON.parse(row.model_plan); } catch {} }
    const cloudEnabled = !!row.cloud_enabled;
    const operatorModel = (modelPlan && modelPlan.operator) || row.model;

    // ── Pre-flight: gate cloud models, then check every distinct model used ──
    const planGate = colonyModels.gatePlan({ operator: operatorModel, ...(modelPlan || {}) }, cloudEnabled);
    if (!planGate.ok) throw new Error(planGate.error);

    const modelsToCheck = [...new Set([
      operatorModel,
      ...(modelPlan ? Object.values(modelPlan) : []),
    ].filter(Boolean))];
    for (const m of modelsToCheck) {
      addEntry({ kind: 'preflight', message: `Checking model "${stripProviderPrefix(m)}"…` });
      const pf = await preflightColony(m, ollamaUrl);
      if (!pf.ok) throw new Error(pf.error);
    }
    addEntry({ kind: 'preflight', message: `Models ready (${modelsToCheck.length}) — tool calling supported.` });

    // ── Git write-back: checkout colony branch pre-flight ────────────────────
    githubWriteback = !!row.github_writeback;
    if (githubWriteback && row.repo_path) {
      try {
        gitCheckoutBranch(row.repo_path, colonyBranch);
        addEntry({ kind: 'preflight', message: `🌿 Checked out branch "${colonyBranch}" — agents will commit work here.` });
      } catch (gitErr) {
        // Non-fatal: emit HITL blocker, store it on the blackboard, but continue
        // running so agents can still do work. They just won't have a dedicated branch.
        const msg = `Failed to checkout git branch "${colonyBranch}": ${gitErr.message}\n\nTo fix: open a terminal, navigate to ${row.repo_path}, run "git checkout -b ${colonyBranch}", then click "Retry" in the colony panel.`;
        addEntry({ kind: 'preflight', message: `⚠️ ${msg}` });
        protocol.writeBlackboard(colonyId, 'system', 'blocker', msg, { action_required: 'fix_git_branch', branch: colonyBranch, repo_path: row.repo_path });
        onEvent({ type: 'blocker', blocker: { message: msg, action: 'fix_git_branch', branch: colonyBranch } });
      }
    }

    // Soft warning for models known to describe tool calls in text instead of
    // invoking them properly. The text parser in agentTools.js will compensate,
    // but results may be less reliable than with a tool-native model.
    const weakToolModels = /^llama3(\.|:)|^llama-3(\.|:)|^mistral(?!-nemo|-small)/i;
    if (weakToolModels.test(stripProviderPrefix(row.model))) {
      addEntry({
        kind: 'preflight',
        message: `⚠ ${stripProviderPrefix(row.model)} has limited multi-step tool-calling reliability. Colony will attempt a text-based tool call fallback, but for best results use qwen2.5, qwen3, or mistral-nemo.`,
      });
    }

    // Shared colony memory — durable knowledge from previous runs, maintained
    // by the operator and editable on the colony page. Injected into the
    // operator and every worker so lessons actually carry across runs.
    let teamRow = null;
    if (row.team_id) {
      try { teamRow = db.prepare('SELECT id, name, description, memory FROM colony_teams WHERE id=?').get(row.team_id); } catch {}
    }
    const colonyMemory = String(teamRow?.memory || '').trim();
    const memorySection = colonyMemory
      ? `\n\n[Colony Memory — shared knowledge from previous runs. Honor it; it encodes hard-won lessons.]\n${colonyMemory.slice(0, 6000)}`
      : '';
    if (colonyMemory) {
      addEntry({ kind: 'preflight', message: `🧠 Colony memory loaded (${colonyMemory.length} chars) — injected into operator and workers.` });
    }

    const recipe = getColonyRecipe(row.recipe_id || DEFAULT_RECIPE_ID);
    // Reasoning is decided by the operator at run start: the operator always
    // reasons; each agent's reasoning is assigned per role based on the
    // mission. (The old user-facing reasoning_mode toggle is gone.)
    const reasoningDecision = colonyModels.decideRoleReasoning({ recipe, goal: row.goal });
    const workerReasoningDefault = reasoningDecision.default;
    const reasoningByAgentId = new Map();
    if (!isCustomAutoRecipe(recipe.id)) {
      addEntry({ kind: 'recipe', recipe_id: recipe.id, name: recipe.name });
    }
    const roleReasoningSummary = Object.entries(reasoningDecision.by_role)
      .map(([k, on]) => `${k}=${on ? 'on' : 'off'}`).join(', ');
    addEntry({
      kind: 'preflight',
      message: `Reasoning (operator decision): operator on; ${roleReasoningSummary || `workers ${workerReasoningDefault ? 'on' : 'off'}`} — ${reasoningDecision.rationale}.`,
    });

    // Recipe-driven colonies create a known roster before the operator starts.
    // The orchestrator then delegates to these exact IDs instead of inventing
    // worker roles and prompts at runtime.
    const recipeWorkers = [];
    if (!isCustomAutoRecipe(recipe.id)) {
      const mcpServers = connectedMcpServers();
      const researchServers = mcpServers.filter(s => s.categories.includes('research'));
      const codeServers = mcpServers.filter(s => s.categories.includes('code'));
      if (researchServers.length || codeServers.length) {
        addEntry({
          kind: 'recipe',
          recipe_id: recipe.id,
          message: `Connected MCP tools available — research: ${researchServers.map(s => s.name).join(', ') || 'none'}; code/repo: ${codeServers.map(s => s.name).join(', ') || 'none'}. Attaching to roles by need.`,
        });
      } else {
        addEntry({
          kind: 'recipe',
          recipe_id: recipe.id,
          message: 'No connected MCP tools available for this recipe; workers will use built-in tools and caveated fallback.',
        });
      }
      let workerConfigs = buildRecipeWorkerConfigs(recipe, row.goal, row.model, modelPlan);
      // Operator staffing: pick the best staff member for each preset role
      // based on the colony's requirements (team name/description + mission).
      const staffingRequirements = [teamRow?.name, teamRow?.description, row.goal].filter(Boolean).join(' ');
      const staffSelections = [];
      workerConfigs = staffDirectory.applyStaffProfilesToWorkerConfigs(recipe.id, workerConfigs, modelPlan, {
        requirements: staffingRequirements,
        onSelect: s => staffSelections.push(s),
      });
      if (staffSelections.length) {
        addEntry({
          kind: 'recipe',
          recipe_id: recipe.id,
          message: `Operator staffing: ${staffSelections.map(s => `${s.role_key} → ${s.display_name}${s.candidates > 1 ? ` (picked from ${s.candidates}: ${s.reason})` : ''}`).join('; ')}`,
        });
      }
      const planned = workerConfigs.filter(w => w.model && w.model !== row.model);
      if (planned.length) {
        addEntry({ kind: 'recipe', recipe_id: recipe.id, message: `Per-role models: ${workerConfigs.map(w => `${w.role_key}=${stripProviderPrefix(w.model)}`).join(', ')}` });
      }
      // Honor the target repo's own coding guidelines (AGENTS.md/CONTRIBUTING.md)
      // for coding roles — prepended as authoritative over the built-in defaults.
      const repoGuidelines = row.repo_path ? readRepoGuidelines(row.repo_path) : '';
      if (repoGuidelines) {
        for (const wc of workerConfigs) {
          if (colonyModels.CODING_ROLES.has(wc.role_key)) wc.system_prompt += repoGuidelines;
        }
        addEntry({ kind: 'recipe', recipe_id: recipe.id, message: 'Loaded repository coding guidelines for coding roles.' });
      }
      // Sandbox capability preflight — tell the user up front whether real coding
      // is possible when this crew has coding roles and a repo to work in. If not,
      // remove the sandbox tool before workers are written so they do not loop on
      // an unavailable runtime.
      const hasCodingRole = recipe.roles.some(r => colonyModels.CODING_ROLES.has(r.key));
      if (hasCodingRole && row.repo_path) {
        try {
          const cap = sandbox.capabilities();
          addEntry({ kind: cap.ready ? 'recipe' : 'preflight', recipe_id: recipe.id, message: `Sandbox: ${cap.message}` });
          if (!cap.ready) {
            for (const wc of workerConfigs) {
              if (colonyModels.CODING_ROLES.has(wc.role_key)) {
                wc.tools = (wc.tools || []).filter(tool => tool !== 'sandbox');
                wc.system_prompt += `\n\n[Sandbox unavailable]\n${cap.message}\nDo not attempt code edits or test execution in this run. Report the capability blocker clearly and hand off only planning or review work that can be done without executing code.`;
              }
            }
          }
        } catch {}
      }
      for (const workerConfig of workerConfigs) {
        if (memorySection) workerConfig.system_prompt += memorySection;
        const wantCats = mcpCategoriesForWorker(workerConfig);
        const matched = mcpServers.filter(s => s.categories.some(c => wantCats.includes(c)));
        if (matched.length > 0) {
          const usesResearch = wantCats.includes('research') && matched.some(s => s.categories.includes('research'));
          // When live research MCP is attached, drop the built-in web_search so the
          // worker uses one consistent surface. Code MCP is additive to sandbox.
          const baseTools = (workerConfig.tools || []).filter(tool => !(usesResearch && tool === 'web_search'));
          workerConfig.tools = [...new Set([...baseTools, ...matched.map(s => s.group)])];
          if (usesResearch) {
            workerConfig.system_prompt += `\n\n[MCP Tools]\nUse the connected MCP tools for live web or document access. When both search and fetch tools are available, use search for topic discovery and fetch for known URLs. The built-in Ollama web_search endpoint is not enabled for this worker when MCP tools are available, so do not refer to it or try to call it. Tool errors, rate limits, and throttling are not evidence that no sources exist; report them as live-access failures and list the verification gap.`;
          } else {
            workerConfig.system_prompt += `\n\n[MCP Tools]\nYou have connected MCP tools for repository/code access (${matched.map(s => s.name).join(', ')}). Prefer them for reading code, issues, PRs, and files over guessing. Report tool errors as access failures rather than assuming nothing exists.`;
          }
        }
        const worker = writeAgent(null, workerConfig);
        addAgentToColony(colonyId, worker.id);
        // Link the staff profile to its freshly seeded worker agent.
        if (workerConfig.role_key) {
          try { staffDirectory.linkAssignedAgent(recipe.id, workerConfig.role_key, worker.id, workerConfig._staff_profile_id); } catch {}
        }
        // Coding roles get the colony's repo mounted as their sandbox workspace
        // so they edit the real project. The PM gets it too — it maintains
        // CHANGELOG/release notes and persists artifacts under docs/.
        if (row.repo_path && (colonyModels.CODING_ROLES.has(workerConfig.role_key) || workerConfig.role_key === 'project_manager')) {
          try { sandbox.setAgentRepo(worker.id, row.repo_path); } catch {}
        }
        const roleReasoning = workerConfig.role_key && Object.prototype.hasOwnProperty.call(reasoningDecision.by_role, workerConfig.role_key)
          ? reasoningDecision.by_role[workerConfig.role_key]
          : workerReasoningDefault;
        recipeWorkers.push({
          id: worker.id,
          name: worker.name,
          persona_role: worker.persona_role,
          avatar_color: worker.avatar_color,
          model: worker.model,
          tools: worker.tools,
          role_key: workerConfig.role_key || null,
          reasoning: roleReasoning,
        });
        reasoningByAgentId.set(worker.id, roleReasoning);
      }

    }

    // Empty-board bootstrap: if a connected repo has no GitHub issue/project
    // cards, ask the PM to draft a reviewable task list from source docs and
    // stop before implementation. A human must accept the tasks before they
    // become the colony plan.
    if (row.repo_path && recipe.id === 'development_team' && !row.bootstrap_accepted && !row.bootstrap_tasks) {
      let board = null;
      try { board = await fetchRepoBoard({ cwd: row.repo_path }); } catch {}
      if (board && !board.auth_required && Array.isArray(board.cards) && board.cards.length === 0) {
        const source = readBootstrapSource(row.repo_path);
        if (!source?.content) {
          const msg = 'No board items were found, but no README/PRD/SPEC source material was available for bootstrap task drafting.';
          protocol.writeBlackboard(colonyId, 'operator', 'blocker', msg, { bootstrap: true });
          db.prepare("UPDATE colonies SET status='awaiting_tasks', updated_at=unixepoch() WHERE id=?").run(colonyId);
          addEntry({ kind: 'bootstrap', status: 'blocked', message: msg });
          flush();
          onEvent({ type: 'done', status: 'awaiting_tasks' });
          return;
        }

        const pmWorker = recipeWorkers.find(w => w.role_key === 'project_manager');
        const pmAgent = pmWorker ? readAgent(pmWorker.id) : null;
        if (pmAgent) {
          const bootstrapRoleByAgentId = new Map(recipeWorkers.filter(w => w.role_key).map(w => [w.id, w.role_key]));
          addEntry({ kind: 'bootstrap', status: 'drafting', source: source.path, message: `No board items found. Asking Project Manager to draft tasks from ${source.path}.` });
          const bootstrapPrompt = [
            'The connected repo has no issue/project board items. Do NOT start implementation.',
            `Source file: ${source.path}`,
            'Draft a concrete, ordered task list from the source material.',
            'Return JSON only in this shape: [{"id":"T1","title":"...","description":"...","acceptance_criteria":["..."],"suggested_order":1}]',
            '',
            'Source material:',
            source.content,
          ].join('\n');
          const response = await runAgentOnce(pmAgent, [{ role: 'user', content: bootstrapPrompt }], ollamaUrl, 0, null, null, null, 8, signal, {
            colonyId,
            recipeId: recipe.id,
            roleByAgentId: bootstrapRoleByAgentId,
            agentHistories: new Map(),
            reasoningByAgentId,
            workerReasoningDefault,
          });
          const tasks = parseBootstrapTasks(response);
          if (tasks.length > 0) {
            db.prepare("UPDATE colonies SET status='awaiting_tasks', bootstrap_tasks=?, updated_at=unixepoch() WHERE id=?")
              .run(JSON.stringify(tasks), colonyId);
            protocol.writeBlackboard(colonyId, 'Project Manager', 'state',
              `Bootstrap task draft from ${source.path}:\n${tasks.map(t => `- ${t.id}. ${t.title}`).join('\n')}`,
              { bootstrap: true, source: source.path, tasks });
            addEntry({ kind: 'bootstrap', status: 'awaiting_acceptance', source: source.path, task_count: tasks.length, tasks });
            flush();
            onEvent({ type: 'done', status: 'awaiting_tasks' });
            return;
          }
        }

        const msg = `No board items were found, but the Project Manager did not return a usable task list from ${source.path}.`;
        protocol.writeBlackboard(colonyId, 'operator', 'blocker', msg, { bootstrap: true, source: source.path });
        db.prepare("UPDATE colonies SET status='awaiting_tasks', updated_at=unixepoch() WHERE id=?").run(colonyId);
        addEntry({ kind: 'bootstrap', status: 'blocked', source: source.path, message: msg });
        flush();
        onEvent({ type: 'done', status: 'awaiting_tasks' });
        return;
      }
    }

    // ── Create orchestrator ───────────────────────────────────────────────────
    // Give generic orchestrators broad agent tools so they can create workers.
    // Recipe operators get only colony control + delegation; their roster is
    // already fixed by the selected use case.
    const recipePrompt = recipeOrchestratorPrompt(row.goal, operatorModel, recipe, recipeWorkers);
    const orchestratorTools = isCustomAutoRecipe(recipe.id)
      ? ['colony_tools', 'agent_tools', 'sandbox', 'memory', 'protocol']
      : ['colony_tools', 'delegation', 'protocol'];
    const orch = writeAgent(null, {
      name:         'Ari Morgan',
      persona_role: isCustomAutoRecipe(recipe.id) ? 'Colony Orchestrator' : `${recipe.name} Operator`,
      model:        operatorModel,
      avatar_color: '#f59e0b',
      tools:        orchestratorTools,
      system_prompt: (recipePrompt || orchestratorPrompt(row.goal, operatorModel)) + memorySection,
      temperature:  0.4,
      max_tokens:   8192,
      context_length: 32768,
      ephemeral:    true,
    });

    db.prepare('UPDATE colonies SET orchestrator_id=?, updated_at=unixepoch() WHERE id=?')
      .run(orch.id, colonyId);
    addAgentToColony(colonyId, orch.id);
    reasoningByAgentId.set(orch.id, true);

    const orchAgent = { id: orch.id, name: orch.name, persona_role: orch.persona_role, avatar_color: orch.avatar_color, model: orch.model, tools: orch.tools };
    onEvent({ type: 'agent_ready', role: 'orchestrator', agent: orchAgent });
    addEntry({ kind: 'agent_ready', role: 'orchestrator', agent: orchAgent });

    for (const worker of recipeWorkers) {
      onEvent({ type: 'agent_ready', role: 'worker', agent: worker });
      addEntry({ kind: 'agent_ready', role: 'worker', agent: worker });
    }

    // ── Wire up live event stream ─────────────────────────────────────────────
    const fakeWs = makeFakeWs((msg) => {
      if (signal?.aborted) return;

      // Track new agents created by orchestrator. runAgentOnce emits every tool
      // call from inside its loop as 'sub_tool_call'/'sub_tool_result', so we
      // must match both forms here.
      const isToolResult = msg.type === 'tool_result' || msg.type === 'sub_tool_result';
      if (isToolResult && msg.name === 'create_agent' && msg.result?.agent_id) {
        addAgentToColony(colonyId, msg.result.agent_id);
        const newAgent = readAgent(msg.result.agent_id);
        if (newAgent) {
          const wa = {
            id: newAgent.id,
            name: newAgent.name,
            persona_role: newAgent.persona_role,
            avatar_color: newAgent.avatar_color,
            model: newAgent.model,
            tools: newAgent.tools,
          };
          onEvent({ type: 'agent_ready', role: 'worker', agent: wa });
          addEntry({ kind: 'agent_ready', role: 'worker', agent: wa });
        }
      }

      // Emit structured log entries for interesting tool calls
      const agentLabel = msg.subAgent || 'Orchestrator';

      // Token deltas stream through the bus directly — NOT persisted to the
      // DB log (would explode it) and NOT wrapped in a {type:'ws'} envelope
      // so the client can handle them with a dedicated case.
      if (msg.type === 'token') {
        onEvent({ type: 'token', agent: agentLabel, kind: msg.kind, delta: msg.delta });
        return;
      }

      if (msg.type === 'thinking') {
        const content = String(msg.content || '').trim();
        if (content) {
          const entry = { kind: 'thinking', agent: agentLabel, content: content.slice(0, 12000), truncated: content.length > 12000 };
          addEntry(entry);
          onEvent({ type: 'thinking', agent: agentLabel, content: entry.content, truncated: entry.truncated });
        }
        return;
      }

      // Permission circuit-breaker tripped — surface one actionable message to the
      // user (log + live event + blackboard) instead of letting the agent retry.
      if (msg.type === 'permission_required') {
        onEvent({ type: 'permission_required', agent: agentLabel, tool: msg.name, message: msg.message });
        addEntry({ kind: 'permission_required', agent: agentLabel, tool: msg.name, message: msg.message });
        try { protocol.writeBlackboard(colonyId, agentLabel, 'blocker', `Permission needed for "${msg.name}": ${msg.message}. Enable the required credential/scope, then re-run.`, { tool: msg.name, permission_required: true }); } catch {}
        return;
      }

      if (msg.type === 'tool_call' || msg.type === 'sub_tool_call') {
        addEntry({
          kind:  'tool_call',
          agent: agentLabel,
          tool:  msg.name,
          args:  truncateArgs(msg.args),
        });
      }

      if (msg.type === 'tool_result' || msg.type === 'sub_tool_result') {
        addEntry({
          kind:   'tool_result',
          agent:  agentLabel,
          tool:   msg.name,
          result: truncateResult(msg.result),
        });

        // Capture plan state updates and goal-achievement signals. These come
        // from the three colony_tools and must drive: (a) a dedicated
        // plan_update bus event so the UI can rerender the checklist, and
        // (b) goalSummary so the outer loop exits cleanly on completion.
        if (msg.name === 'set_plan' && msg.result?.success && msg.result?.steps) {
          onEvent({ type: 'plan_update', plan: { steps: msg.result.steps } });
          addEntry({ kind: 'plan_set', step_count: msg.result.steps.length });
        }
        if (msg.name === 'update_plan_step' && msg.result?.success && msg.result?.plan) {
          onEvent({ type: 'plan_update', plan: msg.result.plan });
          addEntry({
            kind: 'plan_step_update',
            step_id: msg.result.step?.id,
            status: msg.result.step?.status,
            description: msg.result.step?.description,
          });
        }
        if (msg.name === 'mark_goal_achieved' && msg.result?.goal_achieved && msg.result?.summary) {
          goalSummary = msg.result.summary;
        }

        // Communication Protocol signals — surface handoffs (and human-approval
        // holds) so the UI can render the delivery lifecycle and pause points.
        // Auto-recorded handoffs (worker ended with text instead of the handoff
        // tool — see ask_agent) surface exactly like explicit handoffs.
        if (msg.name === 'ask_agent' && msg.result?.auto_handoff) {
          const ah = msg.result.auto_handoff;
          if (ah.plan) {
            onEvent({ type: 'plan_update', plan: ah.plan });
            const doneStep = [...(ah.plan.steps || [])].reverse().find(s => /^auto-completed/.test(s.note || '') && s.status === 'done');
            if (doneStep) {
              addEntry({ kind: 'plan_step_update', step_id: doneStep.id, status: 'done', description: doneStep.description });
            }
          }
          onEvent({ type: 'handoff', handoff: { id: ah.handoff_id, from: ah.from, to: ah.to, contract: ah.contract, status: ah.status, requires_human: false } });
          addEntry({ kind: 'handoff', agent: msg.result.agent_name || agentLabel, from: ah.from, to: ah.to, contract: ah.contract, status: ah.status, requires_human: false, auto_recorded: true });
        }

        if (msg.name === 'handoff' && msg.result) {
          // Accepted handoffs auto-advance the plan (see agentTools handoff handler) —
          // rerender the checklist live.
          if (msg.result.plan) {
            onEvent({ type: 'plan_update', plan: msg.result.plan });
            const doneStep = [...(msg.result.plan.steps || [])].reverse().find(s => /^auto-completed/.test(s.note || '') && s.status === 'done');
            if (doneStep) {
              addEntry({ kind: 'plan_step_update', step_id: doneStep.id, status: 'done', description: doneStep.description });
            }
          }
          if (msg.result.command) {
            const cmd = msg.result.command;
            onEvent({ type: 'handoff', handoff: { id: msg.result.handoff_id, from: cmd.from, to: cmd.target_agent, contract: cmd.contract, status: msg.result.status, requires_human: !!msg.result.requires_human } });
            addEntry({
              kind: 'handoff',
              agent: agentLabel,
              from: cmd.from,
              to: cmd.target_agent,
              contract: cmd.contract,
              status: msg.result.status,
              requires_human: !!msg.result.requires_human,
            });
          } else if (msg.result.ok === false) {
            onEvent({ type: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
            addEntry({ kind: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
          }
        }
        if ((msg.name === 'report_protocol_violation') && msg.result?.reason) {
          onEvent({ type: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
          addEntry({ kind: 'protocol_violation', agent: agentLabel, reason: msg.result.reason });
        }
        if (msg.name === 'blackboard_write' && msg.result?.success) {
          addEntry({ kind: 'blackboard', agent: msg.result.agent || agentLabel, entry_type: msg.result.entry_type });
        }
        if (msg.name === 'checkpoint' && msg.result?.success) {
          addEntry({ kind: 'checkpoint', agent: msg.result.agent || agentLabel });
        }
      }

      // Forward raw WS event for live clients
      onEvent({ type: 'ws', msg });
    });

    // ── Orchestrator run loop ─────────────────────────────────────────────────
    let initialContent = recipeInitialMessage(recipe);
    if (row.bootstrap_accepted && row.bootstrap_tasks) {
      let acceptedTasks = [];
      try { acceptedTasks = JSON.parse(row.bootstrap_tasks || '[]'); } catch {}
      if (acceptedTasks.length) {
        initialContent += `\n\nHuman-approved bootstrap tasks are already accepted for this empty-board repo. Use these as the delivery scope; do not invent a different backlog. If you call set_plan, preserve this task order:\n${acceptedTasks.map(t => `- ${t.id}. ${t.title}: ${t.description || ''}`).join('\n')}`;
      }
    }
    const messages = [{
      role: 'user',
      content: initialContent,
    }];

    // Persistent conversation history for workers — keyed by agent_id.
    // Passed into colonyContext so ask_agent can give each worker a continuous
    // thread across multiple delegation calls instead of starting fresh each time.
    const agentHistories = new Map();
    // Tracks which plan step IDs have had at least one ask_agent call.
    // Prevents the orchestrator from marking steps done without any real delegation.
    const delegatedSteps = new Set();
    // Tracks IDs of workers that have been successfully created.
    // Delegation guard only activates once at least one worker exists.
    const workersCreated = new Set(recipeWorkers.map(worker => worker.id));

    // Map each seeded worker's agent_id → its protocol role key so the
    // Communication Protocol tools (handoff, blackboard_write, …) can attribute
    // entries and enforce the role-specific flow without the agent guessing.
    const roleByAgentId = new Map();
    for (const worker of recipeWorkers) {
      if (worker.role_key) roleByAgentId.set(worker.id, worker.role_key);
    }

    // Outer review loop: runAgentOnce does one "turn" with up to 20 tool-call
    // rounds internally. Between turns we check for completion and, if not
    // done, inject a state-aware nudge showing the current plan status.
    const MAX_OUTER_ROUNDS = 6;
    let completed = false;

    for (let outer = 0; outer < MAX_OUTER_ROUNDS; outer++) {
      if (signal?.aborted) break;

      const directions = drainPendingDirections(colonyId);
      if (directions.length > 0) {
        const directionText = directions.map(d =>
          `- Direction #${d.id}${d.target_role ? ` for ${d.target_role}` : ''}: ${d.content}`,
        ).join('\n');
        const injected = [
          'HIGH PRIORITY USER DIRECTION',
          'Treat this as authoritative. Adjust the current plan with add_plan_step/update_plan_step as needed. Acknowledge how you applied it in your next response.',
          directionText,
        ].join('\n');
        messages.push({ role: 'user', content: injected });
        for (const d of directions) {
          addEntry({ kind: 'direction', direction_id: d.id, status: 'delivered', content: d.content, target_role: d.target_role || null });
          onEvent({ type: 'direction_delivered', direction: { id: d.id, content: d.content, target_role: d.target_role || null } });
        }
      }

      addEntry({ kind: 'round', round: outer + 1 });
      onEvent({ type: 'round_start', round: outer + 1 });

      const response = await runAgentOnce(
        orch, messages, ollamaUrl,
        0,      // depth
        fakeWs,
        null,   // hivePath
        null,   // toolsOverride
        20,     // maxRounds — cascades to workers via executeTool → ask_agent
        signal, // AbortSignal — cancels in-flight Ollama requests on stop
        {
          colonyId,
          // The worker cap only guards the custom_auto path, where the orchestrator
          // spawns workers via create_agent. Seeded recipe crews have a fixed roster
          // and must not be capped — null disables the guard.
          maxWorkers: isCustomAutoRecipe(recipe.id) ? MAX_WORKERS_PER_COLONY : null,
          agentHistories,
          delegatedSteps,
          workersCreated,
          recipeId: recipe.id,
          roleByAgentId,
          reasoningByAgentId,
          workerReasoningDefault,
        },
      );

      addEntry({ kind: 'message', agent: 'Orchestrator', content: response });
      onEvent({ type: 'orchestrator_message', content: response, round: outer + 1 });

      if (signal?.aborted) break;

      // Completion detection — prefer the explicit mark_goal_achieved signal,
      // fall back to a GOAL ACHIEVED: text sentinel for models that skip the
      // structured tool.
      if (goalSummary) {
        db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(goalSummary, colonyId);
        completed = true;
        break;
      }
      // Text-sentinel completion is a fallback for weak models that skip the
      // structured tool. It is DISABLED for protocol recipes — those must finish
      // through the gated mark_goal_achieved so the handoff flow and human gates
      // are actually honored (no declaring victory in prose).
      if (!protocol.hasProtocol(recipe.id)) {
        const match = response.match(/GOAL ACHIEVED:\s*([\s\S]+?)(?:\n\n|$)/i);
        if (match) {
          db.prepare('UPDATE colonies SET summary=? WHERE id=?').run(match[1].trim(), colonyId);
          completed = true;
          break;
        }
      }

      if (outer < MAX_OUTER_ROUNDS - 1) {
        // Build a state-aware nudge based on the current plan and worker list in the DB.
        const planRow = db.prepare('SELECT plan, agent_ids, orchestrator_id FROM colonies WHERE id=?').get(colonyId);
        const plan = planRow?.plan ? JSON.parse(planRow.plan) : null;

        // Always include current worker list so the orchestrator never needs to invent IDs.
        const allIds = JSON.parse(planRow?.agent_ids || '[]');
        const orchId = planRow?.orchestrator_id;
        const workerIds = allIds.filter(id => id !== orchId);
        const workerLines = workerIds.map(id => {
          const a = readAgent(id);
          return a ? `  • "${a.name}" → agent_id: "${a.id}"` : null;
        }).filter(Boolean);

        let nudge = `Round ${outer + 2} of ${MAX_OUTER_ROUNDS}.\n`;

        if (workerLines.length > 0) {
          nudge += `\nYour workers (use these exact agent_id values in ask_agent):\n${workerLines.join('\n')}\n`;
        }

        if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
          nudge += '\nYou have not called set_plan yet. Call it NOW with 3–6 concrete steps before creating workers or doing anything else.\n';
        } else {
          const done = plan.steps.filter(s => s.status === 'done');
          const pending = plan.steps.filter(s => s.status !== 'done');

          if (done.length > 0) {
            const doneLines = done.map(s => `  ✓ [DONE] ${s.id}. ${s.description}`);
            nudge += `\nCompleted steps (do NOT reopen, do NOT call set_plan):\n${doneLines.join('\n')}\n`;
          }

          if (pending.length === 0) {
            nudge += '\n*** ALL STEPS DONE *** Call mark_goal_achieved RIGHT NOW with a summary of what was accomplished. Do NOT create new steps or call set_plan — the plan is complete.\n';
          } else {
            const lines = pending.map(s => {
              const alreadyDelegated = delegatedSteps.has(String(s.id));
              const hint = (s.status === 'in_progress' && alreadyDelegated)
                ? ' ← ask_agent already called; mark this DONE now'
                : s.status === 'in_progress'
                  ? ' ← call ask_agent to do the work, then mark done'
                  : '';
              return `  - [${s.status}] ${s.id}. ${s.description}${s.assigned_to ? ' → ' + s.assigned_to : ''}${hint}`;
            });
            nudge += `\nRemaining steps:\n${lines.join('\n')}\n\nAddress errors above, then continue with the next step. If a step is in_progress and ask_agent already ran for it, mark it done immediately.\n`;
          }
        }

        messages.push({ role: 'assistant', content: response });
        messages.push({ role: 'user', content: nudge });
      }
    }

    // If we exhausted rounds without completion, fail loudly with a diagnostic
    // instead of pretending the run succeeded.
    if (!completed && !signal?.aborted) {
      const planRow = db.prepare('SELECT plan FROM colonies WHERE id=?').get(colonyId);
      const plan = planRow?.plan ? JSON.parse(planRow.plan) : null;
      const pending = plan?.steps?.filter(s => s.status !== 'done') || [];
      const detail = plan
        ? `${pending.length} of ${plan.steps.length} plan steps still unfinished: ${pending.map(s => s.id).join(', ') || '(none)'}`
        : 'no plan was ever set';
      throw new Error(
        `Colony did not call mark_goal_achieved within ${MAX_OUTER_ROUNDS} review rounds. The orchestrator stalled (${detail}). Try a more specific goal, a stronger model, or re-run to retry.`,
      );
    }

    const status = signal?.aborted ? 'stopped' : 'done';
    db.prepare('UPDATE colonies SET status=?, updated_at=unixepoch() WHERE id=?').run(status, colonyId);

    await performWriteback(status);

    // Operator memory upkeep — distill lessons from this run into the colony's
    // shared memory so the next run starts smarter.
    try { await updateColonyMemoryAfterRun(colonyId, row, goalSummary, status, addEntry); } catch {}

    // Auto-post the deliverable summary to the linked board work-item so the
    // user never has to click "Post update" manually. Non-fatal on failure —
    // the manual button remains as a retry.
    if (status === 'done' && row.board_card) {
      try {
        const card = JSON.parse(row.board_card || 'null');
        const repoInfo = row.repo_path ? detectGitHubRepo(row.repo_path) : null;
        if (card?.number && repoInfo) {
          const fresh = getColony(colonyId);
          const comment = await postIssueComment({
            owner: repoInfo.owner, repo: repoInfo.repo, number: card.number,
            body: buildBoardComment(fresh),
          });
          addEntry({ kind: 'writeback', message: `💬 Posted update to ${repoInfo.owner}/${repoInfo.repo} #${card.number}`, comment_url: comment?.html_url || null });
          onEvent({ type: 'writeback', phase: 'board_comment', url: comment?.html_url || null });
        }
      } catch (e) {
        addEntry({ kind: 'writeback', message: `⚠️ Could not auto-post the board update: ${e.message}. Use "Post update" in the summary card to retry.` });
      }
    }

    cleanupSandboxContainers();
    addEntry({ kind: 'done', status });
    flush();
    onEvent({ type: 'done', status });

  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Colony run was stopped' || signal?.aborted) {
      db.prepare("UPDATE colonies SET status='stopped', updated_at=unixepoch() WHERE id=?").run(colonyId);
      // Stopped runs still publish whatever real work landed on the branch.
      try { await performWriteback('stopped'); } catch {}
      // Partial runs often carry the most valuable lessons (what blocked them).
      try { await updateColonyMemoryAfterRun(colonyId, row, goalSummary, 'stopped', addEntry); } catch {}
      cleanupSandboxContainers();
      addEntry({ kind: 'done', status: 'stopped' });
      flush();
      onEvent({ type: 'done', status: 'stopped' });
    } else {
      db.prepare("UPDATE colonies SET status='error', updated_at=unixepoch() WHERE id=?").run(colonyId);
      cleanupSandboxContainers();
      addEntry({ kind: 'error', message: e.message });
      flush();
      onEvent({ type: 'error', message: e.message });
    }
  } finally {
    // Deregister this run so stopColonyRun() no longer finds it, and detach
    // the external-signal listener to avoid leaks on long-lived signals.
    runningColonies.delete(colonyId);
    if (externalSignal) {
      try { externalSignal.removeEventListener('abort', onExternalAbort); } catch {}
    }
    // Drop the per-colony bus if no subscribers remain. If tail clients are
    // still attached, they'll trigger cleanup on their own disconnect.
    try { maybeCleanup(colonyId); } catch {}
  }
}

// ── Post-run colony memory update ─────────────────────────────────────────────
// After each run the operator distills what the team should remember — outcome,
// gotchas, workarounds, open blockers — and appends it to the colony's shared
// memory (editable on the colony page, injected into the next run's prompts).
// Non-fatal: any failure here never affects the run result.
async function updateColonyMemoryAfterRun(colonyId, row, goalSummary, status, addEntry) {
  // Staff memory: every recipe-role profile that crewed this run gets a short
  // dated note (what ran, how it ended) — so the Staff tab's Memory sections
  // accumulate real history without waiting for suggestion applies.
  try {
    const recipe = getColonyRecipe(row.recipe_id || DEFAULT_RECIPE_ID);
    if (Array.isArray(recipe.roles) && recipe.roles.length) {
      const note = `- ${new Date().toISOString().slice(0, 10)} · run ${colonyId} (${status}): ${String(row.goal || '').split('\n')[0].slice(0, 100)}${goalSummary ? ` — ${String(goalSummary).replace(/\s+/g, ' ').slice(0, 140)}` : ''}`;
      for (const role of recipe.roles) {
        const profile = staffDirectory.getProfileByRole(recipe.id, role.key);
        if (profile) staffDirectory.appendProfileMemory(profile.id, note);
      }
    }
  } catch {}

  if (!row?.team_id) return;
  const colonyTeams = require('./colonyTeams');
  const team = colonyTeams.getTeam(row.team_id);
  if (!team) return;

  const fresh = getColony(colonyId);
  const deliverable = fresh?.deliverable || null;
  const workarounds = Array.isArray(deliverable?.workarounds) ? deliverable.workarounds : [];
  let blockers = [];
  try { blockers = protocol.readBlackboard(colonyId, { entryType: 'blocker', limit: 5 }); } catch {}
  if (!goalSummary && !workarounds.length && !blockers.length) return;

  const providers = require('./providers');
  const model = (fresh?.model_plan && fresh.model_plan.operator) || row.model;
  const sys = [
    "You are the Colony Operator maintaining your team's shared memory — durable knowledge that future runs will read.",
    'Distill ONLY what is worth remembering across runs: repo/tooling gotchas, decisions made, recurring failure modes, follow-ups owed.',
    'Do NOT restate the mission or narrate the run. No praise, no filler.',
    'Respond with 2–5 plain bullet lines, each starting with "- ", each under 200 characters. Nothing else.',
  ].join(' ');
  const user = [
    `Mission: ${row.goal}`,
    `Run status: ${status}`,
    goalSummary ? `Outcome summary: ${goalSummary}` : '',
    workarounds.length ? `Workarounds reported:\n${workarounds.map(w => `- ${w.issue || ''} → ${w.recommendation || w.workaround || ''}`).join('\n')}` : '',
    blockers.length ? `Open blockers:\n${blockers.map(b => `- ${String(b.content || '').slice(0, 200)}`).join('\n')}` : '',
    `Existing memory (avoid duplicating notes already present):\n${String(team.memory || '(empty)').slice(-3000)}`,
  ].filter(Boolean).join('\n\n');

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45000);
    let raw;
    try {
      raw = await providers.generateText(model, [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ], { signal: ac.signal, temperature: 0.2, metadata: { colony_id: colonyId, source: 'memory_synthesis' } });
    } finally {
      clearTimeout(timer);
    }
    const bullets = String(raw || '').split('\n')
      .map(l => l.trim().replace(/^[-*]\s+/, ''))
      .filter(l => l && !/^#/.test(l))
      .slice(0, 5)
      .map(l => l.slice(0, 300));
    if (!bullets.length) return;
    const title = `Run ${colonyId} — ${new Date().toISOString().slice(0, 10)} (${status})`;
    colonyTeams.appendTeamMemory(team.id, title, bullets);
    addEntry({ kind: 'memory', message: `🧠 Operator updated colony memory (${bullets.length} note${bullets.length === 1 ? '' : 's'}).` });
  } catch {
    // Memory upkeep is best-effort.
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Log-entry truncation. Caps were 500/2000/300 which visibly chopped worker
// responses (ask_agent results) to 300 chars in the UI — "cuts things off".
// The DB log keeps at most LOG_MAX_ENTRIES, so roomier caps are safe.
function truncateArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '…' : v;
  }
  return out;
}

function truncateResult(result) {
  if (result === null || result === undefined) return result;
  const str = JSON.stringify(result);
  if (str.length <= 8000) return result;
  if (typeof result === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(result)) {
      // `response` carries the worker's full answer — keep the most of it.
      const cap = k === 'response' ? 6000 : 1000;
      out[k] = typeof v === 'string' && v.length > cap ? v.slice(0, cap) + '…' : v;
    }
    return out;
  }
  return String(result).slice(0, 8000) + '…';
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

function createColony(goal, model, recipeId = DEFAULT_RECIPE_ID, opts = {}) {
  const id = newId();
  db.prepare('INSERT INTO colonies (id, goal, model, recipe_id, repo_path, board_card, cloud_enabled, github_writeback, model_plan, reasoning_mode, trigger_config, trigger, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      id, goal, model, recipeId,
      opts.repoPath || null,
      opts.boardCard ? JSON.stringify(opts.boardCard) : null,
      opts.cloudEnabled ? 1 : 0,
      opts.githubWriteback ? 1 : 0,
      opts.modelPlan ? JSON.stringify(opts.modelPlan) : null,
      colonyModels.normalizeReasoningMode(opts.reasoningMode),
      opts.triggerConfig ? JSON.stringify(opts.triggerConfig) : null,
      opts.trigger ? JSON.stringify(opts.trigger) : null,
      opts.teamId || null,
    );
  return id;
}

function listColonies() {
  return db.prepare(
    'SELECT id, team_id, goal, model, recipe_id, status, orchestrator_id, agent_ids, summary, created_at, trigger, board_card FROM colonies ORDER BY created_at DESC',
  ).all().map(r => {
    let trigger = null;
    let boardCard = null;
    if (r.trigger) { try { trigger = JSON.parse(r.trigger); } catch {} }
    if (r.board_card) { try { boardCard = JSON.parse(r.board_card); } catch {} }
    return { ...r, agent_ids: JSON.parse(r.agent_ids || '[]'), trigger, board_card: boardCard };
  });
}

function getColony(id) {
  const row = db.prepare('SELECT * FROM colonies WHERE id=?').get(id);
  if (!row) return null;
  const agents = JSON.parse(row.agent_ids || '[]').map(aid => {
    const a = readAgent(aid);
    return a ? { id: a.id, name: a.name, persona_role: a.persona_role, avatar_color: a.avatar_color, model: a.model, tools: a.tools } : null;
  }).filter(Boolean);
  let plan = null;
  if (row.plan) { try { plan = JSON.parse(row.plan); } catch {} }
  let deliverable = null;
  if (row.deliverable) { try { deliverable = JSON.parse(row.deliverable); } catch {} }
  let boardCard = null;
  if (row.board_card) { try { boardCard = JSON.parse(row.board_card); } catch {} }
  let modelPlan = null;
  if (row.model_plan) { try { modelPlan = JSON.parse(row.model_plan); } catch {} }
  let triggerConfig = null;
  if (row.trigger_config) { try { triggerConfig = JSON.parse(row.trigger_config); } catch {} }
  let trigger = null;
  if (row.trigger) { try { trigger = JSON.parse(row.trigger); } catch {} }
  let bootstrapTasks = null;
  if (row.bootstrap_tasks) { try { bootstrapTasks = JSON.parse(row.bootstrap_tasks); } catch {} }
  return {
    ...row,
    agent_ids: JSON.parse(row.agent_ids || '[]'),
    agents,
    log: JSON.parse(row.log || '[]'),
    plan,
    deliverable,
    board_card: boardCard,
    cloud_enabled: !!row.cloud_enabled,
    model_plan: modelPlan,
    reasoning_mode: colonyModels.normalizeReasoningMode(row.reasoning_mode),
    trigger_config: triggerConfig,
    trigger,
    bootstrap_tasks: bootstrapTasks,
    bootstrap_accepted: !!row.bootstrap_accepted,
  };
}

function deleteColony(id) {
  const row = db.prepare('SELECT agent_ids FROM colonies WHERE id=?').get(id);
  if (!row) return;
  const ids = JSON.parse(row.agent_ids || '[]');
  const { deleteAgent } = require('./agentParser');
  for (const agentId of ids) {
    try { deleteAgent(agentId); } catch {}
  }
  try { db.prepare('DELETE FROM colony_blackboard WHERE colony_id=?').run(id); } catch {}
  try { db.prepare('DELETE FROM colony_handoffs WHERE colony_id=?').run(id); } catch {}
  try { db.prepare('DELETE FROM colony_trigger_events WHERE colony_id=? OR triggered_colony_id=?').run(id, id); } catch {}
  try { db.prepare('DELETE FROM colony_directions WHERE colony_id=?').run(id); } catch {}
  try { db.prepare('DELETE FROM colony_agent_histories WHERE colony_id=?').run(id); } catch {}
  db.prepare('DELETE FROM colonies WHERE id=?').run(id);
}

module.exports = {
  runColony,
  stopColonyRun,
  isColonyRunning,
  createColony,
  listColonies,
  getColony,
  deleteColony,
  truncateArgs,
  truncateResult,
  categorizeMcpServer,
  mcpCategoriesForWorker,
  parseBootstrapTasks,
  readBootstrapSource,
};
