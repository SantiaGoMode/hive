export function flattenModelIds(groupedModels) {
  if (!groupedModels || typeof groupedModels !== 'object' || Array.isArray(groupedModels)) return new Set();
  const ids = [];
  for (const list of Object.values(groupedModels)) {
    if (!Array.isArray(list)) continue;
    for (const model of list) {
      const id = model?.id || model?.name;
      if (id) ids.push(id);
    }
  }
  return new Set(ids);
}

export function validatePipelineDraft({ name, steps, agents, availableModelIds = null }) {
  const agentById = new Map((agents || []).map(agent => [String(agent.id), agent]));
  const stepErrors = (steps || []).map((step) => {
    const errors = {};
    const agent = step.agent_id ? agentById.get(String(step.agent_id)) : null;

    if (!step.agent_id) errors.agent = 'Choose an agent for this step.';
    else if (!agent) errors.agent = 'This saved agent is no longer available.';
    else if (!agent.model) errors.model = 'Selected agent has no model assigned.';
    else if (availableModelIds && availableModelIds.size > 0 && !availableModelIds.has(agent.model)) {
      errors.model = `Model "${agent.model}" is not currently available.`;
    }

    if (!step.prompt?.trim()) errors.prompt = 'Add a prompt template.';
    return errors;
  });

  const formErrors = {};
  if (!name?.trim()) formErrors.name = 'Name is required.';
  if (!steps?.length) formErrors.steps = 'Add at least one step.';

  return {
    formErrors,
    stepErrors,
    valid: Object.keys(formErrors).length === 0 && stepErrors.every(errors => Object.keys(errors).length === 0),
  };
}

export function buildPipelineFlowPreview(steps, sampleInput = 'Initial input') {
  let prev = sampleInput;
  const previews = [];
  const list = steps || [];

  for (let i = 0; i < list.length; i++) {
    const groupStartPrev = prev;
    const group = [];
    if (list[i]?.parallel) {
      while (i < list.length && list[i]?.parallel) {
        group.push({ step: list[i], index: i });
        i++;
      }
      i--;
    } else {
      group.push({ step: list[i], index: i });
    }

    const outputLabels = group.map(({ step, index }) => `${step.label?.trim() || `Step ${index + 1}`} output`);
    for (const { step, index } of group) {
      const prompt = step.prompt || '';
      previews.push({
        index,
        input: sampleInput,
        prev: groupStartPrev,
        prompt,
        rendered: prompt
          .replaceAll('{input}', sampleInput)
          .replaceAll('{prev}', groupStartPrev),
        outputLabel: outputLabels.length === 1 ? outputLabels[0] : outputLabels.join(' + '),
        usesInput: prompt.includes('{input}'),
        usesPrev: prompt.includes('{prev}'),
        parallel: !!step.parallel,
      });
    }
    prev = outputLabels.join(' + ');
  }

  return previews;
}
