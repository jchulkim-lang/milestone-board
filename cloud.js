/* =====================================================================
 *  cloud.js — 클라우드 배포 시에만 동작 (index.html이 http/https에서 로드)
 *  - 로그인 / 공유 동기화 / 접속자 표시
 *  - 권한: 읽기는 모두, 쓰기는 editor·admin만. 뷰어는 '편집 권한 요청', 관리자는 승인 패널.
 *  로컬 파일(file://)에서는 index.html이 이 파일을 로드하지 않습니다(= 모두 편집 가능).
 * ===================================================================== */
(function(){
  let ROLE = "viewer", ACCESS_ME = "viewer";
  let ME = null;            // /api/me 가 돌려준 사용자 — Task 메모 작성자 표기에 쓴다
  let ACCESS_USERS = [], accessQuery = "", viewersOpen = false;
  const esc = s => (s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  /* 권한 4단계 — master(마스터 관리자) / admin(부관리자) / editor / viewer. 서버 effectiveRole 과 같은 뜻. */
  const isMasterRole  = () => ROLE==="master";
  const isAdminRole   = () => ROLE==="admin" || ROLE==="master";
  const isManagerRole = () => ROLE==="manager" || isAdminRole();   // 담당자·일정을 고칠 수 있는 등급
  const canEdit = () => ROLE==="editor" || isManagerRole();
  /* 저장 실패를 조용히 삼키지 않는다 (2026-10-12). 예전엔 403/5xx 가 와도 dirty=false 로 끝나서,
     화면에는 Task 가 보이는데 서버에는 없고 새로고침하면 사라졌다 → "생성이 안 된다"로 제보됨.
     index.html 의 flashNote 를 쓰되, 로딩 순서에 기대지 않도록 존재 확인 후 호출한다. */
  const note = m => { try{ if(typeof flashNote==="function") flashNote(m); else console.warn(m); }catch(_){ } };

  async function getMe(){
    try{ const r = await fetch("/api/me", { credentials:"same-origin" }); if(r.ok){ const j = await r.json(); return j.user; } }catch(_){}
    return null;
  }

  /* ===== 입장 화면 (2026-11-13, build 2026111301) ==============================
     사용자 요청: "입장 페이지 이쁘게 변경해줘 / 위 이미지를 배경으로 해줘" → 키 아트를 깔았다.
     시안 가안 채택 — **좌측 패널**. 왼쪽에서 오른쪽으로 어두워지다 풀려서
     그림의 핵심(둘로 갈린 얼굴·붉은 반쪽)을 하나도 안 가린다.
     ⚠ 배경은 **로그인 화면에서만** 쓴다. 보드 안쪽에 깔면 간트 막대와 숫자를 읽을 때 눈이 피로하다.
     ⚠ 이미지는 deploy/ 의 정적 파일(bg.jpg 209KB / 좁은 화면용 bg-sm.jpg 91KB)이라
       Workers 요청에 안 잡히고 한 번 받으면 캐시된다. 무료 한도 영향 없음.
     ⚠ 구글 버튼은 theme:"outline"(흰 버튼) — 어두운 아트 위에서 filled_blue 는 묻힌다. */
  function showLogin(cfg){
    document.body.insertAdjacentHTML("beforeend",
      `<style>
        #loginOverlay{position:fixed;inset:0;z-index:99999;overflow:hidden;
          font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;
          color:#e7eaf0;background:#08090e;}
        #loginOverlay .lo-art{position:absolute;inset:0;background:#08090e url("/bg.jpg") center/cover no-repeat;}
        #loginOverlay .lo-scrim{position:absolute;inset:0;background:linear-gradient(100deg,
          rgba(8,9,14,.96) 0%, rgba(8,9,14,.90) 26%, rgba(8,9,14,.55) 44%,
          rgba(8,9,14,.12) 62%, rgba(8,9,14,.35) 100%);}
        #loginOverlay .lo-box{position:absolute;left:clamp(24px,6vw,76px);top:50%;transform:translateY(-50%);
          width:min(420px,calc(100% - 48px));display:flex;flex-direction:column;}
        /* 로고 = SD 캐릭터. 간트 막대에서 교체(2026-11-13) — 홈 화면 아이콘과 같은 그림을 쓴다 */
        /* ⚠ 아이콘이 투명 PNG 라 둥근 사각 틀과 안쪽 흰 링을 두면 **빈 상자**가 보인다(2026-11-16).
           틀 없이 캐릭터만 띄우고 drop-shadow 로 어두운 아트 위에서 떨어뜨린다.
           ⚠ ?v= 는 캐시 때문에 필요하다 — cloud.js 는 서버가 __APP_BUILD__ 를 주입하지 않으므로 APP_VERSION 을 쓴다. */
        #loginOverlay .lo-logo{width:84px;height:84px;margin-bottom:18px;
          background:url("/icon.png?v=${window.APP_VERSION||0}") center/contain no-repeat;
          filter:drop-shadow(0 10px 22px rgba(0,0,0,.75)) drop-shadow(0 0 10px rgba(0,0,0,.5));}
        #loginOverlay .lo-kick{font-size:11px;font-weight:800;letter-spacing:3.4px;color:#cdd3ff;
          text-shadow:0 2px 10px rgba(0,0,0,.85);margin-bottom:10px;}
        #loginOverlay .lo-ttl{font-size:clamp(23px,3.2vw,30px);font-weight:800;letter-spacing:-.8px;
          text-shadow:0 3px 18px rgba(0,0,0,.9);}
        #loginOverlay .lo-sub{font-size:13px;color:#cdd3e0;margin-top:10px;margin-bottom:26px;
          text-shadow:0 2px 10px rgba(0,0,0,.9);}
        #loginOverlay #gbtn{min-height:44px;}
        #loginOverlay .lo-foot{margin-top:24px;font-size:11px;color:#9aa3b5;line-height:1.9;
          text-shadow:0 2px 8px rgba(0,0,0,.9);}
        #loginOverlay .lo-foot b{color:#cdd3e0;font-weight:600;}
        #loginOverlay .lo-err{color:#ff8a8a;font-size:12px;max-width:360px;margin-top:14px;line-height:1.6;}
        /* 좁은 화면 — 가벼운 이미지로 바꾸고 가운데 정렬 */
        @media (max-width:900px){
          #loginOverlay .lo-art{background-image:url("/bg-sm.jpg");}
          #loginOverlay .lo-scrim{background:linear-gradient(180deg,
            rgba(8,9,14,.55) 0%, rgba(8,9,14,.25) 28%, rgba(8,9,14,.82) 62%, rgba(8,9,14,.97) 100%);}
          #loginOverlay .lo-box{left:0;right:0;top:auto;bottom:clamp(28px,8vh,64px);transform:none;
            width:auto;padding:0 24px;align-items:center;text-align:center;}
          #loginOverlay .lo-logo{align-items:center;}
        }
        @media (prefers-reduced-motion:no-preference){
          #loginOverlay .lo-box{animation:loUp .5s cubic-bezier(.2,.7,.3,1) both;}
          @keyframes loUp{from{opacity:0;transform:translateY(calc(-50% + 14px))}to{opacity:1}}
          @media (max-width:900px){ @keyframes loUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}} }
        }
      </style>
      <div id="loginOverlay">
        <div class="lo-art"></div>
        <div class="lo-scrim"></div>
        <div class="lo-box">
          <div class="lo-logo" role="img" aria-label="LIMIT ZERO BREAKERS"></div>
          <div class="lo-kick">LIMIT ZERO BREAKERS</div>
          <div class="lo-ttl">마일스톤 관리</div>
          <div class="lo-sub">부서별 일정과 담당자를 한눈에</div>
          <div id="gbtn"></div>
          <div class="lo-foot">회사 구글 계정으로만 들어올 수 있습니다<br>
            <b>처음 로그인하면 열람 권한으로 시작하고, 편집은 승인 후 열립니다</b></div>
          <div id="loginErr" class="lo-err"></div>
        </div>
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
            if(r.ok){ try{ sessionStorage.setItem("ms_authed_tab","1"); }catch(_){}  try{ const u=new URL(location.href); u.searchParams.set("v", String(Date.now())); location.replace(u.toString()); }catch(_){ location.reload(); } }
            else { const e = await r.json(); document.getElementById("loginErr").textContent = "로그인 실패: " + (e.detail || e.error || ""); }
          }catch(_){ document.getElementById("loginErr").textContent = "네트워크 오류"; }
        }
      });
      google.accounts.id.renderButton(document.getElementById("gbtn"),
        { theme:"outline", size:"large", text:"signin_with", shape:"rectangular", width:300 });
    };
    s.onerror = () => { document.getElementById("loginErr").textContent =
      "구글 로그인 스크립트를 불러오지 못했습니다. 네트워크(방화벽)를 확인해 주세요."; };
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
  /* ===== 전면 안내판 (새 버전 / 세션 만료) — 2026-11-16, build 2026111605 ==================
     [stated] 사용자: "버전이 상승하거나 git을 통해 재배포될 때 「새로 고침」 팝업을 노출하고 있잖아.
                       **그 배경을 입장 화면 위에서 노출**하고 싶어."
     → 밋밋한 `rgba(8,11,20,.96)` 단색을 걷어내고 **입장 화면과 똑같은 키 아트 + 스크림**을 깐다.
     ⚠ `bg.jpg` 는 입장 화면에서 이미 받아 둔 정적 파일이라 **추가 요청이 사실상 0건**이다(캐시 적중).
       못 받아도 밑에 깔린 `#08090e` 가 그대로 보이므로 안내문은 항상 읽힌다.
     ⚠ 좁은 화면은 입장 화면과 같은 기준(900px)으로 `bg-sm.jpg` 를 쓴다. */
  function blockBoard(id, title, body, btnText, onClick){
    const small = Math.min(innerWidth, innerHeight) <= 900;
    const art = (small ? "/bg-sm.jpg" : "/bg.jpg") + "?v=" + (window.APP_VERSION||0);
    const o = document.createElement("div"); o.id = id;
    o.style.cssText = "position:fixed;inset:0;z-index:2147483647;overflow:hidden;color:#fff;"+
      "font-family:'Pretendard',-apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif;background:#08090e";
    o.innerHTML =
      '<div style="position:absolute;inset:0;background:#08090e url(\''+art+'\') center/cover no-repeat"></div>'+
      '<div style="position:absolute;inset:0;background:linear-gradient(100deg,'+
        'rgba(8,9,14,.96) 0%, rgba(8,9,14,.90) 26%, rgba(8,9,14,.62) 46%,'+
        'rgba(8,9,14,.30) 64%, rgba(8,9,14,.50) 100%)"></div>'+
      '<div data-bb-box style="position:absolute;left:clamp(24px,6vw,76px);top:50%;transform:translateY(-50%);'+
        'width:min(430px,calc(100% - 48px));display:flex;flex-direction:column;align-items:flex-start;text-align:left">'+
        '<div style="width:84px;height:84px;margin-bottom:18px;background:url(\'/icon.png?v='+(window.APP_VERSION||0)+'\') center/contain no-repeat;'+
          'filter:drop-shadow(0 10px 22px rgba(0,0,0,.75)) drop-shadow(0 0 10px rgba(0,0,0,.5))"></div>'+
        '<div style="font-size:11px;font-weight:800;letter-spacing:3.4px;color:#cdd3ff;text-shadow:0 2px 10px rgba(0,0,0,.85);margin-bottom:10px">LIMIT ZERO BREAKERS</div>'+
        '<div style="font-size:clamp(21px,2.9vw,27px);font-weight:800;letter-spacing:-.6px;text-shadow:0 3px 18px rgba(0,0,0,.9)">'+title+'</div>'+
        '<div style="font-size:13.5px;color:#cdd3e0;line-height:1.8;margin-top:12px;text-shadow:0 2px 10px rgba(0,0,0,.9)">'+body+'</div>'+
      '</div>';
    const b = document.createElement("button"); b.textContent = btnText;
    b.style.cssText = "margin-top:22px;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:11px 20px;"+
      "font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.5)";
    b.onclick = onClick;
    o.querySelector("[data-bb-box]").appendChild(b);
    document.body.appendChild(o);
    return o;
  }
  function reloadFresh(){ try{ const u=new URL(location.href); u.searchParams.set("v", String(Date.now())); location.replace(u.toString()); }catch(_){ location.reload(); } }
  function blockOldVersion(){
    if(_blocked) return; _blocked = true;
    try{ remote.active = false; }catch(_){}
    blockBoard("oldVersionBlock", "새 버전이 배포되었습니다",
      "구버전에서는 데이터 보호를 위해 접속이 제한됩니다.<br>잠시 후 자동으로 최신 버전으로 새로고침됩니다.",
      "지금 새로고침", reloadFresh);
    setTimeout(reloadFresh, 4000);
  }

  /* 세션이 끊겼을 때 — 예전엔 !r.ok 로 조용히 return 해서 낡은 화면을 계속 보여 줬다.
     이제는 명확히 알리고 폴링을 멈춘다(무한 401 재시도 방지). */
  function blockSessionExpired(){
    if(_blocked) return; _blocked = true;
    try{ remote.active = false; }catch(_){}
    blockBoard("sessionExpiredBlock", "로그인이 만료되었습니다",
      "화면의 내용이 최신이 아닐 수 있습니다.<br>다시 로그인하면 이어서 사용할 수 있습니다.",
      "다시 로그인", ()=>location.reload());
  }

  function setupSync(){
    remote.active = true; remote.version = -1; remote._t = null; remote.base = null;   // base = 서버와의 공통 기준
    const clone = (o)=> (typeof _clone==="function") ? _clone(o) : (o==null?o:JSON.parse(JSON.stringify(o)));
    let dirty=false, maxTimer=null; const MAXWAIT=1500;
    const focusedControl=()=>{ const ae=document.activeElement; return !!(ae && (ae.tagName==="SELECT"||ae.tagName==="INPUT"||ae.tagName==="TEXTAREA")); };
    const busy=()=> dirty || focusedControl();   // 편집 중(저장 대기 or 컨트롤 포커스): 백그라운드 갱신 보류
    /* 폴링 1회 = 요청 1회. 접속자 하트비트·목록을 같은 응답에 실어 받는다(예전엔 /api/presence 2개를 따로 호출).
       ?v=<내 버전> 을 보내 서버와 같으면 서버가 본문을 생략(unchanged) → 전송량도 절감. */
    let lastBeat = 0;
    const BEAT_GAP = 60000;                      // 하트비트는 약 1분에 한 번만
    remote.pull = async function(initial){
      if(_blocked) return;
      try{
        const q = new URLSearchParams();
        q.set("p","1");
        if(!initial && this.version >= 0) q.set("v", String(this.version));
        const nowT = Date.now();
        if(initial || nowT - lastBeat > BEAT_GAP){ q.set("beat","1"); lastBeat = nowT; }
        const r = await fetch("/api/state?"+q.toString(), { credentials:"same-origin", headers:{ "X-App-Version": APPVER() } });
        if(r.status===426){ blockOldVersion(); return; }
        if(r.status===401){ blockSessionExpired(); return; }
        if(!r.ok) return;
        const j = await r.json();
        if(j.presence) showPresence(j.presence);
        showLastEdit(j.updatedBy, j.updatedAt);
        if(j.unchanged) return;                  // 서버와 버전 동일 — 할 일 없음
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
      if(_blocked){ dirty=false; return; }
      if(!canEdit()){ if(dirty) note("읽기 전용 권한이라 변경 내용이 서버에 저장되지 않습니다. 하단의 ‘편집 권한 요청’을 눌러 주세요."); dirty=false; return; }
      try{
        for(let attempt=0; attempt<5; attempt++){
          const r0 = await fetch("/api/state", { credentials:"same-origin", headers:{ "X-App-Version": APPVER() } });   // 저장 직전 서버 최신
          if(r0.status===426){ blockOldVersion(); return; }
          if(r0.status===401){ blockSessionExpired(); return; }
          if(r0.ok){ const j0 = await r0.json(); if(j0 && j0.data){ state = (typeof mergeState3==="function") ? mergeState3(remote.base, state, j0.data) : state; remote.base = clone(j0.data); remote.version = j0.version; } }
          const merged = state;
          const r = await fetch("/api/state", { method:"PUT", credentials:"same-origin",
            headers:{ "content-type":"application/json", "X-App-Version": APPVER() }, body: JSON.stringify({ data: merged, baseVersion: remote.version }) });
          if(r.status===426){ blockOldVersion(); return; }
          if(r.status===401){ blockSessionExpired(); return; }   // 저장분이 조용히 사라지지 않도록 알린다
          if(r.status===403){ note("저장 권한이 없어 서버에 반영되지 않았습니다. 편집 권한을 요청해 주세요."); dirty=false; return; }
          if(r.status===409){   // 충돌: 서버 최신으로 재병합 후 재시도(내 변경·남의 변경 모두 보존)
            let cj=null; try{ cj = await r.json(); }catch(_){}
            if(cj && cj.data){ state = (typeof mergeState3==="function") ? mergeState3(remote.base, state, cj.data) : state; remote.base = clone(cj.data); remote.version = cj.version; }
            continue;
          }
          if(r.ok){ const j = await r.json(); remote.version = j.version; state = merged; remote.base = clone(merged); dirty=false; showLastEdit(j.updatedBy, j.updatedAt); buildTimeline(); if(!focusedControl()) render(); return; }
          dirty=false; note("저장에 실패했습니다 (오류 "+r.status+"). 잠시 후 다시 시도해 주세요."); return;   // 기타 오류
        }
        dirty=false; note("저장이 여러 번 충돌해 이번 변경은 반영되지 않았습니다. 다시 한 번 수정해 주세요.");   // 재시도 소진
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
    /* Workers 무료 한도(하루 10만 요청) 대응 — 요청 수를 줄이는 게 핵심.
     *  · 숨긴 탭에서는 아무 호출도 하지 않는다(예전엔 접속자 하트비트가 24시간 계속 돌았다).
     *  · 조작 중에는 8초, 5분간 아무 조작이 없으면 30초 간격으로 완화. 다시 만지면 즉시 8초로 복귀.
     *  · 접속자 표시는 이 폴링 응답에 함께 실려 오므로 별도 요청이 없다. */
    const POLL_ACTIVE=8000, POLL_IDLE=30000, IDLE_AFTER=5*60*1000;
    let lastAct=Date.now(), lastPoll=Date.now();
    const touch=()=>{ lastAct=Date.now(); };
    ["pointerdown","keydown","wheel"].forEach(ev=>document.addEventListener(ev, touch, {passive:true}));
    setInterval(() => {
      if(_blocked || document.visibilityState!=="visible") return;
      const now=Date.now();
      const gap=(now-lastAct > IDLE_AFTER) ? POLL_IDLE : POLL_ACTIVE;
      if(now-lastPoll < gap) return;
      lastPoll=now; remote.pull(false);
    }, 2000);
    document.addEventListener("visibilitychange", () => {
      if(_blocked || document.visibilityState!=="visible") return;
      lastAct=Date.now(); lastPoll=Date.now(); remote.pull(false);
    });
    setStatus("☁ 동기화 중");
  }

  /* 마지막으로 누가·언제 바꿨는지 (하단 바 왼쪽).
     서버가 app_state 행에 갖고 있던 updated_by/updated_at 을 그동안 아무 데도 안 썼다. 추가 요청 없음. */
  let _lastEdit={by:"",at:""};
  function relTime(iso){
    const t=Date.parse(String(iso||"").replace(" ","T")+((/[zZ]|[+-]\d\d:?\d\d$/.test(String(iso||"")))?"":"Z"));
    if(!isFinite(t)) return "";
    const s=Math.max(0,Math.round((Date.now()-t)/1000));
    if(s<60) return "방금";
    if(s<3600) return Math.floor(s/60)+"분 전";
    if(s<86400) return Math.floor(s/3600)+"시간 전";
    return Math.floor(s/86400)+"일 전";
  }
  function paintLastEdit(){
    const el=document.getElementById("lastEdit"); if(!el) return;
    if(!_lastEdit.by && !_lastEdit.at){ el.textContent=""; el.title=""; return; }
    const who=(_lastEdit.by||"").split("@")[0];
    const rel=relTime(_lastEdit.at);
    el.textContent=`✎ ${who||"?"}${rel?" · "+rel:""}`;
    el.title=`마지막 수정: ${_lastEdit.by||"?"}${_lastEdit.at?" · "+_lastEdit.at:""}`;
  }
  function showLastEdit(by, at){
    if(by===undefined && at===undefined) return;
    _lastEdit={ by: by||_lastEdit.by, at: at||_lastEdit.at };
    paintLastEdit();
  }
  setInterval(paintLastEdit, 60000);          // "3분 전" 을 계속 맞춰 준다 (네트워크 호출 없음)

  /* 접속자 표시 — /api/state 응답에 함께 실려 온 값을 그리기만 한다(별도 요청 없음) */
  function showPresence(pr){
    const roleTxt = ROLE==="master" ? "마스터 관리자" : (ROLE==="admin" ? "부관리자"
                  : (ROLE==="manager" ? "매니저" : (ROLE==="editor" ? "편집 가능" : "읽기 전용")));
    setStatus(`${roleTxt} · ☁ ${pr.count}명`, (pr.users||[]).map(u=>u.name || u.email));
  }

  /* ----- 역할별 UI ----- */
  function applyRoleUI(){
    window.APP_ROLE = ROLE;   // index.html 이 읽는 역할값 (마일스톤 설정 읽기전용 판단 등)
    /* Task 메모의 '누가 썼는지'에 쓴다. 로컬 단독 실행이면 null 이라 index.html 이 '나'로 적는다. */
    window.APP_USER = ME ? { name: ME.name || "", email: ME.email || "" } : null;
    document.body.classList.toggle("role-admin", isAdminRole());
    document.body.classList.toggle("role-master", isMasterRole());
    /* 매니저 미만이면 담당자·일정 칸을 잠근다 — index.html 의 asgCanEdit() 와 같은 기준 */
    document.body.classList.toggle("noassign", !isManagerRole());
    if(!canEdit()){ document.body.classList.add("readonly"); injectReadonlyStyle(); injectRequestButton(); }
    /* 부관리자 이상: 권한 관리 · 히스토리 열람 */
    if(isAdminRole()){ injectAccessButton(); injectStatsButton(); }
    else { const hb=document.getElementById("historyBtn"); if(hb) hb.style.display="none"; }
    /* 마스터 전용: 트렐로 관리 · 강제 새로고침 (서버도 같이 막는다 — 숨김만으로는 의미가 없다) */
    const fr=document.getElementById("forceReloadBtn"); if(fr) fr.style.display = isMasterRole() ? "" : "none";
    const tb=document.getElementById("trelloBtn");      if(tb) tb.style.display = isMasterRole() ? "" : "none";
    /* NC 제출 엑셀 — 사외 제출물이라 매니저 이상만. 서버(/api/trello/batch)도 같은 기준으로 막는다 */
    const nx=document.getElementById("ncxBtn");         if(nx) nx.style.display = isManagerRole() ? "" : "none";
    // 마일스톤 설정(#msBtn)은 전원 열람 가능 — 편집 컨트롤만 index.html 쪽에서 관리자에게만 열어 준다
  }
  function injectReadonlyStyle(){
    if(document.getElementById("ro-style")) return;
    const s = document.createElement("style"); s.id = "ro-style";
    s.textContent =
      `body.readonly #addTaskBtn,body.readonly #importBtn,body.readonly #titleEditBtn,body.readonly #historyBtn,body.readonly #notifyBtn,body.readonly #noticeBtn{display:none!important;}
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
  function injectStatsButton(){
    if(document.getElementById("statsBtn")) return;
    const b = document.createElement("button"); b.id="statsBtn"; b.className="btn ghost sm"; b.style.marginLeft="6px"; b.textContent="📈 접속 통계";
    b.title = "월별 · 총 누적 접속자 (관리자 전용)";
    b.onclick = openStats; placeBtn(b);
  }

  /* ===== 접속 통계 (2026-11-18, build 2026111801) ==============================
     [stated] "최근 접속자 수를 통계 내도록해줘. 월별 누적 총 누적 / 관리자만 볼 수 있어"
     [stated] 열람 범위는 **부관리자 이상**, 명단은 **실명 + 마지막 접속** (2026-11-18 선택)
     서버는 /api/visits. 집계 원부는 visit_days(email, KST 날짜) — 사람·하루 1건.
     ⚠ 과거는 소급되지 않는다. 표를 처음 만들 때 users.last_seen 으로 1인 1건만 씨딩된다.
     비용: 쓰기는 사람당 하루 1건, app_state(JSON) 와 무관 → 폴링 전송량 0 증가. */
  const ST_TD  = "padding:7px 0;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums";
  const ST_TD0 = "padding:7px 0;border-bottom:1px solid var(--line);text-align:left;font-weight:700";
  function stHead(t){ return `<div style="font-size:12px;font-weight:800;color:var(--muted);margin:14px 0 7px">${t}</div>`; }
  function ensureStatsModal(){
    let m = document.getElementById("statsModal"); if(m) return m;
    m = document.createElement("div"); m.id="statsModal"; m.className="modal-bg";
    m.innerHTML = `<div class="modal" style="width:560px"><h3>접속 통계 📈</h3>
      <div class="msub">관리자 전용입니다. 사람 단위로 <b>하루 1회</b>만 집계합니다 — 같은 날 여러 번 들어와도 1입니다.</div>
      <div id="statsBody" style="max-height:62vh;overflow:auto">불러오는 중…</div>
      <div class="modal-actions"><span style="font-size:11px;color:var(--muted)">한국 시간(KST) 날짜 기준</span>
        <div class="right"><button class="btn ghost" id="statsCopy">표 복사</button><button class="btn" id="statsClose">닫기</button></div></div></div>`;
    document.body.appendChild(m);
    m.addEventListener("click", e=>{ if(e.target===m) m.classList.remove("show"); });
    m.querySelector("#statsClose").onclick = () => m.classList.remove("show");
    m.querySelector("#statsCopy").onclick = copyStats;
    return m;
  }
  function openStats(){ ensureStatsModal().classList.add("show"); renderStats(); }
  let STATS = null;
  async function renderStats(){
    const el = document.getElementById("statsBody"); if(!el) return;
    el.innerHTML = "불러오는 중…";
    let j;
    try{
      const r = await fetch("/api/visits", { credentials:"same-origin" });
      if(!r.ok){ el.innerHTML = '<div class="dm-empty">권한이 없습니다.</div>'; return; }
      j = await r.json();
    }catch(_){ el.innerHTML = '<div class="dm-empty">불러오기 실패</div>'; return; }
    STATS = j;
    const ms = j.months || [], tot = j.total || { users:0, days:0 }, rec = j.recent || [];
    const cur = ms.find(m=>m.ym===j.ym) || { users:0, days:0 };
    const mx = Math.max(1, ...ms.map(m=>Number(m.users)||0));
    const tile = (k,v,u) => `<div style="background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px">
      <div style="font-size:11px;color:var(--muted);font-weight:700">${k}</div>
      <div style="font-size:22px;font-weight:800;margin-top:3px;letter-spacing:-.5px">${v}<small style="font-size:12px;font-weight:600;color:var(--muted);margin-left:2px">${u}</small></div></div>`;
    let h = `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
      ${tile("총 누적 접속자", tot.users||0, "명")}
      ${tile(`이번 달 (${Number(String(j.ym||"").slice(5,7))||"?"}월)`, cur.users||0, "명")}
      ${tile("오늘", j.todayCount||0, "명")}</div>`;
    h += stHead("월별 누적");
    if(!ms.length) h += '<div class="dm-empty">아직 집계된 날이 없습니다.</div>';
    else{
      const th = (t,r) => `<th style="text-align:${r?"right":"left"};font-size:11px;color:var(--muted);font-weight:700;padding:0 0 6px;border-bottom:1px solid var(--line)">${t}</th>`;
      h += `<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead><tr>${th("월",0)}${th("접속자",1)}${th("접속 일수",1)}${th("1인 평균",1)}</tr></thead><tbody>`;
      ms.forEach(m=>{
        const w = Math.round((Number(m.users)||0)/mx*100);
        const avg = ((Number(m.days)||0)/(Number(m.users)||1)).toFixed(1);
        h += `<tr><td style="${ST_TD0}">${esc(m.ym)}<div style="height:6px;background:var(--panel2);border-radius:4px;overflow:hidden;margin-top:4px"><i style="display:block;height:100%;width:${w}%;background:var(--accent);border-radius:4px"></i></div></td>`
           + `<td style="${ST_TD}">${m.users}</td><td style="${ST_TD}">${m.days}</td><td style="${ST_TD};color:var(--muted)">${avg}일</td></tr>`;
      });
      h += `<tr><td style="${ST_TD0};color:var(--muted)">합계 <span style="font-weight:400;font-size:11px">(중복 제거)</span></td>`
         + `<td style="${ST_TD}"><b>${tot.users}</b></td><td style="${ST_TD}"><b>${tot.days}</b></td><td style="${ST_TD};color:var(--muted)">—</td></tr></tbody></table>`;
    }
    h += stHead(`최근 접속자 (${rec.length}명)`);
    if(!rec.length) h += '<div class="dm-empty">없음</div>';
    else h += `<div style="display:flex;flex-direction:column;gap:1px">` + rec.map((u,i)=>{
      const live = (Date.now() - Date.parse(String(u.at||"").replace(" ","T")+"Z")) < 180000;
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;font-size:12.5px${i%2?"":";background:var(--panel2)"}">`
        + `<i style="width:6px;height:6px;border-radius:50%;flex:none;background:${live?"#22c55e":"var(--line)"}"></i>`
        + `<b style="font-weight:700">${esc(u.name||u.email)}</b>`
        + `<span style="margin-left:auto;color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums" title="${esc(u.at||"")} UTC">${esc(relTime(u.at))}</span></div>`;
    }).join("") + `</div>`;
    h += `<div style="font-size:11px;color:var(--muted);margin-top:12px;line-height:1.6;padding-top:10px;border-top:1px dashed var(--line)">`
      + `· 날짜 단위 집계는 <b>2026-11-18부터</b> 쌓입니다. 그 이전은 기존 「마지막 접속일」 1건만 반영되어(소급 불가) 지난 달 수치는 실제보다 작습니다.<br>`
      + `· 「접속 일수」는 \u2018사람 x 날\u2019 의 합입니다. 합계의 접속자는 전체 기간 고유 인원이라 월별 합과 다릅니다.</div>`;
    el.innerHTML = h;
  }
  async function copyStats(){
    if(!STATS) return;
    const b = document.getElementById("statsCopy"); const old = b ? b.textContent : "";
    const rows = [["월","접속자(명)","접속 일수"]]
      .concat((STATS.months||[]).map(m=>[m.ym, m.users, m.days]))
      .concat([["총 누적(고유)", (STATS.total||{}).users||0, (STATS.total||{}).days||0]]);
    const tsv = rows.map(r=>r.join("\t")).join("\n");
    try{ await navigator.clipboard.writeText(tsv); if(b){ b.textContent="복사됨 ✓"; setTimeout(()=>{ b.textContent=old; }, 1400); } }
    catch(_){ if(b){ b.textContent="복사 실패"; setTimeout(()=>{ b.textContent=old; }, 1400); } }
  }

  function ensureAccessModal(){
    let m = document.getElementById("accessModal"); if(m) return m;
    m = document.createElement("div"); m.id="accessModal"; m.className="modal-bg";
    m.innerHTML = `<div class="modal" style="width:500px"><h3>권한 관리 👥</h3>
      <div class="msub" id="accessSub">불러오는 중…</div>
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
      const j = await r.json(); ACCESS_USERS = j.users || []; ACCESS_ME = j.me || ROLE; drawAccess();
    }catch(_){ el.innerHTML = '<div class="dm-empty">불러오기 실패</div>'; }
  }
  function drawAccess(){
    const el = document.getElementById("accessResults"); if(!el) return;
    const q = accessQuery.trim().toLowerCase();
    const match = u => !q || (u.name||"").toLowerCase().includes(q) || (u.email||"").toLowerCase().includes(q);
    const us = ACCESS_USERS.filter(match);
    const iAmMaster = ACCESS_ME === "master";
    const sub = document.getElementById("accessSub");
    if(sub) sub.textContent = iAmMaster
      ? "마스터 관리자입니다. 부관리자·매니저 임명과 편집 권한 승인을 할 수 있습니다. 담당자 배정과 일정 변경은 매니저 이상만 됩니다."
      : "부관리자입니다. 매니저 임명과 편집 권한 승인을 할 수 있고, 부관리자 임명·해임은 마스터만 할 수 있습니다.";
    const masters  = us.filter(u=>u.role==="master");
    const pending  = us.filter(u=>!["editor","manager","admin","master"].includes(u.role) && u.requested);
    const admins   = us.filter(u=>u.role==="admin");
    const managers = us.filter(u=>u.role==="manager");
    const editors  = us.filter(u=>u.role==="editor");
    const viewers = us.filter(u=>u.role==="viewer" && !u.requested);
    const row = (u,btn) => `<div class="ms-item" style="cursor:default"><span class="ms-name">${esc(u.name||u.email)}</span><span class="ms-range">${esc(u.email)}</span>${btn||""}</div>`;
    const approve = u => `<button class="meta-btn set" data-grant="editor" data-email="${esc(u.email)}">편집 승인</button>`;
    const revoke  = u => `<button class="meta-btn" data-grant="viewer" data-email="${esc(u.email)}">읽기 전용으로</button>`;
    /* 부관리자 임명·해임 버튼은 **마스터에게만** 그린다. 서버도 같은 규칙으로 막는다. */
    const promote = u => iAmMaster ? `<button class="meta-btn set" data-grant="admin" data-email="${esc(u.email)}">부관리자로</button>` : "";
    const demote  = u => iAmMaster ? `<button class="meta-btn" data-grant="manager" data-email="${esc(u.email)}">매니저로</button>` : "";
    /* 매니저 임명·해임은 **마스터와 부관리자** 둘 다 (2026-10-30 사용자 선택) */
    const toMgr   = u => `<button class="meta-btn set" data-grant="manager" data-email="${esc(u.email)}">매니저로</button>`;
    const unMgr   = u => `<button class="meta-btn" data-grant="editor" data-email="${esc(u.email)}">편집 가능으로</button>`;
    const head = t => `<div style="font-size:12px;font-weight:800;color:var(--muted);margin:12px 0 6px">${t}</div>`;
    const empty = `<div class="dm-empty">없음</div>`;
    let h = "";
    h += head(`🔔 승인 대기 (${pending.length})`) + (pending.map(u=>row(u,approve(u))).join("") || empty);
    h += head(`👑 마스터 관리자 (${masters.length})`) + (masters.map(u=>row(u,"")).join("") || empty);
    h += head(`부관리자 (${admins.length})`) + (admins.map(u=>row(u,demote(u))).join("") || empty);
    h += head(`🗂 매니저 (${managers.length}) — 담당자 배정·일정 변경 가능`)
       + (managers.map(u=>row(u, unMgr(u)+promote(u))).join("") || empty);
    h += head(`편집 가능 (${editors.length})`) + (editors.map(u=>row(u, revoke(u)+toMgr(u)+promote(u))).join("") || empty);
    h += `<div id="viewersToggle" style="font-size:12px;font-weight:800;color:var(--muted);margin:12px 0 6px;cursor:pointer">읽기 전용 (${viewers.length}) ${viewersOpen?"▾":"▸"}</div>`;
    if(viewersOpen) h += (viewers.map(u=>row(u,approve(u))).join("") || empty);
    el.innerHTML = h;
  }
  function openAccess(){ accessQuery=""; viewersOpen=false; ensureAccessModal().classList.add("show"); const si=document.getElementById("accessSearch"); if(si) si.value=""; renderAccess(); }

  (async function(){
    const me = await getMe();
    // 편집 전 매 접속(탭) 1회 로그인 요구 — 세션이 살아있어도 이 탭에서 로그인해야 진입. 로그인 시 최신 버전으로 새로고침.
    let authedTab=false; try{ authedTab = sessionStorage.getItem("ms_authed_tab")==="1"; }catch(_){}
    if(me && authedTab){ ME = me; ROLE = me.role || "viewer"; setupSync(); applyRoleUI(); return; }
    let cfg = {};
    try{ cfg = await (await fetch("/api/config")).json(); }catch(_){}
    showLogin(cfg);
  })();
})();
