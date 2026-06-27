/* POST /api/logout → 세션 쿠키 삭제 */
import { clearSessionCookie, json } from "./_session.js";
export async function onRequestPost(){
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}
