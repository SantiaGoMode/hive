# Colony compatibility retirement plan

Hive uses the append-only `colony_run_events` stream as the sole run replay and audit source. Migration 27 transactionally copied pre-durable `colonies.log` entries into that stream and emptied the old column. The column remains in the schema only so older backups and downgrade tooling retain a compatible table shape; version 27+ has no runtime reader or writer for it.

## Inventory

| Compatibility path | Current reader/writer | Evidence and migration gate | Removal target |
|---|---|---|---|
| `colonies.log` projection | **Retired in schema 27.** Migration-only reader in `server/lib/migrations.js`; no runtime writer or fallback reader | Migration test proves ordered preservation, one-time execution, and projection clearing; diagnostics now report event-stream coverage only | Remove the empty compatibility column in a future explicit schema-compaction release |
| Direct `POST /api/colony` launch | `server/routes/colony/lifecycle.js` and `shared.js`; retained for API clients/tests | Compare direct launches with claimed `colony_work_items.run_id` coverage before changing | Keep as supported API until queue-origin runs meet the product target; then version/deprecate rather than silently delete |
| Per-run `trigger_config` | Read/written in `server/routes/colony/runs.js`; team routing is handled by `workRouter.js` | Inventory rows with non-null `trigger_config` before migration to standing orders/team routes | Migrate populated rows to team routing, then remove only after a release with zero reads |
| Legacy role/name inference | Fallbacks in `colonyRecipes.js`, `colonyModels.js`, `colony/seeding.js`, and Colony MCP wiring | Every seeded/runtime role must have an explicit stable `role_key`; tests must prove catalog coverage | Remove individual fallbacks only as each recipe family reaches complete role-key coverage |

## Rules

- Do not delete compatibility code based on age or naming alone.
- Every removal needs a persisted-data query, a migration or explicit preservation decision, and a regression test. The log projection retirement satisfies this through migration 27 and `server/tests/migrations.test.js`.
- Diagnostics report counts only; it never includes goals, prompts, logs, repository paths, or other user content.
- Schema and API removals require release notes and a rollback-compatible backup.
