// [종료] 버튼 동작: 캐시 삭제 → 자식 프로세스 종료 → 포트 정리 → 이 프로젝트의 cmd 창 닫기 → 브라우저 창 닫기 → 서버 종료
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS, APP_TITLE } from './paths.js';
import { killAll } from './media/ffmpeg.js';

const run = promisify(execFile);
const ps = (script) => run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).then(r => r.stdout.trim()).catch(e => `(오류) ${e.message.split('\n')[0]}`);

export async function shutdownSequence({ port, log }) {
  const steps = [];
  const add = (name, detail) => { steps.push({ name, detail }); log?.(`${name}: ${detail}`); };

  // 1. 캐시 삭제
  try {
    let n = 0;
    if (fs.existsSync(DIRS.cache)) for (const f of fs.readdirSync(DIRS.cache)) { fs.rmSync(path.join(DIRS.cache, f), { recursive: true, force: true }); n++; }
    add('캐시 삭제', `${n}개 항목`);
  } catch (e) { add('캐시 삭제', `실패: ${e.message}`); }

  // 2. 서버 자식 프로세스(ffmpeg/python) 종료
  killAll();
  add('작업 프로세스 종료', 'ffmpeg/python 중지');

  // 3. 포트 정리: 이 포트를 점유한 다른 PID(자기 자신 제외)
  if (process.platform === 'win32') {
    const r = await ps(`$me=${process.pid}; $pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; $k=0; foreach($p in $pids){ if($p -ne $me){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $k++ } }; "정리 $k개 (자기 자신 PID $me 는 종료 단계에서 해제)"`);
    add('포트 정리', r);

    // 4. 이 프로젝트 경로가 명령줄에 포함된 cmd 창 닫기 (자기 부모 포함)
    const root = DIRS.root.replace(/'/g, "''");
    const r2 = await ps(`$root='${root}'; $procs = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root.ToLower()) }; $k=0; foreach($p in $procs){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $k++ }; "닫은 명령 창 $k개"`);
    add('명령 창 닫기', r2);

    // 5. 브라우저 창 닫기: 창 제목에 앱 이름이 들어간 창만 (클라이언트가 먼저 새로고침·close 시도)
    const r3 = await ps(`$t='*${APP_TITLE}*'; $k=0; foreach($p in Get-Process | Where-Object { $_.MainWindowTitle -like $t }){ $null = $p.CloseMainWindow(); $k++ }; "닫기 요청 $k개 창"`);
    add('브라우저 창 닫기', r3);
  } else {
    add('포트/창 정리', 'Windows 전용 단계 건너뜀');
  }
  return steps;
}
