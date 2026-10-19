// ASS 자막 생성: 가사(하단) + 곡 전환 제목 오버레이(좌상단)

function tc(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60), cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function esc(t) { return String(t).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N'); }
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** 가사 텍스트 → 줄 배열 ([Verse] 같은 구조 태그 제거) */
export function lyricLines(lyrics) {
  return String(lyrics || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^\[.*\]$/.test(s) && !/^\(.*\)$/.test(s));
}

/**
 * 단어 타이밍을 가사 줄에 배분. words: [{word,start,end}] (곡 내부 시간)
 * 반환: [{text,start,end}]
 */
export function alignLinesToWords(lines, words) {
  if (!lines.length || !words?.length) return [];
  const out = [];
  let wi = 0;
  for (let li = 0; li < lines.length; li++) {
    const tokens = lines[li].split(/\s+/).filter(Boolean);
    const n = tokens.length;
    if (wi >= words.length) break;
    // 첫 토큰 매칭 시도(단어 누락/추가에 대한 완충)
    const target = norm(tokens[0]);
    for (let k = wi; k < Math.min(words.length, wi + 6); k++) if (target && norm(words[k].word) === target) { wi = k; break; }
    const slice = words.slice(wi, wi + n);
    wi += n;
    out.push({ text: lines[li], start: slice[0].start, end: slice[slice.length - 1].end });
  }
  // 겹침 방지 및 최소 표시 시간
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    let end = Math.max(out[i].end, out[i].start + 0.8);
    if (next) end = Math.min(end + 0.6, next.start - 0.05);
    out[i].end = Math.max(end, out[i].start + 0.3);
  }
  return out;
}

/** 줄 단위 타이밍이 이미 있을 때(Mureka lyrics_sections): 겹침 방지·최소 표시 시간만 적용. lines: [{text,start,end}] (초) */
export function timedLinesToSubs(lines) {
  const out = lines.filter(l => l && l.text && Number.isFinite(l.start) && Number.isFinite(l.end)).sort((a, b) => a.start - b.start).map(l => ({ text: l.text, start: l.start, end: Math.max(l.end, l.start) }));
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    let end = Math.max(out[i].end, out[i].start + 0.8);
    if (next) end = Math.min(end, next.start - 0.05);
    out[i].end = Math.max(end, out[i].start + 0.3);
  }
  return out;
}

/** 타이밍 정보가 없을 때: 가사 줄을 곡의 10%~95% 구간에 균등 분배 */
export function distributeLines(lines, duration) {
  if (!lines.length) return [];
  const start = duration * 0.1, end = duration * 0.95;
  const per = (end - start) / lines.length;
  return lines.map((text, i) => ({ text, start: start + i * per, end: start + (i + 1) * per - 0.2 }));
}

/**
 * tracks: [{index,title,offset,duration,lines:[{text,start,end}] (곡 내부 시간)}]
 */
export function buildAss(tracks, { width = 1920, height = 1080, fontName = 'Malgun Gothic', fontSize = 54, showTitleOverlay = true, titleOverlaySeconds = 6, playlistTitle = '' } = {}) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Lyric,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H64000000,&H96000000,0,0,0,0,100,100,0,0,1,3,1,2,120,120,70,1
Style: Title,${fontName},${Math.round(fontSize * 0.8)},&H00FFFFFF,&H00FFFFFF,&H78000000,&HA0000000,1,0,0,0,100,100,0,0,1,2,1,7,60,60,50,1
Style: Playlist,${fontName},${Math.round(fontSize * 0.55)},&H00DDDDDD,&H00FFFFFF,&H78000000,&HA0000000,0,0,0,0,100,100,0,0,1,2,0,9,60,60,50,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const ev = [];
  for (const t of tracks) {
    if (showTitleOverlay) {
      const s = t.offset, e = t.offset + Math.min(titleOverlaySeconds, Math.max(2, t.duration - 1));
      ev.push(`Dialogue: 1,${tc(s)},${tc(e)},Title,,0,0,0,,{\\fad(400,600)}${String(t.index).padStart(2, '0')}. ${esc(t.title)}`);
    }
    for (const l of t.lines || []) {
      ev.push(`Dialogue: 0,${tc(t.offset + l.start)},${tc(t.offset + l.end)},Lyric,,0,0,0,,{\\fad(120,120)}${esc(l.text)}`);
    }
  }
  if (playlistTitle && tracks.length) {
    const last = tracks[tracks.length - 1];
    ev.push(`Dialogue: 2,${tc(0)},${tc(last.offset + last.duration)},Playlist,,0,0,0,,${esc(playlistTitle)}`);
  }
  return head + ev.join('\n') + '\n';
}
