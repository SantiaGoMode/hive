// Sandbox tools (shell/python/files/servers) — run inside the agent's Docker sandbox. (#27)
const fs = require('fs');
const path = require('path');
const { stripWorkspacePrefix } = require('./shared');

function mediaBackendInstallHint() {
  return 'Hive media backends run on the host, not inside the sandbox. Do NOT install Orpheus, SNAC, FLUX, torch, npm packages, or model files in the sandbox for speech/image generation. Use the host-side generate_speech or generate_image tool; if this role lacks the media tool, delegate to a media-capable role or report the missing media tool assignment, not sandbox network access.';
}

function isMediaBackendInstallTarget(value) {
  const text = String(value || '').toLowerCase();
  return /\b(orpheus|snac|flux2?|flux-?klein|text-to-speech|speech-synthesis|tts)\b/.test(text)
    || (/\btorch\b/.test(text) && /\b(orpheus|snac|speech|tts)\b/.test(text));
}

function isPackageInstallCommand(command) {
  return /\b(npm|pnpm|yarn)\s+(install|add|i)\b/i.test(command)
    || /\b(pip|pip3)\s+install\b/i.test(command)
    || /\bpython3?\s+-m\s+pip\s+install\b/i.test(command);
}

function isSourceMutationCommand(command) {
  const text = String(command || '').trim();
  return isPackageInstallCommand(text)
    || /\bnpm\s+audit\s+fix\b/i.test(text)
    || /\b(?:prettier|eslint|biome)\b[^\n]*(?:--write|--fix)\b/i.test(text)
    || /\bgit\s+(?:add|commit|checkout|switch|reset|restore|clean|merge|rebase|cherry-pick)\b/i.test(text)
    || /(^|[;&|]\s*)(?:rm|mv|cp|touch|mkdir|rmdir|truncate)\s/i.test(text)
    || /\bsed\s+-i\b/i.test(text)
    || /(^|[^<])>{1,2}\s*[^&]/.test(text);
}

