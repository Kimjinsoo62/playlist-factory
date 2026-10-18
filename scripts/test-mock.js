// 서버 없이 파이프라인을 end-to-end 로 검증한다 (합성음, 크레딧 0).
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { createJob, bus } from '../server/jobs.js';
import { runJob } from '../server/pipeline.js';

const cfg = loadConfig();
const preset = process.argv[2] || 'jazz-night';
const count = Number(process.argv[3] || 3);
const mockSeconds = Number(process.argv[4] || 12);
bus.on('event', ev => { if (ev.type === 'log') console.log(`[${ev.data.t}] ${ev.data.msg}`); });

const job = createJob({ preset, count, language: 'ko', dryRun: true, provider: 'mock', mockSeconds, subtitles: true, background: process.env.BG || 'slideshow', bgOptions: process.env.BG_OPTS ? JSON.parse(process.env.BG_OPTS) : undefined });   // BG=clock|weather 일 때 BG_OPTS='{"base":"solid"}' 등
console.log('job', job.id, job.dir);
await runJob(job, cfg);
if (job.status !== 'done') { console.error('FAILED:', job.error); process.exit(1); }
const must = ['playlist.mp4', 'playlist.mp3', 'thumbnail.jpg', 'background.png', 'subs.ass', 'youtube.txt', 'job.json'];
for (const f of must) {
  const p = path.join(job.dir, f);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) { console.error('MISSING', f); process.exit(1); }
  console.log('ok', f, fs.statSync(p).size, 'bytes');
}
console.log('RESULT', JSON.stringify({ total: job.result.total, title: job.result.title, chapters: job.result.chapters }, null, 2));
