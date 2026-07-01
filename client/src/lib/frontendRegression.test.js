import { describe, expect, it } from 'vitest';
import {
  buildStarterAgentDraft,
  chatSendState,
  onboardingDecision,
  pipelineCreationState,
  sessionHistoryTarget,
  settingsSaveState,
  validateAgentCreationDraft,
} from './frontendRegression';

describe('frontend workflow regression helpers', () => {
  it('covers onboarding states and starter-agent defaults', () => {
    const groupedModels = { ollama: [{ id: 'llama3.2:3b' }] };
    expect(onboardingDecision({ agents: [], groupedModels })).toEqual({
      stage: 'needs-agent',
      showStarter: true,
      starterModel: 'llama3.2:3b',
    });

    const draft = buildStarterAgentDraft(groupedModels);
    expect(draft).toMatchObject({
      model: 'llama3.2:3b',
      persona_role: 'General Assistant',
      tools: ['memory'],
    });

    expect(onboardingDecision({ agents: [{ id: 'a1' }], groupedModels }).showStarter).toBe(false);
  });

  it('validates agent creation before chat workflows depend on the agent', () => {
    expect(validateAgentCreationDraft({ name: '', model: '' })).toEqual({
      valid: false,
      errors: {
        name: 'Name is required.',
        model: 'Choose a model before chatting.',
      },
    });
    expect(validateAgentCreationDraft({ name: 'Researcher', model: 'ollama/llama3.2:3b' }).valid).toBe(true);
  });

  it('guards chat sending and session-history targets', () => {
    expect(chatSendState({ input: '', attachments: [], agent: { model: 'm' } })).toEqual({
      canSend: false,
      blockedReason: 'empty-message',
    });
    expect(chatSendState({ input: 'hello', agent: {} }).blockedReason).toBe('missing-model');
    expect(chatSendState({ attachments: [{ name: 'notes.md' }], agent: { model: 'm' } }).canSend).toBe(true);
    expect(sessionHistoryTarget('agent-1', 'session-2')).toEqual({
      pathname: '/chat/agent-1',
      state: { sessionId: 'session-2' },
    });
  });

  it('covers pipeline creation validation and model availability', () => {
    const agents = [{ id: 'agent-1', model: 'ollama/llama3.2:3b' }];
    const ok = pipelineCreationState({
      name: 'Research',
      agents,
      availableModelIds: new Set(['ollama/llama3.2:3b']),
      steps: [{ agent_id: 'agent-1', prompt: '{input}' }],
    });
    expect(ok.canCreate).toBe(true);

    const missing = pipelineCreationState({
      name: 'Research',
      agents,
      availableModelIds: new Set(['ollama/mistral:7b']),
      steps: [{ agent_id: 'agent-1', prompt: '' }],
    });
    expect(missing.canCreate).toBe(false);
    expect(missing.validation.stepErrors[0]).toMatchObject({
      model: 'Model "ollama/llama3.2:3b" is not currently available.',
      prompt: 'Add a prompt template.',
    });
  });

  it('summarizes settings-save behavior for gateway and webhook controls', () => {
    expect(settingsSaveState({
      llm_gateway_url: ' http://127.0.0.1:4000/v1 ',
      ngrok_enabled: 'true',
      webhook_public_url: ' https://hooks.example.test ',
    })).toEqual({
      canSave: true,
      gatewayOn: true,
      cloudKeysBypassed: true,
      ngrokAutoStart: true,
      manualWebhookUrl: 'https://hooks.example.test',
    });
  });
});
