# 05 - Security and Architecture

Hive is designed with a strict "local-first" security model, but because it executes arbitrary AI-generated code (via Sandboxes and Colonies), multiple layers of hardening are applied.

---

## 1. Secrets Management

### The Default Model
- Keys (Anthropic, OpenAI, etc.) are saved in `~/.hive/hive.db` (mode `0600`).
- The UI masks these values. The Express API *never* returns cleartext keys to the client.

### The Zero-Rest Model (Environment-Backed Secrets)
If storing API keys in SQLite is unacceptable for your threat model:
1. Clear the keys from the UI.
2. Enter references like `env:MY_COMPANY_OPENAI_KEY` in the settings fields.
3. Launch Hive from an environment populated by your shell, OS secret store, or deployment secret manager.
4. `server/lib/secrets.js` resolves the `env:` prefix, meaning the keys exist only in memory, never on disk.

---

## 2. API Hardening

The Hive backend (`server/`) is protected against unauthorized access.

- **Authentication**: Gated by `HIVE_AUTH_TOKEN`. Mutating requests (POST, PUT, DELETE) and WebSocket upgrades are rejected without it.
- **CORS**: Restricted to `localhost` and whatever is specified in `HIVE_ALLOWED_ORIGINS`.
- **Rate Limiting**: Built-in bounding (default 60 requests per minute) on mutating routes to prevent brute-force attacks or runaway scripts.

---

## 3. Sandbox Hardening

Agents running code in the `sandbox` are highly restricted.
See `server/lib/sandbox.js`.

- **Network**: `network=none` by default. Agents cannot exfiltrate data or download malicious packages unless explicitly granted `HIVE_SANDBOX_NETWORK=bridge`.
- **Capabilities**: Docker containers are run with `--cap-drop=ALL` and `no-new-privileges`.
- **Resource Limits**: Configurable memory and CPU limits prevent fork-bombs or memory leaks from crashing the host machine.
- **Path Confinement**: The sandbox is mounted specifically to `/workspace`. It cannot access the host filesystem outside of this mount.

---

## 4. The LiteLLM Gateway

For enterprise or multi-user setups, the bundled LiteLLM gateway (found in `gateway/`) provides the ultimate layer of control.

By proxying all requests through LiteLLM:
1. **Spend Limits**: You can enforce hard USD caps on individual agents via virtual keys.
2. **Failover**: Ensure reliable Colony runs by routing through `gateway/hive-smart`, which will seamlessly fallback to another model if the primary API rate-limits or goes down.
3. **Caching**: Identical prompt executions can be cached, significantly reducing costs and latency for repetitive agent tasks.
