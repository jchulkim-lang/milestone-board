/* =====================================================================
 *  _worker.js — 단일 파일 버전 (Cloudflare Pages 고급 모드)
 *  이 파일 하나만 저장소 최상위에 올리면 모든 /api/* 서버 기능이 동작합니다.
 *  (functions 폴더가 필요 없습니다. 정적 파일은 env.ASSETS 가 서빙)
 *  필요한 환경변수: GOOGLE_CLIENT_ID, COMPANY_DOMAIN, SESSION_SECRET, D1 바인딩 DB
 * ===================================================================== */
const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_TTL = 60 * 60 * 12; // 12시간
const SNAPSHOT_MIN_GAP_MS = 10 * 60 * 1000;   // 히스토리 스냅샷 최소 간격(10분)
/* ===== 앱 버전(단일 소스) =====
 * 이 숫자 하나만 올리면 됩니다. 호환을 깨는(구버전이 데이터를 망칠 수 있는) 배포일 때만 올리세요.
 * - 서버는 index.html 을 서빙할 때 __APP_BUILD__ 자리에 이 값을 자동 주입 → 클라이언트 APP_VERSION.
 * - 이 값보다 낮은(=오래된) 클라이언트는 /api/state 접속이 차단됩니다.
 * 형식: YYYYMMDDNN (날짜 8자리 + 그날의 배포 순번 2자리). 자릿수를 줄이면 대소 비교가 깨지니
 *       앞으로도 반드시 10자리로 쓸 것. 예: 2026-08-19 세 번째 배포 → 2026081903
 * 기능이 추가/변경될 때마다 올린다. */
const APP_BUILD = 2026082606;
function clientVersion(request){ const v = parseInt(request.headers.get("X-App-Version") || "0", 10); return isNaN(v) ? 0 : v; }

