import { create } from 'zustand';

// Connects to /api/agents/activity SSE and maintains a map of
// { [agentId]: 'streaming' | 'idle' }
export const useActivityStore = create((set) => {
  let es = null;

  function connect() {
    if (es) return;
    es = new EventSource('/api/agents/activity');
    es.onmessage = (e) => {
      try {
        const { agentId, status } = JSON.parse(e.data);
        set(state => {
          const next = { ...state.statuses };
          if (status === 'streaming') {
            next[agentId] = 'streaming';
          } else {
            delete next[agentId];
          }
          return { statuses: next };
        });
      } catch {}
    };
    es.onerror = () => {
      es?.close();
      es = null;
      // Reconnect after 3s
      setTimeout(connect, 3000);
    };
  }

  connect();

  return {
    statuses: {},  // { agentId: 'streaming' }
  };
});
