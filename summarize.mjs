// Enrich data/inbox.json with AI summaries + bug/feature classification.
// Writes data/enriched.json. Re-runs are incremental: chats whose latest
// message hasn't changed are not re-summarized.
//
// Backends (picked automatically, or force with --backend):
//   api  — Anthropic API, needs ANTHROPIC_API_KEY (pay per token)
//   cli  — `claude -p` headless mode, runs on your Claude subscription (free,
//          needs the CLI: npm i -g @anthropic-ai/claude-code, then run
//          `claude` once to log in)
//
// No API key and no CLI? Run fetch.mjs, then ask Claude Code to
// "summarize the inbox" — see SUMMARIZE-TASK.md.
//
// Usage:
//   node summarize.mjs
//   node summarize.mjs --backend cli --model haiku
//   node summarize.mjs --model claude-haiku-4-5    # cheaper API model
//   node summarize.mjs --force                      # re-summarize everything

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { backupFile } from "./lib/backup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const IN = path.join(here, "data", "inbox.json");
const OUT = path.join(here, "data", "enriched.json");

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : null;
}
const FORCE = process.argv.includes("--force");

// ---------- backend selection ----------

function cliAvailable() {
    try {
        return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
        return false;
    }
}

let BACKEND = argValue("--backend");
if (!BACKEND) {
    if (process.env.ANTHROPIC_API_KEY) BACKEND = "api";
    else if (cliAvailable()) BACKEND = "cli";
    else {
        console.error(
            [
                "No summarization backend available. Options:",
                "  1. Free (your Claude subscription): npm i -g @anthropic-ai/claude-code",
                "     then run `claude` once to log in, then re-run this script.",
                "  2. API: export ANTHROPIC_API_KEY=sk-ant-...",
                "  3. Free, no install: run fetch.mjs, then ask Claude Code to",
                "     'summarize the inbox' (see SUMMARIZE-TASK.md).",
            ].join("\n"),
        );
        process.exit(1);
    }
}

// Model defaults per backend. CLI accepts aliases (haiku/sonnet/opus).
const MODEL = argValue("--model") ?? (BACKEND === "cli" ? "haiku" : "claude-opus-4-8");
const CONCURRENCY = BACKEND === "cli" ? 3 : 4;

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

const FALLBACK = (headline, summary, actionNeeded = true) => ({
    headline,
    summary,
    classification: "not sure",
    actionNeeded,
    suggestClose: false,
    closeReason: "",
});

// ---------- backend: api ----------

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

// ---------- backend: cli (claude -p, uses your subscription) ----------

function summarizeViaCli(chat) {
    const prompt = [
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

    return new Promise((resolve, reject) => {
        const proc = spawn("claude", ["-p", "--output-format", "json", "--model", MODEL], {
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d));
        proc.stderr.on("data", (d) => (stderr += d));
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
            try {
                const envelope = JSON.parse(stdout);
                const result = envelope.result ?? "";
                // extract the first JSON object from the reply
                const match = result.match(/\{[\s\S]*\}/);
                if (!match) return reject(new Error(`no JSON in CLI reply: ${result.slice(0, 200)}`));
                resolve(JSON.parse(match[0]));
            } catch (err) {
                reject(new Error(`bad CLI output: ${err.message}: ${stdout.slice(0, 200)}`));
            }
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

// ---------- run ----------

const summarize = BACKEND === "cli" ? summarizeViaCli : summarizeViaApi;

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
console.error(`Summarizing ${chats.length} chats via ${BACKEND} backend, model ${MODEL}...`);

let done = 0;
let reused = 0;
const out = [];
let next = 0;
async function worker() {
    for (;;) {
        const i = next++;
        if (i >= chats.length) return;
        const chat = chats[i];

        const prev = previous.get(chat.id);
        if (prev && prev.ai && prev.mostRecentMessageDate === chat.mostRecentMessageDate) {
            out[i] = { ...chat, ai: prev.ai };
            reused++;
        } else if (chat.messages.length === 0) {
            out[i] = { ...chat, ai: FALLBACK("(no messages)", "Thread has no messages.", false) };
        } else {
            try {
                out[i] = { ...chat, ai: sanitize(await summarize(chat)) };
            } catch (err) {
                console.error(`\n! Chat ${chat.id}: ${err.message}`);
                out[i] = { ...chat, ai: FALLBACK("(error)", `Summarization failed: ${err.message}`) };
            }
        }
        done++;
        process.stderr.write(`\rSummarized: ${done}/${chats.length} (${reused} reused from cache)`);
    }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write("\n");

backupFile(OUT);
fs.writeFileSync(OUT, JSON.stringify({ ...inbox, model: `${BACKEND}:${MODEL}`, summarizedAt: new Date().toISOString(), chats: out }, null, 2));
console.error(`Saved -> ${OUT}`);

const counts = out.reduce((acc, c) => ((acc[c.ai.classification] = (acc[c.ai.classification] ?? 0) + 1), acc), {});
const closeable = out.filter((c) => c.ai.suggestClose && !c.closedDate).length;
console.error(`Classification: ${JSON.stringify(counts)} | suggested to close: ${closeable}`);
