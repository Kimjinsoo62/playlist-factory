// 앱 전용 브라우저 창: Edge/Chrome 을 --app 모드 + 이 프로젝트 안의 별도 프로필(.app-browser)로 띄운다.
// 사용자가 쓰는 브라우저와 다른 프로세스라서 [종료]·STOP.bat 이 명령줄의 프로젝트 경로로 이 창만 골라 닫을 수 있다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DIRS } from './paths.js';

export const APP_PROFILE = path.join(DIRS.root, '.app-browser');

function findBrowser() {
  const env = process.env;
  const candidates = [
    path.join(env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

/** 브라우저는 --app 창의 마지막 위치·크기를 프로필(Preferences 의 browser.app_window_placement["<host>_<path>"])에 저장했다가
 *  시작 몇 초 뒤 다시 적용한다. 한 번이라도 작게 닫히면 계속 작게 뜨므로, 띄우기 전에 최대화·화면 전체 크기로 기록해 둔다.
 *  (첫 실행은 저장값이 없어 브라우저 기본 크기로 뜨고, 그다음 실행부터 적용된다) */
function keepMaximized(url) {
  const file = path.join(APP_PROFILE, 'Default', 'Preferences');
  try {
    if (!fs.existsSync(file)) return;
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
    const u = new URL(url);
    const place = ((prefs.browser ??= {}).app_window_placement ??= {});
    const key = `${u.hostname}_${u.pathname}`;
    const p = place[key] || {};
    // Edge 는 시작 몇 초 뒤 저장된 위치·크기로 되돌리기도 하므로 크기 자체도 작업 영역 전체로 기록한다 (좌표는 브라우저가 저장한 단위 그대로)
    const full = p.work_area_right ? { left: p.work_area_left, top: p.work_area_top, right: p.work_area_right, bottom: p.work_area_bottom } : {};
    if (p.maximized === true && (!p.work_area_right || (p.left === full.left && p.top === full.top && p.right === full.right && p.bottom === full.bottom))) return;
    place[key] = { ...p, ...full, maximized: true };
    fs.writeFileSync(file, JSON.stringify(prefs), 'utf8');
  } catch {}
}

/** 서버(백그라운드)가 띄운 창은 다른 창 뒤에 열리므로, 창이 나타나면(최대 10초) 앞으로 가져온다.
 *  최대화는 keepMaximized 의 저장값으로 브라우저가 직접 한다(밖에서 ShowWindow 로 최대화하면 고배율 화면에서 창이 화면보다 크게 그려진다).
 *  실패해도 창은 그대로 쓸 수 있으므로 결과는 기다리지 않는다. */
function bringToFront() {
  const prof = APP_PROFILE.toLowerCase().replace(/'/g, "''");
  const script = `Add-Type -Namespace PF -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);';
for ($i = 0; $i -lt 40; $i++) {
  $ids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${prof}') } | ForEach-Object { $_.ProcessId });
  $w = if ($ids.Count) { Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 };
  if ($w) {
    $null = [PF.U]::SetForegroundWindow($w.MainWindowHandle);
    break
  };
  Start-Sleep -Milliseconds 250
}`;
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** 앱 창을 연다. Edge·Chrome 이 없으면 기본 브라우저의 일반 탭으로 연다. 반환: 사용한 방식 설명 */
export function openAppWindow(url) {
  if (process.platform !== 'win32') return '(Windows 전용, 건너뜀)';
  const exe = findBrowser();
  if (exe) {
    keepMaximized(url);
    spawn(exe, [`--app=${url}`, `--user-data-dir=${APP_PROFILE}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
    bringToFront();
    return `앱 전용 창 (${path.basename(exe)})`;
  }
  spawn('cmd', ['/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  return '기본 브라우저 (Edge·Chrome 없음)';
}
