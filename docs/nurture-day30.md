# Day-30 nurture: go-live runbook

Built and tested, **off**. Nothing below has been done. Josh confirms before go-live.

## What it does

1. A positive-reply follow-up sequence finishes with no reply, no meeting, no DQ and no unsubscribe: the lead enters at `day30`, due 30 days after the last follow-up that went out (next weekday, 8am to 5pm CT).
2. When due, a NURTURE card posts in `#nurture` with name, company, last outreach, phone, last reply or call summary and a HubSpot link. No phone on file: phone lookup runs first.
3. Josh or Cayden clicks Approve & Send, Edit & send or Skip. Approve queues the approved email in the Smartlead nurture campaign. Nothing sends without that click.
4. A positive reply, booked meeting, no-show rebook, DQ, not-interested or unsubscribe sets the lead to `paused` or `exited`, closes the open card and updates HubSpot.
5. Day 90 and quarterly are disabled (no copy yet).

## Go-live steps (in order)

1. **Merge and deploy** this PR (migration `048_nurture_day30.sql` runs on start; it only creates two empty tables). All flags stay off, so nothing changes.
2. **HubSpot properties** (contact object). Dry run first, it creates nothing:
   `node scripts/hubspot-nurture-properties.js`
   Then, with a HubSpot private app token that has `crm.schemas.contacts.write`:
   `HUBSPOT_ACCESS_TOKEN=... node scripts/hubspot-nurture-properties.js --apply`
   Creates `nurture_stage` (dropdown: none, day30, day90, quarterly, paused, exited), `nurture_next_touch_date` (date), `last_outreach_date` (date), `nurture_exit_reason` (text). If `last_outreach_date` already exists it is kept as is.
3. **Smartlead campaign.** Campaign 3122546 currently sends a generic 7-step sequence. Approve refuses to import into it. Either replace its sequence with one step whose subject is `{{nurture_subject}}` and body is `{{nurture_body}}` (plain text, no tracking, stop on reply, weekday sending window), or create a new campaign that way and set `SMARTLEAD_NURTURE_CAMPAIGN_ID` to its id. Link only the "Joshua Osborn" mailboxes.
4. **Slack.** The Slack bot used for the follow-up cards must be a member of `#nurture` (C0BHBDTMRFY), and that Slack app's Interactivity URL must be this service's `/slack/actions` (it already is for the follow-up cards). Or set `NURTURE_SLACK_BOT_TOKEN` to a bot token of an app pointed at this service.
5. **Env vars** (Railway, replyhandler service):

| Variable | Value | Notes |
|---|---|---|
| `NURTURE_CLIENT_IDS` | the SalesGlider client's uuid | Only this client's sequences enter. Empty means nobody. |
| `NURTURE_ENROLL_START` | ISO time, e.g. `2026-11-01T00:00:00Z` | Sequences finished before this never enter. Required. |
| `HUBSPOT_ACCESS_TOKEN` | private app token | Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`. |
| `HUBSPOT_PORTAL_ID` | `245860747` (default) | For the card link. |
| `NURTURE_SMARTLEAD_API_KEY` | Smartlead key for client 345263 | Falls back to the lead's client Smartlead key. |
| `SMARTLEAD_NURTURE_CAMPAIGN_ID` | `3122546` (default) | Change if you build a new campaign. |
| `NURTURE_SLACK_CHANNEL` | `C0BHBDTMRFY` (default) | |
| `NURTURE_APPROVER_IDS` | `U0AAX2XFJE7,U0BL8JT75KN` (default) | Josh, Cayden. |
| `NURTURE_CALL_MENTIONS` | e.g. `U0CAL8ZDG92:Gabe,U0BL8JT75KN:Cayden` | Who is @-mentioned for the call task. Falls back to `FOLLOWUP_CALLERS`. |
| `NURTURE_MAX_PER_WEEKDAY` | `5` (default) | Cards per Chicago day. |
| `NURTURE_DAY30_DELAY_DAYS` | `30` (default) | |
| `NURTURE_TICK_MINUTES` | `10` (default) | |

6. **Flags, one at a time, in this order** (each is off until set to `true`):
   1. `NURTURE_ENABLED=true`: enrols leads and watches exits. Database only; check `GET /admin/nurture` and `POST /admin/nurture/run?dry=1`.
   2. `NURTURE_HUBSPOT_SYNC_ENABLED=true`: writes the four properties on the HubSpot contact.
   3. `NURTURE_POST_ENABLED=true`: posts Day 30 cards in `#nurture`.
   4. `NURTURE_SEND_ENABLED=true`: lets Approve queue the email in Smartlead.

First Day 30 cards can appear 30 days after the first sequence finishes (sequences started Oct 27, so about late November).

## Rollback

Set `NURTURE_ENABLED=false` (everything stops), or turn off the later flags individually. Rows stay in `nurture_leads` and `nurture_touches`. Open cards stay in Slack until clicked; Approve does nothing while `NURTURE_SEND_ENABLED` is off.

## Manual enrolment (migration 049)

For leads that never had a follow-up sequence, add them by hand. A manual row has `origin = 'manual'`,
no `source_sequence_id` and no `source_reply_id` (no `pending_replies` row is created), and carries its
own copy: `custom_subject` / `custom_body`. The card and the stored touch show that copy instead of the
template, and Edit still works on it.

- Endpoint: `POST /admin/nurture/enrol` with `{ clientId, leads: [...], apply?, allowPartial? }`.
  Dry run unless `apply: true`. Like every admin route it takes no key. A write needs the client in
  `NURTURE_CLIENT_IDS`. The response carries issue codes by row, no names or emails.
- Script: `node scripts/nurture-manual-enrol.js --file leads.json --client <uuid> [--apply] [--allow-partial] [--json]`.
  Dry run by default, with a read-only Postgres session.
- A lead: `email`, `name`, `subject`, `body` (required); `company`, `phone`, `summary`, `note` (card);
  `last_outreach_at`, `due` (ISO dates, `due` defaults to now, snapped into the send window);
  `hubspot: false` (no HubSpot contact) or `hubspot_contact_id`. `flag` is a synonym for `note`.
- Checks per lead: valid email, the same copy rules as the card (guarantee line, sign-off, no dashes,
  110 words, no placeholders), not a duplicate in the file, not already live in nurture, not DQ'd, no
  earlier unsubscribe / not interested / wrong person reply, no meeting still upcoming on the calendar (a meeting that was booked but never held does not exclude a lead). One problem blocks the
  whole batch unless `allowPartial`. Re-running a load enrols nobody twice.
- `override_prior_negative: true` on a lead enrols it despite an earlier unsubscribe / not interested / wrong person
  reply (only that lead; a person decides it; a DQ still blocks). The result carries a `prior_*_reply_overridden` warning.
  Replies that arrive after enrolment still exit it.
- No HubSpot contact: `hubspot_skip` leads are never looked up or written, and the card says "no contact found".
  Leads with neither flag set are looked up at sync time; no contact is fine.
- Exit rules for a manual lead look at its email from enrolment on: later unsubscribe / not interested /
  wrong person exits it, a later positive reply or a booking pauses it, a DQ exits it at any time.
- Phone: the lead's own `phone` is used when no earlier reply has one. There is no reply to run the phone
  lookup from, so a lead without a number shows "none found (no lookup: no reply record on file)".
- Nothing posts or sends from here. All four flags still decide that, and a person still clicks Approve.
