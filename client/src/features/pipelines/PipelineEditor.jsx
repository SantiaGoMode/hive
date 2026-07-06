// Extracted from PipelinesPage (#23).
import { useState, useEffect } from 'react';
import { Plus, ArrowDown, Wand2, GitMerge, ArrowUp, ArrowDownToLine, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../stores/toastStore';
import { useAgentStore } from '../../stores/agentStore';
import { buildPipelineFlowPreview, flattenModelIds, validatePipelineDraft } from '../../components/pipelines/pipelineBuilderUtils';
import { PIPELINE_TEMPLATES } from './templates';
import { StepEditor } from './StepEditor';

export function PipelineEditor({ open, onClose, pipeline, initialTemplate = null }) {
  const { agents } = useAgentStore();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState([]);
  const [saving, setSaving] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [mcpServers, setMcpServers] = useState([]);
  const [models, setModels] = useState({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getMcpServers().then(setMcpServers).catch(() => setMcpServers([]));
    api.getAllModels().then(setModels).catch(() => setModels({}));
  }, [open]);

  useEffect(() => {
    if (pipeline) {
      setName(pipeline.name);
      setDescription(pipeline.description || '');
      setSteps(pipeline.steps || []);
      setShowTemplates(false);
      setSubmitted(false);
    } else if (initialTemplate) {
      setName(initialTemplate.name);
      setDescription(initialTemplate.description || '');
      setSteps(initialTemplate.steps.map(s => ({ ...s })));
      setShowTemplates(false);
      setSubmitted(false);
    } else {
      setName(''); setDescription(''); setSteps([]);
      setShowTemplates(false);
      setSubmitted(false);
    }
  }, [pipeline, open, initialTemplate]);

  const applyTemplate = (tpl) => {
    if (!name) setName(tpl.name);
    setDescription(tpl.description || '');
    setSteps(tpl.steps.map(s => ({ ...s })));
    setShowTemplates(false);
  };

  const addStep = () => setSteps(s => [...s, { label: '', agent_id: '', prompt: s.length === 0 ? '{input}' : '{prev}' }]);
  const updateStep = (i, val) => setSteps(s => s.map((st, j) => j === i ? val : st));
  const removeStep = (i) => setSteps(s => s.filter((_, j) => j !== i));
  const moveStep = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    setSteps(next);
  };
  const moveStepTo = (i, target) => {
    if (i === target || target < 0 || target >= steps.length) return;
    const next = [...steps];
    const [item] = next.splice(i, 1);
    next.splice(target, 0, item);
    setSteps(next);
  };

  const availableModelIds = flattenModelIds(models);
  const validation = validatePipelineDraft({ name, steps, agents, availableModelIds });
  const showValidation = submitted || !validation.valid;
  const flowPreview = buildPipelineFlowPreview(steps);
  const errorCount = Object.keys(validation.formErrors).length
    + validation.stepErrors.reduce((sum, errors) => sum + Object.keys(errors).length, 0);

  const handleSave = async () => {
    setSubmitted(true);
    if (!validation.valid) return toast.error('Fix pipeline validation errors');
    setSaving(true);
    try {
      if (pipeline) await api.updatePipeline(pipeline.id, { name, description, steps });
      else await api.createPipeline({ name, description, steps });
      toast.success(pipeline ? 'Pipeline updated' : 'Pipeline created');
      onClose(true);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={() => onClose(false)} title={pipeline ? `Edit: ${pipeline.name}` : 'New Pipeline'} size="xl">
      <div className="flex flex-col gap-4 max-h-[60vh] overflow-y-auto pr-1">
        {/* Template picker (new pipelines only) */}
        {!pipeline && (
          <div>
            <button
              type="button"
              onClick={() => setShowTemplates(t => !t)}
              className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Wand2 size={12} />
              {showTemplates ? 'Hide templates' : 'Use a template'}
            </button>
            {showTemplates && (
              <div className="mt-2 grid grid-cols-1 gap-2">
                {PIPELINE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.name}
                    type="button"
                    onClick={() => applyTemplate(tpl)}
                    className="text-left p-3 rounded-lg border border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-colors"
                  >
                    <p className="text-sm font-medium text-gray-200">{tpl.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{tpl.description} · {tpl.steps.length} steps</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Research & Summarize" error={showValidation ? validation.formErrors.name : ''} />
        <Input label="Description" value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this pipeline do?" />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-gray-300">Steps</label>
              {showValidation && validation.formErrors.steps && <p className="text-xs text-red-400 mt-1">{validation.formErrors.steps}</p>}
            </div>
            <Button size="sm" variant="secondary" onClick={addStep}><Plus size={12} /> Add Step</Button>
          </div>
          {showValidation && errorCount > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-red-700/40 bg-red-500/5 px-3 py-2 text-xs text-red-300">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{errorCount} issue{errorCount !== 1 ? 's' : ''} need attention before this pipeline can be saved.</span>
            </div>
          )}

          {steps.length === 0 && (
            <div className="text-center py-8 text-gray-500 text-sm border border-dashed border-gray-700 rounded-lg">
              No steps yet — add one above
            </div>
          )}

          {steps.map((step, i) => (
            <div key={i} className="flex flex-col gap-1">
              <StepEditor
                step={step}
                agents={agents}
                mcpServers={mcpServers}
                models={models}
                onChange={v => updateStep(i, v)}
                onRemove={() => removeStep(i)}
                index={i}
                errors={showValidation ? validation.stepErrors[i] : {}}
              />
              <div className="flex items-center justify-end gap-1">
                <span className="mr-2 text-xs text-gray-600">Order</span>
                <button type="button" onClick={() => moveStepTo(i, 0)} disabled={i === 0} title="Move to first" className="rounded border border-gray-800 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                  <ArrowUp size={12} />
                </button>
                <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} title="Move up" className="rounded border border-gray-800 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                  Up
                </button>
                <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} title="Move down" className="rounded border border-gray-800 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                  Down
                </button>
                <button type="button" onClick={() => moveStepTo(i, steps.length - 1)} disabled={i === steps.length - 1} title="Move to last" className="rounded border border-gray-800 px-2 py-1 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-700 disabled:opacity-30 disabled:cursor-not-allowed">
                  <ArrowDownToLine size={12} />
                </button>
              </div>
              {i < steps.length - 1 && (
                <div className="flex justify-center items-center gap-1 py-1">
                  {steps[i + 1]?.parallel
                    ? <><GitMerge size={12} className="text-purple-600" /><span className="text-xs text-purple-600/70">parallel</span></>
                    : <ArrowDown size={14} className="text-gray-700" />
                  }
                </div>
              )}
            </div>
          ))}
        </div>

        {flowPreview.length > 0 && (
          <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-300">Input flow preview</p>
              <p className="text-xs text-gray-600">{'{input}'} stays original · {'{prev}'} becomes the prior output</p>
            </div>
            <div className="flex flex-col gap-2">
              {flowPreview.map(item => (
                <div key={item.index} className="rounded-md border border-gray-800 bg-gray-900/60 p-3">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Step {item.index + 1}{item.parallel ? ' · parallel' : ''}</p>
                    <p className="text-xs text-gray-600">{item.usesInput ? '{input}' : 'no input'} · {item.usesPrev ? '{prev}' : 'no prev'}</p>
                  </div>
                  <p className="text-xs text-gray-500">Previous output: <span className="text-gray-300">{item.prev}</span></p>
                  <p className="text-xs text-gray-500 mt-1">Rendered prompt: <span className="text-gray-300 font-mono">{item.rendered || 'Empty prompt'}</span></p>
                  <p className="text-xs text-gray-500 mt-1">Next {'{prev}'}: <span className="text-gray-300">{item.outputLabel}</span></p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-700">
        <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : (pipeline ? 'Save Changes' : 'Create Pipeline')}</Button>
      </div>
    </Modal>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────
