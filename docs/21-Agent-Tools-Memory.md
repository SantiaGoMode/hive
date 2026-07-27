---
layout: guide
title: Configure agent tools, skills, and memory
description: Grant capabilities deliberately, choose assigned versus on-demand skills, and maintain useful long-term memory.
permalink: /docs/guides/agent-tools-memory/
section: Agent how-to
previous_url: /docs/guides/agent-prompts/
previous_label: Write effective instructions
next_url: /docs/guides/chat-sessions/
next_label: Chat and sessions
---

Models decide what to say. Tools determine what an agent can do. Skills provide reusable instructions. Memory carries selected knowledge across sessions.

## Grant a tool

1. Edit the agent.
2. Open **Tools**.
3. Enable a routine tool or expand **Advanced tool access**.
4. For MCP, select only a connected server and review its exposed tool names.
5. Save.
6. In chat, ask for a harmless operation that requires the tool.
7. Inspect the tool call and result.

If you later set a pipeline-step or schedule tool override, that explicit list replaces the agent’s normal tools for that run.

## Choose assigned skills versus Skill Loader

- **Assigned skill:** injected every time in chat, pipelines, and schedules. Use for core role procedure.
- **Skill Loader tool:** lets the agent discover and load instructions mid-conversation. Use for occasional specialist work.

Too many assigned skills consume context and can introduce conflicting procedures.

## Establish memory

Enable **Persistent Memory**, save the agent, then either:

- tell the agent what to remember and let it call `save_memory`; or
- edit **Agent → Memory** directly.

The memory tool replaces the current `MEMORY.md`, so an agent saving memory must include everything it intends to retain.

Good memory:

```markdown
## Operator preferences
- Use concise status updates.
- Never publish without explicit approval.

## Project conventions
- User-facing changes require a desktop and mobile check.
```

Poor memory includes API keys, full transcripts, one-time payloads, speculative facts, or copied reference manuals.

## Audit context pressure

If an agent becomes slow or confused, review:

1. system prompt length;
2. number of assigned skills;
3. memory length;
4. enabled tool and MCP schemas;
5. chat history;
6. pipeline `{prev}` output or webhook payload size.

Reduce the source of unnecessary context before increasing the model window.
