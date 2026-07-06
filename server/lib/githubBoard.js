const { execFileSync } = require('child_process');
const { githubToken } = require('./config'); // canonical GitHub-token resolver (#36)

const STATUS_MAP = [
  [/^(done|closed|complete|completed|shipped)$/i, 'done'],
  [/^(review|in review|code review|qa|testing|verify|verification)$/i, 'review'],
  [/^(in progress|in-progress|active|doing|wip)$/i, 'in_progress'],
  [/^(ready|ready for dev|ready to start|todo|to do)$/i, 'ready'],
  [/^(backlog|triage|new|open)$/i, 'backlog'],
];

function parseGitHubRemote(remoteUrl) {
  const raw = String(remoteUrl || '').trim();
  if (!raw) return null;

  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2].replace(/\.git$/i, '') };

  const https = raw.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (https) return { owner: https[1], repo: https[2].replace(/\.git$/i, '') };

  return null;
}

function detectGitHubRepo(cwd = process.cwd()) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = parseGitHubRemote(remote);
    return parsed ? { ...parsed, remote } : null;
  } catch {
    return null;
  }
}

function normalizeStatus(status) {
  const value = String(status || '').trim();
  for (const [pattern, lane] of STATUS_MAP) {
    if (pattern.test(value)) return lane;
  }
  return 'backlog';
}

function statusFromLabels(labels = []) {
  const names = labels.map(label => typeof label === 'string' ? label : label?.name).filter(Boolean);
  for (const name of names) {
    const lane = normalizeStatus(name);
    if (lane !== 'backlog' || /^backlog$/i.test(name)) return lane;
  }
  return 'backlog';
}

async function githubFetch(url, { token, method = 'GET', body = null } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Hive-Colony-Board',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.message || `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data;
}

function projectItemStatus(fieldValues = []) {
  for (const value of fieldValues) {
    if (value?.field?.name && /status/i.test(value.field.name) && value.name) {
      return value.name;
    }
  }
  return '';
}

function cardFromContent(content, { repo, projectTitle = '', projectUrl = '', status = '' } = {}) {
  if (!content?.number || !content?.title) return null;
  const type = content.__typename === 'PullRequest' ? 'pull_request' : 'issue';
  return {
    id: `${type}-${content.number}`,
    provider: 'github',
    repo,
    type,
    number: content.number,
    title: content.title,
    description: content.bodyText || '',
    status: normalizeStatus(status || content.state),
    status_label: status || content.state || '',
    assignees: (content.assignees?.nodes || []).map(a => a.login),
    labels: (content.labels?.nodes || []).map(l => l.name),
    url: content.url,
    updated_at: content.updatedAt,
    project_title: projectTitle,
    project_url: projectUrl,
    source: projectTitle ? `GitHub Project: ${projectTitle}` : 'GitHub Issues',
  };
}

