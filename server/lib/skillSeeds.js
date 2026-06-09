// Seed catalog of demo/testing skills. Inserted once at boot (guarded by an
// app_settings flag in db.js). Users can edit or delete them freely afterwards.

const SKILL_SEEDS = [
  {
    name: 'Requirements Elicitation',
    description: 'Turn vague goals into testable requirements',
    instructions: '- Restate the goal in one sentence and confirm scope before decomposing\n- Separate functional requirements from constraints (performance, security, compatibility)\n- Every requirement must be verifiable — if you cannot describe its test, rewrite it\n- Flag assumptions explicitly rather than silently filling gaps',
    templates: [
      { title: 'Requirement entry', type: 'table', content: '| ID | Requirement | Type | Acceptance Criteria | Priority |\n|---|---|---|---|---|\n| R1 | ... | Functional | Given/When/Then ... | Must |' },
    ],
  },
  {
    name: 'User Story Writing',
    description: 'Write small, testable user stories with acceptance criteria',
    instructions: '- Use the "As a / I want / So that" format; the "so that" must name real value\n- Keep stories small enough to finish in one iteration; split by workflow step, not by layer\n- Acceptance criteria use Given/When/Then and cover at least one unhappy path',
    templates: [
      { title: 'Story format', type: 'text', content: 'As a <role>, I want <capability>, so that <benefit>.\n\nAcceptance criteria:\n- Given <context>, when <action>, then <outcome>\n- Given <error context>, when <action>, then <graceful failure>' },
    ],
  },
  {
    name: 'Sprint Planning',
    description: 'Scope, estimate, and sequence a sprint backlog',
    instructions: '- Confirm capacity first (people × days − meetings/leave) before pulling work\n- Pull by priority, then check dependency order; never start a story blocked by an unpulled one\n- State the sprint goal in one sentence; anything not serving it is a stretch item',
    templates: [
      { title: 'Sprint plan', type: 'table', content: '| Story | Owner | Estimate | Depends on | Goal-critical? |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Code Review',
    description: 'Review diffs for correctness, security, and maintainability',
    instructions: '- Read the change description first, then verify the diff actually does that and nothing more\n- Check in order: correctness → security → error handling → tests → naming/clarity\n- Every blocking comment must say why and propose a concrete fix\n- Approve with nits rather than blocking on style when a linter exists',
    templates: [
      { title: 'Review checklist', type: 'instructions', content: '1. Does the change match its stated intent?\n2. Inputs validated? Errors handled, not swallowed?\n3. Any secrets, injection risks, or unsafe deserialization?\n4. Tests cover the new behavior incl. one failure path?\n5. Public names/comments accurate after the change?' },
    ],
  },
  {
    name: 'Unit Test Design',
    description: 'Write focused unit tests with meaningful coverage',
    instructions: '- One behavior per test; name tests <unit>_<scenario>_<expected>\n- Always include: happy path, boundary value, and one failure/exception case\n- Prefer real objects over mocks; mock only true externals (network, clock, fs)',
    templates: [
      { title: 'Test skeleton', type: 'code', content: "describe('<unit>', () => {\n  it('<scenario> → <expected>', () => {\n    // arrange\n    // act\n    // assert (one logical assertion)\n  });\n});" },
    ],
  },
  {
    name: 'Integration Testing',
    description: 'Verify component seams and contracts end to end',
    instructions: '- Test the seam, not the internals: real database/queue where feasible, fakes only at the system boundary\n- Reset state between tests; order-dependent tests are bugs\n- Assert on observable outcomes (rows written, messages emitted), not on internal calls',
    templates: [
      { title: 'Scenario sheet', type: 'table', content: '| Scenario | Components | Setup | Action | Expected observable outcome |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Debugging Methodology',
    description: 'Isolate root causes systematically instead of guessing',
    instructions: '- Reproduce first; a bug you cannot reproduce is a bug you cannot verify fixed\n- Bisect the space: half the input, half the code path, half the timeline\n- Change one variable at a time and record each experiment\n- Fix the root cause; if you must patch a symptom, file the underlying issue',
    templates: [
      { title: 'Debug log', type: 'table', content: '| # | Hypothesis | Experiment | Result | Conclusion |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'API Design',
    description: 'Design consistent, evolvable HTTP/JSON APIs',
    instructions: '- Nouns for resources, verbs via HTTP methods; plural collection names\n- Errors return a machine-readable code, human message, and correlation id\n- Never break existing clients: additive changes only, version when removal is unavoidable\n- Document every endpoint with one example request and response',
    templates: [
      { title: 'Endpoint spec', type: 'text', content: 'METHOD /path/{id}\nPurpose: ...\nAuth: ...\nRequest body: { ... }\nResponses: 200 { ... } | 400 {"error": {"code": "...", "message": "..."}} | 404' },
      { title: 'Error envelope', type: 'code', content: '{\n  "error": {\n    "code": "RESOURCE_NOT_FOUND",\n    "message": "Human-readable explanation",\n    "correlation_id": "req-..."\n  }\n}' },
    ],
  },
  {
    name: 'Database Schema Design',
    description: 'Model relational schemas that survive change',
    instructions: '- Normalize until it hurts, denormalize where measured reads demand it\n- Every table: surrogate primary key, created_at/updated_at, explicit foreign keys\n- Migrations are additive and reversible; destructive changes ship in two releases (deprecate, then drop)',
    templates: [
      { title: 'Migration pattern', type: 'code', content: "-- additive, reversible\nALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';\nCREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);" },
    ],
  },
  {
    name: 'Refactoring Discipline',
    description: 'Improve structure without changing behavior',
    instructions: '- Refactor and behavior change never share a commit\n- Tests green before, after, and ideally between each mechanical step\n- Name the smell you are removing (duplication, long method, feature envy) in the commit message\n- Stop when the named smell is gone — no drive-by rewrites',
    templates: [],
  },
  {
    name: 'Git Hygiene',
    description: 'Small commits, clear messages, clean history',
    instructions: '- One logical change per commit; if the message needs "and", split it\n- Message format: imperative summary ≤72 chars, blank line, then the why\n- Rebase local work for clarity; never rewrite shared branches',
    templates: [
      { title: 'Commit message', type: 'text', content: 'Add rate limiting to webhook ingestion\n\nBursts from misconfigured senders were exhausting the worker pool.\nLimits are per-source with a 429 + Retry-After response.' },
    ],
  },
  {
    name: 'CI/CD Pipeline Design',
    description: 'Build fast, trustworthy delivery pipelines',
    instructions: '- Order stages by speed: lint → unit → build → integration → deploy\n- A red pipeline blocks merge — no manual overrides without an incident note\n- Deploys are idempotent and roll back with one command\n- Keep total PR feedback under 10 minutes; parallelize or cache to get there',
    templates: [
      { title: 'Pipeline stages', type: 'instructions', content: '1. Lint + typecheck (fail fast)\n2. Unit tests with coverage gate\n3. Build artifact once, promote everywhere\n4. Integration tests against the built artifact\n5. Deploy to staging → smoke test → production' },
    ],
  },
  {
    name: 'Incident Response',
    description: 'Triage, mitigate, and learn from production incidents',
    instructions: '- Mitigate first, diagnose second: restore service, then find the root cause\n- One person communicates status; updates at a fixed cadence even when nothing changed\n- Timestamp everything during the incident — the postmortem depends on it\n- Postmortems are blameless and end with owned, dated action items',
    templates: [
      { title: 'Status update', type: 'text', content: '[INCIDENT <sev>] <one-line summary>\nImpact: who/what is affected\nCurrent status: investigating | mitigating | resolved\nNext update: <time>' },
      { title: 'Postmortem outline', type: 'instructions', content: '1. Summary + impact window\n2. Timeline (detection → mitigation → resolution)\n3. Root cause (5 whys)\n4. What went well / poorly\n5. Action items: owner + due date each' },
    ],
  },
  {
    name: 'Performance Profiling',
    description: 'Find and fix real bottlenecks with measurement',
    instructions: '- Measure before optimizing; profile the production-shaped workload, not a toy\n- Optimize the top of the profile only; re-measure after each change\n- State results as percentiles (p50/p95/p99), never averages alone\n- Keep the benchmark script in the repo so wins are reproducible',
    templates: [
      { title: 'Result format', type: 'table', content: '| Scenario | Before p50/p95 | After p50/p95 | Change |\n|---|---|---|---|' },
    ],
  },
  {
    name: 'Security Review',
    description: 'Spot common vulnerabilities before they ship',
    instructions: '- Trace every external input to where it is used; validate at the boundary\n- Check OWASP top risks: injection, broken auth, sensitive data exposure, SSRF\n- Secrets never in code, logs, or error messages\n- Least privilege for every token, role, and database account',
    templates: [
      { title: 'Review checklist', type: 'instructions', content: '1. Inputs validated/encoded at every trust boundary?\n2. AuthN distinct from authZ; every endpoint enforces both?\n3. Secrets from env/vault only; rotated; absent from logs?\n4. Dependencies scanned; known CVEs triaged?\n5. Errors leak no stack traces or internals to clients?' },
    ],
  },
  {
    name: 'Technical Documentation',
    description: 'Write docs people can actually follow',
    instructions: '- Lead with what the reader can do after reading — not with architecture history\n- Every code sample must be copy-paste runnable; test them\n- Document the why for decisions, the how for tasks; keep them separate\n- Update docs in the same change that alters behavior',
    templates: [
      { title: 'README outline', type: 'instructions', content: '1. What it does (2 sentences)\n2. Quick start (copy-paste to first success)\n3. Configuration reference\n4. Troubleshooting (top 5 failures)\n5. Contributing / development setup' },
    ],
  },
  {
    name: 'Architecture Decision Records',
    description: 'Capture significant decisions with context and trade-offs',
    instructions: '- Write an ADR when a decision is expensive to reverse or shapes other work\n- Honestly list at least two real alternatives with their trade-offs\n- Status lifecycle: proposed → accepted → superseded (never delete old ADRs)',
    templates: [
      { title: 'ADR format', type: 'text', content: '# ADR-NNN: <title>\nStatus: proposed | accepted | superseded by ADR-MMM\n\n## Context\nWhat forces are at play.\n\n## Decision\nWhat we chose.\n\n## Alternatives considered\n- Option B: pros / cons\n- Option C: pros / cons\n\n## Consequences\nWhat becomes easier, what becomes harder.' },
    ],
  },
  {
    name: 'Web Research & Verification',
    description: 'Gather facts from the web and verify before reporting',
    instructions: '- Two independent sources for any load-bearing claim; primary sources beat aggregators\n- Record the URL and access date for every fact\n- Distinguish clearly: verified fact / single-source claim / inference\n- Tool errors or rate limits are access failures — report them as gaps, never fill with guesses',
    templates: [
      { title: 'Findings table', type: 'table', content: '| Claim | Source(s) | Date | Confidence | Notes |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Stakeholder Status Updates',
    description: 'Report progress concisely to non-technical audiences',
    instructions: '- Lead with the headline: on track / at risk / blocked, and what changed since last update\n- Translate technical work into user or business impact\n- Risks come with asks: what you need, from whom, by when\n- Keep it under 10 lines; link out for detail',
    templates: [
      { title: 'Status format', type: 'text', content: 'Status: ON TRACK | AT RISK | BLOCKED\nSince last update: <1-2 lines>\nNext: <1-2 lines>\nRisks/asks: <risk> → need <action> from <who> by <when>' },
    ],
  },
  {
    name: 'Estimation & Risk Sizing',
    description: 'Produce honest estimates with explicit uncertainty',
    instructions: '- Estimate in ranges (best/likely/worst), never single numbers\n- Decompose until each piece is under a day before summing\n- List the assumptions the estimate depends on; an invalidated assumption re-opens the estimate\n- Track actuals vs estimates to calibrate yourself over time',
    templates: [
      { title: 'Estimate sheet', type: 'table', content: '| Work item | Best | Likely | Worst | Key assumption |\n|---|---|---|---|---|' },
    ],
  },
];

module.exports = { SKILL_SEEDS };
