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

// Second seed batch: business, marketing, sales, customer, operations, data,
// and security-review skills for the expanded recipe catalog (recipeCatalog.js).
// Inserted once under the `skills_seeded_v2` flag so DBs that already ran the
// v1 seed still receive them. Names here are referenced by staff-profile skill
// assignments — renderSkillsBlock() resolves them to these full bodies.
const SKILL_SEEDS_V2 = [
  {
    name: 'Market Research',
    description: 'Size markets and map landscapes with sourced evidence',
    instructions: '- Cite a URL and access date for every market claim; prefer primary data over aggregator blogs\n- State market size as a range with the methodology behind it (top-down vs bottom-up)\n- Segment before sizing: a number without a segment definition is noise\n- Separate what the data says from your interpretation of it',
    templates: [
      { title: 'Landscape entry', type: 'table', content: '| Segment | Size (range) | Growth | Key players | Source |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Competitive Analysis',
    description: 'Profile competitors: offering, pricing, positioning, strategy',
    instructions: '- Profile from public evidence (pricing pages, docs, reviews, hiring), not assumptions\n- Capture what each competitor optimizes for — their strategy explains their roadmap\n- Identify underserved segments as concrete whitespace, not generic "opportunity"\n- Rate the defensibility of any position you recommend against likely competitor responses',
    templates: [
      { title: 'Competitor card', type: 'table', content: '| Competitor | Offering | Pricing | Positioning | Apparent strategy | Source |\n|---|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Customer Evidence Gathering',
    description: 'Collect real customer signals instead of inventing personas',
    instructions: '- Mine reviews, forums, community threads, and job posts — capture verbatim quotes with links\n- Record the customer\'s own vocabulary; it becomes messaging and search terms later\n- Rank pains by intensity and frequency of evidence, not by what fits the thesis\n- Flag thin evidence explicitly rather than padding a persona with fiction',
    templates: [
      { title: 'Evidence log', type: 'table', content: '| Signal (verbatim) | Source URL | Persona | Pain | Intensity |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Positioning & Messaging',
    description: 'Define target, category, differentiated value, and proof',
    instructions: '- Position against the customer\'s real alternative (often "do nothing"), not your favorite rival\n- Every message pillar needs a proof point; cut claims that cannot be backed\n- Write in the audience\'s vocabulary from research, never internal jargon\n- Test the positioning by arguing the strongest competitor\'s case against it',
    templates: [
      { title: 'Positioning statement', type: 'text', content: 'For <target segment> who <need/trigger>, <product> is a <category> that <differentiated value>. Unlike <primary alternative>, it <key proof>.' },
    ],
  },
  {
    name: 'Campaign Planning',
    description: 'Sequence channels and content against a measurable goal',
    instructions: '- Every activity maps to a message pillar and a priority segment — orphan activities get cut\n- Sequence in phases (pre-launch, launch, sustain) with effort estimates per activity\n- Define the single action the campaign asks for; multiple CTAs dilute all of them\n- Plan measurement before launch: untracked channels are unaccountable channels',
    templates: [
      { title: 'Campaign grid', type: 'table', content: '| Phase | Channel | Asset | Pillar | Segment | Effort | Owner |\n|---|---|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Editorial Strategy',
    description: 'Choose content worth making and brief it precisely',
    instructions: '- Prioritize topics by audience value and differentiation — skip what everyone already writes\n- Every piece gets a brief: audience, angle, takeaway, desired action, success measure\n- Define scope boundaries (what the piece will NOT cover) to stop drafts sprawling\n- Match format to intent: guides for evaluation, opinions for attention, references for retention',
    templates: [
      { title: 'Content brief', type: 'text', content: 'Working title: ...\nAudience: ...\nAngle: why this piece is different\nReader takeaway: one sentence\nDesired action: ...\nOut of scope: ...' },
    ],
  },
  {
    name: 'SEO Research',
    description: 'Ground content plans in real search intent',
    instructions: '- Classify intent per term (informational, comparative, transactional) — content must match it\n- Check who ranks today; competing with entrenched incumbents needs a different distribution route\n- Recommend a primary term plus supporting terms per piece; never keyword-stuff\n- Search data is directional, not gospel — weigh it against audience evidence',
    templates: [],
  },
  {
    name: 'Long-form Drafting',
    description: 'Write drafts a knowledgeable reader would actually finish',
    instructions: '- Open with the reader\'s problem, not the company or the history of the topic\n- Every section must earn its length; cut anything not serving the brief\'s takeaway\n- Use only claims the research supports; keep the source next to each factual claim\n- Concrete beats abstract: examples, numbers, and named scenarios over generalities',
    templates: [],
  },
  {
    name: 'Copy Editing',
    description: 'Make drafts tighter, truer, and more useful',
    instructions: '- Edit in passes: structure first, then claims, then sentences\n- Challenge every factual claim — remove or caveat what cannot be supported\n- Cut filler ruthlessly: hedges, throat-clearing, repeated points\n- Verify the piece still delivers its brief\'s takeaway after the edit',
    templates: [],
  },
  {
    name: 'Distribution Planning',
    description: 'Plan how content actually reaches its audience',
    instructions: '- Plan distribution per piece: owned channels, communities, repurposing, timing\n- Write the carrier snippets (social posts, newsletter blurbs) as part of the plan, not later\n- Respect community norms — value-first sharing, never drive-by link drops\n- Define the signal (traffic, replies, shares) that marks a piece worth follow-up investment',
    templates: [],
  },
  {
    name: 'Sales Discovery',
    description: 'Qualify fit and uncover the real buying problem',
    instructions: '- Ask about the status quo first: what they do today and what it costs them\n- Qualify honestly — routing a bad-fit prospect out early is a win, not a loss\n- Uncover the buying process: who decides, who vetoes, what budget cycle applies\n- End every call with a concrete, dated next step both sides agreed to',
    templates: [
      { title: 'Discovery notes', type: 'table', content: '| Question | Answer | Implication |\n|---|---|---|\n| Current approach? | | |\n| Cost of status quo? | | |\n| Decision process/owner? | | |\n| Timeline & budget? | | |' },
    ],
  },
  {
    name: 'Objection Handling',
    description: 'Respond to objections honestly and advance the conversation',
    instructions: '- Acknowledge before reframing; a dismissed objection returns stronger later\n- Reframe with evidence (proof points, references), never with pressure\n- Distinguish objections from disqualifiers — some objections mean walking away is right\n- Prepare responses for the predictable set: price, timing, incumbent, risk, authority',
    templates: [
      { title: 'Objection card', type: 'text', content: 'Objection: "..."\nAcknowledge: ...\nReframe + evidence: ...\nAdvance: question or next step that moves the conversation\nDisqualifier? yes/no — when to walk away' },
    ],
  },
  {
    name: 'Sales Collateral Writing',
    description: 'Write skimmable assets that carry the pitch unattended',
    instructions: '- A buyer gives collateral thirty seconds — lead with the value, structure for scanning\n- Keep every asset consistent with the pitch narrative\'s claims and proof points\n- One asset, one moment of use: first touch, post-demo, business case — never a catch-all\n- No invented stats or logos; unverifiable claims poison the whole asset',
    templates: [
      { title: 'One-pager outline', type: 'instructions', content: '1. Headline: the outcome, in the buyer\'s words\n2. The problem and its cost (2-3 lines)\n3. How it works (3 bullets max)\n4. Proof: metric, quote, or reference\n5. The ask: one clear next step' },
    ],
  },
  {
    name: 'Funnel Analysis',
    description: 'Find where the funnel leaks, with numbers',
    instructions: '- Compute conversion AND velocity per stage; slow is a leak too\n- Cohort before concluding — aggregate rates hide where the problem concentrates\n- Name the biggest leak with evidence; fixing a non-constraint changes nothing\n- State data gaps and how they limit the diagnosis',
    templates: [
      { title: 'Stage table', type: 'table', content: '| Stage | Entered | Converted | Rate | Median days | Notes |\n|---|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Sales Forecasting',
    description: 'Produce forecasts the business can actually trust',
    instructions: '- Pick the method the data supports (stage-weighted, cohort velocity) and say why\n- Report ranges with confidence, never a single false-precision number\n- Make the inputs inspectable: which deals, which weights, which assumptions\n- Define the weekly ritual: inputs, owner, and the questions asked about slipping deals',
    templates: [],
  },
  {
    name: 'CRM Operations',
    description: 'Make the CRM reflect and reinforce the sales process',
    instructions: '- Stage definitions need entry/exit criteria a rep can answer yes/no to\n- Required fields must earn their friction — every one needs a downstream consumer\n- Automate the manual failure points: routing, reminders, stage-gate checks\n- Name the concrete configuration; "improve hygiene" is not a recommendation',
    templates: [],
  },
  {
    name: 'Customer Health Scoring',
    description: 'Design churn-predicting health scores that stay explainable',
    instructions: '- Score dimensions separately (usage, engagement, outcomes, relationship, support load) before combining\n- Weight with explicit reasoning; simple and explainable beats clever and opaque\n- Every score must decompose into its driving factors — an unexplainable score is unusable\n- Validate against known outcomes: would this score have flagged the accounts that churned?',
    templates: [
      { title: 'Score sheet', type: 'table', content: '| Account | Usage | Engagement | Outcomes | Relationship | Support | Composite | Top risk driver |\n|---|---|---|---|---|---|---|---|' },
    ],
  },
  {
    name: 'CS Playbook Design',
    description: 'Script repeatable plays that move accounts to healthy',
    instructions: '- One play per trigger: the condition, owner actions, timeline, and exit criteria\n- Cover the full lifecycle — onboarding and expansion plays, not just rescue plays\n- Keep each play executable by a busy CSM: one page, concrete steps\n- Define what "worked" means per play so plays can be retired when they don\'t',
    templates: [
      { title: 'Play format', type: 'text', content: 'Trigger: <signal/threshold>\nOwner: ...\nSteps: 1) ... 2) ... 3) ...\nTimeline: ...\nExit criteria: account state that closes the play' },
    ],
  },
  {
    name: 'Escalation Management',
    description: 'Rescue at-risk accounts with clear severity paths',
    instructions: '- Define severity levels with who engages at each and response timelines\n- An escalation brief states situation, impact, asks, and owner — no narrative essays\n- Communicate cadence during an escalation even when nothing changed\n- Close the loop: every escalation ends with a cause note and a prevention action',
    templates: [
      { title: 'Escalation brief', type: 'text', content: 'Severity: ...\nSituation: 2 lines\nImpact: revenue/relationship at stake\nAsks: what, from whom, by when\nOwner: ...' },
    ],
  },
  {
    name: 'Renewal & Expansion Strategy',
    description: 'Turn account health into renewal and growth plans',
    instructions: '- Start the renewal motion early — the value story is built over the term, not at the deadline\n- Ground the value story in delivered outcomes the customer already acknowledged\n- Save strategies target the specific health drivers at risk, not generic discounts\n- Forecast renewals with per-account confidence levels and the reason for each',
    templates: [],
  },
  {
    name: 'Process Mapping',
    description: 'Document how work actually flows today',
    instructions: '- Map the as-is reality, not the official process — capture where they diverge and why\n- Every step gets an owner, tool, input, output, and timing (mark estimates as estimates)\n- Wait states are steps too; most process time hides between the boxes\n- Validate the map with the people who run the process before analyzing it',
    templates: [
      { title: 'Step inventory', type: 'table', content: '| # | Step | Owner | Tool | Duration | Wait after | Deviations |\n|---|---|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Bottleneck Analysis',
    description: 'Find where a process truly loses time and quality',
    instructions: '- Rank constraints by end-to-end impact; fixing a non-constraint changes nothing\n- Look for the four signatures: longest waits, most rework, most manual toil, most variance\n- Distinguish root constraints from symptoms with explicit reasoning\n- Quantify each bottleneck so fixes can be prioritized by impact-per-effort',
    templates: [],
  },
  {
    name: 'SOP Writing',
    description: 'Write procedures a new hire can execute without tribal knowledge',
    instructions: '- Structure: trigger, steps, owner, tools, done-criteria — every SOP, no exceptions\n- Each step is one observable action with its expected result\n- Target a diagnosed problem: an SOP must remove the wait or rework, not just document it\n- Version SOPs and name an owner; an unowned SOP rots silently',
    templates: [
      { title: 'SOP skeleton', type: 'text', content: '# SOP: <name>\nTrigger: when this runs\nOwner: role\nSteps:\n1. <action> → <expected result>\n2. ...\nDone when: <observable end state>\nEscalate to <who> if <condition>' },
    ],
  },
  {
    name: 'Automation Scouting',
    description: 'Decide what to automate and with which tool',
    instructions: '- Automate the proven-stable steps: triggers, data movement, notifications, approvals\n- Research concrete tool options with sources and realistic setup effort, not vendor promises\n- Recommend build/buy/skip per candidate with cost-of-error factored in\n- An automation that fails silently is worse than the manual step it replaced — require observability',
    templates: [],
  },
  {
    name: 'Vendor Evaluation',
    description: 'Score vendors against weighted, testable requirements',
    instructions: '- Requirements and weights come first; shopping before criteria guarantees bias\n- Score from evidence (docs, trials, references) and mark unverifiable claims as unverified\n- Keep an elimination log — why each cut vendor was cut\n- Check viability signals: funding, customer base, release cadence, support responsiveness',
    templates: [
      { title: 'Score matrix', type: 'table', content: '| Requirement (weight) | Vendor A | Vendor B | Vendor C | Evidence |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'TCO & Cost Analysis',
    description: 'Compute what an option truly costs over its life',
    instructions: '- Model beyond the sticker: licenses, setup, integration, training, maintenance, exit\n- Normalize pricing tiers to actual expected usage, not the vendor\'s favorite tier\n- Compare at 1-year and 3-year horizons with assumptions stated inline\n- Include the cost of doing nothing as a baseline option',
    templates: [
      { title: 'TCO table', type: 'table', content: '| Cost component | Option A yr1/yr3 | Option B yr1/yr3 | Assumption |\n|---|---|---|---|' },
    ],
  },
  {
    name: 'Business Risk Assessment',
    description: 'Surface the risks that pitch decks hide',
    instructions: '- Assess systematically: dependency, lock-in, compliance, reputation, execution, market risks\n- Rate likelihood and impact separately; a scary-sounding unlikely risk ranks below a mundane certain one\n- Every flagged risk gets a mitigation or an explicit acceptance rationale\n- Name the single biggest concern plainly — burying it in a matrix is a dodge',
    templates: [
      { title: 'Risk register', type: 'table', content: '| Risk | Likelihood | Impact | Mitigation / acceptance | Owner |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Financial Scenario Modeling',
    description: 'Model economics with explicit, testable assumptions',
    instructions: '- Build simple and reproducible (a script or sheet others can rerun) over clever and opaque\n- Always three scenarios: base, optimistic, pessimistic — with what drives each\n- Sensitivity-test the assumptions that dominate the outcome; state break-even in plain language\n- Every number in the output traces to an assumption with a source',
    templates: [],
  },
  {
    name: 'Executive Brief Writing',
    description: 'Compress analysis into a five-minute decision document',
    instructions: '- Lead with the recommendation and the three facts that most support it\n- One page of body: options considered, economics, risks, and the exact decision being asked for\n- Append the evidence trail so every number is traceable — but keep it out of the body\n- Write for a skeptical reader with no context and no patience',
    templates: [
      { title: 'Brief outline', type: 'instructions', content: '1. Recommendation (one sentence)\n2. The three decisive facts\n3. Options considered with trade-offs (3-4 lines each)\n4. Risks and mitigations\n5. The decision requested, by when\nAppendix: evidence trail' },
    ],
  },
  {
    name: 'Partnership Strategy',
    description: 'Assess partner fit and structure signable deals',
    instructions: '- Mutual gain is the filter: name concretely what each side gets, or drop the lead\n- Assess audience overlap, incentive alignment, and integration cost before any outreach\n- Propose structures in plain language: obligations, economics, exit terms\n- Mark likely negotiation points and your walk-away positions in advance',
    templates: [],
  },
  {
    name: 'Structured Interviewing',
    description: 'Measure competencies instead of rewarding confidence',
    instructions: '- Derive questions and work samples from the role\'s outcome definition, not from favorite puzzles\n- Score against written anchors, independently, before any group discussion\n- Every stage must state what it measures and earn its candidate-time cost\n- Disagreement triggers an extra data point, never a coin flip or the loudest voice',
    templates: [
      { title: 'Scoring anchor', type: 'text', content: 'Competency: ...\nQuestion/exercise: ...\n1 — <concrete weak signal>\n3 — <concrete adequate signal>\n5 — <concrete strong signal>' },
    ],
  },
  {
    name: 'Talent Sourcing',
    description: 'Find where strong candidates actually are and reach them',
    instructions: '- Research where the competency gathers: communities, companies, events — with sources\n- Mix channels deliberately: outbound, referrals, postings — each with its own message\n- Write outreach a strong, employed candidate would answer: specific, honest, short\n- Track channel yield so the next search starts smarter',
    templates: [],
  },
  {
    name: 'Knowledge Base Writing',
    description: 'Write articles that deflect repetitive tickets',
    instructions: '- Write in the customer\'s vocabulary lifted from real tickets, not internal product names\n- Structure for scanning: the fix first, then the explanation, then edge cases\n- One article per problem; catch-all articles help nobody find anything\n- Note where an article cannot fully deflect without a product change — that\'s a defect signal',
    templates: [
      { title: 'Article skeleton', type: 'text', content: '# <Problem in the customer\'s words>\n\n## Fix\n1. ...\n\n## Why this happens\n...\n\n## If that didn\'t work\n- <edge case> → <variant fix or escalation>' },
    ],
  },
  {
    name: 'Support Workflow Design',
    description: 'Route tickets to the right resolution fast',
    instructions: '- Design triage as rules a new agent can apply: categorization, priority, routing, escalation\n- Macros and saved replies for the high-volume categories, linked to KB articles\n- SLAs must be meetable by the actual team size — aspirational SLAs erode trust\n- Every escalation path needs a named destination and a response expectation',
    templates: [],
  },
  {
    name: 'Quality Rubric Design',
    description: 'Define what good looks like and check it consistently',
    instructions: '- Score dimensions separately (accuracy, tone, completeness, process) with concrete anchors\n- Calibrate with worked examples — a rubric nobody scored together drifts immediately\n- Sample sustainably: a small consistent review beats a large abandoned one\n- Rubric findings feed coaching and process fixes, not just scores',
    templates: [],
  },
  {
    name: 'Data Wrangling',
    description: 'Profile, clean, and prepare data reproducibly',
    instructions: '- Profile before transforming: nulls, duplicates, outliers, type mismatches — paste real output\n- Preparation lives in rerunnable scripts, never one-off shell history\n- Raw data stays untouched; derived data goes to separate, named files\n- Log every transformation and dropped record class so the analysis is auditable',
    templates: [],
  },
  {
    name: 'Statistical Inference',
    description: 'Test whether observed patterns are real or noise',
    instructions: '- Choose tests the data shape supports and state their assumptions explicitly\n- Report effect sizes and uncertainty, not just p-values\n- Call out underpowered comparisons and multiple-testing risks honestly\n- "Suggestive but unconfirmed" is a valid and often correct conclusion',
    templates: [],
  },
  {
    name: 'Data Visualization',
    description: 'Turn findings into honest, readable charts',
    instructions: '- Chart form follows the data relationship: trend→line, comparison→bar, distribution→histogram\n- Never truncate axes or cherry-pick windows to exaggerate an effect\n- Annotate each chart with the finding it demonstrates — a chart without a claim is decoration\n- Save charts as files and reference their paths; embedded descriptions are not deliverables',
    templates: [],
  },
  {
    name: 'Threat Modeling',
    description: 'Map attack surface before reviewing a line of code',
    instructions: '- Inventory entry points, trust boundaries, data flows, and assets from the actual system\n- Enumerate threats per boundary (STRIDE is a fine checklist) ranked by likelihood × impact\n- The output is questions for reviewers: what to verify, where, and why it matters\n- Revisit the model when the architecture changes; stale threat models mislead',
    templates: [
      { title: 'Threat entry', type: 'table', content: '| Boundary | Threat (STRIDE) | Likelihood | Impact | Verification question |\n|---|---|---|---|---|' },
    ],
  },
  {
    name: 'Dependency Auditing',
    description: 'Audit dependency trees for vulnerabilities and risk',
    instructions: '- Run the ecosystem audit and paste real output; a summary without output is a claim, not an audit\n- NEVER run "npm audit fix --force" or downgrade to silence a warning — report for deliberate remediation\n- Check the critical path for unmaintained or suspiciously new packages\n- Order remediation by severity and exploitability, not by ease of fix',
    templates: [],
  },
  {
    name: 'Root Cause Analysis',
    description: 'Converge on causes with evidence, not plausible stories',
    instructions: '- Build competing hypotheses and test each against the evidence timeline\n- The first plausible story is usually incomplete — ask what else would explain the same facts\n- Cite the causal defect precisely (file:line, config key, event) with confidence level\n- Name the single missing piece of evidence that would change your conclusion',
    templates: [
      { title: 'Hypothesis table', type: 'table', content: '| Hypothesis | Supporting evidence | Contradicting evidence | Verdict |\n|---|---|---|---|' },
    ],
  },
  {
    name: 'Migration Planning',
    description: 'Slice migrations into safe, verifiable steps',
    instructions: '- Every step leaves the system working; if a step can\'t, split it until it can\n- Define the verification command per step — what proves it landed safely\n- Front-load risk discovery: do the scariest reversible step first\n- Keep rollback simple and tested for every step that touches persistent state',
    templates: [],
  },
  {
    name: 'Release Coordination',
    description: 'Package changes for release with honest go/no-go calls',
    instructions: '- Release notes state what changed, what to watch, and any operator action required\n- The go/no-go call cites the verification evidence, not vibes\n- File follow-up work as explicit tracked items, not footnotes\n- A release with unverified critical paths is a no-go, however late it is',
    templates: [],
  },
  {
    name: 'Changelog Curation',
    description: 'Write user-facing changelogs from what actually shipped',
    instructions: '- Gather from the repo history and linked issues/PRs — never from memory\n- Describe impact in user terms, grouped added/changed/fixed; commit messages are not entries\n- Keep version and date conventions consistent with the existing changelog\n- Note anything deliberately excluded and why',
    templates: [],
  },
  {
    name: 'UX Prototyping',
    description: 'Make product directions tangible as flows and screens',
    instructions: '- Sketch the core flow end to end: entry, key screens, states, and the moment of value\n- Ground every screen in an evidenced customer pain — cite which persona it serves\n- Cover the unglamorous states: empty, loading, error, and first-run\n- Note the interaction risks a real prototype test should probe first',
    templates: [],
  },
];

// v3 — media generation skills for the new image/voice roles (local FLUX.2-klein
// via MLX, Orpheus TTS via Ollama). Seeded into installs that already ran v1/v2.
const SKILL_SEEDS_V3 = [
  {
    name: 'Image Generation',
    description: 'Produce strong images with the local FLUX.2-klein model',
    instructions: '- Write concrete, visual prompts: subject, composition, setting, lighting, style, and mood — vague prompts yield generic art\n- State the medium/style explicitly (photo, flat illustration, 3D render, line diagram) rather than leaving it to chance\n- Call generate_image; it saves a PNG to the run artifacts (downloadable and auto-posted to Discord) — reference the returned filename in your handoff\n- Name files by purpose (hero.png, diagram-flow.png); one image per distinct need, not one prompt for everything\n- If a result misses, refine the prompt and regenerate rather than describing what you would have made',
    templates: [
      { title: 'Image prompt shape', type: 'text', content: '<subject and action>, <composition/framing>, <setting>, <lighting>, <style/medium>, <mood>. Example: "A solo developer at a standing desk reviewing dashboards, medium wide shot, warm home-office at dusk, soft rim light, clean editorial photo, focused and calm."' },
    ],
  },
  {
    name: 'Voice Synthesis',
    description: 'Narrate text as audio with the local Orpheus TTS model',
    instructions: '- Write for the ear: short sentences, natural phrasing, and expanded numbers/acronyms so they read aloud correctly\n- Pick a voice that fits the content and pass it to generate_speech; keep one voice per deliverable for consistency\n- Keep each clip focused — split long scripts into logical segments with clear filenames\n- generate_speech saves a WAV to the run artifacts (downloadable and auto-posted to Discord) — reference the returned filename in your handoff\n- Proofread the script before synthesizing; regenerating is cheaper than shipping a mispronounced take',
    templates: [],
  },
];

module.exports = { SKILL_SEEDS, SKILL_SEEDS_V2, SKILL_SEEDS_V3 };
