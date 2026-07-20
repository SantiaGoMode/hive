// Git write-back for colony runs: commit, push the colony branch, and open a
// Draft PR for successful repository-writing runs. Review/comment permission is
// handled separately below and never grants branch/commit/PR permission.
const protocol = require('../colonyProtocol');
const db = require('../../db');
const { detectGitHubRepo, createDraftPR, createPullRequestReview, postIssueComment, buildBoardComment } = require('../githubBoard');
const { logSwallowed } = require('../logSwallowed');
const { getColony } = require('./persistence');
const {
  gitExec,
  gitCommitAndPush,
  gitDefaultBranch,
  gitHasUncommittedChanges,
  gitBranchHasNewCommits,
  gitBranchHasNewCommitsSince,
} = require('./git');

function reviewTargetFromRow(row) {
  try {
    const card = row?.board_card ? JSON.parse(row.board_card) : null;
    return card?.review_target || null;
  } catch {
    return null;
  }
}

function publishCompareRef(row) {
  const target = reviewTargetFromRow(row);
  return target?.local_ref || target?.head_sha || null;
}

// Build the run-scoped performWriteback(status) closure.
// `ctx` = { colonyId, colonyBranch, addEntry, onEvent, state }
// `state` carries the mutable run values set as the run progresses:
  //   { row, githubPublish, goalSummary }
function createPerformWriteback(ctx) {
  const { colonyId, colonyBranch, addEntry, onEvent, state } = ctx;

  return async (status) => {
    const { row, githubPublish, goalSummary } = state;
    if (!githubPublish || status !== 'done' || !row?.repo_path) return;
    const compareRef = publishCompareRef(row);
    const hasPublishableWork = gitHasUncommittedChanges(row.repo_path)
      || (compareRef ? gitBranchHasNewCommitsSince(row.repo_path, compareRef) : gitBranchHasNewCommits(row.repo_path));
    if (!hasPublishableWork) {
      if (status === 'done') {
        addEntry({ kind: 'writeback', message: '✅ No repository changes were produced — nothing to push or open a PR for. This is a valid no-change outcome.' });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
      }
      return;
    }
    const repoInfo = detectGitHubRepo(row.repo_path);
    if (!repoInfo) return;
    addEntry({ kind: 'writeback', message: `🔀 Committing and pushing colony work to branch "${colonyBranch}"…` });
    onEvent({ type: 'writeback', phase: 'push_start', branch: colonyBranch });
    // Resolve the repo's real default branch — hardcoding "main" 422s the PR
    // (and mislabels the diff) on master-default repos.
    const base = gitDefaultBranch(row.repo_path);
    try {
      // First line only — board-item goals are multi-line and produce
      // unreadable commit subjects / PR titles otherwise.
      const goalLine = String(goalSummary || row.goal || 'Colony completed')
        .split('\n').map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l))[0] || 'Colony completed';
      const commitMsg = `feat(colony): ${goalLine.slice(0, 72)}\n\nColony ID: ${colonyId}`;
      const pushRes = await gitCommitAndPush(row.repo_path, colonyBranch, commitMsg, compareRef ? { compareRef } : {});
      if (!pushRes.pushed) {
        addEntry({ kind: 'writeback', message: `⚠️ Nothing to publish: after excluding secret files, the branch has no commits beyond ${compareRef || 'the default branch'}. No push or PR.` });
        onEvent({ type: 'writeback', phase: 'no_changes', branch: colonyBranch });
        return;
      }

      let diffStat = '';
      try { diffStat = gitExec(['diff', '--stat', `${compareRef || `origin/${base}`}...HEAD`], row.repo_path).slice(0, 2000); } catch {
        try { diffStat = gitExec(['diff', '--stat', `${base}...HEAD`], row.repo_path).slice(0, 2000); } catch (e) { logSwallowed('colonyRunner:diffStat', e, { colonyId }); }
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
        `> Verify the changes against the work item's acceptance criteria, then merge to \`${base}\` when satisfied.`,
      ].filter(l => l !== null).join('\n');

      const titleLine = String(row.goal || 'Automated delivery')
        .split('\n').map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l))
        .find(l => /^Title:\s*/i.test(l))?.replace(/^Title:\s*/i, '')
        || String(row.goal || 'Automated delivery').split('\n').map(l => l.trim()).filter(l => l && !/^\[.*\]$/.test(l))[0]
        || 'Automated delivery';
      const pr = await createDraftPR({
        owner: repoInfo.owner,
        repo: repoInfo.repo,
        title: `[Colony] ${titleLine.slice(0, 72)}`,
        body: prBody,
        head: colonyBranch,
        base,
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
        `3. Open a Pull Request from \`${colonyBranch}\` → \`${base}\` on GitHub.`,
        '',
        'Once you have resolved the issue, click **"Retry Push"** in the colony panel.',
      ].join('\n');
      addEntry({ kind: 'writeback', message: `⚠️ ${msg}` });
      protocol.writeBlackboard(colonyId, 'system', 'blocker', msg, { action_required: 'retry_push', branch: colonyBranch, repo_path: row.repo_path });
      const blocker = { message: msg, action: 'retry_push', branch: colonyBranch };
      // Persist the structured blocker too, so it reappears in the panel on refresh/replay.
      addEntry({ kind: 'blocker', blocker });
      onEvent({ type: 'blocker', blocker });
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
      writeback_enabled: !!state.githubPublish,
      pr_url: state.prUrl || null,
      branch: null,
      new_commits: false,
      uncommitted_files: 0,
    };
    const parts = [];
    if (!row?.repo_path) {
      parts.push('no repository is attached to this run — any claimed code changes, commits, or PRs do not exist');
    } else {
      const compareRef = publishCompareRef(row);
      try { facts.branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], row.repo_path).trim(); } catch { /* not a git repo */ }
      try { facts.uncommitted_files = gitExec(['status', '--porcelain'], row.repo_path).split('\n').filter(Boolean).length; } catch { /* ignore */ }
      facts.compare_ref = compareRef || gitDefaultBranch(row.repo_path);
      facts.new_commits = compareRef
        ? gitBranchHasNewCommitsSince(row.repo_path, compareRef)
        : gitBranchHasNewCommits(row.repo_path, gitDefaultBranch(row.repo_path));
      parts.push(facts.writeback_enabled
        ? `write-back enabled (branch "${colonyBranch}")`
        : 'write-back DISABLED — Hive will not commit, push, or open a PR');
      parts.push(facts.pr_url ? `Draft PR: ${facts.pr_url}` : 'pull request: NONE');
      parts.push(facts.new_commits ? 'new commits: yes' : 'new commits: none');
      parts.push(`uncommitted changes in working tree: ${facts.uncommitted_files} file(s)`);
      if (facts.branch) parts.push(`repo is on branch "${facts.branch}"`);
    }
    const message = `📋 Verified outcome (measured from git, not model claims): ${parts.join(' · ')}. If the summary above contradicts this, trust this.`;
    addEntry({ kind: 'outcome', message, facts });
    return { message, facts };
  } catch (e) {
    logSwallowed('colonyRunner:verifiedOutcome', e, { colonyId });
    return null;
  }
}

