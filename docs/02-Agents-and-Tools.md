# 02 - Agents and Tools

This chapter details how Agents function internally, the specifics of the Docker Sandbox, and the exact constraints of the built-in toolset.

---

## 1. Agent Anatomy

An Agent in Hive is defined by a portable JSON structure (often saved as `.agent.json` on export).

```json
{
  "id": "dev_agent_01",
  "name": "Software Developer",
  "model": "anthropic/claude-3-5-sonnet-latest",
  "system_prompt": "You are a senior software developer...",
  "tools": ["sandbox", "memory", "github"],
  "mcp_servers": ["local_fs_mcp"]
}
```

### Models
Model IDs are prefixed by their provider:
- `anthropic/...`
- `openai/...`
- `gemini/...`
- `gateway/...` (Routes through LiteLLM)
- Unprefixed names (e.g., `llama3.1:8b`) are assumed to be local Ollama models.

---

## 2. The Docker Sandbox

When an agent needs to execute code (via `shell` or `run_python`), Hive spins up an ephemeral Docker container. 

> [!WARNING]
> By default, `HIVE_SANDBOX_NETWORK=none`. This means `npm install`, `pip install`, and `curl` will hang or fail because the container has no internet access. To enable network access for package installations, set `HIVE_SANDBOX_NETWORK=bridge`.

**Sandbox Specs:**
- **Working Directory:** `/workspace` (Mounted to your target project folder).
- **Installed Runtimes:** Node.js 20, Python 3.
- **Security:** Containers run with `--cap-drop=ALL` and `no-new-privileges`. No system services (like PostgreSQL or Redis) are running inside the sandbox.

---

## 3. Core Tool Groups

Hive groups tools together. You assign a group to an agent to grant access to all tools within it.

### `sandbox` Tools
Used for coding, testing, and file manipulation.

- **`shell(command, timeout_seconds)`**: Executes bash commands. Output is capped at 8000 characters. Default timeout is 60s, max is 600s. 
  - *Note:* Interactive commands are strictly prohibited. The command `npm audit fix --force` is hard-blocked at the system level to prevent accidental dependency tree destruction.
- **`run_python(code, filename)`**: Executes arbitrary Python code. 
- **`write_file(path, content)`**: Writes to `/workspace`.
- **`read_file(path, lines)`**: Reads files. Crucial for agents to inspect existing code before modifying.
- **`start_server(command, port)`**: Specifically designed to handle long-running processes (like `npm run dev`) which would otherwise trigger a `shell` timeout. It boots the server in the background and returns control.

### `memory` Tools
- **`save_memory(fact)`**: Appends a specific string to the agent's `MEMORY.md` file in `~/.hive/agents/{id}/MEMORY.md`. The contents of this file are automatically injected into the agent's system prompt at the start of every session.

### `web_search` Tools
- **`web_search(query)`**: Requires an Ollama sign-in. Returns search results.
- **`web_fetch(url)`**: Scrapes the text content of a given URL.

---

## 4. MCP (Model Context Protocol)

Hive natively supports the Model Context Protocol (MCP), allowing you to attach external tool servers to your agents.

### Adding an MCP Server
1. Go to **Settings -> MCP Servers**.
2. Define the transport (stdio or HTTP).
3. **Command/Args**: e.g., `npx`, `-y`, `@modelcontextprotocol/server-filesystem`, `/path/to/expose`.
4. **Environment Variables**: You can pass `env:MY_SECRET` to safely resolve secrets from the host Node.js process environment rather than storing them in the DB.

Once configured, toggle the MCP server on for a specific agent in the Agent editing UI. The agent will immediately gain access to all tools exposed by that server.
