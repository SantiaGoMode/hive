# Hive security, design, stale-code, and production-readiness audit

**Date:** 2026-07-16
**Scope:** Current local worktree, including uncommitted files
**Current verdict after the 2026-07-21 structural pass:** **Signed production release delivered; the principal structural backlog and legacy Colony log-reader retirement are implemented**

Hive has a credible local-first security foundation: first-boot API authentication, strict data-file permissions, a hardened Docker sandbox, bounded durable Colony execution, replayable Colony events, capability snapshots, and focused security tests. The main blockers are at the boundaries where untrusted external input can start privileged work, where credentials are transported or retained, and where releases are published without mandatory quality/signing gates.

The initial audited tree was not a reproducible release candidate: it contained **66 modified and 17 untracked files** relative to `main`. Findings below preserve the original evidence from that working state, not commit `8e66e20` alone. The remediation itself remains uncommitted and must be reviewed and committed before release.

## Remediation update

Implementation completed on 2026-07-16:

- **Resolved:** SEC-001 through SEC-007. Enabled webhooks require secrets, credential headers are redacted and historical rows scrubbed, query credentials were removed, unattended runs receive a restricted capability context, browser/Electron tokens no longer travel in URLs or renderer globals, active artifacts are forced to download, security headers and Electron sandboxing are enabled, and the server binds loopback by default.
- **Resolved:** OPS-002 and OPS-003. Colony jobs use fenced leases and bounded attempts; outbox delivery runs independently with backoff/dead-letter behavior; startup recovery, readiness, and coordinated fatal/signal shutdown are implemented.
- **Resolved:** OPS-001. Unattended actions share bounded process-wide backpressure and expose queue metrics; direct schedules and webhook actions have durable job records, fenced leases, retries, dead-letter replay, and restart recovery; Colony work remains durably queued.
- **Substantially resolved:** DATA-001. SQLite now has explicit WAL/synchronous/busy-timeout/foreign-key pragmas, online backups, retention, integrity checks, and an offline guarded restore command. Webhook telemetry and durable Colony run projections have cascading ownership constraints; remaining polymorphic references stay application-enforced.
- **Resolved release blocker:** REL-001. Release now depends on the full quality gate, fails closed for macOS signing/notarization credentials, pins GitHub Actions to immutable commits, emits SBOMs/checksums/provenance, and publishes only after the supported macOS and Linux builds succeed. Windows is excluded until Authenticode signing is configured.
- **Resolved source gate:** REL-002. `npm run test:ci` passes: 585 server tests and 133 client tests, server lint, gateway validation, warning-free client lint, and the production build. Root, client, and desktop audits report zero known vulnerabilities.
- **Cleaned:** unused imports and unreferenced starter assets were removed; stale runtime, security, gateway, and design-status documentation was corrected; gateway images were pinned by digest; bundled fonts were reduced to the Latin subset.
- **Packaging integrity hardened:** desktop builds now run outside File Provider-backed workspace paths, verify the strict code seal before and after notarization, and mount every generated DMG to verify its embedded app before publication.

Remaining release validation:

- Execute the new installed-package Linux release gate on the next tagged build; the workflow covers Ubuntu 22.04, Ubuntu 24.04, and Debian 12.

## Backlog implementation update — 2026-07-21

