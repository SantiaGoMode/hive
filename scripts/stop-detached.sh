#!/usr/bin/env bash
# stop-detached.sh NAME
# Stop a process group started by spawn-detached.sh, using its pidfile.
set -u

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "usage: stop-detached.sh NAME" >&2
  exit 2
fi

RUNDIR="${HIVE_RUNDIR:-$HOME/.hive}"
PIDFILE="$RUNDIR/$NAME.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "[$NAME] no pidfile ($PIDFILE); nothing to stop"
  exit 0
fi

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [ -z "${PID:-}" ]; then
  echo "[$NAME] empty pidfile; removing"
  rm -f "$PIDFILE"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill -TERM "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
  kill -KILL "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
  echo "[$NAME] stopped (pgid $PID)"
else
  echo "[$NAME] not running (stale pid $PID)"
fi
rm -f "$PIDFILE"
exit 0
