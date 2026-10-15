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
  sel.onchange = updatePresetUI; updatePresetUI();
  const cfg = await api('/api/config');
  fillForm($('#cfgForm'), cfg);
  $('#provider').value = cfg.provider || 'treblo';
  if (!cfg.hasApiKey) { $('#settings').open = true; $('#cfgMsg').textContent = 'Treblo API 키를 입력하거나 소스를 로컬/테스트로 바꾸세요.'; }
  else refreshBalance();
  providerChanged();
  jobs = await api('/api/jobs'); renderJobs();
  connectSSE();
}
function updatePresetUI() {
  const p = presets.find(x => x.id === $('#preset').value); if (!p) return;
  $('#presetDesc').textContent = p.description + (p.instrumental ? ' (연주곡: 가사 자막 없음)' : '');
  estimate();
}
async function estimate() {
  const body = formData();
  try {
    const e = await api('/api/plan', { method: 'POST', body });
    const prov = $('#provider').value;
    $('#estimate').textContent = prov === 'treblo'
      ? `예상: ${e.specs.length}곡 · 크레딧 ${e.credits} · 영상 약 ${e.estMinutes}분 · ${e.instrumental ? '연주곡' : '보컬 (' + e.lang + ')'}`
      : prov === 'local' ? `input 폴더의 파일 중 앞에서 ${e.specs.length}개를 사용합니다.` : `테스트: ${e.specs.length}곡 × ${body.mockSeconds || 20}초 합성음, 크레딧 0`;
  } catch {}
}
['#count', '#language', '#instrumental', '#mockSeconds'].forEach(s => $(s).addEventListener('change', estimate));
$('#provider').addEventListener('change', providerChanged);
async function providerChanged() {
  const prov = $('#provider').value;
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
  o.instrumental = o.instrumental === '' ? null : o.instrumental === 'true';
  o.subtitles = o.subtitles !== 'false';
  if (o.provider === 'mock') { o.dryRun = true; }
  for (const k of ['title', 'thumbnailText', 'backgroundImage', 'extraPrompt', 'thumbnailStyle']) if (!o[k]) delete o[k];
  return o;
}

// ── 작업 시작
$('#form').onsubmit = async (e) => {
  e.preventDefault();
  const body = formData();
  if (body.provider === 'treblo') {
    const est = await api('/api/plan', { method: 'POST', body }).catch(() => null);
    if (est && !confirm(`Treblo API로 ${est.specs.length}곡을 생성합니다.\n크레딧 ${est.credits} 이 사용됩니다. 계속할까요?`)) return;
  }
  $('#btnRun').disabled = true;
  try { const j = await api('/api/jobs', { method: 'POST', body }); select(j.id); }
  catch (err) { alert(err.message); }
  finally { $('#btnRun').disabled = false; }
};
$('#btnOpenInput').onclick = () => api('/api/open', { method: 'POST', body: { path: 'input' } }).catch(e => alert(e.message));
$('#btnOpenOutput').onclick = () => api('/api/open', { method: 'POST', body: { path: 'output' } }).catch(e => alert(e.message));

// ── 설정
function fillForm(form, cfg) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.name.split('.').reduce((o, k) => o?.[k], cfg);
    if (v === undefined || v === null) continue;
    if (el.name === 'treblo.apiKey') { el.placeholder = cfg.hasApiKey ? `저장됨 (${v})` : el.placeholder; continue; }
    if (el.name === 'images.pexelsKey') { if (v) el.placeholder = '저장됨'; continue; }
    el.value = String(v);
  }
}
$('#cfgForm').onsubmit = async (e) => {
  e.preventDefault();
  const patch = {};
  for (const el of $('#cfgForm').elements) {
    if (!el.name) continue;
    let v = el.value;
    if ((el.name === 'treblo.apiKey' || el.name === 'images.pexelsKey') && !v) continue;
    if (el.type === 'number') v = Number(v);
    if (v === 'true') v = true; if (v === 'false') v = false;
    const keys = el.name.split('.'); let o = patch;
    keys.slice(0, -1).forEach(k => o = (o[k] ??= {}));
    o[keys.at(-1)] = v;
  }
  patch.provider = $('#provider').value === 'mock' ? 'treblo' : $('#provider').value;
  let cfg;
  try { cfg = await api('/api/config', { method: 'POST', body: patch }); } catch (err) { alert(err.message); return; }
  fillForm($('#cfgForm'), cfg); $('#apiKey').value = '';
  $('#cfgMsg').textContent = '저장됨 ' + new Date().toLocaleTimeString();
  if (cfg.hasApiKey) refreshBalance();
};
async function refreshBalance() {
  const el = $('#credits');
  try { const b = await api('/api/treblo/balance'); el.textContent = `크레딧 ${(b.num_credits || 0).toLocaleString()} + 종량제 ${(b.num_credits_payg || 0).toLocaleString()}`; el.className = 'chip ok'; }
  catch (e) { el.textContent = '크레딧 확인 실패'; el.className = 'chip err'; el.title = e.message; }
}
$('#btnBalance').onclick = refreshBalance;

// ── SSE
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => { jobs = JSON.parse(e.data).jobs; renderJobs(); if (selected) loadDetail(selected); else if (jobs.length) select(jobs[0].id); });
  es.addEventListener('job', (e) => {
    const ev = JSON.parse(e.data); const j = ev.data;
    const i = jobs.findIndex(x => x.id === j.id); if (i >= 0) jobs[i] = j; else jobs.unshift(j);
    renderJobs(); if (selected === j.id) renderDetail(j);
  });
  es.addEventListener('log', (e) => { const ev = JSON.parse(e.data); if (!selected || ev.jobId === selected) logLine(ev.data.t, ev.data.level, ev.data.msg); });
  es.onopen = () => setOffline(false);
  es.onerror = () => { es.close(); setOffline(true); setTimeout(connectSSE, 3000); };
}

// ── 작업 목록/상세
function renderJobs() {
  $('#jobCount').textContent = jobs.length ? `(${jobs.length})` : '';
  $('#jobs').innerHTML = jobs.map(j => `
    <div class="job ${j.id === selected ? 'sel' : ''}" data-id="${j.id}">
      <span class="dim">${j.id.slice(0, 8)} ${j.id.slice(8, 12)}</span>
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
  } else { $('#result').hidden = true; }
  if (j.error && j.status !== 'running') $('#ytText').textContent = '';
}
$('#btnCancel').onclick = () => selected && api(`/api/jobs/${selected}/cancel`, { method: 'POST' });
$('#btnOpenJob').onclick = () => selected && api('/api/open', { method: 'POST', body: { id: selected } });
$('#btnDelete').onclick = async () => {
  if (!selected || !confirm('이 작업의 출력 폴더를 삭제할까요?')) return;
  await api('/api/jobs/' + selected, { method: 'DELETE' }).catch(e => alert(e.message));
  jobs = jobs.filter(j => j.id !== selected); selected = null; $('#detail').hidden = true; renderJobs();
};
$('#btnCopyYt').onclick = () => navigator.clipboard.writeText($('#ytText').textContent).then(() => $('#btnCopyYt').textContent = '복사됨!');

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
