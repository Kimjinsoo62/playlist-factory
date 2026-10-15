// Treblo (구 Sonauto) 공개 API 어댑터. 문서: https://treblo.com/developers/docs
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const TERMINAL = new Set(['SUCCESS', 'FAILURE']);

export class TrebloProvider {
  constructor(cfg) {
    this.cfg = cfg;
    if (!cfg.apiKey) throw new Error('Treblo API 키가 설정되지 않았습니다. 설정에서 API 키를 입력하세요.');
    this.base = (cfg.baseUrl || 'https://api.treblo.com/v1').replace(/\/$/, '');
  }

  headers(json = true) {
    const h = { Authorization: `Bearer ${this.cfg.apiKey}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async request(method, url, body, { retries = 3 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, { method, headers: this.headers(Boolean(body)), body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`), { retryable: true });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
        return data;
      } catch (e) {
        lastErr = e;
        if (!(e.retryable || e.code === 'ECONNRESET' || e.name === 'TypeError') || i === retries) throw e;
        await sleep(1500 * (i + 1));
      }
    }
    throw lastErr;
  }

  async balance() {
    return this.request('GET', `${this.base}/credits/balance`);
  }

  /** 곡 생성 요청. 반환: task_id */
  async startGeneration(spec) {
    const model = this.cfg.model || 'v3';
    const body = {
      prompt: spec.prompt,
      instrumental: Boolean(spec.instrumental),
      output_format: this.cfg.outputFormat || 'mp3',
      output_bit_rate: this.cfg.outputBitRate || 320,
      align_lyrics: !spec.instrumental,
    };
    if (spec.lyrics && !spec.instrumental) body.lyrics = spec.lyrics;
    if (Array.isArray(spec.tags) && spec.tags.length) body.tags = spec.tags;   // 빈 배열은 절대 보내지 않음
    if (model === 'v3') {
      if (Array.isArray(spec.negative_tags) && spec.negative_tags.length) body.negative_tags = spec.negative_tags;
      if (Array.isArray(spec.length_range) && spec.length_range.length === 2) body.length_range = spec.length_range;
      if (spec.style_scale) body.style_scale = spec.style_scale;
    } else {
      body.num_songs = 1;
      if (spec.bpm) body.bpm = spec.bpm;
    }
    const data = await this.request('POST', `${this.base}/generations/${model}`, body);
    if (!data?.task_id) throw new Error(`task_id 없음: ${JSON.stringify(data)}`);
    return data.task_id;
  }

  async status(taskId) {
    return this.request('GET', `${this.base}/generations/status/${taskId}?include_alignment=true`);
  }

  async getGeneration(taskId) {
    return this.request('GET', `${this.base}/generations/${taskId}`);
  }

  /** SUCCESS/FAILURE 까지 대기. onStatus(status, alignmentStatus) 콜백 */
  async waitFor(taskId, { onStatus, shouldCancel, waitAlignment = true } = {}) {
    const interval = this.cfg.pollIntervalMs || 5000;
    const started = Date.now();
    let alignWaitStart = null;
    for (;;) {
      if (shouldCancel?.()) throw new Error('취소됨');
      const s = await this.status(taskId);
      const st = typeof s === 'string' ? s : s?.status;
      const al = typeof s === 'string' ? null : s?.alignment_status;
      onStatus?.(st, al);
      if (st === 'FAILURE') {
        const g = await this.getGeneration(taskId).catch(() => null);
        throw new Error(`생성 실패: ${g?.error_message || '원인 미상'}`);
      }
      if (st === 'SUCCESS') {
        // 가사 정렬이 요청된 경우 최대 3분 추가 대기
        if (waitAlignment && al && !TERMINAL.has(al)) {
          alignWaitStart ??= Date.now();
          if (Date.now() - alignWaitStart < 180_000) { await sleep(interval); continue; }
        }
        return this.getGeneration(taskId);
      }
      if (Date.now() - started > 20 * 60_000) throw new Error('생성 시간 초과(20분)');
      await sleep(interval);
    }
  }

  async download(url, dest) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`다운로드 실패 HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    return dest;
  }
}

/**
 * 정렬 데이터 정규화. 문서에 응답 필드명이 명시돼 있지 않아 가능한 이름을 모두 시도한다.
 * 반환: [{word, start, end}] 또는 null
 */
export function extractAlignment(gen) {
  if (!gen || typeof gen !== 'object') return null;
  const candidates = ['aligned_lyrics', 'alignment', 'lyrics_alignment', 'word_timings', 'words', 'alignments', 'aligned_words', 'timed_lyrics'];
  let raw = null;
  for (const k of candidates) if (gen[k] != null) { raw = gen[k]; break; }
  if (raw == null) {
    for (const [k, v] of Object.entries(gen)) {
      if (/align|timing|timed/i.test(k) && v && typeof v === 'object') { raw = v; break; }
    }
  }
  if (raw == null) return null;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  let arr = Array.isArray(raw) ? raw : (raw.words || raw.segments || raw.lines || raw.items || raw.data);
  if (!Array.isArray(arr)) return null;
  // 세그먼트 → 단어 평탄화
  if (arr.length && Array.isArray(arr[0]?.words)) arr = arr.flatMap(s => s.words);
  const words = [];
  for (const w of arr) {
    if (!w || typeof w !== 'object') continue;
    const text = w.word ?? w.text ?? w.token ?? w.w;
    const start = num(w.start ?? w.start_time ?? w.startTime ?? w.s ?? w.begin);
    const end = num(w.end ?? w.end_time ?? w.endTime ?? w.e ?? w.stop);
    if (text == null || start == null || end == null) continue;
    words.push({ word: String(text), start, end });
  }
  return words.length ? words : null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
