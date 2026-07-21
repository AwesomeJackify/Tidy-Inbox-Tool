// Enrich data/inbox.json with AI summaries + bug/feature classification.
// Writes data/enriched.json. Re-runs are incremental: chats whose latest
// message hasn't changed are not re-summarized.
//
// Backends (picked automatically, or force with --backend):
//   codex          — `codex exec`, using your existing Codex login
//   claude         — `claude -p`, using your existing Claude Code login
//   anthropic-api  — Anthropic API, needs ANTHROPIC_API_KEY
//   custom         — any CLI that accepts a prompt on stdin and returns JSON;
//                    configure TIDY_AI_COMMAND and JSON-array TIDY_AI_ARGS
//
// No configured backend? Run fetch.mjs, then ask any capable coding agent to
// "summarize the inbox" using SUMMARIZE-TASK.md.
//
// Usage:
//   node summarize.mjs
//   node summarize.mjs --backend cli --model haiku
//   node summarize.mjs --model claude-haiku-4-5    # cheaper API model
//   node summarize.mjs --force                      # re-summarize everything

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { backupFile } from "./lib/backup.mjs";
import { detectAiBackend, parseCustomArgs } from "./lib/ai-backend.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(here, "data", "inbox.json");
const OUT = path.join(here, "data", "enriched.json");
const TYPES = path.join(here, "data", "ticket-types.json");

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}
const FORCE = process.argv.includes("--force");

// ---------- backend selection ----------

const AI = detectAiBackend({ preferred: argValue("--backend") });
if (!AI.available) {
    console.error(
        [
            "No AI summarization provider is available. Options:",
            "  1. Codex: install Codex CLI and run `codex login`.",
            "  2. Claude: install Claude Code and sign in.",
            "  3. Custom CLI: set TIDY_AI_COMMAND and optional JSON-array TIDY_AI_ARGS.",
            "  4. Anthropic API: set ANTHROPIC_API_KEY.",
            "The app still shows opening-message previews without AI.",
        ].join("\n"),
    );
    process.exit(1);
}

const BACKEND = AI.backend;
const MODEL = argValue("--model") ?? process.env.TIDY_AI_MODEL ?? (BACKEND === "claude" ? "haiku" : BACKEND === "anthropic-api" ? "claude-opus-4-8" : null);
const CONCURRENCY = Number(process.env.TIDY_AI_CONCURRENCY) || (BACKEND === "anthropic-api" ? 4 : BACKEND === "claude" ? 3 : 1);

if (!fs.existsSync(IN)) {
    console.error(`No ${IN} — run \`node fetch.mjs\` first.`);
    process.exit(1);
}

// ---------- shared prompt ----------

const SCHEMA = {
    type: "object",
    properties: {
        headline: {
            type: "string",
            description: "One short line (max ~10 words) capturing what this thread is about. No trailing period.",
        },
        summary: {
            type: "string",
            description:
                "2-4 sentence summary: who contacted us, what they need, what has happened so far, and what (if anything) is still outstanding on our side.",
        },
        classification: {
            type: "string",
            enum: ["bug", "feature", "not sure"],
            description:
                "Only 'bug' if the customer clearly reports broken/incorrect existing behavior. Only 'feature' if they clearly request new functionality. Anything ambiguous, mixed, administrative, sales, or spam -> 'not sure'. Be conservative.",
        },
        actionNeeded: {
            type: "boolean",
            description: "True if the thread still needs a reply or work from our team.",
        },
        suggestClose: {
            type: "boolean",
            description:
                "True ONLY if the thread is clearly finished: resolved and acknowledged by the customer, a dead-end (spam, auto-replies, bounce), or clearly abandoned small-talk with nothing pending. When in doubt, false.",
        },
        closeReason: {
            type: "string",
            description: "If suggestClose is true, one short sentence why. Otherwise empty string.",
        },
    },
    required: ["headline", "summary", "classification", "actionNeeded", "suggestClose", "closeReason"],
    additionalProperties: false,
};

