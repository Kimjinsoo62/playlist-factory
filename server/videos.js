// 무료 배경 영상 클립 자동 수집: Pexels Videos(키 필요, images.pexelsKey) / Pixabay Videos(키 필요, images.pixabayKey — 사진과 같은 키)
// 두 서비스 모두 무료 키로 상업 이용(유튜브 수익화 포함)이 허용되고 출처 표기는 권장 사항 → 유튜브 설명에 자동 기재한다.
// 사진 풀(images.js)과 같은 구조: assets/backgrounds/<preset>/videos/ 에 정규화된 mp4(1920x1080, 무음, clipSeconds) + 출처 json.
// 거부 목록은 사진과 같은 _rejected.txt 를 쓰되 id 앞에 pv:(Pexels) / px:(Pixabay) 를 붙여 사진 id 와 섞이지 않게 한다.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DIRS } from './paths.js';
import { normalizeClip, probe } from './media/ffmpeg.js';

const UA = 'playlist-factory/0.1 (https://github.com; local app)';
const PEOPLE = /\b(person|people|man|woman|men|women|girl|boy|guy|lady|portrait|face|child|children|kid|kids|baby|crowd|selfie|model|wedding|bride|couple|family|dancer|dancing|athlete|musician|band|concert|audience|team|students?|businesswoman|businessman|soldiers?|hands?|feet)\b/i;

async function fetchJson(url, headers = {}, timeoutMs = 45000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function download(url, dest, timeoutMs = 180000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  } finally { clearTimeout(t); }
}

