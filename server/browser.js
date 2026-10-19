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

/** 앱 창을 연다. Edge·Chrome 이 없으면 기본 브라우저의 일반 탭으로 연다. 반환: 사용한 방식 설명 */
export function openAppWindow(url) {
  if (process.platform !== 'win32') return '(Windows 전용, 건너뜀)';
  const exe = findBrowser();
  if (exe) {
    spawn(exe, [`--app=${url}`, `--user-data-dir=${APP_PROFILE}`, '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble', '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
    return `앱 전용 창 (${path.basename(exe)})`;
  }
  spawn('cmd', ['/c', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  return '기본 브라우저 (Edge·Chrome 없음)';
}
