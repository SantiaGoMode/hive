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
