import { Wand2, MessageSquare } from 'lucide-react';
import { Button } from '../ui/Button';
import { HiveMark } from '../ui/HiveMark';
import { modelBadge } from '../../lib/modelLabels';
import { useCreateStarterAgent } from './useCreateStarterAgent';

// Compact CTA banner shown on first-run surfaces (Models page, post-pull)
// when a usable model exists but no agent does (issue #2).
export function StarterAgentBanner({ modelId, onCustomize, title }) {
  const { create, creating } = useCreateStarterAgent();
  if (!modelId) return null;
  const badge = modelBadge(modelId);

  return (
    <div className="p-4 bg-blue-500/5 border border-blue-500/30 rounded-xl flex flex-wrap items-center gap-3">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 shadow-sm shadow-amber-950/40">
        <HiveMark size={36} title="" />
      </div>
      <div className="flex-1 min-w-48">
        <p className="text-sm font-medium text-gray-200">{title || 'Model ready — create your first agent'}</p>
        <p className="text-xs text-gray-500 mt-0.5">
          One click sets up a starter agent on{' '}
          <span className="font-mono text-gray-400" title={badge.title}>{badge.text}</span>{' '}
          and takes you straight to chat.
        </p>
      </div>
      <div className="flex gap-2 shrink-0">
        {onCustomize && (
          <Button size="sm" variant="secondary" onClick={onCustomize} disabled={creating} title="Open the agent editor prefilled with this model">
            <Wand2 size={13} /> Customize
          </Button>
        )}
        <Button size="sm" onClick={() => create(modelId)} disabled={creating}>
          <MessageSquare size={13} /> {creating ? 'Creating…' : 'Create starter agent'}
        </Button>
      </div>
    </div>
  );
}
