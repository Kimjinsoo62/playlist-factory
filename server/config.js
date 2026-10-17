import fs from 'node:fs';
import { CONFIG_FILE } from './paths.js';

const DEFAULTS = {
  port: 5177,
  provider: 'treblo',            // 'treblo' | 'lyria' | 'local'
  treblo: {
    apiKey: '',
    baseUrl: 'https://api.treblo.com/v1',
    model: 'v3',                 // 'v3' | 'v2'
    concurrency: 4,
    pollIntervalMs: 5000,
    outputFormat: 'mp3',
    outputBitRate: 320,
  },
  lyria: {
    apiKey: '',                    // Gemini API 키 (aistudio.google.com, 결제 연결 필요). 연주곡 전용 소스
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'lyria-3.5',            // 'lyria-3.5' | 'lyria-3-pro-preview' (둘 다 곡당 $0.08)
    concurrency: 2,
    pollIntervalMs: 5000,
  },
  render: {
    width: 1920,
    height: 1080,
    fps: 10,
    gapSeconds: 1.5,
    encoder: 'auto',             // 'auto' | 'libx264' | 'h264_qsv'
    preset: 'veryfast',
    crf: 20,
    loudnorm: true,
  },
  subtitles: {
    fontName: 'Malgun Gothic',
    fontSize: 54,
    showTitleOverlay: true,
    titleOverlaySeconds: 6,
  },
  images: {
    defaultMode: 'slideshow',      // 'slideshow' (사진 여러 장 페이드 전환) | 'photo' (한 장 고정) | 'gradient'
    slideSeconds: 10,              // 사진 한 장 표시 시간
    fadeSeconds: 1.2,              // 페이드 전환 시간
    slideCount: 8,                 // 슬라이드쇼에 쓸 사진 수(풀 + 새로 받기)
    maxFetchPerJob: 4,             // 작업당 새로 받는 사진 최대 수
    provider: 'commons',           // 'commons' (Wikimedia, 키 불필요, 빠름) | 'openverse' (키 불필요, CC0만, 느림) | 'pexels' (키 필요)
    pexelsKey: '',
  },
  llm: { provider: 'anthropic' },   // 메인 LLM: 'anthropic' | 'openai' | 'gemini' (번역·프리셋 생성·배경 사진 기획에 사용)
  anthropic: { apiKey: '', model: 'claude-opus-5-5', cheapModel: 'claude-haiku-5-5' },
  openai: { apiKey: '', model: 'gpt-5.4', cheapModel: 'gpt-5.4-mini' },
  gemini: { apiKey: '', model: 'gemini-3.6-flash', cheapModel: 'gemini-3.5-flash-lite' },   // 키를 비우면 Lyria(Gemini) 키를 같이 쓴다
  youtube: {
    channelName: '',
    hashtags: '#playlist #aimusic',
    footer: 'Music generated with Treblo (https://treblo.com)',
    // 업로드(YouTube Data API v3): Google Cloud OAuth 클라이언트(데스크톱 앱). 토큰(oauth)은 /api/youtube/* 로만 다루고 /api/config 응답에서는 제거된다
    clientId: '', clientSecret: '', oauth: null, channelTitle: '', channelId: '', connectedAt: '',
    autoUpload: false, defaultPrivacy: 'private', uploadThumbnail: true, syntheticMedia: true,
  },
};

function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) out[k] = deepMerge(a[k] || {}, b[k]);
    else out[k] = b[k];
  }
  return out;
}

/** config.json 내용 + 기본값 (환경변수 미적용). 저장의 기준이 된다. */
function fileConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return deepMerge(DEFAULTS, saved);
}

export function loadConfig() {
  const cfg = fileConfig();
  if (process.env.TREBLO_API_KEY) cfg.treblo.apiKey = process.env.TREBLO_API_KEY;
  if (process.env.GEMINI_API_KEY) { cfg.lyria.apiKey = process.env.GEMINI_API_KEY; cfg.gemini.apiKey = process.env.GEMINI_API_KEY; }
  if (process.env.OPENAI_API_KEY) cfg.openai.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) cfg.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}

export function saveConfig(patch) {
  // 환경변수로 덮어쓴 값(API 키, 포트)이 파일에 기록되지 않도록 파일 내용을 기준으로 병합한다
  const next = deepMerge(fileConfig(), patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return loadConfig();
}

export function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.treblo?.apiKey) c.treblo.apiKey = c.treblo.apiKey.slice(0, 4) + '****' + c.treblo.apiKey.slice(-4);
  c.hasApiKey = Boolean(cfg.treblo?.apiKey);
  if (c.lyria?.apiKey) c.lyria.apiKey = c.lyria.apiKey.slice(0, 4) + '****' + c.lyria.apiKey.slice(-4);
  c.hasLyriaKey = Boolean(cfg.lyria?.apiKey);
  if (c.images?.pexelsKey) c.images.pexelsKey = '****';
  c.hasAnthropicKey = Boolean(cfg.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY);
  for (const id of ['anthropic', 'openai', 'gemini']) if (c[id]?.apiKey) c[id].apiKey = '****';
  if (c.youtube) { c.youtube.connected = Boolean(cfg.youtube?.oauth?.refresh_token); delete c.youtube.oauth; if (c.youtube.clientSecret) c.youtube.clientSecret = '****'; }
  return c;
}
