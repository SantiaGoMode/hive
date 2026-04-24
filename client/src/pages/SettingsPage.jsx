import { useState, useEffect, useCallback } from 'react';
import {
  Trash2, Plus, RefreshCw, CheckCircle, XCircle, Loader, ChevronDown, ChevronUp,
  AlertTriangle, Eye, EyeOff, Lock, Unlock, ChevronRight, ArrowLeft, Wrench, ExternalLink,
  Sun, Moon, Type, Cpu, Square, Wifi, WifiOff, MemoryStick,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { toast } from '../stores/toastStore';
import { useThemeStore, ACCENT_PRESETS } from '../stores/themeStore';

// ── MCP Preset Catalogue ──────────────────────────────────────────────────────

const MCP_PRESETS = [
  // ── Files & Storage ──────────────────────────────────────────────────────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'Files & Storage',
    description: 'Read, write, search, and manage local files and directories',
    icon: '📁',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-filesystem <ALLOWED_PATH>',
    envTemplate: [],
    note: 'Replace <ALLOWED_PATH> with the directory to expose, e.g. /Users/you/projects',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    category: 'Files & Storage',
    description: 'Query and manage a local SQLite database file',
    icon: '🗄️',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sqlite <DB_PATH>',
    envTemplate: [],
    note: 'Replace <DB_PATH> with the path to your .db file',
  },
  // ── Dev Tools ────────────────────────────────────────────────────────────────
  {
    id: 'git',
    name: 'Git',
    category: 'Dev Tools',
    description: 'Git operations: log, diff, commit, branch management',
    icon: '🌿',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-git --repository <REPO_PATH>',
    envTemplate: [],
    note: 'Replace <REPO_PATH> with the path to your git repository',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Dev Tools',
    description: 'Search repos, manage issues, PRs, and files via GitHub API',
    icon: '🐙',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-github',
    envTemplate: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', secret: true, description: 'Personal access token (repo scope) — create at github.com/settings/tokens' },
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    category: 'Dev Tools',
    description: 'Manage GitLab projects, issues, and merge requests',
    icon: '🦊',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-gitlab',
    envTemplate: [
      { key: 'GITLAB_PERSONAL_ACCESS_TOKEN', secret: true, description: 'Personal access token with api scope' },
      { key: 'GITLAB_API_URL', value: 'https://gitlab.com/api/v4', secret: false, description: 'API base URL — change for self-hosted instances' },
    ],
  },
  // ── Databases ────────────────────────────────────────────────────────────────
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'Databases',
    description: 'Query PostgreSQL databases with full SQL support',
    icon: '🐘',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-postgres postgresql://user:password@localhost:5432/database',
    envTemplate: [],
    note: 'Replace the connection string in Args with your actual credentials',
  },
  // ── Web & Search ─────────────────────────────────────────────────────────────
  {
    id: 'brave-search',
    name: 'Brave Search',
    category: 'Web & Search',
    description: 'Real-time web and news search via the Brave Search API',
    icon: '🦁',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-brave-search',
    envTemplate: [
      { key: 'BRAVE_API_KEY', secret: true, description: 'Brave Search API key — get one at brave.com/search/api' },
    ],
  },
  {
    id: 'fetch',
    name: 'Fetch / HTTP',
    category: 'Web & Search',
    description: 'Make HTTP requests and fetch web content or API data',
    icon: '🌐',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-fetch',
    envTemplate: [],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    category: 'Web & Search',
    description: 'Browser automation — take screenshots, fill forms, click elements',
    icon: '🤖',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-puppeteer',
    envTemplate: [],
  },
  // ── Productivity ─────────────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    category: 'Productivity',
    description: 'Read and post Slack messages, manage channels and threads',
    icon: '💬',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-slack',
    envTemplate: [
      { key: 'SLACK_BOT_TOKEN', secret: true, description: 'Bot User OAuth Token (xoxb-...) — create at api.slack.com/apps' },
      { key: 'SLACK_TEAM_ID', secret: false, description: 'Workspace Team ID, e.g. T01ABC123' },
    ],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'Productivity',
    description: 'Read and search files stored in Google Drive',
    icon: '📂',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-gdrive',
    envTemplate: [],
    note: 'Requires Google OAuth setup — see @modelcontextprotocol/server-gdrive README',
  },
  // ── AI & Reasoning ───────────────────────────────────────────────────────────
  {
    id: 'memory',
    name: 'Memory',
    category: 'AI & Reasoning',
    description: 'Persistent knowledge graph memory that survives across sessions',
    icon: '🧠',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-memory',
    envTemplate: [],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    category: 'AI & Reasoning',
    description: 'Structured step-by-step reasoning for complex multi-part problems',
    icon: '🔢',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-sequential-thinking',
    envTemplate: [],
  },
  {
    id: 'everart',
    name: 'EverArt',
    category: 'AI & Reasoning',
    description: 'AI image generation via the EverArt API',
    icon: '🎨',
    transport: 'stdio',
    command: 'npx',
    args: '-y @modelcontextprotocol/server-everart',
    envTemplate: [
      { key: 'EVERART_API_KEY', secret: true, description: 'EverArt API key — get one at everart.ai' },
    ],
  },
];

