// Look up Tidy tickets by code (C00487) or chat id (uuid) and print their context.
//
//   node ticket.mjs C00487 C00723        # summary + last messages for each
//   node ticket.mjs C00487 --full        # full transcript
//   node ticket.mjs 91b6b849-a2af-...     # by chat id (full or prefix)
//   node ticket.mjs C00487 --json         # machine-readable (for tooling/skills)
//
// Searches data/inbox.json (open, sync-managed) merged with data/all-chats.json
// (the full incl-closed corpus, if you've run `build-kb.mjs --fetch`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const df = (f) => path.join(here, "data", f);
const load = (f) => (fs.existsSync(df(f)) ? JSON.parse(fs.readFileSync(df(f), "utf8")).chats ?? [] : []);

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const JSONOUT = args.includes("--json");
const queries = args.filter((a) => !a.startsWith("--"));

if (queries.length === 0) {
    console.error("Usage: node ticket.mjs <code|id> [more…] [--full] [--json]   e.g. node ticket.mjs C00487 C00723");
    process.exit(1);
}

// Merge corpora — all-chats first, inbox overrides (fresher for open threads).
const byId = new Map();
for (const c of load("all-chats.json")) byId.set(c.id, c);
for (const c of load("inbox.json")) byId.set(c.id, c);
const chats = [...byId.values()];
if (chats.length === 0) {
    console.error("No data. Run `node fetch.mjs` (open) or `node build-kb.mjs --fetch` (incl. closed) first.");
    process.exit(1);
}

const ai = new Map((load("enriched.json") ?? []).filter((c) => c.ai).map((c) => [c.id, c.ai]));

// staff detection: sender across many distinct companies = Tidy rep
const senderParties = new Map();
for (const c of chats) for (const m of c.messages ?? []) {
    if (!m.sender) continue;
    if (!senderParties.has(m.sender)) senderParties.set(m.sender, new Set());
    senderParties.get(m.sender).add(c.partiesDescription || "");
}
const isStaff = (s) => (senderParties.get(s)?.size ?? 0) >= 3;
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 864e5) : null);

function findChat(q) {
    const l = q.toLowerCase();
    return chats.find((c) => (c.code || "").toLowerCase() === l) || chats.find((c) => c.id.toLowerCase() === l || c.id.toLowerCase().startsWith(l));
}

const results = [];
for (const q of queries) {
    const c = findChat(q);
    if (!c) {
        results.push({ query: q, found: false });
        continue;
    }
    const a = ai.get(c.id) ?? {};
    const msgs = (c.messages ?? []).filter((m) => FULL || !m.isNote);
    const shown = FULL ? msgs : msgs.filter((m) => !m.isNote).slice(-6);
    results.push({
        query: q,
        found: true,
        code: c.code,
        id: c.id,
        url: c.url,
        parties: c.partiesDescription,
        status: c.closedDate ? "closed" : c.deleted ? "deleted" : "open",
        daysIdle: daysSince(c.mostRecentMessageDate),
        classification: a.classification ?? null,
        headline: a.headline ?? null,
        summary: a.summary ?? null,
        lastFrom: (() => {
            const lm = msgs.filter((m) => !m.isNote).at(-1);
            return lm ? { sender: lm.sender, staff: isStaff(lm.sender), date: (lm.date ?? "").slice(0, 10) } : null;
        })(),
        messages: shown.map((m) => ({ who: isStaff(m.sender) ? "TIDY" : "CUSTOMER", note: !!m.isNote, sender: m.sender, date: (m.date ?? "").slice(0, 16), text: m.text || "(empty/attachment)" })),
    });
}

if (JSONOUT) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
}

for (const r of results) {
    if (!r.found) {
        console.log(`\n${r.query}: NOT FOUND (if it's a closed ticket, run \`node build-kb.mjs --fetch\` to pull it in)`);
        continue;
    }
    console.log(`\n\n████ ${r.code || r.id} — ${r.parties || "?"}  [${r.status}, ${r.daysIdle}d idle${r.classification ? ", " + r.classification : ""}] ████`);
    console.log(`url: ${r.url}`);
    if (r.summary) console.log(`AI: ${r.summary}`);
    if (r.lastFrom) console.log(`last message from: ${r.lastFrom.sender}${r.lastFrom.staff ? " (Tidy)" : " (customer)"} on ${r.lastFrom.date}`);
    console.log("──────────────────────────────────────");
    for (const m of r.messages) console.log(`\n${m.note ? "[NOTE] " : ""}${m.sender} · ${m.date}${FULL ? "" : `  (${m.who})`}\n${m.text}`);
    if (!FULL) console.log(`\n(showing last ${r.messages.length} messages — add --full for the whole thread)`);
}
