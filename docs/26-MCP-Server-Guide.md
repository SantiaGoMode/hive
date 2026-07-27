---
layout: guide
title: Connect and assign an MCP server
description: Add a preset or custom stdio/HTTP server, configure environment references, test it, and grant its tools to an agent.
permalink: /docs/guides/mcp-server/
section: Integration how-to
previous_url: /docs/guides/webhooks/
previous_label: Trigger work with webhooks
next_url: /docs/guides/automation/
next_label: Operate automation safely
---

MCP servers expose external tools. Connection and permission are separate: saving a server does not grant it to every agent.

## Add a preset

1. Open **Skills & Tools** or the MCP section in Settings.
2. Select **Add MCP Server**.
3. Filter the preset gallery and select a server.
4. Replace every `<PLACEHOLDER>` in Args.
5. Fill required environment variables.
6. Mark credentials as secret and prefer `env:NAME` references.
7. Select **Test**.
8. Review the discovered tools and save.

Package-based stdio presets may require `npx` or `uvx` on the host.

## Add a custom server

Choose **Custom setup**:

- **stdio:** enter Name, Command, Args, and environment values.
- **HTTP:** enter Name, URL, and required environment/auth configuration.

Arguments are split on whitespace. Avoid embedding secrets in command arguments or URLs.

## Assign it to an agent

1. Edit the agent.
2. Open **Tools → Advanced tool access → MCP Servers**.
3. Confirm the server has a green connected indicator.
4. Review the tool names and enable the server.
5. Save.
6. Ask the agent to perform a harmless read.

The stored tool ID uses `mcp:<server-id>`. Pipeline step and schedule overrides must explicitly include it if they replace the agent’s normal tools.

## Troubleshoot

- **Command not found:** install or expose the required launcher to the Hive process.
- **Placeholder error:** replace every angle-bracket placeholder.
- **Disconnected:** edit and retest the server.
- **Credential failure:** verify the environment variable exists in the Hive launch environment.
- **Tool absent in chat:** assign the MCP server to the actual agent and save.
- **Network failure in a sandbox:** MCP runs and sandbox networking are different boundaries; review where the server executes before changing `HIVE_SANDBOX_NETWORK`.
