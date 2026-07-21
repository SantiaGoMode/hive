import { useState, useEffect, useMemo } from 'react';
import { Plus, Trash2, Webhook, RefreshCw, Activity, Filter, Play, FileJson, Clock, Zap } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { toast } from '../stores/toastStore';
import { CopyButton } from '../components/ui/CopyButton';
// Import RunModal from its own module — going through the PipelinesPage
// re-export pulls the whole PipelinesPage graph into this chunk.
import { RunModal } from '../features/pipelines/RunModal';

function parseSpec(webhook) {
  if (!webhook || !webhook.context_spec) return [];
  try {
    const v = typeof webhook.context_spec === 'string' ? JSON.parse(webhook.context_spec) : webhook.context_spec;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function parseActions(webhook) {
  if (!webhook || !webhook.actions_config) return [];
  try {
    const v = typeof webhook.actions_config === 'string' ? JSON.parse(webhook.actions_config) : webhook.actions_config;
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

const defaultAction = () => ({
  id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  label: '',
  enabled: true,
  event_type: '',
  target_type: 'pipeline',
  pipeline_id: '',
  agent_id: '',
  prompt: '{input}',
});

function WebhookEditor({ open, webhook, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', description: '', secret: '', enabled: false });
  const [spec, setSpec] = useState([]);
  const [actions, setActions] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [agents, setAgents] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      api.getPipelines().then(setPipelines).catch(() => setPipelines([]));
      api.getAgents().then(setAgents).catch(() => setAgents([]));
      if (webhook) {
        setForm({ name: webhook.name, description: webhook.description || '', secret: webhook.secret || '', enabled: !!webhook.enabled });
        setSpec(parseSpec(webhook));
        setActions(parseActions(webhook));
      } else {
        setForm({ name: '', description: '', secret: '', enabled: false });
        setSpec([]);
        setActions([]);
      }
    }
  }, [open, webhook]);

  const addRow = () => setSpec([...spec, { label: '', path: '', event_type: '' }]);
  const updateRow = (i, key, value) => setSpec(spec.map((m, idx) => idx === i ? { ...m, [key]: value } : m));
  const removeRow = (i) => setSpec(spec.filter((_, idx) => idx !== i));
  const addAction = () => setActions([...actions, defaultAction()]);
  const updateAction = (i, key, value) => setActions(actions.map((a, idx) => idx === i ? { ...a, [key]: value } : a));
  const removeAction = (i) => setActions(actions.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    if (!form.name.trim()) return toast.error('Name is required');
    if (form.enabled && !form.secret.trim()) return toast.error('A secret is required before enabling this webhook');
    // Keep only rows with both a label and a path; drop blank event_type.
    const cleanSpec = spec
      .filter(m => m.label.trim() && m.path.trim())
      .map(m => {
        const row = { label: m.label.trim(), path: m.path.trim() };
        if (m.event_type && m.event_type.trim()) row.event_type = m.event_type.trim();
        return row;
      });
    const cleanActions = actions
      .map(a => ({
        id: a.id,
        label: (a.label || '').trim(),
        enabled: a.enabled !== false,
        event_type: (a.event_type || '').trim(),
        target_type: a.target_type === 'agent' ? 'agent' : 'pipeline',
        pipeline_id: a.target_type === 'agent' ? '' : (a.pipeline_id || '').trim(),
        agent_id: a.target_type === 'agent' ? (a.agent_id || '').trim() : '',
        prompt: a.prompt || '{input}',
      }))
      .filter(a => a.enabled === false || (a.target_type === 'agent' ? a.agent_id : a.pipeline_id));
    setSaving(true);
    try {
      const payload = { ...form, context_spec: cleanSpec, actions_config: cleanActions };
      if (webhook) await api.updateWebhook(webhook.id, payload);
      else await api.createWebhook(payload);
      toast.success(webhook ? 'Webhook updated' : 'Webhook created');
      onSave();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={webhook ? 'Edit Webhook' : 'New Webhook'} size="xl">
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
        <Input label="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. GitHub Commits" />
        <Input label="Description" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Optional description" />
        <Input label="Secret Token" value={form.secret} onChange={e => setForm({ ...form, secret: e.target.value })} placeholder="Required when enabled; use a value or env:WEBHOOK_SECRET" />

        <label className="flex items-center gap-2 cursor-pointer mt-2">
          <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} className="rounded bg-gray-900 border-gray-700 text-blue-500 focus:ring-blue-500" />
          <span className="text-sm text-gray-300">Enable this webhook endpoint</span>
        </label>

        {/* Context spec — fields passed to the agent */}
        <div className="mt-2 pt-4 border-t border-gray-800">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-medium text-gray-200">Agent Context Fields</p>
            <Button size="sm" variant="secondary" onClick={addRow}><Plus size={12} /> Add field</Button>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Map raw payload fields to the distilled context the agent receives. Use dot-paths
            (e.g. <span className="font-mono text-gray-400">repository.full_name</span>,{' '}
            <span className="font-mono text-gray-400">commits.0.id</span>). Leave the event type
            blank to apply to all events. If no fields are defined, the full raw payload is sent.
          </p>
          {spec.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No fields mapped — agent receives the full raw payload.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-[1fr_1.4fr_0.9fr_auto] gap-2 text-[10px] uppercase tracking-wider text-gray-600 px-1">
                <span>Label</span><span>Payload path</span><span>Event type</span><span></span>
              </div>
              {spec.map((m, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.4fr_0.9fr_auto] gap-2 items-center">
                  <input value={m.label} onChange={e => updateRow(i, 'label', e.target.value)} placeholder="repo"
                    className="bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 font-mono focus:ring-blue-500 focus:border-blue-500 outline-none" />
                  <input value={m.path} onChange={e => updateRow(i, 'path', e.target.value)} placeholder="repository.full_name"
                    className="bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 font-mono focus:ring-blue-500 focus:border-blue-500 outline-none" />
                  <input value={m.event_type || ''} onChange={e => updateRow(i, 'event_type', e.target.value)} placeholder="(all)"
                    className="bg-gray-900 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 font-mono focus:ring-blue-500 focus:border-blue-500 outline-none" />
                  <button onClick={() => removeRow(i)} className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors" title="Remove"><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Automatic actions */}
        <div className="mt-2 pt-4 border-t border-gray-800">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-medium text-gray-200">Automatic Actions</p>
            <Button size="sm" variant="secondary" onClick={addAction}><Plus size={12} /> Add action</Button>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Run a pipeline or agent prompt whenever an incoming event matches. Variables:
            <code className="bg-gray-800 px-1 rounded mx-1">{'{input}'}</code>
            <code className="bg-gray-800 px-1 rounded mr-1">{'{context}'}</code>
            <code className="bg-gray-800 px-1 rounded mr-1">{'{event_type}'}</code>
            <code className="bg-gray-800 px-1 rounded">{'{event_id}'}</code>
          </p>
          {actions.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No automatic actions — events are stored for manual review.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {actions.map((action, i) => (
                <div key={action.id || i} className="p-3 rounded-lg border border-gray-700 bg-gray-900/40 flex flex-col gap-3">
                  <div className="grid grid-cols-[1fr_0.8fr_0.8fr_auto] gap-2 items-end">
                    <input
                      value={action.label || ''}
                      onChange={e => updateAction(i, 'label', e.target.value)}
                      placeholder="Coding flow for issues"
                      className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    <input
                      value={action.event_type || ''}
                      onChange={e => updateAction(i, 'event_type', e.target.value)}
                      placeholder="issues (blank = all)"
                      className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 font-mono focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    <select
                      value={action.target_type || 'pipeline'}
                      onChange={e => updateAction(i, 'target_type', e.target.value)}
                      className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    >
                      <option value="pipeline">Pipeline</option>
                      <option value="agent">Agent prompt</option>
                    </select>
                    <button onClick={() => removeAction(i)} className="p-1.5 text-gray-500 hover:text-red-400 rounded transition-colors" title="Remove"><Trash2 size={12} /></button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={action.enabled !== false}
                      onChange={e => updateAction(i, 'enabled', e.target.checked)}
                      className="rounded bg-gray-950 border-gray-700 text-blue-500 focus:ring-blue-500"
                    />
                    Action enabled
                  </label>

                  {action.target_type === 'agent' ? (
                    <select
                      value={action.agent_id || ''}
                      onChange={e => updateAction(i, 'agent_id', e.target.value)}
                      className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    >
                      <option value="">Select agent</option>
                      {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                  ) : (
                    <select
                      value={action.pipeline_id || ''}
                      onChange={e => updateAction(i, 'pipeline_id', e.target.value)}
                      className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    >
                      <option value="">Select pipeline</option>
                      {pipelines.map(pipeline => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}
                    </select>
                  )}

                  <textarea
                    value={action.prompt || ''}
                    onChange={e => updateAction(i, 'prompt', e.target.value)}
                    rows={3}
                    placeholder={action.target_type === 'agent' ? 'Prompt for the agent. Use {input} or {context}.' : 'Input passed into the pipeline. Use {input} or {context}.'}
                    className="bg-gray-950 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 font-mono resize-none focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 mt-4 pt-4 border-t border-gray-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function ActionModal({ open, onClose, payloadStr }) {
  const [pipelines, setPipelines] = useState([]);
  const [selectedPipeline, setSelectedPipeline] = useState(null);

  useEffect(() => {
    if (open) {
      api.getPipelines().then(setPipelines).catch(() => {});
    } else {
      setSelectedPipeline(null);
    }
  }, [open]);

  if (selectedPipeline) {
    return <RunModal open={true} onClose={() => { setSelectedPipeline(null); onClose(); }} pipeline={selectedPipeline} initialInput={payloadStr} />;
  }

  return (
    <Modal open={open} onClose={onClose} title="Take Action">
      <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
        <p className="text-sm text-gray-300">Select a pipeline to process this event's payload.</p>
        <div className="flex flex-col gap-2">
          {pipelines.length === 0 ? (
             <p className="text-xs text-gray-500 italic p-4 text-center border border-dashed border-gray-700 rounded-lg">No pipelines found. Create one in the Pipelines page first.</p>
          ) : pipelines.map(p => (
            <button key={p.id} onClick={() => setSelectedPipeline(p)} className="flex items-center justify-between p-3 rounded-lg border border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-left group">
              <div>
                <p className="text-sm font-medium text-gray-200">{p.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">{p.steps.length} steps</p>
              </div>
              <Play size={14} className="text-gray-600 group-hover:text-blue-400 transition-colors" />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [events, setEvents] = useState([]);
  const [actionRuns, setActionRuns] = useState([]);
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState(null);
  
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [actionPayload, setActionPayload] = useState('');
  
  const [config, setConfig] = useState({});
  const [ngrokStatus, setNgrokStatus] = useState({ running: false, url: null });

  const loadData = async () => {
    try {
      const wh = await api.getWebhooks();
      setWebhooks(wh);
      const conf = await api.getConfig();
      setConfig(conf);
      const ng = await api.getNgrokStatus();
      setNgrokStatus(ng);
      if (wh.length > 0 && !activeId) setActiveId(wh[0].id);
    } catch { toast.error('Failed to load webhooks'); }
  };

  useEffect(() => { loadData(); }, []);

  const loadEvents = async () => {
    if (!activeId) return;
    try {
      const evts = await api.getWebhookEvents(activeId, eventTypeFilter);
      setEvents(evts);
      const runs = await api.getWebhookActionRuns(activeId);
      setActionRuns(runs);
    } catch { setEvents([]); }
  };

  useEffect(() => { loadEvents(); }, [activeId, eventTypeFilter]);

  const activeWebhook = webhooks.find(w => w.id === activeId);
  const activeActions = parseActions(activeWebhook);

  const handleDelete = async (w) => {
    if (!confirm(`Delete webhook "${w.name}"?`)) return;
    try {
      await api.deleteWebhook(w.id);
      if (activeId === w.id) setActiveId(null);
      loadData();
    } catch (e) { toast.error(e.message); }
  };

  const handleClearEvents = async () => {
    if (!activeId) return;
    if (!confirm('Clear all events in this inbox?')) return;
    try {
      await api.clearWebhookEvents(activeId);
      loadEvents();
    } catch (e) { toast.error(e.message); }
  };

  const publicBase = ngrokStatus.running ? ngrokStatus.url : (config.webhook_public_url || `http://localhost:${window.location.port || 3001}`);
  const endpointUrl = activeWebhook ? `${publicBase.replace(/\/$/, '')}/api/webhooks/incoming/${activeWebhook.id}` : '';

  const uniqueEventTypes = useMemo(() => {
    const types = new Set(events.map(e => e.event_type));
    return Array.from(types).filter(Boolean);
  }, [events]);

  return (
    <div className="flex h-full">
      {/* Left Sidebar - Webhooks List */}
      <div className="w-64 border-r border-gray-800 flex flex-col bg-[#1a1d27]">
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2"><Webhook size={16} /> Webhooks</h2>
          <Button size="icon" variant="ghost" onClick={() => { setEditingWebhook(null); setEditorOpen(true); }}><Plus size={14} /></Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {webhooks.length === 0 ? (
            <p className="text-xs text-gray-500 italic p-4 text-center">No webhooks configured.</p>
          ) : webhooks.map(w => (
            <div key={w.id} className={`group flex flex-col p-3 rounded-lg border cursor-pointer transition-colors ${activeId === w.id ? 'bg-blue-500/10 border-blue-500/30' : 'border-transparent hover:bg-gray-800/50'}`} onClick={() => setActiveId(w.id)}>
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${activeId === w.id ? 'text-blue-400' : 'text-gray-300'}`}>{w.name}</span>
                <div className={`w-2 h-2 rounded-full ${w.enabled ? 'bg-green-500' : 'bg-gray-600'}`} title={w.enabled ? 'Enabled' : 'Disabled'} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right Area - Event Inbox */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#0f1117]">
        {activeWebhook ? (
          <>
            <div className="p-6 border-b border-gray-800 flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold text-gray-100 flex items-center gap-2">
                    {activeWebhook.name}
                  </h1>
                  <p className="text-sm text-gray-400 mt-1">{activeWebhook.description || 'No description'}</p>
                  {activeActions.length > 0 && (
                    <p className="text-xs text-blue-400 mt-2 flex items-center gap-1.5">
                      <Zap size={12} /> {activeActions.filter(a => a.enabled !== false).length} automatic action{activeActions.length !== 1 ? 's' : ''} configured
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => loadEvents()}><RefreshCw size={14} /> Refresh</Button>
                  <Button variant="secondary" size="sm" onClick={() => { setEditingWebhook(activeWebhook); setEditorOpen(true); }}>Edit</Button>
                  <Button variant="danger" size="sm" onClick={() => handleDelete(activeWebhook)}><Trash2 size={14} /></Button>
                </div>
              </div>

              {/* Endpoint URL Card */}
              <div className="p-3 rounded-lg bg-gray-900 border border-gray-700 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-500 font-medium mb-1 uppercase tracking-wider">Endpoint URL</p>
                  <p className="text-sm font-mono text-gray-300 truncate select-all">{endpointUrl}</p>
                </div>
                <CopyButton text={endpointUrl} />
              </div>
            </div>

            {actionRuns.length > 0 && (
              <div className="px-6 py-3 border-b border-gray-800 bg-gray-900/20">
                <div className="flex items-center gap-2 mb-2">
                  <Zap size={14} className="text-blue-400" />
                  <h3 className="text-sm font-semibold text-gray-200">Recent Automatic Runs</h3>
                </div>
                <div className="flex flex-col gap-1">
                  {actionRuns.slice(0, 5).map(run => (
                    <div key={run.id} className="flex items-center justify-between gap-3 text-xs bg-gray-900 border border-gray-800 rounded px-3 py-2">
                      <span className="text-gray-300 truncate">{run.action_label || run.action_type}</span>
                      <span className="text-gray-500 truncate">{run.action_type} · {run.target_id}</span>
                      <span className={run.status === 'done' ? 'text-green-400' : run.status === 'error' ? 'text-red-400' : 'text-yellow-400'}>
                        {run.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="px-6 py-3 border-b border-gray-800 flex items-center justify-between bg-gray-900/30">
              <div className="flex items-center gap-3">
                <Activity size={16} className="text-gray-400" />
                <h3 className="text-sm font-semibold text-gray-200">Event Inbox</h3>
                <span className="text-xs bg-gray-800 px-2 py-0.5 rounded-full text-gray-400">{events.length}</span>
              </div>
              <div className="flex items-center gap-3">
                {uniqueEventTypes.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Filter size={14} className="text-gray-500" />
                    <select 
                      value={eventTypeFilter} 
                      onChange={e => setEventTypeFilter(e.target.value)}
                      className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-2 py-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    >
                      <option value="">All Events</option>
                      {uniqueEventTypes.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </div>
                )}
                <Button variant="secondary" size="sm" onClick={handleClearEvents} disabled={events.length === 0} title="Clear Inbox"><Trash2 size={14} /></Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {events.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
                  <Webhook size={32} className="opacity-50" />
                  <p>No events received yet.</p>
                  <p className="text-xs max-w-sm text-center">Configure your external service to send POST requests to the Endpoint URL above.</p>
                </div>
              ) : events.map(evt => (
                <div key={evt.id} className="border border-gray-800 bg-gray-900/30 rounded-lg overflow-hidden flex flex-col">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/60">
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-semibold px-2 py-1 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">{evt.event_type}</span>
                      <span className="text-xs text-gray-500 flex items-center gap-1"><Clock size={11} /> {new Date(evt.created_at * 1000).toLocaleString()}</span>
                    </div>
                    <Button size="sm" onClick={async () => {
                       let envelope;
                       try {
                         envelope = await api.getProjectedEvent(activeWebhook.id, evt.id);
                       } catch {
                         // Fall back to raw payload if projection fails.
                         envelope = { context: evt.payload, _event_id: evt.id, _event_type: evt.event_type, _projected: false };
                       }
                       setActionPayload(JSON.stringify(envelope, null, 2));
                       setActionModalOpen(true);
                    }}>
                      <Play size={12} /> Take Action
                    </Button>
                  </div>
                  <div className="p-4 flex flex-col gap-2">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1"><FileJson size={12} /> Payload</p>
                    <div className="bg-gray-950 p-3 rounded border border-gray-800 overflow-x-auto max-h-64 overflow-y-auto">
                      <pre className="text-xs text-gray-300 font-mono">
                        {JSON.stringify(evt.payload, null, 2)}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500">
            {webhooks.length === 0 ? 'Create a webhook to get started' : 'Select a webhook from the sidebar'}
          </div>
        )}
      </div>

      <WebhookEditor open={editorOpen} webhook={editingWebhook} onClose={() => setEditorOpen(false)} onSave={() => { setEditorOpen(false); loadData(); }} />
      <ActionModal open={actionModalOpen} onClose={() => setActionModalOpen(false)} payloadStr={actionPayload} />
    </div>
  );
}
