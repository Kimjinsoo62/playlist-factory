// Suno AI API 어댑터 (https://docs.sunoapi.org / api.sunoapi.org). 보컬·연주곡 모두, 단어별 가사 타임스탬프 제공.
// - 생성: POST /api/v1/generate → { code: 200, data: { taskId } }
//   · 연주곡(instrumental: true): customMode: true, style(최대 1000자, V4/V3_5 는 200자), title(최대 80자), negativeTags
//   · 보컬곡(instrumental: false): customMode: false, prompt(최대 500자, 장르·성별·언어·주제 포함 → Suno 가 가사 작성 및 보컬 생성)
// - 조회: GET /api/v1/generate/record-info?taskId=... → data.status ('PENDING'|'TEXT_SUCCESS'|'FIRST_SUCCESS'|'SUCCESS'|실패 상태), data.response.sunoData[]
// - 가사 타임스탬프: POST /api/v1/generate/get-timestamped-lyrics { taskId, audioId } → data.alignedWords[]{ word, startS, endS }
// - 잔액(크레딧): GET /api/v1/generate/credit → { code: 200, data: <크레딧 숫자> }
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SUNO_MODELS = ['V5', 'V4_5PLUS', 'V4_5', 'V4', 'V3_5'];
const FAILED_STATUSES = new Set([
  'CREATE_TASK_FAILED',
  'GENERATE_AUDIO_FAILED',
  'CALLBACK_EXCEPTION',
  'SENSITIVE_WORD_ERROR',
  'FAILED',
  'ERROR',
]);

export class SunoProvider {
  constructor(cfg) {
    this.cfg = cfg || {};
    if (!this.cfg.apiKey) throw new Error('Suno API 키가 설정되지 않았습니다. 설정에서 입력하세요.');
    this.base = (this.cfg.baseUrl || 'https://api.sunoapi.org').replace(/\/$/, '');
    this.model = SUNO_MODELS.includes(this.cfg.model) ? this.cfg.model : 'V4_5';
  }

