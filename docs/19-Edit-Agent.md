---
layout: guide
title: Edit, tune, import, and export agents
description: Change an existing agent safely, diagnose weak behavior, manage its sandbox, transfer configurations, and understand deletion.
permalink: /docs/guides/edit-agent/
section: Agent how-to
previous_url: /docs/guides/first-agent/
previous_label: Create and configure an agent
next_url: /docs/guides/agent-prompts/
next_label: Write effective instructions
---

Agent settings become defaults for future chats, pipeline steps, schedules, and webhook actions that use that agent. Tune one dimension at a time so you can tell which edit changed the result.

## Open the editor

On **Agents**, find the card and select the pencil icon. You can also edit the current agent from its Chat page.

## A safe tuning loop

1. Save a representative input and the current output.
2. Identify one failure: format, accuracy, verbosity, creativity, missing tool, or insufficient context.
3. Change the smallest relevant setting.
4. Select **Save Changes**.
5. Start a fresh chat and run the same input.
6. Compare results before making another change.

Existing conversation messages remain in their sessions. A new system prompt applies on subsequent model calls; starting a fresh chat gives the cleanest comparison.

## Which setting should you change?

| Symptom | First change | Avoid |
|---|---|---|
| Output format varies | Add a concrete completion format to System Prompt | Raising context |
| Agent invents current facts | Enable Web Search and require sources | Raising temperature |
| Code is inconsistent | Lower temperature and add acceptance criteria | Adding unrelated tools |
| Response is cut off | Raise Max Tokens | Raising temperature |
| Agent loses early context | Raise Context Window; shorten memory/history | Treating Max Tokens as input capacity |
| Agent ignores a procedure | Assign the relevant skill or shorten the prompt | Repeating the same text in prompt and memory |
| Tool is unavailable | Enable its tool group or MCP server | Telling the model to pretend it used it |
| Small model becomes confused | Reduce prompt, memory, tools, and upstream payload | Only lowering `num_ctx` |
| Cloud spending must stop | Set a gateway budget | Assuming a prompt is a spending control |

## Edit identity without changing behavior

Name, Role, and Avatar Color are presentation and selection fields. Renaming an agent does not rewrite its system prompt. If the prompt identifies the agent by an old name or role, update it separately.

## Change models

Switching Model changes future calls but preserves prompt, tools, memory, and conversations. Re-test tool calling: models differ in tool-use reliability and supported context.

If you enable **Show reasoning**, unsupported models simply ignore it. A pipeline can override the model for one step without changing the agent default.

## Edit memory directly

Open **Memory** to review the exact durable text injected into calls. Use **Reload from disk** before editing if another run may have saved memory. **Clear memory** permanently removes the file after confirmation.

When memory grows:

1. remove task-specific history;
2. consolidate duplicate preferences;
3. keep conclusions and discard the transcript that produced them;
4. re-test with a fresh chat.

## Manage the sandbox

For an agent with Sandbox enabled:

1. Open **Tools → Advanced tool access** and check Docker status.
2. Start the container if needed.
3. Open the **Sandbox** tab.
4. Refresh the file tree, select a text file, edit it, and save.
5. Use exposed localhost port links when an agent has started a server.

**Reset Sandbox** deletes all files in that agent’s sandbox workspace. Export anything important first.

## Export an agent

Select the download icon on an agent card. Hive exports an `.agent.json` file containing:

- name and role
- model
- avatar color
- temperature, output limit, and context window
- system prompt
- tool selection

Memory, chat sessions, workspace files, gateway keys, and Staff history are not included.

## Import an agent

1. Open **Agents → Import**.
2. Select an `.agent.json` file.
3. Hive creates a new agent using the file’s configuration.
4. Edit it and verify the model and tools exist on this Hive installation.
5. Run a harmless test.

Import uses the same creation path as the editor. Unknown fields are ignored and invalid parameter values are rejected.

## Delete an agent

The trash action deletes the agent record and, for Hive-managed workspaces, its workspace files. Before deletion:

- export the configuration;
- copy required sandbox artifacts;
- preserve important memory elsewhere;
- remove or replace references in pipelines, schedules, webhooks, and Staff.

Deletion is not an archive operation.
