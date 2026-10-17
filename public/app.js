const $ = (s) => document.querySelector(s);
const OFFLINE_MSG = '서버에 연결할 수 없습니다. 앱이 종료된 상태입니다. START.bat 으로 다시 실행한 뒤 이 페이지를 새로고침하세요.';
function setOffline(off) {
  let b = document.getElementById('offline');
  if (off && !b) { b = document.createElement('div'); b.id = 'offline'; b.className = 'offline'; b.textContent = '⚠ ' + OFFLINE_MSG; document.body.prepend(b); }
  if (!off && b) b.remove();
}
const api = async (url, opt = {}) => {
  let r;
  try { r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined }); }
  catch { setOffline(true); throw new Error(OFFLINE_MSG); }
  setOffline(false);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
const fmt = (s) => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0'); };

let presets = [], jobs = [], selected = null, info = null;
const logEl = $('#log');
function logLine(t, level, msg) {
  const d = document.createElement('div');
  d.className = level + (msg.startsWith('──') ? ' step' : '');
  d.textContent = `[${t}] ${msg}`;
  logEl.appendChild(d);
  if (logEl.children.length > 1500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}
$('#btnClearLog').onclick = () => logEl.textContent = '';

// ── 초기화
async function init() {
  info = await api('/api/info');
  $('#ver').textContent = 'v' + info.version;
  $('#lan').textContent = ['localhost:' + info.port, ...info.lan.map(l => l.url.replace('http://', ''))].join('  ·  ');
  presets = await api('/api/presets');
  const sel = $('#preset');
  sel.innerHTML = presets.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  try { const last = localStorage.getItem('pf.preset'); if (last && presets.some(p => p.id === last)) sel.value = last; } catch {}   // 새로고침해도 마지막 프리셋 유지
  sel.onchange = () => { try { localStorage.setItem('pf.preset', sel.value); } catch {} updatePresetUI(); }; updatePresetUI();
  const cfg = await api('/api/config');
  fillForm($('#cfgForm'), cfg);
  applyActive(cfg.provider || 'treblo');
  if (!cfg.hasApiKey && !cfg.hasLyriaKey) openKeyModal('작곡 AI API 키가 없습니다. Treblo 또는 Lyria 키를 등록하세요. 로컬 폴더·테스트 소스는 키 없이 쓸 수 있습니다.');
  if (cfg.hasApiKey) refreshBalance();
  providerChanged();
  refreshYt();
  jobs = await api('/api/jobs'); renderJobs();
  const qj = new URLSearchParams(location.search).get('job'); if (qj && jobs.some(j => j.id === qj)) select(qj);   // ?job=작업id 로 바로 선택(링크·캡처용)
  if (!location.search.includes('nosse')) connectSSE();   // ?nosse=1: 화면 캡처 테스트용(실시간 갱신 끔)
  if (location.hash === '#preset') openPresetModal($('#preset').value);   // 링크로 바로 열기
  if (location.hash === '#keys') openKeyModal();                           // 링크로 설정(키) 모달 바로 열기
}
function updatePresetUI() {
  const p = presets.find(x => x.id === $('#preset').value); if (!p) return;
  $('#presetDesc').textContent = p.description + (p.instrumental ? ' (연주곡: 가사 자막 없음)' : '') + (p.koDescription && p.useKoDescription !== false ? ' · 한국어 상세 설명 사용 중' : '');
  estimate();
}
async function estimate() {
  const body = formData();
  try {
    const e = await api('/api/plan', { method: 'POST', body });
    const prov = $('#provider').value;
    const p = presets.find(x => x.id === body.preset);
    const forced = p && !p.instrumental && e.instrumental ? '\u26a0 보컬 프리셋을 연주곡으로 만듭니다(프롬프트에서 보컬 묘사를 뺌). 프리셋 본래의 보컬 결과를 보려면 Treblo를 활성화하고 보컬 옵션을 "프리셋 기본"으로 두세요.\n' : '';
    $('#estimate').textContent = forced + (prov === 'treblo'
      ? `예상: ${e.specs.length}곡 · 크레딧 ${e.credits} · 영상 약 ${e.estMinutes}분 · ${e.instrumental ? '연주곡' : (e.gender === 'male' ? '남성 보컬' : e.gender === 'female' ? '여성 보컬' : '보컬') + ' (' + e.lang + ')'}`
      : prov === 'lyria'
      ? (e.instrumental ? `예상: ${e.specs.length}곡 · 약 $${e.lyriaUsd.toFixed(2)} (곡당 $0.08, Google 결제 계정에 청구) · 영상 약 ${e.estMinutes}분 · 연주곡` : `⚠ Lyria 소스는 연주곡 전용입니다. 연주곡 프리셋을 고르거나 보컬 옵션을 "연주곡"으로 바꾸세요. (가사 타이밍 데이터가 없어 가사 자막을 만들 수 없음)`)
      : prov === 'local' ? `input 폴더의 파일 중 앞에서 ${e.specs.length}개를 사용합니다.` : `테스트: ${e.specs.length}곡 × ${body.mockSeconds || 20}초 합성음, 크레딧 0`);
  } catch {}
}
['#count', '#language', '#instrumental', '#mockSeconds'].forEach(s => $(s).addEventListener('change', estimate));
$('#provider').addEventListener('change', providerChanged);
async function providerChanged() {
  const prov = $('#provider').value;
  // Lyria 는 연주곡 전용: 보컬 옵션이 '프리셋 기본'이고 프리셋이 보컬곡이면 연주곡으로 자동 전환
  if (prov === 'lyria') { const p = presets.find(x => x.id === $('#preset').value); if (p && !p.instrumental && $('#instrumental').value === '') $('#instrumental').value = 'true'; }
  $('#mockSeconds').parentElement.style.visibility = prov === 'mock' ? 'visible' : 'hidden';
  const lf = $('#localFiles');
  if (prov === 'local') {
    const files = await api('/api/local/files');
    lf.hidden = false;
    lf.textContent = files.length ? `input/ 파일 ${files.length}개: ` + files.map(f => f.title + (f.hasLyrics ? '♪' : '')).join(', ') : 'input/ 폴더가 비어 있습니다. mp3/m4a/wav 파일을 넣고 같은 이름의 .txt 가사를 두면 자막이 생깁니다.';
  } else lf.hidden = true;
  estimate();
}

function formData() {
  const f = new FormData($('#form')); const o = {};
  for (const [k, v] of f.entries()) o[k] = v;
  o.count = Number(o.count); o.mockSeconds = Number(o.mockSeconds);
  const voc = o.instrumental;   // '' | 'false' | 'male' | 'female' | 'true'
  if (voc === 'male' || voc === 'female') o.vocalGender = voc; else delete o.vocalGender;
  o.instrumental = voc === '' ? null : voc === 'true';
  o.subtitles = o.subtitles !== 'false';
  if (o.provider === 'mock') { o.dryRun = true; }
  for (const k of ['title', 'thumbnailText', 'backgroundImage', 'extraPrompt', 'thumbnailStyle']) if (!o[k]) delete o[k];
  return o;
}

// ── 로그 새 창(선택). 기본은 작업 칸 아래 인라인 로그이며, 이 창은 두 번째 모니터용. 이름을 고정해 두 번 열어도 같은 창을 재사용한다.
let logWinRef = null;
function openLogWindow(jobId) {
  const url = jobId && jobId !== 'latest' ? `/log.html?job=${encodeURIComponent(jobId)}` : '/log.html';
  const w = Math.min(1000, screen.availWidth - 40), h = Math.min(640, screen.availHeight - 80);
  const left = Math.max(0, screen.availWidth - w - 20), top = Math.max(0, screen.availHeight - h - 40);
  const win = window.open(url, 'playlist-log', `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=no`);
  if (win) { logWinRef = win; try { win.focus(); } catch {} }
  else alert('브라우저가 팝업을 막았습니다. 주소창의 팝업 차단 아이콘에서 허용하세요. (로그는 이 화면 아래에도 표시됩니다)');
  return win;
}
$('#btnLog').onclick = () => openLogWindow(selected || 'latest');

// ── 작업 시작
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const body = formData();
  // 비용이 드는 소스는 화면 안 모달로 확인한다. 브라우저 기본 confirm() 은 메인 창을 앞으로 끌어와 먼저 연 로그 창이 뒤로 숨는다.
  if (body.provider === 'treblo' || body.provider === 'lyria') {
    const est = await api('/api/plan', { method: 'POST', body }).catch(() => null);
    if (body.provider === 'lyria' && est && !est.instrumental) { alert('Lyria 소스는 연주곡 전용입니다. 연주곡 프리셋을 고르거나 보컬 옵션을 "연주곡"으로 바꾸세요.'); return; }
    if (est) {
      const text = body.provider === 'treblo'
        ? `Treblo API로 <b>${est.specs.length}곡</b>을 생성합니다. 크레딧 <b>${est.credits}</b>이 사용됩니다.`
        : `Google Lyria로 <b>${est.specs.length}곡</b>(연주곡)을 생성합니다. 약 <b>$${est.lyriaUsd.toFixed(2)}</b> (곡당 $0.08)이 Google 결제 계정에 청구됩니다.`;
      modal('생성 확인', `<p>${text}</p><p class="dim">[계속]을 누르면 작업이 시작되고 진행 로그가 작업 칸 아래에 표시됩니다.</p>`, [
        { label: '계속', cls: 'primary', onClick: () => { $('#modal').hidden = true; startJob(body); } },
        { label: '취소', onClick: () => $('#modal').hidden = true },
      ]);
      return;
    }
  }
  startJob(body);
};
async function startJob(body) {
  $('#btnRun').disabled = true;
  try { const j = await api('/api/jobs', { method: 'POST', body }); select(j.id); }
  catch (err) { alert(err.message); }
  finally { $('#btnRun').disabled = false; }
}
$('#btnOpenInput').onclick = () => api('/api/open', { method: 'POST', body: { path: 'input' } }).catch(e => alert(e.message));
$('#btnOpenOutput').onclick = () => api('/api/open', { method: 'POST', body: { path: 'output' } }).catch(e => alert(e.message));

