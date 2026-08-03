// Minimal client for the Tidy CRM gateway.
//
// Auth: prefer the CRM frontend's `TidyCore_RefreshToken`. The client exchanges
// it for short-lived access tokens and persists each rotated refresh token.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const API_BASE = process.env.TIDY_API ?? "https://crm-gateway.tidyint.com";
export const AUTH_API_BASE = process.env.TIDY_AUTH_API ?? API_BASE.replace("crm-gateway.", "auth-gateway.");
const AUTH_FILE = process.env.TIDY_AUTH_FILE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tidy-auth.json");

let token = process.env.TIDY_TOKEN;
let refreshToken;
let refreshInFlight;

try {
    // Prefer the rotated value on disk. A long-running parent process may still
    // pass the original environment value to child CLI processes.
    refreshToken = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")).refreshToken;
} catch (err) {
    if (err?.code !== "ENOENT") console.error(`Could not read ${AUTH_FILE}: ${err.message}`);
    refreshToken = process.env.TIDY_REFRESH_TOKEN;
}

function jwtExpiresSoon(value, skewSeconds = 30) {
    if (!value) return true;
    try {
        const payload = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
        return !payload.exp || Date.now() >= (payload.exp - skewSeconds) * 1000;
    } catch {
        return true;
    }
}

function saveRefreshToken(value) {
    const temp = `${AUTH_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ refreshToken: value }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, AUTH_FILE);
    fs.chmodSync(AUTH_FILE, 0o600);
}

async function refreshAccessToken(force = false) {
    if (!force && !jwtExpiresSoon(token)) return token;
    if (!refreshToken) return token;
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
        const res = await fetch(`${AUTH_API_BASE}/v1/auth/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`CRM authentication refresh failed (${res.status}): ${detail.slice(0, 300)}`);
        }
        const next = await res.json();
        if (!next?.accessToken || !next?.refreshToken) throw new Error("CRM authentication refresh returned no token pair.");
        token = next.accessToken;
        refreshToken = next.refreshToken;
        saveRefreshToken(refreshToken);
        return token;
    })().finally(() => {
        refreshInFlight = undefined;
    });
    return refreshInFlight;
}

/** Update the bearer token at runtime (e.g. from the web app when it expires). */
export function setToken(t) {
    token = (t ?? "").trim() || undefined;
    return !!token;
}

/** Seed automatic authentication with the browser's TidyCore_RefreshToken. */
export function setRefreshToken(t) {
    refreshToken = (t ?? "").trim() || undefined;
    token = undefined;
    if (refreshToken) saveRefreshToken(refreshToken);
    else {
        try { fs.unlinkSync(AUTH_FILE); } catch (err) { if (err?.code !== "ENOENT") throw err; }
    }
    return !!refreshToken;
}

/** Whether a token is currently set. */
export function hasToken() {
    return !!token || !!refreshToken;
}

export function hasRefreshToken() {
    return !!refreshToken;
}

/** Make a minimal authenticated request so callers can distinguish a stored
 * token from one the CRM currently accepts. */
export async function verifyToken(refreshed = false) {
    await refreshAccessToken();
    if (!token) throw new Error("No CRM refresh token or access token is set.");
    let res;
    try {
        res = await fetch(`${API_BASE}/v1/chats/get`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
                startRow: 0,
                endRow: 1,
                includeClosed: false,
                myChatsOnly: false,
                excludeNonStarred: false,
                excludeOpen: false,
                excludeAwaitingParticipantReply: false,
                excludeParticipantViewed: false,
                excludeAwaitingSupportReply: false,
            }),
            signal: AbortSignal.timeout(3500),
        });
    } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") throw new Error("CRM token check timed out after 3.5 seconds.");
        throw err;
    }
    if (res.status === 401 && refreshToken && !refreshed) {
        await refreshAccessToken(true);
        return verifyToken(true);
    }
    if (res.status === 401) throw new Error("401 Unauthorized — CRM authentication could not be renewed.");
    if (!res.ok) throw new Error(`CRM token check returned ${res.status}.`);
    return true;
}

