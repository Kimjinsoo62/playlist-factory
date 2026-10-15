// 유튜브 제목/설명/챕터 자동 작성

export function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

import { creditLine } from './images.js';

export function buildYoutubeMeta({ preset, tracks, total, request, cfg, photoCredit = null, photoCredits = [] }) {
  const lang = request.language || 'ko';
  const title = request.title || defaultTitle(preset, tracks.length, total, lang);
  const chapters = tracks.map(t => `${fmtTime(t.offset)} ${String(t.index).padStart(2, '0')}. ${t.title}`);
  const intro = preset.youtubeIntro?.[lang] || preset.youtubeIntro?.ko || preset.description || '';
  const lines = [
    intro, '',
    `▶ Tracklist (${tracks.length}곡 · ${fmtTime(total)})`,
    ...chapters, '',
    cfg.youtube?.hashtags || '',
    (preset.hashtags || []).join(' '), '',
    cfg.youtube?.footer || 'Music generated with Treblo (https://treblo.com)',
    '이 플레이리스트의 음악은 AI(Treblo)로 생성되었습니다.',
  ];
  const credits = photoCredits.length ? photoCredits : (photoCredit ? [photoCredit] : []);
  if (credits.length) { lines.push(''); lines.push(credits.length > 1 ? 'Background photos:' : ''); for (const c of credits) lines.push((credits.length > 1 ? '- ' : '') + creditLine(c).replace(/^Background photo: /, credits.length > 1 ? '' : 'Background photo: ')); }
  if (cfg.youtube?.channelName) lines.push(`© ${cfg.youtube.channelName}`);
  const tags = [...new Set([...(preset.tags || []), ...(preset.keywords || []), 'playlist', 'ai music', preset.name])].slice(0, 30);
  return { title, description: lines.filter(l => l !== undefined).join('\n'), chapters, tags };
}

function defaultTitle(preset, n, total, lang) {
  const h = Math.floor(total / 3600), m = Math.max(h ? 0 : 1, Math.round((total % 3600) / 60));
  const dur = h ? `${h}시간 ${m ? m + '분' : ''}`.trim() : `${m}분`;
  const tpl = preset.titleTemplate?.[lang] || preset.titleTemplate?.ko || `[Playlist] ${preset.name} ${n}곡 · {dur}`;
  return tpl.replace('{n}', n).replace('{dur}', dur).replace('{date}', new Date().toLocaleDateString('ko-KR'));
}