  /** node:https 직접 호출 (로컬 스텁 테스트를 위해 http 도 허용) */
  http(method, url, body, { timeoutMs = 60_000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = (url.startsWith('http:') ? http : https).request(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
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
    if (data && typeof data === 'object') return data.msg || data.message || data.error?.message || data.errorMessage || JSON.stringify(data).slice(0, 400);
    return String(data || '').slice(0, 400);
  }

  async request(method, url, body, { retries = 3, signal, timeoutMs } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const { status, data } = await this.http(method, url, body, { signal, timeoutMs });
        if (status === 429 || status >= 500) throw Object.assign(new Error(`HTTP ${status} ${SunoProvider.errMessage(data)}`), { retryable: true, status });
        if (status < 200 || status >= 300) throw Object.assign(new Error(`HTTP ${status} ${SunoProvider.errMessage(data)}`), { status });
        if (data && typeof data === 'object' && 'code' in data && data.code !== 200) {
          const code = Number(data.code);
          const retryable = code === 429 || code >= 500;
          throw Object.assign(new Error(`Suno API 오류(${data.code}): ${SunoProvider.errMessage(data)}`), { retryable, status: code });
        }
        return data?.data !== undefined ? data.data : data;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted || !(e.retryable || e.code === 'ECONNRESET') || i === retries) throw e;
        await sleep(2000 * (i + 1));
      }
    }
    throw lastErr;
  }

  /** 남은 크레딧 조회 (GET /api/v1/generate/credit) */
  async credits() {
    const d = await this.request('GET', `${this.base}/api/v1/generate/credit`, null, { retries: 1, timeoutMs: 20_000 });
    const credits = typeof d === 'number' ? d : Number(d?.credits ?? d?.credit ?? d?.remainCredits ?? d) || 0;
    return { credits };
  }

  /** 프리셋 스펙 → Suno 요청 페이로드 조립 */
  static buildPayload(spec, { model = 'V4_5', gender = '' } = {}) {
    const callBackUrl = 'https://example.com/callback';
    const tags = Array.isArray(spec.tags) && spec.tags.length ? spec.tags.join(', ') : '';
    const neg = Array.isArray(spec.negative_tags) && spec.negative_tags.length ? spec.negative_tags.join(', ') : '';
    const rawDesc = String(spec.prompt || '').replace(/\s+/g, ' ').trim();

    if (spec.instrumental) {
      const styleMax = model === 'V4' || model === 'V3_5' ? 200 : 1000;
      let style = [tags, rawDesc].filter(Boolean).join('. ');
      const cut = style.length > styleMax;
      if (cut) style = style.slice(0, styleMax - 1).replace(/\s+\S*$/, '') + '…';
      const body = {
        customMode: true,
        instrumental: true,
        model,
        title: String(spec.title || `Track ${spec.index}`).slice(0, 80),
        style: style || 'Instrumental background music',
        callBackUrl,
      };
      if (neg) body.negativeTags = neg.slice(0, 200);
      return { body, prompt: body.style, cut, maxLen: styleMax };
    }

    // 보컬곡: customMode=false 로 설명 프롬프트(최대 500자)를 전달해 Suno 가 가사 작성과 노래를 함께 수행
    const promptMax = 500;
    const prefix = [tags, gender === 'male' ? 'male vocal' : gender === 'female' ? 'female vocal' : ''].filter(Boolean).join(', ');
    let p = prefix ? `${prefix}. ${rawDesc}` : rawDesc;
    if (neg && p.length + neg.length + 10 <= promptMax) p += ` Avoid: ${neg}.`;
    const cut = p.length > promptMax;
    if (cut) {
      // 뒤에 있는 언어·주제 지시("Sung in ... Theme of this song: ...")를 보존하기 위해 앞쪽 설명을 줄인다
      const tailMatch = p.match(/(Sung in [A-Za-z]+\..*)$/);
      if (tailMatch && tailMatch[1].length < promptMax - 60) {
        const tail = tailMatch[1];
        const headBudget = promptMax - tail.length - 3;
        const head = p.slice(0, p.indexOf(tail)).trim().slice(0, headBudget).replace(/\s+\S*$/, '');
        p = `${head}… ${tail}`;
      } else {
        p = p.slice(0, promptMax - 1).replace(/\s+\S*$/, '') + '…';
      }
    }
    const body = {
      customMode: false,
      instrumental: false,
      model,
      prompt: p,
      callBackUrl,
    };
    if (gender === 'male') body.vocalGender = 'm';
    else if (gender === 'female') body.vocalGender = 'f';
    if (neg) body.negativeTags = neg.slice(0, 200);
    return { body, prompt: p, cut, maxLen: promptMax };
  }

  /** 곡 생성 시작. 반환: { id (taskId), model, prompt } */
  async startGeneration(spec, { gender = '', signal } = {}) {
    const { body, prompt, cut, maxLen } = SunoProvider.buildPayload(spec, { model: this.model, gender });
    if (cut) this.onWarn?.(`#${spec.index} 프롬프트가 ${maxLen}자를 넘어 핵심 지시 위주로 줄여 보냅니다`);
    const data = await this.request('POST', `${this.base}/api/v1/generate`, body, { retries: 2, signal });
    const taskId = data?.taskId || data?.id;
    if (!taskId) throw new Error(`응답에 taskId 없음: ${JSON.stringify(data).slice(0, 300)}`);
    return { id: String(taskId), model: this.model, prompt };
  }

  async query(taskId, { signal } = {}) {
    return this.request('GET', `${this.base}/api/v1/generate/record-info?taskId=${encodeURIComponent(taskId)}`, null, { retries: 3, signal, timeoutMs: 30_000 });
  }

  /** 완료까지 대기. 반환: { choice, task } */
  async waitFor(started, { onStatus, shouldCancel, signal } = {}) {
    const interval = this.cfg.pollIntervalMs || 5000;
    const t0 = Date.now();
    for (;;) {
      if (shouldCancel?.()) throw new Error('취소됨');
      const task = await this.query(started.id, { signal });
      const st = String(task?.status || '').toUpperCase();
      onStatus?.(st || 'PENDING');
      if (FAILED_STATUSES.has(st)) {
        throw new Error(`생성 실패(${st}): ${task?.errorMessage || task?.errorCode || SunoProvider.errMessage(task) || '원인 미상'}`);
      }
      if (st === 'SUCCESS') {
        const list = task?.response?.sunoData || task?.sunoData || task?.data || [];
        const choice = (Array.isArray(list) ? list : []).find(c => c?.audioUrl || c?.sourceAudioUrl || c?.streamAudioUrl || c?.audio_url);
        if (!choice) throw new Error(`완료됐지만 sunoData 에 오디오 URL 없음: ${JSON.stringify(task).slice(0, 300)}`);
        return { choice, task };
      }
      if (Date.now() - t0 > 20 * 60_000) throw new Error('생성 시간 초과(20분)');
      await sleep(interval);
    }
  }

  /** 단어별 가사 타임스탬프 조회 (실패 시 null 반환) */
  async getTimestampedLyrics(taskId, audioId, { signal } = {}) {
    if (!taskId || !audioId) return null;
    try {
      const data = await this.request('POST', `${this.base}/api/v1/generate/get-timestamped-lyrics`, { taskId, audioId }, { retries: 1, signal, timeoutMs: 25_000 });
      return extractSunoAlignment(data);
    } catch {
      return null;
    }
  }

  /** 오디오 URL 다운로드. 반환: 저장된 파일 경로 */
  async download(choice, destNoExt, { signal } = {}) {
    const url = choice.audioUrl || choice.sourceAudioUrl || choice.audio_url || choice.streamAudioUrl;
    const ext = (url.split('?')[0].match(/\.(mp3|m4a|ogg|wav|flac)$/i) || [, 'mp3'])[1];
    const file = `${destNoExt}.${ext}`;
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`오디오 다운로드 실패 HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    return file;
  }
}

/**
 * get-timestamped-lyrics 응답(alignedWords: [{word, startS, endS}]) →
 * { words: [{word, start, end}], lyrics: string } 변환
 */
export function extractSunoAlignment(data) {
  const arr = Array.isArray(data) ? data : (data?.alignedWords || data?.words || data?.data?.alignedWords);
  if (!Array.isArray(arr) || !arr.length) return null;
  const words = [];
  const rawTokens = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const raw = String(item.word ?? item.text ?? '');
    if (raw) rawTokens.push(raw);
    // [Verse], [Chorus] 등 구조 태그를 제거하고 실제 가사 단어만 추출
    const cleaned = raw.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const start = Number(item.startS ?? item.start ?? item.start_time);
    const end = Number(item.endS ?? item.end ?? item.end_time);
    if (!cleaned || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const parts = cleaned.split(' ').filter(Boolean);
    const dur = Math.max(0.05, end - start) / parts.length;
    parts.forEach((w, idx) => {
      words.push({
        word: w,
        start: Math.round((start + idx * dur) * 100) / 100,
        end: Math.round((start + (idx + 1) * dur) * 100) / 100,
      });
    });
  }
  if (!words.length) return null;
  return { words, lyrics: rawTokens.join(' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