function b64urlFromBytes(buf){ let s = btoa(String.fromCharCode(...new Uint8Array(buf))); return s.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64urlFromStr(str){ return b64urlFromBytes(enc.encode(str)); }
function bytesFromB64url(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s += "="; const bin = atob(s); const a = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
async function hmacKey(secret){ return crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign","verify"]); }
function json(o, s=200, h={}){ return new Response(JSON.stringify(o), { status:s, headers:{ "content-type":"application/json", ...h } }); }

/* D1 표가 없으면 자동 생성 + 최초 행 보장 (schema.sql 미실행이어도 동작)
 * ※ 최적화(2026-08-22): 예전엔 모든 요청마다 이 함수를 돌렸다. CREATE TABLE IF NOT EXISTS·ALTER TABLE 이
 *   매번 내부 스키마를 훑어 읽기 행 수와 Worker CPU를 크게 잡아먹었다. 지금은 "표/열 없음" 오류가
 *   났을 때만 1회 실행하고 재시도한다(withDb). 정상 운영 중에는 한 번도 호출되지 않는다. */
let DB_READY = false;
async function ensureDb(env){
  if(DB_READY) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT)").run();
  await env.DB.prepare("INSERT OR IGNORE INTO app_state (id,data,version,updated_at,updated_by) VALUES ('main','{\"tasks\":[],\"milestones\":[]}',0,datetime('now'),NULL)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT, last_seen TEXT, role TEXT DEFAULT 'viewer', requested INTEGER DEFAULT 0)").run();
  try{ await env.DB.prepare("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'viewer'").run(); }catch(_){}
  try{ await env.DB.prepare("ALTER TABLE users ADD COLUMN requested INTEGER DEFAULT 0").run(); }catch(_){}
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, version INTEGER, saved_by TEXT, saved_at TEXT)").run();
  DB_READY = true;
}
/* 표/열이 없어서 실패한 경우에만 ensureDb 후 1회 재시도 */
async function withDb(env, fn){
  try{ return await fn(); }
  catch(e){
    const m=String(e && e.message || e);
    if(!/no such table|no such column|has no column/i.test(m)) throw e;
    DB_READY=false; await ensureDb(env); return await fn();
  }
}
function isAdminEmail(env, email){ const list=(env.ADMIN_EMAILS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean); return list.includes((email||"").toLowerCase()); }
async function effectiveRole(env, email){ if(isAdminEmail(env, email)) return "admin"; const r=await env.DB.prepare("SELECT role FROM users WHERE email=?").bind(email).first(); return (r && r.role) || "viewer"; }
function canEdit(role){ return role==="editor" || role==="admin"; }

/* ===== 카카오워크 알림 =====
 *  KAKAO_BOT_KEY(봇 App Key)가 있으면 등록된 멤버(state.notifyEmails)에게 개인 DM.
 *  없으면 KAKAO_WEBHOOK_URL(단톡방)으로 폴백. */
async function dmKakao(env, st, text, blocks){
  const blk = blocks || [{ type:"text", text, markdown:true }];
  const key = env.KAKAO_BOT_KEY;
  if(key){
    const emails = (st && st.notifyEmails) || [];
    for(const email of emails){
      try{
        const ur = await fetch("https://api.kakaowork.com/v1/users.find_by_email?email=" + encodeURIComponent(email), { headers:{ Authorization:"Bearer " + key } });
        const uj = await ur.json(); const uid = uj && uj.user && uj.user.id; if(!uid) continue;
        const cr = await fetch("https://api.kakaowork.com/v1/conversations.open", { method:"POST", headers:{ Authorization:"Bearer " + key, "content-type":"application/json" }, body: JSON.stringify({ user_id: uid }) });
        const cj = await cr.json(); const cid = cj && cj.conversation && cj.conversation.id; if(!cid) continue;
        await fetch("https://api.kakaowork.com/v1/messages.send", { method:"POST", headers:{ Authorization:"Bearer " + key, "content-type":"application/json" }, body: JSON.stringify({ conversation_id: cid, text, blocks: blk }) });
      }catch(_){}
    }
    return;
  }
  if(env.KAKAO_WEBHOOK_URL){ try{ await fetch(env.KAKAO_WEBHOOK_URL, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ text, blocks: blk }) }); }catch(_){} }
}
/* 세그먼트 배열 → 카카오워크 Text Block(inlines). url 있으면 link(짧은 라벨), 없으면 styled */
function textBlock(segs){
  return { type:"text", text: segs.map(s=>s.text).join(""),
    inlines: segs.map(s=> s.url ? { type:"link", text:s.text, url:s.url } : { type:"styled", text:s.text }) };
}
// 저장 시 상태가 '진행 중'·'검토·이슈'·'완료'로 바뀐 Task를 모아 알림
async function notifyStatusChanges(env, oldStr, newStr, who, origin){
  if(!env.KAKAO_BOT_KEY && !env.KAKAO_WEBHOOK_URL) return;
  let o, n; try{ o=JSON.parse(oldStr||"{}"); n=JSON.parse(newStr||"{}"); }catch(_){ return; }
  const oldStatus={}, oldDone={}, oldExists={};
  (o.tasks||[]).forEach(t=>{ oldStatus[t.id]=t.status; oldDone[t.id]=!!t.done; oldExists[t.id]=true; });
  const msName={}; (n.milestones||[]).forEach(m=>{ msName[m.id]=m.name; });
  const WATCH=["진행 중","검토·이슈","완료"];   // 개발: 이 상태로 바뀔 때 알림
  const DOT={"진행 중":"🔵","검토·이슈":"🟠","완료":"🟢"}; // 앱 상태 색과 매칭
  const blocks=[{ type:"text", text:`📌 상태 변경 (${who})` }];
  const preview=[`📌 상태 변경 (${who})`];
  (n.tasks||[]).forEach(t=>{
    // 개발: WATCH 상태로 바뀔 때. 아트: 완료(done) 체크 시.
    let label=null, dot="•";
    if(t.track==="아트"||t.track==="전투"){
      if(oldExists[t.id] && !oldDone[t.id] && t.done){ label=`${t.status} · 완료`; dot="🟢"; }
    } else {
      const prev=oldStatus[t.id];
      if(prev!==undefined && prev!==t.status && WATCH.includes(t.status)){ label=`${prev} → ${t.status}`; dot=DOT[t.status]||"•"; }
    }
    if(label){
      const ms=msName[t.milestoneId]||"-";
      const plan=(t.links && t.links.plan)||"", trello=(t.links && t.links.trello)||"";
      const segs=[{ text:`${dot} [${ms}] ${t.name} : ${label}\n📄 기획서 ` }];
      segs.push(plan ? { text:"[LINK]", url:plan } : { text:"링크 없음" });
      segs.push({ text:`\n📋 Trello ` });
      segs.push(trello ? { text:"[LINK]", url:trello } : { text:"링크 없음" });
      if(origin){ segs.push({ text:`\n🔗 ` }); segs.push({ text:"[바로가기]", url:`${origin}/?task=${encodeURIComponent(t.id)}` }); }
      blocks.push(textBlock(segs));
      blocks.push({ type:"divider" });
      preview.push(segs.map(s=>s.text).join(""));
    }
  });
  if(blocks.length>1){
    if(blocks[blocks.length-1].type==="divider") blocks.pop(); // 마지막 구분선 제거
    await dmKakao(env, n, preview.join("\n"), blocks);
  }
}

async function createSessionToken(user, env){
  const payload = { email:user.email, name:user.name||"", exp:Math.floor(Date.now()/1000)+SESSION_TTL };
  const p = b64urlFromStr(JSON.stringify(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(p));
  return p + "." + b64urlFromBytes(sig);
}
function sessionCookie(t){ return `session=${t}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`; }
function clearCookie(){ return `session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`; }
async function verifySession(request, env){
  const c = request.headers.get("Cookie") || ""; const m = c.match(/(?:^|;\s*)session=([^;]+)/); if(!m) return null;
  const [p, sig] = m[1].split("."); if(!p||!sig) return null;
  const key = await hmacKey(env.SESSION_SECRET); let ok = false;
  try{ ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(sig), enc.encode(p)); }catch(_){ return null; }
  if(!ok) return null;
  let pl; try{ pl = JSON.parse(dec.decode(bytesFromB64url(p))); }catch(_){ return null; }
  if(!pl.exp || pl.exp < Math.floor(Date.now()/1000)) return null;
  return { email:pl.email, name:pl.name };
}

