# ReplyHandler

Automated prospect reply handling for B2B outbound campaigns. Processes inbound replies from SmartLead (email) and HeyReach (LinkedIn), classifies them with Gemini 2.5 Flash, drafts responses in each client's voice, and routes them through Slack for one-tap approval.

## Architecture

```
SmartLead Webhook ──┐
                    ├─→ Classify (Gemini) ─→ Slack Approval ─→ Send Reply
HeyReach Webhook ──┘                            │
                                                 ├─→ SmartLead (email)
                                                 ├─→ HeyReach (LinkedIn)
                                                 └─→ Scheduling link in draft (e.g. Calendly) + optional Google/Microsoft calendar booking after approval
```

## Setup

### 1. Provision the Database

Create a Postgres database and run the schema:

```bash
createdb replyhandler
psql replyhandler < schema.sql
```

Or on Railway, provision a Postgres plugin and apply the base schema once (required before the app can migrate):

```bash
railway run psql $DATABASE_URL < schema.sql
```

After that, each deploy runs `scripts/apply-schema-to-db.js` (empty DB only: full `schema.sql` + migrations) then `scripts/run-migrations.js` (incremental 002–020, tracked in `schema_migrations`). Set `SKIP_DB_MIGRATIONS=1` only if you intentionally manage SQL by hand.

