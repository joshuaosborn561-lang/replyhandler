#!/usr/bin/env sh
set -e
cd "$(dirname "$0")/.."
if [ -n "${DATABASE_URL:-}" ] && ! echo "${SKIP_DB_MIGRATIONS:-}" | grep -qiE '^(1|true|yes|on)$'; then
  echo "[Start] DB bootstrap (empty DB only)..."
  node scripts/apply-schema-to-db.js
  echo "[Start] Incremental migrations (002–010, tracked)..."
  node scripts/run-migrations.js
else
  echo "[Start] Skipping DB migrations (no DATABASE_URL or SKIP_DB_MIGRATIONS set)"
fi
exec node src/index.js
