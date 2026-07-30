# ReplyHandler — working notes

Read this before changing the reply pipeline. These are load-bearing rules that
have each broken production at least once.

## Deployment

Railway auto-deploys **`claude/prospect-reply-automation-q2jei`**, not `main`.
Pushing only to `main` does nothing. Keep both in sync.

## Do not lower the JSON body limit

`src/index.js` sets `express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' })`.

On the Express default (100kb), real SmartLead reply payloads — HTML body plus
quoted thread history plus signatures — are rejected with 413 **before the
webhook route runs**. There is no log line, no error, no Slack card. Replies
just vanish. This cost us a day of missed replies across every client.

## Suppression policy — only three things are silent

`slackSuppressionReason()` in `src/utils/smartlead-webhook-helpers.js` is the
single source of truth. Silent: **out-of-office, explicit unsubscribe/opt-out,
wrong-person**. Everything else reaches Slack.

In particular, **`NOT_INTERESTED` must post to Slack and must get a draft.** It
is an objection worth working, not a dead lead. It drafts in decline mode —
acknowledge, no pitch, no times, no link, then ask about checking back later.

If you add a suppression rule, add it to `slackSuppressionReason()` and return a
distinct reason string. Do not hardcode a reason at the call site — the pollers
report these in `skipCounts`, and a log that misreports *why* a reply went
silent is how a real reply gets lost.

Note: wrong-person also catches "please contact Jane instead", so genuine
referrals are currently silenced. Known tradeoff, deliberate.

## No pending-nudge / "you haven't actioned this" alerts

Deleted on purpose, at the owner's explicit request. `postPendingNudge`,
`postReminder`, `already_replied_yes` / `already_replied_no` /
`snooze_nudge_30` are all gone. Approval cards post once and are left alone.
Do not reintroduce them. The `pending_nudge_*` columns remain in the schema
only because dropping them is riskier than leaving them unused.

## Client notification is on send, and it is the enriched path

`smartlead.forwardThreadToClient()` (called from `reply-send.js`) is the client
notify path. It anchors to a real thread message via
`extractForwardAnchorFromHistory`, so the client sees the actual conversation,
and it adds lead name, email, and cell phone with the enrichment provider.
Gmail is primary; SmartLead forward is the fallback.

Do **not** add a second forward that fires on *inbound* receipt. That was tried
(`3f97035`) and rejected for three reasons: it ran before classification so it
emailed clients every OOO auto-reply and bounce; it keyed off `cc_emails`, which
now drives the CC-on-send system, so clients would receive raw inbound replies
they never opted into; and its purpose — a net against dropped replies — is
already served by the pollers below.

## Webhooks are not the only path — the pollers are the backstop

`smartlead-poller.js` and `heyreach-poller.js` sweep on a cron and re-post
anything the webhooks missed, with `recoverUnpostedSlackCards` catching rows
that were stored but never made it to Slack. This is what recovered the backlog
after the 413 outage. Do not disable them to "reduce noise"; dedupe instead.

Both webhook paths dedupe before classifying (`smartleadDuplicateInDb`,
`heyreachDuplicateInDb` + an in-memory TTL check for HeyReach). Redelivered
events otherwise burn a Gemini call and post a duplicate card.

Lookback defaults to 168h. Anything dropped longer ago than that will not
self-recover and needs a manual sweep.

## Diagnostics

`GET /admin/test/replies?secret=$WEBHOOK_TEST_SECRET&client=<name>&days=N`
— read-only view of stored replies and a per-classification summary. Returns
404 if `WEBHOOK_TEST_SECRET` is unset.
