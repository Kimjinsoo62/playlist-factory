import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, APP_TITLE } from './paths.js';
import { loadConfig, saveConfig, maskConfig } from './config.js';
import { lanAddresses } from './lan.js';
import { bus, createJob, getJob, removeJob, listJobs, summarize, loadPastJobs, log } from './jobs.js';
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
app.get('/api/config', (req, res) => res.json(maskConfig(loadConfig())));
app.post('/api/config', (req, res) => {
  const patch = req.body || {};
  if (patch.treblo && typeof patch.treblo.apiKey === 'string' && patch.treblo.apiKey.includes('****')) delete patch.treblo.apiKey; // 마스킹된 값은 저장하지 않음
  res.json(maskConfig(saveConfig(patch)));
});
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
app.get('/api/jobs', (req, res) => res.json(listJobs()));
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
