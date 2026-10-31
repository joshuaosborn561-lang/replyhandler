# Decision log

Josh's product decisions, in his words, with the reasoning that produced them.
**Append-only.** A decision is superseded by adding a new entry, never by
editing or deleting an old one — the reversals are the most useful part of this
file, because they record where the obvious answer turned out to be wrong.

## How this file is maintained

Whenever Josh makes a call in a session — a preference, a reversal, a "no, do
it this way" — the agent working with him appends an entry here **in the same
session**, before the work is considered done. Not a summary at the end of a
project: at the moment the decision is made, while the reasoning is still
available.

Each entry records:

- **the decision**, quoting him where the wording matters
- **why**, including what was tried and rejected
- **the guard**, if the decision is testable — the test name in
  `test/owner-intent.test.js` that fails when someone reverses it

Decisions with a guard are enforced. Decisions without one rely on this file
being read — so prefer adding a guard when the decision can be expressed as
one.

## Scope of authority

Anyone may add features, fix bugs, and change implementation freely, provided
the guard tests still pass. Reversing an entry below is not an implementation
change — it needs Josh. If a guard blocks something that seems genuinely wrong,
raise it rather than deleting the guard.

---

## 2026-07-31

### Only three kinds of reply are silent

Out-of-office, explicit unsubscribe/opt-out, and wrong-person. Everything else
reaches Slack.

This moved twice. First ask was "only obvious remove me and out of office
should not" come through. Then Not Interested and Wrong Person were added to
the silent set. Then Not Interested was explicitly pulled back out: *"not
interested should be on there but everything else is right."*

An objection is worth working. A dead lead is not the same thing as a lead who
said no once.

Known tradeoff, accepted: wrong-person also matches "please contact Jane
instead", so genuine referrals are silenced too.

Guard: `NOT_INTERESTED reaches Slack and drafts — reversed once, settled`

### NOT_INTERESTED gets a draft, in decline mode

*"still draft for not interested replies"*

It had been alert-only — visible but with no draft and no Approve/Edit buttons.
The default times-first prompt would have pushed meeting slots at someone who
just declined, so declines route through a separate mode: acknowledge in one
line, no pitch, no times, no link, then ask about checking back later.

Guard: `declines draft without pitch, times or link`

### The prospect's signature stays on the card

*"no i like the sig on there"*

Their signature block was stripped as noise. It isn't — title, phone numbers
and booking link are useful context on a reply. Only quoted thread history and
`[cid:]` image refs are removed.

Cost of this decision, accepted knowingly: keeping signatures means the webhook
and poller renderings of one reply diverge again in the tail, so duplicate
detection cannot rely on comparing full text. That is why dedupe keys on a
leading slice instead.

Guard: `the prospect's signature stays on inbound cards`

### Our drafts carry no sign-off

*"remove sigs from ai drafts. just keep the sig on the email account"*

SmartLead sends with `add_signature: true`, so a model-written closing name
stacked a second signature on the real one. The prompt had been explicitly
asking for one.

Guard: `our drafts add no sign-off, mailbox signature only`

### Times-first — the booking link waits until asked

Offered the alternative of including the link in every draft; he kept
times-first. Two concrete times convert better on a cold reply than a link
dump, and it matches his own voice examples.

Guard: `booking link is withheld until the prospect asks`

### The `{BOOKING_LINK}` placeholder bug stays unfixed

A client with no `booking_link` set can get a draft containing the literal text
`{BOOKING_LINK}`. Offered a fix; he declined — it only bites when a client has
no link configured *and* a prospect asks for one.

No guard. Deliberately unfixed, not forgotten.

### No "you haven't actioned this" alerts, ever

*"for the love of gof delete all the you havent actioned alerts. just erase
those from the code"*

Erased, not disabled: `postPendingNudge`, `postReminder`,
`already_replied_yes` / `already_replied_no` / `snooze_nudge_30`, and their
cron jobs. Approval cards post once and are left alone. The `pending_nudge_*`
columns remain only because dropping them is riskier than leaving them unused.

Guard: `no nudge system is reintroduced`

### Client notification is his enriched forward, on send

A second forward firing on *inbound* receipt was written by Cayden
(`3f97035`) and rejected: it ran before classification so it would have emailed
clients every OOO auto-reply and bounce, and it keyed off `cc_emails`, which
now drives CC-on-send, so clients would receive raw inbound replies they never
opted into.

His path anchors to a real thread message so the client sees the actual
conversation, and adds lead name, email and cell phone from enrichment.

Guard: `client notification stays on the enriched send path`

### Client notify thread looks like a normal inbox

*"hey the emails clients getting are weird, the format for the thread should
look like this just obvious"*

Primary Gmail client-notify used to label steps "Us" / "Prospect" /
"Us (just sent)". Rebuild the Thread section as email cards with
**Subject / From / To / body** (and Sent / Replied / You replied status
lines), matching how the conversation looks in SmartLead.

Guard: `test/client-notify-email.test.js`

### Follow-ups after meeting propose: 2h → 24h → 48h → 1 week

Only schedule when the approved outbound proposes a meeting (times, Calendly,
"book for you") — not after every send. Cadence from that send: 2h, 24h, 48h,
then 1 week. Approving a FOLLOW_UP card does not restart the clock.

Skipped when the prospect already booked, proposed a time, has a calendar event,
or a call transcript (Allo / Cube ACR) shows the meeting was set. Both SmartLead
and LinkedIn. No backlog replay (`FOLLOW_UP_MAX_AGE_HOURS`).

Guard: `follow-ups after meeting propose at 2h/24h/48h/1w`

### Correction: follow-ups after any positive reply

*"no any positive reply should be on that cadence"*

Supersedes the meeting-propose-only gate above. Soft positives (tickets,
"sure", questions) were not getting 2h/24h/48h/1w nudges because our outbound
didn't always propose times. Cadence now starts whenever we send a reply to
`INTERESTED`, `MEETING_PROPOSED`, or `QUESTION`. Declines / OOO / other still
do not. FOLLOW_UP sends still do not restart the clock. Booking skips unchanged.

Guard: `follow-ups after any positive reply at 2h/24h/48h/1w`

### First follow-up at 3:30pm CT (not 2h)

*"change 2h to 3:30 pm cst the day the reply came in, unless it came after 2 cst"*

Replaces the former 2-hour first step. Default cadence is now:
1. **3:30 PM America/Chicago** on the calendar day the inbound arrived
2. If inbound was at/after **2:00 PM Central**, use the **next** calendar day at 3:30
3. If that 3:30 is already past when we approve/send, roll forward day-by-day
4. Then **24h → 48h → 1 week** after our send (unchanged)

Hard floor: **no follow-up is ever due sooner than 2 hours after our send**
(`MIN_FOLLOW_UP_HOURS`). Same-day 3:30 that would land inside that window is
pushed to `sentAt + 2h`.

`FOLLOW_UP_HOURS` still overrides the whole sequence with pure hour offsets
(also clamped to ≥ 2h).

Guard: `first follow-up at 3:30pm CT same day unless inbound after 2pm CT`

### Follow-ups pull campaignintelligence booking_events

*"Follow-Up AI replies needs to talk to booking bridge to see when a client
has already booked"*

Push webhook (`/webhook/booking-bridge`) still stops the cadence on confirm.
Additionally, before posting a FOLLOW_UP card, `looksAlreadyBooked` queries
campaignintelligence `booking_events` (same `SUPABASE_URL`) for
`booking_confirmed` — and Culture Fits / MS Bookings `page_view` treated as
booked — so a missed or raced webhook still suppresses the nudge and seeds a
local `meetings` row.

Guard: `test/booking-bridge.test.js` (`campaignIntelligenceSaysBooked`)

### Cancelled bookings do not count as booked

*"Yes, please fix that in reply."* (Oct 27, after booking-bridge #19 started
recording TidyCal cancels / reschedules)

Every check that reads `booking_events` (`campaignIntelligenceSaysBooked` /
`campaignIntelligenceBookingState`, and the ghosted-meeting candidate pull)
ignores a `booking_confirmed` row that has `cancelled_at` set, or that a
`booking_cancelled` row points at (`payload.original_booking_event_id` or the
shared `payload.tidycal_booking_id`). A reschedule is not a cancel. When every
booking for a lead was cancelled, the local `meetings` rows that only mirrored
those bookings (stamped `calendar_provider = 'booking_bridge'`, or an unstamped
`booked` row written within 15 min of the cancelled booking) stop blocking, so
the lead's normal follow-up schedule applies again. Meetings a person marked
booked are untouched, and follow-ups already marked `skipped` are not revived.

Guard: `test/booking-cancelled.test.js`

### No follow-up backfill older than 3 days

*"stop backfilling past 3 days ago"*

Positive-reply cadence backfills and ops scripts must not look further than
3 days. `scheduleAfterOutboundSend` also refuses to start a cadence from a
send older than 3 days.

Guard: covered by `MAX_SCHEDULE_AGE_DAYS` in `outbound-follow-up.js` and the
3-day caps in `scripts/smartlead-positive-followups.js` /
`scripts/post-followup-nudges.js`

### Follow-up drafts must tolerate a null timezone

Every client had `digest_timezone = NULL`. `nextBusinessDayLabel(null)` threw
`RangeError: Invalid time zone`, so the follow-up runner failed on every tick
(200+ attempts, zero Slack cards). Fall back to America/Chicago.

Guard: `follow-up draft tolerates null digest_timezone`

### FOLLOW_UP cards post in the main channel with thread context

*"dont post followups in the thread post them in the main channel....give me
the context of our thread though"*

Cadence FOLLOW_UP cards must be top-level channel messages (`postInThread:
false`), not buried under the original Slack thread. The card still shows the
original prospect reply, what we sent, the suggested follow-up, and a permalink
back to the original Slack card when available.

Guard: `FOLLOW_UP cards post in the main channel with thread context`

### FOLLOW_UP bumps are offer-first; show full thread; Meeting booked button

*"Followup drafts need to be different than form the first reply look aty
recent bumps, they should mirror those. Mostly reference the offer. I also
need you to show me all messages between us not just the first 2. Lastly add
a button meeting booked that stops follow ups and the sequence."*

FOLLOW_UP drafts must NOT reuse the first-reply times-first template
("thanks for getting back… mid-morning or early afternoon… booking link").
They mirror the human-edited bumps: short, soft, offer-first (tickets / free
campaign / video / case study). Slack cards render the full back-and-forth
(not just one inbound + one outbound). A **Meeting booked** button records a
booked meeting, cancels pending cadence steps, and stops future nudges
without DQ'ing the lead.

Guard: `FOLLOW_UP bumps are offer-first with full thread and Meeting booked button`

### FOLLOW_UP bumps reframe the value prop; 3rd bump never uses dashes

*"for the 3rd bump....no dashes ever, you can use ... and for any follow up
you need to reframe the value prop somehow. ie still interested in meeting
for x (whatever was in the original email)"*

Every cadence bump must reframe what the original outbound offered
(tickets / free campaign / video / case study / scraped value prop) —
e.g. "still interested in meeting for the Rangers tickets". Step 3+ copy
never uses em/en dashes or spaced hyphen dashes; use "..." instead.

Guard: `FOLLOW_UP bumps reframe value prop and 3rd bump has no dashes`

### Allo call match is by phone digits, not API filter alone

Allo's `/calls?contact_number=` has returned the account's recent call list
unrelated to the prospect. Judging those transcripts marked innocent leads
`call_transcript_booked` (Parlay VM follow-ups). Always filter to calls whose
to/from matches the prospect's last 10 digits.

Guard: `Allo booking check matches the prospect phone`

### A call that booked skips silently

Offered a Slack note with the transcript excerpt on skip; he chose silent. The
follow-up resolves with `skip_reason = 'call_transcript_booked'` and posts
nothing.

Guard: `a call-transcript booking suppresses without posting`

### Both Allo lines are tracked

*"there are 2 allo numbers track them both"* — `+1 214 910 7558` and
`+1 863 304 9904`. Discovered from the API rather than configured, so a third
line is picked up automatically.

Guard: `all Allo lines are searched, discovered from the API`

### Cell recordings come from Cube ACR in Drive

*"it will be in sub folders of the date and be the phone number"* — matched on
the last 10 digits so `+1` / `1` / bare formats all resolve.

Guard: `Cube ACR recordings match on the last 10 digits`

### One card per prospect, full stop

*"stop sending me doubles for the same guy."*

Duplicate detection had been compared on the reply text — first the whole body,
then a 120-character prefix — and kept losing, because the webhook and the
poller render the same reply differently and keeping the prospect's signature
guarantees the tails diverge.

The final backstop ignores the text entirely: if a card for this lead already
reached Slack inside `LEAD_CARD_WINDOW_MINUTES` (90), no second card is posted.
It sits in `postProspectSlackCard`, the one point every path funnels through,
so webhooks, pollers, recovery and digests are all covered by one check.

Follow-ups are exempt — they are a deliberate second touch on a lead we already
carded.

Tradeoff accepted: a genuinely new reply from the same prospect inside 90
minutes will not get its own card. That is the cost of never seeing a double.

Guard: `a second card for the same lead is blocked`

### SmartLead classifies its own email replies

*"just use smartleads classifier."*

SmartLead already categorises every reply in the master inbox. Running Gemini
over the same text produced a second, sometimes disagreeing opinion for no
benefit. Its category now decides the classification for email; Gemini still
writes the draft. LinkedIn has no equivalent and stays fully on Gemini.

Category names are user-editable in SmartLead, so matching is on normalised
substrings, not exact strings. A category we do not recognise becomes `OTHER`
and still reaches Slack — never a silent drop. No category at all falls back to
Gemini rather than guessing.

Note: this was asked for earlier in the day and was lost when the branch was
restored from the last known-good deploy. Reinstated.

Guard: `SmartLead's category wins over Gemini for email`

### Correction: dedupe on text only, never on time

*"no the same text from the same client shouldnt come through. i need to see if
a client responds, ever."*

Supersedes the 90-minute lead window in the entry above, which was wrong. That
window suppressed *any* second card for a prospect regardless of what they
said, so a genuinely new reply arriving soon after the first would have
vanished. Missing a real reply is worse than showing a double — that is the
whole point of this system.

The rule is:

- **same text, same person → duplicate**, never comes through twice
- **different text, same person → a new reply**, always comes through, however
  soon it arrives

So dedupe compares the reply text and nothing else, and is unbounded in time.
Two renderings of one reply are matched two ways, because the webhook and the
poller differ in both directions: a shared 120-character leading slice catches
divergent tails (signature, quoted headers), and prefix containment catches one
rendering being truncated earlier than the other. Below 40 characters only the
exact leading slice counts, so short replies never collapse together.

Verified both directions: the two real Chris Arnold renderings and a truncated
variant all match; "Tuesday works" vs "Wednesday works", "Yes" vs "No", and two
genuinely different replies from one prospect all still produce their own card.

Guards: `the same reply never repeats, a new reply always shows`,
`no time window can swallow a reply`

### Wrong-person referrals are a dead end, not a lead

*"no that's a dead end. I'm not going to contact x instead."*

Twice I flagged that `looksLikeWrongPerson` matches "please contact X instead"
and suggested routing those to Slack as live referrals. Settled: they are not
worth surfacing. He is not going to chase the named alternative, so silencing
them is correct and the earlier "known tradeoff" note is resolved, not
outstanding.

Wrong-person stays in the silent set with no carve-out for referrals.

