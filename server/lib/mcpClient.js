/**
 * MCP (Model Context Protocol) client manager.
 *
 * Supports two transports:
 *   stdio  — spawn a local process, communicate via newline-delimited JSON-RPC on stdin/stdout
 *   http   — POST JSON-RPC requests to an HTTP endpoint
 *
 * Tool naming in Ollama:  {serverId}__{toolName}
 *   e.g. server ID "abc123", tool "read_file" → "abc123__read_file"
 *   On tool call: split on first "__" to resolve server + original tool name.
 */

const { spawn } = require('child_process');
const readline   = require('readline');
const db         = require('../db');
const { parseEnvRef, resolveSecret } = require('./secrets');

const MCP_TIMEOUT_MS     = 45_000;   // generous for first-time npx download
const MCP_PROTOCOL       = '2024-11-05';
const MCP_RESULT_MAX_LEN = 8_000;    // cap tool results to avoid blowing context window
const MCP_RECONNECT_DELAYS = [2_000, 5_000, 15_000]; // exponential backoff in ms

function resolveEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    out[key] = resolveSecret(value);
  }
  return out;
}

function maskEnvForStatus(env = {}, secretKeys = []) {
  const secrets = new Set(secretKeys || []);
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    out[key] = secrets.has(key) && value && !parseEnvRef(value) ? '••••••••' : value;
  }
  return out;
}

// ── Stdio transport ────────────────────────────────────────────────────────────

class StdioMcpConnection {
  constructor(command, args, env) {
    this.command   = command;
    this.args      = args;
    this.env       = { ...process.env, ...resolveEnv(env) };
    this.proc      = null;
    this.pending   = new Map();   // id → { resolve, reject, timer }
    this._nextId   = 1;
    this.connected = false;
    this._stderr   = '';          // captured stderr for error messages
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.proc = spawn(this.command, this.args, {
        env:   this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Capture stderr — used to build meaningful error messages
      this.proc.stderr.on('data', d => {
        this._stderr += d.toString();
      });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
          // Notifications (no id) — ignore for now
        } catch {}
      });

      this.proc.on('error', (spawnErr) => {
        const detail = this._stderrSnippet();
        const err = new Error(detail ? `${spawnErr.message} — ${detail}` : spawnErr.message);
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
        this.pending.clear();
        this.connected = false;
        reject(err);
      });

