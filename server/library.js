// 보관 곡 라이브러리: 완료된 작업들의 곡(tracks/NN.mp3)을 모아 "조합(compile)" 작업의 재료로 쓴다.
//  - 테스트(합성음) 곡은 기본 제외, 조합 작업의 곡은 다른 폴더를 가리키는 복사본이라 항상 제외
//  - 파일이 지워진 곡은 목록에서 빠진다 (로컬 소스는 input/ 의 원본을 가리킴)
import fs from 'node:fs';
import path from 'node:path';
import { listJobs, getJob } from './jobs.js';
import { extractAlignment } from './providers/treblo.js';
import { LocalProvider } from './providers/local.js';

const pad = (n) => String(n).padStart(2, '0');

/** 곡 파일 절대 경로 (result.tracks[].file 은 작업 폴더 기준 상대 경로) */
function trackFile(job, t) { return t?.file ? path.resolve(job.dir, t.file) : null; }

/** 라이브러리 목록. preset 을 주면 그 프리셋 곡만 */
export function listLibrary({ preset = '', includeMock = false } = {}) {
  const out = [];
  for (const s of listJobs({ includeHidden: true })) {
    const job = getJob(s.id);
    if (!job || job.status !== 'done' || !job.result?.tracks?.length) continue;
    const prov = job.request?.provider || (job.request?.dryRun ? 'mock' : 'treblo');
    if (prov === 'compile') continue;
    if (prov === 'mock' && !includeMock) continue;
    if (preset && job.request?.preset !== preset) continue;
    const instrumental = Boolean(job.request?.instrumental ?? false);
    for (const t of job.result.tracks) {
      const file = trackFile(job, t);
      if (!file || !fs.existsSync(file)) continue;
      out.push({
        jobId: job.id, index: t.index, title: t.title || `Track ${t.index}`, duration: Number(t.duration) || 0, file,
        presetId: job.request?.preset || '', provider: prov, lang: job.request?.language || 'ko', instrumental,
        hasWords: fs.existsSync(path.join(job.dir, 'tracks', `${pad(t.index)}_generation.json`)),
        createdAt: job.createdAt || 0, sourceTitle: job.result?.title || '',
      });
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || a.index - b.index);
}

/** 조합 요청 검증: [{jobId, index}] → 재료 목록. 문제가 있으면 throw */
export function resolveTracks(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('조합할 곡을 하나 이상 고르세요.');
  if (items.length > 60) throw new Error('한 번에 60곡까지 조합할 수 있습니다.');
  const seen = new Set(); const out = [];
  for (const it of items) {
    const key = `${it?.jobId}#${it?.index}`;
    if (seen.has(key)) throw new Error(`같은 곡이 두 번 들어 있습니다: ${key}`);
    seen.add(key);
    const job = getJob(String(it?.jobId || ''));
    if (!job) throw new Error(`원본 작업을 찾을 수 없습니다: ${it?.jobId}`);
    if (job.status !== 'done') throw new Error(`완료되지 않은 작업의 곡입니다: ${job.id}`);
    const t = (job.result?.tracks || []).find(x => x.index === Number(it.index));
    const file = t && trackFile(job, t);
    if (!file || !fs.existsSync(file)) throw new Error(`곡 파일이 없습니다: ${job.id} #${it.index}`);
    out.push({ job, track: t, file, index: Number(it.index) });
  }
  return out;
}

/** 원본 작업 폴더에서 가사·단어 정렬을 읽는다 (Treblo: NN_generation.json, 로컬: 같은 이름의 .txt/.lrc, 그 외 없음) */
export function loadLyrics(job, index, file) {
  const gen = path.join(job.dir, 'tracks', `${pad(index)}_generation.json`);
  if (fs.existsSync(gen)) {
    try {
      const g = JSON.parse(fs.readFileSync(gen, 'utf8'));
      if (g.provider === 'lyria') return { lyrics: '', words: null };
      return { lyrics: g.lyrics || '', words: extractAlignment(g) };
    } catch { /* 아래 폴백 */ }
  }
  // lyrics.txt 의 "## NN. 제목" 구간 (mock·정렬 없는 경우)
  try {
    const all = fs.readFileSync(path.join(job.dir, 'lyrics.txt'), 'utf8');
    const m = new RegExp(`^## ${pad(index)}\\. [^\\n]*\\n([\\s\\S]*?)(?=\\n## \\d\\d\\. |$)`, 'm').exec(all);
    if (m) return { lyrics: m[1].trim(), words: null };
  } catch {}
  const local = LocalProvider.lyricsForFile(file);
  return { lyrics: local || '', words: null };
}
