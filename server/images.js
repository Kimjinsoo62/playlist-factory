// 무료 배경 사진 자동 수집: Wikimedia Commons(키 불필요) / Openverse(키 불필요) / Pexels(키 필요)
// 라이선스 정책: 상업적 이용(유튜브 수익화 포함)이 허용되는 사진만 쓴다.
//   허용 = CC0 · 퍼블릭 도메인 · CC BY(출처 표기 필요, 영상 설명에 자동 기재) · Pexels License
//   제외 = NC(비영리) · ND(변경 금지) · SA(동일조건, 영상 전체에 전파될 수 있어 제외) · 사용 제한(상표·초상권 등)이 붙은 파일
// 분위기 적합성: 작업마다 LLM이 곡 제목·가사·스타일로 검색어를 짜고(plan), 후보(저장 풀 + 새 검색)를 분위기 기준으로 고른다(rank).
//   LLM 키가 없으면 프리셋 검색어 + 휴리스틱 점수로 동작한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DIRS } from './paths.js';

const UA = 'playlist-factory/0.1 (https://github.com; local app)';
const PEOPLE = /\b(person|people|man|woman|men|women|girl|boy|guy|lady|portrait|face|child|children|kid|kids|baby|crowd|selfie|model|wedding|bride|player|players|playing|athlete|athletes|musician|musicians|band|concert|dancers?|boxers?|audience|team|students?|businesswoman|businessman|couple|family|soldiers?)\b/i;
const JUNK = /(map|diagram|logo|scan|document|manuscript|painting|drawing|portrait|museum|HAER|HABS|DPLA|archive|festival|school|church|cathedral|building|house|station|monument|statue|exhibition|panorama|poster|cover|flag|coat of arms|satellite|wildfire|NASA|SVS|HLS|composite|performance|performing|hiking|hiker|sitting|standing|walking)/i;

