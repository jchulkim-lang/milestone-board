/* =====================================================================
 *  cron-worker.js — 별도의 Cloudflare Worker (스케줄 실행)
 *  매일 정해진 시간에 D1을 읽어 '마감 임박(D-3)'·'마감 초과(지연)'를 모아
 *  카카오워크 대화방(Incoming Webhook)으로 알림을 보냅니다.
 *
 *  이 워커는 Pages 프로젝트와 별개입니다. 만드는 법:
 *   1) Cloudflare 대시보드 → Workers & Pages → Create → Worker (이름 예: milestone-cron)
 *   2) 이 파일 내용을 통째로 붙여넣고 Deploy
 *   3) Settings → Variables and Secrets: KAKAO_WEBHOOK_URL = (카카오워크 웹훅 URL)
 *   4) Settings → Bindings → D1 database: 변수명 DB → milestone-db 선택
 *   5) Settings → Triggers → Cron Triggers → 추가:  0 0 * * 1-5
 *        (UTC 0시 = 한국 오전 9시, 월~금. 매일이면 0 0 * * *)
 * ===================================================================== */
export default {
  async scheduled(event, env, ctx){
    ctx.waitUntil(checkDeadlines(env));
  },
  // 테스트용: 브라우저로 이 워커 주소를 열면 즉시 한 번 검사 (?key=... 없이도 동작)
  async fetch(request, env){
    await checkDeadlines(env);
    return new Response("checked");
  }
};

function parseYmd(s){ const p=s.split("-").map(Number); return new Date(p[0], p[1]-1, p[2]); }
function fmt(d){ return (d.getMonth()+1) + "/" + d.getDate(); }

async function checkDeadlines(env){
  if(!env.KAKAO_WEBHOOK_URL || !env.DB) return;
  const row = await env.DB.prepare("SELECT data FROM app_state WHERE id='main'").first();
  if(!row) return;
  let st; try{ st = JSON.parse(row.data); }catch(_){ return; }

  const today = new Date(); today.setHours(0,0,0,0);
  const DL = [["resource","리소스 마감"],["dev","개발 마감"],["qa","QA 마감"],["end","마일스톤 종료"]];
  const soon = [], over = [];

  (st.milestones||[]).forEach(m=>{
    const tasks = (st.tasks||[]).filter(t=>t.milestoneId===m.id);
    const incomplete = tasks.filter(t=>t.status!=="완료").length;
    DL.forEach(([k,label])=>{
      if(!m[k]) return;
      const d = parseYmd(m[k]); d.setHours(0,0,0,0);
      const diff = Math.round((d - today)/86400000);
      if(diff>=0 && diff<=3) soon.push(`• [${m.name}] ${label} D-${diff} (${fmt(d)})`);
      else if(diff<0 && incomplete>0) over.push(`• [${m.name}] ${label} ${-diff}일 초과 · 미완료 ${incomplete}건 (${fmt(d)})`);
    });
  });

  const parts = [];
  if(soon.length) parts.push("⏰ 마감 임박\n" + soon.join("\n"));
  if(over.length) parts.push("🚨 마감 초과(지연)\n" + over.join("\n"));
  if(!parts.length) return; // 알릴 게 없으면 보내지 않음

  await sendKakao(env, "📅 마일스톤 마감 알림\n\n" + parts.join("\n\n"));
}

async function sendKakao(env, text){
  try{
    await fetch(env.KAKAO_WEBHOOK_URL, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ text }) });
    // 형식이 안 맞으면: body: JSON.stringify({ text, blocks:[{ type:"text", text, markdown:true }] })
  }catch(_){}
}
