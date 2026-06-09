#!/usr/bin/env bash
# Launch the Hive dev server (server + client via `npm run dev`) DETACHED, so it
# can be started through `scrt4 run` without tripping scrt4's ~10s CLI timeout.
# The server keeps running after this script returns exit 0.
#
#   start:  scrt4 run '<env prefixes> /path/to/run-dev.sh'
#   logs:   tail -f ~/.hive/hive-dev.log
#   stop:   ./stop-dev.sh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
exec "$DIR/scripts/spawn-detached.sh" hive-dev -- npm run dev
