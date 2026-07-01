// Extracted from PipelinesPage (#23).
import { useState, useEffect } from 'react';
import { Plus, ArrowDown, Wand2, GitMerge } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../stores/toastStore';
import { useAgentStore } from '../../stores/agentStore';
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

  useEffect(() => {
    if (open) api.getMcpServers().then(setMcpServers).catch(() => setMcpServers([]));
  }, [open]);

  useEffect(() => {
    if (pipeline) {
      setName(pipeline.name);
      setDescription(pipeline.description || '');
      setSteps(pipeline.steps || []);
      setShowTemplates(false);
    } else if (initialTemplate) {
      setName(initialTemplate.name);
      setDescription(initialTemplate.description || '');
      setSteps(initialTemplate.steps.map(s => ({ ...s })));
      setShowTemplates(false);
    } else {
      setName(''); setDescription(''); setSteps([]);
      setShowTemplates(false);
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

  const handleSave = async () => {
    if (!name.trim()) return toast.error('Name is required');
    if (!steps.length) return toast.error('Add at least one step');
    if (steps.some(s => !s.agent_id)) return toast.error('All steps need an agent');
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

        <Input label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Research & Summarize" />
        <Input label="Description" value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this pipeline do?" />

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-300">Steps</label>
            <Button size="sm" variant="secondary" onClick={addStep}><Plus size={12} /> Add Step</Button>
          </div>

          {steps.length === 0 && (
            <div className="text-center py-8 text-gray-500 text-sm border border-dashed border-gray-700 rounded-lg">
              No steps yet — add one above
            </div>
          )}

          {steps.map((step, i) => (
            <div key={i} className="flex flex-col gap-1">
              <StepEditor step={step} agents={agents} mcpServers={mcpServers} onChange={v => updateStep(i, v)} onRemove={() => removeStep(i)} index={i} />
              <div className="flex gap-1 justify-end">
                {i > 0 && <button onClick={() => moveStep(i, -1)} className="text-xs text-gray-600 hover:text-gray-400 px-2">↑ Move up</button>}
                {i < steps.length - 1 && <button onClick={() => moveStep(i, 1)} className="text-xs text-gray-600 hover:text-gray-400 px-2">↓ Move down</button>}
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
      </div>
      <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-700">
        <Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : (pipeline ? 'Save Changes' : 'Create Pipeline')}</Button>
      </div>
    </Modal>
  );
}

// ── Copy button ───────────────────────────────────────────────────────────────
