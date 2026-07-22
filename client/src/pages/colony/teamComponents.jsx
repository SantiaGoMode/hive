import { useState, useEffect } from 'react';
import {
  Zap, Square, Trash2, ChevronRight, FileText, Clock, CheckCircle2, XCircle,
  Loader2, Users, Download, ArrowRight, AlertTriangle, ShieldCheck, Link2,
  GitBranch, ExternalLink, X, BarChart3, Package, Plus, Search, Inbox, Play,
  Sparkles, ListTodo, RefreshCw,
} from 'lucide-react';
import { api, downloadAuthenticated } from '../../lib/api';
import { useAuthenticatedUrl } from '../../hooks/useAuthenticatedUrl';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import {
  ITEM_STATUS_META,
  PROVIDER_LABEL,
  STATUS_DOT,
  TEAM_STATUS_META,
  fmtDuration,
  runLabel,
} from './helpers';
import { AgentMarkdown } from './liveComponents';
import { isSafeUrl } from './safeUrl';

export function TeamConfigModal({ initial = null, recipes, presetRecipeId = null, onClose, onSaved }) {
  const editing = !!initial?.id;
  // Founding from a catalog ghost card pre-fills and locks the recipe — the
  // catalog is the hiring hall; the modal only collects name + repo (+ toggles).
  const recipeLocked = !editing && !!presetRecipeId;
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [recipeId, setRecipeId] = useState(initial?.recipe_id || presetRecipeId || 'development_team');
  const [repoPath, setRepoPath] = useState(initial?.repo_path || '');
  const [cloudEnabled, setCloudEnabled] = useState(!!initial?.cloud_enabled);
  const [githubReview, setGithubReview] = useState(!!initial?.github_review);
  const [githubPublish, setGithubPublish] = useState(!!(initial?.github_publish ?? initial?.github_writeback));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedRecipe = recipes.find(r => r.id === recipeId) || null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { name, description, recipe_id: recipeId, repo_path: repoPath, cloud_enabled: cloudEnabled, github_review: githubReview, github_publish: githubPublish };
      const team = editing
        ? await api.updateColonyTeam(initial.id, payload)
        : await api.createColonyTeam(payload);
      onSaved(team);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-5 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-100">
            {editing ? 'Edit colony' : recipeLocked ? `Found a colony — ${selectedRecipe?.name || presetRecipeId}` : 'New colony'}
          </p>
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300"><X size={15} /></button>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Hive-TaskMaster" autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Quick description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="What this team owns and works on…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Team preset</span>
          {recipeLocked ? (
            <span className="text-sm text-gray-200 border border-gray-800 bg-gray-900/60 rounded-lg px-3 py-2">{selectedRecipe?.name || presetRecipeId}</span>
          ) : (
            <select value={recipeId} onChange={e => setRecipeId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          {selectedRecipe?.summary && <p className="text-xs text-gray-500 leading-relaxed">{selectedRecipe.summary}</p>}
          {selectedRecipe?.execution_policy?.mode && (
            <p className="text-xs text-blue-300/80 border border-blue-900/40 bg-blue-950/20 rounded px-2 py-1.5">
              Execution mode: {selectedRecipe.execution_policy.mode === 'read_only' ? 'Read-only repository review' : selectedRecipe.execution_policy.mode === 'artifact_only' ? 'Artifacts only — repository changes blocked' : 'Repository delivery — intentional changes allowed'}
            </p>
          )}
          {selectedRecipe?.roles?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {selectedRecipe.roles.map(role => (
                <span key={role.key} className="text-xs text-gray-400 border border-gray-800 bg-gray-900/60 rounded px-2 py-0.5">{role.name}</span>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-600">The operator staffs each preset role with the best-matched staff member for this colony.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Repository / project</span>
          <input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="/path/to/your/git/repo"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
          <p className="text-xs text-gray-600">Issues and tasks are picked from this repo's board on the colony page — not here.</p>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-300">Enable cloud models</p>
            <p className="text-xs text-gray-600 mt-0.5">Off = local Ollama only. On = operator may assign Anthropic / OpenAI / Gemini.</p>
          </div>
          <button type="button" role="switch" aria-checked={cloudEnabled} onClick={() => setCloudEnabled(v => !v)}
            className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${cloudEnabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${cloudEnabled ? 'right-0.5' : 'left-0.5'}`} />
          </button>
        </div>

        {selectedRecipe?.execution_policy?.github_review && (
          <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-300">Post review to the original PR</p>
              <p className="text-xs text-gray-600 mt-0.5">Posts the verdict/report only. It never edits files, creates a branch, or opens another PR.</p>
            </div>
            <button type="button" role="switch" aria-checked={githubReview} onClick={() => setGithubReview(v => !v)}
              className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${githubReview ? 'bg-blue-600' : 'bg-gray-700'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${githubReview ? 'right-0.5' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {selectedRecipe?.execution_policy?.mode === 'repository_write' && (
          <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-300">Publish repository changes</p>
              <p className="text-xs text-amber-500/70 mt-0.5">Allows intentional edits, commits, pushes, and a Draft PR after a successful run. Failed or stopped runs are never published.</p>
            </div>
            <button type="button" role="switch" aria-checked={githubPublish} onClick={() => setGithubPublish(v => !v)}
              className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${githubPublish ? 'bg-amber-600' : 'bg-gray-700'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${githubPublish ? 'right-0.5' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={save} disabled={!name.trim() || saving} className="flex-1">
            {saving ? <><Loader2 size={13} className="animate-spin" /> Saving…</> : (editing ? 'Save changes' : 'Create colony')}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// Roster card: identity + live status. "Who's idle and who's working" must be
// answerable at a glance, so status, the current run, and the queue depth lead.
export function ColonyCard({ team, recipeNames, onOpen, onDelete }) {
  const stats = team.stats || {};
  const last = team.last_run;
  const status = TEAM_STATUS_META[team.status] || TEAM_STATUS_META.idle;
  const queue = team.queue || { proposed: 0, queued: 0, depth: 0 };
  const activeRun = team.active_run;
  return (
    <button
      onClick={onOpen}
      className="group text-left rounded-xl border border-gray-800 bg-gray-900/40 hover:border-gray-700 hover:bg-gray-900/70 transition-colors p-4 flex flex-col gap-2.5"
    >
      <div className="flex items-start gap-2">
        <Users size={16} className="text-blue-400/80 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-100 truncate">{team.name}</p>
          {team.description && <p className="text-xs text-gray-500 leading-snug line-clamp-2 mt-0.5">{team.description}</p>}
        </div>
        <span className={`flex items-center gap-1.5 text-xs border rounded-full px-2 py-0.5 flex-shrink-0 ${status.chip}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete(); } }}
          className="p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0"
          title="Delete this colony and all its runs (queued work is released, not deleted)"
        >
          <Trash2 size={13} />
        </span>
      </div>
      {activeRun && (
        <p className="text-xs text-blue-300/90 truncate" title={activeRun.goal}>
          <Loader2 size={10} className="inline animate-spin mr-1" />
          {runLabel(activeRun)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-400 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5">{recipeNames[team.recipe_id] || team.recipe_id}</span>
        {team.repo_path && (
          <span className="flex items-center gap-1 text-xs text-gray-500 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5 max-w-[14rem]">
            <GitBranch size={10} /> <span className="truncate">{team.repo_path.split('/').slice(-1)[0]}</span>
          </span>
        )}
        {queue.depth > 0 && (
          <span className={`flex items-center gap-1 text-xs border rounded px-2 py-0.5 ${queue.proposed > 0 ? 'border-purple-500/30 bg-purple-500/10 text-purple-300' : 'border-gray-800 bg-gray-950/60 text-gray-400'}`}
            title={`${queue.proposed} proposed · ${queue.queued} queued`}>
            <ListTodo size={10} /> {queue.depth} in queue
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-500 mt-auto pt-1">
        <span>{stats.total_runs || 0} run{(stats.total_runs || 0) === 1 ? '' : 's'}</span>
        {stats.success_rate != null && <span className="text-green-400/80">{Math.round(stats.success_rate * 100)}% success</span>}
        {team.last_artifact ? (
          <span className="flex items-center gap-1 ml-auto text-gray-600 min-w-0" title={`Last shipped: ${team.last_artifact.file || team.last_artifact.link}`}>
            <Package size={10} className="text-green-400/60 flex-shrink-0" />
            <span className="truncate max-w-[10rem]">{String(team.last_artifact.file || team.last_artifact.link).split('/').slice(-1)[0]}</span>
          </span>
        ) : last && (
          <span className="flex items-center gap-1.5 ml-auto">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[last.status] || 'bg-gray-700'}`} />
            <span className="text-gray-600">{formatDate(last.created_at * 1000)}</span>
          </span>
        )}
      </div>
    </button>
  );
}

// "Hiring hall" ghost card — a catalog recipe that can found a new colony.
export function RecipeGhostCard({ recipe, onFound }) {
  return (
    <button
      onClick={onFound}
      className="group text-left rounded-xl border border-dashed border-gray-800 bg-gray-950/30 hover:border-blue-500/40 hover:bg-gray-900/50 transition-colors p-4 flex flex-col gap-2"
      title={`Found a colony from the ${recipe.name} recipe`}
    >
      <div className="flex items-start gap-2">
        <Sparkles size={14} className="text-gray-600 group-hover:text-blue-400/80 mt-0.5 flex-shrink-0 transition-colors" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-300 group-hover:text-gray-100 truncate transition-colors">{recipe.name}</p>
          {recipe.summary && <p className="text-xs text-gray-600 leading-snug line-clamp-2 mt-0.5">{recipe.summary}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-auto pt-1">
        {recipe.category && <span className="text-xs text-gray-500 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5">{recipe.category}</span>}
        <span className="text-xs text-gray-600">{recipe.roles?.length || 0}-role crew</span>
        <span className="ml-auto text-xs text-blue-400/0 group-hover:text-blue-400 transition-colors flex items-center gap-1"><Plus size={11} /> Found</span>
      </div>
    </button>
  );
}

// Unrouted tray — incoming work no colony owns. Nothing silently disappears:
// the operator routes each item to a colony or dismisses it explicitly.
export function UnroutedTray({ items, teams, onRoute, onDismiss }) {
  const [targets, setTargets] = useState({}); // itemId -> teamId
  if (!items?.length) return null;
  return (
    <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Inbox size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-amber-200">Unrouted work</span>
        <span className="text-xs text-gray-600">— incoming items no colony owns yet; route or dismiss them</span>
      </div>
      <div className="flex flex-col divide-y divide-gray-800/60">
        {items.map(item => (
          <div key={item.id} className="flex items-center gap-2.5 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-200 truncate">
                {item.title}
                {item.board_card?.number && <span className="text-gray-500"> #{item.board_card.number}</span>}
              </p>
              <p className="text-xs text-gray-600 truncate">
                {item.source}{item.board_card?.repo ? ` · ${item.board_card.repo}` : ''}{item.match_reason ? ` · ${item.match_reason}` : ''}
              </p>
            </div>
            <select
              value={targets[item.id] || ''}
              onChange={e => setTargets(prev => ({ ...prev, [item.id]: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[11rem]"
            >
              <option value="">Route to…</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <Button size="sm" variant="secondary" disabled={!targets[item.id]} onClick={() => onRoute(item, targets[item.id])}>
              <ArrowRight size={11} /> Route
            </Button>
            <button onClick={() => onDismiss(item)} className="p-1.5 text-gray-700 hover:text-red-400 transition flex-shrink-0" title="Dismiss this item">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PerformanceStrip({ performance }) {
  if (!performance) return null;
  const s = performance.by_status || {};
  const pct = performance.success_rate != null ? Math.round(performance.success_rate * 100) : null;
  const cells = [
    { label: 'Runs', value: performance.total_runs || 0, Icon: Zap, tint: 'text-blue-400', chip: 'bg-blue-500/10 border-blue-500/20' },
    { label: 'Success', value: pct != null ? `${pct}%` : '—', Icon: ShieldCheck, tint: 'text-green-400', chip: 'bg-green-500/10 border-green-500/20', bar: pct },
    { label: 'Avg duration', value: fmtDuration(performance.avg_duration_secs), Icon: Clock, tint: 'text-purple-300', chip: 'bg-purple-500/10 border-purple-500/20' },
    { label: 'Done', value: s.done || 0, Icon: CheckCircle2, tint: 'text-green-400', chip: 'bg-green-500/10 border-green-500/20' },
    { label: 'Errors', value: s.error || 0, Icon: XCircle, tint: s.error ? 'text-red-400' : 'text-gray-600', chip: s.error ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-800/40 border-gray-800' },
    { label: 'Stopped', value: s.stopped || 0, Icon: Square, tint: 'text-gray-400', chip: 'bg-gray-800/40 border-gray-800' },
  ];
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        <BarChart3 size={13} className="text-blue-400/70" />
        <span className="text-xs font-semibold text-gray-300">Performance</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
        {cells.map(c => (
          <div key={c.label} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-3 py-2.5 flex items-center gap-2.5">
            <span className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${c.chip}`}>
              <c.Icon size={14} className={c.tint} />
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-base font-semibold leading-tight tabular-nums ${c.tint}`}>{c.value}</p>
              <p className="text-xs text-gray-600 truncate">{c.label}</p>
              {c.bar != null && (
                <div className="mt-1 h-1 rounded-full bg-gray-800 overflow-hidden">
                  <div className="h-full rounded-full bg-green-500/70" style={{ width: `${c.bar}%` }} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shared colony memory — durable knowledge the operator distills after each
// run. Editable here; injected into the operator and every worker on launch.
export function ColonyMemoryPanel({ memory, onSave }) {
  const [draft, setDraft] = useState(memory || '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  // Re-sync when the server-side memory changes (e.g. operator updated it
  // after a run) — but only if the user has no unsaved edits. Render-time
  // derived-state pattern (no effect, no cascading render).
  const [lastServer, setLastServer] = useState(memory || '');
  if ((memory || '') !== lastServer) {
    if (draft === lastServer) setDraft(memory || '');
    setLastServer(memory || '');
  }

  const dirty = draft !== (memory || '');
  const save = async () => {
    setSaving(true);
    setStatus('');
    try {
      await onSave(draft);
      setStatus('Saved');
    } catch (e) {
      setStatus(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <FileText size={13} className="text-purple-400/80" />
        <span className="text-xs font-semibold text-gray-300">Colony memory</span>
        <span className="text-xs text-gray-600">— operator appends lessons after each run</span>
        <div className="ml-auto flex items-center gap-2">
          {status && <span className={`text-xs ${status === 'Saved' ? 'text-green-400' : 'text-red-400'}`}>{status}</span>}
          <Button size="sm" variant="secondary" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={e => { setDraft(e.target.value); setStatus(''); }}
        rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
        placeholder={'Nothing remembered yet. Add standing knowledge for the team (conventions, gotchas, decisions) — the operator will append run lessons below it.'}
        className="w-full bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
      />
    </div>
  );
}

const INSIGHT_META = {
  workaround: { label: 'Workaround', cls: 'border-amber-700/50 text-amber-300' },
  acceptance_fail: { label: 'Acceptance fail', cls: 'border-red-800/50 text-red-300' },
  blocker: { label: 'Blocker', cls: 'border-orange-800/50 text-orange-300' },
};

// Cross-run insights — operator improvement reports, failed acceptance
// criteria, and blockers aggregated across the colony's whole run history.
export function InsightsPanel({ insights }) {
  if (!insights?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <AlertTriangle size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-gray-300">Insights</span>
        <span className="text-xs text-gray-600">— issues & improvement reports across runs</span>
      </div>
      <div className="flex flex-col gap-2">
        {insights.map((ins, i) => {
          const meta = INSIGHT_META[ins.type] || { label: ins.type, cls: 'border-gray-700 text-gray-400' };
          return (
            <div key={`${ins.run_id}-${ins.type}-${i}`} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-xs border rounded px-1.5 py-0.5 flex-shrink-0 ${meta.cls}`}>{meta.label}</span>
                <span className="text-xs text-gray-600 truncate flex-1">{runLabel(ins)}</span>
                <span className="text-xs text-gray-700 flex-shrink-0">{formatDate(ins.created_at * 1000)}</span>
              </div>
              <p className="text-xs text-gray-300 leading-snug">{ins.issue}</p>
              {ins.recommendation && (
                <p className="text-xs text-gray-500 leading-snug mt-0.5"><span className="text-gray-600">Improve:</span> {ins.recommendation}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Read-only viewer for a run artifact (file content served from the run repo).
// Callers key this component on runId+path so changing artifacts remounts it —
// the effect only ever fetches once per mount (no state resets needed).
export function ArtifactViewerModal({ runId, path, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const rawUrl = api.colonyArtifactRawUrl(runId, path);
  const mediaUrl = useAuthenticatedUrl(data?.binary ? rawUrl : '');
  useEffect(() => {
    let cancelled = false;
    api.getColonyArtifact(runId, path)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [runId, path]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] rounded-xl border border-gray-800 bg-gray-950 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <FileText size={14} className="text-gray-500 flex-shrink-0" />
          <span className="text-xs font-mono text-gray-200 truncate flex-1">{path === '__report__' ? 'Full report' : path}</span>
          {data?.source && data.source !== 'report' && <span className="text-xs text-blue-300/80 border border-blue-900/40 bg-blue-950/30 rounded px-1.5 py-0.5 flex-shrink-0" title="This file is not in the working tree — it was read from the run's git branch">{data.source}</span>}
          {data?.truncated && <span className="text-xs text-amber-400 flex-shrink-0">truncated</span>}
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300 flex-shrink-0"><X size={15} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {error ? (
            <p className="text-xs text-amber-300 leading-relaxed">{error}</p>
          ) : !data ? (
            <div className="flex items-center gap-2 text-gray-600 justify-center py-6"><Loader2 size={14} className="animate-spin" /><span className="text-xs">Loading…</span></div>
          ) : data.binary ? (
            data.mime?.startsWith('image/') ? (
              <img src={mediaUrl} alt={path} className="max-w-full mx-auto rounded" />
            ) : data.mime?.startsWith('audio/') ? (
              <audio controls src={mediaUrl} className="w-full" />
            ) : data.mime?.startsWith('video/') ? (
              <video controls src={mediaUrl} className="max-w-full mx-auto rounded" />
            ) : (
              <button type="button" onClick={() => downloadAuthenticated(api.colonyArtifactRawUrl(runId, path, { download: true }), path)} className="inline-flex items-center gap-1.5 text-sm text-blue-300 hover:underline">
                <FileText size={14} /> Download {path} ({Math.round((data.size || 0) / 1024)} KB)
              </button>
            )
          ) : (path === '__report__' || /\.(md|markdown)$/i.test(path)) ? (
            <div className="text-sm text-gray-300"><AgentMarkdown>{data.content}</AgentMarkdown></div>
          ) : (
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed">{data.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArtifactsPanel({ artifacts, onOpenArtifact, onDeleteRun }) {
  if (!artifacts?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Package size={13} className="text-green-400/70" />
        <span className="text-xs font-semibold text-gray-300">Artifacts</span>
        <span className="text-xs text-gray-600">— from all runs; click a file to open it</span>
      </div>
      <div className="flex flex-col gap-2">
        {artifacts.map(a => (
          <div key={a.run_id} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2 group">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-gray-400 truncate flex-1">{runLabel(a)}</span>
              <span className="text-xs text-gray-600 flex-shrink-0">{formatDate(a.created_at * 1000)}</span>
              {onDeleteRun && (
                <button
                  type="button"
                  onClick={() => onDeleteRun(a.run_id)}
                  className="p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition flex-shrink-0"
                  title="Delete this run and its artifacts"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            {a.links?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {a.links.map((l, i) => (
                  isSafeUrl(l)
                    ? <a key={i} href={l} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline truncate max-w-xs">
                        <ExternalLink size={10} className="flex-shrink-0" /> {l}
                      </a>
                    : <span key={i} className="flex items-center gap-1 text-xs text-gray-400 truncate max-w-xs">
                        <ExternalLink size={10} className="flex-shrink-0" /> {l}
                      </span>
                ))}
              </div>
            )}
            {a.files?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {a.files.map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onOpenArtifact(a.run_id, f)}
                    className="text-xs text-blue-300/90 hover:text-blue-200 hover:underline font-mono truncate max-w-xs text-left"
                    title="Open this artifact"
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
            {a.report && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => onOpenArtifact(a.run_id, '__report__')}
                  className="inline-flex items-center gap-1 text-xs text-green-300/90 hover:text-green-200 hover:underline"
                  title="Open the full report"
                >
                  <FileText size={10} className="flex-shrink-0" /> Full report
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Colonies-first team room panels ───────────────────────────────────────────

// Crew — the colony's identity leads the page. Staff profiles for the team's
// recipe, rendered as initials avatars (there is no shared avatar component).
export function CrewPanel({ crew, recipeName }) {
  if (!crew?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Users size={13} className="text-blue-400/70" />
        <span className="text-xs font-semibold text-gray-300">Crew</span>
        <span className="text-xs text-gray-600">— {recipeName || 'team'} · staffed by the operator at run start</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {crew.map(member => {
          const initials = String(member.display_name || member.role || '?')
            .split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
          const color = member.avatar_color || '#60a5fa';
          return (
            <div key={member.id || member.role_key} className="flex items-center gap-2.5 rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2">
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
                style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
              >
                {initials}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-200 truncate">{member.display_name || member.role}</p>
                <p className="text-xs text-gray-600 truncate">{member.role}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One row of the colony's work queue.
function WorkItemRow({ item, onAccept, onDismiss, onDelete, onStart, onOpenRun, busy }) {
  const meta = ITEM_STATUS_META[item.status] || ITEM_STATUS_META.queued;
  return (
    <div className="flex items-center gap-2.5 py-2 group">
      <span className={`text-xs border rounded px-1.5 py-0.5 flex-shrink-0 ${meta.chip}`}>{meta.label}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-200 truncate">
          {item.title}
          {item.board_card?.number && <span className="text-gray-500"> #{item.board_card.number}</span>}
        </p>
        <p className="text-xs text-gray-600 truncate">
          {item.source}
          {item.status === 'proposed' && item.match_reason ? ` · ${item.match_reason}` : ''}
          {item.direction ? ` · ${item.direction.split('\n')[0]}` : ''}
        </p>
      </div>
      {item.status === 'proposed' && (
        <>
          <Button size="sm" variant="secondary" onClick={() => onAccept(item)}><CheckCircle2 size={11} /> Accept</Button>
          <Button size="sm" variant="ghost" className="text-gray-500" onClick={() => onDismiss(item)}>Dismiss</Button>
        </>
      )}
      {item.status === 'queued' && (
        <>
          <Button size="sm" onClick={() => onStart(item)} disabled={busy} title="Collect direction + models, then launch">
            <Play size={11} /> Start
          </Button>
          <button onClick={() => onDelete(item)} className="p-1.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition flex-shrink-0" title="Remove from queue">
            <Trash2 size={13} />
          </button>
        </>
      )}
      {item.status === 'claimed' && item.run_id && (
        <Button size="sm" variant="secondary" onClick={() => onOpenRun(item.run_id)}>
          <Loader2 size={11} className="animate-spin" /> View run
        </Button>
      )}
    </div>
  );
}

// Work — the colony's queue plus the "give them work" affordance. Replaces the
// old "Launch a run" panel: adding work is queueing; launching is the Start
// step on a queued item.
export function WorkQueuePanel({
  queue, activeColonyId,
  giveWorkOpen, setGiveWorkOpen, addingWork, onAddWork,
  goal, setGoal, projectBoard, selectedBoardCard, selectedBoardCardId, setSelectedBoardCardId,
  boardSearch, setBoardSearch, visibleBoardCards,
  onAccept, onDismiss, onDelete, onStart, onOpenRun, onQueueCard,
}) {
  const open = (queue || []).filter(i => ['proposed', 'queued', 'claimed'].includes(i.status));
  const order = { proposed: 0, queued: 1, claimed: 2 };
  const sorted = [...open].sort((a, b) => (order[a.status] - order[b.status]) || (a.created_at - b.created_at));

  // Idle-colony nudge: an empty queue suggests open board work instead of a
  // blank panel. Cards already queued (by board card id) are filtered out.
  const queuedCardIds = new Set(open.map(i => i.board_card?.id).filter(Boolean));
  const suggestions = open.length === 0
    ? (projectBoard?.cards || []).filter(c => c.status !== 'done' && !queuedCardIds.has(c.id)).slice(0, 3)
    : [];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <ListTodo size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-gray-300">Work</span>
        <span className="text-xs text-gray-600">({open.length} open)</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setGiveWorkOpen(v => !v)}>
          <Plus size={12} /> Give them work
        </Button>
      </div>

      {giveWorkOpen && (
        <div className="rounded-lg border border-gray-800 bg-gray-950/30 px-3 py-3 flex flex-col gap-3">
          {projectBoard?.configured && (projectBoard.cards || []).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">Work item from the board (optional)</span>
                {selectedBoardCard && (
                  <button type="button" onClick={() => setSelectedBoardCardId(null)} className="text-xs text-gray-500 hover:text-gray-300">unlink</button>
                )}
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-2.5 text-gray-600" />
                <input
                  value={boardSearch}
                  onChange={e => setBoardSearch(e.target.value)}
                  placeholder="Search issues and board tasks"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
                />
              </div>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
                {visibleBoardCards.map(card => {
                  const selected = selectedBoardCardId === card.id;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setSelectedBoardCardId(selected ? null : card.id)}
                      className={`w-full text-left px-3 py-2 transition-colors ${selected ? 'bg-blue-950/30' : 'bg-gray-900/40 hover:bg-gray-800/50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <Link2 size={12} className={selected ? 'text-blue-300' : 'text-gray-600'} />
                        <span className="text-xs font-medium text-gray-200 truncate flex-1">{card.title}</span>
                        {card.number && <span className="text-xs text-gray-500">#{card.number}</span>}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-600">
                        <span>{card.status_label || card.status || 'backlog'}</span>
                        {card.url && <span className="truncate">{card.url}</span>}
                      </div>
                    </button>
                  );
                })}
                {visibleBoardCards.length === 0 && (
                  <div className="px-3 py-3 text-xs text-gray-600 text-center">No matching work items</div>
                )}
              </div>
            </div>
          )}
          {!projectBoard?.configured && (
            <p className="text-xs text-amber-400/80">{projectBoard?.error || 'No repository configured — edit the colony to set one.'}</p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-gray-400">Direction</span>
            <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2}
              placeholder={selectedBoardCard ? 'Optional notes for the selected work item…' : 'Describe what the team should work on…'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
          </div>

          <Button onClick={onAddWork} disabled={(!goal.trim() && !selectedBoardCard) || addingWork}>
            {addingWork ? <><Loader2 size={13} className="animate-spin" /> Adding…</> : <><Plus size={13} /> Add to queue</>}
          </Button>
        </div>
      )}

      {sorted.length > 0 ? (
        <div className="flex flex-col divide-y divide-gray-800/60">
          {sorted.map(item => (
            <WorkItemRow
              key={item.id}
              item={item}
              busy={!!activeColonyId}
              onAccept={onAccept}
              onDismiss={onDismiss}
              onDelete={onDelete}
              onStart={onStart}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      ) : (
        <div className="py-2">
          <p className="text-xs text-gray-600">The queue is empty — this colony is ready for work.</p>
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-500">Suggested from the board</span>
              {suggestions.map(card => (
                <div key={card.id} className="flex items-center gap-2 rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-1.5">
                  <Link2 size={11} className="text-gray-600 flex-shrink-0" />
                  <span className="text-xs text-gray-300 truncate flex-1">{card.title}{card.number ? ` #${card.number}` : ''}</span>
                  <Button size="sm" variant="ghost" className="text-blue-400" onClick={() => onQueueCard(card)}>
                    <Plus size={11} /> Queue
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Start step — a queued item becomes a run. Collects/edits the direction and
// the model plan (the inputs that used to live on the launch form), then
// launches through the queue start endpoint.
export function StartRunModal({
  team, recipe,
  item, direction, setDirection,
  model, setModel, models, groupedModels, cloudEnabled,
  modelPlan, setModelPlan, crew, proposing, onProposeModels,
  advancedOpen, setAdvancedOpen,
  launching, error, activeColonyId, onStart, onClose,
}) {
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  if (!item) return null;
  const card = item.board_card;
  const publishEnabled = !!team?.github_publish;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-5 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-100">Start this work</p>
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300"><X size={15} /></button>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
          <p className="text-xs font-medium text-gray-200">
            {item.title}
            {card?.number && <span className="text-gray-500"> #{card.number}</span>}
          </p>
          <p className="text-xs text-gray-600 mt-0.5 truncate">
            {card?.repo || item.source}
            {card?.labels?.length ? ` · ${card.labels.join(', ')}` : ''}
          </p>
        </div>

        <div className={`rounded-lg border px-3 py-2.5 ${publishEnabled ? 'border-amber-800/50 bg-amber-950/20' : 'border-blue-900/40 bg-blue-950/15'}`}>
          <p className="text-xs font-medium text-gray-200">
            Execution policy: {recipe?.execution_policy?.mode === 'read_only' ? 'Read-only review' : recipe?.execution_policy?.mode === 'artifact_only' ? 'Artifacts only' : 'Repository delivery'}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {team?.github_review ? 'The final report may be posted to the original PR. ' : ''}
            {publishEnabled ? 'This successful run may commit, push, and open a Draft PR.' : 'This run cannot publish repository changes.'}
          </p>
          {publishEnabled && (
            <label className="flex items-start gap-2 mt-2 text-xs text-amber-200/80 cursor-pointer">
              <input type="checkbox" checked={publishConfirmed} onChange={e => setPublishConfirmed(e.target.checked)} className="mt-0.5" />
              <span>I understand this run may publish intentional repository changes. Failed or stopped runs will not publish.</span>
            </label>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Direction</span>
          <textarea value={direction} onChange={e => setDirection(e.target.value)} rows={3} autoFocus
            placeholder={card ? 'Optional notes for the work item…' : 'Describe what the team should do…'}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Colony lead / base model</span>
          <select value={model} onChange={e => setModel(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
            {Object.entries(groupedModels).map(([prov, list]) => {
              // tools === false → the model can't drive colony agents; hide it here.
              const opts = (Array.isArray(list) ? list : []).filter(m => (cloudEnabled || (m.provider || prov) === 'ollama') && m.tools !== false);
              if (opts.length === 0) return null;
              return <optgroup key={prov} label={PROVIDER_LABEL[prov] || prov}>{opts.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</optgroup>;
            })}
          </select>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-950/30">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="queue-start-advanced"
            onClick={() => setAdvancedOpen(v => !v)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/40 transition-colors"
          >
            <div>
              <p className="text-xs font-medium text-gray-300">Per-role model plan</p>
              <p className="text-xs text-gray-600 mt-0.5">{modelPlan ? 'Plan set — expand to edit' : 'Optional: assign a model to each role'}</p>
            </div>
            <ChevronRight size={13} className={`text-gray-500 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
          </button>
          {advancedOpen && (
            <div id="queue-start-advanced" className="border-t border-gray-800 px-3 py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-400">Model plan</span>
                <button type="button" onClick={onProposeModels} disabled={proposing} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 disabled:opacity-50">
                  {proposing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {modelPlan ? 'Re-propose plan' : 'Generate model plan'}
                </button>
              </div>
              {modelPlan && crew?.length > 0 && (
                <div className="rounded-lg border border-gray-800 overflow-hidden">
                  {[{ role_key: 'operator', display_name: 'Ari Morgan', role: 'Orchestrator' }, ...crew].map(member => (
                    <div key={member.role_key} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60 last:border-0">
                      <span className="flex flex-col w-40 flex-shrink-0 min-w-0" title={`${member.role || member.role_key}${member.display_name ? ` — ${member.display_name}` : ''}`}>
                        <span className="text-xs text-gray-300 truncate">{member.role || member.role_key}</span>
                        {member.display_name && member.display_name !== (member.role || '') && (
                          <span className="text-[10px] text-gray-500 truncate">{member.display_name}</span>
                        )}
                      </span>
                      <select value={modelPlan[member.role_key] || ''} onChange={e => setModelPlan(p => ({ ...p, [member.role_key]: e.target.value }))} className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={onStart} disabled={!model || launching || !!activeColonyId || (publishEnabled && !publishConfirmed)} className="flex-1">
            {launching ? <><Loader2 size={13} className="animate-spin" /> Starting…</>
              : activeColonyId ? <><Loader2 size={13} className="animate-spin" /> A run is in progress…</>
              : <><Zap size={13} /> Start run</>}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
