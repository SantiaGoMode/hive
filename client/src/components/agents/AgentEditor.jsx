import { useState, useEffect, useCallback } from 'react';
import { Wand2, Trash2, Save, RefreshCw, Plug, Terminal, RotateCcw, FolderOpen, FileText, ChevronRight, ExternalLink, UserRound } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Select, Textarea } from '../ui/Input';
import { ModelSelect } from '../ui/ModelSelect';
import { toast } from '../../stores/toastStore';
import { useAgentStore } from '../../stores/agentStore';
import { api } from '../../lib/api';

const AVATAR_COLORS = [
  '#d97706', '#f59e0b', '#0f766e', '#10b981', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#ef4444', '#64748b',
];

const TEMPLATES = [
  {
    name: 'Researcher',
    description: 'Search the web and synthesize findings on any topic',
    avatar_color: '#d97706',
    tools: ['web_search', 'memory'],
    temperature: 0.6,
    max_tokens: 4096,
    context_length: 16384,
    system_prompt: 'You are a thorough research assistant. When asked about any topic, search the web for current and accurate information. Always cite your sources. Summarize findings clearly and concisely, and highlight any conflicting information you find.',
  },
  {
    name: 'Coder',
    description: 'Write clean, efficient code in any language',
    avatar_color: '#10b981',
    tools: ['memory'],
    temperature: 0.3,
    max_tokens: 8192,
    context_length: 16384,
    system_prompt: 'You are an expert coding assistant. Write clean, efficient, well-documented code. Explain your implementation decisions briefly. Prefer simple solutions over complex ones. Ask for clarification when requirements are ambiguous.',
  },
  {
    name: 'Writer',
    description: 'Creative writing, editing, and style matching',
    avatar_color: '#ec4899',
    tools: ['memory'],
    temperature: 0.9,
    max_tokens: 4096,
    context_length: 8192,
    system_prompt: "You are a creative writing assistant. Match the user's tone and style. Help with drafts, edits, brainstorming, and feedback. Be encouraging but honest. Save the user's writing preferences and style to memory.",
  },
  {
    name: 'Analyst',
    description: 'Gather data, delegate research, synthesize insights',
    avatar_color: '#f59e0b',
    tools: ['web_search', 'agent_tools', 'memory'],
    temperature: 0.5,
    max_tokens: 4096,
    context_length: 16384,
    system_prompt: 'You are a data analyst. Gather information from the web and other agents to answer complex questions. Break problems into sub-tasks, delegate when useful, and synthesize findings into clear, actionable insights.',
  },
  {
    name: 'Secretary',
    description: 'Task tracking, notes, and remembering preferences',
    avatar_color: '#8b5cf6',
    tools: ['memory'],
    temperature: 0.5,
    max_tokens: 2048,
    context_length: 8192,
    system_prompt: "You are a personal assistant. Track tasks, take notes, and remember the user's preferences, goals, and important details. Proactively save information to memory whenever the user mentions something worth remembering. Keep responses concise and organized.",
  },
];

const TOOLS = [
  {
    id: 'agent_tools',
    label: 'Agent Management & Collaboration',
    desc: 'Create, edit, and delegate to agents. Manage pipelines and schedules, read the shared blackboard, and fetch full raw webhook events with get_webhook_event.',
    builtin: true,
  },
  { id: 'memory', label: 'Persistent Memory', desc: 'Remember things across conversations. The agent can save notes, user preferences, and context to a MEMORY.md file in its workspace.' },
  { id: 'web_search', label: 'Web Search', desc: 'Built-in Ollama web_search/web_fetch. Requires Ollama web access via ollama signin.' },
  { id: 'sandbox', label: 'Sandbox', desc: 'Isolated Docker container for safe code execution. Gives the agent shell access, Python (run_python), and file read/write — all contained away from your system.' },
  { id: 'media', label: 'Media Generation', desc: 'Generate images (FLUX.2-klein) and speech (Orpheus) locally via Ollama. Results render inline in chat and download from the agent\'s artifacts.' },
  { id: 'skills', label: 'Skill Loader', desc: 'Browse the skill catalog and pull a skill\'s full instructions on demand mid-conversation (list_skills / load_skill).' },
];


const BASE_TABS = ['Identity', 'Model', 'System Prompt', 'Tools', 'Memory', 'Advanced'];
const ROUTINE_TOOLS = new Set(['agent_tools', 'memory', 'web_search']);

