# ReplyHandler — working notes

Read this before changing the reply pipeline. These are load-bearing rules that
have each broken production at least once.

**These rules are enforced, not just documented.** CI runs the guard tests on
every push and pull request:

- `test/invariants.test.js` — safety rules. Each corresponds to a change that
  broke production. Anyone should keep these.
- `test/owner-intent.test.js` — **Josh's product decisions.** A failure here is
  not a bug, it is a reversal of a decision he made.

When a guard fails, read the reason in the assertion and the entry in
`DECISIONS.md`. Fix the change, not the guard.

## Who can change what

**Add features, fix bugs, refactor freely** — as long as `npm test` passes.

**`DECISIONS.md` records Josh's calls and needs Josh to change.** Reversing one
is not an implementation decision. Several were already reversed once during
the conversation that produced them, so what is written there is the settled
answer, not the first instinct. If a guard blocks something that looks
genuinely wrong, raise it rather than deleting the guard.

**When Josh makes a new call, append it to `DECISIONS.md` in that same
session** — the decision, why, and the guard test name if it is testable. That
file is the durable memory; chat history is not.

Railway auto-deploys the branch below, so a push there is a production deploy.
Two people pushing to it directly is how work gets silently overwritten — it
already happened once (`3f97035` and `e23f6b5` sat on a branch nothing deployed
for two days). Branch off, open a PR, let CI run.

## Deployment

Railway auto-deploys **`claude/prospect-reply-automation-q2jei`**, not `main`.
Pushing only to `main` does nothing. Keep both in sync.

## Do not lower the JSON body limit

`src/index.js` sets `express.json({ limit: process.env.JSON_BODY_LIMIT || '5mb' })`.

On the Express default (100kb), real SmartLead reply payloads — HTML body plus
quoted thread history plus signatures — are rejected with 413 **before the
webhook route runs**. There is no log line, no error, no Slack card. Replies
just vanish. This cost us a day of missed replies across every client.

## Suppression policy — AI reply channels are interested-only

Final Slack gate: `slackChannelSuppressionReason()` in
`src/utils/slack-channel-policy.js`. Only **`INTERESTED`**,
**`MEETING_PROPOSED`**, and **`QUESTION`** post to the AI reply channels.
`NOT_INTERESTED`, `OOO`, `OTHER`, `OBJECTION`, and similar stay out.

Text heuristics in `slackSuppressionReason()`
(`src/utils/smartlead-webhook-helpers.js`) still catch OOO / unsubscribe /
wrong-person that mis-classify as a positive. Prefer returning a distinct
reason string from the shared helpers so poller `skipCounts` stay accurate.

Drafts follow the same set: `DRAFT_CLASSIFICATIONS` is only those three
positives. Decline-mode helpers remain for fallbacks, but declines are not
Slack-carded.

Note: wrong-person also catches "please contact Jane instead", so genuine
referrals are currently silenced. Known tradeoff, deliberate.

## Josh / SalesGlider draft voice

Ack what they said before any CTA. First outbound on a thread is
`FIRST_TOUCH`; after any prior sent reply it is `CONTINUATION` (do not reset
to cold first-touch voice). For Josh-as-CEO clients, scrub "our CEO" /
"our founder" handoffs to first person (`principal-draft-guard.js`). RAG
prefers client-scoped examples (`match_replies_v2`), skips FOLLOW_UP /
placeholder inbounds for learning, and can be seeded via
`scripts/seed-josh-gold-reply-examples.js`. Realtime learning on approve/edit
covers both SmartLead and HeyReach; the Friday job below re-sweeps the week so
a missed realtime write is caught up.

## Weekly voice learning runs on Fridays

`weekly-voice-learning.js`, scheduled in `cron.js` (`VOICE_LEARNING_CRON`,
default Friday 4pm Central). It learns from every reply Josh actually sent in
the last 8 days — Slack **approved**, Slack **edited** (the diff against
`pending_replies.original_draft` is the strongest signal), and **manual**
replies typed straight into SmartLead / HeyReach — then:

1. upserts each prospect→Josh pair into `reply_examples` (RAG), idempotent on
   `pending_reply_id` / `source_message_id`, both platforms;
2. has Gemini re-synthesize a global voice profile and a per-client profile
   with client-specific notes, **appended** as a new `voice_profiles` row;
3. `voice-profile.js` injects the active profiles into the Claude and Gemini
   draft prompts as a `LEARNED VOICE` block.

**History is permanent, updates stay automatic, revert is a restore.** Every
run adds a row; nothing is ever overwritten, and `DELETE` / `TRUNCATE` on
`voice_profiles` are blocked by trigger. Drafts always read the **newest** row.
When Josh says a week's update is worse, revert it — do not pin or freeze:

```bash
railway run node scripts/voice-profile-revert.js list                          # see every version
railway run node scripts/voice-profile-revert.js revert --previous             # global, one week back
railway run node scripts/voice-profile-revert.js revert --previous --client X  # one client
railway run node scripts/voice-profile-revert.js revert <id>                   # a specific version
```

(HTTP equivalents: `GET /admin/voice-learning/history`,
`POST /admin/voice-learning/revert?id=…` or `&client=…&previous=1`.) A revert
copies the chosen week forward as the new current row (`restored_from` set);
the next Friday refines from it and the rejected week stays in history. There
is deliberately **no pin** — a pinned version was tried and rejected because
it paused auto-updates. Do not add an upsert, a per-week unique index, a
pin, or a cleanup job on this table.

