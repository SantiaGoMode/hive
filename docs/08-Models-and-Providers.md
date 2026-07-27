---
layout: guide
title: Models and providers
description: Configure local Ollama models, cloud providers, and an optional LiteLLM gateway.
permalink: /docs/models-and-providers/
section: Start here
previous_url: /docs/getting-started/
previous_label: Getting started
next_url: /docs/configuration/
next_label: Configuration
---

Hive can run fully offline with Ollama, use provider APIs directly, or route model traffic through LiteLLM. Each agent and Staff profile can prefer a different model.

## Local models with Ollama

1. Install [Ollama](https://ollama.com).
2. Start it with `ollama serve`.
3. In Hive, open **Models → Local**.
4. Pull a model, wait for the progress indicator, and run the connection check.
5. Select the model when creating an agent or editing a Staff profile.

The default Ollama endpoint is `http://127.0.0.1:11434`. An unprefixed model ID is treated as an Ollama model. The setup check only requires a reachable Ollama service; you can pull a model afterward.

## Direct cloud providers

Configure provider keys in **Models** or at launch:

| Provider | Environment variable | Model prefix |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/` |
| OpenAI | `OPENAI_API_KEY` | `openai/` |
| Gemini | `GEMINI_API_KEY` | `gemini/` |

Environment values take precedence over database values. Hive masks stored credentials in the UI and logs. Use an `env:VARIABLE_NAME` reference when you want configuration to name a secret without storing its value.

## LiteLLM gateway

The optional gateway centralizes provider keys, routing, failover, and spend controls. Set:

```bash
LLM_GATEWAY_URL=http://127.0.0.1:4000
LLM_GATEWAY_KEY=your-revocable-key
```

Gateway model aliases use the `gateway/` prefix, such as `gateway/hive-smart` or `gateway/hive-coding`. Keep the gateway bound to localhost unless you deliberately secure a remote deployment.

## Choosing models

- Use a small local model for classification, formatting, and frequent scheduled work.
- Use a strong reasoning or coding model for Colony roles that make consequential decisions.
- Set a Staff model preference for the normal default; a Colony launch model plan can override it for that run.
- Test tool calling before assigning a model to an agent that depends on MCP or sandbox tools.

If a provider fails, see [Troubleshooting]({{ '/docs/troubleshooting/' | relative_url }}).
