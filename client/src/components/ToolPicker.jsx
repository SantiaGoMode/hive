import { Wrench, CheckCircle, Plug } from 'lucide-react';
import { BUILTIN_TOOL_GROUPS, toggleTool, toolPickerModel } from '../lib/toolGroups';

// Compact tool-override picker shared by PipelinesPage (StepEditor) and
// SchedulesPage (ScheduleEditor) — previously duplicated in both (issue #4).
// Toggles built-in tool groups and MCP servers; `tools` is a string array of ids
// (`mcp:<id>` for servers). `overrideHint` is the context line shown when any
// override is set (e.g. "...for this step only." vs "...for this schedule.").
export function ToolPicker({ tools = [], onChange, mcpServers = [], overrideHint }) {
  const { builtin, mcp, overrideCount } = toolPickerModel(tools, mcpServers);
  const toggle = (id) => onChange(toggleTool(tools, id));
  const hasAny = overrideCount > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Wrench size={11} className="text-gray-500" />
          <span className="text-xs font-medium text-gray-400">Tools</span>
        </div>
        <span className="text-xs text-gray-600">
          {hasAny ? `${overrideCount} override${overrideCount !== 1 ? 's' : ''}` : 'agent defaults'}
        </span>
      </div>

      {/* Built-in groups */}
      <div className="flex flex-wrap gap-2">
        {builtin.map(g => (
          <button
            key={g.id}
            type="button"
            onClick={() => toggle(g.id)}
            title={g.desc}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors ${g.selected ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'bg-gray-800/60 border-gray-700 text-gray-500 hover:border-gray-500'}`}
          >
            {g.selected && <CheckCircle size={10} />}
            {g.label}
          </button>
        ))}
      </div>

      {/* MCP servers */}
      {mcp.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1 border-t border-gray-800">
          {mcp.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              title={s.connected ? `${s.toolCount} tools` : 'Disconnected'}
              className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors ${s.selected ? 'bg-purple-500/15 border-purple-500/40 text-purple-300' : 'bg-gray-800/60 border-gray-700 text-gray-500 hover:border-gray-500'} ${!s.connected ? 'opacity-50' : ''}`}
            >
              {s.selected && <CheckCircle size={10} />}
              <Plug size={9} />
              {s.name}
            </button>
          ))}
        </div>
      )}

      {hasAny && overrideHint && <p className="text-xs text-gray-600">{overrideHint}</p>}
    </div>
  );
}

export { BUILTIN_TOOL_GROUPS };