function reviewEventForReport(text) {
  const normalized = String(text || '').toLowerCase();
  if (/request[- ]changes|changes requested|verdict:\s*request/.test(normalized)) return 'REQUEST_CHANGES';
  if (/approve[- ]with[- ]nits|approve with nits/.test(normalized)) return 'COMMENT';
  if (/verdict:\s*approve\b|\bapproved?\b/.test(normalized)) return 'APPROVE';
  return 'COMMENT';
}

// Code-review recipes post their verdict on the ORIGINAL pull request. They do
// not branch from that PR or open a child PR. If GitHub refuses a formal review
// (for example, a token cannot approve its own PR), fall back to a PR comment so
// the report is still delivered without mutating repository contents.
async function postPullRequestReview({ colonyId, row, state, addEntry, onEvent }) {
  if (!state.githubReview || row?.recipe_id !== 'code_review') return null;
  const target = reviewTargetFromRow(row);
  const repoInfo = row.repo_path ? detectGitHubRepo(row.repo_path) : null;
  if (!target?.number || !repoInfo) return null;
  const fresh = getColony(colonyId);
  const report = String(fresh?.deliverable?.report || fresh?.summary || '').trim();
  if (!report) return null;
  const body = `### 🐝 Hive Colony code review\n\n${report}`.slice(0, 60_000);
  const event = reviewEventForReport(report);
  try {
    const review = await createPullRequestReview({ owner: repoInfo.owner, repo: repoInfo.repo, number: target.number, body, event });
    const url = review?.html_url || target.url || null;
    addEntry({ kind: 'writeback', message: `💬 Posted ${event.toLowerCase().replace('_', ' ')} review to PR #${target.number}`, review_url: url });
    onEvent({ type: 'writeback', phase: 'pr_review', url, review_event: event });
    return review;
  } catch (reviewError) {
    const comment = await postIssueComment({ owner: repoInfo.owner, repo: repoInfo.repo, number: target.number, body });
    addEntry({ kind: 'writeback', message: `💬 Posted review report as a comment on PR #${target.number} (formal review unavailable: ${reviewError.message})`, comment_url: comment?.html_url || null });
    onEvent({ type: 'writeback', phase: 'pr_review_comment', url: comment?.html_url || null });
    return comment;
  }
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

module.exports = { createPerformWriteback, postBoardComment, postPullRequestReview, reviewEventForReport, emitVerifiedOutcome };
