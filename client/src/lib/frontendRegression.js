import { validatePipelineDraft } from '../components/pipelines/pipelineBuilderUtils';
import { firstRunStage, pickStarterModel, starterAgentDefaults } from './starterAgent';

export function onboardingDecision({ agents = [], groupedModels = null, dismissed = false } = {}) {
  const stage = firstRunStage({ agents, groupedModels });
  return {
    stage,
    showStarter: !dismissed && stage !== 'complete',
    starterModel: pickStarterModel(groupedModels),
  };
}

export function buildStarterAgentDraft(groupedModels) {
  const model = pickStarterModel(groupedModels);
  return model ? starterAgentDefaults(model) : null;
}

export function validateAgentCreationDraft(form = {}) {
  const errors = {};
  if (!form.name?.trim()) errors.name = 'Name is required.';
  if (!form.model?.trim()) errors.model = 'Choose a model before chatting.';
  return { errors, valid: Object.keys(errors).length === 0 };
}

export function chatSendState({ input = '', attachments = [], agent = {}, isActive = false } = {}) {
  const hasContent = !!input.trim() || attachments.length > 0;
  const hasModel = !!agent.model;
  return {
    canSend: hasContent && hasModel && !isActive,
    blockedReason: !hasModel ? 'missing-model' : !hasContent ? 'empty-message' : isActive ? 'generation-active' : null,
  };
}

export function sessionHistoryTarget(agentId, sessionId) {
  if (!agentId || !sessionId) return null;
  return { pathname: `/chat/${agentId}`, state: { sessionId } };
}

export function pipelineCreationState({ name = '', steps = [], agents = [], availableModelIds = null } = {}) {
  const validation = validatePipelineDraft({ name, steps, agents, availableModelIds });
  return {
    canCreate: validation.valid,
    validation,
  };
}

export function settingsSaveState(config = {}) {
  const gatewayOn = !!String(config.llm_gateway_url || '').trim();
  const ngrokAutoStart = config.ngrok_enabled === true || config.ngrok_enabled === 'true';
  return {
    canSave: true,
    gatewayOn,
    cloudKeysBypassed: gatewayOn,
    ngrokAutoStart,
    manualWebhookUrl: String(config.webhook_public_url || '').trim() || null,
  };
}
