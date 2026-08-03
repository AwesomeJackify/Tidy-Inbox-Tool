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
    (or any coding agent) │  suggest-close)  │                │
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
                        │ (edit "My action"│   │ (from an AI agent       │
                        │  = close here)   │   │  reading the digests)   │
                        └──────────────────┘   └────────────────────────┘
```

**Two sources of truth, joined by chat id:**
- `data/inbox.json` — everything factual (status, dates, messages). `fetch`/`sync` own it.
- `data/enriched.json` — only the AI columns. `report` joins it onto inbox.json; if it's
  missing you still get a spreadsheet, just without AI columns.

**Two independent things touch the outside world** (everything else is local JS):
- **CRM network:** `fetch`, `sync`, `close-chats` (via `lib/api.mjs`).
- **AI:** `summarize` (optional Codex, Claude, Anthropic API, or custom CLI backend), or
  any capable coding-agent session following the task files.

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

\* `summarize` needs an AI backend, or skip it and let Codex or another coding agent do
the analysis in-session (see [SUMMARIZE-TASK.md](SUMMARIZE-TASK.md) /
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

**1. Tidy CRM authentication** — open https://crm.tidyint.com (logged in), Devtools → Application →
Cookies → copy `TidyCore_RefreshToken`:
```bash
export TIDY_REFRESH_TOKEN='eyJ...'
```
On first use the tool exchanges it for an access token, then saves each rotated refresh token in
the gitignored `.tidy-auth.json` file with owner-only permissions. Later runs reuse that file, so the
environment variable is only needed for initial setup. Point at staging with
`export TIDY_API=https://crm-gateway.tidystaging.com` (the matching auth gateway is inferred), or
set `TIDY_AUTH_API` explicitly. To replace an invalid saved login, paste a new refresh token through
the dashboard's Token button (or delete `.tidy-auth.json` before setting the environment variable again).

**2. AI backend** (summaries only) — pick one:
- **Codex:** install/login to the Codex CLI; `summarize.mjs` auto-detects `codex exec`.
- **Claude:** install/login to Claude Code; it is also auto-detected.
- **Custom AI CLI:** set `TIDY_AI_COMMAND`, with optional JSON-array `TIDY_AI_ARGS`.
  The command receives the prompt on stdin and must print a JSON object. Use `{model}` in
  an argument when it should be replaced by `TIDY_AI_MODEL`.
- **Anthropic API:** set `ANTHROPIC_API_KEY`.

Set `TIDY_AI_BACKEND=codex|claude|custom|anthropic-api` to force a provider. Without
that setting the order is custom command, Anthropic API, Codex, then Claude.

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
`data/bug-verdicts.json` — produced by any capable AI session reading `data/bug-digests.json`
(see REVIEW-BUGS-TASK.md). Without it, the page still lists every open bug, ungrouped.

---

**Web app** — everything in one place, no copy-paste:
```bash
export TIDY_REFRESH_TOKEN='...'  # first run only; or paste it via the Token button
npm run serve             # then open http://localhost:8787
```
A local dashboard over the same data files. Five main tabs:

- **Dashboard** — a read-only workload and prioritisation view: open volume, customer-waiting
  tickets, aging, ticket mix, clients needing attention, and the oldest conversations.
- **Outstanding** — genuinely undecided open tickets that have not been marked Keep or Close, with an AI-free
  preview of the customer's opening message when no summary is available. Click the context to
  open the full conversation in a scrollable modal without leaving the app. Mix and match
  **Bug / Feature / Not sure** filters and set Keep or Close. Leaving a ticket untouched is the
  default “deal with later” behaviour; there is no separate Skip action.
- **Inbox** — the full ticket-management workspace with Keep / Close controls, type changes,
  conversations, CRM reply links, and reopening. Choose the opposite status to change an existing
  Keep or Close decision. Open tickets appear after a Keep or Close decision;
  **Include undecided** temporarily restores the complete raw view. Closed tickets remain available
  through the status filter because Sync retains the full open-and-closed history, and can be reopened
  directly in the CRM after confirmation. Ticket type can be set manually to **Bug**, **Feature**, or **Not sure**
  from Inbox, Outstanding, or the conversation modal.
