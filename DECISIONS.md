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

### Follow-ups after meeting propose: 2h → 24h → 48h → 1 week

Only schedule when the approved outbound proposes a meeting (times, Calendly,
"book for you") — not after every send. Cadence from that send: 2h, 24h, 48h,
then 1 week. Approving a FOLLOW_UP card does not restart the clock.

Skipped when the prospect already booked, proposed a time, has a calendar event,
or a call transcript (Allo / Cube ACR) shows the meeting was set. Both SmartLead
and LinkedIn. No backlog replay (`FOLLOW_UP_MAX_AGE_HOURS`).

Guard: `follow-ups after meeting propose at 2h/24h/48h/1w`

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
