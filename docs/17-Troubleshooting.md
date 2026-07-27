---
layout: guide
title: Troubleshooting
description: Diagnose common installation, model, sandbox, provider, webhook, Discord, and database problems.
permalink: /docs/troubleshooting/
section: Help
previous_url: /docs/backups-and-recovery/
previous_label: Backups and recovery
next_url: /docs/faq/
next_label: FAQ
---

Start with the failing surface’s visible status, then check **Settings → Advanced → Maintenance actions** for diagnostics. Avoid changing several settings at once.

## Hive will not open or the UI cannot authenticate

- Confirm no other Hive process already owns the configured port.
- If running from source, open the URL printed by the server.
- Verify `HIVE_AUTH_TOKEN` matches the token used by the browser.
- Check the token saved under `HIVE_HOME` on first boot.
- If you changed `HIVE_BIND_HOST` or origins, restore localhost defaults and retry.

## Ollama is unreachable

1. Run `ollama serve`.
2. Confirm `http://127.0.0.1:11434` responds.
3. Open **Models → Local** and retry the connection.
4. Pull a model if the service is reachable but none are installed.

Hive’s setup readiness check requires Ollama to be reachable; it does not require a model to have been pulled already.

## A cloud provider returns 401 or no models

- Confirm the correct provider key is present.
- Remember that environment values override stored settings.
- Check the model prefix (`anthropic/`, `openai/`, `gemini/`, or `gateway/`).
- For LiteLLM, verify both `LLM_GATEWAY_URL` and `LLM_GATEWAY_KEY`.
- Restart Hive after changing launch environment variables.

## A sandbox tool cannot reach the internet

This is the secure default. `HIVE_SANDBOX_NETWORK=none` blocks container egress. Set it to `bridge` only if that agent’s task requires network access, then restart Hive. Network access does not grant credentials or write permissions by itself.

## Docker or an MCP server is unavailable

- Start Docker and re-run the setup check.
- Confirm `npx` or `uvx` exists for stdio MCP packages that require it.
- Test the MCP server independently.
- Verify environment references resolve in the Hive process.
- Assign the MCP tool to the actual Staff profile or agent running the task.

## A webhook is rejected or does not run

- Confirm the webhook is enabled.
- Verify its secret or signature.
- Do not put secrets in the query string.
- Check delivery rate limits and automation concurrency.
- Inspect run history for a queued, rejected, or failed target.

## Discord is connected but ignores messages

Complete owner setup and bind the channel or conversation to a Staff profile. Confirm `DISCORD_BOT_TOKEN`, owner IDs, and bindings, then retry in a permitted channel. See the [Discord guide]({{ '/docs/discord-bridge/' | relative_url }}).

## Linux AppImage reports `libfuse.so.2`

Use the native `.deb` package on Debian or Ubuntu. It avoids the AppImage FUSE 2 runtime dependency.

## An older version refuses the database

The database was migrated by a newer build. Reinstall the newer build or follow [Backups and recovery]({{ '/docs/backups-and-recovery/' | relative_url }}) to restore a schema-compatible backup.

## Still stuck

Generate a redacted support report and open a [GitHub issue](https://github.com/SantiaGoMode/hive/issues) with the Hive version, OS and architecture, exact steps, expected result, actual result, and timestamps.
