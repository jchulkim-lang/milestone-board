/* =====================================================================
 *  cloud.js — 클라우드 배포 시에만 동작 (index.html이 http/https에서 로드)
 *  - 로그인 / 공유 동기화 / 접속자 표시
 *  - 권한: 읽기는 모두, 쓰기는 editor·admin만. 뷰어는 '편집 권한 요청', 관리자는 승인 패널.
 *  로컬 파일(file://)에서는 index.html이 이 파일을 로드하지 않습니다(= 모두 편집 가능).
 * ===================================================================== */
(function(){
  let ROLE = "viewer";
  let ACCESS_USERS = [], accessQuery = "", viewersOpen = false;
  const esc = s => (s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const canEdit = () => ROLE==="editor" || ROLE==="admin";

  async function getMe(){
    try{ const r = await fetch("/api/me", { credentials:"same-origin" }); if(r.ok){ const j = await r.json(); return j.user; } }catch(_){}
    return null;
  }

  function showLogin(cfg){
    document.body.insertAdjacentHTML("beforeend",
      `<div id="loginOverlay" style="position:fixed;inset:0;background:#0e1014;display:flex;
        flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:99999;
        color:#e7eaf0;font-family:-apple-system,'Malgun Gothic',sans-serif">
        <div style="font-size:18px;font-weight:700">브레이커스 마일스톤 관리</div>
        <div style="font-size:13px;color:#8b93a3">회사 구글 계정으로 로그인하세요</div>
        <div id="gbtn"></div>
        <div id="loginErr" style="color:#ff7a7a;font-size:12px;max-width:340px;text-align:center"></div>
      </div>`);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: cfg.googleClientId, hd: cfg.companyDomain || undefined,
        callback: async (resp) => {
          try{
            const r = await fetch("/api/auth/google", { method:"POST", credentials:"same-origin",
              headers:{ "content-type":"application/json" }, body: JSON.stringify({ credential: resp.credential }) });
            if(r.ok){ location.reload(); }
            else { const e = await r.json(); document.getElementById("loginErr").textContent = "로그인 실패: " + (e.detail || e.error || ""); }
          }catch(_){ document.getElementById("loginErr").textContent = "네트워크 오류"; }
        }
      });
      google.accounts.id.renderButton(document.getElementById("gbtn"), { theme:"filled_blue", size:"large", text:"signin_with" });
    };
    document.head.appendChild(s);
  }

  function setStatus(text, names){
    const el = document.getElementById("syncStatus"); if(!el) return;
    el.classList.add("live");
    const span = el.querySelector("span"); if(span) span.textContent = text;
    if(names) el.title = "접속 중: " + (names.join(", ") || "-");
  }

  function setupSync(){
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
    remote.push = function(s){
      if(!canEdit()) return;            // 뷰어는 저장 불가(서버도 차단)
      clearTimeout(this._t);
      this._t = setTimeout(async () => {
        try{
          const r = await fetch("/api/state", { method:"PUT", credentials:"same-origin",
            headers:{ "content-type":"application/json" }, body: JSON.stringify({ data: s }) });
          if(r.ok){ const j = await r.json(); this.version = j.version; }
        }catch(_){}
      }, 800);
    };
    remote.pull(true);
    setInterval(() => remote.pull(false), 10000);
    startPresence();
  }

  function startPresence(){
    setStatus("☁ 동기화 중");
    const roleTxt = () => ROLE==="admin" ? "관리자" : (ROLE==="editor" ? "편집 가능" : "읽기 전용");
    const beat = () => fetch("/api/presence", { method:"POST", credentials:"same-origin" }).catch(()=>{});
    const show = async () => {
      try{
        const r = await fetch("/api/presence", { credentials:"same-origin" }); if(!r.ok) return;
        const j = await r.json();
        setStatus(`${roleTxt()} · ☁ ${j.count}명`, (j.users||[]).map(u=>u.name || u.email));
      }catch(_){}
    };
    beat(); show();
    setInterval(beat, 15000); setInterval(show, 15000);
  }

  /* ----- 역할별 UI ----- */
  function applyRoleUI(){
    if(!canEdit()){ document.body.classList.add("readonly"); injectReadonlyStyle(); injectRequestButton(); }
    if(ROLE==="admin"){ injectAccessButton(); }
  }
  function injectReadonlyStyle(){
    if(document.getElementById("ro-style")) return;
    const s = document.createElement("style"); s.id = "ro-style";
    s.textContent =
      `body.readonly #addTaskBtn,body.readonly #msBtn,body.readonly #importBtn,body.readonly #titleEditBtn,body.readonly #historyBtn,body.readonly #notifyBtn{display:none!important;}
       body.readonly .kf-chip,body.readonly .st-sel,body.readonly .task-del,body.readonly .drag-handle,body.readonly .meta-row,body.readonly .legend-edit,body.readonly .grp.clickable{pointer-events:none!important;opacity:.5;}
       body.readonly .bar{pointer-events:none!important;}`;
    document.head.appendChild(s);
  }
  function placeBtn(b){ const sync=document.getElementById("syncStatus"); if(sync&&sync.parentNode){ sync.parentNode.insertBefore(b, sync.nextSibling); } else document.querySelector(".topbar").appendChild(b); }
  function injectRequestButton(){
    if(document.getElementById("requestEditBtn")) return;
    const b = document.createElement("button"); b.id="requestEditBtn"; b.className="btn ghost sm"; b.style.marginLeft="6px"; b.textContent="✋ 편집 권한 요청";
    b.onclick = async () => {
      b.disabled=true; b.textContent="요청 중…";
      try{ const r=await fetch("/api/request-edit",{method:"POST",credentials:"same-origin"}); b.textContent = r.ok ? "승인 대기 중" : "요청 실패"; if(!r.ok) b.disabled=false; }
      catch(_){ b.textContent="요청 실패"; b.disabled=false; }
    };
    placeBtn(b);
  }
  function injectAccessButton(){
    if(document.getElementById("accessBtn")) return;
    const b = document.createElement("button"); b.id="accessBtn"; b.className="btn ghost sm"; b.style.marginLeft="6px"; b.textContent="👥 권한 관리";
    b.onclick = openAccess; placeBtn(b);
  }
  function ensureAccessModal(){
    let m = document.getElementById("accessModal"); if(m) return m;
    m = document.createElement("div"); m.id="accessModal"; m.className="modal-bg";
    m.innerHTML = `<div class="modal" style="width:500px"><h3>권한 관리 👥</h3>
      <div class="msub">‘승인 대기🔔’를 ‘편집 승인’하면 편집 가능(editor)이 됩니다. 관리자(admin)는 환경변수 ADMIN_EMAILS로 지정됩니다.</div>
      <input id="accessSearch" placeholder="이름·이메일 검색" style="width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 11px;font-size:13px;margin-bottom:8px">
      <div id="accessResults" class="ms-list-wrap" style="max-height:360px"></div>
      <div class="modal-actions"><span></span><div class="right"><button class="btn" id="accessClose">닫기</button></div></div></div>`;
    document.body.appendChild(m);
    m.addEventListener("click", e=>{ if(e.target===m) m.classList.remove("show"); });
    m.querySelector("#accessClose").onclick = () => m.classList.remove("show");
    m.querySelector("#accessSearch").addEventListener("input", e=>{ accessQuery=e.target.value; drawAccess(); });
    m.querySelector("#accessResults").addEventListener("click", async e=>{
      const tg=e.target.closest("#viewersToggle"); if(tg){ viewersOpen=!viewersOpen; drawAccess(); return; }
      const g = e.target.closest("[data-grant]"); if(!g) return; g.disabled=true;
      try{ await fetch("/api/grant",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({email:g.dataset.email, role:g.dataset.grant})}); }catch(_){}
      renderAccess();
    });
    return m;
  }
  async function renderAccess(){
    const el = document.getElementById("accessResults"); el.innerHTML = "불러오는 중…";
    try{
      const r = await fetch("/api/access", { credentials:"same-origin" });
      if(!r.ok){ el.innerHTML = '<div class="dm-empty">권한이 없습니다.</div>'; return; }
      const j = await r.json(); ACCESS_USERS = j.users || []; drawAccess();
    }catch(_){ el.innerHTML = '<div class="dm-empty">불러오기 실패</div>'; }
  }
  function drawAccess(){
    const el = document.getElementById("accessResults"); if(!el) return;
    const q = accessQuery.trim().toLowerCase();
    const match = u => !q || (u.name||"").toLowerCase().includes(q) || (u.email||"").toLowerCase().includes(q);
    const us = ACCESS_USERS.filter(match);
    const pending = us.filter(u=>u.requested && u.role!=="editor" && u.role!=="admin");
    const admins  = us.filter(u=>u.role==="admin");
    const editors = us.filter(u=>u.role==="editor");
    const viewers = us.filter(u=>u.role==="viewer" && !u.requested);
    const row = (u,btn) => `<div class="ms-item" style="cursor:default"><span class="ms-name">${esc(u.name||u.email)}</span><span class="ms-range">${esc(u.email)}</span>${btn||""}</div>`;
    const approve = u => `<button class="meta-btn set" data-grant="editor" data-email="${esc(u.email)}">편집 승인</button>`;
    const revoke  = u => `<button class="meta-btn" data-grant="viewer" data-email="${esc(u.email)}">읽기 전용으로</button>`;
    const head = t => `<div style="font-size:12px;font-weight:800;color:var(--muted);margin:12px 0 6px">${t}</div>`;
    const empty = `<div class="dm-empty">없음</div>`;
    let h = "";
    h += head(`🔔 승인 대기 (${pending.length})`) + (pending.map(u=>row(u,approve(u))).join("") || empty);
    h += head(`관리자 (${admins.length})`) + (admins.map(u=>row(u,"")).join("") || empty);
    h += head(`편집 가능 (${editors.length})`) + (editors.map(u=>row(u,revoke(u))).join("") || empty);
    h += `<div id="viewersToggle" style="font-size:12px;font-weight:800;color:var(--muted);margin:12px 0 6px;cursor:pointer">읽기 전용 (${viewers.length}) ${viewersOpen?"▾":"▸"}</div>`;
    if(viewersOpen) h += (viewers.map(u=>row(u,approve(u))).join("") || empty);
    el.innerHTML = h;
  }
  function openAccess(){ accessQuery=""; viewersOpen=false; ensureAccessModal().classList.add("show"); const si=document.getElementById("accessSearch"); if(si) si.value=""; renderAccess(); }

  (async function(){
    const me = await getMe();
    if(me){ ROLE = me.role || "viewer"; setupSync(); applyRoleUI(); return; }
    let cfg = {};
    try{ cfg = await (await fetch("/api/config")).json(); }catch(_){}
    showLogin(cfg);
  })();
})();
