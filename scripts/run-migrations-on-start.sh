#!/bin/sh
set -e
if [ -n "$DATABASE_URL" ]; then
  node scripts/run-migrations.js
fi
exec node src/index.js
