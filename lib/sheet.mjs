// Read the user-editable annotation columns back out of inbox-report.xlsx.

import fs from "node:fs";
import ExcelJS from "exceljs";

/** Returns Map<chatId, {action, notes}> from the "My action"/"My notes" columns. */
export async function readAnnotations(file) {
    const map = new Map();
    if (!fs.existsSync(file)) return map;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet("Inbox");
    if (!ws) return map;

    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
        headers[cellText(cell.value).trim()] = col;
    });
    const idCol = headers["Chat ID"];
    const actionCol = headers["My action"];
    const notesCol = headers["My notes"];
    if (!idCol) return map;

    ws.eachRow((row, n) => {
        if (n === 1) return;
        const id = cellText(row.getCell(idCol).value).trim();
        if (!id) return;
        const action = actionCol ? cellText(row.getCell(actionCol).value).trim().toLowerCase() : "";
        const notes = notesCol ? cellText(row.getCell(notesCol).value).trim() : "";
        if (action || notes) map.set(id, { action, notes });
    });
    return map;
}

function cellText(value) {
    if (value == null) return "";
    if (typeof value === "object") {
        if (value.richText) return value.richText.map((r) => r.text).join("");
        if (value.text) return String(value.text);
        if (value.result !== undefined) return String(value.result);
    }
    return String(value);
}