// ── 설정
function fillForm(form, cfg) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.name.split('.').reduce((o, k) => o?.[k], cfg);
    if (v === undefined || v === null) continue;
    if (el.name === 'images.pexelsKey') { if (v) el.placeholder = '저장됨'; continue; }
    if (el.name === 'anthropic.apiKey') { if (cfg.hasAnthropicKey) el.placeholder = '저장됨 (****)'; continue; }
    el.value = String(v);
  }
}
$('#cfgForm').onsubmit = async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of $('#cfgForm').elements) {
    if (!el.name) continue;
    let v = el.value;
    if ((el.name === 'treblo.apiKey' || el.name === 'lyria.apiKey' || el.name === 'images.pexelsKey' || el.name === 'anthropic.apiKey') && !v) continue;
    if (el.type === 'number') v = Number(v);
    if (v === 'true') v = true; if (v === 'false') v = false;
    const keys = el.name.split('.'); let o = patch;
    keys.slice(0, -1).forEach(k => o = (o[k] ??= {}));
    o[keys.at(-1)] = v;
  }
  let cfg;
  try { cfg = await api('/api/config', { method: 'POST', body: patch }); } catch (err) { alert(err.message); return; }
  fillForm($('#cfgForm'), cfg);
  $('#cfgMsg').textContent = '저장됨 ' + new Date().toLocaleTimeString();
  if (cfg.hasApiKey) refreshBalance();
};
async function refreshBalance() {
  const el = $('#credits');
  try { const b = await api('/api/treblo/balance'); el.textContent = `크레딧 ${(b.num_credits || 0).toLocaleString()} + 종량제 ${(b.num_credits_payg || 0).toLocaleString()}`; el.className = 'chip ok'; }
  catch (e) { el.textContent = '크레딧 확인 실패'; el.className = 'chip err'; el.title = e.message; }
}

