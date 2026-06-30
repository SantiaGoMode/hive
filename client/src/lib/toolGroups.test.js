import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOL_GROUPS, toggleTool, toolPickerModel } from './toolGroups';

describe('toggleTool', () => {
  it('adds an id that is not selected', () => {
    expect(toggleTool(['memory'], 'web_search')).toEqual(['memory', 'web_search']);
  });
  it('removes an id that is selected', () => {
    expect(toggleTool(['memory', 'web_search'], 'memory')).toEqual(['web_search']);
  });
  it('does not mutate the input array', () => {
    const input = ['memory'];
    toggleTool(input, 'sandbox');
    expect(input).toEqual(['memory']);
  });
  it('tolerates a missing/invalid selection', () => {
    expect(toggleTool(undefined, 'memory')).toEqual(['memory']);
  });
});

describe('toolPickerModel', () => {
  it('flags selected built-in groups and counts overrides', () => {
    const m = toolPickerModel(['web_search', 'sandbox']);
    expect(m.builtin.find(g => g.id === 'web_search').selected).toBe(true);
    expect(m.builtin.find(g => g.id === 'memory').selected).toBe(false);
    expect(m.overrideCount).toBe(2);
    expect(m.builtin).toHaveLength(BUILTIN_TOOL_GROUPS.length);
  });

  it('maps MCP servers to mcp:<id> rows with selected + connected state', () => {
    const m = toolPickerModel(['mcp:github'], [
      { id: 'github', name: 'GitHub', connected: true, tool_count: 12 },
      { id: 'notion', name: 'Notion', connected: false, tool_count: 0 },
    ]);
    const github = m.mcp.find(s => s.id === 'mcp:github');
    const notion = m.mcp.find(s => s.id === 'mcp:notion');
    expect(github).toMatchObject({ id: 'mcp:github', name: 'GitHub', selected: true, connected: true, toolCount: 12 });
    // disconnected server is still listed (rendered dimmed), just not connected
    expect(notion).toMatchObject({ selected: false, connected: false });
    expect(m.overrideCount).toBe(1); // mcp:github counts toward overrides
  });

  it('handles empty selection and no servers', () => {
    const m = toolPickerModel([], []);
    expect(m.overrideCount).toBe(0);
    expect(m.mcp).toEqual([]);
    expect(m.builtin.every(g => g.selected === false)).toBe(true);
  });

  it('coerces a missing connected flag to false', () => {
    const m = toolPickerModel([], [{ id: 'x', name: 'X' }]);
    expect(m.mcp[0].connected).toBe(false);
  });
});
