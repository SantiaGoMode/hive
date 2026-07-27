---
layout: guide
title: Staff
description: Build a durable directory of AI specialists with roles, personality, tools, skills, memory, model preferences, and performance history.
permalink: /docs/staff/
section: Capabilities
previous_url: /docs/configuration/
previous_label: Configuration
next_url: /docs/agents-and-tools/
next_label: Agents and tools
---

Staff is Hive’s durable people layer. An **agent** is a runtime worker; a **Staff profile** is the reusable identity and operating configuration that can shape agents and fill roles across Colony missions.

## What a Staff profile contains

- display name and professional role
- personality and system prompt
- preferred model
- skills and tool groups
- persistent memory
- avatar color and linked agent
- interactions, run history, metrics, and scorecards
- improvement suggestions derived from real work

Hive seeds Staff profiles from every built-in Colony recipe role. You can also create custom specialists for your own organization.

## Create a custom Staff member

1. Open **Staff** and choose **New staff member**.
2. Give the profile a clear name and role.
3. Write the personality as behavioral guidance: communication style, decision posture, and how the specialist handles uncertainty.
4. Write a system prompt with responsibilities, boundaries, expected evidence, and completion criteria.
5. Choose a model preference.
6. Add the smallest set of tools and skills needed for the role.
7. Save the profile, then create or synchronize its durable agent.

The profile editor is divided into **Prompt & Personality**, **Skills & Tools**, **Memory**, **Suggestions**, **Performance**, and **History**.

## Recipe-backed Staff

Preset profiles stay synchronized with their recipe role defaults until you customize their prompt or tools. Once customized, Hive preserves those values rather than overwriting your work. You can explicitly reset them to current recipe defaults.

A recipe may require tools that are essential to the role. Hive combines those role tools with profile tools when building the effective configuration, so a customized profile cannot silently remove required capability.

Preset recipe profiles cannot be deleted. Custom profiles can.

## Staff in Colony

When a Colony starts, Hive’s operator selects the best available profile for each role using recipe and role fit, skills, memory, and prior handoff record. The selected profile can contribute:

- name, role, and visual identity
- personality and system prompt
- skills manifest and permitted tools
- persistent memory
- preferred model, unless the launch model plan overrides it

This lets the same specialist improve across missions while the recipe continues to enforce the team’s process and required capabilities.

## Memory and improvement

Use profile memory for durable lessons, working preferences, domain context, and decisions that should survive individual conversations. Do not store API keys or other credentials in memory.

Hive can generate suggestions from tool errors, workaround reports, blackboard blockers, user comments, and rejected or invalid handoffs. Review each suggestion before applying it; suggestions are evidence for improvement, not automatic authority to broaden a role.

## Performance and history

Performance views combine metrics, detailed scorecards, interactions, and mission history. Use them to answer practical questions:

- Does this specialist complete its assigned role?
- Are handoffs accepted or repeatedly rejected?
- Which tools fail or cause workarounds?
- Does the model preference fit the job?
- What prompt or skill change would address a repeated failure?

Staff is where Hive turns one-off agent configurations into an accountable, reusable organization.
