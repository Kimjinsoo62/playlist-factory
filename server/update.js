// [업데이트] 버튼: git fetch 로 확인 → 승인 시 겹치는 로컬 수정 파일을 backup/ 에 백업 → fast-forward
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS } from './paths.js';

const run = promisify(execFile);
// core.quotepath=off: 한글 파일명이 "\355\225..." 로 이스케이프되지 않게. GIT_TERMINAL_PROMPT=0: 인증 프롬프트로 멈추지 않게
async function git(args) {
  const { stdout } = await run('git', ['-c', 'core.quotepath=off', '-c', 'safe.directory=*', ...args], { cwd: DIRS.root, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}
const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean);

/** 현재 브랜치와 비교 대상(upstream, 없으면 origin/<브랜치>) */
async function target() {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => `origin/${branch}`);
  return { branch, upstream };
}

/** 업데이트가 덮어쓸 로컬 파일: 수정·삭제된 관리 파일 ∩ 업데이트 변경 파일, 새로 추가될 경로와 겹치는 미관리 파일 */
async function conflicts(upstream) {
  const incoming = new Set(lines(await git(['diff', '--name-only', 'HEAD', upstream])));
  const modified = lines(await git(['diff', '--name-only', 'HEAD'])).filter(f => incoming.has(f));
  const untracked = lines(await git(['ls-files', '--others', '--exclude-standard'])).filter(f => incoming.has(f));
  return { modified, untracked };
}

export async function checkUpdate() {
  try { await git(['--version']); } catch { return { ok: false, error: 'git 을 찾을 수 없습니다. install.bat 을 실행해 git 을 설치한 뒤 앱을 다시 시작하세요.' }; }
  try { await git(['rev-parse', '--is-inside-work-tree']); } catch { return { ok: false, error: 'git 저장소가 아닙니다. install.bat 을 다시 실행하면 GitHub 저장소에 연결합니다.' }; }
  const { branch } = await target();
  let remote = '';
  try { remote = await git(['remote', 'get-url', 'origin']); } catch { return { ok: false, error: '원격 저장소(origin)가 없습니다. install.bat 을 다시 실행하거나 git remote add origin <GitHub URL> 로 추가하세요.', branch }; }
  try { await git(['fetch', '--quiet', 'origin']); } catch (e) { return { ok: false, error: `git fetch 실패: ${e.message.split('\n').slice(-2).join(' ')}`, branch, remote }; }
  const { upstream } = await target();
  const behind = Number(await git(['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0'));
  const ahead = Number(await git(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0'));
  const commits = behind ? lines(await git(['log', `HEAD..${upstream}`, '--pretty=format:%h%x1f%an%x1f%ar%x1f%s'])).map(l => { const [hash, author, when, subject] = l.split('\x1f'); return { hash, author, when, subject }; }) : [];
  const c = behind ? await conflicts(upstream).catch(() => ({ modified: [], untracked: [] })) : { modified: [], untracked: [] };
  return { ok: true, branch, remote, upstream, behind, ahead, commits, backup: [...c.modified, ...c.untracked], current: await git(['rev-parse', '--short', 'HEAD']).catch(() => '') };
}

function stamp() { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

export async function applyUpdate(log) {
  const { upstream } = await target();
  log?.(`git fetch origin`);
  try { await git(['fetch', '--quiet', 'origin']); } catch (e) { throw new Error(`git fetch 실패: ${e.message.split('\n').slice(-2).join(' ')}`); }
  const before = await git(['rev-parse', 'HEAD']);
  if (Number(await git(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0'))) throw new Error(`이 PC 에만 있는 커밋이 있어 자동 업데이트를 할 수 없습니다 (${upstream} 과 갈라짐).`);

  // 업데이트와 겹치는 로컬 수정은 backup/업데이트_<시각>/ 에 먼저 백업한 뒤,
  // 추적 파일(modified)은 stash → fast-forward → stash pop 으로 자동 병합을 시도하고,
  // 줄 단위 충돌(<<<<<)이 난 파일만 원격 버전으로 맞춘다 (앱이 구문 오류로 죽지 않게).
  const { modified, untracked } = await conflicts(upstream);
  let backupDir = '';
  const saved = [];
  const backedUp = [...untracked];
  if (modified.length || untracked.length) {
    backupDir = path.join(DIRS.root, 'backup', `업데이트_${stamp()}`);
    const deleted = [];
    for (const f of [...modified, ...untracked]) {
      const src = path.join(DIRS.root, f);
      if (!fs.existsSync(src)) { deleted.push(f); continue; }
      const dst = path.join(backupDir, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      saved.push(f);
    }
    if (deleted.length) { fs.mkdirSync(backupDir, { recursive: true }); fs.writeFileSync(path.join(backupDir, '_삭제했던_파일.txt'), deleted.join('\r\n') + '\r\n', 'utf8'); }
    for (const f of untracked) fs.rmSync(path.join(DIRS.root, f), { force: true });
  }

  let stashed = false;
  if (modified.length) {
    const sOut = await git(['stash', 'push', '-m', `pf-update-${stamp()}`, '--', ...modified]).catch(() => '');
    stashed = Boolean(sOut && !/No local changes/i.test(sOut));
  }

  log?.(`git merge --ff-only ${upstream}`);
  let out;
  try { out = await git(['merge', '--ff-only', upstream]); }
  catch (e) {
    if (stashed) await git(['stash', 'pop']).catch(() => {});
    for (const f of saved) { try { fs.copyFileSync(path.join(backupDir, f), path.join(DIRS.root, f)); } catch {} }
    throw new Error(`업데이트 실패: ${e.message.split('\n').slice(-3).join(' ')}${saved.length ? ' (로컬 수정 파일은 원래대로 돌려 놓았습니다)' : ''}`);
  }

  if (stashed) {
    try {
      await git(['stash', 'pop']);
      log?.(`로컬 수정 파일 ${modified.length}개 자동 병합 완료`);
    } catch {
      // 줄 단위 충돌이 발생한 파일은 <<< 마커가 남지 않도록 원격(upstream) 버전으로 맞추고 백업 안내
      const unmerged = lines(await git(['diff', '--name-only', '--diff-filter=U']).catch(() => ''));
      const toReset = unmerged.length ? unmerged : modified;
      await git(['checkout', upstream, '--', ...toReset]).catch(() => {});
      await git(['reset', 'HEAD']).catch(() => {});
      await git(['stash', 'drop']).catch(() => {});
      for (const f of toReset) if (!backedUp.includes(f)) backedUp.push(f);
      log?.(`충돌 파일 ${toReset.length}개는 원격 버전으로 적용 (원본은 ${path.relative(DIRS.root, backupDir)} 에 백업)`);
    }
  }
  if (!backedUp.length && backupDir) {
    try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
    backupDir = '';
  }

  const after = await git(['rev-parse', 'HEAD']);
  const changed = before === after ? [] : lines(await git(['diff', '--name-only', before, after]));
  const needInstall = changed.some(f => /^(package(-lock)?\.json|install\.bat|requirements\.txt)$/.test(f));
  log?.(`변경 파일 ${changed.length}개${needInstall ? ' (의존성 변경 → install.bat 재실행 필요)' : ''}`);
  return { ok: true, before: before.slice(0, 7), after: after.slice(0, 7), changed, needInstall, backupDir: backupDir && path.relative(DIRS.root, backupDir), backedUp, output: out };
}
