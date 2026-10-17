// 유튜브 업로드: Google OAuth(데스크톱 앱 클라이언트, localhost 리디렉션) → YouTube Data API v3 재개 가능 업로드 → 썸네일
//  - 토큰은 config.json 의 youtube.oauth 에만 저장(git 제외). API 응답에는 connected 여부만 나간다(maskConfig).
//  - 업로드 1건 = 할당량 1,600 (기본 10,000/일 → 약 6건). 썸네일 설정은 전화 인증된 채널만 가능하므로 실패해도 경고만 남긴다.
//  - 진행 상황은 job.youtube {status, pct, videoId, url, error} 로 job.json 에 기록하고 'job' 이벤트로 화면에 보낸다.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { loadConfig, saveConfig } from './config.js';
import { log, persist, emit, summarize } from './jobs.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
const CHUNK = 8 * 1024 * 1024;              // 재개 가능 업로드 청크(256KB 배수)
const PRIVACY = ['private', 'unlisted', 'public'];
const pendingStates = new Map();            // OAuth state → 생성 시각
const uploading = new Set();                // 업로드 중인 jobId
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function redirectUri(port) { return `http://localhost:${port}/api/youtube/oauth/callback`; }

/** 화면용 상태(비밀·토큰 제외) */
export function status(cfg = loadConfig()) {
  const y = cfg.youtube || {};
  return {
    configured: Boolean(y.clientId && y.clientSecret), connected: Boolean(y.oauth?.refresh_token),
    clientId: y.clientId || '', channelTitle: y.channelTitle || '', channelId: y.channelId || '', connectedAt: y.connectedAt || '',
    autoUpload: Boolean(y.autoUpload), defaultPrivacy: PRIVACY.includes(y.defaultPrivacy) ? y.defaultPrivacy : 'private',
    uploadThumbnail: y.uploadThumbnail !== false, syntheticMedia: y.syntheticMedia !== false,
    redirectUri: redirectUri(cfg.port), uploading: [...uploading],
  };
}

