// Shared helpers + constants for the tool modules and the agent runner (#27).
// Extracted verbatim from the former monolithic agentTools.js.
const fs = require('fs');
const path = require('path');
const { readAgent } = require('../agentParser');
const providers = require('../providers');
const protocol = require('../colonyProtocol');
const { normalizeOllamaUrl } = require('../ollamaUrl');
const { logSwallowed } = require('../logSwallowed');

// Per-model-round timeout. Generous because per-role model plans make Ollama
// swap large models (8b operator ↔ 14b coders) between turns — the first round
// after a swap pays the full model load. 180s was observed discarding a
// worker's completed turn on a 36GB machine.
const MODEL_ROUND_TIMEOUT_MS = 300_000;

// Resolve the canonical role key for the calling agent inside a colony run.
// Recipe operators seed a roleByAgentId map in colonyContext; fall back to an
// explicit arg, then the agent's persona_role/name so the blackboard still gets
// a readable author label.
function resolveRoleKey(colonyContext, callerAgentId, explicit) {
  if (explicit) return explicit;
  const map = colonyContext?.roleByAgentId;
  if (map && callerAgentId && typeof map.get === 'function') {
    const key = map.get(callerAgentId);
    if (key) return key;
  }
  return null;
}

// Classify a tool result as a permission/authorization failure. Used by the
// circuit-breaker so agents stop hammering a tool that needs a credential or
// scope, and the user gets one actionable message instead of a retry loop.
const PERMISSION_ERROR_RE = /\b(permission denied|not authoriz|unauthoriz|forbidden|access denied|EACCES|insufficient (?:scope|permission|access)|requires? (?:the )?[\w .-]*(?:scope|permission|token|credential)|missing (?:scope|permission|token|credential|api key)|no (?:api key|token|credential)|authentication (?:failed|required)|401|403)\b/i;

// Agents see the workspace as "/workspace" inside the sandbox and routinely
// prefix relative paths with it ("workspace/frontend/...", "/workspace/app.py"),
// which used to create a literal nested workspace/ directory in the repo.
// Strip the prefix so paths always resolve from the repo/workspace root.
function stripWorkspacePrefix(p) {
  return String(p || '').replace(/^\/?(?:workspace\/)+/, '');
}

// Extract the failure text from a tool result. Built-in tools fail with
// { error }; MCP tools fail with { result: "[MCP ERROR] ..." } (the manager
// surfaces isError as a text prefix instead of throwing). Returns '' when the
// result doesn't look like a failure.
function failureText(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.error === 'string' && result.error) return result.error;
  if (typeof result.result === 'string' && result.result.startsWith('[MCP ERROR]')) return result.result;
  return '';
}

function isPermissionError(result) {
  const msg = failureText(result);
  // Path-scoping denials (e.g. the Filesystem MCP's "outside allowed
  // directories") are argument errors — other paths may work fine — so they
  // must not trip the per-tool permission halt; the per-call failure breaker
  // covers the retry loop instead.
  if (/outside allowed director/i.test(msg)) return false;
  return PERMISSION_ERROR_RE.test(msg);
}

function permissionGuidance(toolName, errMsg) {
  return `ACTION REQUIRED — "${toolName}" failed with a permissions/auth error: ${errMsg}. ` +
    `This means a credential, API key, or scope is missing — it will NOT succeed on retry. ` +
    `Stop attempting this action. Report to the user exactly what needs to be enabled (e.g. set the ` +
    `relevant API key/token in Settings → Integrations, or grant the MCP server the required scope), ` +
    `then continue with any work that does not depend on it.`;
}

function agentLabel(colonyContext, callerAgentId, explicitRole) {
  const roleKey = resolveRoleKey(colonyContext, callerAgentId, explicitRole);
  const meta = roleKey ? protocol.DEV_TEAM_ROLES[roleKey] : null;
  if (meta) return meta.name;
  const a = callerAgentId ? readAgent(callerAgentId) : null;
  return a?.persona_role || a?.name || roleKey || 'agent';
}

const PROJECT_CONTEXT_FILES = ['PRD.md', 'docs/PRD.md', 'docs/prd.md', 'README.md', 'readme.md', 'SPEC.md', 'docs/SPEC.md'];
const PROJECT_CONTEXT_MAX_CHARS = 9000;

function readProjectContextFiles(repoPath) {
  if (!repoPath) return [];
  const files = [];
  for (const rel of PROJECT_CONTEXT_FILES) {
    try {
      const p = path.join(repoPath, rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) continue;
      const content = fs.readFileSync(p, 'utf8');
      files.push({
        path: rel,
        content: content.slice(0, PROJECT_CONTEXT_MAX_CHARS),
        truncated: content.length > PROJECT_CONTEXT_MAX_CHARS,
      });
    } catch (e) { logSwallowed('agentTools:readProjectContext', e, { file: rel }); }
  }
  return files;
}

// ── Shared blackboard ─────────────────────────────────────────────────────────
// A single SHARED.md file all agents can read and write.