// ── 설정 모달: 작곡 AI API 키 관리 (Treblo · Lyria)
$('#btnSettings').onclick = () => openKeyModal();
$('#kmClose').onclick = () => $('#kmodal').hidden = true;
$('#kmodal').addEventListener('click', (e) => { if (e.target === $('#kmodal')) $('#kmodal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#kmodal').hidden) $('#kmodal').hidden = true; });
async function openKeyModal(msg = '') {
  $('#kmMsg').textContent = msg;
  for (const c of document.querySelectorAll('#kmBody .kcard')) { c.querySelector('[data-r=key]').value = ''; c.querySelector('[data-r=msg]').textContent = ''; }
  $('#kmodal').hidden = false;
  await refreshKeys();
}
// 활성 작곡 AI 반영: 소스 목록에서 대기 소스는 선택 불가, 선택돼 있었으면 활성 소스로 바꿈
function applyActive(active) {
  const sel = $('#provider'); let changed = false;
  for (const o of sel.options) {
    if (!o.dataset.label) continue;
    const standby = o.value !== active;
    o.disabled = standby; o.textContent = o.dataset.label + (standby ? '  — 대기 (설정에서 활성화)' : '');
    if (standby && sel.value === o.value) { sel.value = active; changed = true; }
  }
  if (changed) providerChanged();
}
const NAMES = { treblo: 'Treblo', lyria: 'Lyria', anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' };
async function refreshKeys() {
  let ks; try { ks = await api('/api/keys'); } catch (e) { $('#kmMsg').textContent = e.message; return; }
  const active = Object.keys(ks).find(p => ks[p].kind === 'music' && ks[p].active) || 'treblo';
  applyActive(active);
  // 메인 LLM 에 키가 없는데 다른 LLM 에는 키가 있으면 안내
  const mainLlm = Object.keys(ks).find(p => ks[p].kind === 'llm' && ks[p].active);
  const otherLlm = Object.keys(ks).filter(p => ks[p].kind === 'llm' && !ks[p].active && ks[p].set);
  if (mainLlm && !ks[mainLlm].set && otherLlm.length) $('#kmMsg').textContent = `메인 LLM(${NAMES[mainLlm]})에 키가 없어 번역·사진 기획이 꺼져 있습니다. 키가 있는 ${otherLlm.map(p => NAMES[p]).join('·')} 카드의 [● 메인으로]를 누르세요.`;
  for (const c of document.querySelectorAll('#kmBody .kcard')) {
    const k = ks[c.dataset.p]; if (!k) continue;
    const ac = c.querySelector('[data-r=active]');
    if (ac) {
      const llm = k.kind === 'llm';
      ac.textContent = k.active ? (llm ? '● 메인 LLM' : '● 활성') : '○ 대기'; ac.className = 'chip ' + (k.active ? 'ok' : '');
      c.classList.toggle('active', Boolean(k.active));
      const bA = c.querySelector('[data-act=activate]'), bS = c.querySelector('[data-act=standby]');
      if (bA) { bA.hidden = Boolean(k.active); bA.disabled = !k.set; bA.title = k.set ? (llm ? '이 제공자를 메인 LLM 으로 씁니다' : '이 소스를 활성화하고 다른 소스는 대기로 둡니다') : '키를 먼저 저장하세요'; }
      if (bS) bS.hidden = !k.active;
    }
    const st = c.querySelector('[data-r=status]');
    st.textContent = k.set ? `${k.shared ? '' : '저장됨 '}${k.masked}${k.fromEnv ? ' (환경변수)' : ''}` : '키 없음';
    st.className = 'chip ' + (k.set ? (k.shared ? 'warn' : 'ok') : 'err');
    c.querySelector('[data-r=key]').placeholder = k.set ? `저장됨 (${k.masked}) — 바꾸려면 새 키 입력` : c.querySelector('[data-r=key]').placeholder;
    if (k.model && c.querySelector('[data-r=model]')) c.querySelector('[data-r=model]').value = k.model;
    if (k.cheapModel && c.querySelector('[data-r=cheapModel]')) c.querySelector('[data-r=cheapModel]').value = k.cheapModel;
    const bM = c.querySelector('[data-act=models]'); if (bM) bM.disabled = !k.set;
    if (k.concurrency && c.querySelector('[data-r=concurrency]')) c.querySelector('[data-r=concurrency]').value = k.concurrency;
    c.querySelector('[data-act=delete]').disabled = !k.set || k.fromEnv || k.shared;
    c.querySelector('[data-act=check]').disabled = !k.set;
  }
}
$('#kmBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const card = btn.closest('.kcard'); const p = card.dataset.p; const msg = card.querySelector('[data-r=msg]'); const keyEl = card.querySelector('[data-r=key]');
  const act = btn.dataset.act;
  if (act === 'toggle') { keyEl.type = keyEl.type === 'password' ? 'text' : 'password'; btn.textContent = keyEl.type === 'password' ? '보기' : '숨기기'; return; }
  btn.disabled = true;
  try {
    if (act === 'save') {
      const body = { model: card.querySelector('[data-r=model]')?.value?.trim() || undefined, cheapModel: card.querySelector('[data-r=cheapModel]')?.value?.trim() || undefined, concurrency: Number(card.querySelector('[data-r=concurrency]')?.value) || undefined };
      const k = keyEl.value.trim(); if (k) body.apiKey = k;
      msg.textContent = '저장 중…';
      await api(`/api/keys/${p}`, { method: 'PUT', body });
      keyEl.value = ''; keyEl.type = 'password'; card.querySelector('[data-act=toggle]').textContent = '보기';
      msg.textContent = (k ? '키 저장됨 ' : '설정 저장됨 ') + new Date().toLocaleTimeString();
      $('#kmMsg').textContent = '';
      if (p === 'treblo') refreshBalance();
    } else if (act === 'check') {
      msg.textContent = '확인 중…';
      const r = await api(`/api/keys/${p}/check`);
      msg.textContent = '✔ ' + r.summary;
      if (p === 'treblo') refreshBalance();
    } else if (act === 'models') {
      msg.textContent = '모델 목록 불러오는 중…';
      const r = await api(`/api/keys/${p}/models`);
      for (const dl of card.querySelectorAll('datalist')) dl.innerHTML = r.models.map(m => `<option value="${m}">`).join('');
      msg.textContent = `모델 ${r.models.length}개: ${r.models.slice(0, 8).join(', ')}${r.models.length > 8 ? ' …' : ''} (입력칸에서 ▼ 로 선택)`;
    } else if (act === 'activate') {
      await api(`/api/keys/${p}/activate`, { method: 'POST' });
      if (card.dataset.kind === 'llm') msg.textContent = '메인 LLM 으로 지정됨';
      else { msg.textContent = '활성화됨 — 새 작업의 기본 소스'; $('#provider').value = p; providerChanged(); }
    } else if (act === 'standby') {
      await api(`/api/keys/${p}/standby`, { method: 'POST' });
      msg.textContent = '대기로 전환됨';
    } else if (act === 'delete') {
      if (!confirm(`${NAMES[p] || p} API 키를 config.json 에서 지울까요?`)) return;
      await api(`/api/keys/${p}`, { method: 'DELETE' });
      msg.textContent = '키 삭제됨';
      if (p === 'treblo') { $('#credits').textContent = '크레딧 –'; $('#credits').className = 'chip'; }
    }
    await refreshKeys();
  } catch (err) { msg.textContent = '✖ ' + err.message; }
  finally { btn.disabled = false; }
});

