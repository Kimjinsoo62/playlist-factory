// Mureka 공식 API 어댑터 (https://platform.mureka.ai/docs). 보컬·연주곡 모두, 줄·단어별 가사 타임스탬프 제공.
// - 보컬: POST /v1/lyrics/generate {prompt} → {title, lyrics}  →  POST /v1/song/generate {lyrics, model, prompt, n:1, gender}
// - 연주곡: POST /v1/instrumental/generate {model, prompt, n:1}
// - GET /v1/song/query/{id} · /v1/instrumental/query/{id} 로 status 가 succeeded/failed/timeouted/cancelled 될 때까지 폴링
// - choices[0]: url(mp3) · flac_url · wav_url · duration(ms) · lyrics_sections[].lines[]{start,end,text,words[]{start,end,text}} (모두 밀리초)
// - GET /v1/account/billing: balance(센트) · concurrent_request_limit. 요금은 모델별로 다르며 생성한 곡 수만큼 청구된다 (n 은 반드시 1)
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MUREKA_MODELS = ['auto', 'mureka-9.5', 'mureka-9', 'mureka-8', 'mureka-o2', 'mureka-7.6'];
export const MUREKA_INSTRUMENTAL_MODELS = ['auto', 'mureka-9.5', 'mureka-9', 'mureka-8', 'mureka-7.6'];   // 연주곡 API 는 o2 미지원
const DONE = new Set(['succeeded', 'failed', 'timeouted', 'cancelled']);
const PROMPT_MAX = 1024;      // song/instrumental generate 의 prompt 상한
const LYRICS_MAX = 5000;

export class MurekaProvider {
  constructor(cfg) {
    this.cfg = cfg || {};
    if (!this.cfg.apiKey) throw new Error('Mureka API 키가 설정되지 않았습니다. 설정에서 입력하세요.');
    this.base = (this.cfg.baseUrl || 'https://api.mureka.ai').replace(/\/$/, '');
    this.model = MUREKA_MODELS.includes(this.cfg.model) ? this.cfg.model : 'auto';
  }