async function fetchProjectBoard({ owner, repo, token }) {
  if (!token) return null;
  const query = `
    query RepoProjects($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        projectsV2(first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            title
            url
            items(first: 100) {
              nodes {
                content {
                  __typename
                  ... on Issue {
                    number
                    title
                    bodyText
                    state
                    url
                    updatedAt
                    assignees(first: 10) { nodes { login } }
                    labels(first: 10) { nodes { name } }
                  }
                  ... on PullRequest {
                    number
                    title
                    bodyText
                    state
                    url
                    updatedAt
                    assignees(first: 10) { nodes { login } }
                    labels(first: 10) { nodes { name } }
                  }
                }
                fieldValues(first: 20) {
                  nodes {
                    __typename
                    ... on ProjectV2ItemFieldSingleSelectValue {
                      name
                      field { ... on ProjectV2SingleSelectField { name } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await githubFetch('https://api.github.com/graphql', {
    token,
    method: 'POST',
    body: { query, variables: { owner, repo } },
  });
  if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));

  const projects = result.data?.repository?.projectsV2?.nodes || [];
  for (const project of projects) {
    const cards = (project.items?.nodes || [])
      .map(item => cardFromContent(item.content, {
        repo: `${owner}/${repo}`,
        projectTitle: project.title,
        projectUrl: project.url,
        status: projectItemStatus(item.fieldValues?.nodes || []),
      }))
      .filter(Boolean)
      .filter(card => card.status !== 'done');
    if (cards.length > 0) {
      return {
        source: `GitHub Project: ${project.title}`,
        repo: `${owner}/${repo}`,
        url: project.url,
        cards,
      };
    }
  }

  if (projects.length > 0) {
    const project = projects[0];
    return {
      source: `GitHub Project: ${project.title}`,
      repo: `${owner}/${repo}`,
      url: project.url,
      cards: [],
    };
  }

  return null;
}

async function fetchIssueBoard({ owner, repo, token }) {
  const issues = await githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100&sort=updated&direction=desc`,
    { token },
  );
  const cards = issues.map(issue => {
    const type = issue.pull_request ? 'pull_request' : 'issue';
    const labelStatus = statusFromLabels(issue.labels || []);
    return {
      id: `${type}-${issue.number}`,
      provider: 'github',
      repo: `${owner}/${repo}`,
      type,
      number: issue.number,
      title: issue.title,
      description: issue.body || '',
      status: issue.state === 'closed' ? 'done' : labelStatus,
      status_label: issue.state === 'closed' ? 'Closed' : labelStatus,
      assignees: (issue.assignees || []).map(a => a.login),
      labels: (issue.labels || []).map(l => l.name),
      url: issue.html_url,
      updated_at: issue.updated_at,
      source: 'GitHub Issues',
    };
  }).filter(card => card.status !== 'done');
  return {
    source: 'GitHub Issues',
    repo: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}/issues`,
    cards,
  };
}

async function fetchRepoBoard({ cwd = process.cwd() } = {}) {
  const repoInfo = detectGitHubRepo(cwd);
  if (!repoInfo) {
    return {
      source: null,
      repo: null,
      url: null,
      auth_required: false,
      error: 'No GitHub origin remote detected for this repository.',
      cards: [],
    };
  }

  const token = githubToken();
  try {
    const projectBoard = await fetchProjectBoard({ ...repoInfo, token });
    if (projectBoard) return { ...projectBoard, auth_required: false };
  } catch (e) {
    // Fall through to issues so public repos still produce useful context.
  }

  try {
    const issueBoard = await fetchIssueBoard({ ...repoInfo, token });
    return {
      ...issueBoard,
      auth_required: false,
      project_unavailable: !token,
      project_hint: token ? null : 'Set GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN to load GitHub Projects; showing repo issues instead.',
    };
  } catch (e) {
    return {
      source: null,
      repo: `${repoInfo.owner}/${repoInfo.repo}`,
      url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}`,
      auth_required: true,
      error: e.message,
      cards: [],
    };
  }
}

// Post a comment back to a GitHub issue/PR — the safe, reversible half of board
// write-back (no destructive project-board mutations). Requires a token.
async function postIssueComment({ owner, repo, number, body, token }) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured. Set GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN or run "gh auth login".');
  if (!owner || !repo || !number) throw new Error('owner, repo, and issue number are required');
  if (!body || !String(body).trim()) throw new Error('comment body is required');
  return githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}/comments`,
    { token: auth, method: 'POST', body: { body } },
  );
}

async function createGitHubIssue({ owner, repo, title, body, token }) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured.');
  return githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    { token: auth, method: 'POST', body: { title, body } }
  );
}

// Update an issue's fields (body/title/state/labels) and/or post a comment.
// A PM uses this to keep the work-item description and status current the way a
// human PM would; comments are additive progress notes.
async function updateGitHubIssue({ owner, repo, number, state, body, title, labels, comment, token }) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured.');

  if (comment) {
    await postIssueComment({ owner, repo, number, body: comment, token: auth });
  }

  const patch = {};
  if (state) patch.state = state;
  if (body != null) patch.body = body;
  if (title != null) patch.title = title;
  if (Array.isArray(labels)) patch.labels = labels;
  if (Object.keys(patch).length === 0) return { ok: true, commented: !!comment };

  return githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`,
    { token: auth, method: 'PATCH', body: patch }
  );
}

