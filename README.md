# tidy-inbox-tool

A personal command-line workflow for the Tidy CRM inbox
(`crm.tidyint.com/communication/inbox/all`). It pulls every chat straight from the
CRM gateway API (skipping the slow UI), AI-summarises and classifies each thread,
builds a spreadsheet, flags "bug" threads that look fixed-but-unconfirmed for review,
and closes finished threads in bulk.

---

## How it all fits together

```
                         ┌──────────────────────────────────────────┐
                         │        Tidy CRM gateway  (network)        │
                         │      https://crm-gateway.tidyint.com      │
                         └───────┬───────────────────────▲──────────┘
                        pull all │                        │ close chats
                     chats+msgs  │                        │ (push)
                                 ▼                        │
   ┌───────────┐   writes   ┌─────────────────┐   reads   ┌──────────────┐
   │ fetch.mjs │──────────▶ │ data/inbox.json │ ◀──────── │close-chats.mjs│
   └───────────┘            │  (source of      │          └──────────────┘
   first run only           │   truth: status, │                 ▲ ids
                            │   messages)      │                 │
   ┌───────────┐  push+pull  │                 │          ┌──────────────┐
   │ sync.mjs  │────────────▶│                 │          │ bug-review   │
   └───────────┘  updates    └───┬─────────┬───┘          │   .html      │
   day-to-day                    │         │              │ "Copy close  │
                        reads msgs│         │reads status  │  command" ───┘
                                  ▼         ▼
   ┌──────────────┐  AI   ┌──────────────────┐        ┌────────────────┐
   │ summarize.mjs│──────▶│data/enriched.json│        │ review-bugs.mjs│
   └──────────────┘       │ (AI summary +    │        └───────┬────────┘
    needs an AI backend   │  bug/feature +   │        no API — pure JS
    (or in-session Claude)│  suggest-close)  │                │
                          └────────┬─────────┘   reads bugs   │ writes
                                   │             + verdicts    ▼
              status+messages      │        ┌──────────────────────────┐
              from inbox.json      │        │ data/bug-digests.json    │◀─ input for
                          ┌────────▼──────┐  │ bug-review.html          │   AI analysis
                          │  report.mjs   │  └──────────────────────────┘
                          └───────┬───────┘            ▲
                                  │ writes             │ writes verdicts
                                  ▼                     │
                        ┌──────────────────┐   ┌────────────────────────┐
                        │ inbox-report.xlsx│   │ data/bug-verdicts.json │
                        │ (edit "My action"│   │ (from Claude reading    │
                        │  = close here)   │   │  the digests, free)     │
                        └──────────────────┘   └────────────────────────┘
```

**Two sources of truth, joined by chat id:**
- `data/inbox.json` — everything factual (status, dates, messages). `fetch`/`sync` own it.
- `data/enriched.json` — only the AI columns. `report` joins it onto inbox.json; if it's
  missing you still get a spreadsheet, just without AI columns.

**Two independent things touch the outside world** (everything else is local JS):
- **CRM network:** `fetch`, `sync`, `close-chats` (via `lib/api.mjs`).
- **AI:** `summarize` (optional backend), or a Claude session doing it free in-session.

---

## Scripts at a glance

| Script | Reads | Writes | Network | AI |
|---|---|---|---|---|
| `fetch.mjs` | — | `data/inbox.json` | CRM | — |
| `sync.mjs` | inbox.json, sheet | `data/inbox.json` | CRM | — |
| `summarize.mjs` | inbox.json | `data/enriched.json` | — | yes* |
| `report.mjs` | inbox.json (+enriched, +sheet) | `inbox-report.xlsx` | — | — |
| `review-bugs.mjs` | inbox.json, enriched, verdicts | `bug-review.html`, `data/bug-digests.json` | — | — |
| `close-chats.mjs` | inbox.json / enriched | — (closes in CRM) | CRM | — |
| `serve.mjs` | all data files | — (runs the others) | CRM | — |

`review-bugs.mjs` also has a `--cli` flag (`npm run review`) that prints the grouped
review to the terminal with a ready close command, instead of the HTML page.

`serve.mjs` (`npm run serve`) is the web-app front end — see below.

\* `summarize` needs an AI backend, or skip it and let a Claude session do the analysis
in-session for free (see [SUMMARIZE-TASK.md](SUMMARIZE-TASK.md) /
[REVIEW-BUGS-TASK.md](REVIEW-BUGS-TASK.md)).

`lib/` holds shared helpers: `api.mjs` (CRM client + retry), `map.mjs` (DTO→local shape),
`html.mjs` (email HTML→text), `sheet.mjs` (read annotations back out of the xlsx),
`backup.mjs` (auto-backup before any overwrite).

---

## Setup

```bash
cd ~/Work/tidy-inbox-tool
npm install
```

**1. Tidy CRM token** — open https://crm.tidyint.com (logged in), Devtools → Application →
Cookies → copy `TidyCore_AccessToken`:
```bash
export TIDY_TOKEN='eyJ...'
```
Expires; re-grab when you see a 401. Point at staging with `export TIDY_API=https://crm-gateway.tidystaging.com`.

**2. AI backend** (summaries only) — pick one:
- **Free, no install:** ask a Claude Code session to "summarize the inbox" / "review the bugs".
- **Free, scripted:** `npm i -g @anthropic-ai/claude-code`, run `claude` once to log in — `summarize.mjs` auto-uses it.
- **API:** `export ANTHROPIC_API_KEY='sk-ant-...'`.

---

## Workflows

