import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS } from './paths.js';
import { log, setStep, setStepProgress, finish, fail, persist } from './jobs.js';
import { TrebloProvider, extractAlignment } from './providers/treblo.js';
import { LocalProvider } from './providers/local.js';
import { LyriaProvider, extractText, stripAudio } from './providers/lyria.js';
import { MurekaProvider, extractTimings } from './providers/mureka.js';
import * as ff from './media/ffmpeg.js';
import { buildAss, lyricLines, alignLinesToWords, distributeLines, timedLinesToSubs } from './media/subtitles.js';
import { buildYoutubeMeta, trackCount } from './youtube.js';
import { findBackground, collectBackgrounds } from './images.js';
import { collectVideos } from './videos.js';
import { clockLayout, clockFilters, clockEpoch, clockLabel } from './media/clock.js';
import { getWeather, sampleWeather, WEATHER_CREDIT } from './weather.js';
import { hasLlmKey, llmModel, llmProvider, LLM_PROVIDERS, translateToEnglish, planBackgroundQueries, rankBackgrounds } from './llm.js';

const HANGUL = /[\uac00-\ud7a3]/;
const GENDER_TAG = { male: 'male vocalist', female: 'female vocalist' };   // Treblo 태그 사전 상위권 태그
const GENDER_INSTR = { male: 'Male lead vocal (male singer).', female: 'Female lead vocal (female singer).' };
const genderOf = (v) => (v === 'male' || v === 'female') ? v : '';

const LANG = {
  ko: { name: '한국어', instr: 'Sung in Korean. All lyrics must be in natural Korean (한국어 가사).' },
  en: { name: 'English', instr: 'Sung in English with English lyrics.' },
  ja: { name: '日本語', instr: 'Sung in Japanese with Japanese lyrics (日本語の歌詞).' },
};
/** 프리셋에 주제가 없을 때 쓰는 언어별 기본 곡 주제. 영어·일본어 곡에 한국어 제목이 붙지 않도록 언어마다 따로 둔다. */
export const DEFAULT_TOPICS = {
  ko: ['첫 번째 이야기', '밤의 끝에서', '천천히 흐르는 시간', '창밖의 계절', '다시 만난 오후', '조용한 약속'],
  en: ['The First Story', 'At the End of the Night', 'Slow Passing Hours', 'Seasons Past the Window', 'An Afternoon Reunited', 'A Quiet Promise'],
  ja: ['最初の物語', '夜の終わりに', 'ゆっくり流れる時間', '窓の外の季節', 'また会えた午後', '静かな約束'],
};
/** 언어에 맞는 주제 목록. 영어·일본어인데 한글 주제뿐이면(옛 프리셋에 복사돼 있던 한국어 기본값) 그 언어의 기본 주제를 쓴다. */
export function topicsFor(preset, lang) {
  const own = (preset.topics?.[lang] || []).map(s => String(s).trim()).filter(Boolean);
  const usable = lang === 'ko' ? own : own.filter(s => !HANGUL.test(s));
  return usable.length ? usable : DEFAULT_TOPICS[lang] || DEFAULT_TOPICS.ko;
}

export function loadPresets() {
  const out = [];
  for (const f of fs.readdirSync(DIRS.presets).filter(f => f.endsWith('.json')).sort()) {
    try { const p = JSON.parse(fs.readFileSync(path.join(DIRS.presets, f), 'utf8')); p.id ??= f.replace(/\.json$/, ''); out.push(p); }
    catch (e) { console.error('프리셋 읽기 실패', f, e.message); }
  }
  return out;
}
export function getPreset(id) { return loadPresets().find(p => p.id === id); }

