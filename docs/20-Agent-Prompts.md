---
layout: guide
title: Write effective agent instructions
description: Structure system prompts, decide what belongs in prompts versus memory or skills, and tune instructions for small and large models.
permalink: /docs/guides/agent-prompts/
section: Agent how-to
previous_url: /docs/guides/edit-agent/
previous_label: Edit and tune an agent
next_url: /docs/guides/agent-tools-memory/
next_label: Tools, skills, and memory
---

The system prompt should define stable operating behavior. It should not become a storage bin for every task, reference document, and past conversation.

## Use a five-part prompt

```text
ROLE
You are a customer-support triage specialist.

GOAL
Classify each report, identify missing reproduction information, and propose the next owner.

WORKFLOW
1. Extract the observed and expected behavior.
2. Check whether reproduction steps are complete.
3. Assign severity using the definitions below.
4. Return the required format.

BOUNDARIES
Do not promise a fix date. Do not modify tickets. Mark uncertainty explicitly.

OUTPUT
Return: Summary, Severity, Missing Information, Suggested Owner, and Draft Reply.
```

Add domain definitions or examples only when they materially change decisions.

## Put information in the right place

| Information | Location |
|---|---|
| Stable role, policy, boundaries, completion rules | System Prompt |
| Reusable detailed operating procedure | Assigned Skill |
| Optional specialist procedure loaded only when needed | Skill Loader |
| Durable preferences and learned facts | Memory |
| Current task, files, payload, and deadline | Chat or run input |
| Facts shared across agents | Shared blackboard or Colony memory |

## Make tool use explicit

Enabling a tool makes it available; the prompt should explain when it must be used.

```text
For current facts, use web search before answering and cite the pages used.
Use the sandbox only for calculations and disposable files.
Never publish, delete, or message externally without explicit operator approval.
```

Do not instruct the agent to use a tool that is not enabled.

## Write for verifiability

Weak:

```text
Do a thorough analysis.
```

Stronger:

```text
List the evidence reviewed, separate observed facts from inference, identify unresolved risks,
and finish with a pass/fail decision against each acceptance criterion.
```

## Tune for smaller models

Small models perform better when you:

- keep the role narrow;
- use short numbered steps;
- request one output format;
- enable fewer tools;
- keep memory concise;
- pass distilled webhook fields instead of full payloads;
- avoid asking one agent to plan, research, code, review, and publish.

Context Window does not trim content for you. System prompt, skills, full agent memory, chat history, tool schemas, and tool results all compete for capacity.

## Test the prompt

Create a small evaluation set:

1. a normal request;
2. an ambiguous request;
3. a request outside the role;
4. a request requiring a tool;
5. a request that tries to override a boundary.

Record failures, make one edit, and repeat the same set. Promote stable, detailed procedures into a skill instead of continuously enlarging the system prompt.
