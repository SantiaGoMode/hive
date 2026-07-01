import { create } from 'zustand';
import { getHiveAuthToken } from '../lib/api';

// Connects to /api/agents/activity SSE and maintains a map of
// { [agentId]: 'streaming' | 'idle' }.
//
// The connection is lazy — opened on first subscription, not at module import
// — and carries the auth token; an import-time unauthenticated EventSource
// would 401 and retry every 3s forever when auth is enabled.
export const useActivityStore = create(() => ({
  statuses: {},  // { agentId: 'streaming' }
}));

let es = null;
let started = false;

function activityUrl() {
  const token = getHiveAuthToken();
  return token
    ? `/api/agents/activity?hive_token=${encodeURIComponent(token)}`
    : '/api/agents/activity';
}

function connect() {
  if (es) return;
  es = new EventSource(activityUrl());
  es.onmessage = (e) => {
    try {
      const { agentId, status } = JSON.parse(e.data);
      useActivityStore.setState(state => {
        const next = { ...state.statuses };
        if (status === 'streaming') {
          next[agentId] = 'streaming';
        } else {
          delete next[agentId];
        }
        return { statuses: next };
      });
    } catch { /* ignore malformed frames */ }
  };
  es.onerror = () => {
    es?.close();
    es = null;
    // Reconnect after 3s
    setTimeout(connect, 3000);
  };
}

// Open the stream the first time any component subscribes to the store.
const originalSubscribe = useActivityStore.subscribe;
useActivityStore.subscribe = (...args) => {
  if (!started) {
    started = true;
    connect();
  }
  return originalSubscribe(...args);
};
