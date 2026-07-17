// Bulk-close chats via POST /v1/chats/{id}/close.
// Dry-run by default — nothing is closed until you pass --apply.
// (Closing is reversible: the CRM has a reopen endpoint, and closed chats
// stay visible under the Closed inbox.)
//
// Usage:
//   node close-chats.mjs --suggested            # preview AI-suggested closes from data/enriched.json
//   node close-chats.mjs --suggested --apply    # actually close them
//   node close-chats.mjs --ids id1,id2,id3 --apply
//   node close-chats.mjs --file ids.txt --apply # one chat id per line

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeChat, mapLimit, requireToken } from "./lib/api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENRICHED = path.join(here, "data", "enriched.json");
const RAW = path.join(here, "data", "inbox.json");

// Use enriched data when available (has AI suggestions), otherwise plain inbox data.
const dataFile = fs.existsSync(ENRICHED) ? ENRICHED : fs.existsSync(RAW) ? RAW : null;
const data = dataFile ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : null;
const chatById = new Map(data?.chats.map((c) => [c.id, c]) ?? []);

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");

function argValue(flag) {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : null;
}

let targets = []; // { id, label, reason }

function labelFor(id) {
    const c = chatById.get(id);
    if (!c) return "";
    return c.ai?.headline ? `${c.ai.headline} — ${c.partiesDescription ?? c.title ?? ""}` : (c.title ?? c.partiesDescription ?? "");
}

if (args.includes("--suggested")) {
    if (!data) {
        console.error("No data/inbox.json — run fetch.mjs first.");
        process.exit(1);
    }
    targets = data.chats
        .filter((c) => c.ai?.suggestClose && !c.closedDate)
        .map((c) => ({ id: c.id, label: labelFor(c.id), reason: c.ai.closeReason }));

    if (targets.length === 0 && !data.chats.some((c) => c.ai)) {
        console.error(
            `${path.basename(dataFile)} has no AI suggestions yet — suggest-close flags come from the summarize step.\n` +
                "Either run summarize.mjs, or close specific chats directly:\n" +
                "  node close-chats.mjs --ids <id1>,<id2> --apply\n" +
                '  (or mark rows "close" in the sheet and run: node sync.mjs)',
        );
        process.exit(1);
    }
} else if (argValue("--ids")) {
    // Consume everything from --ids up to the next flag, so both
    // "--ids a,b,c" and "--ids a, b, c" (shell-split on spaces) work.
    const start = args.indexOf("--ids") + 1;
    let raw = [];
    for (let i = start; i < args.length && !args[i].startsWith("--"); i++) raw.push(args[i]);
    targets = raw
        .join(",")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => ({ id, label: labelFor(id), reason: "" }));
} else if (argValue("--file")) {
    targets = fs
        .readFileSync(argValue("--file"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((id) => ({ id, label: labelFor(id), reason: "" }));
} else {
    console.error("Pass one of: --suggested | --ids id1,id2 | --file ids.txt   (add --apply to actually close)");
    process.exit(1);
}

if (targets.length === 0) {
    console.error("Nothing to close.");
    process.exit(0);
}

console.error(`${APPLY ? "CLOSING" : "DRY RUN — would close"} ${targets.length} chats:\n`);
for (const t of targets) {
    console.error(`  ${t.id}  ${t.label}${t.reason ? `  (${t.reason})` : ""}`);
}

if (!APPLY) {
    console.error("\nDry run only. Re-run with --apply to close these chats.");
    process.exit(0);
}

requireToken();
let ok = 0;
let failed = 0;
await mapLimit(targets, 4, async (t) => {
    try {
        await closeChat(t.id);
        ok++;
    } catch (err) {
        failed++;
        console.error(`! ${t.id}: ${err.message}`);
    }
    process.stderr.write(`\rClosed ${ok}/${targets.length}${failed ? ` (${failed} failed)` : ""}`);
});
process.stderr.write("\n");
console.error("Done. (Reopen from the Closed inbox in the CRM if anything was closed by mistake.)");
