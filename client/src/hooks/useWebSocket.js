import { useRef, useCallback, useEffect } from 'react';
import { buildWebSocketProtocols, buildWebSocketUrl } from '../lib/api';

export function useWebSocket(agentId) {
  const wsRef = useRef(null);

  const connect = useCallback(() => {
    const current = wsRef.current;
    // Reuse an OPEN socket, and don't orphan one that is still CONNECTING —
    // opening a second socket would leak the first.
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
      return current;
    }
    const protocols = buildWebSocketProtocols();
    const ws = protocols.length
      ? new WebSocket(buildWebSocketUrl(agentId), protocols)
      : new WebSocket(buildWebSocketUrl(agentId));
    wsRef.current = ws;
    return ws;
  }, [agentId]);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const disconnect = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    // Detach handlers so a close during teardown can't fire setState on an
    // unmounted component, then close (also aborts a CONNECTING socket).
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already closed */ }
  }, []);

  // Close the socket when the consuming component unmounts (or the agent
  // changes) — otherwise navigating away mid-stream leaks the socket and
  // keeps generation running server-side.
  useEffect(() => disconnect, [agentId, disconnect]);

  return { connect, send, disconnect, wsRef };
}
