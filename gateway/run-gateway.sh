#!/usr/bin/env bash
# Start the Hive LLM gateway (LiteLLM + Postgres in Docker), detached.
#
# Real provider keys (and, once enabled, LITELLM_MASTER_KEY) are injected as
# container env at launch and never touch the host DB/disk or Hive's
# process. The compose stack now waits for Postgres to be healthy before LiteLLM
# starts, so we launch through the detached helper (returns exit 0 immediately;
# compose-up finishes in the background, logs to ~/.hive/hive-gateway.log).
#
#   start: gateway/run-gateway.sh
#   spend tracking: expose LITELLM_MASTER_KEY before starting and uncomment the
#            master_key line in litellm.config.yaml.
#   logs:  docker logs -f hive-llm-gateway   |   tail -f ~/.hive/hive-gateway.log
#   stop:  ./gateway/stop-gateway.sh
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
exec "$ROOT/scripts/spawn-detached.sh" hive-gateway -- docker compose -f "$DIR/docker-compose.yml" up -d
