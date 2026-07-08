// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { ChatWindow } from './ChatWindow';

// ── Mock WebSocket ────────────────────────────────────────────────────────────
// Captures instances so tests can drive server frames through onmessage.
class MockWebSocket {
  static instances = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverSend(frame) {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  send(data) { this.sent.push(data); }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

const AGENT = { id: 'a1', name: 'Testbot', model: 'llama3', avatar_color: '#d97706', tools: [] };

function lastSocket() {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

async function sendMessage(text) {
  const box = screen.getByPlaceholderText('Message…');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
  const ws = lastSocket();
  await act(async () => { ws.open(); });
  return ws;
}

describe('ChatWindow streaming state machine', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup(); // vitest runs without globals:true, so auto-cleanup never registers
    vi.unstubAllGlobals();
  });

  it('disables input while streaming and sends the chat frame on open', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('hello');

    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.type).toBe('chat');
    expect(frame.messages.at(-1)).toEqual({ role: 'user', content: 'hello' });
    // Input is disabled during generation.
    expect(screen.getByPlaceholderText('Message…').disabled).toBe(true);
  });

  it('streams chunks and re-enables input on done', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('hi');

    await act(async () => {
      ws.serverSend({ type: 'chunk', content: 'Hello ' });
      ws.serverSend({ type: 'chunk', content: 'there' });
      ws.serverSend({ type: 'done' });
    });

    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message…').disabled).toBe(false);
  });

  it('keeps thinking chunks out of the answer and shows a reasoning disclosure', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('why?');

    await act(async () => {
      ws.serverSend({ type: 'chunk', content: 'pondering the question', kind: 'thinking' });
      ws.serverSend({ type: 'chunk', content: 'The answer is 42.' });
      ws.serverSend({ type: 'done' });
    });

    // Answer text must not contain the reasoning.
    expect(screen.getByText('The answer is 42.')).toBeTruthy();
    expect(screen.queryByText(/pondering the question.*The answer/)).toBeNull();
    // Reasoning is behind a collapsible disclosure on the final message.
    expect(screen.getByText('Reasoning')).toBeTruthy();
    expect(screen.getByText('pondering the question')).toBeTruthy();
  });

  it('survives a malformed frame without wedging the input (finding #4)', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('hi');

    await act(async () => {
      ws.serverSend('{not json');
      ws.serverSend({ type: 'chunk', content: 'still alive' });
      ws.serverSend({ type: 'done' });
    });

    expect(screen.getByText('still alive')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message…').disabled).toBe(false);
  });

  it('recovers when the socket closes without a terminal frame', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('hi');

    await act(async () => {
      ws.serverSend({ type: 'chunk', content: 'partial' });
      ws.close();
    });

    // Partial text is committed and the composer is usable again.
    expect(screen.getByText('partial')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message…').disabled).toBe(false);
  });

  it('matches tool results by call id, not name (Low: parallel same-tool calls)', async () => {
    render(<ChatWindow agent={AGENT} />);
    const ws = await sendMessage('run tools');

    await act(async () => {
      ws.serverSend({ type: 'done_partial' });
      ws.serverSend({ type: 'tool_call', id: 'c1', name: 'web_search', args: { q: 'a' } });
      ws.serverSend({ type: 'tool_call', id: 'c2', name: 'web_search', args: { q: 'b' } });
      // Second call finishes first — must not resolve the first card.
      ws.serverSend({ type: 'tool_result', id: 'c2', name: 'web_search', result: { result: 'B' } });
    });

    // One call still pending (spinner), one done — both rendered.
    const cards = screen.getAllByText('web_search');
    expect(cards).toHaveLength(2);

    await act(async () => {
      ws.serverSend({ type: 'tool_result', id: 'c1', name: 'web_search', result: { result: 'A' } });
      ws.serverSend({ type: 'done' });
    });
    expect(screen.getByPlaceholderText('Message…').disabled).toBe(false);
  });

  it('does not send when the agent has no model', () => {
    render(<ChatWindow agent={{ ...AGENT, model: '' }} />);
    const box = screen.getByPlaceholderText('No model assigned — edit this agent first');
    expect(box.disabled).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
