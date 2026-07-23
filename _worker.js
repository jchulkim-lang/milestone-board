/**
 * SVN 테이블 편집 보드 — Cloudflare Worker (로직 소스)
 *
 * ※ 이 파일 + index.html 을 build.py 로 합쳐 최종 _worker.js 를 만듭니다.
 *
 * 바인딩/환경변수 (Cloudflare Pages 설정):
 *   - D1 바인딩:  DB
 *   - 변수:       GOOGLE_CLIENT_ID, ALLOWED_DOMAIN, ADMIN_EMAILS(관리자 이메일들, 콤마구분)
 *   - 시크릿:     KAKAOWORK_WEBHOOK_URL, SESSION_SECRET, SYNC_TOKEN(동기화 스크립트용, 선택)
 */

const enc = new TextEncoder();

const INDEX_HTML = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SVN 테이블 편집 보드</title>
<script src="https://accounts.google.com/gsi/client" async defer></script>
<style>
 :root{--bg:#0f1115;--panel:#181b22;--panel2:#1f232c;--line:#2b303b;--ink:#e7eaf0;
  --muted:#9aa3b2;--accent:#ffe94a;--accent-ink:#3a2f00;--free:#37d399;--busy:#ff6b6b;--me:#5b8cff;}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);
  font-family:'Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif;font-size:14px}
 .wrap{max-width:none;margin:0 auto;padding:18px 24px}
 h1{font-size:19px;margin:0 0 4px} .sub{color:var(--muted);font-size:13px;margin-bottom:16px}
 .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--panel);
  border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px}
 .bar label{color:var(--muted)} input{background:var(--panel2);color:var(--ink);
  border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:14px}
 .pill{font-size:12px;color:var(--muted);background:var(--panel2);border:1px solid var(--line);
  border-radius:999px;padding:4px 10px}
 .tag-admin{color:var(--accent);border-color:rgba(255,233,74,.4)}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
 .row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line)}
 .row:last-child{border-bottom:none}
 .tname{flex:1;min-width:0} .tname .f{font-weight:700;font-size:15px;letter-spacing:.2px} .tname .m{font-size:12px;color:var(--muted);margin-top:2px}
 .fn{color:#7cc4ff} .ext{color:var(--muted);font-weight:400} .dir{color:#8b93a3;font-weight:400;font-size:12px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
 .cell{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 11px;min-width:0}
 .cell.mine{border-color:rgba(91,140,255,.5)} .cell.busy{border-color:rgba(255,107,107,.4)}
 .cell .top{display:flex;align-items:center;gap:6px}
 .cell .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:14px}
 .cell .bot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px}
 .badge-sm{font-size:11px;font-weight:700;padding:3px 7px;border-radius:999px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
 .btn-sm{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;white-space:nowrap}
 .btn-sm:hover{border-color:#3a4150} .btn-sm.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700}
 .summary{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-bottom:14px}
 .s-title{color:var(--muted);font-size:13px;font-weight:600;margin-right:4px}
 .s-empty{color:var(--muted);font-size:13px}
 .s-chip{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;color:var(--busy);background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.35)}
 .s-chip.me{color:var(--me);background:rgba(91,140,255,.14);border-color:rgba(91,140,255,.4)}
 .s-file{color:var(--muted);font-weight:400;margin-left:2px}
 .badge{font-size:12px;font-weight:700;padding:4px 9px;border-radius:999px;white-space:nowrap}
 .b-free{color:var(--free);background:rgba(55,211,153,.12);border:1px solid rgba(55,211,153,.35)}
 .b-busy{color:var(--busy);background:rgba(255,107,107,.12);border:1px solid rgba(255,107,107,.35)}
 .b-me{color:var(--me);background:rgba(91,140,255,.14);border:1px solid rgba(91,140,255,.4)}
 .btn{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:8px;
  padding:7px 12px;font-size:13px;cursor:pointer} .btn:hover{border-color:#3a4150}
 .btn-primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:700}
 .btn-x{border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:16px;padding:4px 8px}
 .btn-x:hover{color:var(--busy)}
 .btn:disabled{opacity:.4;cursor:not-allowed}
 .toast{position:fixed;left:50%;top:20px;transform:translateX(-50%);background:#2a1416;
  border:1px solid var(--busy);color:#ffd7d7;padding:13px 18px;border-radius:12px;max-width:520px;
  box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:50;display:none}
 .toast.show{display:block} .foot{color:var(--muted);font-size:12px;margin-top:14px;line-height:1.7}
 .center{min-height:70vh;display:grid;place-items:center;text-align:center}
 .login{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:34px 30px;max-width:360px}
 .login h1{margin-bottom:8px} .login p{color:var(--muted);font-size:13px;margin:0 0 20px}
 .who{display:flex;align-items:center;gap:8px}
</style></head><body>
<div class="wrap"><div id="app"></div></div>
<div class="toast" id="toast"></div>
<script>
const $=s=>document.querySelector(s);
let ME=null, POLL=null, SVN_LOADED=false;
function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function fmtName(name){
  name=String(name||"");
  let dir="",file=name; const s=name.lastIndexOf("/");
  if(s>=0){ dir=name.slice(0,s+1); file=name.slice(s+1); }
  let base=file,ext=""; const d=file.lastIndexOf(".");
  if(d>0){ base=file.slice(0,d); ext=file.slice(d); }
  return (dir?\`<span class="dir">\${esc(dir)}</span>\`:"")+\`<span class="fn">\${esc(base)}</span><span class="ext">\${esc(ext)}</span>\`;
}
function fmtNameCell(name){ // 격자 셀용: 폴더는 빼고 파일명만(전체경로는 title로)
  name=String(name||""); const s=name.lastIndexOf("/"); const file=s>=0?name.slice(s+1):name;
  let base=file,ext=""; const d=file.lastIndexOf("."); if(d>0){ base=file.slice(0,d); ext=file.slice(d); }
  return \`<span class="fn">\${esc(base)}</span><span class="ext">\${esc(ext)}</span>\`;
}
function toast(html){const t=$("#toast");t.innerHTML=html;t.classList.add("show");
  clearTimeout(toast._h);toast._h=setTimeout(()=>t.classList.remove("show"),4600);}

async function boot(){
  const me=await (await fetch("/api/me")).json();
  if(me.authed){ ME=me; renderBoard(); startPoll(); } else { renderLogin(); }
}

/* ---------- 로그인 ---------- */
async function renderLogin(){
  stopPoll();
  const cfg=await (await fetch("/api/public-config")).json();
  $("#app").innerHTML=\`<div class="center"><div class="login">
    <h1>SVN 테이블 편집 보드</h1>
    <p>회사 Google 계정으로 로그인하세요.<br>회사 도메인 계정만 접속됩니다.</p>
    <div id="gbtn"></div>
    <div id="gmsg" style="color:var(--busy);font-size:12px;margin-top:12px"></div>
  </div></div>\`;
  (function init(){
    if(!window.google||!google.accounts){ return setTimeout(init,300); }
    google.accounts.id.initialize({ client_id: cfg.google_client_id, callback: async (resp)=>{
      const r=await fetch("/api/auth/google",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential:resp.credential})});
      const d=await r.json();
      if(d.ok){ boot(); } else { $("#gmsg").textContent=d.error||"로그인 실패"; }
    }});
    google.accounts.id.renderButton($("#gbtn"),{theme:"filled_blue",size:"large",text:"signin_with",shape:"pill"});
  })();
}

/* ---------- 보드 ---------- */
function renderBoard(){
  const adminBadge = ME.is_admin ? \`<span class="pill tag-admin">관리자</span>\` : "";
  const adminBars = ME.is_admin ? \`
    <div class="bar">
      <label>SVN Repo 주소</label>
      <input id="svn" placeholder="svn://... 또는 https://..." style="flex:1;min-width:240px">
      <button class="btn" onclick="saveSvn()">저장</button>
      <span class="pill" id="svnMsg">관리자만 수정 가능 · 목록은 동기화(bat)로 채워집니다</span>
    </div>\` : "";
  $("#app").innerHTML=\`
    <h1>SVN 테이블 편집 보드</h1>
    <div class="sub">누가 어떤 테이블을 쓰는지 실시간으로 표시됩니다. 수정할 때만 <b>사용 시작</b>을 눌러주세요.</div>
    <div class="bar">
      <span class="who"><span class="pill">👤 \${esc(ME.name)} · \${esc(ME.email)}</span>\${adminBadge}</span>
      <button class="btn" onclick="logout()">로그아웃</button>
    </div>
    \${adminBars}
    <div class="summary" id="summary"></div>
    <div class="grid" id="list"></div>
    <div class="foot" id="foot"></div>\`;
  refresh();
}

async function refresh(){
  if(!ME) return;
  const r=await fetch("/api/status");
  if(r.status===401){ ME=null; renderLogin(); return; }
  const d=await r.json();
  if(ME.is_admin && !SVN_LOADED){ const el=$("#svn"); if(el){ el.value=d.svn_repo_url||""; SVN_LOADED=true; } }
  const foot=$("#foot"); if(foot) foot.textContent=d.svn_repo_url? ("SVN: "+d.svn_repo_url):"";
  const sum=$("#summary");
  if(sum){
    const inUse=d.tables.filter(t=>t.in_use);
    let html=\`<span class="s-title">현재 사용 중\${inUse.length?(" · "+inUse.length):""}</span>\`;
    if(inUse.length===0){ html+=\`<span class="s-empty">사용 중인 테이블이 없습니다</span>\`; }
    else{
      html+=inUse.map(t=>{
        const file=String(t.table).split("/").pop();
        return \`<span class="s-chip \${t.user_email===ME.email?'me':''}" title="\${esc(t.table)}">👤 \${esc(t.user_name)}<span class="s-file">· \${esc(file)}</span></span>\`;
      }).join("");
    }
    sum.innerHTML=html;
  }
  const list=$("#list"); if(!list) return;
  list.innerHTML=d.tables.map(t=>{
    const tt=esc(t.table).replace(/'/g,"\\\\'");
    let cls="", badge="", btn="";
    if(!t.in_use){
      badge=\`<span class="badge-sm b-free">● 사용 가능</span>\`;
      btn=\`<button class="btn-sm primary" onclick="start('\${tt}')">시작</button>\`;
    } else if(t.user_email===ME.email){
      cls="mine"; badge=\`<span class="badge-sm b-me" title="내가 사용 중 · 경과 \${t.elapsed}">👤 \${esc(t.user_name)}</span>\`;
      btn=\`<button class="btn-sm" onclick="finish('\${tt}')">종료</button>\`;
    } else {
      cls="busy"; badge=\`<span class="badge-sm b-busy" title="사용 중 · 경과 \${t.elapsed}">👤 \${esc(t.user_name)}</span>\`;
      btn = ME.is_admin ? \`<button class="btn-sm" onclick="finish('\${tt}')">강제종료</button>\` : \`\`;
    }
    return \`<div class="cell \${cls}"><div class="top"><div class="nm" title="\${esc(t.table)}">\${fmtNameCell(t.table)}</div></div>
      <div class="bot">\${badge}\${btn}</div></div>\`;
  }).join("");
}

async function start(table){
  const r=await fetch("/api/start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table})});
  if(r.status===409){const d=await r.json();
    toast(\`⚠️ <b>\${esc(table)}</b> 은(는) 이미 <b>\${esc(d.holder.user_name)}</b>님이 사용 중입니다 (경과 \${d.holder.elapsed}).\`);}
  refresh();
}
async function finish(table){
  const r=await fetch("/api/finish",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({table})});
  if(!r.ok){const d=await r.json();toast(esc(d.error||"종료 실패"));}
  refresh();
}
async function saveSvn(){
  const v=($("#svn").value||"").trim();
  const r=await fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({svn_repo_url:v})});
  const d=await r.json();
  $("#svnMsg").textContent = r.ok && d.ok ? "저장됨 ✓" : (d.error||"저장 실패");
  setTimeout(()=>{const m=$("#svnMsg"); if(m) m.textContent="관리자만 수정 가능 · 알림에도 함께 표시";},2600);
}
async function logout(){ await fetch("/api/logout"); ME=null; SVN_LOADED=false; if(window.google&&google.accounts) google.accounts.id.disableAutoSelect(); renderLogin(); }

function startPoll(){ stopPoll(); POLL=setInterval(refresh,3000); }
function stopPoll(){ if(POLL) clearInterval(POLL); POLL=null; }
boot();
</script>
</body></html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/public-config") return json({ google_client_id: env.GOOGLE_CLIENT_ID || "" });
      if (path === "/api/auth/google" && request.method === "POST") return authGoogle(request, env, url);
      if (path === "/api/logout") return logout(url);
      if (path === "/api/me") return apiMe(request, env);
      // 사내 동기화 스크립트용(사용자 로그인 아님, SYNC_TOKEN 으로 인증)
      if (path === "/api/tables/sync" && request.method === "POST") return apiTablesSync(request, env);

      if (path.startsWith("/api/")) {
        const user = await getUser(request, env);
        if (!user) return json({ ok: false, error: "인증이 필요합니다." }, 401);
        const admin = isAdmin(env, user);

        if (path === "/api/status") return apiStatus(env);
        if (path === "/api/start" && request.method === "POST") return apiStart(request, env, user, url);
        if (path === "/api/finish" && request.method === "POST") return apiFinish(request, env, user, url, admin);
        if (path === "/api/config" && request.method === "GET") return apiGetConfig(env);

        // ---- 관리자 전용 ----
        if (path === "/api/config" && request.method === "POST") {
          if (!admin) return json({ ok: false, error: "관리자만 변경할 수 있습니다." }, 403);
          return apiSetConfig(request, env);
        }
        if (path === "/api/tables/add" && request.method === "POST") {
          if (!admin) return json({ ok: false, error: "관리자만 변경할 수 있습니다." }, 403);
          return apiTableAdd(request, env);
        }
        if (path === "/api/tables/remove" && request.method === "POST") {
          if (!admin) return json({ ok: false, error: "관리자만 변경할 수 있습니다." }, 403);
          return apiTableRemove(request, env);
        }
        return json({ ok: false, error: "not found" }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

/* ---------------- 공통 ---------------- */
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
function b64urlEncode(bytes) {
  let bin = ""; const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToString(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlEncode(sig);
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function nowIso() { return new Date().toISOString(); }

function adminList(env) {
  return (env.ADMIN_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
}
function isAdmin(env, user) {
  return adminList(env).includes((user.email || "").toLowerCase());
}

/* ---------------- 세션 ---------------- */
async function makeSession(user, secret) {
  const payload = { email: user.email, name: user.name, exp: nowSec() + 60 * 60 * 12 };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}
async function readSession(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  if (sig !== await hmac(secret, body)) return null;
  try {
    const p = JSON.parse(b64urlDecodeToString(body));
    if (!p.exp || p.exp < nowSec()) return null;
    return p;
  } catch { return null; }
}
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function sessionCookie(value, url, maxAge) {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `sess=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}
async function getUser(request, env) {
  return await readSession(getCookie(request, "sess"), env.SESSION_SECRET || "dev-secret");
}

/* ---------------- 인증 ---------------- */
async function authGoogle(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const cred = body.credential;
  if (!cred) return json({ ok: false, error: "credential 없음" }, 400);
  const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(cred));
  if (!resp.ok) return json({ ok: false, error: "토큰 검증 실패" }, 401);
  const info = await resp.json();
  if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) return json({ ok: false, error: "클라이언트 불일치" }, 401);
  if (info.email_verified !== "true" && info.email_verified !== true) return json({ ok: false, error: "이메일 미인증" }, 401);
  const domain = (env.ALLOWED_DOMAIN || "").toLowerCase();
  const email = (info.email || "").toLowerCase();
  if (domain && !(email.endsWith("@" + domain) || (info.hd || "").toLowerCase() === domain))
    return json({ ok: false, error: `회사(${domain}) 계정만 접속할 수 있습니다.` }, 403);
  const user = { email, name: info.name || email.split("@")[0] };
  const token = await makeSession(user, env.SESSION_SECRET || "dev-secret");
  return json({ ok: true, user }, 200, { "Set-Cookie": sessionCookie(token, url, 60 * 60 * 12) });
}
function logout(url) { return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", url, 0) }); }
async function apiMe(request, env) {
  const user = await getUser(request, env);
  if (!user) return json({ authed: false });
  return json({ authed: true, email: user.email, name: user.name, is_admin: isAdmin(env, user) });
}

/* ---------------- 현황 ---------------- */
async function apiStatus(env) {
  const tables = (await env.DB.prepare("SELECT table_name, memo FROM tables ORDER BY sort_order, table_name").all()).results || [];
  const editing = (await env.DB.prepare("SELECT table_name, user_email, user_name, started_at, note FROM editing").all()).results || [];
  const emap = {}; for (const e of editing) emap[e.table_name] = e;
  const names = new Set(tables.map(t => t.table_name));
  const rows = tables.map(t => rowOf(t.table_name, t.memo, emap[t.table_name]));
  for (const e of editing) if (!names.has(e.table_name)) rows.push(rowOf(e.table_name, "", e));
  return json({ tables: rows, svn_repo_url: await getSetting(env, "svn_repo_url", "") });
}
function rowOf(name, memo, e) {
  return {
    table: name, memo: memo || "", in_use: !!e,
    user_email: e ? e.user_email : null,
    user_name: e ? (e.user_name || e.user_email) : null,
    started_at: e ? e.started_at : null,
    elapsed: e ? humanDuration(e.started_at) : null,
    note: e ? (e.note || "") : "",
  };
}
async function apiStart(request, env, user, url) {
  const body = await request.json().catch(() => ({}));
  const table = (body.table || "").trim();
  const note = (body.note || "").trim();
  if (!table) return json({ ok: false, error: "table 필수" }, 400);
  const ins = await env.DB.prepare(
    "INSERT INTO editing(table_name,user_email,user_name,started_at,note) VALUES(?,?,?,?,?) ON CONFLICT(table_name) DO NOTHING"
  ).bind(table, user.email, user.name, nowIso(), note).run();
  if (ins.meta.changes === 1) {
    await logHistory(env, table, user.email, "start");
    await notify(env, url, `✏️ [시작] ${table} · ${user.name} · ${hhmm()}`);
    return json({ ok: true });
  }
  const row = await env.DB.prepare("SELECT * FROM editing WHERE table_name=?").bind(table).first();
  if (row && row.user_email === user.email) return json({ ok: true, already_mine: true });
  await logHistory(env, table, user.email, "conflict");
  await notify(env, url, `⚠️ [중복] ${table} · 이미 ${row.user_name || row.user_email}님 사용 중(${humanDuration(row.started_at)}) · 시도 ${user.name}`);
  return json({ ok: false, conflict: true, holder: { user_name: row.user_name || row.user_email, elapsed: humanDuration(row.started_at) } }, 409);
}
async function apiFinish(request, env, user, url, admin) {
  const body = await request.json().catch(() => ({}));
  const table = (body.table || "").trim();
  const row = await env.DB.prepare("SELECT * FROM editing WHERE table_name=?").bind(table).first();
  if (!row) return json({ ok: false, error: "현재 편집 중이 아닙니다." }, 400);
  if (row.user_email !== user.email && !admin)
    return json({ ok: false, error: `${row.user_name || row.user_email}님이 편집 중입니다. 본인 것만 종료할 수 있습니다.` }, 403);
  await env.DB.prepare("DELETE FROM editing WHERE table_name=?").bind(table).run();
  await logHistory(env, table, user.email, "finish");
  await notify(env, url, `✅ [완료] ${table} · ${row.user_name || row.user_email} · 소요 ${humanDuration(row.started_at)}`);
  return json({ ok: true });
}

/* ---------------- 설정/테이블(관리자) ---------------- */
async function apiGetConfig(env) { return json({ svn_repo_url: await getSetting(env, "svn_repo_url", "") }); }
async function apiSetConfig(request, env) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.svn_repo_url === "string") await setSetting(env, "svn_repo_url", body.svn_repo_url.trim());
  return json({ ok: true, svn_repo_url: await getSetting(env, "svn_repo_url", "") });
}
async function apiTableAdd(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = (body.table_name || "").trim();
  const memo = (body.memo || "").trim();
  if (!name) return json({ ok: false, error: "table_name 필수" }, 400);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM tables").first();
  await env.DB.prepare("INSERT INTO tables(table_name,memo,sort_order) VALUES(?,?,?) ON CONFLICT(table_name) DO UPDATE SET memo=excluded.memo")
    .bind(name, memo, (max.m || 0) + 1).run();
  return json({ ok: true });
}
async function apiTableRemove(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = (body.table_name || "").trim();
  if (!name) return json({ ok: false, error: "table_name 필수" }, 400);
  await env.DB.prepare("DELETE FROM tables WHERE table_name=?").bind(name).run();
  await env.DB.prepare("DELETE FROM editing WHERE table_name=?").bind(name).run();
  return json({ ok: true });
}

