import { createElement, useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Trash2, RefreshCw, CheckCircle, XCircle, Loader, ChevronRight,
  Sun, Moon, Type, Cpu, Square, Wifi, WifiOff, MemoryStick, Play, Link2, Wrench, Bot,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { toast } from '../stores/toastStore';
import { useThemeStore, ACCENT_PRESETS } from '../stores/themeStore';

// ── Model Providers Section ───────────────────────────────────────────────────

const CLOUD_PROVIDERS = [
  { id: 'anthropic', key: 'anthropic_api_key', label: 'Anthropic (Claude)', hint: 'console.anthropic.com → API Keys' },
  { id: 'openai',    key: 'openai_api_key',    label: 'OpenAI (GPT)',       hint: 'platform.openai.com → API Keys' },
  { id: 'gemini',    key: 'gemini_api_key',    label: 'Google Gemini',      hint: 'aistudio.google.com → API Keys' },
];

function GatewayStatus({ status, loading }) {
  if (loading) {
    return (
      <span className="text-xs text-gray-500 flex items-center gap-1">
        <Loader size={11} className="animate-spin" /> Checking gateway...
      </span>
    );
  }
  if (!status?.enabled) {
    return (
      <span className="text-xs text-gray-500 flex items-center gap-1">
        <WifiOff size={11} /> Gateway not configured
      </span>
    );
  }
  if (status.reachable) {
    return (
      <span className="text-xs text-emerald-400/80 flex items-center gap-1">
        <CheckCircle size={11} /> Gateway reachable
      </span>
    );
  }
  return (
    <span className="text-xs text-red-400 flex items-center gap-1">
      <XCircle size={11} /> {status.message || 'Gateway unreachable'}
    </span>
  );
}

function DiscordBridgeStatus({ status }) {
  if (!status) return null;
  if (status.state === 'connected') {
    if (status.setup_required) {
      return (
        <span className="text-xs text-amber-300 flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400" /> Setup needed{status.guild ? ` (${status.guild})` : ''}
        </span>
      );
    }
    return (
      <span className="text-xs text-green-400 flex items-center gap-1">
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Connected{status.guild ? ` (${status.guild})` : ''}
      </span>
    );
  }
  if (status.state === 'error') {
    return <span className="text-xs text-red-400">Error: {status.error}</span>;
  }
  return <span className="text-xs text-gray-500">Disabled</span>;
}

function money(value) {
  if (value == null) return 'n/a';
  return `$${Number(value).toFixed(value > 0 && value < 0.01 ? 4 : 2)}`;
}

function percent(value) {
  if (value == null) return 'n/a';
  return `${Math.round(Number(value) * 100)}%`;
}

function AdvancedDisclosure({ id, title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/30">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/40 transition-colors"
      >
        <div>
          <p className="text-xs font-medium text-gray-300">{title}</p>
          {summary && <p className="text-xs text-gray-600 mt-0.5">{summary}</p>}
        </div>
        <ChevronRight size={14} className={`text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div id={id} className="border-t border-gray-800 px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

function GatewaySpendSummary({ spend }) {
  if (!spend?.enabled) return null;
  const topAgents = spend.agents?.slice(0, 5) || [];
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <div>
          <p className="text-[11px] text-gray-500">Spend</p>
          <p className="text-sm font-medium text-gray-200">{money(spend.totals?.spend_usd)}</p>
        </div>
        <div>
          <p className="text-[11px] text-gray-500">Calls</p>
          <p className="text-sm font-medium text-gray-200">{spend.totals?.calls ?? 0}</p>
        </div>
        <div>
          <p className="text-[11px] text-gray-500">Cache hits</p>
          <p className="text-sm font-medium text-gray-200">{percent(spend.totals?.cache_hit_rate)}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 text-[11px] text-gray-500">
        {spend.persistence?.spend_logs_reachable ? <CheckCircle size={10} className="text-emerald-400" /> : <XCircle size={10} className="text-red-400" />}
        <span>{spend.persistence?.message || 'Spend log status unavailable'}</span>
      </div>
      {topAgents.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {topAgents.map(agent => (
            <div key={agent.agent_id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-xs">
              <span className="truncate text-gray-300">{agent.agent_name || agent.agent_id}</span>
              <span className="text-gray-400">{money(agent.spend_usd)}</span>
              <span className={agent.budget_remaining_usd != null && agent.budget_remaining_usd <= 0 ? 'text-red-400' : 'text-gray-500'}>
                {agent.budget_usd == null ? 'no cap' : `${money(agent.budget_remaining_usd)} left`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModelProvidersSection({ config, setConfig, gatewayStatus, gatewayLoading }) {
  const [testing, setTesting] = useState(null);
  const [results, setResults] = useState({});
  const [clearing, setClearing] = useState(false);

  // A value is "masked" (a stored secret we shouldn't resend) if it contains a bullet.
  const isMasked = (v) => typeof v === 'string' && v.includes('•');

  // When a gateway URL is set, cloud keys live in the gateway and the per-provider
  // key inputs are bypassed — disable them and say so, rather than inviting dead edits.
  const gatewayOn = !!(config.llm_gateway_url || '').trim();

  const test = async (provider) => {
    setTesting(provider);
    try {
      const r = await api.testProvider(provider);
      setResults(prev => ({ ...prev, [provider]: r }));
      if (r.ok) toast.success(`${provider}: ${r.count} models available`);
      else toast.error(`${provider}: ${r.error || 'no models / key invalid'}`);
    } catch (e) {
      setResults(prev => ({ ...prev, [provider]: { ok: false, error: e.message } }));
      toast.error(e.message);
    } finally {
      setTesting(null);
    }
  };

  const clearStoredSecrets = async () => {
    if (!confirm('Clear stored provider and ngrok secrets from Hive settings? Environment-provided secrets will continue to work.')) return;
    setClearing(true);
    try {
      const next = await api.clearStoredSecrets();
      setConfig(next);
      toast.success('Stored secrets cleared');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="pt-4 border-t border-gray-800 flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2"><Cpu size={16} className="text-blue-400" /> Model Providers</h3>
        <p className="text-xs text-gray-500 mt-1">Add an API key to use a provider's cloud models. Ollama needs no key. Keys are stored locally and never shown again once saved.</p>
      </div>
      {gatewayOn && (
        <p className="text-xs text-emerald-400/80 flex items-center gap-1">
          <CheckCircle size={11} /> Cloud keys are managed by the LLM gateway below — the per-provider keys here are bypassed. "Test" checks the gateway.
        </p>
      )}
      {CLOUD_PROVIDERS.map(p => {
        const val = config[p.key] || '';
        const saved = isMasked(val);
        const res = results[p.id];
        return (
          <div key={p.id} className={`flex flex-col gap-1 ${gatewayOn ? 'opacity-60' : ''}`}>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label={p.label}
                  type="password"
                  value={val}
                  disabled={gatewayOn}
                  onChange={e => setConfig(c => ({ ...c, [p.key]: e.target.value }))}
                  placeholder={gatewayOn ? 'Managed by the LLM gateway' : saved ? 'Saved — type to replace' : `API key (${p.hint})`}
                />
              </div>
              <Button size="sm" variant="secondary" onClick={() => test(p.id)} disabled={testing === p.id}>
                {testing === p.id ? <Loader size={12} className="animate-spin" /> : 'Test'}
              </Button>
            </div>
            <div className="text-xs h-4">
              {res?.ok && <span className="text-green-400 flex items-center gap-1"><CheckCircle size={11} /> {res.count} models available</span>}
              {res && !res.ok && <span className="text-red-400 flex items-center gap-1"><XCircle size={11} /> {res.error || 'Not reachable'}</span>}
            </div>
          </div>
        );
      })}
      <p className="text-xs text-gray-600">Tip: you can also set <code className="bg-gray-800 px-1 rounded">ANTHROPIC_API_KEY</code>, <code className="bg-gray-800 px-1 rounded">OPENAI_API_KEY</code>, or <code className="bg-gray-800 px-1 rounded">GEMINI_API_KEY</code> as environment variables instead.</p>

      {config.llm_gateway_url && (
        <div className="rounded-lg border border-emerald-700/30 bg-emerald-500/5 p-3">
          <GatewayStatus status={gatewayStatus} loading={gatewayLoading} />
          <GatewaySpendSummary spend={gatewayStatus?.spend} />
        </div>
      )}

      <AdvancedDisclosure
        id="settings-provider-advanced"
        title="Advanced provider settings"
        summary={gatewayOn ? 'LLM gateway configured · stored-secret cleanup available' : 'LLM gateway and stored-secret cleanup'}
        defaultOpen={gatewayOn}
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-gray-300 flex items-center gap-2"><Cpu size={13} className="text-emerald-400" /> LLM Gateway (optional)</h4>
            <p className="text-xs text-gray-500">Route all cloud providers through a local LiteLLM proxy that holds the real keys, so Hive only stores a revocable, localhost-scoped key. When a gateway URL is set, the per-provider keys above are bypassed for cloud calls.</p>
            <Input
              label="Gateway base URL"
              value={config.llm_gateway_url || ''}
              onChange={e => setConfig(c => ({ ...c, llm_gateway_url: e.target.value }))}
              placeholder="e.g. http://127.0.0.1:4000/v1"
            />
            <Input
              label="Gateway key"
              type="password"
              value={config.llm_gateway_key || ''}
              onChange={e => setConfig(c => ({ ...c, llm_gateway_key: e.target.value }))}
              placeholder={isMasked(config.llm_gateway_key || '') ? 'Saved — type to replace' : 'Virtual key (optional until gateway master_key is set)'}
            />
          </div>

          <div className="pt-3 border-t border-gray-800/60 flex items-center gap-4">
            <Button size="sm" variant="secondary" onClick={clearStoredSecrets} disabled={clearing} className="w-fit">
              {clearing ? 'Clearing...' : 'Clear stored secrets'}
            </Button>
            <Link to="/setup" className="text-xs text-blue-400 hover:text-blue-300">
              Run setup wizard again
            </Link>
          </div>
        </div>
      </AdvancedDisclosure>
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
                {createElement(Icon, { size: 14 })}
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

function MemBar({ used, total, label, detail }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  const color = pct > 85 ? 'bg-red-500' : pct > 65 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{label}{detail ? <span className="text-gray-600 ml-1">{detail}</span> : null}</span>
        <span>{fmtBytes(used)} / {fmtBytes(total)} <span className="text-gray-600">({pct}%)</span></span>
      </div>
      <div className="h-2 rounded-full bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SystemMonitor({ embedded = false }) {
  const [status, setStatus]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [stopping, setStopping] = useState(null); // model name being stopped

  const refresh = useCallback(async () => {
    try {
      const data = await api.getSystemStatus();
      setStatus(data);
    } catch (e) { void e; }
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
    <div className={`${embedded ? '' : 'bg-gray-900 border border-gray-800 rounded-xl p-6'} flex flex-col gap-5`}>
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
        <MemBar
          used={mem.used}
          total={mem.total}
          label="System RAM"
          detail={mem.source === 'macos_vm_stat' && mem.cached ? `cached ${fmtBytes(mem.cached)} excluded` : null}
        />
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
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearingBlackboard, setClearingBlackboard] = useState(false);
  const [clearingPipelineRuns, setClearingPipelineRuns] = useState(false);
  const [clearingScheduleHistory, setClearingScheduleHistory] = useState(false);
  const [ngrokStatus, setNgrokStatus] = useState({ running: false, url: null });
  const [tunnelActionLoading, setTunnelActionLoading] = useState(false);

  const refreshMetrics = useCallback(async () => {
    setMetricsLoading(true);
    try {
      setMetrics(await api.getSystemMetrics());
    } catch {
      setMetrics(null);
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
    api.getNgrokStatus().then(setNgrokStatus).catch(() => {});
    refreshMetrics();
  }, [refreshMetrics]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateConfig(config);
      toast.success('Settings saved');
      const ngrok = await api.getNgrokStatus();
      setNgrokStatus(ngrok);
      await refreshMetrics();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const handleToggleNgrok = async () => {
    setTunnelActionLoading(true);
    try {
      if (ngrokStatus.running) {
        await api.stopNgrok();
        toast.success('Ngrok tunnel stopped');
      } else {
        const res = await api.startNgrok();
        toast.success(`Ngrok started at ${res.url}`);
      }
      const status = await api.getNgrokStatus();
      setNgrokStatus(status);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setTunnelActionLoading(false);
    }
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

  return (
    <div className="flex flex-col gap-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">Configure Ollama, model providers, and shared data</p>
      </div>

      <AppearanceSection />

      {/* Connections */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-300">Connections</h2>
        <Input
          label="Ollama URL"
          value={config.ollama_url || ''}
          onChange={e => setConfig(c => ({ ...c, ollama_url: e.target.value }))}
          placeholder="http://localhost:11434"
        />
        <p className="text-xs text-gray-600 -mt-2 mb-2">All agent data is stored in <code className="bg-gray-800 px-1 rounded">~/.hive/</code></p>

        <ModelProvidersSection
          config={config}
          setConfig={setConfig}
          gatewayStatus={metrics?.gateway}
          gatewayLoading={metricsLoading}
        />

        <div className="pt-4 border-t border-gray-800 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2"><Link2 size={16} className="text-blue-400" /> Built-in Ngrok Tunnel</h3>
              <p className="text-xs text-gray-500 mt-1">Expose your local Hive instance to receive external webhooks safely.</p>
            </div>
            <div className="flex items-center gap-3">
              {ngrokStatus.running ? (
                <span className="text-xs text-green-400 flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /> Active ({ngrokStatus.url})</span>
              ) : (
                <span className="text-xs text-gray-500">Stopped</span>
              )}
              <Button size="sm" variant={ngrokStatus.running ? "danger" : "primary"} onClick={handleToggleNgrok} disabled={tunnelActionLoading}>
                {tunnelActionLoading ? 'Wait...' : ngrokStatus.running ? <><Square size={12}/> Stop</> : <><Play size={12}/> Start Tunnel</>}
              </Button>
            </div>
          </div>

          <AdvancedDisclosure
            id="settings-webhook-advanced"
            title="Advanced webhook exposure"
            summary={config.webhook_public_url ? 'Manual public URL set' : 'Ngrok token, static domain, auto-start, and manual public URL'}
            defaultOpen={!!config.webhook_public_url || !!config.ngrok_domain}
          >
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Ngrok Auth Token"
                  type="password"
                  value={config.ngrok_authtoken || ''}
                  onChange={e => setConfig(c => ({ ...c, ngrok_authtoken: e.target.value }))}
                  placeholder={config.ngrok_authtoken_from_env ? 'Provided by NGROK_AUTHTOKEN' : 'Your ngrok authtoken'}
                />
                <Input
                  label="Static Domain (Optional)"
                  value={config.ngrok_domain || ''}
                  onChange={e => setConfig(c => ({ ...c, ngrok_domain: e.target.value }))}
                  placeholder="e.g. my-hive.ngrok-free.app"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer mt-1">
                <input type="checkbox" checked={config.ngrok_enabled === 'true'} onChange={e => setConfig({ ...config, ngrok_enabled: e.target.checked ? 'true' : 'false' })} className="rounded bg-gray-900 border-gray-700 text-blue-500 focus:ring-blue-500" />
                <span className="text-sm text-gray-300">Auto-start tunnel when Hive starts</span>
              </label>
              <div className="pt-4 border-t border-gray-800 flex flex-col gap-4">
                <Input
                  label="Manual Webhook Public Base URL"
                  value={config.webhook_public_url || ''}
                  onChange={e => setConfig(c => ({ ...c, webhook_public_url: e.target.value }))}
                  placeholder="https://my-tunnel.ngrok-free.app"
                />
                <p className="text-xs text-gray-600 -mt-2">Only needed if you are running your own tunnel manually instead of using the built-in ngrok integration.</p>
              </div>
            </div>
          </AdvancedDisclosure>
        </div>

        <div className="pt-4 border-t border-gray-800 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-200 flex items-center gap-2"><Bot size={16} className="text-blue-400" /> Discord Bridge</h3>
              <p className="text-xs text-gray-500 mt-1">Chat with the Steward, direct colonies from forum threads, and get health alerts in your private Discord server.</p>
            </div>
            <DiscordBridgeStatus status={metrics?.discord} />
          </div>
          <Input
            label="Bot Token"
            type="password"
            value={config.discord_bot_token || ''}
            onChange={e => setConfig(c => ({ ...c, discord_bot_token: e.target.value }))}
            placeholder={config.discord_bot_token_from_env ? 'Provided by DISCORD_BOT_TOKEN' : 'Discord bot token (Message Content intent required)'}
          />
          <p className="text-xs text-gray-600 -mt-2">
            After saving, invite the bot to your server and run <code className="bg-gray-800 px-1 rounded">/hive setup</code> there. The bot ignores normal messages until setup claims an owner and binds a general channel.
          </p>
        </div>

        <Button onClick={handleSave} disabled={saving} className="mt-2 w-fit">
          {saving ? 'Saving…' : 'Save Settings'}
        </Button>
      </div>

      {/* MCP Servers moved to Skills & Tools */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 flex items-center gap-2"><Wrench size={15} className="text-blue-400" /> MCP Servers</h2>
            <p className="text-xs text-gray-500 mt-0.5">MCP server configuration now lives on the Skills &amp; Tools page, alongside the skills catalog and tool list.</p>
          </div>
          <Link to="/skills" className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0">
            Open Skills &amp; Tools <ChevronRight size={12} />
          </Link>
        </div>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-300">Advanced</h2>
        <AdvancedDisclosure id="settings-system-monitor" title="System resources" summary="Loaded models, RAM, and Ollama status">
          <SystemMonitor embedded />
        </AdvancedDisclosure>

        <AdvancedDisclosure id="settings-maintenance" title="Maintenance actions" summary="Clear shared notes and run history">
          <div className="flex flex-col gap-4">
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
            <div className="flex items-center justify-between border-t border-gray-800 pt-4">
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
        </AdvancedDisclosure>
      </div>

    </div>
  );
}
