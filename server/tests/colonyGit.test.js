const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitCreateReviewWorktree, gitRemoveReviewWorktree } = require('../lib/colony/git');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('code-review git isolation', () => {
  it('uses a temporary worktree without switching or cleaning the source repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-review-source-'));
    let reviewWorktree = null;
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'Hive Test');
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'committed\n', 'utf8');
      git(repo, 'add', 'tracked.txt');
      git(repo, 'commit', '-m', 'initial');

      fs.writeFileSync(path.join(repo, 'local-only.txt'), 'preserve me\n', 'utf8');
      const branchBefore = git(repo, 'branch', '--show-current');
      const statusBefore = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');

      reviewWorktree = gitCreateReviewWorktree(repo, 'HEAD');
      assert.equal(git(repo, 'branch', '--show-current'), branchBefore);
      assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
      assert.equal(fs.readFileSync(path.join(reviewWorktree.path, 'tracked.txt'), 'utf8'), 'committed\n');
      assert.equal(fs.existsSync(path.join(reviewWorktree.path, 'local-only.txt')), false);

      fs.writeFileSync(path.join(reviewWorktree.path, 'tracked.txt'), 'review mutation\n', 'utf8');
      assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'committed\n');

      gitRemoveReviewWorktree(repo, reviewWorktree);
      reviewWorktree = null;
      assert.equal(git(repo, 'branch', '--show-current'), branchBefore);
      assert.equal(git(repo, 'status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
      assert.equal(fs.readFileSync(path.join(repo, 'local-only.txt'), 'utf8'), 'preserve me\n');
    } finally {
      if (reviewWorktree) gitRemoveReviewWorktree(repo, reviewWorktree);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
