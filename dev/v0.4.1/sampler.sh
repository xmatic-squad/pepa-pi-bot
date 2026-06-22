#!/usr/bin/env bash
# Live-eval sampler for pepa-pi-bot. Runs ONE chunk then exits (so the agent is
# re-invoked between chunks to checkpoint + decide intervention).
# Args: $1=chunk-number  $2=duration-seconds(default 300)  $3=sample-interval-seconds(default 30)
# READ-ONLY: only reads bot state/logs; never writes into the bot's state dir.
set -u
D=/Users/timmy/Projects/pepa-pi-bot/state/play.xmatic.team_25565
OUT=/Users/timmy/Projects/pepa-pi-bot/dev/v0.4.1/samples-2026-05-29.log
CHUNK="${1:-0}"
DUR="${2:-300}"
INT="${3:-30}"
LOG="$D/logs/$(date -u +%F).log"
WJ="$D/world-journal.jsonl"

wjcount() { wc -l < "$WJ" 2>/dev/null | tr -d ' '; }
WJ_BASE="$(wjcount)"; WJ_BASE="${WJ_BASE:-0}"

task_line() {
  node -e '
    const fs=require("fs");
    try{
      const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const p=t.position? [t.position.x,t.position.y,t.position.z].map(n=>Math.round(n)).join(","):"?";
      process.stdout.write(`label=${t.label||"?"} status=${t.status||"?"} pos=(${p}) ts=${t.ts||"?"}`);
    }catch(e){ process.stdout.write("label=? (no current-task)"); }
  ' "$D/current-task.json" 2>/dev/null
}

end=$(( $(date +%s) + DUR ))
{
  echo ""
  echo "########## CHUNK ${CHUNK} START $(date -u +%FT%TZ) (dur=${DUR}s int=${INT}s wj_base=${WJ_BASE}) ##########"
} >> "$OUT"

while :; do
  now=$(date +%s); [ "$now" -ge "$end" ] && break
  TS=$(date -u +%FT%TZ)
  CT="$(task_line)"
  HB=$(grep -aE 'reflex: idle: hp=' "$LOG" 2>/dev/null | tail -1 | sed -E 's/.*reflex: idle: //')
  DISP=$(grep -aE 'dispatch: (\xe2\x86\x92|\xe2\x86\x90|->|<-)|skill: .* (\xe2\x86\x92|->) ' "$LOG" 2>/dev/null | tail -1 | sed -E 's/^([0-9T:.-]+Z) \[[a-z]+\] //')
  STK=$(grep -aE 'pathfinder: stuck|wedged:|Digging aborted|stuck_in_place|no_progress|Took to long|silent_dig' "$LOG" 2>/dev/null | tail -1 | sed -E 's/^([0-9T:.-]+Z) \[[a-z]+\] //')
  CONN=$(grep -aE 'mc: kicked|mc: connection ended|mc: spawned at|runtime: pepa runtime starting|child exited|died|respawn|disabled via PEPA_AUTO_IMPROVE|auto-improve: watching' "$LOG" 2>/dev/null | tail -1 | sed -E 's/^([0-9T:.-]+Z) \[[a-z]+\] //')
  WJN="$(wjcount)"; WJN="${WJN:-0}"
  WJL=$(tail -1 "$WJ" 2>/dev/null)
  {
    echo "--- ${TS} (chunk ${CHUNK}) ---"
    echo "  task : ${CT}"
    echo "  hb   : ${HB:-<none>}"
    echo "  disp : ${DISP:-<none>}"
    echo "  stuck: ${STK:-<none>}"
    echo "  wj   : lines=${WJN} delta=$(( WJN - WJ_BASE )) last=${WJL:-<none>}"
    echo "  conn : ${CONN:-<none>}"
  } >> "$OUT"
  now=$(date +%s); rem=$(( end - now ))
  [ "$rem" -le 0 ] && break
  if [ "$rem" -lt "$INT" ]; then sleep "$rem"; else sleep "$INT"; fi
done

echo "########## CHUNK ${CHUNK} DONE $(date -u +%FT%TZ) (wj_now=$(wjcount)) ##########" >> "$OUT"
