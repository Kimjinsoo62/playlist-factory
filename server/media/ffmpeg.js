import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const children = new Set();

function run(cmd, args, { cwd, onStderr, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p);
    let out = '', err = '';
    p.stdout.on('data', d => {
      const s = d.toString(); out += s;
      if (onProgress) for (const line of s.split(/\r?\n/)) {
        const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
        if (m) onProgress(Number(m[1]) / 1e6);
      }
    });
    p.stderr.on('data', d => { const s = d.toString(); err += s; if (err.length > 20000) err = err.slice(-20000); onStderr?.(s); });
    p.on('error', e => { children.delete(p); reject(e); });
    p.on('close', code => {
      children.delete(p);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} 종료 코드 ${code}\n${err.slice(-1500)}`));
    });
  });
}

export function killAll() {
  for (const p of children) { try { p.kill('SIGKILL'); } catch {} }
  children.clear();
}

export async function probe(file) {
  const { out } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const audio = (j.streams || []).find(s => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration || audio?.duration || 0),
    sampleRate: Number(audio?.sample_rate || 0),
    channels: Number(audio?.channels || 0),
    codec: audio?.codec_name,
  };
}

/** 트랙을 44.1kHz 스테레오 WAV로 통일(+라우드니스 정규화) */
export async function normalize(input, output, { loudnorm = true } = {}) {
  const af = [];
  if (loudnorm) af.push('loudnorm=I=-14:TP=-1.5:LRA=11');
  af.push('aresample=44100');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-af', af.join(','), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', output];
  await run('ffmpeg', args);
  return probe(output);
}

/** 트랙 사이에 gap초 무음을 넣어 하나의 WAV로 결합. 반환: 각 트랙 시작 오프셋 */
export async function concat(trackFiles, outFile, { gapSeconds = 1.5, cwd } = {}) {
  const dir = cwd || path.dirname(outFile);
  const silence = path.join(dir, 'silence.wav');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', String(gapSeconds), '-c:a', 'pcm_s16le', silence]);
  const list = [];
  const offsets = [];
  const durations = [];
  let t = 0;
  for (let i = 0; i < trackFiles.length; i++) {
    const f = trackFiles[i];
    const info = await probe(f);
    offsets.push(t);
    durations.push(info.duration);
    list.push(`file '${toListPath(f)}'`);
    t += info.duration;
    if (i < trackFiles.length - 1) { list.push(`file '${toListPath(silence)}'`); t += gapSeconds; }
  }
  const listFile = path.join(dir, 'concat.txt');
  fs.writeFileSync(listFile, list.join('\n') + '\n', 'utf8');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', outFile]);
  return { offsets, durations, total: t };
}

function toListPath(p) { return p.replace(/\\/g, '/').replace(/'/g, "'\\''"); }

/** 오디오 전용 산출물(mp3) */
export async function encodeMp3(wav, out) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '320k', out]);
}

/** 테스트용 합성 트랙(사인파 멜로디) 생성 */
export async function synthTrack(out, { seconds = 20, baseFreq = 220 } = {}) {
  const expr = `sin(2*PI*${baseFreq}*t)*0.3*(0.5+0.5*sin(2*PI*0.5*t))+sin(2*PI*${baseFreq * 1.5}*t)*0.15*(0.5+0.5*sin(2*PI*0.25*t+1))`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}|${expr}:s=44100:d=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '192k', out]);
}

let encoderCache = null;
async function pickEncoder(pref) {
  if (pref && pref !== 'auto') return pref;
  if (encoderCache) return encoderCache;
  // h264_qsv 실제 동작 여부 테스트
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=5', '-t', '1', '-c:v', 'h264_qsv', '-f', 'null', '-']);
    encoderCache = 'h264_qsv';
  } catch { encoderCache = 'libx264'; }
  return encoderCache;
}

/**
 * 정지 배경 + ASS 자막 + 오디오 → MP4. 모든 경로는 cwd 기준 상대 경로여야 함(Windows 콜론 문제 회피).
 */
export async function renderVideo({ cwd, background, audio, ass, out, duration, cfg, onProgress, onLog }) {
  const enc = await pickEncoder(cfg.encoder);
  onLog?.(`비디오 인코더: ${enc}`);
  const vf = [`scale=${cfg.width}:${cfg.height}:force_original_aspect_ratio=increase`, `crop=${cfg.width}:${cfg.height}`, 'format=yuv420p'];
  if (ass) vf.push(`ass=${ass.replace(/\\/g, '/')}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-loop', '1', '-framerate', String(cfg.fps), '-i', background,
    '-i', audio,
    '-vf', vf.join(','),
    '-r', String(cfg.fps)];
  if (enc === 'h264_qsv') args.push('-c:v', 'h264_qsv', '-global_quality', String(cfg.crf || 23), '-look_ahead', '0');
  else args.push('-c:v', 'libx264', '-preset', cfg.preset || 'veryfast', '-tune', 'stillimage', '-crf', String(cfg.crf || 20));
  args.push('-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out);
  try {
    await run('ffmpeg', args, { cwd, onProgress: s => onProgress?.(Math.min(100, (s / duration) * 100)) });
  } catch (e) {
    if (enc !== 'libx264') {
      onLog?.(`${enc} 실패, libx264로 재시도: ${e.message.split('\n')[0]}`);
      encoderCache = 'libx264';
      return renderVideo({ cwd, background, audio, ass, out, duration, cfg: { ...cfg, encoder: 'libx264' }, onProgress, onLog });
    }
    throw e;
  }
}
