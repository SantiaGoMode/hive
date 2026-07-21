# Hive Desktop

Electron shell around the unmodified Hive server + built client. The shell:

1. picks a free localhost port and starts `server/index.js` — via `utilityProcess` (Electron's bundled Node) when packaged, via the system `node` in dev,
2. waits for authenticated subsystems to reach `GET /readyz`,
3. reads the active auth token from `HIVE_AUTH_TOKEN` or `~/.hive/hive.db` (`hive_auth_token`), resyncs the convenience copy at `~/.hive/auth_token`, and injects the token as a request header only for the local Hive origin. The token is never exposed to renderer globals, URLs, or process arguments.

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

On macOS, local `npm run dist` builds use ad-hoc signing (`identity: "-"`) and
disable hardened runtime so the generated app launches without a Developer ID
certificate. The custom macOS signing hook strips provenance xattrs immediately
before delegating to `@electron/osx-sign`; otherwise `codesign` can reject
freshly downloaded Electron helper binaries.
Release builds use `dist:ci`; CI requires signing credentials, hardened runtime,
and notarization before it publishes any artifacts.

All desktop builds use a private temporary output directory before copying final
installers into `desktop/dist`. This prevents macOS File Provider metadata from
being attached between signing and DMG creation. Production builds verify the
strict code seal immediately after signing, again after notarization, and once
more from the app mounted inside every generated DMG; CI refuses to publish if
any signature, Gatekeeper, stapling, or image-checksum check fails.

## Release

Bump the root `package.json` version, tag `vX.Y.Z`, push the tag —
`.github/workflows/release.yml` builds macOS and Linux installers and uploads
them to the GitHub Release only after the complete source gate and both builds
pass. `stage.js` keeps this package's version in lockstep with the root. Missing
macOS signing or notarization credentials fail the release rather than
publishing an unsigned installer. Windows packaging remains available locally
and can return to the matrix after Authenticode credentials are configured.
