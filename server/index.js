import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, APP_TITLE } from './paths.js';
import { loadConfig, saveConfig, maskConfig } from './config.js';
import { lanAddresses } from './lan.js';
import { bus, createJob, getJob, removeJob, listJobs, summarize, loadPastJobs, log, hideFinishedJobs, unhideJobs } from './jobs.js';
import { runJob, loadPresets, planTracks } from './pipeline.js';
import { shutdownSequence } from './shutdown.js';
import { checkUpdate, applyUpdate } from './update.js';
import { TrebloProvider } from './providers/treblo.js';
import { LocalProvider } from './providers/local.js';

const cfg0 = loadConfig();
const PORT = cfg0.port;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(express.static(DIRS.public));
app.use('/output', express.static(DIRS.output));
app.get('/사용설명서.html', (req, res) => res.sendFile(path.join(DIRS.root, '사용설명서.html')));
app.get('/manual', (req, res) => res.sendFile(path.join(DIRS.root, '사용설명서.html')));

for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
loadPastJobs();

// ── 정보
app.get('/api/info', (req, res) => {
  res.json({ title: APP_TITLE, port: PORT, pid: process.pid, lan: lanAddresses(PORT), root: DIRS.root, inputDir: DIRS.input, outputDir: DIRS.output, version: JSON.parse(fs.readFileSync(path.join(DIRS.root, 'package.json'), 'utf8')).version });
});
app.get('/api/presets', (req, res) => res.json(loadPresets()));
const PRESET_FIELDS = ['name', 'description', 'koDescription', 'useKoDescription', 'prompt', 'instrumental', 'topics', 'negative_tags', 'tags', 'length_range', 'thumbnailStyle', 'imageQueries', 'titleTemplate', 'youtubeIntro', 'hashtags', 'keywords'];
function presetPath(id) { if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('프리셋 id는 영문 소문자·숫자·하이픈만'); return path.join(DIRS.presets, id + '.json'); }
app.put('/api/presets/:id', async (req, res) => {
  try {
    const file = presetPath(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '프리셋 없음' });
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { isKnownTag } = await import('./providers/treblo.js');
    for (const k of PRESET_FIELDS) if (k in (req.body || {})) cur[k] = req.body[k];
    if (typeof cur.topics === 'object') for (const l of Object.keys(cur.topics)) cur.topics[l] = (cur.topics[l] || []).map(s => String(s).trim()).filter(Boolean);
    for (const k of ['negative_tags', 'tags']) if (Array.isArray(cur[k])) {
      const bad = cur[k].filter(t => !isKnownTag(t));
      if (bad.length) return res.status(400).json({ error: `Treblo 태그 사전에 없는 태그: ${bad.join(', ')}` });
    }
    if (cur.length_range && !(Array.isArray(cur.length_range) && cur.length_range.length === 2 && cur.length_range.every(n => Number.isInteger(n) && n % 30 === 0))) return res.status(400).json({ error: '길이 범위는 30의 배수 두 개 [최소, 최대]' });
    cur.id = req.params.id;
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n', 'utf8');
    res.json(cur);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/presets/generate', async (req, res) => {
  // 한국어 설명 → 영어 프롬프트(+태그·주제·검색어) 자동 생성 (Claude API)
  try {
    const { generatePresetFromKorean } = await import('./llm.js');
    const r = await generatePresetFromKorean({ ...req.body, cfg: loadConfig() });
    console.log(`[AI 프롬프트] ${r.model} in=${r.usage.input} out=${r.usage.output}`);
    res.json(r);
  } catch (e) { const { describeError } = await import('./llm.js'); res.status(400).json({ error: describeError(e) }); }
});
app.post('/api/presets', async (req, res) => {
  // 새 프리셋 만들기 (한국어 설명만 있어도 됨: 영어 프롬프트가 비면 한국어 설명을 프롬프트로 사용)
  try {
    const b = req.body || {};
    const id = String(b.id || '').trim().toLowerCase();
    const file = presetPath(id);
    if (fs.existsSync(file)) return res.status(400).json({ error: `이미 있는 id: ${id}` });
    if (!b.name?.trim()) return res.status(400).json({ error: '이름을 입력하세요' });
    if (!b.koDescription?.trim() && !b.prompt?.trim()) return res.status(400).json({ error: '한국어 상세 설명 또는 영어 프롬프트 중 하나는 필요합니다' });
    const { isKnownTag } = await import('./providers/treblo.js');
    const bad = (b.negative_tags || []).filter(t => !isKnownTag(t));
    if (bad.length) return res.status(400).json({ error: `Treblo 태그 사전에 없는 태그: ${bad.join(', ')}` });
    const name = b.name.trim();
    const topics = { ko: [], en: [], ja: [], ...(b.topics || {}) };
    for (const l of Object.keys(topics)) topics[l] = (topics[l] || []).map(s => String(s).trim()).filter(Boolean);
    if (!topics.ko.length) topics.ko = ['첫 번째 이야기', '밤의 끝에서', '천천히 흐르는 시간', '창밖의 계절', '다시 만난 오후', '조용한 약속'];
    if (!topics.en.length) topics.en = topics.ko; if (!topics.ja.length) topics.ja = topics.ko;
    const p = {
      id, name, description: (b.description || '').trim() || name,
      koDescription: (b.koDescription || '').trim(), useKoDescription: b.useKoDescription !== false,
      prompt: (b.prompt || '').trim(), instrumental: Boolean(b.instrumental),
      negative_tags: b.negative_tags || [], length_range: Array.isArray(b.length_range) && b.length_range.length === 2 ? b.length_range : [150, 240],
      thumbnailStyle: b.thumbnailStyle || 'night', topics,
      titleTemplate: { ko: `[Playlist] ${name} {n}곡 · {dur}`, en: `[Playlist] ${name} {n} songs · {dur}`, ja: `[Playlist] ${name} {n}曲 · {dur}` },
      youtubeIntro: { ko: (b.description || '').trim() || name },
      hashtags: ['#playlist', '#aimusic'], keywords: [name, 'playlist'],
      imageQueries: (b.imageQueries || []).length ? b.imageQueries : ['abstract background', 'night city lights', 'nature landscape calm'],
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n', 'utf8');
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/presets/:id/copy', (req, res) => {
  try {
    const src = presetPath(req.params.id); const newId = String(req.body?.newId || '').trim();
    const dst = presetPath(newId);
    if (!fs.existsSync(src)) return res.status(404).json({ error: '원본 프리셋 없음' });
    if (fs.existsSync(dst)) return res.status(400).json({ error: '이미 있는 id' });
    const p = JSON.parse(fs.readFileSync(src, 'utf8')); p.id = newId; p.name = req.body?.name || `${p.name} (복제)`;
    fs.writeFileSync(dst, JSON.stringify(p, null, 2) + '\n', 'utf8');
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/presets/:id', (req, res) => {
  try { const f = presetPath(req.params.id); if (!fs.existsSync(f)) return res.sendStatus(404); fs.unlinkSync(f); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/config', (req, res) => res.json(maskConfig(loadConfig())));
app.post('/api/config', (req, res) => {
  const patch = req.body || {};
  if (patch.anthropic && typeof patch.anthropic.apiKey === 'string') {
    const k = patch.anthropic.apiKey.trim();
    if (!k || k.includes('****')) delete patch.anthropic.apiKey;
    else if (!/^[\x21-\x7E]{20,300}$/.test(k)) return res.status(400).json({ error: 'Claude API 키 형식이 아닙니다 (sk-ant-… 형태의 영문·숫자)' });
    else patch.anthropic.apiKey = k;
  }
  if (patch.treblo && typeof patch.treblo.apiKey === 'string') {
    const key = patch.treblo.apiKey.trim();
    if (!key || key.includes('****')) delete patch.treblo.apiKey; // 빈 값·마스킹된 값은 저장하지 않음
    else if (!/^[\x21-\x7E]{8,300}$/.test(key)) return res.status(400).json({ error: `API 키 형식이 아닙니다 (길이 ${key.length}, 한글·공백 등 포함). treblo.com/developers 에서 발급한 키만 붙여 넣으세요.` });
    else patch.treblo.apiKey = key;
  }
  res.json(maskConfig(saveConfig(patch)));
});
app.get('/api/backgrounds/:preset', async (req, res) => {
  const { listPool } = await import('./images.js');
  res.json(listPool(req.params.preset).map(p => ({ file: path.basename(p.file), url: `/assets/backgrounds/${req.params.preset}/${path.basename(p.file)}`, credit: p.credit })));
});
app.delete('/api/backgrounds/:preset/:file', async (req, res) => {
  // 마음에 안 드는 배경 사진 제외(풀에서 삭제 + 다시 받지 않도록 기록)
  const { rejectBackground } = await import('./images.js');
  res.json({ ok: true, id: rejectBackground(req.params.preset, req.params.file) });
});
app.post('/api/backgrounds/:preset/fetch', async (req, res) => {
  const { findBackground } = await import('./images.js');
  const preset = loadPresets().find(p => p.id === req.params.preset);
  if (!preset) return res.status(404).json({ error: '프리셋 없음' });
  const r = await findBackground({ presetId: preset.id, queries: preset.imageQueries, cfg: loadConfig(), log: () => {} });
  res.json(r ? { ok: true, file: path.basename(r.file), credit: r.credit } : { ok: false, error: '사진을 구하지 못했습니다' });
});
app.use('/assets', express.static(DIRS.assets));
app.get('/api/treblo/balance', async (req, res) => {
  try { const tp = new TrebloProvider(loadConfig().treblo); res.json(await tp.balance()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/local/files', (req, res) => {
  const lp = new LocalProvider(DIRS.input);
  res.json(lp.listFiles().map(f => ({ file: path.basename(f), title: LocalProvider.titleFromFile(f), hasLyrics: Boolean(LocalProvider.lyricsForFile(f)) })));
});
app.post('/api/plan', (req, res) => {
  const presets = loadPresets();
  const p = presets.find(x => x.id === req.body?.preset);
  if (!p) return res.status(400).json({ error: '프리셋 없음' });
  const plan = planTracks(p, req.body || {});
  res.json({ ...plan, credits: plan.specs.length * 100, estMinutes: Math.round(plan.specs.length * ((p.length_range?.[0] || 150) + (p.length_range?.[1] || 240)) / 2 / 60) });
});

// ── 작업
app.get('/api/jobs', (req, res) => res.json(listJobs({ includeHidden: req.query.all === '1' })));
app.post('/api/jobs/reset', (req, res) => res.json({ ok: true, hidden: hideFinishedJobs() }));
app.post('/api/jobs/unhide', (req, res) => res.json({ ok: true, unhidden: unhideJobs() }));
app.get('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id); if (!j) return res.sendStatus(404);
  let logs = j.logs.slice(-500);
  if (!logs.length) {
    // 서버 재시작 전 작업: 디스크의 job.log 에서 복원
    try {
      logs = fs.readFileSync(path.join(j.dir, 'job.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-500)
        .map(l => { const m = l.match(/^\[(\d\d:\d\d:\d\d)\] (\w+) (.*)$/); return m ? { t: m[1], level: m[2].toLowerCase(), msg: m[3] } : { t: '', level: 'info', msg: l }; });
    } catch {}
  }
  res.json({ ...summarize(j), logs });
});
app.post('/api/jobs', (req, res) => {
  const body = req.body || {};
  if (!body.preset) return res.status(400).json({ error: 'preset 필요' });
  const cfg = loadConfig();
  const provider = body.dryRun ? 'mock' : (body.provider || cfg.provider);
  if (provider === 'treblo' && !cfg.treblo.apiKey) return res.status(400).json({ error: 'Treblo API 키가 없습니다. 설정에서 입력하거나 소스를 "로컬 폴더"로 바꾸세요.' });
  const job = createJob({ ...body, provider });
  setImmediate(() => runJob(job, cfg));
  res.json(summarize(job));
});
app.post('/api/jobs/:id/cancel', (req, res) => { const j = getJob(req.params.id); if (!j) return res.sendStatus(404); j.cancelRequested = true; log(j, '취소 요청됨', 'warn'); res.json({ ok: true }); });
app.delete('/api/jobs/:id', (req, res) => {
  const j = getJob(req.params.id); if (!j) return res.sendStatus(404);
  if (j.status === 'running') return res.status(400).json({ error: '실행 중인 작업은 삭제할 수 없습니다. 먼저 취소하세요.' });
  try { fs.rmSync(j.dir, { recursive: true, force: true }); } catch {}
  removeJob(j.id);
  res.json({ ok: true });
});
app.post('/api/open', (req, res) => {
  // 탐색기에서 폴더 열기 (실행 PC에서만 의미 있음)
  const j = getJob(req.body?.id); const target = j ? j.dir : (req.body?.path === 'input' ? DIRS.input : DIRS.output);
  import('node:child_process').then(cp => cp.spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref());
  res.json({ ok: true, target });
});

// ── SSE 진행 상황
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ jobs: listJobs() })}\n\n`);
  const h = (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  bus.on('event', h);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { bus.off('event', h); clearInterval(ping); });
});

// ── 업데이트
app.get('/api/update/check', async (req, res) => res.json(await checkUpdate()));
app.post('/api/update/apply', async (req, res) => {
  const lines = [];
  try { const r = await applyUpdate(m => lines.push(m)); res.json({ ...r, log: lines }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message, log: lines }); }
});

// ── 종료
app.post('/api/shutdown', async (req, res) => {
  const lines = [];
  // 클라이언트가 먼저 창을 닫을 수 있도록 응답을 보낸 뒤 정리 실행
  res.json({ ok: true, message: '종료 절차를 시작합니다.' });
  setTimeout(async () => {
    const steps = await shutdownSequence({ port: PORT, log: m => { lines.push(m); console.log('[종료]', m); } });
    console.log('[종료] 서버를 종료합니다.');
    setTimeout(() => process.exit(0), 300);
  }, 700);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddresses(PORT);
  console.log(`\n  ${APP_TITLE} v${JSON.parse(fs.readFileSync(path.join(DIRS.root, 'package.json'), 'utf8')).version}`);
  console.log(`  로컬:  http://localhost:${PORT}`);
  for (const l of lan) console.log(`  LAN:   ${l.url}  (${l.name})`);
  console.log(`  입력 폴더: ${DIRS.input}\n  출력 폴더: ${DIRS.output}`);
  console.log(`  종료: 화면 우측 상단 [종료] 버튼 또는 STOP.bat\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`포트 ${PORT} 가 이미 사용 중입니다. STOP.bat 으로 이전 인스턴스를 종료하거나 config.json 의 port 를 바꾸세요.`); process.exit(1); }
  throw e;
});
process.on('SIGINT', () => process.exit(0));