- **OPS-001 advanced:** direct webhook actions and scheduled agent/pipeline executions now create durable `automation_jobs` records with idempotency keys, source references, policy snapshots, fenced leases, bounded attempts/backoff, dead-letter state, restart recovery, and an authenticated replay endpoint. Colony missions continue to use their dedicated durable queue.
- **DATA-001 advanced:** schema version 25 adds ownership foreign keys with cascading cleanup for webhook events/action history. Pending migrations create a consistent protected SQLite recovery snapshot and fail closed if backup creation fails. Older binaries refuse databases created by newer schemas.
- **DES-001 advanced:** HTTP composition now lives in a testable app factory (`server/app.js`); executable startup retains process signals, integrations, workers, and shutdown lifecycle.
- **DES-003 advanced:** support diagnostics measure durable-event versus legacy-only Colony runs, and `COLONY_LEGACY_RETIREMENT.md` records readers, writers, evidence gates, and removal targets.
- **REL-002 completed:** client hook dependency warnings were fixed; client and server lint now run with zero warnings/errors in the focused verification pass.
- **REL-003 substantially resolved:** stable/beta channel selection is explicit; update checks refuse downgrades, require the exact platform artifact in `SHA256SUMS.txt`, and create a database backup before opening the OS installer. Schema compatibility, rollback steps, and redacted support diagnostics are documented and implemented. Fully unattended in-app replacement remains intentionally out of scope for the operator-approved v1 updater.
- **DES-002 substantially resolved:** the former 2,529-line Colony component module is split into stable live-view, log-rendering, protocol-panel, and persistent-team modules. Expanded recipes are split by product domain, staff analytics and persona overlays are isolated, and founding plus expanded presets now flow through one fail-fast validated registry.
- **DATA-001 advanced:** schema version 26 adds cascading ownership constraints across the durable Colony job, event, workflow, evidence, and outbox projections, including historical-orphan cleanup and invariant tests.
- **Linux installed smoke gate added:** tagged releases install the generated `.deb`, start the packaged Electron/server process under Xvfb, verify readiness, and confirm protected API authentication on Ubuntu 22.04, Ubuntu 24.04, and Debian 12 before publishing.
- **DES-003 log path resolved:** schema version 27 migrates every legacy `colonies.log` entry into append-only run events transactionally, clears the old projection, and removes all runtime readers/writers. SSE replay, API run details, exports, staff analytics, and UI state now share the durable event source.

Still open architectural work:

- Continue opportunistic decomposition of other large screens such as `AgentEditor.jsx`; this is maintainability work, not a release blocker.
- Expand foreign keys only where ownership remains unambiguous; polymorphic automation source references intentionally remain application-enforced.

## Original priority summary (pre-remediation)

| Priority | Finding | Why it blocks production |
|---|---|---|
| P0 | SEC-001: secretless incoming webhooks can start work | A reachable endpoint can accept unauthenticated input and launch agents, pipelines, or Colony runs. |
| P0 | SEC-002: webhook credentials are stored and returned | Bearer/API-key headers are persisted verbatim in SQLite and exposed through the authenticated events API. |
| P0 | REL-001: release can publish untested, unsigned artifacts | Tag builds publish directly; signing/notarization is optional and the current source gate is red. |
| P1 | SEC-003: non-Colony automation has ambient tool authority | Webhooks and schedules can invoke configured agents without Colony's run-scoped capability policy. |
| P1 | SEC-004: long-lived app tokens travel in URLs | Tokens can leak through process arguments, logs, history, diagnostics, or copied URLs. |
| P1 | OPS-001: durability is uneven and retry semantics are incomplete | Colony is queued, but webhook actions/pipelines are fire-and-forget; failed outbox entries have no later drain. |
| P1 | OPS-002: process and data lifecycle are incomplete | No coordinated shutdown, backup/restore, integrity-check, or referential-integrity strategy is present. |

## Original security findings

### SEC-001 — High — Secretless incoming webhooks can execute privileged automation

**Rule:** HIVE-SEC-001 / authenticate every externally reachable automation trigger
**Evidence:** `server/lib/auth.js:149-177` exempts `/api/webhooks/incoming/*` from Hive authentication. `server/routes/webhooks.js:142-182` verifies a signature only when `webhook.secret` is non-empty. The schema makes the secret optional (`server/lib/validate.js:99-106`), and the UI describes it as optional (`client/src/pages/WebhooksPage.jsx:110-116`). Accepted events start configured actions (`server/routes/webhooks.js:211-219`, `server/lib/webhookActions.js:117-132`) and may enqueue Colony runs (`server/lib/colonyTriggers.js:168-229`). Endpoint IDs use timestamp plus four `Math.random()` characters (`server/routes/webhooks.js:13-15`).

