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

  const APPVER = () => String((typeof APP_VERSION!=="undefined" && APP_VERSION) || (window.APP_VERSION||0));
  let _blocked = false;
  function reloadFresh(){ try{ const u=new URL(location.href); u.searchParams.set("v", String(Date.now())); location.replace(u.toString()); }catch(_){ location.reload(); } }
  function blockOldVersion(){
    if(_blocked) return; _blocked = true;
    try{ remote.active = false; }catch(_){}
    const o = document.createElement("div"); o.id = "oldVersionBlock";
    o.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(8,11,20,.96);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;font-family:'Pretendard',-apple-system,sans-serif;padding:24px";
    o.innerHTML = '<div style="font-size:20px;font-weight:800">새 버전이 배포되었습니다</div><div style="font-size:14px;color:#c7cfdf;line-height:1.7">구버전에서는 데이터 보호를 위해 접속이 제한됩니다.<br>잠시 후 자동으로 최신 버전으로 새로고침됩니다.</div>';
    const b = document.createElement("button"); b.textContent = "지금 새로고침";
    b.style.cssText = "background:#2563eb;color:#fff;border:0;border-radius:9px;padding:10px 18px;font-weight:800;font-size:14px;cursor:pointer";
    b.onclick = reloadFresh; o.appendChild(b); document.body.appendChild(o);
    setTimeout(reloadFresh, 4000);
  }

  function setupSync(){
    remote.active = true; remote.version = -1; remote._t = null; remote.base = null;   // base = 서버와의 공통 기준
    const clone = (o)=> (typeof _clone==="function") ? _clone(o) : (o==null?o:JSON.parse(JSON.stringify(o)));
    let dirty=false, maxTimer=null; const MAXWAIT=1500;
    const focusedControl=()=>{ const ae=document.activeElement; return !!(ae && (ae.tagName==="SELECT"||ae.tagName==="INPUT"||ae.tagName==="TEXTAREA")); };
    const busy=()=> dirty || focusedControl();   // 편집 중(저장 대기 or 컨트롤 포커스): 백그라운드 갱신 보류
    remote.pull = async function(initial){
      if(_blocked) return;
      try{
        const r = await fetch("/api/state", { credentials:"same-origin", headers:{ "X-App-Version": APPVER() } });
        if(r.status===426){ blockOldVersion(); return; }
        if(!r.ok) return;
        const j = await r.json();
        const remoteData = (j.data && j.data.milestones) ? j.data : { milestones:[], tasks:[] };
        if(initial){
          state = remoteData; this.version = j.version; remote.base = clone(remoteData);
          migrate(); buildTimeline(); render(); return;
        }
        if(j.version > this.version){
          if(busy()) return;   // 편집 중이면 이번 갱신은 건너뜀(다음 폴링에서 반영) — 조작 덮어쓰기 방지
          state = (typeof mergeState3==="function") ? mergeState3(remote.base, state, remoteData) : remoteData;   // 3-way 병합
          this.version = j.version; remote.base = clone(remoteData);
          migrate(); buildTimeline(); render();
        }
      }catch(_){}
    };
    const doPush = async () => {
      clearTimeout(remote._t); remote._t=null;
      if(maxTimer){ clearTimeout(maxTimer); maxTimer=null; }
      if(!canEdit() || _blocked){ dirty=false; return; }
      try{
        for(let attempt=0; attempt<5; attempt++){
          const r0 = await fetch("/api/state", { credentials:"same-origin", headers:{ "X-App-Version": APPVER() } });   // 저장 직전 서버 최신
          if(r0.status===426){ blockOldVersion(); return; }
          if(r0.ok){ const j0 = await r0.json(); if(j0 && j0.data){ state = (typeof mergeState3==="function") ? mergeState3(remote.base, state, j0.data) : state; remote.base = clone(j0.data); remote.version = j0.version; } }
          const merged = state;
          const r = await fetch("/api/state", { method:"PUT", credentials:"same-origin",
            headers:{ "content-type":"application/json", "X-App-Version": APPVER() }, body: JSON.stringify({ data: merged, baseVersion: remote.version }) });
          if(r.status===426){ blockOldVersion(); return; }
          if(r.status===409){   // 충돌: 서버 최신으로 재병합 후 재시도(내 변경·남의 변경 모두 보존)
            let cj=null; try{ cj = await r.json(); }catch(_){}
            if(cj && cj.data){ state = (typeof mergeState3==="function") ? mergeState3(remote.base, state, cj.data) : state; remote.base = clone(cj.data); remote.version = cj.version; }
            continue;
          }
          if(r.ok){ const j = await r.json(); remote.version = j.version; state = merged; remote.base = clone(merged); dirty=false; buildTimeline(); if(!focusedControl()) render(); return; }
          dirty=false; return;   // 기타 오류
        }
        dirty=false;   // 재시도 소진 — 다음 편집/폴링에서 다시 반영
      }catch(_){ dirty=false; }
    };
    remote.push = function(){
      if(!canEdit() || _blocked) return;            // 뷰어는 저장 불가(서버도 차단)
      dirty = true;
      if(!maxTimer) maxTimer = setTimeout(doPush, MAXWAIT);   // 연속 편집 중에도 최대 대기시간 안에 반드시 저장
      clearTimeout(this._t);
      this._t = setTimeout(doPush, 800);
    };
    remote.pull(true);
    // 3초 폴링 + 숨긴 탭에서는 네트워크 호출 중단(부하·비용 절약), 다시 보이면 즉시 갱신
    setInterval(() => { if(!_blocked && document.visibilityState==="visible") remote.pull(false); }, 3000);
    document.addEventListener("visibilitychange", () => { if(!_blocked && document.visibilityState==="visible") remote.pull(false); });
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
    if(ROLE==="admin"){ injectAccessButton(); const fr=document.getElementById("forceReloadBtn"); if(fr) fr.style.display=""; }
    else { const hb=document.getElementById("historyBtn"); if(hb) hb.style.display="none"; const fr=document.getElementById("forceReloadBtn"); if(fr) fr.style.display="none"; const mb=document.getElementById("msBtn"); if(mb) mb.style.display="none"; }   // 히스토리·강제새로고침·마일스톤 설정은 관리자 전용
  }
  function injectReadonlyStyle(){
    if(document.getElementById("ro-style")) return;
    const s = document.createElement("style"); s.id = "ro-style";
    s.textContent =
      `body.readonly #addTaskBtn,body.readonly #msBtn,body.readonly #importBtn,body.readonly #titleEditBtn,body.readonly #historyBtn,body.readonly #notifyBtn,body.readonly #noticeBtn{display:none!important;}
       body.readonly .kf-chip,body.readonly .st-sel,body.readonly .done-chip,body.readonly .task-del,body.readonly .drag-handle,body.readonly .meta-row,body.readonly .legend-edit,body.readonly .grp.clickable{pointer-events:none!important;opacity:.5;}
       body.readonly .bar{pointer-events:none!important;}`;
    document.head.appendChild(s);
  }
  function placeBtn(b){ const tools=document.getElementById("footTools"); if(tools){ b.style.marginLeft="0"; tools.appendChild(b); return; } const sync=document.getElementById("syncStatus"); if(sync&&sync.parentNode){ sync.parentNode.insertBefore(b, sync.nextSibling); } else document.querySelector(".topbar").appendChild(b); }
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
