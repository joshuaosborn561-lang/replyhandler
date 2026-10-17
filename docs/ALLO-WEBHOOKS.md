# Allo meetings-booked webhooks

Cold-call bookings from Allo show up in Slack `#meetings-booked` and in the
daily / weekly recaps next to email/Calendly bookings. Source is labeled
**Allo call** vs **email**.

## Webhook URL to register

```
https://<RAILWAY_PUBLIC_DOMAIN>/webhook/allo
```

Exact path: **`POST /webhook/allo`**.

In Allo: **Settings > Webhooks** → add that HTTPS URL → subscribe to
`call.completed` and `tag.added`.

Or via API (`POST https://api.withallo.com/v2/api/webhooks`) with an API key
that has the **`WEBHOOKS_READ_WRITE`** scope:

```json
{
  "url": "https://<RAILWAY_PUBLIC_DOMAIN>/webhook/allo",
  "topics": ["call.completed", "tag.added"],
  "description": "ReplyHandler meetings-booked"
}
```

The create response includes `signing_secret` (`whsec_…`) **once**. Store it as
`ALLO_WEBHOOK_SIGNING_SECRET`. Never print it, never commit it. Fetching a
webhook by id can also return the secret if you lost the create response.

Allo retries failed deliveries. The handler is idempotent on the `webhook-id`
header.

## What counts as booked

| Signal | Slack | Recap |
|---|---|---|
| Call has a **Meeting Booked** tag (`call.completed` tags or `tag.added`) | Card, source **Allo call** | Confirmed count |
| No tag, but summary/transcript looks like a booking | Card labeled **likely** | Listed separately, not in confirmed |
| Same email or phone already booked via Calendly/email within 72h | No second card | One meeting |

SalesGlider cards include `https://calendly.com/joshua-salesglidergrowth/30min`.
Mesa Energy and Deep Roots do not use booking links — the caller (Gabe)
collects two times plus an email and Josh books by hand.

## Client mapping

Map the Allo number (or, as fallback, the Allo user email) to a
`clients.name` row.

| Env | Purpose |
|---|---|
| `ALLO_WEBHOOK_SIGNING_SECRET` | HMAC secret from Allo. Required. Unsigned/invalid requests are rejected (401). Unset is 503. |
| `ALLO_NUMBER_CLIENT_MAP` | JSON object of phone → `clients.name`. **Mesa Energy = (916) 270-1857 is the only default.** SalesGlider, Deep Roots, and future clients go here. Example: `{"12145550100":"SalesGlider","12184693457":"Deep Roots Capital"}` |
| `ALLO_USER_CLIENT_MAP` | JSON object of Allo `user_email` → `clients.name` when the number is unmapped. |
| `ALLO_API_KEY` | Existing key. Needed to fetch the call on `tag.added` (`CONVERSATIONS_READ`). Prefer also `WEBHOOKS_READ_WRITE` on the key used to register the webhook. |
| `MEETINGS_BOOKED_SLACK_CHANNEL_ID` | `#meetings-booked` (default `C0BRBK7H4BF`) |
| `MEETINGS_BOOKED_SLACK_BOT_TOKEN` | Optional. Falls back to a client bot token (SalesGlider first). |
| `ALLO_MEETING_DEDUPE_HOURS` | Email/phone dedupe window against Calendly/email bookings (default `72`) |
| `ALLO_MANUAL_BOOK_CLIENTS` | Extra client names that collect two times + email instead of a booking link. Mesa and Deep Roots are already treated as manual. |
| `SALESGLIDER_CALENDLY_URL` | Override for the SalesGlider booking URL |
| `MEETINGS_BOOKED_RECAP_ENABLED` | Daily/weekly Slack recap (default on). Set `0` to leave recaps to booking-bridge only. |
| `MEETINGS_DAILY_RECAP_CRON` | Default `5 19 * * *` (7:05pm) |
| `MEETINGS_WEEKLY_RECAP_CRON` | Default `20 19 * * 5` (Fri 7:20pm) |
| `MEETINGS_BOOKED_RECAP_TIMEZONE` | Default `America/Chicago` |

Do not put secrets in git, PR descriptions, or chat logs.

Recap JSON (same bearer as booking-bridge) also includes `meetings`,
`likely_meetings`, and `meeting_counts.by_source` on
`GET /webhook/booking-bridge/recap?start=<iso>&end=<iso>`.
