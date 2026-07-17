// Build a readable review page for open "bug" threads, grouped by whether they
// look FIXED-BUT-UNCONFIRMED (we shipped a fix, waiting on the customer) vs still
// active. You skim the last few replies, untick any that aren't actually done,
// and copy a ready-to-run close command for the rest.
//
// Two artifacts:
//   data/bug-digests.json  — compact transcripts of every open bug (input for AI analysis)
//   bug-review.html        — the review page (open in a browser)
//
// The verdict ("fixed-unconfirmed" / "active" / "unclear") comes from
// data/bug-verdicts.json, a map of { chatId: {verdict, reason} }. Produce it by
// asking a Claude session to analyse the digests (see REVIEW-BUGS-TASK.md) or by
// running summarize with a backend. Without it, the page still renders every open
// bug ungrouped so it's useful immediately.
//
// Usage:
//   node review-bugs.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const INBOX = path.join(here, "data", "inbox.json");
const ENRICHED = path.join(here, "data", "enriched.json");
const VERDICTS = path.join(here, "data", "bug-verdicts.json");
const DIGESTS = path.join(here, "data", "bug-digests.json");
const OUT = path.join(here, "bug-review.html");

const CLI = process.argv.includes("--cli");

if (!fs.existsSync(INBOX)) {
    console.error("No data/inbox.json — run `node fetch.mjs` (or sync) first.");
    process.exit(1);
}

const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
const aiById = fs.existsSync(ENRICHED)
    ? new Map(JSON.parse(fs.readFileSync(ENRICHED, "utf8")).chats.filter((c) => c.ai).map((c) => [c.id, c.ai]))
    : new Map();
const verdicts = fs.existsSync(VERDICTS) ? JSON.parse(fs.readFileSync(VERDICTS, "utf8")) : {};

// Staff detection: a sender who appears across many DIFFERENT customer companies is
// a Tidy rep. Distinct-chat counting misfires for prolific customers (all their
// tickets share one company); distinct-party counting does not. (fromSupport is
// unreliable on email threads.)
const senderParties = new Map();
for (const c of inbox.chats) {
    for (const m of c.messages) {
        if (!m.sender) continue;
        if (!senderParties.has(m.sender)) senderParties.set(m.sender, new Set());
        senderParties.get(m.sender).add(c.partiesDescription || "");
    }
}
const isStaff = (sender) => (senderParties.get(sender)?.size ?? 0) >= 3;

const openBugs = inbox.chats.filter((c) => !c.closedDate && !c.deleted && aiById.get(c.id)?.classification === "bug");

const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null);

// ---------- write digests for the AI analysis step ----------

const digests = openBugs.map((c) => ({
    id: c.id,
    title: c.title,
    parties: c.partiesDescription,
    daysIdle: daysSince(c.mostRecentMessageDate),
    summary: aiById.get(c.id)?.summary ?? "",
    lastMessages: c.messages
        .filter((m) => !m.isNote)
        .slice(-6)
        .map((m) => ({ who: isStaff(m.sender) ? "TIDY" : "CUSTOMER", sender: m.sender, date: (m.date ?? "").slice(0, 10), text: (m.text || "").slice(0, 600).replace(/\s+/g, " ") })),
}));
fs.mkdirSync(path.dirname(DIGESTS), { recursive: true });
fs.writeFileSync(DIGESTS, JSON.stringify(digests, null, 1));

// ---------- render the review page ----------

const GROUPS = [
    { key: "fixed-unconfirmed", title: "Likely fixed — awaiting customer confirmation", checked: true, color: "#0a7d33" },
    { key: "unclear", title: "Unclear — read before deciding", checked: false, color: "#a06a00" },
    { key: "active", title: "Still active — do not close", checked: false, color: "#9c0006" },
];
const groupOf = (id) => verdicts[id]?.verdict ?? (Object.keys(verdicts).length ? "unclear" : "ungrouped");

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function card(chat) {
    const ai = aiById.get(chat.id) ?? {};
    const v = verdicts[chat.id];
    const idle = daysSince(chat.mostRecentMessageDate);
    const msgs = chat.messages.filter((m) => !m.isNote).slice(-5);
    const group = GROUPS.find((g) => g.key === groupOf(chat.id));
    const checked = group?.checked ? "checked" : "";

    const bubbles = msgs
        .map((m) => {
            const staff = isStaff(m.sender);
            return `<div class="flex"><div class="bubble ${staff ? "b-staff" : "b-cust"}"><div class="who text-[11px] font-semibold mb-0.5">${esc(m.sender)} · ${esc((m.date ?? "").slice(0, 10))}</div>${esc((m.text || "(empty)").slice(0, 900))}</div></div>`;
        })
        .join("");

    const vColor = { "fixed-unconfirmed": "text-success", unclear: "text-warning", active: "text-error" }[groupOf(chat.id)] || "";

    return `<div class="card bg-base-100 shadow-sm mb-3 mx-5" data-group="${esc(groupOf(chat.id))}"><div class="card-body p-4 gap-1">
    <label class="flex items-center gap-3 cursor-pointer">
      <input type="checkbox" class="pick checkbox checkbox-sm" value="${esc(chat.id)}" data-label="${esc(chat.title || chat.partiesDescription || chat.id)}" ${checked}>
      <span class="font-semibold">${esc(chat.title || "(no subject)")}</span>
      <span class="opacity-60">${esc(chat.partiesDescription || "")}</span>
      <span class="ml-auto text-xs opacity-50 whitespace-nowrap">${idle == null ? "" : idle + "d idle"}</span>
    </label>
    ${v?.reason ? `<div class="text-sm font-semibold ${vColor}">→ ${esc(v.reason)}</div>` : ""}
    ${ai.summary ? `<div class="text-sm opacity-70">${esc(ai.summary)}</div>` : ""}
    <div class="flex flex-col gap-2 mt-2">${bubbles}</div>
    <a class="link link-primary text-xs mt-1" href="${esc(chat.url)}" target="_blank">open in CRM ↗</a>
  </div></div>`;
}

