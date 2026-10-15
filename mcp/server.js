// MCP 서버: Claude(Desktop/Code)에서 "플레이리스트 만들어 줘" 한마디로 작업을 시작한다.
// 실행 중인 웹 서버(http://localhost:PORT)의 API를 호출하므로 START.bat 이 먼저 떠 있어야 한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let port = 5177;
try { port = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).port || 5177; } catch {}
const BASE = process.env.PLAYLIST_FACTORY_URL || `http://localhost:${port}`;

async function api(p, opt = {}) {
  const r = await fetch(BASE + p, { headers: { 'Content-Type': 'application/json' }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const text = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: 'playlist-factory', version: '0.1.0' });

server.tool('list_presets', '사용 가능한 장르 프리셋 목록(id, 이름, 설명, 연주곡 여부)을 돌려준다.', {}, async () => {
  const ps = await api('/api/presets');
  return text(ps.map(p => ({ id: p.id, name: p.name, description: p.description, instrumental: Boolean(p.instrumental) })));
});

server.tool('plan_playlist', '플레이리스트를 만들기 전에 곡 수·크레딧·예상 길이를 계산한다(생성하지 않음).', {
  preset: z.string().describe('프리셋 id (list_presets 참고)'),
  count: z.number().int().min(1).max(40).default(6),
  language: z.enum(['ko', 'en', 'ja']).default('ko'),
  instrumental: z.boolean().optional(),
}, async (args) => text(await api('/api/plan', { method: 'POST', body: args })));

server.tool('create_playlist', '플레이리스트 영상 생성 작업을 시작한다. 곡 생성(Treblo API, 병렬) → 결합 → 가사 자막 → 썸네일 → 렌더링 → 유튜브 메타데이터까지 자동. 작업 id를 돌려주며 get_job 으로 진행 상황을 확인한다. provider=treblo 는 곡당 100크레딧이 든다.', {
  preset: z.string().describe('프리셋 id'),
  count: z.number().int().min(1).max(40).default(6).describe('곡 수'),
  language: z.enum(['ko', 'en', 'ja']).default('ko').describe('가사 언어'),
  instrumental: z.boolean().optional().describe('연주곡 여부(생략 시 프리셋 기본값)'),
  provider: z.enum(['treblo', 'local', 'mock']).default('treblo').describe('treblo=API 자동 생성, local=input 폴더의 파일 사용, mock=크레딧 없는 테스트'),
  title: z.string().optional().describe('유튜브 영상 제목(생략 시 자동)'),
  thumbnailStyle: z.enum(['night', 'warm', 'mono', 'neon', 'paper', 'forest', 'ocean']).optional(),
  thumbnailText: z.string().optional(),
  extraPrompt: z.string().optional().describe('음악 프롬프트에 덧붙일 영어 지시 (예: "female vocal, saxophone solo")'),
  subtitles: z.boolean().default(true),
  background: z.enum(['photo', 'gradient']).default('photo').describe('photo=프리셋 분위기의 무료 CC0 사진 자동 수집, gradient=자동 생성 그라데이션'),
}, async (args) => {
  const body = { ...args };
  if (body.provider === 'mock') body.dryRun = true;
  const j = await api('/api/jobs', { method: 'POST', body });
  return text({ jobId: j.id, status: j.status, outputDir: j.dir, hint: 'get_job 으로 진행 상황을 확인하세요. 완료되면 playlist.mp4, thumbnail.jpg, youtube.txt 가 생깁니다.' });
});

server.tool('get_job', '작업의 진행 상황, 트랙 목록, 결과 파일, 최근 로그를 돌려준다.', { jobId: z.string(), logLines: z.number().int().min(0).max(200).default(30) }, async ({ jobId, logLines }) => {
  const j = await api('/api/jobs/' + jobId);
  const { logs, ...rest } = j;
  return text({ ...rest, logs: (logs || []).slice(-logLines).map(l => `[${l.t}] ${l.msg}`) });
});

server.tool('wait_job', '작업이 끝날 때까지(최대 timeoutSec) 기다렸다가 결과를 돌려준다.', { jobId: z.string(), timeoutSec: z.number().int().min(10).max(3600).default(1500) }, async ({ jobId, timeoutSec }) => {
  const started = Date.now();
  for (;;) {
    const j = await api('/api/jobs/' + jobId);
    if (['done', 'failed', 'cancelled'].includes(j.status)) { const { logs, ...rest } = j; return text({ ...rest, lastLogs: (logs || []).slice(-15).map(l => l.msg) }); }
    if (Date.now() - started > timeoutSec * 1000) return text({ timeout: true, status: j.status, progress: j.progress, step: j.step });
    await new Promise(r => setTimeout(r, 8000));
  }
});

server.tool('list_jobs', '최근 작업 목록을 돌려준다.', {}, async () => text((await api('/api/jobs')).map(j => ({ id: j.id, status: j.status, progress: j.progress, preset: j.request?.preset, count: j.request?.count, title: j.result?.title }))));

server.tool('get_youtube_text', '완료된 작업의 유튜브 제목·설명·챕터 텍스트를 돌려준다.', { jobId: z.string() }, async ({ jobId }) => {
  const r = await fetch(`${BASE}/output/${jobId}/youtube.txt`);
  if (!r.ok) throw new Error('youtube.txt 가 아직 없습니다. 작업이 완료되었는지 확인하세요.');
  return text(await r.text());
});

server.tool('credits', 'Treblo 크레딧 잔액을 확인한다.', {}, async () => text(await api('/api/treblo/balance')));

const transport = new StdioServerTransport();
await server.connect(transport);