module.exports = {
  // ── Sandbox ──────────────────────────────────────────────────────────────────
  shell: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a bash command inside your isolated sandbox container. Working directory is /workspace. Has Python 3, Node.js 20, npm, git, curl pre-installed. Output capped at 8000 chars. Default timeout 60s — pass timeout_seconds (max 600) for commands that legitimately need longer (installs, builds). Commands must be non-interactive (use --yes/--no-input flags).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Bash command to run' },
            timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds (default 60, max 600). Raise for package installs and builds.' },
          },
          required: ['command'],
        },
      },
    },
    async handler({ command, timeout_seconds }, { callerAgentId }) {
      const sandbox = require('../sandbox');
      if (sandbox.workspaceMount(callerAgentId).readOnly && isSourceMutationCommand(command)) {
        return {
          stdout: '', exitCode: 1,
          stderr: 'BLOCKED: this Colony role has a read-only repository. Install/fix/format/git-write/file-mutation commands are not allowed. Run non-mutating checks only; if dependencies are unavailable, report the verification gap.',
          policy_violation: 'read_only_repository',
        };
      }
      // Hard policy, not a prompt suggestion: models ignore the prompt ban
      // mid-frenzy and this command reliably destroys dependency trees
      // (observed twice: force-downgraded next@15 to next@9 / react@16).
      if (isPackageInstallCommand(command) && isMediaBackendInstallTarget(command)) {
        return {
          stdout: '',
          stderr: `BLOCKED: ${mediaBackendInstallHint()}`,
          exitCode: 1,
          media_backend_hint: mediaBackendInstallHint(),
        };
      }
      if (/npm\s+audit\s+fix\b[^|;&]*--force/.test(command)) {
        return {
          stdout: '', exitCode: 1,
          stderr: 'BLOCKED: "npm audit fix --force" is disabled in Hive sandboxes — it up/downgrades major versions and destroys the dependency tree. Report the vulnerabilities in your handoff instead; do NOT attempt other workarounds to silence audit warnings.',
        };
      }
      const secs = Math.min(600, Math.max(5, Number(timeout_seconds) || 60));
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, command, secs * 1000);
      const result = { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
      // npm peer-dependency conflict (ERESOLVE) is a recoverable, non-network
      // failure — a real run stalled here because the model treated it as a
      // hard blocker. Hand back the sanctioned escape hatch at the failure site.
      if (exitCode !== 0 && /ERESOLVE|unable to resolve dependency tree/i.test(stderr + stdout)
          && /npm (install|i|ci)\b/.test(command) && !/--legacy-peer-deps|--force/.test(command)) {
        result.resolve_hint = 'ERESOLVE is a peer-dependency conflict, NOT a network problem. Re-run once as "npm install --legacy-peer-deps" (or add "--force" as a last resort). This is allowed — only "npm audit fix --force" is blocked. Do not report this as an access/network blocker.';
      }
      if (exitCode === 124) {
        // Turn a bare timeout into a diagnosis the model can act on. The most
        // common causes: a long-running server (never exits — use start_server),
        // no network (downloads hang forever in a network=none sandbox), an
        // interactive prompt, or a genuinely long install.
        const looksLikeServer = /\b(npm run dev|yarn dev|pnpm dev|next dev|vite(\s|$)|nodemon|uvicorn|flask run|rails s|serve\b|http-server|npm start|node .*server)/.test(command);
        result.timeout_hint = looksLikeServer
          ? `TIMED OUT after ${secs}s — this looks like a LONG-RUNNING SERVER, which never exits, so shell will always time out on it (a run once stalled 5 minutes this way). Use start_server(command, port) instead: it launches in the background and returns the URL immediately.`
          : sandbox.sandboxNetwork(callerAgentId) === 'none'
            ? 'TIMED OUT — this sandbox has NO network access. Downloads/installs (npm, pip, npx create-*) can NEVER succeed here and retrying will not help. Hand this work to a coding role (software_developer, qa_engineer, devops_engineer) whose sandbox has network.'
            : `TIMED OUT after ${secs}s. If the command legitimately needs longer (installs, builds), re-run once with timeout_seconds up to 600. If it may be waiting on an interactive prompt, add non-interactive flags (--yes, --no-input). Do not retry the identical command unchanged.`;
      }
      return result;
    },
  },

  run_python: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'run_python',
        description: 'Execute Python 3 code in the sandbox. Available packages: requests, httpx, flask, fastapi, uvicorn, numpy, pandas, matplotlib, beautifulsoup4, sqlalchemy, pytest, black. Install others with install_package.',
        parameters: {
          type: 'object',
          properties: {
            code:     { type: 'string', description: 'Python source code' },
            filename: { type: 'string', description: 'Optional filename to save as (default: _run.py). Use this when the script imports other local files.' },
          },
          required: ['code'],
        },
      },
    },
    async handler({ code, filename = '_run.py' }, { callerAgentId }) {
      const sandbox = require('../sandbox');
      const safe    = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpFile = `/tmp/${safe}`;
      // Pipe the source via stdin — embedding it in the command string
      // (base64 or otherwise) hits ARG_MAX on large payloads.
      await sandbox.exec(callerAgentId, `cat > ${tmpFile}`, undefined, { input: code });
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, `python3 ${tmpFile}`);
      return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
    },
  },

  install_package: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'install_package',
        description: 'Install a Python (pip) or Node.js (npm) package in the sandbox. Do not use this for Hive media backends such as Orpheus, SNAC, FLUX, or TTS; those run through host-side media tools.',
        parameters: {
          type: 'object',
          properties: {
            package:  { type: 'string', description: 'Package name, e.g. "scikit-learn" or "express"' },
            manager:  { type: 'string', enum: ['pip', 'npm'], description: 'Package manager to use (default: pip)' },
          },
          required: ['package'],
        },
      },
    },
    async handler({ package: pkg, manager = 'pip' }, { callerAgentId }) {
      const sandbox = require('../sandbox');
      if (isMediaBackendInstallTarget(pkg)) {
        const message = mediaBackendInstallHint();
        return { success: false, message, stdout: '', exitCode: 1, media_backend_hint: message };
      }
      // pipefail is load-bearing: without it the exit code is tail's (always 0)
      // and a failed install is reported as success.
      const cmd = manager === 'npm'
        ? `set -o pipefail; npm install -g ${pkg} 2>&1 | tail -5`
        : `set -o pipefail; pip install --quiet ${pkg} 2>&1 | tail -10`;
      const { stdout, exitCode } = await sandbox.exec(callerAgentId, cmd, 120_000);
      // Provide an unambiguous success/failure flag so the model doesn't mistake
      // pip's "WARNING: Running pip as root" for a failed install and retry endlessly.
      const success = exitCode === 0;
      const noNetwork = /EAI_AGAIN|ENOTFOUND|Temporary failure in name resolution|ETIMEDOUT/.test(stdout);
      const message = success
        ? `${pkg} installed successfully (exit 0). Do NOT call install_package again for this package.`
        : noNetwork
          ? `Install failed (exit ${exitCode}): the sandbox has no network access. Do NOT retry — report this as a capability blocker.`
          : `Install failed (exit ${exitCode}).`;
      return { success, message, stdout: stdout.slice(0, 2000), exitCode };
    },
  },

  start_server: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'start_server',
        description: 'Start a web server in the sandbox background. Returns the external URL the user can open. Use ports 3000, 5000, 8000, or 8080 — these are pre-forwarded to your host.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to start the server, e.g. "python3 app.py" or "node server.js" or "uvicorn main:app --host 0.0.0.0 --port 8000"' },
            port:    { type: 'number', description: 'Port the server listens on inside the container (3000, 5000, 8000, or 8080)' },
            label:   { type: 'string', description: 'Short label for this server, e.g. "Flask app"' },
          },
          required: ['command', 'port'],
        },
      },
    },
    async handler({ command, port, label = 'server' }, { callerAgentId }) {
      const sandbox   = require('../sandbox');
      const logFile   = `/tmp/hive_server_${port}.log`;
      const pid       = await sandbox.execBackground(callerAgentId, command, logFile);
      // Give it a moment to start
      await new Promise(r => setTimeout(r, 1500));
      const hp = sandbox.hostPort(callerAgentId, port);
      const url = hp ? `http://localhost:${hp}` : null;
      // Tail the log for early errors
      const { stdout: log } = await sandbox.exec(callerAgentId, `tail -20 ${logFile} 2>/dev/null || echo ""`);
      return {
        success: !!pid,
        pid,
        label,
        container_port: port,
        host_url: url || `(port ${port} not forwarded — use 3000, 5000, 8000, or 8080)`,
        log: log.slice(0, 1000),
      };
    },
  },

  stop_server: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'stop_server',
        description: 'Stop a server running in the sandbox by port number.',
        parameters: {
          type: 'object',
          properties: {
            port: { type: 'number', description: 'Port the server is running on' },
          },
          required: ['port'],
        },
      },
    },
    async handler({ port }, { callerAgentId }) {
      const sandbox = require('../sandbox');
      const { stdout, exitCode } = await sandbox.exec(
        callerAgentId,
        `fuser -k ${port}/tcp 2>/dev/null && echo "stopped" || echo "nothing on port ${port}"`,
      );
      return { result: stdout.trim(), exitCode };
    },
  },

  list_processes: {
    group: 'sandbox',
    definition: {
      type: 'function',
      function: {
        name: 'list_processes',
        description: 'List running processes in the sandbox.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    async handler(_, { callerAgentId }) {
      const sandbox = require('../sandbox');
      const { stdout } = await sandbox.exec(callerAgentId, `ps aux --no-headers 2>/dev/null | grep -v 'ps aux\\|tail -f' | head -20`);
      return { processes: stdout.trim().split('\n').filter(Boolean) };
    },
  },

  write_file: {
    groups: ['sandbox', 'sandbox_files'],
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or overwrite a file in the sandbox workspace. Path is relative to /workspace. NOTE: the sandbox workspace is ephemeral and is NOT delivered — if this file is a deliverable (report, dataset, doc), call save_artifact afterward to promote it to the run artifacts, or it will not reach the colony overview or Discord.',
        parameters: {
          type: 'object',
          properties: {
            path:    { type: 'string', description: 'File path relative to /workspace, e.g. "app.py" or "src/index.js"' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    async handler({ path: filePath, content }, { callerAgentId }) {
      const sandbox  = require('../sandbox');
      if (sandbox.workspaceMount(callerAgentId).readOnly) {
        return { error: 'BLOCKED: this Colony role has a read-only repository. Save reports with save_artifact instead of write_file.' };
      }
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: true });
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, content, 'utf8');
        return { success: true, path: filePath, bytes: content.length };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  read_file: {
    groups: ['sandbox', 'sandbox_files'],
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file from the sandbox workspace. Path is relative to /workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to /workspace' },
          },
          required: ['path'],
        },
      },
    },
    async handler({ path: filePath }, { callerAgentId }) {
      const sandbox  = require('../sandbox');
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: false });
        const content = fs.readFileSync(resolved, 'utf8');
        return { content: content.slice(0, 16000), truncated: content.length > 16000 };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  // Files written with write_file live only in this agent's ephemeral sandbox
  // workspace — they are NOT part of the run's deliverables. save_artifact
  // promotes them into the run's artifact directory, which is the single set the
  // colony overview serves for download and the Discord relay uploads. Generated
  // media (generate_image/generate_speech) auto-registers there; this is the path
  // for reports, datasets, and other non-media files the crew authors as files.
  save_artifact: {
    groups: ['sandbox', 'sandbox_files', 'media'],
    definition: {
      type: 'function',
      function: {
        name: 'save_artifact',
        description: 'Persist a file as a run deliverable so it downloads from the colony overview and posts to Discord. Files you write with write_file stay in your ephemeral sandbox and are NOT delivered — call this to promote them. Give `source_path` to copy an existing /workspace file (preferred for anything you already wrote), or `content` to write inline text directly. Do NOT use this for images/audio from generate_image/generate_speech — those are saved automatically.',
        parameters: {
          type: 'object',
          properties: {
            source_path: { type: 'string', description: 'Path of an existing file in your sandbox workspace to promote, relative to /workspace (e.g. "research_artifact.md"). Preferred over content for files you already wrote.' },
            content: { type: 'string', description: 'Inline text content to save, when the file is not already in the workspace. Ignored if source_path is given.' },
            name: { type: 'string', description: 'Filename to expose in the deliverables (e.g. "research_artifact_2026_2027.md"). Defaults to the basename of source_path.' },
          },
          required: [],
        },
      },
    },
    async handler({ source_path, content, name }, { callerAgentId, colonyContext }) {
      const artifacts = require('../colonyArtifacts');
      // Mirror mediaTools: a colony run uses its own bucket; outside one, a
      // per-agent adhoc bucket under the same root.
      const bucket = colonyContext?.colonyId || `adhoc-${String(callerAgentId || 'agent').slice(0, 60)}`;
      let data;
      let filename = name;
      if (source_path != null && String(source_path).trim()) {
        const sandbox = require('../sandbox');
        try {
          const dir = sandbox.workspaceDir(callerAgentId);
          const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(source_path), { allowMissing: false });
          data = fs.readFileSync(resolved); // Buffer — preserves binary datasets
        } catch (e) {
          return { error: e.message };
        }
        if (!filename) filename = path.basename(String(source_path));
      } else if (content != null) {
        data = String(content);
      } else {
        return { error: 'Provide source_path (a workspace file to promote) or content (inline text).' };
      }
      let saved;
      try {
        saved = artifacts.saveArtifact(bucket, filename || 'artifact', data);
      } catch (e) {
        return { error: e.message };
      }
      const mime = artifacts.mimeFor(saved.name);
      // Fold into the deliverable so the overview + relay surface it (same channel
      // media tools use). See colonyPlanTools generatedArtifacts handling.
      if (colonyContext) (colonyContext.generatedArtifacts ||= []).push({ name: saved.name, mime, kind: 'file' });
      return {
        success: true, artifact: saved.name, mime, kind: 'file', bytes: saved.bytes,
        url: `/api/artifacts/${encodeURIComponent(bucket)}/${encodeURIComponent(saved.name)}`,
        message: `Saved "${saved.name}" to the run artifacts. It downloads from the colony overview and posts to Discord.`,
      };
    },
  },

  delete_file: {
    groups: ['sandbox', 'sandbox_files'],
    definition: {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file or directory in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory path relative to /workspace' },
          },
          required: ['path'],
        },
      },
    },
    async handler({ path: filePath }, { callerAgentId }) {
      const sandbox  = require('../sandbox');
      if (sandbox.workspaceMount(callerAgentId).readOnly) {
        return { error: 'BLOCKED: this Colony role has a read-only repository. delete_file is not allowed.' };
      }
      const dir      = sandbox.workspaceDir(callerAgentId);
      try {
        const resolved = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(filePath), { allowMissing: false });
        fs.rmSync(resolved, { recursive: true, force: true });
        return { success: true, deleted: filePath };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  move_file: {
    groups: ['sandbox', 'sandbox_files'],
    definition: {
      type: 'function',
      function: {
        name: 'move_file',
        description: 'Move or rename a file in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source path relative to /workspace' },
            to:   { type: 'string', description: 'Destination path relative to /workspace' },
          },
          required: ['from', 'to'],
        },
      },
    },
    async handler({ from, to }, { callerAgentId }) {
      const sandbox   = require('../sandbox');
      if (sandbox.workspaceMount(callerAgentId).readOnly) {
        return { error: 'BLOCKED: this Colony role has a read-only repository. move_file is not allowed.' };
      }
      const dir       = sandbox.workspaceDir(callerAgentId);
      try {
        const srcRes = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(from), { allowMissing: false });
        const dstRes = sandbox.resolveWorkspacePath(dir, stripWorkspacePrefix(to), { allowMissing: true });
        fs.mkdirSync(path.dirname(dstRes), { recursive: true });
        fs.renameSync(srcRes, dstRes);
        return { success: true, from, to };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

  list_files: {
    groups: ['sandbox', 'sandbox_files'],
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in the sandbox workspace.',
        parameters: {
          type: 'object',
          properties: {
            directory: { type: 'string', description: 'Subdirectory to list (default: workspace root)' },
          },
          required: [],
        },
      },
    },
    async handler({ directory = '.' }, { callerAgentId }) {
      const sandbox = require('../sandbox');
      try {
        return { files: sandbox.listWorkspaceFiles(callerAgentId, stripWorkspacePrefix(directory), { maxDepth: 3, limit: 100 }) };
      } catch (e) {
        return { error: e.message };
      }
    },
  },

};
