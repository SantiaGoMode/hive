---
layout: guide
title: Automate a workflow
description: Choose the right automation shape, prepare an idempotent target, test failure cases, bound authority, and operate unattended runs.
permalink: /docs/guides/automation/
section: How-to guide
previous_url: /docs/guides/mcp-server/
previous_label: Connect an MCP server
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

Use the dedicated walkthroughs for [pipelines]({{ '/docs/guides/pipeline/' | relative_url }}), [schedules]({{ '/docs/guides/schedules/' | relative_url }}), and [webhooks]({{ '/docs/guides/webhooks/' | relative_url }}).

## Define the input contract

Write down:

- required fields;
- optional fields and defaults;
- maximum expected size;
- how untrusted text is delimited;
- exact output format;
- retry safety; and
- which failures require a person.

For a webhook, project only the fields the target needs. For a pipeline, state whether each step consumes `{input}`, `{prev}`, or both.

## Build and test the target

For a pipeline, add steps in execution order. Use sequential steps when later work depends on earlier output; use parallel steps only when the work is genuinely independent. Confirm the final output shape and retry behavior.

Run it manually with:

- normal input
- missing or malformed input
- a model or tool failure
- the largest expected payload

Also run the same request twice. If the second execution creates a duplicate issue, file, message, or release, the target is not safe for unattended retry.

## Add the trigger

For a schedule, select a preset or cron expression and confirm the host timezone. For a webhook, generate a dedicated secret and send a signed test delivery. See [Integrations and webhooks]({{ '/docs/integrations-and-webhooks/' | relative_url }}) for exposure guidance.

## Bound unattended authority

- Grant the target only necessary tools.
- Do not put credentials in prompts or webhook payloads.
- Require a human gate before consequential publishing, deletion, or spending.
- Keep sandbox networking off unless the target needs it.
- Set concurrency to match host capacity.

Use a gateway budget for cloud agents when a hard spend ceiling matters. A model prompt is not an enforcement mechanism.

## Operate it

Use run history to inspect status, duration, last output, and errors. Repeated retries are a signal to fix the target or input contract, not simply raise retry limits. Disable an automation before changing its target substantially, test manually, then re-enable it.

## Failure policy

Classify failure handling before enabling:

| Failure | Response |
|---|---|
| Temporary provider or network error | Retry within the bounded attempt limit |
| Invalid input | Record and stop; do not retry unchanged |
| Missing permission | Require operator action |
| Partial external mutation | Inspect destination before retry |
| Model produced an uncertain result | Route to human review |
| Repeated tool failure | Disable and repair the target |

## Operational review

Periodically inspect:

- enabled automations and whether each is still needed;
- recent failure and retry rate;
- queue depth and concurrency saturation;
- cloud spend;
- tool and credential scope;
- webhook event retention; and
- whether prompts still match the target’s current configuration.
