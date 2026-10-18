// 유튜브 제목/설명/챕터 자동 작성

export function fmtTime(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

import { creditLine } from './images.js';

/** 곡 수 표기: 한국어 "6곡", 영어 "6 tracks"/"1 track", 일본어 "6曲" */
export function trackCount(n, lang = 'ko') { return lang === 'en' ? `${n} track${n === 1 ? '' : 's'}` : lang === 'ja' ? `${n}曲` : `${n}곡`; }
/** 총 길이 표기: "1시간 4분" / "1 hr 4 min" / "1時間4分" */
export function durLabel(total, lang = 'ko') {
  const h = Math.floor(total / 3600), m = Math.max(h ? 0 : 1, Math.round((total % 3600) / 60));
  if (lang === 'en') return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
  if (lang === 'ja') return h ? `${h}時間${m ? `${m}分` : ''}` : `${m}分`;
  return h ? `${h}시간${m ? ` ${m}분` : ''}` : `${m}분`;
}

export function buildYoutubeMeta({ preset, tracks, total, request, cfg, photoCredit = null, photoCredits = [], extraCredits = [] }) {
  const lang = ['ko', 'en', 'ja'].includes(request.language) ? request.language : 'ko';
  const title = request.title || defaultTitle(preset, tracks.length, total, lang);
  const chapters = tracks.map(t => `${fmtTime(t.offset)} ${String(t.index).padStart(2, '0')}. ${t.title}`);
  const intro = preset.youtubeIntro?.[lang] || preset.youtubeIntro?.ko || preset.description || '';
  // 전역 설정 해시태그 + 프리셋 해시태그를 합치되 같은 태그는 한 번만
  const hashtags = [...new Set(`${cfg.youtube?.hashtags || ''} ${(preset.hashtags || []).join(' ')}`.split(/\s+/).filter(Boolean))].join(' ');
  const lines = [
    intro, '',
    `▶ Tracklist (${trackCount(tracks.length, lang)} · ${fmtTime(total)})`,
    ...chapters, '',
    hashtags, '',
    ...(request.provider === 'lyria'
      ? ['Music generated with Google Lyria (Gemini API, https://deepmind.google/models/lyria/)', '이 플레이리스트의 음악은 AI(Google Lyria)로 생성되었습니다.']
      : [cfg.youtube?.footer || 'Music generated with Treblo (https://treblo.com)', '이 플레이리스트의 음악은 AI(Treblo)로 생성되었습니다.']),
  ];
  const credits = photoCredits.length ? photoCredits : (photoCredit ? [photoCredit] : []);
  if (credits.length) { lines.push(''); lines.push(credits.length > 1 ? 'Background photos:' : ''); for (const c of credits) lines.push((credits.length > 1 ? '- ' : '') + creditLine(c).replace(/^Background photo: /, credits.length > 1 ? '' : 'Background photo: ')); }
  if (extraCredits.length) { lines.push(''); lines.push(...extraCredits); }   // 날씨 데이터 출처 등(CC BY)
  if (cfg.youtube?.channelName) lines.push(`© ${cfg.youtube.channelName}`);
  const tags = [...new Set([...(preset.tags || []), ...(preset.keywords || []), 'playlist', 'ai music', preset.name])].slice(0, 30);
  return { title, description: lines.filter(l => l !== undefined).join('\n'), chapters, tags };
}

function defaultTitle(preset, n, total, lang) {
  const fallback = { ko: `[Playlist] ${preset.name} {n}곡 · {dur}`, en: `[Playlist] ${preset.name} {n} songs · {dur}`, ja: `[Playlist] ${preset.name} {n}曲 · {dur}` };
  const tpl = preset.titleTemplate?.[lang] || fallback[lang] || fallback.ko;
  return tpl.replace('{n}', n).replace('{dur}', durLabel(total, lang)).replace('{date}', new Date().toLocaleDateString(lang === 'en' ? 'en-US' : lang === 'ja' ? 'ja-JP' : 'ko-KR'))
    .replace(/\b1 (songs|tracks)\b/g, (_, w) => '1 ' + w.slice(0, -1));   // 영어 단수형
}
