#!/usr/bin/env bash
# Launch the Hive dev server (server + client via `npm run dev`) DETACHED. The
# server keeps running after this script returns exit 0 — which also lets it be
# started through secret-injecting wrappers with short CLI timeouts (e.g.
# `scrt4 run '<env prefixes> /path/to/run-dev.sh'`).
#
#   start:  ./run-dev.sh
#   logs:   tail -f ~/.hive/hive-dev.log
#   stop:   ./stop-dev.sh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
exec "$DIR/scripts/spawn-detached.sh" hive-dev -- npm run dev
