import { create } from 'zustand';
import { api } from '../lib/api';

export const useAgentStore = create((set, get) => ({
  agents: [],
  loading: false,
  error: null,

  fetchAgents: async () => {
    set({ loading: true, error: null });
    try {
      const agents = await api.getAgents();
      set({ agents, loading: false });
    } catch (e) {
      set({ error: e.message, loading: false });
    }
  },

  createAgent: async (data) => {
    const agent = await api.createAgent(data);
    set(s => ({ agents: [agent, ...s.agents] }));
    return agent;
  },

  updateAgent: async (id, data) => {
    const agent = await api.updateAgent(id, data);
    set(s => ({ agents: s.agents.map(a => a.id === id ? agent : a) }));
    return agent;
  },

  deleteAgent: async (id) => {
    await api.deleteAgent(id);
    set(s => ({ agents: s.agents.filter(a => a.id !== id) }));
  },
}));
