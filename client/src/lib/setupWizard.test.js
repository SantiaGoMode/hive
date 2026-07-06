import { describe, it, expect } from 'vitest';
import {
  SETUP_STEPS, nextStep, prevStep, hasModelAccess, needsSetup, dependencyChecklist,
} from './setupWizard';

const baseStatus = {
  setup_completed: false,
  ollama: { reachable: false, url: 'http://localhost:11434', version: null, installed_models: 0 },
  docker: { available: false, sandbox_ready: false },
  git: { present: false },
  gh: { present: false, authenticated: false },
  npx: { present: true },
  uvx: { present: false },
  providers: { anthropic: false, openai: false, gemini: false },
  gateway: { configured: false },
};

describe('step navigation', () => {
  it('walks forward through all steps and clamps at the end', () => {
    let s = SETUP_STEPS[0];
    const walked = [s];
    for (let i = 0; i < SETUP_STEPS.length; i++) { s = nextStep(s); walked.push(s); }
    expect(walked.slice(0, SETUP_STEPS.length)).toEqual(SETUP_STEPS);
    expect(s).toBe(SETUP_STEPS[SETUP_STEPS.length - 1]);
  });

  it('clamps at the start going backward', () => {
    expect(prevStep(SETUP_STEPS[0])).toBe(SETUP_STEPS[0]);
    expect(prevStep(SETUP_STEPS[1])).toBe(SETUP_STEPS[0]);
  });
});

describe('hasModelAccess', () => {
  it('is false with nothing configured', () => {
    expect(hasModelAccess(baseStatus)).toBe(false);
    expect(hasModelAccess(null)).toBe(false);
  });

  it('requires an installed model, not just a reachable Ollama', () => {
    expect(hasModelAccess({ ...baseStatus, ollama: { ...baseStatus.ollama, reachable: true } })).toBe(false);
    expect(hasModelAccess({ ...baseStatus, ollama: { ...baseStatus.ollama, reachable: true, installed_models: 1 } })).toBe(true);
  });

  it('accepts a provider key or a configured gateway', () => {
    expect(hasModelAccess({ ...baseStatus, providers: { ...baseStatus.providers, openai: true } })).toBe(true);
    expect(hasModelAccess({ ...baseStatus, gateway: { configured: true } })).toBe(true);
  });
});

describe('needsSetup', () => {
  it('redirects only fresh installs', () => {
    expect(needsSetup({ setupStatus: baseStatus, agents: [] })).toBe(true);
  });

  it('never redirects once completed, or when agents exist, or before data loads', () => {
    expect(needsSetup({ setupStatus: { ...baseStatus, setup_completed: true }, agents: [] })).toBe(false);
    expect(needsSetup({ setupStatus: baseStatus, agents: [{ id: 'a1' }] })).toBe(false);
    expect(needsSetup({ setupStatus: null, agents: [] })).toBe(false);
    expect(needsSetup({ setupStatus: baseStatus, agents: null })).toBe(false);
  });
});

describe('dependencyChecklist', () => {
  it('is empty without a status payload', () => {
    expect(dependencyChecklist(null)).toEqual([]);
  });

  it('marks core dependencies as required and carries install links for missing deps', () => {
    const items = dependencyChecklist(baseStatus);
    const required = items.filter(i => i.required).map(i => i.key);
    expect(required).toEqual(['model-access', 'docker', 'gh', 'npx', 'uvx']);
    const modelAccess = items.find(i => i.key === 'model-access');
    expect(modelAccess.ok).toBe(false);
    expect(modelAccess.href).toContain('ollama.com');
    expect(items.find(i => i.key === 'docker').href).toContain('docker');
    expect(items.find(i => i.key === 'uvx').href).toContain('astral.sh');
  });

  it('reflects a healthy system', () => {
    const items = dependencyChecklist({
      ...baseStatus,
      ollama: { reachable: true, url: 'http://localhost:11434', version: '0.9.0', installed_models: 3 },
      docker: { available: true, sandbox_ready: true },
      git: { present: true, version: 'git version 2.44.0' },
    });
    expect(items.find(i => i.key === 'model-access').ok).toBe(true);
    expect(items.find(i => i.key === 'model-access').href).toBeNull();
    expect(items.find(i => i.key === 'docker').ok).toBe(true);
    expect(items.find(i => i.key === 'git').detail).toContain('2.44.0');
  });
});
