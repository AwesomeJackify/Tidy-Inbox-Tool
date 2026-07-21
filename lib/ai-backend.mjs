import { spawnSync } from "node:child_process";

const ALIASES = { api: "anthropic-api", cli: "claude" };

function normalize(name) {
    return ALIASES[name] ?? name;
}

function customArgs(value, fallback) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : fallback;
    } catch {
        return fallback;
    }
}

function probeCodex() {
    const result = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 3000 });
    return result.status === 0;
}

function probeClaude() {
    const result = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 3000 });
    try {
        const status = JSON.parse(result.stdout || "{}");
        return result.status === 0 && status.loggedIn !== false;
    } catch {
        return false;
    }
}

function probeCustom(env) {
    const command = env.TIDY_AI_COMMAND?.trim();
    if (!command) return false;
    const args = customArgs(env.TIDY_AI_CHECK_ARGS, ["--version"]);
    return spawnSync(command, args, { stdio: "ignore", timeout: 3000 }).status === 0;
}

export function parseCustomArgs(value, fallback = []) {
    return customArgs(value, fallback);
}

export function detectAiBackend({ preferred, env = process.env } = {}) {
    const requested = normalize(preferred || env.TIDY_AI_BACKEND || "");
    const providers = {
        "anthropic-api": { source: "Anthropic API", available: Boolean(env.ANTHROPIC_API_KEY) },
        codex: { source: "Codex", available: probeCodex() },
        claude: { source: "Claude Code", available: probeClaude() },
        custom: { source: env.TIDY_AI_NAME?.trim() || "Custom AI", available: probeCustom(env) },
    };

    if (requested) {
        const provider = providers[requested];
        return provider ? { backend: requested, ...provider } : { backend: requested, source: requested, available: false };
    }

    const order = [env.TIDY_AI_COMMAND ? "custom" : null, env.ANTHROPIC_API_KEY ? "anthropic-api" : null, "codex", "claude"].filter(Boolean);
    for (const backend of order) if (providers[backend].available) return { backend, ...providers[backend] };
    return { backend: null, source: null, available: false };
}
