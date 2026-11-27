#!/bin/bash
# Started by pm2 on the server. Secrets live in /etc/keel/keel.env (chmod 600), never in the repo.
cd "$(dirname "$0")/.."
set -a; . /etc/keel/keel.env; set +a
export KEEL_DATA_DIR="${KEEL_DATA_DIR:-/opt/keel/data}"
exec node src/bot.mjs
