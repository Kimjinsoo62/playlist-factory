import fs from 'node:fs';
import { CONFIG_FILE } from './paths.js';

const DEFAULTS = {
  port: 5177,
  provider: 'treblo',            // 'treblo' | 'local'
  treblo: {
    apiKey: '',
    baseUrl: 'https://api.treblo.com/v1',
    model: 'v3',                 // 'v3' | 'v2'
    concurrency: 4,
    pollIntervalMs: 5000,
    outputFormat: 'mp3',
    outputBitRate: 320,
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
  youtube: {
    channelName: '',
    hashtags: '#playlist #aimusic',
    footer: 'Music generated with Treblo (https://treblo.com)',
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

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const cfg = deepMerge(DEFAULTS, saved);
  if (process.env.TREBLO_API_KEY) cfg.treblo.apiKey = process.env.TREBLO_API_KEY;
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  return cfg;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = deepMerge(current, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  if (c.treblo?.apiKey) c.treblo.apiKey = c.treblo.apiKey.slice(0, 4) + '****' + c.treblo.apiKey.slice(-4);
  c.hasApiKey = Boolean(cfg.treblo?.apiKey);
  return c;
}
