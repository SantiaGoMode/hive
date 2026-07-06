import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, ExternalLink, Plus, Save, Search, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input, Textarea } from '../components/ui/Input';
import { ModelSelect } from '../components/ui/ModelSelect';
import { toast } from '../stores/toastStore';
import {
  MultiPicker, NewStaffModal, ProfileCard, StaffChat, StaffHistoryTab, StaffPerformanceTab, Suggestion,
} from './staff/components';
import { initials } from './staff/utils';

const TABS = ['Prompt & Personality', 'Skills & Tools', 'Memory', 'Suggestions', 'Performance', 'History'];

export default function StaffPage() {
  const [profiles, setProfiles] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState('Prompt & Personality');
  const [saving, setSaving] = useState(false);
  const [syncingAgent, setSyncingAgent] = useState(false);
  const [search, setSearch] = useState('');
  const [models, setModels] = useState({});
  const [form, setForm] = useState(null);
  const [skillOptions, setSkillOptions] = useState([]);
  const [toolOptions, setToolOptions] = useState([]);
  const [drilledMetric, setDrilledMetric] = useState(null);
  const [showNewStaff, setShowNewStaff] = useState(false);
  const [effective, setEffective] = useState(null);

  const loadProfiles = useCallback(async () => {
    const data = await api.getStaffProfiles();
    setProfiles(data.profiles || []);
    setSelectedId(prev => prev || data.profiles?.[0]?.id || null);
  }, []);

  const loadSelected = useCallback(async (id) => {
    if (!id) return;
    const data = await api.getStaffProfile(id);
    setSelected(data);
    api.getStaffEffectiveConfig(id).then(setEffective).catch(() => setEffective(null));
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

  const createOrSyncAgent = async () => {
    if (!selected || !form) return;
    setSyncingAgent(true);
    try {
      await api.updateStaffProfile(selected.id, {
        ...form,
        chat_interval_minutes: Number(form.chat_interval_minutes) || 10,
      });
      const result = await api.createAgentFromStaffProfile(selected.id);
      toast.success(result.created ? 'Agent created from staff profile' : 'Assigned agent synced from staff profile');
      await loadProfiles();
      await loadSelected(selected.id);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSyncingAgent(false);
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
                  <Button
                    variant="secondary"
                    onClick={createOrSyncAgent}
                    disabled={syncingAgent || saving}
                    title="Create or update a durable agent from this staff profile"
                  >
                    <Bot size={14} /> {syncingAgent ? 'Syncing…' : selected.assigned_agent_id ? 'Sync agent' : 'Create agent'}
                  </Button>
                  <Button onClick={save} disabled={saving || syncingAgent}>
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
                    <ModelSelect
                      label="Model preference"
                      value={form.model_preference}
                      onChange={v => set('model_preference', v)}
                      groupedModels={models}
                      placeholder="Use launch model plan"
                    />
                    <div className="md:col-span-2 flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-400">Core system prompt</span>
                        <div className="flex items-center gap-2">
                          {selected.prompt_customized ? (
                            <>
                              <span className="text-xs rounded border border-amber-700/50 bg-amber-950/30 px-1.5 py-0.5 text-amber-300" title="This prompt was edited and no longer auto-updates when the recipe role's prompt improves.">
                                Customized — frozen from recipe updates
                              </span>
                              <button
                                type="button"
                                className="text-xs text-blue-400 hover:text-blue-300"
                                onClick={async () => {
                                  if (!window.confirm('Replace this custom prompt with the current recipe default? It will then auto-follow future recipe improvements.')) return;
                                  try {
                                    await api.resetStaffProfile(selected.id, ['system_prompt']);
                                    await loadSelected(selected.id);
                                    toast.success('Prompt reset to recipe default');
                                  } catch (e) { toast.error(e.message); }
                                }}
                              >
                                Reset to recipe default
                              </button>
                            </>
                          ) : (
                            <span className="text-xs rounded border border-emerald-800/50 bg-emerald-950/30 px-1.5 py-0.5 text-emerald-300" title="Matches the recipe seed — automatically follows recipe prompt improvements.">
                              Recipe default — auto-updates
                            </span>
                          )}
                        </div>
                      </div>
                      <Textarea
                        value={form.system_prompt}
                        onChange={e => set('system_prompt', e.target.value)}
                        rows={12}
                        placeholder="Role instructions, responsibilities, and process. When set, this replaces the recipe role's base prompt."
                      />
                      <p className="text-xs text-gray-600">Defines what this staff member does. Editing freezes it from recipe updates — use Reset to re-sync.</p>
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
                    {effective && effective.recipe_role_exists && (
                      <div className="md:col-span-2 rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-2">
                        <p className="text-sm font-medium text-gray-200">Effective tools in colony runs</p>
                        <p className="text-xs text-gray-600 mt-0.5 mb-2">
                          Recipe capability tools are always included — profile tools ADD to them, never replace them.
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {effective.effective_tools.map(({ tool, source }) => (
                            <span
                              key={tool}
                              className={`text-xs px-1.5 py-0.5 rounded border ${source === 'recipe' ? 'bg-gray-800/70 border-gray-700 text-gray-300' : 'bg-purple-500/10 border-purple-500/30 text-purple-300'}`}
                              title={source === 'recipe' ? 'From the recipe role (capability architecture)' : 'Added by this profile'}
                            >
                              {tool}{source === 'profile' ? ' +' : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
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
                          <ModelSelect
                            label="Chat model"
                            value={form.chat_model}
                            onChange={v => set('chat_model', v)}
                            groupedModels={models}
                            placeholder={`Same as work model${form.model_preference ? '' : ' (launch plan)'}`}
                          />
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
                  <StaffPerformanceTab
                    selected={selected}
                    drilledMetric={drilledMetric}
                    setDrilledMetric={setDrilledMetric}
                  />
                )}

                {tab === 'History' && <StaffHistoryTab selected={selected} />}
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
