import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronDown, Clock, ExternalLink, MessageSquare,
  Plus, RefreshCw, Save, Search, SlidersHorizontal, Sparkles, Trash2, UserRound, X, XCircle,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input, Textarea, Select } from '../components/ui/Input';
import { formatDate } from '../lib/utils';
import { modelBadge } from '../lib/modelLabels';
import { toast } from '../stores/toastStore';

const TABS = ['Prompt & Personality', 'Skills & Tools', 'Memory', 'Suggestions', 'Performance', 'History'];

// Multi-select picker: toggleable option chips from a catalog, plus legacy
// values not in the catalog rendered as removable "custom" chips.
function MultiPicker({ label, options, selected, onChange, emptyHint }) {
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

function StaffMarkdown({ children }) {
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

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';
}

function Metric({ label, value, active, drillable, onClick }) {
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
function MetricDetailList({ metricKey, items }) {
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

function ProfileCard({ profile, active, onClick }) {
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

function Suggestion({ suggestion, onApply, onDismiss }) {
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

function StaffChat({ profilesById }) {
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

// Create a custom staff profile. Custom staff become candidates when the
// operator staffs preset roles (matched by role title), and can be @mentioned
// in Staff Chat like anyone else.
function NewStaffModal({ onClose, onCreated }) {
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

export default function StaffPage() {
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('Prompt & Personality');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState({});
  const [form, setForm] = useState(null);
  const [skillOptions, setSkillOptions] = useState([]);
  const [toolOptions, setToolOptions] = useState([]);
  const [drilledMetric, setDrilledMetric] = useState(null);
  const [showNewStaff, setShowNewStaff] = useState(false);

  const loadProfiles = useCallback(async () => {
    const data = await api.getStaffProfiles();
    setProfiles(data.profiles || []);
    setSelectedId(prev => prev || data.profiles?.[0]?.id || null);
  }, []);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    const data = await api.getStaffProfile(id);
    setSelected(data);
    setForm({
      display_name: data.display_name,
      role: data.role,
      personality: data.personality || '',
      system_prompt: data.system_prompt || '',
      skills: Array.isArray(data.skills) ? data.skills : [],
      tools: Array.isArray(data.tools) ? data.tools : [],
      model_preference: data.model_preference || '',
      chat_model: data.chat_model || '',
      memory: data.memory || '',
      avatar_color: data.avatar_color,
      chat_enabled: data.chat_enabled,
      chat_interval_minutes: data.chat_interval_minutes || 10,
    });
  }, []);

  useEffect(() => {
    loadProfiles().catch(e => toast.error(e.message));
    api.getAllModels().then(setModels).catch(() => setModels({}));
    api.getSkills()
      .then(data => setSkillOptions((data.skills || []).map(s => ({ value: s.name, label: s.name, description: s.description }))))
      .catch(() => setSkillOptions([]));
    api.getToolOptions()
      .then(data => setToolOptions(data.tools || []))
      .catch(() => setToolOptions([]));
  }, [loadProfiles]);

  useEffect(() => {
    loadSelected(selectedId).catch(e => toast.error(e.message));
  }, [selectedId, loadSelected]);

  const flatModels = useMemo(() => {
    const out = [];
    for (const [provider, list] of Object.entries(models || {})) {
      for (const m of Array.isArray(list) ? list : []) out.push({ ...m, provider: m.provider || provider });
    }
    return out;
  }, [models]);

  const profilesById = useMemo(() => Object.fromEntries(profiles.map(p => [p.id, p])), [profiles]);
  const filtered = profiles.filter(profile => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return `${profile.display_name} ${profile.role} ${profile.recipe_id} ${profile.role_key}`.toLowerCase().includes(q);
  });

  const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!selected || !form) return;
    setSaving(true);
    try {
      await api.updateStaffProfile(selected.id, {
        ...form,
        chat_interval_minutes: Number(form.chat_interval_minutes) || 10,
      });
      toast.success('Staff profile saved');
      await loadProfiles();
      await loadSelected(selected.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const syncSuggestions = async () => {
    try {
      await api.syncStaffSuggestions();
      if (selectedId) await loadSelected(selectedId);
      await loadProfiles();
      toast.success('Suggestions refreshed');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const applySuggestion = async (id, value) => {
    try {
      await api.applyStaffSuggestion(id, value);
      await loadSelected(selectedId);
      await loadProfiles();
      toast.success('Suggestion applied');
    } catch (e) {
      toast.error(e.message);
    }
  };

  const dismissSuggestion = async (id) => {
    try {
      await api.dismissStaffSuggestion(id);
      await loadSelected(selectedId);
      await loadProfiles();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 gap-4">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-100 flex items-center gap-2">
            <UserRound size={22} className="text-gray-400" /> Staff
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Durable colony employee profiles, evidence-backed suggestions, and staff chat</p>
        </div>
        <Button className="ml-auto" variant="secondary" onClick={syncSuggestions}>
          <Sparkles size={14} /> Refresh suggestions
        </Button>
        <Button onClick={() => setShowNewStaff(true)}>
          <Plus size={14} /> New staff
        </Button>
      </div>

      <div className="grid grid-cols-12 gap-4 min-h-0 flex-1">
        <aside className="col-span-12 lg:col-span-4 xl:col-span-3 min-h-0 flex flex-col gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-gray-600" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search staff"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
            />
          </div>
          <div className="overflow-y-auto min-h-0 flex flex-col gap-2 pr-1">
            {filtered.map(profile => (
              <ProfileCard
                key={profile.id}
                profile={profile}
                active={profile.id === selectedId}
                onClick={() => { setSelectedId(profile.id); setTab('Prompt & Personality'); setDrilledMetric(null); }}
              />
            ))}
          </div>
        </aside>

        <section className="col-span-12 lg:col-span-8 xl:col-span-9 min-h-0 flex flex-col gap-3">
          {!selected || !form ? (
            <div className="flex items-center justify-center h-64 text-gray-600">Loading staff profile…</div>
          ) : (
            <>
              <div className="rounded-lg border border-gray-800 bg-gray-900/50 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="w-12 h-12 rounded-lg flex items-center justify-center text-sm font-semibold text-white" style={{ background: form.avatar_color }}>
                    {initials(form.display_name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-semibold text-gray-100">{form.display_name}</h2>
                      <span className="text-xs rounded border border-gray-800 px-1.5 py-0.5 text-gray-500">{selected.recipe_id}</span>
                      <span className="text-xs rounded border border-gray-800 px-1.5 py-0.5 text-gray-500">{selected.role_key}</span>
                      {selected.assigned_agent_id ? (
                        <Link
                          to={`/chat/${selected.assigned_agent_id}`}
                          title={`Assigned agent: ${selected.assigned_agent_id}`}
                          className="text-xs rounded border border-blue-900/60 bg-blue-950/30 px-1.5 py-0.5 text-blue-300 hover:border-blue-700 transition-colors flex items-center gap-1"
                        >
                          <Bot size={10} /> agent {selected.assigned_agent_id.slice(0, 8)}…
                        </Link>
                      ) : (
                        <span className="text-xs rounded border border-gray-800 px-1.5 py-0.5 text-gray-600 flex items-center gap-1" title="Set when a colony run seeds a worker from this profile">
                          <Bot size={10} /> no agent yet
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-500">{form.role}</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="text-gray-600 hover:text-red-400"
                    title="Delete this staff member (team-preset roles cannot be deleted)"
                    onClick={async () => {
                      if (!window.confirm(`Delete ${selected.display_name}?`)) return;
                      try {
                        await api.deleteStaffProfile(selected.id);
                        toast.success('Staff member deleted');
                        setSelectedId(null);
                        setSelected(null);
                        await loadProfiles();
                      } catch (e) {
                        toast.error(e.message);
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    <Save size={14} /> {saving ? 'Saving…' : 'Save'}
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {TABS.map(t => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/40 p-4">
                {tab === 'Prompt & Personality' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Input label="Display name" value={form.display_name} onChange={e => set('display_name', e.target.value)} />
                    <Input label="Role" value={form.role} onChange={e => set('role', e.target.value)} />
                    <Input label="Avatar color" value={form.avatar_color} onChange={e => set('avatar_color', e.target.value)} />
                    <Select label="Model preference" value={form.model_preference} onChange={e => set('model_preference', e.target.value)}>
                      <option value="">Use launch model plan</option>
                      {Object.entries(models || {}).map(([provider, list]) => (
                        <optgroup key={provider} label={provider}>
                          {(list || []).map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                    <div className="md:col-span-2 flex flex-col gap-1">
                      <Textarea
                        label="Core system prompt"
                        value={form.system_prompt}
                        onChange={e => set('system_prompt', e.target.value)}
                        rows={12}
                        placeholder="Role instructions, responsibilities, and process. When set, this replaces the recipe role's base prompt."
                      />
                      <p className="text-xs text-gray-600">Defines what this staff member does. Leave empty to use the recipe role's built-in prompt.</p>
                    </div>
                    <div className="md:col-span-2 flex flex-col gap-1">
                      <Textarea
                        label="Personality"
                        value={form.personality}
                        onChange={e => set('personality', e.target.value)}
                        rows={6}
                        placeholder="Voice, tone, and working style — e.g. direct and pragmatic, asks clarifying questions, prefers concise updates."
                      />
                      <p className="text-xs text-gray-600">Appended to the system prompt as its own section — shapes how they communicate, not what they do.</p>
                    </div>
                  </div>
                )}

                {tab === 'Skills & Tools' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <MultiPicker
                      label="Skills"
                      options={skillOptions}
                      selected={form.skills}
                      onChange={value => set('skills', value)}
                      emptyHint="No skills in the catalog yet — add some on the Skills & Tools page."
                    />
                    <MultiPicker
                      label="Tools"
                      options={toolOptions}
                      selected={form.tools}
                      onChange={value => set('tools', value)}
                      emptyHint="No tools available."
                    />
                    <p className="md:col-span-2 text-xs text-gray-600 flex items-center gap-1">
                      Manage the skills catalog and MCP servers on the
                      <Link to="/skills" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-0.5">Skills &amp; Tools page <ExternalLink size={10} /></Link>
                    </p>
                    <div className="md:col-span-2 rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-gray-200">Autonomous staff chat</p>
                          <p className="text-xs text-gray-600 mt-0.5">Off by default. Profiles with no model preference cannot generate scheduled messages.</p>
                        </div>
                        <button type="button" role="switch" aria-checked={form.chat_enabled} onClick={() => set('chat_enabled', !form.chat_enabled)} className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${form.chat_enabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
                          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${form.chat_enabled ? 'right-0.5' : 'left-0.5'}`} />
                        </button>
                      </div>
                      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input
                          label="Chat interval minutes"
                          type="number"
                          min="1"
                          max="1440"
                          value={form.chat_interval_minutes}
                          onChange={e => set('chat_interval_minutes', e.target.value)}
                          className="w-40"
                        />
                        <div className="flex flex-col gap-1">
                          <Select label="Chat model" value={form.chat_model} onChange={e => set('chat_model', e.target.value)}>
                            <option value="">Same as work model{form.model_preference ? '' : ' (launch plan)'}</option>
                            {Object.entries(models || {}).map(([provider, list]) => (
                              <optgroup key={provider} label={provider}>
                                {(list || []).map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                              </optgroup>
                            ))}
                          </Select>
                          <p className="text-xs text-gray-600">Used only for autonomous staff chat — pick a smaller, cheaper model than the colony work model.</p>
                        </div>
                      </div>
                      {flatModels.length === 0 && <p className="mt-2 text-xs text-gray-600">No models loaded from providers yet.</p>}
                    </div>
                  </div>
                )}

                {tab === 'Memory' && (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      label="Durable staff memory"
                      value={form.memory}
                      onChange={e => set('memory', e.target.value)}
                      rows={18}
                      placeholder="Nothing here yet. Run notes are appended automatically after each colony run; applying Suggestions also writes here. You can add or edit anything — it's injected into this staff member's prompt on every run."
                    />
                    <p className="text-xs text-gray-600">Auto-populated with a dated note after every colony run this role crews, plus anything you Apply from the Suggestions tab. Fully editable — Save to persist.</p>
                  </div>
                )}

                {tab === 'Suggestions' && (
                  <div className="flex flex-col gap-3">
                    {selected.suggestions?.length === 0 && <p className="text-sm text-gray-600 text-center py-8">No evidence-backed suggestions yet.</p>}
                    {selected.suggestions?.map(suggestion => (
                      <Suggestion key={suggestion.id} suggestion={suggestion} onApply={applySuggestion} onDismiss={dismissSuggestion} />
                    ))}
                  </div>
                )}

                {tab === 'Performance' && (
                  <div className="flex flex-col gap-4">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { key: 'successful_handoffs', label: 'Successful handoffs', value: selected.metrics.successful_handoffs },
                        { key: 'rejected_handoffs', label: 'Rejected handoffs', value: selected.metrics.rejected_handoffs },
                        { key: 'auto_recorded_handoffs', label: 'Auto-recorded', value: selected.metrics.auto_recorded_handoffs },
                        { key: 'blocker_count', label: 'Blockers', value: selected.metrics.blocker_count },
                        { key: 'tool_error_count', label: 'Tool errors', value: selected.metrics.tool_error_count },
                        { key: 'retry_count', label: 'Retries', value: selected.metrics.retry_count },
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
                  </div>
                )}

                {tab === 'History' && (
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
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <StaffChat profilesById={profilesById} />

      {showNewStaff && (
        <NewStaffModal
          onClose={() => setShowNewStaff(false)}
          onCreated={async (profile) => {
            setShowNewStaff(false);
            await loadProfiles();
            setSelectedId(profile.id);
            toast.success(`${profile.display_name} added to staff`);
          }}
        />
      )}
    </div>
  );
}
