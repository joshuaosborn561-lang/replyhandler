# Portable guardrails prompt

Paste the block below into a Claude Code session in any repo where someone else
also works. It reproduces what ReplyHandler has: a durable record of the
owner's decisions, guard tests that fail when one is reversed, and a stated
split between what a collaborator may change freely and what needs the owner.

Run it once per repo. After that it maintains itself, because `CLAUDE.md` is
reloaded every session by every agent working in that repo.

---

```
Set this repo up so my product decisions survive across sessions and other
people's changes. I own the intent; my collaborator can add features and fix
bugs, but must not quietly reverse a decision I've made.

Do all of this:

1. READ FIRST. Before writing anything, look at what already exists — git log,
   any CLAUDE.md / AGENTS.md / README, and the code itself. I want the rules
   that are actually load-bearing here, not generic best practices. Pay
   attention to commits that fix production incidents and to anything a comment
   flags as deliberate or hard-won.

2. ASK ME. List what you believe my standing decisions are and where you're
   guessing. Ask about the ones you can't infer. Do not invent decisions I
   never made — an empty log is better than a wrong one. If a decision looks
   like it was reversed at some point, ask which way is current.

3. WRITE DECISIONS.md. Append-only log of my calls, in my words where the
   wording matters. Each entry: the decision, why (including what was tried and
   rejected), the tradeoff I accepted, and the guard test name if testable.
   State at the top that superseding means adding an entry, never editing or
   deleting one — the reversals are the useful part, because they record where
   the obvious answer turned out to be wrong.

4. WRITE GUARD TESTS. Two files, kept separate so the distinction is visible:
     - test/invariants.test.js — safety rules anyone should keep. Each should
       correspond to a real failure this repo has had.
     - test/owner-intent.test.js — my product decisions. A failure here means
       someone is reversing me, not that they hit a bug.
   Use the language's built-in test runner and no new dependencies if possible.
   Tests must not need a database, network, or credentials.
   Each owner-intent failure must read as a hand-off, not an assertion error.
   Name the decision, say what the change would reverse, point at DECISIONS.md,
   and tell them to check with me before changing it. Something like:

     STOP — this reverses one of my decisions.
       Decision: <the call I made>
       Problem:  <what this change would do>
     This is not a bug. See DECISIONS.md for the reasoning and the tradeoff.
     Check with me before changing it. Do not delete this guard to go green.

   The point is that my collaborator gets a clear prompt to ask me, instead of
   guessing at intent or working around a test he doesn't understand.

5. PROVE THE GUARDS WORK. For at least two rules, actually break the code,
   show me the test failing, then restore it. A guard that passes whatever
   happens is worse than no guard — it manufactures false confidence. Report
   honestly if any rule turns out not to be testable, and say so in
   DECISIONS.md rather than pretending it's covered.

6. WIRE UP CI. Run the tests on every push and pull request. Also add a step
   that simply loads/imports every module — that catches breakage the tests
   miss.

7. UPDATE CLAUDE.md. State plainly:
     - Add features, fix bugs, refactor freely while the tests pass.
     - Reversing a DECISIONS.md entry needs me. If a guard blocks something
       that looks genuinely wrong, raise it — don't delete the guard.
     - When I make a new call in a session, append it to DECISIONS.md IN THAT
       SAME SESSION, with its guard. Chat history is not durable; the repo is.
     - Which branch actually deploys, if any, and that pushing to it is a
       production deploy.

8. TELL ME WHAT ISN'T ENFORCED. None of this blocks a merge until GitHub
   requires it. Give me the exact branch-protection settings to click, and be
   clear that until I do, CI reports failures but doesn't stop anything. Don't
   change repo permissions yourself.

Keep it proportionate — a two-person repo doesn't need a heavyweight process.
Guard the things that would actually cost me if they were reversed.
```

---

## Why it's shaped this way

**Read and ask before writing.** An agent dropped into a new repo will happily
generate plausible-sounding rules. Rules I never set are worse than no rules —
they get enforced, and then someone works around them.

**Prove the guards fail.** Writing an assertion that always passes is easy and
invisible. Breaking the code and watching the test go red is the only way to
know the guard is real. This caught a shipped bug in ReplyHandler:
`stripHtmlToText` was eating `<a@b.com>` as an HTML tag, which silently
defeated the quoted-header cut that anchors on that address.

**Two test files, not one.** "You broke a safety rule" and "you reversed the
owner's decision" call for different responses. Mixing them makes both easier
to dismiss.

**The failure message is the handoff.** A bare assertion error invites someone
to work around the test. A message that names the decision and says "check with
Josh" turns a red build into a conversation — which is the actual goal. The
collaborator is not being blocked, he is being told who to ask.

**Append-only.** A log showing only the final state loses the reasoning, and
someone re-derives the rejected answer later. Several ReplyHandler decisions
are the opposite of the first instinct — that's exactly what needs preserving.

**Branch protection stays manual.** It changes who can push to what. That
belongs to the repo owner, not an agent.
