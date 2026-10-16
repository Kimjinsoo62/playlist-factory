// Google Lyria (Gemini API, Interactions) 어댑터. 연주곡 전용.
// 문서: https://ai.google.dev/gemini-api/docs/music-generation , https://ai.google.dev/api/interactions
// - POST /v1beta/interactions { model, input, background:true } → { id, status }
// - GET  /v1beta/interactions/{id} 로 status 가 completed/failed/... 될 때까지 폴링
// - 응답 steps[type=model_output].content[type=audio].data (base64) 를 파일로 저장
// - 가사 타이밍 데이터가 없으므로 보컬곡 자막을 만들 수 없다 → 파이프라인에서 연주곡일 때만 허용
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

export const LYRIA_MODELS = ['lyria-3.5', 'lyria-3-pro-preview'];
export const LYRIA_USD_PER_SONG = 0.08;          // 2026-10 기준 Gemini API 가격표 (lyria-3.5, lyria-3-pro-preview 모두 곡당 $0.08)
const DONE = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
const EXT = { 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/opus': 'opus', 'audio/webm': 'webm' };

export class LyriaProvider {
  constructor(cfg) {
    this.cfg = cfg || {};
    if (!this.cfg.apiKey) throw new Error('Lyria(Gemini) API 키가 설정되지 않았습니다. 설정에서 입력하세요.');
    this.base = (this.cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    this.model = LYRIA_MODELS.includes(this.cfg.model) ? this.cfg.model : 'lyria-3.5';
  }

  /** node:https 직접 호출. 전역 fetch 는 헤더 대기 5분 제한이 있어 동기 생성(수 분)에 끊길 수 있다. */
  http(method, url, body, { timeoutMs = 10 * 60_000, signal, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = https.request(url, {
        method,
        headers: { 'x-goog-api-key': this.cfg.apiKey, Accept: raw ? '*/*' : 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (raw && res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, data: buf, mime: res.headers['content-type'] || '' });
          const text = buf.toString('utf8');
          let json; try { json = JSON.parse(text); } catch { json = text; }
          resolve({ status: res.statusCode, data: json });
        });
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`응답 시간 초과(${Math.round(timeoutMs / 1000)}초)`)));
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) return req.destroy(new Error('취소됨'));
        signal.addEventListener('abort', () => req.destroy(new Error('취소됨')), { once: true });
      }
      if (data) req.write(data);
      req.end();
    });
  }

  static errMessage(data) {
    if (data && typeof data === 'object') return data.error?.message || (Array.isArray(data.errors) ? data.errors.map(e => e.message).join('; ') : '') || JSON.stringify(data).slice(0, 400);
    return String(data || '').slice(0, 400);
  }

  async request(method, url, body, { retries = 3, signal, timeoutMs } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const { status, data } = await this.http(method, url, body, { signal, timeoutMs });
        if (status === 429 || status >= 500) throw Object.assign(new Error(`HTTP ${status} ${LyriaProvider.errMessage(data)}`), { retryable: true, status });
        if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status} ${LyriaProvider.errMessage(data)}`), { status });
        return data;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted || !(e.retryable || e.code === 'ECONNRESET') || i === retries) throw e;
        await sleep(2000 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 키 유효성 확인(과금 없음): 모델 메타데이터 조회 */
  async check() {
    const m = await this.request('GET', `${this.base}/models/${this.model}`, null, { retries: 1, timeoutMs: 20_000 });
    return { model: m.name || this.model, displayName: m.displayName || m.display_name || '', description: m.description || '' };
  }

  /** 프리셋 스펙(Treblo 형식) → Lyria 자연어 프롬프트 */
  static buildPrompt(spec) {
    let p = String(spec.prompt || '').trim();
    if (!/instrumental/i.test(p)) p += ' Instrumental only, no vocals.';
    if (Array.isArray(spec.length_range) && spec.length_range.length === 2) {
      const [a, b] = spec.length_range.map(Number);
      if (a > 0 && b >= a) p += ` Target length about ${fmtMin(a)}–${fmtMin(b)} minutes, with a clear intro and ending.`;
    }
    if (Array.isArray(spec.negative_tags) && spec.negative_tags.length) p += ` Avoid: ${spec.negative_tags.join(', ')}.`;
    return p.replace(/\s+/g, ' ').trim();
  }

  /** 생성 요청. 반환: { id, interaction } (background 미지원이면 interaction 이 완료 결과) */
  async startGeneration(spec, { signal } = {}) {
    const input = LyriaProvider.buildPrompt(spec);
    const url = `${this.base}/interactions`;
    try {
      const data = await this.request('POST', url, { model: this.model, input, background: true }, { retries: 2, signal, timeoutMs: 60_000 });
      if (!data?.id) throw new Error(`응답에 id 없음: ${JSON.stringify(data).slice(0, 300)}`);
      return { id: data.id, interaction: data, prompt: input };
    } catch (e) {
      // 400 이면 background 미지원일 수 있으므로 동기 호출로 한 번 더 시도 (응답까지 수 분 걸릴 수 있음). 프롬프트 자체가 거부된 경우는 같은 오류로 다시 실패한다.
      if (e.status === 400) {
        this.onWarn?.(`background 요청 거부(${e.message.slice(0, 120)}) → 동기 생성으로 전환`);
        const data = await this.request('POST', url, { model: this.model, input }, { retries: 1, signal, timeoutMs: 15 * 60_000 });
        return { id: data?.id || null, interaction: { ...data, status: data?.status || 'completed' }, prompt: input };
      }
      throw e;
    }
  }

  async get(id, { signal } = {}) {
    return this.request('GET', `${this.base}/interactions/${encodeURIComponent(id)}`, null, { retries: 3, signal, timeoutMs: 30_000 });
  }

  async cancel(id) {
    try { await this.request('POST', `${this.base}/interactions/${encodeURIComponent(id)}/cancel`, {}, { retries: 0, timeoutMs: 15_000 }); } catch {}
  }

  /** 완료까지 대기. onStatus(status) 콜백. 반환: 완료된 interaction */
  async waitFor(started, { onStatus, shouldCancel, signal } = {}) {
    let it = started.interaction;
    const interval = this.cfg.pollIntervalMs || 5000;
    const t0 = Date.now();
    for (;;) {
      const st = String(it?.status || '').toLowerCase();
      onStatus?.(st || '-');
      if (DONE.has(st) || (!st && extractAudio(it))) break;
      if (!started.id) throw new Error(`상태를 알 수 없음: ${JSON.stringify(it).slice(0, 300)}`);
      if (shouldCancel?.()) { await this.cancel(started.id); throw new Error('취소됨'); }
      if (Date.now() - t0 > 20 * 60_000) { await this.cancel(started.id); throw new Error('생성 시간 초과(20분)'); }
      await sleep(interval);
      it = await this.get(started.id, { signal });
    }
    const st = String(it.status || 'completed').toLowerCase();
    if (st === 'failed' || st === 'cancelled') throw new Error(`생성 ${st === 'failed' ? '실패' : '취소됨'}: ${LyriaProvider.errMessage(it) || '원인 미상'}`);
    if (!extractAudio(it)) throw new Error(`오디오 블록 없음(status=${st}): ${LyriaProvider.errMessage(it)}`);
    return it;
  }

  /** 완료된 interaction 의 오디오를 파일로 저장(인라인 base64 또는 uri 참조). 반환: 실제 파일 경로(확장자는 mime 에 따름) */
  async saveAudio(interaction, destNoExt, { signal } = {}) {
    const a = extractAudio(interaction);
    if (!a) throw new Error('오디오 블록 없음');
    let bytes, mime = String(a.mime_type || '').toLowerCase();
    if (a.data) bytes = Buffer.from(a.data, 'base64');
    else {
      // 참조(uri)로 온 경우: 키 헤더로 받고, 거부되면 ?key= 로 한 번 더
      let r = await this.http('GET', a.uri, null, { signal, raw: true, timeoutMs: 5 * 60_000 });
      if (r.status === 401 || r.status === 403) r = await this.http('GET', a.uri + (a.uri.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(this.cfg.apiKey), null, { signal, raw: true, timeoutMs: 5 * 60_000 });
      if (r.status < 200 || r.status >= 300) throw new Error(`오디오 다운로드 실패 HTTP ${r.status} ${LyriaProvider.errMessage(r.data)}`);
      bytes = r.data; mime = mime || String(r.mime).split(';')[0].trim().toLowerCase();
    }
    const ext = EXT[mime] || 'mp3';
    const file = `${destNoExt}.${ext}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
}

