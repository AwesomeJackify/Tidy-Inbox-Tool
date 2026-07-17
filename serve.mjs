// Local web app that ties the whole tool together — a personal CRM ticket manager.
//
//   export TIDY_TOKEN=...      (needed for sync / close actions)
//   node serve.mjs             then open http://localhost:8787
//
// It serves a dashboard over the existing data files and exposes the pipeline
// scripts as buttons. No new dependencies — plain node:http. Localhost only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { closeChat, mapLimit, setToken, hasToken } from "./lib/api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = (f) => path.join(here, "data", f);
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

// Scripts the dashboard buttons may run.
const RUNNABLE = new Set(["fetch", "sync", "summarize", "report", "review-bugs"]);

// Current CRM token — starts from env, updatable at runtime via /api/token so a
// mid-session expiry doesn't force a server restart. Used for /api/close (in-memory)
// and injected into spawned scripts' env (sync/fetch).
let currentToken = process.env.TIDY_TOKEN;

const json = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
};

function readData() {
    const inbox = fs.existsSync(dataFile("inbox.json")) ? JSON.parse(fs.readFileSync(dataFile("inbox.json"), "utf8")) : { chats: [] };
    const aiById = fs.existsSync(dataFile("enriched.json"))
        ? new Map(JSON.parse(fs.readFileSync(dataFile("enriched.json"), "utf8")).chats.filter((c) => c.ai).map((c) => [c.id, c.ai]))
        : new Map();
    const verdicts = fs.existsSync(dataFile("bug-verdicts.json")) ? JSON.parse(fs.readFileSync(dataFile("bug-verdicts.json"), "utf8")) : {};

    // Staff detection: a sender who appears across many DIFFERENT customer companies
    // is a Tidy rep. Counting distinct chats fails for prolific customers (all their
    // tickets share one company); counting distinct parties does not.
    const senderParties = new Map();
    for (const c of inbox.chats) {
        for (const m of c.messages ?? []) {
            if (m.isNote || !m.sender) continue;
            if (!senderParties.has(m.sender)) senderParties.set(m.sender, new Set());
            senderParties.get(m.sender).add(c.partiesDescription || "");
        }
    }
    const isStaff = (sender) => (senderParties.get(sender)?.size ?? 0) >= 3;

    const chats = inbox.chats.map((c) => ({
        id: c.id,
        code: c.code ?? null,
        title: c.title,
        parties: c.partiesDescription,
        opened: c.createdDate,
        last: c.mostRecentMessageDate,
        status: c.deleted ? "deleted" : c.closedDate ? "closed" : "open",
        msgs: c.messages?.length ?? 0,
        url: c.url,
        ai: aiById.get(c.id) ?? null,
        bugVerdict: verdicts[c.id]?.verdict ?? null,
        bugReason: verdicts[c.id]?.reason ?? null,
        // recent messages; staff tagged server-side (see isStaff above)
        tail: (c.messages ?? []).filter((m) => !m.isNote).slice(-8).map((m) => ({ sender: m.sender, date: m.date, text: (m.text || "").slice(0, 900), staff: isStaff(m.sender) })),
    }));
    return { syncedAt: inbox.syncedAt ?? inbox.fetchedAt ?? null, hasToken: hasToken(), chats };
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
        if (req.method === "GET" && url.pathname === "/api/kb") {
            const kb = fs.existsSync(dataFile("knowledge.json")) ? JSON.parse(fs.readFileSync(dataFile("knowledge.json"), "utf8")) : { entries: [] };
            return json(res, 200, kb);
        }
        if (req.method === "POST" && url.pathname === "/api/token") {
            const { token } = await body(req);
            currentToken = (token ?? "").trim() || undefined;
            const ok = setToken(currentToken);
            return json(res, 200, { ok, hasToken: ok });
        }
        if (req.method === "POST" && url.pathname === "/api/close") {
            const { ids } = await body(req);
            if (!Array.isArray(ids) || ids.length === 0) return json(res, 400, { error: "no ids" });
            if (!hasToken()) return json(res, 400, { error: "No CRM token set — paste one via the ⚿ Token button." });
            const results = [];
            await mapLimit(ids, 4, async (id) => {
                try {
                    await closeChat(id);
                    results.push({ id, ok: true });
                } catch (err) {
                    results.push({ id, ok: false, error: err.message });
                }
            });
            return json(res, 200, { results });
        }
        if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
            const name = url.pathname.slice("/api/run/".length);
            if (!RUNNABLE.has(name)) return json(res, 400, { error: `unknown script: ${name}` });
            const result = await runScript(name);
            return json(res, 200, result);
        }
        res.writeHead(404).end("not found");
    } catch (err) {
        json(res, 500, { error: err.message });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.error(`Tidy inbox app running at http://localhost:${PORT}`);
    if (!process.env.TIDY_TOKEN) console.error("(No TIDY_TOKEN set — viewing works; paste one via the ⚿ Token button in the app to enable Sync/Close, no restart needed.)");
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
  #log{white-space:pre-wrap}
</style></head>
<body class="bg-base-200 min-h-screen">
<div class="navbar bg-neutral text-neutral-content px-4 gap-2 sticky top-0 z-30 min-h-0 py-2 flex-wrap">
  <span class="font-semibold text-base mr-3">Tidy Inbox</span>
  <button class="btn btn-sm" onclick="run('sync')" title="Push closes + pull changes">↻ Sync</button>
  <button class="btn btn-sm" onclick="run('summarize')">✦ Summarize</button>
  <button class="btn btn-sm" onclick="run('report')">▤ Rebuild sheet</button>
  <button class="btn btn-sm" onclick="run('review-bugs')">🐞 Re-review bugs</button>
  <button class="btn btn-sm ml-auto" onclick="updateToken()" title="Update the CRM access token"><span id="tokdot" class="inline-block w-2 h-2 rounded-full bg-error mr-1"></span>⚿ Token</button>
  <span class="text-xs opacity-70" id="synced"></span>
  <button class="btn btn-sm btn-ghost" onclick="document.getElementById('log').classList.add('hidden')">×log</button>
</div>
<div role="tablist" class="tabs tabs-boxed bg-base-100 px-4 pt-2 sticky top-12 z-20">
  <a role="tab" class="tab tab-active" data-tab="outstanding" onclick="tab('outstanding')">Outstanding</a>
  <a role="tab" class="tab" data-tab="inbox" onclick="tab('inbox')">Inbox</a>
  <a role="tab" class="tab" data-tab="review" onclick="tab('review')">Reviewer</a>
  <a role="tab" class="tab" data-tab="kb" onclick="tab('kb')">Knowledge</a>
</div>
<div class="p-4 pb-24" id="view"></div>
<pre id="log" class="hidden fixed right-3 bottom-16 w-[420px] max-h-[40vh] overflow-auto bg-neutral text-success-content/90 text-xs p-3 rounded-lg z-40 font-mono"></pre>
<div id="foot" class="hidden fixed bottom-0 inset-x-0 bg-neutral text-neutral-content px-4 py-2 items-center gap-3 flex-wrap z-30"></div>
<script>
let DATA={chats:[]}, TAB='outstanding';
const RSTORE='tidy-review';
let REVIEW=Object.assign({filter:'bug',mode:'cards',idx:0,decisions:{}}, JSON.parse(localStorage.getItem(RSTORE)||'{}'));
function saveReview(){ localStorage.setItem(RSTORE, JSON.stringify(REVIEW)); }
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const day=iso=>iso?String(iso).slice(0,10):'';

async function load(){ DATA=await (await fetch('/api/data')).json();
  document.getElementById('synced').textContent = DATA.syncedAt? 'synced '+day(DATA.syncedAt):'no data — run Sync';
  const dot=document.getElementById('tokdot'); dot.className='inline-block w-2 h-2 rounded-full mr-1 '+(DATA.hasToken?'bg-success':'bg-error');
  render(); }
async function updateToken(){
  const t=prompt('Paste a fresh CRM access token\\n(crm.tidyint.com → Devtools → Application → Cookies → TidyCore_AccessToken):');
  if(t===null) return;
  const r=await (await fetch('/api/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t})})).json();
  await load();
  alert(r.hasToken?'Token updated — Sync and Close will use it now (no restart needed).':'Token cleared.');
}
function tab(t){ TAB=t; document.querySelectorAll('[role=tab]').forEach(d=>d.classList.toggle('tab-active',d.dataset.tab===t)); render(); }
function render(){ if(TAB==='outstanding')renderOutstanding(); else if(TAB==='inbox')renderInbox(); else if(TAB==='review')renderReview(); else renderKb(); }

/* ---------- Outstanding tab: open tickets not yet marked keep/close (skip stays) ---------- */
// Build controls ONCE; typing / deciding only refreshes #otbl so the input keeps focus.
function setDecide(id,d){ REVIEW.decisions[id]=d; saveReview(); outstandingRows(); }
function renderOutstanding(){
  document.getElementById('foot').classList.add('hidden');
  const v=document.getElementById('view');
  v.innerHTML=\`<div class="flex gap-2 mb-3 items-center flex-wrap">
    <input id="oq" class="input input-bordered input-sm w-64" placeholder="search…" oninput="outstandingRows()" value="\${esc(window._oq||'')}">
    <span class="text-sm opacity-70" id="ocount"></span></div>
    <div id="otbl"></div>\`;
  outstandingRows();
}
function outstandingRows(){
  const qin=document.getElementById('oq'); window._oq = qin ? qin.value.toLowerCase() : (window._oq||'');
  const list=DATA.chats.filter(c=>{
    if(c.status!=='open') return false;
    const d=REVIEW.decisions[c.id];
    if(d==='close'||d==='keep') return false;                 // decided -> resolved
    if(window._oq){ const hay=((c.code||'')+' '+c.title+' '+c.parties+' '+(c.ai?.summary||'')).toLowerCase(); if(!hay.includes(window._oq)) return false; }
    return true;
  }).sort((a,b)=>{                                             // undecided before skipped, then oldest first
    const sa=REVIEW.decisions[a.id]==='skip'?1:0, sb=REVIEW.decisions[b.id]==='skip'?1:0;
    return sa-sb || new Date(a.last||0)-new Date(b.last||0);
  });
  const skipped=list.filter(c=>REVIEW.decisions[c.id]==='skip').length;
  document.getElementById('ocount').innerHTML=\`<b>\${list.length}</b> outstanding\${skipped?\` · \${skipped} skipped\`:''} — not yet marked keep or close\`;
  const badge=cls=>cls?\`<span class="badge badge-sm \${cls==='bug'?'badge-error':cls==='feature'?'badge-success':'badge-warning'}">\${cls}</span>\`:'';
  document.getElementById('otbl').innerHTML=\`<div class="overflow-x-auto bg-base-100 rounded-box shadow-sm"><table class="table table-sm table-pin-rows">
    <thead><tr><th>Last activity</th><th>From</th><th>Type</th><th>Last message</th><th>Decide</th><th></th></tr></thead><tbody>
    \${list.map(c=>{const lm=c.tail&&c.tail.length?c.tail[c.tail.length-1]:null;const sk=REVIEW.decisions[c.id]==='skip';
      return \`<tr class="hover \${sk?'opacity-60':''}"><td class="opacity-60 whitespace-nowrap">\${day(c.last)}</td>
      <td>\${esc(c.parties||'')}</td><td>\${badge(c.ai?.classification)}\${sk?' <span class="badge badge-sm badge-ghost">skipped</span>':''}</td>
      <td class="max-w-md"><div class="text-xs opacity-60">\${lm?esc(lm.sender)+(lm.staff?' · Tidy':' · customer'):''}</div>\${esc(c.ai?.headline||(lm?lm.text.slice(0,110):''))}</td>
      <td><div class="join">
        <button class="btn btn-xs join-item btn-error" onclick="setDecide('\${c.id}','close')" title="mark to close">✕</button>
        <button class="btn btn-xs join-item btn-success" onclick="setDecide('\${c.id}','keep')" title="keep (done)">✓</button>
        <button class="btn btn-xs join-item" onclick="setDecide('\${c.id}','skip')" title="skip for now">↷</button>
      </div></td>
      <td><a class="link link-primary whitespace-nowrap" href="\${c.url}" target="_blank">open ↗</a></td></tr>\`;}).join('')
      || '<tr><td colspan="6" class="opacity-60 p-4">Nothing outstanding — everything open is marked keep or close. 🎉</td></tr>'}
    </tbody></table></div>\`;
}

/* ---------- Knowledge base tab ---------- */
let KB=null;
async function renderKb(){
  document.getElementById('foot').classList.add('hidden');
  const v=document.getElementById('view');
  if(!KB) KB=await (await fetch('/api/kb')).json();
  const entries=KB.entries||[];
  const cats=[...new Set(entries.map(e=>e.category).filter(Boolean))].sort();
  v.innerHTML=\`<div class="flex gap-2 mb-3 flex-wrap items-center">
    <input id="kq" class="input input-bordered input-sm w-72" placeholder="search questions & answers…" oninput="kbSearch()" value="\${esc(window._kq||'')}" autofocus>
    <select id="kc" class="select select-bordered select-sm" onchange="kbSearch()"><option value="">all categories</option>\${cats.map(c=>\`<option \${window._kc===c?'selected':''}>\${esc(c)}</option>\`).join('')}</select>
    <span class="text-sm opacity-60" id="kcount"></span></div>
    \${entries.length?'<div id="kbres"></div>':'<div class="alert alert-info">No knowledge base yet. Build it: <code>node build-kb.mjs --fetch</code> (pulls closed tickets), then ask a Claude session to "build the knowledge base" (KB-TASK.md) or set ANTHROPIC_API_KEY and re-run <code>node build-kb.mjs</code>. Then click Knowledge again.</div>'}\`;
  if(entries.length) kbSearch();
}
const KB_STOP=new Set(['the','a','an','to','of','is','it','in','on','for','and','or','my','i','we','how','do','does','can','with','that','this','not','no','why','when','get','getting']);
function kbSearch(){
  const raw=(document.getElementById('kq').value||'').toLowerCase().trim();
  const cat=document.getElementById('kc').value;
  window._kq=raw; window._kc=cat;
  // Drop short words + stopwords so they don't broaden the match.
  const terms=raw.split(/\\s+/).filter(t=>t.length>=3 && !KB_STOP.has(t));
  let res=(KB.entries||[]).filter(e=>!cat||e.category===cat).map(e=>{
    const q=e.question.toLowerCase(), kw=(e.keywords||[]).join(' ').toLowerCase();
    const hay=q+' '+e.answer.toLowerCase()+' '+(e.category||'').toLowerCase()+' '+kw;
    const matched=terms.filter(t=>hay.includes(t)).length;
    let score=0;
    for(const t of terms){ score += q.includes(t)?3 : kw.includes(t)?2 : hay.includes(t)?1 : 0; }
    if(raw && q.includes(raw)) score+=10;        // whole phrase in the question
    else if(raw && hay.includes(raw)) score+=4;  // whole phrase anywhere
    return {e,score,matched};
  }).filter(x=> terms.length===0 || x.matched===terms.length)  // AND: every term must appear
    .sort((a,b)=>b.score-a.score).slice(0,40);
  document.getElementById('kcount').textContent=res.length+(res.length===40?'+ ':' ')+'results';
  document.getElementById('kbres').innerHTML=res.map(({e})=>\`<div class="card bg-base-100 shadow-sm mb-2"><div class="card-body p-4 gap-1">
    <div class="flex items-start gap-2"><h3 class="font-semibold flex-1">\${esc(e.question)}</h3>
      <span class="badge badge-sm badge-neutral">\${esc(e.category||'')}</span></div>
    <div class="text-sm whitespace-pre-wrap">\${esc(e.answer)}</div>
    <div class="text-xs opacity-50 mt-1">\${esc(e.parties||'')} · \${e.status||''} · <a class="link" href="\${e.sourceUrl}" target="_blank">source ticket ↗</a></div>
  </div></div>\`).join('') || '<div class="opacity-60 p-4">No matches — every word must appear. Try fewer or more general words.</div>';
}

/* ---------- Inbox tab ---------- */
// Build controls ONCE; typing only refreshes #tbl (rebuilding the input would drop focus).
function renderInbox(){
  document.getElementById('foot').classList.add('hidden');
  const v=document.getElementById('view');
  v.innerHTML=\`<div class="flex gap-2 mb-3 flex-wrap items-center">
    <input id="q" class="input input-bordered input-sm" placeholder="search…" oninput="inboxRows()" value="\${esc(window._q||'')}">
    <select id="ft" class="select select-bordered select-sm" onchange="inboxRows()">\${['all type','bug','feature','not sure'].map(o=>\`<option \${window._ft===o?'selected':''}>\${o}</option>\`).join('')}</select>
    <select id="fs" class="select select-bordered select-sm" onchange="inboxRows()">\${['open','all','closed'].map(o=>\`<option \${window._fs===o?'selected':''}>\${o}</option>\`).join('')}</select>
    <span class="text-sm opacity-60" id="rowcount"></span></div><div id="tbl"></div>\`;
  inboxRows();
}
function inboxRows(){
  window._q=document.getElementById('q').value.toLowerCase();
  window._ft=document.getElementById('ft').value; window._fs=document.getElementById('fs').value;
  let rows=DATA.chats.filter(c=>{
    if(window._fs==='open'&&c.status!=='open')return false;
    if(window._fs==='closed'&&c.status!=='closed')return false;
    if(window._ft!=='all type'&&(c.ai?.classification||'')!==window._ft)return false;
    if(window._q){const hay=((c.code||'')+' '+c.title+' '+c.parties+' '+(c.ai?.headline||'')+' '+(c.ai?.summary||'')).toLowerCase();if(!hay.includes(window._q))return false;}
    return true;
  }).sort((a,b)=>new Date(b.last||0)-new Date(a.last||0));
  document.getElementById('rowcount').textContent=rows.length+' rows';
  const badge=cls=>cls?\`<span class="badge badge-sm \${cls==='bug'?'badge-error':cls==='feature'?'badge-success':'badge-warning'}">\${cls}</span>\`:'';
  const stColor=s=>s==='open'?'text-success font-semibold':s==='deleted'?'text-error':'opacity-50';
  document.getElementById('tbl').innerHTML=\`<div class="overflow-x-auto bg-base-100 rounded-box shadow-sm"><table class="table table-sm table-pin-rows">
    <thead><tr><th>Ticket</th><th>Last</th><th>From</th><th>Headline</th><th>Type</th><th>Status</th><th>Summary</th><th></th></tr></thead><tbody>
    \${rows.map(c=>\`<tr class="hover"><td class="font-mono text-xs whitespace-nowrap">\${esc(c.code||'')}</td><td class="opacity-60 whitespace-nowrap">\${day(c.last)}</td><td>\${esc(c.parties||'')}</td>
        <td>\${esc(c.ai?.headline||c.title||'')}</td><td>\${badge(c.ai?.classification)}</td>
        <td class="\${stColor(c.status)}">\${c.status}</td><td class="max-w-md">\${esc(c.ai?.summary||'')}</td>
        <td><a class="link link-primary whitespace-nowrap" href="\${c.url}" target="_blank">open ↗</a></td></tr>\`).join('')}
    </tbody></table></div>\`;
}

/* ---------- Reviewer tab ---------- */
const FILTERS={bug:['bug'],bugfeat:['bug','feature'],feature:['feature'],all:['bug','feature','not sure']};
function reviewList(){
  const want=FILTERS[REVIEW.filter]||FILTERS.bug;
  return DATA.chats.filter(c=>c.status==='open'&&want.includes(c.ai?.classification))
    .sort((a,b)=>new Date(a.last||0)-new Date(b.last||0));
}
function decide(id,d){ if(REVIEW.decisions[id]===d) delete REVIEW.decisions[id]; else REVIEW.decisions[id]=d; saveReview(); }
function threadHtml(c){ return \`<div class="flex flex-col gap-2 mt-2">\${c.tail.map(m=>\`<div class="flex"><div class="bubble \${m.staff?'b-staff':'b-cust'}"><div class="who text-[11px] font-semibold mb-0.5">\${esc(m.sender)} · \${day(m.date)}</div>\${esc(m.text)}</div></div>\`).join('')}</div>\`; }
function verdictHtml(c){ const col={'fixed-unconfirmed':'text-success',unclear:'text-warning',active:'text-error'}[c.bugVerdict]||'';
  return c.bugReason?\`<div class="text-sm font-semibold \${col}">→ \${esc(c.bugReason)}</div>\`:''; }

function renderReview(){
  const v=document.getElementById('view');
  const list=reviewList();
  const seg=(val,label)=>\`<input type="radio" name="mode" class="join-item btn btn-sm" aria-label="\${label}" \${REVIEW.mode===val?'checked':''} onclick="REVIEW.mode='\${val}';saveReview();renderReview()">\`;
  const fopt=(val,label)=>\`<option value="\${val}" \${REVIEW.filter===val?'selected':''}>\${label}</option>\`;
  const controls=\`<div class="flex gap-2 mb-3 flex-wrap items-center">
    <select class="select select-bordered select-sm" onchange="REVIEW.filter=this.value;REVIEW.idx=0;saveReview();renderReview()">
      \${fopt('bug','Bugs')}\${fopt('bugfeat','Bugs + features')}\${fopt('feature','Features')}\${fopt('all','Everything open')}</select>
    <div class="join">\${seg('cards','Cards')}\${seg('swipe','One at a time')}\${seg('summary','Review choices')}</div>
    <span class="text-sm opacity-60">\${list.length} in filter</span></div>\`;

  if(REVIEW.mode==='summary'){ v.innerHTML=controls+summaryHtml(); footerBar(); return; }
  if(REVIEW.mode==='swipe'){ v.innerHTML=controls+'<div id="swipe"></div>'; renderSwipe(list); footerBar(); return; }

  let html=controls;
  const grouped = REVIEW.filter==='bug' && list.some(c=>c.bugVerdict);
  const groups = grouped
    ? [['fixed-unconfirmed','Likely fixed — awaiting confirmation','text-success'],['unclear','Unclear — read first','text-warning'],['active','Still active','text-error']]
    : [['','','']];
  for(const [key,title,color] of groups){
    const inG = grouped ? list.filter(c=>(c.bugVerdict||'')===key) : list;
    if(!inG.length) continue;
    if(title) html+=\`<h2 class="text-base font-semibold mt-6 mb-1 \${color}">\${title} (\${inG.length})</h2>\`;
    for(const c of inG) html+=cardHtml(c);
  }
  v.innerHTML=html; footerBar();
}

const decoBorder={close:'border-l-error',keep:'border-l-success',skip:'border-l-neutral'};
function cardHtml(c){
  const d=REVIEW.decisions[c.id]||'';
  return \`<div class="card bg-base-100 shadow-sm mb-3 border-l-4 \${d?decoBorder[d]:'border-l-transparent'}" id="card-\${c.id}"><div class="card-body p-4 gap-1">
    <h3 class="font-semibold text-sm">\${esc(c.title||'(no subject)')} <span class="opacity-60">— \${esc(c.parties||'')}</span></h3>
    \${verdictHtml(c)}
    \${c.ai?.summary?\`<div class="text-sm opacity-70">\${esc(c.ai.summary)}</div>\`:''}
    \${threadHtml(c)}
    <div class="flex gap-2 mt-2 items-center">
      <button class="btn btn-sm \${d==='close'?'btn-error':'btn-outline'}" onclick="decide('\${c.id}','close');paint('\${c.id}')">✕ Close</button>
      <button class="btn btn-sm \${d==='keep'?'btn-success':'btn-outline'}" onclick="decide('\${c.id}','keep');paint('\${c.id}')">✓ Keep</button>
      <button class="btn btn-sm \${d==='skip'?'btn-neutral':'btn-outline'}" onclick="decide('\${c.id}','skip');paint('\${c.id}')">↷ Skip</button>
      <a class="link link-primary text-xs ml-1" href="\${c.url}" target="_blank">open in CRM ↗</a>
    </div></div></div>\`;
}
function paint(id){ const c=DATA.chats.find(x=>x.id===id); const el=document.getElementById('card-'+id); if(c&&el) el.outerHTML=cardHtml(c); footerBar(); }

function renderSwipe(list){
  const el=document.getElementById('swipe');
  if(!list.length){ el.innerHTML='<div class="card bg-base-100 shadow-sm"><div class="card-body">Nothing in this filter.</div></div>'; return; }
  if(REVIEW.idx>=list.length){
    el.innerHTML=\`<div class="max-w-2xl mx-auto text-center">
      <div class="card bg-base-100 shadow"><div class="card-body items-center">
      <h3 class="text-lg font-semibold">All \${list.length} reviewed 🎉</h3>
      <p class="opacity-60">\${countText(list)}</p>
      <button class="btn btn-success" onclick="REVIEW.mode='summary';saveReview();renderReview()">Review choices →</button>
      <button class="btn btn-ghost btn-sm" onclick="REVIEW.idx=0;saveReview();renderReview()">↻ start over</button>
      </div></div></div>\`;
    return;
  }
  const c=list[REVIEW.idx]; const d=REVIEW.decisions[c.id]||'';
  el.innerHTML=\`<div class="max-w-2xl mx-auto">
    <div class="text-sm opacity-60 mb-2 text-center">\${REVIEW.idx+1} / \${list.length} · \${REVIEW.filter} \${d?'· <b>'+d+'</b>':''}</div>
    <div class="card bg-base-100 shadow-lg border-l-4 \${d?decoBorder[d]:'border-l-transparent'}"><div class="card-body p-4 gap-1">
      <h3 class="font-semibold text-sm">\${esc(c.title||'(no subject)')} <span class="opacity-60">— \${esc(c.parties||'')}</span></h3>
      \${verdictHtml(c)}
      \${c.ai?.summary?\`<div class="text-sm opacity-70">\${esc(c.ai.summary)}</div>\`:''}
      <div class="max-h-[46vh] overflow-auto">\${threadHtml(c)}</div>
      <a class="link link-primary text-xs" href="\${c.url}" target="_blank">open in CRM ↗</a>
    </div></div>
    <div class="flex gap-3 justify-center mt-4">
      <button class="btn btn-error btn-lg" onclick="swipeDecide('close')">✕ Close</button>
      <button class="btn btn-neutral btn-lg" onclick="swipeDecide('skip')">↷ Skip</button>
      <button class="btn btn-success btn-lg" onclick="swipeDecide('keep')">✓ Keep</button>
    </div>
    <div class="text-center mt-2"><button class="btn btn-ghost btn-xs" onclick="swipePrev()">← back</button>
      <button class="btn btn-ghost btn-xs" onclick="swipeNext()">skip without deciding →</button></div>
    <div class="text-center text-xs opacity-40 mt-1">keys: ← Close · ↓ Skip · → Keep · Backspace back</div>
  </div>\`;
}
function swipeDecide(d){ const list=reviewList(); const c=list[REVIEW.idx]; if(!c)return; REVIEW.decisions[c.id]=d; REVIEW.idx++; saveReview(); renderSwipe(reviewList()); footerBar(); }
function swipeNext(){ REVIEW.idx++; saveReview(); renderSwipe(reviewList()); }
function swipePrev(){ if(REVIEW.idx>0)REVIEW.idx--; saveReview(); renderSwipe(reviewList()); }

function countsFor(list){ let close=0,keep=0,skip=0; for(const c of list){const d=REVIEW.decisions[c.id]; if(d==='close')close++;else if(d==='keep')keep++;else if(d==='skip')skip++;} return {close,keep,skip,undecided:list.length-close-keep-skip}; }
function countText(list){ const x=countsFor(list); return \`close \${x.close} · keep \${x.keep} · skip \${x.skip} · undecided \${x.undecided}\`; }

function summaryHtml(){
  const list=reviewList();
  const groups=[['close','To close','text-error'],['keep','Keep open','text-success'],['skip','Skipped','opacity-60'],['','Undecided','opacity-40']];
  let html='';
  for(const [key,title,color] of groups){
    const inG=list.filter(c=>(REVIEW.decisions[c.id]||'')===key);
    if(!inG.length)continue;
    html+=\`<h2 class="text-base font-semibold mt-6 mb-1 \${color}">\${title} (\${inG.length})</h2>\`;
    for(const c of inG) html+=\`<div class="card bg-base-100 shadow-sm mb-2 border-l-4 \${key?decoBorder[key]:'border-l-transparent'}"><div class="card-body p-3 gap-0.5">
      <h3 class="font-semibold text-sm">\${esc(c.title||'(no subject)')} <span class="opacity-60">— \${esc(c.parties||'')}</span>
        <a class="link link-primary text-xs ml-1" href="\${c.url}" target="_blank">↗</a></h3>
      \${verdictHtml(c)}</div></div>\`;
  }
  return html || '<div class="card bg-base-100 shadow-sm"><div class="card-body">No decisions yet — review some in Cards or One-at-a-time mode.</div></div>';
}

/* ---------- footer (reviewer actions) ---------- */
function decidedCloseIds(){ return DATA.chats.filter(c=>c.status==='open'&&REVIEW.decisions[c.id]==='close').map(c=>c.id); }
function footerBar(){
  const f=document.getElementById('foot'); f.classList.remove('hidden'); f.classList.add('flex');
  const list=reviewList(); const nClose=decidedCloseIds().length;
  f.innerHTML=\`<span class="text-sm">\${countText(list)}</span>
    <button class="btn btn-sm ml-auto" onclick="copyCloseIds()">Copy close ids (\${nClose})</button>
    <button class="btn btn-sm" onclick="copyCloseCmd()">Copy close command</button>
    <button class="btn btn-sm btn-success" onclick="closeDecided()">Close \${nClose} in CRM</button>
    <span class="text-sm opacity-70" id="fmsg"></span>\`;
}
function copyText(t,msg){ navigator.clipboard?.writeText(t).then(()=>{const m=document.getElementById('fmsg');if(m)m.textContent=msg;}); }
function copyCloseIds(){ const ids=decidedCloseIds(); if(!ids.length)return alert('No chats marked Close.'); copyText(ids.join(','),'copied '+ids.length+' ids'); }
function copyCloseCmd(){ const ids=decidedCloseIds(); if(!ids.length)return alert('No chats marked Close.'); copyText('node close-chats.mjs --ids '+ids.join(',')+' --apply','copied command'); }
async function closeDecided(){
  const ids=decidedCloseIds(); if(!ids.length)return alert('No chats marked Close.');
  if(!confirm('Close '+ids.length+' chats in the CRM?'))return;
  const m=document.getElementById('fmsg'); m.textContent='closing…';
  const r=await (await fetch('/api/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids})})).json();
  if(r.error){m.textContent='error: '+r.error;return;}
  const ok=r.results.filter(x=>x.ok).length;
  for(const x of r.results) if(x.ok) delete REVIEW.decisions[x.id];
  saveReview(); m.textContent=\`closed \${ok}/\${ids.length}. syncing…\`;
  await run('sync',true); await load(); const m2=document.getElementById('fmsg'); if(m2)m2.textContent=\`closed \${ok}/\${ids.length}.\`;
}

/* ---------- run scripts + keyboard ---------- */
async function run(name,quiet){
  const log=document.getElementById('log'); log.classList.remove('hidden'); log.textContent+='\\n$ '+name+' …\\n';
  const r=await (await fetch('/api/run/'+name,{method:'POST'})).json();
  log.textContent+=(r.output||'').trim()+'\\n'; log.scrollTop=log.scrollHeight;
  if(!quiet) await load();
}
document.addEventListener('keydown',e=>{
  if(TAB!=='review'||REVIEW.mode!=='swipe')return;
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT')return;
  if(e.key==='ArrowLeft'){e.preventDefault();swipeDecide('close');}
  else if(e.key==='ArrowRight'){e.preventDefault();swipeDecide('keep');}
  else if(e.key==='ArrowDown'){e.preventDefault();swipeDecide('skip');}
  else if(e.key==='Backspace'){e.preventDefault();swipePrev();}
});
load();
</script></body></html>`;
