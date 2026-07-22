import { useState } from 'react';
import {
  Zap, Square, Trash2, ChevronDown, ChevronRight, Terminal, FileText,
  MessageSquare, Wrench, Clock, CheckCircle2, XCircle, Loader2, Users,
  Server, Download, Filter, ArrowRight, AlertTriangle, Flag, ShieldCheck,
  Link2, GitBranch, ExternalLink, ArrowLeft, X, BarChart3, Package,
  Plus, Search, Inbox, Play, Sparkles, ListTodo, RefreshCw,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/ui/Button';
import {
  ITEM_STATUS_META,
  PROVIDER_LABEL,
  STATUS_DOT,
  STATUS_TEXT,
  TEAM_STATUS_META,
  prettyToolName,
  ts,
} from './helpers';

// Links in deliverables, artifacts, and parsed goal text are LLM-controlled;
// only render them as real anchors when they're http(s). A prompt-injected
// "javascript:" URL would otherwise execute in the app origin on click.
// Markdown renderer for agent messages — models emit **bold**, lists, and code
// fences which previously rendered as raw text. Elements are styled explicitly
// (NOT via `prose` — the Tailwind typography plugin isn't installed, so prose
// classes silently do nothing and lists lose their bullets).
export function AgentMarkdown({ children }) {
  // remark-gfm autolinks bare URLs, and renders tables/strikethrough — no need
  // for the old hand-rolled linkify pass (which corrupted URLs inside code).
  const text = String(children ?? '');
  return (
    <div className="max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        p: ({ children: kids }) => <p className="my-1.5 leading-relaxed">{kids}</p>,
        ul: ({ children: kids }) => <ul className="my-1.5 ml-1 pl-4 list-disc space-y-1 marker:text-gray-600">{kids}</ul>,
        ol: ({ children: kids }) => <ol className="my-1.5 ml-1 pl-4 list-decimal space-y-1 marker:text-gray-600">{kids}</ol>,
        li: ({ children: kids }) => <li className="leading-relaxed">{kids}</li>,
        strong: ({ children: kids }) => <strong className="font-semibold text-inherit brightness-125">{kids}</strong>,
        h1: ({ children: kids }) => <p className="mt-3 mb-1 font-semibold text-sm">{kids}</p>,
        h2: ({ children: kids }) => <p className="mt-3 mb-1 font-semibold">{kids}</p>,
        h3: ({ children: kids }) => <p className="mt-2.5 mb-1 font-semibold">{kids}</p>,
        a: ({ href, children: kids }) => <a href={href} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline break-all">{kids}</a>,
        blockquote: ({ children: kids }) => <blockquote className="border-l-2 border-gray-700 pl-2 my-1.5 text-gray-500">{kids}</blockquote>,
        hr: () => <div className="border-t border-gray-800 my-2" />,
        table: ({ children: kids }) => <table className="my-1.5 text-xs border-collapse">{kids}</table>,
        th: ({ children: kids }) => <th className="border border-gray-800 px-2 py-1 text-left font-medium">{kids}</th>,
        td: ({ children: kids }) => <td className="border border-gray-800 px-2 py-1">{kids}</td>,
        // react-markdown v10 dropped the `inline` prop; detect block code by its
        // language-* className or an embedded newline, and style the <pre> wrapper
        // separately so blocks aren't rendered nested inside a default <pre>.
        pre: ({ children: kids }) => <pre className="bg-gray-900 rounded-lg p-3 overflow-auto my-2">{kids}</pre>,
        code({ className, children: kids }) {
          const isBlock = /language-/.test(className || '') || String(kids).includes('\n');
          return isBlock
            ? <code className="font-mono text-xs text-gray-300">{kids}</code>
            : <code className="bg-gray-900 px-1 py-0.5 rounded text-blue-300 font-mono text-xs">{kids}</code>;
        },
      }}>{text}</ReactMarkdown>
    </div>
  );
}
// ── Badges + UI atoms ─────────────────────────────────────────────────────────

