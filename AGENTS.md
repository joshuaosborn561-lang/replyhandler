# AGENTS.md

See `CLAUDE.md` for the load-bearing product/pipeline rules (reply flow,
suppression policy, draft provider order, follow-up cadence, deployment).
See `README.md` for full setup, API endpoints, and integration docs. This file
only adds Cursor Cloud environment notes.

## Cursor Cloud specific instructions

Node.js + Express service (`replyhandler`). Node 22, npm. There is **no lint
step** (only `start`, `dev`, `test` scripts in `package.json`).

- Dependencies: `npm install` (run automatically by the startup update script).
- Tests: `npm test` — Node's built-in runner over `test/*.test.js`. These are
  pure module/guard checks with **no DB and no network**, so they run anywhere.
  CI (`.github/workflows/ci.yml`) also runs a module-load smoke check:
  `node -e "require('./src/routes/webhooks');require('./src/routes/slack');require('./src/cron');require('./src/services/follow-up-runner');require('./src/services/booking-check')"`.
- Run dev server: `npm run dev` (`node --watch src/index.js`), production
  `npm start`. Serves on `PORT` (default 3000); dashboard UI at `/dashboard`.

### Postgres is required to boot, and start is per-boot

`src/index.js` calls `assertDatabaseReady()` before listening: if `DATABASE_URL`
is unset/unreachable or the schema is missing, the process **exits 1** (it does
not serve). Postgres 16 is installed in the environment, but the server process
does not survive a reboot — start it each boot before running the app:

```
sudo pg_ctlcluster 16 main start
```

The app does **not** load `.env` (no `dotenv` dependency). Export env vars in the
shell that runs the app. Local dev connection string used during setup:

```
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/replyhandler"
```

Apply schema to a fresh DB with the repo's own scripts (idempotent; safe to
re-run): `node scripts/apply-schema-to-db.js` then `node scripts/run-migrations.js`.
The `replyhandler` database and applied schema persist in the environment
snapshot across boots — only the Postgres server process and env exports need to
be re-established.

### External integrations are unconfigured locally

Gemini, Claude/Anthropic, Slack, SmartLead, HeyReach, and enrichment providers
have no API keys in this environment and log `not configured` at startup — this
is expected. The core client-management API (`/admin/clients`), webhook-URL
routing, `/health`, and the `/dashboard` UI all work without them. To exercise
Slack card rendering without live outbound APIs, set `WEBHOOK_TEST_SECRET` and
use `POST /admin/test/slack-draft/:clientId` (see README).
