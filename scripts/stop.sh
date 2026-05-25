#!/usr/bin/env bash
# Emergency stop: find any pepa-pi-bot supervisor/child processes plus any
# straggler TCP connection to the configured MC server, and terminate them.
# Useful when a smoke-test or a crashed instance left the nickname locked.

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ looking for supervisor + bot processes…"
PIDS=$(pgrep -f "$REPO_ROOT/runtime/(supervisor|bot)\.js" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "  killing: $PIDS"
  echo "$PIDS" | xargs kill -TERM 2>/dev/null || true
  sleep 2
  PIDS=$(pgrep -f "$REPO_ROOT/runtime/(supervisor|bot)\.js" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "  still alive after TERM, sending KILL: $PIDS"
    echo "$PIDS" | xargs kill -KILL 2>/dev/null || true
  fi
else
  echo "  none found"
fi

echo "→ cleaning pidfile + bot.sock…"
find "$REPO_ROOT/state" -name "supervisor.pid" -delete 2>/dev/null || true
find "$REPO_ROOT/state" -name "bot.sock" -delete 2>/dev/null || true

echo "→ done. Wait ~30s for the MC server to drop the old session before re-launching."
