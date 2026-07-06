// First-party GitHub tools for colony roles (BA, PM, DevOps, QA).
//
// Why first-party and not only the GitHub MCP: the MCP server is optional, may
// be disconnected, and does not expose code-scanning / Dependabot alerts. These
// tools are always present in a colony run and resolve the target repo + work
// item from the colony's own context (board_card + repo_path), so a worker can
// "update the ticket" without inventing owner/repo/number.
//
// Real-world gap this closes (run mr55aw7ukb9xyr): the BA and PM had GitHub
// tooling attached but never touched the issue — requirements and progress
// stayed on the ephemeral blackboard. These give them a concrete, low-friction
// verb for the record-keeping their prompts now mandate.
const db = require('../../db');
const github = require('../githubBoard');
const { logSwallowed } = require('../logSwallowed');

// Resolve { owner, repo, number, url } from the colony's linked board card,
// falling back to the repo's git remote for owner/repo. `number` is only known
// when a specific issue/PR is linked to the run.
function resolveRepoContext(colonyContext) {
  if (!colonyContext?.colonyId) return { error: 'GitHub tools are only available inside a Colony run.' };
  const row = db.prepare('SELECT repo_path, board_card FROM colonies WHERE id=?').get(colonyContext.colonyId);
  if (!row) return { error: `Colony "${colonyContext.colonyId}" not found.` };

  let card = null;
  try { card = row.board_card ? JSON.parse(row.board_card) : null; } catch (e) { logSwallowed('githubTools:parseBoardCard', e, { colonyId: colonyContext.colonyId }); }

  let owner = null, repo = null;
  if (card?.repo && card.repo.includes('/')) {
    [owner, repo] = card.repo.split('/');
  } else if (row.repo_path) {
    const detected = github.detectGitHubRepo(row.repo_path);
    if (detected) { owner = detected.owner; repo = detected.repo; }
  }
  if (!owner || !repo) {
    return { error: 'No GitHub repository is linked to this run (no board card and no GitHub git remote). Cannot write to GitHub.' };
  }
  return { owner, repo, number: card?.number || null, url: card?.url || null };
}

function noTokenResult(action) {
  return {
    error: `Cannot ${action}: no GitHub token is configured. Ask the user to set GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN or run "gh auth login", then re-run. Report this as an access blocker in your handoff — do not fabricate a GitHub update.`,
    permission_required: true,
  };
}

