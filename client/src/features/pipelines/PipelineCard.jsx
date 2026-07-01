// Extracted from PipelinesPage (#23).
import { Play, Trash2, Edit2, ChevronRight, History, GitMerge } from 'lucide-react';
import { Button } from '../../components/ui/Button';

export function PipelineCard({ pipeline, agents, onEdit, onDelete, onRun, onHistory }) {
  const stepAgents = (pipeline.steps || [])
    .map(s => agents.find(a => a.id === s.agent_id)?.name || s.agent_id)
    .filter(Boolean);

  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 flex flex-col gap-3 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-100">{pipeline.name}</h3>
          {pipeline.description && <p className="text-sm text-gray-500 mt-0.5">{pipeline.description}</p>}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {pipeline.steps?.some(s => s.parallel) && (
            <span className="flex items-center gap-0.5 text-xs text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded px-1.5 py-0.5">
              <GitMerge size={10} /> parallel
            </span>
          )}
          <span className="text-xs text-gray-600">{pipeline.steps?.length || 0} steps</span>
        </div>
      </div>

      {stepAgents.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {stepAgents.map((name, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300">{name}</span>
              {i < stepAgents.length - 1 && <ChevronRight size={10} className="text-gray-600" />}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-1">
        <Button size="sm" className="flex-1" onClick={() => onRun(pipeline)}>
          <Play size={13} /> Run
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onHistory(pipeline)} title="Run history">
          <History size={14} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onEdit(pipeline)} title="Edit">
          <Edit2 size={14} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onDelete(pipeline)} title="Delete">
          <Trash2 size={14} className="text-red-400" />
        </Button>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

