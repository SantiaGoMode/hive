#!/usr/bin/env bash
# Start the Hive LLM gateway (LiteLLM + Postgres in Docker), detached.
#
# Real provider keys (and, once enabled, LITELLM_MASTER_KEY) are injected as
# container env by scrt4 at launch and never touch the host DB/disk or Hive's
# process. The compose stack now waits for Postgres to be healthy before LiteLLM
# starts, which can exceed scrt4's ~10s CLI timeout — so we launch through the
# detached helper (returns exit 0 immediately; compose-up finishes in the
# background, logs to ~/.hive/hive-gateway.log).
#
#   start (spend tracking off):  scrt4 run 'OPENAI_API_KEY=$env[OPENAI_API_KEY] \
#            ANTHROPIC_API_KEY=$env[ANTHROPIC_API_KEY] GEMINI_API_KEY=$env[GEMINI_API_KEY] \
#            /Users/crissantiago/Documents/AI/hive/gateway/run-gateway.sh'
#   start (spend tracking on):   add  LITELLM_MASTER_KEY=$env[LITELLM_MASTER_KEY]  to the
#            prefix above (requires the master_key line uncommented in litellm.config.yaml).
#   logs:  docker logs -f hive-llm-gateway   |   tail -f ~/.hive/hive-gateway.log
#   stop:  ./gateway/stop-gateway.sh
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
exec "$ROOT/scripts/spawn-detached.sh" hive-gateway -- docker compose -f "$DIR/docker-compose.yml" up -d