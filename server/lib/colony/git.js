// Git write-back helpers for colony runs.
// Thin wrappers around the git CLI. All failures throw — callers must catch and
// emit a HITL blocker rather than crashing the colony.
const { execFileSync } = require('child_process');
const { logSwallowed } = require('../logSwallowed');

function gitExec(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitDefaultBranch(repoPath) {
  try {
    return gitExec(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoPath).replace(/^origin\//, '');
  } catch {
    for (const b of ['main', 'master']) {
      try { gitExec(['rev-parse', '--verify', b], repoPath); return b; } catch {} /* probe: failure = branch doesn't exist */
    }
    return 'main';
  }
}

function gitCheckoutBranch(repoPath, branchName) {
  // ALWAYS branch from a fresh default branch. Previously the new colony
  // branch was created from whatever a prior run left checked out, so each
  // run stacked on top of the previous run's unreviewed (possibly broken)
  // commits and could end up with "publishable" work it never produced.
  // Leftover uncommitted changes are stashed (not destroyed) first.
  try {
    if (gitExec(['status', '--porcelain'], repoPath).length > 0) {
      gitExec(['stash', 'push', '--include-untracked', '-m', `hive: leftovers before ${branchName}`], repoPath);
    }
  } catch (e) { logSwallowed('colonyRunner:gitStash', e); }
  const base = gitDefaultBranch(repoPath);
  try { gitExec(['checkout', base], repoPath); } catch (e) { logSwallowed('colonyRunner:gitBase', e); }
  try { gitExec(['pull', '--ff-only'], repoPath); } catch (e) { logSwallowed('colonyRunner:gitBase', e); }
  try {
    gitExec(['checkout', '-b', branchName], repoPath);
  } catch {
    // Branch may already exist (re-run scenario) — just switch to it.
    gitExec(['checkout', branchName], repoPath);
  }
}

async function gitCommitAndPush(repoPath, branchName, message) {
  gitExec(['add', '-A'], repoPath);
  // Secret hygiene: agents sometimes create .env files with credentials and
  // they must never ride along into a pushed PR. Unstage any env files.
  try {
    const staged = gitExec(['diff', '--cached', '--name-only'], repoPath).split('\n').filter(Boolean);
    const envFiles = staged.filter(f => /(^|\/)\.env(\..+)?$/.test(f) && !/\.env\.example$/.test(f));
    if (envFiles.length) gitExec(['reset', '--', ...envFiles], repoPath);
  } catch (e) { logSwallowed('colonyRunner:gitUnstageEnv', e); }
  // If nothing changed, skip the commit gracefully. git prints "nothing to
  // commit" to STDOUT, so check stdout too — checking only stderr/message
  // turned a clean tree into a hard "Failed to push" blocker.
  try {
    gitExec(['commit', '-m', message], repoPath);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    if (!/nothing to commit|working tree clean|nothing added to commit/i.test(out)) throw e;
  }
  // Only push when the branch actually has commits the default branch lacks —
  // pushing an empty branch just produces a "no commits between..." PR error.
  if (!gitBranchHasNewCommits(repoPath, gitDefaultBranch(repoPath))) {
    return { pushed: false };
  }
  gitExec(['push', '-u', 'origin', branchName], repoPath);
  return { pushed: true };
}

// True when the working tree has uncommitted changes (staged or not).
function gitHasUncommittedChanges(repoPath) {
  try { return gitExec(['status', '--porcelain'], repoPath).length > 0; } catch { return false; }
}

// True when the branch has commits that main does not (i.e. there is something
// worth opening a PR for).
function gitBranchHasNewCommits(repoPath, base = 'main') {
  for (const ref of [`origin/${base}`, base]) {
    try { return Number(gitExec(['rev-list', '--count', `${ref}..HEAD`], repoPath)) > 0; } catch {} /* probe: failure = ref missing, try next */
  }
  return false;
}

module.exports = {
  gitExec,
  gitDefaultBranch,
  gitCheckoutBranch,
  gitCommitAndPush,
  gitHasUncommittedChanges,
  gitBranchHasNewCommits,
};
