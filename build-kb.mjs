// Build a searchable Q&A knowledge base from ALL tickets (including closed ones).
//
// Flow:
//   node build-kb.mjs --fetch      # pull ALL chats incl. closed -> data/all-chats.json (needs TIDY_TOKEN)
//   node build-kb.mjs              # distill the corpus -> data/knowledge.json
//
// Corpus source: data/all-chats.json if present (the full incl-closed pull), else
// falls back to data/inbox.json. Distillation needs an AI backend (ANTHROPIC_API_KEY),
// otherwise it writes data/kb-digests.json for a free in-session Claude pass (KB-TASK.md).
//
// Incremental: threads whose latest message is unchanged are not re-distilled.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllChats, getChatMessages, mapLimit, requireToken, API_BASE } from "./lib/api.mjs";
import { mapChat } from "./lib/map.mjs";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = path.join(here, "data", "all-chats.json");
const INBOX = path.join(here, "data", "inbox.json");
const KB = path.join(here, "data", "knowledge.json");
const DIGESTS = path.join(here, "data", "kb-digests.json");

const FETCH = process.argv.includes("--fetch");
const FORCE = process.argv.includes("--force");
const argModel = process.argv.indexOf("--model");
// Bulk mechanical extraction over hundreds of threads — default to an efficient
// model (Haiku); use --model claude-sonnet-4-6 for a quality bump, or opus if you must.
const MODEL = argModel !== -1 ? process.argv[argModel + 1] : "claude-haiku-4-5";

// ---------- 1. corpus (fetch all incl. closed, or reuse) ----------

if (FETCH) {
    requireToken();
    // Incremental: reuse the previous all-chats.json and only re-download messages
    // for chats that are new or whose latest-message / closed state changed.
    const existing = fs.existsSync(ALL) ? new Map(JSON.parse(fs.readFileSync(ALL, "utf8")).chats.map((c) => [c.id, c])) : new Map();
    const stamp = (c) => `${c.mostRecentMessageDate ?? ""}|${c.closedDate ?? ""}`;

    console.error(`Fetching chat list (incl. closed) from ${API_BASE} ...`);
    const chats = await getAllChats({ includeClosed: true });
    const changed = chats.filter((c) => {
        const e = existing.get(c.id);
        return !e || stamp(e) !== stamp(c);
    });
    console.error(`${chats.length} chats total — ${changed.length} new/changed need messages, ${chats.length - changed.length} reused from cache.`);

    let done = 0;
    const fetched = new Map();
    await mapLimit(changed, 5, async (chat) => {
        try {
            fetched.set(chat.id, await getChatMessages(chat.id));
        } catch (err) {
            console.error(`\n! messages for ${chat.id}: ${err.message}`);
            fetched.set(chat.id, null); // fall back to cached below
        }
        done++;
        process.stderr.write(`\rMessages: ${done}/${changed.length} changed chats`);
    });
    if (changed.length) process.stderr.write("\n");

    // Merge: freshly-fetched chats get re-mapped; unchanged chats reuse their cached record.
    const merged = chats.map((c) => {
        const msgs = fetched.get(c.id);
        if (msgs) return mapChat(c, msgs);
        return existing.get(c.id) ?? mapChat(c, []);
    });

    fs.mkdirSync(path.dirname(ALL), { recursive: true });
    backupFile(ALL);
    fs.writeFileSync(ALL, JSON.stringify({ fetchedAt: new Date().toISOString(), chats: merged }, null, 2));
    console.error(`Saved ${merged.length} chats -> ${ALL}`);
}

const corpusFile = fs.existsSync(ALL) ? ALL : fs.existsSync(INBOX) ? INBOX : null;
if (!corpusFile) {
    console.error("No corpus. Run `node build-kb.mjs --fetch` (needs TIDY_TOKEN) or `node fetch.mjs` first.");
    process.exit(1);
}
const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
console.error(`Corpus: ${corpus.chats.length} chats from ${path.basename(corpusFile)}${corpusFile === INBOX ? " (open only — use --fetch for closed too)" : ""}`);

// staff detection: sender across many distinct companies = Tidy rep
const senderParties = new Map();
for (const c of corpus.chats) for (const m of c.messages) {
    if (!m.sender) continue;
    if (!senderParties.has(m.sender)) senderParties.set(m.sender, new Set());
    senderParties.get(m.sender).add(c.partiesDescription || "");
}
const isStaff = (s) => (senderParties.get(s)?.size ?? 0) >= 3;

// Only threads that actually contain a Tidy answer are worth mining.
const answerable = corpus.chats.filter((c) => {
    const msgs = c.messages.filter((m) => !m.isNote);
    return msgs.length >= 2 && msgs.some((m) => isStaff(m.sender)) && msgs.some((m) => !isStaff(m.sender));
});
console.error(`Answerable threads (has customer Q + Tidy reply): ${answerable.length}`);