Guard: covered by `NOT_INTERESTED reaches Slack and drafts — reversed once,
settled`, which asserts the silent set is exactly ooo / unsubscribe /
wrong_person.

## 2026-08-05

### Parlay Tech: no drafts for .io / .ai reply domains

*"for parlay. please exclude all .io and .ai form drafting replies, DQd at
client request"*

Parlay asked to DQ those TLDs. Replies still reach Slack as alert-only (with a
DQ reason) so nothing is silently dropped, but they never get an Approve/Edit
draft, meetings are not opened, and phone enrichment is skipped.

Other clients are unaffected — a `.io` lead for SalesGlider still drafts.

Guard: `Parlay excludes .io and .ai from drafting`

### Slack campaign field shows the campaign name

*"also i need the campaign ID in slack to be the name of the cmapaign not just
the numbers"*

Slack cards were rendering `Campaign 3739758`. We now resolve and persist the
human SmartLead/HeyReach campaign name and show `Name (id)` on draft, alert,
follow-up, and approve-confirmation cards.

Guard: `Slack campaign field shows the campaign name`

### Missing phone says "phone number not found"

*"and if you cant find one say phone number not found"*

When enrichment finishes without a cellphone, Slack shows
`phone number not found` — not provider waterfall jargon.

Guard: `missing phone says phone number not found on Slack`

### Phone stays on the Slack card after approve

*"also i dont want the persons number to disappear in slack after i approve"*

The approval confirmation card rebuilt the Lead line without `lead_phone`, so
the enriched cellphone vanished the moment Approve/Reject/DQ flipped the card.
Confirmation cards now keep the same phone line as the draft/alert card.

Guard: `phone stays on Slack card after approve`

### Slack cards show the prospect LinkedIn URL

*"somethign that would be nice is if you can post the linkedin url of the porspect int the slack cards so we can quickly qualify them"*

Draft, alert, follow-up, and approve-confirmation cards put a clickable LinkedIn URL on the Lead field — HeyReach already has it; email replies get it from enrichment. Same URL stays after Approve / Reject / DQ.

Guard: `Slack cards show the prospect LinkedIn URL`

### Phone enrichment is the email-waterfall stack, max_tier FullEnrich

*"idk how you are enriching prhone number today but you should just use my waterfall in the other project max tier fullenrich"*

Do not stop at GetLeads → AI Ark → LeadMagic, and do not recreate those vendors in ReplyHandler. Call the existing `joshuaosborn561-lang/email-waterfall` MCP/HTTP service (`EMAIL_WATERFALL_URL` + `POST /enrich-one`, same as `enrich_person`) with `need=both` and default `max_tier=fullenrich`. FullEnrich is last-tier **email and cellphone** (`contact.phones`). Slack cards need the compact hit back immediately — `enrich_waterfall` returns counts only, so do not use it here. Missing-phone Slack copy stays `phone number not found`.

Guard: `phone enrichment walks the email-waterfall to FullEnrich`

### Slack DQ button excludes follow-up nudges

*"also add in a DQ button in slack that excludes form followup nudges"*

Every draft and alert card gets a **🚫 DQ** button. Hitting it marks the
prospect disqualified, cancels pending follow-up cadence steps, and blocks
future follow-up scheduling / digest nudges for that lead. Separate from
Reject (which only declines the current draft).

Guard: `Slack DQ button excludes follow-up nudges`

---

## 2026-08-17

### Vasco / Carlos drafts offer in-person meetings only

*"carlos is offering to meet in person, change his replies only to reflrect"*

Vasco Warranty drafts must offer stopping by / meeting in person — not Zoom,
phone, "quick call with our CEO", or booking links. Other clients keep the
global times-first + booking-link default. Driven by Vasco's `voice_prompt`
via `meeting-modality.js` (first-touch fallback, Gemini prompt, FOLLOW_UP bumps).

Guard: `Vasco fallback drafts stop-by in person, never CEO call or booking link`

---

## 2026-08-13

### AI reply Slack channels are interested-only

*"i only want interested replies to come through there. no OOO and no
not interested"*

Supersedes "Only three kinds of reply are silent" / "NOT_INTERESTED reaches
Slack and drafts" for the AI reply channels. Cards post only for
`INTERESTED`, `MEETING_PROPOSED`, and `QUESTION`. OOO, not-interested,
other/objection noise stay out of those channels. Text heuristics still
silence OOO / unsubscribe / wrong-person that mis-classify as positive.
`DRAFT_CLASSIFICATIONS` matches that set (no decline drafts on Slack).

Guard: `Slack channels are interested-only — OOO and NOT_INTERESTED suppressed`

### Josh drafts ack-first; first vs continuation; scrub CEO handoff

SalesGlider voice audit: drafts must acknowledge the prospect's point before
any CTA; second+ replies on a thread must not reset to cold first-touch;
Josh-as-CEO clients must never ship "our CEO" / "our founder" handoff voice
(Chase Dawson leak). RAG prefers client-scoped SalesGlider examples, does
not learn FOLLOW_UP / placeholder inbounds, and seeds gold ack-first pairs.

Guard: `Josh drafts ack-first with first vs continuation and CEO handoff scrub`

---

## 2026-08-17

### Claude draft failures fall through to Gemini, not the robotic template

Anthropic hit usage limits (blocked until 2026-09-01). Claude + RAG was
still "configured", so every draft attempt failed and dumped into
`fallbackDraftText` — the "Happy to jump on a quick call… mid-morning or
early afternoon" template. That is why replies looked like the old default
even though ack-first / CEO-voice / RAG code was on the deploy branch.

Fix: Claude failure → Gemini with the same voice prompt. Deterministic
template only when Gemini also fails. MEETING_PROPOSED last-resort confirms
their times instead of inventing new ones.

Guard: `classifier no longer dumps Claude failures into deterministic fallback only`

### Claude never runs on poller/backfill; draft positives only

*"so do what you need to to gate it and make sure that never happens oand only
draft for interested question meeting proposed. neevr let claude do a
backfill"*

After the Aug 2026 Anthropic burn (poller drafted thousands of
NOT_INTERESTED/OTHER with Sonnet), Claude is hard-disabled whenever
`draftMode: 'bulk'` (SmartLead/HeyReach pollers + ops backfill scripts). No
env opt-in. Drafts only for `INTERESTED` / `MEETING_PROPOSED` / `QUESTION`.

Guard: `Claude never runs on bulk backfill; only positives get drafts`

## 2026-08-20

### Booking-page confirmations stop ReplyHandler follow-ups

Campaignintelligence `log-booking` POSTs to
`/webhook/booking-bridge` with `Authorization: Bearer` matching
`BOOKING_BRIDGE_WEBHOOK_SECRET` (same value as campaignintelligence
`REPLYHANDLER_WEBHOOK_SECRET`). On `booking_confirmed` — and on
Culture Fits / MS Bookings first-click with `treat_as_booked: true` —
skip pending `outbound_follow_ups` by email, close open Slack cards as
`meeting_booked`, and record a booked meeting so the runner does not
nudge someone who already booked.

Guard: `test/booking-bridge.test.js`

## 2026-08-21

### FOLLOW_UP bumps go to a dedicated Slack channel with buttons up top

*"i want followups and bumps to go in a seperate slack channel, and also the
actual buttons are buried deep in the thread....each post should be the
cmapaign, lead, enriched number. then oroginal message, our reply, and then
the conversation in order. no dupes, no show more"*

All FOLLOW_UP cards post to `C0BRRS8DV19` (override with
`FOLLOW_UP_SLACK_CHANNEL_ID`), still top-level (`postInThread: false`) — not
under the original inbox card. Layout: campaign + lead + enriched phone →
Approve/Edit/Reject/DQ/Meeting booked → original message → our reply → rest
of the thread in order (deduped, full text chunked — no `_(truncated)_`) →
suggested bump.

Guard: `FOLLOW_UP bumps go to dedicated channel with easy-to-reach buttons`

## 2026-08-25

### Never send another client's signature on a campaign

*"this email was sent out by goliath aug 25. ensure this never ever happens
again with the sig Sean, that offer's still open whenever you want it. …
Aarav Sanchez Roofs by Peterson"*

Exact send: Goliath Education Receipts → Sean Dean (`sdean@mscok.edu`),
seq-2, 2026-08-25 15:42Z, body correct, signature `Aarav Sanchez / Roofs by
Peterson`. Same day: dozens of Goliath sends signed Peterson or Culture Fits.

Cause: shared SmartLead workspace. Mailboxes moved / rebranded between
clients while in-flight sequences kept sending from them.

Response: pause contaminated Goliath campaigns immediately; cron
`smartlead-sender-guard` scans recent statistics for foreign brand lines in
`%signature%`, Slack-alerts, and auto-pauses. Do not unpause until every
attached sender signs the campaign's own brand.

Guard: `test/smartlead-sender-guard.test.js`

### Correction: Deliverability Wizard owns sender-brand QA

*"Stop the SmartLead sender-brand guard. Deliverability Wizard owns this.
… A leftover Peterson line on mail that already went out is not a
replyhandler pause."*

ReplyHandler does **not** scan SmartLead sends for foreign signatures, does
not Slack cross-client signature alerts, and does not auto-pause or unpause
campaigns. That guard is removed. Wizard rewrites foreign brands on the
mailbox, pulls cross-client attachments, and STARTs a paused Goliath
campaign only after signature QA. Follow-ups in this repo stay reply-card
cadence only.

## 2026-09-15

### Tech Evolution / Corey Tapper keeps the public booking-bridge wrap

Corey’s underlying Calendly is now `https://calendly.com/ctapper/meeting`.
That destination is updated in booking-bridge (separate PR) so the public
page points there. Replyhandler must keep emitting the wrap prospects
already get:

**`https://book.gosalesglider.com/techevo`**

Do not paste `calendly.com/ctapper/meeting` (or the older
`calendly.com/ctapper/new-meeting`) into outbound drafts. Other clients
are unchanged — Bolder stays on `/bolder`.

Guard: `Tech Evolution booking link is the public booking-bridge wrap`

## 2026-09-29

### No follow-up messages past 5pm CT or on the weekend

*"Make sure this accounts for nights and weekends. I don't want messages past 5 CST or on the weekend"*

The 3:30pm CT first step is already before 5, but Friday-after-2pm and Saturday/Sunday inbounds were landing on weekend 3:30s, the 2h floor can push a late send past 5pm, and the 24h/48h/1w offsets are raw hour math — Friday 4:30pm + 24h is Saturday.

Follow-up due times now snap into **Monday–Friday, 8:00 AM–5:00 PM America/Chicago**. Weekend and after-5 dues roll to the next weekday 8am (first step still prefers weekday 3:30 when that is valid). Colliding steps that would all pile onto Monday morning are spread a business day apart. The runner and the attention digest do not post FOLLOW_UP cards outside that window; off-hours `due_at` rows are deferred so `FOLLOW_UP_MAX_AGE_HOURS` does not retire them as stale over the weekend.

Approve-to-send is unchanged — if Josh hits Approve at 6pm the email still goes out. This is the automated cadence, not a hold on a manual send.

Guard: `no follow-up messages past 5pm CT or on the weekend`

### Friday follow-ups stop at noon CT

*"Friday should stop sending at noon cst."*

Tightens the send window above. Monday–Thursday stay 8:00 AM–5:00 PM America/Chicago. **Friday is 8:00 AM–12:00 PM** — noon and after roll to Monday. Friday 3:30pm first steps are past that cutoff, so a Friday inbound (or Thursday after 2pm) lands Monday 3:30pm, not Friday afternoon.

Guard: `no follow-up messages past 5pm CT or on the weekend` (asserts `SEND_WINDOW_FRIDAY_END_HOUR === 12`)

## 2026-10-01

### Reject also marks Not Interested in SmartLead

*"please change the reject button to be reject and mark as not interested where it changes the classification in smartlead"*

The Slack **❌ Reject** button still dismisses the draft (no send) and marks the lead Not Interested. Hitting it:

1. Sets our `pending_replies.classification` to `NOT_INTERESTED`
2. POSTs SmartLead ` /campaigns/{id}/leads/{id}/category` with the account's "Not Interested" category (looked up by name via `/leads/fetch-categories`, not a hardcoded id)
3. Cancels pending follow-up cadence steps for that thread

A SmartLead API failure does not undo the local reject — the card stays rejected and the footer reports the error. HeyReach cards update locally only (no SmartLead category). DQ stays a separate "out of ICP" action.

Guard: `Reject marks the lead Not Interested in SmartLead`

### FOLLOW_UP Slack cards show the draft and last message only

*"the follow up channels in slack make no sense. It's cluttered and I can't see what I'm sending till I click into it and I can't easily see last message in thread."*

Supersedes "original → our reply → rest of thread → suggested bump" / "show all messages between us" on the FOLLOW_UP channel. That dump forced Slack "See more", so the suggested send and the latest turn were off-screen.

New card (approval and confirmation): **lead + campaign → suggested send (or what we just sent) → last thread turn → buttons**. Quoted email history is stripped from the last-message line. Permalink to the original inbox card stays. The full back-and-forth is no longer rendered on the follow-up card.

Guard: `FOLLOW_UP cards show draft + last message; only after we have sent`

### Follow-ups only fire after we have replied first

*"Also make sure follow up only fired if we have replied first."*

A SmartLead/HeyReach sequence email in thread history is not "we replied." Cadence scheduling requires a non-empty `sent_reply` on the approved row. The runner and the attention digest skip (and cancel later steps) with `no_prior_send` unless that thread already has a Slack-approved send. `draft_reply` is not treated as a send.

Guard: `FOLLOW_UP cards show draft + last message; only after we have sent`

### Portal takeover stops our follow-ups and sends

*"My client portal now lets clients take over prospects."*

`POST /client-action` (header `x-portal-secret` = `PORTAL_WEBHOOK_SECRET`) is the only new intake. Classification, drafting, and Slack Approve stay as they are.

`client_has_it` / `booked_offline` / `not_a_fit` sets `client_claimed_leads` for that email + campaign, cancels queued follow-ups and pending drafts (status `suppressed`, reason `client_claimed`, classification unchanged), and posts Slack for Cayden on the client's inbox channel. `open` clears the flag and does not re-queue. `type: note` posts the note and stores it on any pending draft. Repeat of the same payload is a no-op.

Immediately before any approved send or follow-up card, we check the flag. If set, we skip, cancel the rest of that lead's queue, and log `client_claimed`.

Guard: `portal takeover stops sends and follow-ups`

### Mirror onboarding to the client portal

*"My client portal now auto-provisions clients when I onboard them here."*

