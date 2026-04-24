import { MessageSquare, Edit2, Trash2, Clock, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AgentAvatar } from './AgentAvatar';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { formatDate, download } from '../../lib/utils';
import { useActivityStore } from '../../stores/activityStore';

const EXPORT_FIELDS = [
  'name', 'persona_role', 'model',
  'avatar_color', 'temperature', 'max_tokens', 'context_length', 'system_prompt', 'tools',
];

export function AgentCard({ agent, onEdit, onDelete }) {
  const navigate = useNavigate();
  const isStreaming = useActivityStore(s => s.statuses[agent.id] === 'streaming');

  const handleExport = () => {
    const data = Object.fromEntries(EXPORT_FIELDS.map(k => [k, agent[k] ?? null]));
    download(JSON.stringify(data, null, 2), `${agent.name.replace(/\s+/g, '-').toLowerCase()}.agent.json`, 'application/json');
  };

  return (
    <div className="group bg-gray-900 border border-gray-800 rounded-xl p-5 flex flex-col gap-3 hover:border-gray-700 transition-colors">
      {/* Header */}
      <div className="flex items-start gap-3">
        <AgentAvatar name={agent.name} color={agent.avatar_color} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-100 truncate">{agent.name}</h3>
          {agent.persona_role ? (
            <p className="text-xs font-medium mt-0.5 truncate" style={{ color: agent.avatar_color }}>
              {agent.persona_role}
            </p>
          ) : agent.model ? (
            <Badge color="blue" className="mt-1">{agent.model}</Badge>
          ) : null}
        </div>

        {/* Activity dot */}
        {isStreaming ? (
          <div className="w-2 h-2 rounded-full bg-blue-400 mt-1 flex-shrink-0 animate-pulse" title="Streaming" />
        ) : agent.last_active ? (
          <div className="w-2 h-2 rounded-full bg-green-500 mt-1 flex-shrink-0" title="Idle" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-gray-600 mt-1 flex-shrink-0" title="Never used" />
        )}
      </div>

      {agent.persona_role && agent.model && (
        <div className="-mt-1">
          <Badge color="blue">{agent.model}</Badge>
        </div>
      )}

      {agent.last_active && (
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Clock size={12} />
          <span>{formatDate(agent.last_active)}</span>
        </div>
      )}

      <div className="flex gap-2 mt-auto pt-1">
        <Button size="sm" className="flex-1" onClick={() => navigate(`/chat/${agent.id}`)}>
          <MessageSquare size={14} /> Chat
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onEdit(agent)} title="Edit agent">
          <Edit2 size={14} />
        </Button>
        <Button size="icon" variant="ghost" onClick={handleExport} title="Export agent config">
          <Download size={14} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => onDelete(agent)} title="Delete agent">
          <Trash2 size={14} className="text-red-400" />
        </Button>
      </div>
    </div>
  );
}
