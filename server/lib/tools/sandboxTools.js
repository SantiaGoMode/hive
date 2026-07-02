// Sandbox tools (shell/python/files/servers) — run inside the agent's Docker sandbox. (#27)
const fs = require('fs');
const path = require('path');
const { stripWorkspacePrefix } = require('./shared');

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
      const secs = Math.min(600, Math.max(5, Number(timeout_seconds) || 60));
      const { stdout, stderr, exitCode } = await sandbox.exec(callerAgentId, command, secs * 1000);
      const result = { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode };
      if (exitCode === 124) {
        // Turn a bare timeout into a diagnosis the model can act on. The most
        // common causes: no network (downloads hang forever in a network=none
        // sandbox), an interactive prompt, or a genuinely long install.
        result.timeout_hint = sandbox.sandboxNetwork(callerAgentId) === 'none'
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
        description: 'Install a Python (pip) or Node.js (npm) package in the sandbox.',
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
        description: 'Write or overwrite a file in the sandbox workspace. Path is relative to /workspace.',
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