  /** node:https 직접 호출 (전역 fetch 의 헤더 대기 제한을 피하고 취소 신호를 그대로 전달) */
  http(method, url, body, { timeoutMs = 60_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = (url.startsWith('http:') ? http : https).request(url, {   // baseUrl 을 로컬 테스트 서버(http)로 바꿀 수 있게
        method,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
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
    if (data && typeof data === 'object') return data.error?.message || data.message || data.failed_reason || JSON.stringify(data).slice(0, 400);
    return String(data || '').slice(0, 400);
  }

  async request(method, url, body, { retries = 3, signal, timeoutMs } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const { status, data } = await this.http(method, url, body, { signal, timeoutMs });
        if (status === 429 || status >= 500) throw Object.assign(new Error(`HTTP ${status} ${MurekaProvider.errMessage(data)}`), { retryable: true, status });
        if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status} ${MurekaProvider.errMessage(data)}`), { status });
        return data;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted || !(e.retryable || e.code === 'ECONNRESET') || i === retries) throw e;
        await sleep(2000 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 키 확인·잔액 (과금 없음). balance 는 센트 */
  async billing() {
    const b = await this.request('GET', `${this.base}/v1/account/billing`, null, { retries: 1, timeoutMs: 20_000 });
    return { balance: Number(b.balance) || 0, balanceUsd: (Number(b.balance) || 0) / 100, concurrentLimit: Number(b.concurrent_request_limit) || 0, totalSpending: Number(b.total_spending) || 0 };
  }

  /** 프리셋 스펙 → Mureka 스타일 프롬프트 ("r&b, slow, passionate, male vocal" 형식 + 설명). 1024자 상한 */
  static buildPrompt(spec, gender) {
    const parts = [];
    if (Array.isArray(spec.tags) && spec.tags.length) parts.push(spec.tags.join(', '));
    if (!spec.instrumental && gender) parts.push(`${gender} vocal`);
    let p = parts.join(', ');
    const desc = String(spec.prompt || '').replace(/\s+/g, ' ').trim();
    if (desc) p = p ? `${p}. ${desc}` : desc;
    if (Array.isArray(spec.negative_tags) && spec.negative_tags.length) p += ` Avoid: ${spec.negative_tags.join(', ')}.`;
    const cut = p.length > PROMPT_MAX;
    if (cut) p = p.slice(0, PROMPT_MAX - 1).replace(/\s+\S*$/, '') + '…';
    return { prompt: p, cut };
  }

  /** 보컬곡 가사: Mureka 의 가사 생성기로 만든다 (언어·주제 지시는 spec.prompt 에 이미 들어 있음) */
  async generateLyrics(spec, { signal } = {}) {
    const prompt = `Write the complete lyrics for one song, with section tags like [Verse], [Chorus], [Bridge]. Song theme: "${spec.title}". ${String(spec.prompt || '').replace(/\s+/g, ' ').trim()}`;
    const r = await this.request('POST', `${this.base}/v1/lyrics/generate`, { prompt }, { retries: 2, signal, timeoutMs: 120_000 });
    let lyrics = String(r?.lyrics || '').trim();
    if (!lyrics) throw new Error(`가사 생성 응답에 lyrics 없음: ${JSON.stringify(r).slice(0, 300)}`);
    if (lyrics.length > LYRICS_MAX) { this.onWarn?.(`가사가 ${lyrics.length}자라 ${LYRICS_MAX}자로 잘라 보냅니다`); lyrics = lyrics.slice(0, LYRICS_MAX); }
    return { lyrics, title: String(r?.title || '').trim() };
  }

  /** 생성 요청. 반환: { id, kind:'song'|'instrumental', prompt, lyrics } */
  async startGeneration(spec, { gender = '', signal } = {}) {
    const { prompt, cut } = MurekaProvider.buildPrompt(spec, gender);
    if (cut) this.onWarn?.(`#${spec.index} 프롬프트가 ${PROMPT_MAX}자를 넘어 잘라 보냅니다`);
    if (spec.instrumental) {
      const model = MUREKA_INSTRUMENTAL_MODELS.includes(this.model) ? this.model : 'auto';
      const data = await this.request('POST', `${this.base}/v1/instrumental/generate`, { model, prompt, n: 1 }, { retries: 2, signal });
      if (!data?.id) throw new Error(`응답에 id 없음: ${JSON.stringify(data).slice(0, 300)}`);
      return { id: String(data.id), kind: 'instrumental', model: data.model || model, prompt, lyrics: '' };
    }
    const { lyrics } = await this.generateLyrics(spec, { signal });
    const body = { lyrics, model: this.model, prompt, n: 1 };
    if (gender === 'male' || gender === 'female') body.gender = gender;
    const data = await this.request('POST', `${this.base}/v1/song/generate`, body, { retries: 2, signal });
    if (!data?.id) throw new Error(`응답에 id 없음: ${JSON.stringify(data).slice(0, 300)}`);
    return { id: String(data.id), kind: 'song', model: data.model || this.model, prompt, lyrics };
  }

  async query(started, { signal } = {}) {
    return this.request('GET', `${this.base}/v1/${started.kind}/query/${encodeURIComponent(started.id)}`, null, { retries: 3, signal, timeoutMs: 30_000 });
  }

  /** 완료까지 대기. onStatus(status) 콜백. 반환: choices[0] (곡 하나) */
  async waitFor(started, { onStatus, shouldCancel, signal } = {}) {
    const interval = this.cfg.pollIntervalMs || 5000;
    const t0 = Date.now();
    for (;;) {
      if (shouldCancel?.()) throw new Error('취소됨');
      const task = await this.query(started, { signal });
      const st = String(task?.status || '').toLowerCase();
      onStatus?.(st || '-');
      if (DONE.has(st)) {
        if (st !== 'succeeded') throw new Error(`생성 ${st === 'failed' ? '실패' : st === 'timeouted' ? '시간 초과' : '취소됨'}: ${task?.failed_reason || MurekaProvider.errMessage(task) || '원인 미상'}`);
        const choice = (task.choices || []).find(c => c?.url || c?.flac_url || c?.wav_url);
        if (!choice) throw new Error(`완료됐지만 choices 에 오디오 URL 없음: ${JSON.stringify(task).slice(0, 300)}`);
        return { choice, task };
      }
      if (Date.now() - t0 > 20 * 60_000) throw new Error('생성 시간 초과(20분)');
      await sleep(interval);
    }
  }

  /** choices[].url(mp3, 없으면 flac/wav) 을 파일로 저장. 반환: 실제 파일 경로 */
  async download(choice, destNoExt, { signal } = {}) {
    const url = choice.url || choice.flac_url || choice.wav_url;
    const ext = choice.url ? ((url.split('?')[0].match(/\.(mp3|m4a|ogg|wav|flac)$/i) || [, 'mp3'])[1]) : choice.flac_url ? 'flac' : 'wav';
    const file = `${destNoExt}.${ext}`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`오디오 다운로드 실패 HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    return file;
  }
}

/**
 * lyrics_sections → 자막용 타이밍 (초 단위).
 * 반환: { lines:[{text,start,end}], words:[{word,start,end}], lyrics:'[verse]\n...' } 또는 null
 */
export function extractTimings(choice) {
  const sections = choice?.lyrics_sections;
  if (!Array.isArray(sections) || !sections.length) return null;
  const lines = [], words = [], text = [];
  for (const sec of sections) {
    if (sec?.section_type) text.push(`[${sec.section_type}]`);
    for (const ln of sec?.lines || []) {
      const t = String(ln?.text || '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      text.push(t);
      const s = ms(ln.start), e = ms(ln.end);
      if (s != null && e != null && e >= s) lines.push({ text: t, start: s, end: e });
      for (const w of ln?.words || []) {
        const wt = String(w?.text || '').trim(); const ws = ms(w?.start), we = ms(w?.end);
        if (wt && ws != null && we != null) words.push({ word: wt, start: ws, end: we });
      }
    }
  }
  if (!lines.length && !words.length) return null;
  return { lines, words: words.length ? words : null, lyrics: text.join('\n') };
}

function ms(v) { const n = Number(v); return Number.isFinite(n) ? n / 1000 : null; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
