# Hive Desktop

Electron shell around the unmodified Hive server + built client. The shell:

1. picks a free localhost port and starts `server/index.js` — via `utilityProcess` (Electron's bundled Node) when packaged, via the system `node` in dev,
2. waits for `GET /healthz`,
3. reads the active auth token from `HIVE_AUTH_TOKEN` or `~/.hive/hive.db` (`hive_auth_token`), resyncs the convenience copy at `~/.hive/auth_token`, and opens a `BrowserWindow` at the local origin with the token injected through `preload.js` (`window.hiveDesktop.authToken`), so the paste-a-token prompt never appears.

Data lives in the same `~/.hive` as the browser/dev workflows — the desktop app, `npm run dev`, and `npm start` are interchangeable views of one install.

## Develop

```bash
npm install                # in desktop/
npm run dev                # Electron shell + repo server (system node) + client/dist
```

Build the client first (`npm run build` at the repo root) — the server serves `client/dist`.

## Package

```bash
npm run stage              # stage server + prod node_modules (Electron-ABI) + client build
npm run dist               # electron-builder → dist/ artifacts for this platform
```

`scripts/stage.js` installs production deps fresh into `staging/` and rebuilds
`better-sqlite3` against Electron's ABI there — the repo's own `node_modules`
stay on the system-Node ABI, so dev workflows are unaffected. `@ngrok/ngrok` is
N-API and keeps its prebuilds. The staged tree ships as `extraResources`
**outside asar** because the server spawns child processes (git, docker, npx)
and reads files by path.

## Release

Bump the root `package.json` version, tag `vX.Y.Z`, push the tag —
`.github/workflows/release.yml` builds macOS/Linux/Windows installers and
uploads them to the GitHub Release. `stage.js` keeps this package's version in
lockstep with the root. Signing is controlled by CI secrets (see the workflow
header); without them the artifacts are unsigned.
