#!/bin/bash
# Copy the receipts the live bot wrote on the server into receipts/telegram/, then re-verify and rebuild the dashboard.
# Usage: KEEL_HOST=root@your-server scripts/pull-receipts.sh
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${KEEL_HOST:?set KEEL_HOST=user@server}"
mkdir -p receipts/telegram
scp -q -o BatchMode=yes "$HOST:/opt/keel/data/receipts/*" receipts/telegram/ 2>/dev/null || echo "no server receipts yet"
node scripts/verify-receipts.mjs
node scripts/dashboard.mjs
