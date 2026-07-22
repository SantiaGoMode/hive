import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Loader2, MessageSquare } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { AgentMarkdown, KVRows } from './logComponents';

// ── Communication Protocol panels ──────────────────────────────────────────────

const HANDOFF_STATUS_STYLE = {
  pending:        { label: 'pending',  cls: 'border-gray-700 text-gray-400' },
  accepted:       { label: 'accepted', cls: 'border-green-700/50 text-green-300' },
  approved:       { label: 'approved', cls: 'border-green-700/50 text-green-300' },
  rejected:       { label: 'rejected', cls: 'border-red-700/50 text-red-300' },
  // Legacy status from runs recorded before in-run human gates were removed —
  // these are auto-approved server-side; review now happens on the Draft PR.
  awaiting_human: { label: 'auto-approved', cls: 'border-green-700/50 text-green-300' },
};

// Plain-language answer to "what am I supposed to do with this status?"
const HANDOFF_STATUS_EXPLAIN = {
  pending: 'Recorded on the ledger and counts as satisfied for the flow. It shows "pending" simply because the downstream agent never explicitly marks acceptance — no action is needed from you.',
  accepted: 'Accepted — the downstream role received the work and the flow advanced. No action needed.',
  approved: 'Approved — this handoff was explicitly approved. No action needed.',
  rejected: 'Rejected: the protocol preconditions were not met when this was attempted (an upstream role had not handed off yet). The operator was redirected to fix the order — a corrected handoff usually appears later in this list. Nothing for you to do.',
  awaiting_human: 'Legacy status from before in-run approvals were removed — it auto-approves now; your review point is the Draft PR.',
};

// Comment box: posts to the colony blackboard as "User" (permanent record the
// agents can read) and, when the run is live, also queues a high-priority
// direction so the operator reacts immediately.
function UserCommentBox({ colonyId, running, context, onPosted }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const send = async () => {
    const text = val.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.postColonyBlackboard(colonyId, {
        agent: 'User',
        entry_type: 'message',
        content: `USER COMMENT${context ? ` on ${context}` : ''}: ${text}`,
      });
      if (running) {
        try { await api.sendColonyDirection(colonyId, `User comment${context ? ` on ${context}` : ''}: ${text}`); } catch { /* ignore best-effort direction failures */ }
      }
      setVal('');
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      onPosted?.();
    } catch { /* ignore best-effort comment failures */ } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') send(); }}
        placeholder={running ? 'Comment — goes to the operator now + onto the blackboard' : 'Comment — recorded on the blackboard for future reference'}
        className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <Button size="sm" variant="secondary" disabled={busy || !val.trim()} onClick={send}>
        {busy ? '…' : done ? '✓ noted' : 'Send'}
      </Button>
    </div>
  );
}

