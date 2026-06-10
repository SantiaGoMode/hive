import { describe, it, expect } from 'vitest';
import {
  starterAgentName,
  starterAgentDefaults,
  pickStarterModel,
  firstRunStage,
  STARTER_SYSTEM_PROMPT,
} from './starterAgent';

describe('starterAgentName', () => {
  it('derives a friendly name from an Ollama tag', () => {
    expect(starterAgentName('llama3.2:3b')).toBe('Llama3.2 Assistant');
    expect(starterAgentName('mistral:7b')).toBe('Mistral Assistant');
  });

  it('derives a name from prefixed cloud ids', () => {
    expect(starterAgentName('anthropic/claude-sonnet-4-6')).toBe('Claude Sonnet 4 6 Assistant');
    expect(starterAgentName('gateway/hive-smart')).toBe('Hive Smart Assistant');
  });

  it('falls back when model id is empty', () => {
    expect(starterAgentName('')).toBe('My First Agent');
    expect(starterAgentName()).toBe('My First Agent');
  });
});

describe('starterAgentDefaults', () => {
  it('returns a complete, minimal agent config', () => {
    const d = starterAgentDefaults('llama3.2:3b');
    expect(d.name).toBe('Llama3.2 Assistant');
    expect(d.model).toBe('llama3.2:3b');
    expect(d.tools).toEqual(['memory']);
    expect(d.system_prompt).toBe(STARTER_SYSTEM_PROMPT);
    expect(d.temperature).toBeGreaterThan(0);
    expect(d.max_tokens).toBeGreaterThan(0);
    expect(d.context_length).toBeGreaterThan(0);
  });
});

describe('pickStarterModel', () => {
  it('prefers installed Ollama models', () => {
    const grouped = {
      ollama: [{ id: 'llama3.2:3b', source: 'live' }],
      gateway: [{ id: 'gateway/hive-smart', source: 'gateway' }],
      anthropic: [{ id: 'anthropic/claude-sonnet-4-6', source: 'live' }],
    };
    expect(pickStarterModel(grouped)).toBe('llama3.2:3b');
  });

  it('falls back to gateway aliases, then live cloud models', () => {
    expect(pickStarterModel({
      ollama: [],
      gateway: [{ id: 'gateway/hive-smart', source: 'gateway' }],
    })).toBe('gateway/hive-smart');
    expect(pickStarterModel({
      ollama: [],
      gateway: [],
      anthropic: [{ id: 'anthropic/claude-sonnet-4-6', source: 'live' }],
    })).toBe('anthropic/claude-sonnet-4-6');
  });

  it('ignores curated fallback suggestions (no key set)', () => {
    expect(pickStarterModel({
      ollama: [],
      anthropic: [{ id: 'anthropic/claude-sonnet-4-6', source: 'fallback' }],
      openai: [{ id: 'openai/gpt-4o', source: 'fallback' }],
    })).toBeNull();
  });

  it('handles empty/invalid input', () => {
    expect(pickStarterModel(null)).toBeNull();
    expect(pickStarterModel({})).toBeNull();
    expect(pickStarterModel([])).toBeNull();
  });
});

describe('firstRunStage', () => {
  const usable = { ollama: [{ id: 'llama3.2:3b' }] };
  const unusable = { ollama: [], anthropic: [{ id: 'anthropic/x', source: 'fallback' }] };

  it('is complete once any agent exists', () => {
    expect(firstRunStage({ agents: [{ id: 'a1' }], groupedModels: usable })).toBe('complete');
    expect(firstRunStage({ agents: [{ id: 'a1' }], groupedModels: null })).toBe('complete');
  });

  it('is loading until models are fetched', () => {
    expect(firstRunStage({ agents: [], groupedModels: null })).toBe('loading');
    expect(firstRunStage({ agents: [], groupedModels: undefined })).toBe('loading');
  });

  it('needs an agent when a usable model exists', () => {
    expect(firstRunStage({ agents: [], groupedModels: usable })).toBe('needs-agent');
  });

  it('needs a model when nothing usable is available', () => {
    expect(firstRunStage({ agents: [], groupedModels: {} })).toBe('needs-model');
    expect(firstRunStage({ agents: [], groupedModels: unusable })).toBe('needs-model');
  });
});
