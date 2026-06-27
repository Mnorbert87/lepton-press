#!/usr/bin/env bash
# Lepton Press — traction run. Boots the publisher ONCE, then runs the autonomous
# reader many times with varied task/article/budget to generate a real, diverse
# on-chain nano-settlement ledger for the submission. Strictly sequential (the
# reader reuses one nonce — no parallelism).
set -uo pipefail
cd "$(dirname "$0")"

set -a; . ./.env; set +a
: "${SERVER_PRIVATE_KEY:?}" "${AGENT_PRIVATE_KEY:?}"

PORT="${PORT:-4030}"
ROUNDS="${ROUNDS:-48}"
LOG="runs/TRACTION_$(node -e 'process.stdout.write(String(Math.floor(Date.now()/1000)))').log"
mkdir -p runs
[ -d node_modules ] || npm install --silent

echo "▶ booting publisher on :$PORT"
node server.js > runs/publisher.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/article/arc-nanopayments" >/dev/null 2>&1 && break
  sleep 0.3
done

# (article, task) pairs — tasks matched to each article's actual content.
A1=("why can card networks not serve micropayments, and what changes it" \
    "how do stablecoins on a settlement-first chain change payment economics" \
    "who are the first buyers of nanopaid content and why" \
    "what does a publisher need to charge a machine per paragraph" \
    "why does the card fee floor make the long tail of writing invisible")
A2=("how does an autonomous reader decide which paragraph to pay for" \
    "why is streaming payment per second better than charging per article" \
    "what can a publisher learn from per-transaction reading data")
BUDGETS=(0.010 0.020 0.030 0.040 0.050)
GIVEUPS=(2 3)

echo "▶ $ROUNDS sequential reader rounds → $LOG"
ok=0; fail=0
for i in $(seq 1 "$ROUNDS"); do
  if (( i % 2 == 0 )); then ART="arc-nanopayments"; T="${A1[$(( (i/2) % ${#A1[@]} ))]}";
  else ART="agent-reading-economics"; T="${A2[$(( (i/2) % ${#A2[@]} ))]}"; fi
  B="${BUDGETS[$(( i % ${#BUDGETS[@]} ))]}"
  G="${GIVEUPS[$(( i % ${#GIVEUPS[@]} ))]}"
  echo "── round $i/$ROUNDS  article=$ART budget=$B giveup=$G" | tee -a "$LOG"
  if SERVER_URL="http://localhost:$PORT" ARTICLE="$ART" TASK="$T" BUDGET_USDC="$B" GIVE_UP="$G" \
       node reader.js >> "$LOG" 2>&1; then
    ok=$((ok+1))
  else
    fail=$((fail+1)); echo "   ! round $i failed (see $LOG)" | tee -a "$LOG"
    # one retry after a short backoff for transient RPC/nonce hiccups
    sleep 4
    if SERVER_URL="http://localhost:$PORT" ARTICLE="$ART" TASK="$T" BUDGET_USDC="$B" GIVE_UP="$G" \
         node reader.js >> "$LOG" 2>&1; then ok=$((ok+1)); fail=$((fail-1)); echo "   ✓ retry ok" | tee -a "$LOG"; fi
  fi
done

echo "▶ final ledger (/stats)"
curl -s "http://localhost:$PORT/stats" | tee runs/STATS_final.json
echo
echo "── DONE: $ok ok, $fail failed.  log=$LOG  stats=runs/STATS_final.json"