module.exports = {
  github_comment: {
    group: 'github',
    definition: {
      type: 'function',
      function: {
        name: 'github_comment',
        description: 'Post a progress/status comment on the run\'s linked GitHub issue or PR (e.g. finalized requirements, a milestone, a QA PASS/FAIL summary). Targets the linked work item by default; pass issue_number to comment elsewhere. This is a real, visible GitHub write — use it the way a teammate posts an update on a ticket.',
        parameters: {
          type: 'object',
          properties: {
            body: { type: 'string', description: 'Markdown comment body.' },
            issue_number: { type: 'number', description: 'Issue/PR number to comment on. Defaults to the run\'s linked work item.' },
          },
          required: ['body'],
        },
      },
    },
    async handler({ body, issue_number }, { colonyContext }) {
      const ctx = resolveRepoContext(colonyContext);
      if (ctx.error) return { error: ctx.error };
      const number = issue_number || ctx.number;
      if (!number) return { error: 'No issue/PR number: this run has no linked work item. Pass issue_number explicitly.' };
      if (!github.githubToken()) return noTokenResult('post a GitHub comment');
      try {
        const res = await github.postIssueComment({ owner: ctx.owner, repo: ctx.repo, number, body });
        return { success: true, url: res?.html_url || ctx.url, issue_number: number };
      } catch (e) { return { error: `GitHub comment failed: ${e.message}` }; }
    },
  },

  github_update_issue: {
    group: 'github',
    definition: {
      type: 'function',
      function: {
        name: 'github_update_issue',
        description: 'Update the linked GitHub issue the way a PM maintains a ticket: rewrite the description/body, set labels, or change state (open/closed). Use this to keep the work item\'s description current with finalized requirements and status. Prefer github_comment for progress notes; use this for the durable ticket fields.',
        parameters: {
          type: 'object',
          properties: {
            issue_number: { type: 'number', description: 'Issue number to update. Defaults to the run\'s linked work item.' },
            body: { type: 'string', description: 'New issue description (Markdown). Omit to leave unchanged.' },
            title: { type: 'string', description: 'New issue title. Omit to leave unchanged.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Full label set to apply (replaces existing labels). Omit to leave unchanged.' },
            state: { type: 'string', enum: ['open', 'closed'], description: 'Issue state. Omit to leave unchanged.' },
          },
          required: [],
        },
      },
    },
    async handler({ issue_number, body, title, labels, state }, { colonyContext }) {
      const ctx = resolveRepoContext(colonyContext);
      if (ctx.error) return { error: ctx.error };
      const number = issue_number || ctx.number;
      if (!number) return { error: 'No issue number: this run has no linked work item. Pass issue_number explicitly.' };
      if (!github.githubToken()) return noTokenResult('update a GitHub issue');
      try {
        await github.updateGitHubIssue({ owner: ctx.owner, repo: ctx.repo, number, body, title, labels, state });
        return { success: true, issue_number: number, updated: { body: body != null, title: title != null, labels: Array.isArray(labels), state: state || null } };
      } catch (e) { return { error: `GitHub issue update failed: ${e.message}` }; }
    },
  },

  github_create_issue: {
    group: 'github',
    definition: {
      type: 'function',
      function: {
        name: 'github_create_issue',
        description: 'File a new GitHub issue in the run\'s repository — e.g. a follow-up task, a bug found in QA, or a security finding that needs its own ticket. Returns the new issue URL.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Issue title.' },
            body: { type: 'string', description: 'Issue body (Markdown).' },
          },
          required: ['title'],
        },
      },
    },
    async handler({ title, body = '' }, { colonyContext }) {
      const ctx = resolveRepoContext(colonyContext);
      if (ctx.error) return { error: ctx.error };
      if (!github.githubToken()) return noTokenResult('create a GitHub issue');
      try {
        const res = await github.createGitHubIssue({ owner: ctx.owner, repo: ctx.repo, title, body });
        return { success: true, url: res?.html_url, number: res?.number };
      } catch (e) { return { error: `GitHub issue creation failed: ${e.message}` }; }
    },
  },

  github_security_alerts: {
    group: 'github',
    definition: {
      type: 'function',
      function: {
        name: 'github_security_alerts',
        description: 'Read open GitHub security alerts for the repository: Dependabot (vulnerable dependencies) and code-scanning (CodeQL/SAST). Use this as the DevSecOps gate — surface critical/high findings so they can be remediated before the final PR. Read-only.',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['all', 'dependabot', 'code_scanning'], description: 'Which alert source to read (default: all).' },
          },
          required: [],
        },
      },
    },
    async handler({ kind = 'all' }, { colonyContext }) {
      const ctx = resolveRepoContext(colonyContext);
      if (ctx.error) return { error: ctx.error };
      if (!github.githubToken()) return noTokenResult('read GitHub security alerts');

      const out = { repo: `${ctx.owner}/${ctx.repo}`, dependabot: [], code_scanning: [], errors: [] };
      const rank = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1, warning: 1, note: 0, unknown: 0 };
      if (kind === 'all' || kind === 'dependabot') {
        try { out.dependabot = await github.fetchDependabotAlerts({ owner: ctx.owner, repo: ctx.repo }); }
        catch (e) { out.errors.push(`Dependabot alerts unavailable: ${e.message} (feature may be disabled, or the token lacks security_events scope).`); }
      }
      if (kind === 'all' || kind === 'code_scanning') {
        try { out.code_scanning = await github.fetchCodeScanningAlerts({ owner: ctx.owner, repo: ctx.repo }); }
        catch (e) { out.errors.push(`Code-scanning alerts unavailable: ${e.message} (feature may be disabled, or the token lacks security_events scope).`); }
      }
      const all = [...out.dependabot, ...out.code_scanning];
      const criticalHigh = all.filter(a => (rank[String(a.severity).toLowerCase()] ?? 0) >= 3);
      out.total_open = all.length;
      out.critical_high_count = criticalHigh.length;
      out.remediation_required = criticalHigh.length > 0;
      out.guidance = criticalHigh.length
        ? `${criticalHigh.length} critical/high finding(s) MUST be remediated before the final PR. List them in your handoff as REMEDIATION REQUIRED and call request_assistance so the Software Developer fixes them; do not sign off with these open.`
        : (all.length ? 'Only lower-severity findings are open; note them but they need not block the PR.' : (out.errors.length ? 'Could not read alerts — report the access gap; do not claim the repo is clean.' : 'No open security alerts.'));
      return out;
    },
  },
};
