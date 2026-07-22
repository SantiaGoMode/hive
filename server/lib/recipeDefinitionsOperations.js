const { defineRecipe } = require('./recipeFactory');

const OPERATIONS_RECIPES = [
  // ══ Customer ═════════════════════════════════════════════════════════════════
  defineRecipe({
    id: 'customer_success',
    name: 'Customer Success Team',
    category: 'Customer',
    summary: 'Staged CS pass: account research, health scoring, playbooks, escalation handling, and renewal strategy',
    placeholder: 'Describe the customer base or account situation...\ne.g. Build a health-score and renewal playbook for our 30 consulting retainer accounts',
    strict: true,
    roles: [
      {
        key: 'account_researcher', title: 'Account Researcher', agent: 'Freya Dahl',
        caps: ['research', 'analysis'],
        mission: 'to build a factual picture of the accounts: usage, stakeholders, and value delivered.',
        duties: [
          'Profile the accounts from the mission context: segment, stakeholders, contract, and delivered outcomes.',
          'Identify each account’s champion, decision maker, and current sentiment signals.',
          'Flag accounts where key facts are missing — an unprofiled account cannot be scored.',
        ],
        handoff: 'Account research handoff',
        handoffContents: 'the account profiles, stakeholder maps, and the missing-data list',
      },
      {
        key: 'health_score_analyst', title: 'Health Score Analyst', agent: 'Imran Sheikh',
        caps: ['analysis'],
        mission: 'to design a health score that predicts churn before it happens.',
        duties: [
          'Define health dimensions (usage, engagement, outcomes, relationship, support load) with measurable signals.',
          'Weight the dimensions with explicit reasoning; simple and explainable beats clever.',
          'Score the researched accounts and rank them by risk with the driving factors named.',
        ],
        handoff: 'Health score handoff',
        handoffContents: 'the scoring model, the ranked account scores, and the top risk drivers',
      },
      {
        key: 'playbook_designer', title: 'Playbook Designer', agent: 'Charlotte Webb',
        caps: ['writing'], files: true,
        artifact: 'the CS playbooks saved to the workspace',
        mission: 'to script the plays that move accounts from each risk state to healthy.',
        duties: [
          'Write a play per risk driver: trigger, owner actions, timeline, and exit criteria.',
          'Include the onboarding and expansion plays, not just rescue plays.',
          'Keep each play executable by a busy CSM — one page, concrete steps.',
        ],
        handoff: 'Playbook handoff',
        handoffContents: 'the playbook file paths and the trigger-to-play mapping',
      },
      {
        key: 'escalation_coordinator', title: 'Escalation Coordinator', agent: 'Ravi Menon',
        caps: ['analysis', 'writing'],
        mission: 'to design how at-risk accounts get rescued when plays are not enough.',
        duties: [
          'Define the escalation path: severity levels, who engages at each level, and response timelines.',
          'Draft the escalation brief template: situation, impact, asks, and owner.',
          'Apply it to the currently highest-risk accounts as worked examples.',
        ],
        handoff: 'Escalation handoff',
        handoffContents: 'the escalation framework and the worked examples for the riskiest accounts',
      },
      {
        key: 'renewal_strategist', title: 'Renewal Strategist', agent: 'Monica Alvarez',
        caps: ['writing', 'analysis'], files: true,
        artifact: 'the renewal strategy document saved to the workspace',
        mission: 'to turn the health picture into a renewal and expansion strategy.',
        duties: [
          'Build the renewal timeline per account: when to start, the value story, and the expansion angle.',
          'Define the save strategy for at-risk renewals grounded in the health drivers.',
          'Produce the renewal forecast with confidence levels per account.',
        ],
        handoff: 'Final renewal strategy',
        handoffContents: 'the renewal strategy file path, per-account plans, and the forecast',
      },
    ],
  }),

  defineRecipe({
    id: 'support_operations',
    name: 'Support Operations Crew',
    category: 'Customer',
    summary: 'Support ops crew: ticket analysis, knowledge base, workflow design, quality review, and ops leadership',
    placeholder: 'Describe the support situation to improve...\ne.g. Cut first-response time and deflect the top repetitive tickets with better docs',
    roles: [
      {
        key: 'ticket_analyst', title: 'Ticket Analyst', agent: 'Oskar Nilsen',
        caps: ['analysis'],
        mission: 'to find the patterns in the ticket load that everything else should target.',
        duties: [
          'Categorize the ticket data from the mission context: drivers, volumes, resolution times, and repeat themes.',
          'Identify the top deflectable categories and the tickets that signal product defects.',
          'Quantify the impact of each pattern so fixes can be prioritized.',
        ],
        handoffContents: 'the ticket taxonomy with volumes, the deflection candidates, and defect signals',
      },
      {
        key: 'knowledge_base_writer', title: 'Knowledge Base Writer', agent: 'Paula Costa',
        caps: ['writing'], files: true,
        artifact: 'each KB article saved as its own workspace file',
        mission: 'to write the articles that deflect the top repetitive tickets.',
        duties: [
          'Write a KB article per top deflectable category, in the customer’s vocabulary from real tickets.',
          'Structure for scanning: the fix first, then the explanation, then edge cases.',
          'Note where an article cannot fully deflect without a product change.',
        ],
        handoffContents: 'the article file paths mapped to ticket categories',
      },
      {
        key: 'workflow_designer', title: 'Workflow Designer', agent: 'Emre Yilmaz',
        caps: ['analysis', 'writing'],
        mission: 'to redesign triage and routing so tickets reach the right resolution fast.',
        duties: [
          'Design the triage flow: categorization, priority rules, routing, and escalation criteria.',
          'Specify macros/saved replies for the high-volume categories, linked to the new KB articles.',
          'Define SLAs per priority that the current team size can actually meet.',
        ],
        handoffContents: 'the triage/routing design, macro list, and SLA proposal',
      },
      {
        key: 'quality_reviewer', title: 'Quality Reviewer', agent: 'Lena Hoffman',
        caps: ['analysis'],
        mission: 'to define what good support looks like and how to check it.',
        duties: [
          'Define the QA rubric: accuracy, tone, completeness, and process adherence with scoring anchors.',
          'Apply the rubric to sample interactions from the mission context as calibration examples.',
          'Recommend the review cadence and sample size that is sustainable.',
        ],
        handoffContents: 'the QA rubric, calibrated examples, and the review cadence',
      },
      {
        key: 'support_ops_lead', title: 'Support Ops Lead', agent: 'Marcus Bell',
        caps: ['record_keeping', 'writing'], files: true,
        artifact: 'the support ops improvement plan saved to the workspace',
        mission: 'to consolidate the improvements into an owned, sequenced rollout plan.',
        duties: [
          'Consolidate the analysis, KB, workflow, and QA work into one rollout plan with owners and order.',
          'Define the metrics that prove each improvement worked (deflection rate, FRT, CSAT).',
          'Flag the product defects surfaced by ticket analysis for the engineering backlog.',
        ],
        handoff: 'Final support ops plan',
        handoffContents: 'the rollout plan file path, success metrics, and the defect escalation list',
      },
    ],
  }),

  // ══ Operations ═══════════════════════════════════════════════════════════════
  defineRecipe({
    id: 'operations_improvement',
    name: 'Operations Improvement Team',
    category: 'Operations',
    summary: 'Staged ops pass: process mapping, bottleneck analysis, SOPs, automation scouting, and rollout management',
    placeholder: 'Describe the process or operation to improve...\ne.g. Streamline our client onboarding from signed contract to kickoff, currently taking 3 weeks',
    strict: true,
    roles: [
      {
        key: 'process_mapper', title: 'Process Mapper', agent: 'Judith Weber',
        caps: ['analysis'],
        mission: 'to document how the process actually runs today — not how it is supposed to run.',
        duties: [
          'Map the as-is process from the mission context: steps, owners, tools, handoffs, and wait states.',
          'Capture timing per step where known; mark estimates clearly as estimates.',
          'Note where reality deviates from the official process and why.',
        ],
        handoff: 'Process map handoff',
        handoffContents: 'the as-is process map with timings, owners, and deviation notes',
      },
      {
        key: 'bottleneck_analyst', title: 'Bottleneck Analyst', agent: 'Hassan Jibril',
        caps: ['analysis'],
        mission: 'to find where the process actually loses time and quality.',
        duties: [
          'Analyze the map for constraints: longest waits, most rework, most manual toil, most variance.',
          'Rank bottlenecks by end-to-end impact — fixing a non-constraint changes nothing.',
          'Distinguish root constraints from symptoms with explicit reasoning.',
        ],
        handoff: 'Bottleneck analysis handoff',
        handoffContents: 'the ranked bottlenecks with impact reasoning and root-cause notes',
      },
      {
        key: 'sop_writer', title: 'SOP Writer', agent: 'Alena Horak',
        caps: ['writing'], files: true,
        artifact: 'each SOP saved as its own workspace file',
        mission: 'to write the standard operating procedures for the improved process.',
        duties: [
          'Write an SOP per improved process segment: trigger, steps, owner, tools, and done-criteria.',
          'Target the ranked bottlenecks — the SOP must remove the wait or rework, not just document it.',
          'Keep each SOP executable by a new hire without tribal knowledge.',
        ],
        handoff: 'SOP handoff',
        handoffContents: 'the SOP file paths and the bottleneck each one addresses',
      },
      {
        key: 'automation_scout', title: 'Automation Scout', agent: 'Casper Holm',
        caps: ['research', 'analysis'],
        mission: 'to find what in the improved process should be automated rather than proceduralized.',
        duties: [
          'Identify the SOP steps that are automatable: triggers, data movement, notifications, and approvals.',
          'Research concrete tool options with cited sources and realistic setup effort.',
          'Recommend build/buy/skip per candidate with cost-of-error taken into account.',
        ],
        handoff: 'Automation scouting handoff',
        handoffContents: 'the automation candidates with tool options, sources, and build/buy/skip calls',
      },
      {
        key: 'operations_pm', title: 'Operations PM', agent: 'Renata Silva',
        caps: ['record_keeping', 'writing'], files: true,
        artifact: 'the improvement rollout plan saved to the workspace',
        mission: 'to sequence the improvements into a rollout the team can absorb.',
        duties: [
          'Sequence SOPs and automations into rollout phases with owners and realistic dates.',
          'Define the before/after metrics that prove each phase worked.',
          'Plan the change management: who must be trained on what, and when.',
        ],
        handoff: 'Final rollout plan',
        handoffContents: 'the rollout plan file path, phase metrics, and the training plan',
      },
    ],
  }),

  defineRecipe({
    id: 'vendor_procurement',
    name: 'Vendor Procurement Team',
    category: 'Operations',
    summary: 'Staged procurement: requirements, vendor research, risk review, cost analysis, and recommendation',
    placeholder: 'Describe what you need to procure...\ne.g. Select a HIPAA-compliant e-signature vendor for client contracts under $500/month',
    strict: true,
    roles: [
      {
        key: 'requirements_analyst', title: 'Requirements Analyst', agent: 'Beatrice Lang',
        caps: ['analysis'],
        mission: 'to turn the procurement need into testable requirements before anyone shops.',
        duties: [
          'Define must-have vs nice-to-have requirements with the reasoning behind each.',
          'Specify constraints: budget, compliance, integration, timeline, and support expectations.',
          'Write the evaluation criteria and weights the downstream roles must score against.',
        ],
        handoff: 'Requirements handoff',
        handoffContents: 'the weighted requirements, constraints, and evaluation criteria',
      },
      {
        key: 'vendor_researcher', title: 'Vendor Researcher', agent: 'Filip Sorensen',
        caps: ['research'],
        mission: 'to build a sourced longlist and score it against the requirements.',
        duties: [
          'Research candidate vendors with cited sources: capabilities, pricing signals, and customer evidence.',
          'Score each candidate against the weighted criteria; mark unverifiable claims as unverified.',
          'Cut to a shortlist of 3-4 with explicit elimination reasons for the rest.',
        ],
        handoff: 'Vendor research handoff',
        handoffContents: 'the scored shortlist with sources and the elimination log',
      },
      {
        key: 'risk_reviewer', title: 'Risk Reviewer', agent: 'Agnes Varga',
        caps: ['analysis'],
        mission: 'to surface the risks that pricing pages hide.',
        duties: [
          'Assess each shortlisted vendor: lock-in, data ownership, compliance posture, viability, and exit cost.',
          'Check security/compliance evidence (certifications, breach history) with sources where public.',
          'Rate each vendor’s risk with the single biggest concern named.',
        ],
        handoff: 'Risk review handoff',
        handoffContents: 'the per-vendor risk assessment with sources and top concerns',
      },
      {
        key: 'cost_analyst', title: 'Cost Analyst', agent: 'Nikolai Petrov',
        caps: ['analysis'],
        mission: 'to compute what each option truly costs over its life, not its sticker price.',
        duties: [
          'Model total cost of ownership per shortlisted vendor: licenses, setup, integration, training, and exit.',
          'Normalize pricing tiers to the actual expected usage from the requirements.',
          'Show the 1-year and 3-year cost comparison with the assumptions stated.',
        ],
        handoff: 'Cost analysis handoff',
        handoffContents: 'the TCO comparison with assumptions and usage normalization',
      },
      {
        key: 'recommendation_writer', title: 'Recommendation Writer', agent: 'Ida Blom',
        caps: ['writing'], files: true,
        artifact: 'the procurement recommendation saved to the workspace',
        mission: 'to write the recommendation a decision maker can approve in one read.',
        duties: [
          'Lead with the recommended vendor and the three decisive factors.',
          'Summarize the scoring, risks, and costs per shortlisted option with the evidence trail.',
          'Include the negotiation levers and the conditions that would change the recommendation.',
        ],
        handoff: 'Final procurement recommendation',
        handoffContents: 'the complete recommendation and its file path',
      },
    ],
  }),

  defineRecipe({
    id: 'hiring_pipeline',
    name: 'Hiring Pipeline Crew',
    category: 'Operations',
    summary: 'Hiring crew: role design, sourcing strategy, interview architecture, candidate ops, and debrief leadership',
    placeholder: 'Describe the role to hire and the context...\ne.g. Design the hiring pipeline for our first senior consultant hire in the DACH region',
    roles: [
      {
        key: 'role_designer', title: 'Role Designer', agent: 'Sylvia Norris',
        caps: ['analysis', 'writing'],
        mission: 'to define the role sharply enough that everyone screens for the same person.',
        duties: [
          'Define the role’s outcomes for the first year — outcomes, not a task list.',
          'Derive the must-have competencies from those outcomes; cut nice-to-haves ruthlessly.',
          'Write the job description in candidate-facing language with honest selling points.',
        ],
        handoffContents: 'the outcome definition, competency list, and job description draft',
      },
      {
        key: 'sourcing_strategist', title: 'Sourcing Strategist', agent: 'Darius Grant',
        caps: ['research'],
        mission: 'to figure out where this person actually is and how to reach them.',
        duties: [
          'Research where candidates with these competencies gather: communities, companies, events — cite sources.',
          'Design the sourcing mix: outbound, referrals, postings, and the message per channel.',
          'Draft the outreach message that a strong, employed candidate would answer.',
        ],
        handoffContents: 'the sourcing channel plan with sources and the outreach drafts',
      },
      {
        key: 'interview_architect', title: 'Interview Architect', agent: 'Nadia Rahim',
        caps: ['writing'], files: true,
        artifact: 'the interview kit saved to the workspace',
        mission: 'to design interviews that measure the competencies instead of rewarding confidence.',
        duties: [
          'Design the stage sequence with what each stage measures and who runs it.',
          'Write structured questions and work-sample exercises per competency, with scoring anchors.',
          'Balance rigor against candidate time — every stage must earn its cost.',
        ],
        handoffContents: 'the interview kit file path with stages, questions, and scoring anchors',
      },
      {
        key: 'candidate_ops_coordinator', title: 'Candidate Ops Coordinator', agent: 'Leo Fitzgerald',
        caps: ['record_keeping', 'writing'],
        mission: 'to design a candidate process that is fast, fair, and communicative.',
        duties: [
          'Define the pipeline stages, SLAs per stage, and the communication template per touchpoint.',
          'Design the tracking: what gets recorded per candidate so the debrief has evidence.',
          'Plan the rejection communication — respectful and prompt at every stage.',
        ],
        handoffContents: 'the process design, SLAs, tracking spec, and communication templates',
      },
      {
        key: 'hiring_debrief_lead', title: 'Hiring Debrief Lead', agent: 'Vera Malinova',
        caps: ['analysis', 'writing'],
        mission: 'to design how decisions get made so the best evidence wins, not the loudest voice.',
        duties: [
          'Define the debrief protocol: independent scores first, then discussion, with the hiring bar explicit.',
          'Write the decision rubric that weighs competency evidence against the role outcomes.',
          'Define how disagreements resolve and what triggers an extra data point instead of a coin flip.',
        ],
        handoff: 'Final hiring process',
        handoffContents: 'the debrief protocol, decision rubric, and the assembled end-to-end pipeline summary',
      },
    ],
  }),

  defineRecipe({
    id: 'content_pipeline',
    name: 'Content Pipeline Crew',
    category: 'Marketing',
    summary: 'Content production line: brief, research, draft, edit, and publishing QA',
    placeholder: 'Describe the content to produce...\ne.g. Produce a definitive guide to EU MDR compliance timelines for device startups',
    roles: [
      {
        key: 'brief_strategist', title: 'Brief Strategist', agent: 'Iris Kalman',
        caps: ['analysis', 'writing'],
        mission: 'to define what this content must achieve before a word is drafted.',
        duties: [
          'Write the brief: audience, purpose, angle, key takeaway, desired action, and success measure.',
          'Define the scope boundaries — what this piece deliberately does NOT cover.',
          'List the questions the researcher must answer for the draft to be credible.',
        ],
        handoffContents: 'the content brief and the research question list',
      },
      {
        key: 'researcher', title: 'Researcher', agent: 'Tomas Vrba',
        caps: ['research'],
        mission: 'to gather the evidence the piece will stand on.',
        duties: [
          'Answer each brief question with sourced findings; cite the URL for every claim.',
          'Prefer primary sources and recent evidence; flag stale or conflicting information.',
          'Never treat a tool error as evidence that no sources exist — report access failures explicitly.',
        ],
        handoffContents: 'the sourced findings per question and verification gaps',
      },
      {
        key: 'draft_writer', title: 'Draft Writer', agent: 'Amelie Rousseau',
        caps: ['writing'], files: true,
        artifact: 'the draft saved to a workspace file',
        mission: 'to write a draft that delivers the brief’s takeaway on the research’s evidence.',
        duties: [
          'Write the draft to a file, structured around the brief’s angle and takeaway.',
          'Use only claims the research supports; keep the source next to each factual claim.',
          'Open strong and earn every section — cut anything that does not serve the takeaway.',
        ],
        handoffContents: 'the draft file path and the claims list with sources',
      },
      {
        key: 'editor', title: 'Editor', agent: 'Julian Frost',
        caps: ['writing', 'analysis'], files: true,
        mission: 'to make the draft tighter, clearer, and verifiably accurate.',
        duties: [
          'Edit the draft in place: structure, clarity, flow, and consistency with the brief.',
          'Verify every factual claim against the research handoff; caveat or cut unsupported ones.',
          'Check the piece delivers the takeaway to the intended audience.',
        ],
        handoffContents: 'the edited file path, the change summary, and claims cut or caveated',
      },
      {
        key: 'publishing_qa', title: 'Publishing QA', agent: 'Selma Aydin',
        caps: ['analysis', 'writing'],
        mission: 'to run the final gate before the content ships.',
        duties: [
          'Check the final piece against the brief’s success criteria one by one — PASS/FAIL each.',
          'Verify formatting, links, citations, and that the scope boundaries were respected.',
          'Give the ship/hold verdict with exactly what must change on a hold.',
        ],
        handoff: 'Final publishing verdict',
        handoffContents: 'the per-criterion PASS/FAIL, the verdict, and required fixes if held',
      },
      {
        key: 'media_producer', title: 'Media Producer', agent: 'Noor Haddad',
        caps: ['design'], files: true, media: true,
        mission: 'to produce the visuals and audio that ship with the piece.',
        duties: [
          'Generate supporting images (diagrams, cover art, illustrations) with generate_image using specific, well-crafted prompts.',
          'Produce a narrated audio version or voiceover with generate_speech when it serves the format.',
          'Name each file clearly; generated files are auto-saved to the run artifacts and posted to Discord.',
        ],
        handoff: 'Media handoff',
        handoffContents: 'the generated image/audio file names and their purpose',
      },
    ],
  }),

];

module.exports = { OPERATIONS_RECIPES };
