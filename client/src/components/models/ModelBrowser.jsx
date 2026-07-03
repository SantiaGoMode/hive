import { useState, useEffect } from 'react';
import { Download, Trash2, HardDrive, RefreshCw, Plus, Cpu, Search, Bot } from 'lucide-react';
import { api, getHiveAuthToken } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { formatBytes } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { DeleteConfirm } from '../agents/DeleteConfirm';
import { RECOMMENDATION_FAMILIES, filterRecommendations, localModelBudgetGb, recommendedOllamaModels, stretchModelBudgetGb } from '../../lib/ollamaRecommendations';
import { capabilityBadges, groupModelsByTier } from '../../lib/modelClassification';
import { readSSEStream } from '../../lib/streamParser';

function PullProgress({ name, onDone }) {
  const [progress, setProgress] = useState('');
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const token = getHiveAuthToken();
    fetch('/api/ollama/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-hive-auth-token': token } : {}),
      },
      body: JSON.stringify({ name }),
      signal: ctrl.signal,
    }).then(async res => {
      for await (const data of readSSEStream(res, { signal: ctrl.signal })) {
        if (data.status) setProgress(data.status);
        if (data.completed && data.total) setPct(Math.round(data.completed / data.total * 100));
        if (data.status === 'success' || data.status === 'done') { setDone(true); onDone(); }
      }
    }).catch(() => {});
    return () => ctrl.abort();
  }, [name]);

  return (
    <div className="mt-3 p-3 bg-gray-800 rounded-lg text-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-300 font-mono text-xs">{name}</span>
        {done ? <Badge color="green">Done</Badge> : <Badge color="blue">Pulling</Badge>}
      </div>
      {!done && (
        <>
          <div className="w-full bg-gray-700 rounded-full h-1.5 mb-1">
            <div className="bg-blue-500 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-gray-500">{progress} {pct > 0 && `${pct}%`}</p>
        </>
      )}
    </div>
  );
}