// Read open Dependabot (dependency) alerts — the DevSecOps signal a DevOps
// engineer flags before the final PR. Requires a token with security-events /
// repo scope; a 403/404 means the feature is off or the scope is missing.
async function fetchDependabotAlerts({ owner, repo, token, state = 'open' } = {}) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured.');
  const alerts = await githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dependabot/alerts?state=${encodeURIComponent(state)}&per_page=100`,
    { token: auth },
  );
  return (Array.isArray(alerts) ? alerts : []).map(a => ({
    number: a.number,
    state: a.state,
    severity: a.security_advisory?.severity || a.security_vulnerability?.severity || 'unknown',
    package: a.dependency?.package?.name || '',
    summary: a.security_advisory?.summary || '',
    url: a.html_url,
  }));
}

// Read open code-scanning (CodeQL/SAST) alerts. Same auth requirements as above.
async function fetchCodeScanningAlerts({ owner, repo, token, state = 'open' } = {}) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured.');
  const alerts = await githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/code-scanning/alerts?state=${encodeURIComponent(state)}&per_page=100`,
    { token: auth },
  );
  return (Array.isArray(alerts) ? alerts : []).map(a => ({
    number: a.number,
    state: a.state,
    severity: a.rule?.security_severity_level || a.rule?.severity || 'unknown',
    rule: a.rule?.id || a.rule?.name || '',
    summary: a.rule?.description || a.most_recent_instance?.message?.text || '',
    url: a.html_url,
  }));
}

async function createDraftPR({ owner, repo, title, body, head, base, token }) {
  const auth = token || githubToken();
  if (!auth) throw new Error('No GitHub token configured.');
  return githubFetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
    { token: auth, method: 'POST', body: { title, body, head, base, draft: true } }
  );
}

// Render a colony's deliverable as a Markdown comment for the linked work-item.
// Shared by the manual "Post update" route and the automatic post-run write-back.
function buildBoardComment(colony) {
  const d = colony.deliverable || {};
  const lines = [`### \u{1F41D} Hive Colony update \u2014 ${colony.recipe_id || 'colony'}`];
  if (colony.summary) lines.push('', colony.summary);
  if (d.flow_complete !== undefined) lines.push('', `**Flow:** ${d.flow_complete ? 'complete \u2705' : 'partial \u26A0\uFE0F'}`);
  if (Array.isArray(d.links) && d.links.length) {
    lines.push('', '**Links:**', ...d.links.map(l => `- ${l}`));
  }
  if (Array.isArray(d.artifacts) && d.artifacts.length) {
    lines.push('', '**Artifacts:**', ...d.artifacts.map(a => `- ${a}`));
  }
  if (Array.isArray(d.handoffs) && d.handoffs.length) {
    lines.push('', '**Handoffs:**', ...d.handoffs.map(h => `- ${h.from} \u2192 ${h.to}${h.contract ? ` (${h.contract})` : ''} \u2014 ${h.status}`));
  }
  return lines.join('\n');
}

module.exports = {
  parseGitHubRemote,
  detectGitHubRepo,
  normalizeStatus,
  statusFromLabels,
  projectItemStatus,
  cardFromContent,
  fetchRepoBoard,
  postIssueComment,
  githubToken,
  createGitHubIssue,
  updateGitHubIssue,
  createDraftPR,
  fetchDependabotAlerts,
  fetchCodeScanningAlerts,
  buildBoardComment,
};
