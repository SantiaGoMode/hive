# Release, update, and recovery policy

Hive 1.x uses signed manual updates. The desktop app checks the GitHub release feed, and users install only artifacts published by the release workflow. macOS artifacts must be Developer ID signed, hardened, notarized, and stapled. Linux artifacts must match the published SHA-256 manifest and provenance attestation.

The release workflow installs the generated Debian package and exercises the
packaged Electron/server process on Ubuntu 22.04, Ubuntu 24.04, and Debian 12.
Publishing is blocked unless `/readyz` succeeds and the protected API rejects an
unauthenticated request on every representative environment.

For a signed, notarized build that must not create a GitHub Release, manually
dispatch `.github/workflows/release.yml` from the target commit. Manual runs use
the same quality, signing, notarization, artifact-verification, and Linux smoke
gates as a tagged release, but skip the publish job. Download the `hive-macOS`
artifact from the completed run and verify its app with `codesign`, `spctl`, and
`stapler` before installing it. Local development builds are intentionally not
notarized and must never be distributed as production releases.

## Channels

- **Stable:** non-prerelease tags named `vMAJOR.MINOR.PATCH`; intended for normal installs.
- **Beta:** GitHub prereleases named `vMAJOR.MINOR.PATCH-beta.N`; opt-in testing only.
- The app's default update check reads stable releases. It never silently changes channel.

## Schema compatibility

- Database migrations are forward-only and append-only.
- A Hive build refuses to start when the database schema is newer than that build supports. This prevents an older binary from writing through an unknown schema after an app rollback.
- Back up `~/.hive/hive.db` before upgrading. Hive also maintains protected online backups under `~/.hive/backups`.
- An app rollback that crosses a schema version requires restoring a backup created by the older compatible version. Do not point an older app at a newer database.

## Update verification

1. Use the app's **Check for Updates** command or the official GitHub release page.
2. Confirm the release is not a draft or prerelease unless intentionally using beta.
3. Verify the artifact against `SHA256SUMS.txt`.
4. On macOS, require `spctl` acceptance and a valid stapled ticket. Never bypass quarantine for a production release.
5. Create or confirm a recent database backup before replacing the app.

## Rollback

1. Stop Hive completely.
2. Preserve the current database and logs.
3. If the schema did not change, reinstall the previously verified signed app.
4. If the schema changed, restore a compatible pre-update backup with `npm run db:restore -- <backup-name> --confirm-stopped` before launching the older app.
5. Run the database integrity check and `/readyz` smoke test.

## Support diagnostics

Settings → Advanced → Maintenance actions → **Support Diagnostics** downloads a JSON report containing versions, schema and integrity state, queue counts, integration states, and recent redacted warnings/errors. It deliberately excludes database rows, prompts, filesystem paths, endpoint URLs, request headers, and credential values. Review the file before sharing it.
