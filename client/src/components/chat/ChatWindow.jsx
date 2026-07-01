import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Square, Copy, Check, ChevronDown, ChevronUp, Wrench, CheckCircle, XCircle, Loader, Paperclip, X, Image, FileText, Zap, AlertTriangle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useWebSocket } from '../../hooks/useWebSocket';
import { Button } from '../ui/Button';
import { AgentAvatar } from '../agents/AgentAvatar';
import { cn, formatDate } from '../../lib/utils';
import { chatSendState } from '../../lib/frontendRegression';
import { toast } from '../../stores/toastStore';

// ── Copy button ───────────────────────────────────────────────────────────────
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="opacity-0 group-hover:opacity-100 p-1 text-gray-500 hover:text-gray-300 rounded transition-opacity"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

// ── Tool call card (for completed messages) ───────────────────────────────────
// Parse a possibly-namespaced MCP tool name: 'serverId__toolName' → { displayName, mcpServer }
// For built-in tools the name is plain, e.g. 'web_search'.
// Parse a possibly-namespaced MCP tool name: 'serverId__toolName' → { displayName, mcpServer }
// For built-in tools the name is plain, e.g. 'web_search'.
function parseMcpToolName(name, serverName) {
  if (serverName) return { displayName: name.includes('__') ? name.split('__').slice(1).join('__') : name, mcpServer: serverName };
  if (name.includes('__')) {
    const idx = name.indexOf('__');
    return { displayName: name.slice(idx + 2), mcpServer: null }; // server name unknown in history
  }
  return { displayName: name, mcpServer: null };
}

// Render a tool result readably:
// - If { result: string }, show the string directly (preserves newlines, avoids \n escapes)
// - Otherwise pretty-print as JSON
function formatToolResult(result) {
  if (result && typeof result === 'object' && typeof result.result === 'string') {
    return result.result;
  }
  return JSON.stringify(result, null, 2);
}

