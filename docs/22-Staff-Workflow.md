---
layout: guide
title: Build and develop a Staff member
description: Create a custom specialist, configure each profile tab, synchronize an agent, use the profile in Colony, and review improvement evidence.
permalink: /docs/guides/staff-workflow/
section: Team how-to
previous_url: /docs/guides/agent-tools-memory/
previous_label: Tools, skills, and memory
next_url: /docs/guides/first-colony/
next_label: Run your first Colony
---

Use Staff for specialists that should retain identity, operating knowledge, and performance history across assignments.

## Create the profile

1. Open **Staff**.
2. Select **New staff member**.
3. Enter a display name and role.
4. Save, then open the profile.

## Configure each tab

### Prompt & Personality

Personality describes communication and decision style. System Prompt defines responsibility, procedure, boundaries, and completion. Keep them complementary rather than duplicating the same prose.

### Skills & Tools

Assign permanent skills and the minimum tool groups for the role. Recipe-backed roles may add required role tools when used in a Colony; profile customization cannot remove those recipe requirements.

### Memory

Store durable role knowledge: organizational conventions, accepted lessons, and working preferences. Do not copy individual mission transcripts into profile memory.

### Suggestions

Review suggestions generated from tool errors, workarounds, blockers, comments, and rejected handoffs. For each suggestion:

1. open the supporting evidence;
2. decide whether the issue is prompt, model, skill, tool, or mission-specific;
3. apply only changes that belong to the durable role;
4. dismiss irrelevant or one-off suggestions;
5. verify the change on a later assignment.

### Performance and History

Use metrics, scorecards, interactions, and runs to find repeated patterns. A single difficult mission is not enough evidence for broadening tools or rewriting the role.

## Set a model preference

Choose the normal model for this specialist. When creating its agent, leave Model blank to inherit this preference. A per-agent override or Colony launch model plan can supersede it for a specific runtime.

## Create or synchronize the agent

From Staff, create the assigned agent; or open **Agents → New Agent → Staff profile** and select the profile. Repeating the action for a profile with an assigned agent synchronizes that agent rather than creating an unrelated worker.

## Use custom Staff in Colony

Choose a recipe whose role fits the profile. At launch, Hive considers role and recipe fit, skills, memory, and handoff history. Review the proposed crew before starting.

Preset recipe profiles track recipe prompt and tool defaults until customized. After customization, Hive preserves the user-owned values. Use the reset controls when you intentionally want the latest recipe defaults again.

## Verify

A Staff member is ready when its profile tabs contain intentional values, its assigned agent works in chat, it can be selected for an appropriate Colony role, and its performance history records subsequent work.
