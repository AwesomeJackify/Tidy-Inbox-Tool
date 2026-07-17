// Safety net: copy a file into data/backups/ before it gets overwritten.
// Keeps the newest 20 backups per file name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(here, "..", "data", "backups");

export function backupFile(file) {
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = path.basename(file);
    const dest = path.join(BACKUP_DIR, `${base}.${stamp}.bak`);
    fs.copyFileSync(file, dest);

    // prune old backups of this file
    const siblings = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith(".bak"))
        .sort()
        .reverse();
    for (const old of siblings.slice(20)) {
        fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
    return dest;
}
