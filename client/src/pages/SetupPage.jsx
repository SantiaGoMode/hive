import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Circle, ExternalLink, RefreshCw, Rocket } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { api } from '../lib/api';
import { SETUP_STEPS, nextStep, prevStep, dependencyChecklist, hasModelAccess } from '../lib/setupWizard';

const PROVIDER_KEYS = [
  { id: 'anthropic', label: 'Anthropic', settingKey: 'anthropic_api_key', placeholder: 'sk-ant-…' },
  { id: 'openai', label: 'OpenAI', settingKey: 'openai_api_key', placeholder: 'sk-…' },
  { id: 'gemini', label: 'Gemini', settingKey: 'gemini_api_key', placeholder: 'AIza…' },
];

function ChecklistRow({ item }) {
  return (
    <div className="flex items-start gap-3 p-3 bg-gray-800/40 border border-gray-700/60 rounded-lg">
      {item.ok
        ? <CheckCircle2 size={18} className="text-green-400 shrink-0 mt-0.5" />
        : <Circle size={18} className={`${item.required ? 'text-amber-400' : 'text-gray-600'} shrink-0 mt-0.5`} />}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200">
          {item.label}
          {!item.required && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">optional</span>}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">{item.detail}</p>
      </div>
      {!item.ok && item.href && (
        <a
          href={item.href}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 shrink-0 mt-1"
        >
          Install <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(SETUP_STEPS[0]);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const [provider, setProvider] = useState(PROVIDER_KEYS[0]);
  const [keyValue, setKeyValue] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const refresh = useCallback(async () => {
    setChecking(true);
    try { setStatus(await api.getSetupStatus()); }
    catch { /* endpoint unreachable — rows render as unknown until re-check */ }
    finally { setChecking(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const finish = async (destination = '/') => {
    setFinishing(true);
    try { await api.completeSetup(); } catch { /* flag write failed — still leave the wizard */ }
    navigate(destination);
  };

  const saveKey = async () => {
    if (!keyValue.trim()) return;
    setSavingKey(true);
    try {
      await api.updateConfig({ [provider.settingKey]: keyValue.trim() });
      setKeyValue('');
      await refresh();
    } finally {
      setSavingKey(false);
    }
  };

  const checklist = dependencyChecklist(status);
  const modelReady = hasModelAccess(status);
  const stepIndex = SETUP_STEPS.indexOf(step);

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center gap-2 mb-6" aria-label={`Setup step ${stepIndex + 1} of ${SETUP_STEPS.length}`}>
        {SETUP_STEPS.map((s, i) => (
          <div key={s} className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-blue-500' : 'bg-gray-700'}`} />
        ))}
      </div>

      {step === 'welcome' && (
        <div className="text-center py-10">
          <div className="w-14 h-14 mx-auto bg-blue-600/20 border border-blue-500/30 rounded-2xl flex items-center justify-center mb-4">
            <Rocket size={24} className="text-blue-400" />
          </div>
          <h1 className="text-2xl font-semibold text-gray-100">Welcome to Hive</h1>
          <p className="text-sm text-gray-400 mt-2 max-w-md mx-auto">
            Let's check your system and get a model connected. This takes about a
            minute, and everything can be changed later in Settings.
          </p>
          <div className="flex justify-center gap-3 mt-8">
            <Button variant="ghost" onClick={() => finish('/')} disabled={finishing}>Skip setup</Button>
            <Button onClick={() => setStep(nextStep(step))}>Get started</Button>
          </div>
        </div>
      )}

      {step === 'dependencies' && (
        <div>
          <h2 className="text-lg font-semibold text-gray-100">System check</h2>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Hive needs model access, Docker, GitHub access, npx, and uvx for its full
            feature set. You can continue with items missing, but agents that depend
            on them won't work until they're installed.
          </p>
          <div className="space-y-2">
            {checklist.length === 0 && (
              <p className="text-sm text-gray-500 py-6 text-center">{checking ? 'Checking your system…' : 'Could not reach the server — retry below.'}</p>
            )}
            {checklist.map(item => <ChecklistRow key={item.key} item={item} />)}
          </div>
          <div className="flex items-center justify-between mt-6">
            <Button variant="ghost" size="sm" onClick={refresh} disabled={checking}>
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Re-check
            </Button>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(prevStep(step))}>Back</Button>
              <Button onClick={() => setStep(nextStep(step))}>Continue</Button>
            </div>
          </div>
        </div>
      )}

      {step === 'model' && (
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Connect a model</h2>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Pick either path — local and cloud models work side by side.
          </p>

          <div className="p-4 bg-gray-800/40 border border-gray-700/60 rounded-lg mb-3">
            <p className="text-sm font-medium text-gray-200">Local — Ollama</p>
            {status?.ollama?.reachable ? (
              <p className="text-xs text-gray-500 mt-1">
                Ollama is running with {status.ollama.installed_models} model{status.ollama.installed_models === 1 ? '' : 's'} installed.{' '}
                {status.ollama.installed_models === 0 && 'Pull one from the Models page after setup — the wizard will point you there.'}
              </p>
            ) : (
              <p className="text-xs text-gray-500 mt-1">
                Ollama isn't reachable. <a href="https://ollama.com/download" target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">Install it</a>, run <code className="text-gray-400">ollama serve</code>, then re-check on the previous step.
              </p>
            )}
          </div>

          <div className="p-4 bg-gray-800/40 border border-gray-700/60 rounded-lg">
            <p className="text-sm font-medium text-gray-200 mb-2">Cloud — paste an API key</p>
            <div className="flex gap-2 mb-2">
              {PROVIDER_KEYS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setProvider(p)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${provider.id === p.id ? 'bg-blue-600/20 border-blue-500/40 text-blue-300' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'}`}
                >
                  {p.label}{status?.providers?.[p.id] && ' ✓'}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                type="password"
                value={keyValue}
                onChange={e => setKeyValue(e.target.value)}
                placeholder={status?.providers?.[provider.id] ? 'Key saved — type to replace' : provider.placeholder}
                className="flex-1"
              />
              <Button size="sm" onClick={saveKey} disabled={savingKey || !keyValue.trim()}>
                {savingKey ? 'Saving…' : 'Save key'}
              </Button>
            </div>
            <p className="text-[11px] text-gray-600 mt-2">
              Stored locally in Hive's settings database (readable only by your user) and masked in the UI.
            </p>
          </div>

          <div className="flex items-center justify-between mt-6">
            <p className="text-xs text-gray-500">
              {modelReady ? '✓ Model access ready' : 'No model access yet — you can still finish and set it up later.'}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(prevStep(step))}>Back</Button>
              <Button onClick={() => setStep(nextStep(step))}>Continue</Button>
            </div>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div className="text-center py-10">
          <CheckCircle2 size={40} className="text-green-400 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-100">You're set</h2>
          <p className="text-sm text-gray-400 mt-2 max-w-md mx-auto">
            {status?.ollama?.reachable && status.ollama.installed_models === 0
              ? 'Next: pull a local model from the Models page, then create your first agent with one click.'
              : 'Next: create your first agent — a one-click starter is waiting on the Models page.'}
          </p>
          <div className="flex justify-center gap-3 mt-8">
            <Button variant="secondary" onClick={() => setStep(prevStep(step))} disabled={finishing}>Back</Button>
            <Button onClick={() => finish('/models')} disabled={finishing}>
              {finishing ? 'Finishing…' : 'Finish setup'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
