/* =====================================================================
 *  세션 + 구글 ID 토큰 검증 유틸 (Cloudflare Workers 런타임 / Web Crypto)
 *  - 파일명이 _ 로 시작하므로 라우트가 아니라 "임포트 전용" 헬퍼입니다.
 * ===================================================================== */
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlFromBytes(buf){
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromStr(str){ return b64urlFromBytes(enc.encode(str)); }
function bytesFromB64url(s){
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function hmacKey(secret){
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/* ---------- 우리 자체 세션 토큰 (HMAC 서명) ---------- */
const SESSION_TTL = 60 * 60 * 12; // 12시간

export async function createSessionToken(user, env){
  const payload = { email: user.email, name: user.name || "", exp: Math.floor(Date.now() / 1000) + SESSION_TTL };
  const p = b64urlFromStr(JSON.stringify(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(p));
  return p + "." + b64urlFromBytes(sig);
}
export function sessionCookie(token){
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}
export function clearSessionCookie(){
  return `session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
export async function verifySession(request, env){
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!m) return null;
  const [p, sig] = m[1].split(".");
  if (!p || !sig) return null;
  const key = await hmacKey(env.SESSION_SECRET);
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, bytesFromB64url(sig), enc.encode(p)); } catch (_) { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(dec.decode(bytesFromB64url(p))); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { email: payload.email, name: payload.name };
}

/* ---------- 구글 ID 토큰(JWT, RS256) 서버 검증 ---------- */
let JWKS_CACHE = { keys: null, exp: 0 };
async function googleKeys(){
  const now = Date.now();
  if (JWKS_CACHE.keys && JWKS_CACHE.exp > now) return JWKS_CACHE.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  const jwks = await res.json();
  JWKS_CACHE = { keys: jwks.keys, exp: now + 60 * 60 * 1000 }; // 1시간 캐시
  return jwks.keys;
}

export async function verifyGoogleIdToken(idToken, env){
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(dec.decode(bytesFromB64url(parts[0])));
  const payload = JSON.parse(dec.decode(bytesFromB64url(parts[1])));

  // 1) 서명 검증 (구글 공개키)
  const keys = await googleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("signing key not found");
  const pub = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = enc.encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, bytesFromB64url(parts[2]), signed);
  if (!ok) throw new Error("bad signature");

  // 2) 클레임 검증
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error("token expired");
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") throw new Error("bad iss");
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("bad aud (client id mismatch)");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("email not verified");

  // 3) 회사 도메인 제한 (가장 중요)
  const domain = (env.COMPANY_DOMAIN || "").trim();
  if (domain) {
    const emailDomain = (payload.email || "").split("@")[1];
    if (payload.hd !== domain && emailDomain !== domain) throw new Error("domain not allowed");
  }
  return { email: payload.email, name: payload.name, picture: payload.picture, hd: payload.hd };
}

export function json(obj, status = 200, extraHeaders = {}){
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}
