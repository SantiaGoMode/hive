// Git write-back helpers for colony runs.
// Thin wrappers around the git CLI. All failures throw — callers must catch and
// emit a HITL blocker rather than crashing the colony.
const { execFileSync } = require('child_process');
const { logSwallowed } = require('../logSwallowed');

function gitExec(args, cwd) {
  // 64MB buffer: a run that (wrongly) staged 20k node_modules files produced
  // enough push output to die with ENOBUFS at the 1MB default.
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
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

// Bulk build artifacts that must never be committed by a colony run. Task
// repos often lack a .gitignore — `git add -A` once staged 20k node_modules
// files (4.3M lines) and the push died with ENOBUFS.
const JUNK_PATH_RE = /(^|\/)(node_modules|\.next|dist|build|out|coverage|__pycache__|\.venv|venv|\.cache|\.turbo)(\/|$)|\.log$/;

async function gitCommitAndPush(repoPath, branchName, message) {
  gitExec(['add', '-A'], repoPath);
  // Hygiene: unstage secrets (.env files) and bulk artifacts before committing.
  try {
    const staged = gitExec(['diff', '--cached', '--name-only'], repoPath).split('\n').filter(Boolean);
    const unstage = staged.filter(f =>
      (/(^|\/)\.env(\..+)?$/.test(f) && !/\.env\.example$/.test(f)) || JUNK_PATH_RE.test(f));
    // Batch — there can be tens of thousands and argv is capped by ARG_MAX.
    for (let i = 0; i < unstage.length; i += 500) {
      gitExec(['reset', '--', ...unstage.slice(i, i + 500)], repoPath);
    }
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