export function HandoffsPanel({ colonyId, running, refreshKey }) {
  const [handoffs, setHandoffs] = useState([]);
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(() => {
    if (!colonyId) return;
    api.getColonyHandoffs(colonyId)
      .then(data => setHandoffs(data.handoffs || []))
      .catch(() => {});
  }, [colonyId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  if (handoffs.length === 0) return null;

  // Runs are unattended — no in-run approval UI. The human review point is the
  // Draft PR opened at the end of the run. No inner scroll/height cap here: the
  // panel lives inside the status-panels scroll wrapper, and nesting a second
  // scrollbar made cards look clipped mid-row.
  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <ArrowRight size={12} className="text-indigo-400" /> Handoffs
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{handoffs.length}</span>
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {handoffs.map(h => {
            const style = HANDOFF_STATUS_STYLE[h.status] || HANDOFF_STATUS_STYLE.pending;
            const contract = h.payload?.contract || '';
            const expanded = expandedId === h.id;
            return (
              <li key={h.id} className="rounded-md border border-gray-800 bg-gray-950/40">
                <button
                  onClick={() => setExpandedId(prev => prev === h.id ? null : h.id)}
                  className="w-full text-left px-2.5 py-2"
                  title={expanded ? 'Collapse' : 'Show handoff details'}
                >
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <span className="font-medium text-gray-200">{h.from_agent}</span>
                    <ArrowRight size={11} className="text-gray-600 flex-shrink-0" />
                    <span className="font-medium text-gray-200">{h.to_agent}</span>
                    {h.payload?.auto_recorded && <span className="text-[10px] text-indigo-400/80 flex-shrink-0">auto</span>}
                    <span className={`ml-auto rounded border px-1.5 py-0.5 text-xs flex-shrink-0 ${style.cls}`}>{style.label}</span>
                    {expanded ? <ChevronDown size={12} className="text-gray-600 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />}
                  </div>
                  {contract && <p className="mt-1 text-xs text-gray-500 leading-snug">{contract}</p>}
                </button>
                {expanded && (
                  <div className="px-2.5 pb-2 border-t border-gray-800/60 pt-2 flex flex-col gap-2">
                    {/* What this status means / what (if anything) you should do */}
                    <p className="text-xs text-gray-400 leading-relaxed bg-gray-900/60 rounded px-2 py-1.5">
                      {HANDOFF_STATUS_EXPLAIN[h.status] || 'Unknown status.'}
                      {h.protocol_status && h.protocol_status !== 'ok' && (
                        <span className="block mt-1 text-amber-300/90">Protocol: {h.protocol_status}{h.payload?.summary ? ` — ${String(h.payload.summary).slice(0, 300)}` : ''}</span>
                      )}
                    </p>
                    {h.payload?.summary && h.status !== 'rejected' && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Summary from {h.from_agent}</p>
                        <div className="text-xs text-gray-300">
                          <AgentMarkdown>{String(h.payload.summary).slice(0, 1500)}</AgentMarkdown>
                        </div>
                      </div>
                    )}
                    {Array.isArray(h.payload?.artifacts) && h.payload.artifacts.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Artifacts</p>
                        <div className="flex flex-wrap gap-1">
                          {h.payload.artifacts.map((a, i) => (
                            <span key={i} className="rounded border border-gray-800 bg-gray-900/60 px-1.5 py-0.5 text-xs text-gray-400 font-mono break-all">{String(a)}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {h.payload?.payload && Object.keys(h.payload.payload).length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Payload</p>
                        <KVRows obj={h.payload.payload} />
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-[10px] text-gray-600 tabular-nums">
                      {h.created_at && <span>recorded {bbTime(h.created_at)}</span>}
                      {h.updated_at && h.updated_at !== h.created_at && <span>updated {bbTime(h.updated_at)}</span>}
                      {h.human_note && <span className="italic">note: {h.human_note}</span>}
                    </div>
                    <UserCommentBox
                      colonyId={colonyId}
                      running={running}
                      context={`handoff ${h.from_agent}→${h.to_agent} (${h.status})`}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const BB_TYPE_STYLE = {
  state:      'text-emerald-300',
  blocker:    'text-red-300',
  checkpoint: 'text-indigo-300',
  progress:   'text-blue-300',
  assistance: 'text-amber-300',
  message:    'text-sky-300',
};

// Colored accent border per entry type so cards don't blend together.
const BB_TYPE_BORDER = {
  state:      'border-l-emerald-500/50',
  blocker:    'border-l-red-500/60',
  checkpoint: 'border-l-indigo-500/50',
  progress:   'border-l-blue-500/50',
  assistance: 'border-l-amber-500/60',
  message:    'border-l-sky-500/50',
};

// Blackboard timestamps are unix SECONDS (DB created_at).
function bbTime(createdAt) {
  if (!createdAt) return null;
  try {
    return new Date(createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return null; }
}

// One blackboard note card — shared by the Blackboard panel and the crew
// member detail view so they stay visually identical.
export function NoteCard({ entry, showAgent = false, agentColor = null }) {
  const time = bbTime(entry.created_at);
  return (
    <div className={`rounded border border-gray-800/70 border-l-2 ${BB_TYPE_BORDER[entry.entry_type] || 'border-l-gray-700'} bg-gray-950/40 px-2 py-1.5 min-w-0`}>
      <div className="flex items-center gap-1.5 mb-0.5 min-w-0">
        <span className={`rounded border border-gray-800 px-1 py-px text-[10px] uppercase tracking-wide flex-shrink-0 ${BB_TYPE_STYLE[entry.entry_type] || 'text-gray-500'}`}>
          {entry.entry_type}
        </span>
        {showAgent && (
          <span className="text-xs font-medium truncate" style={agentColor ? { color: agentColor } : undefined}>
            {entry.agent}
          </span>
        )}
        {time && <span className="ml-auto text-[10px] text-gray-600 tabular-nums flex-shrink-0">{time}</span>}
      </div>
      <div className="text-xs text-gray-300">
        <AgentMarkdown>{String(entry.content || '').slice(0, 1200)}</AgentMarkdown>
      </div>
    </div>
  );
}

export function BlackboardPanel({ colonyId, running, refreshKey, resolveAgentColor = null }) {
  const [entries, setEntries] = useState([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!colonyId) return;
    api.getColonyBlackboard(colonyId)
      .then(data => setEntries(data.entries || []))
      .catch(() => {});
  }, [colonyId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  if (entries.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Blackboard
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{entries.length} entries</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {entries.map(e => (
            <NoteCard key={e.id} entry={e} showAgent agentColor={resolveAgentColor ? resolveAgentColor(e.agent) : null} />
          ))}
          <UserCommentBox colonyId={colonyId} running={running} context="the blackboard" onPosted={load} />
        </div>
      )}
    </div>
  );
}