      this.proc.on('exit', (code) => {
        const detail = this._stderrSnippet();
        const base   = `Process exited${code != null ? ` (code ${code})` : ''}`;
        const err    = new Error(detail ? `${base}: ${detail}` : base);
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(err);
        }
        this.pending.clear();
        this.connected = false;
      });

      this._call('initialize', {
        protocolVersion: MCP_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'hive', version: '1.0' },
      }).then((result) => {
        // Send initialized notification (no response expected)
        this._notify('notifications/initialized');
        this.connected = true;
        resolve(result);
      }).catch((err) => {
        this.disconnect();
        reject(err);
      });
    });
  }

  // Return a cleaned-up snippet of stderr for error messages (max 300 chars)
  _stderrSnippet() {
    return this._stderr.trim().replace(/\s+/g, ' ').slice(0, 300) || null;
  }

  _notify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try { this.proc?.stdin?.write(msg); } catch {}
  }

  _call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('Not connected'));
      const id = this._nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP timeout: ${method}`));
        }
      }, MCP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.proc.stdin.write(msg);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async listTools() {
    const result = await this._call('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args) {
    const result = await this._call('tools/call', { name, arguments: args });
    return extractContent(result);
  }

  disconnect() {
    try { this.proc?.kill(); } catch {}
    this.proc = null;
    this.connected = false;
    this._stderr = '';
  }
}

// ── HTTP transport ─────────────────────────────────────────────────────────────

class HttpMcpConnection {
  constructor(url) {
    this.url       = url;
    this._nextId   = 1;
    this.connected = false;
  }

  async connect() {
    const result = await this._call('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'hive', version: '1.0' },
    });
    // Send initialized notification (fire-and-forget for HTTP)
    this._call('notifications/initialized', {}).catch(() => {});
    this.connected = true;
    return result;
  }

  async _call(method, params = {}) {
    const id  = this._nextId++;
    const res = await fetch(this.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal:  AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }

  async listTools() {
    const result = await this._call('tools/list', {});
    return result.tools || [];
  }

  async callTool(name, args) {
    const result = await this._call('tools/call', { name, arguments: args });
    return extractContent(result);
  }

  disconnect() { this.connected = false; }
}

// ── Content extraction ─────────────────────────────────────────────────────────
// MCP tool results are { content: [{ type, text }], isError?: boolean }
// Returns a plain string for the agent, capped at MCP_RESULT_MAX_LEN chars.

function extractContent(result) {
  const isError = result?.isError === true;
  const content = result?.content;

  let text;
  if (!content) {
    text = JSON.stringify(result);
  } else if (!Array.isArray(content)) {
    text = String(content);
  } else {
    text = content.map(c => {
      if (c.type === 'text')  return c.text;
      if (c.type === 'image') return `[image: ${c.mimeType || 'unknown'}]`;
      return JSON.stringify(c);
    }).join('\n');
  }

  // Surface isError so the agent knows the call failed rather than silently proceeding
  if (isError) text = `[MCP ERROR] ${text}`;

  // Truncate large results to avoid overflowing the context window
  if (text.length > MCP_RESULT_MAX_LEN) {
    text = text.slice(0, MCP_RESULT_MAX_LEN) +
      `\n\n[Result truncated — ${text.length.toLocaleString()} chars total, showing first ${MCP_RESULT_MAX_LEN.toLocaleString()}]`;
  }

  return text;
}

// ── MCP Manager ────────────────────────────────────────────────────────────────

class McpManager {
  constructor() {
    // serverId → { connection, server, tools: McpTool[] }
    this.clients      = new Map();
    // 'serverId__toolName' → serverId  (for fast tool dispatch)
    this.toolIndex    = new Map();
    // serverId → error string (set on failed connect, cleared on success)
    this.lastErrors   = new Map();
    // serverId → true while a background reconnect is running
    this._reconnecting = new Set();
  }

  // Called at server startup
  async loadAll() {
    const servers = db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all();
    for (const server of servers) {
      try {
        await this._connect(server);
      } catch (e) {
        this.lastErrors.set(server.id, e.message);
        console.warn(`[mcp] Failed to connect "${server.name}": ${e.message}`);
      }
    }
  }

  // Connect a single server config and cache its tools
  async _connect(server) {
    const env = JSON.parse(server.env || '{}');
    const conn = server.transport === 'http'
      ? new HttpMcpConnection(server.url)
      : new StdioMcpConnection(
          server.command,
          JSON.parse(server.args  || '[]'),
          env,
        );

    await conn.connect();
    const tools = await conn.listTools();

    // Register tools in index
    for (const tool of tools) {
      this.toolIndex.set(`${server.id}__${tool.name}`, server.id);
    }

    this.clients.set(server.id, { connection: conn, server, tools });
    this.lastErrors.delete(server.id);
    this._reconnecting.delete(server.id);
    console.log(`[mcp] Connected "${server.name}" (${tools.length} tool${tools.length !== 1 ? 's' : ''})`);

    // Auto-reconnect when a stdio process exits unexpectedly
    if (conn.proc) {
      conn.proc.once('exit', () => {
        // Only act if this specific connection is still the active one (i.e. not manually disconnected)
        if (this.clients.get(server.id)?.connection === conn) {
          console.warn(`[mcp] "${server.name}" exited unexpectedly — scheduling reconnect`);
          this.clients.delete(server.id);
          this.lastErrors.set(server.id, 'Process exited unexpectedly — reconnecting…');
          // Keep toolIndex intact so isMcpTool() still resolves during reconnect window
          this._autoReconnect(server.id, 0);
        }
      });
    }

    return tools;
  }

  // Exponential-backoff reconnect — called after unexpected process exit.
  // Attempts: attempt 0 → 2s, 1 → 5s, 2 → 15s, then gives up.
  _autoReconnect(serverId, attempt) {
    if (attempt >= MCP_RECONNECT_DELAYS.length) {
      console.warn(`[mcp] "${serverId}" — gave up after ${MCP_RECONNECT_DELAYS.length} reconnect attempts`);
      this.lastErrors.set(serverId, `Auto-reconnect failed after ${MCP_RECONNECT_DELAYS.length} attempts`);
      this._reconnecting.delete(serverId);
      return;
    }
    this._reconnecting.add(serverId);
    const delay = MCP_RECONNECT_DELAYS[attempt];
    setTimeout(async () => {
      const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
      if (!server || !server.enabled) {
        this._reconnecting.delete(serverId);
        return;
      }
      console.log(`[mcp] Reconnecting "${server.name}" (attempt ${attempt + 1}/${MCP_RECONNECT_DELAYS.length})…`);
      try {
        await this._connect(server);
        console.log(`[mcp] Reconnected "${server.name}" successfully`);
      } catch (e) {
        this.lastErrors.set(serverId, e.message);
        this._autoReconnect(serverId, attempt + 1);
      }
    }, delay);
  }

  // Reconnect after a config change
  async reconnect(serverId) {
    this.disconnect(serverId);
    const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
    if (!server || !server.enabled) return;
    try {
      await this._connect(server);
    } catch (e) {
      this.lastErrors.set(serverId, e.message);
      throw e;
    }
  }

  disconnect(serverId) {
    this._reconnecting.delete(serverId);
    const entry = this.clients.get(serverId);
    if (!entry) return;
    entry.connection.disconnect();
    // Remove tools from index
    for (const key of [...this.toolIndex.keys()]) {
      if (key.startsWith(`${serverId}__`)) this.toolIndex.delete(key);
    }
    this.clients.delete(serverId);
  }

  // Test a server config without persisting — used by the /test endpoint
  // args and env may be already-parsed (from req.body) or raw strings (from DB)
  async test(serverConfig) {
    const args = Array.isArray(serverConfig.args)
      ? serverConfig.args
      : JSON.parse(serverConfig.args || '[]');
    const env = serverConfig.env && typeof serverConfig.env === 'object'
      ? serverConfig.env
      : JSON.parse(serverConfig.env || '{}');

    const conn = serverConfig.transport === 'http'
      ? new HttpMcpConnection(serverConfig.url)
      : new StdioMcpConnection(serverConfig.command, args, env);
    try {
      await conn.connect();
      const tools = await conn.listTools();
      conn.disconnect();
      return { success: true, tool_count: tools.length, tools: tools.map(t => t.name) };
    } catch (err) {
      try { conn.disconnect(); } catch {}
      throw err;
    }
  }

  // Return Ollama-format tool definitions for a list of server IDs
  getToolDefinitions(serverIds = []) {
    const defs = [];
    for (const serverId of serverIds) {
      const entry = this.clients.get(serverId);
      if (!entry) continue;
      for (const tool of entry.tools) {
        defs.push({
          type: 'function',
          function: {
            name:        `${serverId}__${tool.name}`,
            description: `[${entry.server.name}] ${tool.description || ''}`.trim(),
            parameters:  tool.inputSchema || { type: 'object', properties: {} },
          },
        });
      }
    }
    return defs;
  }

  isMcpTool(toolName) {
    return this.toolIndex.has(toolName);
  }

  async callTool(namespacedName, args) {
    const serverId = this.toolIndex.get(namespacedName);
    if (!serverId) throw new Error(`Unknown MCP tool: ${namespacedName}`);

    let entry = this.clients.get(serverId);
    if (!entry) {
      // Server disconnected — attempt inline reconnect before failing
      if (this._reconnecting.has(serverId)) {
        throw new Error(`MCP server is reconnecting — try again in a moment`);
      }
      const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
      if (!server?.enabled) throw new Error(`MCP server not connected: ${serverId}`);
      console.log(`[mcp] "${server.name}" disconnected at call time — attempting reconnect`);
      try {
        await this._connect(server);
        entry = this.clients.get(serverId);
      } catch (e) {
        throw new Error(`MCP server reconnect failed: ${e.message}`);
      }
    }

    const actualName = namespacedName.slice(serverId.length + 2); // strip 'serverId__'
    return entry.connection.callTool(actualName, args);
  }

  // Resolve a namespaced tool name to its server name (for display in UI)
  getServerName(namespacedName) {
    const serverId = this.toolIndex.get(namespacedName);
    if (!serverId) return null;
    return this.clients.get(serverId)?.server?.name ?? null;
  }

  // Returns server list with connection status, tool info, and last error
  getStatus() {
    const servers = db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all();
    return servers.map(s => {
      const client = this.clients.get(s.id);
      const env = JSON.parse(s.env || '{}');
      const secretKeys = JSON.parse(s.env_secret_keys || '[]');
      return {
        ...s,
        args:            JSON.parse(s.args            || '[]'),
        env:             maskEnvForStatus(env, secretKeys),
        env_secret_keys: secretKeys,
        connected:       !!client,
        tool_count:      client?.tools?.length ?? 0,
        tool_names:      client?.tools?.map(t => t.name) ?? [],
        last_error:      this.lastErrors.get(s.id) ?? null,
      };
    });
  }
}

const manager = new McpManager();
manager._test = { resolveEnv, maskEnvForStatus };

module.exports = manager;
