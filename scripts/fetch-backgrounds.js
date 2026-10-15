// 프리셋별 배경 사진 풀을 미리 채운다. 사용: node scripts/fetch-backgrounds.js [프리셋당 개수=2] [프리셋id ...]
import { loadConfig } from '../server/config.js';
import { loadPresets } from '../server/pipeline.js';
import { findBackground, listPool } from '../server/images.js';

const cfg = loadConfig();
const want = Number(process.argv[2] || 2);
const only = process.argv.slice(3);
for (const p of loadPresets()) {
  if (only.length && !only.includes(p.id)) continue;
  let have = listPool(p.id).length;
  console.log(`\n[${p.id}] 보유 ${have}장, 목표 ${want}장`);
  let fails = 0;
  while (have < want && fails < 4) {
    const r = await findBackground({ presetId: p.id, queries: p.imageQueries, cfg, log: (m) => console.log('  ' + m) });
    if (r?.fresh) have++; else fails++;
  }
}
console.log('\n완료');