**Backups and avoiding data loss:** This app never deletes `clients` rows. If client rows vanish, the Postgres **volume was reset or a new database was attached** (e.g. recreating the Postgres service in Railway). Mitigations: enable **Railway Postgres backups** in the dashboard (plan-dependent); avoid detaching/recreating the Postgres plugin; periodically run `pg_dump` off-platform, e.g. `railway run --service <App> pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql` (use the app service so `DATABASE_URL` points at your data). Client API keys must be **re-entered** after a restore if you only have SQL dumps without secrets elsewhere.

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GEMINI_API_KEY` | Google Gemini API key for classification and 768-dimensional retrieval embeddings |
| `SUPABASE_URL` | Supabase project URL containing synced SmartLead `messages` and the `reply_examples` corpus |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key for retrieval and feedback writes |
| `ANTHROPIC_API_KEY` | Anthropic API key; Claude Sonnet 5 drafts replies from retrieved manual examples |
| `ANTHROPIC_REPLY_MODEL` | Optional drafting model override (default `claude-sonnet-5`) |
| `GEMINI_EMBEDDING_MODEL` | Optional embedding override (default `gemini-embedding-001`; `text-embedding-004` retired Jan 2026) |
| `SLACK_SIGNING_SECRET` | From your Slack app's Basic Information page |
| `WEBHOOK_TEST_SECRET` | Required in production. Protects `/dashboard`, client CRUD, OAuth admin routes, and `/admin/test/*`. First browser visit: `/dashboard?secret=...` |
| `DEFAULT_BOOKING_TIMEZONE` | Optional. IANA zone for labeling verified slots (default `America/New_York`) |
| `FOLLOW_UP_HOURS` | Hours after an unanswered approved send before posting a follow-up approval card (default `3`) |
| `FOLLOW_UP_MAX_AGE_HOURS` | Retire overdue follow-ups instead of replaying a backlog (default `24`) |
| `HEYREACH_POLL_ENABLED` | Optional. Backstop poller for HeyReach inbox replies if webhooks are late/missed (default `true`) |
| `HEYREACH_POLL_MINUTES` | Optional. Poll interval in minutes (default `3`) |
| `HEYREACH_POLL_LOOKBACK_HOURS` | Optional. How far back the poller scans recent conversations (default `168`) |
| `HEYREACH_POLL_CLIENTS_JSON` | Optional fallback client JSON if DB `clients` rows are unavailable. Prefer restoring clients in Postgres. |
| `AFTERNOON_DIGEST_TIMEZONE` | Optional. Timezone for the afternoon attention digest (default `America/Chicago`) |
| `AFTERNOON_DIGEST_HOUR` | Optional. 24h local hour for afternoon attention digest (default `15`, i.e. 3pm) |
| `GETLEADS_API_KEY` | First provider in the inbound cellphone enrichment waterfall |
| `AIARK_API_KEY` | Second provider in the inbound cellphone enrichment waterfall |
| `LEADMAGIC_API_KEY` | LeadMagic API key — LinkedIn→email + mobile-finder fallback |
| `ENRICH_PROVIDER_TIMEOUT_MS` | Per-provider phone enrichment timeout (default `8000`) |
| `SMARTLEAD_MASTER_API_KEY` | Account-wide key for targeted sends, interested sweep, and explicitly routed recovery polling |
| `SMARTLEAD_MASTER_POLL_ENABLED` | Enable the account-wide recovery pass (default on when master key exists) |
| `ALLO_API_KEY` | Allo call transcript access for booking detection |
| `CUBE_ACR_DRIVE_FOLDER_ID` | Google Drive root containing Cube ACR call recordings |
| `PORT` | Server port (default: 3000) |
| `RAILWAY_PUBLIC_DOMAIN` | Set automatically by Railway |

Each client may store an optional **`calendly_personal_access_token`**. When their **booking link** is a Calendly URL and a PAT is set, the server uses Calendly’s API to fetch **real** open times. For other schedulers (Cal.com, SavvyCal, etc.), you can connect Google or Outlook for free/busy. Without calendar access, follow-up suppression uses the conversation and call transcripts as its best guess; a merely `proposed` meeting row is not treated as booked.

### Manual-reply retrieval corpus

Apply `supabase/migrations/001_reply_examples.sql` in the Supabase SQL editor,
then backfill:

```bash
SUPABASE_URL=... \
SUPABASE_SERVICE_ROLE_KEY=... \
GEMINI_API_KEY=... \
node scripts/backfill-reply-examples.js
```

The backfill uses the structural SmartLead signal only:
`direction = 'outbound' AND sequence_number IS NULL`. Scheduled sequence steps
are excluded regardless of their wording. It logs total outbound, qualifying
manual, inserted, skipped, and failed counts. After deployment, approved or
edited SmartLead replies are added to the corpus automatically. Gemini performs
embedding/retrieval; Claude Sonnet 5 writes the actual draft.

**If the dashboard PATCH fails with `column "booking_link" does not exist`:** your Postgres was never migrated from Cal.com. Run `migrations/005_booking_link_safe.sql` once (adds `booking_link` if missing; renames `calcom_event_type_id` only when that column still exists). From a machine with Node: `railway run -s Postgres sh -c 'export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${POSTGRES_DB}" && cd /path/to/repo && npm ci && node scripts/run-sql-file.js migrations/005_booking_link_safe.sql'` or run the SQL in Railway’s Postgres query UI.

**Follow-ups:** the dedicated runner posts an approval card after 3 unanswered hours and checks reply context, confirmed/booked rows, calendar (when connected), Allo, and Cube ACR first. Attention digests are separate and off by default; set `ATTENTION_DIGESTS_ENABLED=1` for morning and 3pm summaries.

### 3. Install and Run

```bash
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Adding a New Client

Use the admin API to create a client. This returns webhook URLs ready to paste into SmartLead and HeyReach.

```bash
curl -X POST https://your-app.up.railway.app/admin/clients \
  \
  -H "Content-Type: application/json" \
  -H "x-webhook-test-secret: $WEBHOOK_TEST_SECRET" \
  -d '{
    "name": "Acme Corp",
    "smartlead_api_key": "sl_key_abc123",
    "heyreach_api_key": "hr_key_def456",
    "slack_bot_token": "xoxb-your-slack-bot-token",
    "slack_channel_id": "C0123456789",
    "calcom_event_type_id": "123456",
    "voice_prompt": "Direct, no-nonsense tone. Speak like a fellow practitioner, not a salesperson. Never use filler phrases like \"great question\" or \"thanks for reaching out\". Keep replies to 2-3 sentences. End with a soft CTA for a call."
  }'
```

Response includes:

```json
{
  "id": "uuid-here",
  "name": "Acme Corp",
  "smartlead_webhook_url": "https://your-app.up.railway.app/webhook/smartlead/uuid-here",
  "heyreach_webhook_url": "https://your-app.up.railway.app/webhook/heyreach/uuid-here",
  ...
}
```

### List all clients

```bash
curl https://your-app.up.railway.app/admin/clients \
  -H "x-webhook-test-secret: $WEBHOOK_TEST_SECRET"
```

### Update a client

```bash
curl -X PATCH https://your-app.up.railway.app/admin/clients/uuid-here \
  \
  -H "Content-Type: application/json" \
  -H "x-webhook-test-secret: $WEBHOOK_TEST_SECRET" \
  -d '{"voice_prompt": "Updated voice instructions here"}'
```

## Webhook Setup

Each client has **unique** URLs (`/webhook/smartlead/<client-uuid>`, `/webhook/heyreach/<client-uuid>`). Replies are posted to **that client’s** `slack_channel_id` using **their** bot token only after we confirm the event belongs to **their** account:

- **SmartLead:** `GET /api/v1/campaigns/{campaign_id}?api_key=...` must succeed for the client’s key (SmartLead returns 404 if the campaign is not in that account).
- **HeyReach:** we call `POST /api/public/campaign/GetAll` with the client’s key and require the webhook’s `campaignId` to appear in their workspace’s campaign list.

Paste **each client’s** webhook URL only into campaigns that belong to **that** client’s SmartLead/HeyReach workspace (the same API keys you saved in the dashboard). If someone pastes Client A’s URL into Client B’s campaign, events are **skipped** (no Slack noise).

**HeyReach polling backstop:** HeyReach webhooks can occasionally sync late. The app also runs an API poller (default every 3 minutes) that scans each active client's HeyReach inbox using the client-level `heyreach_api_key`, dedupes against `pending_replies`, and posts missed replies to the same Slack approval flow. Webhooks remain the primary path; polling is a safety net.

**SmartLead master recovery:** the account-level inbox is polled once and each
row is routed through `smartlead_campaign_routes`. Unknown/conflicting campaigns
are logged and skipped—never guessed and never posted to every client. Migration
020 seeds unambiguous history; after deploy run
`node scripts/seed-smartlead-campaign-routes.js` once to seed dedicated-key
campaigns.

### SmartLead

1. Go to your SmartLead campaign settings
2. Under **Webhooks**, add a new webhook for "Reply Received"
3. Paste the `smartlead_webhook_url` from the admin API response

### HeyReach

1. Go to your HeyReach campaign settings
2. Under **Webhooks**, add a new webhook for "Message Received"
3. Paste the `heyreach_webhook_url` from the admin API response

HeyReach payloads must include a **campaign id** that matches one of the campaigns returned for that API key. We read `campaignId` / `campaign_id` **or** nested `campaign.id` (common on reply webhooks). Reply text may arrive in `recent_messages` rather than top-level `message`.

## Slack App Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add these bot token scopes:
   - `chat:write` — post messages
   - `chat:write.public` — post to channels the bot isn't in
   - `im:history` — read DM history
   - `im:write` — send DMs
   - `channels:history` — read channel history
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`) — this goes in each client's `slack_bot_token`

### 2. Enable Interactivity

1. Under **Interactivity & Shortcuts**, toggle interactivity ON
2. Set the **Request URL** to: `https://your-app.up.railway.app/slack/actions`
3. This is where Slack sends button and modal events (Approve, Edit & send, Reject)

### 3. Get the Signing Secret

1. Under **Basic Information**, find the **Signing Secret**
2. Set it as the `SLACK_SIGNING_SECRET` environment variable

### 4. Invite the Bot

Invite the Slack bot to each client's approval channel:

```
/invite @YourBotName
```

## Booking Link / Calendar Setup

Store each client's public scheduler URL in `booking_link` (Calendly, Cal.com,
SavvyCal, etc.). For Calendly, an optional personal access token lets the app
retrieve verified slots. Google/Microsoft OAuth is optional; without calendar
access the app proposes reasonable times and decides whether to follow up from
reply/call context rather than pretending a proposal is booked.

## Client Onboarding Checklist (Under 10 Minutes)

1. **Create the Slack channel** — e.g., `#client-acme-replies`
2. **Invite the Slack bot** to the channel
3. **Get the channel ID** — right-click the channel name → "Copy link" → the ID is the last segment
4. **Get client API keys** — SmartLead API key, HeyReach API key from the client's accounts
5. **Set up Cal.com** — create team, event type, get the event type ID
6. **Write the voice prompt** — 2-3 sentences describing how replies should sound for this client
7. **Create the client via admin API** — use the curl command above with all details
8. **Paste webhook URLs** — copy `smartlead_webhook_url` into SmartLead, `heyreach_webhook_url` into HeyReach
9. **Send a test reply** — reply to a test campaign to verify the full flow works
10. **Done** — the client is live

## Reply Classifications

| Classification | Action |
|---|---|
| `INTERESTED` | Claude/RAG draft (Gemini fallback) → Slack approval → send |
| `QUESTION` | Claude/RAG draft (Gemini fallback) → Slack approval → send |
| `OBJECTION` | Claude/RAG draft (Gemini fallback) → Slack approval → send |
| `MEETING_PROPOSED` | Times-first draft; booking link waits until requested |
| `NOT_INTERESTED` | Graceful decline draft, no pitch/times/link |
| `OUT_OF_OFFICE` | Stored as suppressed; no Slack |
| `REMOVE_ME` | Unsubscribe + stored as suppressed; no Slack |
| `WRONG_PERSON` | Stored as suppressed; no Slack |
| `COMPETITOR` | Slack alert only |
| `OTHER` | Draft → Slack approval → send |

## Follow-up Timing

Approval cards are posted once; there are no “you haven’t actioned this”
reminders. After an approved prospect reply goes unanswered for 3 hours, the
app may post a separate prospect-facing follow-up draft after booking checks.

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/webhook/smartlead/:clientId` | None | SmartLead inbound webhook |
| `POST` | `/webhook/heyreach/:clientId` | None | HeyReach inbound webhook |
| `POST` | `/slack/actions` | Slack signature | Button interactions |
| `GET` | `/dashboard` | `WEBHOOK_TEST_SECRET` cookie/query | Admin dashboard |
| `POST` | `/admin/clients` | `WEBHOOK_TEST_SECRET` | Create client |
| `GET` | `/admin/clients` | `WEBHOOK_TEST_SECRET` | List clients |
| `PATCH` | `/admin/clients/:clientId` | `WEBHOOK_TEST_SECRET` | Update client |
| `POST` | `/admin/test/slack-draft/:clientId` | `WEBHOOK_TEST_SECRET` (header `x-webhook-test-secret` or `?secret=`) | Post a fake approval card to Slack (no Gemini / no outbound APIs) |
| `GET` | `/health` | None | Health check |

### Test Slack with a fake thread (no SmartLead/HeyReach)

1. Set `WEBHOOK_TEST_SECRET` in your environment (any long random string).
2. Add the same value when calling the test endpoint so it is not open to the public internet.
3. Example JSON bodies for real webhook smoke tests live in `scripts/fake-webhook-payloads.json`.
4. Post a draft card directly to your approval channel:

```bash
export WEBHOOK_TEST_SECRET='your-secret'
export CLIENT_ID='<uuid from GET /admin/clients>'
curl -sS -X POST "https://your-app.up.railway.app/admin/test/slack-draft/$CLIENT_ID" \
  -H "Content-Type: application/json" \
  -H "x-webhook-test-secret: $WEBHOOK_TEST_SECRET" \
  -d '{"classification":"INTERESTED","leadName":"Slack Test"}'
```

Or run `node scripts/post-test-slack-draft.js` after setting `BASE_URL`, `CLIENT_ID`, and `WEBHOOK_TEST_SECRET`.
