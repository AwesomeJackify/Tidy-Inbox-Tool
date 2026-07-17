# Task: build the Q&A knowledge base (in-session, free)

Purpose: mine resolved support threads into a reusable question→answer knowledge base
so common questions can be answered fast without digging through tickets.

Input:  `data/kb-digests.json` — array of answerable threads (customer question + a Tidy
        reply), each with `id`, `parties`, `status`, `url`, and `thread` (the transcript,
        each line tagged TIDY or CUSTOMER).
Output: `data/knowledge.json` — `{ "builtAt": <ISO>, "count": N, "entries": [ ... ] }`.

Each entry:
```json
{
  "question": "clear, general, reusable phrasing of the customer's question (no names/specifics)",
  "answer": "Tidy's answer/workaround as a concrete, actionable how-to (name the settings/steps)",
  "category": "short topic, e.g. Xero | Credit notes | Purchase orders | Templates | Assemblies | Stock | Invoicing | Login | Reports",
  "keywords": ["3-8 search terms/synonyms a user might type"],
  "sourceChatId": "<id from the digest>",
  "sourceUrl": "<url from the digest>",
  "parties": "<parties from the digest>",
  "status": "open | closed"
}
```

Rules:
- Extract **only genuine, reusable** Q&A — where Tidy actually gave an answer or workaround.
  Skip chit-chat, still-unresolved threads, and one-off account-specific fixes that wouldn't
  help another customer.
- A thread may yield **0, 1, or several** entries. Prefer several small focused Q&A over one
  giant one.
- Rephrase questions generically; keep answers concrete (include the exact setting names,
  menu paths, or steps Tidy gave).
- Carry `sourceChatId`, `sourceUrl`, `parties`, `status` through from the digest so each
  answer links back to its ticket.

Work in batches if the file is large. Write the complete `data/knowledge.json`, then tell the
user to open the **Knowledge** tab in the web app (`npm run serve`) to search it.
