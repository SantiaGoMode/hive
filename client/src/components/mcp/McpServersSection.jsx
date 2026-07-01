import { useState, useEffect } from 'react';
import {
  Trash2, Plus, RefreshCw, CheckCircle, Loader, ChevronDown, ChevronUp,
  AlertTriangle, Eye, EyeOff, Lock, Unlock, ChevronRight, ArrowLeft, Wrench,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { toast } from '../../stores/toastStore';
import { MCP_PRESETS, PRESET_CATEGORIES } from '../../lib/mcpPresets';

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
              placeholder={row.secret ? `env:${row.key || 'SECRET_NAME'}` : 'value'}
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
          <Lock size={10} /> Use <code className="bg-gray-800 px-1 rounded">env:NAME</code> to read from the Hive process environment.
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
        <p className="text-xs text-gray-500">Pre-configured for popular MCP servers. Most run through package launchers like <code className="bg-gray-800 px-1 rounded">npx</code> or <code className="bg-gray-800 px-1 rounded">uvx</code>.</p>
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

export function McpServerModal({ open, server, onClose, onSave }) {
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
        value:   t.value || (t.secret ? `env:${t.key}` : ''),
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

  const hasPlaceholders = /<[A-Z_]+>/.test(form.args);

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

// ── Self-contained MCP Servers section ────────────────────────────────────────
// Owns its own data loading, modal state, and CRUD handlers.

export function McpServersSection({ onChanged }) {
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState(null);

  const loadMcp = () => api.getMcpServers().then(list => {
    setMcpServers(list);
    onChanged?.(list);
  }).catch(() => {});

  useEffect(() => { loadMcp(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
            Browse {MCP_PRESETS.length} presets <ChevronRight size={12} />
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
        After adding a server, enable it per-agent in the agent editor's <strong className="text-gray-500">Tools</strong> tab,
        or per staff member on the <strong className="text-gray-500">Staff</strong> page.
        Tool calls appear as <code className="bg-gray-800 px-1 rounded">{'{serverName}__{toolName}'}</code> in chat.
      </p>

      <McpServerModal
        open={mcpModalOpen}
        server={editingServer}
        onClose={() => { setMcpModalOpen(false); setEditingServer(null); }}
        onSave={handleMcpSave}
      />
    </div>
  );
}
