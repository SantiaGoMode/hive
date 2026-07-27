---
layout: guide
title: Trigger work with webhooks
description: Create a secured endpoint, map payload context, route event types to agents or pipelines, test deliveries, and inspect action runs.
permalink: /docs/guides/webhooks/
section: Workflow how-to
previous_url: /docs/guides/schedules/
previous_label: Schedule recurring work
next_url: /docs/guides/mcp-server/
next_label: Connect an MCP server
---

Webhooks let external systems submit events to Hive. Treat every payload as untrusted input.

## Prepare the target

Create and manually test the target agent or pipeline first. Its prompt should distinguish event data from operator instructions and should not perform consequential mutations solely because payload text requests them.

## Create the endpoint

1. Open **Webhooks → New Webhook**.
2. Enter Name and Description.
3. Enter a strong Secret Token or an `env:WEBHOOK_SECRET` reference.
4. Leave the endpoint disabled while configuring it.

An enabled webhook requires a secret.

## Map agent context fields

Under **Agent Context Fields**, add a Label and dot-path for each payload value the target needs:

| Label | Payload path | Event type |
|---|---|---|
| `repo` | `repository.full_name` | blank |
| `commit` | `commits.0.id` | `push` |
| `issue_title` | `issue.title` | `issues` |

Leave Event Type blank to apply a mapping to all events. With no mappings, Hive sends the full raw payload. Mapping a small envelope reduces noise and context use.

The projected envelope includes `_event_id`. An agent with Agent Management & Collaboration can call `get_webhook_event` to retrieve the full raw event only when needed.

## Add an automatic action

1. Select **Add action**.
2. Give it a Label.
3. Optionally filter by Event Type.
4. Choose Pipeline or Agent prompt.
5. Select the target.
6. Write the prompt using:
   - `{input}` for projected input;
   - `{context}` for structured context;
   - `{event_type}` for the detected type;
   - `{event_id}` for the stored delivery ID.
7. Keep the action enabled and save.

An action disabled in the editor is retained but will not run.

## Enable and test

1. Enable the webhook and save.
2. Copy the displayed endpoint.
3. Configure the external service with the endpoint and secret/signature.
4. Send a test event.
5. Open the webhook and inspect Events and Action Runs.
6. Confirm the detected type, projected fields, target, status, and final output.

Use ngrok only when an external service cannot reach localhost. A tunnel does not replace authentication, the webhook secret, rate limits, or careful target permissions.

## Diagnose failures

- **Rejected:** verify the secret/signature and that the endpoint is enabled.
- **Stored but no action:** check event-type spelling, action enabled state, and selected target.
- **Target lacks data:** correct dot-paths or let it fetch the raw event by `_event_id`.
- **Too much context:** add mappings instead of sending the full payload.
- **Queued:** inspect automation concurrency and active runs.
