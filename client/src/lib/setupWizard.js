// First-run setup wizard helpers (pure functions — UI lives in pages/SetupPage.jsx).
// Derives the dependency checklist and gating logic from GET /api/system/setup.

export const SETUP_STEPS = ['welcome', 'dependencies', 'model', 'done'];

export function nextStep(step) {
  const i = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[Math.min(i + 1, SETUP_STEPS.length - 1)];
}

export function prevStep(step) {
  const i = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[Math.max(i - 1, 0)];
}

// Does this install have any way to run a model right now?
export function hasModelAccess(status) {
  if (!status) return false;
  if (status.ollama?.reachable && status.ollama.installed_models > 0) return true;
  if (status.gateway?.configured) return true;
  const p = status.providers || {};
  return !!(p.anthropic || p.openai || p.gemini);
}

// Should the app auto-redirect to /setup? Only for genuinely fresh installs:
// wizard never completed AND no agents yet (existing installs that predate the
// wizard have agents and must not be interrupted).
export function needsSetup({ setupStatus, agents }) {
  if (!setupStatus || setupStatus.setup_completed) return false;
  if (!Array.isArray(agents)) return false;
  return agents.length === 0;
}

// Flatten the /api/system/setup payload into renderable checklist rows.
// "required" here means "required for the happy path", not a hard block —
// the wizard never prevents continuing.
export function dependencyChecklist(status) {
  if (!status) return [];
  const modelAccess = hasModelAccess(status);
  return [
    {
      key: 'model-access',
      label: 'Model access (Ollama or a cloud API key)',
      ok: modelAccess,
      required: true,
      detail: status.ollama?.reachable
        ? `Ollama running at ${status.ollama.url} · ${status.ollama.installed_models} model${status.ollama.installed_models === 1 ? '' : 's'} installed`
        : 'Ollama is not reachable — install it, or add a cloud API key in the next step',
      href: status.ollama?.reachable ? null : 'https://ollama.com/download',
    },
    {
      key: 'docker',
      label: 'Docker (agent sandbox + coding tools)',
      ok: !!status.docker?.available,
      required: true,
      detail: status.docker?.available
        ? (status.docker.sandbox_ready ? 'Running — sandbox image ready' : 'Running — sandbox image builds on first use')
        : 'Not running. Powers the shell/python sandbox and colony coding agents.',
      href: status.docker?.available ? null : 'https://docs.docker.com/get-docker/',
    },
    {
      key: 'git',
      label: 'git (colony code write-back)',
      ok: !!status.git?.present,
      required: false,
      detail: status.git?.present ? status.git.version : 'Optional: needed for colony branch/commit/push workflows.',
      href: status.git?.present ? null : 'https://git-scm.com/downloads',
    },
    {
      key: 'gh',
      label: 'GitHub access (boards, PRs, issues)',
      ok: !!status.gh?.authenticated,
      required: true,
      detail: status.gh?.authenticated
        ? 'Token found'
        : 'Run `gh auth login` in a terminal, or set a token in Settings, to enable GitHub boards, PRs, and issues.',
      href: null,
    },
    {
      key: 'npx',
      label: 'npx (MCP server presets)',
      ok: !!status.npx?.present,
      required: true,
      detail: status.npx?.present ? 'Found on PATH' : 'Ships with Node.js — most MCP presets are spawned via npx.',
      href: status.npx?.present ? null : 'https://nodejs.org/en/download',
    },
    {
      key: 'uvx',
      label: 'uvx (Python MCP servers)',
      ok: !!status.uvx?.present,
      required: true,
      detail: status.uvx?.present ? 'Found on PATH' : 'Part of uv — needed for Python-based MCP presets like fetch.',
      href: status.uvx?.present ? null : 'https://docs.astral.sh/uv/getting-started/installation/',
    },
  ];
}
