// Draft one boss-ready proposal for every Feature-labelled ticket not already
// assigned to a proposal. Uses the shared AI backend (Codex, Claude, API, etc.).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { runAiJson } from "./lib/ai-json.mjs";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (name) => path.join(here, "data", name);
const INBOX = file("inbox.json");
const ENRICHED = file("enriched.json");
const TYPES = file("ticket-types.json");
const PROPOSALS = file("proposals.json");
const ACTIONS = file("ticket-actions.json");
const BATCH_SIZE = 6;
const CONCURRENCY = Math.max(1, Number(process.env.TIDY_PROPOSAL_CONCURRENCY || 2));

if (!fs.existsSync(INBOX)) throw new Error("No data/inbox.json. Run Sync first.");
const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
const enriched = fs.existsSync(ENRICHED) ? JSON.parse(fs.readFileSync(ENRICHED, "utf8")) : { chats: [] };
const manual = fs.existsSync(TYPES) ? JSON.parse(fs.readFileSync(TYPES, "utf8")).types ?? {} : {};
const store = fs.existsSync(PROPOSALS) ? JSON.parse(fs.readFileSync(PROPOSALS, "utf8")) : { proposals: [] };
const actionStore = fs.existsSync(ACTIONS) ? JSON.parse(fs.readFileSync(ACTIONS, "utf8")) : { decisions: {}, events: [] };
const proposals = Array.isArray(store.proposals) ? store.proposals : [];
const aiById = new Map((enriched.chats || []).map((chat) => [chat.id, chat.ai || {}]));
const used = new Set(proposals.flatMap((proposal) => proposal.sourceChatIds || []));
const features = inbox.chats.filter((chat) => (manual[chat.id] || aiById.get(chat.id)?.classification) === "feature" && !used.has(chat.id));

function planningStart() {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 7);
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function source(chat) {
    const messages = (chat.messages || []).filter((message) => !message.isNote);
    const shown = messages.length <= 10 ? messages : [...messages.slice(0, 2), ...messages.slice(-8)];
    const ai = aiById.get(chat.id) || {};
    return {
        id: chat.id,
        code: chat.code,
        client: chat.partiesDescription,
        title: chat.title,
        opened: chat.createdDate,
        lastActivity: chat.mostRecentMessageDate,
        existingHeadline: ai.headline || "",
        existingSummary: ai.summary || "",
        messages: shown.map((message) => ({ sender: message.sender, date: message.date, text: String(message.text || "").slice(0, 1000) })),
    };
}

function batchPrompt(chats) {
    const earliest = planningStart();
    return `Draft exactly one management proposal for each source ticket below. Do not combine tickets. Return ONLY a JSON object with a "proposals" array containing exactly one object per source. Every object must preserve its exact sourceChatId and contain: sourceChatId, title, eli5Summary, customerPerspective, executiveSummary, problem, impact, scope, risks, questions, priority, estimatedDevEffort, estimatedStartDate, estimatedCompletionDate, estimateAssumptions, evidence. Evidence must be an array of short factual strings. Stay grounded in the ticket; do not invent names, revenue, customer sentiment, integrations, or requirements. eli5Summary must explain the request in 1–2 simple, jargon-free sentences. customerPerspective must explain the request from the customer's point of view in 1–3 sentences, naming a person and company only when explicitly supplied in the ticket; otherwise say "The customer at [company]". Scope must give a useful first version and explicit non-goals. Priority must be low, medium, or high with a brief reason. estimatedDevEffort must be a conservative developer-day range. Dates must be YYYY-MM-DD, start no earlier than ${earliest}, and represent an independent scenario where approval and one developer's capacity are available—not a promise or a portfolio schedule. estimateAssumptions must state that capacity assumption plus technical unknowns, testing, review, and dependencies that could move the dates.\n\nSources:\n${JSON.stringify(chats.map(source))}`;
}

