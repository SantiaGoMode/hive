---
layout: guide
title: Integrations and webhooks
description: Connect GitHub and external services, expose secure inbound triggers, and understand delivery controls.
permalink: /docs/integrations-and-webhooks/
section: Capabilities
previous_url: /docs/skills-and-mcp/
previous_label: Skills and MCP
next_url: /docs/discord-bridge/
next_label: Discord bridge
---

Hive integrates through MCP, GitHub credentials, inbound webhooks, Discord, and optional tunnels. External automation is powerful because it can run unattended; keep its authority narrow.

## GitHub

Hive resolves a GitHub token from:

1. the stored Hive integration setting
2. `GITHUB_TOKEN`
3. `GITHUB_PERSONAL_ACCESS_TOKEN`
4. `GH_TOKEN`
5. the active `gh auth token`

Use the least-privileged credential that supports the intended repository. An unattended run does not automatically inherit repository write authority merely because it can reach the network.

## Inbound webhooks

A webhook can start an agent task or pipeline. To create one:

1. Open **Automation** and create a webhook.
2. Select the target agent or pipeline.
3. Generate and store a secret.
4. Configure the external service to call the displayed endpoint.
5. Send a test delivery and inspect the recorded run.

Enabled webhooks require their own secret and are protected by a bounded delivery rate limiter. Put credentials in headers or signatures, never in query parameters. Hive retains only allowlisted delivery metadata rather than indiscriminately persisting inbound headers.

Keep prompts defensive: webhook content is untrusted input, not operator instruction. A target agent should validate fields and avoid interpreting payload text as permission to mutate unrelated systems.

## Tunnels and remote callbacks

`NGROK_AUTHTOKEN` enables the optional ngrok integration. A tunnel makes a local endpoint reachable from the internet; it does not replace Hive authentication, webhook secrets, TLS validation, or origin controls. Disable the tunnel when it is no longer needed.

## Operational limits

Webhook runs share bounded automation concurrency. Configure `HIVE_MAX_CONCURRENT_AUTOMATION_RUNS`, `HIVE_WEBHOOK_RATE_LIMIT`, and `HIVE_WEBHOOK_RATE_WINDOW_MS` for your host capacity and expected delivery volume.

For chat integration, continue to the [Discord bridge]({{ '/docs/discord-bridge/' | relative_url }}).