function AgentBadge({ name, color, active, onClick }) {
  const className = `inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold flex-shrink-0 transition-opacity ${active === false ? 'opacity-30' : ''}`;
  const style = { background: `${color}20`, color, border: `1px solid ${color}40` };

  if (!onClick) {
    return <span className={className} style={style}>{name}</span>;
  }

  return <button onClick={onClick} className={className} style={style}>{name}</button>;
}

function TimeStamp({ entry }) {
  const t = ts(entry);
  if (!t) return null;
  return <span className="text-gray-700 tabular-nums flex-shrink-0">{t}</span>;
}

// ── File card (write_file) ─────────────────────────────────────────────────────

function FileCard({ args, result }) {
  const [open, setOpen] = useState(false);
  const ok = result?.success !== false && !result?.error;
  return (
    <div className="rounded border border-gray-800 bg-gray-900/60 overflow-hidden my-0.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs text-left hover:bg-gray-800/40 transition-colors"
      >
        {open ? <ChevronDown size={10} className="flex-shrink-0" /> : <ChevronRight size={10} className="flex-shrink-0" />}
        <FileText size={11} className="text-blue-400 flex-shrink-0" />
        <span className="font-mono text-gray-300 truncate flex-1">{args?.path || 'file'}</span>
        {ok
          ? <CheckCircle2 size={10} className="text-green-500 flex-shrink-0" />
          : <XCircle size={10} className="text-red-400 flex-shrink-0" />}
      </button>
      {open && args?.content && (
        <pre className="text-xs font-mono bg-gray-950 px-3 py-2 text-gray-400 overflow-x-auto max-h-48 whitespace-pre-wrap break-words border-t border-gray-800">
          {String(args.content).slice(0, 3000)}
        </pre>
      )}
    </div>
  );
}

// ── Server card (start_server) ─────────────────────────────────────────────────

function ServerCard({ args, result }) {
  const port = result?.port || args?.port;
  const url = port ? `http://localhost:${port}` : null;
  const ok = result?.success !== false && !result?.error;
  return (
    <div className="flex items-center gap-2 rounded border border-gray-800 bg-gray-900/60 px-2.5 py-1.5 my-0.5">
      <Server size={11} className={ok ? 'text-green-400' : 'text-red-400'} />
      <span className="text-xs text-gray-400 flex-1">{args?.command || 'server started'}</span>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-blue-400 hover:text-blue-300 font-mono underline flex-shrink-0"
        >
          :{port}
        </a>
      )}
      {ok
        ? <CheckCircle2 size={10} className="text-green-500 flex-shrink-0" />
        : <XCircle size={10} className="text-red-400 flex-shrink-0" />}
    </div>
  );
}

// ── Readable args/result rendering ─────────────────────────────────────────────
// Tool args and results used to render as JSON.stringify blobs — escaped \n and
// \" made worker responses unreadable. These views unescape strings, render the
// worker's response as markdown, and fall back to compact key/value rows.

function TextBlock({ children, tone = 'text-gray-400' }) {
  return (
    <pre className={`text-xs font-mono bg-gray-900 rounded p-2 ${tone} overflow-y-auto max-h-64 whitespace-pre-wrap break-words`}>
      {String(children).slice(0, 6000)}
    </pre>
  );
}