function pick(arr, i) { return arr?.length ? arr[i % arr.length] : null; }
const VOCAL_WORDS = /\b(vocals?|vocalists?|singers?|sung|sing(ing|-along)?|crooner|harmon(y|ies)|choir|falsetto|rap(per|ping)?|lyrics)\b/i;
/** 보컬 프리셋을 연주곡으로 돌릴 때: 보컬을 묘사한 문장을 빼고 앞에 연주곡 지시를 붙인다. 끝에 "no vocals"만 덧붙이면 앞의 보컬 묘사와 모순된 프롬프트가 되어 악기 질감만 남은 엉뚱한 장르(예: 올드팝 → 재즈)가 나온다. */
export function instrumentalize(prompt) {
  // 문장 → 쉼표 절 단위로 나눠 보컬을 말하는 절만 뺀다 (프리셋 프롬프트는 대개 쉼표로 이어진 한 문장)
  const sentences = String(prompt).split(/(?<=[.!?])\s+/).map(s => {
    const end = (s.match(/[.!?]$/) || [''])[0];
    const clauses = s.replace(/[.!?]$/, '').split(/,\s*/).filter(c => !VOCAL_WORDS.test(c));
    const rest = clauses.join(', ');
    return rest.length >= 15 ? rest + end : '';   // "Smooth" 처럼 수식어 한 토막만 남은 문장은 버린다
  }).filter(Boolean);
  const body = sentences.length ? sentences.join(' ') : String(prompt).trim();
  return `Instrumental only, no vocals, no singing. Instrumental arrangement of: ${body}`;
}
function shuffle(arr, seed) {
  const a = [...(arr || [])]; let s = seed || 1;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** 트랙 계획: 프리셋 + 언어 + 곡 수 → 생성 스펙 */
export function planTracks(preset, request) {
  const n = Math.max(1, Math.min(40, Number(request.count) || 6));
  const lang = LANG[request.language] ? request.language : 'ko';
  const instrumental = request.instrumental ?? Boolean(preset.instrumental);
  const gender = instrumental ? '' : (genderOf(request.vocalGender) || genderOf(preset.vocalGender));   // 작업 지정 > 프리셋 기본 > 미지정
  // 태그: 성별을 지정하면 해당 vocalist 태그를 앞에 넣고 반대 성별은 제외 태그로
  let tags = preset.tags?.length ? [...preset.tags] : [];
  let negative = preset.negative_tags?.length ? [...preset.negative_tags] : [];
  if (gender) {
    const want = GENDER_TAG[gender], other = GENDER_TAG[gender === 'male' ? 'female' : 'male'];
    tags = [want, ...tags.filter(t => t !== want && t !== other)];
    negative = [...negative.filter(t => t !== want && t !== other), other];
  }
  const seed = Date.now() % 1000;
  const topics = shuffle(topicsFor(preset, lang), seed);
  // 연주곡의 분위기 문구는 영어 주제로 전달(같은 순서로 섞어 제목과 짝을 맞춤). 제목·자막은 선택한 언어의 주제를 그대로 쓴다.
  const enList = topicsFor(preset, 'en');
  const topicsEn = lang !== 'en' && (preset.topics?.en || []).length && enList.length === topics.length ? shuffle(enList, seed) : null;   // 프리셋 자신의 영어 주제가 있을 때만 짝 맞춤(기본 주제와 섞이지 않게)
  const specs = [];
  for (let i = 0; i < n; i++) {
    const topic = pick(topics, i) || `Track ${i + 1}`;
    let prompt = (preset.prompt || '').trim();
    // 한국어 상세 설명을 프롬프트에 포함 (모달에서 편집 가능). 영어 프롬프트가 없으면 한국어 설명이 곧 프롬프트.
    const ko = (request.koDescription ?? preset.koDescription ?? '').trim();
    const koEn = (request.koDescriptionEn || '').trim();   // runJob 에서 LLM 으로 번역한 영어(있으면 우선)
    if (ko && (request.useKoDescription ?? preset.useKoDescription ?? true)) {
      if (koEn) prompt = prompt ? `${prompt} Detailed style notes (follow them closely): ${koEn}` : `Music style (follow it closely): ${koEn}`;
      else prompt = prompt ? `${prompt} Detailed style notes (written in Korean, follow them closely): ${ko}` : `Music style (described in Korean, follow it closely): ${ko}`;
    }
    if (!prompt) prompt = preset.description || preset.name;
    // 영어 프롬프트가 없는 프리셋: 이름이 곧 장르인 경우가 많으므로(예: 칸트리뮤직) 앞에 붙여 장르를 분명히 한다
    if (!(preset.prompt || '').trim()) prompt = `Genre/style: ${request.presetNameEn || preset.name}. ${prompt}`;
    if (!instrumental) prompt += ` ${LANG[lang].instr}${gender ? ' ' + GENDER_INSTR[gender] : ''} Theme of this song: "${topic}".`;
    else {
      if (!preset.instrumental) prompt = instrumentalize(prompt);   // 보컬 프리셋을 연주곡으로: 보컬 묘사 제거
      else if (!/instrumental/i.test(prompt)) prompt += ' Instrumental only, no vocals.';
      prompt += ` Mood: "${pick(topicsEn, i) || topic}".`;
    }
    if (request.extraPromptEn || request.extraPrompt) prompt += ` ${request.extraPromptEn || request.extraPrompt}`;
    specs.push({
      index: i + 1, title: topic, prompt, instrumental,
      tags: tags.length ? tags : undefined,
      negative_tags: negative.length ? negative : undefined,
      length_range: preset.length_range || undefined,
      style_scale: preset.style_scale || undefined,
    });
  }
  return { specs, lang, instrumental, gender };
}

async function runPool(items, limit, worker) {
  let i = 0; const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await worker(items[idx], idx); }
  }));
  return results;
}

function runPython(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn('python', ['-X', 'utf8', script, ...args], { cwd, windowsHide: true });
    ff.children.add(p);
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => { ff.children.delete(p); c === 0 ? resolve(out) : reject(new Error(`python 종료 코드 ${c}: ${err.slice(-800)}`)); });
    p.on('error', e => { ff.children.delete(p); reject(e); });
  });
}

const rel = (job, p) => path.relative(job.dir, p).replace(/\\/g, '/');

