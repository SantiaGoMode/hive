import { describe, expect, it } from 'vitest';
import {
  buildPipelineFlowPreview,
  flattenModelIds,
  validatePipelineDraft,
} from './pipelineBuilderUtils';

describe('validatePipelineDraft', () => {
  const agents = [
    { id: 'agent-1', name: 'Researcher', model: 'ollama/ready' },
    { id: 'agent-2', name: 'Writer', model: '' },
  ];

  it('flags missing pipeline and step fields inline', () => {
    const result = validatePipelineDraft({
      name: '',
      steps: [{ agent_id: '', prompt: '' }],
      agents,
    });

    expect(result.valid).toBe(false);
    expect(result.formErrors.name).toBe('Name is required.');
    expect(result.stepErrors[0].agent).toBe('Choose an agent for this step.');
    expect(result.stepErrors[0].prompt).toBe('Add a prompt template.');
  });

  it('flags agents without models and unavailable models', () => {
    const missingModel = validatePipelineDraft({
      name: 'Draft',
      steps: [{ agent_id: 'agent-2', prompt: '{input}' }],
      agents,
    });
    expect(missingModel.stepErrors[0].model).toBe('Selected agent has no model assigned.');

    const unavailable = validatePipelineDraft({
      name: 'Draft',
      steps: [{ agent_id: 'agent-1', prompt: '{input}' }],
      agents,
      availableModelIds: new Set(['ollama/other']),
    });
    expect(unavailable.stepErrors[0].model).toContain('not currently available');
  });

  it('accepts a valid simple pipeline', () => {
    const result = validatePipelineDraft({
      name: 'Draft',
      steps: [{ agent_id: 'agent-1', prompt: '{input}' }],
      agents,
      availableModelIds: new Set(['ollama/ready']),
    });

    expect(result.valid).toBe(true);
    expect(result.stepErrors[0]).toEqual({});
  });
});

describe('buildPipelineFlowPreview', () => {
  it('renders input and previous-output variables through sequential steps', () => {
    const preview = buildPipelineFlowPreview([
      { label: 'Research', prompt: 'Find facts about {input}' },
      { label: 'Write', prompt: 'Summarize {prev} for {input}' },
    ]);

    expect(preview[0].rendered).toBe('Find facts about Initial input');
    expect(preview[1].prev).toBe('Research output');
    expect(preview[1].rendered).toBe('Summarize Research output for Initial input');
  });

  it('keeps the same previous output for steps in one parallel group', () => {
    const preview = buildPipelineFlowPreview([
      { label: 'Seed', prompt: '{input}' },
      { label: 'Parallel A', prompt: '{prev}', parallel: true },
      { label: 'Parallel B', prompt: '{prev}', parallel: true },
      { label: 'Join', prompt: '{prev}' },
    ]);

    expect(preview[1].prev).toBe('Seed output');
    expect(preview[2].prev).toBe('Seed output');
    expect(preview[3].prev).toBe('Parallel A output + Parallel B output');
  });
});

describe('flattenModelIds', () => {
  it('normalizes grouped model responses to an id set', () => {
    expect(flattenModelIds({
      ollama: [{ name: 'llama3' }],
      gateway: [{ id: 'gateway/hive-smart', name: 'Hive Smart' }],
    })).toEqual(new Set(['llama3', 'gateway/hive-smart']));
  });
});