export function requireToken() {
    if (!token && !refreshToken) {
        console.error(
            [
                "No CRM authentication is configured.",
                "",
                "How to get it:",
                "  1. Open https://crm.tidyint.com and log in.",
                "  2. Devtools > Application > Cookies > https://crm.tidyint.com",
                "  3. Copy the value of `TidyCore_RefreshToken`.",
                "  4. export TIDY_REFRESH_TOKEN='<paste>'",
                "",
                "The rotated refresh token is saved locally in .tidy-auth.json.",
            ].join("\n"),
        );
        process.exit(1);
    }
}

const MAX_ATTEMPTS = 5; // 1 try + 4 retries — the CRM backend can be flaky under load

async function request(method, path, body, attempt = 1, refreshed = false) {
    await refreshAccessToken();
    let res;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method,
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch (err) {
        // network-level failure — retry
        if (attempt < MAX_ATTEMPTS) return retry(method, path, body, attempt, err.message, refreshed);
        throw err;
    }

    if (res.status === 401) {
        if (refreshToken && !refreshed) {
            await refreshAccessToken(true);
            return request(method, path, body, attempt, true);
        }
        throw new Error("401 Unauthorized — CRM authentication could not be renewed.");
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        // The gateway reports its own backend being down (gRPC "Unavailable",
        // "Connection refused") as an error response — transient, retry.
        const transient = res.status >= 500 || /Unavailable|Connection refused|subchannel/i.test(text);
        if (transient && attempt < MAX_ATTEMPTS) return retry(method, path, body, attempt, `${res.status}`, refreshed);
        throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function retry(method, path, body, attempt, why, refreshed) {
    // Back off a bit longer for gateway timeouts — the backend needs breathing room.
    const delay = Math.min(attempt * 2500, 12000);
    console.error(`\n  CRM backend hiccup on ${method} ${path} (${why}) — retrying in ${delay / 1000}s (${attempt}/${MAX_ATTEMPTS - 1})...`);
    await new Promise((r) => setTimeout(r, delay));
    return request(method, path, body, attempt + 1, refreshed);
}

/** Page through POST /v1/chats/get. Returns all ChatDto items.
 *  Smaller pages = lighter backend queries = fewer 504 gateway timeouts; the
 *  full incl-closed pull is heaviest, so it pages in smaller chunks. */
export async function getAllChats({ includeClosed = false, pageSize } = {}) {
    pageSize = pageSize ?? (includeClosed ? 40 : 100);
    const items = [];
    let startRow = 0;

    for (;;) {
        const filter = {
            startRow,
            endRow: startRow + pageSize,
            includeClosed,
            // mirror the frontend defaults for the "All" inbox
            myChatsOnly: false,
            excludeNonStarred: false,
            excludeOpen: false,
            excludeAwaitingParticipantReply: false,
            excludeParticipantViewed: false,
            excludeAwaitingSupportReply: false,
        };

        const res = await request("POST", "/v1/chats/get", filter);
        const page = res?.items ?? [];
        items.push(...page);

        const total = res?.totalItems ?? items.length;
        process.stderr.write(`\rFetched ${items.length}/${total} chats...`);
        if (items.length >= total || page.length === 0) break;
        startRow += pageSize;
    }

    process.stderr.write("\n");
    return items;
}

/** Look up specific chats by ID (returned regardless of open/closed state). */
export async function getChatsByIds(ids) {
    const items = [];
    for (let i = 0; i < ids.length; i += 100) {
        const res = await request("POST", "/v1/chats/get", {
            onlyIncludedIds: true,
            includedIds: ids.slice(i, i + 100),
            includeClosed: true,
            startRow: null,
            endRow: null,
        });
        items.push(...(res?.items ?? []));
    }
    return items;
}

/** All messages for one chat, oldest first. */
export async function getChatMessages(chatId) {
    const res = await request("POST", "/v1/chat-messages/get", {
        chatId,
        includeNotes: true,
        startRow: null, // null start/end = all rows
        endRow: null,
    });
    const items = res?.items ?? [];
    items.sort((a, b) => new Date(a.createdDate) - new Date(b.createdDate));
    return items;
}

export async function closeChat(chatId) {
    await request("POST", `/v1/chats/${chatId}/close`);
}

/** Reopen a previously closed chat. */
export async function reopenChat(chatId) {
    await request("POST", `/v1/chats/${chatId}/reopen`);
}

/** Run tasks with limited concurrency. */
export async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
