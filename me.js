/* GET /api/me  → 현재 로그인 사용자 (미들웨어가 인증을 보장) */
import { json } from "./_session.js";
export async function onRequestGet(context){
  return json({ user: context.data.user });
}
