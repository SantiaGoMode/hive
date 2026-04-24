import { useRef, useCallback } from 'react';
import { WS_URL } from '../lib/api';

export function useWebSocket(agentId) {
  const wsRef = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(`${WS_URL}/${agentId}`);
    wsRef.current = ws;
    return ws;
  }, [agentId]);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  return { connect, send, disconnect, wsRef };
}
