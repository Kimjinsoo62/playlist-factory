// 로그 전용 창: ?job=작업id 로 특정 작업을, 없으면 최신(진행 중) 작업을 따라간다. 메인 창에서 작업 시작 시 자동으로 열린다.
const $ = (s) => document.querySelector(s);
const logEl = $('#log');
const params = new URLSearchParams(location.search);
let current = params.get('job') || null;          // 보고 있는 작업 id
let presets = [];
$('#follow').checked = !params.get('job') || params.get('follow') === '1';

const statusText = (s) => ({ running: '진행 중', done: '완료', failed: '실패', cancelled: '취소', queued: '대기' })[s] || s || '–';
const chipClass = (s) => ({ running: 'run', done: 'ok', failed: 'err', cancelled: 'warn', queued: '' })[s] || '';
const presetName = (id) => presets.find(p => p.id === id)?.name || id || '';

function line(t, level, msg) {
  const d = document.createElement('div');
  d.className = level + (String(msg).startsWith('──') ? ' step' : '');
  d.textContent = `[${t}] ${msg}`;
  logEl.appendChild(d);
  if (logEl.children.length > 3000) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}
function renderHead(j) {
  if (!j) { $('#title').textContent = '로그 (작업 없음)'; $('#status').textContent = '–'; $('#status').className = 'chip'; $('#jobId').textContent = ''; return; }
  $('#title').textContent = `${presetName(j.request?.preset)} · ${j.request?.count || j.tracks?.length || ''}곡`;
  $('#status').textContent = statusText(j.status); $('#status').className = 'chip ' + chipClass(j.status);
  $('#jobId').textContent = j.id;
  document.title = `플레이리스트 팩토리 - 로그 ${j.progress || 0}% ${statusText(j.status)}`;
  $('#pOverall').style.width = (j.progress || 0) + '%'; $('#pOverallTxt').textContent = `${j.progress || 0}%` + (j.stepIndex ? ` (${j.stepIndex}/${j.stepCount})` : '');
  $('#stepName').textContent = j.step || '단계';
  $('#pStep').style.width = (j.stepProgress || 0) + '%'; $('#pStepTxt').textContent = j.stepProgress ? `${Math.round(j.stepProgress)}%` : '';
}
async function show(id) {
  current = id; logEl.textContent = '';
  const j = await fetch('/api/jobs/' + id).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!j) { renderHead(null); return; }
  for (const l of j.logs || []) line(l.t, l.level, l.msg);
  renderHead(j);
}
function pickLatest(jobs) {
  if (!jobs?.length) return null;
  const live = jobs.filter(j => j.status === 'running' || j.status === 'queued').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return (live[0] || jobs.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]).id;
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    const jobs = JSON.parse(e.data).jobs || [];
    if (current && jobs.some(j => j.id === current)) show(current);
    else { const id = pickLatest(jobs); if (id) show(id); else renderHead(null); }
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data).data;
    if (j.id === current) renderHead(j);
    else if ($('#follow').checked && (j.status === 'running' || j.status === 'queued') && (!current || (j.createdAt || 0) > (window.__curCreated || 0))) { window.__curCreated = j.createdAt; show(j.id); }
    if (j.id === current) window.__curCreated = j.createdAt;
  });
  es.addEventListener('log', (e) => { const ev = JSON.parse(e.data); if (ev.jobId === current) line(ev.data.t, ev.data.level, ev.data.msg); });
  es.onerror = async () => {
    es.close();
    const alive = await fetch('/api/info', { cache: 'no-store' }).then(r => r.ok).catch(() => false);
    if (alive) { setTimeout(connect, 2000); return; }
    window.__dead = (window.__dead || 0) + 1;
    if (window.__dead < 3) { line(new Date().toTimeString().slice(0, 8), 'warn', '서버 연결 끊김 — 3초 후 재연결'); setTimeout(connect, 3000); return; }
    line(new Date().toTimeString().slice(0, 8), 'error', '앱이 종료되었습니다. 이 창을 닫으세요. (다시 실행: START.bat)');
    $('#status').textContent = '서버 종료'; $('#status').className = 'chip err'; document.title = '플레이리스트 팩토리 - 로그 (서버 종료)';
    if (window.opener) setTimeout(() => window.close(), 1500);   // 메인 창에서 연 팝업이면 스스로 닫기
  };
}
$('#btnClear').onclick = () => logEl.textContent = '';
$('#btnClose').onclick = () => window.close();
$('#btnMain').onclick = () => { if (window.opener && !window.opener.closed) window.opener.focus(); else window.open('/', 'playlist-main'); };
window.name = 'playlist-log';
fetch('/api/presets').then(r => r.json()).then(p => { presets = p; }).catch(() => {}).finally(connect);