const bySortedGroup = [...openBugs].sort((a, b) => {
    const order = (id) => GROUPS.findIndex((g) => g.key === groupOf(id));
    return order(a.id) - order(b.id) || (daysSince(b.mostRecentMessageDate) ?? 0) - (daysSince(a.mostRecentMessageDate) ?? 0);
});

let body = "";
if (Object.keys(verdicts).length === 0) {
    body = `<div class="alert alert-warning mx-5 my-4">No AI verdicts yet — showing all ${openBugs.length} open bugs unsorted.
    To group them into "fixed-unconfirmed" vs "active", ask a Claude session to analyse
    <code>data/bug-digests.json</code> (see <code>REVIEW-BUGS-TASK.md</code>), then re-run this script.</div>`;
    body += openBugs.map(card).join("");
} else {
    const gColor = { "fixed-unconfirmed": "text-success", unclear: "text-warning", active: "text-error" };
    for (const g of GROUPS) {
        const inGroup = bySortedGroup.filter((c) => groupOf(c.id) === g.key);
        if (inGroup.length === 0) continue;
        body += `<h2 class="text-base font-semibold mt-6 mb-2 mx-5 ${gColor[g.key] ?? ""}">${g.title} <span class="badge badge-sm">${inGroup.length}</span></h2>`;
        body += inGroup.map(card).join("");
    }
}