// ── SSE
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => { jobs = JSON.parse(e.data).jobs; renderJobs(); if (selected) loadDetail(selected); else if (jobs.length) select(jobs[0].id); });
  es.addEventListener('job', (e) => {
    const ev = JSON.parse(e.data); const j = ev.data;
    const i = jobs.findIndex(x => x.id === j.id); if (i >= 0) jobs[i] = j; else if (!j.hidden || $('#showHidden').checked) jobs.unshift(j);
    if (i < 0 && (j.status === 'running' || j.status === 'queued') && !selected) select(j.id);   // 외부(MCP)에서 시작된 작업: 아무것도 선택돼 있지 않으면 바로 따라감
    renderJobs(); if (selected === j.id) renderDetail(j);
  });
  es.addEventListener('reset', () => reloadJobs());
  es.addEventListener('log', (e) => { const ev = JSON.parse(e.data); if (!selected || ev.jobId === selected) logLine(ev.data.t, ev.data.level, ev.data.msg); });
  es.onopen = () => setOffline(false);
  es.onerror = () => { es.close(); setOffline(true); setTimeout(connectSSE, 3000); };
}

// ── 작업 목록/상세
function renderJobs() {
  $('#jobCount').textContent = jobs.length ? `(${jobs.length})` : '';
  $('#jobs').innerHTML = jobs.map(j => `
    <div class="job ${j.id === selected ? 'sel' : ''}" data-id="${j.id}" style="${j.hidden ? 'opacity:.55' : ''}">
      <span class="dim">${j.id.slice(0, 8)} ${j.id.slice(8, 12)}${j.hidden ? ' 숨김' : ''}</span>
      <span>${presetName(j.request?.preset)} · ${j.request?.count || j.tracks?.length || ''}곡 <div class="mini"><i style="width:${j.progress || 0}%"></i></div></span>
      <span class="chip ${chipClass(j.status)}">${statusText(j.status)}</span>
      <span class="dim">${j.progress || 0}%</span>
    </div>`).join('') || '<div class="dim" style="padding:6px">아직 작업이 없습니다.</div>';
  $('#jobs').querySelectorAll('.job').forEach(el => el.onclick = () => select(el.dataset.id));
}
const presetName = (id) => presets.find(p => p.id === id)?.name || id || '';
const chipClass = (s) => ({ running: 'run', done: 'ok', failed: 'err', cancelled: 'warn', queued: '' })[s] || '';
const statusText = (s) => ({ running: '진행 중', done: '완료', failed: '실패', cancelled: '취소', queued: '대기' })[s] || s;
async function select(id) { selected = id; renderJobs(); logEl.textContent = ''; await loadDetail(id); }
async function loadDetail(id) {
  const j = await api('/api/jobs/' + id).catch(() => null); if (!j) return;
  logEl.textContent = '';   // SSE로 먼저 들어온 줄과 중복되지 않도록 비우고 서버 기록으로 채움
  for (const l of j.logs || []) logLine(l.t, l.level, l.msg);
  renderDetail(j);
}
function renderDetail(j) {
  $('#detail').hidden = false;
  $('#dTitle').textContent = `${presetName(j.request?.preset)} · ${j.id}`;
  const st = $('#dStatus'); st.textContent = statusText(j.status); st.className = 'chip ' + chipClass(j.status);
  $('#pOverall').style.width = (j.progress || 0) + '%'; $('#pOverallTxt').textContent = `${j.progress || 0}%`;
  $('#stepName').textContent = j.step ? `${j.stepIndex}/${j.stepCount} ${j.step}` : '단계';
  $('#pStep').style.width = (j.stepProgress || 0) + '%'; $('#pStepTxt').textContent = j.detail || `${j.stepProgress || 0}%`;
  $('#btnCancel').disabled = j.status !== 'running';
  const res = j.result;
  const rt = res?.tracks || [];
  $('#tracks tbody').innerHTML = (j.tracks || []).map((t, i) => `<tr><td>${t.index}</td><td>${t.title || ''}</td><td>${t.remote || statusText(t.status) || ''}</td><td>${rt[i] ? fmt(rt[i].offset) : ''}</td><td>${rt[i] ? fmt(rt[i].duration) : ''}</td></tr>`).join('');
  if (res) {
    $('#result').hidden = false;
    const base = `/output/${j.id}/`;
    $('#thumb').src = base + res.thumbnail + '?t=' + j.updatedAt;
    $('#lnkVideo').href = base + res.video; $('#lnkAudio').href = base + res.audio; $('#lnkThumb').href = base + res.thumbnail; $('#lnkYt').href = base + res.youtube;
    $('#lnkLyrics').hidden = !res.lyrics; if (res.lyrics) $('#lnkLyrics').href = base + res.lyrics;
    fetch(base + 'youtube.txt').then(r => r.text()).then(t => $('#ytText').textContent = t);
    renderYtState(j);
  } else { $('#result').hidden = true; }
  if (j.error && j.status !== 'running') $('#ytText').textContent = '';
}
// ── 초기화(목록만 비움, 데이터 유지) / 숨긴 작업 보기
const jobsUrl = () => '/api/jobs' + ($('#showHidden').checked ? '?all=1' : '');
async function reloadJobs() { jobs = await api(jobsUrl()); if (selected && !jobs.some(j => j.id === selected)) { selected = null; $('#detail').hidden = true; logEl.textContent = ''; } renderJobs(); }
$('#btnReset').onclick = async () => {
  const finished = jobs.filter(j => !['running', 'queued'].includes(j.status)).length;
  if (!finished) return alert('숨길 끝난 작업이 없습니다.');
  if (!confirm(`끝난 작업 ${finished}개를 목록에서 지울까요?\n결과 파일은 output 폴더에 그대로 남고, "숨긴 작업 보기"로 다시 볼 수 있습니다.`)) return;
  try { const r = await api('/api/jobs/reset', { method: 'POST' }); logLine('--', 'info', `초기화: 작업 ${r.hidden}개를 목록에서 숨김 (데이터 유지)`); await reloadJobs(); }
  catch (e) { alert(e.message); }
};
$('#showHidden').onchange = reloadJobs;
$('#btnCancel').onclick = () => selected && api(`/api/jobs/${selected}/cancel`, { method: 'POST' });
$('#btnOpenJob').onclick = () => selected && api('/api/open', { method: 'POST', body: { id: selected } });
$('#btnDelete').onclick = async () => {
  if (!selected || !confirm('이 작업의 출력 폴더를 삭제할까요?')) return;
  await api('/api/jobs/' + selected, { method: 'DELETE' }).catch(e => alert(e.message));
  jobs = jobs.filter(j => j.id !== selected); selected = null; $('#detail').hidden = true; renderJobs();
};
$('#btnCopyYt').onclick = () => navigator.clipboard.writeText($('#ytText').textContent).then(() => $('#btnCopyYt').textContent = '복사됨!');

