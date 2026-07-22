import { useState, useEffect, useRef, useCallback } from 'react';
import { Clock, MessageSquare, Wrench, Trash2, Download, Eye, ArrowRight, Pencil, Check, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Button } from '../ui/Button';
import { MarkdownContent } from '../MarkdownContent';
import { formatDate, download, exportMarkdown } from '../../lib/utils';
import { toast } from '../../stores/toastStore';
import { DeleteConfirm } from '../agents/DeleteConfirm';

function InlineRename({ value, onSave, onCancel }) {
  const [text, setText] = useState(value);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const submit = () => { if (text.trim()) onSave(text.trim()); else onCancel(); };
  return (
    <div className="flex items-center gap-1 -mx-1">
      <input
        ref={inputRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
        className="flex-1 bg-gray-800 border border-blue-500/60 rounded px-2 py-0.5 text-sm text-gray-100 focus:outline-none min-w-0"
      />
      <button onClick={submit} className="p-1 text-green-400 hover:text-green-300"><Check size={13} /></button>
      <button onClick={onCancel} className="p-1 text-gray-500 hover:text-gray-300"><X size={13} /></button>
    </div>
  );
}

function SessionRow({ session, onView, onContinue, onDelete, onRename }) {
  const [renaming, setRenaming] = useState(false);
  const displayTitle = session.title || session.preview || session.id.slice(0, 8);

  const handleSave = async (title) => {
    try {
      await onRename(title);
      setRenaming(false);
    } catch { toast.error('Failed to rename'); }
  };

  return (
    <div className="group flex flex-col gap-1 px-3 py-2.5 rounded-lg bg-gray-900 border border-gray-800 hover:border-gray-700 transition-colors">
      {renaming ? (
        <InlineRename value={displayTitle} onSave={handleSave} onCancel={() => setRenaming(false)} />
      ) : (
        <div className="flex items-center gap-1 min-w-0">
          <p className="text-sm text-gray-200 truncate flex-1" title={displayTitle}>{displayTitle}</p>
          <button
            onClick={() => setRenaming(true)}
            className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-600 hover:text-gray-300 rounded transition-opacity flex-shrink-0"
            title="Rename"
          >
            <Pencil size={11} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><Clock size={10} />{formatDate(session.modified_at)}</span>
        <span className="flex items-center gap-1"><MessageSquare size={10} />{session.user_message_count}</span>
        {session.tools_used?.length > 0 && (
          <span className="flex items-center gap-1"><Wrench size={10} />{session.tools_used.slice(0, 2).join(', ')}</span>
        )}
      </div>
      <div className="flex gap-1 mt-0.5">
        {onContinue && (
          <Button size="sm" variant="ghost" onClick={onContinue} className="flex-1 justify-center gap-1 text-blue-400 hover:text-blue-300">
            <ArrowRight size={12} /> Continue
          </Button>
        )}
        <Button size="icon" variant="ghost" onClick={onView} title="View session">
          <Eye size={13} />
        </Button>
        <Button size="icon" variant="ghost" onClick={onDelete} title="Delete session">
          <Trash2 size={13} className="text-red-400" />
        </Button>
      </div>
    </div>
  );
}

export function SessionList({ agentId, onContinue }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getSessions(agentId).then(setSessions).catch(() => setSessions([])).finally(() => setLoading(false));
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const handleView = async (sess) => {
    try {
      const full = await api.getSession(agentId, sess.id);
      setViewing(full);
    } catch { toast.error('Failed to load session'); }
  };

  const handleDelete = async () => {
    await api.deleteSession(agentId, deleteTarget.id);
    toast.success('Session deleted');
    load();
  };

  const handleRename = async (sess, title) => {
    await api.renameSession(agentId, sess.id, title);
    setSessions(prev => prev.map(s => s.id === sess.id ? { ...s, title } : s));
  };

  const handleExport = async (sess, format) => {
    const full = await api.getSession(agentId, sess.id);
    const name = sess.title || `session-${sess.id.slice(0, 8)}`;
    if (format === 'md') {
      download(exportMarkdown(full), `${name}.md`, 'text/markdown');
    } else {
      download(JSON.stringify(full, null, 2), `${name}.json`, 'application/json');
    }
  };

  if (loading) return <div className="text-gray-500 text-sm py-8 text-center">Loading sessions…</div>;
  if (!sessions.length) return (
    <div className="text-center py-12 text-gray-500">
      <MessageSquare size={40} className="mx-auto mb-3 opacity-30" />
      <p>No sessions yet</p>
      <p className="text-xs mt-1">Start a chat to create your first session</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
              <h3 className="font-semibold">{viewing.title || `Session ${viewing.id.slice(0, 8)}`}</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => handleExport(viewing, 'md')}><Download size={12} />MD</Button>
                <Button size="sm" variant="secondary" onClick={() => handleExport(viewing, 'json')}><Download size={12} />JSON</Button>
                <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>Close</Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3">
              {viewing.messages.map((msg, i) => (
                <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-gray-800 text-gray-100 rounded-tl-sm'}`}>
                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap text-sm">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</p>
                    ) : (
                      <MarkdownContent>{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</MarkdownContent>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {sessions.map(sess => (
        <SessionRow
          key={sess.id}
          session={sess}
          onView={() => handleView(sess)}
          onContinue={onContinue ? () => onContinue(sess.id) : null}
          onDelete={() => setDeleteTarget(sess)}
          onRename={(title) => handleRename(sess, title)}
        />
      ))}

      <DeleteConfirm
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        itemName={deleteTarget?.title || deleteTarget?.id?.slice(0, 8) || ''}
        itemType="session"
      />
    </div>
  );
}
