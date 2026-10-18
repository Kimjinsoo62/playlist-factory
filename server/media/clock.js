// 화면 가득 채우는 디지털 플립시계 배경: 레이아웃(JS·Python 공용)과 ffmpeg 필터 문자열.
// 레이아웃은 1920×1080 기준으로 잡고 렌더 해상도 비율(W/1920)로 확대·축소한다. Python(썸네일)은 같은 레이아웃을 받아 1280×720 비율로 그린다.

/**
 * @param {{mode?: 'clock'|'weather', showSeconds?: boolean, hour12?: boolean}} opts
 * @returns {{cards: {key:string,x:number,y:number,w:number,h:number}[], digit:number, cy:number, date:{y:number,size:number}|null, colons:{x:number,y:number}[], dot:number, ampm:{x:number,y:number,size:number}|null, full:boolean}}
 */
export function clockLayout({ mode = 'clock', showSeconds = true, hour12 = false } = {}, W = 1920) {
  const s = W / 1920;
  const full = mode !== 'weather';
  const keys = showSeconds ? ['H', 'M', 'S'] : ['H', 'M'];
  let cw, ch, gap, cy;
  if (full) { cw = showSeconds ? 480 : 640; ch = 560; gap = showSeconds ? 60 : 80; cy = 560; }   // 위 150: 날짜, 아래 150: 가사 자막
  else { cw = showSeconds ? 270 : 360; ch = 270; gap = 40; cy = 715; }                             // 위 70~550: 날씨 패널
  const total = keys.length * cw + (keys.length - 1) * gap;
  const x0 = (1920 - total) / 2;
  const cards = keys.map((key, i) => ({ key, x: x0 + i * (cw + gap), y: cy - ch / 2, w: cw, h: ch }));
  const lay = {
    full, cy, cards,
    digit: Math.round(ch * 0.74),
    dot: Math.round(ch * 0.045),
    colons: cards.slice(0, -1).map(c => ({ x: c.x + c.w + gap / 2, y: cy })),
    date: full ? { y: 150, size: 64 } : null,
    ampm: hour12 ? { x: cards[0].x + cw - 12, y: cards[0].y + 14, size: Math.round(ch * 0.11) } : null,
  };
  return scaleLayout(lay, s);
}

function scaleLayout(l, s) {
  if (s === 1) return l;
  const r = v => Math.round(v * s);
  return {
    ...l, cy: r(l.cy), digit: r(l.digit), dot: r(l.dot),
    cards: l.cards.map(c => ({ ...c, x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) })),
    colons: l.colons.map(c => ({ x: r(c.x), y: r(c.y) })),
    date: l.date ? { y: r(l.date.y), size: r(l.date.size) } : null,
    ampm: l.ampm ? { x: r(l.ampm.x), y: r(l.ampm.y), size: r(l.ampm.size) } : null,
  };
}

/** 시계 시작 시각(현지 벽시계 기준 epoch 초). ffmpeg 는 gmtime 으로 포맷하므로 현지 시차를 더해 둔다. startTime "HH:MM" 이면 오늘 그 시각부터 */
export function clockEpoch(startTime = '') {
  const now = new Date();
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(startTime || '').trim());
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) now.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return Math.floor(now.getTime() / 1000) - now.getTimezoneOffset() * 60;
}

/** epoch(현지 벽시계) → "HH:MM:SS" 표시용 */
export function clockLabel(epoch) {
  const d = new Date(epoch * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * ffmpeg -vf 에 끼워 넣을 필터 목록. 시각은 pts(영상 시간)+epoch 를 strftime 으로 찍으므로 영상이 흐르는 만큼 시계도 흐른다.
 * fontRel: 작업 폴더(cwd) 기준 글꼴 상대 경로(슬래시). 드라이브 콜론이 필터 파서를 깨뜨리므로 절대 경로는 쓰지 않는다.
 */
export function clockFilters(lay, epoch, fontRel, { hour12 = false } = {}) {
  const f = [];
  const t = fmt => `%{pts\\:gmtime\\:${Math.floor(epoch)}\\:${fmt}}`;
  const text = (fmt, size, x, y, color = 'white') => `drawtext=fontfile=${fontRel}:text='${t(fmt)}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}`;
  for (const c of lay.cards) {
    f.push(`drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=black@0.68:t=fill`);
  }
  for (const c of lay.colons) {
    const off = Math.round(lay.cards[0].h * 0.12);
    f.push(`drawbox=x=${c.x - lay.dot / 2}:y=${c.y - off - lay.dot / 2}:w=${lay.dot}:h=${lay.dot}:color=white@0.85:t=fill`);
    f.push(`drawbox=x=${c.x - lay.dot / 2}:y=${c.y + off - lay.dot / 2}:w=${lay.dot}:h=${lay.dot}:color=white@0.85:t=fill`);
  }
  const fmtOf = { H: hour12 ? '%I' : '%H', M: '%M', S: '%S' };
  for (const c of lay.cards) {
    const cx = c.x + c.w / 2;
    f.push(text(fmtOf[c.key], lay.digit, `${cx}-text_w/2`, `${lay.cy}-text_h/2-${Math.round(lay.digit * 0.06)}`));
  }
  // 플립시계 가운데 가로선(글자 위에 얹어 두 장으로 보이게)
  for (const c of lay.cards) f.push(`drawbox=x=${c.x}:y=${lay.cy - 3}:w=${c.w}:h=6:color=0x05060a@0.9:t=fill`);
  if (lay.date) f.push(text('%Y.%m.%d (%a)', lay.date.size, '(w-text_w)/2', lay.date.y, 'white@0.85'));
  if (lay.ampm) f.push(text('%p', lay.ampm.size, `${lay.ampm.x}-text_w`, lay.ampm.y, 'white@0.8'));
  return f;
}
