---
layout: guide
title: Run your first Colony
description: Found a persistent team, configure its crew and repository, queue work, launch a mission, supervise handoffs, steer it, and verify completion.
permalink: /docs/guides/first-colony/
section: How-to guide
previous_url: /docs/guides/staff-workflow/
previous_label: Build a Staff member
next_url: /docs/guides/pipeline/
next_label: Build and run a pipeline
---

A Colony is a persistent team with its own crew, repository, memory, and work queue. A mission is one execution by that team. Use Colony when work benefits from role ownership, evidence, review, and controlled handoffs.

## Before you begin

- Connect or create the Staff profiles that should fill the roles.
- Confirm every required model is available.
- For repository work, have a local repository path and the intended GitHub access ready.
- Decide the exact outcome and acceptance criteria.

## 1. Pick a recipe

Open **Colony** and review the recipe cards. Choose the closest operating process, not merely the recipe with the most roles. Recipes define role keys, required tools, handoff expectations, and quality gates. Hive seeds corresponding Staff profiles automatically.

## 2. Found the team

1. Select the recipe.
2. Enter a durable team name.
3. Link the repository when the work requires one.
4. Complete founding.

The team persists after a mission ends. Use one team for a continuing stream of related work rather than creating a new team for every task.

## 3. Review the crew

Inspect which [Staff profiles]({{ '/docs/staff/' | relative_url }}) will fill the roles. Confirm their model preferences, tools, and skills. Customize a profile when the role needs durable organizational context; customize the launch when the change applies only to this mission.

Check:

- every role has a suitable profile;
- required tool groups are present;
- coding roles can access the intended repository;
- cloud roles have budgets when needed; and
- the chosen models can call the required tools.

## 4. Add a work item

Use the team’s work queue to capture the direction before launching. A queue item lets the team retain pending work when another mission is running. Give the item a short title and a complete direction.

## 5. Write an executable direction

Include:

- the desired outcome
- relevant repository, files, or source material
- constraints and prohibited changes
- acceptance criteria
- required validation or artifacts

Vague goals create ambiguous handoffs. A good direction lets the final reviewer distinguish “done” from “plausible.”

Example:

```text
Outcome: Add CSV export to the existing audit-log screen.
Scope: client audit-log components and their existing API only.
Constraints: preserve filtering; do not add a dependency.
Acceptance: exported rows match the visible filter, headers are stable, tests pass,
and the reviewer records browser evidence at desktop and mobile widths.
```

## 6. Choose the launch model plan

The launch plan may use Staff model preferences or override models for roles in this run. Use overrides when a mission needs a stronger coding or review model without permanently changing the specialist.

## 7. Launch and supervise

Choose a model plan and launch. Follow:

- the shared blackboard for current facts and decisions
- the handoff ledger for ownership changes
- live logs for tools and inter-agent messages
- human gates for decisions that require your authority

If a role is blocked, add precise context to the mission rather than silently widening its permissions.

### Steer a live run

Use mission comments or the available steering control to clarify requirements, answer a blocker, or correct scope. Do not replace the mission direction with a contradictory goal midway through execution; queue separate work instead.

### Understand handoffs

A handoff should name the completed artifact, evidence, remaining risks, and next owner. Rejected handoffs are useful signals: inspect the rejection reason instead of repeatedly retrying unchanged work.

### Stop or retry

Stop a run when it is acting outside scope or waiting on unavailable authority. A retry can repeat external work, so verify whether the prior attempt already changed files, issues, releases, or messages.

## 8. Verify completion

Review the final artifact and evidence against the original acceptance criteria. A completed run records what happened; it does not guarantee that every claim is correct. Re-run focused validation when the mission touches code, releases, external messages, or security-sensitive settings.

Afterward, review Staff suggestions and scorecards for repeated errors, rejected handoffs, or model mismatch.

## 9. Maintain team memory

Store only durable team knowledge: repository conventions, stable decisions, known hazards, and lessons that should affect future missions. Mission-specific progress belongs in the run and blackboard, not permanent team memory.

## Completion checklist

- Work item status matches the real outcome.
- Required handoffs were accepted.
- Artifacts exist at the reported locations.
- Tests or other acceptance checks were independently verified.
- External mutations are confirmed in their destination system.
- Useful durable lessons were promoted to Staff or team memory.
- Remaining work is queued explicitly.
