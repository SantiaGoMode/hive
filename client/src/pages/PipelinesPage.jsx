import { useState, useEffect, useRef } from 'react';
import { Plus, Play, Square, Trash2, Edit2, ChevronRight, CheckCircle, XCircle, Loader, Clock, ArrowDown, Copy, Check, History, X, ChevronDown, ChevronUp, Wand2, GitMerge, RotateCcw } from 'lucide-react';

// ── Pipeline Templates ────────────────────────────────────────────────────────
const PIPELINE_TEMPLATES = [
  {
    name: 'Research Brief',
    description: 'Gather evidence, critique sources, then synthesize a concise brief',
    steps: [
      {
        label: 'Research',
        agent_id: '',
        tools: ['web_search', 'memory'],
        prompt: 'Research this topic or question using current, source-backed evidence:\n\n{input}\n\nReturn 5-8 concise findings with source URLs when available. Separate facts from interpretation, call out uncertainty, and end with "Research handoff" containing the strongest findings and source list or verification gaps.',
      },
      {
        label: 'Source Critique',
        agent_id: '',
        tools: ['memory'],
        prompt: 'Critique this research handoff for weak claims, missing context, conflicting evidence, source quality, and stale or thin support:\n\n{prev}\n\nRate the evidence as strong, medium, or weak. End with "Critic handoff" containing claims safe to use and claims that need caveats.',
      },
      {
        label: 'Synthesize Brief',
        agent_id: '',
        tools: ['memory'],
        prompt: 'Create a polished research brief from the research and critique notes:\n\n{prev}\n\nInclude an executive summary, key findings, evidence notes, caveats, open questions, and source URLs or verification gaps. End with "Final brief" followed by the complete deliverable.',
      },
    ],
  },
  {
    name: 'Research → Blog Post',
    description: 'Research a topic then write a polished blog post',
    steps: [
      { label: 'Research', agent_id: '', prompt: 'Research the following topic thoroughly and summarize the key findings, facts, and insights:\n\n{input}' },
      { label: 'Write Post', agent_id: '', prompt: 'Write a well-structured, engaging blog post based on this research:\n\n{prev}\n\nMake it readable, with clear sections, a strong intro, and a conclusion.' },
    ],
  },
  {
    name: 'Summarize → Translate',
    description: 'Summarize content then translate it to Spanish',
    steps: [
      { label: 'Summarize', agent_id: '', prompt: 'Summarize the following content concisely, keeping the most important points:\n\n{input}' },
      { label: 'Translate', agent_id: '', prompt: 'Translate the following text to Spanish, preserving tone and meaning:\n\n{prev}' },
    ],
  },
  {
    name: 'Code Review → Fix',
    description: 'Review code for issues then apply fixes',
    steps: [
      { label: 'Review', agent_id: '', prompt: 'Review the following code carefully. Identify bugs, security issues, performance problems, and style improvements. Be specific:\n\n{input}' },
      { label: 'Apply Fixes', agent_id: '', prompt: 'Based on this code review:\n{prev}\n\nRewrite the original code with all the issues fixed. Provide the complete corrected code.\n\nOriginal code:\n{input}' },
    ],
  },
  {
    name: 'News Briefing',
    description: 'Search for news then write an executive summary',
    steps: [
      { label: 'Gather News', agent_id: '', prompt: 'Search for the latest news and developments about: {input}\n\nCollect the most important stories from the past 24-48 hours.' },
      { label: 'Executive Summary', agent_id: '', prompt: 'Write a concise executive briefing based on these news items:\n\n{prev}\n\nFormat: bullet points for key stories, 1-2 sentences each, most important first.' },
    ],
  },
  {
    name: 'Draft → Polish',
    description: 'Write a first draft then refine and polish it',
    steps: [
      { label: 'Draft', agent_id: '', prompt: 'Write a first draft for the following:\n\n{input}\n\nFocus on getting the content right, don\'t worry too much about polish.' },
      { label: 'Polish', agent_id: '', prompt: 'Improve and polish this draft. Fix grammar, improve flow, sharpen the language, and make it more compelling:\n\n{prev}' },
    ],
  },
  {
    name: 'Webhook → Triage',
    description: 'Triage an incoming webhook event from its distilled context, fetching raw data only if needed',
    steps: [
      {
        label: 'Triage Event',
        agent_id: '',
        tools: ['agent_tools'],
        prompt: 'You are processing an incoming webhook event. The input below is a DISTILLED context envelope — only the fields configured as relevant for this webhook, not the full payload.\n\nThe envelope has this shape:\n- `context`: the extracted fields you should work from first\n- `_event_id`: the id of the stored raw event\n- `_event_type`: the event type\n- `_projected`: true if the context was distilled, false if it is the full raw payload\n\nIf (and only if) `context` is missing a field you genuinely need, call the `get_webhook_event` tool with the `_event_id` to fetch the FULL raw payload (pass `include_headers: true` if you also need request headers). Do not fetch the raw payload otherwise — keep your context lean.\n\nTriage this event: summarize what happened, classify its importance, and state the recommended next action.\n\nEvent envelope:\n{input}',
      },
    ],
  },
];
import { api } from '../lib/api';
import { Button } from '../components/ui/Button';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { toast } from '../stores/toastStore';
import { useAgentStore } from '../stores/agentStore';
import { DeleteConfirm } from '../components/agents/DeleteConfirm';
import { formatDate } from '../lib/utils';
import { ToolPicker } from '../components/ToolPicker';

