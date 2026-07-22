import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Zap, Square, Trash2, ChevronDown, ChevronRight, Terminal, FileText,
  MessageSquare, Wrench, Clock, CheckCircle2, XCircle, Loader2, Users,
  Server, Download, Filter, ArrowRight, AlertTriangle, Flag, ShieldCheck,
  Link2, GitBranch, ExternalLink, ArrowLeft, X, BarChart3, Package,
  Plus, Search, Inbox, Play, Sparkles, ListTodo, RefreshCw,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import { mergeToolEntries } from '../../lib/colonyUtils';
import {
  ITEM_STATUS_META,
  PROVIDER_LABEL,
  STATUS_DOT,
  STATUS_TEXT,
  TEAM_STATUS_META,
  formatSummaryMarkdown,
  parseBoardGoal,
  prettyToolName,
} from './helpers';
import { AgentMarkdown, KVRows, LogEntry } from './logComponents';
import { isSafeUrl } from './safeUrl';
import { BlackboardPanel, HandoffsPanel, NoteCard } from './protocolPanels';

// ── Colony live/replay view ────────────────────────────────────────────────────

// Work item details rendered as a full-width band under the page title: chips
// inline, description/criteria behind a one-line expandable row.
// Normalized fuzzy match between a board criterion and a QA-reported one.
function criterionVerdict(criterion, acceptance) {
  if (!Array.isArray(acceptance)) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  const c = norm(criterion);
  return acceptance.find(r => {
    const rc = norm(r.criterion);
    return rc === c || rc.includes(c) || c.includes(rc);
  }) || null;
}