export function ModelBrowser({ onPullComplete }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pullName, setPullName] = useState('');
  const [pulling, setPulling] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [systemStatus, setSystemStatus] = useState(null);
  const [modelSearch, setModelSearch] = useState('');
  const [recQuery, setRecQuery] = useState('');
  const [recFamily, setRecFamily] = useState('All');
  const [recSort, setRecSort] = useState('fit');

  const load = () => {
    setLoading(true);
    api.getModels().then(setModels).catch(() => setModels([])).finally(() => setLoading(false));
    api.getSystemStatus().then(setSystemStatus).catch(() => setSystemStatus(null));
  };

  useEffect(() => { load(); }, []);

  const handlePull = () => {
    if (!pullName.trim()) return;
    const name = pullName.trim();
    setPulling(prev => prev.includes(name) ? prev : [...prev, name]);
    setPullName('');
  };

  const startPull = (name) => {
    setPulling(prev => prev.includes(name) ? prev : [...prev, name]);
  };

  const handleDelete = async () => {
    try {
      await api.deleteModel(deleteTarget.name);
      toast.success(`Deleted ${deleteTarget.name}`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const recommended = filterRecommendations(
    recommendedOllamaModels(systemStatus?.memory, models),
    { query: recQuery, family: recFamily, sort: recSort },
  );
  const pullingSet = new Set(pulling);
  const budgetGb = localModelBudgetGb(systemStatus?.memory);
  const stretchGb = stretchModelBudgetGb(systemStatus?.memory);

  return (
    <div className="flex flex-col gap-4">
      {/* Ollama connection check (issue #2) */}
      {systemStatus && systemStatus.ollama_reachable === false && (
        <div className="p-3 bg-yellow-500/5 border border-yellow-500/30 rounded-xl flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-48">
            <p className="text-sm font-medium text-yellow-400">Ollama is not reachable</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Tried <code className="bg-gray-800 px-1 rounded font-mono">{systemStatus.ollama_url}</code>.
              Start it with <code className="bg-gray-800 px-1 rounded font-mono">ollama serve</code>, then retry.
              Cloud models (below) still work without Ollama.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Retry connection
          </Button>
        </div>
      )}

      {/* Recommended local models */}
      <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Cpu size={14} /> Curated Local Models
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              All curated models, labeled by fit: comfortable ≤ {budgetGb} GB, stretch ≤ {stretchGb} GB, larger marked over budget.
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={load} disabled={loading} title="Refresh recommendations">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2 text-gray-600" />
            <input
              value={recQuery}
              onChange={e => setRecQuery(e.target.value)}
              placeholder="Search catalog"
              className="w-44 bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {RECOMMENDATION_FAMILIES.map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setRecFamily(f)}
                className={`text-xs rounded-md px-2 py-1 border transition-colors ${recFamily === f ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-gray-800 text-gray-500 hover:border-gray-700'}`}
              >
                {f}
              </button>
            ))}
          </div>
          <select
            value={recSort}
            onChange={e => setRecSort(e.target.value)}
            className="ml-auto bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Sort catalog"
          >
            <option value="fit">Sort: best fit</option>
            <option value="size-asc">Sort: smallest first</option>
            <option value="size-desc">Sort: largest first</option>
            <option value="name">Sort: name</option>
          </select>
        </div>

        {recommended.length === 0 ? (
          <p className="text-xs text-gray-600 italic">No curated models match the current filter.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {recommended.map(model => {
              const pullingModel = pullingSet.has(model.name);
              return (
                <div key={model.name} className="flex flex-col gap-3 p-3 rounded-lg border border-gray-800 bg-gray-950/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{model.title}</p>
                      <p className="text-xs font-mono text-gray-500 truncate">{model.name}</p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Badge color={model.fit === 'over' ? 'red' : model.fit === 'stretch' ? 'yellow' : 'blue'}>
                        {model.fit === 'over' ? 'Over budget' : model.fit === 'stretch' ? 'Stretch' : model.sizeLabel}
                      </Badge>
                      {model.installed && <Badge color="green">Installed</Badge>}
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed">{model.description}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-gray-600" title={model.fitReason}>{model.family} · {model.sizeLabel} · ~{model.estimatedRamGb} GB RAM</span>
                    <Button
                      size="sm"
                      onClick={() => startPull(model.name)}
                      disabled={model.installed || pullingModel}
                    >
                      <Download size={12} /> {model.installed ? 'Installed' : pullingModel ? 'Pulling' : 'Install'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Pull new model */}
      <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
        <h3 className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
          <Plus size={14} /> Pull Custom Model
        </h3>
        <div className="flex gap-2">
          <Input
            value={pullName}
            onChange={e => setPullName(e.target.value)}
            placeholder="e.g. llama3:8b, mistral, phi3"
            className="flex-1"
            onKeyDown={e => e.key === 'Enter' && handlePull()}
          />
          <Button onClick={handlePull} disabled={!pullName.trim() || pullingSet.has(pullName.trim())}>
            <Download size={14} /> Pull
          </Button>
        </div>
        <p className="text-xs text-gray-600 mt-2">Custom pulls are not filtered; use this for exact Ollama tags you already know your machine can run.</p>
        {pulling.map(name => (
          <PullProgress key={name} name={name} onDone={() => { load(); setPulling(prev => prev.filter(n => n !== name)); onPullComplete?.(name); }} />
        ))}
      </div>

      {/* Installed models — grouped by what they can actually do */}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-300">Installed Models ({models.length})</h3>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-2 text-gray-600" />
            <input
              value={modelSearch}
              onChange={e => setModelSearch(e.target.value)}
              placeholder="Filter models"
              className="w-44 bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-2 py-1.5 text-xs text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>
          <Button size="icon" variant="ghost" onClick={load} disabled={loading} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm text-center py-8">Loading models…</div>
      ) : models.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <HardDrive size={40} className="mx-auto mb-3 opacity-30" />
          <p>No models installed</p>
          <p className="text-xs mt-1">Pull a model above to get started</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {groupModelsByTier(models, modelSearch).map(group => (
            <div key={group.tier}>
              <div className="flex items-baseline gap-2 mb-1.5">
                <h4 className={`text-xs font-semibold uppercase tracking-wide ${group.tier === 'agent-ready' ? 'text-green-400' : group.tier === 'tools-light' ? 'text-yellow-400' : 'text-gray-500'}`}>
                  {group.tier === 'agent-ready' && <Bot size={11} className="inline mr-1 -mt-0.5" />}
                  {group.label} ({group.models.length})
                </h4>
                <span className="text-xs text-gray-600">{group.description}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {group.models.map(model => (
                  <div key={model.name} className="flex items-center gap-3 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg hover:border-gray-700 transition-colors">
                    <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-gray-200 truncate">{model.name}</span>
                      {model.details?.parameter_size && <Badge color="blue">{model.details.parameter_size}</Badge>}
                      {capabilityBadges(model).map(b => (
                        <span key={b.key} title={b.hint}>
                          <Badge color={b.color}>{b.label}</Badge>
                        </span>
                      ))}
                    </div>
                    <span className="text-xs text-gray-600 shrink-0">
                      {model.size ? formatBytes(model.size) : ''}
                      {model.details?.quantization_level ? ` · ${model.details.quantization_level}` : ''}
                    </span>
                    <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(model)} title="Delete model">
                      <Trash2 size={14} className="text-red-400" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {groupModelsByTier(models, modelSearch).length === 0 && (
            <p className="text-xs text-gray-600 text-center py-4">No models match "{modelSearch}"</p>
          )}
        </div>
      )}

      <DeleteConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        itemName={deleteTarget?.name || ''}
        itemType="model"
      />
    </div>
  );
}
