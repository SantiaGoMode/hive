import { useEffect, useState } from 'react';
import { Cloud, Settings as SettingsIcon } from 'lucide-react';
import { ModelBrowser } from '../components/models/ModelBrowser';
import { AgentEditor } from '../components/agents/AgentEditor';
import { StarterAgentBanner } from '../components/agents/StarterAgentBanner';
import { useAgentStore } from '../stores/agentStore';
import { pickStarterModel } from '../lib/starterAgent';
import { api } from '../lib/api';

const CLOUD = [
  { id: 'gateway', label: 'LLM Gateway', emoji: '🔀' },
  { id: 'anthropic', label: 'Anthropic', emoji: '🟣' },
  { id: 'openai', label: 'OpenAI', emoji: '🟢' },
  { id: 'gemini', label: 'Google Gemini', emoji: '🔵' },
];

function CloudModels() {
  const [grouped, setGrouped] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAllModels().then(setGrouped).catch(() => setGrouped({})).finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Cloud size={18} className="text-blue-400" />
        <h2 className="text-lg font-semibold text-gray-100">Cloud Models</h2>
      </div>
      <p className="text-sm text-gray-500 -mt-2">
        Available from providers with an API key set. Add keys in{' '}
        <span className="inline-flex items-center gap-1 text-gray-400"><SettingsIcon size={12} /> Settings → Model Providers</span>.
        Cloud models are used by id (e.g. <code className="bg-gray-800 px-1 rounded">anthropic/claude-sonnet-4-6</code>) — there's nothing to download.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {CLOUD.map(prov => {
            const list = (grouped && grouped[prov.id]) || [];
            const isGateway = prov.id === 'gateway';
            const live = list.some(m => m.source === 'live');
            const active = isGateway ? list.length > 0 : live;
            return (
              <div key={prov.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                    <span>{prov.emoji}</span> {prov.label}
                  </h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${active ? 'text-green-400 border-green-500/30 bg-green-500/10' : 'text-gray-500 border-gray-700 bg-gray-800/50'}`}>
                    {isGateway ? (active ? 'Failover pool' : 'Off') : live ? 'Key set' : 'No key'}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {list.length === 0 ? (
                    <p className="text-xs text-gray-600 italic">No models</p>
                  ) : list.map(m => (
                    <div key={m.id} className="flex items-center justify-between text-xs">
                      <span className="font-mono text-gray-300 truncate" title={m.id}>{m.name}</span>
                      {m.source === 'fallback' && <span className="text-gray-600 ml-2 shrink-0">suggested</span>}
                    </div>
                  ))}
                </div>
                {isGateway && active && (
                  <p className="text-[11px] text-gray-600">Failover aliases — each routes across providers with automatic retry.</p>
                )}
                {!isGateway && !live && list.length > 0 && (
                  <p className="text-[11px] text-gray-600">Suggested ids shown — add a key to load the live list.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ModelsPage() {
  const { agents, fetchAgents } = useAgentStore();
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [grouped, setGrouped] = useState(null);
  const [lastPulled, setLastPulled] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    fetchAgents().finally(() => setAgentsLoaded(true));
    api.getAllModels().then(setGrouped).catch(() => setGrouped({}));
  }, []);

  // First-run CTA: a usable model exists (or one was just pulled) but no agent yet.
  const bannerModel = agentsLoaded && agents.length === 0
    ? (lastPulled || pickStarterModel(grouped))
    : null;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Models</h1>
        <p className="text-sm text-gray-500 mt-0.5">Local Ollama models and connected cloud providers</p>
      </div>

      {bannerModel && (
        <StarterAgentBanner
          modelId={bannerModel}
          title={lastPulled ? `${lastPulled} installed — create your first agent` : undefined}
          onCustomize={() => setEditorOpen(true)}
        />
      )}

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-gray-100">Local (Ollama)</h2>
        <ModelBrowser onPullComplete={setLastPulled} />
      </div>

      <CloudModels />

      <AgentEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        agent={null}
        initialValues={bannerModel ? { model: bannerModel } : undefined}
      />
    </div>
  );
}