- **Release follow-up** — group shipped PRs under a release name or version, map each PR to one or
  more open CRM tickets, see which customers still need a release response, reply in the CRM, and
  mark each response completed. Closing a release closes all of its mapped CRM tickets and records
  the individual ticket actions. Copying footer text such as `Release: 1.2026.6.2 - 22 Jul 2026 - 0a54e80b`
  lets the app fill the release number, date, and build automatically. Mappings and response changes
  are included in the audit history.
- **Proposals** — select unassigned **Feature requests**, create an editable AI-assisted or manual
  proposal, and send it for boss sign-off. Boss review has separate actions to send a proposal back
  to Draft, decline it while keeping it visible, or close its source CRM ticket. Approval keeps
  the proposal in Boss review, closes its source CRM tickets, and can later be manually marked Completed.
  Deleting a proposal releases its source tickets back into Feature requests. Every boss-ready
  proposal requires estimated developer effort, indicative start/completion dates, and explicit
  estimate assumptions. Each proposal starts with a plain-language summary and a grounded customer
  perspective that names the person and company only when the ticket supplies them. **Draft all for boss review** creates one estimated proposal per unassigned
  Feature request using the configured AI provider. **Export boss review to Markdown** creates one
  plain decision pack with simple headers, estimates, and source tickets.
- **Knowledge** — search known problems and answers, or filter by client to find recurring
  issue areas and review that client's related tickets.
- **More tools → Audit history** — a durable, searchable record of ticket status/type changes,
  CRM close/reopen attempts, Sync, Summarise, and Excel exports, including staff and timestamps.

  Ticket decisions and their history persist in `data/ticket-actions.json`; localStorage only
  keeps personal UI preferences such as filters. A global decision bar
  stays available across every tab with totals, bulk Close, and bulk **Undo close marks**.
  Selecting **Close** only queues a decision. After confirmation, **Close N in CRM** calls
  `POST /v1/chats/{id}/close` through the local app server with the CRM bearer token, records
  success or failure in Audit history, and runs Sync.
  **Sync now** is the primary header action. Less-frequent actions live under **More tools**:
  AI summarization (disabled when no AI backend is available) and **Export to Excel**, which
  rebuilds and opens `inbox-report.xlsx`. Their output streams into a hideable log panel.
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
node build-kb.mjs --fetch    # pull ALL chats incl. closed -> data/all-chats.json (needs CRM authentication)
node build-kb.mjs            # distil -> data/knowledge.json (uses the same AI provider)
                             #   …or ask Codex/another agent to "build the knowledge base"
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
data/proposals.json   feature proposals, sign-off state, and decision history
data/ticket-types.json  shared manual Bug / Feature / Not sure selections
data/ticket-actions.json durable ticket decisions, action timestamps, and audit events
data/bug-verdicts.json  bug review verdicts (id -> {verdict, reason})
data/bug-digests.json   compact bug transcripts (input for AI analysis)
data/backups/         auto-backups (last 20 of each file, before every overwrite)
inbox-report.xlsx     the spreadsheet (edit "My action" to close)
bug-review.html       the bug review page
```

CRM-derived data plus the `.xlsx`/`.html` is rebuildable and gitignored. `data/proposals.json`,
`data/ticket-types.json`, and `data/ticket-actions.json` contain human decisions and are not rebuildable from the CRM, so
include them in normal internal backups. Running AI Summarize intentionally clears all manual
ticket types and replaces them with its classifications. Saves make rolling copies in `data/backups/`.

## API endpoints used

- `POST /v1/chats/get` — paged chat list (`ChatFilter`; `startRow/endRow: null` = all)
- `POST /v1/chat-messages/get` — all messages per chat (`{chatId, includeNotes}`)
- `POST /v1/chats/{id}/close` — close
- `POST /v1/chats/{id}/reopen` — reopen a closed ticket

Same API and bearer token the CRM frontend uses. Transient gateway errors (the CRM's own
backend being briefly unavailable) are retried automatically.

## Known quirk

The API's "outgoing" flag is unreliable on email threads, so staff-vs-customer in the bug
review is inferred from sender frequency (a name appearing across ≥4 chats = Tidy staff).
It's a heuristic — the review page is a fast-triage aid, not a substitute for a glance at
anything you're unsure about.
