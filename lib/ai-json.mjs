import { spawn } from "node:child_process";
import { codexInvocation, detectAiBackend, parseCustomArgs } from "./ai-backend.mjs";

function parseJson(text) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The AI response did not contain JSON.");
    return JSON.parse(match[0]);
}

function runCommand(command, args, prompt, source, unwrap = (stdout) => stdout, cwd) {
    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
        let stdout = "", stderr = "";
        proc.stdout.on("data", (d) => (stdout += d));
        proc.stderr.on("data", (d) => (stderr += d));
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code !== 0) return reject(new Error(`${source} exited ${code}: ${stderr.slice(0, 300)}`));
            try { resolve(parseJson(unwrap(stdout))); }
            catch (err) { reject(new Error(`${source} returned an invalid draft: ${err.message}`)); }
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
    });
}

export async function runAiJson(prompt, { model = process.env.TIDY_AI_MODEL, preferred, cwd } = {}) {
    const ai = detectAiBackend({ preferred });
    if (!ai.available) throw new Error("No AI provider is available. You can still create the proposal manually.");

    if (ai.backend === "anthropic-api") {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        const client = new Anthropic();
        const response = await client.messages.create({
            model: model || "claude-haiku-4-5",
            max_tokens: 3000,
            messages: [{ role: "user", content: prompt }],
        });
        return { value: parseJson(response.content.find((block) => block.type === "text")?.text), source: ai.source };
    }

    if (ai.backend === "codex") {
        const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", ...(model ? ["--model", model] : []), "-"];
        const invocation = codexInvocation(args);
        return { value: await runCommand(invocation.command, invocation.args, prompt, "Codex", (stdout) => stdout, cwd), source: ai.source };
    }

    if (ai.backend === "claude") {
        const args = ["-p", "--output-format", "json", ...(model ? ["--model", model] : [])];
        const value = await runCommand("claude", args, prompt, "Claude Code", (stdout) => JSON.parse(stdout).result ?? "", cwd);
        return { value, source: ai.source };
    }

    const args = parseCustomArgs(process.env.TIDY_AI_ARGS).map((arg) => arg.replaceAll("{model}", model || ""));
    return { value: await runCommand(process.env.TIDY_AI_COMMAND, args, prompt, process.env.TIDY_AI_NAME || "Custom AI", (stdout) => stdout, cwd), source: ai.source };
}
