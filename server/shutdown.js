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

    // 4. 이 프로젝트 경로가 명령줄에 포함된 cmd 창 닫기 (START.bat 창 포함). STOP.bat 창은 서버가 꺼지길 기다렸다 마무리하므로 제외
    const r2 = await psCount(`$root='${root}'.ToLower(); $k=0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) -and $_.CommandLine -notlike '*STOP.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $k++ }; $k`);
    add('명령 창 닫기', fmtCount(r2, '개 창'));

    // 5. 브라우저 창 닫기: START.bat 이 연 앱 전용 창(명령줄에 이 프로젝트의 .app-browser 프로필)만 닫는다.
    //    정상 종료(CloseMainWindow) 후 남은 프로세스는 강제 종료. 사용자가 쓰는 브라우저는 건드리지 않는다.
    const r3 = await psCount(`$root='${root}'.ToLower(); $ids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root) } | ForEach-Object { $_.ProcessId }); $k=-1; if($ids.Count){ $k=0; foreach($p in Get-Process -Id $ids -ErrorAction SilentlyContinue){ if($p.MainWindowHandle -ne 0){ $null = $p.CloseMainWindow(); $k++ } }; Start-Sleep -Milliseconds 1500; foreach($i in $ids){ Stop-Process -Id $i -Force -ErrorAction SilentlyContinue } }; $k`);
    if (r3 === -1) {
      // 앱 전용 창이 없음(Edge·Chrome 없음, 일반 탭으로 연 경우): 창 제목에 앱 이름이 있는 창만 닫는다. 그 창의 다른 탭도 함께 닫힐 수 있다
      const r4 = await psCount(`$t='*${APP_TITLE}*'; $k=0; foreach($p in Get-Process | Where-Object { $_.MainWindowTitle -like $t -and $_.ProcessName -notin @('cmd','powershell','node') }){ $null = $p.CloseMainWindow(); $k++ }; $k`);
      add('브라우저 창 닫기', `앱 전용 창 없음 → 제목 일치 창 ${fmtCount(r4, '개에 닫기 요청')}`);
    } else add('브라우저 창 닫기', `앱 전용 창 ${fmtCount(r3, '개')}`);
  } else {
    add('포트/창 정리', 'Windows 전용 단계 건너뜀');
  }
  return steps;
}