export function KVRows({ obj, skip = [] }) {
  const keys = Object.keys(obj || {}).filter(k => !skip.includes(k) && obj[k] !== undefined && obj[k] !== null);
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 bg-gray-900 rounded p-2 overflow-y-auto max-h-64">
      {keys.map(k => {
        const v = obj[k];
        const isLongStr = typeof v === 'string' && (v.length > 80 || v.includes('\n'));
        const isComplex = typeof v === 'object'; // arrays + objects → pretty-print
        const inline = !isLongStr && !isComplex;
        return (
          <div key={k} className="text-xs min-w-0">
            <span className="font-mono text-gray-500">{k}:</span>{' '}
            {inline && <span className="text-gray-300 break-words">{typeof v === 'string' ? v : String(v)}</span>}
            {isLongStr && <pre className="mt-0.5 font-mono text-gray-400 whitespace-pre-wrap break-words">{v.slice(0, 4000)}</pre>}
            {isComplex && (
              <pre className="mt-0.5 font-mono text-gray-400 whitespace-pre-wrap break-words">
                {JSON.stringify(v, null, 2).slice(0, 4000)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ToolArgsView({ tool, args }) {
  if (!args || Object.keys(args).length === 0) return null;
  if (tool === 'ask_agent') {
    return (
      <div className="bg-gray-900 rounded p-2 text-xs">
        {args.message && <p className="text-gray-300 whitespace-pre-wrap break-words">{String(args.message).slice(0, 2000)}</p>}
        {args.context && <p className="mt-1 text-gray-600 whitespace-pre-wrap break-words">context: {String(args.context).slice(0, 600)}</p>}
      </div>
    );
  }
  if (tool === 'blackboard_write' && args.content) {
    return <TextBlock>{args.content}</TextBlock>;
  }
  return <KVRows obj={args} />;
}

function ToolResultView({ tool, result }) {
  if (result === undefined || result === null) return null;
  if (typeof result === 'string') return <TextBlock tone="text-gray-300">{result}</TextBlock>;

  if (result.error) {
    return <TextBlock tone="text-red-300">{typeof result.error === 'string' ? result.error : JSON.stringify(result.error, null, 2)}</TextBlock>;
  }

  if (tool === 'ask_agent') {
    return (
      <div className="bg-gray-900 rounded p-2 flex flex-col gap-1.5 overflow-y-auto max-h-96">
        {result.response && (
          <div className="text-xs text-gray-300 font-sans">
            <AgentMarkdown>{String(result.response)}</AgentMarkdown>
          </div>
        )}
        {result.auto_handoff && (
          <p className="text-xs text-indigo-300">
            ⇢ handoff auto-recorded: {result.auto_handoff.from} → {result.auto_handoff.to} ({result.auto_handoff.contract})
          </p>
        )}
        {result.flow_hint && <p className="text-xs text-amber-300/90">{result.flow_hint}</p>}
        {result.warning && <p className="text-xs text-amber-300/90">{result.warning}</p>}
        {result.note && !result.auto_handoff && <p className="text-xs text-gray-500 italic">{result.note}</p>}
      </div>
    );
  }

  if (tool === 'handoff') {
    if (result.ok === false) return <TextBlock tone="text-amber-300">{result.reason || 'protocol violation'}</TextBlock>;
    const cmd = result.command || {};
    return (
      <div className="bg-gray-900 rounded p-2 text-xs flex flex-col gap-1">
        <p className="text-gray-300">
          <span className="text-green-400">{result.status || 'accepted'}</span>
          {cmd.from && cmd.target_agent && <span className="text-gray-400"> · {cmd.from} → {cmd.target_agent}</span>}
          {cmd.contract && <span className="text-gray-600"> ({cmd.contract})</span>}
        </p>
        {cmd.summary && <p className="text-gray-400 whitespace-pre-wrap break-words">{String(cmd.summary).slice(0, 2000)}</p>}
      </div>
    );
  }

  // Plan tools: render steps as a checklist, not a JSON array.
  const planSteps = Array.isArray(result.steps) ? result.steps : (Array.isArray(result.plan?.steps) ? result.plan.steps : null);
  if ((tool === 'set_plan' || tool === 'update_plan_step' || tool === 'add_plan_step') && planSteps) {
    return (
      <div className="bg-gray-900 rounded p-2 flex flex-col gap-0.5 overflow-y-auto max-h-64">
        {result.note && <p className="text-xs text-gray-500 italic mb-1">{result.note}</p>}
        {planSteps.map((s, i) => (
          <p key={s.id || i} className="text-xs min-w-0 break-words">
            <span className="text-gray-600 font-mono">{s.id}.</span>{' '}
            <span className={s.status === 'done' ? 'text-green-400' : s.status === 'in_progress' ? 'text-blue-300' : s.status === 'blocked' ? 'text-red-300' : 'text-gray-500'}>
              [{s.status || 'pending'}]
            </span>{' '}
            <span className="text-gray-300">{s.description}</span>
            {s.assigned_to && <span className="text-gray-600"> → {s.assigned_to}</span>}
          </p>
        ))}
      </div>
    );
  }

  if (tool === 'blackboard_read' && Array.isArray(result.entries)) {
    if (result.entries.length === 0) return <TextBlock>no entries</TextBlock>;
    return (
      <div className="bg-gray-900 rounded p-2 flex flex-col gap-1 overflow-y-auto max-h-64">
        {result.note && <p className="text-xs text-gray-500 italic">{result.note}</p>}
        {result.entries.map((e, i) => (
          <div key={i} className="text-xs min-w-0">
            <span className="text-gray-500">{e.agent}</span>{' '}
            <span className="text-gray-600">[{e.entry_type}]</span>{' '}
            <span className="text-gray-400 whitespace-pre-wrap break-words">{String(e.content || '').slice(0, 600)}</span>
          </div>
        ))}
      </div>
    );
  }

  // Generic: unescaped key/value rows instead of a JSON blob.
  return <KVRows obj={result} />;
}

// ── Generic tool call entry ───────────────────────────────────────────────────

function ToolCallEntry({ entry }) {
  const [open, setOpen] = useState(false);
  // Display + classify by the un-prefixed tool name so MCP tools ("xxx__write_file")
  // read cleanly and get the same treatment as built-ins.
  const toolName = prettyToolName(entry.tool);
  const isFile = ['write_file', 'read_file'].includes(toolName);
  const isShell = ['shell', 'run_python', 'run_bash'].includes(toolName);
  const isServer = toolName === 'start_server';
  const icon = isFile ? <FileText size={11} /> : isShell ? <Terminal size={11} /> : isServer ? <Server size={11} /> : <Wrench size={11} />;

  if (toolName === 'write_file' && entry.args?.path) {
    return <FileCard args={entry.args} result={entry.result} />;
  }
  if (toolName === 'start_server') {
    return <ServerCard args={entry.args} result={entry.result} />;
  }

  const ok = entry.result?.exitCode === 0 || entry.result?.success;
  const err = !!entry.result?.error || entry.result?.exitCode > 0;

  return (
    <div className="pl-2 border-l-2 border-gray-800 my-0.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors w-full text-left py-0.5"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {icon}
        <span className="font-mono text-gray-400" title={entry.tool}>{toolName}</span>
        {isShell && entry.args?.command && (
          <span className="text-gray-600 font-mono truncate max-w-xs">{String(entry.args.command).slice(0, 70)}</span>
        )}
        {entry.tool === 'ask_agent' && entry.args?.message && (
          <span className="text-gray-600 italic truncate max-w-xs">
            {entry.result?.agent_name ? `${entry.result.agent_name} · ` : ''}{String(entry.args.message).slice(0, 60)}
          </span>
        )}
        {entry.result !== undefined && (
          ok ? <CheckCircle2 size={10} className="text-green-500 ml-auto flex-shrink-0" />
            : err ? <XCircle size={10} className="text-red-400 ml-auto flex-shrink-0" /> : null
        )}
        {entry.result === undefined && <Loader2 size={9} className="animate-spin text-gray-700 ml-auto flex-shrink-0" />}
      </button>
      {/* Collapsed preview: the worker's reply is the run's real content — show
          the first line so the log reads as a narrative without expanding. */}
      {!open && entry.tool === 'ask_agent' && typeof entry.result?.response === 'string' && entry.result.response !== '(no response)' && (
        <p className="text-xs text-gray-500 truncate pl-5 pb-0.5">{entry.result.response.replace(/\s+/g, ' ').slice(0, 140)}</p>
      )}
      {open && (
        <div className="mt-1 mb-1 flex flex-col gap-1">
          <ToolArgsView tool={entry.tool} args={entry.args} />
          <ToolResultView tool={entry.tool} result={entry.result} />
        </div>
      )}
    </div>
  );
}

// ── Single log row ────────────────────────────────────────────────────────────

export function LogEntry({ entry, agentColorMap }) {
  const color = agentColorMap[entry.agent] || '#6b7280';

  if (entry.type === 'system') {
    return (
      <div className="flex items-center gap-2 py-1.5 text-xs text-gray-600">
        <div className="flex-1 border-t border-gray-800" />
        <span>{entry.message}</span>
        <div className="flex-1 border-t border-gray-800" />
      </div>
    );
  }

  if (entry.type === 'agent_ready') {
    return (
      <div className="flex items-center gap-2 py-1">
        <TimeStamp entry={entry} />
        <span className="text-xs text-gray-700">{entry.role === 'orchestrator' ? '⬡' : '⬢'}</span>
        <AgentBadge name={entry.agent} color={color} />
        <span className="text-xs text-gray-600">{entry.role === 'orchestrator' ? 'orchestrator' : 'worker'} created</span>
      </div>
    );
  }

  if (entry.type === 'tool_call' || entry.type === 'sub_tool_call') {
    return (
      <div className="flex items-start gap-2 py-0.5">
        <TimeStamp entry={entry} />
        <AgentBadge name={entry.agent} color={color} />
        <div className="flex-1 min-w-0">
          <ToolCallEntry entry={entry} />
        </div>
      </div>
    );
  }

  if (entry.type === 'message') {
    return (
      <div className="flex items-start gap-2 py-2">
        <TimeStamp entry={entry} />
        <AgentBadge name={entry.agent} color={color} />
        <div className="text-sm text-gray-300 leading-relaxed flex-1 min-w-0 font-sans">
          <AgentMarkdown>{entry.content}</AgentMarkdown>
        </div>
      </div>
    );
  }

  if (entry.type === 'thinking') {
    return (
      <div className="flex items-start gap-2 py-1.5">
        <TimeStamp entry={entry} />
        <AgentBadge name={entry.agent} color={color} />
        <details className="flex-1 min-w-0 rounded-md border border-gray-800 bg-gray-950/30 px-2 py-1.5">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 font-sans">
            model thinking{entry.truncated ? ' (truncated)' : ''}
          </summary>
          <pre className="mt-1.5 text-xs text-gray-500 italic whitespace-pre-wrap break-words font-sans leading-relaxed">
            {entry.content}
          </pre>
        </details>
      </div>
    );
  }

  if (entry.type === 'round') {
    return (
      <div className="py-2 text-xs text-gray-600 flex items-center gap-2">
        <div className="flex-1 border-t border-gray-800/80" />
        <span className="px-2">— Round {entry.round} —</span>
        <div className="flex-1 border-t border-gray-800/80" />
      </div>
    );
  }

  if (entry.type === 'handoff') {
    const held = entry.requires_human && entry.status === 'awaiting_human';
    return (
      <div className="flex items-center gap-2 py-1.5">
        <TimeStamp entry={entry} />
        {held
          ? <Flag size={13} className="text-amber-400 flex-shrink-0" />
          : <ArrowRight size={13} className="text-indigo-400 flex-shrink-0" />}
        <span className="text-xs text-gray-300">
          <span className="font-medium text-gray-200">{entry.from}</span>
          <ArrowRight size={11} className="inline mx-1 text-gray-600" />
          <span className="font-medium text-gray-200">{entry.to}</span>
          {entry.contract && <span className="text-gray-500"> · {entry.contract}</span>}
        </span>
        {held && (
          <span className="ml-1 rounded border border-amber-700/50 bg-amber-950/30 px-1.5 py-0.5 text-xs text-amber-300">
            awaiting human approval
          </span>
        )}
      </div>
    );
  }

  if (entry.type === 'protocol_violation') {
    return (
      <div className="flex items-start gap-2 py-1.5">
        <AlertTriangle size={13} className="text-amber-400 flex-shrink-0 mt-0.5" />
        <span className="text-xs text-amber-300/90">
          {entry.agent && <span className="font-medium text-amber-200">{entry.agent}: </span>}
          Protocol violation — {entry.reason}
        </span>
      </div>
    );
  }

  if (entry.type === 'permission_required') {
    return (
      <div className="flex items-start gap-2 py-1.5 px-2 rounded-md border border-red-900/40 bg-red-950/20">
        <XCircle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
        <span className="text-xs text-red-300/90">
          <span className="font-medium text-red-200">Permission needed{entry.tool ? ` · ${entry.tool}` : ''}: </span>
          {entry.message} — enable the credential/scope, then re-run. (Not retrying.)
        </span>
      </div>
    );
  }

  if (entry.type === 'direction') {
    return (
      <div className="flex items-start gap-2 py-1.5 px-2 rounded-md border border-blue-900/40 bg-blue-950/20">
        <MessageSquare size={13} className="text-blue-300 flex-shrink-0 mt-0.5" />
        <span className="text-xs text-blue-200/90">
          <span className="font-medium">{entry.status === 'delivered' ? 'Delivered to operator' : 'Direction queued'}: </span>
          {entry.content}
          {entry.target_role && <span className="text-blue-300/70"> → {entry.target_role}</span>}
        </span>
      </div>
    );
  }

  if (entry.type === 'bootstrap') {
    return (
      <div className="flex items-start gap-2 py-1.5 px-2 rounded-md border border-amber-900/40 bg-amber-950/20">
        <FileText size={13} className="text-amber-300 flex-shrink-0 mt-0.5" />
        <span className="text-xs text-amber-200/90">
          <span className="font-medium">Bootstrap {entry.status}: </span>
          {entry.message || `${entry.task_count || 0} task(s) drafted${entry.source ? ` from ${entry.source}` : ''}`}
        </span>
      </div>
    );
  }

  if (entry.type === 'checkpoint' || entry.type === 'blackboard') {
    const isCheckpoint = entry.type === 'checkpoint';
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-gray-600">
        <Flag size={11} className="flex-shrink-0 text-gray-700" />
        <span>{entry.agent || 'agent'}</span>
        <span className="text-gray-700">
          {isCheckpoint ? 'saved a checkpoint' : `wrote to blackboard${entry.entry_type ? ` (${entry.entry_type})` : ''}`}
        </span>
      </div>
    );
  }

  if (entry.type === 'done') {
    const failed = entry.status === 'failed' || entry.status === 'blocked';
    return (
      <div className="flex items-center gap-2 py-2">
        {failed ? <XCircle size={14} className="text-red-400 flex-shrink-0" /> : <CheckCircle2 size={14} className="text-green-400 flex-shrink-0" />}
        <span className={`text-sm font-medium ${failed ? 'text-red-400' : 'text-green-400'}`}>
          {entry.status === 'stopped' ? 'Colony stopped' : entry.status === 'blocked' ? 'Colony blocked' : entry.status === 'failed' ? 'Colony failed' : 'Colony complete'}
        </span>
      </div>
    );
  }

  if (entry.type === 'error') {
    return (
      <div className="flex items-center gap-2 py-1">
        <XCircle size={13} className="text-red-400 flex-shrink-0" />
        <span className="text-sm text-red-400">{entry.content}</span>
      </div>
    );
  }

  return null;
}