**First run**
```bash
node fetch.mjs           # pull everything -> data/inbox.json
node summarize.mjs       # AI columns (or ask Claude in-session)
node report.mjs          # -> inbox-report.xlsx
```

**Day-to-day (delta sync)** — after closing things in the sheet or the website:
```bash
node sync.mjs && node report.mjs
```
`sync` pushes any rows you marked `close` in the sheet's **My action** column up to the
CRM, pulls only what changed, and flips anything you closed in the website to `closed` in
the data. Add `node summarize.mjs` in the middle if you want AI columns refreshed (only
changed threads are re-analysed).

**Close a specific batch by id**
```bash
node close-chats.mjs --ids <id1>,<id2>,<id3>          # dry run
node close-chats.mjs --ids <id1>,<id2>,<id3> --apply  # actually close
node sync.mjs && node report.mjs                      # reflect in the sheet
```

**Review "bug" threads that look fixed-but-unconfirmed**
```bash
node review-bugs.mjs     # -> bug-review.html  (+ data/bug-digests.json)
open bug-review.html
```
The page groups open bugs into **fixed-unconfirmed / unclear / active**, pre-ticks the
fixed ones, shows the last few replies, and has a **Copy close command** button that emits
a `close-chats --ids --apply` line for whatever's ticked. The grouping comes from
`data/bug-verdicts.json` — produced by a Claude session reading `data/bug-digests.json`
(see REVIEW-BUGS-TASK.md). Without it, the page still lists every open bug, ungrouped.

---

**Web app** — everything in one place, no copy-paste:
```bash
export TIDY_TOKEN='...'   # needed for the Sync/Close buttons
npm run serve             # then open http://localhost:8787
```
A local dashboard over the same data files. Two tabs:

- **Inbox** — searchable/filterable table of every thread (like the spreadsheet but live).
- **Reviewer** — filter by **Bugs / Bugs+features / Features / Everything open**, then work
  through them in one of three modes:
  - **Cards** — all threads as chat-bubble cards, each with Close / Keep / Skip buttons.
  - **One at a time** — a Tinder-style flow: one thread on screen, decide with the buttons
    or arrow keys (← Close · ↓ Skip · → Keep · Backspace back), auto-advances.
  - **Review choices** — a summary grouped by your decisions, with **Copy close ids**,
    **Copy close command**, and **Close N in CRM** (closes directly + re-syncs).

  Your decisions persist (localStorage), so a refresh keeps your place. The header buttons
  run Sync / Summarize / Rebuild sheet / Re-review bugs and stream output into a log panel.
  Localhost only, no new deps.

The web app doesn't replace the scripts — it *drives* them. You can use any mix of CLI,
spreadsheet, and web app; they all read and write the same `data/` files.

## Look up a ticket by code

```bash
node ticket.mjs C00487 C00723        # summary + last messages for each
node ticket.mjs C00487 --full        # whole transcript
node ticket.mjs 91b6b849-… --json    # by chat id / machine-readable
```

Resolves a Tidy ticket **code** (or chat id) to its full context — parties, status, AI
summary, who spoke last, and the messages. In the web app, the **Ticket** column and the
Inbox/Outstanding search boxes now match on code too, so typing `C00487` finds it.

## Knowledge base (Q&A from all tickets)

Mine resolved threads — including closed ones — into a searchable Q&A knowledge base for
answering common questions fast.

```bash
node build-kb.mjs --fetch    # pull ALL chats incl. closed -> data/all-chats.json (needs TIDY_TOKEN)
node build-kb.mjs            # distil -> data/knowledge.json (needs ANTHROPIC_API_KEY)
                             #   …or, free: ask a Claude session to "build the knowledge base"
                             #   (it follows KB-TASK.md over data/kb-digests.json)
```

Then open the **Knowledge** tab in the web app (`npm run serve`) and search — results are
Q&A cards (question, answer, category) each linking back to the source ticket. Incremental:
re-runs only re-distil threads whose latest message changed. The corpus lives in
`data/all-chats.json` (separate from the sync-managed `data/inbox.json`), so building the KB
never disturbs your working inbox.

## Files

```
*.mjs                 task scripts (above)
lib/*.mjs             shared helpers
*-TASK.md             instructions for the free in-session AI steps
data/inbox.json       source of truth (status, messages) — rebuildable via fetch
data/enriched.json    AI summary/classification columns
data/bug-verdicts.json  bug review verdicts (id -> {verdict, reason})
data/bug-digests.json   compact bug transcripts (input for AI analysis)
data/backups/         auto-backups (last 20 of each file, before every overwrite)
inbox-report.xlsx     the spreadsheet (edit "My action" to close)
bug-review.html       the bug review page
```

Everything under `data/`, plus the `.xlsx`/`.html`, is rebuildable from the CRM, so it's
gitignored. Every script backs up the file it's about to overwrite into `data/backups/`
first (keeps 20), so an accidental run is always one copy-back away from undone.

## API endpoints used

- `POST /v1/chats/get` — paged chat list (`ChatFilter`; `startRow/endRow: null` = all)
- `POST /v1/chat-messages/get` — all messages per chat (`{chatId, includeNotes}`)
- `POST /v1/chats/{id}/close` — close

Same API and bearer token the CRM frontend uses. Transient gateway errors (the CRM's own
backend being briefly unavailable) are retried automatically.

## Known quirk

The API's "outgoing" flag is unreliable on email threads, so staff-vs-customer in the bug
review is inferred from sender frequency (a name appearing across ≥4 chats = Tidy staff).
It's a heuristic — the review page is a fast-triage aid, not a substitute for a glance at
anything you're unsure about.