export async function runJob(job, cfg) {
  const req = job.request;
  const check = () => { if (job.cancelRequested) throw new Error('사용자 취소'); };
  try {
    const preset = getPreset(req.preset);
    if (!preset) throw new Error(`프리셋을 찾을 수 없음: ${req.preset}`);
    const providerName = req.dryRun ? 'mock' : (req.provider || cfg.provider || 'treblo');
    const tracksDir = path.join(job.dir, 'tracks');

    // 1. 계획 (+ 한국어 요청을 LLM 으로 영어 번역: 메인 LLM 키가 있을 때만, 테스트 소스는 제외)
    setStep(job, 1, '트랙 계획');
    const llmOn = providerName !== 'mock' && hasLlmKey(cfg);
    if (llmOn && providerName !== 'compile') {
      const items = [];
      const ko = (req.koDescription ?? preset.koDescription ?? '').trim();
      if (ko && (req.useKoDescription ?? preset.useKoDescription ?? true) && HANGUL.test(ko)) items.push(['koDescriptionEn', ko]);
      if (req.extraPrompt && HANGUL.test(req.extraPrompt)) items.push(['extraPromptEn', String(req.extraPrompt)]);
      if (!(preset.prompt || '').trim() && HANGUL.test(preset.name || '')) items.push(['presetNameEn', preset.name]);
      if (items.length) {
        try {
          const r = await translateToEnglish(items.map(i => i[1]), { cfg });
          items.forEach((it, i) => { req[it[0]] = r.texts[i]; });
          log(job, `한국어 요청 → 영어 번역 (${LLM_PROVIDERS[llmProvider(cfg)].label} ${r.model || llmModel(cfg, true)}): ${items.map(i => ({ koDescriptionEn: '상세 설명', extraPromptEn: '추가 프롬프트', presetNameEn: '프리셋 이름(장르)' })[i[0]]).join(', ')}`);
          fs.writeFileSync(path.join(job.dir, 'translation.json'), JSON.stringify(Object.fromEntries(items.map((it, i) => [it[0], { ko: it[1], en: r.texts[i] }])), null, 2), 'utf8');
        } catch (e) { log(job, `번역 실패(한국어 그대로 전달): ${e.message.split('\n')[0]}`, 'warn'); }
      }
    } else if (providerName !== 'mock' && providerName !== 'compile') log(job, '메인 LLM 키가 없어 한국어 요청을 번역하지 않고 그대로 전달합니다 (상단 [설정]에서 등록 가능)', 'warn');
    const { specs, lang, instrumental, gender } = planTracks(preset, req);
    log(job, `프리셋 "${preset.name}" · ${specs.length}곡 · 언어 ${LANG[lang].name} · ${instrumental ? '연주곡' : gender === 'male' ? '남성 보컬' : gender === 'female' ? '여성 보컬' : '보컬'} · 소스 ${providerName}`);
    job.tracks = specs.map(s => ({ index: s.index, title: s.title, status: 'pending' }));
    persist(job);

    // 2. 생성/수집
    setStep(job, 2, providerName === 'treblo' ? '곡 생성(Treblo API, 병렬)' : providerName === 'lyria' ? '곡 생성(Google Lyria, 병렬)' : providerName === 'mureka' ? '곡 생성(Mureka API, 병렬)' : providerName === 'local' ? '로컬 트랙 수집' : providerName === 'compile' ? '보관 곡 모으기' : '테스트 트랙 합성');
    let done = 0;
    const bump = (msg) => { done++; setStepProgress(job, (done / specs.length) * 100, msg); };
    let collected;
    if (providerName === 'treblo') {
      const tp = new TrebloProvider(cfg.treblo);
      tp.onWarn = (m) => log(job, m, 'warn');
      const bal = await tp.balance().catch(e => { throw new Error(`Treblo API 연결 실패: ${e.message}`); });
      const credits = (bal.num_credits || 0) + (bal.num_credits_payg || 0);
      log(job, `크레딧 잔액: 구독 ${bal.num_credits ?? '?'} + 종량제 ${bal.num_credits_payg ?? '?'} (필요: ${specs.length * 100})`);
      if (credits < specs.length * 100) throw new Error(`크레딧 부족: ${credits} < ${specs.length * 100}`);
      collected = await runPool(specs, cfg.treblo.concurrency || 3, async (spec) => {
        check();
        const t = job.tracks[spec.index - 1];
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            t.status = 'generating'; persist(job);
            const taskId = await tp.startGeneration(spec);
            t.taskId = taskId;
            log(job, `#${spec.index} 생성 요청 → ${taskId} (${spec.title})`);
            let lastStatus = '';
            const gen = await tp.waitFor(taskId, {
              shouldCancel: () => job.cancelRequested,
              onStatus: (s, a) => { const k = `${s}/${a || '-'}`; if (k !== lastStatus) { lastStatus = k; t.remote = k; setStepProgress(job, (done / specs.length) * 100, `#${spec.index} ${k}`); } },
            });
            fs.writeFileSync(path.join(tracksDir, `${pad(spec.index)}_generation.json`), JSON.stringify(gen, null, 2), 'utf8');
            const url = gen.song_paths?.[0];
            if (!url) throw new Error('song_paths 비어 있음');
            const ext = (url.split('?')[0].match(/\.(mp3|ogg|wav|flac|m4a)$/i) || [, cfg.treblo.outputFormat || 'mp3'])[1];
            const file = path.join(tracksDir, `${pad(spec.index)}.${ext}`);
            await tp.download(url, file);
            const words = instrumental ? null : extractAlignment(gen);
            if (!instrumental) {
              if (words) log(job, `#${spec.index} 가사 정렬 수신 (${words.length}단어)`);
              else log(job, `#${spec.index} 가사 정렬 데이터 없음(alignment_status=${gen.alignment_status}) → 균등 배분 자막 사용`, 'warn');
            }
            t.status = 'done'; t.file = file; persist(job);
            bump(`#${spec.index} 완료`);
            return { ...spec, file, lyrics: instrumental ? '' : (gen.lyrics || ''), words, remoteTags: gen.tags };
          } catch (e) {
            if (job.cancelRequested || attempt === 2) { t.status = 'failed'; t.error = e.message; persist(job); throw e; }
            log(job, `#${spec.index} 실패, 재시도: ${e.message}`, 'warn');
          }
        }
      });
    } else if (providerName === 'lyria') {
      // Lyria 는 가사 타이밍(정렬) 데이터를 주지 않아 보컬곡 자막을 만들 수 없다 → 연주곡만 허용
      if (!instrumental) throw new Error('Lyria 소스는 연주곡 프리셋(또는 보컬 옵션 "연주곡")에서만 사용할 수 있습니다. 보컬곡은 Treblo 소스를 쓰세요.');
      const lp = new LyriaProvider(cfg.lyria);
      lp.onWarn = (m) => log(job, m, 'warn');
      // 사전 점검(과금 없음): 키·권한 오류(400/401/403)만 즉시 중단, 그 외(404 등 경로 차이)는 경고만 남기고 생성 요청에서 판단
      try { const chk = await lp.check(); log(job, `Lyria 모델 ${chk.model} (${chk.displayName || '-'}) · 예상 비용 약 $${(specs.length * 0.08).toFixed(2)} (곡당 $0.08, 결제 계정에 청구)`); }
      catch (e) { if ([400, 401, 403].includes(e.status)) throw new Error(`Lyria(Gemini) API 연결 실패: ${e.message}`); log(job, `Lyria 모델 조회 실패(계속 진행): ${e.message}`, 'warn'); }
      const ac = new AbortController();
      const cancelTick = setInterval(() => { if (job.cancelRequested) ac.abort(); }, 1000);
      try {
      collected = await runPool(specs, cfg.lyria.concurrency || 2, async (spec) => {
        check();
        const t = job.tracks[spec.index - 1];
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            t.status = 'generating'; persist(job);
            const started = await lp.startGeneration(spec, { signal: ac.signal });
            t.taskId = started.id;
            log(job, `#${spec.index} 생성 요청 → ${started.id || '(동기)'} (${spec.title})`);
            let lastStatus = '';
            const it = await lp.waitFor(started, {
              shouldCancel: () => job.cancelRequested, signal: ac.signal,
              onStatus: (s) => { if (s !== lastStatus) { lastStatus = s; t.remote = s; setStepProgress(job, (done / specs.length) * 100, `#${spec.index} ${s}`); } },
            });
            const file = await lp.saveAudio(it, path.join(tracksDir, pad(spec.index)), { signal: ac.signal });
            fs.writeFileSync(path.join(tracksDir, `${pad(spec.index)}_generation.json`), JSON.stringify({ provider: 'lyria', model: lp.model, prompt: started.prompt, text: extractText(it), interaction: stripAudio(it) }, null, 2), 'utf8');
            t.status = 'done'; t.file = file; persist(job);
            bump(`#${spec.index} 완료`);
            return { ...spec, file, lyrics: '', words: null };
          } catch (e) {
            if (job.cancelRequested || attempt === 2 || /취소됨/.test(e.message)) { t.status = 'failed'; t.error = e.message; persist(job); throw e; }
            log(job, `#${spec.index} 실패, 재시도: ${e.message}`, 'warn');
          }
        }
      });
      } finally { clearInterval(cancelTick); }
    } else if (providerName === 'mureka') {
      // Mureka: 보컬곡은 가사 생성 API 로 가사를 먼저 만들고(언어·주제 지시는 프롬프트에 포함) 곡을 생성, 줄·단어별 타임스탬프로 자막을 맞춘다
      const mp = new MurekaProvider(cfg.mureka);
      mp.onWarn = (m) => log(job, m, 'warn');
      let limit = cfg.mureka.concurrency || 1;
      try {
        const b = await mp.billing();
        log(job, `Mureka 잔액 $${b.balanceUsd.toFixed(2)} · 동시 요청 한도 ${b.concurrentLimit} · 모델 ${mp.model} (곡당 요금은 모델별, 생성한 곡 수만큼 청구)`);
        if (b.concurrentLimit && limit > b.concurrentLimit) { log(job, `동시 생성 수 ${limit} → 계정 한도 ${b.concurrentLimit}로 낮춤`, 'warn'); limit = b.concurrentLimit; }
        if (b.balance <= 0) throw Object.assign(new Error(`Mureka 잔액이 없습니다 ($${b.balanceUsd.toFixed(2)}). platform.mureka.ai 에서 충전하세요.`), { fatal: true });
      } catch (e) { if (e.fatal || [400, 401, 403].includes(e.status)) throw new Error(e.fatal ? e.message : `Mureka API 연결 실패: ${e.message}`); log(job, `Mureka 잔액 조회 실패(계속 진행): ${e.message}`, 'warn'); }
      const ac = new AbortController();
      const cancelTick = setInterval(() => { if (job.cancelRequested) ac.abort(); }, 1000);
      try {
      collected = await runPool(specs, limit, async (spec) => {
        check();
        const t = job.tracks[spec.index - 1];
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            t.status = 'generating'; persist(job);
            const started = await mp.startGeneration(spec, { gender, signal: ac.signal });
            t.taskId = started.id;
            log(job, `#${spec.index} 생성 요청 → ${started.id} (${spec.title}${started.lyrics ? `, 가사 ${started.lyrics.length}자` : ''})`);
            let lastStatus = '';
            const { choice, task } = await mp.waitFor(started, {
              shouldCancel: () => job.cancelRequested, signal: ac.signal,
              onStatus: (s) => { if (s !== lastStatus) { lastStatus = s; t.remote = s; setStepProgress(job, (done / specs.length) * 100, `#${spec.index} ${s}`); } },
            });
            const file = await mp.download(choice, path.join(tracksDir, pad(spec.index)), { signal: ac.signal });
            const timing = instrumental ? null : extractTimings(choice);
            // 자막은 Mureka 가 실제로 부른 줄 텍스트·타이밍을 그대로 쓴다. 타이밍이 없으면 보낸 가사를 균등 배분
            const lyrics = instrumental ? '' : (timing?.lyrics || started.lyrics);
            if (!instrumental) log(job, timing ? `#${spec.index} 가사 타임스탬프 수신 (${timing.lines.length}줄${timing.words ? `, ${timing.words.length}단어` : ''})` : `#${spec.index} 가사 타임스탬프 없음 → 균등 배분 자막 사용`, timing ? 'info' : 'warn');
            // 조합(compile) 소스가 다시 읽을 수 있도록 Treblo 와 같은 필드명(word_aligned_lyrics, 초 단위)으로 저장
            fs.writeFileSync(path.join(tracksDir, `${pad(spec.index)}_generation.json`), JSON.stringify({ provider: 'mureka', model: started.model, prompt: started.prompt, lyrics, word_aligned_lyrics: timing?.words || null, timed_lines: timing?.lines || null, task: { ...task, choices: (task.choices || []).map(c => ({ ...c, lyrics_sections: undefined })) }, choice }, null, 2), 'utf8');
            t.status = 'done'; t.file = file; persist(job);
            bump(`#${spec.index} 완료`);
            return { ...spec, file, lyrics, words: timing?.words || null, timedLines: timing?.lines || null };
          } catch (e) {
            if (job.cancelRequested || attempt === 2 || /취소됨/.test(e.message)) { t.status = 'failed'; t.error = e.message; persist(job); throw e; }
            log(job, `#${spec.index} 실패, 재시도: ${e.message}`, 'warn');
          }
        }
      });
      } finally { clearInterval(cancelTick); }
    } else if (providerName === 'compile') {
      // 보관 곡 조합: 완료된 작업의 곡 파일을 그대로 재료로 쓴다 (복사하지 않음). 가사·정렬은 원본 작업 폴더에서 읽는다
      const { resolveTracks, loadLyrics } = await import('./library.js');
      const items = resolveTracks(req.tracks);
      job.tracks = items.map((it, i) => ({ index: i + 1, title: it.track.title, status: 'done', file: it.file, source: `${it.job.id} #${it.index}` }));
      collected = items.map((it, i) => { const ly = instrumental ? { lyrics: '', words: null } : loadLyrics(it.job, it.index, it.file); return { index: i + 1, title: it.track.title, file: it.file, instrumental, lyrics: ly.lyrics, words: ly.words, timedLines: ly.timedLines || null }; });
      for (const c of collected) { log(job, `#${c.index} ${c.title} ← ${job.tracks[c.index - 1].source}${c.words ? ' (가사 정렬)' : c.lyrics ? ' (가사, 균등 배분)' : ''}`); bump(); }
    } else if (providerName === 'local') {
      const lp = new LocalProvider(DIRS.input);
      const files = lp.listFiles();
      if (!files.length) throw new Error(`input 폴더에 오디오 파일이 없습니다: ${DIRS.input}`);
      const use = files.slice(0, specs.length);
      job.tracks = use.map((f, i) => ({ index: i + 1, title: LocalProvider.titleFromFile(f), status: 'done', file: f }));
      collected = use.map((f, i) => ({ index: i + 1, title: LocalProvider.titleFromFile(f), file: f, instrumental: false, lyrics: LocalProvider.lyricsForFile(f), words: null }));
      for (const c of collected) { log(job, `#${c.index} ${path.basename(c.file)}${c.lyrics ? ' (가사 파일 있음)' : ''}`); bump(); }
    } else {
      collected = [];
      for (const spec of specs) {
        check();
        const file = path.join(tracksDir, `${pad(spec.index)}.mp3`);
        await ff.synthTrack(file, { seconds: Number(req.mockSeconds) || 20, baseFreq: 180 + spec.index * 30 });
        const lyrics = instrumental ? '' : `[Verse]\n${spec.title} 첫 번째 줄 테스트 가사\n두 번째 줄입니다 흘러가는 밤\n[Chorus]\n세 번째 줄 함께 노래해\n네 번째 줄 끝까지`;
        job.tracks[spec.index - 1] = { index: spec.index, title: spec.title, status: 'done', file };
        collected.push({ ...spec, file, lyrics, words: null });
        bump(`#${spec.index} 합성`);
      }
    }
    persist(job);

    // 3. 정규화
    setStep(job, 3, '오디오 정규화(라우드니스)');
    const wavs = [];
    for (let i = 0; i < collected.length; i++) {
      check();
      const c = collected[i];
      const wav = path.join(tracksDir, `${pad(c.index)}_norm.wav`);
      const info = await ff.normalize(c.file, wav, { loudnorm: cfg.render.loudnorm !== false });
      c.duration = info.duration; c.wav = wav; wavs.push(wav);
      setStepProgress(job, ((i + 1) / collected.length) * 100, `#${c.index} ${info.duration.toFixed(1)}s`);
    }

    // 4. 결합
    setStep(job, 4, '트랙 결합');
    const fullWav = path.join(job.dir, 'full.wav');
    const crossfade = Math.max(0, Math.min(10, Number(req.crossfadeSeconds) || 0));
    const { offsets, durations, total, crossfade: usedFade } = await ff.concat(wavs, fullWav, { gapSeconds: cfg.render.gapSeconds, crossfadeSeconds: crossfade, cwd: job.dir });
    collected.forEach((c, i) => { c.offset = offsets[i]; c.duration = durations[i]; });
    log(job, `총 길이 ${fmt(total)}${usedFade ? ` (곡 사이 ${usedFade}초 크로스페이드)` : ` (곡 사이 무음 ${cfg.render.gapSeconds}초)`}`);
    setStepProgress(job, 100);

    // 5. 자막
    setStep(job, 5, '자막(ASS) 작성');
    const subsOn = req.subtitles !== false && !instrumental;
    const assTracks = collected.map(c => {
      let lines = [];
      if (subsOn) {
        const ll = lyricLines(c.lyrics);
        lines = c.timedLines?.length ? timedLinesToSubs(c.timedLines) : c.words ? alignLinesToWords(ll, c.words) : distributeLines(ll, c.duration);   // 줄 타이밍(Mureka) > 단어 정렬(Treblo) > 균등 배분
      }
      return { index: c.index, title: c.title, offset: c.offset, duration: c.duration, lines };
    });
    const assPath = path.join(job.dir, 'subs.ass');
    fs.writeFileSync(assPath, buildAss(assTracks, { ...cfg.subtitles, width: cfg.render.width, height: cfg.render.height, playlistTitle: req.overlayTitle || '' }), 'utf8');
    log(job, `자막 ${assTracks.reduce((a, t) => a + t.lines.length, 0)}줄, 곡 제목 오버레이 ${cfg.subtitles.showTitleOverlay ? '포함' : '제외'}`);
    setStepProgress(job, 100);

    // 6. 배경/썸네일
    setStep(job, 6, '배경 사진·썸네일 생성');
    let bgImage = req.backgroundImage || preset.backgroundImage || '';
    let photoCredit = null;
    let slides = [];                 // 슬라이드쇼용 사진 목록 [{file, credit}]
    let clips = [];                  // 슬라이드쇼용 영상 클립 목록 [{file, credit}] (config.videos.mix 가 video|mixed 일 때)
    // 시계·날씨 오버레이: 배경 선택이 'clock'(시간 표시) | 'weather'(날씨와 시간) 이면 바탕은 bgOptions 로 정한다
    const overlay = ['clock', 'weather'].includes(req.background) ? req.background : null;
    const bgo = { ...(cfg.clock || {}), ...(req.bgOptions || {}) };
    let bgMode = overlay ? (bgo.base === 'solid' ? 'solid' : (bgo.photoMode || cfg.images?.defaultMode || 'slideshow')) : (req.background || cfg.images?.defaultMode || 'slideshow');
    if (bgMode === 'solid') bgImage = '';
    else if (bgImage) bgMode = 'custom';
    let clock = null, weather = null;
    if (overlay) {
      const epoch = clockEpoch(bgo.startTime);
      const layout = clockLayout({ mode: overlay, showSeconds: bgo.showSeconds !== false, hour12: Boolean(bgo.hour12) }, cfg.render.width);
      clock = { layout, epoch, hour12: Boolean(bgo.hour12), showSeconds: bgo.showSeconds !== false };
      log(job, `시계 배경: ${clockLabel(epoch)} 부터 ${bgo.hour12 ? '12시간제' : '24시간제'}${bgo.showSeconds === false ? ', 초 숨김' : ''} · 바탕 ${bgMode === 'solid' ? `단색 ${bgo.color}` : bgMode}`);
      if (overlay === 'weather') {
        if (providerName === 'mock') { weather = sampleWeather(bgo.address); log(job, '날씨: 테스트 작업이라 표본 데이터를 씁니다 (네트워크 호출 없음)'); }
        else {
          try {
            weather = await getWeather(bgo.address, cfg);
            log(job, `날씨 (${weather.place}): ${weather.desc} ${weather.temp}°C, 최고 ${weather.tmax}° 최저 ${weather.tmin}°, 습도 ${weather.humidity}%, 바람 ${weather.wind}m/s (Open-Meteo)`);
          } catch (e) {
            log(job, `날씨 조회 실패 → 시계만 표시: ${e.message.split('\n')[0]}`, 'warn');
            clock.layout = clockLayout({ mode: 'clock', showSeconds: clock.showSeconds, hour12: clock.hour12 }, cfg.render.width);
          }
        }
      }
    }
    const imgLog = (m, lv) => log(job, m, lv);
    // 분위기 기획: 곡 제목·가사·스타일로 검색어를 짜고(LLM), 후보는 분위기 기준으로 선별. 키가 없으면 프리셋 검색어 사용.
    let bgPlan = null, bgRank = null;
    if (llmOn && bgMode !== 'custom' && bgMode !== 'gradient' && bgMode !== 'solid') {
      try {
        bgPlan = await planBackgroundQueries({ preset, instrumental, lang, cfg, tracks: collected.map(c => ({ title: c.title, lyrics: instrumental ? '' : lyricLines(c.lyrics).slice(0, 6).join(' / ') })) });
        fs.writeFileSync(path.join(job.dir, 'background_plan.json'), JSON.stringify(bgPlan, null, 2), 'utf8');
        log(job, `배경 사진 기획 (${LLM_PROVIDERS[llmProvider(cfg)].label} ${bgPlan.model || llmModel(cfg, true)}): ${bgPlan.mood}`);
        log(job, `  검색어: ${bgPlan.queries.join(' · ')}${bgPlan.avoid.length ? ` / 제외: ${bgPlan.avoid.join(', ')}` : ''}`);
        bgRank = (args) => rankBackgrounds({ ...args, mood: bgPlan.mood, cfg });
      } catch (e) { log(job, `배경 사진 기획 실패(프리셋 검색어 사용): ${e.message.split('\n')[0]}`, 'warn'); }
    }
    if (bgMode === 'slideshow') {
      const want = Math.max(2, Math.min(30, Number(req.slideCount) || cfg.images?.slideCount || 8));
      // 사진 수가 많아도 영상 길이보다 길 필요는 없음: 10초 × 장수 ≤ 총 길이 + 여유
      const need = Math.max(2, Math.min(want, Math.ceil(total / (cfg.images?.slideSeconds || 10)) + 1));
      // 구성: 사진만 / 영상만 / 섞기 ([배경] 설정 모달 → config.videos.mix, 요청의 bgOptions.mix 가 있으면 우선)
      const mix = ['photo', 'video', 'mixed'].includes(req.bgOptions?.mix) ? req.bgOptions.mix : (cfg.videos?.mix || 'photo');
      if (mix !== 'photo') {
        const vneed = mix === 'video' ? need : Math.ceil(need / 2);
        clips = await collectVideos({ presetId: preset.id, queries: preset.imageQueries, cfg, log: imgLog, count: vneed, maxFetch: providerName === 'mock' ? 0 : (cfg.videos?.maxFetchPerJob ?? 2), allowFetch: providerName !== 'mock', plan: bgPlan, rank: bgRank });
        if (clips.length) log(job, `배경 영상 ${clips.length}개 (${clips.map(c => (c.credit?.title || '').slice(0, 18)).join(' / ')})`);
        else log(job, `영상을 구하지 못해 사진${mix === 'video' ? ' 슬라이드쇼' : '만'}으로 진행합니다`, 'warn');
      }
      const pneed = clips.length ? (mix === 'video' ? 0 : Math.max(1, need - clips.length)) : need;
      slides = pneed ? await collectBackgrounds({ presetId: preset.id, queries: preset.imageQueries, cfg, log: imgLog, count: pneed, maxFetch: providerName === 'mock' ? 0 : (cfg.images?.maxFetchPerJob ?? 4), allowFetch: providerName !== 'mock', plan: bgPlan, rank: bgRank }) : [];
      if (slides.length >= 2 || (slides.length && clips.length)) log(job, `슬라이드쇼 사진 ${slides.length}장 (${slides.map(s => (s.credit?.title || '').slice(0, 18)).join(' / ')})`);
      else if (slides.length === 1) { log(job, '사진이 1장뿐이라 한 장 고정 배경으로 진행합니다', 'warn'); bgImage = slides[0].file; photoCredit = slides[0].credit; slides = []; }
      else if (!clips.length) log(job, '사진을 구하지 못해 자동 생성 그라데이션 배경을 씁니다', 'warn');
      if (!slides.length && clips.length) {
        // 영상만: 첫 클립의 한 프레임을 대표 배경·썸네일 사진으로 쓴다
        bgImage = path.join(job.dir, 'videoframe.png');
        await ff.extractFrame(clips[0].file, bgImage, { at: 1 });
      }
    } else if (bgMode === 'photo') {
      const found = await findBackground({ presetId: preset.id, queries: preset.imageQueries, cfg, log: imgLog, preferPool: providerName === 'mock', plan: bgPlan, rank: bgRank });
      if (found) { bgImage = found.file; photoCredit = found.credit; }
      else log(job, '사진을 구하지 못해 자동 생성 그라데이션 배경을 씁니다', 'warn');
    } else if (bgMode === 'custom') {
      if (!fs.existsSync(bgImage)) { log(job, `배경 이미지 파일 없음: ${bgImage} → 그라데이션 사용`, 'warn'); bgImage = ''; }
    }
    setStepProgress(job, 50);
    const photoCredits = slides.map(s => s.credit).filter(Boolean);
    const videoCredits = clips.map(c => c.credit).filter(Boolean);
    const extraCredits = weather && !weather.sample ? [WEATHER_CREDIT] : [];
    const meta = buildYoutubeMeta({ preset, tracks: collected, total, request: req, cfg, photoCredit, photoCredits, videoCredits, extraCredits });
    const spec = {
      style: req.thumbnailStyle || preset.thumbnailStyle || 'night',
      title: req.thumbnailText || thumbTitle(meta.title, collected.length),
      subtitle: req.thumbnailSub ?? `${trackCount(collected.length, lang)} · ${fmt(total)}`,
      solid_color: bgMode === 'solid' ? (/^#[0-9a-f]{6}$/i.test(String(bgo.color || '')) ? bgo.color : '#101216') : '',
      clock, weather,
      background_image: bgImage,
      slides: slides.map(s => s.file),
      slides_dir: path.join(job.dir, 'slides'),
      want_gradient: clips.length > 0,   // 영상 클립에 얹을 하단 그라데이션 PNG(slides/grad.png)도 만들어 달라
      out_background: path.join(job.dir, 'background.png'),
      out_thumbnail: path.join(job.dir, 'thumbnail.jpg'),
      seed: Date.now() % 100000,
    };
    const specFile = path.join(job.dir, 'thumb_spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
    const thumbOut = await runPython(path.join(DIRS.scripts, 'thumbnail.py'), [specFile], job.dir);
    let slideFiles = [];
    try { slideFiles = JSON.parse(thumbOut.trim().split(/\r?\n/).pop()).slides || []; } catch {}
    setStepProgress(job, 100);

    // 7. 렌더링
    setStep(job, 7, '영상 렌더링(ffmpeg)');
    const outMp4 = path.join(job.dir, 'playlist.mp4');
    let backgroundVideo = null;
    // 영상 클립이 있으면 10fps 정지 화면용 설정 대신 videos.fps(기본 24)로 렌더링한다 (슬라이드쇼와 최종 렌더링에 같은 설정을 써야 fps 가 맞는다)
    const renderCfg = clips.length ? { ...cfg.render, fps: Number(cfg.videos?.fps) || 24 } : cfg.render;
    const items = [];
    {
      const photos = slideFiles.map(f => ({ file: rel(job, f), kind: 'image' }));
      const vids = clips.map(c => ({ file: rel(job, c.file), kind: 'video' }));
      while (photos.length || vids.length) { if (vids.length) items.push(vids.shift()); if (photos.length) items.push(photos.shift()); }   // 섞기: 영상·사진 번갈아
    }
    if (items.length >= 2 || (items.length && clips.length)) {
      if (clips.length) log(job, `영상 클립 ${clips.length}개 포함 → ${renderCfg.fps}fps 로 렌더링 (사진만일 때 ${cfg.render.fps}fps 보다 시간이 더 걸림)`);
      setStepProgress(job, 2, '슬라이드쇼 배경 만드는 중');
      const gradPng = path.join(job.dir, 'slides', 'grad.png');
      await ff.buildSlideshow({
        cwd: job.dir, items, out: 'slideshow.mp4', cfg: renderCfg, gradient: clips.length && fs.existsSync(gradPng) ? rel(job, gradPng) : null,
        slideSeconds: Number(cfg.images?.slideSeconds) || 10, fadeSeconds: Number(cfg.images?.fadeSeconds) || 1.2, onLog: m => log(job, m),
      });
      backgroundVideo = 'slideshow.mp4';
    }
    // 시계는 영상 시간(pts)+시작 시각을 drawtext 로 찍어 영상이 흐르는 만큼 흘러간다. 글꼴은 작업 폴더 기준 상대 경로(드라이브 콜론 회피)
    const extraFilters = clock ? clockFilters(clock.layout, clock.epoch, rel(job, path.join(DIRS.assets, 'fonts', 'BlackHanSans-Regular.ttf')), { hour12: clock.hour12 }) : [];
    await ff.renderVideo({
      cwd: job.dir, background: 'background.png', backgroundVideo, audio: 'full.wav', ass: subsOn || cfg.subtitles.showTitleOverlay ? 'subs.ass' : null,
      out: 'playlist.mp4', duration: total, cfg: renderCfg, extraFilters, motion: clips.length > 0,
      onProgress: p => setStepProgress(job, p, `렌더링 ${p.toFixed(0)}%`),
      onLog: m => log(job, m),
    });

    // 8. 유튜브 메타
    setStep(job, 8, '유튜브 제목·설명·챕터');
    fs.writeFileSync(path.join(job.dir, 'youtube.txt'), `${meta.title}\n\n${meta.description}\n\n태그: ${meta.tags.join(', ')}\n`, 'utf8');
    fs.writeFileSync(path.join(job.dir, 'youtube.json'), JSON.stringify(meta, null, 2), 'utf8');
    setStepProgress(job, 100);

    // 9. 마무리
    setStep(job, 9, '오디오 산출물·정리');
    await ff.encodeMp3(fullWav, path.join(job.dir, 'playlist.mp3'));
    const lyricsAll = collected.filter(c => c.lyrics).map(c => `## ${pad(c.index)}. ${c.title}\n${c.lyrics.trim()}`).join('\n\n');
    if (lyricsAll) fs.writeFileSync(path.join(job.dir, 'lyrics.txt'), lyricsAll, 'utf8');
    for (const f of ['full.wav', 'silence.wav', 'concat.txt', 'slideshow.mp4', 'videoframe.png']) { try { fs.unlinkSync(path.join(job.dir, f)); } catch {} }
    try { fs.rmSync(path.join(job.dir, 'slides'), { recursive: true, force: true }); } catch {}
    for (const w of wavs) { try { fs.unlinkSync(w); } catch {} }
    setStepProgress(job, 100);

    finish(job, {
      video: rel(job, outMp4), audio: 'playlist.mp3', thumbnail: 'thumbnail.jpg', background: 'background.png',
      subtitles: 'subs.ass', youtube: 'youtube.txt', lyrics: lyricsAll ? 'lyrics.txt' : null, photoCredit, photoCredits, slideCount: slideFiles.length, videoCredits, videoCount: clips.length,
      total, title: meta.title, chapters: meta.chapters, trackCount: collected.length,
      tracks: collected.map(c => ({ index: c.index, title: c.title, offset: c.offset, duration: c.duration, file: rel(job, c.file) })),
    });
    // 10. (선택) 유튜브 자동 업로드: 테스트(합성음) 작업은 제외, 실패해도 작업 상태(done)는 유지
    if (cfg.youtube?.autoUpload) {
      if (providerName === 'mock') log(job, '자동 업로드: 테스트(합성음) 작업은 유튜브에 올리지 않습니다');
      else {
        try {
          const yt = await import('./youtubeUpload.js');
          if (!yt.status(cfg).connected) log(job, '자동 업로드가 켜져 있지만 Google 계정이 연결되지 않아 건너뜁니다 (왼쪽 "유튜브 업로드")', 'warn');
          else { log(job, `자동 업로드 시작 (${cfg.youtube.defaultPrivacy || 'private'})`); const p = yt.prepare(job, { privacy: cfg.youtube.defaultPrivacy, thumbnail: cfg.youtube.uploadThumbnail !== false, syntheticMedia: cfg.youtube.syntheticMedia !== false }); yt.upload(job, p, cfg).catch(() => {}); }
        } catch (e) { log(job, `자동 업로드 준비 실패: ${e.message}`, 'warn'); }
      }
    }
  } catch (e) {
    fail(job, e);
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** 썸네일 제목: 유튜브 제목에서 앞의 [Playlist] 와 꼬리의 "N곡 · 1시간 23분"(라벨에 따로 표시) 을 뗀다 */
function thumbTitle(title, n) {
  let t = String(title || '').replace(/^\[[^\]]*\]\s*/, '');
  // 곡 수 표기: 곡·曲·songs·tracks 외에 빗소리 모음처럼 "N가지 · N kinds · N種類" 로 세는 템플릿도 지원
  for (const c of [`${n}곡`, `${n}曲`, `${n} songs`, `${n} song`, `${n} tracks`, `${n} track`, `${n}가지`, `${n} kinds`, `${n} kind`, `${n}種類`, `${n}種`]) {
    const i = t.indexOf(c);
    if (i <= 0) continue;
    const rest = t.slice(i + c.length);
    // 곡 수 뒤에 길이 표기(· 1시간 23분 / · 45 min / · 24分)만 남아 있으면 곡 수부터 끝까지 제거
    if (/^\s*[·|\-–—:,]?\s*[\d\s:시간분초hrsminute分時間]*$/i.test(rest)) t = t.slice(0, i);
  }
  t = t.replace(/[\s·|\-–—:,]+$/, '').trim();
  return t || String(title || '');
}

function fmt(sec) { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; }