let JWKS = { keys:null, exp:0 };
async function googleKeys(){
  const now = Date.now(); if(JWKS.keys && JWKS.exp > now) return JWKS.keys;
  const r = await fetch("https://www.googleapis.com/oauth2/v3/certs"); const j = await r.json();
  JWKS = { keys:j.keys, exp:now + 3600000 }; return j.keys;
}
async function verifyGoogleIdToken(idToken, env){
  const parts = idToken.split("."); if(parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(dec.decode(bytesFromB64url(parts[0])));
  const payload = JSON.parse(dec.decode(bytesFromB64url(parts[1])));
  const keys = await googleKeys(); const jwk = keys.find(k=>k.kid===header.kid); if(!jwk) throw new Error("signing key not found");
  const pub = await crypto.subtle.importKey("jwk", jwk, { name:"RSASSA-PKCS1-v1_5", hash:"SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, bytesFromB64url(parts[2]), enc.encode(parts[0]+"."+parts[1]));
  if(!ok) throw new Error("bad signature");
  const now = Math.floor(Date.now()/1000);
  if(payload.exp < now) throw new Error("token expired");
  if(payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") throw new Error("bad iss");
  if(payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("bad aud (client id mismatch)");
  if(payload.email_verified !== true && payload.email_verified !== "true") throw new Error("email not verified");
  const domain = (env.COMPANY_DOMAIN || "").trim();
  if(domain){ const ed = (payload.email||"").split("@")[1]; if(payload.hd !== domain && ed !== domain) throw new Error("domain not allowed"); }
  return { email:payload.email, name:payload.name };
}


/* =====================================================================
 *  Trello 동기화 (2026-08-26)
 *  - 대상: 보드(TRELLO_BOARD)의 리스트 중 "마일스톤 이름과 같은 이름"의 리스트. 예) 리스트 M10 → 마일스톤 [M10]
 *  - 트렐로 카드 생성/이름변경 → 보드 Task 생성/이름 갱신 (분류는 항상 "개발")
 *  - 트렐로 카드 삭제·보관(archive) → 보드 Task 삭제
 *  - 보드에서 연결된 Task 삭제 → 트렐로 카드 삭제
 *  - 보드에서 만든 Task 는 트렐로로 보내지 않는다(단방향 생성)
 *  - 카드를 대상 밖 리스트로 옮겨도 Task 는 그대로 둔다(오조작 방지)
 *  필요한 환경변수: TRELLO_KEY, TRELLO_TOKEN, TRELLO_SECRET(웹훅 서명 검증), TRELLO_BOARD(선택)
 * ===================================================================== */
const TRELLO_API = "https://api.trello.com/1";
const TRELLO_MAX_AUTO_DELETE = 10;   // 한 번에 이 개수를 넘는 삭제는 트렐로에 반영하지 않는다(사고 방지)
const trelloReady = env => !!(env.TRELLO_KEY && env.TRELLO_TOKEN);
const trelloBoardId = env => String(env.TRELLO_BOARD || "NfAsSWHN").trim();
async function trelloFetch(env, path, init){
  const sep = path.includes("?") ? "&" : "?";
  const auth = `key=${encodeURIComponent(env.TRELLO_KEY)}&token=${encodeURIComponent(env.TRELLO_TOKEN)}`;
  const r = await fetch(`${TRELLO_API}${path}${sep}${auth}`, init);
  const txt = await r.text();
  if(!r.ok) throw new Error(`trello ${r.status} ${path.split("?")[0]} :: ${txt.slice(0,180)}`);
  try{ return JSON.parse(txt); }catch(_){ return txt; }
}
/* 웹훅의 idModel 은 짧은 링크(NfAsSWHN)를 받지 않고 24자리 보드 ID만 받는다.
 * 목록·카드 조회는 짧은 링크로도 되므로, 웹훅 등록 때만 실제 ID로 바꿔서 쓴다. */
const TRELLO_ID_CACHE = {};
async function trelloRealBoardId(env){
  const raw = trelloBoardId(env);
  if(/^[0-9a-f]{24}$/i.test(raw)) return raw;
  if(TRELLO_ID_CACHE[raw]) return TRELLO_ID_CACHE[raw];
  const b = await trelloFetch(env, `/boards/${raw}?fields=id`);
  const id = b && b.id;
  if(id) TRELLO_ID_CACHE[raw] = id;
  return id || raw;
}

/* "[M10]" 과 "M10" 을 같은 것으로 본다 */
const msKey = v => String(v||"").replace(/[\[\]()\s_·-]/g,"").toUpperCase();
function msIdForList(st, listName){
  const k = msKey(listName); if(!k) return null;
  const m = (st.milestones||[]).find(x => x && !x.free && msKey(x.name) === k);
  return m ? m.id : null;
}
/* 이름 대조용 키: 앞뒤 공백·연속 공백·대소문자 무시 */
const nameKey = v => String(v||"").replace(/\s+/g," ").trim().toLowerCase();
/* 웹훅 payload 의 card 에는 shortUrl 이 없고 shortLink 만 온다. 없으면 카드 ID로 URL 을 만든다. */
const cardUrl = c => (c && (c.shortUrl || c.url ||
  (c.shortLink ? "https://trello.com/c/"+c.shortLink : (c.id ? "https://trello.com/c/"+c.id : "")))) || "";
/* 연결된 Task 에 트렐로 링크가 비어 있으면 채워 준다 */
function fillCardLink(t, c){
  if(!t) return false;
  if(!t.links) t.links = { plan:"", trello:"" };
  const u = cardUrl(c);
  if(u && !t.links.trello){ t.links.trello = u; return true; }
  return false;
}
const firstDevStatus = st => {
  const l = st && st.trackStatuses && st.trackStatuses["개발"];
  return (Array.isArray(l) && l.length && l[0] && l[0].key) || "대기";
};
function taskFromCard(st, card, listName){
  const msId = msIdForList(st, listName);
  const fb = ((st.milestones||[]).find(m=>m && !m.free) || {}).id;
  return { id: "tr_"+card.id, name: (card.name||"").trim() || "(제목 없음)",
    track: "개발", status: firstDevStatus(st), milestoneId: msId || fb, kickoff: "예정",
    links: { plan:"", trello: cardUrl(card) }, depts: {},
    trelloCardId: card.id, trelloList: listName || "" };
}
/* 카드 1장을 상태에 반영: 이름이 같은(아직 연결 안 된) 개발 Task 가 딱 하나면 그 Task 에 연결하고,
 * 없으면 새로 만든다. 같은 이름이 둘 이상이면 어느 것인지 알 수 없으므로 아무것도 하지 않는다.
 * 반환: "linked" | "added" | "ambiguous" | false */
function attachOrCreate(st, card, listName){
  if(!Array.isArray(st.tasks)) st.tasks = [];
  if(st.tasks.some(t => t && t.trelloCardId === card.id)) return false;
  const nm = (card.name||"").trim() || "(제목 없음)";
  const k = nameKey(nm);
  let cands = st.tasks.filter(t => t && !t.trelloCardId && (t.track||"개발")==="개발" && nameKey(t.name)===k);
  if(cands.length > 1){
    const msId = msIdForList(st, listName);
    const same = cands.filter(t => t.milestoneId === msId);
    if(same.length === 1) cands = same;
  }
  if(cands.length > 1) return "ambiguous";
  if(cands.length === 1){
    const t = cands[0];
    t.trelloCardId = card.id; t.trelloList = listName || "";
    t.name = nm;                                  // 이름은 트렐로가 기준 (공백·대소문자 차이도 즉시 맞춘다)
    fillCardLink(t, card);
    return "linked";
  }
  st.tasks.unshift(taskFromCard(st, card, listName));
  return "added";
}

/* 상태를 읽어 고치고 저장(낙관적 잠금 재시도). fn(st) 이 true 를 돌려주면 저장한다. */
async function mutateState(env, who, fn){
  for(let i=0;i<4;i++){
    const cur = await env.DB.prepare("SELECT data, version FROM app_state WHERE id='main'").first();
    if(!cur) return { ok:false, reason:"no-state" };
    let st; try{ st = JSON.parse(cur.data); }catch(_){ return { ok:false, reason:"bad-state" }; }
    const changed = await fn(st);
    if(!changed) return { ok:true, changed:false };
    const res = await env.DB.prepare("UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main' AND version=?")
      .bind(JSON.stringify(st), who, cur.version).run();
    if(res && res.meta && res.meta.changes) return { ok:true, changed:true };
  }
  return { ok:false, reason:"conflict" };
}
/* 트렐로 웹훅 서명 검증: base64(HMAC-SHA1(secret, body + callbackURL)) */
async function trelloSigOk(request, env, bodyText, callbackUrl){
  const secret = env.TRELLO_SECRET; if(!secret) return false;
  const sig = request.headers.get("x-trello-webhook") || "";
  if(!sig) return false;
  try{
    const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-1" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", k, enc.encode(bodyText + callbackUrl));
    return sig === btoa(String.fromCharCode(...new Uint8Array(mac)));
  }catch(_){ return false; }
}
const trelloCallbackUrl = (env, url) => String(env.TRELLO_CALLBACK || (url.origin + "/api/trello/webhook"));

/* 웹훅 액션 1건 반영 */
async function applyTrelloAction(env, act){
  const type = act && act.type, d = (act && act.data) || {};
  const card = d.card || {}; if(!card.id) return false;
  const listName = (d.list && d.list.name) || (d.listAfter && d.listAfter.name) || "";
  const findIdx = st => (st.tasks||[]).findIndex(t => t && t.trelloCardId === card.id);

  if(type === "deleteCard"){
    return (await mutateState(env, "trello", st => {
      const i = findIdx(st); if(i < 0) return false; st.tasks.splice(i,1); return true; })).changed;
  }
  if(type === "createCard" || type === "copyCard" || type === "moveCardToBoard"){
    return (await mutateState(env, "trello", st => {
      if(!msIdForList(st, listName)) return false;            // 대상 리스트가 아니면 무시
      const r = attachOrCreate(st, card, listName);            // 같은 이름 Task 가 있으면 중복 생성 대신 연결
      return r === "linked" || r === "added"; })).changed;
  }
  if(type === "updateCard"){
    const old = d.old || {};
    if(old.closed === false && card.closed === true){        // 보관(archive) → 삭제로 취급
      return (await mutateState(env, "trello", st => {
        const i = findIdx(st); if(i < 0) return false; st.tasks.splice(i,1); return true; })).changed;
    }
    if(old.closed === true && card.closed === false){        // 보관 해제 → 대상 리스트면 되살림
      return (await mutateState(env, "trello", st => {
        const ln = listName || (d.list && d.list.name) || "";
        if(!msIdForList(st, ln)) return false;
        const r = attachOrCreate(st, card, ln);
        return r === "linked" || r === "added"; })).changed;
    }
    if(Object.prototype.hasOwnProperty.call(old, "name")){    // 이름 변경 → 트렐로가 기준
      return (await mutateState(env, "trello", st => {
        const i = findIdx(st); if(i < 0) return false;
        const nm = (card.name||"").trim() || "(제목 없음)";
        const filled = fillCardLink(st.tasks[i], card);        // 링크가 비어 있으면 이 참에 채운다
        if(st.tasks[i].name === nm) return filled;
        st.tasks[i].name = nm; return true; })).changed;
    }
    if(d.listAfter){                                          // 리스트 이동
      return (await mutateState(env, "trello", st => {
        const i = findIdx(st);
        const after = d.listAfter.name || "";
        if(i < 0){                                            // 밖에 있던 카드가 대상 리스트로 들어옴 → 등록
          if(!msIdForList(st, after)) return false;
          const r = attachOrCreate(st, card, after);
          return r === "linked" || r === "added";
        }
        if(st.tasks[i].trelloList === after) return false;     // 밖으로 나가도 Task 는 그대로 둔다
        st.tasks[i].trelloList = after;
        const ms = msIdForList(st, after); if(ms) st.tasks[i].milestoneId = ms;
        return true; })).changed;
    }
  }
  return false;
}

/* 전체 가져오기 — 웹훅이 놓친 것 복구 + 최초 1회 도입용
 *  opts.dry       : true 면 계산만 하고 저장하지 않는다(미리보기)
 *  opts.linkByName: true(기본) 면 "이름이 같은 기존 Task" 를 새로 만들지 않고 그 Task에 카드를 연결한다.
 *                   같은 이름이 2개 이상이면 어느 것인지 알 수 없으므로 아무것도 하지 않고 보고만 한다. */
async function trelloImportAll(env, who, opts){
  const dry = !!(opts && opts.dry);
  const linkByName = !opts || opts.linkByName !== false;
  const board = trelloBoardId(env);
  const lists = await trelloFetch(env, `/boards/${board}/lists?fields=id,name&filter=open`);
  const cards = await trelloFetch(env, `/boards/${board}/cards?fields=id,name,idList,shortUrl&filter=open`);
  const byId = {}; (lists||[]).forEach(l => byId[l.id] = l.name);
  const summary = { dry, linkByName, added:0, linked:0, renamed:0, removed:0, skippedRemoval:0,
                    lists:[], linkedNames:[], addedNames:[], ambiguous:[], removedNames:[] };
  await mutateState(env, who, st => {
    const scope = (lists||[]).filter(l => msIdForList(st, l.name));
    summary.lists = scope.map(l => l.name);
    const scopeIds = new Set(scope.map(l => l.id));
    const inScope = (cards||[]).filter(c => scopeIds.has(c.idList));
    if(!Array.isArray(st.tasks)) st.tasks = [];
    let changed = false;

    inScope.forEach(c => {
      const nm = (c.name||"").trim() || "(제목 없음)";
      const listName = byId[c.idList];
      const i = st.tasks.findIndex(t => t && t.trelloCardId === c.id);
      if(i >= 0){                                            // 이미 연결됨 → 이름·링크만 맞춘다
        if(fillCardLink(st.tasks[i], c)) changed = true;
        if(st.tasks[i].name !== nm){ st.tasks[i].name = nm; summary.renamed++; changed = true; }
        return;
      }
      if(!linkByName){                                       // 이름 연결을 끄면 무조건 새로 만든다
        st.tasks.unshift(taskFromCard(st, c, listName));
        summary.added++; if(summary.addedNames.length < 50) summary.addedNames.push(nm);
        changed = true; return;
      }
      const r = attachOrCreate(st, c, listName);
      if(r === "ambiguous"){ summary.ambiguous.push({ name:nm, list:listName }); return; }
      if(r === "linked"){ summary.linked++; if(summary.linkedNames.length < 50) summary.linkedNames.push(nm); changed = true; return; }
      if(r === "added"){ summary.added++; if(summary.addedNames.length < 50) summary.addedNames.push(nm); changed = true; }
    });

    // 보드에서 사라진(삭제·보관) 카드에 연결된 Task 정리
    const openIds = new Set((cards||[]).map(c => c.id));      // 보드의 열린 카드 전체(대상 밖 리스트 포함)
    const dead = st.tasks.filter(t => t && t.trelloCardId && !openIds.has(t.trelloCardId));
    if(dead.length > TRELLO_MAX_AUTO_DELETE){ summary.skippedRemoval = dead.length; }
    else if(dead.length){
      const kill = new Set(dead.map(t => t.id));
      summary.removedNames = dead.slice(0,50).map(t => t.name);
      st.tasks = st.tasks.filter(t => !kill.has(t.id));
      summary.removed = dead.length; changed = true;
    }
    return dry ? false : changed;                            // 미리보기면 저장하지 않는다
  });
  return summary;
}

/* 보드에서 연결된 Task 를 지우면 트렐로 카드도 삭제 (PUT /api/state 이후 백그라운드) */
async function trelloDeleteRemoved(env, prevRaw, nextRaw){
  try{
    if(!trelloReady(env)) return;
    const prev = JSON.parse(prevRaw || "{}"), next = JSON.parse(nextRaw || "{}");
    if(!Array.isArray(prev.tasks) || !Array.isArray(next.tasks)) return;
    const alive = new Set(next.tasks.map(t => t && t.id));
    const gone = prev.tasks.filter(t => t && t.trelloCardId && !alive.has(t.id));
    if(!gone.length || gone.length > TRELLO_MAX_AUTO_DELETE) return;   // 대량 삭제는 반영하지 않는다
    for(const t of gone){
      try{ await trelloFetch(env, `/cards/${t.trelloCardId}`, { method:"DELETE" }); }catch(_){}
    }
  }catch(_){}
}

async function handleApi(request, env, url, ctx){
  const p = url.pathname;

  if(p === "/api/config" && request.method === "GET"){
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", companyDomain: env.COMPANY_DOMAIN || "" });
  }
  /* 트렐로 웹훅 — 로그인 없이 들어온다. HEAD 는 트렐로의 콜백 URL 검증용. */
  if(p === "/api/trello/webhook"){
    if(request.method === "HEAD" || request.method === "GET") return new Response("ok", { status:200 });
    if(request.method !== "POST") return json({ error:"method" }, 405);
    if(!trelloReady(env)) return json({ error:"trello not configured" }, 200);
    const bodyText = await request.text();
    if(!(await trelloSigOk(request, env, bodyText, trelloCallbackUrl(env, url)))){
      return json({ error:"bad signature" }, 401);
    }
    let body; try{ body = JSON.parse(bodyText); }catch(_){ return json({ ok:true }); }
    if(ctx && ctx.waitUntil) ctx.waitUntil(applyTrelloAction(env, body && body.action).catch(()=>{}));
    else { try{ await applyTrelloAction(env, body && body.action); }catch(_){} }
    return json({ ok:true });
  }

  if(p === "/api/auth/google" && request.method === "POST"){
    try{
      const b = await request.json(); const idt = b.credential || b.id_token; if(!idt) return json({ error:"missing credential" }, 400);
      const user = await verifyGoogleIdToken(idt, env);
      try{
        if(isAdminEmail(env, user.email)) await env.DB.prepare("INSERT INTO users (email,name,last_seen,role) VALUES (?,?,datetime('now'),'admin') ON CONFLICT(email) DO UPDATE SET name=excluded.name, last_seen=datetime('now'), role='admin'").bind(user.email, user.name||"").run();
        else await env.DB.prepare("INSERT INTO users (email,name,last_seen) VALUES (?,?,datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name, last_seen=datetime('now')").bind(user.email, user.name||"").run();
      }catch(_){}
      const tok = await createSessionToken(user, env);
      return json({ ok:true, user:{ email:user.email, name:user.name } }, 200, { "Set-Cookie": sessionCookie(tok) });
    }catch(e){ return json({ error:"auth failed", detail:String(e && e.message || e) }, 401); }
  }

  // 여기부터는 로그인 필요
  const user = await verifySession(request, env);
  if(!user) return json({ error:"unauthorized" }, 401);

  if(p === "/api/me" && request.method === "GET"){ const role=await effectiveRole(env, user.email); return json({ user:{ email:user.email, name:user.name, role } }); }
  if(p === "/api/logout" && request.method === "POST") return json({ ok:true }, 200, { "Set-Cookie": clearCookie() });

  // 편집 권한 요청 / 권한 관리(관리자)
  if(p === "/api/request-edit" && request.method === "POST"){
    await env.DB.prepare("INSERT INTO users (email,name,requested) VALUES (?,?,1) ON CONFLICT(email) DO UPDATE SET requested=1, name=excluded.name").bind(user.email, user.name||"").run();
    return json({ ok:true });
  }
  if(p === "/api/access" && request.method === "GET"){
    if((await effectiveRole(env, user.email)) !== "admin") return json({ error:"forbidden" }, 403);
    const { results } = await env.DB.prepare("SELECT email,name,role,requested FROM users ORDER BY requested DESC, role DESC, name").all();
    const list = (results||[]).map(u=>({ email:u.email, name:u.name, requested:u.requested, role: isAdminEmail(env, u.email) ? "admin" : (u.role||"viewer") }));
    return json({ users: list, adminEmails: env.ADMIN_EMAILS || "" });
  }
  if(p === "/api/grant" && request.method === "POST"){
    if((await effectiveRole(env, user.email)) !== "admin") return json({ error:"forbidden" }, 403);
    const b = await request.json(); const role = (b.role === "editor") ? "editor" : "viewer";
    await env.DB.prepare("INSERT INTO users (email,role,requested) VALUES (?,?,0) ON CONFLICT(email) DO UPDATE SET role=?, requested=0").bind(b.email, role, role).run();
    return json({ ok:true });
  }

  // 구버전 클라이언트 차단: 상태 동기화(읽기·쓰기) 자체를 막아 데이터 손상을 원천 봉쇄
  if(p === "/api/state" && clientVersion(request) < APP_BUILD){
    return json({ error:"version", reason:"upgrade-required", min:APP_BUILD }, 426);
  }
  if(p === "/api/state" && request.method === "GET"){
    /* 요청 수 절감(2026-08-22): 접속자 하트비트·목록을 이 응답에 함께 실어 보낸다.
     *   ?v=<버전>  : 클라이언트가 가진 버전. 서버와 같으면 data 를 빼고 보낸다(전송량 절감).
     *   ?beat=1    : 하트비트 기록(매 폴링마다 쓰지 않고 클라이언트가 ~1분에 한 번만 붙인다).
     *   ?p=1       : 접속자 목록 포함. */
    const q = url.searchParams;
    if(q.get("beat")==="1"){
      try{ await env.DB.prepare("INSERT INTO users (email,name,last_seen) VALUES (?,?,datetime('now')) ON CONFLICT(email) DO UPDATE SET last_seen=datetime('now'), name=excluded.name").bind(user.email, user.name||"").run(); }catch(_){}
    }
    const row = await env.DB.prepare("SELECT data, version, updated_at, updated_by FROM app_state WHERE id='main'").first();
    let presence = undefined;
    if(q.get("p")==="1"){
      try{ const { results } = await env.DB.prepare("SELECT email,name FROM users WHERE last_seen > datetime('now','-180 seconds') ORDER BY name").all();
        presence = { users: results || [], count: (results||[]).length }; }catch(_){}
    }
    if(!row) return json({ data:{ tasks:[], milestones:[] }, version:0, presence });
    const known = Number(q.get("v"));
    if(Number.isFinite(known) && known === row.version && q.get("v")!==null){
      return json({ unchanged:true, version:row.version, presence });   // 바뀐 게 없으면 본문 생략
    }
    let data; try{ data = JSON.parse(row.data); }catch(_){ data = { tasks:[], milestones:[] }; }
    return json({ data, version:row.version, updatedAt:row.updated_at, updatedBy:row.updated_by, presence });
  }
  if(p === "/api/state" && request.method === "PUT"){
    const role = await effectiveRole(env, user.email);
    if(!canEdit(role)) return json({ error:"forbidden", reason:"edit-not-allowed" }, 403);
    const b = await request.json();
    const baseVersion = (b.baseVersion===undefined || b.baseVersion===null) ? null : Number(b.baseVersion);
    const cur = await env.DB.prepare("SELECT data, version FROM app_state WHERE id='main'").first();
    let incoming = b.data ?? {};
    // 마일스톤 설정은 관리자 전용: 비관리자 저장 시 마일스톤 목록은 서버 저장본을 유지(변경 무시)
    if(role !== "admin" && cur && cur.data){
      try{ const prev = JSON.parse(cur.data); if(prev && Array.isArray(prev.milestones)) incoming = { ...incoming, milestones: prev.milestones }; }catch(_){}
    }
    const payload = JSON.stringify(incoming);
    // 낙관적 잠금(CAS): 기준 버전이 서버 최신과 같을 때만 저장. 어긋나면 409+현재상태 반환 → 클라이언트가 재병합·재시도(동시 저장 롤백 방지).
    if(baseVersion !== null && Number.isFinite(baseVersion)){
      const res = await env.DB.prepare("UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main' AND version=?").bind(payload, user.email, baseVersion).run();
      if(!(res && res.meta && res.meta.changes)){
        const c2 = await env.DB.prepare("SELECT data, version FROM app_state WHERE id='main'").first();
        let cd; try{ cd = JSON.parse(c2.data); }catch(_){ cd = { tasks:[], milestones:[] }; }
        return json({ error:"conflict", reason:"version-mismatch", version: c2 ? c2.version : 0, data: cd }, 409);
      }
    } else {
      await env.DB.prepare("UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main'").bind(payload, user.email).run();
    }
    if(ctx && ctx.waitUntil) ctx.waitUntil(notifyStatusChanges(env, cur && cur.data, payload, user.name || user.email, url.origin));
    /* 보드에서 연결된 Task 를 지웠으면 트렐로 카드도 삭제 (응답을 막지 않도록 백그라운드) */
    if(trelloReady(env)){
      const job = trelloDeleteRemoved(env, cur && cur.data, payload);
      if(ctx && ctx.waitUntil) ctx.waitUntil(job.catch(()=>{}));
    }
    const row = await env.DB.prepare("SELECT version FROM app_state WHERE id='main'").first();
    /* 히스토리 스냅샷(최근 50개 보관).
     * 최적화(2026-08-22): 예전엔 저장할 때마다 전체 상태를 통째로 복사해 넣었다(0.8초 디바운스라 하루 수천 건).
     * 지금은 마지막 스냅샷이 10분보다 오래됐을 때만 남긴다 → 50개면 약 8시간 분량을 커버한다. */
    try{
      const last = await env.DB.prepare("SELECT saved_at FROM history ORDER BY id DESC LIMIT 1").first();
      const stale = !last || !last.saved_at || (Date.now() - Date.parse((last.saved_at+"Z").replace(" ","T")) > SNAPSHOT_MIN_GAP_MS);
      if(stale){
        await env.DB.prepare("INSERT INTO history (data,version,saved_by,saved_at) VALUES (?,?,?,datetime('now'))").bind(payload, row ? row.version : 1, user.email).run();
        await env.DB.prepare("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)").run();
      }
    }catch(_){}
    return json({ ok:true, version: row ? row.version : 1 });
  }

  /* ===== 트렐로 관리(관리자 전용) ===== */
  if(p.startsWith("/api/trello/")){
    const role = await effectiveRole(env, user.email);
    if(role !== "admin") return json({ error:"forbidden" }, 403);
    const cb = trelloCallbackUrl(env, url);
    if(p === "/api/trello/status" && request.method === "GET"){
      const out = { configured: trelloReady(env), secret: !!env.TRELLO_SECRET, board: trelloBoardId(env), callback: cb };
      if(!out.configured) return json(out);
      try{
        const lists = await trelloFetch(env, `/boards/${out.board}/lists?fields=id,name&filter=open`);
        const row = await env.DB.prepare("SELECT data FROM app_state WHERE id='main'").first();
        let st = {}; try{ st = JSON.parse(row.data); }catch(_){}
        out.boardId = await trelloRealBoardId(env);
        out.allLists = (lists||[]).map(l => l.name);
        out.scopeLists = (lists||[]).filter(l => msIdForList(st, l.name)).map(l => l.name);
        out.linked = ((st.tasks)||[]).filter(t => t && t.trelloCardId).length;
        const hooks = await trelloFetch(env, `/tokens/${encodeURIComponent(env.TRELLO_TOKEN)}/webhooks`);
        out.hooks = (hooks||[]).filter(h => h && h.callbackURL === cb).map(h => ({ id:h.id, active:h.active }));
      }catch(e){ out.error = String(e && e.message || e); }
      return json(out);
    }
    if(p === "/api/trello/import" && request.method === "POST"){
      if(!trelloReady(env)) return json({ error:"trello not configured" }, 400);
      const q = url.searchParams;
      const opts = { dry: q.get("dry")==="1", linkByName: q.get("link")!=="0" };
      try{ return json({ ok:true, summary: await trelloImportAll(env, "trello-import:"+user.email, opts) }); }
      catch(e){ return json({ error:String(e && e.message || e) }, 502); }
    }
    if(p === "/api/trello/hook" && request.method === "POST"){
      if(!trelloReady(env)) return json({ error:"trello not configured" }, 400);
      try{
        const hooks = await trelloFetch(env, `/tokens/${encodeURIComponent(env.TRELLO_TOKEN)}/webhooks`);
        const dup = (hooks||[]).find(h => h && h.callbackURL === cb);
        if(dup) return json({ ok:true, already:true, id:dup.id });
        const idModel = await trelloRealBoardId(env);          // 짧은 링크는 여기서 실제 ID로 변환
        const made = await trelloFetch(env, `/webhooks/`, { method:"POST",
          headers:{ "content-type":"application/json" },
          body: JSON.stringify({ description:"마일스톤 보드 동기화", callbackURL: cb, idModel }) });
        return json({ ok:true, id: made && made.id, idModel });
      }catch(e){ return json({ error:String(e && e.message || e) }, 502); }
    }
    if(p === "/api/trello/hook" && request.method === "DELETE"){
      try{
        const hooks = await trelloFetch(env, `/tokens/${encodeURIComponent(env.TRELLO_TOKEN)}/webhooks`);
        for(const h of (hooks||[])) if(h && h.callbackURL === cb) await trelloFetch(env, `/webhooks/${h.id}`, { method:"DELETE" });
        return json({ ok:true });
      }catch(e){ return json({ error:String(e && e.message || e) }, 502); }
    }
    return json({ error:"not found" }, 404);
  }

  // 접속자(presence): 하트비트 + 현재 접속자
  if(p === "/api/presence" && request.method === "POST"){
    await env.DB.prepare("INSERT INTO users (email,name,last_seen) VALUES (?,?,datetime('now')) ON CONFLICT(email) DO UPDATE SET last_seen=datetime('now'), name=excluded.name").bind(user.email, user.name||"").run();
    return json({ ok:true });
  }
  if(p === "/api/presence" && request.method === "GET"){
    const { results } = await env.DB.prepare("SELECT email,name FROM users WHERE last_seen > datetime('now','-180 seconds') ORDER BY name").all();
    return json({ users: results || [], count: (results||[]).length });
  }

  // 히스토리 / 롤백
  if(p === "/api/history" && request.method === "GET"){
    if((await effectiveRole(env, user.email)) !== "admin") return json({ error:"forbidden", reason:"admin-only" }, 403);   // 히스토리는 관리자 전용
    const { results } = await env.DB.prepare("SELECT id,version,saved_by,saved_at FROM history ORDER BY id DESC LIMIT 30").all();
    return json({ items: results || [] });
  }
  if(p === "/api/restore" && request.method === "POST"){
    if((await effectiveRole(env, user.email)) !== "admin") return json({ error:"forbidden", reason:"admin-only" }, 403);   // 되돌리기는 관리자 전용
    const b = await request.json();
    const snap = await env.DB.prepare("SELECT data FROM history WHERE id=?").bind(b.id).first();
    if(!snap) return json({ error:"snapshot not found" }, 404);
    const cur = await env.DB.prepare("SELECT data,version FROM app_state WHERE id='main'").first();
    if(cur){ await env.DB.prepare("INSERT INTO history (data,version,saved_by,saved_at) VALUES (?,?,?,datetime('now'))").bind(cur.data, cur.version, user.email+" (되돌리기 직전)").run(); }
    await env.DB.prepare("UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main'").bind(snap.data, user.email).run();
    const row = await env.DB.prepare("SELECT version FROM app_state WHERE id='main'").first();
    await env.DB.prepare("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT 50)").run();
    return json({ ok:true, version: row ? row.version : 1 });
  }

  return json({ error:"not found" }, 404);
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);
    if(url.pathname.startsWith("/api/")) return withDb(env, () => handleApi(request, env, url, ctx));
    // index.html 문서에 현재 빌드 번호 주입(클라이언트 APP_VERSION 자동 설정)
    if(url.pathname === "/" || url.pathname === "/index.html"){
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get("content-type") || "";
      if(res.ok && ct.includes("text/html")){
        const html = (await res.text()).replaceAll("__APP_BUILD__", String(APP_BUILD));
        const h = new Headers(res.headers); h.set("cache-control", "no-cache, must-revalidate");
        return new Response(html, { status: res.status, headers: h });
      }
      return res;
    }
    return env.ASSETS.fetch(request); // 정적 파일(index.html, cloud.js 등)
  }
};
