---
layout: guide
title: Create and configure an agent
description: A complete walkthrough of agent creation modes, every editor tab, model parameters, tools, skills, memory, sandbox access, and testing.
permalink: /docs/guides/first-agent/
section: Agent how-to
previous_url: /docs/security-and-architecture/
previous_label: Security and architecture
next_url: /docs/guides/edit-agent/
next_label: Edit and tune an agent
---

This guide takes you from an empty Agents page to a tested agent whose behavior you understand. It covers the controls in Hive’s **New Agent** editor, not just the minimum fields needed to save.

## Before you begin

You need at least one usable model. Open **Models** and confirm that a local Ollama model or configured cloud model is available. If the Agents page shows the first-run screen, follow its model setup action first.

Decide whether you are creating:

- a **durable organizational specialist**, which should start from a Staff profile; or
- an **independent runtime worker**, which can be configured manually.

See [Staff versus agents]({{ '/docs/staff/' | relative_url }}) if the distinction is unclear.

## Path A: Create an agent from Staff

1. Open **Agents**.
2. Select **New Agent**.
3. Leave **Staff profile** selected.
4. Choose a profile. The preview shows its role key and default model.
5. In **Runtime model settings**, leave Model blank to inherit the Staff preference or select an override for this agent.
6. Adjust temperature, reasoning, output limit, context window, or gateway budget if this runtime needs different settings.
7. Select **Create from staff**.

Identity, prompt, tools, skills, and memory remain managed through Staff. If the profile already has an assigned agent, Hive synchronizes it instead of creating an unrelated duplicate.

## Path B: Create an agent manually

Select **Manual** in the New Agent dialog. The editor has six tabs: **Identity**, **Model**, **System Prompt**, **Tools**, **Memory**, and **Advanced**. A **Sandbox** tab appears after saving an agent with Sandbox enabled.

### 1. Identity

| Field | What it controls | Guidance |
|---|---|---|
| Name | Card name, chat identity, searches, and pipeline selectors | Use a job-oriented name such as `Release Notes Editor` |
| Role | Professional label shown on the agent card | Describe responsibility, not personality |
| Avatar color | Visual distinction in the interface | Has no effect on behavior |

Select **Use Template** to begin from Researcher, Coder, Writer, Analyst, or Secretary defaults. A template fills the description, color, tools, temperature, output limit, context window, and system prompt. It does not prevent later edits.

### 2. Model

Choose a configured model. Bare model names are local Ollama models; cloud and gateway models use prefixes such as `anthropic/`, `openai/`, `gemini/`, and `gateway/`.

| Parameter | Default | Meaning | When to change it |
|---|---:|---|---|
| Temperature | `0.7` | Sampling variability from `0` to `2` | Lower for extraction/code; raise for ideation and prose |
| Show reasoning | Off | Streams reasoning for models that expose the capability | Enable only for a compatible model |
| Max Tokens (`num_predict`) | `4096` | Maximum generated output per response | Raise for long code or reports; lower for short routine work |
| Context Window (`num_ctx`) | `8192` | Model runtime context capacity | Raise for long prompts, memory, history, or large tool results |
| Gateway budget | None | Hard USD cap through a dedicated LiteLLM key | Use for cloud-cost containment |

Open **Advanced model settings** to edit output, context, and budget.

Important behavior:

- Max Tokens limits output, not input.
- Hive ensures Ollama context is large enough to accommodate the requested output plus input headroom.
- Context Window is runtime capacity, not an automatic summarizer. Hive does not pre-trim the system prompt, memory, history, or tool results simply because you lower it.
- Changing a gateway budget causes Hive to mint a new per-agent gateway key on the next use.

Suggested starting points:

| Workload | Temperature | Max Tokens | Context |
|---|---:|---:|---:|
| Classification or structured extraction | `0.1–0.3` | `1024–2048` | `8192` |
| Coding and review | `0.2–0.4` | `4096–8192` | `16384+` |
| Research synthesis | `0.4–0.7` | `4096` | `16384+` |
| Creative writing | `0.8–1.0` | `4096` | `8192+` |

These are starting points, not provider guarantees.

### 3. System Prompt

The system prompt is saved as the agent’s operating identity and injected at the start of every conversation and background run.

Use four parts:

```text
Role
You are a release-notes editor responsible for user-facing change summaries.

Method
Read repository history and linked issues. Group changes as Added, Changed, and Fixed.

Boundaries
Do not invent changes. Do not publish or modify the repository.

Completion
Return Markdown plus a short list of sources used.
```

Keep durable task policy here. Put one-time inputs in chat or the run prompt. Put reusable detailed procedures in an assigned skill. See [Write effective agent instructions]({{ '/docs/guides/agent-prompts/' | relative_url }}).

### 4. Tools

Routine tool groups are shown first:

| Tool | Grants | Use it when |
|---|---|---|
| Agent Management & Collaboration | Create/edit/delegate to agents; manage pipelines and schedules; read shared state | The agent coordinates other workers or automations |
| Persistent Memory | Read and replace `MEMORY.md` | Preferences or lessons should survive sessions |
| Web Search | Ollama web search and fetch | Current public information is required |

Open **Advanced tool access** for Sandbox, Media Generation, Skill Loader, and connected MCP servers.

- **Sandbox** grants isolated shell, Python, and file operations in Docker.
- **Media Generation** grants host-side image and speech tools.
- **Skill Loader** lets the agent browse and load catalog skills during a conversation.
- **MCP servers** expose the tools reported by each connected server.

Permissions are additive at the agent level. Grant the smallest useful set; every enabled tool adds schemas and instructions to model context.

### 5. Skills

Expand **Skills** and select catalog entries whose instructions should be injected into this agent in chat, pipelines, and schedules. Use assigned skills for procedures the agent should always know. Use Skill Loader instead when the agent should load specialist guidance only on demand.

After saving, reopen the editor and verify that the selected skills remain assigned.

### 6. Memory

A new agent must be saved before its Memory tab becomes editable. After creation:

1. Edit the agent.
2. Open **Memory**.
3. Add stable preferences, domain facts, or durable lessons.
4. Select **Save memory**.

Memory is stored in the agent workspace as `MEMORY.md` and injected into every conversation. Keep it concise. Do not store credentials, transient task input, or whole source documents.

### 7. Advanced

The Advanced tab displays a read-only JSON preview of the core configuration. Use it to review name, model, temperature, prompt, and tools before saving. It is not a text editor.

## Save and test

1. Select **Create Agent**.
2. On the new card, select **Chat**.
3. Give the agent a small representative task.
4. Confirm it follows the requested format.
5. If tools are enabled, ask for an operation that proves the intended tool works.
6. Start a new conversation and confirm durable instructions still apply.

Do not test a powerful agent first with a consequential mutation. Start with a read-only or disposable task.

## Verify the result

Your agent is ready when:

- its card shows the intended role and model;
- a representative task produces the expected format;
- required tools appear and can perform a harmless operation;
- forbidden actions are declined or require clarification;
- saved memory survives a new session; and
- the editor reopens with the expected configuration.

Next, learn how to [edit and tune the agent]({{ '/docs/guides/edit-agent/' | relative_url }}) without losing track of what changed.
