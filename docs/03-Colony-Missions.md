# 03 - Colony Missions

Colony Missions allow you to orchestrate multiple agents to execute a complex task sequentially. It replaces a free-form orchestrator with a highly structured, recipe-driven pipeline.

---

## 1. Recipes and Roles

A Colony is instantiated from a **Recipe**. The default recipe is the `development_team`. 
The `development_team` recipe consists of highly tuned prompts and specific tool configurations for 6 roles:

1. **Business Analyst (BA)**: Converts goals into clear requirements and acceptance criteria. (Tools: `memory`, `github`).
2. **Project Manager (PM)**: Breaks requirements into tasks, updates Jira/GitHub boards, maintains `CHANGELOG.md`. Has file-writing access but *cannot execute shell commands*.
3. **UI/UX Designer**: Writes component specifications to `docs/design/`. 
4. **Software Developer**: Modifies code and *must* verify changes using `shell`. Explicitly instructed not to fabricate execution results.
5. **QA Engineer**: Validates against acceptance criteria using `shell` (running tests) and utilizes the `report_acceptance` tool to officially mark criteria as PASS/FAIL.
6. **DevOps Engineer**: Handles Docker, CI/CD, and deployment scripting.

---

## 1b. The Recipe Catalog

Beyond `development_team`, Hive ships a catalog of presets (defined in `server/lib/recipeCatalog.js`) grouped by category. All of them appear dynamically in the colony/team UI, seed staff profiles automatically, and are model-planned per role. Recipes marked **strict** run an enforced handoff chain (each role must hand off to the next in order; the run cannot complete until the chain is done). The rest are **lightweight**: the operator plans mission-specific steps and delegates by expertise.

**Engineering**
- `code_review` *(strict)* — Review Lead → Implementation Reviewer → Test Reviewer → Security Reviewer → Review Synthesizer.
- `incident_response` *(strict)* — Incident Commander → Evidence Collector → Root Cause Analyst → Fix Engineer → Verification Lead → Comms Scribe.
- `docs_release` *(strict)* — Documentation Planner → Technical Writer → Changelog Curator → QA Editor → Publisher.
- `security_review` *(strict)* — Threat Modeler → AppSec Reviewer → Dependency Auditor → Remediation Engineer → Security Signoff.
- `refactor_migration` *(strict)* — Architect → Migration Planner → Refactor Engineer → Regression QA → Release Coordinator.

**Research**
- `research_brief` — Researcher, Source Critic, Synthesizer (founding recipe).
- `data_analysis` — Data Analyst, Data Engineer, Statistician, Visualization Designer, Insight Synthesizer.

**Business Strategy**
- `product_discovery` — Market Researcher, Customer Researcher, Product Strategist, UX Prototyper, Opportunity Synthesizer.
- `business_strategy` — Market Analyst, Competitive Analyst, Financial Modeler, Strategy Synthesizer, Executive Brief Writer.
- `partnerships` — Partner Researcher, Strategic Fit Analyst, Deal Structurer, Risk Reviewer, Outreach Drafter.

**Marketing**
- `go_to_market_launch` *(strict)* — Market Analyst → Positioning Strategist → Campaign Planner → Sales Enablement Lead → Launch PM → Metrics Analyst.
- `marketing_campaign` *(strict)* — Audience Researcher → Messaging Strategist → Channel Planner → Content Producer → Performance Analyst.
- `content_marketing` — Editorial Strategist, SEO Researcher, Draft Writer, Editor, Distribution Planner.
- `content_pipeline` — Brief Strategist, Researcher, Draft Writer, Editor, Publishing QA.

**Sales**
- `sales_enablement` *(strict)* — Buyer Researcher → Pitch Strategist → Objection Handler → Collateral Writer → Sales Coach.
- `revenue_operations` *(strict)* — Funnel Analyst → CRM Ops Specialist → Sales Process Designer → Forecast Analyst → RevOps Synthesizer.

**Customer**
- `customer_success` *(strict)* — Account Researcher → Health Score Analyst → Playbook Designer → Escalation Coordinator → Renewal Strategist.
- `support_operations` — Ticket Analyst, Knowledge Base Writer, Workflow Designer, Quality Reviewer, Support Ops Lead.

**Operations**
- `operations_improvement` *(strict)* — Process Mapper → Bottleneck Analyst → SOP Writer → Automation Scout → Operations PM.
- `vendor_procurement` *(strict)* — Requirements Analyst → Vendor Researcher → Risk Reviewer → Cost Analyst → Recommendation Writer.
- `hiring_pipeline` — Role Designer, Sourcing Strategist, Interview Architect, Candidate Ops Coordinator, Hiring Debrief Lead.

Every role carries internal metadata (`capabilities`, `repo_access`, `network`, MCP categories, artifact expectations) that decides its model tier, whether the colony repo is mounted read-only or writable into its sandbox, whether it gets network egress, which MCP servers attach, and whether coding guidelines are injected. Business roles produce practical artifacts — briefs, campaign plans, SOPs, enablement kits, forecasts, playbooks, and executive summaries — without being treated as software engineers.

---

## 2. The Orchestration Protocol

When a Colony mission is launched with a user goal:

1. **Planning Phase**: The Orchestrator agent reads the goal and the recipe, then writes out a rigid plan of execution.
2. **Delegation Phase**: The Orchestrator uses the `ask_agent` tool to call the first agent in the sequence (e.g., the BA). 
3. **Execution Phase**: The BA does its work (researching, writing to the blackboard), then issues a "Handoff" response.
4. **Verification Phase**: The Orchestrator reviews the handoff. If the BA missed something, the Orchestrator will reject the handoff and push the BA to fix it. If acceptable, it moves to the next role (e.g., PM).

---

## 3. The Blackboard (`SHARED.md`)

Because agents operate in separate conversational contexts, they cannot see each other's chat histories. 

To solve this, Hive provides the Blackboard.
- Physically located at `~/.hive/shared/SHARED.md`.
- All agents in a Colony have the `read_shared` and `write_shared` tools.
- Agents use this to leave technical specs, requirements, and notes for the downstream roles.

> [!TIP]
> A common failure mode for multi-agent systems is hallucinating requirements. The Hive `development_team` prompts specifically instruct agents to write tangible artifacts (to `SHARED.md` or actual repository files) rather than just claiming the work is "done."