const PRESET_CATEGORIES = [...new Set(MCP_PRESETS.map(p => p.category))];

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /token|secret|key|password|pass|auth|credential|api_key/i;

const isSecretKey = (key) => SECRET_KEY_RE.test(key);

// Convert { KEY: value } object + secret keys list → row array for EnvEditor
function envToRows(envObj = {}, secretKeys = []) {
  return Object.entries(envObj).map(([key, value]) => ({
    key,
    value,
    secret: secretKeys.includes(key) || isSecretKey(key),
    visible: false,
  }));
}

// Convert row array → { KEY: value } object
const rowsToEnv = (rows) =>
  Object.fromEntries(rows.filter(r => r.key.trim()).map(r => [r.key.trim(), r.value]));

// Extract list of secret key names from rows
const rowsToSecretKeys = (rows) =>
  rows.filter(r => r.secret && r.key.trim()).map(r => r.key.trim());

// ── Env Variable Editor ───────────────────────────────────────────────────────

function EnvEditor({ rows, onChange }) {
  const add = () => onChange([...rows, { key: '', value: '', secret: false, visible: false }]);
  const update = (i, patch) => onChange(rows.map((r, j) => j === i ? { ...r, ...patch } : r));
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));

  // Auto-detect secret on key change
  const handleKeyChange = (i, key) => {
    update(i, { key, secret: isSecretKey(key) });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">Environment Variables</label>
        <button
          onClick={add}
          className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
        >
          <Plus size={11} /> Add variable
        </button>
      </div>

      {rows.length === 0 && (
        <p className="text-xs text-gray-600 italic">No environment variables. Click "Add variable" to add one.</p>
      )}

      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 items-center">
          {/* KEY */}
          <input
            value={row.key}
            onChange={e => handleKeyChange(i, e.target.value)}
            placeholder="KEY"
            className="w-40 flex-shrink-0 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs font-mono text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {/* VALUE */}
          <div className="flex-1 relative">
            <input
              type={row.secret && !row.visible ? 'password' : 'text'}
              value={row.value}
              onChange={e => update(i, { value: e.target.value })}
              placeholder={row.secret ? '••••••••' : 'value'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 pr-7 text-xs font-mono text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {row.secret && (
              <button
                onClick={() => update(i, { visible: !row.visible })}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                title={row.visible ? 'Hide value' : 'Show value'}
              >
                {row.visible ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
          </div>
          {/* SECRET TOGGLE */}
          <button
            onClick={() => update(i, { secret: !row.secret, visible: false })}
            title={row.secret ? 'Mark as plain text' : 'Mark as secret (masked)'}
            className={`p-1.5 rounded-lg transition-colors ${row.secret ? 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/20' : 'text-gray-600 hover:text-gray-400 hover:bg-gray-700'}`}
          >
            {row.secret ? <Lock size={12} /> : <Unlock size={12} />}
          </button>
          {/* DELETE */}
          <button
            onClick={() => remove(i)}
            className="p-1.5 text-gray-600 hover:text-red-400 rounded-lg hover:bg-red-500/10 transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      {rows.some(r => r.secret) && (
        <p className="text-xs text-amber-600/80 flex items-center gap-1">
          <Lock size={10} /> Secret values are stored locally on disk — masked in the UI only.
        </p>
      )}
    </div>
  );
}

// ── Preset Gallery ────────────────────────────────────────────────────────────

function PresetGallery({ onSelect, onCustom }) {
  const [activeCategory, setActiveCategory] = useState('All');
  const categories = ['All', ...PRESET_CATEGORIES];

  const visible = activeCategory === 'All'
    ? MCP_PRESETS
    : MCP_PRESETS.filter(p => p.category === activeCategory);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-semibold text-gray-100 mb-0.5">Choose a preset</h3>
        <p className="text-xs text-gray-500">Pre-configured for popular MCP servers. All use <code className="bg-gray-800 px-1 rounded">npx -y</code> — no global install needed.</p>
      </div>

      {/* Category filter */}
      <div className="flex gap-1.5 flex-wrap">
        {categories.map(c => (
          <button
            key={c}
            onClick={() => setActiveCategory(c)}
            className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${activeCategory === c ? 'border-blue-500/60 bg-blue-500/10 text-blue-400' : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300'}`}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Preset cards */}
      <div className="grid grid-cols-2 gap-2 max-h-[42vh] overflow-y-auto pr-1">
        {visible.map(preset => (
          <button
            key={preset.id}
            onClick={() => onSelect(preset)}
            className="flex items-start gap-3 p-3 rounded-lg border border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 text-left transition-colors group"
          >
            <span className="text-2xl flex-shrink-0 mt-0.5">{preset.icon}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-gray-200">{preset.name}</p>
              </div>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{preset.description}</p>
              {preset.envTemplate?.length > 0 && (
                <p className="text-xs text-amber-600/80 mt-1 flex items-center gap-1">
                  <Lock size={9} /> {preset.envTemplate.filter(e => e.secret).length} credential{preset.envTemplate.filter(e => e.secret).length !== 1 ? 's' : ''} required
                </p>
              )}
            </div>
          </button>
        ))}
      </div>

      <div className="border-t border-gray-800 pt-3">
        <button
          onClick={onCustom}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          <Wrench size={13} />
          Custom setup (stdio or HTTP, manual config)
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

// ── MCP Server Modal ──────────────────────────────────────────────────────────

const BLANK_FORM = { name: '', transport: 'stdio', command: '', args: '', url: '', envRows: [] };

function McpServerModal({ open, server, onClose, onSave }) {
  const [step, setStep] = useState('preset'); // 'preset' | 'form'
  const [selectedPreset, setSelectedPreset] = useState(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (server) {
      // Editing: skip gallery
      setStep('form');
      setSelectedPreset(null);
      setForm({
        name:      server.name,
        transport: server.transport,
        command:   server.command || '',
        args:      Array.isArray(server.args) ? server.args.join(' ') : (server.args || ''),
        url:       server.url || '',
        envRows:   envToRows(server.env, server.env_secret_keys || []),
      });
    } else {
      setStep('preset');
      setSelectedPreset(null);
      setForm(BLANK_FORM);
    }
    setTestResult(null);
  }, [open, server]);

  if (!open) return null;

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setTestResult(null); };

  const applyPreset = (preset) => {
    setSelectedPreset(preset);
    setForm({
      name:      preset.name,
      transport: preset.transport,
      command:   preset.command,
      args:      preset.args,
      url:       preset.url || '',
      envRows:   (preset.envTemplate || []).map(t => ({
        key:     t.key,
        value:   t.value || '',
        secret:  t.secret ?? isSecretKey(t.key),
        visible: false,
        hint:    t.description,
      })),
    });
    setTestResult(null);
    setStep('form');
  };

  const buildPayload = () => ({
    name:            form.name.trim(),
    transport:       form.transport,
    command:         form.transport === 'stdio' ? (form.command.trim() || undefined) : undefined,
    args:            form.transport === 'stdio' && form.args.trim()
                       ? form.args.trim().split(/\s+/)
                       : [],
    env:             rowsToEnv(form.envRows),
    env_secret_keys: rowsToSecretKeys(form.envRows),
    url:             form.transport === 'http' ? (form.url.trim() || undefined) : undefined,
  });

  const hasPlaceholders = /\<[A-Z_]+\>/.test(form.args);

  const handleTest = async () => {
    if (!form.name.trim()) return toast.error('Name is required');
    if (form.transport === 'stdio' && !form.command.trim()) return toast.error('Command is required');
    if (form.transport === 'http'  && !form.url.trim())    return toast.error('URL is required');
    if (hasPlaceholders) return toast.error('Replace all <PLACEHOLDER> values in Args before testing');
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testMcpServer(buildPayload());
      setTestResult({ ok: true, ...result });
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = () => {
    if (!form.name.trim()) return toast.error('Name is required');
    if (form.transport === 'stdio' && !form.command.trim()) return toast.error('Command is required');
    if (form.transport === 'http'  && !form.url.trim())    return toast.error('URL is required');
    if (hasPlaceholders) return toast.error('Replace all <PLACEHOLDER> values in Args before saving');
    onSave(buildPayload());
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-700 flex items-center gap-3">
          {step === 'form' && !server && (
            <button onClick={() => setStep('preset')} className="p-1 text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800">
              <ArrowLeft size={15} />
            </button>
          )}
          <div className="flex-1">
            <h3 className="font-semibold text-gray-100">
              {server ? `Edit: ${server.name}` : step === 'preset' ? 'Add MCP Server' : selectedPreset ? `Configure: ${selectedPreset.name}` : 'Custom MCP Server'}
            </h3>
            {selectedPreset && step === 'form' && (
              <p className="text-xs text-gray-500 mt-0.5">{selectedPreset.icon} {selectedPreset.description}</p>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-4 flex flex-col gap-4 overflow-y-auto flex-1">
          {step === 'preset' && (
            <PresetGallery onSelect={applyPreset} onCustom={() => { setSelectedPreset(null); setStep('form'); }} />
          )}

          {step === 'form' && (
            <>
              <Input label="Name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. GitHub Tools" />

              <div>
                <label className="text-sm font-medium text-gray-300 block mb-1">Transport</label>
                <div className="flex gap-2">
                  {['stdio', 'http'].map(t => (
                    <button
                      key={t}
                      onClick={() => set('transport', t)}
                      className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${form.transport === t ? 'border-blue-500/60 bg-blue-500/10 text-blue-400' : 'border-gray-700 text-gray-400 hover:border-gray-600'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {form.transport === 'stdio' ? (
                <>
                  <Input
                    label="Command"
                    value={form.command}
                    onChange={e => set('command', e.target.value)}
                    placeholder="npx"
                    className="font-mono text-sm"
                  />
                  <div>
                    <label className="text-sm font-medium text-gray-300 block mb-1">
                      Arguments <span className="text-gray-500 font-normal">(space-separated)</span>
                    </label>
                    <input
                      value={form.args}
                      onChange={e => { set('args', e.target.value); }}
                      placeholder="-y @modelcontextprotocol/server-filesystem /path"
                      className={`w-full bg-gray-800 border rounded-lg px-3 py-2 text-sm font-mono text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${hasPlaceholders ? 'border-amber-500/60' : 'border-gray-700'}`}
                    />
                    {hasPlaceholders && (
                      <p className="text-xs text-amber-500 mt-1 flex items-center gap-1">
                        <AlertTriangle size={11} /> Replace <code className="bg-gray-800 px-1 rounded">&lt;PLACEHOLDER&gt;</code> values before saving
                      </p>
                    )}
                    {selectedPreset?.note && !hasPlaceholders && (
                      <p className="text-xs text-gray-500 mt-1">{selectedPreset.note}</p>
                    )}
                  </div>

                  <EnvEditor rows={form.envRows} onChange={rows => set('envRows', rows)} />

                  {/* Per-row hints from preset template */}
                  {form.envRows.some(r => r.hint) && (
                    <div className="flex flex-col gap-1.5 p-3 rounded-lg bg-gray-800/60 border border-gray-700/50">
                      <p className="text-xs font-medium text-gray-400 mb-0.5">Setup guide</p>
                      {form.envRows.filter(r => r.hint).map((r, i) => (
                        <p key={i} className="text-xs text-gray-500">
                          <code className="text-gray-400">{r.key}</code>: {r.hint}
                        </p>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <Input
                  label="URL"
                  value={form.url}
                  onChange={e => set('url', e.target.value)}
                  placeholder="http://localhost:3002/mcp"
                  className="font-mono text-sm"
                />
              )}

              {testResult && (
                <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${testResult.ok ? 'bg-green-500/5 border-green-500/30 text-green-400' : 'bg-red-500/5 border-red-500/30 text-red-400'}`}>
                  {testResult.ok
                    ? <><CheckCircle size={14} className="flex-shrink-0 mt-0.5" /><span>Connected — {testResult.tool_count} tool{testResult.tool_count !== 1 ? 's' : ''}: {testResult.tools?.join(', ')}</span></>
                    : <><AlertTriangle size={14} className="flex-shrink-0 mt-0.5" /><span>{testResult.error}</span></>
                  }
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {step === 'form' && (
          <div className="px-6 py-4 border-t border-gray-700 flex justify-between items-center">
            <Button variant="secondary" onClick={handleTest} disabled={testing}>
              {testing ? <><Loader size={13} className="animate-spin" /> Testing…</> : 'Test Connection'}
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={handleSave}>Save</Button>
            </div>
          </div>
        )}
        {step === 'preset' && (
          <div className="px-6 py-4 border-t border-gray-700 flex justify-end">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── MCP Server Row ────────────────────────────────────────────────────────────

function McpServerRow({ server, onEdit, onDelete, onReconnect }) {
  const [expanded, setExpanded] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = async () => {
    setReconnecting(true);
    try {
      await onReconnect();
      toast.success('Reconnected');
    } catch (e) { toast.error(e.message); }
    finally { setReconnecting(false); }
  };

  const statusColor = server.connected
    ? 'bg-green-400'
    : server.last_error ? 'bg-red-400' : 'bg-gray-600';
  const statusLabel = server.connected
    ? 'Connected'
    : server.last_error ? `Error: ${server.last_error}` : 'Disconnected';

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor}`}
          title={statusLabel}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200">{server.name}</p>
          <p className="text-xs text-gray-500 truncate">
            {server.transport === 'http' ? server.url : `${server.command} ${Array.isArray(server.args) ? server.args.join(' ') : server.args}`}
            {server.connected && ` · ${server.tool_count} tool${server.tool_count !== 1 ? 's' : ''}`}
          </p>
          {!server.connected && server.last_error && (
            <p className="text-xs text-red-400 truncate mt-0.5">{server.last_error}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!server.connected && (
            <Button size="icon" variant="ghost" onClick={handleReconnect} disabled={reconnecting} title="Reconnect">
              <RefreshCw size={13} className={reconnecting ? 'animate-spin' : ''} />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => setExpanded(e => !e)}>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 bg-gray-900/40 flex flex-col gap-3">
          {/* Tool list */}
          {server.connected && server.tool_names?.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">
                Available tools — reference as <code className="bg-gray-800 px-1 rounded">mcp:{server.id}</code> in agent editor
              </p>
              <div className="flex flex-wrap gap-1.5">
                {server.tool_names.map(name => (
                  <span key={name} className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300 font-mono">
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Not connected state */}
          {!server.connected && (
            <div className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs ${server.last_error ? 'bg-red-500/5 border-red-500/20 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
              {server.last_error
                ? <><AlertTriangle size={12} className="flex-shrink-0 mt-0.5" /><span>{server.last_error}</span></>
                : <span>Server is disconnected. Click the reconnect button to retry.</span>
              }
            </div>
          )}

          {/* Env secret keys hint */}
          {server.env_secret_keys?.length > 0 && (
            <p className="text-xs text-gray-600 flex items-center gap-1">
              <Lock size={10} /> Credentials stored: {server.env_secret_keys.join(', ')}
            </p>
          )}

          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => onEdit(server)}>Edit</Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(server)}>
              <Trash2 size={12} /> Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Appearance Section ────────────────────────────────────────────────────────

function AppearanceSection() {
  const { theme, accent, fontSize, setTheme, setAccent, setFontSize } = useThemeStore();

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-6">
      <h2 className="text-sm font-semibold text-gray-300">Appearance</h2>

      {/* Light / Dark */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-gray-400">Theme</p>
        <div className="flex gap-2">
          {[
            { value: 'dark',  icon: Moon, label: 'Dark'  },
            { value: 'light', icon: Sun,  label: 'Light' },
          ].map(({ value, icon: Icon, label }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                onClick={() => setTheme(value)}
                style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : {}}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors ${
                  active ? '' : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Accent color */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-gray-400">Accent color</p>
        <div className="flex items-center gap-2 flex-wrap">
          {ACCENT_PRESETS.map(({ color, label }) => (
            <button
              key={color}
              title={label}
              onClick={() => setAccent(color)}
              style={{ backgroundColor: color }}
              className={`w-7 h-7 rounded-full transition-transform hover:scale-110 flex-shrink-0 ${
                accent === color ? 'ring-2 ring-offset-2 ring-offset-gray-900 ring-white scale-110' : ''
              }`}
            />
          ))}
          {/* Custom color via native color picker */}
          <label
            title="Custom color"
            className="w-7 h-7 rounded-full border-2 border-dashed border-gray-600 flex items-center justify-center cursor-pointer hover:border-gray-400 transition-colors flex-shrink-0 overflow-hidden"
          >
            <input
              type="color"
              value={accent}
              onChange={e => setAccent(e.target.value)}
              className="opacity-0 absolute w-0 h-0"
            />
            <span className="text-gray-500 text-xs leading-none select-none">+</span>
          </label>
          <span className="text-xs text-gray-500 font-mono ml-1">{accent}</span>
        </div>
      </div>

      {/* Font size */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-gray-400 flex items-center gap-1.5"><Type size={11} /> Font size</p>
        <div className="flex gap-2">
          {[
            { value: 'sm', label: 'S', desc: '13px' },
            { value: 'md', label: 'M', desc: '14px' },
            { value: 'lg', label: 'L', desc: '16px' },
          ].map(({ value, label, desc }) => {
            const active = fontSize === value;
            return (
              <button
                key={value}
                onClick={() => setFontSize(value)}
                title={desc}
                style={active ? { borderColor: 'var(--accent)', color: 'var(--accent)', backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : {}}
                className={`px-4 py-1.5 rounded-lg text-sm border transition-colors ${
                  active ? '' : 'border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── System Monitor ────────────────────────────────────────────────────────────

function fmtBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

function MemBar({ used, total, label }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{label}</span>
        <span>{fmtBytes(used)} / {fmtBytes(total)} <span className="text-gray-600">({pct}%)</span></span>
      </div>
      <div className="h-2 rounded-full bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SystemMonitor() {
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [stopping, setStopping] = useState(null); // model name being stopped

  const refresh = useCallback(async () => {
    try {
      const data = await api.getSystemStatus();
      setStatus(data);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleStop = async (modelName) => {
    setStopping(modelName);
    try {
      await api.stopModel(modelName);
      await refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setStopping(null);
    }
  };

  const mem   = status?.memory;
  const models = status?.models ?? [];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={15} className="text-blue-400" />
          <h2 className="text-sm font-semibold text-gray-300">System Resources</h2>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className={`flex items-center gap-1 text-xs ${status.ollama_reachable ? 'text-green-400' : 'text-red-400'}`}>
              {status.ollama_reachable ? <Wifi size={11} /> : <WifiOff size={11} />}
              Ollama {status.ollama_reachable ? 'connected' : 'unreachable'}
            </span>
          )}
          <button onClick={refresh} className="p-1 text-gray-500 hover:text-gray-300 rounded transition-colors" title="Refresh">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* System RAM */}
      {mem ? (
        <MemBar used={mem.used} total={mem.total} label="System RAM" />
      ) : loading ? (
        <div className="h-8 flex items-center gap-2 text-xs text-gray-600"><Loader size={12} className="animate-spin" /> Loading…</div>
      ) : (
        <p className="text-xs text-gray-600">Could not read memory info</p>
      )}

      {/* Running models */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <MemoryStick size={12} className="text-gray-500" />
          <p className="text-xs font-medium text-gray-400">Loaded Models</p>
          {models.length > 0 && <span className="text-xs text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded-full">{models.length}</span>}
        </div>

        {models.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No models currently loaded in memory</p>
        ) : (
          <div className="flex flex-col gap-2">
            {models.map(m => {
              const vram  = m.size_vram ?? 0;
              const total = m.size ?? 0;
              const ram   = total - vram;
              const expiresAt = m.expires_at ? new Date(m.expires_at) : null;
              const isStopping = stopping === m.name;

              return (
                <div key={m.name} className="flex items-start justify-between gap-3 p-3 rounded-lg bg-gray-800 border border-gray-700">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-200 truncate">{m.name}</span>
                      {m.details?.parameter_size && (
                        <span className="text-xs text-gray-500 flex-shrink-0">{m.details.parameter_size}</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-gray-500">
                      {vram > 0 && <span>VRAM: <span className="text-gray-300">{fmtBytes(vram)}</span></span>}
                      {ram  > 0 && <span>RAM:  <span className="text-gray-300">{fmtBytes(ram)}</span></span>}
                      {total > 0 && <span>Total: <span className="text-gray-300">{fmtBytes(total)}</span></span>}
                      {expiresAt && <span>Expires: <span className="text-gray-400">{expiresAt.toLocaleTimeString()}</span></span>}
                    </div>
                    {/* VRAM bar */}
                    {total > 0 && mem && (
                      <div className="mt-2">
                        <MemBar used={total} total={mem.total} label="System RAM used by model" />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleStop(m.name)}
                    disabled={isStopping}
                    title="Unload model from memory"
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-red-700/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50 flex-shrink-0"
                  >
                    {isStopping ? <Loader size={10} className="animate-spin" /> : <Square size={10} />}
                    {isStopping ? 'Stopping…' : 'Unload'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Settings Page ─────────────────────────────────────────────────────────

export function SettingsPage() {
  const [config, setConfig] = useState({ ollama_url: '' });
  const [saving, setSaving] = useState(false);
  const [clearingBlackboard, setClearingBlackboard] = useState(false);
  const [clearingPipelineRuns, setClearingPipelineRuns] = useState(false);
  const [clearingScheduleHistory, setClearingScheduleHistory] = useState(false);
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState(null);

  const loadMcp = () => api.getMcpServers().then(setMcpServers).catch(() => {});

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
    loadMcp();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateConfig(config);
      toast.success('Settings saved');
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const handleClearBlackboard = async () => {
    if (!confirm('Clear the shared blackboard? All agents will lose access to shared notes.')) return;
    setClearingBlackboard(true);
    try {
      await api.clearSharedBlackboard();
      toast.success('Shared blackboard cleared');
    } catch (e) { toast.error(e.message); }
    finally { setClearingBlackboard(false); }
  };

  const handleClearPipelineRuns = async () => {
    if (!confirm('Delete all pipeline run history? This cannot be undone.')) return;
    setClearingPipelineRuns(true);
    try {
      await api.clearAllPipelineRuns();
      toast.success('Pipeline run history cleared');
    } catch (e) { toast.error(e.message); }
    finally { setClearingPipelineRuns(false); }
  };

  const handleClearScheduleHistory = async () => {
    if (!confirm('Reset run history for all schedules? This clears output and error logs but keeps the schedules.')) return;
    setClearingScheduleHistory(true);
    try {
      await api.clearAllScheduleHistory();
      toast.success('Schedule history cleared');
    } catch (e) { toast.error(e.message); }
    finally { setClearingScheduleHistory(false); }
  };

  const handleMcpSave = async (data) => {
    try {
      if (editingServer) {
        await api.updateMcpServer(editingServer.id, data);
        toast.success('Server updated');
      } else {
        await api.createMcpServer(data);
        toast.success('Server added');
      }
      setMcpModalOpen(false);
      setEditingServer(null);
      loadMcp();
    } catch (e) { toast.error(e.message); }
  };

  const handleMcpDelete = async (server) => {
    if (!confirm(`Delete MCP server "${server.name}"?`)) return;
    try {
      await api.deleteMcpServer(server.id);
      toast.success('Server deleted');
      loadMcp();
    } catch (e) { toast.error(e.message); }
  };

  const handleReconnect = async (server) => {
    await api.reconnectMcpServer(server.id);
    loadMcp();
  };

  const connectedCount = mcpServers.filter(s => s.connected).length;

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure Ollama, MCP servers, and shared data</p>
      </div>

      <AppearanceSection />

      {/* Ollama */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-300">Connections</h2>
        <Input
          label="Ollama URL"
          value={config.ollama_url}
          onChange={e => setConfig(c => ({ ...c, ollama_url: e.target.value }))}
          placeholder="http://localhost:11434"
        />
        <p className="text-xs text-gray-600 -mt-2">All agent data is stored in <code className="bg-gray-800 px-1 rounded">~/.hive/</code></p>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </Button>
      </div>

      {/* MCP Servers */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-300">MCP Servers</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {mcpServers.length === 0
                ? 'Connect local Model Context Protocol servers as agent tool sources'
                : `${mcpServers.length} configured · ${connectedCount} connected`
              }
            </p>
          </div>
          <Button size="sm" onClick={() => { setEditingServer(null); setMcpModalOpen(true); }}>
            <Plus size={13} /> Add Server
          </Button>
        </div>

        {mcpServers.length === 0 ? (
          <div className="text-center py-8 border border-dashed border-gray-700 rounded-lg">
            <p className="text-2xl mb-2">🔌</p>
            <p className="text-sm text-gray-400 font-medium">No MCP servers configured</p>
            <p className="text-xs text-gray-600 mt-1 max-w-xs mx-auto">
              Add a server to give agents access to tools like filesystem, GitHub, databases, web search, and more
            </p>
            <button
              onClick={() => { setEditingServer(null); setMcpModalOpen(true); }}
              className="mt-4 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center gap-1 mx-auto"
            >
              Browse 14 presets <ChevronRight size={12} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map(server => (
              <McpServerRow
                key={server.id}
                server={server}
                onEdit={(s) => { setEditingServer(s); setMcpModalOpen(true); }}
                onDelete={handleMcpDelete}
                onReconnect={() => handleReconnect(server)}
              />
            ))}
          </div>
        )}

        <p className="text-xs text-gray-600">
          After adding a server, enable it per-agent in the agent editor's <strong className="text-gray-500">Tools</strong> tab.
          Tool calls appear as <code className="bg-gray-800 px-1 rounded">{'{serverName}__{toolName}'}</code> in chat.
        </p>
      </div>

      {/* System Monitor */}
      <SystemMonitor />

      {/* Agent Data */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-300">Agent Data</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Shared Blackboard</p>
            <p className="text-xs text-gray-500 mt-0.5">Notes written to <code className="bg-gray-800 px-1 rounded">~/.hive/shared/SHARED.md</code> by any agent</p>
          </div>
          <Button variant="danger" size="sm" onClick={handleClearBlackboard} disabled={clearingBlackboard}>
            <Trash2 size={13} />
            {clearingBlackboard ? 'Clearing…' : 'Clear'}
          </Button>
        </div>
      </div>

      {/* Run History */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-300">Run History</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-gray-200">Pipeline Runs</p>
            <p className="text-xs text-gray-500 mt-0.5">Clears stored inputs, outputs, and step traces for all pipelines</p>
          </div>
          <Button variant="danger" size="sm" onClick={handleClearPipelineRuns} disabled={clearingPipelineRuns}>
            <Trash2 size={13} />
            {clearingPipelineRuns ? 'Clearing…' : 'Clear all'}
          </Button>
        </div>
        <div className="flex items-center justify-between border-t border-gray-800 pt-4">
          <div>
            <p className="text-sm text-gray-200">Schedule History</p>
            <p className="text-xs text-gray-500 mt-0.5">Resets last run time, output, and error log for all schedules</p>
          </div>
          <Button variant="danger" size="sm" onClick={handleClearScheduleHistory} disabled={clearingScheduleHistory}>
            <Trash2 size={13} />
            {clearingScheduleHistory ? 'Clearing…' : 'Clear all'}
          </Button>
        </div>
      </div>

      <McpServerModal
        open={mcpModalOpen}
        server={editingServer}
        onClose={() => { setMcpModalOpen(false); setEditingServer(null); }}
        onSave={handleMcpSave}
      />
    </div>
  );
}
