// 주소지 부근 현재 날씨: Nominatim(OpenStreetMap) 지오코딩 → Open-Meteo(키 불필요, CC BY 4.0).
// 한 작업당 한 번만 호출하고 결과는 렌더링 시점에 고정 표시한다. 좌표는 config.clock.geocache 에 주소별로 저장해 다시 묻지 않는다.
import { saveConfig } from './config.js';

const UA = 'playlist-factory/1.0 (local desktop app)';
const TIMEOUT = 12000;

/** WMO 날씨 코드 → 아이콘 종류(Python 이 그림)와 한국어 설명 */
export function describeWmo(code) {
  const c = Number(code);
  const pick = (kind, desc) => ({ kind, desc });
  if (c === 0) return pick('clear', '맑음');
  if (c === 1) return pick('partly', '대체로 맑음');
  if (c === 2) return pick('partly', '구름 조금');
  if (c === 3) return pick('cloudy', '흐림');
  if (c === 45 || c === 48) return pick('fog', '안개');
  if (c >= 51 && c <= 55) return pick('rain', '이슬비');
  if (c === 56 || c === 57) return pick('rain', '어는 이슬비');
  if (c >= 61 && c <= 65) return pick('rain', c === 65 ? '강한 비' : '비');
  if (c === 66 || c === 67) return pick('rain', '어는 비');
  if (c >= 71 && c <= 75) return pick('snow', c === 75 ? '폭설' : '눈');
  if (c === 77) return pick('snow', '싸락눈');
  if (c >= 80 && c <= 82) return pick('rain', '소나기');
  if (c === 85 || c === 86) return pick('snow', '소낙눈');
  if (c === 95) return pick('thunder', '뇌우');
  if (c === 96 || c === 99) return pick('thunder', '뇌우(우박)');
  return pick('cloudy', '흐림');
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
  return res.json();
}

/** 주소 → {lat, lon, name}. Nominatim 이 한국 주소를 잘 처리한다(동 단위까지). 실패 시 Open-Meteo 지오코더로 한 번 더. */
export async function geocode(address, cfg) {
  const q = String(address || '').trim();
  if (!q) throw new Error('주소가 비어 있습니다. [배경] 설정에서 주소를 입력하세요.');
  const cached = cfg?.clock?.geocache?.[q];
  if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) return { ...cached, cached: true };
  let hit = null;
  try {
    const r = await getJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ko&addressdetails=1&q=${encodeURIComponent(q)}`, { 'User-Agent': UA });
    if (Array.isArray(r) && r[0]) {
      // 표시 이름은 주소 필드로 조립: 시/도 + 구/군 + 동 ("서울특별시 강남구 역삼동"). display_name 을 쪼개면 우편번호가 섞인다
      const a = r[0].address || {};
      const top = a.city || a.state || a.province || a.county || '';
      const mid = a.borough || a.city_district || a.district || a.county || a.town || '';
      const low = a.quarter || a.suburb || a.village || a.neighbourhood || '';
      const name = [...new Set([top, mid, low].filter(Boolean))].join(' ') || r[0].name || q;
      hit = { lat: Number(r[0].lat), lon: Number(r[0].lon), name };
    }
  } catch {}
  if (!hit) {
    const r = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=ko`);
    const g = r?.results?.[0];
    if (!g) throw new Error(`주소를 찾지 못했습니다: ${q}`);
    hit = { lat: g.latitude, lon: g.longitude, name: [g.admin1, g.name].filter(Boolean).join(' ') };
  }
  try { saveConfig({ clock: { geocache: { [q]: hit } } }); } catch {}
  return hit;
}

/** 현재 날씨 + 오늘 최고·최저. 단위: °C, m/s */
export async function fetchWeather({ lat, lon }) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&daily=temperature_2m_max,temperature_2m_min&wind_speed_unit=ms&timezone=auto&forecast_days=1`;
  const r = await getJson(u);
  const c = r.current || {};
  const d = describeWmo(c.weather_code);
  return {
    temp: round1(c.temperature_2m), feels: round1(c.apparent_temperature), humidity: Math.round(c.relative_humidity_2m ?? 0),
    wind: round1(c.wind_speed_10m), code: c.weather_code, kind: d.kind, desc: d.desc, isDay: c.is_day !== 0,
    tmax: round1(r.daily?.temperature_2m_max?.[0]), tmin: round1(r.daily?.temperature_2m_min?.[0]),
    observedAt: c.time || '', timezone: r.timezone || '',
  };
}
const round1 = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);

/** 주소 → 화면에 그릴 날씨 데이터 한 덩어리 */
export async function getWeather(address, cfg) {
  const g = await geocode(address, cfg);
  const w = await fetchWeather(g);
  return { place: g.name, lat: g.lat, lon: g.lon, ...w, source: 'Open-Meteo', fetchedAt: new Date().toISOString() };
}

/** 테스트(mock) 작업용 표본 — 네트워크를 쓰지 않는다 */
export function sampleWeather(address) {
  return { place: String(address || '').trim() || '서울특별시 강남구', temp: 17.4, feels: 16.2, humidity: 58, wind: 2.1, code: 2, kind: 'partly', desc: '구름 조금', isDay: true, tmax: 21.3, tmin: 11.8, sample: true, source: 'sample' };
}

export const WEATHER_CREDIT = 'Weather data by Open-Meteo.com (CC BY 4.0, https://open-meteo.com) · Geocoding © OpenStreetMap contributors';
