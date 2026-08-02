// Export every proposal visible in Boss review as one plain Markdown file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proposalsFile = process.env.TIDY_PROPOSALS_FILE || path.join(here, "data", "proposals.json");
const inboxFile = process.env.TIDY_INBOX_FILE || path.join(here, "data", "inbox.json");
const outputFile = process.env.TIDY_BOSS_REVIEW_MARKDOWN || path.join(here, "outputs", "boss-review", "boss-review-proposals.md");
const proposalStore = fs.existsSync(proposalsFile) ? JSON.parse(fs.readFileSync(proposalsFile, "utf8")) : { proposals: [] };
const inbox = fs.existsSync(inboxFile) ? JSON.parse(fs.readFileSync(inboxFile, "utf8")) : { chats: [] };
const chats = new Map((inbox.chats || []).map((chat) => [chat.id, chat]));
const rank = { ready: 0, declined: 1, approved: 2, completed: 3 };
const statusLabel = { ready: "Ready for sign-off", declined: "Declined", approved: "Approved", completed: "Completed" };
const proposals = (proposalStore.proposals || []).filter((proposal) => Object.hasOwn(rank, proposal.status)).sort((a, b) => rank[a.status] - rank[b.status] || new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

function text(value, fallback = "Not provided") {
    if (value == null || value === "") return fallback;
    if (Array.isArray(value)) return value.map((item) => text(item, "")).filter(Boolean).join("; ") || fallback;
    if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${key.replace(/([A-Z])/g, " $1")}: ${text(item, "")}`).join("; ");
    const result = String(value).replaceAll("[object Object]", "").trim();
    return result || fallback;
}

function clientName(chat) {
    const parties = String(chat?.partiesDescription || "").split(",").map((part) => part.trim()).filter(Boolean);
    return parties.at(-1) || "Unknown client";
}

function sourceLines(proposal) {
    return (proposal.sourceChatIds || []).map((id) => {
        const chat = chats.get(id);
        if (!chat) return `- ${id}`;
        const label = `${chat.code || chat.id} — ${clientName(chat)}`;
        return chat.url ? `- [${label}](${chat.url})` : `- ${label}`;
    }).join("\n") || "- No source ticket found in the current sync.";
}

function oneLine(value, fallback = "Not provided") {
    return text(value, fallback).replace(/\s+/g, " ").trim();
}

function deliveryLine(proposal) {
    const scope = oneLine(proposal.scope, "");
    if (!scope) return oneLine(proposal.executiveSummary);
    const firstSentence = scope.match(/^.*?[.!?](?:\s|$)/)?.[0] || scope;
    const result = firstSentence.replace(/^First version:\s*/i, "").trim();
    return result ? result[0].toUpperCase() + result.slice(1) : result;
}

function conservativeDays(proposal) {
    const values = oneLine(proposal.estimatedDevEffort, "").match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
    return values.length ? Math.ceil(Math.max(...values)) : null;
}

function difficulty(days) {
    if (days == null) return "Not estimated";
    if (days <= 5) return "Low";
    if (days <= 10) return "Moderate";
    if (days <= 20) return "High";
    return "Very high";
}

const lines = [
    "# Boss review",
    "",
    `Generated: ${new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}`,
    `Proposals: ${proposals.length}`,
    "",
    "Review each recommendation and record a clear decision.",
];

for (let index = 0; index < proposals.length; index++) {
    const proposal = proposals[index];
    const days = conservativeDays(proposal);
    const executiveStatement = [proposal.executiveSummary, proposal.problem, proposal.impact]
        .map((value) => text(value, ""))
        .filter(Boolean)
        .join("\n\n");
    lines.push(
        "",
        "---",
        "",
        `## ${index + 1}. ${text(proposal.title, "Untitled proposal")}`,
        "",
        `Status: ${statusLabel[proposal.status] || text(proposal.status)}`,
        "",
        "### ELI5 — from the customer’s perspective",
        "",
        text(proposal.customerPerspective, text(proposal.eli5Summary)),
        "",
        "### What to deliver",
        "",
        deliveryLine(proposal),
        "",
        "### Executive statement",
        "",
        executiveStatement || "Not provided",
        "",
        "### Difficulty",
        "",
        difficulty(days),
        "",
        "### Expected development time",
        "",
        days == null
            ? "Not estimated"
            : `${days} developer-days for one developer. This uses the conservative upper end of the estimate and remains planning guidance, not a delivery commitment.`,
        "",
        "### Source tickets",
        "",
        sourceLines(proposal),
        "",
        "### Boss decision",
        "",
        "Decision: Approve / Decline / Send to Draft",
        "",
        "Notes:",
    );
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${lines.join("\n")}\n`);
console.log(`Exported ${proposals.length} Boss review proposal(s) -> ${outputFile}`);
