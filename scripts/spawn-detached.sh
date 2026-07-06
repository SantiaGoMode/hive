#!/usr/bin/env bash
# spawn-detached.sh NAME -- CMD [ARGS...]
#
# Launch a long-running CMD detached so wrappers, login items, and terminal
# sessions can return quickly while CMD keeps running.
#
# macOS has no `setsid`, so we enable bash monitor mode (`set -m`) to put the
# background job in its OWN process group (PGID == the job's PID). That lets
# stop-detached.sh signal the whole tree as a group later.
#
# Logs -> $HIVE_RUNDIR/NAME.log   PID/PGID -> $HIVE_RUNDIR/NAME.pid
set -u

NAME="${1:-}"; shift || true
[ "${1:-}" = "--" ] && shift
if [ -z "$NAME" ] || [ "$#" -eq 0 ]; then
  echo "usage: spawn-detached.sh NAME -- CMD [ARGS...]" >&2
  exit 2
fi

RUNDIR="${HIVE_RUNDIR:-$HOME/.hive}"
mkdir -p "$RUNDIR"
LOG="$RUNDIR/$NAME.log"
PIDFILE="$RUNDIR/$NAME.pid"

# If a previous instance is still alive, stop its process group first.
if [ -f "$PIDFILE" ]; then
  OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
    kill -TERM "-$OLD" 2>/dev/null || kill -TERM "$OLD" 2>/dev/null || true
    sleep 1
    kill -KILL "-$OLD" 2>/dev/null || true
  fi
fi

# Monitor mode: the next backgrounded job becomes its own process-group leader.
set -m
nohup "$@" >"$LOG" 2>&1 &
PGID=$!
set +m

echo "$PGID" >"$PIDFILE"
disown 2>/dev/null || true
echo "[$NAME] started (pgid $PGID) -> $LOG"
exit 0