// 사내 동기화 스크립트가 svn list 결과를 올리는 통로. SYNC_TOKEN 으로 인증.
async function apiTablesSync(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) return json({ ok: false, error: "인증 실패" }, 401);
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body.tables) ? body.tables : null;
  if (!items) return json({ ok: false, error: "tables 배열 필요" }, 400);
  // 목록 전체 교체(편집 중 상태는 보존)
  await env.DB.prepare("DELETE FROM tables").run();
  let i = 0;
  for (const it of items) {
    const name = typeof it === "string" ? it : (it && it.table_name);
    const memo = typeof it === "string" ? "" : ((it && it.memo) || "");
    if (!name) continue;
    i++;
    await env.DB.prepare("INSERT OR IGNORE INTO tables(table_name,memo,sort_order) VALUES(?,?,?)").bind(name, memo, i).run();
  }
  if (typeof body.svn_repo_url === "string") await setSetting(env, "svn_repo_url", body.svn_repo_url.trim());
  return json({ ok: true, count: i });
}

async function getSetting(env, key, dflt) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return r ? r.value : dflt;
}
async function setSetting(env, key, value) {
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
}
async function logHistory(env, table, email, action) {
  try { await env.DB.prepare("INSERT INTO history(table_name,user_email,action,at) VALUES(?,?,?,?)").bind(table, email, action, nowIso()).run(); } catch {}
}

/* ---------------- 카카오워크 ---------------- */
async function notify(env, url, text) {
  const hook = env.KAKAOWORK_WEBHOOK_URL;
  if (!hook) return;
  try {
    await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  } catch {}
}

/* ---------------- 시간 ---------------- */
function hhmm() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().substr(11, 5); }
function humanDuration(startIso) {
  if (!startIso) return "-";
  const secs = Math.max(0, Math.floor((Date.now() - Date.parse(startIso)) / 1000));
  if (secs < 60) return secs + "초";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "분";
  return Math.floor(mins / 60) + "시간 " + (mins % 60) + "분";
}
