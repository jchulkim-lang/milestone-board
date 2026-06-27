/* GET /api/config → 프론트가 쓸 공개 설정(클라이언트 ID 등). 비밀 아님. */
import { json } from "./_session.js";
export async function onRequestGet(context){
  const { env } = context;
  return json({ googleClientId: env.GOOGLE_CLIENT_ID || "", companyDomain: env.COMPANY_DOMAIN || "" });
}
