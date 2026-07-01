// Pipelines page — composition + top-level state. Presentational pieces,
// editors, the run modal, and history live under ../features/pipelines/ (#23).
import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { DeleteConfirm } from '../components/agents/DeleteConfirm';
import { toast } from '../stores/toastStore';
import { useAgentStore } from '../stores/agentStore';
import { PIPELINE_TEMPLATES } from '../features/pipelines/templates';
import { PipelineEditor } from '../features/pipelines/PipelineEditor';
import { RunModal } from '../features/pipelines/RunModal';
import { HistoryDrawer } from '../features/pipelines/HistoryDrawer';
import { PipelineCard } from '../features/pipelines/PipelineCard';

// Re-exported for WebhooksPage (which opens a pipeline run modal).
export { RunModal } from '../features/pipelines/RunModal';

export function PipelinesPage() {
  const { agents, fetchAgents } = useAgentStore();
  const [pipelines, setPipelines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editorTemplate, setEditorTemplate] = useState(null);
  const [runTarget, setRunTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [historyTarget, setHistoryTarget] = useState(null);

  useEffect(() => { fetchAgents(); }, []);

  const load = () => {
    setLoading(true);
    api.getPipelines().then(setPipelines).catch(() => setPipelines([])).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const handleEditorClose = (saved) => { setEditorOpen(false); setEditing(null); setEditorTemplate(null); if (saved) load(); };
  const handleEdit = (p) => { setEditing(p); setEditorTemplate(null); setEditorOpen(true); };
  const openWithTemplate = (tpl) => { setEditing(null); setEditorTemplate(tpl); setEditorOpen(true); };
  const handleDelete = async () => {
    await api.deletePipeline(deleteTarget.id);
    toast.success('Pipeline deleted');
    load();
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Pipelines</h1>
          <p className="text-sm text-gray-500 mt-0.5">Chain agents together for multi-step tasks</p>
        </div>
        <Button onClick={() => { setEditing(null); setEditorOpen(true); }}>
          <Plus size={16} /> New Pipeline
        </Button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
      ) : pipelines.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-6xl mb-4">⛓️</div>
          <h2 className="text-lg font-semibold text-gray-300">No pipelines yet</h2>
          <p className="text-sm text-gray-500 mt-1 mb-6">Start from scratch or pick a template</p>
          <div className="flex gap-3 justify-center flex-wrap mb-8">
            <Button onClick={() => { setEditing(null); setEditorTemplate(null); setEditorOpen(true); }}><Plus size={16} /> Blank Pipeline</Button>
          </div>
          <p className="text-xs text-gray-600 mb-3 uppercase tracking-wider">Or start with a template</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-2xl mx-auto text-left">
            {PIPELINE_TEMPLATES.map(tpl => (
              <button
                key={tpl.name}
                onClick={() => openWithTemplate(tpl)}
                className="p-3 rounded-lg border border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors text-left"
              >
                <p className="text-sm font-medium text-gray-200">{tpl.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">{tpl.description}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {pipelines.map(p => (
            <PipelineCard
              key={p.id}
              pipeline={p}
              agents={agents}
              onEdit={handleEdit}
              onDelete={setDeleteTarget}
              onRun={setRunTarget}
              onHistory={setHistoryTarget}
            />
          ))}
        </div>
      )}

      <PipelineEditor open={editorOpen} onClose={handleEditorClose} pipeline={editing} initialTemplate={editorTemplate} />
      <RunModal open={!!runTarget} onClose={() => setRunTarget(null)} pipeline={runTarget} />
      <HistoryDrawer pipeline={historyTarget} onClose={() => setHistoryTarget(null)} />
      <DeleteConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        itemName={deleteTarget?.name || ''}
        itemType="pipeline"
      />
    </div>
  );
}
