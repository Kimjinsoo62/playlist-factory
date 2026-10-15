// 무료 배경 사진 자동 수집: Openverse(키 불필요, CC0/퍼블릭도메인만) 또는 Pexels(키 필요)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { DIRS } from './paths.js';

const UA = 'playlist-factory/0.1 (https://github.com; local app)';
const PEOPLE = /\b(person|people|man|woman|men|women|girl|boy|guy|lady|portrait|face|child|children|kid|kids|baby|crowd|selfie|model|wedding|bride|player|players|playing|athlete|athletes|musician|musicians|band|concert|dancers?|boxers?|audience|team|students?|businesswoman|businessman|couple|family|soldiers?)\b/i;

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
      title: (r.title || '').replace(/<[^>]+>/g, '').trim(), creator: r.creator || '', license: (r.license || '').toUpperCase(),
      source: r.source || '', page: r.foreign_landing_url || '', provider: 'openverse',
      width: r.width, height: r.height,
    }));
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
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1920', iiextmetadatafilter: 'LicenseShortName|Artist|ObjectName|Categories',
  });
  const d = await fetchJson(`https://commons.wikimedia.org/w/api.php?${q}`, {}, 25000);
  const pages = Object.values(d.query?.pages || {});
  return pages.map(p => {
    const ii = (p.imageinfo || [])[0] || {}; const md = ii.extmetadata || {};
    const lic = (md.LicenseShortName?.value || '').trim();
    const title = String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, '');
    const artist = (md.Artist?.value || '').replace(/<[^>]+>/g, '').trim();
    const cats = md.Categories?.value || '';
    return { id: `cm${p.pageid}`, url: ii.thumburl || ii.url, title, creator: artist, license: lic, source: 'wikimedia commons', page: ii.descriptionurl || '', provider: 'commons', width: ii.width || 0, height: ii.height || 0, cats };
  }).filter(r => r.url && r.width >= 1600 && r.height >= 900 && r.width > r.height)
    .filter(r => /^(CC0|Public domain|CC BY( \d\.\d)?( [A-Za-z]{2})?)$/i.test(r.license) || /^CC BY \d/i.test(r.license) && !/SA|NC|ND/i.test(r.license))
    .filter(r => !PEOPLE.test(`${r.title} ${r.cats}`))
    .filter(r => !/\.(svg|gif|tif|tiff)$/i.test(r.url))
    .filter(r => !/(map|diagram|logo|scan|document|manuscript|painting|drawing|portrait|museum|HAER|HABS|DPLA|archive|festival|school|church|cathedral|building|house|station|monument|statue|exhibition|panorama|poster|cover|flag|coat of arms|satellite|wildfire|NASA|SVS|HLS|composite|performance|performing|hiking|hiker|sitting|standing|walking)/i.test(`${r.title} ${r.cats}`))
    .filter(r => !/^(DSC|IMG|P\d{6}|\d{8}_)/i.test(r.title))
    .filter(r => r.width / r.height >= 1.3 && r.width / r.height <= 2.2);
}

export async function searchPexels(query, apiKey, { count = 15 } = {}) {
  const q = new URLSearchParams({ query, orientation: 'landscape', size: 'large', per_page: String(count) });
  const d = await fetchJson(`https://api.pexels.com/v1/search?${q}`, { Authorization: apiKey });
  return (d.photos || []).map(p => ({
    id: String(p.id), url: p.src?.large2x || p.src?.original, title: p.alt || '', creator: p.photographer || '',
    license: 'Pexels License', source: 'pexels', page: p.url, provider: 'pexels', width: p.width, height: p.height,
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

/**
 * 프리셋에 맞는 배경 사진을 구한다. 새로 받아보고, 실패하면 저장된 풀에서 고른다.
 * 반환: {file, credit, fresh} | null
 */
export async function findBackground({ presetId, queries, cfg, log, preferPool = false }) {
  const pool = listPool(presetId);
  if (preferPool && pool.length) { const c = pick(pool); return { ...c, fresh: false }; }
  const provider = cfg?.images?.provider || 'commons';
  const query = pick(queries && queries.length ? queries : ['abstract background']);
  try {
    log?.(`배경 사진 검색: "${query}" (${provider})`);
    let results = [];
    if (provider === 'pexels' && cfg?.images?.pexelsKey) results = await searchPexels(query, cfg.images.pexelsKey);
    else if (provider === 'openverse') {
      // Openverse(스톡 사진, 느리고 불안정)와 Wikimedia Commons(빠름)를 동시에 검색해 합친다
      const [ov, cm] = await Promise.allSettled([
        searchOpenverse(query).then(rs => rs.filter(r => !/rawpixel/i.test(r.source))),   // rawpixel 은 다운로드 URL 만료(410)
        searchCommons(query),
      ]);
      if (ov.status === 'rejected') log?.(`Openverse 응답 없음(${ov.reason?.message?.split('\n')[0]}) → Commons 결과만 사용`, 'warn');
      results = [...(ov.value || []), ...(cm.value || [])];
    } else {
      results = await searchCommons(query);
    }
    // 스톡형 소스·CC0 를 앞으로
    results.sort((a, b) => score(b) - score(a));
    if (results.length) log?.(`후보 ${results.length}장 (최고 점수 ${score(results[0])}: ${results[0].title.slice(0, 40)} / ${results[0].source})`);
    const used = new Set(pool.map(p => p.credit?.id));
    const rejected = loadRejected();
    results = results.filter(r => !used.has(r.id) && !rejected.has(r.id));
    if (!results.length) throw new Error('적합한 결과 없음');
    const tries = results.slice(0, 8).sort(() => Math.random() - 0.5).slice(0, 4);
    for (const r of tries) {
      const dir = poolDir(presetId);
      const base = `${Date.now()}_${r.id.slice(0, 8)}`;
      const raw = path.join(dir, base + '.download');
      const out = path.join(dir, base + '.jpg');
      try {
        await download(r.url, raw);
        const size = await normalizeImage(raw, out);
        const credit = { ...r, downloaded: new Date().toISOString(), original: size, query };
        fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify(credit, null, 2), 'utf8');
        log?.(`배경 사진 확보: "${credit.title || r.id}" by ${credit.creator || '?'} · ${credit.license} · ${credit.source} (${size.width}x${size.height})`);
        return { file: out, credit, fresh: true };
      } catch (e) {
        log?.(`사진 후보 건너뜀 (${e.message.split('\n')[0]})`, 'warn');
      } finally { try { fs.unlinkSync(raw); } catch {} }
    }
    throw new Error('후보 4개 모두 실패');
  } catch (e) {
    log?.(`배경 사진 검색 실패: ${e.message}`, 'warn');
    if (pool.length) { const c = pick(pool); log?.(`저장된 배경 사진 사용: ${path.basename(c.file)}`); return { ...c, fresh: false }; }
    return null;
  }
}

export function creditLine(credit) {
  if (!credit) return '';
  const who = credit.creator ? ` by ${credit.creator}` : '';
  const lic = credit.license ? ` (${credit.license})` : '';
  return `Background photo: ${credit.title || 'untitled'}${who}${lic} via ${credit.source || credit.provider}${credit.page ? ' ' + credit.page : ''}`;
}
