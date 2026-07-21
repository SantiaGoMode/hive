import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Zap, Square, Trash2, ChevronDown, ChevronRight, Terminal, FileText,
  MessageSquare, Wrench, Clock, CheckCircle2, XCircle, Loader2, Users,
  Server, Download, Filter, ArrowRight, AlertTriangle, Flag, ShieldCheck,
  Link2, GitBranch, ExternalLink, ArrowLeft, X, BarChart3, Package,
  Plus, Search, Inbox, Play, Sparkles, ListTodo, RefreshCw,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, downloadAuthenticated } from '../../lib/api';
import { useAuthenticatedUrl } from '../../hooks/useAuthenticatedUrl';
import { Button } from '../../components/ui/Button';
import { formatDate } from '../../lib/utils';
import { mergeToolEntries } from '../../lib/colonyUtils';
import {
  ITEM_STATUS_META,
  PROVIDER_LABEL,
  STATUS_DOT,
  STATUS_TEXT,
  TEAM_STATUS_META,
  fmtDuration,
  formatSummaryMarkdown,
  parseBoardGoal,
  prettyToolName,
  runLabel,
  ts,
} from './helpers';

// Links in deliverables, artifacts, and parsed goal text are LLM-controlled;
// only render them as real anchors when they're http(s). A prompt-injected
// "javascript:" URL would otherwise execute in the app origin on click.
const isSafeUrl = (u) => /^https?:\/\//i.test(String(u || ''));

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

