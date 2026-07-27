---
layout: guide
title: Hive documentation
description: Install Hive, configure models, build a durable AI staff, run agents and Colony crews, automate work, and operate Hive safely.
permalink: /docs/
section: Start here
next_url: /docs/installation/
next_label: Installation
---

Hive is a local-first command center for AI work. You can begin with one agent, develop a reusable **Staff** directory, coordinate specialists in a **Colony**, and turn successful work into pipelines, schedules, or webhooks.

New to the product? Follow [Your first hour with Hive]({{ '/docs/guides/first-hour/' | relative_url }}) for an end-to-end tour.

## Choose a starting point

| I want to… | Start here |
|---|---|
| Install the desktop app or run from source | [Installation]({{ '/docs/installation/' | relative_url }}) |
| Connect Ollama or a cloud provider | [Models and providers]({{ '/docs/models-and-providers/' | relative_url }}) |
| Understand every environment setting | [Configuration]({{ '/docs/configuration/' | relative_url }}) |
| Build reusable specialists | [Staff]({{ '/docs/staff/' | relative_url }}) |
| Create and fully configure an agent | [Create and configure an agent]({{ '/docs/guides/first-agent/' | relative_url }}) |
| Understand every agent parameter | [Edit and tune an agent]({{ '/docs/guides/edit-agent/' | relative_url }}) |
| Run a coordinated multi-agent team | [Run your first Colony]({{ '/docs/guides/first-colony/' | relative_url }}) |
| Build a multi-step workflow | [Build and run a pipeline]({{ '/docs/guides/pipeline/' | relative_url }}) |
| Schedule or externally trigger work | [Schedules]({{ '/docs/guides/schedules/' | relative_url }}) or [webhooks]({{ '/docs/guides/webhooks/' | relative_url }}) |
| Fix a problem | [Troubleshooting]({{ '/docs/troubleshooting/' | relative_url }}) |

## Capability map

### People and execution

- **[Staff]({{ '/docs/staff/' | relative_url }})** — durable role profiles with personality, prompts, skills, tools, memory, model preferences, performance, and improvement suggestions.
- **[Agents and tools]({{ '/docs/agents-and-tools/' | relative_url }})** — individual runtime workers for chat and tasks.
- **[Colony missions]({{ '/docs/colony-missions/' | relative_url }})** — recipe-driven teams with a shared blackboard, explicit handoffs, and evidence.
- **[Pipelines and automation]({{ '/docs/pipelines-and-automation/' | relative_url }})** — repeatable multi-step execution, schedules, retries, and run history.

### Models, tools, and connections

- **[Models and providers]({{ '/docs/models-and-providers/' | relative_url }})** — local Ollama, Anthropic, OpenAI, Gemini, and LiteLLM.
- **[Skills and MCP]({{ '/docs/skills-and-mcp/' | relative_url }})** — reusable operating guidance, built-in tool groups, and external MCP servers.
- **[Integrations and webhooks]({{ '/docs/integrations-and-webhooks/' | relative_url }})** — inbound automation, GitHub access, tunnels, and delivery security.
- **[Discord bridge]({{ '/docs/discord-bridge/' | relative_url }})** — route Discord conversations to Staff personas.

## Operating Hive

Hive stores its state locally under `~/.hive` by default. Read [Security and architecture]({{ '/docs/security-and-architecture/' | relative_url }}) before enabling sandbox network access or remote exposure, and keep [Backups and recovery]({{ '/docs/backups-and-recovery/' | relative_url }}) close when upgrading.

## Hands-on guide library

### Agents

- [Create and configure an agent]({{ '/docs/guides/first-agent/' | relative_url }})
- [Edit, tune, import, and export agents]({{ '/docs/guides/edit-agent/' | relative_url }})
- [Write effective agent instructions]({{ '/docs/guides/agent-prompts/' | relative_url }})
- [Configure tools, skills, and memory]({{ '/docs/guides/agent-tools-memory/' | relative_url }})
- [Work with chat and sessions]({{ '/docs/guides/chat-sessions/' | relative_url }})

### Teams and workflows

- [Build and develop a Staff member]({{ '/docs/guides/staff-workflow/' | relative_url }})
- [Run your first Colony]({{ '/docs/guides/first-colony/' | relative_url }})
- [Build and run a pipeline]({{ '/docs/guides/pipeline/' | relative_url }})
- [Schedule recurring work]({{ '/docs/guides/schedules/' | relative_url }})
- [Trigger work with webhooks]({{ '/docs/guides/webhooks/' | relative_url }})
- [Connect and assign an MCP server]({{ '/docs/guides/mcp-server/' | relative_url }})
- [Operate automation safely]({{ '/docs/guides/automation/' | relative_url }})