/** 상업적 이용이 허용되는 라이선스인지 (SA·NC·ND 및 사용 제한 있는 파일은 제외) */
export function isCommercialOk(r) {
  const lic = String(r.license || '').trim();
  if (!lic) return false;
  if (/\b(NC|ND|SA)\b/i.test(lic)) return false;
  if (r.restrictions && String(r.restrictions).trim()) return false;
  if (/^pexels license$/i.test(lic)) return true;
  if (/^(CC0|CC0 1\.0|Public domain|PD|PDM|Public Domain Mark( 1\.0)?)$/i.test(lic)) return true;
  if (/^CC BY( \d\.\d)?( [A-Za-z]{2}(-[A-Za-z]{2})?)?$/i.test(lic)) return true;   // CC BY, CC BY 2.0, CC BY 4.0 DE ...
  return false;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function score(r) {
  let s = 0;
  if (/CC0|Public domain|Pexels/i.test(r.license)) s += 2;
  if (/stocksnap|pexels|pxhere|unsplash|polyhaven|poly haven/i.test(`${r.source} ${r.cats || ''} ${r.creator || ''} ${r.title || ''}`)) s += 4;   // 스톡 사진 소스
  if (/flickr/i.test(`${r.source} ${r.cats || ''}`)) s += 2;
  if (/(long exposure|bokeh|night|rain|sunset|sunrise|skyline|forest|desk|guitar|lamp|window|road|highway|neon|lights|coffee|vinyl|sky|clouds|ocean|sea|lake|mountain)/i.test(r.title)) s += 1;
  if (/\(\d{6,}\)|\d{4}-\d{2}-\d{2}|\b(19|20)\d\d\b/.test(r.title)) s -= 1;   // 아카이브·날짜형 제목
  return s;
}

async function fetchJson(url, headers = {}, timeoutMs = 45000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ac.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/** Wikimedia 원본(수십 MB)을 1920px 썸네일 URL로 바꿈 */
function wikimediaThumb(url, width = 1920) {
  const m = url.match(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/i);
  if (!m) return url;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${m[1]}/${m[2]}/${m[3]}/${width}px-${m[3]}`;
}

export async function searchOpenverse(query, { count = 20 } = {}) {
  const q = new URLSearchParams({ q: query, license: 'cc0,pdm', license_type: 'commercial', size: 'large', aspect_ratio: 'wide', page_size: String(count), mature: 'false' });
  const d = await fetchJson(`https://api.openverse.org/v1/images/?${q}`, {}, 35000);
  return (d.results || [])
    .filter(r => (r.width || 0) >= 1600 && (r.height || 0) >= 900 && (r.width || 0) > (r.height || 0))
    .filter(r => !PEOPLE.test(`${r.title || ''} ${(r.tags || []).map(t => t.name).join(' ')}`))
    .filter(r => !/video|svg|\.gif$/i.test(`${r.category || ''} ${r.url || ''}`))
    .map(r => ({
      id: r.id, url: /upload\.wikimedia\.org/.test(r.url) ? wikimediaThumb(r.url) : r.url,
      title: (r.title || '').replace(/<[^>]+>/g, '').trim(), creator: r.creator || '', license: (r.license || '').toUpperCase() === 'PDM' ? 'Public domain' : (r.license || '').toUpperCase(),
      licenseUrl: r.license_url || '', desc: (r.tags || []).map(t => t.name).slice(0, 12).join(', '),
      source: r.source || '', page: r.foreign_landing_url || '', provider: 'openverse',
      width: r.width, height: r.height,
    }))
    .filter(isCommercialOk);
}

/** Wikimedia Commons 검색(키 불필요, 1~3초). CC0·퍼블릭도메인·CC BY 만 사용(BY-SA 는 동일조건 의무가 있어 제외). */
export async function searchCommons(query, { count = 40 } = {}) {
  // 1차: Unsplash 에서 가져온 스톡 사진(CC0) 카테고리 안에서 검색. 2차: 전체 검색.
  const first = await commonsQuery(`incategory:"Images from Unsplash" ${query}`, count);
  if (first.length >= 3) return first;
  const words = query.split(/\s+/);
  const loose = words.length > 2 ? await commonsQuery(`incategory:"Images from Unsplash" ${words.slice(0, 2).join(' ')}`, count) : [];
  if (first.length + loose.length >= 3) return [...first, ...loose];
  const general = await commonsQuery(`filetype:bitmap ${query}`, count);
  return [...first, ...loose, ...general];
}

async function commonsQuery(gsrsearch, count) {
  const q = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch, gsrnamespace: '6', gsrlimit: String(count),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1920',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ObjectName|Categories|ImageDescription|Restrictions|Copyrighted|UsageTerms',
  });
  const d = await fetchJson(`https://commons.wikimedia.org/w/api.php?${q}`, {}, 25000);
  const pages = Object.values(d.query?.pages || {});
  return pages.map(p => {
    const ii = (p.imageinfo || [])[0] || {}; const md = ii.extmetadata || {};
    const lic = (md.LicenseShortName?.value || '').trim();
    const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
    const artist = (md.Artist?.value || '').replace(/<[^>]+>/g, '').trim();
    const cats = md.Categories?.value || '';
    const desc = (md.ImageDescription?.value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    return {
      id: `cm${p.pageid}`, url: ii.thumburl || ii.url, title, creator: artist, license: lic, licenseUrl: md.LicenseUrl?.value || '',
      restrictions: (md.Restrictions?.value || '').trim(), usageTerms: (md.UsageTerms?.value || '').replace(/<[^>]+>/g, '').trim().slice(0, 120),
      desc, source: 'wikimedia commons', page: ii.descriptionurl || '', provider: 'commons', width: ii.width || 0, height: ii.height || 0, cats,
    };
  }).filter(r => r.url && r.width >= 1600 && r.height >= 900 && r.width > r.height)
    .filter(isCommercialOk)
    .filter(r => !PEOPLE.test(`${r.title} ${r.cats}`))
    .filter(r => !/\.(svg|gif|tif|tiff)$/i.test(r.url))
    .filter(r => !JUNK.test(`${r.title} ${r.cats}`))
    .filter(r => !/^(DSC|IMG|P\d{6}|\d{8}_)/i.test(r.title))
    .filter(r => r.width / r.height >= 1.3 && r.width / r.height <= 2.2);
}

export async function searchPexels(query, apiKey, { count = 15 } = {}) {
  const q = new URLSearchParams({ query, orientation: 'landscape', size: 'large', per_page: String(count) });
  const d = await fetchJson(`https://api.pexels.com/v1/search?${q}`, { Authorization: apiKey });
  return (d.photos || []).map(p => ({
    id: String(p.id), url: p.src?.large2x || p.src?.original, title: p.alt || '', creator: p.photographer || '',
    license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', desc: p.alt || '', source: 'pexels', page: p.url, provider: 'pexels', width: p.width, height: p.height,
  }));
}

async function download(url, dest, timeoutMs = 90000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest));
  } finally { clearTimeout(t); }
}

