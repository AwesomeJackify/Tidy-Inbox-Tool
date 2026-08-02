// Delta-sync between the spreadsheet, local data, and the CRM. Cheap by design:
//
//   1. PUSH:  rows you marked "close" in the sheet's "My action" column are
//             closed in the CRM.
//   2. PULL:  one paged list request for all open and closed chats. Full message history
//             is re-fetched ONLY for new chats or chats whose latest message
//             changed.
//   3. MERGE: data/inbox.json is updated in place. Closed chats stay in the file
//             so the sheet keeps showing them (status: closed).
//
// After syncing, re-run summarize (only changed chats hit the AI) and report
// (your My action / My notes columns are preserved).
//
// Usage:
//   node sync.mjs              # push + pull + merge
//   node sync.mjs --dry-run    # show what would happen, change nothing
//   npm run sync               # sync + summarize + report in one go

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllChats, getChatsByIds, getChatMessages, closeChat, mapLimit, requireToken, API_BASE } from "./lib/api.mjs";
import { mapChat } from "./lib/map.mjs";
import { readAnnotations } from "./lib/sheet.mjs";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(here, "data", "inbox.json");
const SHEET = path.join(here, "inbox-report.xlsx");

const DRY = process.argv.includes("--dry-run");

if (!fs.existsSync(INBOX)) {
    console.error("No data/inbox.json — run `node fetch.mjs` once first.");
    process.exit(1);
}
requireToken();
console.error(`API: ${API_BASE}${DRY ? "  (DRY RUN — no writes)" : ""}`);

const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
const localById = new Map(inbox.chats.map((c) => [c.id, c]));

// ---------- 1. PUSH: apply "close" decisions from the sheet ----------

const annotations = await readAnnotations(SHEET);
const toClose = [...annotations.entries()]
    .filter(([id, a]) => a.action === "close")
    .map(([id]) => localById.get(id))
    .filter((c) => c && !c.closedDate);

if (toClose.length > 0) {
    console.error(`\nSheet decisions: ${toClose.length} chat(s) marked "close":`);
    for (const c of toClose) console.error(`  - ${c.title ?? c.partiesDescription ?? c.id}`);
    if (!DRY) {
        let failed = 0;
        await mapLimit(toClose, 4, async (c) => {
            try {
                await closeChat(c.id);
            } catch (err) {
                failed++;
                console.error(`  ! close ${c.id} failed: ${err.message}`);
            }
        });
        console.error(`Closed ${toClose.length - failed}/${toClose.length} in the CRM.`);
    }
} else {
    console.error("\nSheet decisions: nothing marked 'close'.");
}

// ---------- 2. PULL: cheap delta detection ----------

console.error("");
const freshOpen = await getAllChats({ includeClosed: true });
const freshById = new Map(freshOpen.map((c) => [c.id, c]));

// Chats we know locally that are no longer in the open list: closed remotely,
// closed by us just now, or deleted. One ID-lookup round trip resolves them.
const missingIds = [...localById.keys()].filter((id) => !freshById.has(id));
const refetched = missingIds.length > 0 ? await getChatsByIds(missingIds) : [];
const refetchedById = new Map(refetched.map((c) => [c.id, c]));
const deletedIds = missingIds.filter((id) => !refetchedById.has(id));

// A chat needs its messages re-fetched only if it's new or its latest message moved.
const candidates = [...freshOpen, ...refetched];
const needsMessages = candidates.filter((c) => {
    const local = localById.get(c.id);
    return !local || (local.mostRecentMessageDate ?? null) !== (c.mostRecentMessageDate ?? null);
});

const newCount = candidates.filter((c) => !localById.has(c.id)).length;
console.error(
    `Delta: ${newCount} new, ${needsMessages.length - newCount} updated, ` +
        `${refetched.filter((c) => c.closedDate && !localById.get(c.id)?.closedDate).length} newly closed, ` +
        `${deletedIds.length} deleted, ${candidates.length - needsMessages.length} unchanged.`,
);

if (DRY) {
    console.error("\nDry run — stopping before message fetch/merge.");
    process.exit(0);
}

let done = 0;
const fetchedMessages = new Map();
await mapLimit(needsMessages, 5, async (c) => {
    try {
        fetchedMessages.set(c.id, await getChatMessages(c.id));
    } catch (err) {
        console.error(`\n! Failed messages for chat ${c.id}: ${err.message}`);
        fetchedMessages.set(c.id, localById.get(c.id)?.messages ?? []);
    }
    done++;
    process.stderr.write(`\rMessages: ${done}/${needsMessages.length} changed chats`);
});
if (needsMessages.length > 0) process.stderr.write("\n");

// ---------- 3. MERGE ----------

const mergedChats = candidates.map((c) => {
    const local = localById.get(c.id);
    const messages = fetchedMessages.has(c.id) ? fetchedMessages.get(c.id) : null;
    if (messages) {
        return mapChat(c, messages);
    }
    // metadata may still have moved (title, assignment, closedDate) — refresh it, keep messages
    return { ...mapChat(c, local.messages ?? []), messages: local.messages };
});

// Deleted chats stay visible in the sheet, flagged.
for (const id of deletedIds) {
    const local = localById.get(id);
    mergedChats.push({ ...local, deleted: true });
}

backupFile(INBOX);
fs.writeFileSync(
    INBOX,
    JSON.stringify({ ...inbox, fetchedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), chats: mergedChats }, null, 2),
);

console.error(`Saved ${mergedChats.length} chats -> ${INBOX}`);
console.error("Next: node summarize.mjs (only changed chats hit the AI) && node report.mjs (keeps your My action / My notes).");