function ToolCallCard({ name, args, result, serverName }) {
  const [open, setOpen] = useState(false);
  const hasError = result?.error;
  const { displayName, mcpServer } = parseMcpToolName(name, serverName);
  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden text-xs mt-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-800/60 hover:bg-gray-800 text-gray-400"
      >
        <div className="flex items-center gap-2 min-w-0">
          {hasError ? <XCircle size={12} className="text-red-400 flex-shrink-0" /> : <CheckCircle size={12} className="text-green-400 flex-shrink-0" />}
          {mcpServer && (
            <span className="text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded px-1.5 py-0.5 text-xs font-medium flex-shrink-0">{mcpServer}</span>
          )}
          <span className="font-mono truncate">{displayName}</span>
        </div>
        {open ? <ChevronUp size={12} className="flex-shrink-0" /> : <ChevronDown size={12} className="flex-shrink-0" />}
      </button>
      {open && (
        <div className="bg-gray-900 px-3 py-2 space-y-2">
          {args && Object.keys(args).length > 0 && (
            <div>
              <p className="text-gray-500 mb-1">Arguments</p>
              <pre className="text-gray-300 font-mono text-xs overflow-auto max-h-32">{JSON.stringify(args, null, 2)}</pre>
            </div>
          )}
          <div>
            <p className="text-gray-500 mb-1">{hasError ? 'Error' : 'Result'}</p>
            <pre className={cn('font-mono text-xs overflow-auto max-h-40 whitespace-pre-wrap break-words', hasError ? 'text-red-400' : 'text-gray-300')}>
              {formatToolResult(result)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Live tool call (executing right now) ─────────────────────────────────────
function ActiveToolCall({ name, args, result, status, subAgent, serverName }) {
  const [open, setOpen] = useState(false);
  const { displayName, mcpServer } = parseMcpToolName(name, serverName);
  return (
    <div className={cn(
      'flex items-start gap-2 px-3 py-2 rounded-lg border text-xs mt-1',
      subAgent ? 'bg-purple-500/5 border-purple-700/40 ml-4' : 'bg-gray-800/40 border-gray-700/50'
    )}>
      <div className="mt-0.5 flex-shrink-0">
        {status === 'pending' && <Loader size={12} className="text-blue-400 animate-spin" />}
        {status === 'done'    && <CheckCircle size={12} className="text-green-400" />}
        {status === 'error'   && <XCircle size={12} className="text-red-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-gray-300 flex items-center gap-1.5 min-w-0 flex-wrap">
            {subAgent && <span className="text-purple-400 mr-0.5">{subAgent} →</span>}
            {mcpServer && (
              <span className="text-purple-300 bg-purple-500/10 border border-purple-500/20 rounded px-1.5 py-0.5 font-medium not-font-mono">{mcpServer}</span>
            )}
            <span>
              {status === 'pending' && !mcpServer ? 'Calling ' : ''}
              <span className="text-blue-300">{displayName}</span>
            </span>
            {args?.agent_id && <span className="text-gray-500">→ {args.agent_id}</span>}
          </span>
          {result && (
            <button onClick={() => setOpen(!open)} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}
        </div>
        {open && result && (
          <pre className="mt-1 text-gray-400 font-mono overflow-auto max-h-32 whitespace-pre-wrap break-words">{formatToolResult(result)}</pre>
        )}
      </div>
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────
function MessageBubble({ msg, agentName, agentColor }) {
  const isUser = msg.role === 'user';

  // If there's no text but there are tool events, render tool events inline
  // without a bubble wrapper — avoids an empty "(no content)" shell.
  if (!isUser && !msg.content && msg.toolEvents?.length) {
    return (
      <div className="group flex gap-3">
        <AgentAvatar name={agentName} color={agentColor} size={32} />
        <div className="flex-1 flex flex-col gap-1 max-w-[80%]">
          {msg.toolEvents.map((te, i) => (
            <ToolCallCard key={i} name={te.name} args={te.args} result={te.result} serverName={te.serverName} />
          ))}
          {msg.truncated && (
            <div className="text-xs text-amber-500/80 flex items-center gap-1 px-1 mt-0.5">
              <span>⚠</span> Response cut off — increase Max Tokens in agent settings
            </div>
          )}
          {msg.timestamp && <span className="text-xs text-gray-600 px-1">{formatDate(msg.timestamp)}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('group flex gap-3', isUser && 'flex-row-reverse')}>
      {!isUser && <AgentAvatar name={agentName} color={agentColor} size={32} />}
      {isUser && (
        <div className="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center text-xs font-semibold flex-shrink-0 mt-0.5">U</div>
      )}
      <div className={cn('max-w-[80%] flex flex-col gap-1', isUser && 'items-end')}>
        {msg.content && (
          <div className={cn(
            'rounded-2xl px-4 py-2.5 text-sm',
            isUser ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-gray-800 text-gray-100 rounded-tl-sm',
          )}>
            {isUser ? (
              <p className="whitespace-pre-wrap">{msg.content}</p>
            ) : (
              <div className="prose prose-invert prose-sm max-w-none">
                <ReactMarkdown components={{
                  code({ inline, children }) {
                    return inline
                      ? <code className="bg-gray-900 px-1 py-0.5 rounded text-blue-300 font-mono text-xs">{children}</code>
                      : <pre className="bg-gray-900 rounded-lg p-3 overflow-auto my-2"><code className="font-mono text-xs text-gray-300">{children}</code></pre>;
                  },
                }}>{msg.content}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {/* Truncation warning */}
        {msg.truncated && (
          <div className="text-xs text-amber-500/80 flex items-center gap-1 px-1 mt-0.5">
            <span>⚠</span> Response cut off — increase Max Tokens in agent settings
          </div>
        )}

        {/* Tool calls attached to this message */}
        {msg.toolEvents?.map((te, i) => (
          <ToolCallCard key={i} name={te.name} args={te.args} result={te.result} serverName={te.serverName} />
        ))}

        <div className="flex items-center gap-1 px-1">
          {msg.timestamp && <span className="text-xs text-gray-600">{formatDate(msg.timestamp)}</span>}
          {!isUser && <CopyButton text={msg.content || ''} />}
        </div>
      </div>
    </div>
  );
}

// ── Thinking indicator ────────────────────────────────────────────────────────
function ThinkingIndicator({ agentName, agentColor }) {
  return (
    <div className="flex gap-3">
      <AgentAvatar name={agentName} color={agentColor} size={32} />
      <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-4 py-3">
        <div className="flex gap-1.5 items-center">
          {[0, 1, 2].map(i => (
            <div key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main ChatWindow ───────────────────────────────────────────────────────────
const FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB

async function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    if (isImage) {
      reader.onload = () => resolve({ type: 'image', name: file.name, dataUrl: reader.result, mimeType: file.type });
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ type: 'text', name: file.name, content: reader.result });
      reader.readAsText(file);
    }
  });
}

// Build the content array (or plain string) to send to the server for a message with attachments
function buildMessageContent(text, attachments) {
  if (!attachments.length) return text;
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const att of attachments) {
    if (att.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    } else {
      parts.push({ type: 'text', text: `\n\n[Attached file: ${att.name}]\n${att.content}` });
    }
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

export function ChatWindow({ agent, initialMessages, initialSessionId, onSessionSaved, onMessagesChange }) {
  const [messages, setMessages]           = useState(initialMessages || []);
  const [input, setInput]                 = useState('');
  const [phase, setPhase]                 = useState('idle');
  const [streamingText, setStreamingText] = useState('');
  const [liveTools, setLiveTools]         = useState([]);
  const [sessionId, setSessionId]         = useState(initialSessionId || null);
  const [attachments, setAttachments]     = useState([]);
  const [dragOver, setDragOver]           = useState(false);
  const [stats, setStats]                 = useState(null);   // { tps, output_tokens, input_tokens }
  const [ollamaDown, setOllamaDown]       = useState(false);
  const [sessionSaveError, setSessionSaveError] = useState(null);

  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const fileInputRef = useRef(null);
  const { connect, disconnect, wsRef } = useWebSocket(agent.id);

  // Reset when agent changes or new chat triggered externally
  useEffect(() => {
    setMessages(initialMessages || []);
    setSessionId(initialSessionId || null);
    setStreamingText('');
    setLiveTools([]);
    setPhase('idle');
    setSessionSaveError(null);
  }, [agent.id, initialMessages, initialSessionId]);

  // Accumulated tool events ref so async handlers can read latest
  const liveToolsRef = useRef([]);

  useEffect(() => {
    liveToolsRef.current = liveTools;
  }, [liveTools]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, liveTools]);

  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages]);

  const commitStreamingText = useCallback((text, tools, truncated = false) => {
    if (!text && !tools?.length) return;
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: text,
      toolEvents: tools?.length ? [...tools] : undefined,
      truncated,
      timestamp: Date.now(),
    }]);
    setStreamingText('');
    setLiveTools([]);
    liveToolsRef.current = [];
  }, []);

  const addFiles = useCallback(async (files) => {
    const toAdd = [];
    for (const file of files) {
      if (file.size > FILE_SIZE_LIMIT) { toast.error(`${file.name} is too large (max 10 MB)`); continue; }
      try {
        toAdd.push(await readFileAsAttachment(file));
      } catch (e) { toast.error(e.message); }
    }
    if (toAdd.length) setAttachments(prev => [...prev, ...toAdd]);
  }, []);

  const handleFileInput = useCallback((e) => {
    addFiles(Array.from(e.target.files || []));
    e.target.value = '';
  }, [addFiles]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files || []));
  }, [addFiles]);

  const handleSend = useCallback(() => {
    if (!chatSendState({ input, attachments, agent, isActive: phase !== 'idle' }).canSend) return;

    const content = buildMessageContent(input.trim(), attachments);
    // For display: always show text. For images show a placeholder.
    const displayContent = input.trim() || attachments.map(a => `[${a.name}]`).join(' ');
    const userMsg = { role: 'user', content: displayContent, timestamp: Date.now() };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setAttachments([]);
    setPhase('streaming');
    setStreamingText('');
    setLiveTools([]);
    setStats(null);
    setSessionSaveError(null);
    liveToolsRef.current = [];

    let currentText = '';
    let currentTools = [];
    // Text accumulated across all partial rounds (before tool calls).
    // We DON'T commit at done_partial — instead we keep showing it in the
    // streaming bubble during tool execution and fold it into the final commit.
    let priorText = '';

    const ws = connect();

    // Build wire-format messages: use actual content (may be array for multimodal)
    // for the last user message, plain strings for history.
    const wireMessages = [
      ...history.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content },
    ];
    const startFrame = JSON.stringify({
      type: 'chat',
      model: agent.model,
      messages: wireMessages,
      sessionId: sessionId || undefined,
    });
    // connect() may return an already-open socket; onopen won't fire then.
    if (ws.readyState === WebSocket.OPEN) ws.send(startFrame);
    else ws.onopen = () => ws.send(startFrame);

    // Set when the stream reaches a terminal frame (done/stopped/error) so an
    // onclose after normal completion doesn't double-finalize.
    let finished = false;
    const finalize = () => {
      finished = true;
      const finalText = [priorText, currentText].filter(Boolean).join('\n\n');
      commitStreamingText(finalText, currentTools);
      setPhase('idle');
      disconnect();
    };

    ws.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        // One malformed frame must not wedge the stream state machine.
        return;
      }

      if (data.type === 'chunk') {
        currentText += data.content;
        // Show prior text + current round text together so the bubble never blanks out
        const display = priorText ? priorText + '\n\n' + currentText : currentText;
        setStreamingText(display);
        setPhase('streaming');

      } else if (data.type === 'done_partial') {
        // Model is calling a tool. Save any text from this round into priorText
        // so it stays visible in the streaming bubble during tool execution.
        // Do NOT commit to messages yet — we fold everything into the final done commit.
        if (currentText) {
          priorText = priorText ? priorText + '\n\n' + currentText : currentText;
          // Keep streamingText showing the accumulated prior text while tools run
          setStreamingText(priorText);
        }
        currentText = '';
        // currentTools accumulates across rounds
        setPhase('tools');

      } else if (data.type === 'tool_call') {
        const entry = { id: data.id ?? null, name: data.name, args: data.args, result: null, status: 'pending', serverName: data.serverName ?? null };
        currentTools = [...liveToolsRef.current, entry];
        setLiveTools(currentTools);
        liveToolsRef.current = currentTools;

      } else if (data.type === 'tool_result') {
        // Match by call id — two parallel calls to the same tool must not both
        // receive the first result. Fall back to the first pending name match
        // for frames without an id.
        let matched = false;
        currentTools = liveToolsRef.current.map(t => {
          if (matched || t.status !== 'pending' || t.subAgent) return t;
          const isMatch = data.id != null ? t.id === data.id : t.name === data.name;
          if (!isMatch) return t;
          matched = true;
          return { ...t, result: data.result, status: data.result?.error ? 'error' : 'done' };
        });
        setLiveTools(currentTools);
        liveToolsRef.current = currentTools;

      } else if (data.type === 'sub_tool_call') {
        const entry = { name: data.name, args: data.args, result: null, status: 'pending', subAgent: data.subAgent };
        currentTools = [...liveToolsRef.current, entry];
        setLiveTools(currentTools);
        liveToolsRef.current = currentTools;

      } else if (data.type === 'sub_tool_result') {
        currentTools = liveToolsRef.current.map(t =>
          t.name === data.name && t.status === 'pending' && t.subAgent === data.subAgent
            ? { ...t, result: data.result, status: data.result?.error ? 'error' : 'done' }
            : t
        );
        setLiveTools(currentTools);
        liveToolsRef.current = currentTools;

      } else if (data.type === 'stats') {
        setStats({ tps: data.tps, output_tokens: data.output_tokens, input_tokens: data.input_tokens });

      } else if (data.type === 'session_save_error') {
        const msg = data.message || 'Response generated, but Hive could not save it to chat history.';
        setSessionSaveError(msg);
        toast.error(msg);

      } else if (data.type === 'done') {
        setOllamaDown(false);
        finished = true;
        // Combine prior-round text with final-round text into one commit
        const finalText = [priorText, currentText].filter(Boolean).join('\n\n');
        commitStreamingText(finalText, currentTools, data.truncated);
        if (data.sessionId) {
          setSessionId(data.sessionId);
          onSessionSaved?.(data.sessionId);
        }
        setPhase('idle');
        disconnect();

      } else if (data.type === 'stopped') {
        finalize();

      } else if (data.type === 'error') {
        const msg = data.message || '';
        if (msg.includes('Ollama') || msg.includes('fetch') || msg.includes('ECONNREFUSED')) {
          setOllamaDown(true);
        }
        toast.error(msg || 'Error during generation');
        finalize();
      }
    };

    ws.onerror = () => {
      setOllamaDown(true);
      toast.error('Connection failed — is Ollama running?');
      finalize();
    };

    // A drop without a terminal frame (server restart, network blip) must not
    // leave the input disabled in a stuck 'streaming' phase.
    ws.onclose = () => {
      if (finished) return;
      toast.error('Connection to Hive closed unexpectedly');
      finalize();
    };
  }, [input, attachments, messages, phase, agent, sessionId, connect, disconnect, commitStreamingText, onSessionSaved]);

  const handleStop = useCallback(() => {
    // Use the live socket ref — opening a fresh connection here could never
    // carry the stop to the in-flight run.
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
  }, [wsRef]);

  // Escape stops generation
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && phase !== 'idle') handleStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, handleStop]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const isActive = phase !== 'idle';

  return (
    <div className="flex flex-col h-full">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <AgentAvatar name={agent.name} color={agent.avatar_color} size={56} />
            <div>
              <p className="text-lg font-semibold text-gray-200">{agent.name}</p>
              <p className="text-sm text-gray-500 mt-1">{agent.description || 'Ready to chat'}</p>
              {agent.tools?.length > 0 && (
                <p className="text-xs text-blue-400 mt-2 flex items-center justify-center gap-1">
                  <Wrench size={11} /> Agent management &amp; collaboration tools enabled
                </p>
              )}
            </div>
            <p className="text-xs text-gray-600">Press Enter to send · Shift+Enter for newline</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} agentName={agent.name} agentColor={agent.avatar_color} />
        ))}

        {/* Live streaming assistant bubble — visible during both streaming and tools phases */}
        {(phase === 'streaming' || phase === 'tools') && !streamingText && (
          <ThinkingIndicator agentName={agent.name} agentColor={agent.avatar_color} />
        )}
        {(phase === 'streaming' || phase === 'tools') && streamingText && (
          <MessageBubble
            msg={{ role: 'assistant', content: streamingText }}
            agentName={agent.name}
            agentColor={agent.avatar_color}
          />
        )}

        {/* Live tool calls */}
        {phase === 'tools' && liveTools.length > 0 && (
          <div className="flex gap-3">
            <AgentAvatar name={agent.name} color={agent.avatar_color} size={32} />
            <div className="flex-1 flex flex-col gap-1 max-w-[80%]">
              {liveTools.map((tc, i) => (
                <ActiveToolCall key={i} {...tc} />
              ))}
            </div>
          </div>
        )}
        {phase === 'tools' && liveTools.length === 0 && (
          <ThinkingIndicator agentName={agent.name} agentColor={agent.avatar_color} />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Ollama unreachable banner */}
      {ollamaDown && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-yellow-500/10 border-t border-yellow-500/30 text-yellow-400 text-xs">
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>Ollama is not responding. Start it with <code className="bg-yellow-500/20 px-1 rounded font-mono">ollama serve</code> then try again.</span>
          <button onClick={() => setOllamaDown(false)} className="ml-auto text-yellow-500/60 hover:text-yellow-300"><X size={13} /></button>
        </div>
      )}

      {sessionSaveError && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 bg-red-500/10 border-t border-red-500/30 text-red-300 text-xs">
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>{sessionSaveError}</span>
          <button onClick={() => setSessionSaveError(null)} className="ml-auto text-red-400/70 hover:text-red-200"><X size={13} /></button>
        </div>
      )}

      {/* Generation stats bar */}
      {stats && !isActive && (
        <div className="flex items-center gap-3 px-4 py-1.5 border-t border-gray-800/50 text-xs text-gray-600">
          <Zap size={11} className="text-gray-700" />
          <span>{stats.tps} tok/s</span>
          {stats.input_tokens && <span>{stats.input_tokens.toLocaleString()} in</span>}
          {stats.output_tokens && <span>{stats.output_tokens.toLocaleString()} out</span>}
        </div>
      )}

      {/* Input bar */}
      <div
        className={cn('border-t border-gray-800 p-4 transition-colors', dragOver && 'bg-blue-500/5 border-blue-500/40')}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-2">
            {attachments.map((att, i) => (
              <div key={i} className="flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300">
                {att.type === 'image' ? <Image size={11} className="text-blue-400" /> : <FileText size={11} className="text-green-400" />}
                <span className="max-w-[120px] truncate">{att.name}</span>
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))} className="text-gray-500 hover:text-gray-200 ml-0.5">
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} accept="image/*,text/*,.md,.json,.csv,.yaml,.yml,.toml,.py,.js,.ts,.jsx,.tsx,.html,.css,.sh" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isActive}
            className="p-2 text-gray-500 hover:text-gray-300 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-30 flex-shrink-0"
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={dragOver ? 'Drop files here…' : (agent.model ? 'Message…' : 'No model assigned — edit this agent first')}
            rows={1}
            disabled={!agent.model || isActive}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[46px] max-h-32 overflow-y-auto disabled:opacity-50"
            onInput={e => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
          />
          {isActive ? (
            <Button variant="danger" size="icon" onClick={handleStop} title="Stop generation (Esc)">
              <Square size={16} />
            </Button>
          ) : (
            <Button size="icon" onClick={handleSend} disabled={!chatSendState({ input, attachments, agent, isActive }).canSend} title="Send (Enter)">
              <Send size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
