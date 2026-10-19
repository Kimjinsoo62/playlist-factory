// 프리셋별 배경 영상 클립 풀을 미리 채운다 (Pexels/Pixabay 키 필요). 사용: node scripts/fetch-videos.js [프리셋당 개수=2] [프리셋id ...]
import { loadConfig } from '../server/config.js';
import { loadPresets } from '../server/pipeline.js';
import { collectVideos, listVideoPool, videoKeyReady } from '../server/videos.js';

const cfg = loadConfig();
if (!videoKeyReady(cfg)) { console.error(`영상 소스(${cfg.videos?.provider || 'pexels'}) API 키가 없습니다. 앱의 [배경] 설정 모달에서 입력하세요.`); process.exit(1); }
const want = Number(process.argv[2] || 2);
const only = process.argv.slice(3);
for (const p of loadPresets()) {
  if (only.length && !only.includes(p.id)) continue;
  let have = listVideoPool(p.id).length;
  console.log(`\n[${p.id}] 보유 ${have}개, 목표 ${want}개`);
  let fails = 0;
  while (have < want && fails < 4) {
    const r = await collectVideos({ presetId: p.id, queries: p.imageQueries, cfg, log: (m) => console.log('  ' + m), count: 1, maxFetch: 1, freshOnly: true });
    if (r[0]?.fresh) have++; else fails++;
  }
}
console.log('\n완료');