// ── 프리셋 설명·편집 모달
let pmPreset = null, pmLang = 'ko', pmTopics = {};
const pmf = () => $('#pmForm');
$('#btnPreset').onclick = () => openPresetModal($('#preset').value);
$('#pmClose').onclick = () => $('#pmodal').hidden = true;
let pmMode = 'edit';   // 'edit' | 'new'
$('#btnNewPreset').onclick = () => openPresetModal(null);
function openPresetModal(id) {
  const p = id ? presets.find(x => x.id === id) : {
    id: '', name: '', description: '', koDescription: '', useKoDescription: true, prompt: '', instrumental: false, vocalGender: '',
    thumbnailStyle: 'night', length_range: [150, 240], tags: [], negative_tags: [], imageQueries: [], topics: { ko: [], en: [], ja: [] },
  };
  if (!p) return;
  pmMode = id ? 'edit' : 'new';
  pmPreset = p; pmTopics = JSON.parse(JSON.stringify(p.topics || { ko: [], en: [], ja: [] })); pmLang = 'ko';
  $('#pmTitle').textContent = id ? `프리셋: ${p.name}` : '새 프리셋 만들기'; $('#pmId').textContent = id || '';
  $('#pmIdRow').hidden = Boolean(id);
  $('#pmCopy').hidden = !id; $('#pmDelete').hidden = !id;
  const f = pmf();
  f.id.value = id ? p.id : `my-${Date.now().toString(36).slice(-5)}`;
  f.name.value = p.name || ''; f.description.value = p.description || ''; f.koDescription.value = p.koDescription || '';
  f.useKoDescription.checked = p.useKoDescription !== false; f.prompt.value = p.prompt || '';
  f.instrumental.value = p.instrumental ? 'true' : (p.vocalGender === 'male' || p.vocalGender === 'female' ? p.vocalGender : 'false'); f.thumbnailStyle.value = p.thumbnailStyle || 'night';
  f.len0.value = p.length_range?.[0] ?? 150; f.len1.value = p.length_range?.[1] ?? 240;
  f.tags.value = (p.tags || []).join(', '); f.negative_tags.value = (p.negative_tags || []).join(', '); f.imageQueries.value = (p.imageQueries || []).join(', ');
  showTopics('ko'); $('#pmMsg').textContent = ''; $('#pmodal').hidden = false; pmPreview();
}
function showTopics(l) {
  pmTopics[pmLang] = pmf().topics.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  pmLang = l; pmf().topics.value = (pmTopics[l] || []).join('\n');
  document.querySelectorAll('#pmForm .tab').forEach(b => b.classList.toggle('on', b.dataset.l === l));
}
document.querySelectorAll('#pmForm .tab').forEach(b => b.onclick = () => showTopics(b.dataset.l));
function pmBody() {
  const f = pmf(); showTopics(pmLang);
  return {
    name: f.name.value.trim(), description: f.description.value.trim(), koDescription: f.koDescription.value.trim(), useKoDescription: f.useKoDescription.checked,
    prompt: f.prompt.value.trim(), instrumental: f.instrumental.value === 'true', vocalGender: ['male', 'female'].includes(f.instrumental.value) ? f.instrumental.value : '', thumbnailStyle: f.thumbnailStyle.value,
    length_range: [Number(f.len0.value), Number(f.len1.value)], topics: pmTopics,
    tags: f.tags.value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    negative_tags: f.negative_tags.value.split(',').map(s => s.trim()).filter(Boolean),
    imageQueries: f.imageQueries.value.split(',').map(s => s.trim()).filter(Boolean),
  };
}
async function pmPreview() {
  const b = pmBody();
  if (pmMode === 'new') {
    // 저장 전 미리보기: 서버와 같은 규칙으로 조립
    let p = b.prompt;
    if (b.koDescription && b.useKoDescription) p = p ? `${p} Detailed style notes (written in Korean, follow them closely): ${b.koDescription}` : `Music style (described in Korean, follow it closely): ${b.koDescription}`;
    if (!p) p = b.description || b.name || '(설명을 입력하세요)';
    $('#pmPreview').textContent = p + (b.instrumental ? ' Instrumental only, no vocals. Mood: "…".' : ' Sung in Korean. … Theme of this song: "…".');
    return;
  }
  try {
    const r = await api('/api/plan', { method: 'POST', body: { preset: pmPreset.id, count: 1, language: $('#language').value, koDescription: b.koDescription, useKoDescription: b.useKoDescription, instrumental: b.instrumental, vocalGender: b.vocalGender } });
    $('#pmPreview').textContent = r.specs[0].prompt.replace(pmPreset.prompt, b.prompt);
  } catch (e) { $('#pmPreview').textContent = e.message; }
}
async function refreshPresetSelect(selectId) {
  presets = await api('/api/presets');
  $('#preset').innerHTML = presets.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
  if (selectId) $('#preset').value = selectId;
  updatePresetUI();
}
$('#pmPreviewBtn').onclick = pmPreview;
// ── AI로 영어 프롬프트 자동 생성 (Claude API)
$('#pmGen').onclick = async () => {
  const f = pmf(); const ko = f.koDescription.value.trim();
  if (!ko) return alert('한국어 상세 설명을 먼저 적어 주세요.');
  if (f.prompt.value.trim() && !confirm('이미 영어 프롬프트가 있습니다. 새로 생성한 내용으로 바꿀까요?')) return;
  const wantTopics = $('#pmGenTopics').checked;
  const btn = $('#pmGen'); btn.disabled = true; $('#pmGenMsg').textContent = '메인 LLM이 프롬프트를 쓰는 중… (10~30초)';
  try {
    const r = await api('/api/presets/generate', { method: 'POST', body: { koDescription: ko, name: f.name.value.trim(), instrumental: f.instrumental.value === 'true', wantTopics } });
    f.prompt.value = r.prompt;
    f.useKoDescription.checked = false;   // 생성된 프롬프트가 설명의 번역이므로 둘 다 보내면 같은 내용이 두 번 들어간다
    if (r.description && !f.description.value.trim()) f.description.value = r.description;
    if (wantTopics) {
      if (r.tags?.length && !f.tags.value.trim()) f.tags.value = r.tags.join(', ');
      if (r.negative_tags?.length && !f.negative_tags.value.trim()) f.negative_tags.value = r.negative_tags.join(', ');
      if (r.imageQueries?.length && !f.imageQueries.value.trim()) f.imageQueries.value = r.imageQueries.join(', ');
      showTopics(pmLang);   // 현재 탭 내용을 pmTopics 에 반영
      let filled = 0;
      for (const l of ['ko', 'en', 'ja']) if (r.topics?.[l]?.length && !(pmTopics[l] || []).length) { pmTopics[l] = r.topics[l]; filled++; }
      f.topics.value = (pmTopics[pmLang] || []).join('\n');
      $('#pmGenMsg').textContent = `생성 완료 (${r.model}, 토큰 ${r.usage.input}+${r.usage.output}) · 주제 ${filled}개 언어 채움. 저장을 눌러 반영하세요.`;
    } else $('#pmGenMsg').textContent = `생성 완료 (${r.model}). 저장을 눌러 반영하세요.`;
    pmPreview();
  } catch (e) { $('#pmGenMsg').textContent = '실패: ' + e.message; }
  finally { btn.disabled = false; }
};
pmf().onsubmit = async (e) => {
  e.preventDefault();
  try {
    if (pmMode === 'new') {
      const body = { ...pmBody(), id: pmf().id.value.trim().toLowerCase() };
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(body.id)) throw new Error('프리셋 id는 영문 소문자·숫자·하이픈 2~41자');
      const created = await api('/api/presets', { method: 'POST', body });
      await refreshPresetSelect(created.id);
      try { localStorage.setItem('pf.preset', created.id); } catch {}
      openPresetModal(created.id);
      $('#pmMsg').textContent = created._generated
        ? `새 프리셋 "${created.name}" 저장됨 · 메인 LLM(${created._model})이 영어 프롬프트·태그·주제·배경 검색어를 자동 생성했습니다. 아래 영어 프롬프트를 확인하세요. 이제 선택되어 있습니다.`
        : `새 프리셋 "${created.name}" 저장됨. 영어 프롬프트가 비어 있어 한국어 설명이 그대로 전달됩니다${created._generateError ? ` (자동 생성 실패: ${created._generateError})` : ''}. ✨ 버튼으로 영어 프롬프트를 만들어 저장하는 것을 권장합니다.`;
      return;
    }
    const saved = await api('/api/presets/' + pmPreset.id, { method: 'PUT', body: pmBody() });
    const i = presets.findIndex(x => x.id === saved.id); if (i >= 0) presets[i] = saved; pmPreset = saved;
    $('#preset').options[$('#preset').selectedIndex].text = saved.name; updatePresetUI();
    $('#pmMsg').textContent = '저장됨 ' + new Date().toLocaleTimeString(); pmPreview();
  } catch (err) { $('#pmMsg').textContent = '오류: ' + err.message; }
};
$('#pmCopy').onclick = async () => {
  const newId = prompt('새 프리셋 id (영문 소문자·숫자·하이픈)', pmPreset.id + '-2'); if (!newId) return;
  const name = prompt('새 프리셋 이름', pmPreset.name + ' (내 버전)') || undefined;
  try {
    await api(`/api/presets/${pmPreset.id}`, { method: 'PUT', body: pmBody() });   // 현재 편집 내용 먼저 저장
    const p = await api(`/api/presets/${pmPreset.id}/copy`, { method: 'POST', body: { newId, name } });
    presets = await api('/api/presets');
    $('#preset').innerHTML = presets.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
    $('#preset').value = p.id; updatePresetUI(); openPresetModal(p.id);
  } catch (err) { $('#pmMsg').textContent = '오류: ' + err.message; }
};
$('#pmDelete').onclick = async () => {
  if (presets.length <= 1 || !confirm(`프리셋 "${pmPreset.name}" 파일을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await api('/api/presets/' + pmPreset.id, { method: 'DELETE' });
    presets = await api('/api/presets');
    $('#preset').innerHTML = presets.map(x => `<option value="${x.id}">${x.name}</option>`).join('');
    updatePresetUI(); $('#pmodal').hidden = true;
  } catch (err) { $('#pmMsg').textContent = '오류: ' + err.message; }
};

// ── 유튜브 업로드 (왼쪽 패널 + 모달). 진행 상황은 job.youtube 로 'job' 이벤트에 실려 온다
let ytStatus = null, ymJobId = null;
const PRIV_KO = { private: '비공개', unlisted: '일부 공개', public: '공개' };
async function refreshYt() {
  try { ytStatus = await api('/api/youtube/status'); } catch { return; }
  const y = ytStatus, st = $('#ytState');
  st.textContent = y.connected ? `연결됨 · ${y.channelTitle || '채널'}` : y.configured ? '연결 필요' : '설정 필요'; st.className = 'chip ' + (y.connected ? 'ok' : 'warn');
  $('#ytChannel').textContent = y.connected ? `${y.channelTitle || '(채널명 없음)'} 채널` : y.configured ? '저장됨 → 연결 버튼을 누르세요' : '연결 안 됨 (아래 ID·비밀 저장 후 연결)';
  $('#ytDisconnect').hidden = !y.connected; $('#ytConnect').disabled = !y.configured; $('#ytConnect').textContent = y.connected ? '다시 연결' : 'Google 계정 연결';
  const f = $('#ytForm'); f.defaultPrivacy.value = y.defaultPrivacy; f.uploadThumbnail.value = String(y.uploadThumbnail); f.syntheticMedia.value = String(y.syntheticMedia); f.autoUpload.checked = y.autoUpload;
  f.clientId.placeholder = y.clientId || 'xxxx.apps.googleusercontent.com (Google Cloud > OAuth 클라이언트 · 데스크톱 앱)'; f.clientSecret.placeholder = y.configured ? '저장됨 (****)' : 'GOCSPX-…';
}
$('#ytForm').onsubmit = async (e) => {
  e.preventDefault(); const f = $('#ytForm');
  const body = { defaultPrivacy: f.defaultPrivacy.value, uploadThumbnail: f.uploadThumbnail.value === 'true', syntheticMedia: f.syntheticMedia.value === 'true', autoUpload: f.autoUpload.checked };
  if (f.clientId.value.trim()) body.clientId = f.clientId.value.trim();
  if (f.clientSecret.value.trim()) body.clientSecret = f.clientSecret.value.trim();
  try { await api('/api/youtube/settings', { method: 'POST', body }); f.clientId.value = ''; f.clientSecret.value = ''; $('#ytMsg').textContent = '저장됨 ' + new Date().toLocaleTimeString(); refreshYt(); }
  catch (err) { $('#ytMsg').textContent = '오류: ' + err.message; }
};
$('#ytConnect').onclick = async () => {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return alert('Google 계정 연결은 서버 PC의 브라우저에서 http://localhost:' + (info?.port || '') + ' 로 접속해 진행하세요. (Google 이 localhost 로만 돌려보냅니다)');
  let r; try { r = await api('/api/youtube/auth/url'); } catch (e) { return alert(e.message); }
  const w = window.open(r.url, 'playlist-google-auth', 'popup=yes,width=560,height=720');
  if (!w) return alert('브라우저가 팝업을 막았습니다. 팝업을 허용한 뒤 다시 누르세요.');
  $('#ytMsg').textContent = 'Google 로그인 창에서 계정을 고르고 권한을 허용하세요…';
  const started = Date.now(); const before = ytStatus?.connectedAt || '';
  const tick = setInterval(async () => {
    await refreshYt();
    if (ytStatus?.connected && ytStatus.connectedAt !== before) { clearInterval(tick); $('#ytMsg').textContent = `연결됨: ${ytStatus.channelTitle || ytStatus.channelId}`; try { w.close(); } catch {} }
    else if (Date.now() - started > 5 * 60_000 || w.closed) { clearInterval(tick); if (!ytStatus?.connected) $('#ytMsg').textContent = '연결되지 않았습니다. 다시 시도하세요.'; }
  }, 2500);
};
$('#ytDisconnect').onclick = async () => { if (!confirm('Google 계정 연결을 해제할까요? (저장된 토큰 삭제)')) return; await api('/api/youtube/disconnect', { method: 'POST' }).catch(e => alert(e.message)); refreshYt(); };
function renderYtState(j) {
  const y = j.youtube; const a = $('#lnkYtVideo'), s = $('#ytJobState');
  if (y?.url) { a.hidden = false; a.href = y.url; a.textContent = `▶ YouTube (${PRIV_KO[y.privacy] || ''}${y.publishAt ? ' · 예약' : ''})`; } else a.hidden = true;
  if (y?.status === 'uploading') { s.hidden = false; s.className = 'chip run'; s.textContent = `유튜브 업로드 ${y.pct || 0}%`; }
  else if (y?.status === 'failed') { s.hidden = false; s.className = 'chip err'; s.textContent = '유튜브 업로드 실패'; s.title = y.error || ''; }
  else s.hidden = true;
  if (ymJobId === j.id && y) renderYmProgress(y);
}
function renderYmProgress(y) {
  $('#ymBar').style.width = (y.pct || 0) + '%'; $('#ymPct').textContent = y.status === 'uploading' ? `${y.pct || 0}%` : '';
  $('#ymStatus').textContent = { uploading: '업로드 중', done: '완료', failed: '실패' }[y.status] || '대기';
  $('#ymUpload').disabled = y.status === 'uploading';
  $('#ymResult').innerHTML = y.status === 'done' ? `완료: <a href="${y.url}" target="_blank">${y.url}</a> (${PRIV_KO[y.privacy] || ''}${y.publishAt ? `, ${new Date(y.publishAt).toLocaleString()} 공개 예약` : ''})${y.thumbnailSet === false ? ' · ⚠ 썸네일은 설정되지 않았습니다(채널 전화 인증 필요)' : ''}` : y.status === 'failed' ? `<span style="color:var(--err)">실패: ${y.error || ''}</span>` : '';
}
$('#ytUploadBtn').onclick = async () => {
  const j = jobs.find(x => x.id === selected);
  if (!j) return alert('먼저 작업 목록에서 업로드할 작업을 선택하세요.');
  if (j.status !== 'done') return alert('완료된 작업만 업로드할 수 있습니다.');
  if (!ytStatus?.connected) return alert('먼저 Google 계정을 연결하세요.');
  let meta = {}; try { meta = await (await fetch(`/output/${j.id}/youtube.json`)).json(); } catch {}
  const f = $('#ymForm'); ymJobId = j.id;
  $('#ymJob').textContent = `${presetName(j.request?.preset)} · ${j.id}`;
  f.title.value = (j.youtube?.title || meta.title || j.result?.title || '').slice(0, 100); f.description.value = meta.description || ''; f.tags.value = (meta.tags || []).join(', ');
  f.privacy.value = ytStatus.defaultPrivacy || 'private'; f.publishAt.value = ''; f.thumbnail.checked = ytStatus.uploadThumbnail !== false; f.syntheticMedia.checked = ytStatus.syntheticMedia !== false;
  renderYmProgress(j.youtube || { status: '', pct: 0 });
  if (j.youtube?.url) $('#ymResult').innerHTML += ' <span class="dim">(이미 업로드된 작업입니다. 다시 올리면 새 영상이 하나 더 생깁니다)</span>';
  $('#ymodal').hidden = false;
};
$('#ymClose').onclick = () => { $('#ymodal').hidden = true; ymJobId = null; };
$('#ymForm').onsubmit = async (e) => {
  e.preventDefault(); const f = $('#ymForm');
  const body = { jobId: ymJobId, title: f.title.value.trim(), description: f.description.value, tags: f.tags.value.split(',').map(s => s.trim()).filter(Boolean), privacy: f.privacy.value, thumbnail: f.thumbnail.checked, syntheticMedia: f.syntheticMedia.checked };
  if (f.publishAt.value) { const d = new Date(f.publishAt.value); if (Number.isNaN(d.getTime())) return alert('예약 시각이 올바르지 않습니다.'); body.publishAt = d.toISOString(); }
  if (body.privacy === 'public' && !body.publishAt && !confirm('바로 공개로 업로드합니다. 계속할까요?')) return;
  try { $('#ymUpload').disabled = true; $('#ymStatus').textContent = '시작 중'; $('#ymResult').textContent = ''; await api('/api/youtube/upload', { method: 'POST', body }); }
  catch (err) { $('#ymUpload').disabled = false; $('#ymStatus').textContent = '실패'; $('#ymResult').innerHTML = `<span style="color:var(--err)">${err.message}</span>`; }
};

// ── 모달
function modal(title, html, actions = []) {
  $('#mTitle').textContent = title; $('#mBody').innerHTML = html;
  const a = $('#mActions'); a.innerHTML = '';
  for (const act of actions) { const b = document.createElement('button'); b.className = 'btn ' + (act.cls || ''); b.textContent = act.label; b.onclick = act.onClick; a.appendChild(b); }
  $('#modal').hidden = false;
}
$('#mClose').onclick = () => $('#modal').hidden = true;

// ── 업데이트
$('#btnUpdate').onclick = async () => {
  modal('업데이트 확인', '<div class="dim">원격 저장소를 확인하는 중(git fetch)…</div>');
  const r = await api('/api/update/check').catch(e => ({ ok: false, error: e.message }));
  if (!r.ok) return modal('업데이트 확인 실패', `<p>${r.error}</p>`);
  if (!r.behind) return modal('최신 버전', `<p>현재 버전이 최신입니다. (${r.branch} @ ${r.current}${r.ahead ? `, 로컬 커밋 ${r.ahead}개 앞섬` : ''})</p>`);
  const list = r.commits.map(c => `<li><code>${c.hash}</code> ${c.subject} <span class="dim">— ${c.author}, ${c.when}</span></li>`).join('');
  modal(`업데이트 ${r.behind}개 있음`, `<p>${r.remote} (${r.branch})</p><ul>${list}</ul>${r.dirty ? `<p class="dim">⚠ 로컬 수정 파일 ${r.dirty}개가 있어 pull 이 실패할 수 있습니다.</p>` : ''}`, [
    { label: '지금 업데이트(git pull)', cls: 'primary', onClick: applyUpdate },
    { label: '나중에', onClick: () => $('#modal').hidden = true },
  ]);
};
async function applyUpdate() {
  modal('업데이트 적용 중', '<div class="bar" style="height:14px"><div class="fill" style="width:40%;animation:none"></div></div><pre id="updLog">git pull --ff-only …</pre>');
  try {
    const r = await api('/api/update/apply', { method: 'POST' });
    modal('업데이트 완료', `<p><b>업데이트 완료, 앱을 재시작하세요.</b> (${r.before} → ${r.after})</p>${r.needInstall ? '<p>⚠ 의존성이 바뀌었습니다. 재시작 전에 <code>install.bat</code> 을 먼저 실행하세요.</p>' : ''}<pre>${(r.log || []).join('\n')}\n${r.changed.join('\n')}</pre>`, [
      { label: '지금 종료(재시작 준비)', cls: 'danger', onClick: shutdown },
      { label: '닫기', onClick: () => $('#modal').hidden = true },
    ]);
  } catch (e) { modal('업데이트 실패', `<pre>${e.message}</pre>`); }
}

// ── 종료
$('#btnQuit').onclick = () => { if (confirm('앱을 종료할까요?\n캐시 삭제 → 서버 종료 → 포트 정리 → 명령 창 닫기 → 브라우저 닫기 순서로 진행됩니다.')) shutdown(); };
async function shutdown() {
  try { if (logWinRef && !logWinRef.closed) logWinRef.close(); } catch {}   // 로그 창(팝업)은 서버 쪽 창 닫기가 못 잡으므로 여기서 닫는다
  $('#modal').hidden = true;
  const ov = $('#overlay'); ov.hidden = false;
  const ol = $('#ovLog'); ol.textContent = '종료 요청 전송…\n';
  try { await api('/api/shutdown', { method: 'POST' }); ol.textContent += '서버가 정리 작업을 시작했습니다.\n브라우저 창을 닫습니다…\n'; }
  catch (e) { ol.textContent += '서버 응답 없음: ' + e.message + '\n'; }
  setTimeout(() => {
    try { window.open('', '_self'); window.close(); } catch {}
    setTimeout(() => { ol.textContent += '브라우저가 자동으로 닫히지 않으면 이 탭을 직접 닫아 주세요.\n'; }, 800);
  }, 1200);
}

window.addEventListener('error', (e) => logLine('--', 'error', `스크립트 오류: ${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => logLine('--', 'error', `처리되지 않은 오류: ${e.reason?.stack || e.reason}`));
init().catch(e => { logLine('--', 'error', '초기화 실패: ' + (e.stack || e.message)); });
