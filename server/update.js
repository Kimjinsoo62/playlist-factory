// [업데이트] 버튼: git fetch 로 확인 → 승인 시 git pull
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DIRS } from './paths.js';

const run = promisify(execFile);
async function git(args) {
  const { stdout } = await run('git', args, { cwd: DIRS.root, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function checkUpdate() {
  try { await git(['rev-parse', '--is-inside-work-tree']); } catch { return { ok: false, error: 'git 저장소가 아닙니다. 프로젝트 폴더에서 git init 후 원격을 추가하세요.' }; }
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
  let remote = '';
  try { remote = await git(['remote', 'get-url', 'origin']); } catch { return { ok: false, error: '원격 저장소(origin)가 없습니다. git remote add origin <GitHub URL> 로 추가하세요.', branch }; }
  try { await git(['fetch', '--quiet', 'origin']); } catch (e) { return { ok: false, error: `git fetch 실패: ${e.message.split('\n').slice(-2).join(' ')}`, branch, remote }; }
  let upstream;
  try { upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); }
  catch { upstream = `origin/${branch}`; }
  const behind = Number(await git(['rev-list', '--count', `HEAD..${upstream}`]).catch(() => '0'));
  const ahead = Number(await git(['rev-list', '--count', `${upstream}..HEAD`]).catch(() => '0'));
  const commits = behind ? (await git(['log', `HEAD..${upstream}`, '--pretty=format:%h%x1f%an%x1f%ar%x1f%s'])).split('\n').filter(Boolean).map(l => { const [hash, author, when, subject] = l.split('\x1f'); return { hash, author, when, subject }; }) : [];
  const dirty = (await git(['status', '--porcelain']).catch(() => '')).split('\n').filter(l => l && !l.includes('config.json')).length;
  return { ok: true, branch, remote, upstream, behind, ahead, commits, dirty, current: await git(['rev-parse', '--short', 'HEAD']).catch(() => '') };
}

export async function applyUpdate(log) {
  const before = await git(['rev-parse', 'HEAD']);
  log?.('git pull --ff-only 실행');
  let out;
  try { out = await git(['pull', '--ff-only', 'origin']); }
  catch (e) { throw new Error(`git pull 실패: ${e.message.split('\n').slice(-3).join(' ')}`); }
  const after = await git(['rev-parse', 'HEAD']);
  const changed = before === after ? [] : (await git(['diff', '--name-only', before, after])).split('\n').filter(Boolean);
  const needInstall = changed.some(f => /^(package(-lock)?\.json|install\.bat|requirements\.txt)$/.test(f));
  log?.(`변경 파일 ${changed.length}개${needInstall ? ' (의존성 변경 → install.bat 재실행 필요)' : ''}`);
  return { ok: true, before: before.slice(0, 7), after: after.slice(0, 7), changed, needInstall, output: out };
}
