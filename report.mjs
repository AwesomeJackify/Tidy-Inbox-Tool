// Build inbox-report.xlsx from data/enriched.json (falls back to data/inbox.json
// without AI columns if you haven't run summarize yet).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { readAnnotations } from "./lib/sheet.mjs";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENRICHED = path.join(here, "data", "enriched.json");
const RAW = path.join(here, "data", "inbox.json");
const OUT = path.join(here, "inbox-report.xlsx");

// Chat status/metadata always comes from inbox.json (sync.mjs keeps it current);
// enriched.json only contributes the AI columns, joined by chat id.
const src = fs.existsSync(RAW) ? RAW : fs.existsSync(ENRICHED) ? ENRICHED : null;
if (!src) {
    console.error("No data found — run `node fetch.mjs` (and optionally `node summarize.mjs`) first.");
    process.exit(1);
}
const data = JSON.parse(fs.readFileSync(src, "utf8"));
if (src === RAW && fs.existsSync(ENRICHED)) {
    const enriched = JSON.parse(fs.readFileSync(ENRICHED, "utf8"));
    const aiById = new Map(enriched.chats.filter((c) => c.ai).map((c) => [c.id, c.ai]));
    let joined = 0;
    for (const chat of data.chats) {
        const ai = aiById.get(chat.id);
        if (ai) {
            chat.ai = ai;
            joined++;
        }
    }
    console.error(`Joined AI summaries for ${joined}/${data.chats.length} chats from enriched.json.`);
}
console.error(`Building report from ${path.basename(src)} (${data.chats.length} chats)...`);

// Carry your manual edits over from the previous version of the sheet.
const annotations = await readAnnotations(OUT);
if (annotations.size > 0) console.error(`Preserving ${annotations.size} annotated row(s) from the existing sheet.`);

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Inbox", { views: [{ state: "frozen", ySplit: 1 }] });

ws.columns = [
    { header: "Opened", key: "opened", width: 11, style: { numFmt: "yyyy-mm-dd" } },
    { header: "Last activity", key: "last", width: 11, style: { numFmt: "yyyy-mm-dd" } },
    { header: "From", key: "from", width: 24 },
    { header: "Headline", key: "headline", width: 38 },
    { header: "Type", key: "type", width: 10 },
    { header: "Action needed", key: "action", width: 13 },
    { header: "Suggest close", key: "close", width: 13 },
    { header: "Close reason", key: "closeReason", width: 30 },
    { header: "My action", key: "myAction", width: 10 },
    { header: "My notes", key: "myNotes", width: 28 },
    { header: "AI summary", key: "summary", width: 70 },
    { header: "Msgs", key: "msgs", width: 6 },
    { header: "Status", key: "status", width: 8 },
    { header: "Assigned", key: "assigned", width: 16 },
    { header: "Subject/title", key: "title", width: 34 },
    { header: "Link", key: "link", width: 12 },
    { header: "Chat ID", key: "id", width: 38 },
];

const TYPE_COLORS = { bug: "FFFFC7CE", feature: "FFC6EFCE", "not sure": "FFFFEB9C" };

const chats = [...data.chats].sort((a, b) => new Date(b.mostRecentMessageDate ?? 0) - new Date(a.mostRecentMessageDate ?? 0));

for (const chat of chats) {
    const ai = chat.ai ?? {};
    const ann = annotations.get(chat.id);
    // A "close" decision that has been applied (chat is now closed) is spent — drop it.
    const myAction = ann?.action === "close" && chat.closedDate ? "" : (ann?.action ?? "");
    const row = ws.addRow({
        opened: chat.createdDate ? new Date(chat.createdDate) : null,
        last: chat.mostRecentMessageDate ? new Date(chat.mostRecentMessageDate) : null,
        from: chat.partiesDescription || chat.messages?.find((m) => !m.fromSupport)?.sender || "",
        headline: ai.headline ?? "",
        type: ai.classification ?? "",
        action: ai.actionNeeded === undefined ? "" : ai.actionNeeded ? "YES" : "no",
        close: ai.suggestClose === undefined ? "" : ai.suggestClose ? "YES" : "no",
        closeReason: ai.closeReason ?? "",
        myAction,
        myNotes: ann?.notes ?? "",
        summary: ai.summary ?? "",
        msgs: chat.messages?.length ?? 0,
        status: chat.deleted ? "deleted" : chat.closedDate ? "closed" : "open",
        assigned: (chat.assignedUsers ?? []).join(", "),
        title: chat.title ?? "",
        id: chat.id,
    });

    row.getCell("link").value = { text: "open", hyperlink: chat.url };
    row.getCell("link").font = { color: { argb: "FF0563C1" }, underline: true };

    const typeColor = TYPE_COLORS[ai.classification];
    if (typeColor) {
        row.getCell("type").fill = { type: "pattern", pattern: "solid", fgColor: { argb: typeColor } };
    }
    if (ai.suggestClose) {
        row.getCell("close").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
    }
    if (ai.actionNeeded) {
        row.getCell("action").font = { bold: true, color: { argb: "FF9C0006" } };
    }
    row.getCell("summary").alignment = { wrapText: true, vertical: "top" };
    row.getCell("closeReason").alignment = { wrapText: true, vertical: "top" };
    row.getCell("myNotes").alignment = { wrapText: true, vertical: "top" };
    row.getCell("myAction").dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"close,keep"'],
    };
    if (myAction === "close") {
        row.getCell("myAction").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };
    }
    row.alignment = { vertical: "top" };
}

ws.getRow(1).font = { bold: true };
ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };

backupFile(OUT);
await wb.xlsx.writeFile(OUT);
console.error(`Wrote ${OUT}`);
