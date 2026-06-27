/* =====================================================================
 *  cloud.js — 클라우드 배포 시에만 동작 (index.html이 http/https에서 로드)
 *  1) 로그인 안 됐으면 구글 로그인 오버레이 표시
 *  2) 로그인 됐으면 /api/state 로 공유 데이터 불러오고, 저장을 클라우드로 연결
 *  로컬 파일(file://)에서는 index.html이 이 파일을 아예 로드하지 않습니다.
 * ===================================================================== */
(function(){
  async function isAuthed(){
    try{ const r = await fetch("/api/me", { credentials:"same-origin" }); return r.ok; }catch(_){ return false; }
  }

  function showLogin(cfg){
    document.body.insertAdjacentHTML("beforeend",
      `<div id="loginOverlay" style="position:fixed;inset:0;background:#0e1014;display:flex;
        flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:99999;
        color:#e7eaf0;font-family:-apple-system,'Malgun Gothic',sans-serif">
        <div style="font-size:18px;font-weight:700">본부 마일스톤 관리</div>
        <div style="font-size:13px;color:#8b93a3">회사 구글 계정으로 로그인하세요</div>
        <div id="gbtn"></div>
        <div id="loginErr" style="color:#ff7a7a;font-size:12px;max-width:340px;text-align:center"></div>
      </div>`);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        hd: cfg.companyDomain || undefined,
        callback: async (resp) => {
          try{
            const r = await fetch("/api/auth/google", {
              method:"POST", credentials:"same-origin",
              headers:{ "content-type":"application/json" },
              body: JSON.stringify({ credential: resp.credential })
            });
            if(r.ok){ location.reload(); }
            else { const e = await r.json(); document.getElementById("loginErr").textContent = "로그인 실패: " + (e.detail || e.error || ""); }
          }catch(_){ document.getElementById("loginErr").textContent = "네트워크 오류"; }
        }
      });
      google.accounts.id.renderButton(document.getElementById("gbtn"), { theme:"filled_blue", size:"large", text:"signin_with" });
    };
    document.head.appendChild(s);
  }

  function setupSync(){
    // 기존 앱의 remote 객체 메서드를 클라우드용으로 교체 (state/render 등은 앱 전역)
    remote.active = true; remote.version = -1; remote._t = null;
    remote.pull = async function(initial){
      try{
        const r = await fetch("/api/state", { credentials:"same-origin" });
        if(!r.ok) return;
        const j = await r.json();
        if(initial || j.version > this.version){
          this.version = j.version;
          if(j.data && j.data.milestones) state = j.data;
          migrate(); buildTimeline(); render();
        }
      }catch(_){}
    };
    remote.push = function(s){            // 저장: 0.8초 디바운스 후 클라우드 PUT
      clearTimeout(this._t);
      this._t = setTimeout(async () => {
        try{
          const r = await fetch("/api/state", {
            method:"PUT", credentials:"same-origin",
            headers:{ "content-type":"application/json" },
            body: JSON.stringify({ data: s })
          });
          if(r.ok){ const j = await r.json(); this.version = j.version; }
        }catch(_){}
      }, 800);
    };
    remote.pull(true);                    // 시작 시 공유 데이터 로드
    setInterval(() => remote.pull(false), 10000); // 10초마다 동기화
  }

  (async function(){
    if(await isAuthed()){ setupSync(); return; }
    let cfg = {};
    try{ cfg = await (await fetch("/api/config")).json(); }catch(_){}
    showLogin(cfg);
  })();
})();