const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Bug review — ${openBugs.length} open</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style>
  /* single-lane chat bubbles (user preference): both sides left, distinguished by colour */
  .bubble{max-width:92%;border-radius:14px;border-top-left-radius:4px;white-space:pre-wrap;padding:8px 12px;font-size:13px;border-left-width:3px}
  .b-staff{background:#eef4ff;border:1px solid #cfe0f5;border-left-color:#4a80c0}
  .b-cust{background:#faf8f3;border:1px solid #eee7d9;border-left-color:#cbbfa4}
  .b-staff .who{color:#3f6fa8} .b-cust .who{color:#a1926f}
  #cmd{position:fixed;left:-9999px}
</style></head><body class="bg-base-200 pb-24">
<header class="sticky top-0 bg-base-100 border-b px-5 py-3 z-10">
  <h1 class="text-lg font-semibold">Open bugs — review to close</h1>
  <div class="text-sm opacity-60">Tick = will be closed. Pre-ticked = looks fixed &amp; unconfirmed. Untick anything still live, then copy the close command.</div>
</header>
${body}
<footer class="fixed bottom-0 inset-x-0 bg-neutral text-neutral-content px-5 py-3 flex gap-3 items-center flex-wrap z-20">
  <span><span id="count" class="font-semibold">0</span> selected</span>
  <div class="ml-auto flex gap-2">
    <button class="btn btn-sm" onclick="selectGroup('fixed-unconfirmed')">Select only fixed-unconfirmed</button>
    <button class="btn btn-sm" onclick="setAll(false)">Clear all</button>
    <button class="btn btn-sm btn-success" onclick="copyCmd()">Copy close command</button>
  </div>
</footer>
<textarea id="cmd"></textarea>
<script>
  const picks = () => [...document.querySelectorAll('.pick')];
  const selected = () => picks().filter(p => p.checked);
  // Persist tick state across refreshes. Only ids the user has touched are stored;
  // untouched bugs keep their default (fixed-unconfirmed pre-checked).
  const STORE = 'tidy-bug-picks';
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  picks().forEach(p => { if (p.value in saved) p.checked = saved[p.value]; });
  function save(){ const m = {}; picks().forEach(p => m[p.value] = p.checked); localStorage.setItem(STORE, JSON.stringify(m)); }
  function refresh(){ document.getElementById('count').textContent = selected().length; }
  function setAll(v){ picks().forEach(p => p.checked = v); save(); refresh(); }
  function selectGroup(g){ picks().forEach(p => p.checked = p.closest('.card').dataset.group === g); save(); refresh(); }
  function copyCmd(){
    const ids = selected().map(p => p.value);
    if(!ids.length){ alert('Nothing selected.'); return; }
    const cmd = 'node close-chats.mjs --ids ' + ids.join(',') + ' --apply';
    const ta = document.getElementById('cmd'); ta.value = cmd; ta.select();
    navigator.clipboard?.writeText(cmd).catch(()=>document.execCommand('copy'));
    alert('Copied close command for ' + ids.length + ' chats.\\nPaste it in your terminal, then run: node sync.mjs && node report.mjs');
  }
  document.addEventListener('change', e => { if(e.target.classList.contains('pick')){ save(); refresh(); } });
  refresh();
</script>
</body></html>`;

fs.writeFileSync(OUT, html);

const groupCounts = {};
for (const c of openBugs) groupCounts[groupOf(c.id)] = (groupCounts[groupOf(c.id)] ?? 0) + 1;

if (CLI) {
    printCli();
} else {
    console.error(`${openBugs.length} open bugs -> ${OUT}`);
    console.error(`Groups: ${JSON.stringify(groupCounts)}`);
    if (Object.keys(verdicts).length === 0) {
        console.error(`\nNo verdicts yet. To group them: ask Claude to analyse data/bug-digests.json (see REVIEW-BUGS-TASK.md), then re-run.`);
    }
    console.error(`Open it:  open ${OUT}`);
}

/** Terminal version of the review page. */
function printCli() {
    const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", blue: "\x1b[36m", grey: "\x1b[90m" };
    const groupColor = { "fixed-unconfirmed": C.green, unclear: C.yellow, active: C.red, ungrouped: C.dim };
    const wrap = (s, w = 96, indent = "        ") =>
        String(s || "")
            .replace(/\s+/g, " ")
            .replace(new RegExp(`(.{1,${w}})(\\s|$)`, "g"), `$1\n${indent}`)
            .trimEnd();

    console.log(`\n${C.bold}Open bugs — review to close${C.reset}  (${openBugs.length} total)`);
    if (Object.keys(verdicts).length === 0) {
        console.log(`${C.yellow}No verdicts yet — showing all bugs ungrouped. Ask Claude to analyse data/bug-digests.json (REVIEW-BUGS-TASK.md).${C.reset}`);
    }

    for (const g of GROUPS.length ? GROUPS : [{ key: "ungrouped", title: "All open bugs" }]) {
        const inGroup = bySortedGroup.filter((c) => groupOf(c.id) === g.key);
        if (inGroup.length === 0) continue;
        const col = groupColor[g.key] ?? C.reset;
        console.log(`\n${col}${C.bold}▚ ${g.title}  (${inGroup.length})${C.reset}`);

        const detailed = g.key === "fixed-unconfirmed";
        for (const c of inGroup) {
            const ai = aiById.get(c.id) ?? {};
            const v = verdicts[c.id];
            const idle = daysSince(c.mostRecentMessageDate);
            const head = `${col}•${C.reset} ${C.bold}${c.title || "(no subject)"}${C.reset} ${C.grey}${c.partiesDescription || ""} · ${idle == null ? "" : idle + "d idle"}${C.reset}`;
            console.log(`  ${head}`);
            if (v?.reason) console.log(`      ${col}→ ${wrap(v.reason)}${C.reset}`);
            if (detailed) {
                for (const m of c.messages.filter((x) => !x.isNote).slice(-2)) {
                    const staff = isStaff(m.sender);
                    const tag = `${staff ? C.blue : C.reset}${staff ? "Tidy" : "cust"} ${m.sender}${C.reset}`;
                    console.log(`      ${C.dim}${(m.date ?? "").slice(0, 10)}${C.reset} ${tag}: ${wrap(m.text, 90)}`);
                }
                console.log(`      ${C.grey}${c.url}${C.reset}`);
            }
        }
    }

    const closeIds = bySortedGroup.filter((c) => groupOf(c.id) === "fixed-unconfirmed").map((c) => c.id);
    if (closeIds.length) {
        console.log(`\n${C.bold}To close the ${closeIds.length} fixed-unconfirmed bugs${C.reset} (delete any id you want to keep):\n`);
        console.log(`node close-chats.mjs --ids ${closeIds.join(",")} --apply`);
        console.log(`${C.dim}then: node sync.mjs && node report.mjs${C.reset}`);
    }
    console.log(`\n${C.dim}(Full readable version with checkboxes: open ${path.basename(OUT)})${C.reset}`);
}