const SYSTEM = `You analyze customer support threads from the CRM inbox of Tidy, a B2B inventory/ERP software company. For each thread you produce a terse triage record for an internal spreadsheet. Be factual and conservative: never guess at classifications, and only suggest closing threads that are unambiguously finished. Notes marked [internal note] are from our own team.`;

function renderChat(chat) {
    const lines = [
        `Thread: ${chat.title || "(no subject)"}`,
        `Parties: ${chat.partiesDescription || "unknown"}`,
        `Opened: ${chat.createdDate ?? "unknown"}  Last activity: ${chat.mostRecentMessageDate ?? "unknown"}`,
        `Status: ${chat.closedDate ? "closed" : "open"}`,
        "",
    ];
    // Keep the transcript bounded: first 2 + last 28 messages, 1500 chars each.
    const msgs = chat.messages;
    const shown = msgs.length <= 30 ? msgs : [...msgs.slice(0, 2), { gap: msgs.length - 30 }, ...msgs.slice(-28)];
    for (const m of shown) {
        if (m.gap) {
            lines.push(`[... ${m.gap} messages omitted ...]`);
            continue;
        }
        const who = m.fromSupport ? `Tidy support (${m.sender})` : `Customer (${m.sender})`;
        const tag = m.isNote ? " [internal note]" : "";
        const files = m.hasFiles ? " [attachment]" : "";
        const text = (m.text || "(empty message)").slice(0, 1500);
        lines.push(`--- ${m.date} | ${who}${tag}${files}`, text, "");
    }
    return lines.join("\n");
}

const FALLBACK = (headline, summary, actionNeeded = true, unavailableReason = null) => ({
    headline,
    summary,
    classification: "not sure",
    actionNeeded,
    suggestClose: false,
    closeReason: "",
    ...(unavailableReason ? { unavailableReason } : {}),
});

function friendlyFailure(err) {
    const detail = String(err?.message || err || "unknown error");
    if (err?.code === "ENOENT" || /exited \d+/i.test(detail)) {
        return `${AI.source || "AI provider"} summarization is unavailable. Check that the provider is installed, configured, and signed in, then try again.`;
    }
    return "The summary could not be generated. Check the summarization setup and try again.";
}

// ---------- backend: Anthropic API ----------

let apiClient = null;
async function summarizeViaApi(chat) {
    if (!apiClient) {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        apiClient = new Anthropic();
    }
    const response = await apiClient.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: renderChat(chat) }],
    });
    if (response.stop_reason === "refusal") {
        return FALLBACK("(refused)", "Model declined to summarize.");
    }
    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    return JSON.parse(text);
}

// ---------- CLI backends ----------

function buildPrompt(chat) {
    return [
        SYSTEM,
        "",
        "Analyze the thread below and respond with ONLY a JSON object (no markdown fences, no prose) with exactly these fields:",
        JSON.stringify(
            Object.fromEntries(Object.entries(SCHEMA.properties).map(([k, v]) => [k, v.enum ? v.enum.join(" | ") + " — " + v.description : v.description])),
            null,
            2,
        ),
        "",
        renderChat(chat),
    ].join("\n");
}

function parseJsonReply(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`no JSON in AI reply: ${String(text || "").slice(0, 200)}`);
    return JSON.parse(match[0]);
}

function runAiCommand(command, args, prompt, source, unwrap = (stdout) => stdout) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d));
        proc.stderr.on("data", (d) => (stderr += d));
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error(`${source} exited ${code}: ${stderr.slice(0, 300)}`));
            try {
                resolve(parseJsonReply(unwrap(stdout)));
            } catch (err) {
                reject(new Error(`bad ${source} output: ${err.message}: ${stdout.slice(0, 200)}`));
            }
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

function summarizeViaClaude(chat) {
    const args = ["-p", "--output-format", "json", ...(MODEL ? ["--model", MODEL] : [])];
    return runAiCommand("claude", args, buildPrompt(chat), "Claude Code", (stdout) => JSON.parse(stdout).result ?? "");
}

function summarizeViaCodex(chat) {
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", ...(MODEL ? ["--model", MODEL] : []), "-"];
    return runAiCommand("codex", args, buildPrompt(chat), "Codex");
}