function AdvancedDisclosure({ id, title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/40 transition-colors"
      >
        <div>
          <p className="text-xs font-medium text-gray-300">{title}</p>
          {summary && <p className="text-xs text-gray-600 mt-0.5">{summary}</p>}
        </div>
        <ChevronRight size={14} className={`text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div id={id} className="border-t border-gray-800 px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

export function AgentEditor({ open, onClose, agent, initialValues }) {
  const { createAgent, updateAgent, fetchAgents } = useAgentStore();
  const [tab, setTab] = useState(0);
  const [models, setModels] = useState({});
  const [saving, setSaving] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [staffProfiles, setStaffProfiles] = useState([]);
  const [staffProfileId, setStaffProfileId] = useState('');
  const [staffCreating, setStaffCreating] = useState(false);
  const [createMode, setCreateMode] = useState('staff');
  const DEFAULTS = {
    name: '', persona_name: '', persona_role: '', description: '', avatar_color: '#d97706',
    model: '', temperature: 0.7, max_tokens: 4096, context_length: 8192,
    system_prompt: '', tools: [], skills: [], reasoning: false,
  };

  const [form, setForm] = useState(DEFAULTS);
  const [mcpServers, setMcpServers] = useState([]);
  const [skillOptions, setSkillOptions] = useState([]);
  const [memory, setMemory] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [sandboxStatus, setSandboxStatus] = useState(null);
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const [sandboxFiles, setSandboxFiles] = useState([]);
  const [sandboxSelectedFile, setSandboxSelectedFile] = useState(null);
  const [sandboxFileContent, setSandboxFileContent] = useState('');
  const [sandboxFileSaving, setSandboxFileSaving] = useState(false);

  const staffCreateMode = !agent && createMode === 'staff' && staffProfiles.length > 0;
  const hasSandbox = form.tools.includes('sandbox') && !!agent?.id;
  const TABS = hasSandbox ? [...BASE_TABS, 'Sandbox'] : BASE_TABS;
  const selectedStaffProfile = staffProfiles.find(profile => profile.id === staffProfileId) || null;

  useEffect(() => {
    if (agent) setForm({ ...DEFAULTS, ...agent });
    else setForm({ ...DEFAULTS, ...(initialValues || {}) });
    setCreateMode(agent ? 'manual' : 'staff');
    setTab(0);
    setShowTemplates(false);
    setMemory('');
  }, [agent, open]);

  const loadMemory = useCallback(async () => {
    if (!agent?.id) return;
    setMemoryLoading(true);
    try {
      const { content } = await api.getAgentMemory(agent.id);
      setMemory(content);
    } catch { setMemory(''); }
    finally { setMemoryLoading(false); }
  }, [agent?.id]);

  // Load memory when Memory tab is opened
  useEffect(() => {
    if (tab === 4 && agent?.id) loadMemory();
  }, [tab, agent?.id]);

  // Load sandbox status when Tools tab is opened
  useEffect(() => {
    if (tab === 3 && agent?.id) {
      api.getSandboxStatus(agent.id).then(setSandboxStatus).catch(() => setSandboxStatus(null));
    }
  }, [tab, agent?.id]);

  const sandboxTabIndex = TABS.indexOf('Sandbox');
  useEffect(() => {
    if (tab === sandboxTabIndex && hasSandbox) {
      api.getSandboxFiles(agent.id).then(d => setSandboxFiles(d.files || [])).catch(() => setSandboxFiles([]));
      api.getSandboxStatus(agent.id).then(setSandboxStatus).catch(() => {});
    }
  }, [tab, agent?.id, hasSandbox]);

  const loadSandboxFile = async (filePath) => {
    if (filePath.endsWith('/') || filePath === '.') return;
    setSandboxSelectedFile(filePath);
    try {
      const { content } = await api.getSandboxFile(agent.id, filePath);
      setSandboxFileContent(content);
    } catch { setSandboxFileContent('(binary or unreadable)'); }
  };

  const saveSandboxFile = async () => {
    if (!sandboxSelectedFile) return;
    setSandboxFileSaving(true);
    try {
      await api.saveSandboxFile(agent.id, sandboxSelectedFile, sandboxFileContent);
      toast.success('File saved');
    } catch (e) { toast.error(e.message); }
    finally { setSandboxFileSaving(false); }
  };

  const handleSandboxStart = async () => {
    if (!agent?.id) return;
    setSandboxBusy(true);
    try {
      const s = await api.startSandbox(agent.id);
      setSandboxStatus(s);
      toast.success('Sandbox started');
    } catch (e) { toast.error(e.message); }
    finally { setSandboxBusy(false); }
  };

  const handleSandboxReset = async () => {
    if (!agent?.id) return;
    if (!window.confirm('Reset sandbox? This will delete all files in the sandbox workspace.')) return;
    setSandboxBusy(true);
    try {
      await api.resetSandbox(agent.id);
      setSandboxStatus({ docker: true, status: 'missing' });
      toast.success('Sandbox reset');
    } catch (e) { toast.error(e.message); }
    finally { setSandboxBusy(false); }
  };

  const applyTemplate = (tpl) => {
    setForm(f => ({
      ...f,
      // Only set name if blank (don't overwrite a name the user already typed)
      name: f.name.trim() || tpl.name,
      description: tpl.description,
      avatar_color: tpl.avatar_color,
      tools: tpl.tools,
      temperature: tpl.temperature,
      max_tokens: tpl.max_tokens,
      context_length: tpl.context_length,
      system_prompt: tpl.system_prompt,
    }));
    setShowTemplates(false);
  };

  useEffect(() => {
    api.getAllModels().then(setModels).catch(() => setModels({}));
    api.getMcpServers().then(setMcpServers).catch(() => setMcpServers([]));
    api.getSkills().then(d => setSkillOptions(d.skills || [])).catch(() => setSkillOptions([]));
    if (!agent) {
      api.getStaffProfiles()
        .then(data => {
          const profiles = data.profiles || [];
          setStaffProfiles(profiles);
          setStaffProfileId(prev => prev || profiles[0]?.id || '');
        })
        .catch(() => {
          setStaffProfiles([]);
          setStaffProfileId('');
        });
    } else {
      setStaffProfiles([]);
      setStaffProfileId('');
    }
  }, [open, agent]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));
  const toggleTool = (id) => setForm(f => ({
    ...f,
    tools: f.tools.includes(id) ? f.tools.filter(t => t !== id) : [...f.tools, id],
  }));
  const toggleSkill = (name) => setForm(f => ({
    ...f,
    skills: (f.skills || []).includes(name) ? f.skills.filter(s => s !== name) : [...(f.skills || []), name],
  }));
  const routineTools = TOOLS.filter(tool => ROUTINE_TOOLS.has(tool.id));
  const advancedTools = TOOLS.filter(tool => !ROUTINE_TOOLS.has(tool.id));
  const selectedMcpCount = form.tools.filter(id => id.startsWith('mcp:')).length;

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Name is required');
    setSaving(true);
    try {
      if (agent) await updateAgent(agent.id, form);
      else await createAgent(form);
      toast.success(agent ? 'Agent updated' : 'Agent created');
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateFromStaffProfile = async () => {
    if (!staffProfileId) return toast.error('Choose a staff profile first');
    setStaffCreating(true);
    try {
      const body = {
        model: form.model || undefined,
        temperature: form.temperature,
        max_tokens: form.max_tokens,
        context_length: form.context_length,
        reasoning: !!form.reasoning,
        gateway_budget_usd: form.gateway_budget_usd ?? null,
      };
      const result = await api.createAgentFromStaffProfile(staffProfileId, body);
      await fetchAgents();
      toast.success(result.created ? 'Agent created from staff profile' : 'Assigned agent synced from staff profile');
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setStaffCreating(false);
    }
  };

  const handleMemorySave = async () => {
    if (!agent?.id) return;
    setMemorySaving(true);
    try {
      await api.updateAgentMemory(agent.id, memory);
      toast.success('Memory saved');
    } catch (e) { toast.error(e.message); }
    finally { setMemorySaving(false); }
  };

  const handleMemoryClear = async () => {
    if (!agent?.id) return;
    if (!window.confirm('Clear all memory for this agent? This cannot be undone.')) return;
    try {
      await api.clearAgentMemory(agent.id);
      setMemory('');
      toast.success('Memory cleared');
    } catch (e) { toast.error(e.message); }
  };

  const yamlPreview = JSON.stringify({ name: form.name, model: form.model, temperature: form.temperature, system_prompt: form.system_prompt, tools: form.tools }, null, 2);
  const staffDefaultModel = selectedStaffProfile?.model_preference || '';
  const modelPlaceholder = staffCreateMode && staffDefaultModel
    ? `Use staff default (${staffDefaultModel})`
    : '— Select a model —';
  const modelHint = staffCreateMode ? (
    <p className="text-xs text-gray-500 -mt-1">
      {staffDefaultModel
        ? 'Leave blank to use the staff profile default. Choose a model here only to override it for this agent.'
        : 'This staff profile has no model preference. Choose a model for the agent before chatting.'}
    </p>
  ) : (
    <p className="text-xs text-gray-500 -mt-1">
      Pick a configured provider model. Cloud models are prefixed
      (<code className="bg-gray-800 px-1 rounded">anthropic/…</code>, <code className="bg-gray-800 px-1 rounded">openai/…</code>, <code className="bg-gray-800 px-1 rounded">gemini/…</code>);
      Ollama models use the bare name.
    </p>
  );
  const modelRuntimeSettings = (
    <div className="flex flex-col gap-4">
      <ModelSelect
        value={form.model}
        onChange={v => set('model', v)}
        groupedModels={models}
        placeholder={modelPlaceholder}
        showBadge
        hint={modelHint}
      />
      <div>
        <label className="text-sm font-medium text-gray-300 block mb-1">Temperature: {form.temperature}</label>
        <input type="range" min="0" max="2" step="0.05" value={form.temperature}
          onChange={e => set('temperature', parseFloat(e.target.value))}
          className="w-full accent-blue-500" />
        <div className="flex justify-between text-xs text-gray-500 mt-1"><span>Precise</span><span>Creative</span></div>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-950/40 px-3 py-2">
        <div>
          <p className="text-sm font-medium text-gray-300">Show reasoning</p>
          <p className="text-xs text-gray-600 mt-0.5">Stream the model's thinking in chat. Only applies to models with the Reasoning capability (see Models page) — others ignore it.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!!form.reasoning}
          onClick={() => set('reasoning', !form.reasoning)}
          className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${form.reasoning ? 'bg-purple-600' : 'bg-gray-700'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${form.reasoning ? 'right-0.5' : 'left-0.5'}`} />
        </button>
      </div>
      <AdvancedDisclosure
        id="agent-model-advanced"
        title="Advanced model settings"
        summary={`Output ${form.max_tokens.toLocaleString()} tokens · context ${form.context_length.toLocaleString()}${form.gateway_budget_usd != null ? ` · budget $${form.gateway_budget_usd}` : ''}`}
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-sm font-medium text-gray-300 block mb-1">
              Max Tokens (num_predict): {form.max_tokens.toLocaleString()}
              <span className="text-gray-500 font-normal ml-2 text-xs">max output per response</span>
            </label>
            <input type="range" min="256" max="32768" step="256" value={form.max_tokens}
              onChange={e => set('max_tokens', parseInt(e.target.value))}
              className="w-full accent-blue-500" />
            <div className="flex justify-between text-xs text-gray-500 mt-1"><span>256</span><span>32k</span></div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-300 block mb-1">
              Context Window (num_ctx): {form.context_length.toLocaleString()}
              {form.context_length >= 65536 && <span className="text-blue-400 text-xs ml-2">64k+</span>}
              <span className="text-gray-500 font-normal ml-2 text-xs">conversation memory — auto-expanded if Max Tokens exceeds this</span>
            </label>
            <input type="range" min="2048" max="131072" step="2048" value={form.context_length}
              onChange={e => set('context_length', parseInt(e.target.value))}
              className="w-full accent-blue-500" />
            <div className="flex justify-between text-xs text-gray-500 mt-1"><span>2k</span><span>128k</span></div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-300 block mb-1">
              LLM Gateway budget (USD)
              <span className="text-gray-500 font-normal ml-2 text-xs">optional — caps this agent's spend via a dedicated gateway key</span>
            </label>
            <input
              type="number" min="0" step="0.5"
              value={form.gateway_budget_usd ?? ''}
              onChange={e => set('gateway_budget_usd', e.target.value === '' ? null : parseFloat(e.target.value))}
              placeholder="No limit"
              className="w-40 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
            />
            <p className="text-xs text-gray-600 mt-1">Requires the LLM gateway (Settings → Model Providers). When set, calls run on a per-agent key with this hard cap; changing it re-mints the key.</p>
          </div>
        </div>
      </AdvancedDisclosure>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={agent ? `Edit: ${agent.name}` : 'New Agent'} size="xl">
      {!agent && staffProfiles.length > 0 && (
        <div className="mb-4 inline-flex rounded-lg border border-gray-800 bg-gray-900/50 p-1">
          <button
            type="button"
            onClick={() => { setCreateMode('staff'); setTab(0); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${createMode === 'staff' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'}`}
          >
            Staff profile
          </button>
          <button
            type="button"
            onClick={() => { setCreateMode('manual'); setTab(0); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${createMode === 'manual' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100 hover:bg-gray-800'}`}
          >
            Manual
          </button>
        </div>
      )}
      {!staffCreateMode && (
        <div className="flex gap-1 mb-6 border-b border-gray-700 pb-0">
          {TABS.map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(i)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${tab === i ? 'text-blue-400 border-b-2 border-blue-400 -mb-px' : 'text-gray-400 hover:text-gray-200'}`}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-64">
        {staffCreateMode && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,320px)_1fr] gap-5">
            <div className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <UserRound size={16} className="text-blue-300" />
                  <p className="text-sm font-medium text-gray-200">Staff profile</p>
                </div>
                <p className="text-xs text-gray-600 mt-1">Identity, prompt, tools, skills, and memory are managed in Staff settings.</p>
              </div>
              <div>
                <Select
                  label="Profile"
                  value={staffProfileId}
                  onChange={e => setStaffProfileId(e.target.value)}
                >
                  <option value="">Select staff profile</option>
                  {staffProfiles.map(profile => (
                    <option key={profile.id} value={profile.id}>
                      {profile.display_name} — {profile.role}
                    </option>
                  ))}
                </Select>
              </div>

              {selectedStaffProfile && (
                <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
                  <div className="flex items-center gap-3">
                    <span
                      className="w-10 h-10 rounded-lg flex items-center justify-center text-xs font-semibold text-white flex-shrink-0"
                      style={{ background: selectedStaffProfile.avatar_color }}
                    >
                      {selectedStaffProfile.display_name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-200 truncate">{selectedStaffProfile.display_name}</p>
                      <p className="text-xs text-gray-500 truncate">{selectedStaffProfile.role}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 gap-2 text-xs">
                    <div>
                      <p className="text-gray-600">Profile key</p>
                      <p className="text-gray-300 font-mono truncate">{selectedStaffProfile.role_key}</p>
                    </div>
                    <div>
                      <p className="text-gray-600">Default model</p>
                      <p className="text-gray-300 truncate">{selectedStaffProfile.model_preference || 'No staff model preference'}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div className="mb-3">
                <p className="text-sm font-medium text-gray-200">Runtime model settings</p>
                <p className="text-xs text-gray-600 mt-0.5">Only these runtime settings are editable here.</p>
              </div>
              {modelRuntimeSettings}
            </div>
          </div>
        )}

        {!staffCreateMode && tab === 0 && (
          <div className="flex flex-col gap-4">
            {/* Template picker */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Start from scratch or use a template</span>
              <Button size="sm" variant="secondary" onClick={() => setShowTemplates(v => !v)}>
                <Wand2 size={12} /> {showTemplates ? 'Hide Templates' : 'Use Template'}
              </Button>
            </div>
            {showTemplates && (
              <div className="grid grid-cols-1 gap-2">
                {TEMPLATES.map(tpl => (
                  <button
                    key={tpl.name}
                    onClick={() => applyTemplate(tpl)}
                    className="flex items-center gap-3 p-3 rounded-lg border border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 text-left transition-colors"
                  >
                    <div className="w-8 h-8 rounded-lg flex-shrink-0 flex items-center justify-center text-sm font-bold text-white" style={{ background: tpl.avatar_color }}>
                      {tpl.name[0]}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-200">{tpl.name}</p>
                      <p className="text-xs text-gray-500">{tpl.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <Input label="Name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. researcher" />
            <Input label="Role" value={form.persona_role} onChange={e => set('persona_role', e.target.value)} placeholder="e.g. Research Analyst" />
            <div>
              <label className="text-sm font-medium text-gray-300 block mb-2">Avatar Color</label>
              <div className="flex gap-2 flex-wrap">
                {AVATAR_COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => set('avatar_color', c)}
                    className={`w-8 h-8 rounded-lg transition-transform ${form.avatar_color === c ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900 scale-110' : 'hover:scale-110'}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {!staffCreateMode && tab === 1 && modelRuntimeSettings}

        {tab === 2 && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-gray-300">System Prompt</label>
              <span className="text-xs text-gray-500">{form.system_prompt.length} chars · saved to SOUL.md</span>
            </div>
            <Textarea
              value={form.system_prompt}
              onChange={e => set('system_prompt', e.target.value)}
              placeholder="You are a helpful assistant..."
              className="h-64 font-mono text-sm"
            />
            <p className="text-xs text-gray-500">Injected at the start of every conversation as this agent's personality</p>
          </div>
        )}

        {tab === 3 && (
          <div className="flex flex-col gap-3">
            {routineTools.map(tool => (
              <div key={tool.id}
                className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${form.tools.includes(tool.id) ? 'border-blue-500/50 bg-blue-500/5' : 'border-gray-700 hover:border-gray-600'}`}
                onClick={() => toggleTool(tool.id)}
              >
                <div className="flex-1 min-w-0 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-200">{tool.label}</span>
                    {tool.builtin && (
                      <span className="text-xs bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded px-1.5 py-0.5">built-in</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{tool.desc}</div>
                </div>
                <div className={`w-10 h-5 rounded-full flex-shrink-0 transition-colors ${form.tools.includes(tool.id) ? 'bg-blue-600' : 'bg-gray-700'} relative`}>
                  <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.tools.includes(tool.id) ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </div>
              </div>
            ))}

            {form.tools.includes('agent_tools') && (
              <div className="p-3 rounded-lg border border-blue-500/20 bg-blue-500/5 text-xs text-blue-200/80">
                Webhook-triggered agents can use the projected input envelope's <code className="bg-blue-950/60 px-1 rounded">_event_id</code> with <code className="bg-blue-950/60 px-1 rounded">get_webhook_event</code> to fetch the full raw payload only when they need more fields.
              </div>
            )}

            <AdvancedDisclosure
              id="agent-skills"
              title="Skills"
              summary={`${(form.skills || []).length} skill${(form.skills || []).length === 1 ? '' : 's'} assigned`}
              defaultOpen={(form.skills || []).length > 0}
            >
              <p className="text-xs text-gray-500 mb-2">
                Assigned skills inject their instructions and templates into this agent's
                system prompt — in chat, pipelines, and schedules. Manage the catalog on
                the Skills &amp; Tools page.
              </p>
              {skillOptions.length === 0 && (
                <p className="text-xs text-gray-600">No skills in the catalog yet.</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {skillOptions.map(skill => {
                  const selected = (form.skills || []).includes(skill.name);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => toggleSkill(skill.name)}
                      title={skill.description || skill.name}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${selected ? 'bg-teal-600/20 border-teal-500/40 text-teal-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-600'}`}
                    >
                      {skill.name}
                    </button>
                  );
                })}
              </div>
            </AdvancedDisclosure>

            <AdvancedDisclosure
              id="agent-tools-advanced"
              title="Advanced tool access"
              summary={`${form.tools.includes('sandbox') ? 'Sandbox enabled · ' : ''}${selectedMcpCount} MCP server${selectedMcpCount === 1 ? '' : 's'} selected`}
              defaultOpen={form.tools.includes('sandbox') || selectedMcpCount > 0}
            >
              <div className="flex flex-col gap-3">
                {advancedTools.map(tool => (
                  <div key={tool.id}
                    className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${form.tools.includes(tool.id) ? 'border-blue-500/50 bg-blue-500/5' : 'border-gray-700 hover:border-gray-600'}`}
                    onClick={() => toggleTool(tool.id)}
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <span className="text-sm font-medium text-gray-200">{tool.label}</span>
                      <div className="text-xs text-gray-500 mt-0.5">{tool.desc}</div>
                    </div>
                    <div className={`w-10 h-5 rounded-full flex-shrink-0 transition-colors ${form.tools.includes(tool.id) ? 'bg-blue-600' : 'bg-gray-700'} relative`}>
                      <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.tools.includes(tool.id) ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                ))}

                {form.tools.includes('sandbox') && agent?.id && (
                  <div className="p-3 rounded-lg border border-gray-700/60 bg-gray-800/30 flex items-center gap-3">
                    <Terminal size={13} className="text-gray-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-300">Sandbox container</p>
                      {!sandboxStatus ? (
                        <p className="text-xs text-gray-600">Checking…</p>
                      ) : !sandboxStatus.docker ? (
                        <p className="text-xs text-yellow-500">Docker not available</p>
                      ) : (
                        <p className="text-xs">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${sandboxStatus.status === 'running' ? 'bg-green-400' : 'bg-gray-600'}`} />
                          <span className="text-gray-400">{sandboxStatus.status}</span>
                        </p>
                      )}
                    </div>
                    {sandboxStatus?.docker && (
                      <div className="flex gap-1.5 flex-shrink-0">
                        {sandboxStatus.status !== 'running' && (
                          <button
                            onClick={handleSandboxStart}
                            disabled={sandboxBusy}
                            className="px-2 py-1 text-xs bg-green-600/20 text-green-400 border border-green-600/30 rounded hover:bg-green-600/30 transition-colors disabled:opacity-50"
                          >
                            {sandboxBusy ? '…' : 'Start'}
                          </button>
                        )}
                        <button
                          onClick={handleSandboxReset}
                          disabled={sandboxBusy}
                          className="p-1 text-gray-600 hover:text-gray-400 rounded hover:bg-gray-700 transition-colors disabled:opacity-50"
                          title="Reset sandbox (deletes all files)"
                        >
                          <RotateCcw size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="pt-3 border-t border-gray-800">
                  <div className="flex items-center gap-2 mb-2">
                    <Plug size={12} className="text-gray-500" />
                    <span className="text-xs font-medium text-gray-400">MCP Servers</span>
                    {mcpServers.length === 0 && (
                      <span className="text-xs text-gray-600 ml-1">— add servers in Settings</span>
                    )}
                  </div>
                  {mcpServers.map(server => {
                    const mcpId = `mcp:${server.id}`;
                    const enabled = form.tools.includes(mcpId);
                    return (
                      <div key={server.id} className="mb-2">
                        <div
                          className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${enabled ? 'border-purple-500/50 bg-purple-500/5' : 'border-gray-700 hover:border-gray-600'}`}
                          onClick={() => toggleTool(mcpId)}
                        >
                          <div className="flex-1 min-w-0 pr-3">
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${server.connected ? 'bg-green-400' : 'bg-gray-600'}`} />
                              <span className="text-sm font-medium text-gray-200">{server.name}</span>
                              <span className="text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded px-1.5 py-0.5">MCP</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {server.connected
                                ? `${server.tool_count} tool${server.tool_count !== 1 ? 's' : ''} · ${server.transport === 'http' ? server.url : server.command}`
                                : <span className="text-yellow-600">Disconnected — reconnect in Settings</span>
                              }
                            </div>
                          </div>
                          <div className={`w-10 h-5 rounded-full flex-shrink-0 transition-colors ${enabled ? 'bg-purple-600' : 'bg-gray-700'} relative`}>
                            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                          </div>
                        </div>
                        {enabled && server.connected && server.tool_names?.length > 0 && (
                          <div className="mt-1 ml-3 flex flex-wrap gap-1">
                            {server.tool_names.map(t => (
                              <span key={t} className="text-xs bg-purple-900/30 text-purple-300 border border-purple-700/30 rounded px-1.5 py-0.5 font-mono">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </AdvancedDisclosure>
          </div>
        )}

        {tab === 4 && (
          <div className="flex flex-col gap-3">
            {!agent ? (
              <p className="text-sm text-gray-500 text-center py-8">Save the agent first to manage its memory.</p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-300">Agent Memory</p>
                    <p className="text-xs text-gray-500 mt-0.5">Stored in <code className="bg-gray-800 px-1 rounded">workspace/MEMORY.md</code> — injected into every conversation</p>
                  </div>
                  <button
                    onClick={loadMemory}
                    disabled={memoryLoading}
                    className="p-1.5 text-gray-500 hover:text-gray-300 rounded-lg hover:bg-gray-800 transition-colors"
                    title="Reload from disk"
                  >
                    <RefreshCw size={13} className={memoryLoading ? 'animate-spin' : ''} />
                  </button>
                </div>
                <textarea
                  value={memory}
                  onChange={e => setMemory(e.target.value)}
                  rows={10}
                  placeholder="No memory yet. The agent will write here as it saves information across conversations."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2 justify-between">
                  <button
                    onClick={handleMemoryClear}
                    disabled={!memory}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 size={12} /> Clear memory
                  </button>
                  <button
                    onClick={handleMemorySave}
                    disabled={memorySaving}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
                  >
                    <Save size={12} /> {memorySaving ? 'Saving…' : 'Save memory'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === 5 && (
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium text-gray-300">YAML Preview (read-only)</label>
            <pre className="bg-gray-800 rounded-lg p-4 text-xs text-gray-300 font-mono overflow-auto max-h-64">{yamlPreview}</pre>
          </div>
        )}

        {tab === sandboxTabIndex && hasSandbox && (
          <div className="flex flex-col gap-3">
            {/* Status bar */}
            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-gray-800/40 border border-gray-700/60">
              <Terminal size={13} className="text-gray-500 flex-shrink-0" />
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${sandboxStatus?.status === 'running' ? 'bg-green-400' : 'bg-gray-600'}`} />
                <span className="text-xs text-gray-400">{sandboxStatus?.status ?? 'unknown'}</span>
                {sandboxStatus?.ports && Object.entries(sandboxStatus.ports).map(([cp, hp]) => (
                  <a key={cp} href={`http://localhost:${hp}`} target="_blank" rel="noreferrer"
                    className="flex items-center gap-0.5 text-xs text-blue-400 hover:text-blue-300">
                    :{hp} <ExternalLink size={10} />
                  </a>
                ))}
              </div>
              <div className="flex gap-1.5">
                {sandboxStatus?.status !== 'running' && (
                  <button onClick={handleSandboxStart} disabled={sandboxBusy}
                    className="px-2 py-1 text-xs bg-green-600/20 text-green-400 border border-green-600/30 rounded hover:bg-green-600/30 transition-colors disabled:opacity-50">
                    {sandboxBusy ? '…' : 'Start'}
                  </button>
                )}
                <button onClick={handleSandboxReset} disabled={sandboxBusy} title="Reset sandbox"
                  className="p-1 text-gray-600 hover:text-gray-400 rounded hover:bg-gray-700 transition-colors disabled:opacity-50">
                  <RotateCcw size={12} />
                </button>
                <button onClick={() => api.getSandboxFiles(agent.id).then(d => setSandboxFiles(d.files || []))}
                  className="p-1 text-gray-600 hover:text-gray-400 rounded hover:bg-gray-700 transition-colors" title="Refresh files">
                  <RefreshCw size={12} />
                </button>
              </div>
            </div>

            <div className="flex gap-2 min-h-64">
              {/* File tree */}
              <div className="w-40 flex-shrink-0 flex flex-col gap-0.5 overflow-y-auto max-h-80">
                {sandboxFiles.length === 0 ? (
                  <p className="text-xs text-gray-600 px-1 py-2">No files yet</p>
                ) : sandboxFiles.map(f => {
                  const name = f.replace(/^\.\//, '');
                  const depth = (name.match(/\//g) || []).length;
                  return (
                    <button key={f} onClick={() => loadSandboxFile(name)}
                      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-left text-xs truncate transition-colors ${sandboxSelectedFile === name ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'}`}
                      style={{ paddingLeft: `${depth * 8 + 6}px` }}
                    >
                      <FileText size={10} className="flex-shrink-0 opacity-60" />
                      <span className="truncate">{name.split('/').pop()}</span>
                    </button>
                  );
                })}
              </div>

              {/* File editor */}
              <div className="flex-1 flex flex-col gap-1.5 min-w-0">
                {sandboxSelectedFile ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-gray-500 truncate">{sandboxSelectedFile}</span>
                      <button onClick={saveSandboxFile} disabled={sandboxFileSaving}
                        className="flex items-center gap-1 px-2 py-0.5 text-xs bg-blue-600/20 text-blue-400 border border-blue-600/30 rounded hover:bg-blue-600/30 disabled:opacity-50 transition-colors flex-shrink-0">
                        <Save size={10} /> {sandboxFileSaving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                    <textarea
                      value={sandboxFileContent}
                      onChange={e => setSandboxFileContent(e.target.value)}
                      className="flex-1 w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs font-mono text-gray-200 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 min-h-52"
                    />
                  </>
                ) : (
                  <div className="flex items-center justify-center h-full text-xs text-gray-600">
                    Select a file to view or edit
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="sticky bottom-0 -mx-6 -mb-6 mt-6 flex justify-end gap-3 border-t border-gray-700 bg-gray-900/95 px-6 py-4 backdrop-blur">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {staffCreateMode ? (
          <Button onClick={handleCreateFromStaffProfile} disabled={staffCreating || !staffProfileId}>
            <UserRound size={14} /> {staffCreating ? 'Creating…' : 'Create from staff'}
          </Button>
        ) : tab !== 4 && tab !== sandboxTabIndex && (
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : (agent ? 'Save Changes' : 'Create Agent')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
