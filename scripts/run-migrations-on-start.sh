#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[Start] Running DB migrations..."
  node scripts/run-migrations.js
else
  echo "[Start] DATABASE_URL unset; skipping migrations"
fi
exec node src/index.js
