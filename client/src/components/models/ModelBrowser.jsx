import { useState, useEffect } from 'react';
import { Download, Trash2, HardDrive, RefreshCw, Plus, MessageSquare, Edit3 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { formatBytes, formatDate } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { DeleteConfirm } from '../agents/DeleteConfirm';
import { buildStarterAgent } from '../../lib/starterAgent';

function PullProgress({ name, onDone }) {
  const [progress, setProgress] = useState('');
  const [pct, setPct] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let completed = false;
    fetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal: ctrl.signal,
    }).then(async res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done: d, value } = await reader.read();
        if (d) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data.status) setProgress(data.status);
            if (data.completed && data.total) setPct(Math.round(data.completed / data.total * 100));
            if ((data.status === 'success' || data.status === 'done') && !completed) {
              completed = true;
              setDone(true);
              onDone(name);
            }
          } catch {
            // Ignore malformed progress chunks from the Ollama stream.
          }
        }
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

export function ModelBrowser() {
  const navigate = useNavigate();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pullName, setPullName] = useState('');
  const [pulling, setPulling] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [readyModel, setReadyModel] = useState(null);
  const [creatingFor, setCreatingFor] = useState(null);

  const load = () => {
    setLoading(true);
    api.getModels().then(setModels).catch(() => setModels([])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handlePull = () => {
    if (!pullName.trim()) return;
    setPulling(prev => [...prev, pullName.trim()]);
    setPullName('');
  };

  const handlePullDone = (name) => {
    load();
    setReadyModel(name);
    setPulling(prev => prev.filter(n => n !== name));
  };

  const handleStartChat = async (modelName) => {
    setCreatingFor(modelName);
    try {
      const agent = await api.createAgent(buildStarterAgent(modelName));
      toast.success('Starter agent created');
      navigate(`/chat/${agent.id}`);
    } catch (e) {
      toast.error(e.message || 'Could not create starter agent');
      navigate(`/?setupModel=${encodeURIComponent(modelName)}`);
    } finally {
      setCreatingFor(null);
    }
  };

  const handleReviewAgent = (modelName) => {
    navigate(`/?setupModel=${encodeURIComponent(modelName)}`);
  };

  const handleDelete = async () => {
    try {
      await api.deleteModel(deleteTarget.name);
      toast.success(`Deleted ${deleteTarget.name}`);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Pull new model */}
      <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
        <h3 className="text-sm font-semibold text-gray-200 mb-3 flex items-center gap-2">
          <Plus size={14} /> Pull a Model
        </h3>
        <div className="flex gap-2">
          <Input
            value={pullName}
            onChange={e => setPullName(e.target.value)}
            placeholder="e.g. llama3:8b, mistral, phi3"
            className="flex-1"
            onKeyDown={e => e.key === 'Enter' && handlePull()}
          />
          <Button onClick={handlePull} disabled={!pullName.trim()}>
            <Download size={14} /> Pull
          </Button>
        </div>
        {pulling.map(name => (
          <PullProgress key={name} name={name} onDone={handlePullDone} />
        ))}
        {readyModel && (
          <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-blue-200">{readyModel} is ready</p>
              <p className="text-xs text-blue-300/70 mt-0.5">Create a starter agent and go straight to chat.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => handleStartChat(readyModel)} disabled={creatingFor === readyModel}>
                <MessageSquare size={13} /> {creatingFor === readyModel ? 'Creating...' : 'Start chat'}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => handleReviewAgent(readyModel)}>
                <Edit3 size={13} /> Review
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Installed models */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">Installed Models ({models.length})</h3>
        <Button size="icon" variant="ghost" onClick={load} disabled={loading} title="Refresh">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm text-center py-8">Loading models…</div>
      ) : models.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <HardDrive size={40} className="mx-auto mb-3 opacity-30" />
          <p>No models installed</p>
          <p className="text-xs mt-1">Pull a model above, then create a starter agent for chat.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {models.map(model => (
            <div key={model.name} className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 transition-colors">
              <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center">
                <HardDrive size={18} className="text-gray-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm font-medium text-gray-200 truncate">{model.name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  {model.size && <Badge color="gray">{formatBytes(model.size)}</Badge>}
                  {model.details?.quantization_level && <Badge color="purple">{model.details.quantization_level}</Badge>}
                  {model.details?.parameter_size && <Badge color="blue">{model.details.parameter_size}</Badge>}
                  {model.modified_at && <span className="text-xs text-gray-600">{formatDate(new Date(model.modified_at).getTime())}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => handleStartChat(model.name)} disabled={creatingFor === model.name}>
                  <MessageSquare size={14} /> {creatingFor === model.name ? 'Creating...' : 'Start Chat'}
                </Button>
                <Button size="icon" variant="ghost" onClick={() => handleReviewAgent(model.name)} title="Review starter agent">
                  <Edit3 size={14} />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(model)} title="Delete model">
                  <Trash2 size={14} className="text-red-400" />
                </Button>
              </div>
            </div>
          ))}
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
