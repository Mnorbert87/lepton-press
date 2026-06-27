#!/usr/bin/env bash
# Lepton Press — end-to-end demo on Arc testnet.
# Boots the publisher, runs the autonomous reader against it, tears the publisher down.
# Requires a funded SERVER_PRIVATE_KEY + AGENT_PRIVATE_KEY in .env (burner keys only).
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "Missing .env — copy .env.example and fill burner keys."; exit 1; }
set -a; . ./.env; set +a
: "${SERVER_PRIVATE_KEY:?Set SERVER_PRIVATE_KEY in .env}"
: "${AGENT_PRIVATE_KEY:?Set AGENT_PRIVATE_KEY in .env}"

PORT="${PORT:-4030}"
[ -d node_modules ] || npm install --silent

echo "▶ starting publisher on :$PORT"
node server.js &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
# Wait for the publisher to answer before the agent browses.
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$PORT/article/${ARTICLE:-arc-nanopayments}" >/dev/null 2>&1 && break
  sleep 0.3
done

echo "▶ running autonomous reader"
SERVER_URL="http://localhost:$PORT" node reader.js

echo "▶ publisher revenue ledger"
curl -s "http://localhost:$PORT/stats"
echo
