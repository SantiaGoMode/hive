# 04 - Pipelines and Automation

This chapter explains how to chain agents together and trigger them without manual intervention.

---

## 1. Pipelines

Pipelines are static, deterministic graphs of agent executions. Unlike Colonies (which use an LLM orchestrator to dynamically plan steps), Pipelines always execute the exact steps you define.

### Execution Modes
- **Sequential**: Step 2 waits for Step 1 to finish. The raw string output of Step 1 is automatically injected into the prompt of Step 2.
- **Parallel**: Step 2 and Step 3 run at the same time. This is useful for fan-out tasks (e.g., asking three different models to review the same codebase simultaneously).

### Data Flow
When a pipeline runs, the system tracks the `final_output` of each step. 
If Step A feeds into Step B, Step B's prompt evaluates with the `{input}` variable replaced by Step A's output. 

---

## 2. Schedules (Cron)

Schedules allow you to run an agent automatically on a timer.

- **Storage**: Schedules are stored in the SQLite database and loaded into memory on boot by `server/lib/scheduler.js`.
- **Syntax**: Uses standard 5-field cron syntax (e.g., `*/15 * * * *` for every 15 minutes).
- **Natural Language Parsing**: The UI provides a natural language to cron parser, but underneath, it always saves standard cron strings.
- **Concurrency Prevention**: If a cron fires (e.g., every 1 minute) but the agent's previous run is still executing, the scheduler will *skip* the new tick to prevent duplicate cascading runs.

---

## 3. Webhooks

Webhooks allow external systems (GitHub, Zapier, custom scripts) to trigger agents or pipelines in Hive.

### The Webhook Schema
When configuring a webhook action, you specify a prompt template that can include `{input}` (the raw JSON payload) and `{context}` (projected specific variables).

**Example Github Issue Payload:**
```json
{
  "action": "opened",
  "issue": {
    "title": "Fix the login bug",
    "body": "Users cannot log in when using Safari."
  }
}
```

**Context Projection (`webhookProjection.js`)**:
Hive attempts to flatten and extract the most relevant data into a `context` object to save tokens.
In the prompt template for your webhook action, you can write:
`Please review this new issue: {input}`

### Security & Rate Limiting
- **Signatures**: Hive validates incoming webhooks using constant-time string comparisons against the generated secret.
- **Runaway Cost Protection**: The environment variable `HIVE_MAX_TRIGGERED_COLONY_RUNS` (default 2) caps the number of concurrent Colony missions that can be triggered by a webhook flurry, preventing a misconfigured GitHub action from draining your API credits.
