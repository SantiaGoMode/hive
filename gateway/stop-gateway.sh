#!/usr/bin/env bash
# Stop the Hive LLM gateway container.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
exec docker compose -f "$DIR/docker-compose.yml" down
