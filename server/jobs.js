import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DIRS } from './paths.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const jobs = new Map();

function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export function createJob(request) {
  const id = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_' + Math.random().toString(36).slice(2, 6);
  const dir = path.join(DIRS.output, id);
  fs.mkdirSync(path.join(dir, 'tracks'), { recursive: true });
  const job = {
    id, dir, request,
    status: 'queued',          // queued | running | done | failed | cancelled
    step: '', stepIndex: 0, stepCount: 9,
    progress: 0,               // 0..100 overall
    stepProgress: 0,           // 0..100 current step
    tracks: [],
    logs: [],
    result: null,
    error: null,
    createdAt: Date.now(), updatedAt: Date.now(),
    cancelRequested: false,
  };
  jobs.set(id, job);
  persist(job);
  emit(job, 'job', summarize(job));
  return job;
}

export function getJob(id) { return jobs.get(id); }
export function removeJob(id) { return jobs.delete(id); }
export function listJobs({ includeHidden = false } = {}) {
  return [...jobs.values()].filter(j => includeHidden || !j.hidden).sort((a, b) => b.createdAt - a.createdAt).map(summarize);
}

/** 화면 초기화: 끝난 작업을 목록에서 숨긴다(출력 데이터는 유지, 재시작 후에도 숨김 유지) */
export function hideFinishedJobs() {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.status === 'running' || j.status === 'queued' || j.hidden) continue;
    j.hidden = true; j.hiddenAt = Date.now(); persist(j); n++;
  }
  bus.emit('event', { type: 'reset', jobId: null, data: { hidden: n } });
  return n;
}
export function unhideJobs() {
  let n = 0;
  for (const j of jobs.values()) if (j.hidden) { j.hidden = false; persist(j); n++; }
  bus.emit('event', { type: 'reset', jobId: null, data: { unhidden: n } });
  return n;
}

export function summarize(job) {
  const { logs, ...rest } = job;
  return { ...rest, logCount: logs.length };
}

export function log(job, msg, level = 'info') {
  const line = { t: ts(), level, msg };
  job.logs.push(line);
  if (job.logs.length > 2000) job.logs.splice(0, job.logs.length - 2000);
  job.updatedAt = Date.now();
  emit(job, 'log', line);
  try { fs.appendFileSync(path.join(job.dir, 'job.log'), `[${line.t}] ${level.toUpperCase()} ${msg}\n`); } catch {}
}

export function setStep(job, index, name) {
  job.stepIndex = index; job.step = name; job.stepProgress = 0;
  job.progress = Math.round(((index - 1) / job.stepCount) * 100);
  job.status = 'running';
  log(job, `── ${index}/${job.stepCount} ${name}`);
  emit(job, 'job', summarize(job));
}

export function setStepProgress(job, pct, detail) {
  job.stepProgress = Math.max(0, Math.min(100, Math.round(pct)));
  job.progress = Math.round(((job.stepIndex - 1 + job.stepProgress / 100) / job.stepCount) * 100);
  if (detail) job.detail = detail;
  emit(job, 'job', summarize(job));
}

export function finish(job, result) {
  job.status = 'done'; job.progress = 100; job.stepProgress = 100; job.result = result;
  log(job, '완료');
  persist(job); emit(job, 'job', summarize(job));
}

export function fail(job, err) {
  job.status = job.cancelRequested ? 'cancelled' : 'failed';
  job.error = String(err?.stack || err);
  log(job, `${job.status === 'cancelled' ? '취소됨' : '실패'}: ${err?.message || err}`, 'error');
  persist(job); emit(job, 'job', summarize(job));
}

export function persist(job) {
  try { fs.writeFileSync(path.join(job.dir, 'job.json'), JSON.stringify(summarize(job), null, 2), 'utf8'); } catch {}
}

export function emit(job, type, data) {
  bus.emit('event', { type, jobId: job.id, data });
}

export function loadPastJobs() {
  try {
    for (const name of fs.readdirSync(DIRS.output)) {
      const f = path.join(DIRS.output, name, 'job.json');
      if (!fs.existsSync(f) || jobs.has(name)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        j.logs = [];
        if (j.status === 'running' || j.status === 'queued') j.status = 'failed', j.error = '서버 재시작으로 중단됨';
        jobs.set(j.id, j);
      } catch {}
    }
  } catch {}
}
