---
layout: guide
title: Work with chat and sessions
description: Start focused conversations, use attachments and tools, search history, manage context, and know when to begin a new session.
permalink: /docs/guides/chat-sessions/
section: Agent how-to
previous_url: /docs/guides/agent-tools-memory/
previous_label: Tools, skills, and memory
next_url: /docs/guides/staff-workflow/
next_label: Build a Staff member
---

Chat is the interactive execution surface for an agent. A session contains conversation history; agent memory is separate and persists across sessions.

## Start a focused session

1. Open **Agents** and select **Chat**.
2. Start a new session for one outcome.
3. Put the goal, relevant context, constraints, and expected format in the first message.
4. Attach text or images only when the selected model supports the needed input.
5. Watch streamed tool calls and results.

## Give actionable input

```text
Goal: Turn the attached notes into an implementation plan.
Constraints: Do not modify files. Preserve every acceptance criterion.
Output: Scope, assumptions, numbered steps, tests, and open questions.
```

Follow-up messages should correct or add context, not silently redefine the goal.

## Use tools deliberately

If the agent should search, run code, inspect files, or delegate, say what evidence you expect from that tool. A tool call can fail; read the result rather than assuming the action occurred.

## Start a new session when

- the topic or desired outcome changes;
- you changed the system prompt, model, or core tools and want a clean test;
- conversation history is large or contains obsolete assumptions;
- you are comparing two configurations; or
- the agent keeps anchoring on an earlier mistake.

Starting a new session does not clear agent memory.

## Search history

On **Agents**, switch search to **History** and search conversation content. Selecting a result opens the matching agent and session. Normal agent search instead matches agent name, description, or model.

## Control context

Chat calls can include system prompt, assigned skills, agent memory, shared guidance, tool and MCP schemas, tool results, and message history. For smaller models:

- use shorter sessions;
- keep memory curated;
- disable unused tools;
- attach only relevant material;
- summarize decisions before moving to a new session.

## Capture durable learning

At the end of useful work, decide where the lesson belongs:

- only this session: leave it in history;
- future work by this agent: save concise memory;
- every specialist in a role: update Staff;
- repeatable procedure: create or update a skill;
- workflow input/output sequence: build a pipeline.
