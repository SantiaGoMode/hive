# Multi-Provider Model Support — Design Plan (rev. 2 — Vercel AI SDK)

> **Revision note.** Rev. 1 proposed hand-writing native adapters per provider. Research
> against June 2026 best practice (see `plans/multi-provider-research.md` / chat history)
> changed the approach: use the **Vercel AI SDK v6** as the provider abstraction. It is the
> de-facto standard for TypeScript/Node (20M+ monthly downloads), runs in plain Node with no
> Next.js, uses each provider's **native** API (not the degraded OpenAI-compat shims), and
> normalizes streaming + tool-calling across providers — which is exactly the layer rev. 1 was
> going to build by hand. **All four providers, including Ollama, route through the AI SDK** via
> provider packages (Ollama through the community provider).

## Goal

Let agents use **cloud models** (Anthropic, OpenAI, Google Gemini) in addition to local
**Ollama** models. A model is selected per agent (and per colony/pipeline step). Chat
streaming, tool calling, pipelines, colony, and schedules work identically regardless of which
provider backs the model.

Decisions locked in:
- **Providers:** Ollama + Anthropic + OpenAI + Gemini, **all via the Vercel AI SDK v6**.
- **Ollama route:** the **community AI-SDK provider** (uniform code path for every provider).
- **API keys:** stored in `app_settings`, masked on read (same pattern as `ngrok_authtoken`).
- **Model list:** fetched **live** per provider when a key is set, filtered to chat/tool-capable
  models, with a curated fallback + free-text entry when no key or the call fails.
- **OpenAI surface:** the **Responses API** (AI SDK default in v6) — not legacy Chat Completions.

---

## Why the AI SDK (and what we rejected)

- **Hand-rolled native adapters (rev. 1):** correct architecture but the per-provider tool-call
  and message mappers were the highest-risk, highest-maintenance code. The AI SDK already does
  this normalization, tested across providers. Superseded.
- **One OpenAI-compatible endpoint for all providers:** rejected — Anthropic's compat layer is
  documented "for testing/comparison, not production" (ignores `strict`, no extended thinking);
  Gemini's compat layer drops `anyOf`/`oneOf`/`$ref`/`pattern` from function-call schemas, which
  would silently break our tool definitions. The AI SDK uses native APIs and avoids this.
- **LiteLLM:** the other dominant gateway, but a Python proxy run as a separate process
  (Postgres/Redis). Wrong stack and weight for a lean, local-first Node app.

### Dependencies added

