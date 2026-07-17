// Fetch every chat + all its messages from the Tidy CRM and save to data/inbox.json.
//
// Usage:
//   export TIDY_TOKEN='<TidyCore_AccessToken cookie value>'
//   node fetch.mjs                 # open chats only (what /communication/inbox/all shows)
//   node fetch.mjs --include-closed

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllChats, getChatMessages, mapLimit, requireToken, API_BASE } from "./lib/api.mjs";
import { mapChat } from "./lib/map.mjs";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "data", "inbox.json");

const includeClosed = process.argv.includes("--include-closed");

requireToken();
console.error(`API: ${API_BASE}  (includeClosed=${includeClosed})`);

const chats = await getAllChats({ includeClosed });
console.error(`Fetching messages for ${chats.length} chats (5 at a time)...`);

let done = 0;
const enrichedChats = await mapLimit(chats, 5, async (chat) => {
    let messages = [];
    try {
        messages = await getChatMessages(chat.id);
    } catch (err) {
        console.error(`\n! Failed messages for chat ${chat.id} (${chat.title ?? "untitled"}): ${err.message}`);
    }
    done++;
    process.stderr.write(`\rMessages: ${done}/${chats.length} chats`);

    return mapChat(chat, messages);
});

process.stderr.write("\n");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const backup = backupFile(OUT);
if (backup) console.error(`Previous inbox.json backed up -> ${backup}`);
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), includeClosed, chats: enrichedChats }, null, 2));

const totalMessages = enrichedChats.reduce((n, c) => n + c.messages.length, 0);
console.error(`Saved ${enrichedChats.length} chats / ${totalMessages} messages -> ${OUT}`);