**Impact:** If Hive is reachable on the LAN or through ngrok, anyone who learns or guesses an enabled secretless endpoint can inject prompts and consume model/tool capacity. Impact becomes critical when the target agent has repo-write, GitHub-write, network, package-install, or shell tools.

**Fix:** Require a resolvable secret before an enabled webhook may have actions or triggers. Permit secretless endpoints only on verified loopback and only as inert event capture. Generate IDs with `crypto.randomUUID()` or at least 128 random bits. Add per-webhook throttling, payload-size limits, timestamp/replay validation where the provider supports it, and a clear unsafe-local-only state in the UI.

**Exploit conditions / false-positive note:** The route is intentionally public because webhook providers cannot send the Hive UI token. A secret-configured endpoint correctly validates GitHub HMAC or constant-time static credentials. The vulnerability is the supported enabled-empty-secret state combined with a reachable listener.

### SEC-002 — High — Incoming authentication material is retained verbatim

**Rule:** HIVE-SEC-002 / never persist request credentials in telemetry
**Evidence:** Incoming events serialize all request headers (`server/routes/webhooks.js:192-200`). The route accepts `Authorization: Bearer` and `x-api-key` credentials (`server/routes/webhooks.js:171-177`), and the events endpoint parses and returns the stored headers (`server/routes/webhooks.js:87-100`). A query-string secret is also accepted.

**Impact:** A webhook secret can be copied into the long-lived database, backups, support bundles, UI responses, or logs. Query credentials also leak easily through URLs and infrastructure access logs.

**Fix:** Store an allowlist of non-sensitive delivery metadata only. Always redact `authorization`, `x-api-key`, cookies, provider signatures, and any configured secret-bearing header before constructing the event object or writing SQLite. Remove query-string secret authentication. Add a migration/maintenance action that scrubs existing event rows.

**Exploit conditions / false-positive note:** Reading the events API still requires Hive auth, and GitHub HMAC signatures are not reusable as a static secret. Static bearer/API-key modes are directly reusable and are currently stored.

### SEC-003 — High — External automation does not share Colony's capability boundary

**Rule:** HIVE-SEC-003 / authorize tools per run and per source
**Evidence:** Tool policy is enforced only when `executeTool` receives a `colonyContext` with capabilities (`server/lib/tools/registry.js:25-44,66-90`). Webhook actions call `runAgentOnce` directly (`server/lib/webhookActions.js:100-132`); scheduled agents do the same (`server/lib/scheduler.js:110-136`). Those paths inherit the agent's persistent tool groups rather than a source-specific capability snapshot.

**Impact:** Prompt injection arriving through an external trigger receives whatever ambient authority the configured agent has. This undermines the otherwise sound separation between review/read and publish/write capabilities in Colony.

**Fix:** Introduce one run policy object for chat, schedule, webhook, pipeline, Discord, and Colony execution. Snapshot allowed capabilities at enqueue time; default external/unattended sources to no repo/GitHub mutation, no package installation, and no network unless explicitly approved. Record policy denials and granted capabilities with every run.

**Exploit conditions / false-positive note:** Operators choose agent tools, so some authority is intentional. The issue is that external input inherits persistent grants without an additional source/run authorization decision.

### SEC-004 — Medium — Long-lived Hive tokens are exposed in URLs and renderer state

**Rule:** HIVE-SEC-004 / do not put bearer credentials in URLs
**Evidence:** The server accepts `hive_token` and `token` query parameters (`server/lib/auth.js:100-110`). The client appends the token to raw artifact and WebSocket URLs (`client/src/lib/api.js:157-164,262-268`) and stores browser tokens in `localStorage` (`client/src/lib/api.js:4-20`). Electron passes the token in renderer process arguments and exposes it globally through preload (`desktop/main.js:228-240`, `desktop/preload.js:1-10`). A `VITE_HIVE_AUTH_TOKEN` fallback would embed a token in the client bundle.

**Impact:** Tokens can appear in process listings, browser history, copied URLs, reverse-proxy logs, crash reports, and diagnostics. Any renderer XSS can read the global/localStorage token.