function WorkItemHeader({ goal, acceptance = null }) {
  const [open, setOpen] = useState(false);
  const item = parseBoardGoal(goal);
  if (!item) {
    const text = String(goal || '');
    if (text.length < 90 && !text.includes('\n')) return null; // header title already shows it
    return (
      <div className="mt-1 min-w-0">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} mission details
        </button>
        {open && <p className="mt-1 text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{text}</p>}
      </div>
    );
  }
  const { fields, description, criteria } = item;
  const chips = [
    fields.Repository && `${fields.Repository}${fields.Number ? ` ${fields.Number}` : ''}`,
    fields.Type,
    fields.Status && `status: ${fields.Status}`,
    fields['Board status'] && `board: ${fields['Board status']}`,
  ].filter(Boolean);
  return (
    <div className="mt-1 min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c, i) => (
          <span key={i} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-500">{c}</span>
        ))}
        {fields.URL && isSafeUrl(fields.URL) && (
          <a href={fields.URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline">
            <ExternalLink size={10} /> {fields.Number || 'open'}
          </a>
        )}
        {(description || criteria.length > 0) && (
          <button onClick={() => setOpen(o => !o)} className="flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-300">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} details
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5">
          {description && <p className="text-xs text-gray-400 leading-relaxed">{description}</p>}
          {criteria.length > 0 && (
            <div className="mt-1.5">
              <p className="text-xs font-medium text-gray-500 mb-0.5">
                Acceptance criteria
                {acceptance && <span className="ml-1.5 text-gray-600 font-normal">— validated by QA</span>}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
                {criteria.map((c, i) => {
                  const v = criterionVerdict(c, acceptance);
                  const icon = v?.status === 'pass'
                    ? <CheckCircle2 size={11} className="text-green-400 flex-shrink-0 mt-0.5" />
                    : v?.status === 'fail'
                      ? <XCircle size={11} className="text-red-400 flex-shrink-0 mt-0.5" />
                      : <div className="w-2.5 h-2.5 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />;
                  return (
                    <li key={i} title={v?.evidence ? `${v.status}: ${v.evidence}` : 'not yet validated'} className={`flex items-start gap-1.5 text-xs ${v?.status === 'pass' ? 'text-gray-400' : v?.status === 'fail' ? 'text-red-300' : 'text-gray-400'}`}>
                      {icon} {c}
                      {v?.status === 'fail' && <span className="text-red-400/70">(failed)</span>}
                      {!v && acceptance && <span className="text-gray-600">(not verified)</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Plan rendered as a slim horizontal strip above the output: progress bar plus
// wrapping step chips — minimal vertical footprint.
function PlanStrip({ plan }) {
  // Click a step chip to expand it to its full text (and note); click again to collapse.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const toggleStep = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const done = plan.steps.filter(s => s.status === 'done').length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const iconFor = (status) => {
    if (status === 'done') return <CheckCircle2 size={11} className="text-green-400 flex-shrink-0" />;
    if (status === 'in_progress') return <Loader2 size={11} className="text-blue-400 animate-spin flex-shrink-0" />;
    if (status === 'blocked') return <XCircle size={11} className="text-red-400 flex-shrink-0" />;
    return <div className="w-2.5 h-2.5 rounded-full border border-gray-600 flex-shrink-0" />;
  };
  const chipColor = (status) => {
    if (status === 'done') return 'border-green-900/50 text-gray-500';
    if (status === 'in_progress') return 'border-blue-800/60 text-blue-300';
    if (status === 'blocked') return 'border-red-900/60 text-red-300';
    return 'border-gray-800 text-gray-400';
  };
  return (
    <div className="mb-2 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-300 flex-shrink-0">Plan</span>
        <div className="h-1 bg-gray-800 rounded overflow-hidden flex-1">
          <div className="h-full bg-green-500/70 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">{done}/{total} · {pct}%</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {plan.steps.map(step => {
          const expanded = expandedIds.has(step.id);
          return (
            <button
              key={step.id}
              onClick={() => toggleStep(step.id)}
              title={expanded ? 'Collapse' : `${step.description}${step.note ? `\n${step.note}` : ''}`}
              className={`flex items-start gap-1 rounded border bg-gray-950/40 px-1.5 py-0.5 text-xs text-left cursor-pointer hover:bg-gray-900 transition-colors ${expanded ? 'basis-full' : 'max-w-[16rem]'} ${chipColor(step.status)}`}
            >
              <span className="mt-0.5">{iconFor(step.status)}</span>
              {expanded ? (
                <span className="min-w-0">
                  <span className="break-words">{step.id}. {step.description}</span>
                  {step.assigned_to && <span className="text-gray-600"> → {step.assigned_to}</span>}
                  {step.note && <span className="block text-gray-500 italic mt-0.5 break-words">{step.note}</span>}
                </span>
              ) : (
                <span className="truncate">{step.id}. {step.description}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CrewRoster({ colony, log, agentColorMap, filterAgent, onFilterAgent }) {
  const [open, setOpen] = useState(false);
  const initials = (name) => String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

  // Blackboard entries ARE the workers' notes. They're recorded under the role
  // display name ("Software Developer"), not the persona name ("Sam Rivera"),
  // so they're matched to crew members by role OR name below. (The old "0 notes"
  // counted `message` log entries, which only the orchestrator emits.)
  const [bbEntries, setBbEntries] = useState([]);
  const running = colony?.status === 'running';
  const colonyId = colony?.id;
  const logLength = (log || []).length;
  const loadBb = useCallback(() => {
    if (!colonyId) return;
    api.getColonyBlackboard(colonyId)
      .then(data => setBbEntries(data.entries || []))
      .catch(() => {});
  }, [colonyId]);
  useEffect(() => { loadBb(); }, [loadBb, logLength]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(loadBb, 5000);
    return () => clearInterval(t);
  }, [running, loadBb]);

  const roster = useMemo(() => {
    const byName = new Map();
    const normName = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

    const ensure = (name, patch = {}) => {
      if (!name) return null;
      const existing = byName.get(name) || {
        name,
        role: '',
        model: '',
        configuredTools: [],
        kind: 'worker',
        color: agentColorMap[name] || '#6b7280',
        toolCount: 0,
        tools: new Map(), // tool name -> count
        notes: [],
      };
      const next = {
        ...existing,
        ...patch,
        color: patch.color || existing.color || agentColorMap[name] || '#6b7280',
      };
      byName.set(name, next);
      return next;
    };

    for (const agent of colony?.agents || []) {
      // Identify the lead robustly via the colony's orchestrator_id rather than
      // pattern-matching the persona_role string.
      const isLead = colony?.orchestrator_id && agent.id === colony.orchestrator_id;
      ensure(agent.name, {
        role: agent.persona_role || agent.role || '',
        model: agent.model || '',
        configuredTools: Array.isArray(agent.tools) ? agent.tools : [],
        kind: isLead ? 'orchestrator' : 'worker',
        color: agent.avatar_color || agentColorMap[agent.name],
      });
    }

    for (const entry of log || []) {
      if (entry.type === 'agent_ready') {
        const current = byName.get(entry.agent);
        ensure(entry.agent, {
          kind: entry.role === 'orchestrator' ? 'orchestrator' : 'worker',
          role: entry.agent_role || current?.role || (entry.role === 'orchestrator' ? 'Orchestrator' : 'Specialist'),
          model: entry.model || current?.model || '',
          configuredTools: Array.isArray(entry.tools) ? entry.tools : (current?.configuredTools || []),
          color: entry.avatar_color || current?.color,
        });
      }
      if ((entry.type === 'tool_call' || entry.type === 'sub_tool_call') && entry.agent) {
        const item = ensure(entry.agent);
        if (item) {
          item.toolCount += 1;
          if (entry.tool) item.tools.set(entry.tool, (item.tools.get(entry.tool) || 0) + 1);
        }
      }
    }

    // Attribute blackboard notes by persona name OR role display name.
    const members = [...byName.values()];
    for (const e of bbEntries) {
      const who = normName(e.agent);
      const member = members.find(m => normName(m.name) === who || normName(m.role) === who)
        // "Operator"/"system" notes attach to the orchestrator.
        || (/(operator|orchestrator|system)/.test(who) ? members.find(m => m.kind === 'orchestrator') : null);
      if (member) member.notes.push(e);
    }

    return members.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'orchestrator' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [agentColorMap, colony, log, bbEntries]);

  const [expandedAgent, setExpandedAgent] = useState(null);

  if (roster.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5 min-w-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Crew
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{roster.length} agent{roster.length !== 1 ? 's' : ''}</span>
      </button>
      {open && (
      <div className="grid grid-cols-1 gap-2 mt-2">
        {roster.map(agent => {
          const active = filterAgent === null || filterAgent === agent.name;
          const expanded = expandedAgent === agent.name;
          return (
            <div
              key={agent.name}
              className={`rounded-md border min-w-0 transition-colors ${active ? 'border-gray-700 bg-gray-800/50' : 'border-gray-800 bg-gray-950/30 opacity-60'}`}
            >
              {/* Card header: click to expand tools/notes; filter is its own button */}
              <button
                onClick={() => setExpandedAgent(prev => prev === agent.name ? null : agent.name)}
                className="w-full text-left px-2.5 py-2 min-w-0"
                title={expanded ? 'Collapse' : 'Show tools used and notes taken'}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
                    style={{ background: agent.color }}
                  >
                    {initials(agent.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-200 truncate">{agent.name}</p>
                    <p className="text-xs text-gray-600 truncate">
                      {agent.role || 'Specialist'}{agent.model ? ` · ${agent.model}` : ''}
                    </p>
                  </div>
                  <span className="text-xs text-gray-600 flex-shrink-0 tabular-nums">
                    {agent.toolCount} tools · {agent.notes.length} notes
                  </span>
                  {expanded ? <ChevronDown size={12} className="text-gray-600 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />}
                </div>
              </button>
              {expanded && (
                <div className="px-2.5 pb-2 border-t border-gray-800/60 pt-2 flex flex-col gap-2">
                  {/* Tools used, with per-tool counts */}
                  {agent.model && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Model</p>
                      <span className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-400 font-mono">
                        {agent.model}
                      </span>
                    </div>
                  )}
                  {agent.configuredTools.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Configured tools</p>
                      <div className="flex flex-wrap gap-1">
                        {agent.configuredTools.map(tool => (
                          <span key={tool} title={tool} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-500 font-mono">
                            {prettyToolName(tool)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Tools used</p>
                    {agent.tools.size === 0 ? (
                      <p className="text-xs text-gray-600 italic">no tool calls recorded</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {[...agent.tools.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => (
                          <span key={tool} title={tool} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-400 font-mono">
                            {prettyToolName(tool)}{count > 1 ? ` ×${count}` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Notes (blackboard entries by this member) */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Notes (blackboard)</p>
                    {agent.notes.length === 0 ? (
                      <p className="text-xs text-gray-600 italic">no blackboard notes yet</p>
                    ) : (
                      <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
                        {agent.notes.map((n, i) => (
                          <NoteCard key={n.id || i} entry={n} />
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => onFilterAgent(prev => prev === agent.name ? null : agent.name)}
                    className={`self-start flex items-center gap-1 text-xs ${filterAgent === agent.name ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    <Filter size={10} /> {filterAgent === agent.name ? 'Clear log filter' : 'Filter log to this agent'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

export function ColonyLiveView({ colony, log, agentColorMap, running, streamingByAgent = {}, plan = null, onStop, onExport, onBack = null, blockers = [], prUrl = null }) {
  const bottomRef = useRef(null);
  const [filterAgent, setFilterAgent] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Reasoning display is no longer a run-screen toggle — which agents reason is
  // an operator decision made at run start, and their thinking streams as-is.
  const showReasoning = true;
  const [showPanels, setShowPanels] = useState(true);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState(null);
  const [acceptingTasks, setAcceptingTasks] = useState(false);
  const [acceptError, setAcceptError] = useState(null);
  const [artifactView, setArtifactView] = useState(null); // artifact path | null

  const postToBoard = async () => {
    setPosting(true);
    setPostResult(null);
    try {
      const r = await api.postColonyBoardComment(colony.id);
      setPostResult({ ok: true, url: r.url });
    } catch (e) {
      setPostResult({ ok: false, error: e.message });
    } finally {
      setPosting(false);
    }
  };

  const acceptBootstrapTasks = async () => {
    setAcceptingTasks(true);
    setAcceptError(null);
    try {
      await api.acceptBootstrapTasks(colony.id);
      window.location.reload();
    } catch (e) {
      setAcceptError(e.message);
    } finally {
      setAcceptingTasks(false);
    }
  };

  const streamingEntries = Object.entries(streamingByAgent).filter(
    ([, v]) => (v?.content && v.content.length > 0) || (v?.thinking && v.thinking.length > 0),
  );

  // Auto-scroll when log grows OR streaming text updates
  const streamingLen = streamingEntries.reduce((n, [, v]) => n + (v.content?.length || 0) + (v.thinking?.length || 0), 0);
  useEffect(() => {
    // 'auto' (instant) — queued 'smooth' animations stack up during streaming
    // and make the log feel like it's pausing/rubber-banding.
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [log.length, streamingLen, autoScroll]);

  const merged = mergeToolEntries(log);

  // The run auto-posts its deliverable to the linked board item; the manual
  // button is only a RETRY for when that failed.
  const boardPosted = log.some(e =>
    e.kind === 'writeback' && (e.comment_url || /Posted update/.test(e.message || '')));

  const filtered = filterAgent
    ? merged.filter(e => !e.agent || e.agent === filterAgent || e.type === 'round' || e.type === 'done' || e.type === 'error' || e.type === 'system')
    : merged;

  const agents = Object.entries(agentColorMap).map(([name, color]) => ({ name, color }));

  const statusColor = { running: 'text-blue-400', done: 'text-green-400', stopped: 'text-gray-400', awaiting_tasks: 'text-amber-300', blocked: 'text-amber-300', failed: 'text-red-400', error: 'text-red-400' };
  const statusIcon = {
    running: <Loader2 size={12} className="animate-spin" />,
    done: <CheckCircle2 size={12} />,
    stopped: <Square size={12} />,
    awaiting_tasks: <FileText size={12} />,
    blocked: <XCircle size={12} />,
    failed: <XCircle size={12} />,
    error: <XCircle size={12} />,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Colony header — show a clean title; full work-item details render in the
          formatted Work item card below, not as a raw text dump here. */}
      <div className="flex items-start gap-3 pb-3 border-b border-gray-800 mb-2">
        {onBack && (
          <button onClick={onBack} className="mt-0.5 p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition flex-shrink-0" title="Back to colony">
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200 leading-snug line-clamp-2">
            {(() => {
              const item = parseBoardGoal(colony.goal);
              if (item) return `${item.fields.Number ? `${item.fields.Number} · ` : ''}${item.fields.Title || 'Work item'}`;
              return colony.goal;
            })()}
          </p>
          {/* Full work item details across the top */}
          <WorkItemHeader goal={colony.goal} acceptance={colony.deliverable?.acceptance?.results || null} />
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className={`flex items-center gap-1 text-xs ${statusColor[colony.status] || 'text-gray-500'}`}>
              {statusIcon[colony.status]}
              {colony.status}
            </span>
            <span className="text-xs text-gray-600">{colony.model}</span>
            <span className="text-xs text-gray-700">{formatDate(colony.created_at * 1000)}</span>
            {isSafeUrl(colony.trigger?.source_url) && (
              <a href={colony.trigger.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline">
                <Flag size={11} /> source event
              </a>
            )}
            {colony.board_card?.number && isSafeUrl(colony.board_card?.url) && (
              <a href={colony.board_card.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
                <Link2 size={11} /> {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number}
              </a>
            )}
            {colony.trigger_config?.webhook_id && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Zap size={11} /> triggers: {(colony.trigger_config.event_types || []).join(', ')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowPanels(v => !v)}
            className={showPanels ? 'text-gray-400 hover:text-gray-200' : 'text-blue-400 hover:text-blue-300'}
            title="Show/hide the work item, plan, crew, handoffs, and summary panels"
          >
            {showPanels ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details
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

      {/* Two-column body: details sidebar on the LEFT, output/log on the RIGHT.
          One scroll surface per column — no more stacked sections with nested
          scrollbars squeezing the output. */}
      <div className="flex flex-1 min-h-0 gap-4">

      {/* Details column (collapsible via the "Details" button) */}
      <div className={`w-96 xl:w-[28rem] flex-shrink-0 min-h-0 overflow-y-auto pr-1 flex-col gap-3 ${showPanels ? 'flex' : 'hidden'}`}>

      <CrewRoster
        colony={colony}
        log={log}
        agentColorMap={agentColorMap}
        filterAgent={filterAgent}
        onFilterAgent={setFilterAgent}
      />

      {/* Draft PR badge — shown once the branch has been pushed */}
      {isSafeUrl(prUrl) && (
        <a href={prUrl} target="_blank" rel="noreferrer"
          className="mb-3 flex items-center gap-2 rounded-lg border border-green-700/50 bg-green-950/20 px-3 py-2 text-xs text-green-300 hover:bg-green-950/40 transition-colors">
          <GitBranch size={13} className="flex-shrink-0" />
          <span className="font-medium">Draft PR opened</span>
          <span className="text-green-500 truncate">{prUrl}</span>
          <ExternalLink size={11} className="ml-auto flex-shrink-0" />
        </a>
      )}

      {/* HITL Blocker alerts — require human action before the colony can continue */}
      {blockers.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {blockers.map((b, i) => (
            <div key={i} className="rounded-lg border border-amber-600/60 bg-amber-950/30 px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs font-semibold text-amber-300">Action Required — Colony is paused</span>
              </div>
              <pre className="text-xs text-amber-200/80 whitespace-pre-wrap break-words leading-relaxed font-sans">{b.message}</pre>
              {b.action === 'retry_push' && (
                <p className="mt-2 text-xs text-amber-400/70">Fix the issue above, then push the branch manually and open a PR on GitHub.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {colony.status === 'awaiting_tasks' && Array.isArray(colony.bootstrap_tasks) && colony.bootstrap_tasks.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2.5">
          <div className="flex items-center gap-2 mb-2">
            <FileText size={13} className="text-amber-300" />
            <span className="text-xs font-semibold text-amber-200">Bootstrap Tasks Awaiting Review</span>
            <Button size="sm" className="ml-auto" disabled={acceptingTasks} onClick={acceptBootstrapTasks}>
              {acceptingTasks ? 'Starting…' : 'Use these tasks'}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {colony.bootstrap_tasks.map(task => (
              <div key={task.id || task.title} className="rounded border border-amber-900/40 bg-gray-950/30 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-300 font-mono">{task.id}</span>
                  <span className="text-xs font-medium text-gray-100">{task.title}</span>
                </div>
                {task.description && <p className="mt-1 text-xs text-gray-400 leading-snug">{task.description}</p>}
                {Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0 && (
                  <p className="mt-1 text-xs text-gray-500 leading-snug">Acceptance: {task.acceptance_criteria.join('; ')}</p>
                )}
              </div>
            ))}
          </div>
          {acceptError && <p className="mt-2 text-xs text-red-400">{acceptError}</p>}
        </div>
      )}

      {/* Communication protocol — handoff lifecycle, shared blackboard */}
      <HandoffsPanel colonyId={colony.id} running={running} refreshKey={log.length} />
      <BlackboardPanel
        colonyId={colony.id}
        running={running}
        refreshKey={log.length}
        resolveAgentColor={(who) => {
          // Entries are written under either the persona name ("Sam Rivera") or
          // the role display name ("Software Developer") — resolve both.
          if (agentColorMap[who]) return agentColorMap[who];
          const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
          const match = (colony.agents || []).find(a => norm(a.persona_role) === norm(who) || norm(a.name) === norm(who));
          return match ? (agentColorMap[match.name] || match.avatar_color || null) : null;
        }}
      />

      {/* Summary + structured deliverable card */}
      {colony.summary && (
        <div className="mb-3 rounded-lg border border-green-900/50 bg-green-950/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <CheckCircle2 size={13} className="text-green-400" />
            <span className="text-xs font-semibold text-green-400">Goal Achieved</span>
            {colony.deliverable && (
              <span className={`ml-auto rounded border px-1.5 py-0.5 text-xs ${colony.deliverable.flow_complete ? 'border-green-700/50 text-green-300' : 'border-amber-700/50 text-amber-300'}`}>
                {colony.deliverable.flow_complete ? 'flow complete' : 'partial flow'}
              </span>
            )}
          </div>
          <div className="text-xs text-green-200/90 leading-relaxed">
            <AgentMarkdown>{formatSummaryMarkdown(colony.summary)}</AgentMarkdown>
          </div>
          {colony.deliverable?.report && String(colony.deliverable.report).trim() !== String(colony.summary || '').trim() && (
            <details className="mt-2 rounded-md border border-green-900/40 bg-green-950/10 px-2.5 py-2" open>
              <summary className="cursor-pointer text-xs font-semibold text-green-300/90">Full report</summary>
              <div className="mt-2 text-xs text-green-100/90 leading-relaxed">
                <AgentMarkdown>{String(colony.deliverable.report)}</AgentMarkdown>
              </div>
            </details>
          )}
          {colony.deliverable && (colony.deliverable.links?.length > 0 || colony.deliverable.artifacts?.length > 0) && (
            <div className="mt-2 flex flex-col gap-1">
              {colony.deliverable.links?.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <ShieldCheck size={11} className="text-green-500/70" />
                  {colony.deliverable.links.map((l, i) => (
                    isSafeUrl(l)
                      ? <a key={i} href={l} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:underline truncate max-w-xs">{l}</a>
                      : <span key={i} className="text-xs text-gray-400 truncate max-w-xs">{l}</span>
                  ))}
                </div>
              )}
              {colony.deliverable.artifacts?.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <FileText size={11} className="text-gray-500" />
                  {colony.deliverable.artifacts.map((a, i) => (
                    <button key={i} type="button" onClick={() => setArtifactView(a)} className="text-xs text-blue-300/90 hover:text-blue-200 hover:underline truncate max-w-xs text-left" title="Open this artifact">
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {colony.deliverable?.workarounds?.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-800/50 bg-amber-950/20 px-2.5 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <AlertTriangle size={12} className="text-amber-400" />
                <span className="text-xs font-semibold text-amber-300">Operator improvement report</span>
              </div>
              <div className="space-y-2">
                {colony.deliverable.workarounds.map((w, i) => (
                  <div key={i} className="text-xs leading-relaxed border-l-2 border-amber-800/50 pl-2">
                    <p className="font-medium text-amber-200">{w.issue}</p>
                    {w.workaround && (
                      <p className="text-amber-100/80"><span className="text-amber-400/70">Workaround:</span> {w.workaround}</p>
                    )}
                    {w.recommendation && (
                      <p className="text-amber-100/80"><span className="text-amber-400/70">Improve:</span> {w.recommendation}</p>
                    )}
                    {w.impact && (
                      <p className="text-amber-200/60"><span className="text-amber-400/70">Impact:</span> {w.impact}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {colony.board_card?.number && (
            <div className="mt-2 flex items-center gap-2">
              {boardPosted && !postResult ? (
                <span className="flex items-center gap-1 text-xs text-green-400/80">
                  <CheckCircle2 size={11} /> Update posted to {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number} automatically
                </span>
              ) : (
                <Button size="sm" variant="secondary" disabled={posting} onClick={postToBoard} title="The run posts this automatically — use only if the auto-post failed">
                  {posting ? 'Posting…' : `Retry posting update to #${colony.board_card.number}`}
                </Button>
              )}
              {postResult?.ok && isSafeUrl(postResult.url || colony.board_card.url) && (
                <a href={postResult.url || colony.board_card.url} target="_blank" rel="noreferrer" className="text-xs text-green-300 hover:underline">
                  Posted to {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number}
                </a>
              )}
              {postResult && !postResult.ok && <span className="text-xs text-red-400">{postResult.error}</span>}
            </div>
          )}
        </div>
      )}

      </div>{/* end details column */}

      {/* Output column — gets all remaining width and one scrollbar */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">

      {/* Plan strip — spread across the output, slim vertical footprint */}
      <PlanStrip plan={plan} />

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
          const thinkingOnly = !buf.content && buf.thinking;
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
                {/* Reasoning hidden but the model is mid-think — show a pulse so
                    the stream doesn't look stalled. */}
                {!showReasoning && thinkingOnly && (
                  <p className="text-xs text-gray-600 italic font-sans animate-pulse">thinking…</p>
                )}
                {buf.content && (
                  <div className="text-sm text-gray-300 leading-relaxed font-sans">
                    <AgentMarkdown>{buf.content}</AgentMarkdown>
                    <span className="inline-block w-1.5 h-3 bg-gray-400 align-middle ml-0.5 animate-pulse" />
                  </div>
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

      {/* Direction input — message the running colony directly */}
      <DirectionInput colonyId={colony.id} disabled={!running} />

      </div>{/* end output column */}
      </div>{/* end two-column body */}

      {artifactView && (
        <ArtifactViewerModal key={`${colony.id}:${artifactView}`} runId={colony.id} path={artifactView} onClose={() => setArtifactView(null)} />
      )}
    </div>
  );
}

function DirectionInput({ colonyId, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setSending(true);
    setStatus('');
    try {
      await api.sendColonyDirection(colonyId, v);
      setText('');
      setStatus('Queued for the next operator round');
    } catch (e) {
      setStatus(e.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-2 border-t border-gray-800 pt-2">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder={disabled ? 'Direction is available while the colony is running' : 'Direct the colony… e.g. focus on the v2 endpoints first'}
          disabled={disabled || sending}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600 disabled:opacity-50"
        />
        <Button size="sm" onClick={send} disabled={disabled || sending || !text.trim()}>
          {sending ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} Send
        </Button>
      </div>
      {status && <p className="mt-1 text-xs text-gray-500">{status}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
// A Colony is a named, persistent team (e.g. "Hive-TaskMaster"). The main tab
// lists colonies as cards; each colony page shows an overview (crew,
// performance, runs, artifacts) and is where runs are launched against the
// team's work items. Repo/project + base config are set when the colony is
// created — not per run. All three views render from this ONE mounted
// component so a live SSE stream survives internal navigation:
//   /colony                      → colony cards
//   /colony/:teamId              → colony page
//   /colony/:teamId/run/:runId   → run page (live view / replay)

// Create / edit a colony. Issues and tasks are deliberately NOT selected here —
// they're picked from the colony page when launching a run. Only the team
// identity (name, description) and base config (preset, repo, toggles) live here.