/** Pexels 영상에는 설명이 없어 페이지 주소의 슬러그("rain-falling-on-a-window-1234")에서 제목을 만든다 */
function slugTitle(pageUrl) {
  const m = String(pageUrl || '').match(/\/video\/([^/?#]+?)(?:-(\d+))?\/?$/);
  return m ? m[1].replace(/-/g, ' ') : '';
}
/** 1920 폭에 가장 가까운 mp4 파일(없으면 가장 큰 것) */
function pickPexelsFile(files) {
  const mp4 = (files || []).filter(f => /mp4/i.test(f.file_type || '') && f.link && f.width);
  if (!mp4.length) return null;
  return mp4.sort((a, b) => Math.abs(a.width - 1920) - Math.abs(b.width - 1920) || (b.width - a.width))[0];
}

export async function searchPexelsVideos(query, cfg, { count = 15 } = {}) {
  const key = cfg?.images?.pexelsKey; if (!key) throw new Error('Pexels API 키가 없습니다 ([배경] 설정에서 입력)');
  const base = (cfg?.videos?.pexelsBase || 'https://api.pexels.com/v1').replace(/\/$/, '');
  const q = new URLSearchParams({ query, orientation: 'landscape', size: 'medium', per_page: String(count) });
  const d = await fetchJson(`${base}/videos/search?${q}`, { Authorization: key });
  return (d.videos || []).map(v => {
    const f = pickPexelsFile(v.video_files);
    if (!f) return null;
    return {
      id: `pv:${v.id}`, kind: 'video', url: f.link, title: slugTitle(v.url) || `pexels video ${v.id}`, creator: v.user?.name || '', creatorUrl: v.user?.url || '',
      license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', desc: slugTitle(v.url), source: 'pexels', provider: 'pexels', page: v.url,
      width: f.width, height: f.height, duration: Number(v.duration) || 0, preview: v.image || '',
    };
  }).filter(Boolean);
}

export async function searchPixabayVideos(query, cfg, { count = 15 } = {}) {
  const key = cfg?.images?.pixabayKey; if (!key) throw new Error('Pixabay API 키가 없습니다 ([배경] 설정에서 입력)');
  const base = (cfg?.videos?.pixabayBase || 'https://pixabay.com/api').replace(/\/$/, '');
  const q = new URLSearchParams({ key, q: query.slice(0, 100), video_type: 'film', safesearch: 'true', per_page: String(Math.max(3, count)), min_width: '1280' });
  const d = await fetchJson(`${base}/videos/?${q}`);
  return (d.hits || []).map(h => {
    const v = h.videos || {};
    const f = (v.medium?.url && v.medium) || (v.large?.url && v.large) || (v.small?.url && v.small);   // medium ≈ 1920x1080, large 는 4K 라 무거움
    if (!f) return null;
    return {
      id: `px:${h.id}`, kind: 'video', url: f.url, title: String(h.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4).join(', ') || `pixabay video ${h.id}`, creator: h.user || '',
      license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', desc: h.tags || '', source: 'pixabay', provider: 'pixabay', page: h.pageURL,
      width: f.width, height: f.height, duration: Number(h.duration) || 0, preview: f.thumbnail || '',
    };
  }).filter(Boolean);
}

function loadRejected() {
  try { return new Set(fs.readFileSync(path.join(DIRS.assets, 'backgrounds', '_rejected.txt'), 'utf8').split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean)); }
  catch { return new Set(); }
}
function poolDir(presetId) { const d = path.join(DIRS.assets, 'backgrounds', presetId, 'videos'); fs.mkdirSync(d, { recursive: true }); return d; }
export function listVideoPool(presetId) {
  const d = poolDir(presetId);
  return fs.readdirSync(d).filter(f => f.endsWith('.mp4')).map(f => {
    let credit = null; try { credit = JSON.parse(fs.readFileSync(path.join(d, f.replace(/\.mp4$/, '.json')), 'utf8')); } catch {}
    return { file: path.join(d, f), credit };
  });
}
/** 풀에서 지우고 거부 목록에 기록(다시 받지 않음). 반환: id */
export function rejectVideo(presetId, file) {
  const d = poolDir(presetId); const base = path.basename(file, '.mp4');
  let id = null; try { id = JSON.parse(fs.readFileSync(path.join(d, base + '.json'), 'utf8')).id; } catch {}
  for (const ext of ['.mp4', '.json', '.jpg']) { try { fs.unlinkSync(path.join(d, base + ext)); } catch {} }
  if (id) fs.appendFileSync(path.join(DIRS.assets, 'backgrounds', '_rejected.txt'), `${id}  # ${presetId} video ${new Date().toISOString().slice(0, 10)}\n`, 'utf8');
  return id;
}

export function videoKeyReady(cfg) {
  const p = cfg?.videos?.provider || 'pexels';
  return p === 'pixabay' ? Boolean(cfg?.images?.pixabayKey) : Boolean(cfg?.images?.pexelsKey);
}

async function gatherCandidates({ presetId, queries, cfg, log, avoid = [], maxQueries = 3 }) {
  const provider = cfg?.videos?.provider || 'pexels';
  const qs = [...new Set((queries || []).map(q => String(q).trim()).filter(Boolean))];
  const useQs = qs.length > maxQueries ? qs.sort(() => Math.random() - 0.5).slice(0, maxQueries) : qs;
  if (!useQs.length) useQs.push('abstract background');
  log?.(`배경 영상 검색 (${provider}): ${useQs.map(q => `"${q}"`).join(', ')}`);
  const searchOne = (query) => (provider === 'pixabay' ? searchPixabayVideos(query, cfg) : searchPexelsVideos(query, cfg)).then(rs => rs.map(r => ({ ...r, query })));
  const settled = await Promise.allSettled(useQs.map(searchOne));
  const used = new Set(listVideoPool(presetId).map(p => p.credit?.id));
  const rejected = loadRejected();
  const avoidRe = avoid.length ? new RegExp(`\\b(${avoid.map(a => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
  const minDur = Math.max(4, Number(cfg?.videos?.clipSeconds) || 12) * 0.5;   // 너무 짧은 클립은 제외(마지막 프레임 정지가 길어짐)
  const seen = new Set(); const out = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') { log?.(`"${useQs[i]}" 영상 검색 실패: ${s.reason?.message?.split('\n')[0]}`, 'warn'); return; }
    for (const r of s.value) {
      if (seen.has(r.id) || used.has(r.id) || rejected.has(r.id)) continue;
      if (r.duration && r.duration < minDur) continue;
      if (PEOPLE.test(`${r.title} ${r.desc || ''}`)) continue;
      if (avoidRe && avoidRe.test(`${r.title} ${r.desc || ''}`)) continue;
      seen.add(r.id); out.push(r);
    }
  });
  log?.(`영상 후보 ${out.length}개 (무료·상업 이용 가능, 인물 제외)`);
  return out;
}

/** 후보 하나를 내려받아 정규화(1920x1080·무음·clipSeconds)해 풀에 저장. 반환 {file, credit} | null */
async function downloadCandidate(r, presetId, cfg, log) {
  const dir = poolDir(presetId);
  const base = `${Date.now()}_${String(r.id).replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  const raw = path.join(dir, base + '.download');
  const out = path.join(dir, base + '.mp4');
  try {
    await download(r.url, raw);
    const seconds = Math.max(4, Math.min(60, Number(cfg?.videos?.clipSeconds) || 12));
    const dur = await normalizeClip(raw, out, { seconds, cfg: { ...cfg.render, fps: Number(cfg?.videos?.fps) || 24 } });
    const { query, ...rest } = r;
    const credit = { ...rest, downloaded: new Date().toISOString(), clipSeconds: Math.round(dur * 10) / 10, query };
    fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(credit, null, 2), 'utf8');
    log?.(`배경 영상 확보: "${credit.title}" by ${credit.creator || '?'} · ${credit.license} · ${credit.source} (${r.width}x${r.height}, ${Math.round(dur)}초로 저장)`);
    return { file: out, credit };
  } catch (e) {
    log?.(`영상 후보 건너뜀 "${(r.title || r.id).slice(0, 40)}" (${e.message.split('\n')[0]})`, 'warn');
    try { fs.unlinkSync(out); } catch {}
    return null;
  } finally { try { fs.unlinkSync(raw); } catch {} }
}

function poolCandidates(presetId) {
  return listVideoPool(presetId).map((p, i) => {
    const c = p.credit || {};
    return { id: c.id || `vpool${i}`, title: c.title || path.basename(p.file), desc: [c.desc, c.query ? `(found with: ${c.query})` : ''].filter(Boolean).join(' '), source: 'pool', file: p.file, credit: p.credit, license: c.license, kind: 'video' };
  });
}
function heuristicOrder(poolCands, fresh, queries) {
  const words = new Set((queries || []).join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const hit = (c) => { const t = `${c.title} ${c.desc} ${c.credit?.query || ''}`.toLowerCase(); return [...words].some(w => t.includes(w)); };
  return [...poolCands.filter(hit).sort(() => Math.random() - 0.5), ...fresh, ...poolCands.filter(c => !hit(c)).sort(() => Math.random() - 0.5)];
}

/**
 * 배경 영상 클립을 모은다. 사진의 collectBackgrounds 와 같은 규칙: 풀 + 새 검색, rank(LLM)가 있으면 분위기 순, 새 클립은 maxFetch 개까지.
 * 반환: [{file, credit, fresh}]
 */
export async function collectVideos({ presetId, queries, cfg, log, count = 4, maxFetch = 2, allowFetch = true, plan = null, rank = null, freshOnly = false }) {
  const poolCands = freshOnly ? [] : poolCandidates(presetId);
  if (!allowFetch || !videoKeyReady(cfg)) {
    if (allowFetch) log?.(`영상 소스(${cfg?.videos?.provider || 'pexels'}) API 키가 없어 저장된 영상 풀만 씁니다 ([배경] 설정에서 키 입력)`, 'warn');
    return poolCands.sort(() => Math.random() - 0.5).slice(0, count).map(c => ({ file: c.file, credit: c.credit, fresh: false }));
  }
  const qs = plan?.queries?.length ? plan.queries : queries;
  let fresh = [];
  try { fresh = await gatherCandidates({ presetId, queries: qs, cfg, log, avoid: plan?.avoid || [] }); }
  catch (e) { log?.(`배경 영상 검색 실패: ${e.message}`, 'warn'); }
  let order = null;
  const all = [...poolCands, ...fresh];
  if (rank && all.length) {
    try {
      const ids = await rank({ candidates: all.map(c => ({ id: String(c.id), title: c.title, desc: (c.desc || '').slice(0, 200), pool: c.source === 'pool' })), count: count + 2 });
      const byId = new Map(all.map(c => [String(c.id), c]));
      order = ids.map(id => byId.get(String(id))).filter(Boolean);
      if (order.length) log?.(`영상 분위기 적합 순 선별(LLM): ${order.slice(0, count).map(c => `"${(c.title || c.id).slice(0, 30)}"${c.source === 'pool' ? '(풀)' : ''}`).join(', ')}`);
      else order = null;
    } catch (e) { log?.(`영상 LLM 선별 실패(${e.message.split('\n')[0]}) → 휴리스틱으로 고릅니다`, 'warn'); }
  }
  if (!order) order = heuristicOrder(poolCands, fresh, qs);
  const picked = []; let fetched = 0; const usedFiles = new Set();
  for (const c of order) {
    if (picked.length >= count) break;
    if (c.source === 'pool') { if (!usedFiles.has(c.file)) { usedFiles.add(c.file); picked.push({ file: c.file, credit: c.credit, fresh: false }); } }
    else if (fetched < maxFetch) { fetched++; const r = await downloadCandidate(c, presetId, cfg, log); if (r) picked.push({ ...r, fresh: true }); }
  }
  if (picked.length < count) for (const c of poolCands.sort(() => Math.random() - 0.5)) { if (picked.length >= count) break; if (!usedFiles.has(c.file)) { usedFiles.add(c.file); picked.push({ file: c.file, credit: c.credit, fresh: false }); } }
  return picked;
}

/** 클립 길이(초). 풀 json 의 clipSeconds 가 없으면 ffprobe */
export async function clipDuration(item) {
  if (item.credit?.clipSeconds) return Number(item.credit.clipSeconds);
  try { return (await probe(item.file)).duration; } catch { return 0; }
}
