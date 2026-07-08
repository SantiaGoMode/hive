// ── Work router ───────────────────────────────────────────────────────────────
// Intake matchmaking (colonies-first spec, R4): when a board card is created /
// labeled or a webhook event arrives, propose a destination colony for it.
// Suggestion-only — items land as `proposed` in the matched colony's queue (or
// in the roster's Unrouted tray) and never start runs on their own.
//
// Matching is deliberately isolated here (called from the webhook receiver and
// any future board poller) so P2 ideas — multiple colonies per recipe,
// cross-repo colonies — swap the scoring without touching intake call sites.

const { detectGitHubRepo } = require('./githubBoard');
const { boardCardFromPayload, classifyEvent } = require('./colonyTriggers');
const { getColonyRecipe } = require('./colonyRecipes');
const colonyTeams = require('./colonyTeams');
const workItems = require('./colonyWorkItems');
const { logger } = require('./logger');

// detectGitHubRepo shells out to git; cache repo_path → "owner/repo" briefly so
// one webhook burst doesn't fork git once per team per event.
const REPO_SLUG_TTL_MS = 5 * 60 * 1000;
const repoSlugCache = new Map(); // repo_path -> { slug, at }

function repoSlugForPath(repoPath) {
  if (!repoPath) return null;
  const cached = repoSlugCache.get(repoPath);
  if (cached && Date.now() - cached.at < REPO_SLUG_TTL_MS) return cached.slug;
  const detected = detectGitHubRepo(repoPath);
  const slug = detected ? `${detected.owner}/${detected.repo}`.toLowerCase() : null;
  repoSlugCache.set(repoPath, { slug, at: Date.now() });
  return slug;
}

function keywordsForTeam(team) {
  const recipe = getColonyRecipe(team.recipe_id);
  const words = new Set();
  if (recipe.category) words.add(String(recipe.category).toLowerCase());
  for (const role of recipe.roles || []) {
    for (const skill of role.skills || []) words.add(String(skill).toLowerCase());
  }
  return words;
}

function cardTokens(card) {
  const labels = (card.labels || []).map(l => String(l).toLowerCase());
  const titleWords = String(card.title || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
  return { labels, titleWords };
}

// Pick the best colony for a card. Repo ownership is the gate; recipe
// category / crew skills vs. card labels break ties between colonies that
// share a repo. Returns { team, reason } or null (→ Unrouted).
function matchTeamForCard(card, teams = null) {
  const cardRepo = String(card?.repo || '').toLowerCase();
  if (!cardRepo) return null;
  const candidates = (teams || colonyTeams.listTeams())
    .filter(t => t.repo_path && repoSlugForPath(t.repo_path) === cardRepo);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { team: candidates[0], reason: `repo ${card.repo} is owned by "${candidates[0].name}"` };
  }

  const { labels, titleWords } = cardTokens(card);
  let best = null;
  for (const team of candidates) {
    const keywords = keywordsForTeam(team);
    let score = 0;
    const hits = [];
    for (const label of labels) {
      if (keywords.has(label)) { score += 2; hits.push(`label "${label}"`); }
    }
    for (const word of titleWords) {
      if (keywords.has(word)) { score += 1; hits.push(`"${word}"`); }
    }
    // Oldest team wins ties — stable, predictable routing.
    if (!best || score > best.score) best = { team, score, hits };
  }
  const reasonBits = [`repo ${card.repo} is shared by ${candidates.length} colonies`];
  if (best.score > 0) reasonBits.push(`${[...new Set(best.hits)].slice(0, 3).join(', ')} matches "${best.team.name}" crew`);
  else reasonBits.push(`defaulted to oldest colony "${best.team.name}"`);
  return { team: best.team, reason: reasonBits.join('; ') };
}

// Land a card as a proposed item in the best-matching colony's queue, or in
// the Unrouted tray when nothing matches. Dedupes on (source, source_ref) so
// redeliveries and label churn don't stack duplicates — a dismissed proposal
// stays dismissed.
function proposeCard(card, { source = 'board', sourceRef = null } = {}) {
  if (!card) return null;
  const ref = sourceRef || (card.id ? String(card.id) : null);
  if (workItems.hasItemForSource(source, ref)) return null;
  const match = matchTeamForCard(card);
  return workItems.createWorkItem({
    teamId: match?.team.id || null,
    source,
    sourceRef: ref,
    title: card.title || '',
    direction: '',
    boardCard: card,
    status: 'proposed',
    matchReason: match ? match.reason : 'no colony owns this repo',
  });
}

// Card-producing webhook actions worth proposing. Everything else (closed,
// edited, comment chatter) relates to work already tracked elsewhere.
const INTAKE_ACTIONS = new Set(['opened', 'reopened', 'labeled', 'transferred', '']);

// Called from the webhook receiver for every accepted event, independently of
// the legacy per-run trigger_config path (which may also start a run).
function routeWebhookEvent(event) {
  try {
    const payload = event.payload || {};
    const kind = classifyEvent(event.event_type, payload);
    if (kind === 'comment') return null; // comments steer existing work, not new items
    const action = String(payload.action || '').toLowerCase();
    if (!INTAKE_ACTIONS.has(action)) return null;
    const card = boardCardFromPayload(payload, kind);
    if (!card || (!card.number && !card.url)) return null;
    return proposeCard(card, {
      source: 'webhook',
      sourceRef: `${event.webhook_id || 'wh'}:${card.id || event.id}`,
    });
  } catch (e) {
    logger.error('workRouter', 'route_event_failed', { event_id: event?.id, error: e?.message || String(e) });
    return null;
  }
}

module.exports = { matchTeamForCard, proposeCard, routeWebhookEvent, repoSlugForPath };