/** 이미지 검증 + 1920x1080 JPG로 정규화 (Pillow). 반환: {width,height} 원본 크기 */
function normalizeImage(src, dest) {
  return new Promise((resolve, reject) => {
    const code = `
import sys, json
from PIL import Image
src, dest = sys.argv[1], sys.argv[2]
im = Image.open(src); im.load(); w, h = im.size
if w < 1280 or h < 720: print(json.dumps({'error': 'too small', 'width': w, 'height': h})); sys.exit(0)
im = im.convert('RGB'); s = max(1920 / w, 1080 / h)
im = im.resize((int(w * s) + 1, int(h * s) + 1), Image.LANCZOS)
x = (im.width - 1920) // 2; y = (im.height - 1080) // 2
im.crop((x, y, x + 1920, y + 1080)).save(dest, quality=92)
print(json.dumps({'width': w, 'height': h}))`;
    const p = spawn('python', ['-X', 'utf8', '-c', code, src, dest], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => {
      if (c !== 0) return reject(new Error(err.slice(-300) || `python exit ${c}`));
      try { const j = JSON.parse(out.trim()); j.error ? reject(new Error(`${j.error} ${j.width}x${j.height}`)) : resolve(j); } catch { reject(new Error('normalize parse ' + out)); }
    });
    p.on('error', reject);
  });
}

/** assets/backgrounds/_rejected.txt : 다시 받지 않을 사진 id 목록(한 줄에 하나, # 주석 가능) */
function loadRejected() {
  try { return new Set(fs.readFileSync(path.join(DIRS.assets, 'backgrounds', '_rejected.txt'), 'utf8').split(/\r?\n/).map(s => s.split('#')[0].trim()).filter(Boolean)); }
  catch { return new Set(); }
}
export function rejectBackground(presetId, file) {
  const d = poolDir(presetId); const base = path.basename(file, '.jpg');
  let id = null; try { id = JSON.parse(fs.readFileSync(path.join(d, base + '.json'), 'utf8')).id; } catch {}
  for (const ext of ['.jpg', '.json']) { try { fs.unlinkSync(path.join(d, base + ext)); } catch {} }
  if (id) fs.appendFileSync(path.join(DIRS.assets, 'backgrounds', '_rejected.txt'), `${id}  # ${presetId} ${new Date().toISOString().slice(0, 10)}\n`, 'utf8');
  return id;
}
function poolDir(presetId) { const d = path.join(DIRS.assets, 'backgrounds', presetId); fs.mkdirSync(d, { recursive: true }); return d; }
export function listPool(presetId) {
  const d = poolDir(presetId);
  return fs.readdirSync(d).filter(f => f.endsWith('.jpg')).map(f => {
    let credit = null; try { credit = JSON.parse(fs.readFileSync(path.join(d, f.replace(/\.jpg$/, '.json')), 'utf8')); } catch {}
    return { file: path.join(d, f), credit };
  });
}

