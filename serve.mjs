// Local web app that ties the whole tool together — a personal CRM ticket manager.
//
//   export TIDY_REFRESH_TOKEN=...  (one-time setup for sync / close actions)
//   node serve.mjs             then open http://localhost:8787
//
// It serves a dashboard over the existing data files and exposes the pipeline
// scripts as buttons. No new dependencies — plain node:http. Localhost only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeChat, reopenChat, mapLimit, setToken, setRefreshToken, hasToken, hasRefreshToken, verifyToken } from "./lib/api.mjs";
import { detectAiBackend } from "./lib/ai-backend.mjs";
import { runAiJson } from "./lib/ai-json.mjs";
import { backupFile } from "./lib/backup.mjs";
import { isKnownTidyStaff } from "./lib/map.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = (f) => path.join(here, "data", f);
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// Scripts the dashboard buttons may run.
const RUNNABLE = new Set(["fetch", "sync", "summarize", "report", "draft-feature-proposals"]);
const REPORT_FILE = path.join(here, "inbox-report.xlsx");
const BOSS_REVIEW_MARKDOWN = path.join(here, "outputs", "boss-review", "boss-review-proposals.md");
const PROPOSALS_FILE = dataFile("proposals.json");
const TYPES_FILE = dataFile("ticket-types.json");
const ACTIONS_FILE = process.env.TIDY_ACTIONS_FILE || dataFile("ticket-actions.json");
const RELEASE_FOLLOWUPS_FILE = process.env.TIDY_RELEASE_FOLLOWUPS_FILE || dataFile("release-followups.json");

// Current CRM token — starts from env, updatable at runtime via /api/token so a
// mid-session expiry doesn't force a server restart. Used for /api/close (in-memory)
// and injected into spawned scripts' env (sync/fetch).
let currentToken = process.env.TIDY_TOKEN;
let tokenRejected = false;
let tokenVerifiedAt = null;

function crmTokenStatus() {
    if (!hasToken()) return { available: false, state: "missing", verifiedAt: null, reason: "No CRM refresh token or access token is set." };
    if (tokenRejected) return { available: false, state: "expired", verifiedAt: tokenVerifiedAt, reason: "The CRM rejected this token. It has probably expired." };
    try {
        if (hasRefreshToken() || !currentToken) return { available: true, state: tokenVerifiedAt ? "verified" : "unverified", verifiedAt: tokenVerifiedAt, reason: tokenVerifiedAt ? null : "Authentication will be verified and refreshed automatically." };
        const parts = currentToken.split(".");
        if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            if (payload.exp && Date.now() >= payload.exp * 1000) return { available: false, state: "expired", verifiedAt: tokenVerifiedAt, reason: "The CRM token has expired." };
        }
    } catch {}
    return { available: true, state: tokenVerifiedAt ? "verified" : "unverified", verifiedAt: tokenVerifiedAt, reason: tokenVerifiedAt ? null : "Token has not been checked with the CRM yet." };
}

async function checkCrmToken() {
    const current = crmTokenStatus();
    if (!current.available) return current;
    // Skip network check if verified within the last 4 minutes
    if (tokenVerifiedAt && (Date.now() - new Date(tokenVerifiedAt).getTime()) < 4 * 60 * 1000) return current;
    try {
        await verifyToken();
        tokenRejected = false;
        tokenVerifiedAt = new Date().toISOString();
        return crmTokenStatus();
    } catch (err) {
        const reason = String(err?.message || err);
        if (/401|unauthori[sz]ed|token.{0,20}expired/i.test(reason)) {
            tokenRejected = true;
            return crmTokenStatus();
        }
        return { ...crmTokenStatus(), state: "unknown", verifiedAt: tokenVerifiedAt, reason: `Could not verify the token right now: ${reason}` };
    }
}

function summarizationStatus() {
    return detectAiBackend();
}

function openLocalFile(file) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", file] : [file];
    return new Promise((resolve) => {
        const proc = spawn(command, args, { stdio: "ignore" });
        proc.on("error", () => resolve(false));
        proc.on("close", (code) => resolve(code === 0));
    });
}

const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
};

function staffDetector(chats) {
    const senderParties = new Map();
    for (const chat of chats) {
        for (const message of chat.messages ?? []) {
            if (message.isNote || !message.sender) continue;
            if (!senderParties.has(message.sender)) senderParties.set(message.sender, new Set());
            senderParties.get(message.sender).add(chat.partiesDescription || "");
        }
    }
    return (sender) => (senderParties.get(sender)?.size ?? 0) >= 3;
}

function readData() {
    const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
    const aiById = fs.existsSync(dataFile("enriched.json"))
        ? new Map(JSON.parse(fs.readFileSync(dataFile("enriched.json"), "utf8")).chats.filter((c) => c.ai).map((c) => [c.id, c.ai]))
        : new Map();
    const verdicts = fs.existsSync(dataFile("bug-verdicts.json")) ? JSON.parse(fs.readFileSync(dataFile("bug-verdicts.json"), "utf8")) : {};
    const manualTypes = fs.existsSync(TYPES_FILE) ? JSON.parse(fs.readFileSync(TYPES_FILE, "utf8")).types ?? {} : {};
    const actionStore = readTicketActions();
    const latestAction = new Map();
    for (const event of actionStore.events) {
        if (!event.ticketId || !event.at) continue;
        const current = latestAction.get(event.ticketId);
        if (!current || new Date(event.at) > new Date(current.at)) latestAction.set(event.ticketId, event);
    }

    // Staff detection: a sender who appears across many DIFFERENT customer companies
    // is a Tidy rep. Counting distinct chats fails for prolific customers (all their
    // tickets share one company); counting distinct parties does not.
    const isStaff = staffDetector(inbox.chats);

    const presentAi = (ai) => {
        if (!ai) return null;
        const unavailable = ai.unavailableReason === "summarization" || ai.headline === "(error)" || /^Summarization failed:/i.test(ai.summary || "");
        return unavailable
            ? {
                  ...ai,
                  headline: "Summary unavailable",
                  summary: "AI summarization is unavailable. Configure or sign in to an AI provider, then run Summarize again.",
                  unavailable: true,
              }
            : ai;
    };

    const chats = inbox.chats.map((c) => {
        const messages = c.messages ?? [];
        const latestMessage = messages.filter((m) => !m.isNote).at(-1);
        const firstMessage = messages.find((m) => !m.isNote && !isStaff(m.sender)) ?? messages.find((m) => !m.isNote);
        const appAction = latestAction.get(c.id) ?? null;
        const crmLast = c.mostRecentMessageDate ?? null;
        const actionIsLatest = appAction && (!crmLast || new Date(appAction.at) > new Date(crmLast));
        return {
        id: c.id,
        code: c.code ?? null,
        title: c.title,
        parties: c.partiesDescription,
        opened: c.createdDate,
        last: crmLast,
        actionLast: appAction?.at ?? null,
        activityLast: actionIsLatest ? appAction.at : crmLast,
        activitySource: actionIsLatest ? "app" : "crm",
        latestAction: appAction,
        // Also apply the sender gate to already-synced data. This removes old
        // false positives immediately; the next Sync also re-evaluates the
        // customer-reader condition in lib/map.mjs.
        leftOnRead: Boolean(c.leftOnRead && latestMessage && isKnownTidyStaff(latestMessage.sender)),
        status: c.deleted ? "deleted" : c.closedDate ? "closed" : "open",
        msgs: c.messages?.length ?? 0,
        url: c.url,
        ai: presentAi(aiById.get(c.id)),
        manualType: manualTypes[c.id] ?? null,
        bugVerdict: verdicts[c.id]?.verdict ?? null,
        bugReason: verdicts[c.id]?.reason ?? null,
        opening: firstMessage
            ? { sender: firstMessage.sender, date: firstMessage.date, text: (firstMessage.text || "").slice(0, 900), staff: isStaff(firstMessage.sender) }
            : null,
        // recent messages; staff tagged server-side (see isStaff above)
        tail: messages.filter((m) => !m.isNote).slice(-8).map((m) => ({ sender: m.sender, date: m.date, text: (m.text || "").slice(0, 900), staff: isStaff(m.sender) })),
        conversationSearch: messages
            .map((message) => `${message.sender || ""} ${message.text || ""}`)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
    };
    });
    const ai = summarizationStatus();
    const crm = crmTokenStatus();
    const decisions = Object.fromEntries(Object.entries(actionStore.decisions).filter(([, value]) => value === "close" || value === "keep"));
    return { syncedAt: inbox.syncedAt ?? inbox.fetchedAt ?? null, hasToken: hasToken(), crmAvailable: crm.available, crmState: crm.state, crmVerifiedAt: crm.verifiedAt, crmReason: crm.reason, aiAvailable: ai.available, aiSource: ai.source, decisions, chats };
}

function readManualTypes() {
    return fs.existsSync(TYPES_FILE) ? JSON.parse(fs.readFileSync(TYPES_FILE, "utf8")).types ?? {} : {};
}

function writeManualTypes(types) {
    backupFile(TYPES_FILE);
    fs.mkdirSync(path.dirname(TYPES_FILE), { recursive: true });
    fs.writeFileSync(TYPES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), types }, null, 2));
}

function readTicketActions() {
    if (!fs.existsSync(ACTIONS_FILE)) return { decisions: {}, events: [] };
    const data = JSON.parse(fs.readFileSync(ACTIONS_FILE, "utf8"));
    return { decisions: data.decisions ?? {}, events: Array.isArray(data.events) ? data.events : [] };
}

function writeTicketActions(store) {
    backupFile(ACTIONS_FILE);
    fs.mkdirSync(path.dirname(ACTIONS_FILE), { recursive: true });
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), decisions: store.decisions, events: store.events }, null, 2));
}

function auditEvent({ ticketId, action, by, from = null, to = null, success = true, detail = "" }) {
    return { id: randomUUID(), ticketId, at: new Date().toISOString(), by: String(by || "Staff").trim() || "Staff", action, from, to, success, detail: String(detail || "").slice(0, 1000) };
}

function readProposals() {
    if (!fs.existsSync(PROPOSALS_FILE)) return { proposals: [] };
    const data = JSON.parse(fs.readFileSync(PROPOSALS_FILE, "utf8"));
    return { proposals: Array.isArray(data.proposals) ? data.proposals : [] };
}

function readReleaseFollowups() {
    if (!fs.existsSync(RELEASE_FOLLOWUPS_FILE)) return { followups: [] };
    const data = JSON.parse(fs.readFileSync(RELEASE_FOLLOWUPS_FILE, "utf8"));
    return { followups: Array.isArray(data.followups) ? data.followups : [] };
}

function writeReleaseFollowups(followups) {
    backupFile(RELEASE_FOLLOWUPS_FILE);
    fs.mkdirSync(path.dirname(RELEASE_FOLLOWUPS_FILE), { recursive: true });
    fs.writeFileSync(RELEASE_FOLLOWUPS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), followups }, null, 2));
}

function writeProposals(proposals) {
    backupFile(PROPOSALS_FILE);
    fs.mkdirSync(path.dirname(PROPOSALS_FILE), { recursive: true });
    fs.writeFileSync(PROPOSALS_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), proposals }, null, 2));
}

function proposalSources(ids) {
    const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
    const wanted = new Set(ids);
    return inbox.chats.filter((chat) => wanted.has(chat.id));
}

function proposalPrompt(chats) {
    const sources = chats.map((chat) => ({
        id: chat.id,
        title: chat.title,
        client: chat.partiesDescription,
        opened: chat.createdDate,
        lastActivity: chat.mostRecentMessageDate,
        messages: (() => {
            const messages = (chat.messages ?? []).filter((message) => !message.isNote);
            const shown = messages.length <= 14 ? messages : [...messages.slice(0, 2), ...messages.slice(-12)];
            return shown.map((message) => ({ sender: message.sender, date: message.date, text: (message.text || "").slice(0, 1200) }));
        })(),
    }));
    const today = new Date().toISOString().slice(0, 10);
    return `You are helping a small software company turn customer feature requests into a concise proposal for management approval. Combine supplied tickets only when they describe the same underlying need. Stay factual, cite client evidence, and never invent names, revenue, sentiment, integrations, or requirements. Every proposal requires an indicative development estimate. Estimate conservatively from the requested scope, state uncertainty, and treat dates as planning guidance rather than commitments. Today is ${today}. Return ONLY JSON with these string fields: title, eli5Summary, customerPerspective, executiveSummary, problem, impact, scope, risks, questions, priority, estimatedDevEffort, estimatedStartDate, estimatedCompletionDate, estimateAssumptions; and an evidence array of short strings. "eli5Summary" must explain the request in 1–2 very simple, jargon-free sentences from the customer's perspective, using the customer's name and company when explicitly supplied. "customerPerspective" must explain the issue from the customer's point of view in 1–3 sentences, naming the person and company only when the ticket explicitly supplies them—for example, "Rosalind from Rozcraft wants... because..." Otherwise say "The customer at [company]...". "executiveSummary" must be a detailed 3–5 sentence management statement covering the problem, proposed high-level delivery, expected benefit, and key boundary or uncertainty. Dates must use YYYY-MM-DD. "scope" must begin with one high-level sentence describing what to deliver, followed by a useful first version and explicit non-goals. "priority" should recommend low, medium, or high with a brief reason. "estimatedDevEffort" must be a conservative developer-day range for one developer. Dates should assume approval and developer capacity are available, and estimateAssumptions must make that assumption and important technical unknowns explicit.\n\nSource tickets:\n${JSON.stringify(sources)}`;
}

function cleanProposalDraft(value, sourceChatIds, aiSource = null) {
    const text = (input) => {
        if (input == null) return "";
        if (Array.isArray(input)) return input.map(text).filter(Boolean).join("; ");
        if (typeof input === "object") return Object.entries(input).map(([key, item]) => `${key.replace(/([A-Z])/g, " $1")}: ${text(item)}`).filter((item) => !item.endsWith(": ")).join("\n");
        return String(input).trim();
    };
    const string = (key) => text(value?.[key]);
    return {
        title: string("title"), eli5Summary: string("eli5Summary"), customerPerspective: string("customerPerspective"), executiveSummary: string("executiveSummary"), problem: string("problem"), impact: string("impact"),
        scope: string("scope"), risks: string("risks"), questions: string("questions"), priority: string("priority"),
        estimatedDevEffort: string("estimatedDevEffort"), estimatedStartDate: string("estimatedStartDate"),
        estimatedCompletionDate: string("estimatedCompletionDate"), estimateAssumptions: string("estimateAssumptions"),
        evidence: Array.isArray(value?.evidence) ? value.evidence.map(text).filter(Boolean).slice(0, 20) : [],
        sourceChatIds: [...new Set(sourceChatIds)], aiSource,
    };
}

function runScript(name, args = []) {
    return new Promise((resolve) => {
        const env = { ...process.env, ...(currentToken ? { TIDY_TOKEN: currentToken } : {}) };
        const proc = spawn("node", [`${name}.mjs`, ...args], { cwd: here, env });
        let out = "";
        proc.stdout.on("data", (d) => (out += d));
        proc.stderr.on("data", (d) => (out += d)); // scripts log progress to stderr
        proc.on("close", (code) => resolve({ ok: code === 0, code, output: out }));
        proc.on("error", (err) => resolve({ ok: false, code: -1, output: err.message }));
    });
}

