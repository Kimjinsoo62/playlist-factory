import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, APP_TITLE } from './paths.js';
import { loadConfig, saveConfig, maskConfig } from './config.js';
import { lanAddresses } from './lan.js';
import { bus, createJob, getJob, removeJob, listJobs, summarize, loadPastJobs, log, hideFinishedJobs, unhideJobs } from './jobs.js';
import { runJob, loadPresets, planTracks, DEFAULT_TOPICS } from './pipeline.js';
import { shutdownSequence } from './shutdown.js';
import { openAppWindow } from './browser.js';
import { checkUpdate, applyUpdate } from './update.js';
import { TrebloProvider } from './providers/treblo.js';
import { LocalProvider } from './providers/local.js';
import { LyriaProvider, LYRIA_USD_PER_SONG, LYRIA_MODELS } from './providers/lyria.js';
import { MurekaProvider, MUREKA_MODELS } from './providers/mureka.js';
import { LLM_PROVIDERS, llmProvider, llmKey, checkLlmKey, listLlmModels, describeError as describeLlmError } from './llm.js';
import * as yt from './youtubeUpload.js';

const cfg0 = loadConfig();
const PORT = cfg0.port;
const app = express();
app.use(express.json({ limit: '2mb' }));
// 다른 사이트(출처)에서 온 API 요청은 거부한다. 열어 둔 아무 웹페이지가 작업 시작(과금)·설정 변경·종료를 못 하게.
// 이 서버가 내려준 화면(localhost·LAN 주소 모두)은 Origin 의 host 가 Host 와 같고, MCP·curl 은 Origin 을 보내지 않는다.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  let host = '';
  try { host = new URL(origin).host; } catch {}
  if (host && host === req.headers.host) return next();
  res.status(403).json({ error: `다른 출처(${origin})의 요청은 허용하지 않습니다.` });
});
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
const PRESET_FIELDS = ['name', 'description', 'koDescription', 'useKoDescription', 'prompt', 'instrumental', 'vocalGender', 'topics', 'negative_tags', 'tags', 'length_range', 'thumbnailStyle', 'imageQueries', 'titleTemplate', 'youtubeIntro', 'hashtags', 'keywords'];
function presetPath(id) { if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error('프리셋 id는 영문 소문자·숫자·하이픈만'); return path.join(DIRS.presets, id + '.json'); }
app.put('/api/presets/:id', async (req, res) => {
  try {
    const file = presetPath(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: '프리셋 없음' });
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { isKnownTag } = await import('./providers/treblo.js');
    for (const k of PRESET_FIELDS) if (k in (req.body || {})) cur[k] = req.body[k];
    cur.vocalGender = ['male', 'female'].includes(cur.vocalGender) ? cur.vocalGender : '';   // '' = 미지정(프리셋 프롬프트대로)
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
    const bad = [...(b.tags || []), ...(b.negative_tags || [])].filter(t => !isKnownTag(t));
    if (bad.length) return res.status(400).json({ error: `Treblo 태그 사전에 없는 태그: ${bad.join(', ')}` });
    const name = b.name.trim();
    // 영어 프롬프트가 비어 있으면 메인 LLM 으로 자동 생성 (장르·악기·템포가 담긴 프롬프트 + 제외 태그·주제·배경 검색어). 실패하면 한국어 설명만으로 저장.
    let generated = null, generateError = null;
    if (!b.prompt?.trim() && b.koDescription?.trim() && b.autoGenerate !== false) {
      const { generatePresetFromKorean, hasLlmKey, describeError } = await import('./llm.js');
      const cfg = loadConfig();
      if (hasLlmKey(cfg)) {
        try {
          generated = await generatePresetFromKorean({ koDescription: b.koDescription, name, instrumental: Boolean(b.instrumental), wantTopics: true, cfg });
          b.prompt = generated.prompt;
          if (!b.description?.trim() && generated.description) b.description = generated.description;
          if (!(b.tags || []).length) b.tags = generated.tags;
          if (!(b.negative_tags || []).length) b.negative_tags = generated.negative_tags;
          if (!(b.imageQueries || []).length) b.imageQueries = generated.imageQueries;
          const t = b.topics || {}; if (!(t.ko || []).length && generated.topics.ko.length) b.topics = generated.topics;
          console.log(`[AI 프롬프트] 새 프리셋 ${id}: ${generated.model} in=${generated.usage?.input} out=${generated.usage?.output}`);
        } catch (e) { generateError = describeError(e); console.warn(`[AI 프롬프트] 새 프리셋 ${id} 자동 생성 실패: ${generateError}`); }
      } else generateError = '메인 LLM 키 없음';
    }
    const topics = { ko: [], en: [], ja: [], ...(b.topics || {}) };
    for (const l of Object.keys(topics)) topics[l] = (topics[l] || []).map(s => String(s).trim()).filter(Boolean);
    for (const l of ['ko', 'en', 'ja']) if (!topics[l].length) topics[l] = DEFAULT_TOPICS[l];   // 언어별 기본 주제 (영어 곡에 한국어 제목이 붙지 않도록)
    const p = {
      id, name, description: (b.description || '').trim() || name,
      koDescription: (b.koDescription || '').trim(), useKoDescription: generated ? false : b.useKoDescription !== false,   // 자동 생성 프롬프트는 설명의 번역이라 둘 다 보내면 중복
      prompt: (b.prompt || '').trim(), instrumental: Boolean(b.instrumental), vocalGender: ['male', 'female'].includes(b.vocalGender) ? b.vocalGender : '',
      tags: b.tags || [], negative_tags: b.negative_tags || [], length_range: Array.isArray(b.length_range) && b.length_range.length === 2 ? b.length_range : [150, 240],
      thumbnailStyle: b.thumbnailStyle || 'night', topics,
      titleTemplate: { ko: `[Playlist] ${name} {n}곡 · {dur}`, en: `[Playlist] ${name} {n} songs · {dur}`, ja: `[Playlist] ${name} {n}曲 · {dur}` },
      youtubeIntro: { ko: (b.description || '').trim() || name },
      hashtags: ['#playlist', '#aimusic'], keywords: [name, 'playlist'],
      imageQueries: (b.imageQueries || []).length ? b.imageQueries : ['abstract background', 'night city lights', 'nature landscape calm'],
      quick: Boolean(b.quick),   // [간편하게 생성]이 곡 설명으로 만든 프리셋 (화면에 ⚡ 표시)
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n', 'utf8');
    res.json({ ...p, _generated: Boolean(generated), _generateError: generateError, _model: generated?.model });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/presets/:id/copy', (req, res) => {
  try {
    const src = presetPath(req.params.id); const newId = String(req.body?.newId || '').trim();
    const dst = presetPath(newId);
    if (!fs.existsSync(src)) return res.status(404).json({ error: '원본 프리셋 없음' });
    if (fs.existsSync(dst)) return res.status(400).json({ error: '이미 있는 id' });
    const p = JSON.parse(fs.readFileSync(src, 'utf8')); p.id = newId; p.name = req.body?.name || `${p.name} (복제)`; delete p.quick;   // 복제본은 일반 프리셋
    fs.writeFileSync(dst, JSON.stringify(p, null, 2) + '\n', 'utf8');
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/presets/:id', (req, res) => {
  try { const f = presetPath(req.params.id); if (!fs.existsSync(f)) return res.sendStatus(404); fs.unlinkSync(f); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/config', async (req, res) => { const cfg = loadConfig(); const { hasLlmKey } = await import('./llm.js'); res.json({ ...maskConfig(cfg), hasLlmKey: hasLlmKey(cfg) }); });
app.post('/api/config', (req, res) => {
  const patch = req.body || {};
  if (patch.anthropic && typeof patch.anthropic.apiKey === 'string') {
    const k = patch.anthropic.apiKey.trim();
    if (!k || k.includes('****')) delete patch.anthropic.apiKey;
    else if (!/^[\x21-\x7E]{20,300}$/.test(k)) return res.status(400).json({ error: 'Claude API 키 형식이 아닙니다 (sk-ant-… 형태의 영문·숫자)' });
    else patch.anthropic.apiKey = k;
  }
  if (patch.lyria && typeof patch.lyria.apiKey === 'string') {
    const k = patch.lyria.apiKey.trim();
    if (!k || k.includes('****')) delete patch.lyria.apiKey;
    else if (!/^[\x21-\x7E]{20,300}$/.test(k)) return res.status(400).json({ error: 'Gemini API 키 형식이 아닙니다 (AIza… 형태의 영문·숫자). aistudio.google.com 에서 발급한 키만 붙여 넣으세요.' });
    else patch.lyria.apiKey = k;
  }
  // 사진·영상 소스 키: 빈 값·마스킹된 값은 저장하지 않음 (모달을 그냥 저장해도 기존 키가 지워지지 않게)
  for (const [sec, key] of [['images', 'pexelsKey'], ['videos', 'pixabayKey']]) {
    if (patch[sec] && typeof patch[sec][key] === 'string') {
      const k = patch[sec][key].trim();
      if (!k || k.includes('****')) delete patch[sec][key];
      else if (!/^[\x21-\x7E]{8,300}$/.test(k)) return res.status(400).json({ error: `${key} 형식이 아닙니다 (영문·숫자만, 길이 ${k.length})` });
      else patch[sec][key] = k;
    }
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
  const r = await findBackground({ presetId: preset.id, queries: preset.imageQueries, cfg: loadConfig(), log: () => {}, freshOnly: true });   // 새 사진만(풀 재사용 금지)
  res.json(r ? { ok: true, file: path.basename(r.file), credit: r.credit } : { ok: false, error: '사진을 구하지 못했습니다' });
});
// ── 배경 영상 풀 (프리셋별 assets/backgrounds/<preset>/videos/)
app.get('/api/videos/:preset', async (req, res) => {
  const { listVideoPool } = await import('./videos.js');
  res.json(listVideoPool(req.params.preset).map(p => ({ file: path.basename(p.file), url: `/assets/backgrounds/${req.params.preset}/videos/${path.basename(p.file)}`, credit: p.credit })));
});
app.delete('/api/videos/:preset/:file', async (req, res) => {
  const { rejectVideo } = await import('./videos.js');
  res.json({ ok: true, id: rejectVideo(req.params.preset, req.params.file) });
});
app.post('/api/videos/:preset/fetch', async (req, res) => {
  const { collectVideos, videoKeyReady } = await import('./videos.js');
  const preset = loadPresets().find(p => p.id === req.params.preset);
  if (!preset) return res.status(404).json({ error: '프리셋 없음' });
  const cfg = loadConfig();
  if (!videoKeyReady(cfg)) return res.json({ ok: false, error: `${cfg.videos?.provider === 'pixabay' ? 'Pixabay' : 'Pexels'} API 키가 없습니다. 아래에 입력하고 저장하세요.` });
  const lines = [];
  const r = await collectVideos({ presetId: preset.id, queries: preset.imageQueries, cfg, log: m => lines.push(m), count: 1, maxFetch: 1, freshOnly: true });
  res.json(r[0] ? { ok: true, file: path.basename(r[0].file), credit: r[0].credit, log: lines } : { ok: false, error: '영상을 구하지 못했습니다 (검색 결과 없음 또는 다운로드 실패)', log: lines });
});
app.use('/assets', express.static(DIRS.assets));
// ── 작곡 AI API 키 관리 (설정 모달)
const KEY_PROVIDERS = {
  treblo: { kind: 'music', label: 'Treblo', env: 'TREBLO_API_KEY', pattern: /^[\x21-\x7E]{8,300}$/, models: ['v3', 'v2'], maxConc: 10, hint: 'treblo.com/developers 에서 발급한 키만 붙여 넣으세요.' },
  lyria: { kind: 'music', label: 'Lyria(Gemini)', env: 'GEMINI_API_KEY', pattern: /^[\x21-\x7E]{20,300}$/, models: LYRIA_MODELS, maxConc: 6, hint: 'aistudio.google.com 에서 발급한 AIza… 형태의 키만 붙여 넣으세요.' },
  mureka: { kind: 'music', label: 'Mureka', env: 'MUREKA_API_KEY', pattern: /^[\x21-\x7E]{16,300}$/, models: MUREKA_MODELS, maxConc: 25, hint: 'platform.mureka.ai/apiKeys 에서 발급한 키만 붙여 넣으세요.' },
  ...Object.fromEntries(Object.entries(LLM_PROVIDERS).map(([id, m]) => [id, { kind: 'llm', label: m.label, env: m.env, pattern: /^[\x21-\x7E]{20,300}$/, models: null, maxConc: 0, hint: `${m.site} 에서 발급한 ${m.keyHint} 형태의 키만 붙여 넣으세요.` }])),
};
const isMusic = (id) => KEY_PROVIDERS[id]?.kind === 'music';
const isLlm = (id) => KEY_PROVIDERS[id]?.kind === 'llm';
const MODEL_ID = /^[\w.\-:/]{3,80}$/;   // LLM 모델 id 는 자유 입력(제공자마다 수시로 바뀜)
function keyStatus(cfg) {
  const out = {};
  for (const [id, m] of Object.entries(KEY_PROVIDERS)) {
    const k = cfg[id]?.apiKey || '';
    const shared = m.kind === 'llm' && id === 'gemini' && !k && Boolean(cfg.lyria?.apiKey);   // Lyria 키 공유
    out[id] = { kind: m.kind, set: Boolean(k) || shared, shared, masked: k ? k.slice(0, 4) + '****' + k.slice(-4) : (shared ? 'Lyria 키 공유' : ''), fromEnv: Boolean(process.env[m.env]), model: cfg[id]?.model, cheapModel: m.kind === 'llm' ? cfg[id]?.cheapModel : undefined, concurrency: m.maxConc ? cfg[id]?.concurrency : undefined, active: m.kind === 'music' ? activeProvider(cfg) === id : llmProvider(cfg) === id };
  }
  return out;
}
/** 활성 작곡 AI: config.provider (treblo | lyria). 작곡 AI 가 아닌 값이 들어 있으면 treblo 로 간주 */
function activeProvider(cfg) { return isMusic(cfg.provider) ? cfg.provider : 'treblo'; }
app.get('/api/keys', (req, res) => res.json(keyStatus(loadConfig())));
app.put('/api/keys/:provider', (req, res) => {
  const id = req.params.provider, m = KEY_PROVIDERS[id];
  if (!m) return res.status(404).json({ error: '알 수 없는 소스' });
  const b = req.body || {}; const patch = {};
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
    const k = b.apiKey.trim();
    if (k.includes('****')) return res.status(400).json({ error: '마스킹된 키는 저장할 수 없습니다. 새 키를 입력하세요.' });
    if (!m.pattern.test(k)) return res.status(400).json({ error: `${m.label} API 키 형식이 아닙니다 (길이 ${k.length}, 한글·공백 등 포함). ${m.hint}` });
    patch.apiKey = k;
  }
  if (typeof b.model === 'string' && (m.models ? m.models.includes(b.model) : MODEL_ID.test(b.model.trim()))) patch.model = b.model.trim();
  if (isLlm(id) && typeof b.cheapModel === 'string' && MODEL_ID.test(b.cheapModel.trim())) patch.cheapModel = b.cheapModel.trim();
  if (m.maxConc && Number.isFinite(Number(b.concurrency)) && Number(b.concurrency) >= 1) patch.concurrency = Math.min(m.maxConc, Math.floor(Number(b.concurrency)));
  if (!Object.keys(patch).length) return res.status(400).json({ error: '저장할 값이 없습니다' });
  res.json(keyStatus(saveConfig({ [id]: patch })));
});
app.delete('/api/keys/:provider', (req, res) => {
  const id = req.params.provider, m = KEY_PROVIDERS[id];
  if (!m) return res.status(404).json({ error: '알 수 없는 소스' });
  const cfg = saveConfig({ [id]: { apiKey: '' } });
  if (process.env[m.env]) return res.status(400).json({ error: `config.json 의 키는 지웠지만 환경변수 ${m.env} 가 설정되어 있어 계속 사용됩니다.`, ...keyStatus(cfg) });
  res.json(keyStatus(cfg));
});
// 활성화/대기: 작곡 AI 는 한 번에 하나만 활성. 대기 소스로는 작업을 시작할 수 없다.
app.post('/api/keys/:provider/activate', (req, res) => {
  const id = req.params.provider, m = KEY_PROVIDERS[id];
  if (!m) return res.status(404).json({ error: '알 수 없는 소스' });
  const cfg = loadConfig();
  if (isLlm(id)) {
    if (!llmKey(cfg, id)) return res.status(400).json({ error: `${m.label} API 키가 없어 메인 LLM 으로 지정할 수 없습니다. 먼저 키를 저장하세요.` });
    return res.json(keyStatus(saveConfig({ llm: { provider: id } })));
  }
  if (!cfg[id]?.apiKey) return res.status(400).json({ error: `${m.label} API 키가 없어 활성화할 수 없습니다. 먼저 키를 저장하세요.` });
  res.json(keyStatus(saveConfig({ provider: id })));
});
app.post('/api/keys/:provider/standby', (req, res) => {
  const id = req.params.provider, m = KEY_PROVIDERS[id];
  if (!m) return res.status(404).json({ error: '알 수 없는 소스' });
  const cfg = loadConfig();
  if (isLlm(id)) {
    if (llmProvider(cfg) !== id) return res.json(keyStatus(cfg));
    const next = Object.keys(LLM_PROVIDERS).find(p => p !== id && llmKey(cfg, p));
    if (!next) return res.status(400).json({ error: `다른 LLM 키가 없어 ${m.label} 를 대기로 둘 수 없습니다. 메인 LLM 은 하나가 지정되어 있어야 합니다.` });
    return res.json(keyStatus(saveConfig({ llm: { provider: next } })));
  }
  if (activeProvider(cfg) !== id) return res.json(keyStatus(cfg));          // 이미 대기
  const other = Object.keys(KEY_PROVIDERS).find(p => p !== id && isMusic(p) && cfg[p]?.apiKey);
  if (!other) return res.status(400).json({ error: `다른 작곡 AI 키가 없어 ${m.label} 를 대기로 둘 수 없습니다. 작곡 AI 는 최소 하나가 활성이어야 합니다.` });
  res.json(keyStatus(saveConfig({ provider: other })));
});
app.get('/api/keys/:provider/check', async (req, res) => {
  const id = req.params.provider; const cfg = loadConfig();
  try {
    if (id === 'treblo') { const b = await new TrebloProvider(cfg.treblo).balance(); return res.json({ ok: true, summary: `크레딧 구독 ${(b.num_credits || 0).toLocaleString()} + 종량제 ${(b.num_credits_payg || 0).toLocaleString()} (곡당 100)`, balance: b }); }
    if (id === 'lyria') { const r = await new LyriaProvider(cfg.lyria).check(); return res.json({ ok: true, summary: `연결 정상: ${r.model}${r.displayName ? ' (' + r.displayName + ')' : ''}`, ...r }); }
    if (id === 'mureka') { const b = await new MurekaProvider(cfg.mureka).billing(); return res.json({ ok: true, summary: `잔액 $${b.balanceUsd.toFixed(2)} · 동시 요청 한도 ${b.concurrentLimit}${cfg.mureka.concurrency > b.concurrentLimit && b.concurrentLimit ? ` (동시 생성 수 ${cfg.mureka.concurrency} → 작업 시 ${b.concurrentLimit}로 제한됨)` : ''}`, ...b }); }
    if (isLlm(id)) { try { const r = await checkLlmKey(cfg, id); return res.json({ ok: true, summary: `연결 정상: ${r.model}${r.displayName ? ' (' + r.displayName + ')' : ''}`, ...r }); } catch (e) { return res.status(400).json({ error: describeLlmError(e, id) }); } }
    res.status(404).json({ error: '알 수 없는 소스' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/keys/:provider/models', async (req, res) => {
  const id = req.params.provider;
  if (!isLlm(id)) return res.status(404).json({ error: '모델 목록은 LLM 제공자만 지원합니다' });
  try { res.json({ models: await listLlmModels(loadConfig(), id) }); }
  catch (e) { res.status(400).json({ error: describeLlmError(e, id) }); }
});
app.get('/api/treblo/balance', async (req, res) => {
  try { const tp = new TrebloProvider(loadConfig().treblo); res.json(await tp.balance()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/mureka/balance', async (req, res) => {
  try { res.json(await new MurekaProvider(loadConfig().mureka).billing()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/lyria/check', async (req, res) => {
  try { const lp = new LyriaProvider(loadConfig().lyria); res.json(await lp.check()); }
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
  res.json({ ...plan, credits: plan.specs.length * 100, lyriaUsd: Math.round(plan.specs.length * LYRIA_USD_PER_SONG * 100) / 100, estMinutes: Math.round(plan.specs.length * ((p.length_range?.[0] || 150) + (p.length_range?.[1] || 240)) / 2 / 60) });
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
app.get('/api/library', async (req, res) => {
  const { listLibrary } = await import('./library.js');
  res.json(listLibrary({ preset: String(req.query.preset || ''), includeMock: req.query.mock === '1' }).map(t => ({ ...t, file: undefined })));   // 절대 경로는 화면에 보내지 않음
});
app.post('/api/jobs', async (req, res) => {
  const body = req.body || {};
  if (!body.preset) return res.status(400).json({ error: 'preset 필요' });
  const cfg = loadConfig();
  const provider = body.dryRun ? 'mock' : (body.provider || cfg.provider);
  if (provider === 'compile') {
    // 보관 곡 조합: 곡 목록 검증, 곡 수·연주곡 여부·언어는 재료에서 결정
    try {
      const { resolveTracks } = await import('./library.js');
      const items = resolveTracks(body.tracks);
      body.count = items.length;
      body.instrumental = items.every(it => Boolean(it.job.request?.instrumental));
      if (!['ko', 'en', 'ja'].includes(body.language)) { const c = {}; for (const it of items) { const l = it.job.request?.language || 'ko'; c[l] = (c[l] || 0) + 1; } body.language = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; }
      body.crossfadeSeconds = Math.max(0, Math.min(10, Number(body.crossfadeSeconds) || 0));
      delete body.koDescription; delete body.extraPrompt;
    } catch (e) { return res.status(400).json({ error: e.message }); }
  }
  if (isMusic(provider) && activeProvider(cfg) !== provider) return res.status(400).json({ error: `${KEY_PROVIDERS[provider].label} 소스는 대기 상태입니다. 상단 [설정]에서 활성화한 뒤 사용하세요. (현재 활성: ${KEY_PROVIDERS[activeProvider(cfg)].label})` });
  if (provider === 'treblo' && !cfg.treblo.apiKey) return res.status(400).json({ error: 'Treblo API 키가 없습니다. 설정에서 입력하거나 소스를 "로컬 폴더"로 바꾸세요.' });
  if (provider === 'mureka' && !cfg.mureka.apiKey) return res.status(400).json({ error: 'Mureka API 키가 없습니다. 설정에서 입력하세요.' });
  if (provider === 'lyria') {
    if (!cfg.lyria.apiKey) return res.status(400).json({ error: 'Lyria(Gemini) API 키가 없습니다. 설정에서 입력하세요.' });
    const p = loadPresets().find(x => x.id === body.preset);
    if (!p) return res.status(400).json({ error: '프리셋 없음' });
    if (!planTracks(p, body).instrumental) return res.status(400).json({ error: 'Lyria 소스는 연주곡 프리셋에서만 쓸 수 있습니다. 연주곡 프리셋을 고르거나 보컬 옵션을 "연주곡"으로 바꾸세요. (Lyria 는 가사 타이밍 데이터를 주지 않아 가사 자막을 만들 수 없음)' });
  }
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

// ── 유튜브 업로드 (Google OAuth 데스크톱 앱 클라이언트 → localhost 리디렉션 → YouTube Data API v3)
app.get('/api/youtube/status', (req, res) => res.json(yt.status(loadConfig())));
app.post('/api/youtube/settings', (req, res) => {
  const b = req.body || {}; const patch = {};
  if (typeof b.clientId === 'string' && b.clientId.trim()) { const v = b.clientId.trim(); if (!/^[\w.\-]{10,200}$/.test(v)) return res.status(400).json({ error: '클라이언트 ID 형식이 아닙니다 (…apps.googleusercontent.com)' }); patch.clientId = v; }
  if (typeof b.clientSecret === 'string' && b.clientSecret.trim() && !b.clientSecret.includes('****')) { const v = b.clientSecret.trim(); if (!/^[\x21-\x7E]{10,200}$/.test(v)) return res.status(400).json({ error: '클라이언트 비밀 형식이 아닙니다' }); patch.clientSecret = v; }
  for (const k of ['autoUpload', 'uploadThumbnail', 'syntheticMedia']) if (typeof b[k] === 'boolean') patch[k] = b[k];
  if (['private', 'unlisted', 'public'].includes(b.defaultPrivacy)) patch.defaultPrivacy = b.defaultPrivacy;
  if (!Object.keys(patch).length) return res.status(400).json({ error: '저장할 값이 없습니다' });
  res.json(yt.status(saveConfig({ youtube: patch })));
});
app.get('/api/youtube/auth/url', (req, res) => { try { res.json({ url: yt.authUrl(loadConfig()) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/youtube/oauth/callback', async (req, res) => {
  try { const r = await yt.handleCallback(req.query); console.log(`[유튜브] Google 계정 연결됨: ${r.channelTitle || r.channelId}`); res.send(yt.callbackPage(true, 'Google 계정 연결 완료', `채널: ${r.channelTitle || r.channelId || '(이름 없음)'}`)); }
  catch (e) { console.warn('[유튜브] 연결 실패:', e.message); res.status(400).send(yt.callbackPage(false, 'Google 계정 연결 실패', e.message)); }
});
app.post('/api/youtube/disconnect', (req, res) => { yt.disconnect(); res.json(yt.status(loadConfig())); });
app.post('/api/youtube/upload', (req, res) => {
  const j = getJob(req.body?.jobId); if (!j) return res.status(404).json({ error: '작업 없음' });
  const cfg = loadConfig();
  if (!yt.status(cfg).connected) return res.status(400).json({ error: 'Google 계정이 연결되어 있지 않습니다. 왼쪽 "유튜브 업로드"에서 [Google 계정 연결]을 누르세요.' });
  let p; try { p = yt.prepare(j, req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  yt.upload(j, p, cfg).catch(() => {});   // 진행·결과는 job.youtube + SSE 로 전달
  res.json({ ok: true, jobId: j.id, title: p.title, privacy: p.privacy, publishAt: p.publishAt });
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
  // START.bat 이 PF_OPEN_BROWSER=1 로 실행하면 서버가 뜬 뒤 앱 전용 창을 연다 (npm start·테스트에서는 열지 않음)
  if (process.env.PF_OPEN_BROWSER === '1') console.log(`  브라우저: ${openAppWindow(`http://localhost:${PORT}`)}\n`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`포트 ${PORT} 가 이미 사용 중입니다. STOP.bat 으로 이전 인스턴스를 종료하거나 config.json 의 port 를 바꾸세요.`); process.exit(1); }
  throw e;
});
process.on('SIGINT', () => process.exit(0));
