---
layout: guide
title: Schedule recurring work
description: Schedule an agent, pipeline, or Colony team; configure cron and tool overrides; test, monitor, pause, and retry runs.
permalink: /docs/guides/schedules/
section: Workflow how-to
previous_url: /docs/guides/pipeline/
previous_label: Build and run a pipeline
next_url: /docs/guides/webhooks/
next_label: Trigger work with webhooks
---

Create a schedule only after its target succeeds manually with the same prompt.

## Create a schedule

1. Open **Schedules → New Schedule**.
2. Enter a Label that identifies the outcome, such as `Morning support digest`.
3. Choose exactly one target:
   - **Agent** for one prompt;
   - **Pipeline** for a multi-step flow;
   - **Colony team** for a new recurring mission.
4. Select a preset schedule or **Custom**.
5. Write the Prompt.
6. Leave **Enabled** on only when you are ready for unattended execution.
7. Save.

For a pipeline, Prompt becomes the original pipeline input. For a Colony team, each fire starts a mission or queues it when the team is busy and posts to the team’s Discord thread.

## Cron format

Custom cron uses:

```text
minute hour day-of-month month day-of-week
```

Examples:

| Expression | Meaning |
|---|---|
| `0 8 * * *` | Every day at 08:00 |
| `0 9 * * 1` | Monday at 09:00 |
| `*/15 * * * *` | Every 15 minutes |
| `0 */6 * * *` | Every six hours |

Schedules use the Hive host’s local timezone. Confirm the host timezone before relying on business-hour timing.

## Agent tool overrides

Under **Advanced schedule options**, an agent schedule can set explicit tool overrides. These replace the agent’s normal configured tools for that scheduled run.

Pipeline schedules use each step’s tool configuration. Colony schedules use recipe crew tools. Neither accepts a schedule-level override.

## Test and operate

1. Save initially with Enabled off.
2. Use the manual run control.
3. Inspect the run output and errors.
4. Enable only after the manual result is correct.
5. Watch historical runs, last output, and failure state.

Pause a schedule before changing its target or prompt substantially. A retry reruns work; ensure the action is safe to repeat.