**Fix:** Fetch media with authenticated `fetch()` and Blob URLs; use short-lived, artifact-scoped signed URLs when element URLs are unavoidable. Authenticate WebSockets with an ephemeral ticket or a header/subprotocol accepted during upgrade. Keep browser credentials session-scoped or use an appropriately protected local session. Pass Electron authentication through narrow IPC/session header injection rather than argv/global renderer state. Remove production support for `VITE_HIVE_AUTH_TOKEN`.

**Exploit conditions / false-positive note:** The token is random and local files are permission-protected. This is an exposure-amplification issue, not a weak-token issue.

### SEC-005 — Medium — Active artifacts are served inline from the authenticated app origin

**Rule:** HIVE-SEC-005 / isolate untrusted active content
**Evidence:** Artifact MIME support includes SVG and HTML (`server/lib/colonyArtifacts.js:78-88`). Generic and Colony routes default to inline responses (`server/routes/artifacts.js:18-30`, `server/routes/colony/runs.js:42-65`).

**Impact:** Agent-produced HTML/SVG opened directly in a browser can become same-origin active content. That is especially risky while app authentication uses browser-readable/query credentials.

**Fix:** Force `attachment` for HTML/SVG and unknown files, add `X-Content-Type-Options: nosniff`, and serve previews from a separate opaque/sandboxed origin or a sandboxed iframe with a strict CSP. Prefer safe text rendering for code/report previews.

**Exploit conditions / false-positive note:** SVG displayed through `<img>` is safer than top-level navigation, and normal artifact access requires authentication. Direct navigation and future preview changes remain risky.

### SEC-006 — Medium — HTTP and Electron defense-in-depth is incomplete

**Rule:** HIVE-SEC-006 / secure headers and renderer isolation
**Evidence:** `server/index.js:44-93` installs no CSP/security-header middleware and does not disable `X-Powered-By`. `client/index.html:1-13` has no CSP. Electron correctly uses context isolation and disables Node integration, but does not enable renderer sandboxing and does not block navigation (`desktop/main.js:228-248`).

**Impact:** A future injection flaw has a larger blast radius, particularly because the renderer can access the app token. Server fingerprinting and content sniffing are avoidable.

**Fix:** Add a production CSP and explicit headers (Helmet or equivalent), disable framework fingerprinting, set `nosniff`, and establish a centralized production error handler. Enable Electron `sandbox: true`, deny unexpected `will-navigate`, constrain permissions, and retain the existing external-window deny policy.

**Exploit conditions / false-positive note:** `react-markdown` does not enable raw HTML by default, and `nodeIntegration: false` plus `contextIsolation: true` are good existing controls.

### SEC-007 — Medium — The API listens on all interfaces by default

**Rule:** HIVE-SEC-007 / local-first services bind loopback by default
**Evidence:** `server/index.js:97-117` calls `server.listen(PORT)` without a host. The API token still protects normal routes, but secretless incoming webhooks remain exposed to any reachable interface.

**Impact:** A local-first installation is unnecessarily visible on the LAN/container network. This magnifies SEC-001 and increases attack surface.

**Fix:** Bind `127.0.0.1` by default. Add an explicit `HIVE_BIND_HOST`/public-exposure mode that requires authentication, secure webhook configuration, and a startup warning. Keep ngrok as an explicit exposure path.

**Exploit conditions / false-positive note:** This is not unauthenticated access to ordinary APIs; first-boot token auth is present. It is an unnecessary reachability default.

### Security controls that are working

- First boot generates a 256-bit API token and writes the convenience file with `0600` permissions (`server/lib/auth.js:129-146`).
- Hive home/database permissions are normalized to `0700`/`0600`, and test processes are guarded from opening the production database (`server/db.js:8-47`).
- The sandbox validates containment and symlinks, drops all Linux capabilities, disables privilege escalation and network by default, and sets CPU/memory/PID caps (`server/lib/sandbox.js:126-148,280-301`).
- GitHub webhook HMAC comparison and static-token comparison are constant-time when a secret is configured (`server/routes/webhooks.js:153-181`).
- No likely private keys or common live-token patterns were found in tracked source by the audit scan.
- `npm audit --audit-level=low` reported zero known vulnerabilities for root, client, and desktop dependency trees on 2026-07-16.

