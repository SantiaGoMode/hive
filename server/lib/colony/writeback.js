// Git write-back for colony runs: commit, push the colony branch, and open a
// Draft PR for the user to review. This is ALWAYS the last act of a run when the
// agents produced real work — it runs for done AND stopped runs so partial work
// is never stranded uncommitted on a local branch.
const protocol = require('../colonyProtocol');
const db = require('../../db');
const { detectGitHubRepo, createDraftPR, postIssueComment, buildBoardComment } = require('../githubBoard');
const { logSwallowed } = require('../logSwallowed');
const { getColony } = require('./persistence');
const {
  gitExec,
  gitCommitAndPush,
  gitDefaultBranch,
  gitHasUncommittedChanges,
  gitBranchHasNewCommits,
} = require('./git');

// Build the run-scoped performWriteback(status) closure.
// `ctx` = { colonyId, colonyBranch, addEntry, onEvent, state }
// `state` carries the mutable run values set as the run progresses:
//   { row, githubWriteback, goalSummary }
function createPerformWriteback(ctx) {
  const { colonyId, colonyBranch, addEntry, onEvent, state } = ctx;

  return async (status) => {
    const { row, githubWriteback, goalSummary } = state;
    if (!githubWriteback || !row?.repo_path) return;
    const hasPublishableWork = gitHasUncommittedChanges(row.repo_path)
      || gitBranchHasNewCommits(row.repo_path);
    if (!hasPublishableWork) {
      if (status === 'done') {
        addEntry({ kind: 'writeback', message: '⚠️ No file changes were produced on the colony branch — nothing to push or open a PR for. The agents completed the flow without committing real work.' });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
      }
      return;
    }
    const repoInfo = detectGitHubRepo(row.repo_path);
    if (!repoInfo) return;
    addEntry({ kind: 'writeback', message: `🔀 Committing and pushing colony work to branch "${colonyBranch}"…` });
    onEvent({ type: 'writeback', phase: 'push_start', branch: colonyBranch });
    try {
      const commitMsg = `feat(colony): ${(goalSummary || row.goal || 'Colony completed').slice(0, 72)}\n\nColony ID: ${colonyId}`;
      const pushRes = await gitCommitAndPush(row.repo_path, colonyBranch, commitMsg);
      if (!pushRes.pushed) {
        addEntry({ kind: 'writeback', message: '⚠️ Nothing to publish: after excluding secret files, the branch has no commits beyond the default branch. No push or PR.' });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
        return;
      }

      let diffStat = '';
      try { diffStat = gitExec(['diff', '--stat', 'origin/main...HEAD'], row.repo_path).slice(0, 2000); } catch {
        try { diffStat = gitExec(['diff', '--stat', 'main...HEAD'], row.repo_path).slice(0, 2000); } catch (e) { logSwallowed('colonyRunner:diffStat', e, { colonyId }); }
      }

      const prBody = [
        `## 🐝 Hive Colony — Automated Delivery`,
        '',
        `**Goal:** ${row.goal}`,
        '',
        goalSummary ? `**Summary:** ${goalSummary}` : '',
        status !== 'done' ? `**Note:** the run ended early (status: ${status}) — this PR contains the partial work committed so far.` : '',
        diffStat ? `\n**Changes:**\n\`\`\`\n${diffStat}\n\`\`\`` : '',
        '',
        `> This pull request was opened automatically by Hive Colony \`${colonyId}\`.`,
        `> Verify the changes against the work item's acceptance criteria, then merge to \`main\` when satisfied.`,
      ].filter(l => l !== null).join('\n');

      const pr = await createDraftPR({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title: `[Colony] ${(row.goal || 'Automated delivery').slice(0, 72)}`,
        body: prBody,
        head: colonyBranch,
        base: 'main',
      });

      state.prUrl = pr.html_url; // read by the verified-outcome report
      addEntry({ kind: 'writeback', message: `✅ Draft PR opened: ${pr.html_url}`, pr_url: pr.html_url });
      db.prepare("UPDATE colonies SET summary=COALESCE(summary,'') || ? WHERE id=?")
        .run(`\n\n**Draft PR:** ${pr.html_url}`, colonyId);
      onEvent({ type: 'writeback', phase: 'pr_opened', pr_url: pr.html_url, branch: colonyBranch });
    } catch (gitErr) {
      const msg = [
        `Failed to push branch "${colonyBranch}" or open a Draft PR: ${gitErr.message}`,
        '',
        '**What to do:**',
        `1. Open a terminal and navigate to: \`${row.repo_path}\``,
        `2. Run: \`git push -u origin ${colonyBranch}\``,
        `3. Open a Pull Request from \`${colonyBranch}\` → \`main\` on GitHub.`,
        '',
        'Once you have resolved the issue, click **"Retry Push"** in the colony panel.',
      ].join('\n');
      addEntry({ kind: 'writeback', message: `⚠️ ${msg}` });
      protocol.writeBlackboard(colonyId, 'system', 'blocker', msg, { action_required: 'retry_push', branch: colonyBranch, repo_path: row.repo_path });
      onEvent({ type: 'blocker', blocker: { message: msg, action: 'retry_push', branch: colonyBranch } });
    }
  };
}

