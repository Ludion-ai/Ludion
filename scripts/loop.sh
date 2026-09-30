#!/usr/bin/env bash
# Unattended outer loop (optional). Each iteration is a fresh Claude Code session; memory lives in
# files (STATE.md, git, the ratchet). Stops when nothing autonomous is left, or when the PASS count
# has not moved for $STALL iterations (stagnation means a human should look).
#   MAX=10 STALL=3 npm run loop
# Tip: in dontAsk mode, Bash with $VAR expansion may be denied (anthropics/claude-code#51001);
# keep repeatable actions behind npm scripts so the allow list matches cleanly.
set -uo pipefail
MAX=${MAX:-10}; STALL=${STALL:-3}; TURNS=${TURNS:-150}
mkdir -p .loop
prev=-1; stuck=0
for i in $(seq 1 "$MAX"); do
  node scripts/scoreboard.mjs --json > .loop/score.json 2>/dev/null || true
  pass=$(node -p 'require("./.loop/score.json").pass')
  todo=$(node -p 'require("./.loop/score.json").autonomous')
  echo "[loop $i/$MAX] pass=$pass autonomous_todo=$todo"
  if [ "$todo" -le 0 ]; then echo "nothing autonomous left — see docs/STATE.md 人間待ち"; break; fi
  if [ "$pass" -le "$prev" ]; then stuck=$((stuck + 1)); else stuck=0; fi
  if [ "$stuck" -ge "$STALL" ]; then echo "no progress in $STALL iterations — human look needed"; break; fi
  prev=$pass
  LUDION_LOOP=1 claude -p "$(cat .claude/loop-prompt.md)" \
    --settings .claude/settings.json --permission-mode dontAsk --max-turns "$TURNS" \
    --output-format stream-json --verbose > ".loop/iter-$i.jsonl" 2>&1
  git log -1 --oneline
done