## Original architecture and reliability findings

### OPS-001 — High — Durability and backpressure are inconsistent

Colony now has a bounded durable queue (`server/lib/colonyJobs.js:1-12,89-100`), which is a major improvement. Direct webhook actions still start one `setImmediate` task per match with no global concurrency/cost limit (`server/lib/webhookActions.js:117-132`), and regular pipelines/agent schedules remain process-local work. A restart can therefore lose or duplicate non-Colony work.

The Colony outbox is also only drained at successful run finalization (`server/lib/colony/runner.js:503-510`). Failed entries are marked `failed` and selected by a later `processRun` call (`server/lib/colonyOutbox.js:13-35`), but no startup/background worker calls it again. In practice, “failed” is terminal until custom code reprocesses that same run.

**Recommendation:** Build one durable execution substrate for unattended work. Give jobs idempotency keys, source/owner/cost metadata, retry count, exponential backoff, dead-letter state, and operator replay. Run an independent outbox dispatcher at startup and continuously; never couple retry solely to a successful model-run finalizer.

### OPS-002 — High — Colony lease/retry semantics can duplicate side effects

`colonyJobs.claimNext()` reclaims expired running jobs and increments attempts without a retry limit or backoff (`server/lib/colonyJobs.js:33-47`). Heartbeats do not check whether the lease update succeeded (`server/lib/colonyJobs.js:57-66`), so a runner that lost ownership can continue. Startup requeues every running job (`server/lib/colonyJobs.js:114-123`). The design is reasonable for a single local process, but it does not yet provide safe lease semantics under stalls or multiple workers.

**Recommendation:** Add fencing tokens/attempt IDs and require them on every run-state transition; abort work immediately when heartbeat ownership is lost. Define max attempts, backoff, dead-letter/blocked state, and recovery checkpoints. Add a database invariant preventing more than one active job per team. Document delivery as at-least-once and keep all external mutations behind the outbox.

### OPS-003 — High — Crash and shutdown lifecycle is unsafe

Unhandled rejections and exceptions are logged but the process remains alive (`server/index.js:3-8`), potentially after undefined state. There is no production `SIGTERM`/`SIGINT` coordinator to stop HTTP intake, schedulers, Discord, MCP, ngrok, active jobs, and SQLite cleanly. Startup reports `/healthz` before asynchronous subsystem initialization finishes (`server/index.js:55-58,111-180`), so liveness and readiness are conflated.

**Recommendation:** Implement idempotent graceful shutdown with a deadline, stop accepting traffic first, release/expire leases, stop schedulers and integrations, close sockets/DB, then exit. Treat uncaught exceptions as fatal after logging. Split `/livez` from `/readyz`, with readiness reflecting migration and required-service state.

### DATA-001 — High — No backup, restore, integrity, or referential-integrity lifecycle

The schema contains 29 table declarations but no foreign keys or SQLite durability pragmas found by the audit. Deletion paths manually clean related rows, often best-effort. No database backup API, restore flow, WAL checkpoint, `busy_timeout`, or `integrity_check` operation was found.

**Recommendation:** Add versioned backup/restore/export with pre-migration backups; use SQLite's online backup API; set and test an explicit journal/synchronous/busy-timeout policy; run integrity checks on demand and after abnormal shutdown. Introduce foreign keys gradually where data ownership is clear, or add explicit invariant/repair tests before enabling enforcement.

### DES-001 — Medium — Server composition and domain boundaries are too broad

`server/index.js` is both process policy, middleware composition, integration boot, recovery, and readiness. Database access is performed directly throughout routes and libraries. This makes consistent authorization, validation, transactions, telemetry, and lifecycle behavior difficult.

**Recommendation:** Separate an app factory (pure HTTP composition), a service container/lifecycle manager, and executable startup. Put run creation, authorization, and persistence behind domain services. Add one request/error envelope and structured correlation IDs for HTTP, runs, jobs, and external actions.

