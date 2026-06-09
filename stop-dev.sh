#!/usr/bin/env bash
# Stop the detached Hive dev server started by run-dev.sh.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/scripts/stop-detached.sh" hive-dev
