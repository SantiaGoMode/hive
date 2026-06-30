import { describe, it, expect } from 'vitest';
import {
  parseModelId, modelOptionLabel, modelBadge,
  orderedModelGroups, modelGroupHeading, MODEL_PROVIDER_ORDER,
} from './modelLabels';

describe('parseModelId', () => {
  it('splits a known provider prefix', () => {
    expect(parseModelId('anthropic/claude-sonnet-4-6')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6', full: 'anthropic/claude-sonnet-4-6' });
  });
  it('treats bare and ollama-prefixed names as ollama', () => {
    expect(parseModelId('llama3.1:8b')).toEqual({ provider: 'ollama', model: 'llama3.1:8b', full: 'llama3.1:8b' });
    expect(parseModelId('ollama/qwen3').provider).toBe('ollama');
  });
  it('treats an unknown prefix as an ollama bare name', () => {
    expect(parseModelId('library/foo:tag').provider).toBe('ollama');
  });
});

describe('modelOptionLabel', () => {
  it('appends a recognized source in parentheses', () => {
    expect(modelOptionLabel({ name: 'gpt-5', source: 'live' })).toBe('gpt-5 (live)');
    expect(modelOptionLabel({ name: 'claude', source: 'fallback' })).toBe('claude (fallback)');
  });
  it('omits unknown/missing sources', () => {
    expect(modelOptionLabel({ name: 'gpt-5' })).toBe('gpt-5');
    expect(modelOptionLabel({ name: 'gpt-5', source: 'weird' })).toBe('gpt-5');
  });
});

describe('modelBadge', () => {
  it('shows bare model for ollama and a provider-prefixed badge for cloud', () => {
    expect(modelBadge('llama3.1:8b').text).toBe('llama3.1:8b');
    const b = modelBadge('anthropic/claude-sonnet-4-6');
    expect(b.text).toBe('Claude: claude-sonnet-4-6');
    expect(b.title).toBe('anthropic/claude-sonnet-4-6');
  });
});

describe('modelGroupHeading', () => {
  it('labels ollama as local and flags gateway as recommended', () => {
    expect(modelGroupHeading('ollama')).toBe('Ollama (local)');
    expect(modelGroupHeading('gateway')).toBe('LLM Gateway (recommended)');
    expect(modelGroupHeading('anthropic')).toBe('Anthropic');
  });
});

describe('orderedModelGroups', () => {
  it('orders by MODEL_PROVIDER_ORDER with gateway first and skips empty groups', () => {
    const grouped = {
      openai: [{ id: 'openai/gpt-5', name: 'gpt-5' }],
      ollama: [{ id: 'llama3', name: 'llama3' }],
      gateway: [{ id: 'gateway/hive-smart', name: 'hive-smart' }],
      anthropic: [], // empty → skipped
    };
    const out = orderedModelGroups(grouped);
    expect(out.map(([p]) => p)).toEqual(['gateway', 'ollama', 'openai']);
    expect(MODEL_PROVIDER_ORDER[0]).toBe('gateway');
  });

  it('appends unknown providers after the known order', () => {
    const out = orderedModelGroups({
      custom: [{ id: 'custom/x', name: 'x' }],
      ollama: [{ id: 'llama3', name: 'llama3' }],
    });
    expect(out.map(([p]) => p)).toEqual(['ollama', 'custom']);
  });

  it('returns [] for empty, null, or array inputs', () => {
    expect(orderedModelGroups(null)).toEqual([]);
    expect(orderedModelGroups({})).toEqual([]);
    expect(orderedModelGroups(['a'])).toEqual([]);
  });
});