### DES-002 — Medium — Colony/UI and catalog modules are oversized and split across overlapping sources

The main Colony component file is 2,526 lines; `recipeCatalog.js` is 1,765; `staffDirectory.js` is 966; `AgentEditor.jsx` is 918; and `colonyRecipes.js` is 842. Recipe behavior is distributed among catalog metadata, runtime recipes, seeding, staff definitions, prompts, and UI assumptions.

**Recommendation:** Split Colony UI by stable feature boundary (run timeline, workflow/evidence, artifacts, queue, team configuration). Define one validated recipe schema and generate runtime/UI projections from it. Keep recipe-specific behavior in explicit adapters rather than switches spread across runner, prompts, and components.

### DES-003 — Medium — Transitional compatibility paths need an explicit retirement plan

The durable Colony architecture is sound directionally, but legacy run logs/state coexist with append-only events and fallback readers. Draft design documents describe features that are now partially shipped. Compatibility is valuable, but indefinite dual paths increase divergence and test burden.

**Recommendation:** Inventory each legacy field/path, its current reader/writer, migration condition, and deletion version. Add telemetry or tests proving old paths are no longer used before removal. Mark specs as implemented/partially implemented and record the final architectural decisions.

## Garbage, stale code, and maintainability

### Confirmed removable or stale items

- `client/src/assets/react.svg`, `vite.svg`, and `hero.png` have no source references.
- `server/lib/discord/commands.js:4-6` imports `cron` and `scheduler` but does not use them.
- `server/tests/ownedAgents.test.js:4` imports `before` but does not use it.
- `docs/AUDIT.md:1-12` claims a July 1 tree is current and points to line counts/findings that have since changed. Archive it as a dated audit or replace it with an index of immutable audits.
- `.env.example:19` says an empty auth token means localhost is open, while startup now generates a token.
- `README.md:97` advertises Node 18, but installed Vite requires Node `^20.19.0 || >=22.12.0`, and installed `better-sqlite3` supports Node 20+.
- `README.md:85` claims bounded concurrent webhook runs; only Colony jobs are globally bounded. Direct webhook actions are not.
- `README.md:104` instructs users to remove macOS quarantine. That is development-distribution guidance, not acceptable production release guidance.
- `docs/specs/colonies-first.md` and `docs/specs/discord-bridge.md` remain “Draft v1” even though substantial implementation exists.

### Bloat and complexity to address after blockers

- Five separate Inter weight imports include more font subsets than the app likely needs (`client/src/main.jsx:4-8`). Prefer a variable Latin/Latin-ext build or explicitly scoped subsets.
- The Colony page is the largest feature chunk and its 2,526-line component module impedes focused test coverage and safe ownership.
- `gateway/docker-compose.yml:13` uses mutable `ghcr.io/berriai/litellm:main-stable`; pin an audited version and digest for reproducible releases.
- GitHub Actions use movable major tags. Pin release-critical third-party actions to commit SHAs and use an update bot.
- The custom macOS signer depends on an internal `@electron/osx-sign/dist/cjs/util` module and monkey-patches it (`desktop/scripts/sign-macos.js:53-84`). Preserve the workaround only with a packaging regression test and a tracked upstream replacement plan.

### Not garbage

The Colony route wrapper, legacy-state readers, owned-agent service, recipe catalog, and scheduling modules are active. They should not be deleted based only on size or naming. Retire them only after call-site and persisted-data migration evidence.

## Original production release findings

### REL-001 — High — The release workflow can publish an unverified, unsigned product

The CI workflow runs tests/lint/build on main and pull requests (`.github/workflows/ci.yml:23-45`), but the tag-triggered release independently installs, builds, and immediately publishes (`.github/workflows/release.yml:39-66`). It does not run the quality gate or require that the tagged commit passed CI. The workflow explicitly permits unsigned macOS/Windows artifacts (`.github/workflows/release.yml:4-10`), and notarization is not configured in `desktop/electron-builder.yml:26-34`.

