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
  vocalGender: z.enum(['male', 'female']).optional(),
}, async (args) => text(await api('/api/plan', { method: 'POST', body: args })));

server.tool('create_playlist', '플레이리스트 영상 생성 작업을 시작한다. 곡 생성(Treblo API, 병렬) → 결합 → 가사 자막 → 썸네일 → 렌더링 → 유튜브 메타데이터까지 자동. 작업 id를 돌려주며 get_job 으로 진행 상황을 확인한다. provider=treblo 는 곡당 100크레딧, provider=lyria(Google Lyria, 연주곡 전용) 는 곡당 약 $0.08 이 든다.', {
  preset: z.string().describe('프리셋 id'),
  count: z.number().int().min(1).max(40).default(6).describe('곡 수'),
  language: z.enum(['ko', 'en', 'ja']).default('ko').describe('가사 언어'),
  instrumental: z.boolean().optional().describe('연주곡 여부(생략 시 프리셋 기본값)'),
  vocalGender: z.enum(['male', 'female']).optional().describe('보컬 성별. male=남성, female=여성 (생략 시 프리셋 기본값, 연주곡이면 무시)'),
  provider: z.enum(['treblo', 'lyria', 'local', 'mock']).optional().describe('생략하면 설정에서 활성화한 작곡 AI 를 사용. treblo=Treblo API 자동 생성(보컬·연주곡), lyria=Google Lyria 자동 생성(연주곡 프리셋 전용, 가사 자막 불가; 설정에서 활성 상태여야 함), local=input 폴더의 파일 사용, mock=크레딧 없는 테스트'),
  title: z.string().optional().describe('유튜브 영상 제목(생략 시 자동)'),
  thumbnailStyle: z.enum(['night', 'warm', 'mono', 'neon', 'paper', 'forest', 'ocean']).optional(),
  thumbnailText: z.string().optional(),
  extraPrompt: z.string().optional().describe('음악 프롬프트에 덧붙일 영어 지시 (예: "female vocal, saxophone solo")'),
  subtitles: z.boolean().default(true),
  background: z.enum(['slideshow', 'photo', 'gradient', 'clock', 'weather']).default('slideshow').describe('slideshow=무료 사진 여러 장 10초마다 페이드 전환, photo=무료 사진 한 장 고정, gradient=자동 생성 그라데이션, clock=화면 가득 디지털 플립시계, weather=주소지 날씨+시계 (clock/weather 의 바탕·주소는 웹앱 [배경] 설정에 저장된 값 사용)'),
  koDescription: z.string().optional().describe('이 작업에만 적용할 한국어 상세 스타일 설명(분위기·악기·템포·보컬). 생략하면 프리셋에 저장된 설명을 사용'),
}, async (args) => {
  const body = { ...args };
  if (body.provider === 'mock') body.dryRun = true;
  const j = await api('/api/jobs', { method: 'POST', body });
  return text({ jobId: j.id, status: j.status, outputDir: j.dir, hint: 'get_job 으로 진행 상황을 확인하세요. 완료되면 playlist.mp4, thumbnail.jpg, youtube.txt 가 생깁니다.' });
});

server.tool('create_playlist_from_description', '[간편하게 생성] 프리셋 없이 곡 설명(한국어)만으로 플레이리스트를 만든다: 메인 LLM이 설명으로 영어 프롬프트·태그·곡 주제를 담은 새 프리셋(quick-…, ⚡)을 저장한 뒤 그 프리셋으로 작업을 시작한다. 설명에는 장르·악기·템포·보컬·분위기를 꼭 넣을 것. 프롬프트 자동 생성에 실패하면 유료 소스(treblo·lyria)는 시작하지 않고 오류를 돌려준다.', {
  description: z.string().min(10).describe('곡 설명(한국어, 10자 이상). 예: "비 오는 밤 창가에서 듣는 잔잔한 어쿠스틱 발라드. 통기타와 피아노, 70~80 BPM, 담담한 여성 보컬"'),
  name: z.string().max(30).optional().describe('프리셋 이름(생략 시 설명의 첫 구절)'),
  count: z.number().int().min(1).max(40).default(6).describe('곡 수'),
  language: z.enum(['ko', 'en', 'ja']).default('ko').describe('가사 언어'),
  vocal: z.enum(['vocal', 'male', 'female', 'instrumental']).default('vocal').describe('vocal=보컬(성별 미지정), male=남성 보컬, female=여성 보컬, instrumental=연주곡'),
  provider: z.enum(['treblo', 'lyria', 'mock']).optional().describe('생략하면 설정에서 활성화한 작곡 AI. lyria 는 vocal=instrumental 이어야 함. mock=크레딧 없는 테스트'),
  title: z.string().optional().describe('유튜브 영상 제목(생략 시 자동)'),
  subtitles: z.boolean().default(true),
  background: z.enum(['slideshow', 'photo', 'gradient', 'clock', 'weather']).default('slideshow'),
}, async ({ description, name, count, language, vocal, provider, title, subtitles, background }) => {
  if (provider === 'lyria' && vocal !== 'instrumental') throw new Error('Lyria 소스는 연주곡 전용입니다. vocal=instrumental 로 지정하세요.');
  const first = description.split(/[\n.,!?;:()·]/).map(s => s.trim()).find(Boolean) || description.trim();
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const id = `quick-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const created = await api('/api/presets', { method: 'POST', body: { id, name: (name || '').trim() || first.slice(0, 16), koDescription: description, instrumental: vocal === 'instrumental', vocalGender: vocal === 'male' || vocal === 'female' ? vocal : '', quick: true } });
  if (!created._generated && provider !== 'mock') throw new Error(`프리셋 "${created.name}"(${created.id})은 저장했지만 영어 프롬프트 자동 생성에 실패해 시작하지 않았습니다: ${created._generateError || '알 수 없는 오류'}. 메인 LLM 키를 확인하세요.`);
  const body = { preset: created.id, count, language, instrumental: vocal === 'instrumental', subtitles, background };
  if (vocal === 'male' || vocal === 'female') body.vocalGender = vocal;
  if (provider) body.provider = provider; if (provider === 'mock') body.dryRun = true;
  if (title) body.title = title;
  const j = await api('/api/jobs', { method: 'POST', body });
  return text({ jobId: j.id, presetId: created.id, presetName: created.name, prompt: created.prompt, status: j.status, outputDir: j.dir, hint: 'get_job 으로 진행 상황을 확인하세요. 프리셋은 presets/ 에 저장되어 list_presets 에 나타납니다.' });
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

server.tool('upload_youtube', '완료된 작업의 영상(playlist.mp4)을 연결된 유튜브 채널에 업로드한다. 앱 화면에서 Google 계정이 먼저 연결돼 있어야 한다. 기본 비공개. 진행 상황·결과 링크는 get_job 의 youtube 필드로 확인한다. 업로드 1건 = API 할당량 1,600(하루 기본 10,000).', {
  jobId: z.string(),
  privacy: z.enum(['private', 'unlisted', 'public']).default('private'),
  title: z.string().max(100).optional().describe('생략하면 youtube.json 의 제목'),
  description: z.string().max(5000).optional(),
  publishAt: z.string().optional().describe('예약 공개 시각(ISO 8601). 지정하면 비공개로 올라가 그 시각에 공개'),
  thumbnail: z.boolean().default(true),
}, async (args) => text(await api('/api/youtube/upload', { method: 'POST', body: args })));

const transport = new StdioServerTransport();
await server.connect(transport);