// System-verified run outcome, measured from git — never from model claims.
// Models routinely fabricate "Draft PR opened" / "deployed" in their final
// summaries; this entry states what actually exists so the user (and the UI)
// can spot the contradiction immediately.
// `ctx` = { colonyId, row, state, colonyBranch, addEntry }
function emitVerifiedOutcome({ colonyId, row, state, colonyBranch, addEntry }) {
  try {
    const facts = {
      writeback_enabled: !!state.githubWriteback,
      pr_url: state.prUrl || null,
      branch: null,
      new_commits: false,
      uncommitted_files: 0,
    };
    const parts = [];
    if (!row?.repo_path) {
      parts.push('no repository is attached to this run — any claimed code changes, commits, or PRs do not exist');
    } else {
      try { facts.branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], row.repo_path).trim(); } catch { /* not a git repo */ }
      try { facts.uncommitted_files = gitExec(['status', '--porcelain'], row.repo_path).split('\n').filter(Boolean).length; } catch { /* ignore */ }
      facts.new_commits = gitBranchHasNewCommits(row.repo_path, gitDefaultBranch(row.repo_path));
      parts.push(facts.writeback_enabled
        ? `write-back enabled (branch "${colonyBranch}")`
        : 'write-back DISABLED — Hive created no branch, commit, or PR');
      parts.push(facts.pr_url ? `Draft PR: ${facts.pr_url}` : 'pull request: NONE');
      parts.push(facts.new_commits ? 'new commits: yes' : 'new commits: none');
      parts.push(`uncommitted changes in working tree: ${facts.uncommitted_files} file(s)`);
      if (facts.branch) parts.push(`repo is on branch "${facts.branch}"`);
    }
    addEntry({
      kind: 'outcome',
      message: `📋 Verified outcome (measured from git, not model claims): ${parts.join(' · ')}. If the summary above contradicts this, trust this.`,
      facts,
    });
  } catch (e) { logSwallowed('colonyRunner:verifiedOutcome', e, { colonyId }); }
}

// Auto-post the deliverable summary to the linked board work-item so the user
// never has to click "Post update" manually. Non-fatal on failure — the manual
// button remains as a retry. `ctx` = { colonyId, row, addEntry, onEvent }.
async function postBoardComment(ctx) {
  const { colonyId, row, addEntry, onEvent } = ctx;
  try {
    const card = JSON.parse(row.board_card || 'null');
    const repoInfo = row.repo_path ? detectGitHubRepo(row.repo_path) : null;
    if (card?.number && repoInfo) {
      const fresh = getColony(colonyId);
      const comment = await postIssueComment({
        owner: repoInfo.owner, repo: repoInfo.repo, number: card.number,
        body: buildBoardComment(fresh),
      });
      addEntry({ kind: 'writeback', message: `💬 Posted update to ${repoInfo.owner}/${repoInfo.repo} #${card.number}`, comment_url: comment?.html_url || null });
      onEvent({ type: 'writeback', phase: 'board_comment', url: comment?.html_url || null });
    }
  } catch (e) {
    addEntry({ kind: 'writeback', message: `⚠️ Could not auto-post the board update: ${e.message}. Use "Post update" in the summary card to retry.` });
  }
}

module.exports = { createPerformWriteback, postBoardComment, emitVerifiedOutcome };
