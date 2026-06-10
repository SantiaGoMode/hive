import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '../../stores/toastStore';
import { useAgentStore } from '../../stores/agentStore';
import { starterAgentDefaults } from '../../lib/starterAgent';

// One-click starter-agent creation: creates the agent with sensible defaults
// and routes straight into chat. On failure the user stays put with a
// recoverable error toast (issue #2).
export function useCreateStarterAgent() {
  const navigate = useNavigate();
  const createAgent = useAgentStore(s => s.createAgent);
  const [creating, setCreating] = useState(false);

  const create = async (modelId) => {
    if (!modelId || creating) return;
    setCreating(true);
    try {
      const agent = await createAgent(starterAgentDefaults(modelId));
      toast.success(`Created ${agent.name} — say hello!`);
      navigate(`/chat/${agent.id}`);
    } catch (e) {
      toast.error(`Could not create starter agent: ${e.message}`);
    } finally {
      setCreating(false);
    }
  };

  return { create, creating };
}
