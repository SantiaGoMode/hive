const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { getColonyRecipe, listColonyRecipes, buildRecipeWorkerConfigs } = require('../lib/colonyRecipes');
const { workerRepoAccess } = require('../lib/colony/seeding');
const { EXECUTION_MODES, recipeExecutionPolicy, statusForOutcome, unattendedRunContext } = require('../lib/colonyPolicy');
const { reviewEventForReport } = require('../lib/colony/writeback');

describe('colony execution policy', () => {
  it('makes code review read-only and keeps delivery recipes writable', () => {
    assert.equal(recipeExecutionPolicy(getColonyRecipe('code_review')).mode, EXECUTION_MODES.READ_ONLY);
    assert.equal(recipeExecutionPolicy(getColonyRecipe('code_review')).github_review, true);
    assert.equal(recipeExecutionPolicy(getColonyRecipe('code_review')).github_publish, false);
    assert.equal(recipeExecutionPolicy(getColonyRecipe('development_team')).mode, EXECUTION_MODES.REPOSITORY_WRITE);
    assert.equal(recipeExecutionPolicy(getColonyRecipe('business_strategy')).mode, EXECUTION_MODES.ARTIFACT_ONLY);
  });

  it('exposes the effective policy in the recipe catalog', () => {
    const review = listColonyRecipes().find(r => r.id === 'code_review');
    assert.deepEqual(review.execution_policy, { mode: 'read_only', github_review: true, github_publish: false });
  });

  it('downgrades stale/custom writable role metadata under a read-only policy', () => {
    const [reviewer] = buildRecipeWorkerConfigs(getColonyRecipe('code_review'), 'Review PR #1', 'fake');
    reviewer._role_meta.repo_access = 'write';
    assert.equal(workerRepoAccess(reviewer, recipeExecutionPolicy(getColonyRecipe('code_review'))), 'read');
  });

  it('maps structured outcomes to honest statuses', () => {
    assert.equal(statusForOutcome('succeeded_no_changes'), 'done');
    assert.equal(statusForOutcome('blocked'), 'blocked');
    assert.equal(statusForOutcome('failed'), 'failed');
  });

  it('removes write authority from unattended automation sources', () => {
    for (const source of ['webhook', 'schedule']) {
      const context = unattendedRunContext(source);
      assert.equal(context.source, source);
      assert.equal(context.capabilities.repo_write, false);
      assert.equal(context.capabilities.github_write, false);
      assert.equal(context.capabilities.artifact_write, true);
    }
  });
});

describe('GitHub review verdict mapping', () => {
  it('distinguishes approval, comment-only nits, and requested changes', () => {
    assert.equal(reviewEventForReport('Verdict: approve'), 'APPROVE');
    assert.equal(reviewEventForReport('Verdict: approve-with-nits'), 'COMMENT');
    assert.equal(reviewEventForReport('Verdict: request-changes'), 'REQUEST_CHANGES');
  });
});
