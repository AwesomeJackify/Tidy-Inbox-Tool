// Minimal client for the Tidy CRM gateway.
//
// Auth: the CRM frontend stores a bearer token in the `TidyCore_AccessToken`
// cookie on .tidyint.com. Grab it from devtools and export it as TIDY_TOKEN.

export const API_BASE = process.env.TIDY_API ?? "https://crm-gateway.tidyint.com";

let token = process.env.TIDY_TOKEN;

/** Update the bearer token at runtime (e.g. from the web app when it expires). */
export function setToken(t) {
    token = (t ?? "").trim() || undefined;
    return !!token;
}

/** Whether a token is currently set. */
export function hasToken() {
    return !!token;
}

/** Make a minimal authenticated request so callers can distinguish a stored
 * token from one the CRM currently accepts. */
export async function verifyToken() {
    if (!token) throw new Error("No CRM token is set.");
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
    if (res.status === 401) throw new Error("401 Unauthorized — your CRM token has expired.");
    if (!res.ok) throw new Error(`CRM token check returned ${res.status}.`);
    return true;
}

export function requireToken() {
    if (!token) {
        console.error(
            [
                "TIDY_TOKEN is not set.",
                "",
                "How to get it:",
                "  1. Open https://crm.tidyint.com and log in.",
                "  2. Devtools > Application > Cookies > https://crm.tidyint.com",
                "  3. Copy the value of `TidyCore_AccessToken`.",
                "  4. export TIDY_TOKEN='<paste>'",
                "",
                "(Tokens expire — if you get a 401, grab a fresh one.)",
            ].join("\n"),
        );
        process.exit(1);
    }
}

const MAX_ATTEMPTS = 5; // 1 try + 4 retries — the CRM backend can be flaky under load

async function request(method, path, body, attempt = 1) {
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
        if (attempt < MAX_ATTEMPTS) return retry(method, path, body, attempt, err.message);
        throw err;
    }

    if (res.status === 401) {
        throw new Error("401 Unauthorized — your TIDY_TOKEN has expired. Grab a fresh one from the browser cookie.");
    }
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        // The gateway reports its own backend being down (gRPC "Unavailable",
        // "Connection refused") as an error response — transient, retry.
        const transient = res.status >= 500 || /Unavailable|Connection refused|subchannel/i.test(text);
        if (transient && attempt < MAX_ATTEMPTS) return retry(method, path, body, attempt, `${res.status}`);
        throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function retry(method, path, body, attempt, why) {
    // Back off a bit longer for gateway timeouts — the backend needs breathing room.
    const delay = Math.min(attempt * 2500, 12000);
    console.error(`\n  CRM backend hiccup on ${method} ${path} (${why}) — retrying in ${delay / 1000}s (${attempt}/${MAX_ATTEMPTS - 1})...`);
    await new Promise((r) => setTimeout(r, delay));
    return request(method, path, body, attempt + 1);
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
