// Pre-flight model checks for colony runs.
// Fail fast with a clear message if the selected model is missing or doesn't
// support tool calling. Previously the colony would silently produce garbage
// when the user picked a non-tool-capable model.
const { stripProviderPrefix } = require('../agentParser');
const { normalizeOllamaUrl } = require('../ollamaUrl');
const colonyModels = require('../colonyModels');
const protocol = require('../colonyProtocol');
const { gitCheckoutBranch } = require('./git');

// Probe installed models for the 'tools' capability (failure path only, so a
// user picking a non-tool model gets alternatives they can select immediately).
// Capped and parallel; a misbehaving /api/show just shortens the list.
async function listInstalledToolModels(ollamaUrl, models, exclude) {
  const names = models.map(m => m.name).filter(n => n !== exclude && !n.includes('embed')).slice(0, 20);
  const probes = names.map(async (name) => {
    try {
      const res = await fetch(`${ollamaUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const info = await res.json();
      const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
      return caps.includes('tools') ? name : null;
    } catch {
      return null;
    }
  });
  return (await Promise.all(probes)).filter(Boolean).slice(0, 8);
}

async function preflightColony(model, ollamaUrl) {
  const providers = require('../providers');
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
        // Recommend from what's actually installed, not generic pull targets.
        const alternatives = await listInstalledToolModels(normalizedOllamaUrl, models, stripped);
        const hint = alternatives.length
          ? `Tool-capable models already installed: ${alternatives.join(', ')}.`
          : 'Colony requires a tool-capable model — try llama3.1, qwen2.5, qwen3, mistral-nemo, or mistral-small.';
        return {
          ok: false,
          error: `Model "${stripped}" does not support tool calling (capabilities: ${caps.join(', ')}). ${hint}`,
        };
      }
    }
  } catch {
    // Non-fatal — skip capability check if /api/show misbehaves.
  }

  return { ok: true };
}

// Run the full pre-flight for a colony: cloud-model gating, per-model capability
// checks, git colony-branch checkout, and the weak-tool-model soft warning.
// Throws on a hard gate/capability failure. Sets `state.githubWriteback` and
// returns the resolved operator model. `ctx` = { colonyId, row, modelPlan,
//   colonyBranch, ollamaUrl, addEntry, onEvent, state }.
async function runModelPreflightAndCheckout(ctx) {
  const { colonyId, row, modelPlan, colonyBranch, ollamaUrl, addEntry, onEvent, state } = ctx;

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

  // Warm the operator model BEFORE round 1 with a visible log entry. A cold
  // 14b load under memory pressure takes minutes, and without this the run
  // shows a silent "round" entry and looks stalled — users kill healthy runs.
  const providers2 = require('../providers');
  if (providers2.parseModel(operatorModel).provider === 'ollama') {
    const name = stripProviderPrefix(operatorModel);
    // Gate on /api/ps first (3s cap): skip when already loaded, and skip when
    // the endpoint is unavailable (old Ollama, test fakes) — the warm-up is a
    // UX nicety and must never hang a run or a test suite.
    let needsLoad = false;
    try {
      const psRes = await fetch(`${normalizeOllamaUrl(ollamaUrl)}/api/ps`, { signal: AbortSignal.timeout(3000) });
      if (psRes.ok) {
        const ps = await psRes.json();
        // Require the real /api/ps shape (models array). Test fakes answer
        // every route with chat-shaped JSON — warming against one consumes a
        // scripted model response and derails the run.
        if (Array.isArray(ps.models)) {
          needsLoad = !ps.models.some(m => m.name === name || m.name === `${name}:latest`);
        }
      }
    } catch { /* ps unavailable — skip warm-up */ }
    if (needsLoad) {
      addEntry({ kind: 'preflight', message: `⏳ Loading operator model "${name}" into memory (large models can take minutes on first load)…` });
      const startedAt = Date.now();
      try {
        const res = await fetch(`${normalizeOllamaUrl(ollamaUrl)}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name, prompt: 'ok', options: { num_predict: 1 }, stream: false }),
          signal: AbortSignal.timeout(600_000),
        });
        const secs = Math.round((Date.now() - startedAt) / 1000);
        addEntry({ kind: 'preflight', message: res.ok
          ? `Operator model loaded in ${secs}s.`
          : `⚠ Operator model warm-up returned HTTP ${res.status} after ${secs}s — continuing; the first round may be slow.` });
      } catch (e) {
        addEntry({ kind: 'preflight', message: `⚠ Operator model warm-up did not finish (${e.name === 'TimeoutError' ? 'timed out after 600s' : e.message}) — continuing; the first round may be slow.` });
      }
    }
  }

  // ── Git write-back: checkout colony branch pre-flight ────────────────────
  state.githubWriteback = !!row.github_writeback;
  if (state.githubWriteback && row.repo_path) {
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

  return { operatorModel };
}

module.exports = { preflightColony, runModelPreflightAndCheckout };
