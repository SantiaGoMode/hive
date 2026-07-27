---
layout: guide
title: Frequently asked questions
description: Quick answers about privacy, Staff, agents, Colony, models, tools, platforms, data, and recovery.
permalink: /docs/faq/
section: Help
previous_url: /docs/troubleshooting/
previous_label: Troubleshooting
---

## Can Hive run without a cloud account?

Yes. Run Ollama locally and choose local models. Cloud providers and LiteLLM are optional.

## Where does Hive store data?

Under `~/.hive` by default, or the directory set by `HIVE_HOME`. The SQLite database defaults to `~/.hive/hive.db`.

## What is the difference between Staff and agents?

A Staff profile is a durable specialist identity: role, personality, prompt, skills, tools, memory, model preference, and performance history. An agent is a runtime worker you chat with or execute. A Staff profile can create or synchronize an agent and can be selected for Colony roles.

## What is the difference between Colony and a pipeline?

A Colony coordinates role-based specialists through a recipe, shared blackboard, and explicit handoffs. A pipeline passes outputs through a predetermined sequence or parallel graph. Use Colony when judgment and role ownership matter; use a pipeline when the processing path is repeatable.

## Can I create custom Staff members?

Yes. Custom profiles can represent any ongoing role. Recipe-backed preset profiles are seeded automatically and cannot be deleted, but their prompts and tools can be customized or reset.

## Can different Staff members use different models?

Yes. Each profile can have a preferred model. A Colony launch model plan may override that preference for a specific run.

## Does Hive support OpenAI, Anthropic, and Gemini?

Yes, using your own API keys. Hive also supports Ollama and an optional LiteLLM gateway.

## Does Hive support MCP?

Yes. Connect stdio or HTTP MCP servers and assign them explicitly to agents or Staff profiles.

## Do sandboxed agents have internet access?

Not by default. Docker sandbox networking defaults to `none`. Set `HIVE_SANDBOX_NETWORK=bridge` only when required and after reviewing the security implications.

## Can I access Hive remotely?

Hive binds to `127.0.0.1` by default. Remote exposure is possible but requires deliberate network configuration, TLS, strict origins, authentication, and a trusted reverse proxy. A tunnel does not replace those controls.

## Are Windows installers available?

Not currently. macOS and Linux artifacts are published. Windows packaging can be built locally but public installers wait on signing.

## How are secrets stored?

Hive can store masked provider settings locally or resolve `env:NAME` references at runtime. For stronger isolation, keep provider keys in a LiteLLM gateway.

## How do I back up Hive?

Hive creates protected online SQLite backups under `~/.hive/backups` every 24 hours and retains seven by default. See [Backups and recovery]({{ '/docs/backups-and-recovery/' | relative_url }}).

## How do I report a problem without leaking private data?

Download the redacted report from **Settings → Advanced → Maintenance actions**. It omits prompts, stored rows, paths, URLs, headers, and credentials.