After a successful create or update on this dashboard, POST the client fields plus `handler_client_id` (this service's UUID) to `PORTAL_URL/functions/v1/provision-client` with `x-portal-secret` = `PORTAL_WEBHOOK_SECRET`. 10s timeout, one retry after 5s. Failures are logged only — the save here is never rolled back.

`PORTAL_URL` is the Supabase project URL (`https://scvrsmfzyvmmbnaolcrg.supabase.co`), not salesglider.ai. The portal only stores `name`, `contact_email`, SmartLead/HeyReach keys, `booking_link`, and `active`. Do not send Slack tokens, Calendly PATs, voice, timezone, or CC lists.

Invite emails stay off until DNS points salesglider.ai at the new portal. `skip_invite` is true when `contact_email` is empty **or** `PORTAL_SKIP_INVITE` is unset/true. Set `PORTAL_SKIP_INVITE=false` to send invites. The portal still returns a one-time `login_link`; if it also returns a warning (email change, no re-invite), show that on the dashboard. First create still needs a `contact_email` — the live function returns 400 without one. Empty email only works on a later update of an existing `handler_client_id`.

Portal claim/release/note POSTs may include extra fields (`handler_client_id`, `client_company`, `name`, `company`, `lead_id`). Ignore them. `/client-action` still keys on email + campaign_id.

If the portal returns a login link, the confirmation screen shows it so Josh can copy it. "Sync all clients to portal" pushes every existing client the same way.

Guard: `onboarding mirrors to the client portal`

## 2026-10-02

### Client notify emails include the full live thread — same for every client

*"myles macintosh just got an auto email from us for cory that is not the full transcript, i thought you had already fixed that for kyle?"*

The Kyle inbox-card format (Subject / From / To) is already live. Myles McAntosh's Cory Schell notify still used the inbound-time `thread_context` snapshot, so a FOLLOW_UP send dropped the first approved reply and looked like a partial transcript. CSS leftovers (`P {margin-top:0}`) and a 12-message tail made it worse.

Client notify now refetches live SmartLead history at send time, merges prior approved sends from `pending_replies` when history lags, keeps the full thread (not `slice(-12)`), and strips style/CSS junk. Same path for Emcor, Peterson, and everyone else. Still on send only — no inbound-receipt forward.

Guard: `client notify email includes the full live thread`

### Weekly Friday voice learning from approved, edited and manual replies

*"set up a routine to automatically go in every friday, learn from the weeks
last replies, and continuously shape yourself to my voice, while also
acknowledging client specific information. this should be from approved
replies from slack as well as edited ones or manual replies from smartlead
and heyreach"*

A scheduled job (`weekly-voice-learning.js`, Friday 4pm Central by default,
`VOICE_LEARNING_CRON`) sweeps the last eight days and learns from every reply
Josh actually sent, in four buckets: Slack **approved**, Slack **edited**
(the original AI draft is now kept in `pending_replies.original_draft` so the
diff survives), **manual SmartLead** replies (a `SENT` directly after a
prospect `REPLY` in message-history — structural, never phrase-based), and
**manual HeyReach** replies. Each pair goes into the RAG corpus, and Gemini
re-synthesizes a global voice profile plus a per-client profile that carries
client-specific notes (offer, who takes the meeting, in-person vs call, named
teammates). Both the Claude and Gemini draft prompts read the latest profile
as a `LEARNED VOICE` block.

Choices made along the way:

- Realtime learning on approve/edit previously skipped HeyReach. It now learns
  both platforms; the Friday sweep is also the catch-up for any realtime miss.
- Learned lines are **style guidance only**. Booking-link, no-sign-off,
  meeting-modality and principal-voice rules in the prompts still win, and
  any learned line carrying a URL is dropped. Client notes count as facts for
  Claude's example-leak check because they come from that client's own sends.
- A client with fewer than 3 new replies in the week keeps its previous
  profile rather than overfitting to one message (`VOICE_LEARNING_MIN_EXAMPLES`).
- The same outbound text in two different threads is a template, not a voice
  example, and is dropped.
- It is a bulk job: Gemini only, never Anthropic. Same rule as the pollers.
- No Slack post. The run logs `[VoiceLearning] Weekly run complete` and is
  inspectable at `GET /admin/voice-learning/profiles`.

Guard: `weekly Friday voice learning from approved, edited and manual replies`

### Every week's voice profile is kept forever; updates stay automatic; revert is one command

*"make sure you save the previous week's style so that if your updates suck
i can revert back indefinitely"* — then, on the first draft of this which
pinned a version and paused updates: *"no have it auto update but if i come
back in here i should be able to easily revert"*

Each Friday run **appends** a new `voice_profiles` row per scope; it never
updates or replaces an earlier week. Deleting rows is blocked at the database
(`DELETE` and `TRUNCATE` triggers), so the history is permanent regardless of
what any script does.

Drafts always read the **newest** row, so weekly updates apply on their own.
Revert is a **restore, not a freeze**: `scripts/voice-profile-revert.js revert
--previous` (or `revert <id>`, or `POST /admin/voice-learning/revert`) copies
the chosen earlier week forward as a new current row with `restored_from`
pointing back at it. Drafts switch to it, the next Friday refines from it, and
the rejected week stays in the list. There is no pin and nothing to undo later
— a pinned version was tried first and rejected because it would have stopped
the auto-updates until someone remembered to unpin. Global and each client
revert independently.

Guard: `voice profile history is permanent, auto-updates continue, any earlier week can be restored`

### Portal invite emails go out for new clients

*"Tell ReplyHandler to stop sending skip_invite: true. New clients will now get a real invite email that lands on the new portal."*

DNS is no longer the gate. A new client with a `contact_email` gets a real invite email from the portal. `skip_invite` is true only when `contact_email` is empty **or** `PORTAL_SKIP_INVITE=true` (also `1` / `yes`). Unset and `false` both send the invite. `PORTAL_SKIP_INVITE=true` remains the kill switch if we need to suppress them again.

The portal still returns a one-time `login_link` for the dashboard. First create still needs a `contact_email`.

Guard: `portal invite emails go out for new clients`

### Portal fills itself from ReplyHandler — backfill clients and live positive replies

*"Two things so the portal fills itself from ReplyHandler: 1. Backfill provision-client for every existing active client. 2. On every positive reply, POST new-positive-reply. Also: when a client's keys change, re-send provision-client."*

`POST /admin/clients/sync-portal` now pushes **active** clients only (re-run is safe — the portal updates, never duplicates). The provision payload includes `allo_api_key` when the client has one. Create and update still re-POST provision-client, so a SmartLead / HeyReach / Allo key change follows to the portal.

On every positive inbound that would Slack-card (`INTERESTED` / `MEETING_PROPOSED` / `QUESTION`), POST `PORTAL_URL/functions/v1/new-positive-reply` with `x-portal-secret`. Payload: `handler_client_id`, `email`, `name`, `company`, `campaign_id`, `lead_id`, `snippet`, `replied_at` (ISO, stable from `pending_replies.created_at` so Slack recovery does not duplicate), `channel` (`email` | `linkedin` | `call`). FOLLOW_UP cards do not fire this. Failures are logged only — Slack and the webhook still succeed. The portal is idempotent on client + channel + email + replied_at.

Guard: `portal fills itself from ReplyHandler`

### Portal create no longer requires contact_email

*"Re-run sync for all 11 active clients. The portal no longer requires contact_email on first create. Clients provisioned without an email get no invite until one is sent; re-send provision-client with contact_email when it is set."*

First create may omit `contact_email`. We still send `skip_invite: true` when the email is empty, so they get no invite and no portal login until an address is saved. Setting `contact_email` later re-POSTs provision-client (same as any create/update) and the invite goes out.

Guard: `portal create works without contact_email; invite waits for one`

### Portal contact email is the Always-notify address

*"the contact email is always the always notify email for positive replies"*

Portal `contact_email` is not a separate address. It is the first Always-notify / Always-forward email (`cc_emails`, else legacy `cc_email`). Provision, create, update, and sync-all derive it from that list. A leftover `contact_email` column is ignored when Always-notify is empty. Changing Always-notify re-POSTs provision-client so the invite follows.

Guard: `portal contact email is the always-notify address`

## 2026-10-05

### First positive reply: two calendar times AND the booking link

*"when we reply to a positive reply. offer two times from the prospects calendar, and then also give the booking link. then on the next days follow up, say those times were taken, here are two more times and the booking link"*

Supersedes **Times-first — the booking link waits until asked** and the next-day half of **FOLLOW_UP bumps are offer-first**.

The first approved reply to `INTERESTED` / `MEETING_PROPOSED` / `QUESTION` offers two verified open times (Calendly / connected calendar) **and** the booking URL in the same email. If they already proposed times, confirm those and still include the link. Vasco / in-person clients still get two stop-by times and never a booking link, Zoom, or phone CTA.

The next-day FOLLOW_UP (cadence step 2 / 24h) does not reuse the first two times. It says those were taken, offers the next two open slots, and includes the booking link again (except Vasco). Same-day step 1 stays a short offer-first bump. Later steps keep the value-prop reframe and no-dashes rule, and also refresh times.

Guard: `positive replies include two times and the booking link`
Guard: `FOLLOW_UP next-day bump refreshes times with booking link and Meeting booked button`

### No Calendly PAT — check the connected calendar first

*"ok and for PAT i dont need that. is there a way grokbot can just check first quickly?"*

Do not ask for a Calendly personal access token. Booking-bridge still has no availability API. Open times come from the Google/Outlook calendar already connected on the client: one free/busy call, weekday 9–4 in the booking timezone, 2.5s timeout on pollers and LinkedIn so the check stays quick. If the calendar is not connected or the check times out, fall back to two rough times plus the booking link.

Guard: `open times come from the connected calendar, not a Calendly PAT`

### Open times come from the public booking page

*"GrokBot's an agent… here's the main calendar link before we wrap it… find two times in the next two days… not same day… tomorrow and the day after… accounting for Fridays and weekends. I'm never going to get anything from the client. This is a public website."*

Supersedes **No Calendly PAT — check the connected calendar first** for how we get times. Still no PAT, still no client OAuth / client-id / client-secret.

Unwrap `book.gosalesglider.com/{slug}` to the destination calendar Josh stored in BookingBridge. That file (`https://book.gosalesglider.com/clients.js`) is the catalog — Calendly, HubSpot, Teams/MS Bookings, SavvyCal/PowerPSA, whatever he pasted. Read the same public slot JSON each scheduling page loads. A newly added slug is picked up from the live file; do not require a code change or a client OAuth secret.

- Calendly: `/api/booking/event_types/lookup` + `/calendar/range`
- HubSpot Meetings: `/meetings-public/v3/book/availability-page`
- SavvyCal (including custom domains like meet.powerpsa.com): public page `linkId` + `POST /api/links/{id}/intervals`
- MS Bookings / bookwithme: public availability URL when the host answers (some datacenter IPs get 417)

Offer one time tomorrow and one the next business day — skip today, Saturday, Sunday; Friday rolls to Monday/Tuesday. The draft still pastes the public wrap, never the raw destination. Vasco stays in-person with no link.

Guard: `open times come from the public booking page, not a client OAuth secret`

### Paste the regular calendar link — we wrap it

*"if I put a regular link in my reply handler stuff… automatically do BookingBridge from there… wrap it and update it in your backend… then you know exactly what link is the regular link"*

Josh pastes Calendly / HubSpot / Teams / SavvyCal in the client Booking Link field. ReplyHandler stores that as `booking_destination_url`, rewrites `booking_link` to `book.gosalesglider.com/{slug}`, and publishes the destination on `GET /public/booking-clients` so BookingBridge can wrap a brand-new slug without editing `site/clients.js`. Drafts paste the wrap. Open times are read from the regular destination. No second step in BookingBridge.

Guard: `regular booking links are wrapped and the destination is kept`

### Same inbound cannot be carded or sent twice

*"hey apparently you are sending us the same thing 2 times. casey buckstaff is one."*

The webhook and the SmartLead poller both passed "not posted yet," both classified, and both inserted. Casey Buckstaff got two Slack cards two seconds apart — the second footer said "Recovered by SmartLead inbox polling backstop," which is the *new insert* path, not Slack-post recovery. Philip Walker the same morning was the other path: recoverUnposted posted a card, then the webhook posted the same inbound four seconds later. Cayden approved "the second copy."

`alreadyPostedToSlack` required `slack_message_ts IS NOT NULL OR status = 'suppressed'`. The webhook inserts first and posts Slack second, so a just-inserted row without a ts did not count. Matching on `lead_id` only also missed when the two paths resolved different ids for the same person.

Fix:
- any non-FOLLOW_UP recorded row counts — do not wait for Slack ts
- same person is `lead_id` **or** email
- `claimNewInbound` takes an advisory lock, rechecks, then inserts (webhook + both pollers)
- Slack post claims the row so recover + webhook cannot both card the same inbound
- `sendReplyToPlatform` skips if the same outbound text already went to that person, so two leftover cards cannot both send

Pollers stay on. A genuinely different reply from the same person still gets its own card.

Guard: `the same inbound cannot be carded or sent twice`

## 2026-10-07

### Deep Roots: Tyler calls — ask what time works, no booking link

*"for deep roots i am just going to have tyler call them, it will be from 218 469 3457, ask them what time works best for them instead of offering a booking link"*

Exception to **First positive reply: two calendar times AND the booking link**. Deep Roots does not book on a calendar page. Tyler calls the prospect from 218-469-3457. Positive drafts acknowledge first, then ask what time works best, and name that number so they know who is calling. If they already proposed a time, confirm it and say Tyler will call from that number.

No booking URL, no two invented calendar slots, no Zoom/Calendly. FOLLOW_UP bumps ask again what time works — they do not say "those times got taken" (we never offered times) and they never paste a link.

Pinned by client name (`Deep Roots`) so it holds even if `voice_prompt` is still empty. Voice prompt can also say "Tyler will call" / the 218 number.

Guard: `Deep Roots asks what time works — Tyler calls, no booking link`

### Deep Roots: Tyler notify only when qualified + wants a call

*"I don't need an alert every time you reply to someone, just when it looks like someone is qualified, meets the employee and EBITEDA standards, and is interested in scheduling a call."*

Tyler (Always-notify `tleverington@deeprootscapital.com`) was getting a Gmail FYI on every approved Deep Roots send — Ken asking min EBITDA, Jason saying he was open, Neel dodging size then saying "Tomorrow works!". Josh told him we would scale the notifications back.

Slack cards for the team are unchanged. Other clients still notify on every send. Deep Roots still *replies* on Approve; only the client email is gated.

Notify Tyler only when all of these are true from **prospect** text (never our outbound "$1M to $10M" copy):

1. They want to schedule a call (named a time / "tomorrow works" / MEETING_PROPOSED).
2. EBITDA is confirmed in the **$1M–$10M** bar we ask in the emails — a stated number in range, or a yes to "does that sound like you?" after we asked. Skirted or missing = no email. Below $1M or above $10M = no email.
3. If they name headcount, it has to be **10–500** employees. Silence on headcount does not block once EBITDA is confirmed (we do not ask employees on every first touch). A 3-person shop that wants a call still does not email Tyler.

The Slack card says Tyler is notified only when qualified + wants a call. A skipped send footers `Tyler notify skipped — {reason}`.

Guard: `Deep Roots Tyler notify is qualified-and-scheduling only`

## 2026-10-08

### Josh dropped LeadMagic — reply enrichment is the email-waterfall job

Josh cancelled LeadMagic. The HeyReach `profile-to-email` call and `src/services/leadmagic.js` are gone. One claimed job per inbound reply owns email, cellphone, and LinkedIn:

- Ack the HeyReach webhook immediately; run enrichment in the background.
- Claim on `phone_enrichment_status` so a retry never pays twice.
- Free cache first (`pending_replies`, `{tag}_wf_contacts`, `name_bank`) — read-only, never touch `dl_status` / `sg_exclude` / `skip_*`.
- Then `EMAIL_WATERFALL_URL` `POST /enrich-one` with `linkedin_url` and `approve_cost_usd`. Email: getleads → smartlead → aiark → prospeo → fullenrich. Mobile: getleads → aiark → prospeo → FullEnrich. Accept a number only when Veriphone says valid + mobile.
- Default ceiling `$0.25`. FullEnrich mobile only for `INTERESTED` / `MEETING_PROPOSED` under `$1.00`. Estimate before each paid call. Logs are ids / tiers / spend — no lead rows.
- Legacy `leadmagic` / `lm` max_tier aliases to `aiark` (same old spend boundary).

Guard: `phone enrichment walks the email-waterfall to FullEnrich`
Guard: `reply enrichment is idempotent, ceiling-capped, Veriphone-gated`

## 2026-10-11

### Every Slack reply card shows LinkedIn and the company website

*"I've asked many times — every new reply card in every reply channel has to show the prospect's LinkedIn as a clickable link and a clickable link to their company website."*

Earlier passes did not stick for three reasons, all in the card builders rather than the data:

1. `leadFieldText` / `linkedinUrlLine` omitted LinkedIn when the URL was empty (silent drop). Website was never rendered at all.
2. `postProspectSlackCard` copied `phone.linkedinUrl` onto the card but dropped `phone.website`. Smartlead webhook/poller cards never passed either field. Confirmation (`sentCardPayload`) and FOLLOW_UP refresh did not SELECT / pass `lead_website`.
3. The poster awaited the 120s phone enrich before `chat.postMessage`, so a slow enrich looked like a missing card — and there was no `chat.update` when the link arrived later.

Fix at the root: every path that posts a reply card (Smartlead webhook, HeyReach webhook, both pollers, FOLLOW_UP runner, recoverUnposted, admin/test fixtures) goes through `postProspectSlackCard`. Draft / alert / sent-confirmation / refresh all render through `leadFieldText`, which always prints LinkedIn (clickable or `LinkedIn: not found`) and website (clickable or `Website: not found`).

Cheap sources first: fields already on the lead (Smartlead custom fields, HeyReach profile URL), then `{tag}_wf_contacts` / `name_bank` / `pending_replies` (by LinkedIn or email), then the work-email domain for the website (never gmail/outlook/…). If LinkedIn is still missing, `EMAIL_WATERFALL_URL` `/enrich-one` with a `$0.05` ceiling (getleads → AI Ark → Prospeo; estimate first; not FullEnrich). Post the card immediately; `chat.update` the same message when the links arrive. Persist with `COALESCE` on `linkedin_url` / `lead_website`. Never write `dl_status` / `sg_exclude` / `skip_*`.

Guard: `every Slack reply card shows LinkedIn and the company website`
Guard: `Slack cards show the prospect LinkedIn URL` (kept — clickable when present)

### Every Slack reply card shows the topup ICP verdict

*"Add an ICP verdict line to every reply card. Do not invent new ICP logic — reuse what topup already does for site_check / icp."*

Every new reply card (every client/channel, Smartlead and HeyReach) prints one ICP line on the shared Lead field:

- `🎯 80% disqualified: website says venture capital firm; client only works with private equity firm`
- or `🎯 ICP: unknown (no website)` / `unknown (no ICP)` / `unknown (checking)` then `chat.update`

The grader is topup's, not a new one:

1. `topup.icp_variants` is the per-client source of record (jev_variant + PASS token).
2. Shared cache: `client_salesglider.icp_llm_results` (fit, `prob` = P(PASS), reason / category) — the same row `site_check(icp)` and `icp(job_id)` already paid for.
3. Site text: `client_salesglider.icp_site_text` (icp-site-fetch), else a homepage fetch.
4. Miss path: Gemini with the icp-llm `JEV_Q` category prompt + `PASS` token (cited in `reply-icp-variants.js`). ReplyHandler has Gemini, not Jev/OpenRouter.

Estimate first (~$0.002 Gemini; topup Jev is ~$0.0001). Ceiling `$0.02`. Cache by `(client_tag, domain)` in `reply_icp_verdicts`. Post the card immediately; `completeCardLinks` `chat.update`s when the verdict lands. Never write `dl_status` / `sg_exclude` / `skip_*`. Never write topup ICP tables.

Guard: `every Slack reply card shows the topup ICP verdict`

## 2026-10-13

### Gabe Calls: every inbound reply forwards to Gabe

*"Anytime one of Gabe's cold call emails gets a reply I want it to forward to him same as other clients."*

Then, after we could not guess the address: forward-to is
`gabe@salesglidergrowth.com` (migration 036; previously gabriel.lopez@rocketbox.mx). Never `crecimiento@rocketbox.mx` (it bounced).

Josh is making a **deliberate exception** to **Client notification is his
enriched forward, on send**. The exception is only this caller-campaign path:

- Gabe Calls | SalesGlider `#4085158`
- Gabe Calls | EMCOR `#4085159`
- Gabe Calls | Deep Roots `#4085160`
- any future campaign whose name matches `Gabe Calls%`

Every inbound on those campaigns is emailed to Gabe the moment it arrives —
including OOO / not interested / wrong person. Client notify (`cc_emails`,
Gmail / SmartLead forward on Approve) is unchanged and still on send for
every client.

Implementation is config, not `if (gabe)`: `inbound_forward_rules` maps
campaign id and/or a name LIKE pattern to `to_emails`. Dedupe table
`inbound_forwards` so webhook + poller send once. Primary Gmail, same sender
as client-notify. The Allo `Caller reply to Allo` webhook
(`LEAD_CATEGORY_UPDATED`) stays on those campaigns. Registering `EMAIL_REPLY`
is a reviewed script / UI step — do not auto-apply against live campaigns.

Guard: `Gabe Calls inbound forwards on arrival; client notify stays on send`

## 2026-10-14

### Drafts never invent facts — prompt plus a verifier

On Oct 13 a QUESTION draft said a Boulder-named cyber firm was based in
Denver. The prospect had asked where the sender was based. Evidence
(counts and field names only):

- Slack card 2026-10-13 14:40 CDT, `#bcp-ai-replies`, classification
  `QUESTION`, status Approved & sent (not edited).
- `draft_reply` contained "Denver, CO". Inbound asked "based out of".
- Campaign `3763803` messages: 129 rows, **0** `denver` / `boulder` in
  `body`. BCP `sequence_steps`: 117 rows, **0** `denver` / `boulder` /
  `based` in `email_body` / `subject_line`.
- `reply_examples` for that client: Denver first appears **2026-10-13
  after this send** (the approved hallucination was learned). Earlier
  rows: **0** Denver.
- LinkedIn / website / ICP from PRs #92 / #93 are Slack-card only and
  were not in the draft prompt. Card had `linkedin_url` empty, website =
  prospect domain, ICP about the prospect vertical — none mentioned
  Denver.
- Prompt already said "never invent locations." That was instruction
  only. The example-term leak check only flags proper nouns copied from
  RAG examples, so a world-knowledge city slipped through.

Root cause: **the model invented Denver.** Not bad lead fields, not
enrichment, not a campaign template, not a swapped contact.

Josh: drafts must not hallucinate. Guardrails:

1. Prompt may use only facts in the provided context. Never state or
   guess a location, size, client name, or other specific unless it is
   there. If they ask and the context is silent, say you do not want to
   guess and offer a call.
2. After generation, extract cities/states, numbers, and proper nouns
   and require each in the source context (thread / inbound /
   scheduling / voice / names — not RAG examples). Mismatch → regenerate
   once with a stricter hint; if it still fails, strip the claim
   sentence or flag the Slack card `needs review` (`status = flagged`)
   rather than treating it as a clean send.

Do not add a client HQ field to the prompt unless Josh asks. Silence
beats a guessed city.

Guard: `drafts never invent facts — prompt + post-generation check`

## 2026-10-15

### New clients get an ICP profile from Josh's Fireflies calls

When a client is added (`POST /admin/clients`) they must have an ICP the
Slack-card grader can read. Existing clients already covered by
`topup.icp_variants` / `DEFAULT_CLIENT_VARIANTS` are left alone. Everyone
else is built from Josh's Fireflies transcripts: search by client name
and domain, extract industries / titles / company size / geos / offer /
exclusions using **only facts in those transcripts** (same
`FACT_GROUNDING_RULES` as the draft verifier). Store on
`clients.icp_profile` — that is what `loadVariant()` reads after topup /
defaults miss.

No matching calls, missing `FIREFLIES_API_KEY`, or no grounded facts →
`icp_status = needs_review`. Do not invent an ICP. Backfill is
`POST /admin/clients/backfill-icp` and `scripts/backfill-client-icp.js`.
Counts only in the response.

Guard: `new clients get an ICP profile or needs-review when no calls`

### ICP builds stay automatic — no client stays blank

Startup and a weekday hourly cron (6am–8pm America/Chicago, Josh's
quiet hours) run the backfill for any active client whose `icp_status`
is empty, missing, or never built. `needs_review` is retried once a
day in case new Fireflies calls appeared. Clients already covered by
a default variant persist `icp_status='skipped_existing'` so the
column is not left empty.

`POST /admin/clients/:id/rebuild-icp` (`force=true` by default) rebuilds
one client. When an ICP becomes ready, last-3-day Slack cards graded
`no ICP` are `chat.update`d in place — no new cards.

Guard: `ICP builds stay automatic — no client stays blank`

### Mixed-intent replies are classified from the full body

SmartLead stamps "Not Interested" from an opening deferral ("let's hold
off for now") even when the rest of the body is a question or interest.
Those replies reached ReplyHandler, then the category override replaced
Gemini, then the interested-only Slack gate dropped them.

Classify mixed / conditional replies from the **full body**. A hold-off
plus a later question or interest is a conversation (`QUESTION` unless
the body is already `INTERESTED` / `MEETING_PROPOSED`) and gets a Slack
card. Clear declines still follow SmartLead and stay out of the channel.

Does not reopen "NOT_INTERESTED reaches Slack". Pure not-interested
stays suppressed.

Guard: `mixed-intent replies are classified from the body, not SmartLead category`

## 2026-10-15

### Calendly PAT is gone

Josh never uses a Calendly personal access token. Remove the field, the
authenticated Calendly API client, dashboard inputs, and docs. Public
Calendly / HubSpot / Teams slot reads stay — those do not need a PAT.

Guard: `Calendly PAT integration is removed`

### Every client FYI is CC'd to ops; replies go to the ops inbox

The "FYI, we just replied" Gmail (and SmartLead-forward fallback) also
CCs `FYI_CC_EMAILS` so ops sees every notify. When that env is unset,
use the default ops teammate address. Set the env empty to disable.

The body includes: "If you have any notes on this reply, just hit
reply all. Our operations team sees it." Reply-To is `FYI_REPLY_TO` or
`PRIMARY_GMAIL_FROM` (the connected primary Gmail mailbox).

Guard: `FYI emails CC ops and invite reply to the ops inbox`

## 2026-10-15

### Every /admin route requires ADMIN_API_KEY

`/admin` was open on the public internet — client create/list/update,
test Slack drafts, voice-learning revert, diagnostics. Require header
`ADMIN_API_KEY`. If the env is missing, fail closed (503), do not 404
and serve the route. Wrong or missing header is 401. Dashboard and
scripts send the same header.

Guard: superseded on 2026-10-20, see below.

### Resurface wrongly suppressed mixed/question replies

Mixed-intent bodies that landed as `pending_replies.status = suppressed`
before full-body classification can be re-opened. Select suppressed rows
from the last N days (default 3), re-run `classifyAndDraft` (`draftMode:
bulk`), and for mixed-intent or `QUESTION` reset status and call
`postProspectSlackCard`. `dry_run` is the default and returns counts
only — no names.

`POST /admin/resurface-suppressed` and `scripts/resurface-suppressed.js`.

Guard: `wrongly suppressed mixed/question replies can be resurfaced`

## 2026-10-17

### Reply classification moves to Jev; drafts stay Claude then Gemini

Classification (category + `pitch_to_us_prob` in one call) uses Jev
(`typesafe/jev-1.13` via the Decisions API), not Gemini. Keyword prechecks
for OOO / wrong-person / not-interested stay. Gemini remains the
per-reply fallback when Jev fails (`CLASSIFIER_FALLBACK_GEMINI`, default
on) so a Jev outage cannot swallow replies. Drafting is unchanged:
Claude on realtime webhooks, Gemini on bulk, template last.

Endpoint and key come from `JEV_API_URL` and `JEV_API_KEY`. Fail-fast
if they are missing — never hardcode them.

Guard: `reply classification is Jev with Gemini fallback`

### Hide cold inbound pitches, never campaign threads we started

`isColdInbound` means no campaign ID AND (they wrote first OR we never
sent before their reply). Slack suppresses when that is true AND
`pitch_to_us_prob >= 0.8`. Campaign threads where we sent first always
post. Record those hides with `recordSuppressedReply` reason
`pitch_inbound`. A one-line daily Slack summary per channel,
"N pitches hidden today", posts only if N > 0. `SUPPRESS_PITCHES`
defaults on.

Guard: `cold inbound pitches at 0.8 are hidden; campaign threads are not`

### FOLLOW_UP drafts continue the conversation; never wait on Josh

Cayden sends follow-ups. 19 of the last 31 cards in the follow-ups channel
ignored an explicit prospect ask because `draftReattemptToBook` discarded
`lastInboundMessage` and always used `bumpForOffer` / `timesTakenBump`.

Supersedes **FOLLOW_UP Slack cards show the draft and last message only**,
the template half of **FOLLOW_UP bumps are offer-first**, and the canned
"those times got taken" half of **First positive reply: two calendar times
AND the booking link** (slots and the booking link are still passed in as
available facts; the model decides whether a meeting ask fits).

- Draft with Claude Sonnet + RAG the same way original replies do, even from
  the cron / poller path. Per-run cap (`FOLLOW_UP_CLAUDE_CAP`, default 25)
  and logged token cost. Gemini only if Claude errors or the cap is hit.
  Templates remain last-resort when both LLMs fail, logged loudly.
- Give the model the full thread, cadence step, and days since the last
  message. Address anything they asked for or set as a condition. Never
  repeat an earlier bump. Suggest a meeting only where it naturally fits.
- Follow-ups must not wait on Josh. There is no `needs_josh` flag.
  Pricing → "happy to walk through pricing on a quick call", no flag.
  One-pager / deck / "email me some info" → `needs_client=true` plus
  `what_to_send` **only when the draft actually loops the contact in**.
  The draft names the actual client contact from `voice_prompt`,
  copied character-for-character (e.g. it is "Myles" with a Y, not
  Miles). Spoken line: "looping in {exact first name} from our side".
  Name only, no title. Never say founder. Never let the model respell
  the name. Card shows `LOOP IN CLIENT: <what>`. Existing Gmail /
  SmartLead-forward notify to the client and Cayden still runs on send.
- Slack card: **WILL SEND** (full text, never truncated) at the top,
  buttons directly under it, optional LOOP IN CLIENT line, then the
  full thread oldest → newest (them/us + dates, signatures and
  disclaimers stripped, older turns ~400 chars, last two in full).
  Stay inside Slack's 50-block / 3000-char limits; overflow posts the
  full history as a thread reply.
- SmartLead `POST /campaigns/{id}/reply-email-thread` documents `cc` and
  `bcc` as comma-separated **strings** (field name `cc`, not an array).
  Default send still omits both. **Send + CC client** appears only when
  `needs_client` is set **and** the draft contains "looping in X from
  our side". That button is the only path that passes `cc` into
  `sendReply()`. Recipient is the same Always-forward addresses
  (`cc_emails` / legacy `cc_email`) that already receive that client's
  FYI — not a new field, not round-robin. The usual FYI forward still
  goes out.

Guard: `FOLLOW_UP drafts continue the thread and never wait on Josh`
Guard: `FOLLOW_UP cards show WILL SEND + full thread; only after we have sent`

### Send + CC only on loop-in drafts; Reject label; verbatim contact name

*"The 'Send + CC client' button must appear ONLY on cards where the draft
loops in the client contact ('looping in X from our side'); tie it to
the loop-in flag. CC recipient = existing client always-forward address.
Use smartlead sendReply() payload.cc as a comma-separated string (field
name 'cc', NOT cc_emails, NOT array) and wire reply-send.js to pass it
only for that button. Rename the 'Reject / Not interested' button to
just 'Reject'. Contact first names must come verbatim from client
config, never LLM-spelled; e.g. it is 'Myles' with a Y, not Miles. Pass
the exact name to Sonnet and validate the draft contains it exactly."*

Tightens the follow-up loop-in path:

- **Send + CC client** is gated on `needs_client` **and** the spoken
  loop-in line in the draft. Pricing cards that wrongly set the flag
  do not get the button. `reply-send.js` passes SmartLead `cc` (string)
  only when that button was used.
- Slack **❌ Reject** is the label. Hitting it still marks the lead
  Not Interested in SmartLead (the 2026-10-01 behavior is unchanged).
- The contact first name is copied from `voice_prompt` character-for-
  character into the Sonnet prompt. Global FOLLOW_UP rules do not
  include example spellings. A lookalike (Miles vs Myles) is rewritten
  to the configured name; `needs_client` stays only if the exact
  phrase is present after that check.

Guard: `FOLLOW_UP drafts continue the thread and never wait on Josh`
Guard: `Reject marks the lead Not Interested in SmartLead`

## 2026-10-19

### The dashboard stays open with no login

`/dashboard` loads with no login prompt. Read-only `/dashboard/api/*`
never returns SmartLead, HeyReach, or Allo keys or Slack tokens.
Every `/dashboard/api` payload is scanned last in `stripSecrets`:
any string that looks like a token (`xox[abposr]-`, `sk-`, `ghp_`, or a
32+ `[A-Za-z0-9_-]` blob that is not a UUID) is blanked, even when
stored in a non-secret column such as `slack_channel_id`.
`window.prompt` / `getAdminKey` must not run on page load. `/admin/*`
stays behind `requireAdminApiKey`; edits may prompt only when you click
an edit. Do not add dashboard auth back.

Guard: `the dashboard stays open with no login`

### SmartLead numeric categories; unknown never OTHER

EMAIL_REPLY now sends the category as a number: 1 Interested, 2 Meeting,
3 Not Interested, 4 Do Not Contact, 5 Info Request, 6 OOO, 7 Wrong
Person. Names still map. An unknown category falls through to our
classifier (Jev / Gemini). Never stamp OTHER from an unmapped category.

Guard: `SmartLead's category wins over Gemini for email`

### Reply to the actual sender, reply-all

Send to the latest inbound From. CC every other human on that message
(to + cc), including the original lead when a colleague replied. Exclude
our sending accounts and domains, duplicates, and auto-reply addresses.
Loop-in client CC from #106 still applies on Send + CC client. Use
SmartLead `to_email` and optional `to_first_name` (`recipient` is
rejected with 400). `reply_message_id` and `reply_email_body` keep
the quoted line on the actual sender. Greeting and Slack card use
that sender's first name.

Guard: covered by `test/reply-all.test.js`

### New replies post as top-level cards

`postInThread` defaults false. If an earlier card exists, link to it
("Earlier card"). FOLLOW_UP cards stay top-level as well.

Guard: `new replies post as top-level cards and link to an earlier card`

### Webhook is primary (persist, 200, async); poller every minute

Persist the inbound, return 200 immediately, process async. Post the
Slack card right after classification, then update it with the draft and
times. Poller is the backstop: every minute, clients in parallel, skip
already-handled rows before extra fetches, skip inactive clients.
Parallelize thread / campaign / calendar fetches. Startup registers an
EMAIL_REPLY webhook for every ACTIVE campaign, throttled to ~1 call
per second per API key (shared keys 429 after a burst). A list-call
failure is reported as unknown, not missing. Poller / webhook list
and create / listEmailAccounts retry 429s with backoff. The poller
skips findUnpostedReply rows created in the last ~2 minutes so it
does not post a placeholder card ahead of the webhook.

### Never invent ticket details or calendar times

Reply and follow-up prompts must not state seat, section, row, venue,
date, or quantity — tickets get worked out after a quick call. Fact-check
catches seat/section/row. FOLLOW_UP ticket detector requires `ticket` or
`tix`; a team name alone is not enough. Calendar open times cache for
5–10 minutes, ~8s timeout, log empty. Never state times that did not
come from the calendar.

### HeyReach: isolate a bad key

One client's HeyReach key failure must not stop polling for the others.
Each client is try/caught (including GetConversationsV2).

## No admin key checks (2026-10-20)

Josh: "why is there any key checks at all, get rid of them all." The ADMIN_API_KEY gate is removed from /admin, test-webhooks and voice-learning. It had also been returning 401 on /public/booking-clients, which broke BookingBridge auto-wrap. Inbound webhook shared-secret checks stay.

Guard: `no route requires ADMIN_API_KEY`

### Every reply card shows full name, LinkedIn, website, ICP, phone, and the person's location + time zone (Oct 21)

*"I need all the replies to show the person's full name, their LinkedIn… their website… ICP… phone number… and I need to know what time zone they're in… not the headquarters, the actual person… on all the AI reply channels and also on the follow-up channels… for all clients."*

Root causes it only worked for some clients:
1. Smartlead webhook posts the card with an empty draft, then the draft update and the late enrichment update both `chat.update` from their own stale copies. The draft update re-sent the pre-enrichment card, so LinkedIn / website / phone / ICP fell back to "not found" (or the late update wiped the draft). Now every update merges into the card's latest state (`patchPostedCard` / `mergeCardPayload`); an empty field never erases a found one.
2. Website said "not found" when only the email domain was known on rebuilt cards. `leadFieldText` now derives `https://domain` from any non-free-mail email.
3. No person location / time zone existed anywhere. `lead-location.js` reads it from lead fields; `person-profile-lookup.js` adds AI Ark reverse lookup then Serper LinkedIn search (also a LinkedIn + full-name fallback). Time zone is derived from the person's location, never company HQ. Stored in `pending_replies.lead_location / lead_timezone / lead_full_name` (migration 038).
4. Clients without an ICP waited for the hourly weekday sweep. A card that grades `unknown (no ICP)` now triggers `ensureClientIcp` (Fireflies) for that client immediately, single-flight, then regrades its cards.
5. No confirmed mobile showed no number at all. The non-mobile alt number now shows as "not a confirmed mobile".

Guard: `test/card-person-fields.test.js`

## 2026-10-21

### One card and one send per follow-up step

Jeff Miller (jeff@twobearcapital.com, 2026-10-20) got two approval cards for the same follow-up. Both were approved, so the same bump went out twice. The second send was about twelve minutes later and the opening line had been reworded, so the existing "same sent text" check did not see it. Travis Shindelbower (2026-10-21) had one Smartlead send rendered three times on the follow-up card: history, the stored send, and the last-outbound extra differ by signature and link brackets.

A follow-up step is claimed (`posting`) before the draft and the Slack post. One `pending_replies` row per `follow_up_id`. One open cadence row per person + step. Approve takes a person lock and sets `sending` before the provider call. The same step blocks even when the wording differs. A different numbered step still sends. Thread turns collapse on `message_id` or a cleaned-body prefix with a short signature tail. Do not dedupe on Smartlead `stats_id` — one thread shares it. FOLLOW_UP cards still skip inbound-text sibling dedupe so steps 2–4 are not swallowed.

Guard: `one card and one send per follow-up step` in `test/follow-up-idempotency.test.js`, plus the existing `the same inbound cannot be carded or sent twice` (FOLLOW_UP sibling skip stays).

### Reject on a follow-up card skips only that step

*"the Reject button on a follow-up card should only cancel that one pending send. It must NOT stop the sequence or mark the lead as rejected/not interested. The lead's next scheduled follow-up should still be generated and sent on schedule."*

Exception to "Reject also marks Not Interested in SmartLead" (2026-10-01). That decision still applies to inbox cards: classification `NOT_INTERESTED`, SmartLead category, cancel the cadence. The button label stays **❌ Reject**.

On a `FOLLOW_UP` card, Reject sets that row to `skipped` and leaves the classification alone. It does not call `markLeadNotInterested` and does not call `cancelPendingForThread`. Later cadence steps stay pending and still post. The card says **Skipped — next follow-up still scheduled**.

Travis Shindelbower, 2026-10-21 16:30 ET: Reject on the follow-ups card posted "Rejected — not interested", set SmartLead to Not Interested, and cancelled 3 pending nudges. That is the behavior this reverses for follow-up cards only.

Guard: `Reject on a follow-up card skips only that step`

## 2026-10-22

### Automated mailbox notices are not interested drafts

Server-move notices, "please use the new email", unmonitored mailboxes, departure auto-replies ("no longer employed / no longer with / has left" plus "reach out" or "contact"), ticket confirmations, and "this is an automated message" were matching the loose referral regex (`reach out to X`, `contact our office`) and getting relabeled INTERESTED. SmartLead category 3 (Not Interested) did not stop that, and the referral path then cleared a wrong-person suppression. Frank Madrigal, Lindsey Lukas, and Harry Buchman posted as Approve-able drafts.

Those bodies are suppressed with reason `automated_notice`. The check is rules-only and runs before SmartLead's category, before referral promotion, and before the classifier-outage fallback, so it still holds when Jev and Gemini are down. `promoteReferral` does not promote a WRONG_PERSON label, a NOT_INTERESTED label, or text that is OOO or wrong-person. The old line that cleared `wrong_person` after a referral promotion is gone.

A person who is still there can still be drafted: "I'm not the right person, but talk to my colleague Jay, he handles this." Departure wording still wins over that carve-out. "Please contact Jane instead" and "no longer with the company" stay silent.

Guard: `automated notices are not interested drafts` in `test/automated-notice.test.js`

### CC client is an option on every SmartLead card

*"I want that as an option on every card"* — after a Bill Hall EMCOR card
that needed Myles on the prospect thread, not only a Gmail FYI.

Supersedes "Send + CC only on loop-in drafts" (2026-10-19). Regular
**Approve & Send** still omits SmartLead `cc` (deliverability). **📬 Approve
& Send + CC client** now appears on every SmartLead draft card that has
Always-forward addresses (`cc_emails` / `cc_email`) — INTERESTED /
MEETING_PROPOSED / QUESTION and FOLLOW_UP alike, whether or not the draft
says "looping in X from our side". HeyReach stays off (no email CC).
Cards with no Always-forward (SalesGlider) still hide the button. The
button is still the only path that passes `cc` into `sendReply()`.
Recipient is the same Always-forward list. Reply-all CCs and Gmail FYI
are unchanged.

Guard: `Approve & Send + CC client is an option on every SmartLead card`

### Webhook and poller HTML must compare as the same reply (Oct 22)

Bill Hall at EMCOR, Oct 22 2026, 2:52 PM ET. The same inbound posted two Slack cards three seconds apart: one from the SmartLead webhook, one from the inbox poller. The bodies were the same reply. The poller kept `Bill Hall &#8211; Project Executive` and the webhook had already decoded that to a dash. The 120-character prefix diverged at the signature, so text dedupe missed.

Comparison now decodes numeric (decimal and hex) and common named entities, then folds dash variants and curly quotes to ASCII, on both the JS side and the stored-column SQL. The poller and the webhook store the decoded text. Migration `040_decode_inbound_html_entities.sql` rewrites entities already sitting in `inbound_message` from the last 30 days and is in `scripts/run-migrations.js`. It does not fold dashes in the stored column and does not touch older rows.

A stats-id backup (same person, campaign, and SmartLead email stats id inside a short window, even when the texts differ) was added and then removed the same day. A duplicate card is acceptable. A missed reply is not. Dedupe stays text-only. The stats id is still the latest SENT message and is shared by a later, different reply (Doug Baden, 2026-08-03). `idx_pending_replies_stats_dedupe` is not created.

Guards: `Bill Hall entity renderings share a dedupe prefix` and `different text is never deduped, including when the stats id matches` in `test/inbound-entity-dedupe.test.js`. `poller dedupe never matches on stats_id alone` forbids any stats-id match in `reply-dedupe.js`.

### One email, one card, full text (Oct 26)

PR #140 kept the full prospect email on the card. It also made the reply webhook (HTML) and the category-changed webhook (plain text with `>` quote markers and `[email]` expansions) diverge inside the 120-character prefix. Henry Witt, hwitt@hmwitt.com, SG Subs Owners Tickets 1019, Oct 26 2026 2:35 PM ET, got two cards and two portal forwards for one reply.

The canon is `docs/INBOUND_CANON.md`, enforced by `test/inbound-canon.test.js` inside the CI job Invariant guards:

1. FULL TEXT: every Slack card, stored inbound row and drafter input shows the prospect's full email. No silent truncation.
2. ONE EMAIL = ONE CARD = AT MOST ONE SEND: a single inbound email must never produce two cards, two portal forwards or two sends, however many times or ways it reaches us (Smartlead reply webhook, Smartlead category-changed webhook, the SmartLead inbox polling backstop, HeyReach, retries).
3. NEVER DROP A REAL REPLY: a genuinely new reply from the same person must always post. No time-window dedupe and no stats-id/campaign keyed dedupe (both were tried and removed on purpose).

Identity is the email's Message-ID, checked inside the existing claim lock before text comparison. Text is only the fallback, and storage, dedupe, and `preferFullerInbound` share `normalizeInboundText`. A category event updates the stored row and does not open a second card. The same person saying "Thanks" in two emails with two Message-IDs is two cards. A second approve of one email cannot send twice.

This does not bring back a stats-id or time-window match. A duplicate card of one email is still worse than a missed reply, and a missed reply is still not acceptable. Two different Message-IDs are two emails even when the words match. That is the correction to "the same text is always a duplicate": the same rendering of one email is a duplicate; a second email is not.

Guard: `test/inbound-canon.test.js`.

## 2026-10-27

### Disclaimer and scanner footers are automated notices

Kayla Debiec (kdebiec@embracepetinsurance.com, Parlay campaign 4161772, subject "Cavaliers tix") replied with only a confidentiality disclaimer and a Mimecast virus-scan footer. Jev classified it OTHER and wrote no draft. The referral matcher then treated "copying" inside "disclosure, copying, distribution" as "prospect looped in a colleague" and promoted OTHER to INTERESTED, so #parlay-replyhandler got an approval card headed SMARTLEAD — INTERESTED with both labels in the footer.

A reply that, after quoted history and a trailing signature, is only a legal disclaimer or a security-gateway footer (Mimecast, Proofpoint, Barracuda, an external-sender banner, and the same kind of notice) is an automated notice: no approval card, no draft, same `automated_notice` path as the mailbox and departure notices. A real sentence plus that footer is classified on the human sentence and the card still shows the full email, footer included. Referral promotion reads the human sentence only, and bare "copying" is not a referral unless it names who was copied. A later SmartLead "Interested" category does not relabel a disclaimer-only row.

Guard: `disclaimer and scanner footers are automated notices` in `test/automated-notice.test.js`

### An email in the referral is a card; a name alone is not a CC (Oct 27)

Ariel Isaac Franco (ariel@orioncityscape.com), Vector campaign "Vector | Big Owners | Clippers" 4242292, subject "Clippers tix", replied at 10:57 AM ET Oct 27 2026: "Hi please talk to Guy at our office. Guy@orioncityscape.com", plus his signature. SmartLead stamped the lead Not Interested (category 3). The webhook at 14:57:10Z logged `suppressed from Slack` with classification `NOT_INTERESTED` and reason `not_interested`. `promoteReferral` refused to override Not Interested and Wrong Person, so no card posted in #vector-ai-replies. The #144 deploy started about a minute later and did not drop this webhook.

That refusal stays for a name with no address ("talk to Guy", "please contact Jane instead", "I've CC'd our ops manager"). Those rows follow the old path: OTHER can still become INTERESTED, and a Not Interested or Wrong Person label stays silent. The card, when one posts, is the normal card. There is no CC button and no CC field.

When the human-written sentence contains the other person's email, the row is carded even if SmartLead said Not Interested or Wrong Person. The card shows the full reply and the detected address, and adds "Approve & send with CC" for that address. Normal Approve does not add it. Edit can change or clear it. Clearing sends with no referral CC. A non-empty field that is not an email, or a CC the provider cannot place on the same thread, sends nothing. The address is the one they typed. It is not guessed from a name, and it is not taken from a signature, quoted history, or a disclaimer. OOO, unsubscribe, remove-me, and automated notices still do not promote.

The referred person is not enrolled in a cold sequence in this change, and the domain is not blocked.

Guard: `test/referral-cc.test.js`, including `a name with no email has no CC option`.

### Referral drafts are Cayden's two lines (Oct 27)

Any reply that hands us to another person, including a card that shows the CC action, uses this draft and no other:

```
Thank you so much for the contact, {prospect first name}!

Hey {referred first name}, would this be worth meeting about for you?
```

The referred name comes from the human sentence ("talk to Guy" is Guy). If the sentence only has an email, the local part is used when it reads as a first name. Otherwise the second line is "Hey there, would this be worth meeting about for you?" and no name is invented. The mailbox still appends its signature on send. The model does not write this draft. Deep Roots and Vasco wording does not replace it.

The #146 poller did not post Ariel Isaac Franco's card. The webhook row was stored `suppressed` with no Slack ts. When the inbox history is current, the poller's fast path treated any stored row as `already_posted` and returned before `recoverSuppressedReferral`. That skip does not log the address. A row older than `SMARTLEAD_POLL_LOOKBACK_HOURS` is a separate skip (`older_than_lookback`) and also does not log the address.

Both already-posted checks now recover a suppressed referral that contains an email, on that same row, before counting `already_posted`. A name with no email stays suppressed. This is not a second insert and not a time-window dedupe. `alreadyPostedToSlack` still matches a suppressed row so the poller does not insert another copy. `findUnpostedReply` still does not resurrect suppressed rows in general.

`POST /admin/refresh-referral-draft?leadEmail=ariel@orioncityscape.com&campaignId=4242292&dry=0` does not consult the poller lookback or the `already_posted` skip. A named lead or reply id is not limited to the last 30 days. Her row has no Slack ts, so the endpoint posts exactly one card: the two-line template and the CC button for Guy@orioncityscape.com. A row that already has a Slack ts is `chat.update`d on that same message. It does not send.

Guard: `a suppressed email referral the poller would skip still posts once` and `the early already-posted skip recovers a suppressed email referral` in `test/referral-draft.test.js`.

### A left-the-company email is not a referral (Oct 27)

Cayden does not want a card when the person has left, the mailbox is dead, the reply is an auto-forward, or the reply is a no, even if the text contains an email. At 11:49 AM ET the #147 recovery promoted 15 suppressed rows (`[SmartLeadPoll] Suppressed referral with an email promoted to a card`) and posted 13 cards. The unwanted ones were mailbox notices (Wayne Klinger, John Davis, Irene Amaro, Evan Glassman, Katrina Flesher, Frank Bonanno, Andrew Murray, Christopher Hallmeyer), departures (Ricardo Polmon, Bob Reilly), an auto-forward (James Wyman), and a no sent on someone's behalf (Courtney Franklin / Fernanda, greeted "Hey Fersosa" and CC'd to the sender). Don Smith ("Please contact Greg Goodwin or Steve Schofield") was the real handoff. Ariel ("please talk to Guy at our office. Guy@") is still a handoff.

Those bodies do not promote, do not recover, and do not get a referral draft or a CC. A Not Interested label, including SmartLead's category, stays suppressed unless the human text is a current employee's handoff. The sender's own address is never a CC. A role or company local part is not a greeting; the line is "Hey there". This is not a second insert and not a time-window dedupe.

Cards already posted by that poll stay where they are. Nothing is deleted. They are the Slack messages for the names above, and the rows updated around 15:49 UTC on Oct 27 2026 whose inbound matches `not regularly monitored`, `no longer monitored`, `no longer active`, `no longer in use`, `no longer part of`, `no longer a sales representative`, `forward your email`, or `not seeking`, with a real `slack_message_ts`. Reject on the card is the existing Not Interested action.

Ariel's row is outside the poller lookback, so startup posts her one card if she still has none (`ensureArielReferralCard`). A boot that finds a Slack timestamp does nothing. It does not send.

Guard: `test/referral-departure.test.js`.

### Marbella's second reply gets one confirmation card (Oct 27)

Marbella Porcayo (marbella@pacocean.net), Vector campaign 4242292, SmartLead lead 4826394186, replied "Info" at 10:22 AM ET and that card was sent at 10:23. At 10:32 AM ET she replied again, Message-ID `<C472638D-01F3-4902-B61B-C0C8AE0A923A@pacocean.net>`, with "Wed, Oct 28 at 11:00 AM PDT", taking the first time we offered. The webhook logged campaign 4242292 as not accessible while SmartLead was returning 429, stored nothing, and posted no card. #148 fail-opens that access check for a later 429. It does not recreate a reply that was already dropped.

Startup posts exactly one card for that Message-ID in Vector's Slack channel (`ensureMarbellaReplyCard`). The draft is this text and nothing else. The mailbox adds the signature. It is not written by a model:

```
Hey Marbella, that time works for us. We look forward to meeting with you Wednesday, Oct 28 at 11:00 AM PDT!
```

A boot that already has a Slack timestamp, or a sent / approved / sending row, for that Message-ID does nothing. It does not send.

The inbox poller treats already-posted per inbound Message-ID. A later reply on a thread that already has a card is its own card. The same Message-ID is still one card. A lead is `older_than_lookback` only when every timestamp we have (last_reply_time and the newest reply in history) is outside the window, so a later reply inside the window is not dropped because an older timestamp is.

Guard: `test/marbella-one-shot.test.js` and `test/poller-second-reply.test.js`.

### Dead-mailbox and departure auto-replies never become referral cards (Oct 27)

After the email-referral change, the first poller pass re-carded a week of suppressed replies in one second (13 cards across five channels, 7 of them auto-replies: "this email account is no longer active", "the address is no longer in use", "this inbox is no longer being monitored", "no longer part of our team, mailbox not monitored", "no longer a sales representative"). The automated-notice check only knew "mailbox no longer monitored" and "no longer employed / with / has left" plus the words reach out / contact, so these slipped through and a typed address promoted them to INTERESTED with a "Thanks so much for the contact" draft.

A dead or unwatched mailbox, or a departure notice, is an automated notice even when it names an address or a department mailbox. It does not card, draft, or promote. A live person handing us to a colleague with the colleague's address still cards.

Guard: `test/dead-mailbox-notices.test.js`.

### Client channels get only a real interest or a real question (Oct 27)

Josh: "I don't want these replies in the channels anymore. When we get one look at it and if it's a legit interested or question send it in, if not I don't wanna see junk." The reply he saw was an "Unclassified reply" line holding a mail-server "Message blocked" notice ("Your message to ... has been blocked ... aka.ms/EXOSmtpErrors"), with "Not auto-drafted. Reply manually if it needs one."

Only `INTERESTED`, `MEETING_PROPOSED` and `QUESTION` post to a client channel. That includes meeting and booking requests, a referral from a live person who typed an address (#146), and a positive mixed reply. Everything else is stored as a `suppressed` row with a `suppression_reason` and is never posted:

- bounces, NDRs, "Message blocked", mailer-daemon, postmaster: `bounce`
- auto-replies, mailbox notices, dead or departed mailboxes, ticket bots, disclaimer-only: `automated_notice` (the dead-mailbox rules from #150 are part of this)
- out of office: `ooo`
- clear no: `not_interested`
- unsubscribe: `unsubscribe` (the SmartLead unsubscribe call and opt-out handling are unchanged)
- OTHER, OBJECTION and anything unclassified: `not_interested_channel`

The "Unclassified reply" alert is retired. `shouldAlertOther` always returns false and nothing posts a raw OTHER line. A bounce text is caught by rule before any label, so it never reaches Slack even if SmartLead or the classifier called it interested.

When the primary classifier leaves a reply as OTHER, Claude Sonnet gets one more look (`classifyOtherSecondOpinion`). INTERESTED, QUESTION or MEETING_PROPOSED upgrades it and it posts normally. Anything else, or an Anthropic error, stays OTHER and is suppressed. When unsure the prompt says JUNK.

Unchanged: opt-out handling, Gabe Calls forwarding, booking detection, phone lookup on posted cards, and the error alert when a draft fails on a legitimate reply. Bounces are still seen by SmartLead, which owns bounce handling for the lead. Replyhandler never acted on `EMAIL_BOUNCED`, so nothing there changes. Suppressed rows stay visible in the diagnostics endpoint and `resurface-suppressed`.

Guard: `test/channel-only-real-replies.test.js`.

### Follow-up card sequence for positive replies (Oct 27, OFF by default)

Josh's spec for the follow-ups channel. Every step is a Slack card a human clicks. Nothing sends to a lead on its own. Caller is Gabe (`FOLLOWUP_CALLER_NAME`). It is off until `FOLLOWUP_SEQUENCE_ENABLED=true`, and it only enrols positive replies (INTERESTED, MEETING_PROPOSED) that arrive after it is turned on (never a back-fill; `FOLLOWUP_SEQUENCE_START` and a 6h age cap enforce that). It applies to every client. When on, it replaces the old outbound cadence for positive replies (`scheduleAfterOutboundSend` returns early) so a lead never gets two sets of nudges.

Days are BUSINESS days (Mon-Fri, skipping New Year's Day, Memorial Day, July 4, Labor Day, Thanksgiving and the day after, and Christmas; a weekend holiday is observed on the nearest weekday). Call cards only come due inside the lead's local business hours (9-5 Mon-Fri, lead time zone, else the client's, else Central). Open times always come from `resolveVerifiedSchedulingSlots`, the same live availability the reply drafts use.

Every call card carries this line and the phone, with one button per outcome (no bare "Connected"; if you spoke to them you pick what they said): Meeting booked (stops the sequence), No answer / left voicemail, Spoke to them: not interested (stops the sequence), Spoke to them: call back later (sequence continues), Wrong number (no more call cards for that lead; emails continue): "Hey {first_name}, this is {caller_name} with {client_name}. We emailed you about {offer + value prop in one sentence}. Did you still want to take a peek at that in the next couple days?"

- Day 0: if there is a phone, the first reply draft says "calling you now" (only inside the lead's call hours) and a call card posts. When Gabe clicks No answer/VM, the email card posts by itself 5 minutes later (no second click). Its text is "Hey {first_name}, just tried you, left you a voicemail. Still want to take a peek at this?" followed by "Does X or Y work for a quick call?" with two live times.
- Day 0, 3 to 4 hours later: call card, no voicemail.
- Day 1: call card at a different time of day, then an email card "Those times got taken, here are new times" with two fresh live slots (slots already offered are excluded).
- Day 3: call card with voicemail 2 ("calling about {offer}, I'll send you one more email, if you're still interested we can get this scheduled"), then an email card adding one real proof point, then an "Any thoughts?" card.
- Day 5: breakup email card ("Don't want to keep emailing you. Did you still want to meet about this, or have priorities changed?").
- Day 6: final call card plus a breakup voicemail: "Hey {first_name}, {caller} with {client}. Last call from me. Quick recap: {offer}. {proof}. If it's still a priority, reply to my email and we'll get it scheduled; if not, no worries." The proof sentence is the verbatim proof point from the campaign copy and is left out when there is no real proof (never invented). Then stop.
- No phone: no calling-now line and no call cards; email cards only.
- The "Does X or Y work for a quick call?" line stays fixed (Josh, Oct 27). LinkedIn-sourced leads get these as LinkedIn messages through the existing send path.
- Any later inbound reply, a booking, an unsubscribe or a DQ stops the sequence and closes its unsent cards. A reject on one email card skips that step only.

Offer line and proof point come from the client's own campaign copy (SmartLead campaign sequence, else the outbound mail in the lead's thread). The proof point must be a sentence copied word for word from that copy and contain a real number; the offer line may not carry a number the copy lacks. When no real proof exists the Day 3 proof card is held, never invented. A hand-entered row (`POST /admin/followup-sequence/copy`, no key like every admin route) overrides extraction.

Guards: `test/followup-sequence-pure.test.js`, `test/followup-sequence-guards.test.js`, and `test/followup-sequence-db.test.js` (runs only where PGlite is installed).

Update (Oct 27, Josh): the Day 0 voicemail email and the Day 6 breakup voicemail were reworded as above. Guards: `test/followup-sequence-pure.test.js` (scripts) and `test/followup-sequence-db.test.js` (auto-fire 5 minutes after No answer, Day 6 card with and without proof).

Update (Oct 27, Josh): "Spoke to them: call back later" no longer records right away. It opens a Slack modal with a datetime picker (the picker uses the clicker's Slack time zone; the modal states the lead's time zone, their current local time and the call hours, and the default is the next open slot in the lead's business hours). The route validates the pick before acknowledging (future time, inside the lead's call hours, Mon-Fri, not a holiday) and shows the error on the picker otherwise. On submit the click is recorded as `call_back`, a `call_callback_<n>` step is queued for that time on the same sequence (same script and five buttons, no voicemail line), and the original card is redrawn with "Callback set for ...". The rest of the sequence is untouched and continues on its own timing; a callback set after the last step reopens a completed sequence. A booking, any inbound reply or unsubscribe, a DQ, or Not interested cancels pending callbacks with the other steps; Wrong number cancels them too. Nothing is sent to the lead. Guards: `test/followup-sequence-pure.test.js` (modal, default time, validation), `test/followup-sequence-guards.test.js` (route validates before ack), `test/followup-sequence-db.test.js` (modal opens without recording, scheduling and posting at the time, sequence continues, cancellation on booked/reply/unsub/DQ/wrong number, reopen, double submit).

Update (Oct 27, Josh): the callers are Gabe (`U0CAL8ZDG92`) and Cayden (`U0BL8JT75KN`). `FOLLOWUP_CALLERS` maps Slack user id to display name (`U0CAL8ZDG92:Gabe,U0BL8JT75KN:Cayden`, or JSON); without it the old single `FOLLOWUP_CALLER_NAME` / `FOLLOWUP_CALLER_SLACK_ID` applies. The call script, every voicemail and the Day 6 breakup say "(name)" literally ("Hey {first_name}, this is (name) with {client_name}..."), so whoever calls says their own name; the claimed caller's name is never put into a script. Cards @-mention every configured caller until one of them clicks an outcome on the lead. The first configured caller to click any outcome (including setting a callback) claims it (`followup_sequences.claimed_by_*`, migration 046, first-come, atomic). Later cards for that lead @-mention only the claimer and show a "Caller:" line. A click by someone who is not on the list still records the outcome but is logged (warning plus `nonCaller` on the step) and never claims. Still nothing is auto-sent to a lead. Guards: `test/followup-sequence-pure.test.js` (parsing, "(name)" scripts), `test/followup-sequence-guards.test.js` (env example), `test/followup-sequence-db.test.js` (unclaimed card, claim, later mentions, no steal, non-caller, callback claim).

### No-show rebook card for Gabe and Cayden (Oct 27, OFF by default)

Josh's rule: a no-show is an obvious one, detected about 5 minutes after the meeting ends (not 45), the same "meeting ended" idea as the Fireflies call-finished notifier. A booked meeting is a no-show when Fireflies has no recording of it, OR the recording is under 5 minutes, OR only one person joined or spoke (Fireflies' own notetaker never counts). Anything else is attended. A transcript that is still processing or live is HELD and re-checked, never called a no-show.

On a no-show, ONE rebook email card goes to the follow-ups channel tagging Gabe and Cayden (first click claims it; the sent-confirmation card shows who clicked). Buttons are the standard FOLLOW_UP card: Approve & Send, Edit & send, Reject (on a follow-up card this reads as Skipped). It sends only on a click, through the existing send path. Copy is short, uses two live times plus the booking link, and claims nothing. The extra call cards, day 2 email and breakup only exist with `GHOSTED_MEETING_FULL_SEQUENCE=true`.

Scan runs every 2 minutes. Knobs: `GHOSTED_MEETING_GRACE_MINUTES` (5), `GHOSTED_MEETING_MIN_MINUTES` (5), `GHOSTED_MEETING_MENTIONS`, `GHOSTED_MEETING_FULL_SEQUENCE`. Guard: `test/ghosted-meetings.test.js`.

### Day-30 nurture (built, OFF by default, not enabled)

Josh's spec (via CRM): a lead whose positive-reply follow-up sequence ran to the end gets a Day 30 nurture touch, as a human-approved card. Nothing sends on its own. Go-live steps live in `docs/nurture-day30.md`.

- **Entry:** a `followup_sequences` row with `status = 'completed'` and `origin = 'reply'`, for a client listed in `NURTURE_CLIENT_IDS`, that finished after `NURTURE_ENROLL_START`. The last follow-up date is the latest email that was actually sent or call outcome logged, not a card that was only posted. If nothing went out the row is recorded as `exited / no_followup_sent`.
- **Exits and pauses** (checked at entry, every 10 minutes, when the card is due, and again at the Approve click): DQ, client claimed, unsubscribe, NOT_INTERESTED, WRONG_PERSON and a no-show rebook sequence set `exited`. A positive reply (INTERESTED, MEETING_PROPOSED, QUESTION) or a booked meeting sets `paused`. Out-of-office and other automatic replies change nothing. A newer finished sequence for a paused lead supersedes the pause.
- **Stages:** none / day30 / day90 / quarterly / paused / exited, mirrored to the HubSpot contact as `nurture_stage`, `nurture_next_touch_date`, `last_outreach_date`, `nurture_exit_reason`. Only day30 has copy. After a Day 30 send (or skip) the lead moves to day90 with an informational date; day90 and quarterly touches never post until Research sends copy.
- **Card:** NURTURE-tagged, posted to `#nurture` (C0BHBDTMRFY) by the client's Slack bot. Name, company, last outreach, phone, last reply or call summary, HubSpot link, the email, and Approve & Send / Edit & send / Skip for Josh and Cayden only. No phone on file: the reply's own number, then HubSpot, then the existing reply phone lookup once (it keeps its own spend ceiling, and only runs for someone who replied positively).
- **Send:** Approve imports the lead into Smartlead campaign `SMARTLEAD_NURTURE_CAMPAIGN_ID` (3122546) with the approved subject and body in custom fields. It refuses unless every step of that campaign's sequence renders `{{nurture_subject}}` and `{{nurture_body}}`, so the current generic sequence cannot send unapproved copy. It also refuses an unsubscribed lead, a lead already in the campaign, or a lead active in another campaign, and it never overrides the blocklist or unsubscribe list.
- **Flags (all off):** `NURTURE_ENABLED`, `NURTURE_HUBSPOT_SYNC_ENABLED`, `NURTURE_POST_ENABLED`, `NURTURE_SEND_ENABLED`.
- Admin routes follow the no-key rule: `GET /admin/nurture` (counts only) and `POST /admin/nurture/run?dry=1`.

Guards: `test/nurture-day30-pure.test.js`, `test/nurture-day30-db.test.js` (PGlite).

## Nurture: manual enrolment (migration 049)
Leads can be enrolled by hand with their own subject and body, no `pending_replies` row, and optionally no
HubSpot contact. Dry run is the default; one bad lead blocks the whole batch; the endpoint takes no key
(Josh, Oct 20) but only writes for clients listed in `NURTURE_CLIENT_IDS` and never returns names or emails.
Manual rows are judged by email, from enrolment onward, so a lead's older replies don't pause it.

## SalesGlider's own ICP: any B2B service business (2026-10-28)
Josh set SalesGlider's own ICP to any B2B service business with roughly $36K+ customer lifetime value. It is no longer
limited to trade contractors. Decision makers are owners, founders, CEOs, presidents, partners, and heads of sales or growth.
The old grader (`choice`, pass = `commercial_trade_contractor`) disqualified staffing firms with 99-100% confidence.
- Reply cards for SalesGlider use the code-owned variant `b2b_service` (pass `b2b_service_business`), which wins over
  `topup.icp_variants` (still `choice` for topup's own pipeline). Cached results are only reused when graded for that variant.
- Buyer titles for SalesGlider are `DEFAULT_CLIENT_PERSONAS.salesglider`, not `clients.icp_profile.titles`.
- A cached `reply_icp_verdicts` row graded against a different pass label is ignored, so changed ICPs regrade by themselves.
- Guards: `test/reply-icp.test.js` (SalesGlider grades against any B2B service business; cached verdict with an older pass label),
  `test/decision-maker.test.js` (SalesGlider buyers).

A meeting that was booked but never held (no-show, cancelled, moved) does not exclude a manual lead (Josh, Oct 29: "no-shows count for nurture"). Only a meeting still upcoming on the calendar, a reply marked `meeting_booked` after enrolment, or a later positive reply pauses it. The old check (any meeting row, bridge booking, earlier reply or past call that said "booked") is still used for sequence leads.

## Context at the top of every #followups-ai-replies card (2026-10-28)
*"i need more context in followups channel."* Every card there (Day 0 call, follow-up email, rebook / no-show) now opens with: the client name in
bold; the lead's name, title, company, phone and email; their actual reply (quoted, short); our last sent message (short excerpt); the campaign and the
offer; the meeting or no-show time when there is one; links to the original reply card and the Smartlead thread; and the ICP fit and decision-maker
verdicts with a short reason each, worded like reply cards. Call cards also show the full email we sent and their full reply directly under the script.
- The call script and the voicemail share their first line, so a call card has one script block: opening, "if they answer", "if it goes to voicemail".
- The offer comes from config first (a hand-entered row, then the client's ICP offer) and from the campaign copy last. With no offer anywhere the line is
  left out, and the scripts say "We emailed you recently." The "[offer not found in campaign copy ...]" placeholder is gone.
- ICP and decision-maker lines are the verdicts already stored on the original reply row (`pending_replies.icp_verdict`). No model call.
- Title and company are stored on `pending_replies` from now on (migration 050). Older rows fall back to the decision-maker title and the work-email domain.
Guard: `test/followup-card-context.test.js`

## Lead emails: instant "Meeting booked" brief, one daily positive-reply roll-up, no callback email (Josh, Oct 29 2026)
Approved by Josh on Oct 29 ("a b b a perfect brief make sure i get these too"). This reverses the earlier "client notify on every send" call.
- **Meeting booked** is the only instant lead email, for every channel (Allo calls, Calendly, anything that reaches `/webhook/booking-bridge/booked-email`).
  It is a full brief: opener, when and where, who they are, their company, how they booked, the conversation so far, call notes, talking points, watch-outs,
  links. Data is best effort (Smartlead thread, one Serper search plus a homepage fetch, one model call, the client's calendar for the time); any piece that
  fails is left out or printed as "not found", and the email still goes. `BOOKED_BRIEF_DATA=off` skips the lookups. Josh is ALWAYS on To or CC, on top of the client list and Cayden/Gabe.
- **Positive replies** (INTERESTED, MEETING_PROPOSED) reach the client as ONE email per client, weekdays 4:00pm CT, `PROSPECT_REPLY_NOTIFY_MODE=rollup` (default;
  `instant` restores the per-send email, `off` sends none). Only replies we actually sent an answer to (the Smartlead send succeeded) are queued; follow-up nudges
  are not. To = the client's notify list, CC = Josh and Cayden. Weekend replies ride in Monday's email; an empty day sends nothing. Queue = `pending_replies.client_digest_status`
  (migration 051). Slack cards say "Queued for the 4:00 PM CT client roll-up" for queued replies and nothing for the rest.
- **Callback ("Warm lead:") emails are removed**: allo-calling flag `WARM_LEAD_EMAIL_ENABLED` is off and the route and email builder are deleted. A callback that is a booked meeting still sends the Meeting booked brief.
Guards: `test/invariants.test.js`, `test/booked-brief.test.js`, `test/client-reply-digest.test.js`.

## Edit modal: "CC client on this reply" (Josh, Oct 29 2026)
Josh: "Still need to be able to cc client when I edit." Before the roll-up, Edit & send always emailed the client instantly; the roll-up (#177) turned that into a queue, and the Edit modal had no way to copy the client (only the card's Send + CC client button did).
- The Edit modal shows an optional **CC client on this reply** checkbox listing the client's Always-CC addresses (smartlead replies with a list only). Ticked: those addresses go on the prospect reply, exactly like the card's Approve & Send + CC client button (Always-CC only, never round-robin). Unticked: unchanged.
- The 4:00pm CT roll-up is independent: the reply is still queued for it either way. The no-CC card notice now says the client gets the roll-up while `PROSPECT_REPLY_NOTIFY_MODE` is rollup.
Guard: `test/edit-cc-client.test.js`

## Dead Slack buttons: retire closed cards, tell the clicker, cap the CC label (Josh, Oct 29 2026)
Josh: "Ship the card fixes." A card's buttons sometimes did nothing. Cause: the booking bridge closed the reply (`meeting_booked`) but left the card's Approve / Edit / Reject buttons up, and every handler returned silently on a non-pending reply.
- **Closers retire the card.** When the booking bridge, or a sibling close from Meeting booked / DQ, closes a reply, its Slack card is flipped to the confirmation card with no buttons ("Meeting booked, no action needed", or the DQ card). Best effort (`services/retire-slack-cards.js`): a Slack error never fails the booking. Follow-up-sequence cards and cards never posted are skipped.
- **Dead click = private notice.** Clicking a reply-card button (Approve, Edit, Reject, DQ, Meeting booked) on a reply that is no longer open shows an ephemeral "Already handled (status)" via the interaction `response_url` (`services/card-click-guard.js`). Fails open. Approve still runs its own handler so the stale card is relabelled. Follow-up-sequence and nurture buttons keep their own handling.
- **CC checkbox label is capped at Slack's 75 characters** (`ccClientOptionText`). A long Always-CC list used to make `views.open` fail with invalid_blocks.
Guard: `test/stale-card-retire.test.js`
## "We just CC'd you" notice to the client (Josh, Oct 29 2026)
Josh: "when we cc a client we need an email from my inbox saying hey we just ccd you check your spam heres the sender." Approved with his edits at 10:23am CT.
- Whenever a reply goes out with the client CC'd (Approve & Send + CC client, or Edit with the "CC client on this reply" box ticked), EACH always-CC contact gets their own short plain email from Josh's primary Gmail (same sender as the booked-meeting and roll-up emails). Subject `Hot lead: we CC'd you`. Body: `Hi {first name},` / `We just CC'd you on our reply to {lead_name} at {company}. If you don't see it, check your spam and promotions folders. It came from {sender_email}.` / `Thanks,` / `Josh`. No add-to-contacts line.
- First name comes from the contact's email (the client record stores addresses only): john.smith@ -> John. Role mailboxes (info@, office@), initials and junk fall back to `Hi there,`.
- Cayden is CC'd on every one, from the same setting as the booked-meeting email (`BOOKED_MEETING_EMAIL_CC`, default cayden@salesglidergrowth.com).
- **Flag `CC_NOTICE_EMAIL_ENABLED`, default OFF.**
- Sent only after the SmartLead send succeeded with the client addresses on it. Never the prospect, Josh, the sending inbox or the round-robin rep. A failed notice never fails the reply.
- The sending address is the mailbox of the SENT message we replied to (the stats_id), else the latest SENT message, else the address the prospect wrote to. If it cannot be found the sentence is left out.
Guard: `test/cc-notice-email.test.js`

## Every LinkedIn (HeyReach) reply gets a card, for every client (Josh, Oct 30 2026)
Josh: "I'd like to see any heyreach reply from now on. For all clients." Trigger: three LinkedIn replies on one client's account (a "why I accepted your invite" reply, a "what made you send the request" reply and a "I do not connect with people I do not know" reply) were classified OTHER and recorded as suppressed rows (`not_interested_channel`), so no card posted. The Oct 27 interested-only gate was written for email and also covered LinkedIn.
- **LinkedIn only.** `slackChannelSuppressionReason({ platform: 'heyreach' })` returns null, so no label (OTHER, NOT_INTERESTED, WRONG_PERSON, OOO, ...), no cold-inbound pitch filter and no text heuristic hides a HeyReach reply. Email keeps the interested-only gate unchanged. `HEYREACH_POST_ALL_REPLIES=off` restores the old LinkedIn gate.
- **Alert cards, no draft** for any label that is not INTERESTED / MEETING_PROPOSED / QUESTION. Those three still draft as before.
- **The HeyReach webhook no longer drops a reply** for a missing client API key, a payload with no lead or conversation id (a derived thread key is used), a HeyReach API blip while verifying the campaign, or a classifier error (card posts as OTHER with no draft). The only skips left: an empty body (nothing to show), an inactive client, an exact duplicate, and a campaign that belongs to another client's workspace (that one leaves a suppressed audit row, because posting it would land in the wrong client's channel).
- **Recovery** (`recoverUnpostedSlackCards`, `repostReplyRowToSlack`) retries any unposted LinkedIn row, not only the three positive labels.
- **No new paid enrichment.** Visibility-only LinkedIn cards (OTHER, NOT_INTERESTED, WRONG_PERSON, OBJECTION, COMPETITOR) skip the paid email/phone waterfall, as they did before when they were suppressed.
- **Duplicate guard is unchanged:** same person plus the same text is still one card.
- `POST /admin/heyreach/approval-card` accepts any label. A positive label still needs a draft. A neutral label (or no label and no draft) posts an alert card from the stored row, which is how an older suppressed reply is shown. It never inserts a second row and never double-posts.
Guard: `test/heyreach-all-replies.test.js`.

## Clients get three automatic updates, and prospect sends never CC them (Josh, Oct 31 2026)

Josh: clients get exactly three automatic updates — (1) the weekday EOD roll-up of positive replies, (2) the instant meeting-booked brief, and (3) the day-of meeting brief. Clients are never CC'd on a Smartlead or HeyReach prospect reply. This supersedes "CC client uses Always-forward (`cc_emails`)" and the line that setting `contact_email` later re-sends a portal invite.

- **`clients.notify_emails`** is the only list for those updates. Migration 052 copies the current `cc_emails` into it once. Later edits to Always-notify do not overwrite it. Portal login stays the first Always-notify address (`cc_emails` / legacy `cc_email` → `contact_email`). Do not provision the portal from `notify_emails`.
- **Plain Approve does not CC the client.** Smartlead and HeyReach sends strip `cc_emails`, `cc_email`, `contact_email`, and `notify_emails` even when reply-all already has them on the thread. Josh's, Cayden's, the lead's, and SalesGlider's own inboxes stay stripped too. HeyReach `sendMessage` has no email CC field.
- **Keep both manual copies.** The card's **Approve & Send + CC client** button and the Edit modal's **CC client** checkbox still put `notify_emails` on the Smartlead `cc` string. They do not pull `cc_emails`, `cc_email`, `contact_email`, or round-robin.
- **The two updates that live here** (roll-up and meeting-booked brief) send To `notify_emails`. `PROSPECT_REPLY_NOTIFY_MODE=instant` is the old per-send Gmail and uses the same list; it does not also queue the roll-up and it does not CC the prospect send. Round-robin is stored and is not emailed. The Deep Roots gate still applies to the digest and the instant email. Gabe Calls inbound forward stays a campaign map and does not read `cc_emails`.
- **The day-of meeting brief now lives here, behind a review hold.** See "Day-of client briefs are held for review" below. `reminder-email.js` still emails the prospect (`meeting.lead_email`) one hour before. There is no Resend client here. The client copy goes to `notify_emails` only after a reviewer releases it.
- **Portal updates never re-invite.** First-time provisioning may invite when Always-notify has an address and `PORTAL_SKIP_INVITE` is not true. Admin PATCH and sync-all call `provisionClientToPortal` with `invite: false`, so `skip_invite` is true. Adding an email later updates the portal record and does not email another invite.

Guards: `test/client-notify-emails.test.js`, `test/portal-provision.test.js` (`an update never re-sends a portal invite`).

## Reject only closes the card (2026-10-31)

Reverses "Reject also marks Not Interested in SmartLead" (2026-10-01) for every card, on both Smartlead and HeyReach.

- **❌ Reject** sets that `pending_replies` row to `rejected` and rewrites the Slack card. It does not send a reply.
- It must not call `markLeadNotInterested`, `updateLeadCategory`, or any Smartlead category endpoint, and it must not change a HeyReach lead category or status. Campaign status is untouched.
- The local classification stays whatever it was. Reject does not write `NOT_INTERESTED`.
- Inbox reject still cancels pending follow-up nudges for that thread.
- A FOLLOW_UP card is unchanged from 2026-10-21: Reject sets that step to `skipped`, does not cancel later steps, and does not touch the lead category.

Guard: `Reject closes the card and does not change the lead category`. Runtime proof: `test/card-safety.test.js` (`Reject makes no Smartlead or HeyReach category or status call`).

## SalesGlider ICP is any high-ticket B2B business (2026-10-31)

Replaces the 2026-10-28 line that limited SalesGlider to a B2B service business with roughly $36K customer lifetime value. The pass is still `b2b_service_business` on the `b2b_service` variant. The instructions, that pass criterion, `low_value_or_solo`, and `DEFAULT_CLIENT_VARIANTS.salesglider.note` now say any high-ticket B2B business. There is no dollar LTV cutoff in those texts.

Guard: `SalesGlider grades against any high-ticket B2B business, not only trade contractors`.

## Fireflies ICP calls also match attendee domain and onboarding titles (2026-10-31)

A client's ICP is still built only from facts in their Fireflies transcripts, and a miss is still `needs_review`. Search now also keeps a call when:

- a participant, attendee, host, or organizer email uses the domain of the client's contact, CC, or booking address (own mailboxes such as salesglidergrowth.com stay skipped), or
- the title contains Onboarding or Discovery together with a contact's first name (from a person email, not a role mailbox).

The weekday auto-build also scans the last 90 days of transcripts for those same matches. Invented cities and other unsupported phrases are still dropped.

Guard: `a call matches on attendee domain or Onboarding/Discovery plus a first name` in `test/client-icp-profile.test.js`. The 90-day window is `automatic build searches Fireflies across a 90 day window` in `test/icp-auto-build.test.js`.

## A hand-entered ICP can be saved on the client (2026-10-31)

`POST /admin/clients/:clientId/icp-profile` sets `icp_profile`, `icp_status`, `icp_source`, and `icp_transcript_count`. Same open admin surface as the other client routes — no API key. The profile may only contain industries, titles, company_size, geos, offer, and exclusions, each a string or a list of strings. Status is `ready`, `needs_review`, or `skipped_existing` (default `ready` when the profile has facts). The response is those ICP columns only, never the client row (that row carries API keys). This write does not re-provision the portal.

Guard: `a hand-entered ICP accepts the six fields and rejects a bad shape` and `saveManualIcpProfile writes the ICP columns and does not return the client row` in `test/client-icp-profile.test.js`.

## Interested reply card: full context first, then just the latest exchange (2026-10-31)

Josh: "I need to see the client name, his campaign, his contact info, the ICP and DM, and what we said and what he said and then the card to decide. Then if we get into back and forth, just our last, his last, drafted reply and button, and click in to see whole thread."

- The **first** reply card, top to bottom: client name, campaign, the lead (name once), phone with its mobile label, email, LinkedIn, and the company website, then the ICP and decision-maker scores, what we said, what they said, the draft, then the buttons. Contact details are not repeated in a footer.
- A **later reply in the same thread** (more than one real message from them, or a message from us after they already replied) shows only our last message, their last message, the draft, the same buttons, and **View full thread**. That button opens a modal with the whole thread plus the client, campaign, contact, and scores. The cold email plus their first reply is still the first card.
- Approve, Approve & Send + CC client, Edit, Reject (close only), DQ, and Meeting booked stay separate buttons. `action_id` and `value` stay the reply id, so a card already posted with the old layout still works. Follow-up cards are unchanged.

Guard: `test/reply-card-layout.test.js`.

## Interested card review: no client header, Jev fit line, mobile only when confirmed (2026-10-31)

Josh reviewed the PR #189 mockups.

- Drop the bold client-name header. Each client already has its own Slack channel, so the name at the top was noise. Campaign, lead, contact, ICP, what we said, what they said, the draft, and the buttons stay. Follow-up cards still use their own one-line header.
- The ICP line is the Jev website check, not a percentage. ReplyHandler already ports topup `icp-llm` (`supabase/functions/icp-llm/index.ts`, `JEV_Q` / `PASS`, skill `skills/icp-website-gate`): read a cached `client_salesglider.icp_llm_results` row for this variant, otherwise fetch the company site (homepage, or cached `icp_site_text`) and grade it with the same category prompt against `clients.icp_profile` or the client's variant. Gemini stands in for Jev because this service has no OpenRouter key. The card shows `Fit — {reason}` or `Not a fit — {reason}`. No ICP on file stays `ICP: not on file`. A fetch that fails or times out says `ICP: site unreachable`. A page that loads but is too thin stays unreadable. The decision-maker line stays under that. Confidence is still stored and is not shown.
- The check is cached on `client_tag` + domain (`reply_icp_verdicts`), including an unreachable or unreadable fetch, so the next card for that client and domain does not fetch again. A different client's ICP is a different cache row. A stored `icp_profile` does not reuse a Jev row graded for another variant.
- Phone: `_(mobile)_` only when the line type is confirmed mobile (`phoneLabel` or `phoneType` is `mobile`). A source number, a landline, VoIP, or anything unverified is shown with no label. The number itself still shows.

Guard: `the interested card has no client header, a Jev fit line, and a mobile label only when confirmed` in `test/owner-intent.test.js`. Website-check cases: `an unreachable website is said so, not graded, and retried later` and `a stored ICP is judged from the website, not another client's Jev row` in `test/reply-icp.test.js`. Phone: `a phone is labeled mobile only when the line type is confirmed mobile` in `test/reply-card-layout.test.js`.

## Reply ICP check calls Jev, not Gemini (2026-10-31)

Josh: no Gemini. The reply ICP check does not grade with Gemini and has no Gemini fallback. When there is no cached topup Jev row, the card calls Jev the same way topup `icp-llm` `jev()` does: `POST https://openrouter.ai/api/alpha/decisions` with `OPENROUTER_API_KEY`, model `typesafe/jev-1.13`, and the variant's category question. That is the OpenRouter call behind the spec `jev:typesafe/jev-1.13|<variant>`. Reusing an existing `client_salesglider.icp_llm_results` Jev row is still the step before a new call. A missing key or a failed Jev call shows `ICP: check failed` and is not written to `reply_icp_verdicts`, so a later card retries. An unreachable site still says `ICP: site unreachable` and is also not cached.

Guard: `a missing Jev key or a failed call shows ICP: check failed and is not cached` and `a miss calls Jev on OpenRouter and does not call another grader` in `test/reply-icp.test.js`. The owner-intent guard `the interested card has no client header, a Jev fit line, and a mobile label only when confirmed` also rejects a Gemini grader in `reply-icp.js`.

## Day-of client briefs are held for review (Josh, Oct 31 2026)

Josh: every client brief needs a pre-send review hold. Build it about 2 hours before the meeting and put it in a queue instead of sending. Notify the reviewer. Only a released brief may be emailed, and a brief with zero context can never be released or sent. Unreviewed briefs never auto-send. `CLIENT_DAYOF_BRIEF_ENABLED` stays default off so nothing reaches a client until he turns it on.

- **When.** `CLIENT_DAYOF_BRIEF_LEAD_MINUTES` (default 120) before `meetings.confirmed_time`, while the meeting is still in the future. A `confirmed_time` stamped at insert (within 2 minutes of `created_at`) is not a meeting time and is skipped. One row per meeting (`client_dayof_briefs.meeting_id` unique). A restart does not insert or notify a second time once `reviewer_notified_at` is set. A failed reviewer notify is retried. A failed client send is retried only for `released` rows and stops two hours after the start.
- **Hold.** Status is `held`, `released`, or `blocked`. The cron inserts `held` and does not email the client. `GET /admin/client-briefs/pending` lists held rows. `POST /admin/client-briefs/:id/release` merges optional enriched fields and re-renders. `POST /admin/client-briefs/:id/block` drops it. `GET /admin/client-briefs/preview?meetingId=` renders one meeting and does not queue or send.
- **Reviewer.** `REVIEW_NOTIFY` is one target: an `http(s)` URL gets a JSON POST, an email address gets the brief from the primary Gmail. The documented default is `salesglider-briefs@mail.grokbot.com` (`docs/.env.example`). An email subject starts with the fixed tag `[Client brief review]`, then the lead, company, and meeting time. The body includes the rendered brief and the release, enrich, and block links. Enrich is a POST of JSON fields to the release link. No target still holds the brief.
- **Send.** Only `released`, only when the flag is on. To = `clients.notify_emails` (Vector's list is that client's notify list, copied once by migration 052). CC = Josh (`BOOKED_MEETING_EMAIL_TO`, default joshua@salesglidergrowth.com), not duplicated on To. An empty notify list does not send. This does not CC a client on a Smartlead or HeyReach prospect reply.
- **Zero context.** Release and send refuse a brief that has none of: how they came in (campaign, channel, or source), company info (name, what they do, size, or site), past emails or calls (summary, quote, or call notes), or a stated ask. Missing LinkedIn alone does not refuse. A refused release stays `held`. Enrichment that adds one of those can then release.
- **Shape.** The client email uses the HTML shell of the briefs `send-brief` already sends Josh (Client portal Supabase `scvrsmfzyvmmbnaolcrg`, function `send-brief`: Arial 14px, `h3` header, bold section title, bullets). Subject is `Brief: <name> @ <time>`. That function only posts prebuilt HTML to Josh through Resend. ReplyHandler renders here and sends with Gmail to `notify_emails`. It does not call `send-brief`. Sections, when there is something to say: Who (email, phone, LinkedIn, title, location), ICP fit, LinkedIn (DM history already on the reply), Email thread, Call history, Source campaign, About the company, Open items, Flags. Empty sections are left out. Facts come from the meeting and the stored reply. Nothing is researched or invented. The reviewer adds company detail the row does not have.

Guard: `test/client-dayof-brief.test.js`.

## Day-of briefs gather the same facts on hold and on preview (Josh, Oct 31 2026)

Josh rejected a brief that only had a name, a campaign, and a bare website. The hold and the dry-run preview have to fill the same sections from the lookups reply cards already use, not from a one-off script.

- **One gather.** `gatherBriefFacts` runs for the cron hold and for `GET /admin/client-briefs/preview`. A section that is empty after that gather is left out of the email.
- **What it may read.** The stored reply and meeting. Smartlead message history and the lead record when the thread, phone, or LinkedIn is missing. Person-profile lookup for LinkedIn, title, and location. The email waterfall for phone and LinkedIn. HeyReach only when a LinkedIn URL is already known (no name-only search, so a different person is not attached). Allo calls for the phone on the brief. The company site, and only a sentence that is on the page. A phone labeled Tel/Phone in the prospect's own reply. The cached ICP verdict. If that verdict is missing, the line is "ICP fit: not on file" — this job does not call Jev or Claude.
- **What it may not do.** Invent a title, a headcount, a profile, or a call. A lookup that fails or is not configured leaves that fact out.

Guard: `test/client-dayof-brief.test.js` (`the live hold and the preview pull the same sections`).

## Client briefs use the reply-card ICP line and drop the campaign (Josh, Oct 31 2026)

Josh, on the held client brief: explain ICP fit from the Jev website check the same way a reply card does, add the decision-maker line, and take the source campaign off the email.

- **ICP.** `gatherBriefFacts` calls `resolveReplyIcp` (`src/services/reply-icp.js`) with `grade: true`, on both the cron hold and the preview. The line is the card's words from `icpFitPlain`: `Fit — {reason}`, `Not a fit — {reason}`, `ICP: not on file`, `ICP: check failed` (and the card's other unknown reasons, such as `ICP: site unreachable`). A failed check is not replaced with a softer line.
- **Decision maker.** Same function as the card: `loadClientPersonas` then `judgeDecisionMaker`, printed with `decisionMakerText`. The line says whether this person's title matches the client's target titles. It does not invent another person's name.
- **No source campaign.** The campaign can still sit on the stored facts (the zero-context guard still counts how they came in). It is not a section in the email.
- **Shape.** The HTML shell stays the one `send-brief` already uses (Arial 14px, `h3`, bold section title, bullets). A search of Josh's Gmail for a brief he answered "yes this is awesome" did not find that reply. The briefs from `briefs@reports.salesglidergrowth.com` already use this shell.

Guard: `test/client-dayof-brief.test.js` (`prints the reply-card ICP line and a decision-maker line, and leaves the campaign out`, and `the live hold and the preview pull the same sections`).
