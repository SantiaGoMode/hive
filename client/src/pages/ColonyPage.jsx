import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Zap, Square, Trash2, ChevronDown, ChevronRight, Terminal, FileText,
  MessageSquare, Wrench, Clock, CheckCircle2, XCircle, Loader2, Users,
  Server, Download, Filter, RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { formatDate } from '../lib/utils';
import { AGENT_COLORS, sseToEntries, dbLogToEntries, mergeToolEntries } from '../lib/colonyUtils';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(entry) {
  if (!entry.ts) return null;
  const d = new Date(entry.ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Badges + UI atoms ─────────────────────────────────────────────────────────

function AgentBadge({ name, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold flex-shrink-0 transition-opacity ${active === false ? 'opacity-30' : ''}`}
      style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
    >
      {name}
    </button>
  );
}

function TimeStamp({ entry }) {
  const t = ts(entry);
  if (!t) return null;
  return <span className="text-gray-700 tabular-nums flex-shrink-0">{t}</span>;
}

// ── File card (write_file) ─────────────────────────────────────────────────────

function FileCard({ args, result }) {
  const [open, setOpen] = useState(false);
  const ok = result?.success !== false && !result?.error;
  return (
    <div className="rounded border border-gray-800 bg-gray-900/60 overflow-hidden my-0.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown size={10} className="flex-shrink-0" /> : <ChevronRight size={10} className="flex-shrink-0" />}
        <FileText size={11} className="text-blue-400 flex-shrink-0" />
        <span className="font-mono text-gray-300 truncate flex-1">{args?.path || 'file'}</span>
        {ok
          ? <CheckCircle2 size={10} className="text-green-500 flex-shrink-0" />
          : <XCircle size={10} className="text-red-400 flex-shrink-0" />}
      </button>
      {open && args?.content && (
        <pre className="text-xs font-mono bg-gray-950 px-3 py-2 text-gray-400 overflow-x-auto max-h-48 whitespace-pre-wrap break-words border-t border-gray-800">
          {String(args.content).slice(0, 3000)}
        </pre>
      )}
    </div>
  );
}

// ── Server card (start_server) ─────────────────────────────────────────────────

function ServerCard({ args, result }) {
  const port = result?.port || args?.port;
  const url = port ? `http://localhost:${port}` : null;
  const ok = result?.success !== false && !result?.error;
  return (
    <div className="flex items-center gap-2 rounded border border-gray-800 bg-gray-900/60 px-2.5 py-1.5 my-0.5">
      <Server size={11} className={ok ? 'text-green-400' : 'text-red-400'} />
      <span className="text-xs text-gray-400 flex-1">{args?.command || 'server started'}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 font-mono underline flex-shrink-0"
        >
          :{port}
        </a>
      )}
      {ok
        ? <CheckCircle2 size={10} className="text-green-500 flex-shrink-0" />
        : <XCircle size={10} className="text-red-400 flex-shrink-0" />}
    </div>
  );
}

// ── Generic tool call entry ───────────────────────────────────────────────────

function ToolCallEntry({ entry }) {
  const [open, setOpen] = useState(false);
  const isFile = ['write_file', 'read_file'].includes(entry.tool);
  const isShell = ['shell', 'run_python'].includes(entry.tool);
  const isServer = entry.tool === 'start_server';
  const icon = isFile ? <FileText size={11} /> : isShell ? <Terminal size={11} /> : isServer ? <Server size={11} /> : <Wrench size={11} />;

  if (entry.tool === 'write_file') {
    return <FileCard args={entry.args} result={entry.result} />;
  }
  if (entry.tool === 'start_server') {
    return <ServerCard args={entry.args} result={entry.result} />;
  }

  const ok = entry.result?.exitCode === 0 || entry.result?.success;
  const err = !!entry.result?.error || entry.result?.exitCode > 0;

  return (
    <div className="pl-2 border-l-2 border-gray-800 my-0.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full text-left py-0.5"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {icon}
        <span className="font-mono text-gray-400">{entry.tool}</span>
        {isShell && entry.args?.command && (
          <span className="text-gray-600 font-mono truncate max-w-xs">{String(entry.args.command).slice(0, 70)}</span>
        )}
        {entry.tool === 'ask_agent' && entry.args?.message && (
          <span className="text-gray-600 italic truncate max-w-xs">{String(entry.args.message).slice(0, 60)}</span>
        )}
        {entry.result !== undefined && (
          ok ? <CheckCircle2 size={10} className="text-green-500 ml-auto flex-shrink-0" />
            : err ? <XCircle size={10} className="text-red-400 ml-auto flex-shrink-0" /> : null
        )}
        {entry.result === undefined && <Loader2 size={9} className="animate-spin text-gray-700 ml-auto flex-shrink-0" />}
      </button>
      {open && (
        <div className="mt-1 mb-1 flex flex-col gap-1">
          {entry.args && Object.keys(entry.args).length > 0 && (
            <pre className="text-xs font-mono bg-gray-900 rounded p-2 text-gray-400 overflow-x-auto max-h-36 whitespace-pre-wrap break-words">
              {JSON.stringify(entry.args, null, 2).slice(0, 3000)}
            </pre>
          )}
          {entry.result !== undefined && (
            <pre className="text-xs font-mono bg-gray-900 rounded p-2 text-gray-300 overflow-x-auto max-h-36 whitespace-pre-wrap break-words">
              {typeof entry.result === 'string'
                ? entry.result.slice(0, 3000)
                : JSON.stringify(entry.result, null, 2).slice(0, 3000)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── Single log row ────────────────────────────────────────────────────────────

function LogEntry({ entry, agentColorMap }) {
  const color = agentColorMap[entry.agent] || '#6b7280';

  if (entry.type === 'system') {
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-gray-600">
        <div className="flex-1 border-t border-gray-800" />
        <span>{entry.message}</span>
        <div className="flex-1 border-t border-gray-800" />
      </div>
    );
  }

  if (entry.type === 'agent_ready') {
    return (
      <div className="flex items-center gap-2 py-1">
        <TimeStamp entry={entry} />
        <span className="text-xs text-gray-700">{entry.role === 'orchestrator' ? '⬡' : '⬢'}</span>
        <AgentBadge name={entry.agent} color={color} />
        <span className="text-xs text-gray-600">{entry.role === 'orchestrator' ? 'orchestrator' : 'worker'} created</span>
      </div>
    );
  }

  if (entry.type === 'tool_call' || entry.type === 'sub_tool_call') {
    return (
      <div className="flex items-start gap-2 py-0.5">
        <TimeStamp entry={entry} />
        <AgentBadge name={entry.agent} color={color} />
        <div className="flex-1 min-w-0">
          <ToolCallEntry entry={entry} />
        </div>
      </div>
    );
  }

  if (entry.type === 'message') {
    return (
      <div className="flex items-start gap-2 py-2">
        <TimeStamp entry={entry} />
        <AgentBadge name={entry.agent} color={color} />
        <p className="text-sm text-gray-300 leading-relaxed flex-1 whitespace-pre-wrap">{entry.content}</p>
      </div>
    );
  }

  if (entry.type === 'round') {
    return (
      <div className="py-2 text-xs text-gray-600 flex items-center gap-2">
        <div className="flex-1 border-t border-gray-800/80" />
        <span className="px-2">— Round {entry.round} —</span>
        <div className="flex-1 border-t border-gray-800/80" />
      </div>
    );
  }

  if (entry.type === 'done') {
    return (
      <div className="flex items-center gap-2 py-2">
        <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />
        <span className="text-sm font-medium text-green-400">
          {entry.status === 'stopped' ? 'Colony stopped' : 'Colony complete'}
        </span>
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="flex items-center gap-2 py-1">
        <XCircle size={13} className="text-red-400 flex-shrink-0" />
        <span className="text-sm text-red-400">{entry.content}</span>
      </div>
    );
  }

  return null;
}

// ── Colony live/replay view ────────────────────────────────────────────────────

function PlanChecklist({ plan }) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const done = plan.steps.filter(s => s.status === 'done').length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const iconFor = (status) => {
    if (status === 'done') return <CheckCircle2 size={12} className="text-green-400" />;
    if (status === 'in_progress') return <Loader2 size={12} className="text-blue-400 animate-spin" />;
    if (status === 'blocked') return <XCircle size={12} className="text-red-400" />;
    return <div className="w-3 h-3 rounded-full border border-gray-600" />;
  };
  const rowColor = (status) => {
    if (status === 'done') return 'text-gray-500 line-through';
    if (status === 'in_progress') return 'text-blue-300';
    if (status === 'blocked') return 'text-red-300';
    return 'text-gray-400';
  };
  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-300">Plan</span>
        <span className="text-xs text-gray-500 tabular-nums">{done}/{total} · {pct}%</span>
      </div>
      <div className="h-1 bg-gray-800 rounded mb-2 overflow-hidden">
        <div className="h-full bg-green-500/70 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-col gap-1">
        {plan.steps.map(step => (
          <li key={step.id} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 flex-shrink-0">{iconFor(step.status)}</span>
            <div className="flex-1 min-w-0">
              <span className={rowColor(step.status)}>
                <span className="text-gray-600 mr-1">{step.id}.</span>
                {step.description}
              </span>
              {step.assigned_to && (
                <span className="ml-1.5 text-gray-600">→ {step.assigned_to}</span>
              )}
              {step.note && (
                <div className="text-gray-600 italic mt-0.5">{step.note}</div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ColonyLiveView({ colony, log, agentColorMap, running, streamingByAgent = {}, plan = null, onStop, onExport }) {
  const bottomRef = useRef(null);
  const [filterAgent, setFilterAgent] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);

  const streamingEntries = Object.entries(streamingByAgent).filter(
    ([, v]) => (v?.content && v.content.length > 0) || (v?.thinking && v.thinking.length > 0),
  );

  // Auto-scroll when log grows OR streaming text updates
  const streamingLen = streamingEntries.reduce((n, [, v]) => n + (v.content?.length || 0) + (v.thinking?.length || 0), 0);
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log.length, streamingLen, autoScroll]);

  const merged = mergeToolEntries(log);

  const filtered = filterAgent
    ? merged.filter(e => !e.agent || e.agent === filterAgent || e.type === 'round' || e.type === 'done' || e.type === 'error' || e.type === 'system')
    : merged;

  const agents = Object.entries(agentColorMap).map(([name, color]) => ({ name, color }));

  const statusColor = { running: 'text-blue-400', done: 'text-green-400', stopped: 'text-gray-400', error: 'text-red-400' };
  const statusIcon = {
    running: <Loader2 size={12} className="animate-spin" />,
    done: <CheckCircle2 size={12} />,
    stopped: <Square size={12} />,
    error: <XCircle size={12} />,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Colony header */}
      <div className="flex items-start gap-3 pb-3 border-b border-gray-800 mb-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200 leading-snug">{colony.goal}</p>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className={`flex items-center gap-1 text-xs ${statusColor[colony.status] || 'text-gray-500'}`}>
              {statusIcon[colony.status]}
              {colony.status}
            </span>
            <span className="text-xs text-gray-600">{colony.model}</span>
            <span className="text-xs text-gray-700">{formatDate(colony.created_at * 1000)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowReasoning(v => !v)}
            className={showReasoning ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500 hover:text-gray-300'}
            title="Toggle display of model reasoning tokens"
          >
            {showReasoning ? 'Reasoning on' : 'Reasoning off'}
          </Button>
          {running && (
            <Button size="sm" variant="ghost" onClick={onStop} className="text-red-400 hover:text-red-300">
              <Square size={12} /> Stop
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onExport} className="text-gray-500 hover:text-gray-300">
            <Download size={12} /> Export
          </Button>
        </div>
      </div>

      {/* Plan checklist */}
      <PlanChecklist plan={plan} />

      {/* Summary card */}
      {colony.summary && (
        <div className="mb-3 rounded-lg border border-green-900/50 bg-green-950/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <CheckCircle2 size={13} className="text-green-400" />
            <span className="text-xs font-semibold text-green-400">Goal Achieved</span>
          </div>
          <p className="text-xs text-green-300 leading-relaxed">{colony.summary}</p>
        </div>
      )}

      {/* Agent filter chips */}
      {agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 items-center">
          <Filter size={11} className="text-gray-600 flex-shrink-0" />
          {agents.map(a => (
            <AgentBadge
              key={a.name}
              name={a.name}
              color={a.color}
              active={filterAgent === null || filterAgent === a.name}
              onClick={() => setFilterAgent(prev => prev === a.name ? null : a.name)}
            />
          ))}
          {filterAgent && (
            <button onClick={() => setFilterAgent(null)} className="text-xs text-gray-600 hover:text-gray-400 px-1">clear</button>
          )}
        </div>
      )}

      {/* Log */}
      <div
        className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-0.5 font-mono text-xs pr-1"
        onScroll={e => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 && running && (
          <div className="flex items-center gap-2 text-gray-600 py-6 justify-center">
            <Loader2 size={14} className="animate-spin" />
            <span>Orchestrator is planning…</span>
          </div>
        )}
        {filtered.length === 0 && !running && (
          <div className="text-gray-600 py-6 text-center">No entries</div>
        )}
        {filtered.map((entry, i) => (
          <LogEntry key={i} entry={entry} agentColorMap={agentColorMap} />
        ))}

        {/* Streaming preview: live token deltas for agents currently generating */}
        {streamingEntries.map(([agentName, buf]) => {
          if (filterAgent && filterAgent !== agentName) return null;
          const color = agentColorMap[agentName] || '#6b7280';
          return (
            <div key={`stream-${agentName}`} className="flex items-start gap-2 py-2">
              <div className="flex-shrink-0 w-12">
                <Loader2 size={10} className="animate-spin text-gray-600" />
              </div>
              <AgentBadge name={agentName} color={color} />
              <div className="flex-1 min-w-0">
                {showReasoning && buf.thinking && (
                  <pre className="text-xs text-gray-600 italic whitespace-pre-wrap break-words font-sans leading-relaxed mb-1 border-l-2 border-gray-800 pl-2">
                    {buf.thinking}
                  </pre>
                )}
                {buf.content && (
                  <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap break-words font-sans">
                    {buf.content}
                    <span className="inline-block w-1.5 h-3 bg-gray-400 align-middle ml-0.5 animate-pulse" />
                  </p>
                )}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Auto-scroll hint */}
      {!autoScroll && running && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          className="mt-1 text-xs text-blue-400 hover:text-blue-300 text-center py-1"
        >
          ↓ Resume auto-scroll
        </button>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ColonyPage() {
  const [colonies, setColonies] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loadedColony, setLoadedColony] = useState(null); // full colony data inc. log
  const [loadingColony, setLoadingColony] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [goal, setGoal] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [launching, setLaunching] = useState(false);

  // Live run state
  const [activeColonyId, setActiveColonyId] = useState(null);
  const [liveLog, setLiveLog] = useState([]);
  const [liveAgentColorMap, setLiveAgentColorMap] = useState({});
  // Streaming token buffers keyed by the agent label emitted in token events.
  // Shape: { [agentName]: { content: string, thinking: string } }
  const [streamingByAgent, setStreamingByAgent] = useState({});
  // Live plan state — updated by plan_update events during a live run.
  const [livePlan, setLivePlan] = useState(null);
  const colorIndexRef = useRef(0);
  const streamAbortRef = useRef(null); // cancels in-flight resume stream

  useEffect(() => {
    api.getColonies().then(setColonies).catch(() => {});
    api.getModels().then(m => {
      setModels(m);
      if (m.length > 0) setModel(m[0].name);
    }).catch(() => {});
  }, []);

  // Shared SSE consumer — used by both launch and resume paths.
  // Reads events from the given Response, drives liveLog/liveAgentColorMap,
  // and flips status on done/error. Safe to abort via the response's signal.
  const consumeStream = useCallback(async (response, knownColonyId = null) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let colonyId = knownColonyId;
    const agentNameMap = {};

    const processLine = (line) => {
      if (!line.startsWith('data: ')) return;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { return; }

      if (event.type === 'colony_id') {
        colonyId = event.colonyId;
        setActiveColonyId(colonyId);
        return;
      }

      // Token deltas — append to the per-agent streaming buffer and bail out
      // before sseToEntries runs. Not persisted to liveLog (would be thousands
      // of entries); rendered separately as a live preview row.
      if (event.type === 'token' && event.agent) {
        const kind = event.kind === 'thinking' ? 'thinking' : 'content';
        setStreamingByAgent(prev => {
          const existing = prev[event.agent] || { content: '', thinking: '' };
          return { ...prev, [event.agent]: { ...existing, [kind]: existing[kind] + (event.delta || '') } };
        });
        return;
      }

      if (event.type === 'plan_update' && event.plan) {
        setLivePlan(event.plan);
        return;
      }

      if (event.type === 'agent_ready' && event.agent?.name) {
        const agentName = event.agent.name;
        agentNameMap[event.agent.id] = agentName;
        setLiveAgentColorMap(prev => {
          if (prev[agentName]) return prev;
          const color = event.agent.avatar_color || AGENT_COLORS[colorIndexRef.current % AGENT_COLORS.length];
          colorIndexRef.current++;
          return { ...prev, [agentName]: color };
        });
      }

      const entries = sseToEntries(event, agentNameMap);
      if (entries.length > 0) setLiveLog(prev => [...prev, ...entries]);

      // Finalize / clear streaming buffers at natural boundaries so the live
      // preview doesn't linger once the logged entry has taken its place.
      if (event.type === 'round_start' || event.type === 'orchestrator_message') {
        setStreamingByAgent({});
      }
      if (event.type === 'ws') {
        const m = event.msg || {};
        if (m.type === 'sub_tool_call' || m.type === 'tool_call') {
          const key = m.subAgent;
          if (key) {
            setStreamingByAgent(prev => {
              if (!prev[key]) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
        }
      }

      if (event.type === 'done' || event.type === 'error') {
        setStreamingByAgent({});
        const newStatus = event.type === 'done' ? (event.status || 'done') : 'error';
        if (colonyId) {
          setColonies(prev => prev.map(c => c.id === colonyId ? { ...c, status: newStatus } : c));
          // Reload full colony so summary/log appear in the past-run path after the stream ends.
          api.getColony(colonyId).then(data => {
            setLoadedColony(prev => (prev?.id === colonyId || selectedId === colonyId ? data : prev));
          }).catch(() => {});
        }
        setActiveColonyId(null);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) processLine(line.trim());
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
      }
    }
  }, [selectedId]);

  // Load full colony detail when selected. For running colonies, additionally
  // attach to the resumable SSE stream so the UI keeps ticking across refresh.
  useEffect(() => {
    // Cancel any in-flight resume stream from the previous selection
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }

    if (!selectedId) return;
    // If this colony is already being streamed by handleLaunch, don't double-attach.
    if (selectedId === activeColonyId) return;

    let cancelled = false;
    setLoadingColony(true);
    setLoadedColony(null);

    api.getColony(selectedId)
      .then(async data => {
        if (cancelled) return;
        setLoadedColony(data);
        setLoadingColony(false);

        // If the run is still live on the server, attach to the stream. Reset
        // live state first so we don't mix logs across colonies.
        if (data.status === 'running') {
          setLiveLog([]);
          setLiveAgentColorMap({});
          setStreamingByAgent({});
          setLivePlan(null);
          colorIndexRef.current = 0;
          setActiveColonyId(selectedId);

          const ac = new AbortController();
          streamAbortRef.current = ac;
          try {
            const res = await api.streamColony(selectedId, 0, ac.signal);
            if (cancelled || ac.signal.aborted) return;
            await consumeStream(res, selectedId);
          } catch (e) {
            if (e.name !== 'AbortError' && !cancelled) {
              setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
            }
          }
        }
      })
      .catch(() => { if (!cancelled) setLoadingColony(false); });

    return () => {
      cancelled = true;
      if (streamAbortRef.current) {
        streamAbortRef.current.abort();
        streamAbortRef.current = null;
      }
    };
  }, [selectedId, activeColonyId, consumeStream]);

  const handleLaunch = async () => {
    if (!goal.trim() || !model) return;
    setLaunching(true);
    setLiveLog([]);
    setLiveAgentColorMap({});
    setStreamingByAgent({});
    setLivePlan(null);
    colorIndexRef.current = 0;

    // Reading the first chunk to get colony_id could be done before calling
    // consumeStream, but colony_id arrives as the very first SSE frame anyway
    // and consumeStream handles it. We just need to seed the colony list once
    // we see it. Wrap consumeStream with a peek that intercepts colony_id.
    try {
      const res = await api.launchColony(goal, model);
      if (!res.ok) throw new Error('Failed to start colony');

      setShowForm(false);
      setLaunching(false);

      // Seed the colony list as soon as colony_id arrives. We re-tap into the
      // stream by intercepting the first frame manually, then delegating the
      // rest to consumeStream via a cloned response.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let colonyId = null;
      const agentNameMap = {};

      const processLine = (line) => {
        if (!line.startsWith('data: ')) return;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { return; }

        if (event.type === 'colony_id') {
          colonyId = event.colonyId;
          setActiveColonyId(colonyId);
          setSelectedId(colonyId);
          setLoadedColony(null);
          setColonies(prev => [{
            id: colonyId, goal, model, status: 'running',
            agent_ids: [], created_at: Math.floor(Date.now() / 1000),
          }, ...prev]);
          return;
        }

        if (event.type === 'token' && event.agent) {
          const kind = event.kind === 'thinking' ? 'thinking' : 'content';
          setStreamingByAgent(prev => {
            const existing = prev[event.agent] || { content: '', thinking: '' };
            return { ...prev, [event.agent]: { ...existing, [kind]: existing[kind] + (event.delta || '') } };
          });
          return;
        }

        if (event.type === 'plan_update' && event.plan) {
        setLivePlan(event.plan);
        return;
      }

      if (event.type === 'agent_ready' && event.agent?.name) {
          const agentName = event.agent.name;
          agentNameMap[event.agent.id] = agentName;
          setLiveAgentColorMap(prev => {
            if (prev[agentName]) return prev;
            const color = event.agent.avatar_color || AGENT_COLORS[colorIndexRef.current % AGENT_COLORS.length];
            colorIndexRef.current++;
            return { ...prev, [agentName]: color };
          });
        }

        const entries = sseToEntries(event, agentNameMap);
        if (entries.length > 0) setLiveLog(prev => [...prev, ...entries]);

        if (event.type === 'round_start' || event.type === 'orchestrator_message') {
          setStreamingByAgent({});
        }
        if (event.type === 'ws') {
          const m = event.msg || {};
          if ((m.type === 'sub_tool_call' || m.type === 'tool_call') && m.subAgent) {
            setStreamingByAgent(prev => {
              if (!prev[m.subAgent]) return prev;
              const next = { ...prev };
              delete next[m.subAgent];
              return next;
            });
          }
        }

        if (event.type === 'done' || event.type === 'error') {
          setStreamingByAgent({});
          const newStatus = event.type === 'done' ? (event.status || 'done') : 'error';
          if (colonyId) {
            setColonies(prev => prev.map(c => c.id === colonyId ? { ...c, status: newStatus } : c));
            api.getColony(colonyId).then(data => {
              setLoadedColony(prev => (prev?.id === colonyId || selectedId === colonyId ? data : prev));
            }).catch(() => {});
          }
          setActiveColonyId(null);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) processLine(line.trim());
      }
    } catch (e) {
      setLiveLog(prev => [...prev, { type: 'error', content: e.message }]);
      setLaunching(false);
      setActiveColonyId(null);
    }
  };

  const handleStop = async () => {
    if (!activeColonyId) return;
    await api.stopColony(activeColonyId).catch(() => {});
    setColonies(prev => prev.map(c => c.id === activeColonyId ? { ...c, status: 'stopped' } : c));
    setActiveColonyId(null);
  };

  const handleDelete = async (id, e) => {
    e.stopPropagation();
    await api.deleteColony(id).catch(() => {});
    setColonies(prev => prev.filter(c => c.id !== id));
    if (selectedId === id) { setSelectedId(null); setLoadedColony(null); }
    if (activeColonyId === id) setActiveColonyId(null);
  };

  const handleExport = () => {
    const isLive = selectedId === activeColonyId;
    const logData = isLive ? liveLog : (loadedColony?.log || []);
    const colony = colonies.find(c => c.id === selectedId);
    const blob = new Blob([JSON.stringify({ goal: colony?.goal, model: colony?.model, status: colony?.status, log: logData }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `colony-${selectedId?.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Compute what to show in the right panel
  const selectedColony = colonies.find(c => c.id === selectedId);
  const isLive = selectedId === activeColonyId;

  // Build agentColorMap for past colony from DB log
  const pastAgentColorMap = (() => {
    if (isLive || !loadedColony?.log) return {};
    const map = {};
    let idx = 0;
    for (const e of loadedColony.log) {
      if (e.kind === 'agent_ready' && e.agent?.name) {
        const name = e.agent.name;
        if (!map[name]) {
          map[name] = e.agent?.avatar_color || AGENT_COLORS[idx % AGENT_COLORS.length];
          idx++;
        }
      }
    }
    return map;
  })();

  const pastLog = loadedColony ? dbLogToEntries(loadedColony.log, pastAgentColorMap) : [];
  const displayColony = isLive
    ? { ...selectedColony }
    : (loadedColony ? { ...loadedColony } : selectedColony);
  const displayLog = isLive ? liveLog : pastLog;
  const displayColorMap = isLive ? liveAgentColorMap : pastAgentColorMap;

  const statusDot = { running: 'bg-blue-400 animate-pulse', done: 'bg-green-400', stopped: 'bg-gray-600', error: 'bg-red-400' };
  const statusColor = { running: 'text-blue-400', done: 'text-green-400', stopped: 'text-gray-500', error: 'text-red-400' };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
            <Users size={18} className="text-gray-400" /> Colony
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">Give a goal — agents self-organize, spin up sandboxes, and execute autonomously</p>
        </div>
        <Button onClick={() => setShowForm(v => !v)} disabled={!!activeColonyId}>
          <Zap size={14} /> {activeColonyId ? 'Running…' : 'New Colony'}
        </Button>
      </div>

      {/* New colony form */}
      {showForm && !activeColonyId && (
        <div className="px-6 py-4 border-b border-gray-800 bg-gray-900/50">
          <div className="flex flex-col gap-3 max-w-2xl">
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="Describe what you want the colony to build or accomplish…&#10;e.g. Build a REST API that tracks cryptocurrency prices and stores them in SQLite"
              rows={3}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
            <div className="flex items-center gap-3">
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {models.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
              <Button onClick={handleLaunch} disabled={!goal.trim() || !model || launching}>
                {launching ? <><Loader2 size={13} className="animate-spin" /> Launching…</> : <><Zap size={13} /> Launch</>}
              </Button>
              <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Colony list */}
        <div className="w-64 flex-shrink-0 border-r border-gray-800 overflow-y-auto flex flex-col">
          {colonies.length === 0 ? (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-6 py-12">
              <Users size={32} className="text-gray-700" />
              <p className="text-sm text-gray-500">No colonies yet</p>
              <p className="text-xs text-gray-600">Launch a colony to watch agents self-organize and build autonomously</p>
            </div>
          ) : (
            colonies.map(c => (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`flex items-start gap-2 px-4 py-3 border-b border-gray-800/60 text-left hover:bg-gray-800/40 transition-colors ${selectedId === c.id ? 'bg-gray-800/60' : ''}`}
              >
                <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${statusDot[c.status] || 'bg-gray-600'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-200 line-clamp-2 leading-snug">{c.goal}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className={`text-xs ${statusColor[c.status] || 'text-gray-500'}`}>{c.status}</p>
                    <p className="text-xs text-gray-700 truncate">{c.model}</p>
                  </div>
                </div>
                <button
                  onClick={(e) => handleDelete(c.id, e)}
                  className="p-0.5 text-gray-700 hover:text-red-400 transition-colors flex-shrink-0 mt-0.5"
                >
                  <Trash2 size={11} />
                </button>
              </button>
            ))
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col p-5">
          {loadingColony ? (
            <div className="flex items-center gap-2 text-gray-600 justify-center py-8">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Loading colony…</span>
            </div>
          ) : selectedColony && displayColony ? (
            <ColonyLiveView
              colony={displayColony}
              log={displayLog}
              agentColorMap={displayColorMap}
              running={isLive}
              streamingByAgent={isLive ? streamingByAgent : {}}
              plan={isLive ? livePlan : loadedColony?.plan}
              onStop={handleStop}
              onExport={handleExport}
            />
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center">
              <Zap size={40} className="text-gray-700" />
              <p className="text-gray-500 text-sm">Select a colony or launch a new one</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