const body = (req) =>
    new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => resolve(b ? JSON.parse(b) : {}));
    });

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://localhost:${PORT}`);

        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end(PAGE);
        }
        if (req.method === "GET" && url.pathname === "/api/data") {
            return json(res, 200, readData());
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/chat/")) {
            const id = decodeURIComponent(url.pathname.slice("/api/chat/".length));
            const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
            const chat = inbox.chats.find((item) => item.id === id);
            if (!chat) return json(res, 404, { error: "Ticket not found." });
            const isStaff = staffDetector(inbox.chats);
            return json(res, 200, {
                id: chat.id, title: chat.title, parties: chat.partiesDescription, url: chat.url,
                messages: (chat.messages ?? []).map((message) => ({
                    sender: message.sender, date: message.date, text: (message.text || "").slice(0, 5000),
                    staff: message.isNote || isStaff(message.sender), note: Boolean(message.isNote),
                })),
            });
        }
        if (req.method === "GET" && url.pathname === "/api/kb") {
            const kb = fs.existsSync(dataFile("knowledge.json")) ? JSON.parse(fs.readFileSync(dataFile("knowledge.json"), "utf8")) : { entries: [] };
            return json(res, 200, kb);
        }
        if (req.method === "GET" && url.pathname === "/api/proposals") {
            return json(res, 200, readProposals());
        }
        if (req.method === "GET" && url.pathname === "/api/release-followups") {
            return json(res, 200, readReleaseFollowups());
        }
        if (req.method === "GET" && url.pathname === "/api/audit") {
            const store = readTicketActions();
            return json(res, 200, { events: [...store.events].sort((a, b) => new Date(b.at) - new Date(a.at)) });
        }
        if (req.method === "POST" && url.pathname === "/api/release-followups/save") {
            const { followup, by } = await body(req);
            const prNumber = String(followup?.prNumber || "").replace(/^#/, "").trim();
            const releaseName = String(followup?.releaseName || "").trim();
            const ticketIds = [...new Set(Array.isArray(followup?.ticketIds) ? followup.ticketIds.map(String) : [])];
            if (!releaseName) return json(res, 400, { error: "Enter a release name or version." });
            if (!/^\d+$/.test(prNumber)) return json(res, 400, { error: "Enter a numeric PR number." });
            if (!ticketIds.length) return json(res, 400, { error: "Select at least one ticket that needs a response." });
            if (followup?.releasedAt && !/^\d{4}-\d{2}-\d{2}$/.test(followup.releasedAt)) return json(res, 400, { error: "Enter a valid release date." });
            if (followup?.prUrl && !/^https?:\/\//i.test(followup.prUrl)) return json(res, 400, { error: "The PR link must start with http:// or https://." });
            const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
            const known = new Set(inbox.chats.map((chat) => chat.id));
            if (ticketIds.some((id) => !known.has(id))) return json(res, 400, { error: "One or more selected tickets are no longer available." });
            const store = readReleaseFollowups();
            const index = followup.id ? store.followups.findIndex((item) => item.id === followup.id) : -1;
            if (index < 0 && store.followups.some((item) => item.prNumber === prNumber)) return json(res, 400, { error: `PR #${prNumber} already has a follow-up mapping. Edit the existing mapping instead.` });
            const existing = index >= 0 ? store.followups[index] : null;
            const conflicting = store.followups.find((item) => item.id !== existing?.id && (item.tickets || []).some((ticket) => ticketIds.includes(ticket.ticketId)));
            if (conflicting) return json(res, 400, { error: `One or more selected tickets already belong to PR #${conflicting.prNumber}. Remove them from that PR first.` });
            const now = new Date().toISOString();
            const oldTickets = new Map((existing?.tickets || []).map((ticket) => [ticket.ticketId, ticket]));
            const saved = {
                id: existing?.id || randomUUID(),
                releaseName,
                releaseBuild: String(followup.releaseBuild || "").trim(),
                prNumber,
                prTitle: String(followup.prTitle || "").trim(),
                prUrl: String(followup.prUrl || "").trim(),
                releasedAt: String(followup.releasedAt || "").trim() || now.slice(0, 10),
                notes: String(followup.notes || "").trim(),
                tickets: ticketIds.map((ticketId) => oldTickets.get(ticketId) || { ticketId, status: "needs_response", mappedAt: now, mappedBy: String(by || "Staff").trim() || "Staff" }),
                closedAt: existing?.closedAt || null,
                closedBy: existing?.closedBy || null,
                createdAt: existing?.createdAt || now,
                createdBy: existing?.createdBy || String(by || "Staff").trim() || "Staff",
                updatedAt: now,
            };
            if (index >= 0) store.followups[index] = saved; else store.followups.unshift(saved);
            writeReleaseFollowups(store.followups);
            const actions = readTicketActions();
            for (const ticketId of ticketIds) if (!oldTickets.has(ticketId)) actions.events.push(auditEvent({ ticketId, action: "release_pr_mapped", by, to: `PR #${prNumber}`, detail: `Mapped to ${releaseName}, PR #${prNumber}${saved.prTitle ? ` — ${saved.prTitle}` : ""}; customer response required.` }));
            for (const ticketId of oldTickets.keys()) if (!ticketIds.includes(ticketId)) actions.events.push(auditEvent({ ticketId, action: "release_pr_unmapped", by, from: `PR #${prNumber}`, detail: `Removed from PR #${prNumber} release follow-up.` }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true, followup: saved });
        }
        if (req.method === "POST" && url.pathname === "/api/release-followups/close-release") {
            const { releaseName, by } = await body(req);
            const name = String(releaseName || "").trim();
            const store = readReleaseFollowups();
            const followups = store.followups.filter((item) => (item.releaseName || "Uncategorised") === name);
            if (!name || !followups.length) return json(res, 404, { ok: false, error: "Release not found." });
            const crm = crmTokenStatus();
            if (!hasToken() || !crm.available) return json(res, 400, { ok: false, authFailed: true, error: crm.reason || "No CRM authentication is configured." });
            const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
            const chats = new Map((inbox.chats || []).map((chat) => [chat.id, chat]));
            const ticketIds = [...new Set(followups.flatMap((item) => (item.tickets || []).map((ticket) => ticket.ticketId)))];
            const results = ticketIds.filter((id) => chats.get(id)?.status !== "closed").length ? [] : ticketIds.map((id) => ({ id, ok: true, alreadyClosed: true }));
            if (!results.length) await mapLimit(ticketIds, 4, async (id) => {
                if (chats.get(id)?.status === "closed") return results.push({ id, ok: true, alreadyClosed: true });
                try { await closeChat(id); results.push({ id, ok: true }); }
                catch (err) { results.push({ id, ok: false, error: err.message }); }
            });
            const authFailed = results.some((result) => !result.ok && /401|unauthori[sz]ed|token.{0,20}expired/i.test(result.error || ""));
            if (authFailed) tokenRejected = true;
            const actions = readTicketActions();
            for (const result of results) if (!result.alreadyClosed) actions.events.push(auditEvent({ ticketId: result.id, action: result.ok ? "crm_closed" : "crm_close_failed", by, success: result.ok, to: result.ok ? "closed" : null, detail: result.ok ? `Closed with release ${name}.` : result.error }));
            const failed = results.filter((result) => !result.ok);
            if (failed.length) {
                actions.events.push(auditEvent({ action: "release_close_failed", by, success: false, detail: `${name}: ${failed.length} of ${ticketIds.length} ticket closures failed.` }));
                writeTicketActions(actions);
                return json(res, 200, { ok: false, authFailed, error: `Could not close ${failed.length} ticket${failed.length === 1 ? "" : "s"}. The release remains open.`, results });
            }
            const now = new Date().toISOString();
            for (const item of followups) { item.closedAt = now; item.closedBy = String(by || "Staff").trim() || "Staff"; item.updatedAt = now; }
            writeReleaseFollowups(store.followups);
            actions.events.push(auditEvent({ action: "release_closed", by, to: "closed", detail: `${name} completed; ${ticketIds.length} mapped ticket${ticketIds.length === 1 ? "" : "s"} closed or already closed.` }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true, releaseName: name, closedAt: now, results });
        }
        if (req.method === "POST" && url.pathname === "/api/release-followups/ticket") {
            const { followupId, ticketId, status, by } = await body(req);
            if (!new Set(["needs_response", "responded"]).has(status)) return json(res, 400, { error: "Invalid follow-up status." });
            const store = readReleaseFollowups();
            const followup = store.followups.find((item) => item.id === followupId);
            const ticket = followup?.tickets?.find((item) => item.ticketId === ticketId);
            if (!followup || !ticket) return json(res, 404, { error: "Release follow-up ticket not found." });
            const previous = ticket.status;
            ticket.status = status;
            ticket.respondedAt = status === "responded" ? new Date().toISOString() : null;
            ticket.respondedBy = status === "responded" ? String(by || "Staff").trim() || "Staff" : null;
            followup.updatedAt = new Date().toISOString();
            writeReleaseFollowups(store.followups);
            const actions = readTicketActions();
            actions.events.push(auditEvent({ ticketId, action: status === "responded" ? "release_customer_responded" : "release_response_reopened", by, from: previous, to: status, detail: `PR #${followup.prNumber} release follow-up.` }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true, followup });
        }
        if (req.method === "POST" && url.pathname === "/api/release-followups/delete") {
            const { id, by } = await body(req);
            const store = readReleaseFollowups();
            const index = store.followups.findIndex((item) => item.id === id);
            if (index < 0) return json(res, 404, { error: "Release follow-up not found." });
            const [removed] = store.followups.splice(index, 1);
            writeReleaseFollowups(store.followups);
            const actions = readTicketActions();
            for (const ticket of removed.tickets || []) actions.events.push(auditEvent({ ticketId: ticket.ticketId, action: "release_pr_unmapped", by, from: `PR #${removed.prNumber}`, detail: `Deleted PR #${removed.prNumber} release follow-up.` }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/proposals/draft") {
            const { ids } = await body(req);
            if (!Array.isArray(ids) || !ids.length) return json(res, 400, { error: "Select at least one feature ticket." });
            const chats = proposalSources(ids.slice(0, 20));
            if (!chats.length) return json(res, 404, { error: "The selected tickets could not be found." });
            try {
                const result = await runAiJson(proposalPrompt(chats));
                return json(res, 200, { ok: true, proposal: cleanProposalDraft(result.value, chats.map((chat) => chat.id), result.source) });
            } catch (err) {
                return json(res, 200, { ok: false, error: err.message });
            }
        }
        if (req.method === "POST" && url.pathname === "/api/proposals/save") {
            const { proposal } = await body(req);
            if (!proposal || !String(proposal.title || "").trim()) return json(res, 400, { error: "A proposal title is required." });
            const store = readProposals();
            const existingIndex = proposal.id ? store.proposals.findIndex((item) => item.id === proposal.id) : -1;
            const existing = existingIndex >= 0 ? store.proposals[existingIndex] : null;
            const now = new Date().toISOString();
            const allowed = new Set(["draft", "ready", "changes_requested", "approved", "declined", "planned", "completed"]);
            const status = allowed.has(proposal.status) ? proposal.status : existing?.status || "draft";
            const author = String(proposal.author || existing?.author || "Staff").trim() || "Staff";
            const cleaned = cleanProposalDraft(proposal, proposal.sourceChatIds || existing?.sourceChatIds || [], proposal.aiSource || existing?.aiSource || null);
            if (status === "ready" && (!cleaned.eli5Summary || !cleaned.customerPerspective || !cleaned.estimatedDevEffort || !cleaned.estimatedStartDate || !cleaned.estimatedCompletionDate || !cleaned.estimateAssumptions)) {
                return json(res, 400, { error: "Boss-ready proposals require a simple summary, customer perspective, development effort, dates, and estimate assumptions." });
            }
            const history = [...(existing?.history || [])];
            if (!existing) history.push({ at: now, by: author, action: "created", status });
            else if (existing.status !== status) history.push({ at: now, by: author, action: "status changed", status });
            const saved = { ...cleaned, id: existing?.id || randomUUID(), status, author, createdAt: existing?.createdAt || now, updatedAt: now, history };
            if (existingIndex >= 0) store.proposals[existingIndex] = saved; else store.proposals.unshift(saved);
            writeProposals(store.proposals);
            return json(res, 200, { ok: true, proposal: saved });
        }
        if (req.method === "POST" && url.pathname === "/api/proposals/decision") {
            const { id, status, by, comment } = await body(req);
            const allowed = new Set(["draft", "approved", "changes_requested", "declined", "planned", "completed"]);
            if (!allowed.has(status)) return json(res, 400, { error: "Invalid proposal decision." });
            const store = readProposals();
            const proposal = store.proposals.find((item) => item.id === id);
            if (!proposal) return json(res, 404, { error: "Proposal not found." });
            if (status === "completed" && proposal.status !== "approved") return json(res, 400, { error: "Only an approved proposal can be marked completed." });
            const now = new Date().toISOString();
            const actor = String(by || "Boss").trim() || "Boss";
            const previous = proposal.status;
            const nextStatus = status;
            proposal.status = nextStatus; proposal.updatedAt = now;
            proposal.history = [...(proposal.history || []), { at: now, by: actor, action: "decision", status: nextStatus, outcome: status, comment: String(comment || "").trim() }];
            writeProposals(store.proposals);
            const actions = readTicketActions();
            const detail = status === "draft" ? "Proposal sent back to Draft for editing." : status === "declined" ? "Boss declined proposal; source ticket left open for a separate close decision." : `Proposal ${status}.`;
            for (const ticketId of proposal.sourceChatIds || []) actions.events.push(auditEvent({ ticketId, action: "proposal_status_changed", by: actor, from: previous, to: nextStatus, detail }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true, proposal });
        }
        if (req.method === "POST" && url.pathname === "/api/proposals/delete") {
            const { id, by } = await body(req);
            const store = readProposals();
            const index = store.proposals.findIndex((item) => item.id === id);
            if (index < 0) return json(res, 404, { error: "Proposal not found." });
            const [proposal] = store.proposals.splice(index, 1);
            writeProposals(store.proposals);
            const actions = readTicketActions();
            for (const ticketId of proposal.sourceChatIds || []) actions.events.push(auditEvent({ ticketId, action: "proposal_deleted", by, from: proposal.status, detail: `Deleted proposal: ${proposal.title}. Ticket returned to Feature requests.` }));
            writeTicketActions(actions);
            return json(res, 200, { ok: true, sourceChatIds: proposal.sourceChatIds || [] });
        }
        if (req.method === "GET" && url.pathname === "/api/report") {
            if (!fs.existsSync(REPORT_FILE)) return json(res, 404, { error: "No Excel export yet." });
            res.writeHead(200, {
                "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "content-disposition": 'attachment; filename="inbox-report.xlsx"',
            });
            return fs.createReadStream(REPORT_FILE).pipe(res);
        }
        if (req.method === "GET" && url.pathname === "/api/boss-review-markdown") {
            if (!fs.existsSync(BOSS_REVIEW_MARKDOWN)) return json(res, 404, { error: "No Markdown export yet." });
            res.writeHead(200, {
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": 'attachment; filename="boss-review-proposals.md"',
            });
            return fs.createReadStream(BOSS_REVIEW_MARKDOWN).pipe(res);
        }
        if (req.method === "POST" && url.pathname === "/api/type") {
            const { id, type, by } = await body(req);
            const allowed = new Set(["bug", "feature", "not sure"]);
            if (!id || (type !== null && !allowed.has(type))) return json(res, 400, { error: "Invalid ticket type." });
            const types = readManualTypes();
            const previous = types[id] ?? null;
            if (type === null) delete types[id]; else types[id] = type;
            writeManualTypes(types);
            const actions = readTicketActions();
            const event = auditEvent({ ticketId: id, action: type === null ? "manual_type_cleared" : "manual_type_changed", by, from: previous, to: type });
            actions.events.push(event);
            writeTicketActions(actions);
            return json(res, 200, { ok: true, type: type ?? null, event });
        }
        if (req.method === "POST" && url.pathname === "/api/decision") {
            const { id, decision, by } = await body(req);
            const allowed = new Set(["close", "keep", null]);
            if (!id || !allowed.has(decision)) return json(res, 400, { error: "Invalid ticket status." });
            const actions = readTicketActions();
            const previous = actions.decisions[id] ?? null;
            if (decision === null) delete actions.decisions[id]; else actions.decisions[id] = decision;
            const event = auditEvent({ ticketId: id, action: decision === null ? "status_cleared" : "status_changed", by, from: previous, to: decision });
            actions.events.push(event);
            writeTicketActions(actions);
            return json(res, 200, { ok: true, decision, event });
        }
        if (req.method === "POST" && url.pathname === "/api/token") {
            const { token, refreshToken } = await body(req);
            currentToken = (token ?? "").trim() || undefined;
            tokenRejected = false;
            tokenVerifiedAt = null;
            const ok = refreshToken !== undefined ? setRefreshToken(refreshToken) : setToken(currentToken);
            const crm = ok ? await checkCrmToken() : crmTokenStatus();
            return json(res, 200, { ok: ok && crm.state === "verified", hasToken: ok, ...crm });
        }
        if (req.method === "POST" && url.pathname === "/api/token/check") {
            return json(res, 200, await checkCrmToken());
        }
        if (req.method === "POST" && url.pathname === "/api/close") {
            const { ids, by } = await body(req);
            if (!Array.isArray(ids) || ids.length === 0) return json(res, 400, { error: "no ids" });
            const crm = crmTokenStatus();
            if (!hasToken() || !crm.available) {
                const error = crm.reason || "No CRM authentication set — paste a refresh token via the ⚿ Token button.";
                const actions = readTicketActions();
                for (const id of ids) actions.events.push(auditEvent({ ticketId: id, action: "crm_close_failed", by, success: false, detail: error }));
                writeTicketActions(actions);
                return json(res, 400, { error });
            }
            const results = [];
            await mapLimit(ids, 4, async (id) => {
                try {
                    await closeChat(id);
                    results.push({ id, ok: true });
                } catch (err) {
                    results.push({ id, ok: false, error: err.message });
                }
            });
            const actions = readTicketActions();
            for (const result of results) {
                actions.events.push(auditEvent({ ticketId: result.id, action: result.ok ? "crm_closed" : "crm_close_failed", by, success: result.ok, to: result.ok ? "closed" : null, detail: result.error || "Closed through POST /v1/chats/{id}/close" }));
                if (result.ok) delete actions.decisions[result.id];
            }
            const authFailed = results.some((result) => !result.ok && /401|unauthori[sz]ed|token.{0,20}expired/i.test(result.error || ""));
            if (authFailed) tokenRejected = true;
            writeTicketActions(actions);
            return json(res, 200, { results, authFailed });
        }
        if (req.method === "POST" && url.pathname === "/api/reopen") {
            const { ids, by } = await body(req);
            if (!Array.isArray(ids) || ids.length === 0) return json(res, 400, { error: "no ids" });
            const crm = crmTokenStatus();
            if (!hasToken() || !crm.available) {
                const error = crm.reason || "No CRM authentication set — paste a refresh token via the ⚿ Token button.";
                const actions = readTicketActions();
                for (const id of ids) actions.events.push(auditEvent({ ticketId: id, action: "crm_reopen_failed", by, success: false, detail: error }));
                writeTicketActions(actions);
                return json(res, 400, { error });
            }
            const results = [];
            await mapLimit(ids, 4, async (id) => {
                try {
                    await reopenChat(id);
                    results.push({ id, ok: true });
                } catch (err) {
                    results.push({ id, ok: false, error: err.message });
                }
            });
            const actions = readTicketActions();
            for (const result of results) {
                actions.events.push(auditEvent({ ticketId: result.id, action: result.ok ? "crm_reopened" : "crm_reopen_failed", by, success: result.ok, to: result.ok ? "open" : null, detail: result.error || "Reopened through POST /v1/chats/{id}/reopen" }));
                if (result.ok) delete actions.decisions[result.id];
            }
            const authFailed = results.some((result) => !result.ok && /401|unauthori[sz]ed|token.{0,20}expired/i.test(result.error || ""));
            if (authFailed) tokenRejected = true;
            writeTicketActions(actions);
            return json(res, 200, { results, authFailed });
        }
        if (req.method === "POST" && url.pathname === "/api/export-excel") {
            const { by } = await body(req);
            const result = await runScript("report");
            if (!result.ok) {
                const actions = readTicketActions(); actions.events.push(auditEvent({ action: "excel_export_failed", by, success: false, detail: result.output })); writeTicketActions(actions);
                return json(res, 200, result);
            }
            const opened = fs.existsSync(REPORT_FILE) && (await openLocalFile(REPORT_FILE));
            const actions = readTicketActions(); actions.events.push(auditEvent({ action: "excel_exported", by, detail: opened ? "Workbook rebuilt and opened." : "Workbook rebuilt; automatic open was unavailable." })); writeTicketActions(actions);
            return json(res, 200, { ...result, opened });
        }
        if (req.method === "POST" && url.pathname === "/api/export-boss-review-markdown") {
            const { by } = await body(req);
            const result = await runScript("export-boss-review-markdown");
            if (!result.ok) {
                const actions = readTicketActions(); actions.events.push(auditEvent({ action: "boss_review_markdown_export_failed", by, success: false, detail: result.output })); writeTicketActions(actions);
                return json(res, 200, result);
            }
            const opened = fs.existsSync(BOSS_REVIEW_MARKDOWN) && (await openLocalFile(BOSS_REVIEW_MARKDOWN));
            const actions = readTicketActions(); actions.events.push(auditEvent({ action: "boss_review_markdown_exported", by, detail: opened ? "Boss review Markdown exported and opened." : "Boss review Markdown exported; automatic open was unavailable." })); writeTicketActions(actions);
            return json(res, 200, { ...result, opened, download: "/api/boss-review-markdown" });
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
            const name = url.pathname.slice("/api/run/".length);
            if (!RUNNABLE.has(name)) return json(res, 400, { error: `unknown script: ${name}` });
            const { by } = await body(req);
            if (name === "sync") {
                const crm = crmTokenStatus();
                if (!crm.available) return json(res, 400, { ok: false, error: crm.reason, authFailed: true });
            }
            const result = await runScript(name);
            if (name === "sync" && result.ok) {
                tokenRejected = false;
                tokenVerifiedAt = new Date().toISOString();
            }
            if (name === "sync" && !result.ok && /401|unauthori[sz]ed|token.{0,20}expired/i.test(result.output || "")) {
                tokenRejected = true;
                result.authFailed = true;
            }
            if (name === "summarize" && result.ok) {
                result.manualTypesCleared = true;
            }
            const actions = readTicketActions();
            actions.events.push(auditEvent({ action: `${name}_${result.ok ? "completed" : "failed"}`, by, success: result.ok, detail: result.ok ? "" : result.output }));
            writeTicketActions(actions);
            return json(res, 200, result);
        }
        res.writeHead(404).end("not found");
    } catch (err) {
        json(res, 500, { error: err.message });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.error(`Tidy inbox app running at http://localhost:${PORT}`);
    if (!hasToken()) console.error("(No CRM authentication set — viewing works; paste a refresh token via the ⚿ Token button to enable Sync/Close.)");
});

const PAGE = /* html */ `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Tidy Inbox</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@5" rel="stylesheet" type="text/css" />
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<style>
  /* single-lane chat bubbles (user preference): both sides left-aligned, distinguished by colour */
  .bubble{max-width:92%;border-radius:14px;border-top-left-radius:4px;white-space:pre-wrap;padding:8px 12px;font-size:13px;border-left-width:3px}
  .b-staff{background:#eef4ff;border:1px solid #cfe0f5;border-left-color:#4a80c0}
  .b-cust{background:#faf8f3;border:1px solid #eee7d9;border-left-color:#cbbfa4}
  .b-staff .who{color:#3f6fa8} .b-cust .who{color:#a1926f}
  .context-preview{min-width:260px;text-align:left;border-radius:8px;padding:4px 6px;margin:-4px -6px;cursor:pointer}
  .context-preview:hover{background:#f1f5f9}.context-preview:focus{outline:2px solid #93c5fd}
  .conversation-note{background:#fff8d6;border:1px solid #f2d675;border-left:4px solid #d9a500}
  .btn-success:disabled{background:#15803d!important;border-color:#15803d!important;color:#fff!important;opacity:.6!important}
  .ticket-type-picker[open]>.dropdown-content{position:fixed!important;z-index:1000!important}
  #log{white-space:pre-wrap}
</style></head>
<body class="bg-base-200 min-h-screen">
<div class="navbar bg-neutral text-neutral-content px-4 gap-2 sticky top-0 z-30 min-h-0 py-2 flex-wrap">
  <span class="font-semibold text-base mr-3">Tidy Inbox</span>
  <button id="syncButton" class="btn btn-sm btn-success px-5 font-semibold" onclick="syncNow()">↻ Sync now</button>
  <div class="dropdown">
    <button tabindex="0" class="btn btn-sm bg-white text-slate-900 border-white hover:bg-slate-100">More tools ▾</button>
    <ul tabindex="0" class="dropdown-content menu bg-white text-slate-900 rounded-box z-50 w-80 p-2 shadow-2xl border border-slate-300">
      <li><button id="summarizeTool" class="items-start whitespace-normal py-3 hover:bg-slate-100" onclick="run('summarize')"><span class="text-base">✦</span><span><b class="text-slate-950">Summarize with AI</b><small id="summarizeHint" class="block text-slate-600 font-normal mt-0.5">Checking availability…</small></span></button></li>
      <li><button class="items-start whitespace-normal py-3 hover:bg-slate-100" onclick="exportExcel()"><span class="text-base">▤</span><span><b class="text-slate-950">Export to Excel</b><small class="block text-slate-600 font-normal mt-0.5">Rebuild and open inbox-report.xlsx</small></span></button></li>
      <li class="mt-1 border-t border-slate-200 pt-1"><button class="items-start whitespace-normal py-3 hover:bg-slate-100" onclick="tab('audit');document.activeElement?.blur()"><span class="text-base">◷</span><span><b class="text-slate-950">Audit history</b><small class="block text-slate-600 font-normal mt-0.5">Review staff actions and ticket timestamps</small></span></button></li>
    </ul>
  </div>
  <button id="tokenButton" class="btn btn-sm ml-auto" onclick="updateToken()" title="Check or update the CRM access token"><span id="tokdot" class="inline-block w-2 h-2 rounded-full bg-warning mr-1"></span><span id="toktext">Checking token…</span></button>
  <span class="text-xs opacity-70" id="synced"></span>
  <button class="btn btn-sm btn-ghost" onclick="hideLog()">×log</button>
</div>
<div class="flex items-end gap-3 bg-base-100 px-4 pt-2 sticky top-12 z-20 overflow-x-auto">
  <div role="tablist" class="tabs tabs-boxed shrink-0">
    <a role="tab" class="tab tab-active" data-tab="dashboard" onclick="tab('dashboard')">Dashboard</a>
    <a role="tab" class="tab" data-tab="outstanding" onclick="tab('outstanding')">Outstanding</a>
    <a role="tab" class="tab" data-tab="inbox" onclick="tab('inbox')">Inbox</a>
    <a role="tab" class="tab" data-tab="releases" onclick="tab('releases')">Release follow-up</a>
  </div>
  <div role="tablist" class="tabs tabs-boxed shrink-0 ml-auto">
    <a role="tab" class="tab" data-tab="proposals" onclick="tab('proposals')">Proposals</a>
    <a role="tab" class="tab" data-tab="kb" onclick="tab('kb')">Knowledge</a>
  </div>
</div>
<div class="p-4 pb-24" id="view"></div>
<div id="logpanel" class="hidden fixed right-3 bottom-16 w-[420px] max-w-[calc(100vw-1.5rem)] bg-neutral rounded-lg shadow-xl z-40 overflow-hidden border border-white/15">
  <div class="flex items-center px-3 py-1.5 border-b border-white/15 text-neutral-content">
    <span class="text-xs font-semibold opacity-70">Terminal output</span>
    <button class="btn btn-ghost btn-xs ml-auto text-neutral-content" onclick="hideLog()" aria-label="Hide terminal output">✕ Hide</button>
  </div>
  <pre id="log" class="max-h-[40vh] overflow-auto text-lime-300 text-xs p-3 font-mono"></pre>
</div>
<dialog id="conversationModal" class="modal">
  <div class="modal-box max-w-4xl h-[82vh] p-0 overflow-hidden flex flex-col">
    <div class="flex items-start gap-3 p-4 border-b bg-base-100 z-10">
      <div class="flex-1"><h3 id="conversationTitle" class="font-bold text-lg">Conversation</h3><div id="conversationMeta" class="text-xs opacity-55"></div></div>
      <div id="conversationType"></div>
      <a id="conversationReply" class="btn btn-sm btn-primary" target="_blank">Reply in CRM ↗</a>
      <form method="dialog"><button class="btn btn-sm btn-ghost" aria-label="Close conversation">✕</button></form>
    </div>
    <div id="conversationContent" class="p-4 overflow-y-auto flex-1 bg-base-200"></div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>close</button></form>
</dialog>
<dialog id="undoCloseModal" class="modal">
  <div class="modal-box w-[96vw] max-w-[96vw] p-0 overflow-hidden">
    <div class="flex items-center gap-3 p-4 border-b"><div><h3 class="font-bold text-lg">Undo Close marks</h3><p class="text-sm opacity-60">Choose which tickets should no longer be marked Close.</p></div><form method="dialog" class="ml-auto"><button class="btn btn-sm btn-ghost" aria-label="Cancel">✕</button></form></div>
    <div class="flex items-center gap-2 px-4 py-2 border-b bg-base-200"><label class="flex items-center gap-2 cursor-pointer"><input id="undoCloseAll" type="checkbox" class="checkbox checkbox-sm" onchange="toggleUndoCloseSelection(this.checked)"><span class="text-sm">Select all</span></label><span id="undoCloseCount" class="text-sm opacity-60 ml-auto">0 selected</span></div>
    <div id="undoCloseList" class="max-h-[60vh] overflow-auto"></div>
    <div class="flex justify-end gap-2 p-4 border-t"><form method="dialog"><button class="btn btn-sm">Cancel</button></form><button class="btn btn-sm btn-neutral" onclick="undoSelectedCloseMarks()">Undo selected</button></div>
  </div>
  <form method="dialog" class="modal-backdrop"><button>cancel</button></form>
</dialog>
<div id="foot" class="hidden fixed bottom-0 inset-x-0 bg-neutral text-neutral-content px-4 py-2 items-center gap-3 flex-wrap z-30"></div>
<script>
let DATA={chats:[]}, TAB='dashboard', RELEASE_FOLLOWUPS=null, EDIT_RELEASE=null;
let PROPOSALS=null, PROPVIEW='candidates', EDITING_PROPOSAL=null;
let TOKEN_CHECK_IN_FLIGHT=false,TOKEN_CHECK_TIMER=null,TOKEN_CHECK_DEADLINE=0;
const PROPSELECT=new Set();
const RSTORE='tidy-review';
let REVIEW=Object.assign({filter:'bug',mode:'cards',idx:0,decisions:{}}, JSON.parse(localStorage.getItem(RSTORE)||'{}'));
function saveReview(){ localStorage.setItem(RSTORE, JSON.stringify(REVIEW)); }
function auditActor(){
  let name=(localStorage.getItem('tidy-staff-name')||localStorage.getItem('tidy-reviewer-name')||'').trim();
  if(!name){name=(prompt('Enter your name for the audit history:')||'').trim();if(name)localStorage.setItem('tidy-staff-name',name);}
  return name||'Staff';
}
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const day=iso=>iso?String(iso).slice(0,10):'';
const ticketType=c=>c.manualType||c.ai?.classification||'';
function typePicker(c){
  const current=ticketType(c), manual=Boolean(c.manualType);
  const labels={bug:'Bug',feature:'Feature','not sure':'Not sure'};
  const colors={bug:'btn-error',feature:'btn-success','not sure':'btn-warning'};
  const label=labels[current]||'Set type', color=colors[current]||'btn-outline';
  const option=(type)=>\`<li><button type="button" class="\${current===type?'active font-semibold':''}" onclick="event.stopPropagation();setTicketType('\${c.id}','\${type}')">\${labels[type]}\${current===type?' ✓':''}</button></li>\`;
  return \`<details class="ticket-type-picker dropdown dropdown-end" onclick="event.stopPropagation()" ontoggle="positionTypeMenu(this)">
    <summary class="btn btn-xs \${color} max-w-28 whitespace-nowrap" title="\${manual?'Manually selected':'AI-selected'} type. Click to change.">\${label} ▾</summary>
    <ul class="dropdown-content menu bg-base-100 text-base-content rounded-box z-[60] w-40 border border-base-300 p-1 shadow-xl">
      \${option('bug')}\${option('feature')}\${option('not sure')}
      \${manual?\`<li class="mt-1 border-t border-base-300 pt-1"><button type="button" onclick="event.stopPropagation();setTicketType('\${c.id}',null)">Use AI type</button></li>\`:''}
    </ul>
  </details>\`;
}
function positionTypeMenu(details){
  if(!details.open)return;
  requestAnimationFrame(()=>{const summary=details.querySelector('summary'),menu=details.querySelector('.dropdown-content');if(!summary||!menu)return;const rect=summary.getBoundingClientRect(),width=160;menu.style.top=Math.min(window.innerHeight-menu.offsetHeight-8,rect.bottom+4)+'px';menu.style.left=Math.max(8,Math.min(window.innerWidth-width-8,rect.right-width))+'px';});
}
function typeBadge(c){
  const type=ticketType(c), labels={bug:'Bug',feature:'Feature','not sure':'Not sure'}, colors={bug:'badge-error',feature:'badge-success','not sure':'badge-warning'};
  return \`<span class="badge badge-sm \${colors[type]||'badge-ghost'}">\${labels[type]||'Unclassified'}</span>\`;
}
function decisionPicker(c){
  const current=REVIEW.decisions[c.id]||'';
  const button=(value,label,selected)=>{const active=current===value;return \`<button type="button" class="btn btn-xs join-item \${active?selected+' disabled:opacity-100':'btn-outline'}" \${active?'disabled aria-disabled="true"':\`onclick="event.stopPropagation();setDecide('\${c.id}','\${value}')"\`} title="\${active?label+' is selected. Choose the other status to change it.':'Set status to '+label}">\${label}</button>\`;};
  return \`<div class="join whitespace-nowrap" aria-label="Triage ticket">\${button('close','Close','btn-error')}\${button('keep','Keep','btn-success')}</div>\`;
}
function outstandingDecisionPicker(c){
  const staged=pendingOutstanding[c.id]||'';
  const button=(value,label,cls)=>{const active=staged===value;return \`<button type="button" data-decision="\${value}" data-selected-class="\${cls}" class="btn btn-xs join-item \${active?cls:'btn-outline'}" onclick="event.stopPropagation();stageOutstanding('\${c.id}','\${value}',this)" title="\${active?'Click to deselect':'Set to '+label}">\${label}</button>\`;};
  return \`<div class="join whitespace-nowrap" aria-label="Triage ticket">\${button('close','Close','btn-error')}\${button('keep','Keep','btn-success')}</div>\`;
}
async function setTicketType(id,type){
  const result=await (await fetch('/api/type',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,type,by:auditActor()})})).json();
  if(!result.ok)return alert(result.error||'The ticket type could not be saved.');
  const chat=DATA.chats.find(c=>c.id===id);if(chat){chat.manualType=result.type;applyLocalActivity(chat,result.event);}render();
  const modal=document.getElementById('conversationModal');if(modal.open&&chat)document.getElementById('conversationType').innerHTML=typePicker(chat);
}
function applyLocalActivity(chat,event){
  if(!chat||!event)return;chat.actionLast=event.at;chat.activityLast=event.at;chat.activitySource='app';chat.latestAction=event;
}
function contextHtml(c,max=180){
  const hasAi=c.ai&&!c.ai.unavailable&&(c.ai.headline||c.ai.summary);
  const compact=hasAi?(c.ai.headline||c.ai.summary.slice(0,max)):c.opening?c.opening.text.slice(0,max):(c.title||'No message preview available');
  const label=hasAi?'AI summary':c.opening?'Opening message · '+(c.opening.sender||'customer'):'Ticket context';
  const seen=c.leftOnRead?' border border-error rounded-md p-2':'';
  const title=c.leftOnRead?'Left on read':'';
  return \`<button type="button" class="context-preview w-full\${seen}" title="\${title}" onclick="openConversation('\${c.id}')"><div class="text-xs opacity-50">\${esc(label)} · click to view conversation</div><div>\${esc(compact)}\${!hasAi&&c.opening&&c.opening.text.length>max?'…':''}</div></button>\`;
}
async function openConversation(id){
  const modal=document.getElementById('conversationModal'), content=document.getElementById('conversationContent');
  document.getElementById('conversationTitle').textContent='Conversation';document.getElementById('conversationMeta').textContent='Loading…';content.innerHTML='<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>';modal.showModal();
  const chat=await (await fetch('/api/chat/'+encodeURIComponent(id))).json();
  if(chat.error){content.innerHTML=\`<div class="alert alert-error">\${esc(chat.error)}</div>\`;return;}
  document.getElementById('conversationTitle').textContent=chat.title||'(no subject)';document.getElementById('conversationMeta').textContent=chat.parties||'';document.getElementById('conversationReply').href=chat.url;
  const localChat=DATA.chats.find(c=>c.id===id);document.getElementById('conversationType').innerHTML=localChat?typePicker(localChat):'';
  content.innerHTML=(chat.messages||[]).map(m=>m.note
    ? \`<div class="conversation-note rounded-lg p-3 mb-3"><div class="text-[11px] font-semibold mb-1">Internal note · \${esc(m.sender||'')} · \${day(m.date)}</div><div class="whitespace-pre-wrap text-sm">\${esc(m.text||'(empty)')}</div></div>\`
    : \`<div class="bubble \${m.staff?'b-staff':'b-cust'} mb-3"><div class="who text-[11px] font-semibold mb-1">\${esc(m.sender||'')} · \${m.staff?'Tidy':'customer'} · \${day(m.date)}</div>\${esc(m.text||'(empty)')}</div>\`).join('')||'<div class="opacity-60">No messages in this ticket.</div>';
  content.scrollTop=content.scrollHeight;
}

async function load(){ DATA=await (await fetch('/api/data')).json();
  if(!localStorage.getItem('tidy-actions-migrated')){
    const serverDecisions=DATA.decisions||{};
    const legacy=Object.entries(REVIEW.decisions||{}).filter(([id,value])=>!Object.hasOwn(serverDecisions,id)&&['close','keep'].includes(value));
    if(legacy.length){await Promise.all(legacy.map(([id,decision])=>fetch('/api/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,decision,by:'Imported from browser history'})})));DATA=await (await fetch('/api/data')).json();}
    localStorage.setItem('tidy-actions-migrated','1');
  }
  REVIEW.decisions=Object.assign({},DATA.decisions||{});saveReview();
  document.getElementById('synced').textContent = DATA.syncedAt? 'synced '+day(DATA.syncedAt):'no data — run Sync';
  paintTokenStatus();
  updateSyncState();
  const summarize=document.getElementById('summarizeTool'); summarize.disabled=!DATA.aiAvailable;
  summarize.classList.toggle('opacity-40',!DATA.aiAvailable);
  document.getElementById('summarizeHint').textContent=DATA.aiAvailable?'Available via '+DATA.aiSource+' · replaces manual ticket types':'Unavailable — configure or sign in to an AI provider';
  render();
  if(DATA.hasToken&&DATA.crmState==='unverified')refreshTokenStatus();
}
function paintTokenStatus(checking=false){
  const dot=document.getElementById('tokdot'),text=document.getElementById('toktext'),button=document.getElementById('tokenButton');if(!dot||!text||!button)return;
  const state=checking?'checking':(DATA.crmState||(!DATA.hasToken?'missing':'unverified'));
  const styles={verified:'bg-success',expired:'bg-error',missing:'bg-error',checking:'bg-warning',unverified:'bg-warning',unknown:'bg-warning'};
  const labels={verified:'CRM connected',expired:'Login expired',missing:'CRM disconnected',checking:'Checking CRM…',unverified:'CRM unchecked',unknown:'Check failed'};
  const seconds=checking&&TOKEN_CHECK_DEADLINE?Math.max(0,Math.ceil((TOKEN_CHECK_DEADLINE-Date.now())/1000)):null;
  dot.className='inline-block w-2 h-2 rounded-full mr-1 '+(styles[state]||'bg-warning');text.textContent=checking?'Checking token · '+seconds+'s':(labels[state]||'Token status unknown');
  const checked=DATA.crmVerifiedAt?' Last verified '+new Date(DATA.crmVerifiedAt).toLocaleTimeString()+'.':'';button.title=(DATA.crmReason||labels[state])+checked+' Click to update the token.';
}
async function refreshTokenStatus(force=false){
  if(TOKEN_CHECK_IN_FLIGHT||!DATA.hasToken)return;
  if(!force&&DATA.crmState==='verified'&&DATA.crmVerifiedAt&&(Date.now()-new Date(DATA.crmVerifiedAt).getTime()<5*60*1000))return;
  TOKEN_CHECK_IN_FLIGHT=true;TOKEN_CHECK_DEADLINE=Date.now()+4000;paintTokenStatus(true);clearInterval(TOKEN_CHECK_TIMER);TOKEN_CHECK_TIMER=setInterval(()=>paintTokenStatus(true),250);
  const hardTimeout=setTimeout(()=>{if(!TOKEN_CHECK_IN_FLIGHT)return;TOKEN_CHECK_IN_FLIGHT=false;TOKEN_CHECK_DEADLINE=0;clearInterval(TOKEN_CHECK_TIMER);TOKEN_CHECK_TIMER=null;DATA.crmState='unknown';DATA.crmReason='Token check timed out.';paintTokenStatus();},5000);
  try{const state=await (await fetch('/api/token/check',{method:'POST',signal:AbortSignal.timeout(4000)})).json();DATA.crmAvailable=state.available;DATA.crmState=state.state;DATA.crmVerifiedAt=state.verifiedAt;DATA.crmReason=state.reason;paintTokenStatus();updateSyncState();}
  catch{DATA.crmState='unknown';DATA.crmReason='The CRM token check timed out. You can retry by reloading or clicking Token.';paintTokenStatus();}
  finally{clearTimeout(hardTimeout);TOKEN_CHECK_IN_FLIGHT=false;TOKEN_CHECK_DEADLINE=0;clearInterval(TOKEN_CHECK_TIMER);TOKEN_CHECK_TIMER=null;paintTokenStatus();}
}
function updateSyncState(){
  const button=document.getElementById('syncButton');
  button.classList.toggle('opacity-80',!DATA.crmAvailable);
  button.classList.toggle('ring-2',!DATA.crmAvailable);
  button.classList.toggle('ring-white/40',!DATA.crmAvailable);
  button.textContent=DATA.crmAvailable?'↻ Sync now':'↻ Sync unavailable';
  button.setAttribute('aria-disabled',String(!DATA.crmAvailable));
  button.title=DATA.crmAvailable?'Pull the latest CRM changes':(DATA.crmReason||'CRM access is unavailable')+' Click to learn how to fix it.';
}
function syncNow(){
  if(!DATA.crmAvailable) return alert((DATA.crmReason||'CRM access is unavailable')+'\\n\\nUse the Token button to paste your CRM refresh token.');
  return run('sync');
}
async function updateToken(){
  const t=prompt('Paste your CRM refresh token\\n(crm.tidyint.com → Devtools → Application → Cookies → TidyCore_RefreshToken):');
  if(t===null) return;
  const r=await (await fetch('/api/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refreshToken:t})})).json();
  await load();
  alert(r.state==='verified'?'Authentication verified — future access tokens will refresh automatically.':(r.reason||'Token cleared.'));
}
function tab(t){ TAB=t; document.querySelectorAll('[role=tab]').forEach(d=>d.classList.toggle('tab-active',d.dataset.tab===t)); render(); }
function render(){
  if(TAB==='dashboard')renderDashboard(); else if(TAB==='outstanding')renderOutstanding(); else if(TAB==='inbox')renderInbox(); else if(TAB==='releases')renderReleases(); else if(TAB==='proposals')renderProposals(); else if(TAB==='audit')renderAudit(); else renderKb();
  footerBar();
}

/* ---------- Dashboard: workload, aging, and client attention ---------- */
const idleDays=iso=>iso?Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/86400000)):0;
const lastMessage=c=>c.tail?.length?c.tail[c.tail.length-1]:null;
const waitingOnTidy=c=>{const last=lastMessage(c);return Boolean(last&&!last.staff);};
const clientName=c=>{const parts=String(c.parties||'Unknown client').split(',').map(x=>x.trim()).filter(Boolean);return parts.at(-1)||'Unknown client';};
function dashboardBars(rows,color='#16a34a'){
  const max=Math.max(1,...rows.map(r=>r.value));
  return rows.map(r=>\`<div class="grid grid-cols-[110px_1fr_36px] gap-2 items-center text-sm mb-2"><span class="truncate" title="\${esc(r.label)}">\${esc(r.label)}</span><div class="h-3 bg-base-200 rounded-full overflow-hidden"><div class="h-full rounded-full" style="width:\${r.value?Math.max(2,r.value/max*100):0}%;background:\${r.color||color}"></div></div><b class="text-right">\${r.value}</b></div>\`).join('');
}
function renderDashboard(){
  const v=document.getElementById('view');
  const open=DATA.chats.filter(c=>c.status==='open');
  const waiting=open.filter(waitingOnTidy);
  const stale=waiting.filter(c=>idleDays(c.last)>=7);
  const clients=new Map();
  for(const c of open){
    const name=clientName(c), days=idleDays(c.last), isWaiting=waitingOnTidy(c);
    if(!clients.has(name))clients.set(name,{name,open:0,waiting:0,oldest:0,score:0});
    const x=clients.get(name);x.open++;if(isWaiting){x.waiting++;x.oldest=Math.max(x.oldest,days);}
  }
  for(const x of clients.values())x.score=x.waiting*15+Math.min(x.oldest,60)+Math.max(0,x.open-1)*5;
  const attention=[...clients.values()].filter(x=>x.waiting>0).sort((a,b)=>b.score-a.score||b.oldest-a.oldest).slice(0,8);
  const highAttention=[...clients.values()].filter(x=>x.waiting>=2||(x.waiting>=1&&x.oldest>=14)).length;
  const ageBuckets=[
    {label:'0–2 days',value:waiting.filter(c=>idleDays(c.last)<=2).length,color:'#22c55e'},
    {label:'3–7 days',value:waiting.filter(c=>idleDays(c.last)>=3&&idleDays(c.last)<=7).length,color:'#84cc16'},
    {label:'8–14 days',value:waiting.filter(c=>idleDays(c.last)>=8&&idleDays(c.last)<=14).length,color:'#f59e0b'},
    {label:'15–30 days',value:waiting.filter(c=>idleDays(c.last)>=15&&idleDays(c.last)<=30).length,color:'#f97316'},
    {label:'30+ days',value:waiting.filter(c=>idleDays(c.last)>30).length,color:'#dc2626'},
  ];
  const types=['bug','feature','not sure'].map((type,i)=>({label:type,value:open.filter(c=>ticketType(c)===type).length,color:['#dc2626','#16a34a','#d97706'][i]}));
  const unclassified=open.filter(c=>!ticketType(c)).length;if(unclassified)types.push({label:'unclassified',value:unclassified,color:'#94a3b8'});
  const oldest=[...waiting].sort((a,b)=>idleDays(b.last)-idleDays(a.last)).slice(0,10);
  const stat=(label,value,note,color)=>\`<div class="card bg-base-100 shadow-sm border-l-4 \${color}"><div class="card-body p-4 gap-0"><div class="text-3xl font-bold">\${value}</div><div class="font-semibold">\${label}</div><div class="text-xs opacity-55 mt-1">\${note}</div></div></div>\`;
  v.innerHTML=\`<div class="flex items-end justify-between gap-3 flex-wrap mb-4"><div><h1 class="text-2xl font-bold">Support dashboard</h1><p class="text-sm opacity-60">Prioritise limited capacity using ticket age, client load, and who spoke last.</p></div><span class="text-xs opacity-50">Based on data synced \${DATA.syncedAt?day(DATA.syncedAt):'never'}</span></div>
    <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
      \${stat('Open tickets',open.length,'Total current workload','border-l-slate-500')}
      \${stat('Waiting on us',waiting.length,'Customer sent the latest message','border-l-blue-500')}
      \${stat('Waiting 7+ days',stale.length,'Customer-waiting tickets going stale','border-l-orange-500')}
      \${stat('Clients needing attention',highAttention,'Multiple waits or one 14+ day wait','border-l-red-500')}
    </div>
    <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
      <div class="card bg-base-100 shadow-sm"><div class="card-body p-4"><h2 class="font-semibold">Customer waiting time</h2><p class="text-xs opacity-50 mb-2">Age since the latest customer message</p>\${dashboardBars(ageBuckets)}</div></div>
      <div class="card bg-base-100 shadow-sm"><div class="card-body p-4"><h2 class="font-semibold">Open ticket mix</h2><p class="text-xs opacity-50 mb-2">Uses existing classifications; AI is not required for unclassified tickets</p>\${dashboardBars(types,'#64748b')}</div></div>
    </div>
    <div class="card bg-base-100 shadow-sm mb-4"><div class="card-body p-4"><div class="flex items-start justify-between gap-3"><div><h2 class="font-semibold">Clients needing attention</h2><p class="text-xs opacity-50">Ranked by customer-waiting tickets, oldest wait, and total open load—not sentiment.</p></div></div>
      <div class="mt-3">\${attention.length?attention.map(x=>\`<div class="grid grid-cols-[minmax(130px,1fr)_2fr_auto] gap-3 items-center mb-3"><div class="font-medium truncate" title="\${esc(x.name)}">\${esc(x.name)}</div><div class="h-3 bg-base-200 rounded-full overflow-hidden"><div class="h-full bg-red-400 rounded-full" style="width:\${Math.max(4,x.score/Math.max(...attention.map(a=>a.score))*100)}%"></div></div><div class="text-xs text-right whitespace-nowrap"><b>\${x.waiting}</b> waiting · \${x.open} open · oldest \${x.oldest}d</div></div>\`).join(''):'<div class="text-sm opacity-60">No clients are currently waiting on Tidy.</div>'}</div>
    </div>
    <div class="card bg-base-100 shadow-sm"><div class="card-body p-0"><div class="p-4 pb-2"><h2 class="font-semibold">Oldest customer-waiting tickets</h2><p class="text-xs opacity-50">Click Context to open the full conversation.</p></div><div class="overflow-x-auto"><table class="table table-sm"><thead><tr><th>Waiting</th><th>Client</th><th>Type</th><th>Context</th><th></th></tr></thead><tbody>
      \${oldest.map(c=>\`<tr><td class="font-semibold whitespace-nowrap \${idleDays(c.last)>=14?'text-error':idleDays(c.last)>=7?'text-warning':''}">\${idleDays(c.last)}d</td><td>\${esc(clientName(c))}</td><td>\${typeBadge(c)}</td><td class="max-w-xl">\${contextHtml(c,180)}</td><td><a class="link link-primary whitespace-nowrap" href="\${c.url}" target="_blank">reply in CRM ↗</a></td></tr>\`).join('')||'<tr><td colspan="5" class="p-4 opacity-60">Nobody is waiting on Tidy right now.</td></tr>'}
      </tbody></table></div></div></div>\`;
}

/* ---------- Outstanding tab: genuinely undecided open tickets ---------- */
// Build controls ONCE; typing / deciding only refreshes #otbl so the input keeps focus.
async function persistDecision(id,decision){
  const result=await (await fetch('/api/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,decision,by:auditActor()})})).json();
  if(!result.ok){alert(result.error||'The ticket status could not be saved.');return false;}
  if(result.decision===null)delete REVIEW.decisions[id];else REVIEW.decisions[id]=result.decision;
  // The server records the action timestamp immediately. Keep the current
  // browser ordering stable; the new activity order is applied on refresh.
  saveReview();return true;
}
const pendingOutstanding={};
function stageOutstanding(id,d,button){
  if(pendingOutstanding[id]===d){delete pendingOutstanding[id];}else{pendingOutstanding[id]=d;}
  const picker=button.closest('[aria-label="Triage ticket"]');
  picker.closest('tr').classList.toggle('bg-base-200/60',Boolean(pendingOutstanding[id]));
  picker.querySelectorAll('button').forEach(item=>{
    const active=pendingOutstanding[id]===item.dataset.decision;
    item.classList.toggle('btn-outline',!active);
    item.classList.toggle(item.dataset.selectedClass,active);
    item.title=active?'Click to deselect':'Set to '+item.textContent.trim();
  });
}
async function confirmOutstanding(){
  const entries=Object.entries(pendingOutstanding);if(!entries.length)return;
  const ok=await Promise.all(entries.map(([id,d])=>persistDecision(id,d)));
  entries.forEach(([id],i)=>{if(ok[i])delete pendingOutstanding[id];});
  outstandingRows();footerBar();
}
function clearOutstanding(){Object.keys(pendingOutstanding).forEach(k=>delete pendingOutstanding[k]);document.querySelectorAll('#otbl [aria-label="Triage ticket"] button').forEach(item=>{item.closest('tr').classList.remove('bg-base-200/60');item.classList.remove(item.dataset.selectedClass);item.classList.add('btn-outline');item.title='Set to '+item.textContent.trim();});}
async function setDecide(id,d){
  if(REVIEW.decisions[id]===d)return;
  if(!await persistDecision(id,d))return;
  if(TAB==='outstanding')outstandingRows();else if(TAB==='inbox')inboxRows(); footerBar();
}
function renderOutstanding(){
  const v=document.getElementById('view');
  const types=['bug','feature','not sure'];
  const selected=Array.isArray(window._otfs)?window._otfs:types;
  v.innerHTML=\`<div class="flex gap-2 mb-3 items-center flex-wrap">
    <input id="oq" class="input input-bordered input-sm w-64" placeholder="search…" oninput="outstandingRows()" value="\${esc(window._oq||'')}">
    <div class="flex gap-1.5 flex-wrap" aria-label="Filter outstanding tickets by type">\${types.map(type=>\`<label class="flex items-center gap-1.5 border border-base-300 rounded-lg px-2 py-1 bg-base-100 cursor-pointer text-sm"><input type="checkbox" class="checkbox checkbox-xs checkbox-primary otf" value="\${type}" \${selected.includes(type)?'checked':''} onchange="outstandingRows()"> \${type}</label>\`).join('')}</div>
    <span class="text-sm opacity-70" id="ocount"></span></div>
    <div id="otbl"></div>\`;
  outstandingRows();
}
function outstandingRows(){
  const qin=document.getElementById('oq'); window._oq = qin ? qin.value.toLowerCase() : (window._oq||'');
  window._otfs=[...document.querySelectorAll('.otf:checked')].map(el=>el.value);
  const list=DATA.chats.filter(c=>{
    if(c.status!=='open') return false;
    const d=REVIEW.decisions[c.id];
    if(d) return false;
    if(window._otfs.length<3&&!window._otfs.includes(ticketType(c)))return false;
    if(window._oq){ const hay=((c.code||'')+' '+c.title+' '+c.parties+' '+(c.ai?.summary||'')).toLowerCase(); if(!hay.includes(window._oq)) return false; }
    return true;
  }).sort((a,b)=>new Date(a.last||0)-new Date(b.last||0));
  document.getElementById('ocount').innerHTML=\`<b>\${list.length}</b> outstanding — no management decision yet\`;
  document.getElementById('otbl').innerHTML=\`<div id="outstandingStageBar" class="sticky top-24 z-10 h-[58px] mb-3"></div><div class="overflow-x-auto bg-base-100 rounded-box shadow-sm"><table class="table table-sm table-pin-rows">
    <thead><tr><th>Ticket</th><th>Last activity</th><th>From</th><th>Type</th><th>Context</th><th>Decide</th><th></th></tr></thead><tbody>
    \${list.map(c=>outstandingRow(c)).join('')
      || '<tr><td colspan="7" class="opacity-60 p-4">Nothing outstanding — every open ticket has a management decision. 🎉</td></tr>'}
    </tbody></table></div>\`;
  outstandingStageBar();
}
function outstandingStageBar(){
  const bar=document.getElementById('outstandingStageBar');if(!bar)return;
  bar.innerHTML=\`<div class="h-full flex items-center gap-3 p-3 bg-base-200 rounded-lg border border-base-300">
    <span class="text-sm font-semibold">Choose Close or Keep, then confirm.</span>
    <div class="ml-auto flex gap-2"><button class="btn btn-sm btn-ghost" onclick="clearOutstanding()">Clear</button><button class="btn btn-sm btn-primary" onclick="confirmOutstanding()">Confirm all</button></div></div>\`;
}
function outstandingRow(c){
  return '<tr class="hover'+(pendingOutstanding[c.id]?' bg-base-200/60':'')+'">'
    +'<td class="font-semibold whitespace-nowrap">'+esc(c.code||'—')+'</td><td class="opacity-60 whitespace-nowrap">'+day(c.last)+'</td><td>'+esc(c.parties||'')+'</td><td>'+typePicker(c)+'</td><td class="max-w-md">'+contextHtml(c,150)+'</td>'
    +'<td>'+outstandingDecisionPicker(c)+'</td>'
    +'<td><a class="link link-primary whitespace-nowrap" href="'+c.url+'" target="_blank">reply in CRM ↗</a></td></tr>';
}

/* ---------- Release follow-up: map shipped PRs to customers awaiting a reply ---------- */
async function ensureReleaseFollowups(){if(!RELEASE_FOLLOWUPS)RELEASE_FOLLOWUPS=(await (await fetch('/api/release-followups')).json()).followups||[];}
async function renderReleases(){
  const v=document.getElementById('view');v.innerHTML='<div class="flex justify-center p-10"><span class="loading loading-spinner loading-lg"></span></div>';
  await ensureReleaseFollowups();if(TAB!=='releases')return;
  const editing=EDIT_RELEASE&&RELEASE_FOLLOWUPS.find(item=>item.id===EDIT_RELEASE.id)||null;
  const selected=new Set((editing?.tickets||[]).map(ticket=>ticket.ticketId));
  const mappedElsewhere=new Set(RELEASE_FOLLOWUPS.filter(item=>item.id!==editing?.id).flatMap(item=>(item.tickets||[]).map(ticket=>ticket.ticketId)));
  const available=DATA.chats.filter(chat=>chat.status==='open'&&!mappedElsewhere.has(chat.id)&&!selected.has(chat.id)).sort((a,b)=>new Date(b.last||0)-new Date(a.last||0));
  const alreadyMapped=DATA.chats.filter(chat=>selected.has(chat.id)).sort((a,b)=>new Date(b.last||0)-new Date(a.last||0));
  const pending=RELEASE_FOLLOWUPS.reduce((sum,item)=>sum+(item.closedAt?0:(item.tickets||[]).filter(ticket=>ticket.status!=='responded').length),0);
  const releaseNames=[...new Set(RELEASE_FOLLOWUPS.map(item=>item.releaseName).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const releaseCount=new Set(RELEASE_FOLLOWUPS.map(item=>item.releaseName||'Uncategorised')).size;
  const ticketRow=(chat,mapped=false)=>{const searchText=((chat.code||'')+' '+(chat.title||'')+' '+(chat.parties||'')+' '+(chat.ai?.headline||'')+' '+(chat.ai?.summary||'')).toLowerCase();return \`<label class="release-ticket-row flex items-start gap-3 p-3 border-b border-base-200 cursor-pointer \${mapped?'bg-base-200 opacity-60':'hover:bg-base-200'}" data-search="\${esc(searchText)}"><input type="checkbox" class="checkbox checkbox-sm release-ticket mt-0.5" value="\${chat.id}" \${mapped?'checked':''}><span class="min-w-0 flex-1"><span class="font-semibold">\${esc(chat.code||'Ticket')} · \${esc(clientName(chat))}</span><span class="block text-xs opacity-60 truncate">\${esc(chat.title||chat.ai?.headline||'No subject')}</span></span>\${mapped?'<span class="badge badge-ghost whitespace-nowrap">Already mapped</span>':typeBadge(chat)}</label>\`;};
  const availableRows=available.map(chat=>ticketRow(chat)).join('');
  const mappedRows=alreadyMapped.length?\`<div class="release-ticket-section px-3 py-2 text-xs font-semibold bg-base-300">Already mapped to this PR</div>\${alreadyMapped.map(chat=>ticketRow(chat,true)).join('')}\`:'';
  const ticketRows=availableRows+mappedRows;
  const grouped=new Map();for(const item of RELEASE_FOLLOWUPS){const name=item.releaseName||'Uncategorised';if(!grouped.has(name))grouped.set(name,[]);grouped.get(name).push(item);}
  const cards=[...grouped.entries()].sort((a,b)=>{const ap=a[1].reduce((n,item)=>n+(item.tickets||[]).filter(t=>t.status!=='responded').length,0),bp=b[1].reduce((n,item)=>n+(item.tickets||[]).filter(t=>t.status!=='responded').length,0);const ad=Math.max(...a[1].map(item=>new Date(item.releasedAt||item.createdAt||0).getTime()||0)),bd=Math.max(...b[1].map(item=>new Date(item.releasedAt||item.createdAt||0).getTime()||0));return Number(bp>0)-Number(ap>0)||bd-ad||a[0].localeCompare(b[0]);}).map(([name,items])=>releaseFollowupGroup(name,items)).join('');
  v.innerHTML=\`<div class="flex items-end justify-between gap-3 flex-wrap mb-4"><div><h1 class="text-2xl font-bold">Release follow-up</h1><p class="text-sm opacity-60">Group shipped pull requests by release, map them to tickets, and track which customers still need a reply.</p></div><div class="stats bg-base-100 shadow-sm"><div class="stat py-2 px-4"><div class="stat-title text-xs">Releases</div><div class="stat-value text-xl">\${releaseCount}</div></div><div class="stat py-2 px-4"><div class="stat-title text-xs">PRs</div><div class="stat-value text-xl">\${RELEASE_FOLLOWUPS.length}</div></div><div class="stat py-2 px-4"><div class="stat-title text-xs">Need response</div><div class="stat-value text-xl text-warning">\${pending}</div></div></div></div>
    <div class="card bg-base-100 shadow-sm mb-5"><div class="card-body p-4"><div class="flex items-center gap-2 mb-3"><h2 class="font-bold text-lg">\${editing?'Edit PR #'+esc(editing.prNumber):'Map a released PR'}</h2>\${editing?'<button class="btn btn-sm btn-ghost ml-auto" onclick="EDIT_RELEASE=null;renderReleases()">Cancel</button>':''}</div>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-4"><section class="rounded-lg border border-base-300 p-4"><div class="flex items-center justify-between gap-3 mb-3"><div><h3 class="font-semibold">Release details</h3><p class="text-xs opacity-55">Version, date and build that customers received.</p></div><button class="btn btn-sm btn-outline whitespace-nowrap" type="button" onclick="pasteWebsiteRelease()">Paste website release</button></div><div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><label class="form-control sm:col-span-2"><span class="label-text">Release number</span><input id="releaseName" class="input input-bordered w-full" list="releaseNameOptions" placeholder="1.2026.6.2" value="\${esc(editing?(editing.releaseName||'Uncategorised'):'')}"><datalist id="releaseNameOptions">\${releaseNames.map(name=>\`<option value="\${esc(name)}"></option>\`).join('')}</datalist></label><label class="form-control"><span class="label-text">Release date</span><input id="releaseDate" type="date" class="input input-bordered w-full" value="\${esc(editing?.releasedAt||new Date().toISOString().slice(0,10))}"></label><label class="form-control"><span class="label-text">Build / commit</span><input id="releaseBuild" class="input input-bordered w-full" placeholder="0a54e80b" value="\${esc(editing?.releaseBuild||'')}"></label></div></section><section class="rounded-lg border border-base-300 p-4"><div class="mb-3"><h3 class="font-semibold">Pull request</h3><p class="text-xs opacity-55">The shipped change this customer follow-up relates to.</p></div><div class="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-3"><label class="form-control"><span class="label-text">PR number</span><input id="releasePrNumber" class="input input-bordered w-full" placeholder="1223" value="\${esc(editing?.prNumber||'')}"></label><label class="form-control"><span class="label-text">PR title</span><input id="releasePrTitle" class="input input-bordered w-full" placeholder="What shipped?" value="\${esc(editing?.prTitle||'')}"></label><label class="form-control sm:col-span-2"><span class="label-text">PR link <span class="opacity-50">(optional)</span></span><input id="releasePrUrl" class="input input-bordered w-full" placeholder="https://github.com/…/pull/1223" value="\${esc(editing?.prUrl||'')}"></label></div></section><label class="form-control xl:col-span-2"><span class="label-text font-semibold">Support note <span class="font-normal opacity-50">(optional)</span></span><input id="releaseNotes" class="input input-bordered w-full" placeholder="Anything support should mention when replying to customers" value="\${esc(editing?.notes||'')}"></label></div>
      <div class="mt-4"><div class="flex items-center gap-2 mb-2"><span class="font-semibold">Open tickets needing a response</span><span class="text-xs opacity-55">Tickets assigned to another PR are hidden.</span><input class="input input-sm input-bordered ml-auto w-72" placeholder="Find ticket or customer…" oninput="filterReleaseTickets(this.value)"></div><div class="border border-base-300 rounded-lg max-h-72 overflow-y-auto">\${ticketRows||'<div class="p-4 opacity-60">No unassigned open tickets available.</div>'}</div></div>
      <div class="card-actions justify-end mt-4"><button class="btn btn-success" onclick="saveReleaseFollowup('\${editing?.id||''}')">\${editing?'Update mapping':'Save PR mapping'}</button></div><div id="releaseFormStatus" class="text-sm"></div></div></div>
    <div><h2 class="font-bold text-lg mb-2">Releases and customer replies</h2>\${cards||'<div class="card bg-base-100"><div class="card-body opacity-60">No PRs mapped yet.</div></div>'}</div>\`;
}
function filterReleaseTickets(value){const q=String(value||'').toLowerCase();document.querySelectorAll('.release-ticket-row').forEach(row=>row.classList.toggle('hidden',q&&!row.dataset.search.includes(q)));document.querySelectorAll('.release-ticket-section').forEach(section=>{let next=section.nextElementSibling,visible=false;while(next&&next.classList.contains('release-ticket-row')){if(!next.classList.contains('hidden'))visible=true;next=next.nextElementSibling;}section.classList.toggle('hidden',!visible);});}
function parseWebsiteRelease(text){
  const match=String(text||'').trim().match(/^Release:\\s*(.+?)\\s*-\\s*(\\d{1,2})\\s+([A-Za-z]{3})\\s+(\\d{4})\\s*-\\s*([A-Za-z0-9]+)\\s*$/i);if(!match)return false;
  const months={jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'},month=months[match[3].toLowerCase()];if(!month)return false;
  document.getElementById('releaseName').value=match[1].trim();document.getElementById('releaseDate').value=match[4]+'-'+month+'-'+match[2].padStart(2,'0');document.getElementById('releaseBuild').value=match[5];return true;
}
async function pasteWebsiteRelease(){
  let value='';try{value=await navigator.clipboard.readText();}catch{}if(!value)value=prompt('Paste the website footer release text:')||'';
  if(!parseWebsiteRelease(value))alert('That does not look like a website release. Expected: Release: 1.2026.6.2 - 22 Jul 2026 - 0a54e80b');
}
function releaseFollowupGroup(name,items){
  const closed=items.every(item=>item.closedAt),pending=items.reduce((sum,item)=>sum+(item.closedAt?0:(item.tickets||[]).filter(ticket=>ticket.status!=='responded').length),0),ticketCount=new Set(items.flatMap(item=>(item.tickets||[]).map(ticket=>ticket.ticketId))).size;
  const dates=items.map(item=>item.releasedAt).filter(Boolean).sort(),builds=[...new Set(items.map(item=>item.releaseBuild).filter(Boolean))];const dateText=dates.length===0?'Release date unknown':dates[0]===dates[dates.length-1]?'Released '+dates[0]:'Released '+dates[0]+' to '+dates[dates.length-1];
  const ordered=items.slice().sort((a,b)=>{const ap=(a.tickets||[]).some(t=>t.status!=='responded'),bp=(b.tickets||[]).some(t=>t.status!=='responded');return Number(bp)-Number(ap)||String(a.prNumber).localeCompare(String(b.prNumber),undefined,{numeric:true});});
  const nameArg=esc(JSON.stringify(name));
  return \`<section class="card bg-base-100 shadow-sm mb-5 \${closed?'opacity-65':''}"><details \${closed?'':'open'}><summary class="p-4 flex items-center gap-3 flex-wrap border-b border-base-300 cursor-pointer list-none"><div><h3 class="font-bold text-xl">\${esc(name)}</h3><div class="text-xs opacity-60">\${items.length} PR\${items.length===1?'':'s'} · \${ticketCount} ticket\${ticketCount===1?'':'s'} · \${dateText}\${builds.length?' · Build '+builds.map(esc).join(', '):''}</div></div><div class="ml-auto badge \${closed?'badge-neutral':pending?'badge-warning':'badge-success'} badge-lg">\${closed?'Past release — closed':pending?pending+' response'+(pending===1?'':'s')+' remaining':'All customers responded'}</div>\${closed?'':\`<button class="btn btn-sm btn-neutral" onclick="event.preventDefault();event.stopPropagation();closeRelease(\${nameArg},\${ticketCount})">Close release</button>\`}</summary><div class="p-3 bg-base-200/50">\${ordered.map(item=>releaseFollowupCard(item)).join('')}</div></details></section>\`;
}
function releaseFollowupCard(item){
  const pending=item.closedAt?0:(item.tickets||[]).filter(ticket=>ticket.status!=='responded').length;
  const title='PR #'+esc(item.prNumber)+(item.prTitle?' · '+esc(item.prTitle):'');
  const tickets=(item.tickets||[]).map(ticket=>{const chat=DATA.chats.find(c=>c.id===ticket.ticketId),done=ticket.status==='responded';return \`<div class="grid grid-cols-1 lg:grid-cols-[minmax(180px,1fr)_minmax(260px,2fr)_320px] gap-3 items-center p-3 border-t border-base-200 \${done?'opacity-55':''}"><div><button class="font-semibold link link-primary text-left" onclick="openConversation('\${ticket.ticketId}')">\${esc(chat?.code||ticket.ticketId)} · \${esc(chat?clientName(chat):'Ticket not in current sync')}</button><div class="text-xs">\${done?'Responded '+day(ticket.respondedAt):'Customer response needed'} · \${esc(chat?.status||'unknown')}</div></div><div>\${chat?contextHtml(chat,170):'<span class="text-sm opacity-60">Ticket details unavailable.</span>'}</div><div class="flex gap-2 justify-end">\${chat?.url?\`<a class="btn btn-sm btn-primary whitespace-nowrap" href="\${chat.url}" target="_blank">Reply in CRM ↗</a>\`:''}<button class="btn btn-sm w-44 whitespace-nowrap \${done?'btn-outline':'btn-success'}" onclick="setReleaseTicketStatus('\${item.id}','\${ticket.ticketId}','\${done?'needs_response':'responded'}')">\${done?'Needs response again':'Mark responded'}</button></div></div>\`;}).join('');
  return \`<div class="card bg-base-100 border border-base-300 mb-3 last:mb-0"><div class="card-body p-0"><div class="p-4 flex items-start gap-3 flex-wrap"><div><h4 class="font-bold text-lg">\${item.prUrl?\`<a class="link link-primary" href="\${esc(item.prUrl)}" target="_blank">\${title} ↗</a>\`:title}</h4><div class="text-xs opacity-55">Released \${esc(item.releasedAt||'date unknown')} · \${pending} response\${pending===1?'':'s'} remaining</div>\${item.notes?\`<div class="text-sm mt-2">\${esc(item.notes)}</div>\`:''}</div><div class="ml-auto flex gap-2"><button class="btn btn-sm" onclick="startEditRelease('\${item.id}')">Edit mapping</button><button class="btn btn-sm btn-error btn-outline" onclick="deleteReleaseFollowup('\${item.id}')">Delete</button></div></div>\${tickets}</div></div>\`;
}
async function saveReleaseFollowup(id){
  const ticketIds=[...document.querySelectorAll('.release-ticket:checked')].map(input=>input.value),status=document.getElementById('releaseFormStatus');
  const followup={id:id||null,releaseName:document.getElementById('releaseName').value.trim(),releaseBuild:document.getElementById('releaseBuild').value.trim(),prNumber:document.getElementById('releasePrNumber').value.trim(),prTitle:document.getElementById('releasePrTitle').value.trim(),prUrl:document.getElementById('releasePrUrl').value.trim(),releasedAt:document.getElementById('releaseDate').value,notes:document.getElementById('releaseNotes').value.trim(),ticketIds};
  status.textContent='Saving…';const result=await (await fetch('/api/release-followups/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({followup,by:auditActor()})})).json();if(!result.ok){status.textContent=result.error||'Could not save this PR mapping.';return;}RELEASE_FOLLOWUPS=null;EDIT_RELEASE=null;renderReleases();
}
function startEditRelease(id){EDIT_RELEASE=RELEASE_FOLLOWUPS.find(item=>item.id===id)||null;renderReleases();scrollTo({top:0,behavior:'smooth'});}
async function setReleaseTicketStatus(followupId,ticketId,status){const result=await (await fetch('/api/release-followups/ticket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({followupId,ticketId,status,by:auditActor()})})).json();if(!result.ok)return alert(result.error||'Could not update the response status.');RELEASE_FOLLOWUPS=null;renderReleases();}
async function closeRelease(releaseName,ticketCount){
  if(!DATA.crmAvailable)return alert((DATA.crmReason||'CRM access is unavailable')+' Use the Token button to paste a fresh token.');
  if(!confirm('Close '+releaseName+' and all '+ticketCount+' mapped ticket'+(ticketCount===1?'':'s')+' in the CRM?'))return;
  const result=await (await fetch('/api/release-followups/close-release',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({releaseName,by:auditActor()})})).json();
  if(result.authFailed){await load();return alert(result.error||'The CRM token has expired.');}
  if(!result.ok)return alert(result.error||'The release could not be closed.');
  for(const row of result.results||[]){const chat=DATA.chats.find(item=>item.id===row.id);if(chat)chat.status='closed';}
  RELEASE_FOLLOWUPS=null;await renderReleases();alert(releaseName+' is closed. All mapped tickets are closed in the CRM.');
}
async function deleteReleaseFollowup(id){const item=RELEASE_FOLLOWUPS.find(row=>row.id===id);if(!item||!confirm('Delete the PR #'+item.prNumber+' mapping? Ticket and CRM data will not be deleted.'))return;const result=await (await fetch('/api/release-followups/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,by:auditActor()})})).json();if(!result.ok)return alert(result.error||'Could not delete the mapping.');RELEASE_FOLLOWUPS=null;EDIT_RELEASE=null;renderReleases();}

/* ---------- Feature proposals ---------- */
const PROP_STATUS={draft:'Draft',ready:'Ready for sign-off',changes_requested:'Changes requested',approved:'Approved',declined:'Declined',planned:'Planned',completed:'Completed'};
const PROP_COLOR={draft:'badge-ghost',ready:'badge-warning',changes_requested:'badge-info',approved:'badge-success',declined:'badge-error',planned:'badge-primary',completed:'badge-neutral'};
async function ensureProposals(){ if(!PROPOSALS)PROPOSALS=(await (await fetch('/api/proposals')).json()).proposals||[]; }
function proposalTab(view,label,count){return \`<button class="btn btn-sm \${PROPVIEW===view?'btn-neutral':'btn-ghost'}" onclick="PROPVIEW='\${view}';renderProposals()">\${label}\${count===undefined?'':' · '+count}</button>\`;}
async function renderProposals(){
  await ensureProposals();
  const ready=PROPOSALS.filter(p=>['ready','declined','approved','completed'].includes(p.status)).length;
  const used=new Set(PROPOSALS.flatMap(p=>p.sourceChatIds||[]));
  const eligibleFeatureIds=new Set(DATA.chats.filter(c=>c.status==='open'&&REVIEW.decisions[c.id]==='keep'&&ticketType(c)==='feature').map(c=>c.id));
  const candidates=DATA.chats.filter(c=>eligibleFeatureIds.has(c.id)&&!used.has(c.id));
  const drafts=PROPOSALS.filter(p=>['draft','changes_requested','planned'].includes(p.status)&&(p.sourceChatIds||[]).some(id=>eligibleFeatureIds.has(id)));
  if(PROPVIEW==='repository')PROPVIEW='candidates';
  const v=document.getElementById('view');
  v.innerHTML=\`<div class="flex items-start justify-between gap-3 flex-wrap mb-4"><div><h1 class="text-2xl font-bold">Feature proposals</h1><p class="text-sm opacity-60">Choose feature requests to prepare, then send finished proposals to Boss review.</p></div><div class="join bg-base-100 rounded-lg">\${proposalTab('candidates','Feature requests',candidates.length+drafts.length)}\${proposalTab('review','Boss review',ready)}</div></div><div id="proposalBody"></div>\`;
  if(PROPVIEW==='edit')renderProposalForm(); else if(PROPVIEW==='review')renderProposalReview(); else renderProposalCandidates(candidates,drafts);
}
function proposalToggle(id,on){if(on)PROPSELECT.add(id);else PROPSELECT.delete(id);const n=document.getElementById('propSelected');if(n)n.textContent=PROPSELECT.size+' selected';}
function renderProposalCandidates(candidates,drafts=[]){
  const body=document.getElementById('proposalBody');
  body.innerHTML=\`<div class="card bg-base-100 shadow-sm"><div class="card-body p-4"><div class="flex items-center gap-2 flex-wrap mb-2"><span id="propSelected" class="text-sm font-semibold">\${PROPSELECT.size} selected</span><span class="text-xs opacity-55">\${DATA.aiAvailable?'AI available via '+esc(DATA.aiSource):'No authenticated AI provider'}</span><button class="btn btn-sm btn-primary ml-auto" onclick="draftProposalWithAi()" aria-disabled="\${!DATA.aiAvailable}" title="\${DATA.aiAvailable?'Draft using '+esc(DATA.aiSource):'Configure or sign in to an AI provider first'}" \${DATA.aiAvailable?'':'disabled'}>✦ Draft selected</button><button class="btn btn-sm btn-success" onclick="draftAllFeatureProposals()" aria-disabled="\${!DATA.aiAvailable}" title="Draft every unassigned Feature request and send it to Boss review" \${DATA.aiAvailable?'':'disabled'}>✦ Draft all for boss review</button><button class="btn btn-sm" onclick="beginManualProposal()">Create blank proposal</button></div>\${DATA.aiAvailable?'':'<div class="alert py-2 text-sm mb-2">AI drafting is unavailable, but proposals can still be created manually.</div>'}<div class="overflow-x-auto"><table class="table table-sm"><thead><tr><th></th><th>Feature request</th><th>Client</th><th>Context</th><th></th></tr></thead><tbody>
  \${candidates.sort((a,b)=>new Date(b.last||0)-new Date(a.last||0)).map(c=>\`<tr><td><input type="checkbox" class="checkbox checkbox-sm" \${PROPSELECT.has(c.id)?'checked':''} onchange="proposalToggle('\${c.id}',this.checked)"></td><td><div class="font-semibold">\${esc(c.title||c.ai?.headline||'Feature request')}</div><div class="text-xs opacity-50">\${day(c.last)}</div></td><td>\${esc(clientName(c))}</td><td class="max-w-xl">\${contextHtml(c,160)}</td><td><a class="link link-primary whitespace-nowrap" href="\${c.url}" target="_blank">reply in CRM ↗</a></td></tr>\`).join('')||'<tr><td colspan="5" class="p-5 opacity-60">No feature requests are waiting for a proposal.</td></tr>'}
  </tbody></table></div><div id="proposalStatus" class="text-sm mt-2"></div></div></div>\`;
  if(drafts.length){
    const cards=drafts.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).map(p=>\`<div class="card bg-base-100 shadow-sm mb-3"><div class="card-body p-4">\${proposalDetails(p,true)}<div class="card-actions justify-end mt-3"><button class="btn btn-sm" onclick="EDITING_PROPOSAL=PROPOSALS.find(x=>x.id==='\${p.id}');PROPVIEW='edit';renderProposals()">Edit draft</button><button class="btn btn-sm btn-error btn-outline" onclick="deleteProposal('\${p.id}')">Delete</button></div></div></div>\`).join('');
    body.insertAdjacentHTML('afterbegin',\`<div class="mb-5"><h2 class="text-lg font-bold mb-2">Draft proposals</h2>\${cards}</div>\`);
  }
}
function selectedProposalIds(){return [...PROPSELECT].filter(id=>DATA.chats.some(c=>c.id===id));}
function blankProposal(ids){
  const chats=ids.map(id=>DATA.chats.find(c=>c.id===id)).filter(Boolean);
  return {title:chats.length===1?(chats[0].ai?.headline||chats[0].title||''):'',eli5Summary:'',customerPerspective:'',executiveSummary:'',problem:'',impact:'',scope:'',risks:'',questions:'',priority:'',estimatedDevEffort:'',estimatedStartDate:'',estimatedCompletionDate:'',estimateAssumptions:'',evidence:[],sourceChatIds:ids,status:'draft',author:localStorage.getItem('tidy-staff-name')||''};
}
function beginManualProposal(){EDITING_PROPOSAL=blankProposal(selectedProposalIds());PROPVIEW='edit';renderProposals();}
async function draftProposalWithAi(){
  const ids=selectedProposalIds();if(!ids.length)return alert('Select at least one feature ticket first.');
  const status=document.getElementById('proposalStatus');status.innerHTML='<span class="loading loading-spinner loading-sm"></span> Reading the selected tickets and drafting a proposal…';
  const result=await (await fetch('/api/proposals/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids})})).json();
  if(!result.ok){status.textContent=result.error||'The draft could not be generated.';return;}
  EDITING_PROPOSAL={...blankProposal(ids),...result.proposal};PROPVIEW='edit';renderProposals();
}
async function draftAllFeatureProposals(){
  if(!DATA.aiAvailable)return alert('Configure or sign in to an AI provider first.');
  if(!confirm('Draft every unassigned Feature request and send all proposals directly to Boss review?\\n\\nEach proposal will include indicative development effort and dates.'))return;
  const status=document.getElementById('proposalStatus');status.innerHTML='<span class="loading loading-spinner loading-sm"></span> Drafting boss-ready proposals. This can take several minutes…';
  const result=await (await fetch('/api/run/draft-feature-proposals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:auditActor()})})).json();
  if(!result.ok){status.textContent=(result.output||result.error||'Bulk proposal drafting failed.').trim();return;}
  PROPOSALS=null;PROPSELECT.clear();PROPVIEW='review';await load();
}
const proposalField=(id,label,value,rows=0,help='')=>\`<label class="form-control"><span class="label-text font-semibold mb-1">\${label}</span>\${rows?\`<textarea id="\${id}" class="textarea textarea-bordered w-full" rows="\${rows}">\${esc(value||'')}</textarea>\`:\`<input id="\${id}" class="input input-bordered w-full" value="\${esc(value||'')}">\`}\${help?\`<span class="text-xs opacity-50 mt-1">\${help}</span>\`:''}</label>\`;
function renderProposalForm(){
  const p=EDITING_PROPOSAL||blankProposal([]), body=document.getElementById('proposalBody');
  const sources=(p.sourceChatIds||[]).map(id=>DATA.chats.find(c=>c.id===id)).filter(Boolean);
  body.innerHTML=\`<div class="card bg-base-100 shadow-sm"><div class="card-body p-5"><div class="flex items-center gap-2"><h2 class="text-xl font-bold">\${p.id?'Edit proposal':'New proposal'}</h2>\${p.aiSource?\`<span class="badge badge-outline">Drafted by \${esc(p.aiSource)}</span>\`:''}</div><div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mt-2">
    <div class="lg:col-span-2">\${proposalField('propTitle','Proposal title',p.title)}</div>
    <div class="lg:col-span-2">\${proposalField('propEli5','Simple summary',p.eli5Summary,2,'Explain it plainly in one or two sentences, without jargon.')}</div>
    <div class="lg:col-span-2">\${proposalField('propCustomerPerspective','Customer perspective',p.customerPerspective,3,'Explain what the named customer wants and why, using only names present in the ticket.')}</div>
    <div class="lg:col-span-2">\${proposalField('propSummary','Executive summary',p.executiveSummary,3,'A short boss-friendly explanation of the decision being requested.')}</div>
    \${proposalField('propProblem','Customer problem',p.problem,5)}\${proposalField('propImpact','Expected impact',p.impact,5)}
    \${proposalField('propScope','Proposed first scope and non-goals',p.scope,6)}\${proposalField('propEvidence','Customer evidence',(p.evidence||[]).join('\\n'),6,'One evidence point per line.')}
    \${proposalField('propRisks','Risks and dependencies',p.risks,4)}\${proposalField('propQuestions','Open questions',p.questions,4)}
    \${proposalField('propPriority','Priority recommendation',p.priority,3)}\${proposalField('propEffort','Estimated development effort',p.estimatedDevEffort,0,'Required planning estimate, expressed as a developer-day range.')}
    \${proposalField('propStart','Indicative development start',p.estimatedStartDate,0,'YYYY-MM-DD · assumes approval and capacity are available.')}\${proposalField('propCompletion','Indicative completion',p.estimatedCompletionDate,0,'YYYY-MM-DD · planning guidance, not a delivery commitment.')}
    <div class="lg:col-span-2">\${proposalField('propEstimateAssumptions','Estimate assumptions',p.estimateAssumptions,4,'Required: capacity assumptions, technical unknowns, dependencies, and what could change the dates.')}</div>
    \${proposalField('propAuthor','Prepared by',p.author||localStorage.getItem('tidy-staff-name')||'')}
    </div><div class="mt-4"><div class="text-sm font-semibold mb-2">Source tickets (\${sources.length})</div><div class="flex gap-2 flex-wrap">\${sources.map(c=>\`<a class="badge badge-outline" href="\${c.url}" target="_blank">\${esc(clientName(c))} · \${esc(c.code||day(c.last))} ↗</a>\`).join('')}</div></div>
    <div class="card-actions justify-end mt-5"><button class="btn btn-ghost" onclick="EDITING_PROPOSAL=null;PROPVIEW='candidates';renderProposals()">Cancel</button><button class="btn" onclick="saveProposal('draft')">Save draft</button><button class="btn btn-success" onclick="saveProposal('ready')">Send for sign-off</button></div><div id="proposalFormStatus" class="text-sm"></div></div></div>\`;
}
function proposalFormValue(id){return document.getElementById(id)?.value.trim()||'';}
async function saveProposal(status){
  const proposal={...EDITING_PROPOSAL,title:proposalFormValue('propTitle'),eli5Summary:proposalFormValue('propEli5'),customerPerspective:proposalFormValue('propCustomerPerspective'),executiveSummary:proposalFormValue('propSummary'),problem:proposalFormValue('propProblem'),impact:proposalFormValue('propImpact'),scope:proposalFormValue('propScope'),evidence:proposalFormValue('propEvidence').split(/\\n+/).map(x=>x.trim()).filter(Boolean),risks:proposalFormValue('propRisks'),questions:proposalFormValue('propQuestions'),priority:proposalFormValue('propPriority'),estimatedDevEffort:proposalFormValue('propEffort'),estimatedStartDate:proposalFormValue('propStart'),estimatedCompletionDate:proposalFormValue('propCompletion'),estimateAssumptions:proposalFormValue('propEstimateAssumptions'),author:proposalFormValue('propAuthor'),status};
  if(!proposal.title)return alert('Add a proposal title first.');if(status==='ready'&&(!proposal.eli5Summary||!proposal.customerPerspective))return alert('Add the simple summary and customer perspective before sending for sign-off.');if(!proposal.estimatedDevEffort||!proposal.estimatedStartDate||!proposal.estimatedCompletionDate||!proposal.estimateAssumptions)return alert('Add the required development effort, dates, and estimate assumptions.');localStorage.setItem('tidy-staff-name',proposal.author);
  const result=await (await fetch('/api/proposals/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposal})})).json();
  if(!result.ok)return alert(result.error||'The proposal could not be saved.');PROPOSALS=null;EDITING_PROPOSAL=null;PROPSELECT.clear();PROPVIEW=status==='ready'?'review':'candidates';renderProposals();
}
function proposalStatusBadge(p){return \`<span class="badge \${PROP_COLOR[p.status]||'badge-ghost'}">\${esc(PROP_STATUS[p.status]||p.status)}</span>\`;}
function proposalDetails(p,compact=false){
  const section=(title,text)=>text?\`<div><h4 class="text-xs uppercase tracking-wide opacity-45 font-semibold mt-3">\${title}</h4><div class="whitespace-pre-wrap text-sm">\${esc(text)}</div></div>\`:'';
  const sources=(p.sourceChatIds||[]).map(id=>DATA.chats.find(c=>c.id===id)).filter(Boolean);
  const estimate=\`<div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3"><div class="bg-base-200 rounded-lg p-3"><div class="text-[10px] uppercase opacity-50 font-semibold">Estimated effort</div><div class="font-semibold">\${esc(p.estimatedDevEffort||'Not estimated')}</div></div><div class="bg-base-200 rounded-lg p-3"><div class="text-[10px] uppercase opacity-50 font-semibold">Indicative start</div><div class="font-semibold">\${esc(p.estimatedStartDate||'Not estimated')}</div></div><div class="bg-base-200 rounded-lg p-3"><div class="text-[10px] uppercase opacity-50 font-semibold">Indicative completion</div><div class="font-semibold">\${esc(p.estimatedCompletionDate||'Not estimated')}</div></div></div>\${section('Estimate assumptions',p.estimateAssumptions)}<div class="text-[11px] opacity-50 mt-1">Planning estimate only—not a delivery commitment.</div>\`;
  return \`<div class="flex items-start gap-2"><div class="flex-1"><h3 class="text-lg font-bold">\${esc(p.title)}</h3><div class="text-xs opacity-50">Prepared by \${esc(p.author||'Staff')} · updated \${day(p.updatedAt)}</div></div>\${proposalStatusBadge(p)}</div>\${section('Simple summary',p.eli5Summary)}\${section('Customer perspective',p.customerPerspective)}\${section('Executive summary',p.executiveSummary)}\${section('Customer problem',p.problem)}\${section('Expected impact',p.impact)}\${estimate}\${compact?'':section('Proposed scope',p.scope)+section('Evidence',(p.evidence||[]).map(x=>'• '+x).join('\\n'))+section('Risks and dependencies',p.risks)+section('Open questions',p.questions)+section('Priority recommendation',p.priority)}<div class="flex gap-2 flex-wrap mt-3">\${sources.map(c=>\`<a class="badge badge-outline" href="\${c.url}" target="_blank">\${esc(clientName(c))} ↗</a>\`).join('')}</div>\`;
}
function proposalHistoryLabel(h){return PROP_STATUS[h.outcome||h.status]||h.action;}
function openProposalSources(p){return (p.sourceChatIds||[]).map(id=>DATA.chats.find(c=>c.id===id)).filter(c=>c&&c.status==='open');}
function renderProposalRepository(){
  const body=document.getElementById('proposalBody');
  body.innerHTML=PROPOSALS.length?PROPOSALS.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).map(p=>{const openSources=openProposalSources(p);return \`<div class="card bg-base-100 shadow-sm mb-3"><div class="card-body p-5">\${proposalDetails(p)}<div class="card-actions justify-end mt-3"><details class="dropdown dropdown-top"><summary class="btn btn-sm btn-ghost">Decision history</summary><div class="dropdown-content bg-white text-slate-900 border rounded-box shadow-xl p-3 w-80 z-40">\${(p.history||[]).slice().reverse().map(h=>\`<div class="text-xs mb-2"><b>\${esc(proposalHistoryLabel(h))}</b> · \${esc(h.by)} · \${day(h.at)}\${h.comment?\`<div class="opacity-70">\${esc(h.comment)}</div>\`:''}</div>\`).join('')||'No history yet.'}</div></details>\${p.status==='approved'&&openSources.length?\`<button class="btn btn-sm btn-warning" onclick="closeProposalSources('\${p.id}',true)">Close source tickets (\${openSources.length})</button>\`:''}\${p.status==='approved'?\`<button class="btn btn-sm btn-success" onclick="completeProposal('\${p.id}')">Mark feature completed</button>\`:''}<button class="btn btn-sm" onclick="EDITING_PROPOSAL=PROPOSALS.find(x=>x.id==='\${p.id}');PROPVIEW='edit';renderProposals()">Edit</button><button class="btn btn-sm btn-error btn-outline" onclick="deleteProposal('\${p.id}')">Delete proposal</button></div></div></div>\`;}).join(''):'<div class="card bg-base-100"><div class="card-body opacity-60">No proposals yet. Start from Feature requests.</div></div>';
}
async function deleteProposal(id){
  const proposal=PROPOSALS.find(p=>p.id===id);if(!proposal)return;
  const count=(proposal.sourceChatIds||[]).length;
  if(!confirm('Delete "'+proposal.title+'"?\\n\\n'+count+' source ticket'+(count===1?'':'s')+' will return to Feature requests.'))return;
  const result=await (await fetch('/api/proposals/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,by:auditActor()})})).json();
  if(!result.ok)return alert(result.error||'The proposal could not be deleted.');PROPOSALS=null;PROPVIEW='candidates';renderProposals();
}
async function completeProposal(id){
  const proposal=PROPOSALS.find(p=>p.id===id);if(!proposal||!confirm('Mark "'+proposal.title+'" as completed?\\n\\nUse this when the approved feature has actually been delivered.'))return;
  const result=await (await fetch('/api/proposals/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status:'completed',by:auditActor(),comment:'Feature marked completed.'})})).json();
  if(!result.ok)return alert(result.error||'The proposal could not be completed.');PROPOSALS=null;renderProposals();
}
async function closeProposalSources(id,ask=false,by=null){
  const proposal=(PROPOSALS||[]).find(p=>p.id===id);if(!proposal)return false;
  const ids=openProposalSources(proposal).map(c=>c.id);if(!ids.length)return true;
  if(ask&&!confirm('Close '+ids.length+' source ticket'+(ids.length===1?'':'s')+' in the CRM?'))return false;
  if(!DATA.crmAvailable){alert('The source tickets are still open.\\n\\n'+(DATA.crmReason||'CRM access is unavailable')+' Use the Token button, then retry.');return false;}
  const result=await (await fetch('/api/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,by:by||auditActor()})})).json();
  if(result.error){alert('The source tickets could not be closed.\\n\\n'+result.error);return false;}
  const failed=(result.results||[]).filter(x=>!x.ok);await run('sync',true);await load();
  if(failed.length)alert((ids.length-failed.length)+'/'+ids.length+' source tickets closed. '+failed.length+' failed and can be retried from Boss review.');
  return failed.length===0;
}
function renderProposalReviewLegacy(){
  const body=document.getElementById('proposalBody');
  const reviewed=PROPOSALS.filter(p=>['ready','approved','completed'].includes(p.status)).sort((a,b)=>{const rank={ready:0,approved:1,completed:2};return rank[a.status]-rank[b.status]||new Date(b.updatedAt)-new Date(a.updatedAt);});
  body.innerHTML=\`<div class="flex items-center gap-2 mb-3 flex-wrap"><label class="text-sm font-semibold">Reviewer name</label><input id="proposalReviewer" class="input input-sm input-bordered" value="\${esc(localStorage.getItem('tidy-reviewer-name')||'')}"><span class="text-xs opacity-50">Recorded with every decision</span><button class="btn btn-success ml-auto" onclick="exportBossReviewDocx()" \${reviewed.length?'':'disabled'} title="\${reviewed.length?'Create one concise Word decision pack':'Send a proposal for boss review first'}">Export boss review to Word</button></div><div id="bossExportStatus" class="text-sm mb-3"></div>\${reviewed.map(p=>{const openSources=openProposalSources(p);const actions=p.status==='ready'?\`<label class="form-control mt-4"><span class="label-text font-semibold">Decision comment</span><textarea id="decision-\${p.id}" class="textarea textarea-bordered" rows="2" placeholder="Reason, conditions, or requested changes…"></textarea></label><div class="card-actions justify-end mt-3"><button class="btn btn-error btn-outline" onclick="proposalDecision('\${p.id}','declined')">Decline → Draft</button><button class="btn btn-info btn-outline" onclick="proposalDecision('\${p.id}','changes_requested')">Request changes</button><button class="btn btn-success" onclick="proposalDecision('\${p.id}','approved')">Approve & close source tickets</button></div>\`:p.status==='approved'?\`<div class="alert alert-success py-2 mt-4"><span>Approved. \${openSources.length?openSources.length+' source ticket'+(openSources.length===1?' is':'s are')+' still open.':'Source tickets are closed.'}</span></div><div class="card-actions justify-end mt-3">\${openSources.length?\`<button class="btn btn-warning" onclick="closeProposalSources('\${p.id}',true)">Close source tickets (\${openSources.length})</button>\`:''}<button class="btn btn-success" onclick="completeProposal('\${p.id}')">Mark feature completed</button></div>\`:'<div class="alert py-2 mt-4"><span>This approved feature has been marked completed.</span></div>';return \`<div class="card bg-base-100 shadow-sm mb-4"><div class="card-body p-5">\${proposalDetails(p)}\${actions}</div></div>\`;}).join('')||'<div class="card bg-base-100"><div class="card-body opacity-60">Nothing has been sent for boss review yet.</div></div>'}\`;
}
function renderProposalReview(){
  const body=document.getElementById('proposalBody');
  const rank={ready:0,declined:1,approved:2,completed:3};
  const reviewed=PROPOSALS.filter(p=>Object.hasOwn(rank,p.status)).sort((a,b)=>rank[a.status]-rank[b.status]||new Date(b.updatedAt)-new Date(a.updatedAt));
  const cards=reviewed.map(p=>{
    const openSources=openProposalSources(p), closeLabel='Close source ticket'+(openSources.length===1?'':'s')+(openSources.length?' ('+openSources.length+')':'');
    let actions='';
    if(p.status==='ready') actions=\`<label class="form-control mt-4"><span class="label-text font-semibold">Decision note <span class="font-normal opacity-55">(required for decline)</span></span><textarea id="decision-\${p.id}" class="textarea textarea-bordered" rows="2" placeholder="Reason or instructions…"></textarea></label><div class="card-actions justify-end mt-3"><button class="btn" onclick="proposalDecision('\${p.id}','draft')">Send to Draft</button><button class="btn btn-error btn-outline" onclick="proposalDecision('\${p.id}','declined')">Decline</button>\${openSources.length?\`<button class="btn btn-warning" onclick="closeProposalSources('\${p.id}',true)">\${closeLabel}</button>\`:''}<button class="btn btn-success" onclick="proposalDecision('\${p.id}','approved')">Approve & close ticket</button></div>\`;
    else if(p.status==='declined') actions=\`<div class="alert alert-error py-2 mt-4"><span>Declined. The source ticket is \${openSources.length?'still open':'closed'}.</span></div><div class="card-actions justify-end mt-3"><button class="btn" onclick="proposalDecision('\${p.id}','draft')">Send to Draft</button>\${openSources.length?\`<button class="btn btn-warning" onclick="closeProposalSources('\${p.id}',true)">\${closeLabel}</button>\`:''}</div>\`;
    else if(p.status==='approved') actions=\`<div class="alert alert-success py-2 mt-4"><span>Approved. \${openSources.length?openSources.length+' source ticket'+(openSources.length===1?' is':'s are')+' still open.':'Source tickets are closed.'}</span></div><div class="card-actions justify-end mt-3">\${openSources.length?\`<button class="btn btn-warning" onclick="closeProposalSources('\${p.id}',true)">\${closeLabel}</button>\`:''}<button class="btn btn-success" onclick="completeProposal('\${p.id}')">Mark feature completed</button></div>\`;
    else actions='<div class="alert py-2 mt-4"><span>This approved feature has been marked completed.</span></div>';
    return \`<div class="card bg-base-100 shadow-sm mb-4"><div class="card-body p-5">\${proposalDetails(p)}\${actions}</div></div>\`;
  }).join('');
  body.innerHTML=\`<div class="flex items-center gap-2 mb-3 flex-wrap"><label class="text-sm font-semibold">Reviewer name</label><input id="proposalReviewer" class="input input-sm input-bordered" value="\${esc(localStorage.getItem('tidy-reviewer-name')||'')}"><span class="text-xs opacity-50">Recorded with every decision</span><button class="btn btn-success ml-auto" onclick="exportBossReviewMarkdown()" \${reviewed.length?'':'disabled'} title="\${reviewed.length?'Create one plain Markdown decision pack':'Send a proposal for boss review first'}">Export boss review to Markdown</button></div><div id="bossExportStatus" class="text-sm mb-3"></div>\${cards||'<div class="card bg-base-100"><div class="card-body opacity-60">Nothing has been sent for boss review yet.</div></div>'}\`;
}
async function exportBossReviewMarkdown(){
  const status=document.getElementById('bossExportStatus');status.innerHTML='<span class="loading loading-spinner loading-sm"></span> Creating Markdown file…';
  const result=await (await fetch('/api/export-boss-review-markdown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:auditActor()})})).json();
  if(!result.ok){status.textContent=(result.output||result.error||'The Markdown file could not be created.').trim();return;}
  status.innerHTML=result.opened?'Markdown file created and opened.':\`Markdown file created. <a class="link link-primary" href="\${result.download}">Download it</a>.\`;
}
async function proposalDecision(id,status){
  const by=document.getElementById('proposalReviewer')?.value.trim();if(!by)return alert('Enter the reviewer name first.');localStorage.setItem('tidy-reviewer-name',by);
  const comment=document.getElementById('decision-'+id)?.value.trim()||'';
  if(status==='declined'&&!comment)return alert('Add a reason for declining this proposal.');
  const result=await (await fetch('/api/proposals/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status,by,comment})})).json();
  if(!result.ok)return alert(result.error||'The decision could not be saved.');
  if(status==='approved'){PROPOSALS=PROPOSALS.map(p=>p.id===id?result.proposal:p);PROPVIEW='review';await closeProposalSources(id,false,by);PROPOSALS=null;renderProposals();return;}
  PROPOSALS=null;PROPVIEW=status==='draft'?'candidates':'review';renderProposals();
}

/* ---------- Knowledge base tab ---------- */
let KB=null;
async function renderKb(){
  const v=document.getElementById('view');
  if(!KB) KB=await (await fetch('/api/kb')).json();
  const entries=KB.entries||[];
  const cats=[...new Set(entries.map(e=>e.category).filter(Boolean))].sort();
  const clients=[...new Set(entries.map(e=>e.parties).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  v.innerHTML=\`<div class="flex gap-2 mb-3 flex-wrap items-center">
    <input id="kq" class="input input-bordered input-sm w-72" placeholder="search problems, answers, or clients…" oninput="kbSearch()" value="\${esc(window._kq||'')}" autofocus>
    <input id="kp" class="input input-bordered input-sm w-72" placeholder="filter by client…" list="kclients" oninput="kbSearch()" value="\${esc(window._kp||'')}">
    <datalist id="kclients">\${clients.map(c=>\`<option value="\${esc(c)}"></option>\`).join('')}</datalist>
    <select id="kc" class="select select-bordered select-sm" onchange="kbSearch()"><option value="">all categories</option>\${cats.map(c=>\`<option \${window._kc===c?'selected':''}>\${esc(c)}</option>\`).join('')}</select>
    <span class="text-sm opacity-60" id="kcount"></span></div>
    <div id="ksummary" class="mb-3"></div>
    \${entries.length?'<div id="kbres"></div>':'<div class="alert alert-info">No knowledge base yet. Run <code>node build-kb.mjs --fetch</code>, then ask Codex or another AI coding agent to "build the knowledge base" using KB-TASK.md. Then click Knowledge again.</div>'}\`;
  if(entries.length) kbSearch();
}
const KB_STOP=new Set(['the','a','an','to','of','is','it','in','on','for','and','or','my','i','we','how','do','does','can','with','that','this','not','no','why','when','get','getting']);
function kbSearch(){
  const raw=(document.getElementById('kq').value||'').toLowerCase().trim();
  const client=(document.getElementById('kp').value||'').toLowerCase().trim();
  const cat=document.getElementById('kc').value;
  window._kq=raw; window._kp=document.getElementById('kp').value; window._kc=cat;
  // Drop short words + stopwords so they don't broaden the match.
  const terms=raw.split(/\\s+/).filter(t=>t.length>=3 && !KB_STOP.has(t));
  let matches=(KB.entries||[]).filter(e=>(!cat||e.category===cat)&&(!client||(e.parties||'').toLowerCase().includes(client))).map(e=>{
    const q=e.question.toLowerCase(), kw=(e.keywords||[]).join(' ').toLowerCase(), parties=(e.parties||'').toLowerCase();
    const hay=q+' '+e.answer.toLowerCase()+' '+(e.category||'').toLowerCase()+' '+kw+' '+parties;
    const matched=terms.filter(t=>hay.includes(t)).length;
    let score=0;
    for(const t of terms){ score += q.includes(t)?3 : parties.includes(t)?3 : kw.includes(t)?2 : hay.includes(t)?1 : 0; }
    if(raw && q.includes(raw)) score+=10;        // whole phrase in the question
    else if(raw && parties.includes(raw)) score+=8;
    else if(raw && hay.includes(raw)) score+=4;  // whole phrase anywhere
    return {e,score,matched};
  }).filter(x=> terms.length===0 || x.matched===terms.length)  // AND: every term must appear
    .sort((a,b)=>b.score-a.score);
  const res=matches.slice(0,40);
  document.getElementById('kcount').textContent=matches.length+' result'+(matches.length===1?'':'s');
  const areas={}; for(const {e} of matches) areas[e.category||'Other']=(areas[e.category||'Other']||0)+1;
  document.getElementById('ksummary').innerHTML=client&&matches.length
    ? \`<div class="text-sm flex gap-2 items-center flex-wrap"><span class="opacity-60">Recurring areas:</span> \${Object.entries(areas).sort((a,b)=>b[1]-a[1]).map(([name,n])=>\`<span class="badge badge-outline">\${esc(name)} · \${n}</span>\`).join('')}</div>\`
    : '';
  document.getElementById('kbres').innerHTML=res.map(({e})=>\`<div class="card bg-base-100 shadow-sm mb-2"><div class="card-body p-4 gap-1">
    <div class="flex items-start gap-2"><h3 class="font-semibold flex-1">\${esc(e.question)}</h3>
      <span class="badge badge-sm badge-neutral">\${esc(e.category||'')}</span></div>
    <div class="text-sm whitespace-pre-wrap">\${esc(e.answer)}</div>
    <div class="text-xs opacity-50 mt-1">\${esc(e.parties||'')} · \${e.status||''} · <a class="link" href="\${e.sourceUrl}" target="_blank">source ticket ↗</a></div>
  </div></div>\`).join('') || '<div class="opacity-60 p-4">No matches — every word must appear. Try fewer or more general words.</div>';
}

/* ---------- Durable ticket audit history ---------- */
let AUDIT_EVENTS=[];
const auditLabels={status_changed:'Status changed',status_cleared:'Status cleared',manual_type_changed:'Type changed',manual_type_cleared:'Manual type cleared',crm_closed:'Closed in CRM',crm_close_failed:'CRM close failed',crm_reopened:'Reopened in CRM',crm_reopen_failed:'CRM reopen failed',proposal_status_changed:'Proposal status changed',proposal_deleted:'Proposal deleted',release_pr_mapped:'PR mapped',release_pr_unmapped:'PR unmapped',release_customer_responded:'Release reply sent',release_response_reopened:'Release reply reopened',release_closed:'Release closed',release_close_failed:'Release close failed','draft-feature-proposals_completed':'Feature proposals drafted','draft-feature-proposals_failed':'Feature proposal drafting failed',sync_completed:'Sync completed',sync_failed:'Sync failed',summarize_completed:'Summarise completed',summarize_failed:'Summarise failed',report_completed:'Report rebuilt',report_failed:'Report failed',excel_exported:'Excel exported',excel_export_failed:'Excel export failed'};
async function renderAudit(){
  const v=document.getElementById('view');
  v.innerHTML='<div class="flex justify-center p-10"><span class="loading loading-spinner loading-lg"></span></div>';
  const result=await (await fetch('/api/audit')).json();if(TAB!=='audit')return;AUDIT_EVENTS=result.events||[];
  const name=localStorage.getItem('tidy-staff-name')||localStorage.getItem('tidy-reviewer-name')||'';
  v.innerHTML=\`<div class="flex items-start justify-between gap-4 flex-wrap mb-4"><div><h1 class="text-2xl font-bold">Audit history</h1><p class="text-sm opacity-60">Permanent record of ticket-management actions taken in this app.</p></div><label class="form-control"><span class="label-text text-xs">Your name for future actions</span><input class="input input-sm input-bordered w-64" value="\${esc(name)}" placeholder="e.g. Alex" onchange="localStorage.setItem('tidy-staff-name',this.value.trim())"></label></div>
    <div class="flex gap-2 items-center mb-3"><input id="auditQ" class="input input-sm input-bordered w-80" placeholder="Search ticket, person, or action…" oninput="auditRows()"><span id="auditCount" class="text-sm opacity-60"></span></div><div id="auditTable"></div>\`;
  auditRows();
}
function auditRows(){
  const q=(document.getElementById('auditQ')?.value||'').toLowerCase();
  const chats=new Map(DATA.chats.map(c=>[c.id,c]));
  const rows=AUDIT_EVENTS.filter(e=>{const c=chats.get(e.ticketId);return !q||((c?.code||'')+' '+(c?.title||'')+' '+(c?.parties||'')+' '+(e.by||'')+' '+(auditLabels[e.action]||e.action)+' '+(e.from||'')+' '+(e.to||'')).toLowerCase().includes(q);});
  document.getElementById('auditCount').textContent=rows.length+' actions';
  const change=e=>e.action==='status_changed'?((e.from||'Undecided')+' → '+e.to):e.action==='status_cleared'?((e.from||'Status')+' → Undecided'):e.action==='manual_type_changed'?((e.from||'AI type')+' → '+e.to):e.action==='manual_type_cleared'?((e.from||'Manual type')+' → AI type'):e.detail||'';
  document.getElementById('auditTable').innerHTML=\`<div class="overflow-x-auto bg-base-100 rounded-box shadow-sm"><table class="table table-sm"><thead><tr><th>When</th><th>Ticket</th><th>Action</th><th>Change / detail</th><th>By</th></tr></thead><tbody>\${rows.map(e=>{const c=chats.get(e.ticketId);const ticket=e.ticketId?\`<button class="link link-primary text-left" onclick="openConversation('\${e.ticketId}')">\${esc(c?.code||e.ticketId)}</button><div class="text-xs opacity-55 max-w-xs truncate">\${esc(c?.title||'Ticket not in current sync')}</div>\`:'<span class="opacity-50">Application</span>';return \`<tr><td class="whitespace-nowrap text-xs">\${esc(new Date(e.at).toLocaleString())}</td><td>\${ticket}</td><td><span class="badge badge-sm \${e.success===false?'badge-error':['crm_closed','crm_reopened'].includes(e.action)?'badge-success':'badge-ghost'}">\${esc(auditLabels[e.action]||e.action)}</span></td><td class="text-xs">\${esc(change(e))}</td><td>\${esc(e.by||'Staff')}</td></tr>\`;}).join('')||'<tr><td colspan="5" class="p-5 opacity-60">No actions recorded yet.</td></tr>'}</tbody></table></div>\`;
}

/* ---------- Inbox tab ---------- */
// Build controls ONCE; typing only refreshes #tbl (rebuilding the input would drop focus).
function renderInbox(){
  const v=document.getElementById('view');
  const types=['bug','feature','not sure'];
  const selected=Array.isArray(window._fts)?window._fts:(window._ft&&window._ft!=='all type'?[window._ft]:types);
  window._inboxOrder=new Map(DATA.chats.slice().sort((a,b)=>new Date(b.activityLast||b.last||0)-new Date(a.activityLast||a.last||0)).map((chat,index)=>[chat.id,index]));
  v.innerHTML=\`<div class="flex gap-2 mb-3 flex-wrap items-center">
    <input id="q" class="input input-bordered input-sm" placeholder="search tickets and conversations…" oninput="inboxRows()" value="\${esc(window._q||'')}">
    <div class="flex gap-1.5 flex-wrap" aria-label="Filter by type">\${types.map(type=>\`<label class="flex items-center gap-1.5 border border-base-300 rounded-lg px-2 py-1 bg-base-100 cursor-pointer text-sm"><input type="checkbox" class="checkbox checkbox-xs checkbox-primary ift" value="\${type}" \${selected.includes(type)?'checked':''} onchange="inboxRows()"> \${type}</label>\`).join('')}</div>
    <select id="fs" class="select select-bordered select-sm" onchange="inboxRows()">\${['open','all','closed'].map(o=>\`<option \${window._fs===o?'selected':''}>\${o}</option>\`).join('')}</select>
    <label class="flex items-center gap-1.5 text-sm cursor-pointer"><input id="iu" type="checkbox" class="checkbox checkbox-xs" \${window._iu?'checked':''} onchange="inboxRows()"> Include undecided</label>
    <span class="text-sm opacity-60" id="rowcount"></span></div><div id="tbl"></div>\`;
  inboxRows();
}
function inboxRows(){
  window._q=document.getElementById('q').value.toLowerCase();
  window._fts=[...document.querySelectorAll('.ift:checked')].map(el=>el.value); window._fs=document.getElementById('fs').value;window._iu=document.getElementById('iu').checked;
  let rows=DATA.chats.filter(c=>{
    if(window._fs==='open'&&c.status!=='open')return false;
    if(window._fs==='closed'&&c.status!=='closed')return false;
    const decision=REVIEW.decisions[c.id];
    if(!window._iu&&c.status==='open'&&!['close','keep'].includes(decision))return false;
    if(window._fts.length<3&&!window._fts.includes(ticketType(c)))return false;
    if(window._q){const hay=((c.code||'')+' '+c.title+' '+c.parties+' '+(c.ai?.headline||'')+' '+(c.ai?.summary||'')+' '+(c.conversationSearch||'')).toLowerCase();if(!hay.includes(window._q))return false;}
    return true;
  }).sort((a,b)=>(window._inboxOrder?.get(a.id)??Number.MAX_SAFE_INTEGER)-(window._inboxOrder?.get(b.id)??Number.MAX_SAFE_INTEGER));
  document.getElementById('rowcount').textContent=rows.length+(window._iu?' tickets':' managed tickets');
  const stColor=s=>s==='open'?'text-success font-semibold':s==='deleted'?'text-error':'opacity-50';
  const manageCell=c=>c.status==='open'?decisionPicker(c):c.status==='closed'?\`<button class="btn btn-xs btn-success \${DATA.crmAvailable?'':'opacity-60'}" onclick="reopenTicket('\${c.id}')" title="\${DATA.crmAvailable?'Reopen this ticket in the CRM':esc(DATA.crmReason||'CRM access unavailable')}">Reopen</button>\`:'—';
   document.getElementById('tbl').innerHTML=\`<div class="overflow-x-auto bg-base-100 rounded-box shadow-sm"><table class="table table-sm table-pin-rows">
    <thead><tr><th>Ticket</th><th>Last activity</th><th>From</th><th>Headline</th><th>Type</th><th>Manage</th><th>Status</th><th>Context</th><th>CRM</th></tr></thead><tbody>
    \${rows.map(c=>\`<tr class="hover \${c.status==='open'&&REVIEW.decisions[c.id]==='close'?'bg-base-200 opacity-60':''}" title="\${c.status==='open'&&REVIEW.decisions[c.id]==='close'?'Pending close — remains here until the CRM confirms closure':''}"><td class="font-mono text-xs whitespace-nowrap">\${esc(c.code||'')}</td><td class="whitespace-nowrap"><div class="opacity-60">\${day(c.activityLast||c.last)}</div>\${c.activitySource==='app'?'<div class="text-[10px] text-primary">app action</div>':''}</td><td>\${esc(c.parties||'')}</td>
        <td>\${esc(c.ai&&!c.ai.unavailable?c.ai.headline:(c.title||''))}</td><td>\${typePicker(c)}</td><td>\${manageCell(c)}</td>
        <td><span class="\${stColor(c.status)}">\${c.status}</span></td><td class="max-w-md">\${contextHtml(c,240)}</td>
        <td><a class="link link-primary whitespace-nowrap" href="\${c.url}" target="_blank">\${c.status==='closed'?'view CRM ↗':'reply in CRM ↗'}</a></td></tr>\`).join('')}
    </tbody></table></div>\`;
}

function countsFor(list){ let close=0,keep=0; for(const c of list){const d=REVIEW.decisions[c.id]; if(d==='close')close++;else if(d==='keep')keep++;} return {close,keep,undecided:list.length-close-keep}; }
function countText(list){ const x=countsFor(list); return \`close \${x.close} · keep \${x.keep} · outstanding \${x.undecided}\`; }

/* ---------- global decision bar ---------- */
function decidedCloseIds(){ return DATA.chats.filter(c=>c.status==='open'&&REVIEW.decisions[c.id]==='close').map(c=>c.id); }
function footerBar(){
  const f=document.getElementById('foot'); f.classList.remove('hidden'); f.classList.add('flex');
  const list=DATA.chats.filter(c=>c.status==='open'); const nClose=decidedCloseIds().length;
  f.innerHTML=\`<span class="text-sm"><span class="opacity-60">All open:</span> \${countText(list)}</span>
    <div class="dropdown dropdown-top ml-auto">
      <button tabindex="0" class="btn btn-sm bg-white text-slate-900 border-white hover:bg-slate-200 hover:border-slate-200">Developer ▴</button>
      <ul tabindex="0" class="dropdown-content menu bg-white text-slate-900 rounded-box z-50 w-64 p-2 mb-2 shadow-2xl border border-slate-300">
        <li><button onclick="copyCloseDetails()"><span>⌘</span><span><b>Copy close details</b><small class="block text-slate-600 font-normal">IDs and CLI command · \${nClose} selected</small></span></button></li>
      </ul>
    </div>
    <button class="btn btn-sm bg-white text-slate-900 border-white hover:bg-slate-200 hover:border-slate-200 disabled:bg-white/20 disabled:text-white/70 disabled:border-white/30 disabled:opacity-100" onclick="openUndoCloseMarks()" \${nClose?'':'disabled'}>Undo close marks (\${nClose})</button>
    <button class="btn btn-sm btn-success" onclick="closeDecided()">Close \${nClose} in CRM</button>
    <span class="text-sm opacity-70" id="fmsg"></span>\`;
}
function copyText(t,msg){ navigator.clipboard?.writeText(t).then(()=>{const m=document.getElementById('fmsg');if(m)m.textContent=msg;}); }
function copyCloseDetails(){
  const ids=decidedCloseIds(); if(!ids.length)return alert('No chats marked Close.');
  const joined=ids.join(','); copyText('Close IDs ('+ids.length+'):\\n'+joined+'\\n\\nCommand:\\nnode close-chats.mjs --ids '+joined+' --apply','copied close details');
}
function openUndoCloseMarks(){
  const tickets=DATA.chats.filter(chat=>chat.status==='open'&&REVIEW.decisions[chat.id]==='close');if(!tickets.length)return;
  document.getElementById('undoCloseAll').checked=false;document.getElementById('undoCloseList').innerHTML=\`<table class="table table-sm table-pin-rows bg-base-100"><thead><tr><th>Select</th><th>Ticket</th><th>Last activity</th><th>From</th><th>Headline</th><th>Type</th><th>Manage</th><th>Status</th><th>Context</th><th>CRM</th></tr></thead><tbody>\${tickets.map(chat=>\`<tr class="hover"><td><input type="checkbox" class="checkbox checkbox-sm undo-close-ticket" value="\${chat.id}" onchange="updateUndoCloseCount()" aria-label="Select \${esc(chat.code||'ticket')}"></td><td class="font-mono text-xs whitespace-nowrap">\${esc(chat.code||'')}</td><td class="whitespace-nowrap"><div class="opacity-60">\${day(chat.activityLast||chat.last)}</div>\${chat.activitySource==='app'?'<div class="text-[10px] text-primary">app action</div>':''}</td><td>\${esc(chat.parties||'')}</td><td>\${esc(chat.ai&&!chat.ai.unavailable?chat.ai.headline:(chat.title||''))}</td><td>\${typePicker(chat)}</td><td><span class="badge badge-error">Close</span></td><td class="text-success font-semibold">\${esc(chat.status)}</td><td class="max-w-md">\${contextHtml(chat,240)}</td><td><a class="link link-primary whitespace-nowrap" href="\${chat.url}" target="_blank">reply in CRM ↗</a></td></tr>\`).join('')}</tbody></table>\`;updateUndoCloseCount();document.getElementById('undoCloseModal').showModal();
}
function toggleUndoCloseSelection(checked){document.querySelectorAll('.undo-close-ticket').forEach(input=>input.checked=checked);updateUndoCloseCount();}
function updateUndoCloseCount(){const inputs=[...document.querySelectorAll('.undo-close-ticket')],selected=inputs.filter(input=>input.checked).length;document.getElementById('undoCloseCount').textContent=selected+' selected';const all=document.getElementById('undoCloseAll');all.checked=inputs.length>0&&selected===inputs.length;all.indeterminate=selected>0&&selected<inputs.length;}
async function undoSelectedCloseMarks(){
  const ids=[...document.querySelectorAll('.undo-close-ticket:checked')].map(input=>input.value);if(!ids.length)return alert('Select at least one ticket to undo.');
  await Promise.all(ids.map(id=>persistDecision(id,'keep')));document.getElementById('undoCloseModal').close();render();const message=document.getElementById('fmsg');if(message)message.textContent='undid '+ids.length+' Close mark'+(ids.length===1?'':'s');
}
async function closeDecided(){
  const ids=decidedCloseIds(); if(!ids.length)return alert('No chats marked Close.');
  if(!confirm('Close '+ids.length+' chats in the CRM?'))return;
  const m=document.getElementById('fmsg'); m.textContent='closing…';
  const r=await (await fetch('/api/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,by:auditActor()})})).json();
  if(r.error||r.authFailed){m.textContent='error: '+(r.error||'CRM token expired');await load();return alert((r.error||'The CRM rejected the token.')+'\\n\\nUse the Token button to paste a fresh token.');}
  const ok=r.results.filter(x=>x.ok).length;
  for(const x of r.results) if(x.ok) delete REVIEW.decisions[x.id];
  saveReview(); m.textContent=\`closed \${ok}/\${ids.length}. syncing…\`;
  await run('sync',true); await load(); const m2=document.getElementById('fmsg'); if(m2)m2.textContent=\`closed \${ok}/\${ids.length}.\`;
}
async function reopenTicket(id){
  const chat=DATA.chats.find(c=>c.id===id);
  if(!chat||chat.status!=='closed')return alert('This ticket is not currently marked closed. Run Sync if the CRM changed recently.');
  if(!DATA.crmAvailable)return alert((DATA.crmReason||'CRM access is unavailable')+'\\n\\nUse the Token button to paste your CRM refresh token.');
  if(!confirm('Reopen '+(chat.code||chat.title||'this ticket')+' in the CRM?'))return;
  const message=document.getElementById('fmsg');if(message)message.textContent='reopening…';
  const result=await (await fetch('/api/reopen',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[id],by:auditActor()})})).json();
  if(result.error||result.authFailed){if(message)message.textContent='reopen failed';await load();return alert(result.error||'The CRM token has expired. Use the Token button to paste a fresh token.');}
  const outcome=result.results?.[0];
  if(!outcome?.ok){if(message)message.textContent='reopen failed';return alert(outcome?.error||'The CRM did not reopen this ticket.');}
  delete REVIEW.decisions[id];saveReview();if(message)message.textContent='reopened. syncing…';
  await run('sync',true);await load();const current=document.getElementById('fmsg');if(current)current.textContent='ticket reopened.';
}

/* ---------- run scripts ---------- */
async function run(name,quiet){
  const log=document.getElementById('log'); document.getElementById('logpanel').classList.remove('hidden'); log.textContent+='\\n$ '+name+' …\\n';
  const r=await (await fetch('/api/run/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:auditActor()})})).json();
  log.textContent+=(r.output||r.error||'').trim()+'\\n'; log.scrollTop=log.scrollHeight;
  if(r.authFailed){ await load(); alert((r.error||'CRM authentication could not be renewed.')+'\\n\\nUse the Token button to paste your CRM refresh token.'); return; }
  if(!quiet) await load();
}
async function exportExcel(){
  const log=document.getElementById('log'); document.getElementById('logpanel').classList.remove('hidden'); log.textContent+='\\n$ Export to Excel …\\n';
  const r=await (await fetch('/api/export-excel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({by:auditActor()})})).json();
  log.textContent+=(r.output||r.error||'').trim()+'\\n';
  if(r.ok&&r.opened) log.textContent+='Opened inbox-report.xlsx.\\n';
  else if(r.ok){ const a=document.createElement('a'); a.href='/api/report'; a.download='inbox-report.xlsx'; a.click(); log.textContent+='Excel could not be opened automatically, so it was downloaded instead.\\n'; }
  log.scrollTop=log.scrollHeight;
}
function hideLog(){ document.getElementById('logpanel').classList.add('hidden'); }
load();
setInterval(()=>refreshTokenStatus(),5*60*1000);
</script></body></html>`;
