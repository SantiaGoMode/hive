// Extracted from PipelinesPage (#23).
import { Trash2, GitMerge } from 'lucide-react';
import { Input, Textarea } from '../../components/ui/Input';
import { ToolPicker } from '../../components/ToolPicker';

export function StepEditor({ step, agents, mcpServers, onChange, onRemove, index }) {
  return (
    <div className={`flex flex-col gap-3 p-4 rounded-lg border bg-gray-800/40 ${step.parallel ? 'border-purple-700/50' : 'border-gray-700'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Step {index + 1}</span>
          {step.parallel && (
            <span className="flex items-center gap-1 text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded px-1.5 py-0.5">
              <GitMerge size={10} /> parallel
            </span>
          )}
        </div>
        <button onClick={onRemove} className="text-gray-600 hover:text-red-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>
      <Input
        label="Label"
        value={step.label || ''}
        onChange={e => onChange({ ...step, label: e.target.value })}
        placeholder={`Step ${index + 1}`}
      />
      <div>
        <label className="text-sm font-medium text-gray-300 block mb-1">Agent</label>
        <select
          value={step.agent_id || ''}
          onChange={e => onChange({ ...step, agent_id: e.target.value })}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">— Select agent —</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      <Textarea
        label="Prompt template"
        value={step.prompt || ''}
        onChange={e => onChange({ ...step, prompt: e.target.value })}
        placeholder="Use {prev} for previous step's output, {input} for the original user input"
        className="h-24 font-mono text-xs"
      />
      <p className="text-xs text-gray-600">Variables: <code className="text-gray-500">{'{prev}'}</code> = last output · <code className="text-gray-500">{'{input}'}</code> = original input</p>

      {/* Tool picker */}
      <div className="pt-2 border-t border-gray-700/50">
        <ToolPicker
          tools={step.tools || []}
          onChange={t => onChange({ ...step, tools: t })}
          mcpServers={mcpServers}
          overrideHint="These tools override the agent's configured tools for this step only."
        />
      </div>

      {/* Parallel toggle */}
      <div
        className="flex items-center justify-between pt-2 border-t border-gray-700/50 cursor-pointer select-none"
        onClick={() => onChange({ ...step, parallel: !step.parallel })}
      >
        <div>
          <p className="text-xs font-medium text-gray-300">Run in parallel</p>
          <p className="text-xs text-gray-600">Consecutive parallel steps run simultaneously via Promise.all</p>
        </div>
        <div className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors ${step.parallel ? 'bg-purple-600' : 'bg-gray-700'} relative`}>
          <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${step.parallel ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </div>
      </div>
    </div>
  );
}

