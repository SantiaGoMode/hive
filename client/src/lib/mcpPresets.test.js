import { describe, it, expect } from 'vitest';
import { MCP_PRESETS } from './mcpPresets';

describe('MCP web search presets', () => {
  it('uses Brave Search as the automated search coverage preset', () => {
    const webSearchPresets = MCP_PRESETS.filter(p => p.category === 'Web & Search' && /search/i.test(`${p.name} ${p.description}`));
    const brave = webSearchPresets.find(p => p.id === 'brave-search');

    expect(brave).toBeTruthy();
    expect(brave.command).toBe('npx');
    expect(brave.args).toContain('@modelcontextprotocol/server-brave-search');
    expect(brave.envTemplate).toContainEqual(expect.objectContaining({ key: 'BRAVE_API_KEY', secret: true }));
  });

  it('does not rely on DuckDuckGo for search smoke coverage', () => {
    const smokePreset = MCP_PRESETS.find(p => p.id === 'brave-search');
    expect(smokePreset.name).toBe('Brave Search');
    expect(smokePreset.args).not.toMatch(/duckduckgo/i);
  });
});
