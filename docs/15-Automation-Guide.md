---
layout: guide
title: Automate a workflow
description: Turn a proven task into a pipeline, schedule, or webhook with bounded unattended execution.
permalink: /docs/guides/automation/
section: How-to guide
previous_url: /docs/guides/first-colony/
previous_label: Run your first Colony
next_url: /docs/backups-and-recovery/
next_label: Backups and recovery
---

Automate only after the underlying agent task works reliably with representative input.

## Choose the trigger

| Need | Use |
|---|---|
| Run at a fixed time | Schedule |
| Run when an external system sends an event | Webhook |
| Pass work through several agents | Pipeline |
| Run one recurring task | Scheduled agent |

## Build and test the target

For a pipeline, add steps in execution order. Use sequential steps when later work depends on earlier output; use parallel steps only when the work is genuinely independent. Confirm the final output shape and retry behavior.

Run it manually with:

- normal input
- missing or malformed input
- a model or tool failure
- the largest expected payload

## Add the trigger

For a schedule, select a preset or cron expression and confirm the host timezone. For a webhook, generate a dedicated secret and send a signed test delivery. See [Integrations and webhooks]({{ '/docs/integrations-and-webhooks/' | relative_url }}) for exposure guidance.

## Bound unattended authority

- Grant the target only necessary tools.
- Do not put credentials in prompts or webhook payloads.
- Require a human gate before consequential publishing, deletion, or spending.
- Keep sandbox networking off unless the target needs it.
- Set concurrency to match host capacity.

## Operate it

Use run history to inspect status, duration, last output, and errors. Repeated retries are a signal to fix the target or input contract, not simply raise retry limits. Disable an automation before changing its target substantially, test manually, then re-enable it.
