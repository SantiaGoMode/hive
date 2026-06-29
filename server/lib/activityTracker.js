// Tracks which agents are currently streaming and notifies SSE listeners.

const active = new Set();       // agent IDs currently streaming
const listeners = new Set();    // SSE response objects

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) {
    try { res.write(data); } catch {} /* SSE client may have disconnected */
  }
}

function setActive(agentId) {
  if (active.has(agentId)) return;
  active.add(agentId);
  broadcast({ agentId, status: 'streaming' });
}

function setIdle(agentId) {
  if (!active.has(agentId)) return;
  active.delete(agentId);
  broadcast({ agentId, status: 'idle' });
}

function getActive() {
  return [...active];
}

function addListener(res) {
  listeners.add(res);
}

function removeListener(res) {
  listeners.delete(res);
}

module.exports = { setActive, setIdle, getActive, addListener, removeListener };
