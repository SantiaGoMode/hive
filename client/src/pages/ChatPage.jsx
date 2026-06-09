import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useLocation, Link } from 'react-router-dom';
import { ArrowLeft, History, Edit2, Plus, Download } from 'lucide-react';
import { api } from '../lib/api';
import { ChatWindow } from '../components/chat/ChatWindow';
import { SessionList } from '../components/sessions/SessionList';
import { AgentEditor } from '../components/agents/AgentEditor';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { AgentAvatar } from '../components/agents/AgentAvatar';
import { download, exportMarkdown, formatDate } from '../lib/utils';
import { modelBadge } from '../lib/modelLabels';

export function ChatPage() {
  const { agentId } = useParams();
  const location = useLocation();
  const [agent, setAgent]               = useState(null);
  const [loading, setLoading]           = useState(true);
  const [showHistory, setShowHistory]   = useState(false);
  const [editOpen, setEditOpen]         = useState(false);

  // Chat session state — lifted here so SessionList can load into ChatWindow
  const [chatKey, setChatKey]           = useState(0);  // bump to reset ChatWindow
  const [initialMessages, setInitialMessages] = useState([]);
  const [initialSessionId, setInitialSessionId] = useState(null);
  const [sessionListKey, setSessionListKey]     = useState(0); // bump to refresh list
  const chatMessagesRef = useRef([]);  // kept in sync by ChatWindow via onMessagesChange

  const loadAgent = () => {
    setLoading(true);
    api.getAgent(agentId).then(a => { setAgent(a); setLoading(false); }).catch(() => setLoading(false));
  };

  useEffect(() => { loadAgent(); }, [agentId]);

  // Auto-load a session when navigated here from search results
  useEffect(() => {
    const sessId = location.state?.sessionId;
    if (!sessId) return;
    api.getSession(agentId, sessId)
      .then(session => {
        setInitialMessages(session.messages.map(m => ({ ...m, timestamp: m.timestamp || Date.now() })));
        setInitialSessionId(sessId);
        setChatKey(k => k + 1);
      })
      .catch(() => {});
  }, [agentId, location.state?.sessionId]);

  const startNewChat = useCallback(() => {
    setInitialMessages([]);
    setInitialSessionId(null);
    setChatKey(k => k + 1);
  }, []);

  const loadSession = useCallback(async (sessId) => {
    try {
      const session = await api.getSession(agentId, sessId);
      setInitialMessages(session.messages.map(m => ({ ...m, timestamp: m.timestamp || Date.now() })));
      setInitialSessionId(sessId);
      setChatKey(k => k + 1);
      setShowHistory(false);
    } catch {}
  }, [agentId]);

  const handleSessionSaved = useCallback(() => {
    setSessionListKey(k => k + 1);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'n') { e.preventDefault(); startNewChat(); }
      if (mod && e.key === 'h') { e.preventDefault(); setShowHistory(v => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [startNewChat]);

  const handleExport = useCallback((format) => {
    const msgs = chatMessagesRef.current;
    if (!msgs.length) return;
    const sessionData = {
      id: initialSessionId || 'live',
      agent_id: agentId,
      messages: msgs,
      created_at: msgs[0]?.timestamp || Date.now(),
    };
    const ts = formatDate(Date.now()).replace(/[^a-z0-9]/gi, '-');
    if (format === 'json') {
      download(JSON.stringify(sessionData, null, 2), `${agent?.name || agentId}-${ts}.json`, 'application/json');
    } else {
      download(exportMarkdown(sessionData), `${agent?.name || agentId}-${ts}.md`, 'text/markdown');
    }
  }, [agentId, agent, initialSessionId]);

  if (loading) return <div className="flex items-center justify-center h-64 text-gray-500">Loading…</div>;
  if (!agent)  return <div className="flex items-center justify-center h-64 text-gray-500">Agent not found</div>;
  const model = agent.model ? modelBadge(agent.model) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50 sticky top-0 z-10">
        <Link to="/" className="p-1.5 text-gray-400 hover:text-gray-100 rounded-md hover:bg-gray-800 transition-colors">
          <ArrowLeft size={18} />
        </Link>
        <AgentAvatar name={agent.name} color={agent.avatar_color} size={32} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-100 truncate">{agent.name}</span>
            {model && <Badge color={model.color} className="text-xs max-w-xs truncate" title={model.title}>{model.text}</Badge>}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={startNewChat} title="New chat (⌘N)">
          <Plus size={14} /> New Chat
        </Button>
        <div className="relative group">
          <Button size="icon" variant="ghost" title="Export conversation">
            <Download size={16} />
          </Button>
          <div className="absolute right-0 top-full mt-1 hidden group-hover:flex flex-col bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-20 min-w-[100px]">
            <button onClick={() => handleExport('md')} className="px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 text-left">Markdown</button>
            <button onClick={() => handleExport('json')} className="px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 text-left">JSON</button>
          </div>
        </div>
        <Button size="icon" variant="ghost" onClick={() => setShowHistory(!showHistory)} title="Session history (⌘H)">
          <History size={16} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => setEditOpen(true)} title="Edit agent">
          <Edit2 size={16} />
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat */}
        <div className={`flex-1 overflow-hidden flex flex-col ${showHistory ? 'border-r border-gray-800' : ''}`}>
          <ChatWindow
            key={chatKey}
            agent={agent}
            initialMessages={initialMessages}
            initialSessionId={initialSessionId}
            onSessionSaved={handleSessionSaved}
            onMessagesChange={msgs => { chatMessagesRef.current = msgs; }}
          />
        </div>

        {/* Session history drawer */}
        {showHistory && (
          <div className="w-80 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <h3 className="text-sm font-semibold text-gray-300">Session History</h3>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <SessionList
                key={sessionListKey}
                agentId={agentId}
                onContinue={loadSession}
              />
            </div>
          </div>
        )}
      </div>

      <AgentEditor
        open={editOpen}
        onClose={() => { setEditOpen(false); loadAgent(); }}
        agent={agent}
      />
    </div>
  );
}
