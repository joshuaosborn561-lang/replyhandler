#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# setup.sh — Stand up ReplyHandler on Railway in one command.
#
# Prerequisites:
#   1. Railway CLI installed  (npm i -g @railway/cli)
#   2. Authenticated           (railway login)
#   3. A .env file in this directory with all required variables filled in
#      (copy .env.example → .env and edit)
#
# Usage:
#   chmod +x setup.sh && ./setup.sh
# ──────────────────────────────────────────────────────────────────────

REQUIRED_VARS=(
  GEMINI_API_KEY
  SLACK_SIGNING_SECRET
  LEADMAGIC_API_KEY
  CALCOM_API_KEY
)

# ─── Preflight checks ────────────────────────────────────────────────
if ! command -v railway &>/dev/null; then
  echo "❌  Railway CLI not found. Install it:  npm i -g @railway/cli"
  exit 1
fi

if ! railway whoami &>/dev/null; then
  echo "❌  Not logged in to Railway. Run:  railway login"
  exit 1
fi

if [ ! -f .env ]; then
  echo "❌  No .env file found. Copy .env.example → .env and fill in your values."
  exit 1
fi

# Source .env
set -a
source .env
set +a

# Validate required vars are set and non-empty
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "❌  Missing required environment variables in .env:"
  printf "   • %s\n" "${MISSING[@]}"
  exit 1
fi

echo "✅  Preflight checks passed."
echo ""

# ─── Create Railway project ──────────────────────────────────────────
echo "🚀  Creating Railway project: replyhandler"
railway init --name replyhandler
echo ""

# ─── Provision Postgres ──────────────────────────────────────────────
echo "🗄️   Provisioning Postgres database..."
railway add --plugin postgresql
echo ""

# Wait for the plugin to be ready and DATABASE_URL to be injected
echo "⏳  Waiting for Postgres to be ready..."
sleep 5

# ─── Set environment variables ───────────────────────────────────────
echo "🔐  Setting environment variables..."
for var in "${REQUIRED_VARS[@]}"; do
  railway variables set "$var=${!var}"
done
echo ""

# ─── Run database schema ─────────────────────────────────────────────
echo "📋  Running schema.sql against Railway Postgres..."
railway run psql \$DATABASE_URL -f schema.sql
echo ""

# ─── Deploy ──────────────────────────────────────────────────────────
echo "🚢  Deploying to Railway..."
railway up --detach
echo ""

# ─── Print summary ───────────────────────────────────────────────────
echo "──────────────────────────────────────────────────"
echo "✅  ReplyHandler deployed to Railway!"
echo ""
echo "Next steps:"
echo "  1. Open the Railway dashboard to find your public domain"
echo "     (Settings → Networking → Generate Domain)"
echo "  2. Set the Slack interactivity URL to:"
echo "     https://<your-domain>/slack/actions"
echo "  3. Create your first client:"
echo ""
echo "     curl -X POST https://<your-domain>/admin/clients \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"name\": \"My Client\", \"slack_bot_token\": \"xoxb-...\", \"slack_channel_id\": \"C...\"}'"
echo ""
echo "  4. Paste the returned webhook URLs into SmartLead and HeyReach."
echo "──────────────────────────────────────────────────"
