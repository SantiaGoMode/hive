import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Search, MessageSquare, Clock, Upload, Download, ChevronRight, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAgentStore } from '../stores/agentStore';
import { AgentCard } from '../components/agents/AgentCard';
import { AgentEditor } from '../components/agents/AgentEditor';
import { DeleteConfirm } from '../components/agents/DeleteConfirm';
import { Button } from '../components/ui/Button';
import { AgentCardSkeleton } from '../components/ui/Skeleton';
import { toast } from '../stores/toastStore';
import { api } from '../lib/api';
import { formatDate } from '../lib/utils';

const STARTER_MODELS = [
  { name: 'llama3.2:3b', label: 'Llama 3.2 3B', desc: 'Fast · 2 GB · Great for everyday tasks' },
  { name: 'mistral:7b', label: 'Mistral 7B', desc: 'Balanced · 4.1 GB · Strong reasoning' },
  { name: 'qwen3.5:latest', label: 'Qwen 3.5', desc: 'Advanced · 6.6 GB · Tool calling + thinking' },
];

function OnboardingScreen({ onPull, onDismiss }) {
  const [pulling, setPulling] = useState(null);
  const [progress, setProgress] = useState({});

  const handlePull = async (modelName) => {
    setPulling(modelName);
    try {
      const res = await fetch(`/api/ollama/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.completed && d.total) {
              setProgress(p => ({ ...p, [modelName]: Math.round((d.completed / d.total) * 100) }));
            }
          } catch {}
        }
      }
      toast.success(`${modelName} pulled successfully`);
      onPull();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setPulling(null);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-8 max-w-xl mx-auto text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center">
          <Zap size={28} className="text-white" />
        </div>
        <h1 className="text-2xl font-bold text-gray-100">Welcome to Hive</h1>
        <p className="text-gray-400 text-sm leading-relaxed">
          Hive runs AI agents locally using Ollama. To get started, pull a model — everything stays on your machine.
        </p>
        <p className="text-xs text-gray-600">
          Make sure Ollama is running: <code className="bg-gray-800 px-1.5 py-0.5 rounded font-mono">ollama serve</code>
        </p>
      </div>

      <div className="w-full flex flex-col gap-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Choose a starter model</p>
        {STARTER_MODELS.map(m => (
          <div key={m.name} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="text-left">
              <p className="text-sm font-medium text-gray-200">{m.label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{m.desc}</p>
              {pulling === m.name && progress[m.name] != null && (
                <div className="mt-2 w-40 h-1 bg-gray-700 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all" style={{ width: `${progress[m.name]}%` }} />
                </div>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => handlePull(m.name)}
              disabled={!!pulling}
            >
              {pulling === m.name ? (
                progress[m.name] != null ? `${progress[m.name]}%` : 'Pulling…'
              ) : (
                <><Download size={13} /> Pull</>
              )}
            </Button>
          </div>
        ))}
      </div>

      <button onClick={onDismiss} className="text-xs text-gray-600 hover:text-gray-400 flex items-center gap-1">
        I already have models <ChevronRight size={12} />
      </button>
    </div>
  );
}

function SessionSearchResults({ results, agents, onSelect }) {
  if (!results.length) return (
    <div className="text-center py-8 text-gray-500 text-sm">No matching sessions found</div>
  );

  // Group by agent_id
  const grouped = results.reduce((acc, r) => {
    if (!acc[r.agent_id]) acc[r.agent_id] = [];
    acc[r.agent_id].push(r);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-4">
      {Object.entries(grouped).map(([agentId, sessions]) => {
        const agent = agents.find(a => a.id === agentId);
        return (
          <div key={agentId}>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              {agent?.name || agentId}
            </p>
            <div className="flex flex-col gap-2">
              {sessions.map(sess => (
                <button
                  key={sess.id}
                  onClick={() => onSelect(agentId, sess.id)}
                  className="flex flex-col gap-1 p-3 rounded-lg bg-gray-900 border border-gray-800 hover:border-blue-500/50 hover:bg-blue-500/5 text-left transition-colors"
                >
                  <p className="text-sm text-gray-200 truncate">{sess.preview || sess.id.slice(0, 8)}</p>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><Clock size={10} />{formatDate(sess.modified_at)}</span>
                    <span className="flex items-center gap-1"><MessageSquare size={10} />{sess.user_message_count} messages</span>
                    {sess.matches?.length > 0 && (
                      <span className="text-blue-400">{sess.matches.length} match{sess.matches.length !== 1 ? 'es' : ''}</span>
                    )}
                  </div>
                  {sess.matches?.[0] && (
                    <p className="text-xs text-gray-500 truncate mt-0.5 italic">
                      …{sess.matches[0].content.slice(0, 80)}…
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { agents, loading, error, fetchAgents, deleteAgent } = useAgentStore();
  const [editingAgent, setEditingAgent] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState('agents'); // 'agents' | 'sessions'
  const [sessionResults, setSessionResults] = useState([]);
  const [sessionSearching, setSessionSearching] = useState(false);
  const [models, setModels] = useState(null); // null = not yet checked
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const searchTimeoutRef = useRef(null);
  const importInputRef = useRef(null);

  useEffect(() => {
    fetchAgents();
    api.getModels().then(setModels).catch(() => setModels([]));
  }, []);

  const handleEdit = (agent) => { setEditingAgent(agent); setEditorOpen(true); };
  const handleCreate = () => { setEditingAgent(null); setEditorOpen(true); };

  const handleDelete = async () => {
    await deleteAgent(deleteTarget.id);
    toast.success(`Deleted ${deleteTarget.name}`);
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.name) { toast.error('Invalid agent file — missing name'); return; }
      await api.createAgent(data);
      toast.success(`Imported ${data.name}`);
      fetchAgents();
    } catch (err) {
      toast.error(err.message || 'Failed to import agent');
    }
  };

  // Debounced session search
  useEffect(() => {
    if (searchMode !== 'sessions' || !search.trim()) {
      setSessionResults([]);
      return;
    }
    clearTimeout(searchTimeoutRef.current);
    setSessionSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await api.searchSessions(search.trim());
        setSessionResults(results);
      } catch { setSessionResults([]); }
      finally { setSessionSearching(false); }
    }, 400);
  }, [search, searchMode]);

  const handleSessionSelect = useCallback((agentId, sessionId) => {
    navigate(`/chat/${agentId}`, { state: { sessionId } });
  }, [navigate]);

  const filtered = agents.filter(a =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description?.toLowerCase().includes(search.toLowerCase()) ||
    a.model?.toLowerCase().includes(search.toLowerCase())
  );

  const showOnboarding = !onboardingDismissed && models !== null && models.length === 0 && agents.length === 0 && !loading;

  if (showOnboarding) {
    return (
      <OnboardingScreen
        onPull={() => { api.getModels().then(setModels).catch(() => {}); fetchAgents(); }}
        onDismiss={() => setOnboardingDismissed(true)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Agents</h1>
          <p className="text-sm text-gray-500 mt-0.5">{agents.length} configured</p>
        </div>
        <div className="flex gap-2">
          <input ref={importInputRef} type="file" accept=".json" className="hidden" onChange={handleImport} />
          <Button variant="secondary" onClick={() => importInputRef.current?.click()} title="Import agent from JSON">
            <Upload size={16} /> Import
          </Button>
          <Button onClick={handleCreate} title="New agent">
            <Plus size={16} /> New Agent
          </Button>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={searchMode === 'agents' ? 'Search agents…' : 'Search conversation history…'}
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={() => { setSearchMode(m => m === 'agents' ? 'sessions' : 'agents'); setSearch(''); }}
          className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5 ${searchMode === 'sessions' ? 'border-blue-500/50 bg-blue-500/10 text-blue-400' : 'border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'}`}
          title="Toggle session search"
        >
          <MessageSquare size={13} />
          History
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {searchMode === 'sessions' ? (
        <div>
          {sessionSearching && <div className="text-gray-500 text-sm py-4 text-center">Searching…</div>}
          {!sessionSearching && search.trim() && (
            <SessionSearchResults results={sessionResults} agents={agents} onSelect={handleSessionSelect} />
          )}
          {!search.trim() && (
            <div className="text-center py-12 text-gray-500">
              <MessageSquare size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Type to search across all conversation history</p>
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <AgentCardSkeleton key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-6xl mb-4">🤖</div>
          <h2 className="text-lg font-semibold text-gray-300">
            {agents.length === 0 ? 'No agents yet' : 'No results'}
          </h2>
          <p className="text-sm text-gray-500 mt-1 mb-6">
            {agents.length === 0 ? 'Create your first agent in 30 seconds' : 'Try a different search'}
          </p>
          {agents.length === 0 && (
            <Button onClick={handleCreate}><Plus size={16} /> Create your first agent</Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onEdit={handleEdit}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      <AgentEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        agent={editingAgent}
      />

      <DeleteConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        itemName={deleteTarget?.name || ''}
        itemType="agent"
      />
    </div>
  );
}