// ── Pipeline Editor Modal ─────────────────────────────────────────────────────

// Built-in tool groups + the compact tool picker now live in the shared
// components/ToolPicker (issue #4), used here and by SchedulesPage.

function StepEditor({ step, agents, mcpServers, onChange, onRemove, index }) {
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

function PipelineEditor({ open, onClose, pipeline, initialTemplate = null }) {
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
function CopyBtn({ text }) {
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
function StepCard({ entry, onRetry }) {
  const isPending = entry.status === 'pending';
  const isError   = entry.status === 'error';
  const isDone    = entry.status === 'done';

  return (
    <div className={`p-4 rounded-lg border transition-colors flex-1 min-w-0 ${isError ? 'border-red-700/40 bg-red-500/5' : isDone ? 'border-gray-700 bg-gray-800/40' : 'border-blue-700/30 bg-blue-500/5'}`}>
      <div className="flex items-center gap-2 mb-2">
        {isPending && <Loader size={14} className="text-blue-400 animate-spin flex-shrink-0" />}
        {isDone    && <CheckCircle size={14} className="text-green-400 flex-shrink-0" />}
        {isError   && <XCircle size={14} className="text-red-400 flex-shrink-0" />}
        <span className="text-sm font-medium text-gray-200 truncate">{entry.label}</span>
        <span className="text-xs text-gray-500 flex-shrink-0">→ {entry.agent_name}</span>
        {entry.duration_ms != null && (
          <span className="text-xs text-gray-600 ml-auto flex-shrink-0 flex items-center gap-1">
            <Clock size={10} />{(entry.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>
      {isPending && <p className="text-xs text-blue-400 animate-pulse">Running…</p>}
      {isError && (
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-red-400">{entry.error}</p>
          {onRetry && (
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
function StepTrace({ entry, index }) {
  return (
    <div className="flex flex-col gap-2">
      {index > 0 && <div className="flex justify-center"><ArrowDown size={14} className="text-gray-700" /></div>}
      <StepCard entry={entry} />
    </div>
  );
}

// Renders a parallel group side-by-side
function ParallelGroupTrace({ entries, showArrowAbove, onRetry }) {
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

// ── Run Modal ─────────────────────────────────────────────────────────────────

// Group step entries by their `group` index for rendering
function groupStepEntries(steps) {
  const groups = new Map();
  for (const s of steps) {
    const g = s.group ?? s.step; // fallback: each step is its own group
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

// Compute the prev_output for a step being retried:
// use the last completed group's output (joined if parallel) or the original input.
function getPrevOutputForRetry(stepEntry, allSteps, input) {
  const retryGroup = stepEntry.group ?? stepEntry.step;
  if (retryGroup === 0) return input;
  const prevGroupSteps = allSteps.filter(s => (s.group ?? s.step) === retryGroup - 1 && s.status === 'done');
  if (!prevGroupSteps.length) return input;
  return prevGroupSteps.length === 1
    ? prevGroupSteps[0].output
    : prevGroupSteps.map(s => s.output).join('\n\n---\n\n');
}

export function RunModal({ open, onClose, pipeline, initialInput = '' }) {
  const [input, setInput] = useState(initialInput);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState([]);       // live trace entries
  const [finalOutput, setFinalOutput] = useState(null);
  const [totalMs, setTotalMs] = useState(null);
  const abortRef = useRef(null);
  // Track which step indices are currently retrying
  const [retrying, setRetrying] = useState(new Set());

  useEffect(() => {
    if (open) { setInput(initialInput); setSteps([]); setFinalOutput(null); setTotalMs(null); setRetrying(new Set()); }
  }, [open, initialInput]);

  const handleStop = () => { abortRef.current?.abort(); };

  const handleRetryStep = async (stepEntry) => {
    const stepIndex = stepEntry.step;
    setRetrying(r => new Set([...r, stepIndex]));
    // Reset this step to pending in the trace
    setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'pending', error: undefined, output: undefined, duration_ms: undefined } : e));
    // Remove final output since we're re-running
    setFinalOutput(null);
    setTotalMs(null);

    const prevOutput = getPrevOutputForRetry(stepEntry, steps, input);
    const ctrl = new AbortController();

    try {
      const res = await api.retryPipelineStep(pipeline.id, stepIndex, prevOutput, input, ctrl.signal);
      if (!res.ok) { toast.error(`Server error ${res.status}`); return; }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'step_done') {
              setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'done', output: evt.output, duration_ms: evt.duration_ms } : e));
            } else if (evt.type === 'step_error') {
              setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'error', error: evt.error, duration_ms: evt.duration_ms } : e));
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        toast.error(e.message);
        setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'error', error: e.message } : e));
      }
    } finally {
      setRetrying(r => { const n = new Set(r); n.delete(stepIndex); return n; });
    }
  };

  const handleRun = async () => {
    if (!input.trim()) return toast.error('Enter an input first');
    setRunning(true);
    setSteps([]);
    setFinalOutput(null);
    setTotalMs(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await api.runPipeline(pipeline.id, input.trim(), ctrl.signal);
      if (!res.ok) { toast.error(`Server error ${res.status}`); setRunning(false); return; }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'step_start') {
              setSteps(s => [...s, { status: 'pending', label: evt.label, agent_name: evt.agent_name, step: evt.step, group: evt.group }]);
            } else if (evt.type === 'step_done') {
              setSteps(s => s.map(e => e.step === evt.step ? { ...e, status: 'done', output: evt.output, duration_ms: evt.duration_ms } : e));
            } else if (evt.type === 'step_error') {
              setSteps(s => s.map(e => e.step === evt.step ? { ...e, status: 'error', error: evt.error, duration_ms: evt.duration_ms } : e));
            } else if (evt.type === 'done') {
              setFinalOutput(evt.final_output);
              setTotalMs(evt.total_ms);
            }
          } catch {}
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') toast.error(e.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  if (!pipeline) return null;
  const hasResults = steps.length > 0;
  const succeeded  = finalOutput != null;
  const groupedEntries = groupStepEntries(steps);

  return (
    <Modal open={open} onClose={() => { handleStop(); onClose(); }} title={`Run: ${pipeline.name}`} size="xl">
      <div className="flex flex-col gap-4">
        {/* Input area — shown until first step starts */}
        {!hasResults && (
          <>
            <p className="text-sm text-gray-400">{pipeline.description || `${pipeline.steps?.length}-step pipeline`}</p>
            <Textarea
              label="Initial input"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="What should the pipeline process?"
              className="h-28"
              disabled={running}
            />
          </>
        )}

        {/* Live trace */}
        {hasResults && (
          <div className="flex flex-col gap-1 max-h-[55vh] overflow-y-auto pr-1">
            <div className="p-3 rounded-lg bg-gray-800 border border-gray-700 text-sm mb-2">
              <p className="text-xs text-gray-500 mb-0.5">Input</p>
              <p className="text-gray-200">{input}</p>
            </div>
            {groupedEntries.map(([groupIdx, entries], i) => {
              const isParallel = entries.length > 1;
              if (isParallel) {
                return (
                  <ParallelGroupTrace
                    key={groupIdx}
                    entries={entries}
                    showArrowAbove={i > 0}
                    onRetry={(entry) => !running && !retrying.has(entry.step) && handleRetryStep(entry)}
                  />
                );
              } else {
                const entry = entries[0];
                return (
                  <div key={groupIdx} className="flex flex-col gap-2">
                    {i > 0 && <div className="flex justify-center"><ArrowDown size={14} className="text-gray-700" /></div>}
                    <StepCard
                      entry={entry}
                      onRetry={!running && !retrying.has(entry.step) ? () => handleRetryStep(entry) : null}
                    />
                  </div>
                );
              }
            })}

            {succeeded && (
              <>
                <div className="flex justify-center mt-1"><ArrowDown size={14} className="text-gray-700" /></div>
                <div className="p-4 rounded-lg border border-blue-600/30 bg-blue-500/5 relative group">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-blue-400 font-semibold">Final Output</p>
                    <div className="flex items-center gap-2">
                      {totalMs && <span className="text-xs text-gray-600 flex items-center gap-1"><Clock size={10} />{(totalMs/1000).toFixed(1)}s total</span>}
                      <CopyBtn text={finalOutput} />
                    </div>
                  </div>
                  <p className="text-sm text-gray-200 whitespace-pre-wrap">{finalOutput}</p>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-gray-800">
          {running ? (
            <Button variant="danger" onClick={handleStop}><Square size={14} /> Stop</Button>
          ) : hasResults ? (
            <>
              <Button variant="secondary" onClick={() => { setSteps([]); setFinalOutput(null); setTotalMs(null); }}>Run Again</Button>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button onClick={handleRun} disabled={!input.trim()}><Play size={14} /> Run Pipeline</Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── History Drawer ────────────────────────────────────────────────────────────
function RunHistoryRow({ run }) {
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
                        : <div className="max-h-48 overflow-y-auto bg-gray-900/60 rounded-md p-2 mt-1 border border-gray-700/50">
                            <p className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">{entry.output}</p>
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
                <CopyBtn text={run.final_output} />
              </div>
              <div className="max-h-64 overflow-y-auto">
                <p className="text-xs text-gray-300 whitespace-pre-wrap leading-relaxed">{run.final_output}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryDrawer({ pipeline, onClose }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

  const loadRuns = () => {
    if (!pipeline) return;
    setLoading(true);
    api.getPipelineRuns(pipeline.id)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRuns(); }, [pipeline]);

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

function PipelineCard({ pipeline, agents, onEdit, onDelete, onRun, onHistory }) {
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
