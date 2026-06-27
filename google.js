/* POST /api/auth/google  { credential: "<구글 ID 토큰>" }
 * 구글 ID 토큰을 서버에서 검증하고, 통과하면 우리 세션 쿠키를 발급한다. */
import { verifyGoogleIdToken, createSessionToken, sessionCookie, json } from "../_session.js";

export async function onRequestPost(context){
  const { request, env } = context;
  try {
    const body = await request.json();
    const idToken = body.credential || body.id_token;
    if (!idToken) return json({ error: "missing credential" }, 400);

    const user = await verifyGoogleIdToken(idToken, env); // 실패 시 throw → 401

    // 접속 사용자 기록(선택)
    try {
      await env.DB.prepare(
        "INSERT INTO users (email,name,last_seen) VALUES (?,?,datetime('now')) " +
        "ON CONFLICT(email) DO UPDATE SET name=excluded.name, last_seen=datetime('now')"
      ).bind(user.email, user.name || "").run();
    } catch (_) { /* users 테이블 없거나 실패해도 로그인은 진행 */ }

    const token = await createSessionToken(user, env);
    return json({ ok: true, user: { email: user.email, name: user.name } }, 200, { "Set-Cookie": sessionCookie(token) });
  } catch (e) {
    return json({ error: "auth failed", detail: String(e && e.message || e) }, 401);
  }
}
