export function groupStepEntries(steps) {
  const groups = new Map();
  for (const step of steps) {
    const group = step.group ?? step.step;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(step);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

export function getPrevOutputForRetry(stepEntry, allSteps, input) {
  const retryGroup = stepEntry.group ?? stepEntry.step;
  if (retryGroup === 0) return input;
  const prevGroupSteps = allSteps.filter(step => (step.group ?? step.step) === retryGroup - 1 && step.status === 'done');
  if (!prevGroupSteps.length) return input;
  return prevGroupSteps.length === 1
    ? prevGroupSteps[0].output
    : prevGroupSteps.map(step => step.output).join('\n\n---\n\n');
}
