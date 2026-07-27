---
layout: guide
title: Your first hour with Hive
description: A guided product tour from first launch through models, Staff, an agent chat, a Colony team, a pipeline, and safe automation.
permalink: /docs/guides/first-hour/
section: Start here
previous_url: /docs/configuration/
previous_label: Configuration
next_url: /docs/guides/first-agent/
next_label: Create and configure an agent
---

This walkthrough is the fastest way to understand how Hive’s parts fit together. Complete it with disposable example work before connecting production systems.

## 0–10 minutes: finish setup

1. Launch Hive and complete the environment checks.
2. Open **Models**.
3. For local use, connect Ollama and pull a model that fits your available memory.
4. For cloud use, configure one provider key and verify its live model list.
5. Open **Settings** and confirm the Hive home, authentication, Docker, Git, and GitHub status you intend to use.

Expected result: at least one model is selectable in an agent editor.

## 10–20 minutes: meet Staff and create an agent

1. Open **Staff** and inspect a recipe-seeded profile.
2. Review its role, prompt, skills, tools, memory, suggestions, performance, and history tabs.
3. Open **Agents → New Agent → Staff profile**.
4. Select that profile and create its agent.
5. Open the agent’s editor and review the inherited runtime settings.

Expected result: the Staff profile has an assigned agent, and the agent card shows a model.

## 20–30 minutes: chat and refine

1. Select **Chat** on the agent card.
2. Give it a small, verifiable request.
3. Start a second session for a different topic.
4. Ask it to remember one harmless preference.
5. Edit the agent, open **Memory**, and confirm the saved text.
6. Update one prompt instruction and retry the original request in a fresh session.

Expected result: you can distinguish conversation history, durable memory, and the system prompt.

## 30–40 minutes: build a pipeline

1. Create a second agent with a different responsibility.
2. Open **Pipelines → New Pipeline**.
3. Add a first step using `{input}`.
4. Add a second step using `{prev}`.
5. Review Input Flow Preview.
6. Save and run the pipeline manually.

Expected result: the second agent receives the first agent’s output and produces a final result.

## 40–50 minutes: found a Colony team

1. Open **Colony** and choose a small recipe.
2. Found a team with a durable name.
3. Review the proposed crew and their Staff profiles.
4. Add a narrowly scoped work item.
5. Launch and watch blackboard updates and handoffs.

Expected result: you can see the difference between a predetermined pipeline and a role-driven Colony mission.

## 50–60 minutes: automate safely

1. Open **Schedules**.
2. Create a disabled schedule targeting the tested agent or pipeline.
3. Write the same prompt that already worked manually.
4. Run it once manually and inspect history.
5. Decide whether to enable it.

Do not expose a webhook or enable a consequential schedule during the tour.

## Where to go next

| Goal | Guide |
|---|---|
| Understand all agent settings | [Create and configure an agent]({{ '/docs/guides/first-agent/' | relative_url }}) |
| Improve agent behavior | [Edit and tune an agent]({{ '/docs/guides/edit-agent/' | relative_url }}) |
| Build organizational specialists | [Build a Staff member]({{ '/docs/guides/staff-workflow/' | relative_url }}) |
| Compose deterministic work | [Build a pipeline]({{ '/docs/guides/pipeline/' | relative_url }}) |
| Coordinate a team | [Run a Colony]({{ '/docs/guides/first-colony/' | relative_url }}) |
| Connect external tools | [Connect MCP]({{ '/docs/guides/mcp-server/' | relative_url }}) |