function getSharedPath(hivePath) {
  const base = hivePath || path.join(require('os').homedir(), '.hive');
  return path.join(base, 'shared', 'SHARED.md');
}

function readShared(hivePath) {
  const p = getSharedPath(hivePath);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').trim();
}

function writeShared(content, hivePath) {
  const p = getSharedPath(hivePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content.trimEnd() + '\n', 'utf8');
}

// ── Memory helpers ────────────────────────────────────────────────────────────

function readMemory(workspace) {
  if (!workspace) return '';
  const p = path.join(workspace, 'MEMORY.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8').trim();
}

// ── Non-streaming agent loop (used by ask_agent) ──────────────────────────────
// Runs the full tool loop for a target agent without a WebSocket, so the calling
// agent gets a real answer even if the target needs to call tools (e.g. web search).

const MAX_SUB_ROUNDS = 6;

async function validateAgentModel(model, ollamaUrl) {
  const parsed = providers.parseModel(model);
  if (!parsed.modelId) return { ok: false, error: 'model is empty' };
  const normalizedOllamaUrl = normalizeOllamaUrl(ollamaUrl);

  if (parsed.provider !== 'ollama') {
    if (!providers.hasKey(parsed.provider)) {
      const label = providers.LABEL?.[parsed.provider] || parsed.provider;
      return { ok: false, error: `${label} API key is not set. Add it in Settings → Model Providers or set the provider environment variable.` };
    }
    return { ok: true, provider: parsed.provider, modelId: parsed.modelId };
  }

  try {
    const tagsRes = await fetch(`${normalizedOllamaUrl}/api/tags`);
    if (tagsRes.ok) {
      const { models = [] } = await tagsRes.json();
      const modelValid = models.some(m =>
        m.name === parsed.modelId ||
        m.name === `${parsed.modelId}:latest` ||
        m.name.startsWith(`${parsed.modelId}:`),
      );
      if (modelValid) return { ok: true, provider: 'ollama', modelId: parsed.modelId };
    }
  } catch (e) { logSwallowed('agentTools:validateModel', e); }

  return {
    ok: false,
    provider: 'ollama',
    modelId: parsed.modelId,
    error: `Model "${model}" is not installed on Ollama. Install it with: ollama pull ${parsed.modelId}`,
  };
}

// ── Text tool call parser ─────────────────────────────────────────────────────
// Some models (llama3.1, mistral-7b) describe tool calls in markdown/JSON prose
// instead of emitting proper function_call payloads. This parser extracts those
// descriptions and returns synthetic tool_calls so the agent loop can execute them.
//
// Patterns handled:
//   {"name": "tool_name", "parameters": {...}}
//   {"name": "tool_name", "arguments": {...}}
//   Same patterns inside ```json ... ``` code blocks
function extractTextToolCalls(content, toolDefinitions) {
  const toolNames = new Set(
    toolDefinitions.map(t => t.function?.name).filter(Boolean),
  );
  if (toolNames.size === 0) return [];

  const candidates = [];

  // 1. Code blocks: ```json\n{...}\n```  or  ```\n{...}\n```
  const codeBlockRe = /```(?:json)?\s*(\{[\s\S]+?\})\s*```/g;
  let m;
  while ((m = codeBlockRe.exec(content)) !== null) candidates.push(m[1]);

  // 2. Bare JSON objects containing "name" + "parameters"/"arguments"
  // We scan for objects by finding every '{' that could be the start of one.
  const bareRe = /\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*(?:"parameters"|"arguments")\s*:\s*(\{)/g;
  while ((m = bareRe.exec(content)) !== null) {
    // Walk forward to find the matching closing brace for the inner args object,
    // then capture the full outer object.
    let start = m.index;
    let depth = 0;
    for (let i = start; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') { depth--; if (depth === 0) { candidates.push(content.slice(start, i + 1)); break; } }
    }
  }

  const results = [];
  const seen = new Set();

  for (const raw of candidates) {
    let obj;
    try { obj = JSON.parse(raw); } catch {
      // Try fixing Python-style single quotes
      try { obj = JSON.parse(raw.replace(/'/g, '"')); } catch { continue; }
    }
    if (typeof obj.name !== 'string' || !toolNames.has(obj.name)) continue;
    const args = obj.parameters || obj.arguments || {};
    const key = obj.name + JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ function: { name: obj.name, arguments: args } });
  }

  return results;
}

module.exports = {
  MODEL_ROUND_TIMEOUT_MS, MAX_SUB_ROUNDS,
  resolveRoleKey, stripWorkspacePrefix, isPermissionError, permissionGuidance, failureText,
  PERMISSION_ERROR_RE, agentLabel, readProjectContextFiles,
  PROJECT_CONTEXT_FILES, PROJECT_CONTEXT_MAX_CHARS,
  getSharedPath, readShared, writeShared, readMemory,
  validateAgentModel, extractTextToolCalls,
};