Rules that hold here: it is a bulk job, so **Gemini only — never Anthropic**;
FOLLOW_UP bumps and placeholder inbounds are never learned; a manual SmartLead
reply is identified **structurally** (a `SENT` directly after a prospect
`REPLY`), never by phrase; the same outbound text in two different threads is
treated as a template and dropped; anything we already sent from Slack is not
double-learned. The learned block is style guidance only — the operational
rules in the prompts (booking link, no sign-off, meeting modality, principal
voice) still win, and the sanitizer drops any learned line carrying a URL.

Every failure in the job is logged and skipped. A missing `voice_profiles`
table (migration 027 not applied) means drafts simply run without the block.
Trigger by hand with `scripts/run-weekly-voice-learning.js --dry` or
`POST /admin/voice-learning/run?secret=…&dry=1`; inspect with
`GET /admin/voice-learning/profiles?secret=…`.

## Draft provider order

1. Claude + RAG when `ANTHROPIC_API_KEY` + Supabase embeddings are configured
   **and** `draftMode` is realtime (webhooks only)
2. On Claude failure (including Anthropic usage limits), **Gemini** with the
   same voice prompt — do not skip to the template
3. Deterministic `fallbackDraftText` only if Gemini also fails / returns empty

**Hard rule:** pollers and backfill scripts pass `draftMode: 'bulk'`. Claude is
never used there — no env opt-in. Only `INTERESTED` / `MEETING_PROPOSED` /
`QUESTION` get drafts at all.

If drafts suddenly all look like "Happy to jump on a quick call…", check
Anthropic quota first, then confirm this fallthrough is still wired.

## Client meeting modality (Vasco / Carlos)

Some clients meet in person. That is driven by `clients.voice_prompt` via
`src/utils/meeting-modality.js` — not a global default. Vasco's prompt says
Carlos stops by the dealership in person; drafts and FOLLOW_UP bumps then
omit Zoom / phone / "our CEO" / booking links. Leave other clients on
times-first + booking-link.

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

## Follow-ups: 2h → 24h → 48h → 1w after any positive reply

`scheduleAfterOutboundSend` queues when we send a reply to a positive inbound
(`INTERESTED`, `MEETING_PROPOSED`, `QUESTION`). Default cadence is `2,24,48,168`
hours (`FOLLOW_UP_HOURS`). FOLLOW_UP sends do not restart the sequence.

`follow-up-runner.js` posts the next due step as a **top-level** Slack channel
card (not threaded under the original reply). Drafts are **offer-first bumps**
(different from the first times-first reply). The card shows the **full**
back-and-forth, a permalink to the original card, and a **Meeting booked**
button that cancels the cadence.
Before posting it asks `booking-check.js` whether the prospect already booked —
a `meetings` row, a later reply proposing a time or confirming, a calendar
event with them as attendee, or a call transcript (Allo / Cube ACR). Any one
suppresses the card silently, records `skip_reason`, and cancels later steps
for that thread.

Rows more than `FOLLOW_UP_MAX_AGE_HOURS` (24) past due are retired as `stale`
rather than posted. That guard matters: the table accumulated for months while
nothing read it, and without it the whole backlog would have posted at once.

Every external lookup in this path — Allo, Drive, Gemini, calendar — treats its
own failure as **not booked**. A broken integration produces a redundant nudge,
never a silently swallowed follow-up. Keep it that way.

## Call recordings

Allo (`withallo.com`) transcribes its own calls, so `GET /v1/api/calls` returns
`transcript` and `summary` inline — never download its audio. Auth is the raw
key in `Authorization` with **no `Bearer ` prefix**, and the key needs the
`CONVERSATIONS_READ` scope. Numbers are discovered from `GET /numbers`, not
configured; `ALLO_PHONE_NUMBERS` only pins a subset.

Cube ACR drops raw audio in Drive under date subfolders, named by phone number.
Matching keys on the **last 10 digits**, which survives `+1` / `1` / bare forms.
Those recordings do need transcribing — Gemini takes the audio directly.

Drive access rides on the primary Gmail OAuth token (`drive.readonly`). Two
separate things must both be true, and they fail with different errors:

1. The mailbox must be re-consented at `/auth/gmail/connect` after the scope
   was added — an older token silently lacks it.
2. **The Drive API must be enabled in the Google Cloud project behind
   `GMAIL_CLIENT_ID`.** That project only had Gmail enabled, so Drive returned
   403 "has not been used in project ... before or it is disabled" even with a
   correctly-scoped token. Enabling the API is a one-time console action.

## Diagnostics

`GET /admin/test/replies?secret=$WEBHOOK_TEST_SECRET&client=<name>&days=N`
— read-only view of stored replies and a per-classification summary. Returns
404 if `WEBHOOK_TEST_SECRET` is unset.

`GET /health` returns `gitSha` from `RAILWAY_GIT_COMMIT_SHA` — the fastest way
to confirm what is actually deployed rather than assuming a push went live.

`integration-check.js` probes Allo and Drive once at boot and logs
`[Startup] Allo ready` / `[Startup] Drive ready`, so a bad key, missing scope
or disabled API surfaces immediately instead of hours later inside a skipped
booking check.
