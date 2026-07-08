import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Bot, MessageSquare } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { cn } from '../../lib/utils';

export function AgentSwitcher({ open, onClose }) {
  const { agents } = useAgentStore();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const filtered = query.trim()
    ? agents.filter(a =>
        a.name.toLowerCase().includes(query.toLowerCase()) ||
        a.description?.toLowerCase().includes(query.toLowerCase()) ||
        a.model?.toLowerCase().includes(query.toLowerCase()),
      )
    : agents;

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Keep cursor in bounds when filter changes
  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Scroll cursor into view
  useEffect(() => {
    const item = listRef.current?.children[cursor];
    item?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const go = useCallback((agent) => {
    navigate(`/chat/${agent.id}`);
    onClose();
  }, [navigate, onClose]);

  const handleKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      if (filtered[cursor]) go(filtered[cursor]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-md bg-[#1a1d27] border border-gray-700 rounded-xl shadow-2xl overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-700">
          <Search size={15} className="text-gray-500 flex-shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-gray-100 text-sm placeholder-gray-600 focus:outline-none"
            placeholder="Search agents…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          <kbd className="text-xs text-gray-600 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5">esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-600 text-center py-6">No agents found</p>
          ) : (
            filtered.map((agent, i) => (
              <button
                key={agent.id}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
                  i === cursor ? 'bg-blue-600/15' : 'hover:bg-gray-800',
                )}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(agent)}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ backgroundColor: agent.avatar_color || '#d97706' }}
                >
                  <Bot size={13} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-200 truncate">{agent.name}</p>
                  {agent.description && (
                    <p className="text-xs text-gray-500 truncate">{agent.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {agent.model && <span className="text-xs text-gray-600">{agent.model.replace(/^.*\//,'')}</span>}
                  <MessageSquare size={11} className="text-gray-600" />
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer hint */}
        {filtered.length > 0 && (
          <div className="px-4 py-2 border-t border-gray-800 flex gap-3 text-xs text-gray-600">
            <span><kbd className="bg-gray-800 border border-gray-700 rounded px-1">↑↓</kbd> navigate</span>
            <span><kbd className="bg-gray-800 border border-gray-700 rounded px-1">↵</kbd> open chat</span>
          </div>
        )}
      </div>
    </div>
  );
}