/** Google 동의 화면 URL. 데스크톱 앱 클라이언트는 http://localhost:포트 리디렉션을 등록 없이 허용한다. */
export function authUrl(cfg = loadConfig()) {
  const y = cfg.youtube || {};
  if (!y.clientId || !y.clientSecret) throw new Error('먼저 Google OAuth 클라이언트 ID와 클라이언트 비밀을 저장하세요.');
  for (const [s, t] of pendingStates) if (Date.now() - t > 15 * 60_000) pendingStates.delete(s);
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  const q = new URLSearchParams({ client_id: y.clientId, redirect_uri: redirectUri(cfg.port), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${j.error || 'HTTP ' + r.status}${j.error_description ? ': ' + j.error_description : ''}`), { code: j.error, status: r.status });
  return j;
}

/** OAuth 콜백: code → refresh_token 저장, 채널명 조회 */
export async function handleCallback({ code, state, error } = {}) {
  if (error) throw new Error(`Google 인증이 거부되었습니다: ${error}`);
  if (!code) throw new Error('인증 코드가 없습니다.');
  if (!state || !pendingStates.has(state)) throw new Error('인증 요청이 만료되었거나 맞지 않습니다. 앱에서 [Google 계정 연결]을 다시 누르세요.');
  pendingStates.delete(state);
  const cfg = loadConfig(); const y = cfg.youtube || {};
  const t = await tokenRequest({ code, client_id: y.clientId, client_secret: y.clientSecret, redirect_uri: redirectUri(cfg.port), grant_type: 'authorization_code' });
  if (!t.refresh_token) throw new Error('refresh_token 을 받지 못했습니다. Google 계정 > 보안 > 서드파티 앱에서 이 앱의 액세스를 삭제한 뒤 다시 연결하세요.');
  const oauth = { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, scope: t.scope || SCOPES.join(' ') };
  let channelTitle = '', channelId = '';
  try {
    const ch = await apiJson('GET', 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', null, oauth.access_token);
    channelTitle = ch.items?.[0]?.snippet?.title || ''; channelId = ch.items?.[0]?.id || '';
  } catch (e) { channelTitle = `(채널 조회 실패: ${e.message.slice(0, 80)})`; }
  saveConfig({ youtube: { oauth, channelTitle, channelId, connectedAt: new Date().toISOString() } });
  return { channelTitle, channelId };
}

export function disconnect() { saveConfig({ youtube: { oauth: null, channelTitle: '', channelId: '', connectedAt: '' } }); }

/** 유효한 access_token (만료 1분 전이면 refresh) */
export async function accessToken(cfg = loadConfig()) {
  const y = cfg.youtube || {}; const o = y.oauth;
  if (!o?.refresh_token) throw Object.assign(new Error('Google 계정이 연결되어 있지 않습니다. 왼쪽 "유튜브 업로드"에서 [Google 계정 연결]을 누르세요.'), { code: 'NOT_CONNECTED' });
  if (o.access_token && (o.expires_at || 0) - Date.now() > 60_000) return o.access_token;
  let t;
  try { t = await tokenRequest({ refresh_token: o.refresh_token, client_id: y.clientId, client_secret: y.clientSecret, grant_type: 'refresh_token' }); }
  catch (e) {
    if (e.code === 'invalid_grant') throw Object.assign(new Error('Google 연결이 만료되었거나 취소되었습니다(OAuth 동의 화면이 "테스트" 상태면 7일마다 만료). [Google 계정 연결]을 다시 누르세요.'), { code: 'RECONNECT' });
    throw e;
  }
  const oauth = { ...o, access_token: t.access_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000 };
  saveConfig({ youtube: { oauth } });
  return oauth.access_token;
}

async function apiJson(method, url, body, token, headers = {}) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw apiError(r.status, j);
  return j;
}

const REASON_KO = {
  quotaExceeded: 'YouTube API 일일 할당량을 넘었습니다(기본 10,000, 업로드 1건 1,600). 태평양 시간 자정에 초기화됩니다.',
  uploadLimitExceeded: '이 채널의 업로드 한도를 넘었습니다. 잠시 후 다시 시도하세요.',
  forbidden: '권한이 없습니다. 연결한 Google 계정이 이 채널의 소유자인지, 동의 화면에서 업로드 권한을 허용했는지 확인하세요.',
  youtubeSignupRequired: '이 Google 계정에 YouTube 채널이 없습니다. 먼저 채널을 만드세요.',
  invalidTitle: '제목이 올바르지 않습니다(100자 이하, < > 사용 불가).',
  invalidDescription: '설명이 올바르지 않습니다(5,000자 이하, < > 사용 불가).',
  invalidTags: '태그가 올바르지 않습니다(전체 500자 이하).',
  invalidPublishAt: '예약 공개 시각이 올바르지 않습니다.',
  authError: '인증 오류입니다. [Google 계정 연결]을 다시 누르세요.',
  insufficientPermissions: '권한 범위가 부족합니다. 연결을 해제하고 다시 연결하세요.',
};
function apiError(status, j) {
  const reason = j?.error?.errors?.[0]?.reason || (status === 401 ? 'authError' : '');
  const msg = j?.error?.message || (typeof j === 'string' ? j.slice(0, 300) : JSON.stringify(j).slice(0, 300));
  return Object.assign(new Error(`${REASON_KO[reason] || msg}${reason ? ` (${reason})` : ''} [HTTP ${status}]`), { status, reason });
}

/** node:https 요청(큰 PUT 본문용). 전역 fetch 는 헤더 대기 제한이 있어 수십 MB 청크에 불안정하다. */
function httpsReq(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch { json = text; } resolve({ status: res.statusCode, headers: res.headers, json }); });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`응답 시간 초과(${Math.round(timeoutMs / 1000)}초)`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const clampTitle = (t) => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Playlist';
function clampTags(tags) {
  const out = []; let total = 0;
  for (const raw of Array.isArray(tags) ? tags : String(tags || '').split(',')) {
    const t = String(raw).replace(/[<>]/g, '').trim().slice(0, 60); if (!t || out.includes(t)) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;   // 공백 포함 태그는 따옴표 2자 추가
    if (total + cost > 480) break;
    out.push(t); total += cost;
  }
  return out;
}

/**
 * 업로드 옵션 검증(동기). 라우트가 400 으로 돌려줄 수 있도록 파일·상태 오류는 여기서 던진다.
 * @returns {{video, title, description, tags, privacy, publishAt, thumbnail, syntheticMedia}}
 */
export function prepare(job, { title, description, tags, privacy, publishAt, thumbnail = true, syntheticMedia = true } = {}) {
  if (job.status !== 'done') throw new Error('완료된 작업만 업로드할 수 있습니다.');
  if (uploading.has(job.id)) throw new Error('이 작업은 이미 업로드 중입니다.');
  const video = job.result?.video ? path.join(job.dir, job.result.video) : path.join(job.dir, 'playlist.mp4');
  if (!fs.existsSync(video)) throw new Error('업로드할 playlist.mp4 가 없습니다. output 폴더를 확인하세요.');
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(job.dir, 'youtube.json'), 'utf8')); } catch {}
  const p = {
    video, title: clampTitle(title || meta.title || job.result?.title),
    description: String(description ?? meta.description ?? '').replace(/[<>]/g, '').slice(0, 5000),
    tags: clampTags(tags ?? meta.tags ?? []),
    privacy: PRIVACY.includes(privacy) ? privacy : 'private', publishAt: null,
    thumbnail: Boolean(thumbnail), syntheticMedia: Boolean(syntheticMedia),
  };
  if (publishAt) {
    const d = new Date(publishAt);
    if (Number.isNaN(d.getTime())) throw new Error('예약 공개 시각 형식이 올바르지 않습니다.');
    if (d.getTime() < Date.now() + 60_000) throw new Error('예약 공개 시각은 현재보다 뒤여야 합니다.');
    p.publishAt = d.toISOString(); p.privacy = 'private';   // 예약 공개는 비공개로 올리고 그 시각에 공개된다
  }
  return p;
}

/** 실제 업로드(비동기). prepare() 결과를 받는다. 실패해도 작업 상태(done)는 바꾸지 않고 job.youtube 에만 기록한다. */
export async function upload(job, p, cfg = loadConfig()) {
  uploading.add(job.id);
  const set = (patch) => { job.youtube = { ...(job.youtube || {}), ...patch, updatedAt: Date.now() }; persist(job); emit(job, 'job', summarize(job)); };
  try {
    set({ status: 'uploading', pct: 0, error: null, title: p.title, privacy: p.privacy, publishAt: p.publishAt, videoId: null, url: null });
    log(job, `── 유튜브 업로드 시작: "${p.title}" · ${p.privacy}${p.publishAt ? ` · 예약 공개 ${p.publishAt}` : ''}`);
    const token = await accessToken(cfg);
    const size = fs.statSync(p.video).size;
    const lang = ['ko', 'en', 'ja'].includes(job.request?.language) ? job.request.language : 'ko';
    const body = {
      snippet: { title: p.title, description: p.description, tags: p.tags, categoryId: '10', defaultLanguage: lang, defaultAudioLanguage: lang },
      status: { privacyStatus: p.privacy, selfDeclaredMadeForKids: false, containsSyntheticMedia: p.syntheticMedia, ...(p.publishAt ? { publishAt: p.publishAt } : {}) },
    };
    // 1) 재개 가능 업로드 세션
    const metaBuf = Buffer.from(JSON.stringify(body));
    const init = await httpsReq('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': String(metaBuf.length), 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' }, body: metaBuf,
    });
    if (init.status !== 200 || !init.headers.location) throw apiError(init.status, init.json);
    const session = init.headers.location;
    log(job, `업로드 세션 시작 (${(size / 1048576).toFixed(1)} MB)`);
    // 2) 청크 전송 (308 = 계속, 200/201 = 완료)
    const fd = fs.openSync(p.video, 'r');
    let offset = 0, result = null, retries = 0, lastLogged = 0;
    try {
      while (offset < size) {
        const len = Math.min(CHUNK, size - offset);
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, offset);
        const r = await httpsReq(session, { method: 'PUT', headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${offset}-${offset + len - 1}/${size}` }, body: buf });
        if (r.status === 308) {
          const m = /bytes=0-(\d+)/.exec(r.headers.range || ''); offset = m ? Number(m[1]) + 1 : offset; retries = 0;   // Range 없는 308 = 저장된 바이트 없음 → 같은 청크 재전송
        } else if (r.status === 200 || r.status === 201) {
          result = r.json; offset = size;
        } else if ((r.status >= 500 || r.status === 429) && retries < 5) {
          retries++; await sleep(2000 * retries);
          const q = await httpsReq(session, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });   // 서버가 받은 범위 확인 후 재개
          if (q.status === 200 || q.status === 201) { result = q.json; offset = size; }
          else { const m = /bytes=0-(\d+)/.exec(q.headers.range || ''); offset = m ? Number(m[1]) + 1 : offset; log(job, `전송 오류(HTTP ${r.status}) → ${(offset / 1048576).toFixed(1)} MB 부터 재개 (${retries}/5)`, 'warn'); }
        } else throw apiError(r.status, r.json);
        const pct = Math.min(100, Math.round(offset / size * 100));
        set({ pct });
        if (pct - lastLogged >= 25 || pct === 100) { lastLogged = pct; log(job, `업로드 ${pct}% (${(offset / 1048576).toFixed(1)} / ${(size / 1048576).toFixed(1)} MB)`); }
      }
    } finally { fs.closeSync(fd); }
    const videoId = result?.id;
    if (!videoId) throw new Error('업로드 응답에 영상 id 가 없습니다: ' + JSON.stringify(result).slice(0, 200));
    const url = `https://youtu.be/${videoId}`;
    set({ status: 'done', pct: 100, videoId, url, uploadedAt: new Date().toISOString() });
    log(job, `유튜브 업로드 완료: ${url} (${p.privacy === 'public' ? '공개' : p.privacy === 'unlisted' ? '일부 공개' : '비공개'}${p.publishAt ? `, ${p.publishAt} 에 공개 예약` : ''})`);
    // 3) 썸네일 (전화 인증 채널만 가능 → 실패는 경고)
    const thumb = job.result?.thumbnail ? path.join(job.dir, job.result.thumbnail) : null;
    if (p.thumbnail && thumb && fs.existsSync(thumb)) {
      try {
        const img = fs.readFileSync(thumb);
        const r = await httpsReq(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`, { method: 'POST', headers: { Authorization: `Bearer ${await accessToken(cfg)}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(img.length) }, body: img });
        if (r.status !== 200) throw apiError(r.status, r.json);
        log(job, '썸네일 설정 완료'); set({ thumbnailSet: true });
      } catch (e) { log(job, `썸네일 설정 실패(영상은 정상 업로드됨, 채널 전화 인증 필요할 수 있음): ${e.message}`, 'warn'); set({ thumbnailSet: false, thumbnailError: e.message }); }
    }
    return job.youtube;
  } catch (e) {
    log(job, `유튜브 업로드 실패: ${e.message}`, 'error');
    set({ status: 'failed', error: e.message });
    throw e;
  } finally { uploading.delete(job.id); }
}

/** 콜백 응답 페이지 */
export function callbackPage(ok, title, detail) {
  const esc = (s) => String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>플레이리스트 팩토리 - ${esc(title)}</title>
<style>body{font:10pt 'Malgun Gothic',sans-serif;background:#15171c;color:#e4e6ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{border:1px solid #2f343d;border-radius:6px;padding:18px 24px;max-width:520px;background:#1d2026}h1{font-size:12pt;margin:0 0 8px;color:${ok ? '#38c7a0' : '#d9363e'}}</style></head>
<body><div class="box"><h1>${esc(title)}</h1><p>${esc(detail)}</p><p style="color:#8b919c">이 창을 닫고 앱으로 돌아가세요.</p></div><script>setTimeout(()=>{try{window.close()}catch(e){}},${ok ? 4000 : 60000})</script></body></html>`;
}
