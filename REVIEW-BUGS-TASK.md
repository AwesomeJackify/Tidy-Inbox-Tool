# Task: classify open bug threads as fixed-unconfirmed vs active (in-session, free)

Purpose: many "bug" threads are actually resolved — Tidy shipped a fix and is just
waiting on the customer to confirm, which they often never do. This step reads each
open bug and decides whether it looks safe to close.

Input:  `data/bug-digests.json` — array of open bug threads, each with `id`, `title`,
        `parties`, `daysIdle`, `summary`, and `lastMessages` (each tagged TIDY or
        CUSTOMER via sender-frequency; treat the tag as a strong hint, but trust the
        actual text — the tag can be wrong on email threads).
Output: `data/bug-verdicts.json` — an object mapping each chat `id` to
        `{ "verdict": "...", "reason": "..." }`.

Verdicts:
- `"fixed-unconfirmed"` — Tidy clearly stated a fix was made/released/deployed, and the
  customer has NOT since said it's still broken. Silence after a fix, or a customer
  "thanks/that worked", both qualify. This is the close pile.
- `"active"` — the customer's most recent substantive message reports the issue is still
  happening, or Tidy still owes a fix / a reply / is mid-investigation. Do NOT close.
- `"unclear"` — you can't tell from the thread. Leave for manual reading.

`reason`: one short sentence (max ~15 words) — e.g. "Fix released 30 Jun, no customer
reply since" or "Customer says still broken on 2 Jul". This is shown on the review card.

Be conservative: if a customer replied after the fix saying it's still wrong (like a
"this worked... actually no it didn't" flip), that's `active`, not fixed. When genuinely
torn, use `unclear`.

Write the complete `data/bug-verdicts.json`, then tell the user to run
`node review-bugs.mjs` to rebuild the review page (`bug-review.html`) grouped by verdict.
