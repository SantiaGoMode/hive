// Colony execution policy and terminal outcome vocabulary.
//
// A recipe's purpose determines what it may mutate. GitHub review/comment access
// and repository publishing are deliberately separate capabilities: reviewing a
// PR must never imply permission to create another branch/commit/PR.

const EXECUTION_MODES = Object.freeze({
  READ_ONLY: 'read_only',
  ARTIFACT_ONLY: 'artifact_only',
  REPOSITORY_WRITE: 'repository_write',
});

const SUCCESS_OUTCOMES = new Set([
  'succeeded_no_changes',
  'succeeded_with_artifacts',
  'changes_proposed',
  'changes_published',
]);

const TERMINAL_OUTCOMES = new Set([
  ...SUCCESS_OUTCOMES,
  'blocked',
  'failed',
  'stopped',
]);

function normalizeExecutionPolicy(policy, fallbackMode = EXECUTION_MODES.ARTIFACT_ONLY) {
  const raw = policy && typeof policy === 'object' ? policy : {};
  const mode = Object.values(EXECUTION_MODES).includes(raw.mode) ? raw.mode : fallbackMode;
  return {
    mode,
    github_review: !!raw.github_review,
    github_publish: mode === EXECUTION_MODES.REPOSITORY_WRITE && !!raw.github_publish,
  };
}

function recipeExecutionPolicy(recipe) {
  if (!recipe) return normalizeExecutionPolicy(null);
  const fallback = recipe.id === 'custom_auto'
    ? EXECUTION_MODES.REPOSITORY_WRITE
    : EXECUTION_MODES.ARTIFACT_ONLY;
  return normalizeExecutionPolicy(recipe.execution_policy, fallback);
}

function isSuccessfulOutcome(outcome) {
  return SUCCESS_OUTCOMES.has(String(outcome || ''));
}

function statusForOutcome(outcome) {
  if (isSuccessfulOutcome(outcome)) return 'done';
  if (outcome === 'blocked') return 'blocked';
  if (outcome === 'stopped') return 'stopped';
  return 'failed';
}

function runCapabilitySnapshot(recipe, opts = {}) {
  const policy = recipeExecutionPolicy(recipe);
  const repoAttached = !!opts.repoPath;
  const githubReview = !!opts.githubReview && policy.github_review;
  const githubPublish = !!opts.githubPublish && policy.mode === EXECUTION_MODES.REPOSITORY_WRITE;
  return Object.freeze({
    repo_read: repoAttached,
    repo_write: repoAttached && policy.mode === EXECUTION_MODES.REPOSITORY_WRITE,
    artifact_write: true,
    network: true,
    github_read: true,
    github_write: githubPublish,
    github_review: githubReview,
    github_publish: githubPublish,
  });
}

function defaultContextBudget(recipe) {
  const roleCount = Array.isArray(recipe?.roles) ? recipe.roles.length : 0;
  return Object.freeze({
    team_memory_chars: 6000,
    worker_history_messages: 24,
    worker_history_chars: 24000,
    blackboard_entries: 60,
    outer_rounds: roleCount > 5 ? 8 : 6,
    worker_tool_rounds: 12,
  });
}

// Unattended inputs (webhooks and schedules) must not inherit persistent write
// authority merely because their target agent has powerful tool groups enabled.
function unattendedRunContext(source, extra = {}) {
  return {
    ...extra,
    source,
    capabilities: Object.freeze({
      repo_read: false,
      repo_write: false,
      artifact_write: true,
      network: true,
      github_read: true,
      github_write: false,
      github_review: false,
      github_publish: false,
    }),
  };
}

module.exports = {
  EXECUTION_MODES,
  SUCCESS_OUTCOMES,
  TERMINAL_OUTCOMES,
  normalizeExecutionPolicy,
  recipeExecutionPolicy,
  isSuccessfulOutcome,
  statusForOutcome,
  runCapabilitySnapshot,
  defaultContextBudget,
  unattendedRunContext,
};
