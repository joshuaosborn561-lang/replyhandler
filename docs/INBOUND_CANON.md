# Inbound canon

These three rules are permanent. CI's Invariant guards job runs
`test/inbound-canon.test.js` on every pull request. A failure blocks merge.

1. FULL TEXT: every Slack card, stored inbound row and drafter input shows the prospect's full email. No silent truncation.
2. ONE EMAIL = ONE CARD = AT MOST ONE SEND: a single inbound email must never produce two cards, two portal forwards or two sends, however many times or ways it reaches us (Smartlead reply webhook, Smartlead category-changed webhook, the SmartLead inbox polling backstop, HeyReach, retries).
3. NEVER DROP A REAL REPLY: a genuinely new reply from the same person must always post. No time-window dedupe and no stats-id/campaign keyed dedupe (both were tried and removed on purpose).

## How it is enforced

The email's RFC 5322 Message-ID is stored on `pending_replies.inbound_message_id` (migration 043) and indexed. `claimNewInbound` treats a matching Message-ID for the same person as a duplicate inside the existing advisory lock, before any text comparison.

When no Message-ID is present, both sides go through `normalizeInboundText`: decode entities, fold dashes and quotes, strip leading `>` quote markers, remove `[link]` and `[email]` bracket expansions and `<mailto:...>`, collapse whitespace. Storage uses the same function (`forStorage` keeps case, newlines, and the typed dash). `preferFullerInbound` uses it too. A fuller duplicate copy upgrades the stored text and does not post again.

A category-changed webhook for an email already stored updates that row's category and the existing card when the card is still in memory. It does not create a row, a card, or a portal forward. If it arrives first, it is the single card, and the later reply webhook dedupes against it.

Approving a second card for the same Message-ID cannot send. The outbound claim blocks on that id (or on the same inbound text when either side has no id). Two real emails that both say "Thanks" and carry different Message-IDs are two cards and can both send.
