/* =====================================================================
 *  /api/* 전체에 적용되는 인증 미들웨어.
 *  - /api/auth/* 와 /api/config 는 비인증 허용(로그인 진입점/공개 설정)
 *  - 그 외 모든 /api 요청은 유효한 세션 쿠키가 없으면 401
 *  => "API 자체"를 보호하므로 외부인이 D1에 직접 접근할 수 없습니다.
 * ===================================================================== */
import { verifySession, json } from "./_session.js";

export async function onRequest(context){
  const { request, env, next, data } = context;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/config") {
    return next();
  }
  const user = await verifySession(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  data.user = user; // 다운스트림 핸들러에서 context.data.user 로 사용
  return next();
}
