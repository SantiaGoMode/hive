import { describe, expect, it } from 'vitest';
import { STARTER_MODELS, buildStarterAgent } from './starterAgent';

describe('starter agent helpers', () => {
  it('builds a chat-ready starter agent for the selected model', () => {
    const agent = buildStarterAgent('llama3.2:3b');

    expect(agent.name).toBe('Hive Starter');
    expect(agent.model).toBe('llama3.2:3b');
    expect(agent.tools).toContain('memory');
    expect(agent.system_prompt).toContain('local-first assistant');
  });

  it('exposes starter model choices for onboarding', () => {
    expect(STARTER_MODELS.length).toBeGreaterThan(0);
    expect(STARTER_MODELS[0]).toHaveProperty('name');
  });
});
