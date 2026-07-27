---
layout: guide
title: Skills and MCP
description: Give agents reusable operating knowledge and connect built-in or external tools with explicit scope.
permalink: /docs/skills-and-mcp/
section: Capabilities
previous_url: /docs/pipelines-and-automation/
previous_label: Pipelines and automation
next_url: /docs/integrations-and-webhooks/
next_label: Integrations and webhooks
---

Hive separates **skills**—reusable instructions and operating knowledge—from **tools**, which can act on files, services, and other agents.

## Built-in tool groups

| Group | Typical capabilities |
|---|---|
| `agent_tools` | Create, update, and ask agents |
| `memory` | Save durable agent memory |
| `sandbox` | Shell, Python, file I/O, and managed servers |
| `web_search` | Search and retrieve public web information |
| `colony_tools` | Coordinate Colony work and handoffs |
| `media` | Host-side local image and speech generation |

Grant only what a role needs. Tool availability is part of a Staff profile or agent configuration and remains distinct from model selection.

## Skills

A skill gives an agent a repeatable method, domain vocabulary, constraints, and supporting resources. Attach skills when the same instructions would otherwise be copied into many prompts. Keep the system prompt focused on role and policy; put detailed procedures in skills.

Good skills are:

- narrow enough to trigger for a recognizable task
- explicit about prerequisites, inputs, and completion evidence
- careful about mutations and external side effects
- backed by examples or scripts when consistency matters

## MCP servers

Model Context Protocol servers expose external tools. Hive supports:

- **stdio servers**, launched as child processes
- **HTTP servers**, reached at a configured endpoint

Common integrations include filesystem, git, GitHub, search, databases, and messaging systems.

### Configure safely

1. Add the MCP server and choose stdio or HTTP.
2. Define its command or endpoint.
3. Use environment references for secrets rather than literal credential values.
4. Test the connection.
5. Assign the server only to the Staff profiles or agents that need it.
6. Run a harmless read operation before granting mutation authority.

`npx` or `uvx` must be available when a configured stdio server depends on them. A Docker sandbox has no network access by default, so networked tools may require `HIVE_SANDBOX_NETWORK=bridge`. Read the [security guide]({{ '/docs/security-and-architecture/' | relative_url }}) before enabling it.

## Media tools

Image and speech generation run host-side rather than inside the agent sandbox. Configure the local media model settings in Hive, then grant the `media` tool group. Agents should call `generate_image` or `generate_speech` directly; they should not install model runtimes inside sandbox containers.