function summarizeViaCustom(chat) {
    const command = process.env.TIDY_AI_COMMAND;
    const args = parseCustomArgs(process.env.TIDY_AI_ARGS).map((arg) => arg.replaceAll("{model}", MODEL || ""));
    return runAiCommand(command, args, buildPrompt(chat), process.env.TIDY_AI_NAME || "Custom AI");
}

// ---------- run ----------

const summarize = { "anthropic-api": summarizeViaApi, claude: summarizeViaClaude, codex: summarizeViaCodex, custom: summarizeViaCustom }[BACKEND];

const inbox = JSON.parse(fs.readFileSync(IN, "utf8"));
const previous = fs.existsSync(OUT) && !FORCE
    ? new Map(JSON.parse(fs.readFileSync(OUT, "utf8")).chats.map((c) => [c.id, c]))
    : new Map();

const VALID_CLASSIFICATIONS = new Set(["bug", "feature", "not sure"]);
function sanitize(ai) {
    return {
        headline: String(ai.headline ?? "").slice(0, 200),
        summary: String(ai.summary ?? ""),
        classification: VALID_CLASSIFICATIONS.has(ai.classification) ? ai.classification : "not sure",
        actionNeeded: Boolean(ai.actionNeeded),
        suggestClose: Boolean(ai.suggestClose),
        closeReason: String(ai.closeReason ?? ""),
    };
}

const chats = inbox.chats;
console.error(`Summarizing ${chats.length} chats via ${AI.source}${MODEL ? `, model ${MODEL}` : ""}...`);

let done = 0;
let reused = 0;
let failures = 0;
const out = [];
let next = 0;
async function worker() {
    for (;;) {
        const i = next++;
        if (i >= chats.length) return;
        const chat = chats[i];

        const prev = previous.get(chat.id);
        const previousFailed = prev?.ai && (prev.ai.unavailableReason || prev.ai.headline === "(error)" || /^Summarization failed:/i.test(prev.ai.summary || ""));
        if (prev && prev.ai && !previousFailed && prev.mostRecentMessageDate === chat.mostRecentMessageDate) {
            out[i] = { ...chat, ai: prev.ai };
            reused++;
        } else if (chat.messages.length === 0) {
            out[i] = { ...chat, ai: FALLBACK("(no messages)", "Thread has no messages.", false) };
        } else {
            try {
                out[i] = { ...chat, ai: sanitize(await summarize(chat)) };
            } catch (err) {
                failures++;
                if (failures <= 3) console.error(`\n! Chat ${chat.id}: ${friendlyFailure(err)}`);
                else if (failures === 4) console.error("\n! Further summarization errors hidden.");
                out[i] = { ...chat, ai: FALLBACK("Summary unavailable", friendlyFailure(err), true, "summarization") };
            }
        }
        done++;
        process.stderr.write(`\rSummarized: ${done}/${chats.length} (${reused} reused from cache)`);
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write("\n");

backupFile(OUT);
fs.writeFileSync(OUT, JSON.stringify({ ...inbox, model: `${BACKEND}:${MODEL || "default"}`, summarizedAt: new Date().toISOString(), chats: out }, null, 2));
console.error(`Saved -> ${OUT}`);

// AI classification is authoritative when explicitly run: discard every manual
// type so the UI, filters, proposals, and exports all use the new AI result.
backupFile(TYPES);
fs.writeFileSync(TYPES, JSON.stringify({ updatedAt: new Date().toISOString(), types: {} }, null, 2));
console.error("Cleared manual ticket types (AI classifications now take precedence).");

const counts = out.reduce((acc, c) => ((acc[c.ai.classification] = (acc[c.ai.classification] ?? 0) + 1), acc), {});
const closeable = out.filter((c) => c.ai.suggestClose && !c.closedDate).length;
console.error(`Classification: ${JSON.stringify(counts)} | suggested to close: ${closeable}`);
if (failures) console.error(`${failures} summaries unavailable — check the ${AI.source || "AI provider"} setup, then run Summarize again.`);
