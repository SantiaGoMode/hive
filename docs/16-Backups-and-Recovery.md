---
layout: guide
title: Backups and recovery
description: Protect Hive state, verify database integrity, restore safely, and understand update compatibility.
permalink: /docs/backups-and-recovery/
section: Operations
previous_url: /docs/guides/automation/
previous_label: Automate a workflow
next_url: /docs/troubleshooting/
next_label: Troubleshooting
---

Hive stores its operational state in SQLite and creates protected online backups under `~/.hive/backups` by default.

## What to protect

- `~/.hive/hive.db` — configuration and operational records
- `~/.hive/agents/` — agent memory and conversation state
- `~/.hive/shared/` — shared workspace memory
- your environment or secret manager configuration

Do not copy a live SQLite database as a substitute for Hive’s online backup mechanism.

## Backup policy

Hive creates a backup every 24 hours and retains seven by default. Configure `HIVE_BACKUP_INTERVAL_HOURS` and `HIVE_BACKUP_RETENTION` before launch if you need a different policy. Copy protected backups to another trusted device if the Hive host itself is a single point of failure.

## Integrity check

Use **Settings → Advanced → Maintenance actions** or the database integrity endpoint to check SQLite health. Run a check before a major upgrade and whenever the host has suffered an abrupt shutdown or disk problem.

## Restore a backup

1. Stop every Hive desktop and server process.
2. Identify the backup name under `~/.hive/backups`.
3. Run:

```bash
npm run db:restore -- <backup-name> --confirm-stopped
```

The utility validates the selected backup and preserves the current database before replacing it. Start Hive, run the integrity check, and inspect recent agents and runs.

## Updates and schema compatibility

Database migrations are forward-only. An older Hive build refuses to open a database whose schema is newer than it supports. A safe rollback therefore means restoring both:

- the older application build
- a backup created before the newer schema migration

Do not repeatedly launch old and new versions against the same state directory.

## Support diagnostics

Download a redacted report from **Settings → Advanced → Maintenance actions**. It excludes prompts, stored rows, paths, URLs, headers, and credential values. Attach it to an issue with the Hive version, operating system, reproduction steps, and relevant timestamps.