`ai` (core), `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, and a community Ollama
provider (`ai-sdk-ollama` — actively maintained for v6, reliable tool-calling; `ollama-ai-provider-v2`
is the fallback choice). **Caveat:** the Ollama provider is community-maintained, not first-party.
Since Ollama is the default path, we pin the version and cover it in tests; if it ever lags a
v6 release we can swap to the alternate community package or fall back to direct Ollama HTTP for
that one provider without touching the rest of the layer.

---

## The provider layer

The agent `model` field already uses a provider-prefix convention (`ollama/llama3.1`), and
`stripProviderPrefix` in `agentParser.js` strips only `ollama/`. That prefix is our seam. We add
**`server/lib/providers/`** wrapping the AI SDK:

```js
// server/lib/providers/index.js
const { streamText, jsonSchema, tool } = require('ai');
const { createOpenAI }    = require('@ai-sdk/openai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { createGoogleGenerativeAI } = require('@ai-sdk/google');
const { createOllama }    = require('ai-sdk-ollama');

// model string -> { provider, modelId }; bare string defaults to 'ollama' (back-compat)
function parseModel(modelString) { /* split on first '/', default provider 'ollama' */ }

// Build an AI SDK model instance for a parsed model, injecting the right key/baseURL.
function getModel(provider, modelId) {
  switch (provider) {
    case 'anthropic': return createAnthropic({ apiKey: keyFor('anthropic') })(modelId);
    case 'openai':    return createOpenAI({ apiKey: keyFor('openai') })(modelId); // Responses API by default in v6
    case 'gemini':    return createGoogleGenerativeAI({ apiKey: keyFor('gemini') })(modelId);
    case 'ollama':
    default:          return createOllama({ baseURL: ollamaBaseUrl() })(modelId);
  }
}
```

### One normalized streaming function

Both existing call sites consume Ollama NDJSON today. We replace the raw `fetch` with one
function that drives the AI SDK's `fullStream` and yields the **same normalized events** the
app already accumulates:

```js
// server/lib/providers/index.js (cont.)
async function* streamChat(modelString, { messages, tools, options, signal }) {
  const { provider, modelId } = parseModel(modelString);
  const result = streamText({
    model: getModel(provider, modelId),
    messages: toModelMessages(messages),     // Ollama-shaped -> AI SDK ModelMessage[]
    tools: toAiSdkTools(tools),               // our tool defs -> AI SDK tools (NO execute)
    abortSignal: signal,
    temperature: options?.temperature,
    maxOutputTokens: options?.num_predict,
    // single model round — the app runs its own tool loop (see below)
    stopWhen: () => true,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':      yield { type: 'content',  delta: part.text }; break;
      case 'reasoning-delta': yield { type: 'thinking',  delta: part.text }; break;
      case 'tool-call':       yield { type: 'tool_call', call: { id: part.toolCallId,
                                       function: { name: part.toolName, arguments: part.input } } }; break;
      case 'finish':          yield { type: 'done', reason: part.finishReason,
                                       stats: mapUsage(part.totalUsage) }; break;
      case 'error':           throw part.error;
    }
  }
}
```

Key design choice: **the app keeps its own tool-execution loop.** The AI SDK *can* run the
tool loop itself (tools with `execute` + `stopWhen` step counts), but Hive already has a
sophisticated loop — delegation rules, colony orchestration, consecutive-repeat detection, and
live WS streaming of each tool call. We preserve all of that by running the AI SDK **one model
round at a time** (no `execute` on tools): stream text + tool calls out, let the existing loop
execute tools via `executeTool`, append results, and call `streamChat` again. This keeps the
blast radius small and behavior identical.

### Adapters (small, pure, tested)

- `toModelMessages(messages)` — map `{role: system|user|assistant|tool, content, tool_calls?}`
  to AI SDK `ModelMessage[]` (assistant tool calls → `tool-call` parts; tool results → `tool`
  role messages with `tool-result` parts).
- `toAiSdkTools(toolDefs)` — `getToolDefinitions()` returns OpenAI-style
  `{ function: { name, description, parameters } }`; wrap each as an AI SDK `tool({ description,
  inputSchema: jsonSchema(parameters) })` with **no `execute`** so the SDK surfaces the call
  instead of running it.
- `mapUsage(usage)` — `{ inputTokens, outputTokens }` → existing `{ input_tokens, output_tokens, tps? }`.
- Tool-call `arguments` arrive already parsed (object) from the SDK — no per-provider JSON
  string parsing needed (a rev. 1 concern the SDK removes).

The Ollama-specific `think:true` / `<think>`-stripping logic is no longer needed: reasoning
arrives as normalized `reasoning-delta` parts across providers. We keep a small compatibility
shim only if a pinned Ollama model still emits inline `<think>` tags through the community
provider (verified during build).

---

## API keys

Stored in `app_settings`, consistent with `ngrok_authtoken`:

- New allowed keys in `PUT /api/config`: `anthropic_api_key`, `openai_api_key`, `gemini_api_key`.
- **Masked on read:** `GET /api/config` returns these masked — never the raw secret (mirror the
  MCP `env_secret_keys` masking already in the codebase). UI sends a new value only when edited.
- `keyFor(provider)` resolves the raw value server-side from the DB. Optional `process.env`
  fallback can be added cheaply later.
- Settings UI gains a **"Model Providers"** section: one masked input + "Test" button per
  provider (test = call that provider's `listModels`, report ok/fail).

---

## Model listing (live + fallback) — unchanged by the SDK choice

`GET /api/models` (new, provider-agnostic) returns a merged, provider-tagged list:
- Ollama: existing `/api/tags`.
- Cloud: each provider's REST list endpoint when a key is set (the AI SDK does not list models
  for direct providers, so this stays a thin per-provider `listModels`), **filtered** to
  chat/tool-capable models (drop embeddings, tts, moderation, vision-only, dated dupes).
- On missing key / error: substitute that provider's **curated fallback list** so the picker is
  never empty. The picker also accepts **free-text** `provider/model` entry.

`routes/ollama.js` (pull/delete/show) stays for Ollama model management; `routes/models.js` owns
the unified cross-provider list.

---

## Touch points (file-by-file)

| File | Change |
|------|--------|
| `package.json` | Add `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `ai-sdk-ollama` (pinned). |
| `server/lib/providers/index.js` | **New.** `parseModel`, `getModel`, `streamChat`, `keyFor`, adapters. |
| `server/lib/providers/listModels.js` | **New.** Per-provider live list + curated fallback + filters. |
| `server/lib/agentTools.js` | `runAgentOnce` consumes `providers.streamChat` events instead of `fetch(ollama/api/chat)`; existing tool loop unchanged. `list_models` tool + `create_agent` preflight become provider-aware. |
| `server/lib/websocket.js` | `streamOllamaRound` → `streamRound` over `providers.streamChat`; keep WS `chunk`/`stat` event shapes identical. |
| `server/lib/colonyRunner.js` | `preflightColony` provider-aware: for cloud models verify a key is present instead of hitting Ollama `/api/tags`. |
| `server/routes/models.js` | **New.** `GET /api/models` unified live+fallback list. |
| `server/routes/config.js` | Allow + mask the three api-key settings. |
| `server/routes/ollama.js` | Unchanged (Ollama pull/delete/show). |
| `server/db.js` | No schema change (keys in `app_settings`; `agents.model` already free-text). |
| `client/src/lib/api.js` | `getModels` → `/models`; add provider key config helpers. |
| `client/src/components/agents/AgentEditor.jsx` | Model picker grouped by provider (optgroups) + custom entry; relabel "Ollama Model" → "Model". |
| `client/src/pages/ModelsPage.jsx` / `ModelBrowser.jsx` | Provider grouping; Ollama keeps pull/delete, cloud models list-only. |
| `client/src/pages/SettingsPage.jsx` | New "Model Providers" section: masked key inputs + Test buttons. |
| `server/tests/providers.test.js` | **New.** `parseModel`; `toModelMessages` / `toAiSdkTools` / `mapUsage`; stream normalization via a mocked AI SDK `fullStream`. |

---

## Backward compatibility

- Existing agents store bare model names (`llama3.1:8b`) or `ollama/...` → both resolve to the
  Ollama provider through the SDK. No migration, no behavior change.
- Ollama remains the zero-config default; cloud providers are inert until a key is set.
- WS/SSE event shapes to the client are unchanged, so the chat UI needs no rework beyond the
  model picker.

---

## Risks & mitigations

1. **Community Ollama provider lag/quirks** — pin the version, cover Ollama tool-calling +
   streaming in tests; fallback to the alternate community package or direct Ollama HTTP for
   that single provider if needed (rest of layer untouched).
2. **App loop vs SDK loop seam** — we deliberately run one SDK round per loop iteration with no
   tool `execute`; verify tool-call surfacing + multi-round behavior matches today's Ollama path
   before adding clouds.
3. **Message/tool adapter correctness** — small pure functions, unit-tested against recorded
   samples (assistant tool calls, tool results, multimodal/file attachments already supported in
   chat).
4. **Secret leakage** — never return raw keys; mask in `GET /config`; `keyFor` server-only.
5. **AI SDK v6 surface drift** — pin major version; the wrapper isolates the rest of the app
   from SDK API changes.

---

## Verification plan

- Unit: `parseModel`; adapters; stream normalization via mocked `fullStream` → assert our event
  sequence (`content` / `thinking` / `tool_call` / `done`).
- Parity gate: with only the SDK + Ollama provider wired, confirm an existing Ollama agent,
  pipeline, and colony run behave exactly as before (this is build step 1's exit criterion).
- Integration (manual, macOS, real keys): one chat + one tool-using run per cloud provider; one
  pipeline and one colony run on a cloud model; confirm WS streaming + stats render.
- Regression: existing test suite green; existing Ollama agents unchanged.
- Secret check: `GET /api/config` never returns a raw key.

---

## Suggested build order

1. Add deps; build `providers/` wrapping the AI SDK; route **Ollama through the SDK**; wire both
   call sites + colony preflight. **Exit criterion: full parity with today on Ollama.**
2. Add `routes/models.js` unified list + config key masking + Settings "Model Providers" UI.
3. Enable cloud providers one at a time — Anthropic, then OpenAI (Responses), then Gemini — each
   with adapter tests and a manual tool-using run.
4. Client model picker grouping + ModelsPage provider sections.
5. Full test pass + per-provider manual verification.
