/* =====================================================================
 *  _worker.js — 단일 파일 버전 (Cloudflare Pages 고급 모드)
 *  이 파일 하나만 저장소 최상위에 올리면 모든 /api/* 서버 기능이 동작합니다.
 *  (functions 폴더가 필요 없습니다. 정적 파일은 env.ASSETS 가 서빙)
 *  필요한 환경변수: GOOGLE_CLIENT_ID, COMPANY_DOMAIN, SESSION_SECRET, D1 바인딩 DB
 * ===================================================================== */
const enc = new TextEncoder();
const dec = new TextDecoder();
const SESSION_TTL = 60 * 60 * 12; // 12시간

function b64urlFromBytes(buf){ let s = btoa(String.fromCharCode(...new Uint8Array(buf))); return s.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); }
function b64urlFromStr(str){ return b64urlFromBytes(enc.encode(str)); }
function bytesFromB64url(s){ s = s.replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s += "="; const bin = atob(s); const a = new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) a[i]=bin.charCodeAt(i); return a; }
async function hmacKey(secret){ return crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["sign","verify"]); }
function json(o, s=200, h={}){ return new Response(JSON.stringify(o), { status:s, headers:{ "content-type":"application/json", ...h } }); }

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

async function handleApi(request, env, url){
  const p = url.pathname;

  if(p === "/api/config" && request.method === "GET"){
    return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", companyDomain: env.COMPANY_DOMAIN || "" });
  }
  if(p === "/api/auth/google" && request.method === "POST"){
    try{
      const b = await request.json(); const idt = b.credential || b.id_token; if(!idt) return json({ error:"missing credential" }, 400);
      const user = await verifyGoogleIdToken(idt, env);
      try{ await env.DB.prepare("INSERT INTO users (email,name,last_seen) VALUES (?,?,datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name, last_seen=datetime('now')").bind(user.email, user.name||"").run(); }catch(_){}
      const tok = await createSessionToken(user, env);
      return json({ ok:true, user:{ email:user.email, name:user.name } }, 200, { "Set-Cookie": sessionCookie(tok) });
    }catch(e){ return json({ error:"auth failed", detail:String(e && e.message || e) }, 401); }
  }

  // 여기부터는 로그인 필요
  const user = await verifySession(request, env);
  if(!user) return json({ error:"unauthorized" }, 401);

  if(p === "/api/me" && request.method === "GET") return json({ user });
  if(p === "/api/logout" && request.method === "POST") return json({ ok:true }, 200, { "Set-Cookie": clearCookie() });

  if(p === "/api/state" && request.method === "GET"){
    const row = await env.DB.prepare("SELECT data, version, updated_at, updated_by FROM app_state WHERE id='main'").first();
    if(!row) return json({ data:{ tasks:[], milestones:[] }, version:0 });
    let data; try{ data = JSON.parse(row.data); }catch(_){ data = { tasks:[], milestones:[] }; }
    return json({ data, version:row.version, updatedAt:row.updated_at, updatedBy:row.updated_by });
  }
  if(p === "/api/state" && request.method === "PUT"){
    const b = await request.json(); const payload = JSON.stringify(b.data ?? {});
    await env.DB.prepare("UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main'").bind(payload, user.email).run();
    const row = await env.DB.prepare("SELECT version FROM app_state WHERE id='main'").first();
    return json({ ok:true, version: row ? row.version : 1 });
  }

  return json({ error:"not found" }, 404);
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if(url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    return env.ASSETS.fetch(request); // 정적 파일(index.html, cloud.js 등)
  }
};