**Recommendation:** Make release a promotion of an immutable, CI-verified commit. Run `npm run test:ci`, focused packaging smoke tests, dependency/license policy, and artifact verification before publish. Build all platform artifacts first, sign them, generate checksums/SBOM/provenance, then publish in a separate gated job. Require Developer ID + hardened runtime + notarization on macOS and Authenticode on Windows; fail closed if signing secrets are absent.

### REL-002 — High — The current worktree does not pass the source gate

On 2026-07-16:

- Root, client, and desktop `npm audit --audit-level=low`: **pass, zero known vulnerabilities**.
- Focused auth, WebSocket, webhook, sandbox, and Colony durability tests: **32/32 pass**.
- Client tests previously in this audit: **133/133 pass**.
- Client production build and gateway model validation: **pass**.
- Client lint: **exit 0 with 13 React hook dependency warnings**.
- Server lint: **fail**, three unused-import errors in `server/lib/discord/commands.js` and `server/tests/ownedAgents.test.js`.
- Full `npm run test:ci`: did not complete cleanly in the audit window and was interrupted after the server suite stopped producing output. It must not be reported as passing.

**Recommendation:** Establish a clean committed release candidate, make every required gate deterministic and time-bounded, fix open-handle/stall behavior in the full server suite, and require a completely green `test:ci` plus packaged-app smoke test.

### REL-003 — Medium — Operational product lifecycle is incomplete

The desktop updater checks GitHub and opens a browser rather than applying a signature-verified update. There is no visible rollback channel, schema compatibility policy, release notes/changelog contract, support bundle with secret redaction, or documented disaster recovery procedure.

**Recommendation:** Define stable/beta channels, signed update metadata, rollback behavior, minimum supported schema/app versions, backup-before-update, a redacted diagnostics bundle, and a release runbook. For a local-first v1, a secure manual updater is acceptable only if releases are signed/notarized and migrations/backups are reliable.

## Recommended implementation order

### Phase 0 — Stop unsafe release/exposure

1. Make enabled action-bearing webhooks require a secret; restrict secretless capture to loopback.
2. Redact and scrub stored webhook headers; remove query secret authentication.
3. Bind the server to loopback by default.
4. Make the release workflow fail unless tests, lint, signing, hardened runtime, and notarization pass.
5. Fix the current lint errors and full-suite stall; cut releases only from a clean commit.

### Phase 1 — Unify trust and execution

1. Apply run-scoped source/capability policies to every agent/pipeline invocation.
2. Move webhook actions and scheduled/pipeline work onto a durable bounded job system.
3. Add fenced leases, bounded retries/backoff, dead-letter handling, and a real outbox dispatcher.
4. Replace URL/argv bearer-token transport and isolate active artifacts.
5. Add CSP/security headers and Electron renderer sandbox/navigation controls.

### Phase 2 — Operational readiness

1. Add graceful shutdown, readiness, backup/restore, integrity checks, and migration rollback safeguards.
2. Add signed update/rollback and redacted support diagnostics.
3. Pin container/actions dependencies and produce checksums, SBOM, and provenance.
4. Correct runtime/security documentation and archive stale audits/specs.

### Phase 3 — Simplify the system

1. Consolidate recipe definitions into one validated source.
2. Split oversized Colony/UI/server modules around domain boundaries.
3. Measure and retire legacy Colony state paths.
4. Remove confirmed unused assets/imports and trim font/package payloads.

## Production-ready exit criteria

Hive is ready for a production candidate when all of the following are true:

- No enabled externally reachable automation path accepts unauthenticated input.
- Every unattended run has a recorded source, capability snapshot, concurrency/cost limit, idempotency key, and durable status.
- No reusable credential is stored in webhook events or placed in routine URLs/process arguments.
- Release artifacts are built from a clean commit after green tests/lint/audits, then signed, notarized where applicable, checksummed, and smoke-tested after installation.
- Shutdown/recovery tests prove active work reaches a deterministic recoverable state without duplicate external mutations.
- Backup, restore, migration, and integrity-check drills pass against representative user data.
- Documentation matches the supported Node/platform versions and actual security model.
