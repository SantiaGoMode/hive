---
layout: guide
title: Create your first agent
description: Build, test, and refine one useful agent with a model, prompt, tools, and memory.
permalink: /docs/guides/first-agent/
section: How-to guide
previous_url: /docs/security-and-architecture/
previous_label: Security and architecture
next_url: /docs/guides/first-colony/
next_label: Run your first Colony
---

This guide creates a focused agent before adding multi-agent coordination.

## 1. Confirm a model

Open **Models** and verify that one Ollama or cloud model responds. See [Models and providers]({{ '/docs/models-and-providers/' | relative_url }}) if none are ready.

## 2. Define the job

Choose a task with a visible outcome, such as summarizing a local document, reviewing a change, or turning meeting notes into actions. Write down:

- the inputs it may use
- the output format
- what it must not change
- the evidence that proves completion

## 3. Create the agent

Open **Agents**, create an agent, and set:

- a descriptive name and role
- the selected model
- a concise system prompt
- only the tool groups needed for the job

A useful prompt states responsibility, boundaries, workflow, and completion criteria. Avoid asking the prompt to simulate tools the agent does not have.

## 4. Test in chat

Start with a harmless example. Watch streamed tool calls and inspect the result. If the result is weak, change one variable at a time:

1. clarify the expected output
2. add missing context
3. remove unnecessary tools
4. try a more suitable model

## 5. Add durable memory

Ask the agent to save stable preferences or lessons that should apply next time. Do not save credentials or temporary task details. Review its memory periodically.

## 6. Promote reusable work to Staff

If the agent represents an ongoing organizational role, create or update a [Staff profile]({{ '/docs/staff/' | relative_url }}). Staff adds personality, skills, performance history, suggestions, and reuse in Colony missions.
