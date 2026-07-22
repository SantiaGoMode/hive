// Extracted from PipelinesPage (#23).
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Loader, ArrowDown, History, X, ChevronDown, ChevronUp, GitMerge, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { groupStepEntries } from '../../components/pipelines/pipelineRunUtils';
import { CopyButton } from '../../components/ui/CopyButton';
import { MarkdownContent } from '../../components/MarkdownContent';

export function RunHistoryRow({ run }) {
  const [expanded, setExpanded] = useState(false);
  const isOk = run.status === 'done';
  const isStopped = run.status === 'stopped' || run.status === 'running';
  const fmtDate = (unix) => new Date(unix * 1000).toLocaleString();

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-800/50 transition-colors text-left"
        onClick={() => setExpanded(e => !e)}
      >
        {isOk
          ? <CheckCircle size={14} className="text-green-400 flex-shrink-0" />
          : isStopped
            ? <XCircle size={14} className="text-yellow-500 flex-shrink-0" />
            : <XCircle size={14} className="text-red-400 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-300 truncate">{run.input}</p>
          <p className="text-xs text-gray-600 mt-0.5">{fmtDate(run.ran_at)} · {run.trace.length} steps{run.total_ms ? ` · ${(run.total_ms / 1000).toFixed(1)}s` : ''}</p>
        </div>
        {expanded ? <ChevronUp size={13} className="text-gray-600 flex-shrink-0" /> : <ChevronDown size={13} className="text-gray-600 flex-shrink-0" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-800 space-y-3 pt-3 bg-[#0f1117]">
          {[...groupStepEntries(run.trace)].map(([groupIdx, entries], i) => {
            const isParallel = entries.length > 1;
            return (
              <div key={groupIdx} className="flex flex-col gap-1">
                {i > 0 && (
                  <div className="flex justify-center items-center gap-1">
                    {isParallel
                      ? <><GitMerge size={11} className="text-purple-600" /><span className="text-xs text-purple-600/70">parallel</span></>
                      : <ArrowDown size={12} className="text-gray-700" />}
                  </div>
                )}
                <div className={`flex gap-2 ${!isParallel ? 'flex-col' : ''}`}>
                  {entries.map((entry) => (
                    <div key={entry.step} className={`p-3 rounded-lg border text-sm flex-1 min-w-0 ${entry.status === 'error' ? 'border-red-800/40 bg-red-500/5' : 'border-gray-700 bg-gray-800/40'}`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        {entry.status === 'done'
                          ? <CheckCircle size={12} className="text-green-400 flex-shrink-0" />
                          : <XCircle size={12} className="text-red-400 flex-shrink-0" />}
                        <span className="font-medium text-gray-200 text-xs truncate">{entry.label}</span>
                        <span className="text-xs text-gray-500 flex-shrink-0">→ {entry.agent_name}</span>
                        {entry.duration_ms != null && (
                          <span className="ml-auto text-xs text-gray-600 flex-shrink-0">{(entry.duration_ms / 1000).toFixed(1)}s</span>
                        )}
                      </div>
                      {entry.status === 'error'
                        ? <p className="text-xs text-red-400 whitespace-pre-wrap">{entry.error}</p>
                        : <div className="max-h-48 overflow-y-auto bg-gray-900/60 rounded-md p-2 mt-1 border border-gray-700/50 text-xs">
                            {entry.thinking && (
                              <p className="text-[11px] text-purple-400/70 mb-1.5 whitespace-pre-wrap border-b border-gray-800 pb-1.5">{entry.thinking}</p>
                            )}
                            <MarkdownContent>{entry.output || ''}</MarkdownContent>
                          </div>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {run.final_output && (
            <div className="p-3 rounded-lg border border-blue-700/30 bg-blue-500/5">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs text-blue-400 font-semibold">Final Output</p>
                <CopyButton text={run.final_output} />
              </div>
              <div className="max-h-64 overflow-y-auto text-xs">
                <MarkdownContent>{run.final_output}</MarkdownContent>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryDrawer({ pipeline, onClose }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const loadRuns = useCallback(() => {
    if (!pipeline) return;
    setLoading(true);
    api.getPipelineRuns(pipeline.id)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [pipeline]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const handleClearHistory = async () => {
    if (!confirm('Clear all run history for this pipeline?')) return;
    setClearing(true);
    try {
      await api.clearPipelineRuns(pipeline.id);
      setRuns([]);
    } finally {
      setClearing(false);
    }
  };

  if (!pipeline) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#1a1d27] border-l border-gray-700 flex flex-col h-full shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 className="font-semibold text-gray-100">Run History</h2>
            <p className="text-xs text-gray-500 mt-0.5">{pipeline.name}</p>
          </div>
          <div className="flex items-center gap-2">
            {runs.length > 0 && (
              <button
                onClick={handleClearHistory}
                disabled={clearing}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                title="Clear all run history"
              >
                <RotateCcw size={11} />
                {clearing ? 'Clearing…' : 'Clear'}
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-100 rounded-lg hover:bg-gray-800">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="flex items-center justify-center h-24 text-gray-500">
              <Loader size={18} className="animate-spin" />
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-16 text-gray-600">
              <History size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No runs yet</p>
            </div>
          ) : (
            runs.map(r => <RunHistoryRow key={r.id} run={r} />)
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pipeline Card ─────────────────────────────────────────────────────────────