function clean(value, chatId, sourceName) {
    const text = (input) => {
        if (input == null) return "";
        if (Array.isArray(input)) return input.map(text).filter(Boolean).join("; ");
        if (typeof input === "object") return Object.entries(input).map(([key, item]) => `${key.replace(/([A-Z])/g, " $1")}: ${text(item)}`).filter((item) => !item.endsWith(": ")).join("\n");
        return String(input).trim();
    };
    const string = (key) => text(value?.[key]);
    const result = {
        title: string("title"), eli5Summary: string("eli5Summary"), customerPerspective: string("customerPerspective"), executiveSummary: string("executiveSummary"), problem: string("problem"), impact: string("impact"),
        scope: string("scope"), risks: string("risks"), questions: string("questions"), priority: string("priority"),
        estimatedDevEffort: string("estimatedDevEffort"), estimatedStartDate: string("estimatedStartDate"),
        estimatedCompletionDate: string("estimatedCompletionDate"), estimateAssumptions: string("estimateAssumptions"),
        evidence: Array.isArray(value?.evidence) ? value.evidence.map(text).filter(Boolean).slice(0, 20) : [],
        sourceChatIds: [chatId], aiSource: sourceName,
    };
    const required = ["title", "eli5Summary", "customerPerspective", "executiveSummary", "problem", "scope", "priority", "estimatedDevEffort", "estimatedStartDate", "estimatedCompletionDate", "estimateAssumptions"];
    if (required.some((key) => !result[key])) throw new Error(`AI omitted required fields for ${chatId}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result.estimatedStartDate) || !/^\d{4}-\d{2}-\d{2}$/.test(result.estimatedCompletionDate)) throw new Error(`AI returned invalid dates for ${chatId}.`);
    return result;
}

async function draftBatch(chats) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const response = await runAiJson(batchPrompt(chats));
            const rows = Array.isArray(response.value?.proposals) ? response.value.proposals : [];
            const byId = new Map(rows.map((row) => [row.sourceChatId, row]));
            if (chats.some((chat) => !byId.has(chat.id))) throw new Error("AI did not return every requested sourceChatId.");
            return chats.map((chat) => clean(byId.get(chat.id), chat.id, response.source));
        } catch (error) {
            lastError = error;
            console.error(`Batch attempt ${attempt} failed: ${error.message}`);
        }
    }
    throw lastError;
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const index = next++;
            if (index >= items.length) return;
            try { results[index] = { ok: true, value: await fn(items[index], index) }; }
            catch (error) { results[index] = { ok: false, error }; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

if (!features.length) {
    console.log("All Feature-labelled tickets already have proposals.");
    process.exit(0);
}

const batches = [];
for (let index = 0; index < features.length; index += BATCH_SIZE) batches.push(features.slice(index, index + BATCH_SIZE));
console.log(`Drafting ${features.length} proposal(s) in ${batches.length} batch(es)…`);
const results = await mapLimit(batches, CONCURRENCY, async (batch, index) => {
    console.log(`Batch ${index + 1}/${batches.length}: ${batch.length} feature request(s)`);
    return draftBatch(batch);
});

const drafted = results.filter((result) => result.ok).flatMap((result) => result.value);
const failedIds = results.flatMap((result, index) => result.ok ? [] : batches[index].map((chat) => chat.id));
const now = new Date().toISOString();
for (const draft of drafted) {
    const id = randomUUID();
    proposals.unshift({ ...draft, id, status: "ready", author: `${draft.aiSource || "AI"} draft`, createdAt: now, updatedAt: now, history: [{ at: now, by: draft.aiSource || "AI", action: "created", status: "ready", comment: "Bulk-drafted from Feature-labelled ticket with indicative development estimate." }] });
    actionStore.events.push({ id: randomUUID(), ticketId: draft.sourceChatIds[0], at: now, by: draft.aiSource || "AI", action: "proposal_status_changed", from: null, to: "ready", success: true, detail: `Boss-ready proposal drafted: ${draft.title}` });
}

if (drafted.length) {
    backupFile(PROPOSALS); backupFile(ACTIONS);
    fs.writeFileSync(PROPOSALS, JSON.stringify({ updatedAt: now, proposals }, null, 2));
    fs.writeFileSync(ACTIONS, JSON.stringify({ updatedAt: now, decisions: actionStore.decisions || {}, events: actionStore.events || [] }, null, 2));
}
console.log(`Created ${drafted.length}/${features.length} boss-ready proposal(s).`);
if (failedIds.length) {
    console.error(`Failed ticket IDs (${failedIds.length}): ${failedIds.join(", ")}`);
    process.exitCode = 1;
}
