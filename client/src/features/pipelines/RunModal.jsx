// Extracted from PipelinesPage (#23).
import { useState, useEffect, useRef } from 'react';
import { Play, Square, Clock, ArrowDown } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../stores/toastStore';
import { readSSEStream } from '../../lib/streamParser';
import { CopyBtn, StepCard, ParallelGroupTrace, groupStepEntries, getPrevOutputForRetry } from './runViews';

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

      for await (const evt of readSSEStream(res, { signal: ctrl.signal })) {
        if (evt.type === 'step_done') {
          setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'done', output: evt.output, duration_ms: evt.duration_ms } : e));
        } else if (evt.type === 'step_error') {
          setSteps(s => s.map(e => e.step === stepIndex ? { ...e, status: 'error', error: evt.error, duration_ms: evt.duration_ms } : e));
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

      for await (const evt of readSSEStream(res, { signal: ctrl.signal })) {
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
