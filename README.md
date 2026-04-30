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

After that, each deploy runs `scripts/apply-schema-to-db.js` (empty DB only: full `schema.sql` + migrations) then `scripts/run-migrations.js` (incremental 002–010, tracked in `schema_migrations`). Set `SKIP_DB_MIGRATIONS=1` only if you intentionally manage SQL by hand.

**Backups and avoiding data loss:** This app never deletes `clients` rows. If client rows vanish, the Postgres **volume was reset or a new database was attached** (e.g. recreating the Postgres service in Railway). Mitigations: enable **Railway Postgres backups** in the dashboard (plan-dependent); avoid detaching/recreating the Postgres plugin; periodically run `pg_dump` off-platform, e.g. `railway run --service <App> pg_dump "$DATABASE_URL" > backup-$(date +%Y%m%d).sql` (use the app service so `DATABASE_URL` points at your data). Client API keys must be **re-entered** after a restore if you only have SQL dumps without secrets elsewhere.

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in all values:

```bash
cp .env.example .env
```

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `GEMINI_API_KEY` | Google Gemini API key for classification and drafting |
| `SLACK_SIGNING_SECRET` | From your Slack app's Basic Information page |
| `WEBHOOK_TEST_SECRET` | Optional. Protects `POST /admin/test/slack-draft/:clientId` for Slack-only testing |
| `DEFAULT_BOOKING_TIMEZONE` | Optional. IANA zone for labeling verified slots (default `America/New_York`) |
| `FOLLOW_UP_REMINDER_HOURS` | Optional. After you **send** an approved reply, Slack gets a **follow-up nudge** if the prospect hasn’t replied again within this many hours (default `24`) |
| `LEADMAGIC_API_KEY` | Lead Magic API key for LinkedIn email lookup |
| `CALCOM_API_KEY` | Cal.com API key (if required) |
| `PORT` | Server port (default: 3000) |
| `RAILWAY_PUBLIC_DOMAIN` | Set automatically by Railway |

Each client may store an optional **`calendly_personal_access_token`**. When their **booking link** is a Calendly URL and a PAT is set, the server uses Calendly’s API to fetch **real** open times. For other schedulers (Cal.com, SavvyCal, etc.), you can **connect Google or Outlook** so two slots may still be inferred from calendar free/busy; if neither Calendly+PAT nor a connected calendar is available, the AI will **not** invent wall-clock times and will rely on the booking link only. On existing databases, run `migrations/004_calendly_pat.sql` once.

**If the dashboard PATCH fails with `column "booking_link" does not exist`:** your Postgres was never migrated from Cal.com. Run `migrations/005_booking_link_safe.sql` once (adds `booking_link` if missing; renames `calcom_event_type_id` only when that column still exists). From a machine with Node: `railway run -s Postgres sh -c 'export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${POSTGRES_DB}" && cd /path/to/repo && npm ci && node scripts/run-sql-file.js migrations/005_booking_link_safe.sql'` or run the SQL in Railway’s Postgres query UI.

**Prospect follow-up nudge:** run `migrations/007_outbound_follow_ups.sql`. After a reply is **approved/sent** from Slack, if the prospect sends **another inbound** message within `FOLLOW_UP_REMINDER_HOURS`, the pending nudge is cancelled; otherwise the client’s Slack channel gets a reminder to follow up. This uses **SmartLead** `campaign_id`+`lead_id` or **HeyReach** `conversation_id` / `lead_id` from webhooks — not “read receipts” from LinkedIn/email.

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
curl https://your-app.up.railway.app/admin/clients
```

### Update a client

```bash
curl -X PATCH https://your-app.up.railway.app/admin/clients/uuid-here \
  \
  -H "Content-Type: application/json" \
  -d '{"voice_prompt": "Updated voice instructions here"}'
```

## Webhook Setup

Each client has **unique** URLs (`/webhook/smartlead/<client-uuid>`, `/webhook/heyreach/<client-uuid>`). Replies are posted to **that client’s** `slack_channel_id` using **their** bot token only after we confirm the event belongs to **their** account:

- **SmartLead:** `GET /api/v1/campaigns/{campaign_id}?api_key=...` must succeed for the client’s key (SmartLead returns 404 if the campaign is not in that account).
- **HeyReach:** we call `POST /api/public/campaign/GetAll` with the client’s key and require the webhook’s `campaignId` to appear in their workspace’s campaign list.

Paste **each client’s** webhook URL only into campaigns that belong to **that** client’s SmartLead/HeyReach workspace (the same API keys you saved in the dashboard). If someone pastes Client A’s URL into Client B’s campaign, events are **skipped** (no Slack noise).

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

## Cal.com Setup

### 1. Create a Cal.com Organization

1. Sign up at [cal.com](https://cal.com) and create an organization for SalesGlider Growth

### 2. Add Client Sub-Teams

For each client:
1. Create a sub-team under your organization
2. Have the client connect their Google/Outlook calendar under their team profile

### 3. Create an Event Type

1. Under the client's team, create an event type (e.g., "30 Minute Discovery Call")
2. Configure the duration, availability, and confirmation email template
3. Find the **Event Type ID** — it's in the URL when editing the event type: `cal.com/event-types/123456`
4. Add this ID to the client record via the admin API:

```bash
curl -X PATCH https://your-app.up.railway.app/admin/clients/uuid-here \
  \
  -H "Content-Type: application/json" \
  -d '{"calcom_event_type_id": "123456"}'
```

Cal.com handles sending calendar invites and confirmation emails automatically — the system just creates the booking.

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
| `INTERESTED` | Gemini drafts reply → Slack approval → send |
| `QUESTION` | Gemini drafts reply → Slack approval → send |
| `OBJECTION` | Gemini drafts reply → Slack approval → send |
| `MEETING_PROPOSED` | Draft includes two suggested times + Calendly-style link → Slack approval → send; optional calendar invite if a calendar is connected |
| `NOT_INTERESTED` | Slack alert only |
| `OUT_OF_OFFICE` | Slack alert only |
| `REMOVE_ME` | Unsubscribe lead + Slack alert |
| `WRONG_PERSON` | Slack alert only |
| `COMPETITOR` | Slack alert only |
| `OTHER` | Slack alert only |

## Timeout Reminders

- **30 minutes**: A reminder is posted as a thread reply on the original Slack message
- **2 hours**: An escalation with `@here` is posted to the channel
- Checked every 10 minutes via cron job

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/webhook/smartlead/:clientId` | None | SmartLead inbound webhook |
| `POST` | `/webhook/heyreach/:clientId` | None | HeyReach inbound webhook |
| `POST` | `/slack/actions` | Slack signature | Button interactions |
| `POST` | `/admin/clients` | None | Create client |
| `GET` | `/admin/clients` | None | List clients |
| `PATCH` | `/admin/clients/:clientId` | None | Update client |
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
