import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { Clock, Plus, Play, Trash2, ToggleLeft, ToggleRight, Edit2, CheckCircle, AlertCircle, Loader2, ChevronDown, ChevronUp, RotateCcw, GitBranch } from 'lucide-react';
import { cn } from '../lib/utils';
import { toast } from '../stores/toastStore';
import { Modal } from '../components/ui/Modal';
import { ToolPicker } from '../components/ToolPicker';
import { CopyButton } from '../components/ui/CopyButton';
import { MarkdownContent } from '../components/MarkdownContent';

function AdvancedDisclosure({ id, title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-800 bg-[#0f1117]/60">
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
        <ChevronDown size={13} className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id={id} className="border-t border-gray-800 px-3 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

// The built-in tool groups + compact tool picker are shared via
// components/ToolPicker (issue #4) with PipelinesPage.

// ── Cron presets ──────────────────────────────────────────────────────────────
const PRESETS = [
  { label: 'Every minute',   value: '* * * * *' },
  { label: 'Every 5 min',    value: '*/5 * * * *' },
  { label: 'Every 15 min',   value: '*/15 * * * *' },
  { label: 'Every hour',     value: '0 * * * *' },
  { label: 'Every 6 hours',  value: '0 */6 * * *' },
  { label: 'Daily at 8am',   value: '0 8 * * *' },
  { label: 'Daily at noon',  value: '0 12 * * *' },
  { label: 'Daily at 6pm',   value: '0 18 * * *' },
  { label: 'Weekly (Mon 9am)',value: '0 9 * * 1' },
  { label: 'Custom…',        value: 'custom' },
];

const EMPTY_FORM = { agent_id: '', pipeline_id: '', label: '', cron_expr: '0 8 * * *', prompt: '', enabled: true, tools: [] };

// ── Schedule editor modal ─────────────────────────────────────────────────────
function ScheduleEditor({ schedule, agents, pipelines, onSave, onClose }) {
  const [form, setForm] = useState(() =>
    schedule
      ? { agent_id: schedule.agent_id || '', pipeline_id: schedule.pipeline_id || '', label: schedule.label, cron_expr: schedule.cron_expr, prompt: schedule.prompt, enabled: !!schedule.enabled, tools: schedule.tools || [] }
      : { ...EMPTY_FORM },
  );
  const [target, setTarget] = useState(schedule?.pipeline_id ? 'pipeline' : 'agent');
  const [presetKey, setPresetKey] = useState(() => {
    const found = PRESETS.find(p => p.value !== 'custom' && p.value === (schedule?.cron_expr ?? EMPTY_FORM.cron_expr));
    return found ? found.value : 'custom';
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [mcpServers, setMcpServers] = useState([]);
  const hasCustomCron = presetKey === 'custom';
  const hasToolOverrides = form.tools.length > 0;

  useEffect(() => {
    api.getMcpServers().then(setMcpServers).catch(() => setMcpServers([]));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handlePreset = (value) => {
    setPresetKey(value);
    if (value !== 'custom') set('cron_expr', value);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (target === 'agent' && !form.agent_id) { setError('Select an agent'); return; }
    if (target === 'pipeline' && !form.pipeline_id) { setError('Select a pipeline'); return; }
    if (!form.label.trim()) { setError('Label is required'); return; }
    if (!form.cron_expr.trim()) { setError('Cron expression is required'); return; }
    if (!form.prompt.trim()) { setError('Prompt is required'); return; }
    setSaving(true);
    setError('');
    try {
      // Tool overrides only apply to agent runs; pipelines bring their own steps.
      const payload = target === 'pipeline'
        ? { ...form, agent_id: '', tools: [] }
        : { ...form, pipeline_id: '' };
      if (schedule) {
        await api.updateSchedule(schedule.id, payload);
      } else {
        await api.createSchedule(payload);
      }
      onSave();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={schedule ? 'Edit Schedule' : 'New Schedule'}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
          {/* Label */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1">Label</label>
            <input
              className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              placeholder="e.g. Morning news briefing"
              value={form.label}
              onChange={e => set('label', e.target.value)}
            />
          </div>

          {/* Target: single agent or whole pipeline */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1">Run</label>
            <div className="flex gap-1 mb-2 bg-[#0f1117] border border-gray-800 rounded-lg p-0.5 w-fit">
              {['agent', 'pipeline'].map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize ${target === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-100'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            {target === 'agent' ? (
              <select
                className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                value={form.agent_id}
                onChange={e => set('agent_id', e.target.value)}
              >
                <option value="">Select an agent…</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            ) : (
              <>
                <select
                  className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                  value={form.pipeline_id}
                  onChange={e => set('pipeline_id', e.target.value)}
                >
                  <option value="">Select a pipeline…</option>
                  {pipelines.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-600 mt-1">The prompt below is the pipeline's input; its final output is stored as the run result.</p>
              </>
            )}
          </div>

          {/* Schedule */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1">Schedule</label>
            <select
              className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500 mb-2"
              value={presetKey}
              onChange={e => handlePreset(e.target.value)}
            >
              {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>

          {/* Prompt */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1">Prompt</label>
            <textarea
              rows={4}
              className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:border-blue-500"
              placeholder="What should the agent do? e.g. Search for the latest AI news and summarize the top 5 stories."
              value={form.prompt}
              onChange={e => set('prompt', e.target.value)}
            />
          </div>

          <AdvancedDisclosure
            id="schedule-advanced"
            title="Advanced schedule options"
            summary={`${hasCustomCron ? `Custom cron ${form.cron_expr}` : 'Raw cron expression'} · ${form.tools.length} tool override${form.tools.length === 1 ? '' : 's'}`}
            defaultOpen={hasCustomCron || hasToolOverrides}
          >
            <div className="flex flex-col gap-4">
              <div>
                <label className="text-xs text-gray-400 font-medium block mb-1">Cron expression</label>
                <input
                  className="w-full bg-[#0f1117] border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 font-mono focus:outline-none focus:border-blue-500"
                  placeholder="cron expression: min hr dom mon dow"
                  value={form.cron_expr}
                  onChange={e => { setPresetKey('custom'); set('cron_expr', e.target.value); }}
                />
                <p className="text-xs text-gray-600 mt-1">Format: minute hour day-of-month month day-of-week</p>
              </div>
              {target === 'agent' ? (
                <ToolPicker
                  tools={form.tools}
                  onChange={t => set('tools', t)}
                  mcpServers={mcpServers}
                  overrideHint="Overrides the agent's configured tools for this schedule."
                />
              ) : (
                <p className="text-xs text-gray-600">Tool overrides don't apply to pipeline schedules — each step's own tool settings are used.</p>
              )}
            </div>
          </AdvancedDisclosure>

          {/* Enabled */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 rounded accent-blue-500"
              checked={form.enabled}
              onChange={e => set('enabled', e.target.checked)}
            />
            <span className="text-sm text-gray-300">Enabled (run on schedule)</span>
          </label>

          {error && <p className="text-red-400 text-xs">{error}</p>}

          <div className="flex gap-2 justify-end pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-100 rounded-lg hover:bg-gray-800">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {schedule ? 'Save changes' : 'Create schedule'}
            </button>
          </div>
        </form>
    </Modal>
  );
}

// ── Schedule card ─────────────────────────────────────────────────────────────
function ScheduleCard({ schedule, agents, pipelines, onEdit, onDelete, onToggle, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  const isPipeline = !!schedule.pipeline_id;
  const agent = agents.find(a => a.id === schedule.agent_id);
  const pipeline = pipelines.find(p => p.id === schedule.pipeline_id);
  const targetName = isPipeline
    ? (pipeline?.name ?? schedule.pipeline_id)
    : (agent?.name ?? schedule.agent_id);

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await api.runScheduleNow(schedule.id);
      // Poll for result after the agent likely finishes
      setTimeout(() => onRefresh(), 3000);
    } catch (e) {
      toast.error(`Failed to run schedule: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const handleClearHistory = async () => {
    setClearingHistory(true);
    try {
      await api.clearScheduleHistory(schedule.id);
      onRefresh();
    } catch (e) {
      toast.error(`Failed to clear history: ${e.message}`);
    } finally {
      setClearingHistory(false);
    }
  };

  const fmtTime = (unix) => {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  };

  return (
    <div className={cn(
      'bg-[#1a1d27] border rounded-xl overflow-hidden transition-colors',
      schedule.enabled ? 'border-gray-700' : 'border-gray-800 opacity-60',
    )}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className={cn(
              'w-2 h-2 rounded-full mt-1.5 flex-shrink-0',
              schedule.enabled ? 'bg-green-500' : 'bg-gray-600',
            )} />
            <div className="min-w-0">
              <p className="font-medium text-gray-100 text-sm truncate">{schedule.label}</p>
              <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                {isPipeline && <GitBranch size={10} className="text-purple-400" />}
                {targetName}
                {isPipeline && <span className="text-[10px] uppercase tracking-wide bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded px-1 py-px">pipeline</span>}
                {' '}· <code className="font-mono">{schedule.cron_expr}</code>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handleRunNow}
              disabled={running}
              title="Run now"
              className="p-1.5 text-gray-400 hover:text-green-400 rounded-lg hover:bg-gray-800 disabled:opacity-50"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            </button>
            <button onClick={() => onToggle(schedule.id)} title={schedule.enabled ? 'Disable' : 'Enable'} className="p-1.5 text-gray-400 hover:text-blue-400 rounded-lg hover:bg-gray-800">
              {schedule.enabled ? <ToggleRight size={16} className="text-blue-400" /> : <ToggleLeft size={16} />}
            </button>
            <button onClick={() => onEdit(schedule)} className="p-1.5 text-gray-400 hover:text-gray-100 rounded-lg hover:bg-gray-800">
              <Edit2 size={13} />
            </button>
            <button onClick={() => onDelete(schedule.id)} className="p-1.5 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-800">
              <Trash2 size={13} />
            </button>
            <button onClick={() => setExpanded(e => !e)} className="p-1.5 text-gray-400 hover:text-gray-100 rounded-lg hover:bg-gray-800">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-3 mt-3 text-xs text-gray-500">
          <span>Runs: <span className="text-gray-300">{schedule.run_count}</span></span>
          <span>Last run: <span className="text-gray-300">{fmtTime(schedule.last_run)}</span></span>
          {schedule.last_error && (
            <span className="flex items-center gap-1 text-red-400">
              <AlertCircle size={11} /> Error
            </span>
          )}
          {!schedule.last_error && schedule.last_run && (
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle size={11} /> OK
            </span>
          )}
        </div>
        {/* Tool badges */}
        {schedule.tools?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {schedule.tools.map(t => (
              <span key={t} className={`text-xs px-1.5 py-0.5 rounded border ${t.startsWith('mcp:') ? 'bg-purple-500/10 border-purple-500/20 text-purple-400' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'}`}>
                {t.startsWith('mcp:') ? `⬡ ${t.slice(4)}` : t}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3 bg-[#0f1117] space-y-3">
          <div>
            <p className="text-xs text-gray-500 font-medium mb-1">Prompt</p>
            <p className="text-sm text-gray-300 whitespace-pre-wrap">{schedule.prompt}</p>
          </div>
          {schedule.last_error && (
            <div>
              <p className="text-xs text-red-400 font-medium mb-1">Last error</p>
              <p className="text-xs text-red-300 font-mono whitespace-pre-wrap bg-red-500/5 border border-red-500/20 rounded-lg p-2 max-h-32 overflow-y-auto">{schedule.last_error}</p>
            </div>
          )}
          {schedule.last_output && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-gray-500 font-medium">Last output</p>
                <CopyButton text={schedule.last_output} size={11} title="Copy output" className="flex-shrink-0" />
              </div>
              <div className="bg-gray-900 border border-gray-700 rounded-lg p-3 max-h-72 overflow-y-auto text-sm text-gray-200">
                <MarkdownContent>{schedule.last_output}</MarkdownContent>
              </div>
            </div>
          )}
          <div className="pt-1 border-t border-gray-800/60 flex justify-end">
            <button
              onClick={handleClearHistory}
              disabled={clearingHistory}
              className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400 transition-colors disabled:opacity-50"
            >
              <RotateCcw size={10} />
              {clearingHistory ? 'Clearing…' : 'Clear run history'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Delete confirm ────────────────────────────────────────────────────────────
function DeleteConfirm({ onConfirm, onCancel }) {
  return (
    <Modal open onClose={onCancel} title="Delete schedule?" size="sm">
      <p className="text-sm text-gray-400 mb-4">This will permanently remove the schedule. No more runs will trigger.</p>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-100 rounded-lg hover:bg-gray-800">Cancel</button>
        <button onClick={onConfirm} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg">Delete</button>
      </div>
    </Modal>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SchedulesPage() {
  const [schedules, setSchedules] = useState([]);
  const [agents, setAgents] = useState([]);
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editTarget, setEditTarget] = useState(null);    // schedule | true (new)
  const [deleteId, setDeleteId] = useState(null);

  const load = useCallback(async () => {
    try {
      // Fetch independently so an agent list error doesn't wipe out schedules and vice versa
      const [schedulesResult, agentsResult, pipelinesResult] = await Promise.allSettled([
        api.getSchedules(),
        api.getAgents(),
        api.getPipelines(),
      ]);
      if (schedulesResult.status === 'fulfilled') setSchedules(schedulesResult.value);
      if (agentsResult.status === 'fulfilled') setAgents(agentsResult.value);
      if (pipelinesResult.status === 'fulfilled') setPipelines(pipelinesResult.value);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (id) => {
    try {
      await api.toggleSchedule(id);
    } catch (e) {
      toast.error(`Failed to toggle schedule: ${e.message}`);
      return;
    }
    load();
  };

  const handleDelete = async () => {
    try {
      await api.deleteSchedule(deleteId);
    } catch (e) {
      toast.error(`Failed to delete schedule: ${e.message}`);
      return;
    }
    setDeleteId(null);
    load();
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Clock size={20} className="text-blue-400" />
          <h1 className="text-xl font-bold text-gray-100">Scheduled Runs</h1>
          {schedules.length > 0 && (
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">{schedules.length}</span>
          )}
        </div>
        <button
          onClick={() => setEditTarget(true)}
          className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg"
        >
          <Plus size={15} />
          New Schedule
        </button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <Loader2 size={20} className="animate-spin text-gray-500" />
        </div>
      ) : schedules.length === 0 ? (
        <div className="text-center py-16 text-gray-600">
          <Clock size={40} className="mx-auto mb-3 opacity-30" />
          <p className="font-medium text-gray-500">No schedules yet</p>
          <p className="text-sm mt-1">Automate agents to run on a cron schedule.</p>
          <button
            onClick={() => setEditTarget(true)}
            className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg"
          >
            Create your first schedule
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {schedules.map(s => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              agents={agents}
              pipelines={pipelines}
              onEdit={setEditTarget}
              onDelete={setDeleteId}
              onToggle={handleToggle}
              onRefresh={load}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editTarget && (
        <ScheduleEditor
          schedule={editTarget === true ? null : editTarget}
          agents={agents}
          pipelines={pipelines}
          onSave={() => { setEditTarget(null); load(); }}
          onClose={() => setEditTarget(null)}
        />
      )}

      {/* Delete confirm */}
      {deleteId && (
        <DeleteConfirm
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