function LogEntry({ entry, agentColorMap }) {
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

// ── Colony live/replay view ────────────────────────────────────────────────────

// Work item details rendered as a full-width band under the page title: chips
// inline, description/criteria behind a one-line expandable row.
// Normalized fuzzy match between a board criterion and a QA-reported one.
function criterionVerdict(criterion, acceptance) {
  if (!Array.isArray(acceptance)) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  const c = norm(criterion);
  return acceptance.find(r => {
    const rc = norm(r.criterion);
    return rc === c || rc.includes(c) || c.includes(rc);
  }) || null;
}

function WorkItemHeader({ goal, acceptance = null }) {
  const [open, setOpen] = useState(false);
  const item = parseBoardGoal(goal);
  if (!item) {
    const text = String(goal || '');
    if (text.length < 90 && !text.includes('\n')) return null; // header title already shows it
    return (
      <div className="mt-1 min-w-0">
        <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300">
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} mission details
        </button>
        {open && <p className="mt-1 text-xs text-gray-400 leading-relaxed whitespace-pre-wrap">{text}</p>}
      </div>
    );
  }
  const { fields, description, criteria } = item;
  const chips = [
    fields.Repository && `${fields.Repository}${fields.Number ? ` ${fields.Number}` : ''}`,
    fields.Type,
    fields.Status && `status: ${fields.Status}`,
    fields['Board status'] && `board: ${fields['Board status']}`,
  ].filter(Boolean);
  return (
    <div className="mt-1 min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((c, i) => (
          <span key={i} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-500">{c}</span>
        ))}
        {fields.URL && isSafeUrl(fields.URL) && (
          <a href={fields.URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline">
            <ExternalLink size={10} /> {fields.Number || 'open'}
          </a>
        )}
        {(description || criteria.length > 0) && (
          <button onClick={() => setOpen(o => !o)} className="flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-300">
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} details
          </button>
        )}
      </div>
      {open && (
        <div className="mt-1.5">
          {description && <p className="text-xs text-gray-400 leading-relaxed">{description}</p>}
          {criteria.length > 0 && (
            <div className="mt-1.5">
              <p className="text-xs font-medium text-gray-500 mb-0.5">
                Acceptance criteria
                {acceptance && <span className="ml-1.5 text-gray-600 font-normal">— validated by QA</span>}
              </p>
              <ul className="flex flex-wrap gap-x-4 gap-y-0.5">
                {criteria.map((c, i) => {
                  const v = criterionVerdict(c, acceptance);
                  const icon = v?.status === 'pass'
                    ? <CheckCircle2 size={11} className="text-green-400 flex-shrink-0 mt-0.5" />
                    : v?.status === 'fail'
                      ? <XCircle size={11} className="text-red-400 flex-shrink-0 mt-0.5" />
                      : <div className="w-2.5 h-2.5 rounded-full border border-gray-600 flex-shrink-0 mt-0.5" />;
                  return (
                    <li key={i} title={v?.evidence ? `${v.status}: ${v.evidence}` : 'not yet validated'} className={`flex items-start gap-1.5 text-xs ${v?.status === 'pass' ? 'text-gray-400' : v?.status === 'fail' ? 'text-red-300' : 'text-gray-400'}`}>
                      {icon} {c}
                      {v?.status === 'fail' && <span className="text-red-400/70">(failed)</span>}
                      {!v && acceptance && <span className="text-gray-600">(not verified)</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Plan rendered as a slim horizontal strip above the output: progress bar plus
// wrapping step chips — minimal vertical footprint.
function PlanStrip({ plan }) {
  // Click a step chip to expand it to its full text (and note); click again to collapse.
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const toggleStep = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const done = plan.steps.filter(s => s.status === 'done').length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const iconFor = (status) => {
    if (status === 'done') return <CheckCircle2 size={11} className="text-green-400 flex-shrink-0" />;
    if (status === 'in_progress') return <Loader2 size={11} className="text-blue-400 animate-spin flex-shrink-0" />;
    if (status === 'blocked') return <XCircle size={11} className="text-red-400 flex-shrink-0" />;
    return <div className="w-2.5 h-2.5 rounded-full border border-gray-600 flex-shrink-0" />;
  };
  const chipColor = (status) => {
    if (status === 'done') return 'border-green-900/50 text-gray-500';
    if (status === 'in_progress') return 'border-blue-800/60 text-blue-300';
    if (status === 'blocked') return 'border-red-900/60 text-red-300';
    return 'border-gray-800 text-gray-400';
  };
  return (
    <div className="mb-2 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-300 flex-shrink-0">Plan</span>
        <div className="h-1 bg-gray-800 rounded overflow-hidden flex-1">
          <div className="h-full bg-green-500/70 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-gray-500 tabular-nums flex-shrink-0">{done}/{total} · {pct}%</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {plan.steps.map(step => {
          const expanded = expandedIds.has(step.id);
          return (
            <button
              key={step.id}
              onClick={() => toggleStep(step.id)}
              title={expanded ? 'Collapse' : `${step.description}${step.note ? `\n${step.note}` : ''}`}
              className={`flex items-start gap-1 rounded border bg-gray-950/40 px-1.5 py-0.5 text-xs text-left cursor-pointer hover:bg-gray-900 transition-colors ${expanded ? 'basis-full' : 'max-w-[16rem]'} ${chipColor(step.status)}`}
            >
              <span className="mt-0.5">{iconFor(step.status)}</span>
              {expanded ? (
                <span className="min-w-0">
                  <span className="break-words">{step.id}. {step.description}</span>
                  {step.assigned_to && <span className="text-gray-600"> → {step.assigned_to}</span>}
                  {step.note && <span className="block text-gray-500 italic mt-0.5 break-words">{step.note}</span>}
                </span>
              ) : (
                <span className="truncate">{step.id}. {step.description}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CrewRoster({ colony, log, agentColorMap, filterAgent, onFilterAgent }) {
  const [open, setOpen] = useState(false);
  const initials = (name) => String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || '?';

  // Blackboard entries ARE the workers' notes. They're recorded under the role
  // display name ("Software Developer"), not the persona name ("Sam Rivera"),
  // so they're matched to crew members by role OR name below. (The old "0 notes"
  // counted `message` log entries, which only the orchestrator emits.)
  const [bbEntries, setBbEntries] = useState([]);
  const running = colony?.status === 'running';
  const colonyId = colony?.id;
  const logLength = (log || []).length;
  const loadBb = useCallback(() => {
    if (!colonyId) return;
    api.getColonyBlackboard(colonyId)
      .then(data => setBbEntries(data.entries || []))
      .catch(() => {});
  }, [colonyId]);
  useEffect(() => { loadBb(); }, [loadBb, logLength]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(loadBb, 5000);
    return () => clearInterval(t);
  }, [running, loadBb]);

  const roster = useMemo(() => {
    const byName = new Map();
    const normName = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

    const ensure = (name, patch = {}) => {
      if (!name) return null;
      const existing = byName.get(name) || {
        name,
        role: '',
        model: '',
        configuredTools: [],
        kind: 'worker',
        color: agentColorMap[name] || '#6b7280',
        toolCount: 0,
        tools: new Map(), // tool name -> count
        notes: [],
      };
      const next = {
        ...existing,
        ...patch,
        color: patch.color || existing.color || agentColorMap[name] || '#6b7280',
      };
      byName.set(name, next);
      return next;
    };

    for (const agent of colony?.agents || []) {
      // Identify the lead robustly via the colony's orchestrator_id rather than
      // pattern-matching the persona_role string.
      const isLead = colony?.orchestrator_id && agent.id === colony.orchestrator_id;
      ensure(agent.name, {
        role: agent.persona_role || agent.role || '',
        model: agent.model || '',
        configuredTools: Array.isArray(agent.tools) ? agent.tools : [],
        kind: isLead ? 'orchestrator' : 'worker',
        color: agent.avatar_color || agentColorMap[agent.name],
      });
    }

    for (const entry of log || []) {
      if (entry.type === 'agent_ready') {
        const current = byName.get(entry.agent);
        ensure(entry.agent, {
          kind: entry.role === 'orchestrator' ? 'orchestrator' : 'worker',
          role: entry.agent_role || current?.role || (entry.role === 'orchestrator' ? 'Orchestrator' : 'Specialist'),
          model: entry.model || current?.model || '',
          configuredTools: Array.isArray(entry.tools) ? entry.tools : (current?.configuredTools || []),
          color: entry.avatar_color || current?.color,
        });
      }
      if ((entry.type === 'tool_call' || entry.type === 'sub_tool_call') && entry.agent) {
        const item = ensure(entry.agent);
        if (item) {
          item.toolCount += 1;
          if (entry.tool) item.tools.set(entry.tool, (item.tools.get(entry.tool) || 0) + 1);
        }
      }
    }

    // Attribute blackboard notes by persona name OR role display name.
    const members = [...byName.values()];
    for (const e of bbEntries) {
      const who = normName(e.agent);
      const member = members.find(m => normName(m.name) === who || normName(m.role) === who)
        // "Operator"/"system" notes attach to the orchestrator.
        || (/(operator|orchestrator|system)/.test(who) ? members.find(m => m.kind === 'orchestrator') : null);
      if (member) member.notes.push(e);
    }

    return members.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'orchestrator' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [agentColorMap, colony, log, bbEntries]);

  const [expandedAgent, setExpandedAgent] = useState(null);

  if (roster.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5 min-w-0">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Crew
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{roster.length} agent{roster.length !== 1 ? 's' : ''}</span>
      </button>
      {open && (
      <div className="grid grid-cols-1 gap-2 mt-2">
        {roster.map(agent => {
          const active = filterAgent === null || filterAgent === agent.name;
          const expanded = expandedAgent === agent.name;
          return (
            <div
              key={agent.name}
              className={`rounded-md border min-w-0 transition-colors ${active ? 'border-gray-700 bg-gray-800/50' : 'border-gray-800 bg-gray-950/30 opacity-60'}`}
            >
              {/* Card header: click to expand tools/notes; filter is its own button */}
              <button
                onClick={() => setExpandedAgent(prev => prev === agent.name ? null : agent.name)}
                className="w-full text-left px-2.5 py-2 min-w-0"
                title={expanded ? 'Collapse' : 'Show tools used and notes taken'}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[11px] font-semibold text-white flex-shrink-0"
                    style={{ background: agent.color }}
                  >
                    {initials(agent.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-200 truncate">{agent.name}</p>
                    <p className="text-xs text-gray-600 truncate">
                      {agent.role || 'Specialist'}{agent.model ? ` · ${agent.model}` : ''}
                    </p>
                  </div>
                  <span className="text-xs text-gray-600 flex-shrink-0 tabular-nums">
                    {agent.toolCount} tools · {agent.notes.length} notes
                  </span>
                  {expanded ? <ChevronDown size={12} className="text-gray-600 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />}
                </div>
              </button>
              {expanded && (
                <div className="px-2.5 pb-2 border-t border-gray-800/60 pt-2 flex flex-col gap-2">
                  {/* Tools used, with per-tool counts */}
                  {agent.model && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Model</p>
                      <span className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-400 font-mono">
                        {agent.model}
                      </span>
                    </div>
                  )}
                  {agent.configuredTools.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">Configured tools</p>
                      <div className="flex flex-wrap gap-1">
                        {agent.configuredTools.map(tool => (
                          <span key={tool} title={tool} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-500 font-mono">
                            {prettyToolName(tool)}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Tools used</p>
                    {agent.tools.size === 0 ? (
                      <p className="text-xs text-gray-600 italic">no tool calls recorded</p>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {[...agent.tools.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => (
                          <span key={tool} title={tool} className="rounded border border-gray-800 bg-gray-950/40 px-1.5 py-0.5 text-xs text-gray-400 font-mono">
                            {prettyToolName(tool)}{count > 1 ? ` ×${count}` : ''}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Notes (blackboard entries by this member) */}
                  <div>
                    <p className="text-xs font-medium text-gray-500 mb-1">Notes (blackboard)</p>
                    {agent.notes.length === 0 ? (
                      <p className="text-xs text-gray-600 italic">no blackboard notes yet</p>
                    ) : (
                      <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto pr-1">
                        {agent.notes.map((n, i) => (
                          <NoteCard key={n.id || i} entry={n} />
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => onFilterAgent(prev => prev === agent.name ? null : agent.name)}
                    className={`self-start flex items-center gap-1 text-xs ${filterAgent === agent.name ? 'text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
                  >
                    <Filter size={10} /> {filterAgent === agent.name ? 'Clear log filter' : 'Filter log to this agent'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}

// ── Communication Protocol panels ──────────────────────────────────────────────

const HANDOFF_STATUS_STYLE = {
  pending:        { label: 'pending',  cls: 'border-gray-700 text-gray-400' },
  accepted:       { label: 'accepted', cls: 'border-green-700/50 text-green-300' },
  approved:       { label: 'approved', cls: 'border-green-700/50 text-green-300' },
  rejected:       { label: 'rejected', cls: 'border-red-700/50 text-red-300' },
  // Legacy status from runs recorded before in-run human gates were removed —
  // these are auto-approved server-side; review now happens on the Draft PR.
  awaiting_human: { label: 'auto-approved', cls: 'border-green-700/50 text-green-300' },
};

// Plain-language answer to "what am I supposed to do with this status?"
const HANDOFF_STATUS_EXPLAIN = {
  pending: 'Recorded on the ledger and counts as satisfied for the flow. It shows "pending" simply because the downstream agent never explicitly marks acceptance — no action is needed from you.',
  accepted: 'Accepted — the downstream role received the work and the flow advanced. No action needed.',
  approved: 'Approved — this handoff was explicitly approved. No action needed.',
  rejected: 'Rejected: the protocol preconditions were not met when this was attempted (an upstream role had not handed off yet). The operator was redirected to fix the order — a corrected handoff usually appears later in this list. Nothing for you to do.',
  awaiting_human: 'Legacy status from before in-run approvals were removed — it auto-approves now; your review point is the Draft PR.',
};

// Comment box: posts to the colony blackboard as "User" (permanent record the
// agents can read) and, when the run is live, also queues a high-priority
// direction so the operator reacts immediately.
function UserCommentBox({ colonyId, running, context, onPosted }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const send = async () => {
    const text = val.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api.postColonyBlackboard(colonyId, {
        agent: 'User',
        entry_type: 'message',
        content: `USER COMMENT${context ? ` on ${context}` : ''}: ${text}`,
      });
      if (running) {
        try { await api.sendColonyDirection(colonyId, `User comment${context ? ` on ${context}` : ''}: ${text}`); } catch { /* ignore best-effort direction failures */ }
      }
      setVal('');
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      onPosted?.();
    } catch { /* ignore best-effort comment failures */ } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') send(); }}
        placeholder={running ? 'Comment — goes to the operator now + onto the blackboard' : 'Comment — recorded on the blackboard for future reference'}
        className="flex-1 min-w-0 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <Button size="sm" variant="secondary" disabled={busy || !val.trim()} onClick={send}>
        {busy ? '…' : done ? '✓ noted' : 'Send'}
      </Button>
    </div>
  );
}

function HandoffsPanel({ colonyId, running, refreshKey }) {
  const [handoffs, setHandoffs] = useState([]);
  const [open, setOpen] = useState(true);
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(() => {
    if (!colonyId) return;
    api.getColonyHandoffs(colonyId)
      .then(data => setHandoffs(data.handoffs || []))
      .catch(() => {});
  }, [colonyId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  if (handoffs.length === 0) return null;

  // Runs are unattended — no in-run approval UI. The human review point is the
  // Draft PR opened at the end of the run. No inner scroll/height cap here: the
  // panel lives inside the status-panels scroll wrapper, and nesting a second
  // scrollbar made cards look clipped mid-row.
  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <ArrowRight size={12} className="text-indigo-400" /> Handoffs
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{handoffs.length}</span>
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {handoffs.map(h => {
            const style = HANDOFF_STATUS_STYLE[h.status] || HANDOFF_STATUS_STYLE.pending;
            const contract = h.payload?.contract || '';
            const expanded = expandedId === h.id;
            return (
              <li key={h.id} className="rounded-md border border-gray-800 bg-gray-950/40">
                <button
                  onClick={() => setExpandedId(prev => prev === h.id ? null : h.id)}
                  className="w-full text-left px-2.5 py-2"
                  title={expanded ? 'Collapse' : 'Show handoff details'}
                >
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <span className="font-medium text-gray-200">{h.from_agent}</span>
                    <ArrowRight size={11} className="text-gray-600 flex-shrink-0" />
                    <span className="font-medium text-gray-200">{h.to_agent}</span>
                    {h.payload?.auto_recorded && <span className="text-[10px] text-indigo-400/80 flex-shrink-0">auto</span>}
                    <span className={`ml-auto rounded border px-1.5 py-0.5 text-xs flex-shrink-0 ${style.cls}`}>{style.label}</span>
                    {expanded ? <ChevronDown size={12} className="text-gray-600 flex-shrink-0" /> : <ChevronRight size={12} className="text-gray-600 flex-shrink-0" />}
                  </div>
                  {contract && <p className="mt-1 text-xs text-gray-500 leading-snug">{contract}</p>}
                </button>
                {expanded && (
                  <div className="px-2.5 pb-2 border-t border-gray-800/60 pt-2 flex flex-col gap-2">
                    {/* What this status means / what (if anything) you should do */}
                    <p className="text-xs text-gray-400 leading-relaxed bg-gray-900/60 rounded px-2 py-1.5">
                      {HANDOFF_STATUS_EXPLAIN[h.status] || 'Unknown status.'}
                      {h.protocol_status && h.protocol_status !== 'ok' && (
                        <span className="block mt-1 text-amber-300/90">Protocol: {h.protocol_status}{h.payload?.summary ? ` — ${String(h.payload.summary).slice(0, 300)}` : ''}</span>
                      )}
                    </p>
                    {h.payload?.summary && h.status !== 'rejected' && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Summary from {h.from_agent}</p>
                        <div className="text-xs text-gray-300">
                          <AgentMarkdown>{String(h.payload.summary).slice(0, 1500)}</AgentMarkdown>
                        </div>
                      </div>
                    )}
                    {Array.isArray(h.payload?.artifacts) && h.payload.artifacts.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Artifacts</p>
                        <div className="flex flex-wrap gap-1">
                          {h.payload.artifacts.map((a, i) => (
                            <span key={i} className="rounded border border-gray-800 bg-gray-900/60 px-1.5 py-0.5 text-xs text-gray-400 font-mono break-all">{String(a)}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {h.payload?.payload && Object.keys(h.payload.payload).length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-0.5">Payload</p>
                        <KVRows obj={h.payload.payload} />
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-[10px] text-gray-600 tabular-nums">
                      {h.created_at && <span>recorded {bbTime(h.created_at)}</span>}
                      {h.updated_at && h.updated_at !== h.created_at && <span>updated {bbTime(h.updated_at)}</span>}
                      {h.human_note && <span className="italic">note: {h.human_note}</span>}
                    </div>
                    <UserCommentBox
                      colonyId={colonyId}
                      running={running}
                      context={`handoff ${h.from_agent}→${h.to_agent} (${h.status})`}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const BB_TYPE_STYLE = {
  state:      'text-emerald-300',
  blocker:    'text-red-300',
  checkpoint: 'text-indigo-300',
  progress:   'text-blue-300',
  assistance: 'text-amber-300',
  message:    'text-sky-300',
};

// Colored accent border per entry type so cards don't blend together.
const BB_TYPE_BORDER = {
  state:      'border-l-emerald-500/50',
  blocker:    'border-l-red-500/60',
  checkpoint: 'border-l-indigo-500/50',
  progress:   'border-l-blue-500/50',
  assistance: 'border-l-amber-500/60',
  message:    'border-l-sky-500/50',
};

// Blackboard timestamps are unix SECONDS (DB created_at).
function bbTime(createdAt) {
  if (!createdAt) return null;
  try {
    return new Date(createdAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return null; }
}

// One blackboard note card — shared by the Blackboard panel and the crew
// member detail view so they stay visually identical.
function NoteCard({ entry, showAgent = false, agentColor = null }) {
  const time = bbTime(entry.created_at);
  return (
    <div className={`rounded border border-gray-800/70 border-l-2 ${BB_TYPE_BORDER[entry.entry_type] || 'border-l-gray-700'} bg-gray-950/40 px-2 py-1.5 min-w-0`}>
      <div className="flex items-center gap-1.5 mb-0.5 min-w-0">
        <span className={`rounded border border-gray-800 px-1 py-px text-[10px] uppercase tracking-wide flex-shrink-0 ${BB_TYPE_STYLE[entry.entry_type] || 'text-gray-500'}`}>
          {entry.entry_type}
        </span>
        {showAgent && (
          <span className="text-xs font-medium truncate" style={agentColor ? { color: agentColor } : undefined}>
            {entry.agent}
          </span>
        )}
        {time && <span className="ml-auto text-[10px] text-gray-600 tabular-nums flex-shrink-0">{time}</span>}
      </div>
      <div className="text-xs text-gray-300">
        <AgentMarkdown>{String(entry.content || '').slice(0, 1200)}</AgentMarkdown>
      </div>
    </div>
  );
}

function BlackboardPanel({ colonyId, running, refreshKey, resolveAgentColor = null }) {
  const [entries, setEntries] = useState([]);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    if (!colonyId) return;
    api.getColonyBlackboard(colonyId)
      .then(data => setEntries(data.entries || []))
      .catch(() => {});
  }, [colonyId]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [running, load]);

  if (entries.length === 0) return null;

  return (
    <div className="mb-3 rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Blackboard
        </span>
        <span className="text-xs text-gray-500 tabular-nums">{entries.length} entries</span>
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {entries.map(e => (
            <NoteCard key={e.id} entry={e} showAgent agentColor={resolveAgentColor ? resolveAgentColor(e.agent) : null} />
          ))}
          <UserCommentBox colonyId={colonyId} running={running} context="the blackboard" onPosted={load} />
        </div>
      )}
    </div>
  );
}

export function ColonyLiveView({ colony, log, agentColorMap, running, streamingByAgent = {}, plan = null, onStop, onExport, onBack = null, blockers = [], prUrl = null }) {
  const bottomRef = useRef(null);
  const [filterAgent, setFilterAgent] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  // Reasoning display is no longer a run-screen toggle — which agents reason is
  // an operator decision made at run start, and their thinking streams as-is.
  const showReasoning = true;
  const [showPanels, setShowPanels] = useState(true);
  const [posting, setPosting] = useState(false);
  const [postResult, setPostResult] = useState(null);
  const [acceptingTasks, setAcceptingTasks] = useState(false);
  const [acceptError, setAcceptError] = useState(null);
  const [artifactView, setArtifactView] = useState(null); // artifact path | null

  const postToBoard = async () => {
    setPosting(true);
    setPostResult(null);
    try {
      const r = await api.postColonyBoardComment(colony.id);
      setPostResult({ ok: true, url: r.url });
    } catch (e) {
      setPostResult({ ok: false, error: e.message });
    } finally {
      setPosting(false);
    }
  };

  const acceptBootstrapTasks = async () => {
    setAcceptingTasks(true);
    setAcceptError(null);
    try {
      await api.acceptBootstrapTasks(colony.id);
      window.location.reload();
    } catch (e) {
      setAcceptError(e.message);
    } finally {
      setAcceptingTasks(false);
    }
  };

  const streamingEntries = Object.entries(streamingByAgent).filter(
    ([, v]) => (v?.content && v.content.length > 0) || (v?.thinking && v.thinking.length > 0),
  );

  // Auto-scroll when log grows OR streaming text updates
  const streamingLen = streamingEntries.reduce((n, [, v]) => n + (v.content?.length || 0) + (v.thinking?.length || 0), 0);
  useEffect(() => {
    // 'auto' (instant) — queued 'smooth' animations stack up during streaming
    // and make the log feel like it's pausing/rubber-banding.
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [log.length, streamingLen, autoScroll]);

  const merged = mergeToolEntries(log);

  // The run auto-posts its deliverable to the linked board item; the manual
  // button is only a RETRY for when that failed.
  const boardPosted = (colony.log || []).some(e =>
    e.kind === 'writeback' && (e.comment_url || /Posted update/.test(e.message || '')));

  const filtered = filterAgent
    ? merged.filter(e => !e.agent || e.agent === filterAgent || e.type === 'round' || e.type === 'done' || e.type === 'error' || e.type === 'system')
    : merged;

  const agents = Object.entries(agentColorMap).map(([name, color]) => ({ name, color }));

  const statusColor = { running: 'text-blue-400', done: 'text-green-400', stopped: 'text-gray-400', awaiting_tasks: 'text-amber-300', blocked: 'text-amber-300', failed: 'text-red-400', error: 'text-red-400' };
  const statusIcon = {
    running: <Loader2 size={12} className="animate-spin" />,
    done: <CheckCircle2 size={12} />,
    stopped: <Square size={12} />,
    awaiting_tasks: <FileText size={12} />,
    blocked: <XCircle size={12} />,
    failed: <XCircle size={12} />,
    error: <XCircle size={12} />,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Colony header — show a clean title; full work-item details render in the
          formatted Work item card below, not as a raw text dump here. */}
      <div className="flex items-start gap-3 pb-3 border-b border-gray-800 mb-2">
        {onBack && (
          <button onClick={onBack} className="mt-0.5 p-1.5 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-gray-800 transition flex-shrink-0" title="Back to colony">
            <ArrowLeft size={15} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200 leading-snug line-clamp-2">
            {(() => {
              const item = parseBoardGoal(colony.goal);
              if (item) return `${item.fields.Number ? `${item.fields.Number} · ` : ''}${item.fields.Title || 'Work item'}`;
              return colony.goal;
            })()}
          </p>
          {/* Full work item details across the top */}
          <WorkItemHeader goal={colony.goal} acceptance={colony.deliverable?.acceptance?.results || null} />
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <span className={`flex items-center gap-1 text-xs ${statusColor[colony.status] || 'text-gray-500'}`}>
              {statusIcon[colony.status]}
              {colony.status}
            </span>
            <span className="text-xs text-gray-600">{colony.model}</span>
            <span className="text-xs text-gray-700">{formatDate(colony.created_at * 1000)}</span>
            {isSafeUrl(colony.trigger?.source_url) && (
              <a href={colony.trigger.source_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline">
                <Flag size={11} /> source event
              </a>
            )}
            {colony.board_card?.number && isSafeUrl(colony.board_card?.url) && (
              <a href={colony.board_card.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200">
                <Link2 size={11} /> {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number}
              </a>
            )}
            {colony.trigger_config?.webhook_id && (
              <span className="flex items-center gap-1 text-xs text-gray-500">
                <Zap size={11} /> triggers: {(colony.trigger_config.event_types || []).join(', ')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowPanels(v => !v)}
            className={showPanels ? 'text-gray-400 hover:text-gray-200' : 'text-blue-400 hover:text-blue-300'}
            title="Show/hide the work item, plan, crew, handoffs, and summary panels"
          >
            {showPanels ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details
          </Button>
          {running && (
            <Button size="sm" variant="ghost" onClick={onStop} className="text-red-400 hover:text-red-300">
              <Square size={12} /> Stop
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onExport} className="text-gray-500 hover:text-gray-300">
            <Download size={12} /> Export
          </Button>
        </div>
      </div>

      {/* Two-column body: details sidebar on the LEFT, output/log on the RIGHT.
          One scroll surface per column — no more stacked sections with nested
          scrollbars squeezing the output. */}
      <div className="flex flex-1 min-h-0 gap-4">

      {/* Details column (collapsible via the "Details" button) */}
      <div className={`w-96 xl:w-[28rem] flex-shrink-0 min-h-0 overflow-y-auto pr-1 flex-col gap-3 ${showPanels ? 'flex' : 'hidden'}`}>

      <CrewRoster
        colony={colony}
        log={log}
        agentColorMap={agentColorMap}
        filterAgent={filterAgent}
        onFilterAgent={setFilterAgent}
      />

      {/* Draft PR badge — shown once the branch has been pushed */}
      {isSafeUrl(prUrl) && (
        <a href={prUrl} target="_blank" rel="noreferrer"
          className="mb-3 flex items-center gap-2 rounded-lg border border-green-700/50 bg-green-950/20 px-3 py-2 text-xs text-green-300 hover:bg-green-950/40 transition-colors">
          <GitBranch size={13} className="flex-shrink-0" />
          <span className="font-medium">Draft PR opened</span>
          <span className="text-green-500 truncate">{prUrl}</span>
          <ExternalLink size={11} className="ml-auto flex-shrink-0" />
        </a>
      )}

      {/* HITL Blocker alerts — require human action before the colony can continue */}
      {blockers.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {blockers.map((b, i) => (
            <div key={i} className="rounded-lg border border-amber-600/60 bg-amber-950/30 px-3 py-2.5">
              <div className="flex items-center gap-2 mb-1.5">
                <AlertTriangle size={13} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs font-semibold text-amber-300">Action Required — Colony is paused</span>
              </div>
              <pre className="text-xs text-amber-200/80 whitespace-pre-wrap break-words leading-relaxed font-sans">{b.message}</pre>
              {b.action === 'retry_push' && (
                <p className="mt-2 text-xs text-amber-400/70">Fix the issue above, then push the branch manually and open a PR on GitHub.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {colony.status === 'awaiting_tasks' && Array.isArray(colony.bootstrap_tasks) && colony.bootstrap_tasks.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2.5">
          <div className="flex items-center gap-2 mb-2">
            <FileText size={13} className="text-amber-300" />
            <span className="text-xs font-semibold text-amber-200">Bootstrap Tasks Awaiting Review</span>
            <Button size="sm" className="ml-auto" disabled={acceptingTasks} onClick={acceptBootstrapTasks}>
              {acceptingTasks ? 'Starting…' : 'Use these tasks'}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {colony.bootstrap_tasks.map(task => (
              <div key={task.id || task.title} className="rounded border border-amber-900/40 bg-gray-950/30 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-300 font-mono">{task.id}</span>
                  <span className="text-xs font-medium text-gray-100">{task.title}</span>
                </div>
                {task.description && <p className="mt-1 text-xs text-gray-400 leading-snug">{task.description}</p>}
                {Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0 && (
                  <p className="mt-1 text-xs text-gray-500 leading-snug">Acceptance: {task.acceptance_criteria.join('; ')}</p>
                )}
              </div>
            ))}
          </div>
          {acceptError && <p className="mt-2 text-xs text-red-400">{acceptError}</p>}
        </div>
      )}

      {/* Communication protocol — handoff lifecycle, shared blackboard */}
      <HandoffsPanel colonyId={colony.id} running={running} refreshKey={log.length} />
      <BlackboardPanel
        colonyId={colony.id}
        running={running}
        refreshKey={log.length}
        resolveAgentColor={(who) => {
          // Entries are written under either the persona name ("Sam Rivera") or
          // the role display name ("Software Developer") — resolve both.
          if (agentColorMap[who]) return agentColorMap[who];
          const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();
          const match = (colony.agents || []).find(a => norm(a.persona_role) === norm(who) || norm(a.name) === norm(who));
          return match ? (agentColorMap[match.name] || match.avatar_color || null) : null;
        }}
      />

      {/* Summary + structured deliverable card */}
      {colony.summary && (
        <div className="mb-3 rounded-lg border border-green-900/50 bg-green-950/20 px-3 py-2.5">
          <div className="flex items-center gap-1.5 mb-1">
            <CheckCircle2 size={13} className="text-green-400" />
            <span className="text-xs font-semibold text-green-400">Goal Achieved</span>
            {colony.deliverable && (
              <span className={`ml-auto rounded border px-1.5 py-0.5 text-xs ${colony.deliverable.flow_complete ? 'border-green-700/50 text-green-300' : 'border-amber-700/50 text-amber-300'}`}>
                {colony.deliverable.flow_complete ? 'flow complete' : 'partial flow'}
              </span>
            )}
          </div>
          <div className="text-xs text-green-200/90 leading-relaxed">
            <AgentMarkdown>{formatSummaryMarkdown(colony.summary)}</AgentMarkdown>
          </div>
          {colony.deliverable?.report && String(colony.deliverable.report).trim() !== String(colony.summary || '').trim() && (
            <details className="mt-2 rounded-md border border-green-900/40 bg-green-950/10 px-2.5 py-2" open>
              <summary className="cursor-pointer text-xs font-semibold text-green-300/90">Full report</summary>
              <div className="mt-2 text-xs text-green-100/90 leading-relaxed">
                <AgentMarkdown>{String(colony.deliverable.report)}</AgentMarkdown>
              </div>
            </details>
          )}
          {colony.deliverable && (colony.deliverable.links?.length > 0 || colony.deliverable.artifacts?.length > 0) && (
            <div className="mt-2 flex flex-col gap-1">
              {colony.deliverable.links?.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <ShieldCheck size={11} className="text-green-500/70" />
                  {colony.deliverable.links.map((l, i) => (
                    isSafeUrl(l)
                      ? <a key={i} href={l} target="_blank" rel="noreferrer" className="text-xs text-blue-300 hover:underline truncate max-w-xs">{l}</a>
                      : <span key={i} className="text-xs text-gray-400 truncate max-w-xs">{l}</span>
                  ))}
                </div>
              )}
              {colony.deliverable.artifacts?.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <FileText size={11} className="text-gray-500" />
                  {colony.deliverable.artifacts.map((a, i) => (
                    <button key={i} type="button" onClick={() => setArtifactView(a)} className="text-xs text-blue-300/90 hover:text-blue-200 hover:underline truncate max-w-xs text-left" title="Open this artifact">
                      {a}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {colony.deliverable?.workarounds?.length > 0 && (
            <div className="mt-2 rounded-md border border-amber-800/50 bg-amber-950/20 px-2.5 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <AlertTriangle size={12} className="text-amber-400" />
                <span className="text-xs font-semibold text-amber-300">Operator improvement report</span>
              </div>
              <div className="space-y-2">
                {colony.deliverable.workarounds.map((w, i) => (
                  <div key={i} className="text-xs leading-relaxed border-l-2 border-amber-800/50 pl-2">
                    <p className="font-medium text-amber-200">{w.issue}</p>
                    {w.workaround && (
                      <p className="text-amber-100/80"><span className="text-amber-400/70">Workaround:</span> {w.workaround}</p>
                    )}
                    {w.recommendation && (
                      <p className="text-amber-100/80"><span className="text-amber-400/70">Improve:</span> {w.recommendation}</p>
                    )}
                    {w.impact && (
                      <p className="text-amber-200/60"><span className="text-amber-400/70">Impact:</span> {w.impact}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {colony.board_card?.number && (
            <div className="mt-2 flex items-center gap-2">
              {boardPosted && !postResult ? (
                <span className="flex items-center gap-1 text-xs text-green-400/80">
                  <CheckCircle2 size={11} /> Update posted to {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number} automatically
                </span>
              ) : (
                <Button size="sm" variant="secondary" disabled={posting} onClick={postToBoard} title="The run posts this automatically — use only if the auto-post failed">
                  {posting ? 'Posting…' : `Retry posting update to #${colony.board_card.number}`}
                </Button>
              )}
              {postResult?.ok && isSafeUrl(postResult.url || colony.board_card.url) && (
                <a href={postResult.url || colony.board_card.url} target="_blank" rel="noreferrer" className="text-xs text-green-300 hover:underline">
                  Posted to {colony.board_card.repo ? `${colony.board_card.repo} ` : ''}#{colony.board_card.number}
                </a>
              )}
              {postResult && !postResult.ok && <span className="text-xs text-red-400">{postResult.error}</span>}
            </div>
          )}
        </div>
      )}

      </div>{/* end details column */}

      {/* Output column — gets all remaining width and one scrollbar */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">

      {/* Plan strip — spread across the output, slim vertical footprint */}
      <PlanStrip plan={plan} />

      {/* Agent filter chips */}
      {agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 items-center">
          <Filter size={11} className="text-gray-600 flex-shrink-0" />
          {agents.map(a => (
            <AgentBadge
              key={a.name}
              name={a.name}
              color={a.color}
              active={filterAgent === null || filterAgent === a.name}
              onClick={() => setFilterAgent(prev => prev === a.name ? null : a.name)}
            />
          ))}
          {filterAgent && (
            <button onClick={() => setFilterAgent(null)} className="text-xs text-gray-600 hover:text-gray-400 px-1">clear</button>
          )}
        </div>
      )}

      {/* Log */}
      <div
        className="flex-1 overflow-y-auto min-h-0 flex flex-col gap-0.5 font-mono text-xs pr-1"
        onScroll={e => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setAutoScroll(atBottom);
        }}
      >
        {filtered.length === 0 && running && (
          <div className="flex items-center gap-2 text-gray-600 py-6 justify-center">
            <Loader2 size={14} className="animate-spin" />
            <span>Orchestrator is planning…</span>
          </div>
        )}
        {filtered.length === 0 && !running && (
          <div className="text-gray-600 py-6 text-center">No entries</div>
        )}
        {filtered.map((entry, i) => (
          <LogEntry key={i} entry={entry} agentColorMap={agentColorMap} />
        ))}

        {/* Streaming preview: live token deltas for agents currently generating */}
        {streamingEntries.map(([agentName, buf]) => {
          if (filterAgent && filterAgent !== agentName) return null;
          const color = agentColorMap[agentName] || '#6b7280';
          const thinkingOnly = !buf.content && buf.thinking;
          return (
            <div key={`stream-${agentName}`} className="flex items-start gap-2 py-2">
              <div className="flex-shrink-0 w-12">
                <Loader2 size={10} className="animate-spin text-gray-600" />
              </div>
              <AgentBadge name={agentName} color={color} />
              <div className="flex-1 min-w-0">
                {showReasoning && buf.thinking && (
                  <pre className="text-xs text-gray-600 italic whitespace-pre-wrap break-words font-sans leading-relaxed mb-1 border-l-2 border-gray-800 pl-2">
                    {buf.thinking}
                  </pre>
                )}
                {/* Reasoning hidden but the model is mid-think — show a pulse so
                    the stream doesn't look stalled. */}
                {!showReasoning && thinkingOnly && (
                  <p className="text-xs text-gray-600 italic font-sans animate-pulse">thinking…</p>
                )}
                {buf.content && (
                  <div className="text-sm text-gray-300 leading-relaxed font-sans">
                    <AgentMarkdown>{buf.content}</AgentMarkdown>
                    <span className="inline-block w-1.5 h-3 bg-gray-400 align-middle ml-0.5 animate-pulse" />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <div ref={bottomRef} />
      </div>

      {/* Auto-scroll hint */}
      {!autoScroll && running && (
        <button
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
          className="mt-1 text-xs text-blue-400 hover:text-blue-300 text-center py-1"
        >
          ↓ Resume auto-scroll
        </button>
      )}

      {/* Direction input — message the running colony directly */}
      <DirectionInput colonyId={colony.id} disabled={!running} />

      </div>{/* end output column */}
      </div>{/* end two-column body */}

      {artifactView && (
        <ArtifactViewerModal key={`${colony.id}:${artifactView}`} runId={colony.id} path={artifactView} onClose={() => setArtifactView(null)} />
      )}
    </div>
  );
}

function DirectionInput({ colonyId, disabled }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState('');
  const send = async () => {
    const v = text.trim();
    if (!v) return;
    setSending(true);
    setStatus('');
    try {
      await api.sendColonyDirection(colonyId, v);
      setText('');
      setStatus('Queued for the next operator round');
    } catch (e) {
      setStatus(e.message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-2 border-t border-gray-800 pt-2">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder={disabled ? 'Direction is available while the colony is running' : 'Direct the colony… e.g. focus on the v2 endpoints first'}
          disabled={disabled || sending}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600 disabled:opacity-50"
        />
        <Button size="sm" onClick={send} disabled={disabled || sending || !text.trim()}>
          {sending ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />} Send
        </Button>
      </div>
      {status && <p className="mt-1 text-xs text-gray-500">{status}</p>}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
// A Colony is a named, persistent team (e.g. "Hive-TaskMaster"). The main tab
// lists colonies as cards; each colony page shows an overview (crew,
// performance, runs, artifacts) and is where runs are launched against the
// team's work items. Repo/project + base config are set when the colony is
// created — not per run. All three views render from this ONE mounted
// component so a live SSE stream survives internal navigation:
//   /colony                      → colony cards
//   /colony/:teamId              → colony page
//   /colony/:teamId/run/:runId   → run page (live view / replay)

// Create / edit a colony. Issues and tasks are deliberately NOT selected here —
// they're picked from the colony page when launching a run. Only the team
// identity (name, description) and base config (preset, repo, toggles) live here.
export function TeamConfigModal({ initial = null, recipes, presetRecipeId = null, onClose, onSaved }) {
  const editing = !!initial?.id;
  // Founding from a catalog ghost card pre-fills and locks the recipe — the
  // catalog is the hiring hall; the modal only collects name + repo (+ toggles).
  const recipeLocked = !editing && !!presetRecipeId;
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [recipeId, setRecipeId] = useState(initial?.recipe_id || presetRecipeId || 'development_team');
  const [repoPath, setRepoPath] = useState(initial?.repo_path || '');
  const [cloudEnabled, setCloudEnabled] = useState(!!initial?.cloud_enabled);
  const [githubReview, setGithubReview] = useState(!!initial?.github_review);
  const [githubPublish, setGithubPublish] = useState(!!(initial?.github_publish ?? initial?.github_writeback));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedRecipe = recipes.find(r => r.id === recipeId) || null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { name, description, recipe_id: recipeId, repo_path: repoPath, cloud_enabled: cloudEnabled, github_review: githubReview, github_publish: githubPublish };
      const team = editing
        ? await api.updateColonyTeam(initial.id, payload)
        : await api.createColonyTeam(payload);
      onSaved(team);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-5 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-100">
            {editing ? 'Edit colony' : recipeLocked ? `Found a colony — ${selectedRecipe?.name || presetRecipeId}` : 'New colony'}
          </p>
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300"><X size={15} /></button>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Hive-TaskMaster" autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Quick description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} placeholder="What this team owns and works on…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Team preset</span>
          {recipeLocked ? (
            <span className="text-sm text-gray-200 border border-gray-800 bg-gray-900/60 rounded-lg px-3 py-2">{selectedRecipe?.name || presetRecipeId}</span>
          ) : (
            <select value={recipeId} onChange={e => setRecipeId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
              {recipes.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          {selectedRecipe?.summary && <p className="text-xs text-gray-500 leading-relaxed">{selectedRecipe.summary}</p>}
          {selectedRecipe?.execution_policy?.mode && (
            <p className="text-xs text-blue-300/80 border border-blue-900/40 bg-blue-950/20 rounded px-2 py-1.5">
              Execution mode: {selectedRecipe.execution_policy.mode === 'read_only' ? 'Read-only repository review' : selectedRecipe.execution_policy.mode === 'artifact_only' ? 'Artifacts only — repository changes blocked' : 'Repository delivery — intentional changes allowed'}
            </p>
          )}
          {selectedRecipe?.roles?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {selectedRecipe.roles.map(role => (
                <span key={role.key} className="text-xs text-gray-400 border border-gray-800 bg-gray-900/60 rounded px-2 py-0.5">{role.name}</span>
              ))}
            </div>
          )}
          <p className="text-xs text-gray-600">The operator staffs each preset role with the best-matched staff member for this colony.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Repository / project</span>
          <input value={repoPath} onChange={e => setRepoPath(e.target.value)} placeholder="/path/to/your/git/repo"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
          <p className="text-xs text-gray-600">Issues and tasks are picked from this repo's board on the colony page — not here.</p>
        </div>

        <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-300">Enable cloud models</p>
            <p className="text-xs text-gray-600 mt-0.5">Off = local Ollama only. On = operator may assign Anthropic / OpenAI / Gemini.</p>
          </div>
          <button type="button" role="switch" aria-checked={cloudEnabled} onClick={() => setCloudEnabled(v => !v)}
            className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${cloudEnabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${cloudEnabled ? 'right-0.5' : 'left-0.5'}`} />
          </button>
        </div>

        {selectedRecipe?.execution_policy?.github_review && (
          <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-300">Post review to the original PR</p>
              <p className="text-xs text-gray-600 mt-0.5">Posts the verdict/report only. It never edits files, creates a branch, or opens another PR.</p>
            </div>
            <button type="button" role="switch" aria-checked={githubReview} onClick={() => setGithubReview(v => !v)}
              className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${githubReview ? 'bg-blue-600' : 'bg-gray-700'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${githubReview ? 'right-0.5' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {selectedRecipe?.execution_policy?.mode === 'repository_write' && (
          <div className="flex items-center justify-between rounded-lg bg-gray-900/50 border border-gray-800 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-gray-300">Publish repository changes</p>
              <p className="text-xs text-amber-500/70 mt-0.5">Allows intentional edits, commits, pushes, and a Draft PR after a successful run. Failed or stopped runs are never published.</p>
            </div>
            <button type="button" role="switch" aria-checked={githubPublish} onClick={() => setGithubPublish(v => !v)}
              className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${githubPublish ? 'bg-amber-600' : 'bg-gray-700'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${githubPublish ? 'right-0.5' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-2 pt-1">
          <Button onClick={save} disabled={!name.trim() || saving} className="flex-1">
            {saving ? <><Loader2 size={13} className="animate-spin" /> Saving…</> : (editing ? 'Save changes' : 'Create colony')}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

// Roster card: identity + live status. "Who's idle and who's working" must be
// answerable at a glance, so status, the current run, and the queue depth lead.
export function ColonyCard({ team, recipeNames, onOpen, onDelete }) {
  const stats = team.stats || {};
  const last = team.last_run;
  const status = TEAM_STATUS_META[team.status] || TEAM_STATUS_META.idle;
  const queue = team.queue || { proposed: 0, queued: 0, depth: 0 };
  const activeRun = team.active_run;
  return (
    <button
      onClick={onOpen}
      className="group text-left rounded-xl border border-gray-800 bg-gray-900/40 hover:border-gray-700 hover:bg-gray-900/70 transition-colors p-4 flex flex-col gap-2.5"
    >
      <div className="flex items-start gap-2">
        <Users size={16} className="text-blue-400/80 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-100 truncate">{team.name}</p>
          {team.description && <p className="text-xs text-gray-500 leading-snug line-clamp-2 mt-0.5">{team.description}</p>}
        </div>
        <span className={`flex items-center gap-1.5 text-xs border rounded-full px-2 py-0.5 flex-shrink-0 ${status.chip}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
          {status.label}
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onDelete(); } }}
          className="p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0"
          title="Delete this colony and all its runs (queued work is released, not deleted)"
        >
          <Trash2 size={13} />
        </span>
      </div>
      {activeRun && (
        <p className="text-xs text-blue-300/90 truncate" title={activeRun.goal}>
          <Loader2 size={10} className="inline animate-spin mr-1" />
          {runLabel(activeRun)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-gray-400 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5">{recipeNames[team.recipe_id] || team.recipe_id}</span>
        {team.repo_path && (
          <span className="flex items-center gap-1 text-xs text-gray-500 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5 max-w-[14rem]">
            <GitBranch size={10} /> <span className="truncate">{team.repo_path.split('/').slice(-1)[0]}</span>
          </span>
        )}
        {queue.depth > 0 && (
          <span className={`flex items-center gap-1 text-xs border rounded px-2 py-0.5 ${queue.proposed > 0 ? 'border-purple-500/30 bg-purple-500/10 text-purple-300' : 'border-gray-800 bg-gray-950/60 text-gray-400'}`}
            title={`${queue.proposed} proposed · ${queue.queued} queued`}>
            <ListTodo size={10} /> {queue.depth} in queue
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-500 mt-auto pt-1">
        <span>{stats.total_runs || 0} run{(stats.total_runs || 0) === 1 ? '' : 's'}</span>
        {stats.success_rate != null && <span className="text-green-400/80">{Math.round(stats.success_rate * 100)}% success</span>}
        {team.last_artifact ? (
          <span className="flex items-center gap-1 ml-auto text-gray-600 min-w-0" title={`Last shipped: ${team.last_artifact.file || team.last_artifact.link}`}>
            <Package size={10} className="text-green-400/60 flex-shrink-0" />
            <span className="truncate max-w-[10rem]">{String(team.last_artifact.file || team.last_artifact.link).split('/').slice(-1)[0]}</span>
          </span>
        ) : last && (
          <span className="flex items-center gap-1.5 ml-auto">
            <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[last.status] || 'bg-gray-700'}`} />
            <span className="text-gray-600">{formatDate(last.created_at * 1000)}</span>
          </span>
        )}
      </div>
    </button>
  );
}

// "Hiring hall" ghost card — a catalog recipe that can found a new colony.
export function RecipeGhostCard({ recipe, onFound }) {
  return (
    <button
      onClick={onFound}
      className="group text-left rounded-xl border border-dashed border-gray-800 bg-gray-950/30 hover:border-blue-500/40 hover:bg-gray-900/50 transition-colors p-4 flex flex-col gap-2"
      title={`Found a colony from the ${recipe.name} recipe`}
    >
      <div className="flex items-start gap-2">
        <Sparkles size={14} className="text-gray-600 group-hover:text-blue-400/80 mt-0.5 flex-shrink-0 transition-colors" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-300 group-hover:text-gray-100 truncate transition-colors">{recipe.name}</p>
          {recipe.summary && <p className="text-xs text-gray-600 leading-snug line-clamp-2 mt-0.5">{recipe.summary}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 mt-auto pt-1">
        {recipe.category && <span className="text-xs text-gray-500 border border-gray-800 bg-gray-950/60 rounded px-2 py-0.5">{recipe.category}</span>}
        <span className="text-xs text-gray-600">{recipe.roles?.length || 0}-role crew</span>
        <span className="ml-auto text-xs text-blue-400/0 group-hover:text-blue-400 transition-colors flex items-center gap-1"><Plus size={11} /> Found</span>
      </div>
    </button>
  );
}

// Unrouted tray — incoming work no colony owns. Nothing silently disappears:
// the operator routes each item to a colony or dismisses it explicitly.
export function UnroutedTray({ items, teams, onRoute, onDismiss }) {
  const [targets, setTargets] = useState({}); // itemId -> teamId
  if (!items?.length) return null;
  return (
    <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Inbox size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-amber-200">Unrouted work</span>
        <span className="text-xs text-gray-600">— incoming items no colony owns yet; route or dismiss them</span>
      </div>
      <div className="flex flex-col divide-y divide-gray-800/60">
        {items.map(item => (
          <div key={item.id} className="flex items-center gap-2.5 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-200 truncate">
                {item.title}
                {item.board_card?.number && <span className="text-gray-500"> #{item.board_card.number}</span>}
              </p>
              <p className="text-xs text-gray-600 truncate">
                {item.source}{item.board_card?.repo ? ` · ${item.board_card.repo}` : ''}{item.match_reason ? ` · ${item.match_reason}` : ''}
              </p>
            </div>
            <select
              value={targets[item.id] || ''}
              onChange={e => setTargets(prev => ({ ...prev, [item.id]: e.target.value }))}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500 max-w-[11rem]"
            >
              <option value="">Route to…</option>
              {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <Button size="sm" variant="secondary" disabled={!targets[item.id]} onClick={() => onRoute(item, targets[item.id])}>
              <ArrowRight size={11} /> Route
            </Button>
            <button onClick={() => onDismiss(item)} className="p-1.5 text-gray-700 hover:text-red-400 transition flex-shrink-0" title="Dismiss this item">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PerformanceStrip({ performance }) {
  if (!performance) return null;
  const s = performance.by_status || {};
  const pct = performance.success_rate != null ? Math.round(performance.success_rate * 100) : null;
  const cells = [
    { label: 'Runs', value: performance.total_runs || 0, Icon: Zap, tint: 'text-blue-400', chip: 'bg-blue-500/10 border-blue-500/20' },
    { label: 'Success', value: pct != null ? `${pct}%` : '—', Icon: ShieldCheck, tint: 'text-green-400', chip: 'bg-green-500/10 border-green-500/20', bar: pct },
    { label: 'Avg duration', value: fmtDuration(performance.avg_duration_secs), Icon: Clock, tint: 'text-purple-300', chip: 'bg-purple-500/10 border-purple-500/20' },
    { label: 'Done', value: s.done || 0, Icon: CheckCircle2, tint: 'text-green-400', chip: 'bg-green-500/10 border-green-500/20' },
    { label: 'Errors', value: s.error || 0, Icon: XCircle, tint: s.error ? 'text-red-400' : 'text-gray-600', chip: s.error ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-800/40 border-gray-800' },
    { label: 'Stopped', value: s.stopped || 0, Icon: Square, tint: 'text-gray-400', chip: 'bg-gray-800/40 border-gray-800' },
  ];
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        <BarChart3 size={13} className="text-blue-400/70" />
        <span className="text-xs font-semibold text-gray-300">Performance</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
        {cells.map(c => (
          <div key={c.label} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-3 py-2.5 flex items-center gap-2.5">
            <span className={`w-8 h-8 rounded-lg border flex items-center justify-center flex-shrink-0 ${c.chip}`}>
              <c.Icon size={14} className={c.tint} />
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-base font-semibold leading-tight tabular-nums ${c.tint}`}>{c.value}</p>
              <p className="text-xs text-gray-600 truncate">{c.label}</p>
              {c.bar != null && (
                <div className="mt-1 h-1 rounded-full bg-gray-800 overflow-hidden">
                  <div className="h-full rounded-full bg-green-500/70" style={{ width: `${c.bar}%` }} />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shared colony memory — durable knowledge the operator distills after each
// run. Editable here; injected into the operator and every worker on launch.
export function ColonyMemoryPanel({ memory, onSave }) {
  const [draft, setDraft] = useState(memory || '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  // Re-sync when the server-side memory changes (e.g. operator updated it
  // after a run) — but only if the user has no unsaved edits. Render-time
  // derived-state pattern (no effect, no cascading render).
  const [lastServer, setLastServer] = useState(memory || '');
  if ((memory || '') !== lastServer) {
    if (draft === lastServer) setDraft(memory || '');
    setLastServer(memory || '');
  }

  const dirty = draft !== (memory || '');
  const save = async () => {
    setSaving(true);
    setStatus('');
    try {
      await onSave(draft);
      setStatus('Saved');
    } catch (e) {
      setStatus(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <FileText size={13} className="text-purple-400/80" />
        <span className="text-xs font-semibold text-gray-300">Colony memory</span>
        <span className="text-xs text-gray-600">— operator appends lessons after each run</span>
        <div className="ml-auto flex items-center gap-2">
          {status && <span className={`text-xs ${status === 'Saved' ? 'text-green-400' : 'text-red-400'}`}>{status}</span>}
          <Button size="sm" variant="secondary" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 size={11} className="animate-spin" /> : null} {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={e => { setDraft(e.target.value); setStatus(''); }}
        rows={Math.min(14, Math.max(4, draft.split('\n').length + 1))}
        placeholder={'Nothing remembered yet. Add standing knowledge for the team (conventions, gotchas, decisions) — the operator will append run lessons below it.'}
        className="w-full bg-gray-950/60 border border-gray-800 rounded-lg px-3 py-2 text-xs text-gray-200 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
      />
    </div>
  );
}

const INSIGHT_META = {
  workaround: { label: 'Workaround', cls: 'border-amber-700/50 text-amber-300' },
  acceptance_fail: { label: 'Acceptance fail', cls: 'border-red-800/50 text-red-300' },
  blocker: { label: 'Blocker', cls: 'border-orange-800/50 text-orange-300' },
};

// Cross-run insights — operator improvement reports, failed acceptance
// criteria, and blockers aggregated across the colony's whole run history.
export function InsightsPanel({ insights }) {
  if (!insights?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <AlertTriangle size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-gray-300">Insights</span>
        <span className="text-xs text-gray-600">— issues & improvement reports across runs</span>
      </div>
      <div className="flex flex-col gap-2">
        {insights.map((ins, i) => {
          const meta = INSIGHT_META[ins.type] || { label: ins.type, cls: 'border-gray-700 text-gray-400' };
          return (
            <div key={`${ins.run_id}-${ins.type}-${i}`} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-xs border rounded px-1.5 py-0.5 flex-shrink-0 ${meta.cls}`}>{meta.label}</span>
                <span className="text-xs text-gray-600 truncate flex-1">{runLabel(ins)}</span>
                <span className="text-xs text-gray-700 flex-shrink-0">{formatDate(ins.created_at * 1000)}</span>
              </div>
              <p className="text-xs text-gray-300 leading-snug">{ins.issue}</p>
              {ins.recommendation && (
                <p className="text-xs text-gray-500 leading-snug mt-0.5"><span className="text-gray-600">Improve:</span> {ins.recommendation}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Read-only viewer for a run artifact (file content served from the run repo).
// Callers key this component on runId+path so changing artifacts remounts it —
// the effect only ever fetches once per mount (no state resets needed).
export function ArtifactViewerModal({ runId, path, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const rawUrl = api.colonyArtifactRawUrl(runId, path);
  const mediaUrl = useAuthenticatedUrl(data?.binary ? rawUrl : '');
  useEffect(() => {
    let cancelled = false;
    api.getColonyArtifact(runId, path)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [runId, path]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] rounded-xl border border-gray-800 bg-gray-950 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <FileText size={14} className="text-gray-500 flex-shrink-0" />
          <span className="text-xs font-mono text-gray-200 truncate flex-1">{path === '__report__' ? 'Full report' : path}</span>
          {data?.source && data.source !== 'report' && <span className="text-xs text-blue-300/80 border border-blue-900/40 bg-blue-950/30 rounded px-1.5 py-0.5 flex-shrink-0" title="This file is not in the working tree — it was read from the run's git branch">{data.source}</span>}
          {data?.truncated && <span className="text-xs text-amber-400 flex-shrink-0">truncated</span>}
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300 flex-shrink-0"><X size={15} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto p-4">
          {error ? (
            <p className="text-xs text-amber-300 leading-relaxed">{error}</p>
          ) : !data ? (
            <div className="flex items-center gap-2 text-gray-600 justify-center py-6"><Loader2 size={14} className="animate-spin" /><span className="text-xs">Loading…</span></div>
          ) : data.binary ? (
            data.mime?.startsWith('image/') ? (
              <img src={mediaUrl} alt={path} className="max-w-full mx-auto rounded" />
            ) : data.mime?.startsWith('audio/') ? (
              <audio controls src={mediaUrl} className="w-full" />
            ) : data.mime?.startsWith('video/') ? (
              <video controls src={mediaUrl} className="max-w-full mx-auto rounded" />
            ) : (
              <button type="button" onClick={() => downloadAuthenticated(api.colonyArtifactRawUrl(runId, path, { download: true }), path)} className="inline-flex items-center gap-1.5 text-sm text-blue-300 hover:underline">
                <FileText size={14} /> Download {path} ({Math.round((data.size || 0) / 1024)} KB)
              </button>
            )
          ) : (path === '__report__' || /\.(md|markdown)$/i.test(path)) ? (
            <div className="text-sm text-gray-300"><AgentMarkdown>{data.content}</AgentMarkdown></div>
          ) : (
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-words leading-relaxed">{data.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArtifactsPanel({ artifacts, onOpenArtifact, onDeleteRun }) {
  if (!artifacts?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Package size={13} className="text-green-400/70" />
        <span className="text-xs font-semibold text-gray-300">Artifacts</span>
        <span className="text-xs text-gray-600">— from all runs; click a file to open it</span>
      </div>
      <div className="flex flex-col gap-2">
        {artifacts.map(a => (
          <div key={a.run_id} className="rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2 group">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-gray-400 truncate flex-1">{runLabel(a)}</span>
              <span className="text-xs text-gray-600 flex-shrink-0">{formatDate(a.created_at * 1000)}</span>
              {onDeleteRun && (
                <button
                  type="button"
                  onClick={() => onDeleteRun(a.run_id)}
                  className="p-1 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition flex-shrink-0"
                  title="Delete this run and its artifacts"
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            {a.links?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {a.links.map((l, i) => (
                  isSafeUrl(l)
                    ? <a key={i} href={l} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs text-blue-300 hover:underline truncate max-w-xs">
                        <ExternalLink size={10} className="flex-shrink-0" /> {l}
                      </a>
                    : <span key={i} className="flex items-center gap-1 text-xs text-gray-400 truncate max-w-xs">
                        <ExternalLink size={10} className="flex-shrink-0" /> {l}
                      </span>
                ))}
              </div>
            )}
            {a.files?.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {a.files.map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onOpenArtifact(a.run_id, f)}
                    className="text-xs text-blue-300/90 hover:text-blue-200 hover:underline font-mono truncate max-w-xs text-left"
                    title="Open this artifact"
                  >
                    {f}
                  </button>
                ))}
              </div>
            )}
            {a.report && (
              <div className="mt-1">
                <button
                  type="button"
                  onClick={() => onOpenArtifact(a.run_id, '__report__')}
                  className="inline-flex items-center gap-1 text-xs text-green-300/90 hover:text-green-200 hover:underline"
                  title="Open the full report"
                >
                  <FileText size={10} className="flex-shrink-0" /> Full report
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Colonies-first team room panels ───────────────────────────────────────────

// Crew — the colony's identity leads the page. Staff profiles for the team's
// recipe, rendered as initials avatars (there is no shared avatar component).
export function CrewPanel({ crew, recipeName }) {
  if (!crew?.length) return null;
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        <Users size={13} className="text-blue-400/70" />
        <span className="text-xs font-semibold text-gray-300">Crew</span>
        <span className="text-xs text-gray-600">— {recipeName || 'team'} · staffed by the operator at run start</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
        {crew.map(member => {
          const initials = String(member.display_name || member.role || '?')
            .split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
          const color = member.avatar_color || '#60a5fa';
          return (
            <div key={member.id || member.role_key} className="flex items-center gap-2.5 rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-2">
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
                style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
              >
                {initials}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-gray-200 truncate">{member.display_name || member.role}</p>
                <p className="text-xs text-gray-600 truncate">{member.role}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// One row of the colony's work queue.
function WorkItemRow({ item, onAccept, onDismiss, onDelete, onStart, onOpenRun, busy }) {
  const meta = ITEM_STATUS_META[item.status] || ITEM_STATUS_META.queued;
  return (
    <div className="flex items-center gap-2.5 py-2 group">
      <span className={`text-xs border rounded px-1.5 py-0.5 flex-shrink-0 ${meta.chip}`}>{meta.label}</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-200 truncate">
          {item.title}
          {item.board_card?.number && <span className="text-gray-500"> #{item.board_card.number}</span>}
        </p>
        <p className="text-xs text-gray-600 truncate">
          {item.source}
          {item.status === 'proposed' && item.match_reason ? ` · ${item.match_reason}` : ''}
          {item.direction ? ` · ${item.direction.split('\n')[0]}` : ''}
        </p>
      </div>
      {item.status === 'proposed' && (
        <>
          <Button size="sm" variant="secondary" onClick={() => onAccept(item)}><CheckCircle2 size={11} /> Accept</Button>
          <Button size="sm" variant="ghost" className="text-gray-500" onClick={() => onDismiss(item)}>Dismiss</Button>
        </>
      )}
      {item.status === 'queued' && (
        <>
          <Button size="sm" onClick={() => onStart(item)} disabled={busy} title="Collect direction + models, then launch">
            <Play size={11} /> Start
          </Button>
          <button onClick={() => onDelete(item)} className="p-1.5 text-gray-700 hover:text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition flex-shrink-0" title="Remove from queue">
            <Trash2 size={13} />
          </button>
        </>
      )}
      {item.status === 'claimed' && item.run_id && (
        <Button size="sm" variant="secondary" onClick={() => onOpenRun(item.run_id)}>
          <Loader2 size={11} className="animate-spin" /> View run
        </Button>
      )}
    </div>
  );
}

// Work — the colony's queue plus the "give them work" affordance. Replaces the
// old "Launch a run" panel: adding work is queueing; launching is the Start
// step on a queued item.
export function WorkQueuePanel({
  queue, activeColonyId,
  giveWorkOpen, setGiveWorkOpen, addingWork, onAddWork,
  goal, setGoal, projectBoard, selectedBoardCard, selectedBoardCardId, setSelectedBoardCardId,
  boardSearch, setBoardSearch, visibleBoardCards,
  onAccept, onDismiss, onDelete, onStart, onOpenRun, onQueueCard,
}) {
  const open = (queue || []).filter(i => ['proposed', 'queued', 'claimed'].includes(i.status));
  const order = { proposed: 0, queued: 1, claimed: 2 };
  const sorted = [...open].sort((a, b) => (order[a.status] - order[b.status]) || (a.created_at - b.created_at));

  // Idle-colony nudge: an empty queue suggests open board work instead of a
  // blank panel. Cards already queued (by board card id) are filtered out.
  const queuedCardIds = new Set(open.map(i => i.board_card?.id).filter(Boolean));
  const suggestions = open.length === 0
    ? (projectBoard?.cards || []).filter(c => c.status !== 'done' && !queuedCardIds.has(c.id)).slice(0, 3)
    : [];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <ListTodo size={13} className="text-amber-400/80" />
        <span className="text-xs font-semibold text-gray-300">Work</span>
        <span className="text-xs text-gray-600">({open.length} open)</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setGiveWorkOpen(v => !v)}>
          <Plus size={12} /> Give them work
        </Button>
      </div>

      {giveWorkOpen && (
        <div className="rounded-lg border border-gray-800 bg-gray-950/30 px-3 py-3 flex flex-col gap-3">
          {projectBoard?.configured && (projectBoard.cards || []).length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-gray-400">Work item from the board (optional)</span>
                {selectedBoardCard && (
                  <button type="button" onClick={() => setSelectedBoardCardId(null)} className="text-xs text-gray-500 hover:text-gray-300">unlink</button>
                )}
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-3 top-2.5 text-gray-600" />
                <input
                  value={boardSearch}
                  onChange={e => setBoardSearch(e.target.value)}
                  placeholder="Search issues and board tasks"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600"
                />
              </div>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
                {visibleBoardCards.map(card => {
                  const selected = selectedBoardCardId === card.id;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setSelectedBoardCardId(selected ? null : card.id)}
                      className={`w-full text-left px-3 py-2 transition-colors ${selected ? 'bg-blue-950/30' : 'bg-gray-900/40 hover:bg-gray-800/50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <Link2 size={12} className={selected ? 'text-blue-300' : 'text-gray-600'} />
                        <span className="text-xs font-medium text-gray-200 truncate flex-1">{card.title}</span>
                        {card.number && <span className="text-xs text-gray-500">#{card.number}</span>}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-600">
                        <span>{card.status_label || card.status || 'backlog'}</span>
                        {card.url && <span className="truncate">{card.url}</span>}
                      </div>
                    </button>
                  );
                })}
                {visibleBoardCards.length === 0 && (
                  <div className="px-3 py-3 text-xs text-gray-600 text-center">No matching work items</div>
                )}
              </div>
            </div>
          )}
          {!projectBoard?.configured && (
            <p className="text-xs text-amber-400/80">{projectBoard?.error || 'No repository configured — edit the colony to set one.'}</p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-gray-400">Direction</span>
            <textarea value={goal} onChange={e => setGoal(e.target.value)} rows={2}
              placeholder={selectedBoardCard ? 'Optional notes for the selected work item…' : 'Describe what the team should work on…'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
          </div>

          <Button onClick={onAddWork} disabled={(!goal.trim() && !selectedBoardCard) || addingWork}>
            {addingWork ? <><Loader2 size={13} className="animate-spin" /> Adding…</> : <><Plus size={13} /> Add to queue</>}
          </Button>
        </div>
      )}

      {sorted.length > 0 ? (
        <div className="flex flex-col divide-y divide-gray-800/60">
          {sorted.map(item => (
            <WorkItemRow
              key={item.id}
              item={item}
              busy={!!activeColonyId}
              onAccept={onAccept}
              onDismiss={onDismiss}
              onDelete={onDelete}
              onStart={onStart}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      ) : (
        <div className="py-2">
          <p className="text-xs text-gray-600">The queue is empty — this colony is ready for work.</p>
          {suggestions.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-gray-500">Suggested from the board</span>
              {suggestions.map(card => (
                <div key={card.id} className="flex items-center gap-2 rounded-lg bg-gray-950/50 border border-gray-800/60 px-2.5 py-1.5">
                  <Link2 size={11} className="text-gray-600 flex-shrink-0" />
                  <span className="text-xs text-gray-300 truncate flex-1">{card.title}{card.number ? ` #${card.number}` : ''}</span>
                  <Button size="sm" variant="ghost" className="text-blue-400" onClick={() => onQueueCard(card)}>
                    <Plus size={11} /> Queue
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Start step — a queued item becomes a run. Collects/edits the direction and
// the model plan (the inputs that used to live on the launch form), then
// launches through the queue start endpoint.
export function StartRunModal({
  team, recipe,
  item, direction, setDirection,
  model, setModel, models, groupedModels, cloudEnabled,
  modelPlan, setModelPlan, crew, proposing, onProposeModels,
  advancedOpen, setAdvancedOpen,
  launching, error, activeColonyId, onStart, onClose,
}) {
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  if (!item) return null;
  const card = item.board_card;
  const publishEnabled = !!team?.github_publish;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-gray-800 bg-gray-950 p-5 flex flex-col gap-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-gray-100">Start this work</p>
          <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-300"><X size={15} /></button>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2.5">
          <p className="text-xs font-medium text-gray-200">
            {item.title}
            {card?.number && <span className="text-gray-500"> #{card.number}</span>}
          </p>
          <p className="text-xs text-gray-600 mt-0.5 truncate">
            {card?.repo || item.source}
            {card?.labels?.length ? ` · ${card.labels.join(', ')}` : ''}
          </p>
        </div>

        <div className={`rounded-lg border px-3 py-2.5 ${publishEnabled ? 'border-amber-800/50 bg-amber-950/20' : 'border-blue-900/40 bg-blue-950/15'}`}>
          <p className="text-xs font-medium text-gray-200">
            Execution policy: {recipe?.execution_policy?.mode === 'read_only' ? 'Read-only review' : recipe?.execution_policy?.mode === 'artifact_only' ? 'Artifacts only' : 'Repository delivery'}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {team?.github_review ? 'The final report may be posted to the original PR. ' : ''}
            {publishEnabled ? 'This successful run may commit, push, and open a Draft PR.' : 'This run cannot publish repository changes.'}
          </p>
          {publishEnabled && (
            <label className="flex items-start gap-2 mt-2 text-xs text-amber-200/80 cursor-pointer">
              <input type="checkbox" checked={publishConfirmed} onChange={e => setPublishConfirmed(e.target.checked)} className="mt-0.5" />
              <span>I understand this run may publish intentional repository changes. Failed or stopped runs will not publish.</span>
            </label>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Direction</span>
          <textarea value={direction} onChange={e => setDirection(e.target.value)} rows={3} autoFocus
            placeholder={card ? 'Optional notes for the work item…' : 'Describe what the team should do…'}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600" />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-gray-400">Colony lead / base model</span>
          <select value={model} onChange={e => setModel(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
            {Object.entries(groupedModels).map(([prov, list]) => {
              // tools === false → the model can't drive colony agents; hide it here.
              const opts = (Array.isArray(list) ? list : []).filter(m => (cloudEnabled || (m.provider || prov) === 'ollama') && m.tools !== false);
              if (opts.length === 0) return null;
              return <optgroup key={prov} label={PROVIDER_LABEL[prov] || prov}>{opts.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}</optgroup>;
            })}
          </select>
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-950/30">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="queue-start-advanced"
            onClick={() => setAdvancedOpen(v => !v)}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-gray-800/40 transition-colors"
          >
            <div>
              <p className="text-xs font-medium text-gray-300">Per-role model plan</p>
              <p className="text-xs text-gray-600 mt-0.5">{modelPlan ? 'Plan set — expand to edit' : 'Optional: assign a model to each role'}</p>
            </div>
            <ChevronRight size={13} className={`text-gray-500 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} />
          </button>
          {advancedOpen && (
            <div id="queue-start-advanced" className="border-t border-gray-800 px-3 py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-400">Model plan</span>
                <button type="button" onClick={onProposeModels} disabled={proposing} className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 disabled:opacity-50">
                  {proposing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  {modelPlan ? 'Re-propose plan' : 'Generate model plan'}
                </button>
              </div>
              {modelPlan && crew?.length > 0 && (
                <div className="rounded-lg border border-gray-800 overflow-hidden">
                  {[{ role_key: 'operator', display_name: 'Ari Morgan', role: 'Orchestrator' }, ...crew].map(member => (
                    <div key={member.role_key} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60 last:border-0">
                      <span className="flex flex-col w-40 flex-shrink-0 min-w-0" title={`${member.role || member.role_key}${member.display_name ? ` — ${member.display_name}` : ''}`}>
                        <span className="text-xs text-gray-300 truncate">{member.role || member.role_key}</span>
                        {member.display_name && member.display_name !== (member.role || '') && (
                          <span className="text-[10px] text-gray-500 truncate">{member.display_name}</span>
                        )}
                      </span>
                      <select value={modelPlan[member.role_key] || ''} onChange={e => setModelPlan(p => ({ ...p, [member.role_key]: e.target.value }))} className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                        {models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center gap-2 pt-1">
          <Button onClick={onStart} disabled={!model || launching || !!activeColonyId || (publishEnabled && !publishConfirmed)} className="flex-1">
            {launching ? <><Loader2 size={13} className="animate-spin" /> Starting…</>
              : activeColonyId ? <><Loader2 size={13} className="animate-spin" /> A run is in progress…</>
              : <><Zap size={13} /> Start run</>}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}
