// [종료] 버튼 동작: 캐시 삭제 → 자식 프로세스 종료 → 포트 정리 → 이 프로젝트의 cmd 창 닫기 → 브라우저 창 닫기 → 서버 종료
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS, APP_TITLE } from './paths.js';
import { killAll } from './media/ffmpeg.js';

const run = promisify(execFile);
/** PowerShell 스크립트를 실행하고 마지막 줄을 숫자로 돌려준다(한글 출력 인코딩 문제를 피하기 위해 숫자만 출력). */
async function psCount(script) {
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    const n = Number(stdout.trim().split(/\r?\n/).pop());
    return Number.isFinite(n) ? n : null;
  } catch (e) { return `(오류) ${e.message.split('\n')[0]}`; }
}
const fmtCount = (r, unit) => (typeof r === 'number' ? `${r}${unit}` : String(r ?? '확인 불가'));

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

  if (process.platform === 'win32') {
    const root = DIRS.root.replace(/'/g, "''");

    // 3. 포트 정리: 이 포트를 점유한 다른 PID(자기 자신 제외)
    const r1 = await psCount(`$me=${process.pid}; $k=0; $pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach($p in $pids){ if($p -ne $me){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $k++ } }; $k`);
    add('포트 정리', `${fmtCount(r1, '개 프로세스')} (서버 자신 PID ${process.pid} 은 종료 시 해제)`);

    // 4. 이 프로젝트 경로가 명령줄에 포함된 cmd 창 닫기 (START.bat 창 포함)
    const r2 = await psCount(`$root='${root}'.ToLower(); $k=0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $k++ }; $k`);
    add('명령 창 닫기', fmtCount(r2, '개 창'));

    // 5. 브라우저 창 닫기: 창 제목에 앱 이름이 들어간 창만 (클라이언트가 먼저 새로고침·close 시도)
    const r3 = await psCount(`$t='*${APP_TITLE}*'; $k=0; foreach($p in Get-Process | Where-Object { $_.MainWindowTitle -like $t -and $_.ProcessName -notin @('cmd','powershell','node') }){ $null = $p.CloseMainWindow(); $k++ }; $k`);
    add('브라우저 창 닫기', fmtCount(r3, '개 창에 닫기 요청'));
  } else {
    add('포트/창 정리', 'Windows 전용 단계 건너뜀');
  }
  return steps;
}
