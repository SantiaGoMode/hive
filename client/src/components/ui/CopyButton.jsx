import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// Shared copy-to-clipboard icon button (replaces the bespoke CopyBtn copies
// that lived in pipelines/runViews, HistoryDrawer, and SchedulesPage).
export function CopyButton({ text, size = 12, title = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className={`p-1 text-gray-500 hover:text-gray-300 rounded transition-colors ${className}`}
      title={title}
      aria-label={title}
    >
      {copied ? <Check size={size} className="text-green-400" /> : <Copy size={size} />}
    </button>
  );
}
