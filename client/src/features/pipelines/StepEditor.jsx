// Extracted from PipelinesPage (#23).
import { useState } from 'react';
import { Trash2, GitMerge, AlertCircle, Wrench, ChevronRight } from 'lucide-react';
import { Input, Textarea } from '../../components/ui/Input';
import { ToolPicker } from '../../components/ToolPicker';
import { ModelSelect } from '../../components/ui/ModelSelect';

function toolLabel(id, mcpServers) {
  if (id?.startsWith('mcp:')) {
    const server = mcpServers.find(s => `mcp:${s.id}` === id);
    return server?.name || id;
  }
  return id;
}

function AdvancedDisclosure({ id, title, summary, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pt-2 border-t border-gray-700/50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-gray-800/50 transition-colors"
      >
        <div>
          <p className="text-xs font-medium text-gray-300">{title}</p>
          {summary && <p className="text-xs text-gray-600 mt-0.5">{summary}</p>}
        </div>
        <ChevronRight size={13} className={`text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div id={id} className="mt-2 flex flex-col gap-3">
          {children}
        </div>
      )}
    </div>
  );
}

export function StepEditor({ step, agents, mcpServers, models = {}, onChange, onRemove, index, errors = {} }) {
  const selectedAgent = agents.find(agent => String(agent.id) === String(step.agent_id));
  const hasErrors = Object.keys(errors).length > 0;
  const tools = step.tools || [];

  return (
    <div className={`flex flex-col gap-3 p-4 rounded-lg border bg-gray-800/40 ${hasErrors ? 'border-red-700/50' : step.parallel ? 'border-purple-700/50' : 'border-gray-700'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Step {index + 1}</span>
          {step.parallel && (
            <span className="flex items-center gap-1 text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded px-1.5 py-0.5">
              <GitMerge size={10} /> parallel
            </span>
          )}
          {hasErrors && (
            <span className="flex items-center gap-1 text-xs bg-red-500/10 text-red-300 border border-red-500/20 rounded px-1.5 py-0.5">
              <AlertCircle size={10} /> needs attention
            </span>
          )}
        </div>
        <button type="button" onClick={onRemove} className="text-gray-600 hover:text-red-400 transition-colors" title="Remove step">
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
          className={`w-full bg-gray-800 border rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 ${errors.agent || errors.model ? 'border-red-500' : 'border-gray-700'}`}
        >
          <option value="">— Select agent —</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}{a.model ? ` · ${a.model}` : ' · no model'}</option>)}
        </select>
        {errors.agent && <p className="text-xs text-red-400 mt-1">{errors.agent}</p>}
        {errors.model && <p className="text-xs text-red-400 mt-1">{errors.model}</p>}
        {selectedAgent && !errors.model && (
          <p className="text-xs text-gray-600 mt-1">Model: <span className="text-gray-400">{selectedAgent.model || 'No model assigned'}</span></p>
        )}
      </div>
      <Textarea
        label="Prompt template"
        value={step.prompt || ''}
        onChange={e => onChange({ ...step, prompt: e.target.value })}
        placeholder="Use {prev} for previous step's output, {input} for the original user input"
        className="h-24 font-mono text-xs"
        error={errors.prompt}
      />
      <p className="text-xs text-gray-600">Variables: <code className="text-gray-500">{'{prev}'}</code> = last output · <code className="text-gray-500">{'{input}'}</code> = original input</p>

      <AdvancedDisclosure
        id={`pipeline-step-${index}-advanced`}
        title="Advanced step options"
        summary={`${tools.length} tool override${tools.length === 1 ? '' : 's'}${step.model ? ' · model override' : ''}${step.parallel ? ' · parallel enabled' : ''}`}
        defaultOpen={tools.length > 0 || !!step.model || !!step.parallel}
      >
        <ModelSelect
          label="Model override"
          value={step.model || ''}
          onChange={m => onChange({ ...step, model: m || undefined })}
          groupedModels={models}
          placeholder={`— Agent default${selectedAgent?.model ? ` (${selectedAgent.model})` : ''} —`}
          hint={<p className="text-xs text-gray-600">Run just this step on a different model — e.g. a gateway alias like <code className="text-gray-500">gateway/hive-coding</code> — without changing the agent.</p>}
        />

        <div>
          {tools.length > 0 && (
            <div className="mb-3 rounded-md border border-blue-700/30 bg-blue-500/5 p-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-blue-300">
                <Wrench size={11} />
                Step tool override
              </div>
              <p className="mt-1 text-xs text-gray-500">
                This step uses {tools.length} explicit tool{tools.length !== 1 ? 's' : ''}: {tools.map(id => toolLabel(id, mcpServers)).join(', ')}
              </p>
            </div>
          )}
          <ToolPicker
            tools={tools}
            onChange={t => onChange({ ...step, tools: t })}
            mcpServers={mcpServers}
            overrideHint="These tools override the agent's configured tools for this step only."
          />
        </div>

        <button
          type="button"
          className="flex w-full items-center justify-between rounded-lg border border-gray-700/50 px-3 py-2 text-left transition-colors hover:border-gray-600 select-none"
          onClick={() => onChange({ ...step, parallel: !step.parallel })}
          aria-pressed={!!step.parallel}
        >
          <div>
            <p className="text-xs font-medium text-gray-300">Run in parallel</p>
            <p className="text-xs text-gray-600">Consecutive parallel steps run simultaneously via Promise.all</p>
          </div>
          <div className={`w-9 h-5 rounded-full flex-shrink-0 transition-colors ${step.parallel ? 'bg-purple-600' : 'bg-gray-700'} relative`}>
            <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${step.parallel ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </button>
      </AdvancedDisclosure>
    </div>
  );
}
