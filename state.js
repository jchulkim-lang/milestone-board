/* /api/state
 *   GET  → 공유 상태 JSON + version 반환
 *   PUT  → 상태 저장 (last-write-wins, version +1)
 * 미들웨어가 인증을 보장하므로 로그인 사용자만 접근 가능. */
import { json } from "./_session.js";

export async function onRequestGet(context){
  const { env } = context;
  const row = await env.DB.prepare(
    "SELECT data, version, updated_at, updated_by FROM app_state WHERE id='main'"
  ).first();
  if (!row) return json({ data: { tasks: [], milestones: [] }, version: 0 });
  let data;
  try { data = JSON.parse(row.data); } catch (_) { data = { tasks: [], milestones: [] }; }
  return json({ data, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by });
}

export async function onRequestPut(context){
  const { request, env, data } = context;
  const user = data.user;
  const body = await request.json();
  const payload = JSON.stringify(body.data ?? {});

  // last-write-wins: 버전 검사 없이 그대로 덮어쓰고 version 증가
  await env.DB.prepare(
    "UPDATE app_state SET data=?, version=version+1, updated_at=datetime('now'), updated_by=? WHERE id='main'"
  ).bind(payload, user.email).run();

  const row = await env.DB.prepare("SELECT version FROM app_state WHERE id='main'").first();
  return json({ ok: true, version: row ? row.version : 1, updatedBy: user.email });
}