/** 검색어 여러 개로 후보를 모은다(라이선스·인물·중복·거부 목록 필터 적용, 점수순). */
async function gatherCandidates({ presetId, queries, cfg, log, avoid = [], maxQueries = 3 }) {
  const provider = cfg?.images?.provider || 'commons';
  const qs = [...new Set((queries || []).map(q => String(q).trim()).filter(Boolean))];
  const useQs = qs.length > maxQueries ? qs.sort(() => Math.random() - 0.5).slice(0, maxQueries) : qs;
  if (!useQs.length) useQs.push('abstract background');
  log?.(`배경 사진 검색 (${provider}): ${useQs.map(q => `"${q}"`).join(', ')}`);
  const searchOne = async (query) => {
    let results = [];
    if (provider === 'pexels' && cfg?.images?.pexelsKey) results = await searchPexels(query, cfg.images.pexelsKey);
    else if (provider === 'openverse') {
      const [ov, cm] = await Promise.allSettled([
        searchOpenverse(query).then(rs => rs.filter(r => !/rawpixel/i.test(r.source))),   // rawpixel 은 다운로드 URL 만료(410)
        searchCommons(query),
      ]);
      if (ov.status === 'rejected') log?.(`Openverse 응답 없음(${ov.reason?.message?.split('\n')[0]}) → Commons 결과만 사용`, 'warn');
      results = [...(ov.value || []), ...(cm.value || [])];
    } else results = await searchCommons(query);
    return results.map(r => ({ ...r, query }));
  };
  const settled = await Promise.allSettled(useQs.map(searchOne));
  const used = new Set(listPool(presetId).map(p => p.credit?.id));
  const rejected = loadRejected();
  const avoidRe = avoid.length ? new RegExp(`\\b(${avoid.map(a => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i') : null;
  const seen = new Set(); const out = [];
  settled.forEach((s, i) => {
    if (s.status === 'rejected') { log?.(`"${useQs[i]}" 검색 실패: ${s.reason?.message?.split('\n')[0]}`, 'warn'); return; }
    for (const r of s.value) {
      if (seen.has(r.id) || used.has(r.id) || rejected.has(r.id)) continue;
      if (!isCommercialOk(r)) continue;
      if (avoidRe && avoidRe.test(`${r.title} ${r.desc || ''} ${r.cats || ''}`)) continue;
      seen.add(r.id); out.push(r);
    }
  });
  out.sort((a, b) => score(b) - score(a));
  log?.(`후보 ${out.length}장 (상업적 이용 가능 라이선스만)`);
  return out;
}

/** 후보 한 장을 내려받아 풀에 저장. 반환 {file, credit} | null */
async function downloadCandidate(r, presetId, log) {
  const dir = poolDir(presetId);
  const base = `${Date.now()}_${String(r.id).slice(0, 8)}`;
  const raw = path.join(dir, base + '.download');
  const out = path.join(dir, base + '.jpg');
  try {
    await download(r.url, raw);
    const size = await normalizeImage(raw, out);
    const { query, ...rest } = r;
    const credit = { ...rest, downloaded: new Date().toISOString(), original: size, query };
    fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(credit, null, 2), 'utf8');
    log?.(`배경 사진 확보: "${credit.title || r.id}" by ${credit.creator || '?'} · ${credit.license} · ${credit.source} (${size.width}x${size.height})`);
    return { file: out, credit };
  } catch (e) {
    log?.(`사진 후보 건너뜀 "${(r.title || r.id).slice(0, 40)}" (${e.message.split('\n')[0]})`, 'warn');
    return null;
  } finally { try { fs.unlinkSync(raw); } catch {} }
}

/** 풀 항목을 후보 형식으로 */
function poolCandidates(presetId) {
  return listPool(presetId).map((p, i) => {
    const c = p.credit || {};
    return { id: c.id || `pool${i}`, title: c.title || path.basename(p.file), desc: [c.desc, c.query ? `(found with: ${c.query})` : '', (c.cats || '').split('|').slice(0, 4).join(', ')].filter(Boolean).join(' '), source: 'pool', file: p.file, credit: p.credit, license: c.license };
  });
}

/** LLM 없이 고르는 순서: 이번 검색어와 맞는 풀 사진 → 새 후보(점수순) → 나머지 풀 */
function heuristicOrder(poolCands, fresh, queries) {
  const words = new Set((queries || []).join(' ').toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const hit = (c) => { const t = `${c.title} ${c.desc} ${c.credit?.query || ''}`.toLowerCase(); return [...words].some(w => t.includes(w)); };
  const poolHit = poolCands.filter(hit).sort(() => Math.random() - 0.5);
  const poolMiss = poolCands.filter(c => !hit(c)).sort(() => Math.random() - 0.5);
  return [...poolHit, ...fresh, ...poolMiss];
}

/**
 * 배경 사진 여러 장을 모은다. 후보 = 저장 풀 + 새 검색 결과. rank(LLM)가 있으면 분위기 기준으로 고르고, 없으면 휴리스틱.
 * 새 사진은 maxFetch 장까지만 내려받고, 모자라면 풀에서 채운다.
 * @param rank  async ({candidates:[{id,title,desc}], count}) => [id...]  (분위기 적합 순)
 * 반환: [{file, credit, fresh}]
 */
export async function collectBackgrounds({ presetId, queries, cfg, log, count = 8, maxFetch = 4, allowFetch = true, plan = null, rank = null, freshOnly = false }) {
  const poolCands = freshOnly ? [] : poolCandidates(presetId);
  if (!allowFetch) return poolCands.sort(() => Math.random() - 0.5).slice(0, count).map(c => ({ file: c.file, credit: c.credit, fresh: false }));
  const qs = plan?.queries?.length ? plan.queries : queries;
  let fresh = [];
  try { fresh = await gatherCandidates({ presetId, queries: qs, cfg, log, avoid: plan?.avoid || [] }); }
  catch (e) { log?.(`배경 사진 검색 실패: ${e.message}`, 'warn'); }
  let order = null;
  const all = [...poolCands, ...fresh];
  if (rank && all.length) {
    try {
      const ids = await rank({ candidates: all.map(c => ({ id: String(c.id), title: c.title, desc: (c.desc || c.cats || '').slice(0, 200), pool: c.source === 'pool' })), count: count + 4 });
      const byId = new Map(all.map(c => [String(c.id), c]));
      order = ids.map(id => byId.get(String(id))).filter(Boolean);
      if (order.length) log?.(`분위기 적합 순 선별(LLM): ${order.slice(0, count).map(c => `"${(c.title || c.id).slice(0, 30)}"${c.source === 'pool' ? '(풀)' : ''}`).join(', ')}`);
      else { log?.('LLM 선별 결과가 비어 휴리스틱으로 고릅니다', 'warn'); order = null; }
    } catch (e) { log?.(`LLM 선별 실패(${e.message.split('\n')[0]}) → 휴리스틱으로 고릅니다`, 'warn'); }
  }
  if (!order) order = heuristicOrder(poolCands, fresh, qs);
  const picked = []; let fetched = 0; const usedFiles = new Set();
  for (const c of order) {
    if (picked.length >= count) break;
    if (c.source === 'pool') { if (!usedFiles.has(c.file)) { usedFiles.add(c.file); picked.push({ file: c.file, credit: c.credit, fresh: false }); } }
    else if (fetched < maxFetch) { fetched++; const r = await downloadCandidate(c, presetId, log); if (r) picked.push({ ...r, fresh: true }); }
  }
  if (picked.length < count) for (const c of poolCands.sort(() => Math.random() - 0.5)) { if (picked.length >= count) break; if (!usedFiles.has(c.file)) { usedFiles.add(c.file); picked.push({ file: c.file, credit: c.credit, fresh: false }); } }
  return picked;
}

/**
 * 배경 사진 한 장. preferPool 이면 풀에서만, freshOnly 면 새로 받은 것만.
 * 반환: {file, credit, fresh} | null
 */
export async function findBackground({ presetId, queries, cfg, log, preferPool = false, plan = null, rank = null, freshOnly = false }) {
  const r = await collectBackgrounds({ presetId, queries, cfg, log, count: 1, maxFetch: 4, allowFetch: !preferPool, plan, rank, freshOnly });
  return r[0] || null;
}

export function creditLine(credit) {
  if (!credit) return '';
  const who = credit.creator ? ` by ${credit.creator}` : '';
  const lic = credit.license ? ` (${credit.license}${credit.licenseUrl ? ' ' + credit.licenseUrl : ''})` : '';
  return `Background ${credit.kind === 'video' ? 'video' : 'photo'}: ${credit.title || 'untitled'}${who}${lic} via ${credit.source || credit.provider}${credit.page ? ' ' + credit.page : ''}`;
}