function renderThread(c) {
    const lines = [`Parties: ${c.partiesDescription || "unknown"}`, `Status: ${c.closedDate ? "closed" : "open"}`, ""];
    // The Q&A lives in the opening question + the replies. Cap messages and length
    // to keep input tokens (and the in-session digest file) lean.
    const msgs = c.messages.filter((x) => !x.isNote);
    const shown = msgs.length <= 14 ? msgs : [...msgs.slice(0, 2), { gap: msgs.length - 14 }, ...msgs.slice(-12)];
    for (const m of shown) {
        if (m.gap) {
            lines.push(`[... ${m.gap} messages omitted ...]`);
            continue;
        }
        lines.push(`[${isStaff(m.sender) ? "TIDY" : "CUSTOMER"} ${m.sender} ${(m.date ?? "").slice(0, 10)}]: ${(m.text || "").slice(0, 500).replace(/\s+/g, " ")}`);
    }
    return lines.join("\n");
}

// ---------- 2. write digests (input for AI, in-session or backend) ----------

fs.mkdirSync(path.dirname(DIGESTS), { recursive: true });
fs.writeFileSync(DIGESTS, JSON.stringify(answerable.map((c) => ({ id: c.id, parties: c.partiesDescription, status: c.closedDate ? "closed" : "open", url: c.url, thread: renderThread(c) })), null, 1));

// ---------- 3. distil to Q&A (API backend if available) ----------

const SCHEMA = {
    type: "object",
    properties: {
        entries: {
            type: "array",
            description: "Zero or more reusable Q&A pairs distilled from this thread. Empty if there is no clear, reusable answer.",
            items: {
                type: "object",
                properties: {
                    question: { type: "string", description: "The customer's question, rephrased as a clear, general, reusable question (strip names/specifics)." },
                    answer: { type: "string", description: "Tidy's answer/resolution, concise and actionable, as a reusable how-to. Include the concrete steps or setting names." },
                    category: { type: "string", description: "Short topic label, e.g. 'Xero', 'Credit notes', 'Purchase orders', 'Templates', 'Assemblies', 'Stock', 'Invoicing', 'Login', 'Reports'." },
                    keywords: { type: "array", items: { type: "string" }, description: "3-8 search keywords/synonyms a user might type." },
                },
                required: ["question", "answer", "category", "keywords"],
                additionalProperties: false,
            },
        },
    },
    required: ["entries"],
    additionalProperties: false,
};

const SYSTEM = `You mine resolved support threads from the CRM of Tidy, a B2B inventory/ERP product (TidyStock/TidyWork, Xero integration), into a reusable Q&A knowledge base. Extract only genuine, reusable question→answer pairs where Tidy gave a real answer or workaround. Skip pure chit-chat, unresolved threads, and one-off account-specific fixes that wouldn't help another customer. Rephrase questions generically (no customer names). Keep answers concrete and actionable.`;

// Incremental cache: keep prior entries for a chat if its latest message is unchanged.
const prevByChat = fs.existsSync(KB) && !FORCE ? JSON.parse(fs.readFileSync(KB, "utf8")) : { entries: [] };
const cachedFor = new Map(); // chatId -> {lastDate, entries[]}
for (const e of prevByChat.entries ?? []) {
    if (!cachedFor.has(e.sourceChatId)) cachedFor.set(e.sourceChatId, { lastDate: e.__lastDate, entries: [] });
    cachedFor.get(e.sourceChatId).entries.push(e);
}

if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
        [
            "",
            `Wrote ${answerable.length} thread digests -> ${DIGESTS}`,
            "No ANTHROPIC_API_KEY set, so no Q&A generated yet. Two options:",
            "  1. Free: ask a Claude session to 'build the knowledge base' (see KB-TASK.md).",
            "  2. API: export ANTHROPIC_API_KEY=sk-ant-... and re-run.",
            "Then open the Knowledge tab in the web app (npm run serve).",
        ].join("\n"),
    );
    process.exit(0);
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic();

const lastDate = (c) => c.mostRecentMessageDate ?? c.messages.at(-1)?.date ?? null;
const out = [];
let done = 0, reused = 0, next = 0;
async function worker() {
    for (;;) {
        const i = next++;
        if (i >= answerable.length) return;
        const c = answerable[i];
        const cache = cachedFor.get(c.id);
        if (cache && cache.lastDate === lastDate(c)) {
            out.push(...cache.entries);
            reused++;
        } else {
            try {
                const res = await client.messages.create({
                    model: MODEL,
                    max_tokens: 2048,
                    system: SYSTEM,
                    // The schema is compiled once and reused (24h) across all threads by the API.
                    output_config: { format: { type: "json_schema", schema: SCHEMA } },
                    messages: [{ role: "user", content: renderThread(c) }],
                });
                const entries = res.stop_reason === "refusal" ? [] : JSON.parse(res.content.find((b) => b.type === "text")?.text ?? "{}").entries ?? [];
                for (const e of entries) out.push({ ...e, sourceChatId: c.id, sourceUrl: c.url, parties: c.partiesDescription, status: c.closedDate ? "closed" : "open", __lastDate: lastDate(c) });
            } catch (err) {
                console.error(`\n! ${c.id}: ${err.message}`);
            }
        }
        done++;
        process.stderr.write(`\rDistilled: ${done}/${answerable.length} (${reused} cached, ${out.length} Q&A so far)`);
    }
}
await Promise.all(Array.from({ length: 4 }, worker));
process.stderr.write("\n");

backupFile(KB);
fs.writeFileSync(KB, JSON.stringify({ builtAt: new Date().toISOString(), model: MODEL, count: out.length, entries: out }, null, 2));
console.error(`Saved ${out.length} Q&A entries -> ${KB}`);
