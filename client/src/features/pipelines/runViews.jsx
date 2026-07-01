// Extracted from PipelinesPage (#23).
import { useState } from 'react';
import { Play, CheckCircle, XCircle, Loader, Clock, ArrowDown, Copy, Check, GitMerge } from 'lucide-react';

export function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="p-1 text-gray-500 hover:text-gray-300 rounded transition-colors"
      title="Copy"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  );
}

// ── Step trace card ───────────────────────────────────────────────────────────
export function StepCard({ entry, onRetry }) {
  const isPending = entry.status === 'pending';
  const isError   = entry.status === 'error';
  const isStopped = entry.status === 'stopped';
  const isDone    = entry.status === 'done';

  return (
    <div className={`p-4 rounded-lg border transition-colors flex-1 min-w-0 ${isError ? 'border-red-700/40 bg-red-500/5' : isStopped ? 'border-yellow-700/40 bg-yellow-500/5' : isDone ? 'border-gray-700 bg-gray-800/40' : 'border-blue-700/30 bg-blue-500/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        {isPending && <Loader size={14} className="text-blue-400 animate-spin flex-shrink-0" />}
        {isDone    && <CheckCircle size={14} className="text-green-400 flex-shrink-0" />}
        {isError   && <XCircle size={14} className="text-red-400 flex-shrink-0" />}
        {isStopped && <XCircle size={14} className="text-yellow-400 flex-shrink-0" />}
        <span className="text-sm font-medium text-gray-200 truncate">{entry.label}</span>
        <span className="text-xs text-gray-500 flex-shrink-0">→ {entry.agent_name}</span>
        {entry.duration_ms != null && (
          <span className="text-xs text-gray-600 ml-auto flex-shrink-0 flex items-center gap-1">
            <Clock size={10} />{(entry.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {isPending && <p className="text-xs text-blue-400 animate-pulse">Running…</p>}
      {(isError || isStopped) && (
        <div className="flex items-start justify-between gap-2">
          <p className={`text-sm ${isStopped ? 'text-yellow-300' : 'text-red-400'}`}>{entry.error}</p>
          {isError && onRetry && (
            <button
              onClick={onRetry}
              className="flex-shrink-0 flex items-center gap-1 text-xs px-2 py-1 rounded border border-yellow-600/40 bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 transition-colors"
            >
              <Play size={10} /> Retry
            </button>
          )}
        </div>
      )}
      {isDone && (
        <div className="relative group">
          <p className="text-sm text-gray-300 whitespace-pre-wrap pr-6">{entry.output}</p>
          <div className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <CopyBtn text={entry.output} />
          </div>
        </div>
      )}
    </div>
  );
}

// Groups steps by their group index and renders sequential/parallel accordingly
export function StepTrace({ entry, index }) {
  return (
    <div className="flex flex-col gap-2">
      {index > 0 && <div className="flex justify-center"><ArrowDown size={14} className="text-gray-700" /></div>}
      <StepCard entry={entry} />
    </div>
  );
}

// Renders a parallel group side-by-side
export function ParallelGroupTrace({ entries, showArrowAbove, onRetry }) {
  return (
    <div className="flex flex-col gap-2">
      {showArrowAbove && (
        <div className="flex justify-center items-center gap-1">
          <GitMerge size={12} className="text-purple-600" />
          <span className="text-xs text-purple-600/70">parallel</span>
        </div>
      )}
      <div className="flex gap-2">
        {entries.map(entry => (
          <StepCard
            key={entry.step}
            entry={entry}
            onRetry={onRetry ? () => onRetry(entry) : null}
          />
        ))}
      </div>
    </div>
  );
}
