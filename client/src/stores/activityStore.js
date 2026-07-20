import { create } from 'zustand';
import { fetchAuthenticated } from '../lib/api';

// Connects to /api/agents/activity SSE and maintains a map of
// { [agentId]: 'streaming' | 'idle' }.
//
// The connection is lazy — opened on first subscription, not at module import
// — and carries the auth token; an import-time unauthenticated EventSource
// would 401 and retry every 3s forever when auth is enabled.
export const useActivityStore = create(() => ({
  statuses: {},  // { agentId: 'streaming' }
}));

let controller = null;
let started = false;

function applyFrame(data) {
  try {
    const { agentId, status } = JSON.parse(data);
    useActivityStore.setState(state => {
      const next = { ...state.statuses };
      if (status === 'streaming') next[agentId] = 'streaming';
      else delete next[agentId];
      return { statuses: next };
    });
  } catch { /* ignore malformed frames */ }
}

async function connect() {
  if (controller) return;
  controller = new AbortController();
  try {
    const response = await fetchAuthenticated('/api/agents/activity', { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Activity stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const frames = pending.split('\n\n');
      pending = frames.pop() || '';
      for (const frame of frames) {
        const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
        if (data) applyFrame(data);
      }
    }
  } catch {
    // Reconnect below unless this connection was intentionally replaced.
  } finally {
    controller = null;
    if (started) setTimeout(connect, 3000);
  }
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