/** steps[type=model_output].content[type=audio] 중 마지막 오디오 블록(인라인 data 또는 uri). 없으면 null */
export function extractAudio(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.output_audio?.data || it.output_audio?.uri) return it.output_audio;
  let found = null;
  for (const s of it.steps || []) {
    if (s?.type && s.type !== 'model_output') continue;
    for (const c of s?.content || []) if (c?.type === 'audio' && (c.data || c.uri)) found = c;
  }
  return found;
}

/** 텍스트 블록(가사·구조 설명) 모두 이어 붙임 */
export function extractText(it) {
  if (!it || typeof it !== 'object') return '';
  if (typeof it.output_text === 'string' && it.output_text) return it.output_text;
  const out = [];
  for (const s of it.steps || []) {
    if (s?.type && s.type !== 'model_output') continue;
    for (const c of s?.content || []) if (c?.type === 'text' && c.text) out.push(c.text);
  }
  return out.join('\n');
}

/** 저장용: base64 오디오를 뺀 사본 */
export function stripAudio(it) {
  const copy = JSON.parse(JSON.stringify(it || {}));
  for (const s of copy.steps || []) for (const c of s?.content || []) if (c?.type === 'audio' && c.data) { c.bytes = Buffer.byteLength(c.data, 'base64'); delete c.data; }
  if (copy.output_audio?.data) { copy.output_audio.bytes = Buffer.byteLength(copy.output_audio.data, 'base64'); delete copy.output_audio.data; }
  return copy;
}

function fmtMin(sec) { const m = sec / 60; return Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, ''); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
