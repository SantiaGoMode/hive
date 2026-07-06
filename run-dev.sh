#!/usr/bin/env bash
# Launch the Hive dev server (server + client via `npm run dev`) DETACHED. The
# server keeps running after this script returns exit 0, which lets login items
# or secret-injecting launch wrappers hand off quickly while Hive stays running.
#
#   start:  ./run-dev.sh
#   logs:   tail -f ~/.hive/hive-dev.log
#   stop:   ./stop-dev.sh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1
exec "$DIR/scripts/spawn-detached.sh" hive-dev -- npm run dev
