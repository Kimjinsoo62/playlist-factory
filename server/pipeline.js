import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS } from './paths.js';
import { log, setStep, setStepProgress, finish, fail, persist } from './jobs.js';
import { TrebloProvider, extractAlignment } from './providers/treblo.js';
import { LocalProvider } from './providers/local.js';
import * as ff from './media/ffmpeg.js';
import { buildAss, lyricLines, alignLinesToWords, distributeLines } from './media/subtitles.js';
import { buildYoutubeMeta } from './youtube.js';
import { findBackground } from './images.js';

const LANG = {
  ko: { name: '한국어', instr: 'Sung in Korean. All lyrics must be in natural Korean (한국어 가사).' },
  en: { name: 'English', instr: 'Sung in English with English lyrics.' },
  ja: { name: '日本語', instr: 'Sung in Japanese with Japanese lyrics (日本語の歌詞).' },
};

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
  const topics = shuffle(preset.topics?.[lang] || preset.topics?.ko || [], Date.now() % 1000);
  const specs = [];
  for (let i = 0; i < n; i++) {
    const topic = pick(topics, i) || `Track ${i + 1}`;
    let prompt = preset.prompt;
    // 한국어 상세 설명을 프롬프트에 포함 (모달에서 편집 가능)
    const ko = (request.koDescription ?? preset.koDescription ?? '').trim();
    if (ko && (request.useKoDescription ?? preset.useKoDescription ?? true)) prompt += ` Detailed style notes (written in Korean, follow them closely): ${ko}`;
    if (!instrumental) prompt += ` ${LANG[lang].instr} Theme of this song: "${topic}".`;
    else prompt += ` Instrumental only, no vocals. Mood: "${topic}".`;
    if (request.extraPrompt) prompt += ` ${request.extraPrompt}`;
    specs.push({
      index: i + 1, title: topic, prompt, instrumental,
      tags: preset.tags?.length ? preset.tags : undefined,
      negative_tags: preset.negative_tags?.length ? preset.negative_tags : undefined,
      length_range: preset.length_range || undefined,
      style_scale: preset.style_scale || undefined,
    });
  }
  return { specs, lang, instrumental };
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

    // 1. 계획
    setStep(job, 1, '트랙 계획');
    const { specs, lang, instrumental } = planTracks(preset, req);
    log(job, `프리셋 "${preset.name}" · ${specs.length}곡 · 언어 ${LANG[lang].name} · ${instrumental ? '연주곡' : '보컬'} · 소스 ${providerName}`);
    job.tracks = specs.map(s => ({ index: s.index, title: s.title, status: 'pending' }));
    persist(job);

    // 2. 생성/수집
    setStep(job, 2, providerName === 'treblo' ? '곡 생성(Treblo API, 병렬)' : providerName === 'local' ? '로컬 트랙 수집' : '테스트 트랙 합성');
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
    const { offsets, durations, total } = await ff.concat(wavs, fullWav, { gapSeconds: cfg.render.gapSeconds, cwd: job.dir });
    collected.forEach((c, i) => { c.offset = offsets[i]; c.duration = durations[i]; });
    log(job, `총 길이 ${fmt(total)}`);
    setStepProgress(job, 100);

    // 5. 자막
    setStep(job, 5, '자막(ASS) 작성');
    const subsOn = req.subtitles !== false && !instrumental;
    const assTracks = collected.map(c => {
      let lines = [];
      if (subsOn) {
        const ll = lyricLines(c.lyrics);
        lines = c.words ? alignLinesToWords(ll, c.words) : distributeLines(ll, c.duration);
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
    const bgMode = bgImage ? 'custom' : (req.background || cfg.images?.defaultMode || 'photo');
    if (bgMode === 'photo') {
      const found = await findBackground({ presetId: preset.id, queries: preset.imageQueries, cfg, log: (m, lv) => log(job, m, lv), preferPool: providerName === 'mock' });
      if (found) { bgImage = found.file; photoCredit = found.credit; }
      else log(job, '사진을 구하지 못해 자동 생성 그라데이션 배경을 씁니다', 'warn');
    } else if (bgMode === 'custom') {
      if (!fs.existsSync(bgImage)) { log(job, `배경 이미지 파일 없음: ${bgImage} → 그라데이션 사용`, 'warn'); bgImage = ''; }
    }
    setStepProgress(job, 50);
    const meta = buildYoutubeMeta({ preset, tracks: collected, total, request: req, cfg, photoCredit });
    const spec = {
      style: req.thumbnailStyle || preset.thumbnailStyle || 'night',
      title: req.thumbnailText || meta.title.replace(/^\[[^\]]*\]\s*/, ''),
      subtitle: req.thumbnailSub ?? `${collected.length} tracks · ${fmt(total)}`,
      background_image: bgImage,
      out_background: path.join(job.dir, 'background.png'),
      out_thumbnail: path.join(job.dir, 'thumbnail.jpg'),
      seed: Date.now() % 100000,
    };
    const specFile = path.join(job.dir, 'thumb_spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec), 'utf8');
    await runPython(path.join(DIRS.scripts, 'thumbnail.py'), [specFile], job.dir);
    setStepProgress(job, 100);

    // 7. 렌더링
    setStep(job, 7, '영상 렌더링(ffmpeg)');
    const outMp4 = path.join(job.dir, 'playlist.mp4');
    await ff.renderVideo({
      cwd: job.dir, background: 'background.png', audio: 'full.wav', ass: subsOn || cfg.subtitles.showTitleOverlay ? 'subs.ass' : null,
      out: 'playlist.mp4', duration: total, cfg: cfg.render,
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
    for (const f of ['full.wav', 'silence.wav', 'concat.txt']) { try { fs.unlinkSync(path.join(job.dir, f)); } catch {} }
    for (const w of wavs) { try { fs.unlinkSync(w); } catch {} }
    setStepProgress(job, 100);

    finish(job, {
      video: rel(job, outMp4), audio: 'playlist.mp3', thumbnail: 'thumbnail.jpg', background: 'background.png',
      subtitles: 'subs.ass', youtube: 'youtube.txt', lyrics: lyricsAll ? 'lyrics.txt' : null, photoCredit,
      total, title: meta.title, chapters: meta.chapters, trackCount: collected.length,
      tracks: collected.map(c => ({ index: c.index, title: c.title, offset: c.offset, duration: c.duration, file: rel(job, c.file) })),
    });
  } catch (e) {
    fail(job, e);
  }
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(sec) { sec = Math.floor(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60; return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`; }
