import { describe, it, expect } from 'vitest';
import { classifyLocalModel, groupModelsByTier, parameterSizeB, capabilityBadges } from './modelClassification';

const m = (name, caps, params) => ({ name, capabilities: caps, details: params ? { parameter_size: params } : {} });

describe('classifyLocalModel', () => {
  it('tiers by capability and capacity', () => {
    expect(classifyLocalModel(m('qwen2.5-coder:14b', ['completion', 'tools', 'insert'], '14.8B'))).toBe('agent-ready');
    expect(classifyLocalModel(m('qwen3:14b', ['completion', 'tools', 'thinking'], '14.8B'))).toBe('agent-ready');
    expect(classifyLocalModel(m('qwen2.5:1.5b', ['completion', 'tools'], '1.5B'))).toBe('tools-light');
    expect(classifyLocalModel(m('llama3.1:8b', ['completion', 'tools'], '8.0B'))).toBe('tools-light'); // weak multi-step family
    expect(classifyLocalModel(m('mistral:7b', ['completion', 'tools'], '7.2B'))).toBe('tools-light');
    expect(classifyLocalModel(m('deepseek-coder-v2:16b', ['completion', 'insert'], '15.7B'))).toBe('chat-only');
    expect(classifyLocalModel(m('gemma3:4b', ['completion'], '4.3B'))).toBe('chat-only');
    expect(classifyLocalModel(m('nomic-embed-text:latest', ['embedding'], '137M'))).toBe('embedding');
  });

  it('treats unknown capabilities as chat-only rather than guessing agent-ready', () => {
    expect(classifyLocalModel({ name: 'mystery:9b', capabilities: null })).toBe('chat-only');
  });
});

describe('parameterSizeB', () => {
  it('parses details and falls back to the name tag', () => {
    expect(parameterSizeB(m('x', [], '8.2B'))).toBe(8.2);
    expect(parameterSizeB({ name: 'foo:13b', details: {} })).toBe(13);
    expect(parameterSizeB({ name: 'foo:latest', details: {} })).toBe(null);
  });
});

describe('groupModelsByTier', () => {
  const models = [
    m('qwen2.5:1.5b', ['completion', 'tools'], '1.5B'),
    m('qwen3:14b', ['completion', 'tools', 'thinking'], '14.8B'),
    m('qwen2.5:32b', ['completion', 'tools'], '32.8B'),
    m('gemma3:1b', ['completion'], '1B'),
    m('nomic-embed-text:latest', ['embedding'], '137M'),
  ];

  it('groups best-tier-first and sorts larger models first within a tier', () => {
    const groups = groupModelsByTier(models);
    expect(groups[0].tier).toBe('agent-ready');
    expect(groups[0].models.map(x => x.name)).toEqual(['qwen2.5:32b', 'qwen3:14b']);
    expect(groups.map(g => g.tier)).toEqual(['agent-ready', 'tools-light', 'chat-only', 'embedding']);
  });

  it('filters by search query and drops empty tiers', () => {
    const groups = groupModelsByTier(models, 'qwen3');
    expect(groups).toHaveLength(1);
    expect(groups[0].models.map(x => x.name)).toEqual(['qwen3:14b']);
  });
});

describe('capabilityBadges', () => {
  it('maps capabilities to labeled badges', () => {
    const badges = capabilityBadges(m('qwen3:14b', ['completion', 'tools', 'thinking'], '14.8B'));
    expect(badges.map(b => b.key)).toEqual(['tools', 'thinking']);
  });
});
