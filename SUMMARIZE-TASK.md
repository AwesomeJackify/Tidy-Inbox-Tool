# Task: summarize the inbox (for Claude Code, in-session)

This is the zero-setup free path: instead of running `summarize.mjs` (which needs an
API key or the `claude` CLI), a Claude Code session performs the summarize step itself.

## Instructions for Claude

Input: `data/inbox.json` (produced by `node fetch.mjs`).
Output: `data/enriched.json` — identical structure, but each chat gains an `ai` object,
plus top-level `model: "claude-code-session"` and `summarizedAt: <ISO timestamp>`.

Be incremental: if `data/enriched.json` already exists, copy the existing `ai` object
for any chat whose `mostRecentMessageDate` is unchanged; only summarize new/updated chats.

For each chat, read its messages (messages with `fromSupport: true` are from the Tidy
team; `isNote: true` are internal notes) and produce:

```json
{
  "headline":       "one line, max ~10 words, no trailing period",
  "summary":        "2-4 sentences: who contacted us, what they need, what happened so far, what is still outstanding on our side",
  "classification": "bug | feature | not sure",
  "actionNeeded":   true,
  "suggestClose":   false,
  "closeReason":    ""
}
```

Rules (be conservative):
- `classification`: "bug" ONLY if the customer clearly reports broken/incorrect existing
  behavior. "feature" ONLY if they clearly request new functionality. Everything
  ambiguous, mixed, administrative, sales, or spam -> "not sure".
- `suggestClose`: true ONLY if the thread is unambiguously finished — resolved and
  acknowledged by the customer, spam/auto-reply/bounce dead-ends, or clearly abandoned
  with nothing pending. When in doubt: false. If true, put one short sentence in
  `closeReason`; otherwise `closeReason` is "".
- `actionNeeded`: true if the thread still needs a reply or work from the Tidy team.
- Chats with zero messages get: headline "(no messages)", classification "not sure",
  actionNeeded false, suggestClose false.

Context: Tidy is a B2B inventory/ERP software company; these threads are its CRM inbox.

Work in batches (the file can be large — read it in slices rather than all at once if
needed), then write the complete `data/enriched.json` and report the classification
counts and how many chats were flagged suggestClose. The user then runs
`node report.mjs` to build the spreadsheet.
