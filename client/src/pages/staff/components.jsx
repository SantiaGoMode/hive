import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, Clock, MessageSquare, RefreshCw,
  SlidersHorizontal, Trash2, X, XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';
import { formatDate } from '../../lib/utils';
import { modelBadge } from '../../lib/modelLabels';
import { toast } from '../../stores/toastStore';
import { initials } from './utils';

// Multi-select picker: toggleable option chips from a catalog, plus legacy
// values not in the catalog rendered as removable "custom" chips.
export function MultiPicker({ label, options, selected, onChange, emptyHint }) {
  const optionValues = new Set(options.map(o => o.value));
  const customValues = selected.filter(v => !optionValues.has(v));

  const toggle = (value) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">{label}</label>
        <span className="text-xs text-gray-600">{selected.length} selected</span>
      </div>
      {options.length === 0 && <p className="text-xs text-gray-600 italic">{emptyHint}</p>}
      <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
        {options.map(option => {
          const active = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              className={`text-left rounded-lg border px-3 py-2 transition-colors ${active ? 'border-blue-500/60 bg-blue-500/10' : 'border-gray-800 bg-gray-950/40 hover:border-gray-700'}`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center ${active ? 'border-blue-500 bg-blue-500' : 'border-gray-600'}`}>
                  {active && <CheckCircle2 size={10} className="text-white" />}
                </span>
                <span className={`text-sm ${active ? 'text-gray-100' : 'text-gray-300'}`}>{option.label}</span>
                {option.connected === false && <span className="text-xs text-gray-600">(disconnected)</span>}
              </div>
              {option.description && <p className="mt-0.5 ml-5 text-xs text-gray-500 leading-relaxed">{option.description}</p>}
              {/* Explicit function list — exactly what this tool group grants access to */}
              {(option.functions?.length > 0 || option.tool_names?.length > 0) && (
                <p className="mt-1 ml-5 text-xs text-gray-600 font-mono leading-relaxed break-words">
                  {(option.functions?.length ? option.functions.map(f => f.name) : option.tool_names).join(' · ')}
                </p>
              )}
            </button>
          );
        })}
      </div>
      {customValues.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-gray-600">Legacy entries (not in catalog):</p>
          <div className="flex flex-wrap gap-1.5">
            {customValues.map(value => (
              <span key={value} className="flex items-center gap-1 text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300">
                {value}
                <button type="button" onClick={() => toggle(value)} className="text-gray-500 hover:text-red-400 transition-colors">
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StaffMarkdown({ children }) {
  return (
    <div className="text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown components={{
        p: ({ children: kids }) => <p className="my-1.5">{kids}</p>,
        ul: ({ children: kids }) => <ul className="my-1.5 pl-4 list-disc space-y-1 marker:text-gray-600">{kids}</ul>,
        ol: ({ children: kids }) => <ol className="my-1.5 pl-4 list-decimal space-y-1 marker:text-gray-600">{kids}</ol>,
        li: ({ children: kids }) => <li>{kids}</li>,
        code({ inline, children: kids }) {
          return inline
            ? <code className="bg-gray-900 px-1 py-0.5 rounded text-blue-300 font-mono text-xs">{kids}</code>
            : <pre className="bg-gray-900 rounded-lg p-2 overflow-auto my-2"><code className="font-mono text-xs text-gray-300">{kids}</code></pre>;
        },
      }}>{String(children || '')}</ReactMarkdown>
    </div>
  );
}

export function Metric({ label, value, active, drillable, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!drillable}
      className={`text-left rounded-md border px-3 py-2 transition-colors ${active ? 'border-blue-500/60 bg-blue-950/30' : 'border-gray-800 bg-gray-950/40'} ${drillable ? 'hover:border-gray-600 cursor-pointer' : 'cursor-default'}`}
    >
      <p className="text-xs text-gray-500 flex items-center gap-1">
        {label}
        {drillable && <ChevronDown size={10} className={`text-gray-600 transition-transform ${active ? 'rotate-180' : ''}`} />}
      </p>
      <p className="mt-1 text-lg font-semibold text-gray-100 tabular-nums">{value}</p>
    </button>
  );
}

// Evidence list for a drilled-down performance metric.
export function MetricDetailList({ metricKey, items }) {
  if (!items?.length) {
    return <p className="text-sm text-gray-600 text-center py-6">No underlying records for this metric.</p>;
  }
  const isHandoff = ['successful_handoffs', 'rejected_handoffs', 'auto_recorded_handoffs'].includes(metricKey);
  const isNote = ['blocker_count', 'user_comments_received'].includes(metricKey);
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <div key={item.id || i} className="rounded border border-gray-800 bg-gray-950/40 px-3 py-2 text-xs">
          {isHandoff && (
            <>
              <p className="text-gray-300">{item.from_agent} → {item.to_agent}</p>
              <p className="text-gray-600 mt-0.5">
                {item.status} · {item.protocol_status}
                {item.created_at ? ` · ${formatDate(item.created_at * 1000)}` : ''}
                {item.colony_id ? <> · colony <code className="bg-gray-900 px-1 rounded">{item.colony_id}</code></> : ''}
              </p>
            </>
          )}
          {isNote && (
            <>
              <p className="text-gray-600">{item.entry_type} · {item.agent}{item.colony_id ? <> · colony <code className="bg-gray-900 px-1 rounded">{item.colony_id}</code></> : ''}</p>
              <div className="text-gray-300 mt-1"><StaffMarkdown>{item.content}</StaffMarkdown></div>
            </>
          )}
          {metricKey === 'tool_error_count' && (
            <>
              <p className="text-gray-300"><code className="bg-gray-900 px-1 rounded">{item.tool || 'unknown tool'}</code> failed</p>
              <p className="text-red-400/80 mt-1 break-words">{item.error}</p>
              <p className="text-gray-600 mt-0.5">{item.agent}{item.colony_id ? <> · colony <code className="bg-gray-900 px-1 rounded">{item.colony_id}</code></> : ''}</p>
            </>
          )}
          {metricKey === 'retry_count' && (
            <>
              <p className="text-gray-300">{item.summary}</p>
              <p className="text-gray-600 mt-0.5">{item.agent}{item.kind ? ` · ${item.kind}` : ''}{item.colony_id ? <> · colony <code className="bg-gray-900 px-1 rounded">{item.colony_id}</code></> : ''}</p>
            </>
          )}
          {item.colony_id && (
            <Link
              to={item.team_id ? `/colony/${item.team_id}/run/${item.colony_id}` : '/colony'}
              className="text-blue-300 hover:underline inline-block mt-1"
            >
              Open Colony Run
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

export function ProfileCard({ profile, active, onClick }) {
  const model = profile.model_preference ? modelBadge(profile.model_preference) : null;
  return (
    <button
      onClick={onClick}
      className={`text-left rounded-lg border px-3 py-3 transition-colors min-w-0 ${active ? 'border-blue-500/50 bg-blue-950/20' : 'border-gray-800 bg-gray-900/50 hover:border-gray-700'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-semibold text-white flex-shrink-0" style={{ background: profile.avatar_color }}>
          {initials(profile.display_name)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-100 truncate">{profile.display_name}</p>
          <p className="text-xs text-gray-500 truncate">{profile.role}</p>
        </div>
        {profile.suggestion_count > 0 && (
          <span className="rounded-full border border-amber-700/50 bg-amber-950/30 px-1.5 py-0.5 text-xs text-amber-300">
            {profile.suggestion_count}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <span className="text-xs border border-gray-800 rounded px-1.5 py-0.5 text-gray-500">{profile.recipe_id}</span>
        <span className={`text-xs border rounded px-1.5 py-0.5 ${profile.chat_enabled ? 'border-green-800/60 text-green-300' : 'border-gray-800 text-gray-600'}`}>
          {profile.chat_enabled ? `${profile.chat_interval_minutes}m chat` : 'chat off'}
        </span>
        {(profile.prompt_customized || profile.tools_customized) && (
          <span
            className="text-xs border border-amber-700/50 bg-amber-950/30 rounded px-1.5 py-0.5 text-amber-300"
            title="Prompt or tools were customized — frozen from recipe updates (reset from the profile's Prompt tab)"
          >
            customized
          </span>
        )}
        {model && <span title={model.title} className="text-xs border border-gray-800 rounded px-1.5 py-0.5 text-gray-400 max-w-full truncate">{model.text}</span>}
      </div>
      {profile.metrics && (
        <p className="mt-2 text-xs text-gray-600">
          {profile.metrics.successful_handoffs} handoffs · {profile.metrics.blocker_count} blockers · {profile.metrics.tool_error_count} tool errors
        </p>
      )}
    </button>
  );
}

export function Suggestion({ suggestion, onApply, onDismiss }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(suggestion.proposed_value);
  const isPending = suggestion.status === 'pending';
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-200">{suggestion.target_field}</span>
            <span className="text-xs text-gray-600">{suggestion.evidence_type}: {suggestion.evidence_ref}</span>
            <span className={`text-xs rounded border px-1.5 py-0.5 ${isPending ? 'border-amber-700/50 text-amber-300' : suggestion.status === 'applied' ? 'border-green-700/50 text-green-300' : 'border-gray-700 text-gray-500'}`}>
              {suggestion.status}
            </span>
          </div>
          {suggestion.rationale && <p className="mt-1 text-xs text-gray-500">{suggestion.rationale}</p>}
          {editing ? (
            <textarea
              value={value}
              onChange={e => setValue(e.target.value)}
              rows={5}
              className="mt-2 w-full bg-gray-900 border border-gray-800 rounded px-2 py-1.5 text-xs text-gray-100 font-mono resize-none focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          ) : (
            <pre className="mt-2 text-xs text-gray-400 whitespace-pre-wrap break-words max-h-40 overflow-y-auto bg-gray-900 rounded px-2 py-1.5">{suggestion.proposed_value}</pre>
          )}
        </div>
      </div>
      {isPending && (
        <div className="mt-2 flex items-center gap-2 justify-end">
          <Button size="sm" variant="ghost" onClick={() => setEditing(v => !v)}>
            <SlidersHorizontal size={12} /> {editing ? 'Preview' : 'Edit'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onDismiss(suggestion.id)}>
            <XCircle size={12} /> Dismiss
          </Button>
          <Button size="sm" onClick={() => onApply(suggestion.id, editing ? value : undefined)}>
            <CheckCircle2 size={12} /> Apply
          </Button>
        </div>
      )}
    </div>
  );
}

export function StaffChat({ profilesById }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef(null);

  const load = useCallback(() => {
    api.getStaffChat(100).then(data => setMessages(data.messages || [])).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setSending(true);
    try {
      await api.postStaffChat(v);
      setText('');
      load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  const authorName = (message) => {
    if (message.author_profile_id) return profilesById[message.author_profile_id]?.display_name || 'Staff';
    return message.author_type === 'user' ? 'You' : 'System';
  };

  return (
    <div className="border-t border-gray-800 bg-gray-950/30 pt-3">
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare size={14} className="text-gray-500" />
        <span className="text-sm font-semibold text-gray-200">Staff Chat</span>
        <span className="text-xs text-gray-600">casual lounge chat; keep task details in Colony chats</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={load}>
          <RefreshCw size={12} /> Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-gray-600 hover:text-red-400"
          onClick={async () => {
            if (!window.confirm('Clear all staff chat history? Staff will start chatting fresh.')) return;
            try {
              await api.clearStaffChat();
              setMessages([]);
              toast.success('Staff chat cleared');
            } catch (e) {
              toast.error(e.message);
            }
          }}
        >
          <Trash2 size={12} /> Clear
        </Button>
      </div>
      <div className="h-72 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 flex flex-col gap-2">
        {messages.length === 0 && <p className="text-sm text-gray-600 text-center py-8">No staff chat yet.</p>}
        {messages.map(message => {
          const profile = message.author_profile_id ? profilesById[message.author_profile_id] : null;
          return (
            <div key={message.id} className="flex items-start gap-2">
              <span className="w-7 h-7 rounded flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0" style={{ background: profile?.avatar_color || '#374151' }}>
                {message.author_type === 'user' ? 'You' : initials(authorName(message))}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-gray-300">{authorName(message)}</span>
                  <span className="text-xs text-gray-700">{message.trigger_type}</span>
                  <span className="text-xs text-gray-700">{formatDate(message.created_at * 1000)}</span>
                </div>
                <div className="text-sm text-gray-300">
                  <StaffMarkdown>{message.content}</StaffMarkdown>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder="Water cooler chat… mention @Sam, @qa_engineer, or @Project Manager"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
        />
        <Button size="sm" onClick={send} disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : <><ArrowRight size={12} /> Send</>}
        </Button>
      </div>
    </div>
  );
}

export function StaffPerformanceTab({ selected, drilledMetric, setDrilledMetric }) {
  return (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { key: 'successful_handoffs', label: 'Successful handoffs', value: selected.metrics.successful_handoffs },
                        { key: 'rejected_handoffs', label: 'Rejected handoffs', value: selected.metrics.rejected_handoffs },
                        { key: 'auto_recorded_handoffs', label: 'Auto-recorded', value: selected.metrics.auto_recorded_handoffs },
                        { key: 'blocker_count', label: 'Blockers', value: selected.metrics.blocker_count },
                        { key: 'tool_error_count', label: 'Tool errors', value: selected.metrics.tool_error_count },
                        { key: 'retry_count', label: 'Loop-breaker trips', value: selected.metrics.retry_count },
                        { key: 'user_comments_received', label: 'User comments', value: selected.metrics.user_comments_received },
                      ].map(m => (
                        <Metric
                          key={m.key}
                          label={m.label}
                          value={m.value}
                          drillable
                          active={drilledMetric === m.key}
                          onClick={() => setDrilledMetric(prev => prev === m.key ? null : m.key)}
                        />
                      ))}
                      <Metric label="Suggestion acceptance" value={`${Math.round(selected.metrics.suggestion_acceptance_rate * 100)}%`} />
                    </div>
                    {drilledMetric && (
                      <div className="rounded-lg border border-gray-800 bg-gray-950/30 p-3">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-medium text-gray-400">
                            Evidence: {drilledMetric.replace(/_/g, ' ')}
                            <span className="text-gray-600 ml-2">{selected.metric_details?.[drilledMetric]?.length || 0} record{(selected.metric_details?.[drilledMetric]?.length || 0) === 1 ? '' : 's'}</span>
                          </p>
                          <button onClick={() => setDrilledMetric(null)} className="text-gray-600 hover:text-gray-300 transition-colors"><X size={12} /></button>
                        </div>
                        <div className="max-h-80 overflow-y-auto pr-1">
                          <MetricDetailList metricKey={drilledMetric} items={selected.metric_details?.[drilledMetric]} />
                        </div>
                      </div>
                    )}
                    <RunScorecard rows={selected.run_scorecard} />
                  </div>
  );
}

// Per-run outcomes table — the "is this staff member improving?" view.
const SCORECARD_STATUS_DOT = { done: 'bg-green-500', stopped: 'bg-yellow-500', error: 'bg-red-500', running: 'bg-blue-500' };

function RunScorecard({ rows }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/30 p-3">
      <p className="text-xs font-medium text-gray-400 mb-2">
        Run scorecard <span className="text-gray-600">— per-run outcomes, most recent first</span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-600 border-b border-gray-800">
              <th className="text-left font-medium py-1.5 pr-3">Run</th>
              <th className="text-left font-medium py-1.5 pr-3">Steps</th>
              <th className="text-left font-medium py-1.5 pr-3" title="Accepted / rejected handoffs by this role">Handoffs</th>
              <th className="text-right font-medium py-1.5 pr-3" title="Tool calls this role made">Calls</th>
              <th className="text-right font-medium py-1.5 pr-3" title="Files written / shell commands — real-work signals">Files·Shell</th>
              <th className="text-right font-medium py-1.5 pr-3" title="Failed tool results">Errors</th>
              <th className="text-right font-medium py-1.5 pr-3" title="Duplicate/identical-result/halt guard trips">Breakers</th>
              <th className="text-right font-medium py-1.5" title="Turns ending with no output / halted / max rounds">Silent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.run_id} className="border-b border-gray-800/50 last:border-0 text-gray-300">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${SCORECARD_STATUS_DOT[r.run_status] || 'bg-gray-600'}`} title={r.run_status} />
                  <Link
                    to={r.team_id ? `/colony/${r.team_id}/run/${r.run_id}` : '/colony'}
                    className="text-blue-400 hover:text-blue-300 font-mono"
                    title={`${r.run_status} · ${new Date(r.created_at * 1000).toLocaleString()}`}
                  >
                    {r.run_id.slice(0, 8)}
                  </Link>
                  <span className="text-gray-600 ml-1.5">{new Date(r.created_at * 1000).toLocaleDateString()}</span>
                </td>
                <td className="py-1.5 pr-3">
                  {r.steps_assigned === 0 ? <span className="text-gray-600">—</span> : (
                    <span title={`${r.steps_done} done / ${r.steps_blocked} blocked / ${r.steps_assigned} assigned`}>
                      <span className={r.steps_done === r.steps_assigned ? 'text-green-400' : ''}>{r.steps_done}</span>
                      <span className="text-gray-600">/{r.steps_assigned}</span>
                      {r.steps_blocked > 0 && <span className="text-red-400 ml-1">({r.steps_blocked} blocked)</span>}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  <span className="text-green-400">{r.handoffs_accepted}</span>
                  {r.handoffs_rejected > 0 && <span className="text-red-400"> / {r.handoffs_rejected} rej</span>}
                </td>
                <td className="py-1.5 pr-3 text-right">{r.tool_calls}</td>
                <td className="py-1.5 pr-3 text-right text-gray-400">{r.files_written}·{r.shell_commands}</td>
                <td className={`py-1.5 pr-3 text-right ${r.tool_errors > 0 ? 'text-amber-400' : 'text-gray-600'}`}>{r.tool_errors}</td>
                <td className={`py-1.5 pr-3 text-right ${r.breaker_trips > 0 ? 'text-red-400' : 'text-gray-600'}`}>{r.breaker_trips}</td>
                <td className={`py-1.5 text-right ${r.silent_turns > 0 ? 'text-red-400' : 'text-gray-600'}`}>{r.silent_turns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function StaffHistoryTab({ selected }) {
  return (
                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
                    <div className="xl:col-span-3">
                      <h3 className="text-sm font-semibold text-gray-200 mb-2">Recent Runs</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {(selected.runs || []).length === 0 && <p className="text-xs text-gray-600">No colony runs linked to this staff member yet.</p>}
                        {(selected.runs || []).map(run => (
                          <Link
                            key={run.id}
                            to={run.team_id ? `/colony/${run.team_id}/run/${run.id}` : '/colony'}
                            className="rounded border border-gray-800 bg-gray-950/40 px-3 py-2 text-xs hover:border-gray-700 transition-colors"
                          >
                            <p className="text-gray-300 truncate">{run.goal}</p>
                            <p className="text-gray-600 mt-0.5">
                              {run.team_name || 'Colony'} · {run.status} · {formatDate(run.created_at * 1000)}
                            </p>
                          </Link>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-200 mb-2">Handoffs</h3>
                      <div className="flex flex-col gap-2">
                        {selected.interactions.handoffs.length === 0 && <p className="text-xs text-gray-600">No handoffs yet.</p>}
                        {selected.interactions.handoffs.map(h => (
                          <div key={h.id} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1.5 text-xs">
                            <p className="text-gray-300">{h.from_agent} → {h.to_agent}</p>
                            <p className="text-gray-600">{h.status} · {h.protocol_status}</p>
                            {h.colony_id && (
                              <Link to={h.team_id ? `/colony/${h.team_id}/run/${h.colony_id}` : '/colony'} className="text-blue-300 hover:underline">
                                Open Colony Run
                              </Link>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-200 mb-2">Blackboard</h3>
                      <div className="flex flex-col gap-2">
                        {selected.interactions.blackboard.length === 0 && <p className="text-xs text-gray-600">No blackboard notes yet.</p>}
                        {selected.interactions.blackboard.map(entry => (
                          <div key={entry.id} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1.5 text-xs">
                            <p className="text-gray-500">{entry.entry_type} · {entry.agent}</p>
                            <div className="text-gray-300"><StaffMarkdown>{entry.content}</StaffMarkdown></div>
                            {entry.colony_id && (
                              <Link to={entry.team_id ? `/colony/${entry.team_id}/run/${entry.colony_id}` : '/colony'} className="text-blue-300 hover:underline">
                                Open Colony Run
                              </Link>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-200 mb-2">Conversation History</h3>
                      <p className="text-xs text-gray-600 mb-2">"Operator" messages are the colony operator delegating work to this staff member during a run.</p>
                      <div className="flex flex-col gap-2">
                        {selected.interactions.histories.length === 0 && <p className="text-xs text-gray-600">No persisted worker history yet.</p>}
                        {selected.interactions.histories.map(history => (
                          <div key={`${history.colony_id}-${history.agent_id}`} className="rounded border border-gray-800 bg-gray-950/40 px-2 py-1.5 text-xs">
                            <p className="text-gray-500 flex items-center gap-1">
                              <Clock size={10} /> {formatDate(history.updated_at * 1000)}
                              {history.colony_id && <code className="bg-gray-900 px-1 rounded text-gray-600">run {history.colony_id}</code>}
                              {history.colony_id && (
                                <Link to={history.team_id ? `/colony/${history.team_id}/run/${history.colony_id}` : '/colony'} className="text-blue-300 hover:underline ml-auto">
                                  Open
                                </Link>
                              )}
                            </p>
                            {/* Full transcript, scrollable — no truncation. The worker's
                                "user" turns are the operator's delegation messages. */}
                            <div className="mt-1 flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-1">
                              {history.history.map((m, i) => {
                                const who = m.role === 'user' ? 'Operator' : m.role === 'assistant' ? (selected.display_name || 'Staff') : m.role;
                                return (
                                  <p key={i} className="text-gray-400 whitespace-pre-wrap break-words">
                                    <span className={m.role === 'user' ? 'text-amber-500/80' : 'text-blue-400/80'}>{who}:</span> {m.content}
                                  </p>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
  );
}

// Create a custom staff profile. Custom staff become candidates when the
// operator staffs preset roles (matched by role title), and can be @mentioned
// in Staff Chat like anyone else.
export function NewStaffModal({ onClose, onCreated }) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [personality, setPersonality] = useState('');
  const [avatarColor, setAvatarColor] = useState('#3b82f6');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setSaving(true);
    setError('');
    try {
      const profile = await api.createStaffProfile({
        display_name: displayName,
        role,
        personality,
        avatar_color: avatarColor,
      });
      onCreated(profile);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-950 p-5 flex flex-col gap-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-100">New staff member</p>
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300"><X size={15} /></button>
        </div>
        <Input label="Name" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Riley Kim" autoFocus />
        <Input label="Role / specialty" value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Security Engineer" />
        <Textarea label="Personality (optional)" value={personality} onChange={e => setPersonality(e.target.value)} rows={3} placeholder="Voice and working style…" />
        <Input label="Avatar color" value={avatarColor} onChange={e => setAvatarColor(e.target.value)} />
        <p className="text-xs text-gray-600">System prompt, skills, tools, models, and memory are edited on the profile after creation. The operator can pick custom staff for matching preset roles when staffing a run.</p>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={create} disabled={!displayName.trim() || !role.trim() || saving} className="flex-1">
            {saving ? 'Creating…' : 'Create staff member'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
